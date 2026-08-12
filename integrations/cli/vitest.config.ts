import { defineConfig } from 'vitest/config';

// Hermetic by construction, exactly like the SDK suite: every test injects a
// fake client and a fake line writer, so there is no network, no filesystem
// and no clock to control beyond the seams the code already exposes. Files may
// run in parallel.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
