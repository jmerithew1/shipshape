#!/usr/bin/env node
/**
 * Copy the DB assets that tsc does not emit into dist/.
 *
 * Replaces `cp src/db/schema.sql dist/db/schema.sql && cp -r src/db/migrations
 * dist/db/migrations`, which are POSIX-only. pnpm spawns scripts through
 * cmd.exe on Windows, so `cp` is not a command there — which broke `pnpm
 * build:api`, and with it `e2e/global-setup.ts` (it shells the same build via
 * execSync before any Playwright worker starts). That is one of the two
 * defects that made 869 E2E tests unrunnable on Windows.
 *
 * scripts/deploy.sh asserts both of these exist in dist/ and compares the
 * migration file count against src/ before packaging, so a silent miscopy
 * here fails the deploy loudly rather than shipping a broken image.
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(apiRoot, 'src', 'db');
const dest = join(apiRoot, 'dist', 'db');

mkdirSync(dest, { recursive: true });

// schema.sql — the full fresh-install DDL, applied before any migration
const schema = join(src, 'schema.sql');
if (!existsSync(schema)) {
  console.error('[copy-db-assets] FAIL: src/db/schema.sql is missing');
  process.exit(1);
}
cpSync(schema, join(dest, 'schema.sql'));

// migrations/ — numbered SQL, applied in filename order after the schema
const migrationsSrc = join(src, 'migrations');
if (!existsSync(migrationsSrc)) {
  console.error('[copy-db-assets] FAIL: src/db/migrations is missing');
  process.exit(1);
}
cpSync(migrationsSrc, join(dest, 'migrations'), { recursive: true });

const count = (dir) => readdirSync(dir).filter((f) => f.endsWith('.sql')).length;
const srcCount = count(migrationsSrc);
const destCount = count(join(dest, 'migrations'));

if (srcCount !== destCount) {
  console.error(`[copy-db-assets] FAIL: copied ${destCount} migrations, expected ${srcCount}`);
  process.exit(1);
}

console.log(`[copy-db-assets] schema.sql + ${destCount} migrations -> dist/db`);
