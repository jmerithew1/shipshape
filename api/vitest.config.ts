import { defineConfig } from 'vitest/config'

// The test suite TRUNCATEs every table in whatever database DATABASE_URL
// names (src/test/setup.ts). If the ambient DATABASE_URL is not explicitly a
// test database, redirect the test process to the local ship_test database
// instead of destroying a dev database. CI overrides by exporting a
// DATABASE_URL whose db name ends in _test. setup.ts still hard-refuses
// non-test names as the backstop.
const ambient = process.env.DATABASE_URL ?? ''
const isTestDb = /(_test|^test_)[^/]*$/.test(new URL(ambient || 'postgresql://x/x').pathname)
const TEST_DATABASE_URL = isTestDb
  ? ambient
  : 'postgresql://ship:ship_dev_password@localhost:5433/ship_test'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/test/setup.ts'],
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
    },
    // Run test files sequentially to prevent database conflicts
    // Tests within each file can still run in parallel
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['node_modules', 'dist', 'src/test/**'],
    },
  },
})
