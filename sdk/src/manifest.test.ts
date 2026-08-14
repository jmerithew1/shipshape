import { describe, expect, it, vi } from 'vitest';
import { ShipClient } from './client.js';
import { SDK_ROUTES, SDK_ROUTE_MANIFEST, withPathParam, type RouteManifestEntry } from './manifest.js';
import { collect } from './pagination.js';

const BASE_URL = 'https://ship.example.com';
const API_PREFIX = '/api/v1';

interface Hit {
  method: string;
  path: string;
}

/** `/documents/{id}` → a regex that matches `/documents/doc_123`. */
function templateToRegExp(template: string): RegExp {
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\\\{id\\\}/g, '[^/]+')}$`);
}

function matchManifest(hit: Hit): RouteManifestEntry | undefined {
  return SDK_ROUTE_MANIFEST.find(
    (entry) =>
      entry.method.toLowerCase() === hit.method.toLowerCase() &&
      templateToRegExp(entry.path).test(hit.path)
  );
}

/**
 * Drive every resource method against a fake fetch and record the route each
 * one actually reached. This is the SDK half of the anti-drift check: CI
 * compares the manifest against openapi.json, and this compares the manifest
 * against the code, so a manifest entry cannot be a lie in either direction.
 */
async function exerciseEveryMethod(): Promise<Hit[]> {
  const hits: Hit[] = [];

  const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    hits.push({
      method: (init?.method ?? 'GET').toLowerCase(),
      path: url.pathname.slice(API_PREFIX.length),
    });
    // One shape that satisfies both list and single-entity call sites, with
    // next_cursor null so iterate() terminates after one page.
    return new Response(JSON.stringify({ data: [], next_cursor: null, id: 'x' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const ship = new ShipClient({ token: 't', baseUrl: BASE_URL, fetch: fetchImpl });

  await ship.me();

  await ship.documents.list();
  await ship.documents.get('doc_1');
  await ship.documents.create({ title: 'Spec', document_type: 'doc' });
  await collect(ship.documents.iterate());

  await ship.issues.list();
  await ship.issues.get('iss_1');
  await collect(ship.issues.iterate());

  await ship.sprints.list();
  await ship.sprints.get('spr_1');
  await collect(ship.sprints.iterate());

  await ship.webhooks.list();
  await ship.webhooks.create({ event_type: 'document.created', target_url: 'https://x.test/hook' });
  await ship.webhooks.delete('wh_1');
  await ship.webhooks.deliveries();
  await collect(ship.webhooks.iterateDeliveries());
  await ship.webhooks.replay('del_1');

  return hits;
}

describe('SDK_ROUTE_MANIFEST', () => {
  it('has no duplicate operationIds', () => {
    const ids = SDK_ROUTE_MANIFEST.map((entry) => entry.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has no duplicate method+path pairs', () => {
    const pairs = SDK_ROUTE_MANIFEST.map((entry) => `${entry.method} ${entry.path}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('is well-formed: camelCase operationId, lowercase method, rooted path', () => {
    for (const entry of SDK_ROUTE_MANIFEST) {
      expect(entry.operationId).toMatch(/^[a-z][A-Za-z0-9]*$/);
      expect(['get', 'post', 'put', 'patch', 'delete']).toContain(entry.method);
      expect(entry.path.startsWith('/')).toBe(true);
      // Paths are spec-relative: the /api/v1 prefix belongs to the client.
      expect(entry.path.startsWith('/api')).toBe(false);
    }
  });

  it('exposes exactly the operationIds the OpenAPI spec is expected to declare', () => {
    expect(SDK_ROUTE_MANIFEST.map((entry) => entry.operationId).sort()).toEqual(
      [
        'createDocument',
        'createWebhook',
        'deleteWebhook',
        'getDocument',
        'getIssue',
        'getMe',
        'getSprint',
        'listDocuments',
        'listIssues',
        'listSprints',
        'listWebhookDeliveries',
        'listWebhooks',
        'replayWebhookDelivery',
      ].sort()
    );
  });

  it('keeps the keyed and flat forms in sync', () => {
    expect(SDK_ROUTE_MANIFEST).toHaveLength(Object.keys(SDK_ROUTES).length);
    for (const [key, route] of Object.entries(SDK_ROUTES)) {
      expect(key).toBe(route.operationId);
      expect(SDK_ROUTE_MANIFEST).toContainEqual({
        operationId: route.operationId,
        method: route.method,
        path: route.path,
      });
    }
  });
});

describe('manifest ↔ client parity', () => {
  it('every route a resource method calls is declared in the manifest', async () => {
    const hits = await exerciseEveryMethod();
    expect(hits.length).toBeGreaterThan(0);

    const undeclared = hits.filter((hit) => matchManifest(hit) === undefined);
    expect(undeclared).toEqual([]);
  });

  it('every manifest entry is reachable from a resource method', async () => {
    const hits = await exerciseEveryMethod();
    const reached = new Set(
      hits.map((hit) => matchManifest(hit)?.operationId).filter((id): id is string => Boolean(id))
    );

    const unreachable = SDK_ROUTE_MANIFEST.map((entry) => entry.operationId).filter(
      (id) => !reached.has(id)
    );
    expect(unreachable).toEqual([]);
  });
});

describe('withPathParam', () => {
  it('substitutes and URL-encodes the id', () => {
    expect(withPathParam('/documents/{id}', 'doc_1')).toBe('/documents/doc_1');
    expect(withPathParam('/webhooks/deliveries/{id}/replay', 'a/b')).toBe(
      '/webhooks/deliveries/a%2Fb/replay'
    );
  });
});
