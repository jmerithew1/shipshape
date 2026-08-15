/**
 * Fitness test: every public v1 path the dev portal calls must exist in the
 * published OpenAPI spec.
 *
 * WHY THIS EXISTS. The portal shipped calling `/api/v1/webhooks/subscriptions`
 * for list/create/delete, but the server mounts subscriptions at
 * `/api/v1/webhooks` (and `/api/v1/webhooks/:id` for delete). Every one of
 * those calls 404'd with "No such endpoint" — the Subscriptions tab was
 * entirely non-functional against the deployed API.
 *
 * Nothing caught it: the portal's other tests mock fetch (so they assert the
 * mock, not the contract), and the TTFE drill exercises the SDK/CLI, which use
 * the correct paths. The portal was the one client of the public API with no
 * parity check — so it drifted alone.
 *
 * This closes that gap the same way the SDK's route-manifest test does: the
 * spec is the single source of truth, and any client that names a path the
 * spec does not publish fails the build.
 *
 * Deliberately STATIC (parses the source) rather than runtime: it needs no
 * server, and it catches the path at the moment it is written rather than only
 * when a human happens to click that tab.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(here, 'api.ts');
// devportal -> pages -> src -> web -> repo root
const SPEC = path.join(here, '..', '..', '..', '..', 'docs', 'openapi.json');

/** The v1 prefix the server mounts the public router under. */
const V1_PREFIX = '/api/v1';

/**
 * Pull every `${WEBHOOK_BASE}...` template literal — plus bare uses of the
 * constant — out of the portal's API module, and normalise each into the shape
 * the spec uses: interpolations become `{id}`, query strings are dropped.
 */
function portalPaths(source: string, base: string): string[] {
  const found = new Set<string>();

  // Bare `WEBHOOK_BASE` passed as a whole path, e.g. apiPost(WEBHOOK_BASE, ...)
  if (/\(\s*WEBHOOK_BASE\s*[,)]/.test(source)) found.add(base);

  // Template literals that start with the constant.
  for (const m of source.matchAll(/`\$\{WEBHOOK_BASE\}([^`]*)`/g)) {
    const suffix = (m[1] ?? '')
      .replace(/\?.*$/, '') // drop query string
      .replace(/\$\{[^}]+\}/g, '{id}'); // interpolation -> path param
    found.add(base + suffix);
  }

  return [...found];
}

describe('dev portal public-API paths match the published spec', () => {
  const source = fs.readFileSync(SOURCE, 'utf8');
  const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8')) as { paths: Record<string, unknown> };
  const specPaths = Object.keys(spec.paths);

  const base = source.match(/export const WEBHOOK_BASE = '([^']+)'/)?.[1];

  it('names the public webhook surface in exactly one place', () => {
    expect(base).toBe(`${V1_PREFIX}/webhooks`);
  });

  it('calls only paths the spec publishes', () => {
    const called = portalPaths(source, base!);

    // Guard against the regex silently matching nothing and the test passing
    // vacuously — the failure mode that would make this whole file useless.
    expect(called.length).toBeGreaterThanOrEqual(4);

    const unpublished = called.filter((p) => !specPaths.includes(p.slice(V1_PREFIX.length)));
    expect(unpublished, `paths not in docs/openapi.json: ${unpublished.join(', ')}`).toEqual([]);
  });
});
