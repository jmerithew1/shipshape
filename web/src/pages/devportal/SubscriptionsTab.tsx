/**
 * Subscriptions — one app's webhook endpoints.
 *
 * The signing secret follows the same rule as the client secret: returned once
 * at creation, stored only as a hash, and shown through the same modal so the
 * "you cannot get this back" warning is worded identically in both places.
 */
import { useState } from 'react';
import {
  useSubscriptions,
  useCreateSubscription,
  useDeleteSubscription,
  SUGGESTED_EVENT_TYPES,
  type IssuedSecret,
} from './api';
import { SecretModal } from './SecretModal';
import { EndpointError } from './EndpointError';

export function SubscriptionsTab({ appId }: { appId: string | null }) {
  const subscriptions = useSubscriptions(appId);
  const create = useCreateSubscription();
  const remove = useDeleteSubscription(appId);

  const [eventType, setEventType] = useState('');
  const [targetUrl, setTargetUrl] = useState('');
  const [issuedSecret, setIssuedSecret] = useState<IssuedSecret | null>(null);

  if (!appId) {
    return <div className="text-sm text-muted">Select an app to manage its subscriptions.</div>;
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!appId || !eventType.trim() || !targetUrl.trim()) return;

    create.mutate(
      { app_id: appId, event_type: eventType.trim(), target_url: targetUrl.trim() },
      {
        onSuccess: ({ subscription, signingSecret }) => {
          setEventType('');
          setTargetUrl('');
          if (signingSecret) {
            setIssuedSecret({
              appName: `${subscription.event_type} → ${subscription.target_url}`,
              clientId: null,
              clientSecret: signingSecret,
              warning:
                'Use this secret to verify the signature on every delivery to this endpoint.',
            });
          }
        },
      }
    );
  }

  function handleDismissSecret() {
    setIssuedSecret(null);
    create.reset();
  }

  const rows = subscriptions.data?.data ?? [];

  return (
    <div className="space-y-8">
      {issuedSecret && <SecretModal secret={issuedSecret} onDismiss={handleDismissSecret} />}

      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-medium text-foreground">Add a subscription</h2>
          <p className="text-xs text-muted">
            Ship POSTs the event to this URL and retries on failure (1s, 4s, 16s, 1m, 5m, 30m)
            before dead-lettering it.
          </p>
        </div>

        <form onSubmit={handleCreate} className="flex max-w-3xl flex-wrap items-end gap-3">
          <div className="w-56">
            <label htmlFor="sub-event" className="mb-1 block text-xs text-muted">
              Event type
            </label>
            <input
              id="sub-event"
              type="text"
              list="ship-event-types"
              value={eventType}
              onChange={(e) => setEventType(e.target.value)}
              placeholder="document.updated"
              className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <datalist id="ship-event-types">
              {SUGGESTED_EVENT_TYPES.map((type) => (
                <option key={type} value={type} />
              ))}
            </datalist>
          </div>
          <div className="min-w-[18rem] flex-1">
            <label htmlFor="sub-url" className="mb-1 block text-xs text-muted">
              Target URL
            </label>
            <input
              id="sub-url"
              type="url"
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              placeholder="https://example.com/hooks/ship"
              className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <button
            type="submit"
            disabled={create.isPending || !eventType.trim() || !targetUrl.trim()}
            className="rounded-md bg-accent px-4 py-2 text-sm text-white transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {create.isPending ? 'Adding…' : 'Add subscription'}
          </button>
        </form>

        {create.error && <EndpointError error={create.error} />}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-foreground">Subscriptions</h2>

        {subscriptions.isLoading ? (
          <div className="text-sm text-muted">Loading…</div>
        ) : subscriptions.error ? (
          <EndpointError error={subscriptions.error} />
        ) : rows.length === 0 ? (
          <div className="text-sm text-muted">No subscriptions for this app yet.</div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full">
              <thead className="bg-border/30">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-medium text-muted">Event type</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-muted">Target URL</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-muted">Secret</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-muted">Status</th>
                  <th className="px-4 py-3 text-right text-sm font-medium text-muted">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((sub) => (
                  <tr key={sub.id} className={sub.active ? '' : 'opacity-50'}>
                    <td className="px-4 py-3 font-mono text-sm text-foreground">{sub.event_type}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted">{sub.target_url}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted">
                      {sub.secret_prefix}…
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {sub.active ? (
                        <span className="text-green-500">Active</span>
                      ) : (
                        <span className="text-muted">Inactive</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-sm">
                      <button
                        type="button"
                        onClick={() => {
                          if (confirm(`Delete the subscription to ${sub.target_url}?`)) {
                            remove.mutate(sub.id);
                          }
                        }}
                        disabled={remove.isPending}
                        className="text-red-500 transition-colors hover:text-red-400 disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {remove.error && <EndpointError error={remove.error} />}
      </section>
    </div>
  );
}
