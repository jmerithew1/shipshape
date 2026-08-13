import { defineConfig } from 'vitest/config';

// Hermetic by construction, like the SDK and CLI suites: every test injects a
// fake Slack poster or a fake fetch, so nothing in this suite talks to Slack or
// to Ship. The one thing tests DO use for real is a loopback listener on an
// ephemeral port (`app.listen(0)`), because the property most worth testing —
// that the bytes which were signed are the bytes we verify — only holds if the
// real Express body pipeline runs. Faking `req` would fake away the bug.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
