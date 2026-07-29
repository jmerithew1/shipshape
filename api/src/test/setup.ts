import { beforeAll, afterAll } from 'vitest'
import { pool } from '../db/client.js'

// Test setup for API integration tests
// This runs before all tests in each test file

beforeAll(async () => {
  // Ensure test environment
  process.env.NODE_ENV = 'test'

  // Guard: this file TRUNCATEs 15 tables in whatever database DATABASE_URL
  // points at. Run unguarded against a dev database, `pnpm test` silently
  // destroys it — which happened for real on 2026-07-29 (ship_dev wiped;
  // see bench/cat3-latency/out/NOTES-2026-07-29.md). Tests refuse to run
  // unless the database name is explicitly a test database.
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set; tests need a *_test database to run against')
  }
  const dbName = new URL(process.env.DATABASE_URL).pathname.slice(1)
  if (!/(_test$|^test_)/.test(dbName)) {
    throw new Error(
      `Refusing to run tests against database "${dbName}": the test suite ` +
      `TRUNCATEs all tables. Point DATABASE_URL at a test database (name ` +
      `ending in _test), e.g. postgresql://ship:ship_dev_password@localhost:5433/ship_test`
    )
  }

  // Clean up test data from previous runs to prevent duplicate key errors
  // Use TRUNCATE CASCADE which is faster and bypasses row-level triggers
  // (audit_logs has AU-9 compliance triggers preventing DELETE)
  await pool.query(`TRUNCATE TABLE
    workspace_invites, sessions, files, document_links, document_history,
    comments, document_associations, document_snapshots, sprint_iterations,
    issue_iterations, documents, audit_logs, workspace_memberships,
    users, workspaces
    CASCADE`)
})

afterAll(async () => {
  // Close pool only at the very end - vitest handles this via globalTeardown
})
