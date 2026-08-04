import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { apiPost } from '@/lib/api';

/**
 * FleetGraph context chat — embedded in the document view, scoped to what
 * the user is looking at. The header and suggested questions prove the
 * scoping at first paint; there is no standalone chat page by design.
 */

interface ChatMessage {
  role: 'user' | 'agent';
  text: string;
  degraded?: boolean;
}

const SUGGESTED_BY_TYPE: Record<string, string[]> = {
  issue: [
    "What's the current state of this issue?",
    'Has anything happened here in the last few days?',
    'Who should I talk to about this?',
  ],
  sprint: [
    'Is this week on track?',
    'What is most at risk this week?',
    "What hasn't moved since Monday?",
  ],
  project: [
    'How healthy is this project right now?',
    'What needs a decision from me?',
    'What has the team shipped recently?',
  ],
};

export function AgentChatPanel({
  docType,
  docId,
  docTitle,
  projectId,
  weekId,
}: {
  docType: string;
  docId: string;
  docTitle: string;
  projectId?: string | null;
  weekId?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [authExpired, setAuthExpired] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  // Fresh document, fresh conversation — the panel is scoped to the view.
  useEffect(() => {
    setMessages([]);
  }, [docId]);

  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    setMessages((m) => [...m, { role: 'user', text }]);
    setInput('');
    setBusy(true);
    try {
      const res = await apiPost('/api/agent/chat', {
        doc_type: docType,
        doc_id: docId,
        project_id: projectId ?? null,
        week_id: weekId ?? null,
        message: text,
      });
      if (res.status === 401) {
        setAuthExpired(true);
        return;
      }
      const body = await res.json();
      setMessages((m) => [
        ...m,
        {
          role: 'agent',
          text: body.response ?? body.error ?? 'No response.',
          degraded: body.degraded,
        },
      ]);
    } catch {
      setMessages((m) => [
        ...m,
        { role: 'agent', text: 'Something went wrong reaching FleetGraph.', degraded: true },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const suggestions: string[] =
    SUGGESTED_BY_TYPE[docType] ?? SUGGESTED_BY_TYPE.project ?? [];

  return (
    <>
      {/* Toggle — lives on the document view, never a standalone page */}
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full px-4 py-2 shadow-lg',
          'bg-indigo-600 text-white hover:bg-indigo-700 text-sm font-semibold',
        )}
        title="Ask FleetGraph about this document"
      >
        <span className="flex items-center justify-center h-5 w-5 rounded-full bg-white/20 text-[10px] font-bold">
          F
        </span>
        {open ? 'Close' : 'Ask FleetGraph'}
      </button>

      {open && (
        <div className="fixed bottom-20 right-5 z-40 w-96 max-w-[calc(100vw-2.5rem)] rounded-xl border border-border bg-background shadow-2xl flex flex-col overflow-hidden">
          {/* Context header — proves the scoping at first paint */}
          <div className="px-4 py-3 border-b border-border bg-indigo-500/10">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-indigo-700 dark:text-indigo-300">
              FleetGraph · scoped to this view
            </div>
            <div className="text-sm font-medium text-foreground truncate mt-0.5">
              Discussing: {docTitle || 'Untitled'}
            </div>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 max-h-80 min-h-40">
            {messages.length === 0 && (
              <div className="space-y-2">
                <p className="text-xs text-muted">
                  Grounded in this {docType === 'sprint' ? 'week' : docType} and its
                  neighborhood. Try:
                </p>
                {suggestions.map((s) => (
                  <button
                    key={s}
                    onClick={() => void send(s)}
                    className="block w-full text-left text-xs px-3 py-2 rounded-lg border border-border hover:bg-indigo-500/10 text-foreground"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
            {messages.map((m, i) => (
              <div
                key={i}
                className={cn(
                  'text-sm rounded-lg px-3 py-2 whitespace-pre-wrap',
                  m.role === 'user'
                    ? 'bg-indigo-600 text-white ml-8'
                    : 'bg-background border border-border mr-4',
                  m.degraded && 'italic text-muted',
                )}
              >
                {m.text}
              </div>
            ))}
            {busy && <div className="text-xs text-muted italic">FleetGraph is reading this view…</div>}
            {authExpired && (
              <div className="text-xs text-red-600 dark:text-red-400">
                Your session expired. <a className="underline" href="/login">Sign in again</a> to
                continue this conversation.
              </div>
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
            className="flex gap-2 p-3 border-t border-border"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={`Ask about this ${docType === 'sprint' ? 'week' : docType}…`}
              className="flex-1 text-sm px-3 py-2 rounded-lg border border-border bg-background"
              disabled={busy || authExpired}
            />
            <button
              type="submit"
              disabled={busy || !input.trim() || authExpired}
              className="text-sm font-semibold px-3 py-2 rounded-lg bg-indigo-600 text-white disabled:opacity-50"
            >
              Send
            </button>
          </form>
        </div>
      )}
    </>
  );
}

export default AgentChatPanel;
