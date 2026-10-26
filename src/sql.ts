import type { AffiliateStore, AttributionRow, InviteRow } from './store.ts';

/** Runs one statement written with $1..$n placeholders and returns its rows. */
export type Exec = (sql: string, params: unknown[]) => Promise<any[]>;

export interface SqlStoreOptions {
  /** Table name prefix. Default `aff_`. */
  prefix?: string;
}

/** Internal: which engine the SQL runs on. */
export type Dialect = 'sqlite' | 'postgres';

function checkPrefix(prefix: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) throw new Error(`invalid table prefix: ${prefix}`);
  return prefix;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function toInvite(r: any): InviteRow {
  return {
    id: String(r.id),
    codeHash: String(r.code_hash),
    inviterId: String(r.inviter_id),
    createdAt: Number(r.created_at),
    expiresAt: num(r.expires_at),
    usedBy: str(r.used_by),
    usedAt: num(r.used_at),
    note: r.note == null ? '' : String(r.note),
    revokedAt: num(r.revoked_at),
  };
}

export function ddl(prefix: string, dialect: Dialect = 'sqlite'): string[] {
  const p = checkPrefix(prefix);
  const pgOnly =
    dialect === 'postgres'
      ? [
          // Quota check + insert under a per-inviter advisory lock. A plpgsql function takes a fresh
          // snapshot per statement, so the count after the lock sees every committed invite; a single
          // INSERT ... SELECT WHERE count < limit would race under READ COMMITTED.
          `CREATE OR REPLACE FUNCTION ${p}insert_invite(
            p_id TEXT, p_hash TEXT, p_inviter TEXT, p_created BIGINT, p_expires BIGINT, p_note TEXT, p_limit INTEGER
          ) RETURNS BOOLEAN LANGUAGE plpgsql AS $fn$
          BEGIN
            PERFORM pg_advisory_xact_lock(hashtext('${p}invites'), hashtext(p_inviter));
            IF (SELECT count(*) FROM ${p}invites
                WHERE inviter_id = p_inviter AND (revoked_at IS NULL OR used_by IS NOT NULL)) >= p_limit THEN
              RETURN FALSE;
            END IF;
            INSERT INTO ${p}invites (id, code_hash, inviter_id, created_at, expires_at, note)
              VALUES (p_id, p_hash, p_inviter, p_created, p_expires, p_note);
            RETURN TRUE;
          END
          $fn$`,
        ]
      : [];
  return [
    `CREATE TABLE IF NOT EXISTS ${p}invites (
      id TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL UNIQUE,
      inviter_id TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      expires_at BIGINT,
      used_by TEXT,
      used_at BIGINT,
      note TEXT NOT NULL DEFAULT '',
      revoked_at BIGINT,
      legacy_dup INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS ${p}invites_inviter_idx ON ${p}invites (inviter_id)`,
    `CREATE INDEX IF NOT EXISTS ${p}invites_used_by_idx ON ${p}invites (used_by)`,
    `CREATE TABLE IF NOT EXISTS ${p}quotas (
      user_id TEXT PRIMARY KEY,
      total INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${p}codes (
      user_id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      created_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${p}attributions (
      user_id TEXT PRIMARY KEY,
      affiliate_id TEXT NOT NULL,
      code TEXT NOT NULL,
      at BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ${p}attributions_affiliate_idx ON ${p}attributions (affiliate_id)`,
    ...pgOnly,
  ];
}

/**
 * One invite per invitee (0.3.0). Runs after `ddl()`; idempotent, so it also upgrades 0.2 tables:
 * 1. adds `legacy_dup` (Postgres here; SQLite has no ADD COLUMN IF NOT EXISTS, sqlStore checks first),
 * 2. marks every redemption that is not a user's first as `legacy_dup = 1` (only rows written before
 *    0.3.0 can be such duplicates; they stay used and keep their history),
 * 3. adds a unique index on `used_by` over the remaining rows, so a user can hold one redeemed invite.
 */
export function upgradeDdl(prefix: string, dialect: Dialect = 'sqlite', qualify = ''): string[] {
  const p = checkPrefix(prefix);
  const t = `${qualify}${p}invites`;
  return [
    ...(dialect === 'postgres' ? [`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS legacy_dup INTEGER NOT NULL DEFAULT 0`] : []),
    `UPDATE ${t} SET legacy_dup = 1
      WHERE used_by IS NOT NULL AND legacy_dup = 0 AND EXISTS (
        SELECT 1 FROM ${t} o WHERE o.used_by = ${t}.used_by
          AND (o.used_at < ${t}.used_at OR (o.used_at = ${t}.used_at AND o.id < ${t}.id)))`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ${p}invites_one_per_user ON ${t} (used_by)
      WHERE used_by IS NOT NULL AND legacy_dup = 0`,
  ];
}

const isUniqueViolation = (err: unknown) =>
  (err as any)?.code === '23505' || /unique|duplicate key/i.test(String((err as Error)?.message ?? err));

/** Store over any SQL engine that speaks the common subset of SQLite and Postgres (RETURNING, ON CONFLICT). */
export function sqlStore(exec: Exec, opts: SqlStoreOptions = {}, dialect: Dialect = 'sqlite'): AffiliateStore {
  const p = checkPrefix(opts.prefix ?? 'aff_');
  let ready: Promise<void> | null = null;
  const init = () =>
    (ready ??= (async () => {
      for (const stmt of ddl(p, dialect)) await exec(stmt, []);
      if (dialect === 'sqlite') {
        const has = await exec(`SELECT 1 AS x FROM pragma_table_info('${p}invites') WHERE name = 'legacy_dup'`, []);
        if (has.length === 0) await exec(`ALTER TABLE ${p}invites ADD COLUMN legacy_dup INTEGER NOT NULL DEFAULT 0`, []);
      }
      for (const stmt of upgradeDdl(p, dialect)) await exec(stmt, []);
    })().catch((err) => {
      ready = null;
      throw err;
    }));
  const q = async (sql: string, params: unknown[] = []) => {
    await init();
    return exec(sql, params);
  };
  const COUNTED = `(revoked_at IS NULL OR used_by IS NOT NULL)`;

  return {
    async getQuota(userId) {
      const rows = await q(`SELECT total FROM ${p}quotas WHERE user_id = $1`, [userId]);
      return rows[0] ? Number(rows[0].total) : null;
    },
    async setQuota(userId, total) {
      await q(
        `INSERT INTO ${p}quotas (user_id, total) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET total = excluded.total`,
        [userId, total],
      );
    },
    async countInvites(inviterId) {
      const rows = await q(`SELECT count(*) AS n FROM ${p}invites WHERE inviter_id = $1 AND ${COUNTED}`, [inviterId]);
      return Number(rows[0]?.n ?? 0);
    },
    async insertInvite(row, limit) {
      if (dialect === 'postgres') {
        const res = await q(`SELECT ${p}insert_invite($1, $2, $3, $4, $5, $6, $7) AS ok`, [
          row.id, row.codeHash, row.inviterId, row.createdAt, row.expiresAt, row.note, limit,
        ]);
        return res[0]?.ok === true || res[0]?.ok === 't' || res[0]?.ok === 1;
      }
      // SQLite: writers are serialized, so the check and the insert cannot interleave.
      const rows = await q(
        `INSERT INTO ${p}invites (id, code_hash, inviter_id, created_at, expires_at, used_by, used_at, note, revoked_at)
         SELECT CAST($1 AS TEXT), CAST($2 AS TEXT), CAST($3 AS TEXT), CAST($4 AS BIGINT), CAST($5 AS BIGINT), NULL, NULL, CAST($6 AS TEXT), NULL
         WHERE (SELECT count(*) FROM ${p}invites WHERE inviter_id = CAST($3 AS TEXT) AND ${COUNTED}) < CAST($7 AS INTEGER)
         RETURNING id`,
        [row.id, row.codeHash, row.inviterId, row.createdAt, row.expiresAt, row.note, limit],
      );
      return rows.length > 0;
    },
    async getInviteByHash(codeHash) {
      const rows = await q(`SELECT * FROM ${p}invites WHERE code_hash = $1`, [codeHash]);
      return rows[0] ? toInvite(rows[0]) : null;
    },
    async getInvite(id) {
      const rows = await q(`SELECT * FROM ${p}invites WHERE id = $1`, [id]);
      return rows[0] ? toInvite(rows[0]) : null;
    },
    async claimInvite(id, userId, at) {
      // NOT EXISTS refuses a user who already redeemed an invite; the unique index on used_by is what
      // makes it hold when two redeems by the same user race (the loser gets a unique violation).
      try {
        const rows = await q(
          `UPDATE ${p}invites SET used_by = $2, used_at = $3
           WHERE id = $1 AND used_by IS NULL AND revoked_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM ${p}invites prior WHERE prior.used_by = $2)
           RETURNING id`,
          [id, userId, at],
        );
        return rows.length > 0;
      } catch (err) {
        if (isUniqueViolation(err)) return false;
        throw err;
      }
    },
    async revokeInvite(id, at) {
      await q(`UPDATE ${p}invites SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL`, [id, at]);
    },
    async listInvites(inviterId) {
      const rows = await q(`SELECT * FROM ${p}invites WHERE inviter_id = $1 ORDER BY created_at DESC, id`, [inviterId]);
      return rows.map(toInvite);
    },
    async invitedBy(userId) {
      const rows = await q(
        `SELECT inviter_id FROM ${p}invites WHERE used_by = $1 ORDER BY used_at ASC LIMIT 1`,
        [userId],
      );
      return rows[0] ? String(rows[0].inviter_id) : null;
    },
    async invitees(inviterId) {
      const rows = await q(
        `SELECT used_by, used_at FROM ${p}invites WHERE inviter_id = $1 AND used_by IS NOT NULL ORDER BY used_at ASC`,
        [inviterId],
      );
      return rows.map((r) => ({ userId: String(r.used_by), at: Number(r.used_at) }));
    },
    async getAffiliateCode(userId) {
      const rows = await q(`SELECT code FROM ${p}codes WHERE user_id = $1`, [userId]);
      return rows[0] ? String(rows[0].code) : null;
    },
    async putAffiliateCode(userId, code, at) {
      await q(
        `INSERT INTO ${p}codes (user_id, code, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [userId, code, at],
      );
      const rows = await q(`SELECT code FROM ${p}codes WHERE user_id = $1`, [userId]);
      return rows[0] ? String(rows[0].code) : null;
    },
    async affiliateByCode(code) {
      const rows = await q(`SELECT user_id FROM ${p}codes WHERE code = $1`, [code]);
      return rows[0] ? String(rows[0].user_id) : null;
    },
    async attribute(row: AttributionRow) {
      const rows = await q(
        `INSERT INTO ${p}attributions (user_id, affiliate_id, code, at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO NOTHING RETURNING user_id`,
        [row.userId, row.affiliateId, row.code, row.at],
      );
      return rows.length > 0;
    },
    async getAttribution(userId) {
      const rows = await q(`SELECT * FROM ${p}attributions WHERE user_id = $1`, [userId]);
      const r = rows[0];
      return r ? { userId: String(r.user_id), affiliateId: String(r.affiliate_id), code: String(r.code), at: Number(r.at) } : null;
    },
  };
}
