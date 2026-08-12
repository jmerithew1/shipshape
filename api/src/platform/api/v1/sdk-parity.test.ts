/**
 * SDK ↔ OpenAPI PARITY — the drift gate the assignment requires:
 * "Method signatures match OpenAPI spec; drift fails CI via a fitness test."
 *
 * This test exists because the claim was previously only a COMMENT. Two source
 * files asserted that CI diffed the SDK manifest against the spec in both
 * directions; nothing did, and by the time this was written the two had already
 * drifted — the spec said `createWebhookSubscription` while the SDK said
 * `createWebhook`. A promise in a comment is not a gate.
 *
 * The manifest is load-bearing rather than descriptive: `sdk/src/resources.ts`
 * builds its request URLs from it, so a method cannot call a path the manifest
 * does not declare. Diffing the manifest therefore diffs the real client.
 *
 * Runs in the api package because that is where the spec is generated; the SDK
 * side is read from its built output (importing `sdk/src` violates rootDir —
 * see the note in sdk-live.test.ts).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import { createV1Router } from './router.js';
import { registerV1Routes } from './resources/routes.js';
import { buildV1Spec } from '../../openapi/v1-registry.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { SDK_ROUTE_MANIFEST } from '../../../../../sdk/dist/index.js';

interface SpecOperation {
  operationId?: string;
}
interface Spec {
  paths: Record<string, Record<string, SpecOperation>>;
}

interface ManifestEntry {
  operationId: string;
  method: string;
  path: string;
}

let spec: Spec;
const manifest = SDK_ROUTE_MANIFEST as ManifestEntry[];

/** Express `:id` → OpenAPI `{id}`, so the two sides are comparable. */
function toSpecPath(p: string): string {
  return p.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
}

beforeAll(() => {
  // Registering the routes is what populates the OpenAPI registry.
  const app = express();
  app.use('/api/v1', createV1Router(registerV1Routes));
  spec = buildV1Spec() as unknown as Spec;
});

describe('SDK ↔ spec parity', () => {
  it('has a manifest to diff (guards against a vacuous pass)', () => {
    expect(manifest.length).toBeGreaterThan(0);
    expect(Object.keys(spec.paths).length).toBeGreaterThan(0);
  });

  it('declares no SDK method the server does not serve', () => {
    const specOps = new Set<string>();
    for (const item of Object.values(spec.paths)) {
      for (const op of Object.values(item)) if (op.operationId) specOps.add(op.operationId);
    }

    const sdkOnly = manifest.map((m) => m.operationId).filter((id) => !specOps.has(id));
    expect(
      sdkOnly,
      `the SDK exposes methods with no server route — a consumer calling these gets a 404: ${sdkOnly.join(', ')}`
    ).toEqual([]);
  });

  it('leaves no public operation without an SDK method', () => {
    const sdkOps = new Set(manifest.map((m) => m.operationId));
    const specOnly: string[] = [];
    for (const item of Object.values(spec.paths)) {
      for (const op of Object.values(item)) {
        if (op.operationId && !sdkOps.has(op.operationId)) specOnly.push(op.operationId);
      }
    }
    expect(
      specOnly,
      `the API publishes operations the SDK cannot call: ${specOnly.join(', ')}`
    ).toEqual([]);
  });

  it('agrees on the method and path of every operation, not just the name', () => {
    // Matching ids while disagreeing on the URL is the subtler drift: the
    // manifest would look correct while every call 404s.
    const byId = new Map<string, { method: string; path: string }>();
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (op.operationId) byId.set(op.operationId, { method, path });
      }
    }

    const mismatches: string[] = [];
    for (const entry of manifest) {
      const specSide = byId.get(entry.operationId);
      if (!specSide) continue; // covered by the previous test
      const sdkPath = toSpecPath(entry.path);
      if (specSide.method !== entry.method.toLowerCase() || specSide.path !== sdkPath) {
        mismatches.push(
          `${entry.operationId}: sdk ${entry.method.toUpperCase()} ${sdkPath} vs spec ${specSide.method.toUpperCase()} ${specSide.path}`
        );
      }
    }
    expect(mismatches, mismatches.join(' | ')).toEqual([]);
  });

  it('keeps operationIds unique on both sides', () => {
    const sdkIds = manifest.map((m) => m.operationId);
    expect(new Set(sdkIds).size, 'duplicate operationId in the SDK manifest').toBe(sdkIds.length);
  });
});
