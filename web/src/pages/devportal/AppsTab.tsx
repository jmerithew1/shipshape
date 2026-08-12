/**
 * Apps — register an OAuth app, rotate its secret, deactivate it.
 *
 * The scope checkboxes are populated from GET /api/oauth-apps/scopes rather
 * than a list in this file. That is the visible half of "scopes are data": a
 * scope added to the server's registry appears here with no frontend change.
 */
import { useState } from 'react';
import { cn } from '@/lib/cn';
import {
  useOAuthApps,
  useScopes,
  useRegisterApp,
  useRotateSecret,
  useDeactivateApp,
  type IssuedSecret,
  type OAuthApp,
} from './api';
import { SecretModal } from './SecretModal';

/** Accepts one URI per line, or comma-separated. */
function parseRedirectUris(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function AppsTab({
  selectedAppId,
  onSelectApp,
}: {
  selectedAppId: string | null;
  onSelectApp: (appId: string) => void;
}) {
  const apps = useOAuthApps();
  const scopes = useScopes();
  const register = useRegisterApp();
  const rotate = useRotateSecret();
  const deactivate = useDeactivateApp();

  const [name, setName] = useState('');
  const [redirectUris, setRedirectUris] = useState('');
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [issuedSecret, setIssuedSecret] = useState<IssuedSecret | null>(null);

  const error = register.error ?? rotate.error ?? deactivate.error ?? apps.error;

  function toggleScope(scope: string) {
    setSelectedScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]
    );
  }

  function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    const uris = parseRedirectUris(redirectUris);
    if (!name.trim() || uris.length === 0 || selectedScopes.length === 0) return;

    register.mutate(
      { name: name.trim(), redirect_uris: uris, requested_scopes: selectedScopes },
      {
        onSuccess: (secret) => {
          setIssuedSecret(secret);
          setName('');
          setRedirectUris('');
          setSelectedScopes([]);
        },
      }
    );
  }

  function handleRotate(app: OAuthApp) {
    if (!confirm(`Rotate the secret for "${app.name}"? The current secret stops working immediately.`)) {
      return;
    }
    rotate.mutate(app, { onSuccess: (secret) => setIssuedSecret(secret) });
  }

  function handleDeactivate(app: OAuthApp) {
    if (!confirm(`Deactivate "${app.name}"? Every token it issued is revoked immediately.`)) return;
    deactivate.mutate(app.id);
  }

  /**
   * Dismissal must destroy the secret everywhere it exists: our state AND the
   * mutation caches that produced it.
   */
  function handleDismissSecret() {
    setIssuedSecret(null);
    register.reset();
    rotate.reset();
  }

  const canSubmit =
    name.trim().length > 0 &&
    parseRedirectUris(redirectUris).length > 0 &&
    selectedScopes.length > 0 &&
    !register.isPending;

  return (
    <div className="space-y-8">
      {issuedSecret && <SecretModal secret={issuedSecret} onDismiss={handleDismissSecret} />}

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">
          {error.message}
        </div>
      )}

      {/* Register */}
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-medium text-foreground">Register an app</h2>
          <p className="text-xs text-muted">
            The client secret is shown once, at creation. Ship keeps only a hash.
          </p>
        </div>

        <form onSubmit={handleRegister} className="max-w-2xl space-y-4">
          <div>
            <label htmlFor="app-name" className="mb-1 block text-xs text-muted">
              App name
            </label>
            <input
              id="app-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Deploy Bot"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>

          <div>
            <label htmlFor="app-redirects" className="mb-1 block text-xs text-muted">
              Redirect URIs (one per line)
            </label>
            <textarea
              id="app-redirects"
              value={redirectUris}
              onChange={(e) => setRedirectUris(e.target.value)}
              rows={3}
              placeholder="https://example.com/oauth/callback"
              className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>

          <fieldset>
            <legend className="mb-1 text-xs text-muted">Scopes</legend>
            {scopes.isLoading && <div className="text-sm text-muted">Loading scopes…</div>}
            <div className="grid gap-1 sm:grid-cols-2">
              {(scopes.data ?? []).map((def) => (
                <label key={def.scope} className="flex cursor-pointer items-start gap-2 py-1">
                  <input
                    type="checkbox"
                    checked={selectedScopes.includes(def.scope)}
                    onChange={() => toggleScope(def.scope)}
                    className="mt-1 h-3.5 w-3.5 rounded border-border text-accent focus:ring-accent/50"
                  />
                  <span>
                    <span className="font-mono text-sm text-foreground">{def.scope}</span>
                    <span className="block text-xs text-muted">{def.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <button
            type="submit"
            disabled={!canSubmit}
            className="rounded-md bg-accent px-4 py-2 text-sm text-white transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {register.isPending ? 'Registering…' : 'Register app'}
          </button>
        </form>
      </section>

      {/* List */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-foreground">Registered apps</h2>

        {apps.isLoading ? (
          <div className="text-sm text-muted">Loading…</div>
        ) : (apps.data ?? []).length === 0 ? (
          <div className="text-sm text-muted">No apps registered yet.</div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full">
              <thead className="bg-border/30">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-medium text-muted">Name</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-muted">Client ID</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-muted">Secret</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-muted">Scopes</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-muted">Status</th>
                  <th className="px-4 py-3 text-right text-sm font-medium text-muted">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(apps.data ?? []).map((app) => (
                  <tr
                    key={app.id}
                    className={cn(
                      !app.active && 'opacity-50',
                      selectedAppId === app.id && 'bg-accent/5'
                    )}
                  >
                    <td className="px-4 py-3 text-sm">
                      <button
                        type="button"
                        onClick={() => onSelectApp(app.id)}
                        className="font-medium text-foreground hover:text-accent"
                        title="Select this app for the Subscriptions and Deliveries tabs"
                      >
                        {app.name}
                      </button>
                      <div className="text-xs text-muted">
                        {app.redirect_uris.join(', ') || 'no redirect URIs'}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted">{app.client_id}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted">
                      {app.client_secret_prefix}…
                      {app.secret_rotated_at && (
                        <span className="block text-[11px]">
                          rotated {new Date(app.secret_rotated_at).toLocaleDateString()}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted">
                      {app.requested_scopes.join(', ')}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {app.active ? (
                        <span className="text-green-500">Active</span>
                      ) : (
                        <span className="text-red-500">Inactive</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right text-sm">
                      {app.active && (
                        <>
                          <button
                            type="button"
                            onClick={() => handleRotate(app)}
                            disabled={rotate.isPending}
                            className="text-muted transition-colors hover:text-foreground disabled:opacity-50"
                          >
                            Rotate secret
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeactivate(app)}
                            disabled={deactivate.isPending}
                            className="ml-3 text-red-500 transition-colors hover:text-red-400 disabled:opacity-50"
                          >
                            Deactivate
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
