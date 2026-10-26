// CI helper: prepares a plain Postgres for PostgREST the way Supabase does (anon / authenticated /
// service_role behind an authenticator login) and applies the default-prefix migration.
//   node --experimental-strip-types test/setup-postgrest.ts   (reads AFFILIATES_TEST_PG_URL)
import pg from 'pg';
import { supabaseMigrationSql } from '../src/index.ts';

const pool = new pg.Pool({ connectionString: process.env.AFFILIATES_TEST_PG_URL });
await pool.query(`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator LOGIN PASSWORD 'auth' NOINHERIT;
  END IF;
END $$`);
await pool.query(`GRANT anon, authenticated, service_role TO authenticator`);
await pool.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role`);
await pool.query(supabaseMigrationSql());
await pool.end();
console.log('postgrest roles + aff_ migration ready');
