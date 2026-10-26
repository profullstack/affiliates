import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { calculateReferral, DEFAULT_SPLIT } from '@profullstack/referrals';
import {
  Affiliates,
  memoryStore,
  sqliteStore,
  postgresStore,
  supabaseStore,
  normalizeCode,
  buildReferralUrl,
  extractCode,
  type AffiliateStore,
} from '../src/index.ts';

import pg from 'pg';
import { fakeSupabase, postgrestLikePool } from './fake-supabase.ts';

// Real Postgres runs when AFFILIATES_TEST_PG_URL is set, e.g.
//   docker run --rm -e POSTGRES_PASSWORD=x -p 55432:5432 postgres:16-alpine
//   AFFILIATES_TEST_PG_URL=postgres://postgres:x@127.0.0.1:55432/postgres npm test
const PG_URL = process.env.AFFILIATES_TEST_PG_URL;
const pools: pg.Pool[] = [];
let pgSchemaN = 0;
function pgStore(): AffiliateStore {
  const pool = new pg.Pool({ connectionString: PG_URL, max: 10 });
  pools.push(pool);
  // fresh tables per test via a unique prefix
  return postgresStore(pool, { prefix: `t${process.pid}_${++pgSchemaN}_` });
}
after(async () => {
  await Promise.all(pools.map((p) => p.end()));
});

const stores: [string, () => AffiliateStore][] = [
  ['memory', () => memoryStore()],
  ['sqlite (node:sqlite)', () => sqliteStore(new DatabaseSync(':memory:'))],
  ['sqlite custom prefix', () => sqliteStore(new DatabaseSync(':memory:'), { prefix: 'inv_' })],
];
function sbStore(): AffiliateStore {
  const pool = postgrestLikePool(pg, PG_URL!);
  pools.push(pool);
  const prefix = `s${process.pid}_${++pgSchemaN}_`;
  return supabaseStore(fakeSupabase(pool, { prefix }), { prefix });
}
if (PG_URL) stores.push(['postgres (real)', pgStore], ['supabase rpc (real Postgres)', sbStore]);

const DAY = 86_400_000;

for (const [name, make] of stores) {
  describe(name, () => {
    const setup = (opts: ConstructorParameters<typeof Affiliates>[1] = {}) => {
      let t = 1_700_000_000_000;
      const clock = { now: () => t, advance: (ms: number) => (t += ms) };
      const aff = new Affiliates(make(), { now: clock.now, ...opts });
      return { aff, clock };
    };

    test('default quota is 3 and exhausts with "no invites left"', async () => {
      const { aff } = setup();
      assert.deepEqual(await aff.quota('alice'), { total: 3, used: 0, left: 3 });
      for (let i = 0; i < 3; i++) await aff.createInvite('alice', `#${i}`);
      assert.deepEqual(await aff.quota('alice'), { total: 3, used: 3, left: 0 });
      await assert.rejects(aff.createInvite('alice'), { message: 'no invites left' });
    });

    test('quota holds under concurrent creates', async () => {
      const { aff } = setup({ defaultQuota: 2 });
      const results = await Promise.allSettled(Array.from({ length: 10 }, () => aff.createInvite('bob')));
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
      assert.equal((await aff.invites('bob')).length, 2);
    });

    test('setQuota gives more invites', async () => {
      const { aff } = setup({ defaultQuota: 1 });
      await aff.createInvite('alice');
      await assert.rejects(aff.createInvite('alice'), /no invites left/);
      await aff.setQuota('alice', 3);
      assert.deepEqual(await aff.quota('alice'), { total: 3, used: 1, left: 2 });
      await aff.createInvite('alice');
      await aff.setQuota('alice', 10);
      assert.equal((await aff.quota('alice')).left, 8);
      await assert.rejects(aff.setQuota('alice', -1));
    });

    test('invite code shape, hashed storage, listing without code', async () => {
      const { aff } = setup();
      const inv = await aff.createInvite('alice', 'for carol');
      assert.match(inv.code, /^INV-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
      assert.equal(inv.inviterId, 'alice');
      assert.equal(inv.note, 'for carol');
      assert.equal(inv.expiresAt, inv.createdAt + 30 * DAY);
      assert.equal(inv.usedBy, null);
      const [listed] = await aff.invites('alice');
      assert.ok(listed);
      assert.equal('code' in listed, false);
      assert.equal(listed.id, inv.id);
      assert.equal(JSON.stringify(listed).includes(inv.code), false);
    });

    test('redeem is single use and records who invited whom', async () => {
      const { aff } = setup();
      const inv = await aff.createInvite('alice');
      const r = await aff.redeemInvite(inv.code, 'carol');
      assert.deepEqual(r, { ok: true, inviterId: 'alice', inviteId: inv.id });
      assert.deepEqual(await aff.redeemInvite(inv.code, 'dave'), { ok: false, reason: 'used' });
      assert.equal(await aff.invitedBy('carol'), 'alice');
      assert.equal(await aff.invitedBy('dave'), null);
      const invitees = await aff.invitees('alice');
      assert.equal(invitees.length, 1);
      assert.equal(invitees[0]?.userId, 'carol');
      const [listed] = await aff.invites('alice');
      assert.equal(listed?.usedBy, 'carol');
      assert.equal(typeof listed?.usedAt, 'number');
    });

    test('single use under concurrency: exactly one of 25 racers wins', async () => {
      const { aff } = setup();
      const inv = await aff.createInvite('alice');
      const results = await Promise.all(Array.from({ length: 25 }, (_, i) => aff.redeemInvite(inv.code, `u${i}`)));
      const wins = results.filter((r) => r.ok);
      assert.equal(wins.length, 1);
      assert.ok(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === 'used'));
      assert.equal((await aff.invitees('alice')).length, 1);
    });

    test('a user who redeemed one invite is refused a second (already_invited) and it stays unused', async () => {
      const { aff } = setup();
      const a = await aff.createInvite('alice');
      const b = await aff.createInvite('bob');
      assert.equal((await aff.redeemInvite(a.code, 'carol')).ok, true);
      assert.deepEqual(await aff.redeemInvite(b.code, 'carol'), { ok: false, reason: 'already_invited' });
      const [bobs] = await aff.invites('bob');
      assert.equal(bobs?.usedBy, null);
      assert.equal(bobs?.usedAt, null);
      assert.deepEqual(await aff.invitees('bob'), []);
      assert.equal(await aff.invitedBy('carol'), 'alice');
      // the same code again is plain 'used'; bob's invite still works for someone new
      assert.deepEqual(await aff.redeemInvite(a.code, 'carol'), { ok: false, reason: 'used' });
      assert.deepEqual(await aff.redeemInvite(b.code, 'dave'), { ok: true, inviterId: 'bob', inviteId: b.id });
    });

    test('concurrent redeems of different invites by one user: exactly one succeeds', async () => {
      const { aff } = setup();
      const inviters = ['i1', 'i2', 'i3', 'i4', 'i5', 'i6'];
      const invs = await Promise.all(inviters.map((i) => aff.createInvite(i)));
      for (let round = 0; round < 3; round++) {
        const user = `racer${round}`;
        const results = await Promise.all(invs.map((inv) => aff.redeemInvite(inv.code, user)));
        const wins = results.filter((r) => r.ok);
        if (round === 0) {
          assert.equal(wins.length, 1, JSON.stringify(results));
          assert.ok(results.every((r) => r.ok || r.reason === 'already_invited'), JSON.stringify(results));
        } else {
          // the earlier round's winner used one invite; the rest are free again for a new user
          assert.equal(wins.length, 1, JSON.stringify(results));
        }
        const used = (await Promise.all(inviters.map((i) => aff.invites(i)))).flat().filter((r) => r.usedBy === user);
        assert.equal(used.length, 1);
        assert.equal(await aff.invitedBy(user), wins[0]?.ok ? wins[0].inviterId : null);
      }
    });

    test('redeem accepts sloppy input (case, spaces, look-alikes)', async () => {
      const { aff } = setup();
      const inv = await aff.createInvite('alice');
      const sloppy = ' ' + inv.code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l') + ' ';
      assert.equal((await aff.redeemInvite(sloppy, 'carol')).ok, true);
    });

    test('self-redeem is refused and does not burn the invite', async () => {
      const { aff } = setup();
      const inv = await aff.createInvite('alice');
      assert.deepEqual(await aff.redeemInvite(inv.code, 'alice'), { ok: false, reason: 'self' });
      assert.equal((await aff.redeemInvite(inv.code, 'carol')).ok, true);
    });

    test('unknown or empty code is invalid', async () => {
      const { aff } = setup();
      assert.deepEqual(await aff.redeemInvite('INV-0000-0000-0000', 'carol'), { ok: false, reason: 'invalid' });
      assert.deepEqual(await aff.redeemInvite('', 'carol'), { ok: false, reason: 'invalid' });
    });

    test('expiry with injected clock', async () => {
      const { aff, clock } = setup({ inviteTtlMs: 7 * DAY });
      const a = await aff.createInvite('alice');
      const b = await aff.createInvite('alice');
      clock.advance(7 * DAY - 1);
      assert.equal((await aff.redeemInvite(a.code, 'carol')).ok, true);
      clock.advance(1);
      assert.deepEqual(await aff.redeemInvite(b.code, 'dave'), { ok: false, reason: 'expired' });
    });

    test('inviteTtlMs null never expires', async () => {
      const { aff, clock } = setup({ inviteTtlMs: null });
      const a = await aff.createInvite('alice');
      assert.equal(a.expiresAt, null);
      clock.advance(10_000 * DAY);
      assert.equal((await aff.redeemInvite(a.code, 'carol')).ok, true);
    });

    test('revoke stops the code and refunds the quota slot', async () => {
      const { aff } = setup({ defaultQuota: 1 });
      const inv = await aff.createInvite('alice');
      assert.equal((await aff.quota('alice')).left, 0);
      await aff.revokeInvite(inv.id);
      assert.deepEqual(await aff.redeemInvite(inv.code, 'carol'), { ok: false, reason: 'revoked' });
      assert.equal((await aff.quota('alice')).left, 1);
      const again = await aff.createInvite('alice');
      assert.equal((await aff.redeemInvite(again.code, 'carol')).ok, true);
      // revoking a used invite does not refund it or undo the invite
      await aff.revokeInvite(again.id);
      assert.equal((await aff.quota('alice')).left, 0);
      assert.equal(await aff.invitedBy('carol'), 'alice');
    });

    test('affiliate code is stable per user and distinct across users', async () => {
      const { aff } = setup();
      const a1 = await aff.affiliateCode('alice');
      const a2 = await aff.affiliateCode('alice');
      const b = await aff.affiliateCode('bob');
      assert.equal(a1, a2);
      assert.notEqual(a1, b);
      assert.match(a1, /^[0-9A-HJKMNP-TV-Z]{8}$/);
      const [c1, c2] = await Promise.all([aff.affiliateCode('zed'), aff.affiliateCode('zed')]);
      assert.equal(c1, c2);
    });

    test('attribution is first-touch, never overwritten, never self', async () => {
      const { aff } = setup();
      const a = await aff.affiliateCode('alice');
      const b = await aff.affiliateCode('bob');
      assert.deepEqual(await aff.attribute(a.toLowerCase(), 'carol'), { ok: true, affiliateId: 'alice' });
      assert.deepEqual(await aff.attribute(b, 'carol'), { ok: false, affiliateId: 'alice' });
      assert.equal(await aff.affiliateOf('carol'), 'alice');
      assert.deepEqual(await aff.attribute(a, 'alice'), { ok: false });
      assert.deepEqual(await aff.attribute('NOPE1234', 'dave'), { ok: false });
      assert.equal(await aff.affiliateOf('dave'), null);
    });

    test('commission matches @profullstack/referrals DEFAULT_SPLIT', () => {
      const { aff } = setup();
      for (const amount of [0, 1, 999, 1000, 4999, 123_457]) {
        const ref = calculateReferral(amount, DEFAULT_SPLIT);
        assert.deepEqual(aff.commission(amount), { discountCents: ref.discountCents, commissionCents: ref.commissionCents });
      }
      assert.deepEqual(aff.commission(10_000), { discountCents: 2_000, commissionCents: 6_000 });
    });
  });
}

// 0.2 schema (no legacy_dup, no unique index) holding the bug: carol redeemed two invites.
const OLD_INVITES = (t: string) => `CREATE TABLE ${t} (
  id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, inviter_id TEXT NOT NULL, created_at BIGINT NOT NULL,
  expires_at BIGINT, used_by TEXT, used_at BIGINT, note TEXT NOT NULL DEFAULT '', revoked_at BIGINT)`;
const OLD_ROWS = (t: string) => `INSERT INTO ${t} (id, code_hash, inviter_id, created_at, expires_at, used_by, used_at) VALUES
  ('i1', 'h1', 'alice', 1, NULL, 'carol', 10),
  ('i2', 'h2', 'bob',   1, NULL, 'carol', 20),
  ('i3', 'h3', 'erin',  1, NULL, 'carol', 20),
  ('i4', 'h4', 'alice', 1, NULL, 'dave',  30)`;

async function checkUpgraded(aff: Affiliates, rowsOf: () => Promise<{ id: string; legacy_dup: unknown }[]>) {
  // store operations run the upgrade on first use
  assert.equal(await aff.invitedBy('carol'), 'alice');
  const flags = Object.fromEntries((await rowsOf()).map((r) => [r.id, Number(r.legacy_dup)]));
  assert.deepEqual(flags, { i1: 0, i2: 1, i3: 1, i4: 0 });
  // history is kept: the old extra redemptions still count as used
  assert.equal((await aff.invitees('bob'))[0]?.userId, 'carol');
  // and from now on the rule holds for old and new users alike
  const fresh = await aff.createInvite('frank');
  assert.deepEqual(await aff.redeemInvite(fresh.code, 'carol'), { ok: false, reason: 'already_invited' });
  assert.deepEqual(await aff.redeemInvite(fresh.code, 'dave'), { ok: false, reason: 'already_invited' });
  assert.equal((await aff.redeemInvite(fresh.code, 'gina')).ok, true);
}

describe('upgrade from a 0.2 schema with duplicate redemptions', () => {
  test('sqliteStore adds legacy_dup, marks the duplicates and the unique index on startup', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(OLD_INVITES('aff_invites'));
    db.exec(OLD_ROWS('aff_invites'));
    const aff = new Affiliates(sqliteStore(db));
    await checkUpgraded(aff, async () => db.prepare('SELECT id, legacy_dup FROM aff_invites WHERE id LIKE ? ORDER BY id').all('i%') as any);
    const idx = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'aff_invites_one_per_user'`).get() as any;
    assert.match(idx.sql, /UNIQUE INDEX/);
    // a second store on the same file is a no-op upgrade
    const again = new Affiliates(sqliteStore(db));
    assert.equal(await again.invitedBy('carol'), 'alice');
  });

  test('postgresStore upgrades in place', { skip: !PG_URL && 'set AFFILIATES_TEST_PG_URL' }, async () => {
    const pool = new pg.Pool({ connectionString: PG_URL, max: 4 });
    pools.push(pool);
    const prefix = `u${process.pid}_${++pgSchemaN}_`;
    await pool.query(OLD_INVITES(`${prefix}invites`));
    await pool.query(OLD_ROWS(`${prefix}invites`));
    const aff = new Affiliates(postgresStore(pool, { prefix }));
    await checkUpgraded(aff, async () =>
      (await pool.query(`SELECT id, legacy_dup FROM ${prefix}invites WHERE id LIKE 'i_' ORDER BY id`)).rows);
    const again = new Affiliates(postgresStore(pool, { prefix }));
    assert.equal(await again.invitedBy('carol'), 'alice');
  });
});

describe('codes', () => {
  test('normalizeCode', () => {
    assert.equal(normalizeCode('inv-7k3m-qx9d-2f8h'), 'INV-7K3M-QX9D-2F8H');
    assert.equal(normalizeCode('  INV 7K3M QX9D 2F8H '), 'INV-7K3M-QX9D-2F8H');
    assert.equal(normalizeCode('7k3mqx9d2f8h'), 'INV-7K3M-QX9D-2F8H');
    assert.equal(normalizeCode('INV-OOIL-0000-1111'), 'INV-0011-0000-1111');
    assert.equal(normalizeCode('ab-cd-ef-gh'), 'ABCDEFGH');
    assert.equal(normalizeCode('k0ol1i23'), 'K0011123');
    assert.equal(normalizeCode(''), '');
  });

  test('re-exported URL helpers from @profullstack/referrals', () => {
    const url = buildReferralUrl('https://example.com/signup', 'ABCD2345');
    assert.equal(extractCode(url), 'ABCD2345');
  });

  test('custom split flows through to calculateReferral', () => {
    const aff = new Affiliates(memoryStore(), { split: { affiliate: 0.3, customer: 0.1, total: 0.4 } });
    assert.deepEqual(aff.commission(1000), { discountCents: 100, commissionCents: 300 });
  });
});
