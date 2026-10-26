// Regenerates migrations/supabase.sql from supabaseMigrationSql(). `npm run gen:migration`.
import { writeFileSync } from 'node:fs';
import { supabaseMigrationSql } from '../src/supabase.ts';
writeFileSync(new URL('../migrations/supabase.sql', import.meta.url), supabaseMigrationSql());
