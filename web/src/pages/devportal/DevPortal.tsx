/**
 * Developer portal (Week 6, "PlugForge") — /devportal.
 *
 * Four screens, one selected app. The app selector lives in the shell rather
 * than in each tab because subscriptions, deliveries, and (optionally) the
 * audit log are all views of the SAME app: switching tabs must not lose the
 * operator's place.
 *
 * Tab state is in the URL (`?tab=`) exactly as WorkspaceSettings does it, so a
 * link to the delivery log is a link to the delivery log.
 *
 * Deliberately plain: tables, a form, and one modal, styled with the classes
 * already in the app. No new dependencies. This is developer tooling that must
 * work, not a design exercise.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { useOAuthApps } from './api';
import { AppsTab } from './AppsTab';
import { SubscriptionsTab } from './SubscriptionsTab';
import { DeliveriesTab } from './DeliveriesTab';
import { AuditTab } from './AuditTab';

type Tab = 'apps' | 'subscriptions' | 'deliveries' | 'audit';

const TABS: { id: Tab; label: string }[] = [
  { id: 'apps', label: 'Apps' },
  { id: 'subscriptions', label: 'Subscriptions' },
  { id: 'deliveries', label: 'Delivery log' },
  { id: 'audit', label: 'Audit log' },
];

const VALID_TABS = TABS.map((t) => t.id);

/** Tabs that operate on one selected app. */
const APP_SCOPED: Tab[] = ['subscriptions', 'deliveries'];

export function DevPortalPage() {
  const { currentWorkspace } = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const apps = useOAuthApps();

  const tabParam = searchParams.get('tab') as Tab | null;
  const activeTab: Tab = tabParam && VALID_TABS.includes(tabParam) ? tabParam : 'apps';

  // Default to the first app rather than making the operator pick one when
  // there is only ever one sensible answer.
  const appList = apps.data ?? [];
  const effectiveAppId =
    selectedAppId ?? (appList.length > 0 ? (appList[0]?.id ?? null) : null);

  if (!currentWorkspace) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted">No workspace selected</div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 items-center justify-between border-b border-border px-6">
        <h1 className="text-lg font-semibold text-foreground">Developer Portal</h1>
        {APP_SCOPED.includes(activeTab) && appList.length > 0 && (
          <label className="flex items-center gap-2 text-xs text-muted">
            App
            <select
              value={effectiveAppId ?? ''}
              onChange={(e) => setSelectedAppId(e.target.value || null)}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
            >
              {appList.map((app) => (
                <option key={app.id} value={app.id}>
                  {app.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      <div className="border-b border-border">
        <nav className="flex px-6">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setSearchParams({ tab: tab.id }, { replace: true })}
              className={cn(
                'border-b-2 px-4 py-3 text-sm font-medium transition-colors',
                activeTab === tab.id
                  ? 'border-accent text-foreground'
                  : 'border-transparent text-muted hover:text-foreground'
              )}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      <main className="flex-1 overflow-auto p-6 pb-20">
        {activeTab === 'apps' && (
          <AppsTab selectedAppId={effectiveAppId} onSelectApp={setSelectedAppId} />
        )}
        {activeTab === 'subscriptions' && <SubscriptionsTab appId={effectiveAppId} />}
        {activeTab === 'deliveries' && <DeliveriesTab appId={effectiveAppId} />}
        {activeTab === 'audit' && <AuditTab />}
      </main>
    </div>
  );
}
