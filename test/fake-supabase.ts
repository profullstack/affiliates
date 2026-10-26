// A small stand-in for supabase-js `client.rpc()` over a real Postgres pool, faithful to what
// PostgREST does for an RPC call: one transaction per request, `SET LOCAL ROLE` to the key's role,
// named arguments, a set-returning function comes back as an array, a scalar one as the bare value,
// VOID as null, and errors as `{ data: null, error: { message, code } }`.
import type pg from 'pg';
import { supabaseMigrationSql, type SupabaseLike } from '../src/index.ts';

/** A pool that parses BIGINT as a number, as PostgREST's JSON does. */
export function postgrestLikePool(pgmod: typeof pg, connectionString: string): pg.Pool {
  return new pgmod.Pool({
    connectionString,
    max: 12,
    types: {
      getTypeParser: ((oid: number, format?: any) =>
        oid === 20 ? (v: string) => Number(v) : pgmod.types.getTypeParser(oid, format)) as any,
    },
  });
}

const ROLES_SQL = `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$`;

let rolesReady: Promise<void> | null = null;
export function ensureRoles(pool: pg.Pool): Promise<void> {
  return (rolesReady ??= pool
    .query(ROLES_SQL)
    .then(() => undefined)
    .catch((err) => {
      // two test files can race on CREATE ROLE; the loser sees a duplicate, which is fine
      if (!/already exists|duplicate key/.test(String(err?.message))) throw err;
    }));
}

/** Applies supabaseMigrationSql(prefix) once, then serves rpc() calls as `role`. */
export function fakeSupabase(
  pool: pg.Pool,
  opts: { prefix?: string; role?: 'service_role' | 'anon' | 'authenticated'; migrate?: boolean } = {},
): SupabaseLike & { ready: Promise<void> } {
  const role = opts.role ?? 'service_role';
  const ready = (async () => {
    await ensureRoles(pool);
    if (opts.migrate !== false) await pool.query(supabaseMigrationSql(opts.prefix));
  })();
  const shapes = new Map<string, { retset: boolean; void: boolean }>();
  return {
    ready,
    async rpc(fn: string, args: Record<string, unknown> = {}) {
      await ready;
      const c = await pool.connect();
      try {
        let shape = shapes.get(fn);
        if (!shape) {
          const r = await c.query(
            `SELECT proretset, prorettype = 'void'::regtype AS isvoid FROM pg_proc
             WHERE proname = $1 AND pronamespace = 'public'::regnamespace`,
            [fn],
          );
          if (!r.rows[0]) return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${fn}` } };
          shape = { retset: r.rows[0].proretset, void: r.rows[0].isvoid };
          shapes.set(fn, shape);
        }
        const keys = Object.keys(args);
        const named = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
        const params = keys.map((k) => (args[k] === undefined ? null : args[k]));
        await c.query('BEGIN');
        await c.query(`SET LOCAL ROLE ${role}`);
        const sql = shape.retset ? `SELECT * FROM public.${fn}(${named})` : `SELECT public.${fn}(${named}) AS v`;
        const res = await c.query(sql, params);
        await c.query('COMMIT');
        if (shape.retset) return { data: res.rows, error: null };
        if (shape.void) return { data: null, error: null };
        return { data: res.rows[0]?.v ?? null, error: null };
      } catch (err: any) {
        await c.query('ROLLBACK').catch(() => {});
        return { data: null, error: { message: String(err?.message ?? err), code: err?.code } };
      } finally {
        c.release();
      }
    },
  };
}
