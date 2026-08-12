import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * The only configuration this demo needs: teach the bundler that the SDK's
 * Node-only paths are not reachable from a browser.
 *
 * `@ship/sdk` publishes a single entry point, so `import { ShipClient }` also
 * pulls in `verifyWebhook`, which STATICALLY imports `node:crypto`. Rollup
 * binds that module's named exports before tree-shaking can remove it, so the
 * build dies on `"createHmac" is not exported by "__vite-browser-external"`.
 * Aliasing both built-ins to a stub that throws keeps the module graph
 * resolvable without shipping a silently broken signature verifier — see
 * src/node-builtins-unavailable.ts for why it throws rather than no-ops.
 */
const nodeStub = fileURLToPath(new URL('./src/node-builtins-unavailable.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      'node:crypto': nodeStub,
      'node:fs/promises': nodeStub,
    },
  },
});
