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

const SEEN_KEY = 'fleetgraph.seenFindingIds';
const TOASTED_KEY = 'fleetgraph.toastedFindingIds';

function readIds(key: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function writeIds(key: string, ids: Set<string>): void {
  // Cap growth: resolved findings never come back, old ids are inert.
  localStorage.setItem(key, JSON.stringify([...ids].slice(-200)));
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
        : `FleetGraph found ${fresh.length} things that need your call`,
      'info',
      8000,
      { label: 'View', onClick: () => setOpen(true) },
    );
    fresh.forEach((f) => toasted.add(f.id));
    writeIds(TOASTED_KEY, toasted);

    // If the panel is already open, these count as seen immediately.
    if (openRef.current) {
      const seen = readIds(SEEN_KEY);
      fresh.forEach((f) => seen.add(f.id));
      writeIds(SEEN_KEY, seen);
    }
    setSeenVersion((v) => v + 1);
  }, [findings, showToast]);

  if (findings.length === 0) return null;

  const seen = readIds(SEEN_KEY);
  const unseenCount = findings.filter((f) => !seen.has(f.id)).length;

  const toggle = () => {
    setOpen((o) => {
      const next = !o;
      if (next) {
        const s = readIds(SEEN_KEY);
        findings.forEach((f) => s.add(f.id));
        writeIds(SEEN_KEY, s);
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
        title={`FleetGraph: ${findings.length} finding${findings.length === 1 ? '' : 's'} need your call`}
      >
        <span
          className={cn(
            'flex items-center justify-center h-5 w-5 rounded-full text-[10px] font-bold',
            unseenCount > 0 ? 'bg-white/25 text-white' : 'bg-indigo-600 text-white',
          )}
        >
          F
        </span>
        {unseenCount > 0 ? `${unseenCount} need${unseenCount === 1 ? 's' : ''} your call` : findings.length}
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
