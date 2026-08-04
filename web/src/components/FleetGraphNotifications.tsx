import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { useAgentFindingsQuery } from '@/hooks/useAgentFindingsQuery';
import { FindingCard } from '@/components/AgentFindings';
import { useCurrentDocument } from '@/contexts/CurrentDocumentContext';
import { useToast } from '@/components/ui/Toast';

/**
 * Global FleetGraph notification widget — bottom-right on every page.
 *
 * Attention design (James's field feedback, 2026-08-04): a passive badge is
 * wallpaper. New findings announce themselves once via the app's toast system
 * and the button pulses until the panel is opened; after that the widget goes
 * quiet again. Renders nothing at all when there are no open findings — the
 * agent earns attention, it doesn't reserve screen space.
 */

const SEEN_KEY = 'fleetgraph.seenFindings';
const TOASTED_KEY = 'fleetgraph.toastedFindingIds';

/** A glance buys quiet in proportion to the stakes, not forever — undecided
 *  findings re-pulse so they can't be forgotten, sooner when they matter
 *  more. Only a disposition clears them for good. */
const SEEN_TTL_BY_SEVERITY: Record<string, number> = {
  critical: 30 * 60 * 1000,
  high: 60 * 60 * 1000,
  medium: 2 * 60 * 60 * 1000,
  low: 4 * 60 * 60 * 1000,
};
const DEFAULT_SEEN_TTL_MS = 2 * 60 * 60 * 1000;

function readIds(key: string): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '[]');
    return new Set(Array.isArray(parsed) ? (parsed as string[]) : []);
  } catch {
    return new Set();
  }
}

function writeIds(key: string, ids: Set<string>): void {
  // Cap growth: resolved findings never come back, old ids are inert.
  localStorage.setItem(key, JSON.stringify([...ids].slice(-200)));
}

function readSeenMap(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, number>)
      : {};
  } catch {
    return {};
  }
}

function writeSeenMap(map: Record<string, number>): void {
  const entries = Object.entries(map).slice(-200);
  localStorage.setItem(SEEN_KEY, JSON.stringify(Object.fromEntries(entries)));
}

function isSeenFresh(
  map: Record<string, number>,
  id: string,
  severity: string,
): boolean {
  const at = map[id];
  const ttl = SEEN_TTL_BY_SEVERITY[severity] ?? DEFAULT_SEEN_TTL_MS;
  return typeof at === 'number' && Date.now() - at < ttl;
}

export function FleetGraphNotifications() {
  const { data } = useAgentFindingsQuery();
  const { currentDocumentId } = useCurrentDocument();
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  // Bump to re-render after mutating localStorage-backed seen-state.
  const [, setSeenVersion] = useState(0);
  const openRef = useRef(open);
  openRef.current = open;

  const findings = data?.findings ?? [];

  // Announce genuinely new findings once, via toast.
  useEffect(() => {
    if (findings.length === 0) return;
    const toasted = readIds(TOASTED_KEY);
    const fresh = findings.filter((f) => !toasted.has(f.id));
    if (fresh.length === 0) return;

    const first = fresh[0]!;
    showToast(
      fresh.length === 1
        ? `FleetGraph: ${first.title}`
        : `FleetGraph: ${fresh.length} new alerts need attention`,
      'info',
      8000,
      { label: 'View', onClick: () => setOpen(true) },
    );
    fresh.forEach((f) => toasted.add(f.id));
    writeIds(TOASTED_KEY, toasted);

    // If the panel is already open, these count as seen immediately.
    if (openRef.current) {
      const seen = readSeenMap();
      fresh.forEach((f) => { seen[f.id] = Date.now(); });
      writeSeenMap(seen);
    }
    setSeenVersion((v) => v + 1);
  }, [findings, showToast]);

  if (findings.length === 0) return null;

  const seen = readSeenMap();
  const unseenCount = findings.filter((f) => !isSeenFresh(seen, f.id, f.severity)).length;

  const toggle = () => {
    setOpen((o) => {
      const next = !o;
      if (next) {
        const m = readSeenMap();
        findings.forEach((f) => { m[f.id] = Date.now(); });
        writeSeenMap(m);
        setSeenVersion((v) => v + 1);
      }
      return next;
    });
  };

  // Chat button occupies bottom-right on document pages; stack above it.
  const anchor = currentDocumentId ? 'bottom-20' : 'bottom-5';

  return (
    <>
      {/* Pulse halo sits behind the button while findings are unseen */}
      <span
        className={cn('fixed right-5 z-30 pointer-events-none', anchor)}
        aria-hidden="true"
      >
        {unseenCount > 0 && (
          <span className="absolute inset-0 rounded-full bg-indigo-500/60 motion-safe:animate-ping" />
        )}
      </span>
      <button
        onClick={toggle}
        className={cn(
          'fixed right-5 z-40 flex items-center gap-2 rounded-full px-4 py-2.5 shadow-lg text-sm font-semibold transition-colors',
          unseenCount > 0
            ? 'bg-indigo-600 text-white hover:bg-indigo-700 motion-safe:animate-pulse'
            : 'bg-background border border-indigo-500/50 hover:border-indigo-500 text-foreground',
          anchor,
        )}
        title={`FleetGraph: ${findings.length} alert${findings.length === 1 ? '' : 's'} waiting for a decision`}
      >
        <span
          className={cn(
            'flex items-center justify-center h-5 w-5 rounded-full text-[10px] font-bold',
            unseenCount > 0 ? 'bg-white/25 text-white' : 'bg-indigo-600 text-white',
          )}
        >
          F
        </span>
        {unseenCount > 0
          ? `${unseenCount} new alert${unseenCount === 1 ? '' : 's'}`
          : `${findings.length} alert${findings.length === 1 ? '' : 's'}`}
      </button>

      {open && (
        <div
          className={cn(
            'fixed right-5 z-40 w-[26rem] max-w-[calc(100vw-2.5rem)] rounded-xl border border-border bg-background shadow-2xl overflow-hidden flex flex-col',
            currentDocumentId ? 'bottom-36' : 'bottom-20',
          )}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-indigo-500/10">
            <div className="flex items-center gap-2">
              <span className="flex items-center justify-center h-5 w-5 rounded-full bg-indigo-600 text-white text-[10px] font-bold">
                F
              </span>
              <h2 className="text-sm font-semibold text-indigo-700 dark:text-indigo-300">
                FleetGraph
              </h2>
            </div>
            <span className="text-[11px] text-muted">
              Notifies once · cards clear themselves when resolved
            </span>
          </div>
          <div className="divide-y divide-border overflow-y-auto max-h-[60vh]">
            {findings.map((f) => (
              <FindingCard key={f.id} finding={f} />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

export default FleetGraphNotifications;
