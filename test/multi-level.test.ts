import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { Affiliates, MAX_LEVELS, memoryStore, sqliteStore, postgresStore, supabaseStore, type AffiliateStore } from '../src/index.ts';
import { fakeSupabase } from './fake-supabase.ts';

const PG_URL = process.env.AFFILIATES_TEST_PG_URL;
const pools: pg.Pool[] = [];
let n = 0;
after(async () => {
  await Promise.all(pools.map((p) => p.end()));
});

const stores: [string, () => AffiliateStore][] = [
  ['memory', () => memoryStore()],
  ['sqlite', () => sqliteStore(new DatabaseSync(':memory:'))],
];
if (PG_URL) {
  stores.push([
    'postgres',
    () => {
      const pool = new pg.Pool({ connectionString: PG_URL, max: 5 });
      pools.push(pool);
      return postgresStore(pool, { prefix: `ml${process.pid}_${++n}_` });
    },
  ]);
  // supabaseStore: every call is an rpc() to the migration's functions, attributed_to included
  const pool = new pg.Pool({ connectionString: PG_URL, max: 5 });
  pools.push(pool);
  stores.push(['supabase rpc', () => supabaseStore(fakeSupabase(pool, { prefix: `mls${process.pid}_${++n}_` }) as never, { prefix: `mls${process.pid}_${n}_` })]);
}

/** Link `child` under `parent` with parent's affiliate link. */
async function link(aff: Affiliates, parent: string, child: string) {
  const r = await aff.attribute(await aff.affiliateCode(parent), child);
  assert.equal(r.ok, true, `${child} under ${parent}`);
}

for (const [name, make] of stores) {
  describe(`multi-level (${name})`, () => {
    test('default plan is single-level and equals commission()', async () => {
      const aff = new Affiliates(make());
      assert.deepEqual([...aff.levels], [0.6]);
      await link(aff, 'a', 'b');
      await link(aff, 'b', 'c');
      const p = await aff.payouts('c', 10_000);
      const c = aff.commission(10_000);
      assert.deepEqual(p.lines, [{ affiliateId: 'b', level: 1, rate: 0.6, cents: c.commissionCents }]);
      assert.equal(p.discountCents, c.discountCents);
      assert.equal(p.totalCents, c.commissionCents);
    });

    test('a buyer with no referrer pays nothing out and gets no discount', async () => {
      const aff = new Affiliates(make(), { levels: [0.2, 0.05] });
      const p = await aff.payouts('lonely', 10_000);
      assert.deepEqual(p, { amountCents: 10_000, discountCents: 0, lines: [], totalCents: 0 });
    });

    test('three-level plan pays each ancestor its rate, nearest first', async () => {
      const aff = new Affiliates(make(), { levels: [0.2, 0.05, 0.02] });
      await link(aff, 'a', 'b');
      await link(aff, 'b', 'c');
      await link(aff, 'c', 'd');
      await link(aff, 'd', 'e');
      const p = await aff.payouts('e', 10_000);
      assert.deepEqual(
        p.lines.map((l) => [l.affiliateId, l.level, l.cents]),
        [['d', 1, 2000], ['c', 2, 500], ['b', 3, 200]],
      );
      assert.equal(p.totalCents, 2700);
      assert.equal(p.discountCents, 2000);
      // 'a' is level 4: beyond the plan, unpaid
      assert.ok(!p.lines.some((l) => l.affiliateId === 'a'));
    });

    test('a short upline pays only the levels that exist', async () => {
      const aff = new Affiliates(make(), { levels: [0.2, 0.05, 0.02] });
      await link(aff, 'a', 'b');
      const p = await aff.payouts('b', 999);
      assert.deepEqual(p.lines, [{ affiliateId: 'a', level: 1, rate: 0.2, cents: 199 }]);
    });

    test('invites count as a parent when there is no link', async () => {
      const aff = new Affiliates(make(), { levels: [0.1, 0.1] });
      const inv = await aff.createInvite('a');
      assert.equal((await aff.redeemInvite(inv.code, 'b')).ok, true);
      await link(aff, 'b', 'c');
      const up = await aff.upline('c');
      assert.deepEqual(up, [
        { userId: 'b', level: 1, via: 'link' },
        { userId: 'a', level: 2, via: 'invite' },
      ]);
      assert.equal((await aff.payouts('c', 1000)).totalCents, 200);
    });

    test('an ineligible ancestor is skipped and their share stays with the house', async () => {
      const aff = new Affiliates(make(), { levels: [0.2, 0.05, 0.02], eligible: (u) => u !== 'c' });
      await link(aff, 'a', 'b');
      await link(aff, 'b', 'c');
      await link(aff, 'c', 'd');
      const p = await aff.payouts('d', 10_000);
      assert.deepEqual(p.lines.map((l) => [l.affiliateId, l.level, l.cents]), [['b', 2, 500], ['a', 3, 200]]);
    });

    test('attribute() refuses a link that would loop', async () => {
      const aff = new Affiliates(make(), { levels: [0.1, 0.1] });
      await link(aff, 'a', 'b');
      await link(aff, 'b', 'c');
      // 'a' has no referrer yet; linking 'a' under 'c' (its own grandchild) would loop
      const r = await aff.attribute(await aff.affiliateCode('c'), 'a');
      assert.deepEqual(r, { ok: false, cycle: true });
      assert.equal(await aff.affiliateOf('a'), null);
    });

    test('redeemInvite() refuses an invite from your own downline', async () => {
      const aff = new Affiliates(make());
      await link(aff, 'a', 'b');
      const inv = await aff.createInvite('b');
      assert.deepEqual(await aff.redeemInvite(inv.code, 'a'), { ok: false, reason: 'cycle' });
    });

    test('downline lists the tree breadth first with parents', async () => {
      const aff = new Affiliates(make(), { levels: [0.1, 0.1, 0.1] });
      await link(aff, 'a', 'b');
      await link(aff, 'a', 'c');
      await link(aff, 'b', 'd');
      const inv = await aff.createInvite('d');
      assert.equal((await aff.redeemInvite(inv.code, 'e')).ok, true);
      const down = await aff.downline('a');
      assert.deepEqual(
        down.map((d) => [d.userId, d.level, d.parentId]),
        [['b', 1, 'a'], ['c', 1, 'a'], ['d', 2, 'b'], ['e', 3, 'd']],
      );
      assert.deepEqual((await aff.downline('a', 1)).map((d) => d.userId), ['b', 'c']);
    });

    test('rounding never pays more than the rate, and small sales can pay nothing', async () => {
      const aff = new Affiliates(make(), { levels: [0.2, 0.05, 0.02] });
      await link(aff, 'a', 'b');
      await link(aff, 'b', 'c');
      await link(aff, 'c', 'd');
      for (const amount of [0, 1, 7, 49, 101, 123_457]) {
        const p = await aff.payouts('d', amount);
        for (const l of p.lines) assert.ok(l.cents <= amount * l.rate && l.cents > 0);
        assert.ok(p.totalCents + p.discountCents <= amount);
      }
      assert.deepEqual((await aff.payouts('d', 1)).lines, []);
    });
  });
}

describe('level plan validation', () => {
  const store = () => memoryStore();
  test('refuses a plan that pays out more than the sale', () => {
    // default customer discount 0.2: 0.6 + 0.3 + 0.2 > 1
    assert.throws(() => new Affiliates(store(), { levels: [0.6, 0.3] }), /more than the purchase/);
  });
  test('accepts a plan that uses exactly the whole sale', () => {
    assert.doesNotThrow(() => new Affiliates(store(), { levels: [0.6, 0.2] }));
  });
  test('refuses bad rates, empty plans and too many levels', () => {
    assert.throws(() => new Affiliates(store(), { levels: [] }), /non-empty/);
    assert.throws(() => new Affiliates(store(), { levels: [-0.1] }), /0 to 1/);
    assert.throws(() => new Affiliates(store(), { levels: [Number.NaN] }), /0 to 1/);
    assert.throws(
      () => new Affiliates(store(), { levels: Array(MAX_LEVELS + 1).fill(0.01) }),
      /at most/,
    );
  });
  test('a custom split frees room for deeper levels', () => {
    const split = { affiliate: 0.3, customer: 0, total: 0.3 };
    const aff = new Affiliates(store(), { split, levels: [0.3, 0.2, 0.1, 0.05] });
    assert.equal(aff.levels.length, 4);
  });
});
