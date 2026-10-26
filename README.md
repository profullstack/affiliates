# @profullstack/affiliates

Scarce invite codes plus open affiliate links, for every Profullstack property.

- **Invite codes** are scarce on purpose. Each user gets a small quota (default 3). Each code
  works once, expires (default 30 days), cannot be redeemed by the person who made it, and records
  who invited whom. Codes look like `INV-7K3M-QX9D-2F8H` (60 random bits, Crockford base32) and are
  stored only as sha256 hashes, so a database leak does not leak working codes.
- **Affiliate codes** are open: one stable public code per user, unlimited use, first-touch
  attribution that is never overwritten.
- **Commission math** is not reimplemented here. It comes from
  [`@profullstack/referrals`](https://www.npmjs.com/package/@profullstack/referrals)
  (`calculateReferral`, `DEFAULT_SPLIT` = 60% affiliate, 20% customer discount), and its
  `buildReferralUrl` / `extractCode` are re-exported.

Stores: in-memory, SQLite (`bun:sqlite`, `node:sqlite`, `better-sqlite3`) and Postgres (anything
with a node-postgres style `query`). SQL stores create their own tables (prefix `aff_`).

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
  | { ok: false; reason: 'invalid' | 'expired' | 'used' | 'self' | 'revoked' };

export interface AffiliateStore { /* see src/store.ts: quota, invite, claim, attribution primitives */ }
export function memoryStore(): AffiliateStore;
export function sqliteStore(db: SqliteLike, opts?: { prefix?: string }): AffiliateStore;
export function postgresStore(
  pool: { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> },
  opts?: { prefix?: string },
): AffiliateStore;

export class Affiliates {
  constructor(store: AffiliateStore, opts?: {
    now?: () => number;              // clock, default Date.now
    defaultQuota?: number;           // default 3
    inviteTtlMs?: number | null;     // default 30 days, null = never expires
    split?: ReferralSplit;           // default DEFAULT_SPLIT from @profullstack/referrals
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
  attribute(code: string, newUserId: string): Promise<{ ok: boolean; affiliateId?: string }>;
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
- **Redeem order**: `invalid`, `revoked`, `used`, `self`, `expired`. A self-redeem does not burn the
  invite. If a user redeems two different invites, `invitedBy` returns the first inviter.
- **normalizeCode** uppercases, drops spaces and punctuation, and maps the Crockford look-alikes
  `O` to `0` and `I`/`L` to `1`. Invite codes come back as `INV-XXXX-XXXX-XXXX` (the `INV` prefix is
  optional on input), so `inv 7k3m qx9d 2f8h` redeems.
- **Affiliate attribution** is first touch: a second `attribute` for the same user returns
  `{ ok: false, affiliateId: <the original> }`. Users cannot attribute themselves.

Tables (prefix configurable): `aff_invites`, `aff_quotas`, `aff_codes`, `aff_attributions`.

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
AFFILIATES_TEST_PG_URL=postgres://postgres:x@127.0.0.1:55432/postgres npm test   # adds real Postgres
npm run build            # tsc to dist/
```

MIT, Profullstack, Inc.
