/**
 * Shown-once client secret.
 *
 * The security property this component exists to hold: THE VALUE LIVES IN
 * EXACTLY ONE PLACE, the caller's `secret` prop, and it is gone the moment the
 * modal is dismissed.
 *
 *   - this component copies the secret into no state of its own (only the
 *     boolean "copied" flag), so unmounting it is genuinely destructive;
 *   - `onDismiss` is the caller's cue to null its own state AND to reset the
 *     mutation that produced the secret — react-query keeps `mutation.data`
 *     alive otherwise, which would quietly leave the secret in the cache long
 *     after the modal closed;
 *   - dismissal is a deliberate act (an explicit button, plus Escape). There
 *     is no backdrop click: a stray click must not destroy a credential the
 *     operator has not written down yet.
 */
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import type { IssuedSecret } from './api';

export function SecretModal({
  secret,
  onDismiss,
}: {
  secret: IssuedSecret;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const dismissRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    dismissRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(secret.clientSecret);
      setCopied(true);
      setCopyFailed(false);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard permission denied / insecure context: say so instead of
      // silently pretending the copy worked.
      setCopyFailed(true);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="secret-modal-title"
    >
      <div className="w-full max-w-lg space-y-4 rounded-lg border border-border bg-background p-6 shadow-lg">
        <div>
          <h2 id="secret-modal-title" className="text-base font-semibold text-foreground">
            Client secret for {secret.appName}
          </h2>
          <p className="mt-1 text-sm text-muted">{secret.warning}</p>
        </div>

        <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3">
          <p className="text-sm font-medium text-foreground">
            This is the only time this secret will ever be shown.
          </p>
          <p className="mt-1 text-xs text-muted">
            Ship stores only a hash of it. If you lose it, nobody — not you, not an
            administrator — can recover it; you will have to rotate the secret and update
            every deployment of your app.
          </p>
        </div>

        {secret.clientId && (
          <div>
            <div className="mb-1 text-xs text-muted">Client ID</div>
            <code className="block overflow-x-auto rounded-md border border-border bg-background px-3 py-2 font-mono text-sm text-foreground">
              {secret.clientId}
            </code>
          </div>
        )}

        <div>
          <div className="mb-1 text-xs text-muted">Client secret</div>
          <div className="flex gap-2">
            <code
              data-testid="client-secret-value"
              className="flex-1 overflow-x-auto rounded-md border border-border bg-background px-3 py-2 font-mono text-sm text-foreground"
            >
              {secret.clientSecret}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              className={cn(
                'rounded-md px-3 py-2 text-sm transition-colors',
                copied ? 'bg-green-500/20 text-green-500' : 'bg-border/50 text-foreground hover:bg-border'
              )}
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          {copyFailed && (
            <p className="mt-1 text-xs text-red-500">
              Could not access the clipboard. Select the secret above and copy it manually.
            </p>
          )}
        </div>

        <div className="flex justify-end">
          <button
            ref={dismissRef}
            type="button"
            onClick={onDismiss}
            className="rounded-md bg-accent px-4 py-2 text-sm text-white transition-colors hover:bg-accent/90"
          >
            I have stored the secret
          </button>
        </div>
      </div>
    </div>
  );
}
