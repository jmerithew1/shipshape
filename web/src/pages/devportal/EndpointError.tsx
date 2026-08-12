/**
 * One error banner for the webhook screens.
 *
 * It calls out the 404/401 cases explicitly because those two mean something
 * specific and actionable here — the public webhook surface is a separate
 * deployable from this portal, so "not found" means "that endpoint is not
 * mounted on this server", not "you did something wrong".
 */
export function EndpointError({ error }: { error: Error }) {
  const message = error.message;
  const notMounted = /\(404\)|No such endpoint/i.test(message);
  const unauthorized = /\(401\)|unauthorized|bearer/i.test(message);

  return (
    <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">
      <div>{message}</div>
      {notMounted && (
        <div className="mt-1 text-xs text-muted">
          The webhook endpoints are not mounted on this server yet. This screen works against
          <code className="mx-1 font-mono">/api/v1/webhooks*</code>; nothing else on the portal is
          affected.
        </div>
      )}
      {!notMounted && unauthorized && (
        <div className="mt-1 text-xs text-muted">
          The webhook endpoints are part of the bearer-token public API. Your session is still
          valid — the portal simply has no access token for that surface.
        </div>
      )}
    </div>
  );
}
