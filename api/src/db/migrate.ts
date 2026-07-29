#!/usr/bin/env npx ts-node
/**
 * Database migration script
 * 1. Runs schema.sql for initial table setup
 * 2. Runs numbered migration files from migrations/ folder
 * 3. Tracks completed migrations in schema_migrations table
 */
import { config } from 'dotenv';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Pool } from 'pg';
import { loadProductionSecrets } from '../config/ssm.js';

// Load .env.local for local development
config({ path: join(dirname(fileURLToPath(import.meta.url)), '../../.env.local') });

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function migrate() {
  await loadProductionSecrets();

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL environment variable is not set');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  try {
    console.log('Running database migrations...');

    // Fresh-install detection MUST happen before schema.sql runs: a fresh
    // database gets the complete current snapshot from schema.sql (the repo's
    // stated convention — schema.sql is initial setup, migrations are deltas
    // for EXISTING databases). Re-running every migration on top of the
    // snapshot double-applies them — e.g. 010_oauth_state.sql CREATEs a table
    // schema.sql already created, which is exactly where fresh installs died
    // (AUDIT_REPORT.md Cat 6 / corrections table "Migration 033/010").
    const freshInstall = !(
      await pool.query(`SELECT to_regclass('public.documents') AS t`)
    ).rows[0].t;

    // Step 1: Run schema.sql for initial setup.
    // "already exists" tolerance is scoped to THIS step only. It used to live
    // in the outer catch, where it swallowed the entire run: any error whose
    // message contained "already exists" — including a failing migration —
    // aborted everything after it and exited 0. That is how a fresh install
    // died silently at migration 010 with a green exit code
    // (AUDIT_REPORT.md Cat 6, ranked #1 Critical).
    const schemaPath = join(__dirname, 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    try {
      await pool.query(schema);
      console.log('✅ Schema applied');
    } catch (schemaError) {
      const msg = schemaError instanceof Error ? schemaError.message : String(schemaError);
      if (msg.includes('already exists')) {
        console.log('ℹ️  Schema already exists, continuing to migrations...');
      } else {
        throw schemaError;
      }
    }

    // Step 2: Create migrations tracking table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT now()
      )
    `);

    // Step 3: Get list of already-applied migrations
    const appliedResult = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
    const appliedMigrations = new Set(appliedResult.rows.map(r => r.version));

    // Step 4: Find and run pending migrations
    const migrationsDir = join(__dirname, 'migrations');
    let migrationFiles: string[] = [];

    try {
      migrationFiles = readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort(); // Ensures numeric order: 001_, 002_, etc.
    } catch {
      console.log('ℹ️  No migrations directory found');
    }

    // Fresh install: schema.sql just provided the current snapshot, so every
    // known migration is already reflected. Stamp them as applied instead of
    // re-executing them against the snapshot.
    if (freshInstall) {
      for (const file of migrationFiles) {
        await pool.query(
          'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
          [file.replace('.sql', '')]
        );
      }
      console.log(
        `✅ Fresh install: schema.sql is the current snapshot; stamped ${migrationFiles.length} migrations as applied`
      );
      return;
    }

    let migrationsRun = 0;
    for (const file of migrationFiles) {
      const version = file.replace('.sql', '');

      if (appliedMigrations.has(version)) {
        continue; // Already applied
      }

      console.log(`  Running migration: ${file}`);
      const migrationPath = join(migrationsDir, file);
      const migrationSql = readFileSync(migrationPath, 'utf-8');

      // Run migration in a transaction. A failure here must surface with the
      // failing file named and a non-zero exit — never be reclassified by the
      // outer catch (see Step 1 note).
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(migrationSql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
        console.log(`  ✅ ${file} applied`);
        migrationsRun++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`  ❌ Migration ${file} FAILED and was rolled back`);
        throw err;
      } finally {
        client.release();
      }
    }

    if (migrationsRun === 0) {
      console.log('✅ All migrations already applied');
    } else {
      console.log(`✅ ${migrationsRun} migration(s) applied successfully`);
    }

  } catch (error) {
    // No "already exists" tolerance here: that check is scoped to schema.sql
    // in Step 1. Anything reaching this catch is a real failure and the
    // process must exit non-zero so deploys stop instead of running against
    // a half-migrated database.
    console.error('Database migration failed:', error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

migrate();
