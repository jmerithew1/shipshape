import { defineConfig } from 'vitest/config';

// The SDK suite is hermetic by construction: no network, no database, no
// filesystem beyond an OS temp dir. Every test injects a fake `fetch`, so
// there is nothing to set up and nothing to tear down — hence no setupFiles
// and no DATABASE_URL guard (contrast api/vitest.config.ts, which truncates
// tables). Files may run in parallel.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
