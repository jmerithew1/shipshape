/**
 * ScopeRegistry — scopes as data (Week 6, "PlugForge").
 *
 * The assignment's extension test is "add a new scope without editing the
 * middleware". This registry is how: middleware (authn/scope) only ever asks
 * the registry questions; new scopes register here at module load and every
 * consumer (token gate full-access expansion, requireScope validation, the
 * consent screen, OpenAPI metadata) picks them up with zero edits elsewhere.
 *
 * assertKnown() exists so a typo'd scope string in a route declaration dies
 * at module load (requireScope calls it at factory time), not at request time
 * as a silent always-403.
 */

export interface ScopeDefinition {
  scope: string;
  description: string;
}

export class ScopeRegistry {
  // Map preserves insertion order, which gives list() a stable order.
  private readonly definitions = new Map<string, ScopeDefinition>();

  register(def: ScopeDefinition): void {
    if (this.definitions.has(def.scope)) {
      throw new Error(`Scope already registered: '${def.scope}'`);
    }
    this.definitions.set(def.scope, def);
  }

  has(scope: string): boolean {
    return this.definitions.has(scope);
  }

  /** All registered scope names, in stable registration order. */
  list(): string[] {
    return [...this.definitions.keys()];
  }

  /** All registered definitions (for consent screens / docs), stable order. */
  listDefinitions(): ScopeDefinition[] {
    return [...this.definitions.values()];
  }

  describe(scope: string): string | undefined {
    return this.definitions.get(scope)?.description;
  }

  /** Throws on unknown scope — call at module load to catch typos early. */
  assertKnown(scope: string): void {
    if (!this.definitions.has(scope)) {
      throw new Error(
        `Unknown scope: '${scope}'. Known scopes: ${this.list().join(', ')}. ` +
          `Register new scopes in api/src/platform/scopes/registry.ts.`
      );
    }
  }
}

/** The platform's scope registry, pre-seeded with the v1 surface's scopes. */
export const scopeRegistry = new ScopeRegistry();

const V1_SCOPES: ScopeDefinition[] = [
  { scope: 'documents:read', description: 'Read documents in the workspace' },
  { scope: 'documents:write', description: 'Create and update documents in the workspace' },
  { scope: 'issues:read', description: 'Read issues in the workspace' },
  { scope: 'issues:write', description: 'Create and update issues in the workspace' },
  { scope: 'sprints:read', description: 'Read sprints and iteration data in the workspace' },
  { scope: 'sprints:write', description: 'Create and update sprints in the workspace' },
  { scope: 'webhooks:manage', description: 'Create, list, and delete webhook subscriptions' },
];

for (const def of V1_SCOPES) scopeRegistry.register(def);
