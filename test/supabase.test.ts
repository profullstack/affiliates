import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { createCode, type ReferralCode, type ReferralStore } from '@profullstack/referrals';
import { trackReferralCode } from '@profullstack/referrals/next';
import {
  Affiliates,
  memoryStore,
  supabaseStore,
  supabaseMigrationSql,
  supabaseUpgradeSql,
  refFromRequest,
  REF_COOKIE,
  REF_PARAM,
} from '../src/index.ts';
import { fakeSupabase, postgrestLikePool } from './fake-supabase.ts';

describe('referral cookie compatibility', () => {
  test('REF_COOKIE is the cookie @profullstack/referrals/next actually sets', () => {
    const set: [string, string][] = [];
    const request = { nextUrl: new URL('https://x.test/?ref=ABC123') };
    const response = { cookies: { set: (name: string, value: string) => void set.push([name, value]) } };
    trackReferralCode(request as any, response as any);
    assert.deepEqual(set, [[REF_COOKIE, 'ABC123']]);
    assert.equal(REF_COOKIE, 'referral_code');
    assert.equal(REF_PARAM, 'ref');
  });

  test('refFromRequest reads ?ref= first, then the referral_code cookie', () => {
    const req = (url: string, cookie?: string) =>
      new Request(url, cookie ? { headers: { cookie } } : undefined);
    assert.equal(refFromRequest(req('https://x.test/signup?ref=E6KETYBK')), 'E6KETYBK');
    assert.equal(refFromRequest(req('https://x.test/signup', 'theme=dark; referral_code=OLD123; a=b')), 'OLD123');
    assert.equal(refFromRequest(req('https://x.test/signup?ref=NEW', 'referral_code=OLD')), 'NEW');
    assert.equal(refFromRequest(req('https://x.test/signup', 'referral_code=a%20b')), 'a b');
    assert.equal(refFromRequest(req('https://x.test/signup', 'referral_code="Q1"')), 'Q1');
    assert.equal(refFromRequest(req('https://x.test/signup?ref=', 'other=1')), null);
    assert.equal(refFromRequest(req('https://x.test/')), null);
    assert.equal(refFromRequest(req('https://x.test/', 'my_referral_code=nope')), null);
    // plain { headers, url } (Hono c.req.raw, custom servers), relative url tolerated
    assert.equal(refFromRequest({ headers: new Headers({ cookie: 'referral_code=ZZ' }), url: '/auth/callback' }), 'ZZ');
    assert.equal(refFromRequest({ headers: new Headers(), url: '/x?ref=R1' }), 'R1');
    // custom names
    assert.equal(refFromRequest(req('https://x.test/?via=V'), { param: 'via' }), 'V');
    assert.equal(refFromRequest(req('https://x.test/', 'gc_ref=G'), { cookieName: 'gc_ref' }), 'G');
  });

  test('attribute() returns external for an @profullstack/referrals code (ReferralStore)', async () => {
    const codes = new Map<string, ReferralCode>();
    const refStore: ReferralStore = {
      async saveCode(c) { codes.set(c.code, c); },
      async getCode(c) { return codes.get(c) ?? null; },
      async saveUsage() {},
      async getUsagesByAffiliate() { return []; },
    };
    const legacy = await createCode('old_affiliate', refStore);
    const aff = new Affiliates(memoryStore(), { externalCodes: refStore });
    const ours = await aff.affiliateCode('alice');
    assert.deepEqual(await aff.attribute(legacy.code.toLowerCase(), 'erin'), { ok: false, external: true });
    assert.equal(await aff.affiliateOf('erin'), null);
    assert.deepEqual(await aff.attribute('NOTACODE', 'erin'), { ok: false });
    assert.deepEqual(await aff.attribute(ours, 'erin'), { ok: true, affiliateId: 'alice' });
  });

  test('attribute() external check as a function; without one, unknown codes are just not ok', async () => {
    const aff = new Affiliates(memoryStore(), { externalCodes: (c) => c === 'LEGACY1' });
    assert.deepEqual(await aff.attribute('LEGACY1', 'u1'), { ok: false, external: true });
    assert.deepEqual(await aff.attribute('OTHER', 'u1'), { ok: false });
    const plain = new Affiliates(memoryStore());
    assert.deepEqual(await plain.attribute('LEGACY1', 'u1'), { ok: false });
  });
});

describe('supabase migration', () => {
  test('migrations/supabase.sql is supabaseMigrationSql() output', () => {
    const file = readFileSync(new URL('../migrations/supabase.sql', import.meta.url), 'utf8');
    assert.equal(file, supabaseMigrationSql());
    const up = readFileSync(new URL('../migrations/supabase-0.3.0-upgrade.sql', import.meta.url), 'utf8');
    assert.equal(up, supabaseUpgradeSql());
  });

  test('every function is SECURITY DEFINER with a pinned search_path; prefix is validated', () => {
    const sql = supabaseMigrationSql('gc_');
    const fns = sql.match(/CREATE OR REPLACE FUNCTION/g)?.length ?? 0;
    assert.ok(fns >= 17);
    assert.equal(sql.match(/^SECURITY DEFINER$/gm)?.length, fns);
    assert.equal(sql.match(/SET search_path = public, pg_temp/g)?.length, fns);
    assert.equal(sql.match(/ENABLE ROW LEVEL SECURITY/g)?.length, 4);
    assert.doesNotMatch(sql, /CREATE POLICY/);
    assert.doesNotMatch(sql, /aff_/);
    assert.throws(() => supabaseMigrationSql('x; drop table y'), /invalid table prefix/);
    assert.throws(() => supabaseStore({ rpc: async () => ({ data: null, error: null }) }, { prefix: 'a-b' }));
  });

  test('rpc errors surface as thrown Errors', async () => {
    const store = supabaseStore({ rpc: async () => ({ data: null, error: { message: 'boom', code: 'X' } }) });
    await assert.rejects(store.getQuota('a'), /aff_get_quota: boom/);
  });
});

// Real Postgres (CI service container, or: docker run --rm -e POSTGRES_PASSWORD=x -p 55432:5432 postgres:16-alpine)
const PG_URL = process.env.AFFILIATES_TEST_PG_URL;

describe('supabaseStore over rpc() on real Postgres', { skip: !PG_URL && 'set AFFILIATES_TEST_PG_URL' }, () => {
  let pool: pg.Pool;
  let n = 0;
  before(() => {
    pool = postgrestLikePool(pg, PG_URL!);
  });
  after(async () => {
    await pool?.end();
  });
  const make = async (opts: ConstructorParameters<typeof Affiliates>[1] = {}) => {
    const prefix = `sb${process.pid}_${++n}_`;
    const client = fakeSupabase(pool, { prefix });
    await client.ready;
    return { aff: new Affiliates(supabaseStore(client, { prefix }), opts), prefix, client };
  };

  test('quota of 3 holds under 10 parallel creates', async () => {
    const { aff } = await make({ defaultQuota: 3 });
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => aff.createInvite('alice', `#${i}`)));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const no = results.filter((r) => r.status === 'rejected');
    assert.equal(ok.length, 3);
    assert.equal(no.length, 7);
    for (const r of no) assert.equal((r as PromiseRejectedResult).reason.message, 'no invites left');
    assert.equal((await aff.invites('alice')).length, 3);
    assert.deepEqual(await aff.quota('alice'), { total: 3, used: 3, left: 0 });
  });

  test('an invite is single use under 20 concurrent redeems', async () => {
    const { aff } = await make();
    const inv = await aff.createInvite('alice');
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => aff.redeemInvite(inv.code, `u${i}`)));
    const winners = results.filter((r) => r.ok);
    assert.equal(winners.length, 1);
    for (const r of results) if (!r.ok) assert.equal(r.reason, 'used');
    assert.equal((await aff.invitees('alice')).length, 1);
    const [listed] = await aff.invites('alice');
    assert.equal(typeof listed?.usedAt, 'number');
    assert.equal(await aff.invitedBy(listed!.usedBy!), 'alice');
  });

  test('first-touch attribution: parallel attributes to different affiliates, exactly one sticks', async () => {
    const { aff } = await make();
    const codes = await Promise.all(['a1', 'a2', 'a3', 'a4', 'a5'].map((u) => aff.affiliateCode(u)));
    assert.equal(new Set(codes).size, 5);
    assert.equal(await aff.affiliateCode('a1'), codes[0]); // stable
    const results = await Promise.all(codes.map((c) => aff.attribute(c, 'newbie')));
    const won = results.filter((r) => r.ok);
    assert.equal(won.length, 1);
    const first = won[0]!.affiliateId!;
    for (const r of results) if (!r.ok) assert.equal(r.affiliateId, first);
    assert.equal(await aff.affiliateOf('newbie'), first);
    // a later click never overwrites
    assert.deepEqual(await aff.attribute(codes[4]!, 'newbie'), { ok: false, affiliateId: first });
    // self-attribution refused
    assert.deepEqual(await aff.attribute(codes[0]!, 'a1'), { ok: false });
  });

  test('an @profullstack/referrals code in referral_codes comes back external', async () => {
    const { aff } = await make();
    await pool.query(`CREATE TABLE IF NOT EXISTS public.referral_codes (
      id uuid DEFAULT gen_random_uuid() PRIMARY KEY, code text NOT NULL UNIQUE, owner_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz)`);
    const legacy = `LEG${process.pid}X${n}`;
    await pool.query(`INSERT INTO public.referral_codes (code, owner_id) VALUES ($1, 'old') ON CONFLICT DO NOTHING`, [legacy]);
    assert.deepEqual(await aff.attribute(` ${legacy.toLowerCase()} `, 'newbie'), { ok: false, external: true });
    assert.equal(await aff.affiliateOf('newbie'), null);
    assert.deepEqual(await aff.attribute('ZZZZNOPE', 'newbie'), { ok: false });
    const ours = await aff.affiliateCode('alice');
    assert.deepEqual(await aff.attribute(ours, 'newbie'), { ok: true, affiliateId: 'alice' });
  });

  test('one invite per invitee holds under concurrent redeems through rpc()', async () => {
    const { aff } = await make();
    const invs = await Promise.all(['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7', 'i8'].map((i) => aff.createInvite(i)));
    const results = await Promise.all(invs.map((inv) => aff.redeemInvite(inv.code, 'carol')));
    assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
    for (const r of results) if (!r.ok) assert.equal(r.reason, 'already_invited');
    const used = (await Promise.all(invs.map((inv) => aff.invites(inv.inviterId)))).flat().filter((r) => r.usedBy);
    assert.equal(used.length, 1);
  });

  for (const how of ['supabaseUpgradeSql()', 'full supabaseMigrationSql() re-run'] as const) {
    test(`a database on 0.2's migration with duplicate redemptions upgrades via ${how}`, async () => {
      const prefix = `sbu${process.pid}_${++n}_`;
      const old = readFileSync(new URL('./fixtures/supabase-0.2.0.sql', import.meta.url), 'utf8').replaceAll('aff_', prefix);
      await fakeSupabase(pool, { prefix, migrate: false }).ready; // roles
      await pool.query(old);
      await pool.query(`INSERT INTO public.${prefix}invites (id, code_hash, inviter_id, created_at, used_by, used_at) VALUES
        ('i1', 'h1', 'alice', 1, 'carol', 10), ('i2', 'h2', 'bob', 1, 'carol', 20), ('i3', 'h3', 'alice', 1, 'dave', 30)`);
      const sql = how === 'supabaseUpgradeSql()' ? supabaseUpgradeSql(prefix) : supabaseMigrationSql(prefix);
      await pool.query(sql);
      await pool.query(sql); // idempotent
      const flags = await pool.query(`SELECT id, legacy_dup FROM public.${prefix}invites ORDER BY id`);
      assert.deepEqual(flags.rows.map((r) => [r.id, r.legacy_dup]), [['i1', 0], ['i2', 1], ['i3', 0]]);
      const aff = new Affiliates(supabaseStore(fakeSupabase(pool, { prefix, migrate: false }), { prefix }));
      assert.equal(await aff.invitedBy('carol'), 'alice');
      const fresh = await aff.createInvite('frank');
      assert.deepEqual(await aff.redeemInvite(fresh.code, 'carol'), { ok: false, reason: 'already_invited' });
      assert.equal((await aff.redeemInvite(fresh.code, 'gina')).ok, true);
      // grants survive the function's CREATE OR REPLACE: anon still refused
      const anon = await fakeSupabase(pool, { prefix, role: 'anon', migrate: false }).rpc(`${prefix}claim_invite`, {
        p_id: 'x', p_user: 'y', p_at: 1,
      });
      assert.match(String(anon.error?.message), /permission denied/);
    });
  }

  test('anon and authenticated keys cannot call the functions or read the tables; RLS on, no policies', async () => {
    const { prefix } = await make();
    for (const role of ['anon', 'authenticated'] as const) {
      const c = fakeSupabase(pool, { prefix, role, migrate: false });
      const r = await c.rpc(`${prefix}get_quota`, { p_user: 'a' });
      assert.match(String(r.error?.message), /permission denied/);
      const cl = await pool.connect();
      try {
        await cl.query('BEGIN');
        await cl.query(`SET LOCAL ROLE ${role}`);
        await assert.rejects(cl.query(`SELECT * FROM public.${prefix}invites`), /permission denied/);
      } finally {
        await cl.query('ROLLBACK');
        cl.release();
      }
    }
    const rls = await pool.query(
      `SELECT relname, relrowsecurity FROM pg_class WHERE relname = ANY($1) AND relnamespace = 'public'::regnamespace`,
      [['invites', 'quotas', 'codes', 'attributions'].map((t) => prefix + t)],
    );
    assert.equal(rls.rows.length, 4);
    for (const r of rls.rows) assert.equal(r.relrowsecurity, true);
    const pol = await pool.query(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename LIKE $1`, [`${prefix}%`]);
    assert.equal(pol.rows[0].n, 0);
    const fns = await pool.query(
      `SELECT proname, prosecdef, proconfig FROM pg_proc WHERE proname LIKE $1 AND pronamespace = 'public'::regnamespace`,
      [`${prefix}%`],
    );
    assert.equal(fns.rows.length, 17);
    for (const f of fns.rows) {
      assert.equal(f.prosecdef, true, f.proname);
      assert.deepEqual(f.proconfig, ['search_path=public, pg_temp'], f.proname);
    }
  });

  test('migration is idempotent', async () => {
    const { prefix, aff } = await make();
    await aff.createInvite('alice');
    await pool.query(supabaseMigrationSql(prefix));
    assert.equal((await aff.invites('alice')).length, 1);
  });
});

// Optional: the same flows through a real PostgREST (what supabase-js talks to). Needs the default-prefix
// migration applied to its database, e.g. with docker run postgrest/postgrest and:
//   AFFILIATES_TEST_POSTGREST_URL=http://127.0.0.1:3999 AFFILIATES_TEST_POSTGREST_JWT_SECRET=... npm test
const REST_URL = process.env.AFFILIATES_TEST_POSTGREST_URL;
const REST_SECRET = process.env.AFFILIATES_TEST_POSTGREST_JWT_SECRET;

async function jwt(role: string, secret: string): Promise<string> {
  const { createHmac } = await import('node:crypto');
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role, exp: Math.floor(Date.now() / 1000) + 600 })}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

/** Minimal PostgREST rpc client with supabase-js' `{ data, error }` result shape. */
function restClient(url: string, token: string) {
  return {
    async rpc(fn: string, args: Record<string, unknown> = {}) {
      const res = await fetch(`${url}/rpc/${fn}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(args),
      });
      const text = await res.text();
      const body = text ? JSON.parse(text) : null;
      return res.ok ? { data: body, error: null } : { data: null, error: body };
    },
  };
}

describe('supabaseStore through real PostgREST', { skip: !(REST_URL && REST_SECRET) && 'set AFFILIATES_TEST_POSTGREST_URL' }, () => {
  const run = `r${Date.now().toString(36)}`;
  const make = async (opts: ConstructorParameters<typeof Affiliates>[1] = {}) =>
    new Affiliates(supabaseStore(restClient(REST_URL!, await jwt('service_role', REST_SECRET!))), opts);

  test('quota 3 under 10 parallel creates, single use under 20 redeems, first touch', async () => {
    const aff = await make({ defaultQuota: 3 });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => aff.createInvite(`${run}_alice`)));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
    const inv = (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ code: string }>).value;
    const redeems = await Promise.all(Array.from({ length: 20 }, (_, i) => aff.redeemInvite(inv.code, `${run}_u${i}`)));
    assert.equal(redeems.filter((r) => r.ok).length, 1);
    assert.deepEqual(await aff.quota(`${run}_alice`), { total: 3, used: 3, left: 0 });
    const listed = await aff.invites(`${run}_alice`);
    assert.equal(listed.length, 3);
    assert.equal(typeof listed[0]?.createdAt, 'number');
    const codes = await Promise.all([1, 2, 3].map((i) => aff.affiliateCode(`${run}_a${i}`)));
    const att = await Promise.all(codes.map((c) => aff.attribute(c, `${run}_newbie`)));
    assert.equal(att.filter((r) => r.ok).length, 1);
    assert.ok(await aff.affiliateOf(`${run}_newbie`));
    await aff.setQuota(`${run}_alice`, 5);
    assert.equal((await aff.quota(`${run}_alice`)).left, 2);
    assert.deepEqual(await aff.attribute('NOPE0000', `${run}_x`), { ok: false });
  });

  test('one user redeeming 6 invites at once gets exactly one; the rest stay unused', async () => {
    const aff = await make();
    const invs = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => aff.createInvite(`${run}_inv${i}`)));
    const results = await Promise.all(invs.map((inv) => aff.redeemInvite(inv.code, `${run}_carol`)));
    assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
    for (const r of results) if (!r.ok) assert.equal(r.reason, 'already_invited');
    const used = (await Promise.all(invs.map((inv) => aff.invites(inv.inviterId)))).flat().filter((r) => r.usedBy);
    assert.equal(used.length, 1);
  });

  test('anon key is refused', async () => {
    const anon = restClient(REST_URL!, await jwt('anon', REST_SECRET!));
    const r = await anon.rpc('aff_get_quota', { p_user: 'x' });
    assert.ok(r.error);
  });
});
