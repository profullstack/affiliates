import { ddl } from './sql.ts';
import type { AffiliateStore, AttributionRow, InviteRow } from './store.ts';

/**
 * The one supabase-js call this store uses: `client.rpc(fn, args)`. A `SupabaseClient` from
 * `@supabase/supabase-js` (v2) fits as is; so does any PostgREST client with the same shape.
 * Use a service-role client: the functions are not executable by `anon` or `authenticated`.
 */
export interface SupabaseLike {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: any; error: any }>;
}

export interface SupabaseStoreOptions {
  /** Table and function name prefix. Default `aff_`. Must match the prefix the migration was generated with. */
  prefix?: string;
}

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

/** PostgREST returns a set-returning function as an array and a scalar one as the bare value. */
const rows = (data: unknown): any[] => (Array.isArray(data) ? data : data == null ? [] : [data]);
const scalar = (data: unknown): unknown => (Array.isArray(data) ? (data[0] ?? null) : data);
const truthy = (v: unknown) => v === true || v === 't' || v === 'true' || v === 1;

/**
 * SQL for a Supabase migration: the four tables (same schema as `postgresStore`, so both stores can
 * share them), RLS enabled with no policies (anon and authenticated keys see nothing), and one
 * SECURITY DEFINER function per store operation with a pinned search_path, executable only by
 * `service_role`. The scarce operations are atomic inside those functions: quota check + insert
 * under a per-inviter advisory lock, single-use claim with `UPDATE ... WHERE used_by IS NULL`, and
 * first-touch attribution with `ON CONFLICT DO NOTHING`. Idempotent: safe to run twice.
 */
export function supabaseMigrationSql(prefix = 'aff_'): string {
  const p = checkPrefix(prefix);
  const sigs: string[] = [];
  const bodies: string[] = [];
  const fn = (name: string, args: string, returns: string, body: string, lang: 'sql' | 'plpgsql' = 'sql') => {
    const types = args ? args.split(',').map((a) => a.trim().split(/\s+/).slice(1).join(' ')) : [];
    sigs.push(`public.${p}${name}(${types.join(', ')})`);
    bodies.push(`CREATE OR REPLACE FUNCTION public.${p}${name}(${args})
RETURNS ${returns}
LANGUAGE ${lang}
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
${body.trim()}
$fn$;
`);
  };
  const T = `public.${p}invites`;
  const COUNTED = `(revoked_at IS NULL OR used_by IS NOT NULL)`;

  fn('get_quota', 'p_user TEXT', 'INTEGER', `SELECT total FROM public.${p}quotas WHERE user_id = p_user`);
  fn(
    'set_quota',
    'p_user TEXT, p_total INTEGER',
    'VOID',
    `INSERT INTO public.${p}quotas (user_id, total) VALUES (p_user, p_total)
  ON CONFLICT (user_id) DO UPDATE SET total = excluded.total`,
  );
  fn(
    'count_invites',
    'p_inviter TEXT',
    'INTEGER',
    `SELECT count(*)::INTEGER FROM ${T} WHERE inviter_id = p_inviter AND ${COUNTED}`,
  );
  // Same logic and signature as postgresStore's insert_invite(), so the two stores can share a schema.
  fn(
    'insert_invite',
    'p_id TEXT, p_hash TEXT, p_inviter TEXT, p_created BIGINT, p_expires BIGINT, p_note TEXT, p_limit INTEGER',
    'BOOLEAN',
    `BEGIN
  -- Per-inviter lock; plpgsql takes a fresh snapshot per statement, so the count sees every committed invite.
  PERFORM pg_advisory_xact_lock(hashtext('${p}invites'), hashtext(p_inviter));
  IF (SELECT count(*) FROM ${T} WHERE inviter_id = p_inviter AND ${COUNTED}) >= p_limit THEN
    RETURN FALSE;
  END IF;
  INSERT INTO ${T} (id, code_hash, inviter_id, created_at, expires_at, note)
    VALUES (p_id, p_hash, p_inviter, p_created, p_expires, coalesce(p_note, ''));
  RETURN TRUE;
END`,
    'plpgsql',
  );
  fn('get_invite_by_hash', 'p_hash TEXT', `SETOF ${T}`, `SELECT * FROM ${T} WHERE code_hash = p_hash`);
  fn('get_invite', 'p_id TEXT', `SETOF ${T}`, `SELECT * FROM ${T} WHERE id = p_id`);
  fn(
    'claim_invite',
    'p_id TEXT, p_user TEXT, p_at BIGINT',
    'BOOLEAN',
    `WITH won AS (
  UPDATE ${T} SET used_by = p_user, used_at = p_at
  WHERE id = p_id AND used_by IS NULL AND revoked_at IS NULL
  RETURNING 1
)
SELECT EXISTS (SELECT 1 FROM won)`,
  );
  fn(
    'revoke_invite',
    'p_id TEXT, p_at BIGINT',
    'VOID',
    `UPDATE ${T} SET revoked_at = p_at WHERE id = p_id AND revoked_at IS NULL`,
  );
  fn(
    'list_invites',
    'p_inviter TEXT',
    `SETOF ${T}`,
    `SELECT * FROM ${T} WHERE inviter_id = p_inviter ORDER BY created_at DESC, id`,
  );
  fn(
    'invited_by',
    'p_user TEXT',
    'TEXT',
    `SELECT inviter_id FROM ${T} WHERE used_by = p_user ORDER BY used_at ASC LIMIT 1`,
  );
  fn(
    'invitees',
    'p_inviter TEXT',
    'TABLE (user_id TEXT, at BIGINT)',
    `SELECT used_by, used_at FROM ${T}
  WHERE inviter_id = p_inviter AND used_by IS NOT NULL ORDER BY used_at ASC`,
  );
  fn('get_affiliate_code', 'p_user TEXT', 'TEXT', `SELECT code FROM public.${p}codes WHERE user_id = p_user`);
  fn(
    'put_affiliate_code',
    'p_user TEXT, p_code TEXT, p_at BIGINT',
    'TEXT',
    `BEGIN
  INSERT INTO public.${p}codes (user_id, code, created_at) VALUES (p_user, p_code, p_at) ON CONFLICT DO NOTHING;
  RETURN (SELECT code FROM public.${p}codes WHERE user_id = p_user);
END`,
    'plpgsql',
  );
  fn('affiliate_by_code', 'p_code TEXT', 'TEXT', `SELECT user_id FROM public.${p}codes WHERE code = p_code`);
  fn(
    'attribute',
    'p_user TEXT, p_affiliate TEXT, p_code TEXT, p_at BIGINT',
    'BOOLEAN',
    `WITH ins AS (
  INSERT INTO public.${p}attributions (user_id, affiliate_id, code, at) VALUES (p_user, p_affiliate, p_code, p_at)
  ON CONFLICT (user_id) DO NOTHING
  RETURNING 1
)
SELECT EXISTS (SELECT 1 FROM ins)`,
  );
  fn(
    'get_attribution',
    'p_user TEXT',
    `SETOF public.${p}attributions`,
    `SELECT * FROM public.${p}attributions WHERE user_id = p_user`,
  );
  // True when the code is an @profullstack/referrals code: a row in its `referral_codes` table
  // (20260602000000_referrals.sql, codes stored upper-case). False when that table does not exist.
  fn(
    'is_external_code',
    'p_code TEXT',
    'BOOLEAN',
    `DECLARE found BOOLEAN := FALSE;
BEGIN
  IF to_regclass('public.referral_codes') IS NULL THEN
    RETURN FALSE;
  END IF;
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.referral_codes WHERE code = $1)'
    INTO found USING upper(btrim(p_code));
  RETURN found;
END`,
    'plpgsql',
  );

  const tables = ddl(p, 'sqlite').map((s) => s.replace(/CREATE (TABLE|INDEX) IF NOT EXISTS (\w+)/, (_m, kind, name) =>
    kind === 'TABLE' ? `CREATE TABLE IF NOT EXISTS public.${name}` : `CREATE INDEX IF NOT EXISTS ${name}`,
  ).replace(/ ON (\w+) \(/, ' ON public.$1 (').replace(/\n\s+\)$/, '\n)').replace(/\n\s+/g, '\n  ') + ';');
  const names = ['invites', 'quotas', 'codes', 'attributions'];
  const each = (role: string, stmt: (s: string) => string) =>
    `  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN\n${sigs.map((s) => `    ${stmt(s)}`).join('\n')}\n  END IF;`;
  return [
    `-- @profullstack/affiliates: Supabase migration (prefix ${p})`,
    `-- Generated by supabaseMigrationSql('${p}'). Same tables as postgresStore, so both stores can share them.`,
    `-- Use with supabaseStore(serviceRoleClient). Idempotent.`,
    '',
    ...tables,
    '',
    '-- RLS on with no policies: anon and authenticated keys see nothing. Access goes only through the',
    '-- SECURITY DEFINER functions below, which only service_role may execute.',
    ...names.map((n) => `ALTER TABLE public.${p}${n} ENABLE ROW LEVEL SECURITY;`),
    '',
    ...bodies,
    ...sigs.map((s) => `REVOKE ALL ON FUNCTION ${s} FROM PUBLIC;`),
    '',
    `DO $grants$
BEGIN
${each('anon', (s) => `REVOKE ALL ON FUNCTION ${s} FROM anon;`)}
${each('authenticated', (s) => `REVOKE ALL ON FUNCTION ${s} FROM authenticated;`)}
${each('service_role', (s) => `GRANT EXECUTE ON FUNCTION ${s} TO service_role;`)}
${['anon', 'authenticated'].map((role) => `  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN\n${names.map((n) => `    REVOKE ALL ON TABLE public.${p}${n} FROM ${role};`).join('\n')}\n  END IF;`).join('\n')}
END
$grants$;`,
    '',
    "NOTIFY pgrst, 'reload schema';",
    '',
  ].join('\n');
}

/**
 * Store over supabase-js / PostgREST (service-role client). Every operation is one `rpc()` call to a
 * function from `supabaseMigrationSql()` (shipped as `migrations/supabase.sql`); apply it first.
 * Also answers `isExternalCode` from @profullstack/referrals' `referral_codes` table when it exists.
 */
export function supabaseStore(client: SupabaseLike, opts: SupabaseStoreOptions = {}): AffiliateStore {
  const p = checkPrefix(opts.prefix ?? 'aff_');
  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const { data, error } = await client.rpc(`${p}${name}`, args);
    if (error) {
      const msg = typeof error === 'string' ? error : (error.message ?? JSON.stringify(error));
      throw new Error(`${p}${name}: ${msg}`, { cause: error });
    }
    return data;
  };

  return {
    async getQuota(userId) {
      return num(scalar(await call('get_quota', { p_user: userId })));
    },
    async setQuota(userId, total) {
      await call('set_quota', { p_user: userId, p_total: total });
    },
    async countInvites(inviterId) {
      return Number(scalar(await call('count_invites', { p_inviter: inviterId })) ?? 0);
    },
    async insertInvite(row, limit) {
      const ok = await call('insert_invite', {
        p_id: row.id,
        p_hash: row.codeHash,
        p_inviter: row.inviterId,
        p_created: row.createdAt,
        p_expires: row.expiresAt,
        p_note: row.note,
        p_limit: limit,
      });
      return truthy(scalar(ok));
    },
    async getInviteByHash(codeHash) {
      const r = rows(await call('get_invite_by_hash', { p_hash: codeHash }))[0];
      return r ? toInvite(r) : null;
    },
    async getInvite(id) {
      const r = rows(await call('get_invite', { p_id: id }))[0];
      return r ? toInvite(r) : null;
    },
    async claimInvite(id, userId, at) {
      return truthy(scalar(await call('claim_invite', { p_id: id, p_user: userId, p_at: at })));
    },
    async revokeInvite(id, at) {
      await call('revoke_invite', { p_id: id, p_at: at });
    },
    async listInvites(inviterId) {
      return rows(await call('list_invites', { p_inviter: inviterId })).map(toInvite);
    },
    async invitedBy(userId) {
      return str(scalar(await call('invited_by', { p_user: userId })));
    },
    async invitees(inviterId) {
      return rows(await call('invitees', { p_inviter: inviterId })).map((r) => ({
        userId: String(r.user_id),
        at: Number(r.at),
      }));
    },
    async getAffiliateCode(userId) {
      return str(scalar(await call('get_affiliate_code', { p_user: userId })));
    },
    async putAffiliateCode(userId, code, at) {
      return str(scalar(await call('put_affiliate_code', { p_user: userId, p_code: code, p_at: at })));
    },
    async affiliateByCode(code) {
      return str(scalar(await call('affiliate_by_code', { p_code: code })));
    },
    async attribute(row: AttributionRow) {
      const ok = await call('attribute', {
        p_user: row.userId,
        p_affiliate: row.affiliateId,
        p_code: row.code,
        p_at: row.at,
      });
      return truthy(scalar(ok));
    },
    async getAttribution(userId) {
      const r = rows(await call('get_attribution', { p_user: userId }))[0];
      return r
        ? { userId: String(r.user_id), affiliateId: String(r.affiliate_id), code: String(r.code), at: Number(r.at) }
        : null;
    },
    async isExternalCode(code) {
      return truthy(scalar(await call('is_external_code', { p_code: code })));
    },
  };
}
