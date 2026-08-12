/**
 * Delivery log — the operator's answer to "did my webhook arrive, and if not,
 * why".
 *
 * SERVER-SIDE PAGINATION. The cursor stack is the whole state: `cursors` holds
 * the cursor for each page visited, so Back is a pop rather than a refetch of
 * everything before it. Client-side slicing of a table that grows by one row
 * per event is not an option.
 *
 * REPLAY CHAINS. A delivery with `replay_of_id` is a manual re-send of an
 * earlier one, and it keeps the original's idempotency key. Showing it as an
 * unrelated row would make the log read as duplicate deliveries, so a replay
 * is indented under a reference to its original, and the original is marked
 * when it is on the same page.
 */
import { useState } from 'react';
import { cn } from '@/lib/cn';
import { useDeliveries, useReplayDelivery, type DeliveryStatus, type WebhookDelivery } from './api';
import { EndpointError } from './EndpointError';

const STATUS_COLOR: Record<DeliveryStatus, string> = {
  pending: 'text-muted',
  delivering: 'text-blue-500',
  succeeded: 'text-green-500',
  failed: 'text-yellow-500',
  dead_lettered: 'text-red-500',
};

function shortId(id: string): string {
  return id.slice(0, 8);
}

export function DeliveriesTab({ appId }: { appId: string | null }) {
  // `cursors` is the stack of cursors for pages 2..n; page 1 has no cursor.
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.length > 0 ? (cursors[cursors.length - 1] ?? null) : null;

  const deliveries = useDeliveries(appId, cursor);
  const replay = useReplayDelivery(appId);

  if (!appId) {
    return <div className="text-sm text-muted">Select an app to see its delivery log.</div>;
  }

  const rows: WebhookDelivery[] = deliveries.data?.data ?? [];
  const idsOnPage = new Set(rows.map((row) => row.id));
  const replayedIds = new Set(
    rows.map((row) => row.replay_of_id).filter((id): id is string => id !== null)
  );

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-medium text-foreground">Delivery log</h2>
        <p className="text-xs text-muted">
          Newest first. Dead-lettered deliveries have exhausted the retry ladder and can be
          replayed by hand; a replay carries the original idempotency key.
        </p>
      </div>

      {replay.error && <EndpointError error={replay.error} />}

      {deliveries.isLoading ? (
        <div className="text-sm text-muted">Loading…</div>
      ) : deliveries.error ? (
        <EndpointError error={deliveries.error} />
      ) : rows.length === 0 ? (
        <div className="text-sm text-muted">No deliveries yet.</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full">
            <thead className="bg-border/30">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted">Event</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted">Status</th>
                <th className="px-4 py-3 text-right text-sm font-medium text-muted">Attempt</th>
                <th className="px-4 py-3 text-right text-sm font-medium text-muted">Response</th>
                <th className="px-4 py-3 text-right text-sm font-medium text-muted">Latency</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted">When</th>
                <th className="px-4 py-3 text-right text-sm font-medium text-muted">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => {
                const isReplay = row.replay_of_id !== null;
                return (
                  <tr key={row.id} className={cn(isReplay && 'bg-accent/5')}>
                    <td className="px-4 py-3 text-sm">
                      <div className={cn('font-mono text-foreground', isReplay && 'pl-4')}>
                        {isReplay && <span className="mr-1 text-muted">↳</span>}
                        {row.event_type}
                      </div>
                      {isReplay && row.replay_of_id && (
                        <div className="pl-4 text-xs text-muted">
                          replay of{' '}
                          <span className="font-mono">{shortId(row.replay_of_id)}</span>
                          {idsOnPage.has(row.replay_of_id) ? ' (below)' : ''}
                        </div>
                      )}
                      {!isReplay && replayedIds.has(row.id) && (
                        <div className="text-xs text-muted">replayed above</div>
                      )}
                      {row.last_error && (
                        <div className="max-w-md truncate text-xs text-red-500" title={row.last_error}>
                          {row.last_error}
                        </div>
                      )}
                    </td>
                    <td className={cn('px-4 py-3 text-sm', STATUS_COLOR[row.status] ?? 'text-muted')}>
                      {row.status.replace('_', ' ')}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-muted">{row.attempt_number}</td>
                    <td className="px-4 py-3 text-right text-sm text-muted">
                      {row.response_status ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-muted">
                      {row.latency_ms === null ? '—' : `${row.latency_ms} ms`}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted">
                      {new Date(row.delivered_at ?? row.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right text-sm">
                      {row.status === 'dead_lettered' && (
                        <button
                          type="button"
                          onClick={() => replay.mutate(row.id)}
                          disabled={replay.isPending}
                          className="rounded-md bg-border/50 px-3 py-1 text-foreground transition-colors hover:bg-border disabled:opacity-50"
                        >
                          {replay.isPending ? 'Replaying…' : 'Replay'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setCursors((prev) => prev.slice(0, -1))}
          disabled={cursors.length === 0}
          className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-border/30 disabled:opacity-40"
        >
          Back
        </button>
        <button
          type="button"
          onClick={() => {
            const next = deliveries.data?.next_cursor;
            if (next) setCursors((prev) => [...prev, next]);
          }}
          disabled={!deliveries.data?.next_cursor}
          className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-border/30 disabled:opacity-40"
        >
          Next
        </button>
        <span className="text-xs text-muted">Page {cursors.length + 1}</span>
      </div>
    </div>
  );
}
