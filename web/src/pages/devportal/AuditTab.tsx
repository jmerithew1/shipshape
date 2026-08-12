/**
 * Audit log — every /api/v1 call this workspace served.
 *
 * `request_id` is shown first because it is the join key: the same value is in
 * the X-Request-Id header the client saw, in the ApiError body it received,
 * and in the server logs. One id answers "what actually happened to that
 * request" without correlating timestamps.
 */
import { useState } from 'react';
import { cn } from '@/lib/cn';
import { useAuditLog, useOAuthApps } from './api';

function statusColor(status: number): string {
  if (status >= 500) return 'text-red-500';
  if (status === 429) return 'text-yellow-500';
  if (status >= 400) return 'text-yellow-500';
  return 'text-green-500';
}

export function AuditTab() {
  const [clientId, setClientId] = useState<string | null>(null);
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.length > 0 ? (cursors[cursors.length - 1] ?? null) : null;

  const apps = useOAuthApps();
  const audit = useAuditLog(clientId, cursor);
  const rows = audit.data?.logs ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-foreground">Public API calls</h2>
          <p className="text-xs text-muted">
            Every request served on /api/v1 for this workspace, newest first.
          </p>
        </div>
        <div>
          <label htmlFor="audit-client" className="mb-1 block text-xs text-muted">
            Filter by app
          </label>
          <select
            id="audit-client"
            value={clientId ?? ''}
            onChange={(e) => {
              setClientId(e.target.value || null);
              setCursors([]);
            }}
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          >
            <option value="">All apps</option>
            {(apps.data ?? []).map((app) => (
              <option key={app.id} value={app.client_id}>
                {app.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {audit.error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">
          {audit.error.message}
        </div>
      )}

      {audit.isLoading ? (
        <div className="text-sm text-muted">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-muted">No public API calls recorded yet.</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full">
            <thead className="bg-border/30">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted">When</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted">Request ID</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted">Route</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted">Scope</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted">Client</th>
                <th className="px-4 py-3 text-right text-sm font-medium text-muted">Status</th>
                <th className="px-4 py-3 text-right text-sm font-medium text-muted">Latency</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="whitespace-nowrap px-4 py-3 text-xs text-muted">
                    {new Date(row.occurred_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted">{row.request_id}</td>
                  <td className="px-4 py-3 font-mono text-xs text-foreground">
                    <span className="mr-1 text-muted">{row.method}</span>
                    {row.route}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted">{row.scope_used ?? '—'}</td>
                  <td className="px-4 py-3 font-mono text-xs text-muted">{row.client_id ?? '—'}</td>
                  <td className={cn('px-4 py-3 text-right text-sm', statusColor(row.status))}>
                    {row.status}
                  </td>
                  <td className="px-4 py-3 text-right text-sm text-muted">{row.latency_ms} ms</td>
                </tr>
              ))}
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
            const next = audit.data?.next_cursor;
            if (next) setCursors((prev) => [...prev, next]);
          }}
          disabled={!audit.data?.next_cursor}
          className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-border/30 disabled:opacity-40"
        >
          Next
        </button>
        <span className="text-xs text-muted">Page {cursors.length + 1}</span>
      </div>
    </div>
  );
}
