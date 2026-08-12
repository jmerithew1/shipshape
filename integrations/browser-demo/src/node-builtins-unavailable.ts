/**
 * Browser stubs for the Node built-ins `@ship/sdk` reaches for.
 *
 * The SDK is one barrel (`exports` declares only `"."`), so importing
 * `ShipClient` also drags in two Node-only paths:
 *
 *   node:crypto      — `verifyWebhook` needs HMAC and `timingSafeEqual`.
 *                      A STATIC import, so Rollup binds its named exports
 *                      before tree-shaking can drop the module, and the build
 *                      fails on `"createHmac" is not exported by
 *                      "__vite-browser-external"`.
 *   node:fs/promises — `FileTokenStore`. Already a dynamic import, so it only
 *                      warns, but aliasing it too keeps the build output clean.
 *
 * Neither belongs in a browser, and that is a statement about the platform, not
 * a packaging accident: verifying a webhook requires the subscription's signing
 * secret, and a secret shipped to a browser is not a secret. This demo uses
 * `LocalStorageTokenStore` and never calls either one.
 *
 * These throw rather than returning a no-op. A silent stub for a signature
 * verifier is the worst possible failure mode — it would report "valid" for
 * every forged payload. If some future edit does reach this code, it fails
 * loudly at the first call, with a message that says why.
 */

function unavailable(symbol: string): never {
  throw new Error(
    `@ship/browser-demo: ${symbol} is a Node-only API and is not available in the browser. ` +
      `Webhook signature verification and file-backed token storage are server-side concerns; ` +
      `run them in a Node integration (see integrations/cli) instead.`
  );
}

// node:crypto — used by the SDK's verifyWebhook.
export function createHmac(): never {
  return unavailable('crypto.createHmac');
}
export function timingSafeEqual(): never {
  return unavailable('crypto.timingSafeEqual');
}

// node:fs/promises — used by the SDK's FileTokenStore.
export function readFile(): never {
  return unavailable('fs.readFile');
}
export function writeFile(): never {
  return unavailable('fs.writeFile');
}
export function mkdir(): never {
  return unavailable('fs.mkdir');
}
export function chmod(): never {
  return unavailable('fs.chmod');
}
export function rm(): never {
  return unavailable('fs.rm');
}

export default { createHmac, timingSafeEqual, readFile, writeFile, mkdir, chmod, rm };
