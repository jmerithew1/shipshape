import { useState } from 'react';
import { cn } from '@/lib/cn';
import { useAgentFindingsQuery } from '@/hooks/useAgentFindingsQuery';
import { FindingCard } from '@/components/AgentFindings';
import { useCurrentDocument } from '@/contexts/CurrentDocumentContext';

/**
 * Global FleetGraph notification widget — bottom-right on every page.
 *
 * Anti-noise by design: renders nothing at all when there are no open
 * findings (the agent earns attention; it doesn't reserve screen space).
 * On document pages it stacks above the "Ask FleetGraph" chat button.
 */
export function FleetGraphNotifications() {
  const { data } = useAgentFindingsQuery();
  const { currentDocumentId } = useCurrentDocument();
  const [open, setOpen] = useState(false);

  const findings = data?.findings ?? [];
  if (findings.length === 0) return null;

  // Chat button occupies bottom-right on document pages; stack above it.
  const anchor = currentDocumentId ? 'bottom-20' : 'bottom-5';

  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'fixed right-5 z-40 flex items-center gap-2 rounded-full px-3.5 py-2 shadow-lg',
          'bg-background border border-indigo-500/50 hover:border-indigo-500 text-sm font-semibold',
          anchor,
        )}
        title={`FleetGraph: ${findings.length} finding${findings.length === 1 ? '' : 's'} need your call`}
      >
        <span className="flex items-center justify-center h-5 w-5 rounded-full bg-indigo-600 text-white text-[10px] font-bold">
          F
        </span>
        <span className="px-1.5 py-0.5 text-xs font-bold rounded-full bg-indigo-600 text-white">
          {findings.length}
        </span>
      </button>

      {open && (
        <div
          className={cn(
            'fixed right-5 z-40 w-[26rem] max-w-[calc(100vw-2.5rem)] rounded-xl border border-border bg-background shadow-2xl overflow-hidden flex flex-col',
            currentDocumentId ? 'bottom-32' : 'bottom-16',
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
