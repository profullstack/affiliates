// Regenerates migrations/supabase.sql from supabaseMigrationSql(). `npm run gen:migration`.
import { writeFileSync } from 'node:fs';
import { supabaseMigrationSql, supabaseUpgradeSql } from '../src/supabase.ts';
writeFileSync(new URL('../migrations/supabase.sql', import.meta.url), supabaseMigrationSql());
writeFileSync(new URL('../migrations/supabase-0.3.0-upgrade.sql', import.meta.url), supabaseUpgradeSql());
