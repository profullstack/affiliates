import { sqlStore, type SqlStoreOptions } from './sql.ts';
import type { AffiliateStore } from './store.ts';

/** Anything with a node-postgres style `query` (pg.Pool, pg.Client, @profullstack/libsql-pg, ...). */
export interface PgLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

/** Store on Postgres. Creates its tables (prefix `aff_`) on first use. */
export function postgresStore(pool: PgLike, opts: SqlStoreOptions = {}): AffiliateStore {
  return sqlStore(async (sql, params) => {
    const res = await pool.query(sql, params.map((v) => (v === undefined ? null : v)));
    return res?.rows ?? [];
  }, opts, 'postgres');
}
