import { sqlStore, type SqlStoreOptions } from './sql.ts';
import type { AffiliateStore } from './store.ts';

interface SqliteStatement {
  all(...params: any[]): any;
  get?(...params: any[]): any;
  run?(...params: any[]): any;
}

/**
 * A synchronous SQLite handle: bun:sqlite `Database` (query/prepare + exec),
 * better-sqlite3 `Database` (prepare + exec) or node:sqlite `DatabaseSync` (prepare + exec).
 */
export type SqliteLike =
  | { query(sql: string): SqliteStatement; exec(sql: string): unknown }
  | { prepare(sql: string): SqliteStatement; exec(sql: string): unknown };

/** Rewrite $1..$n to positional `?`, expanding params in order of appearance. */
export function toPositional(sql: string, params: unknown[]): { sql: string; params: unknown[] } {
  const out: unknown[] = [];
  const text = sql.replace(/\$(\d+)/g, (_m, n: string) => {
    out.push(params[Number(n) - 1]);
    return '?';
  });
  return { sql: text, params: out.map((v) => (v === undefined ? null : v)) };
}

/** Store on a synchronous SQLite handle. Creates its tables (prefix `aff_`) on first use. */
export function sqliteStore(db: SqliteLike, opts: SqlStoreOptions = {}): AffiliateStore {
  const anyDb = db as any;
  const prep: (sql: string) => SqliteStatement =
    typeof anyDb.query === 'function' ? (sql) => anyDb.query(sql) : (sql) => anyDb.prepare(sql);
  return sqlStore(async (sql, params) => {
    const { sql: text, params: args } = toPositional(sql, params);
    if (args.length === 0 && /^\s*CREATE\s/i.test(text)) {
      anyDb.exec(text);
      return [];
    }
    const st = prep(text) as SqliteStatement & { reader?: boolean };
    if (st.reader === false && st.run) {
      // better-sqlite3 refuses .all() on statements that return no rows
      st.run(...args);
      return [];
    }
    const rows = st.all(...args);
    return Array.isArray(rows) ? rows : [];
  }, opts);
}
