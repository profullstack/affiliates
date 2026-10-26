# @profullstack/affiliates

Scarce invite codes plus open affiliate links, for every Profullstack property.

- **Invite codes** are scarce on purpose. Each user gets a small quota (default 3). Each code
  works once, expires (default 30 days), cannot be redeemed by the person who made it, and records
  who invited whom. Each user can be invited once: a second invite is refused (`already_invited`)
  and stays unused, so one account cannot earn several inviters a bonus. Codes look like `INV-7K3M-QX9D-2F8H` (60 random bits, Crockford base32) and are
  stored only as sha256 hashes, so a database leak does not leak working codes.
- **Affiliate codes** are open: one stable public code per user, unlimited use, first-touch
  attribution that is never overwritten.
- **Commission math** is not reimplemented here. It comes from
  [`@profullstack/referrals`](https://www.npmjs.com/package/@profullstack/referrals)
  (`calculateReferral`, `DEFAULT_SPLIT` = 60% affiliate, 20% customer discount), and its
  `buildReferralUrl` / `extractCode` are re-exported.

Stores: in-memory, SQLite (`bun:sqlite`, `node:sqlite`, `better-sqlite3`), Postgres (anything
with a node-postgres style `query`) and Supabase (a supabase-js client, through `rpc()` only). SQL
stores create their own tables (prefix `aff_`); the Supabase store ships its schema as a migration.

```sh
npm i @profullstack/affiliates
```

## Quick start

```ts
import { Database } from 'bun:sqlite';               // or: import { DatabaseSync } from 'node:sqlite'
import { Affiliates, sqliteStore, buildReferralUrl, extractCode } from '@profullstack/affiliates';

const aff = new Affiliates(sqliteStore(new Database('app.db')));

// invites: scarce, single use
const invite = await aff.createInvite('user_alice', 'for Carol');
invite.code;                                          // 'INV-7K3M-QX9D-2F8H' (shown once, only the hash is stored)
await aff.quota('user_alice');                        // { total: 3, used: 1, left: 2 }
await aff.redeemInvite(invite.code, 'user_carol');    // { ok: true, inviterId: 'user_alice', inviteId: '...' }
await aff.redeemInvite(invite.code, 'user_dave');     // { ok: false, reason: 'used' }
const other = await aff.createInvite('user_bob');
await aff.redeemInvite(other.code, 'user_carol');     // { ok: false, reason: 'already_invited' } (other stays unused)
await aff.invitedBy('user_carol');                    // 'user_alice'
await aff.setQuota('user_alice', 10);                 // admin: hand out more

// affiliate links: open, unlimited, first touch wins
const code = await aff.affiliateCode('user_alice');   // 'E6KETYBK' (stable)
const link = buildReferralUrl('https://example.com/signup', code);  // ...?ref=E6KETYBK
await aff.attribute(extractCode(link)!, 'user_erin'); // { ok: true, affiliateId: 'user_alice' }
aff.commission(10_000);                               // { discountCents: 2000, commissionCents: 6000 }
```

Postgres:

```ts
import pg from 'pg';
import { Affiliates, postgresStore } from '@profullstack/affiliates';
const aff = new Affiliates(postgresStore(new pg.Pool({ connectionString: process.env.DATABASE_URL })));
```

## On Supabase

For apps that only have a supabase-js client (service role key, no direct `DATABASE_URL`). Every
operation is one `client.rpc()` call to a Postgres function, so the scarce parts are atomic in the
database, not read-modify-write in JS: the quota check and insert run under a per-inviter advisory
lock (the same logic as `postgresStore`'s `aff_insert_invite()`), redemption is
`UPDATE ... WHERE used_by IS NULL` backed by a unique index on `used_by` (one invite per user), and attribution is `INSERT ... ON CONFLICT DO NOTHING`.
`@supabase/supabase-js` is not a dependency; anything with `rpc(fn, args) -> { data, error }` works.

1. Add the migration (tables, RLS on with no policies, `SECURITY DEFINER` functions with a pinned
   `search_path`, executable only by `service_role`):

   ```sh
   cp node_modules/@profullstack/affiliates/migrations/supabase.sql supabase/migrations/20261026000000_affiliates.sql
   # other prefix: node -e "import('@profullstack/affiliates').then(m => process.stdout.write(m.supabaseMigrationSql('gc_')))" > ...
   ```

2. Use a service-role client on the server only:

   ```ts
   // lib/affiliates.ts  (server only)
   import { createClient } from '@supabase/supabase-js';
   import { Affiliates, supabaseStore } from '@profullstack/affiliates';
   let aff: Affiliates | undefined;
   export const getAffiliates = () => (aff ??= new Affiliates(supabaseStore(createClient(
     process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } }))));

   // app/auth/callback/route.ts, after exchangeCodeForSession() gave you `user`
   import { refFromRequest } from '@profullstack/affiliates';
   const ref = refFromRequest(request);                                   // ?ref= or the referral_code cookie
   if (ref) await getAffiliates().attribute(ref, user.id);                // { external: true } = not ours, see below
   ```

   Build the client lazily (as above), not at module top level: Next.js inlines `process.env.X` at
   build time, and a secret that is only present at runtime would compile in as `undefined`.

The tables are the same as `postgresStore`'s, so a script with a direct Postgres URL can use
`postgresStore` on the same data. `supabaseStore(client, { prefix })` must match the prefix the
migration was generated with. The anon and authenticated keys can neither read the tables nor call
the functions.

## Already using @profullstack/referrals

Sites that already ship `@profullstack/referrals` keep it: its tables, its `trackReferralCode`
middleware and its single `referral_code` cookie. Affiliates reads that cookie instead of setting
its own, so one sign-up is never counted twice.

- **Do not set a second cookie.** In the signup or auth callback, take the code with
  `refFromRequest(request)` (it reads `?ref=` and then `REF_COOKIE`, which is `'referral_code'`, the
  name `@profullstack/referrals/next` sets) and pass it to `aff.attribute(code, newUserId)`.
- **Codes that are theirs come back `{ ok: false, external: true }`** and nothing is recorded; hand
  them to the existing referrals flow (`applyReferral`, the site's own usage table). Our codes come
  back `{ ok: true, affiliateId }`. Unknown codes come back `{ ok: false }`.
- How "theirs" is decided: `supabaseStore` checks the `referral_codes` table from
  `20260602000000_referrals.sql` when it exists. Other stores take
  `new Affiliates(store, { externalCodes })`, where `externalCodes` is your @profullstack/referrals
  `ReferralStore` (its `getCode` is used) or a function `(code) => boolean | Promise<boolean>`.

```ts
const code = refFromRequest(request);
if (code) {
  const r = await aff.attribute(code, user.id);
  if (r.external) await applyReferral({ code, newUserId: user.id, amountCents, store: referralStore });
}
```

## Invite-only signup in 5 lines

```ts
const aff = new Affiliates(sqliteStore(db));
const r = await aff.redeemInvite(body.inviteCode, newUserId);    // in your signup handler, before creating the account
if (!r.ok) return new Response(`Invite ${r.reason}`, { status: 403 });
await createUser(newUserId, { invitedBy: r.inviterId });
// later, on the user's settings page: const { code } = await aff.createInvite(userId);
```

Allocate the user id before redeeming (or redeem inside the same transaction you create the user in)
so a failed account creation does not silently burn the invite. If it does, `setQuota` the inviter
one more.

## API

```ts
export type Invite = {
  code: string;            // plaintext, only on create
  id: string;
  inviterId: string;
  createdAt: number;       // ms
  expiresAt: number | null;
  usedBy: string | null;
  usedAt: number | null;
  note: string;
};
export type RedeemInviteResult =
  | { ok: true; inviterId: string; inviteId: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'used' | 'self' | 'revoked' | 'already_invited' };

export interface AffiliateStore { /* see src/store.ts: quota, invite, claim, attribution primitives */ }
export function memoryStore(): AffiliateStore;
export function sqliteStore(db: SqliteLike, opts?: { prefix?: string }): AffiliateStore;
export function postgresStore(
  pool: { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> },
  opts?: { prefix?: string },
): AffiliateStore;
export function supabaseStore(
  client: { rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: any; error: any }> },
  opts?: { prefix?: string },
): AffiliateStore;
export function supabaseMigrationSql(prefix?: string): string;   // = migrations/supabase.sql for 'aff_'
export function supabaseUpgradeSql(prefix?: string): string;     // = migrations/supabase-0.3.0-upgrade.sql

export const REF_COOKIE = 'referral_code';                        // @profullstack/referrals' cookie
export const REF_PARAM = 'ref';
export function refFromRequest(
  req: Request | { headers: Headers; url: string },
  opts?: { param?: string; cookieName?: string },
): string | null;                                                 // ?ref= first, then the cookie

export class Affiliates {
  constructor(store: AffiliateStore, opts?: {
    now?: () => number;              // clock, default Date.now
    defaultQuota?: number;           // default 3
    inviteTtlMs?: number | null;     // default 30 days, null = never expires
    split?: ReferralSplit;           // default DEFAULT_SPLIT from @profullstack/referrals
    externalCodes?: ReferralStore | ((code: string) => boolean | Promise<boolean>);
  });
  quota(userId: string): Promise<{ total: number; used: number; left: number }>;
  setQuota(userId: string, total: number): Promise<void>;
  createInvite(inviterId: string, note?: string): Promise<Invite>;   // throws Error('no invites left')
  redeemInvite(code: string, newUserId: string): Promise<RedeemInviteResult>;
  invitedBy(userId: string): Promise<string | null>;
  invitees(inviterId: string): Promise<{ userId: string; at: number }[]>;
  invites(inviterId: string): Promise<Omit<Invite, 'code'>[]>;       // newest first; also carries revokedAt
  revokeInvite(inviteId: string): Promise<void>;
  affiliateCode(userId: string): Promise<string>;
  attribute(code: string, newUserId: string): Promise<{ ok: boolean; affiliateId?: string; external?: boolean }>;
  isExternalCode(code: string): Promise<boolean>;
  affiliateOf(userId: string): Promise<string | null>;
  commission(amountCents: number): { discountCents: number; commissionCents: number };
}
export { buildReferralUrl, extractCode, calculateReferral, DEFAULT_SPLIT } from '@profullstack/referrals';
export function normalizeCode(input: string): string;
```

Semantics worth knowing:

- **Quota** counts every invite a user created except ones revoked before use, so revoking an unused
  invite refunds the slot. `setQuota` sets the total, not an increment.
- **Single use** is enforced in the store with `UPDATE ... WHERE used_by IS NULL AND revoked_at IS NULL`;
  under any number of concurrent redeems exactly one wins and the rest get `used`.
- **Quota under concurrency**: SQLite serializes writers, and on Postgres the check and insert run in
  a small `aff_insert_invite()` function under a per-inviter advisory lock, so parallel
  `createInvite` calls cannot overshoot.
- **One invite per invitee** (since 0.3.0): a user who already redeemed an invite gets
  `{ ok: false, reason: 'already_invited' }` and the second invite is not touched (still unused, still
  redeemable by someone else). It is atomic in every store: a unique index on `used_by` (memory: a
  synchronous check), so two concurrent redeems of two different codes by the same user give exactly
  one success. Before 0.3.0 both were used up and both inviters were credited.
- **Redeem order**: `invalid`, `revoked`, `used`, `self`, `expired`, `already_invited`. A self-redeem
  does not burn the invite. `invitedBy` returns the inviter of the user's first redeemed invite.
- **normalizeCode** uppercases, drops spaces and punctuation, and maps the Crockford look-alikes
  `O` to `0` and `I`/`L` to `1`. Invite codes come back as `INV-XXXX-XXXX-XXXX` (the `INV` prefix is
  optional on input), so `inv 7k3m qx9d 2f8h` redeems.
- **Affiliate attribution** is first touch: a second `attribute` for the same user returns
  `{ ok: false, affiliateId: <the original> }`. Users cannot attribute themselves. A code that is not
  ours but belongs to the site's @profullstack/referrals setup returns `{ ok: false, external: true }`.

Tables (prefix configurable): `aff_invites`, `aff_quotas`, `aff_codes`, `aff_attributions`.

## Upgrading from 0.2

0.2 let one user redeem several invites, crediting every inviter. 0.3.0 refuses the second one with
the new reason `'already_invited'` (an addition to the `RedeemInviteResult` union: a `switch` over
`reason` with no default needs one more case). The schema gains one column and one index:

- `aff_invites.legacy_dup INTEGER NOT NULL DEFAULT 0`: set to 1 on every redemption that was not a
  user's first. Only rows written before the upgrade can be such duplicates. They stay used and keep
  their history (`invitees` still lists them); they are only excluded from the new index.
- `aff_invites_one_per_user`: `UNIQUE (used_by) WHERE used_by IS NOT NULL AND legacy_dup = 0`.

**sqliteStore / postgresStore**: nothing to do. They run the upgrade on first use, idempotently, the
same way they create their tables.

**supabaseStore**: add one more migration. Either the delta:

```sh
cp node_modules/@profullstack/affiliates/migrations/supabase-0.3.0-upgrade.sql supabase/migrations/20261027000000_affiliates_0_3.sql
# other prefix: node -e "import('@profullstack/affiliates').then(m => process.stdout.write(m.supabaseUpgradeSql('gc_')))" > ...
```

or the whole of `migrations/supabase.sql` again (it is idempotent and contains the same statements).
It adds the column and index and replaces `aff_claim_invite()`; existing grants are kept.

**Schema you manage yourself** (your own migrations over `aff_` tables), the SQL is:

```sql
-- Postgres (SQLite: drop "IF NOT EXISTS" from ADD COLUMN and run it only if the column is missing)
ALTER TABLE aff_invites ADD COLUMN IF NOT EXISTS legacy_dup INTEGER NOT NULL DEFAULT 0;
UPDATE aff_invites SET legacy_dup = 1
  WHERE used_by IS NOT NULL AND legacy_dup = 0 AND EXISTS (
    SELECT 1 FROM aff_invites o WHERE o.used_by = aff_invites.used_by
      AND (o.used_at < aff_invites.used_at OR (o.used_at = aff_invites.used_at AND o.id < aff_invites.id)));
CREATE UNIQUE INDEX IF NOT EXISTS aff_invites_one_per_user ON aff_invites (used_by)
  WHERE used_by IS NOT NULL AND legacy_dup = 0;
```

To find accounts that took more than one invite before the upgrade (for clawing back bonuses):
`SELECT used_by, inviter_id, used_at FROM aff_invites WHERE legacy_dup = 1`.

## CLI

```sh
npx @profullstack/affiliates --db app.db invite create user_alice --note "for Carol"
affiliates --db app.db invite list user_alice
affiliates --db app.db invite revoke <inviteId>
affiliates --db app.db invite redeem INV-7K3M-QX9D-2F8H user_carol
affiliates --db app.db quota set user_alice 10
affiliates --db app.db quota get user_alice
affiliates --db app.db invitedby user_carol
affiliates --db app.db invitees user_alice
affiliates --db app.db code user_alice
affiliates --db app.db --json commission 10000
```

Works on a SQLite file through `node:sqlite` under Node (22.13+) and `bun:sqlite` under Bun. Every
command takes `--json`. Other options: `--prefix`, `--default-quota`, `--ttl-days` (0 = no expiry).
`--db` defaults to `$AFFILIATES_DB`, then `./affiliates.db`.

## Development

```sh
npm test                 # node --experimental-strip-types --test (memory + node:sqlite)
AFFILIATES_TEST_PG_URL=postgres://postgres:x@127.0.0.1:55432/postgres npm test   # adds real Postgres + supabaseStore over rpc()
# adds real PostgREST too (see .github/workflows and test/setup-postgrest.ts):
#   AFFILIATES_TEST_POSTGREST_URL=http://127.0.0.1:3000 AFFILIATES_TEST_POSTGREST_JWT_SECRET=... npm test
npm run gen:migration    # rewrite migrations/supabase.sql + supabase-0.3.0-upgrade.sql after changing them
npm run build            # tsc to dist/
```

MIT, Profullstack, Inc.
