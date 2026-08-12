# @ship/browser-demo

Authorization Code + PKCE in a single-page app that lists the signed-in user's
documents through `@ship/sdk`.

It is deliberately three files — `index.html`, `src/main.ts`, and this README.
What it has to demonstrate is narrow: a **public client** (one that cannot keep a
secret, because everything it ships is readable) can authenticate a human, hold
the resulting token, and call the API, with the PKCE code verifier standing in
for the client secret.

Like every package under `integrations/`, it imports **`@ship/sdk` and nothing
else** — no `api/src`, no `@ship/shared`. That boundary is enforced by ESLint
(`no-restricted-imports`), not by good intentions.

---

## Run it

```bash
# from the repo root — the SDK must be built, the demo imports its dist output
pnpm install
pnpm --filter @ship/sdk build

# terminal 1: the Ship API
pnpm --filter @ship/api dev          # http://localhost:3000

# terminal 2: this demo
pnpm --filter @ship/browser-demo dev # http://localhost:5173
```

Then open <http://localhost:5173>, paste your OAuth app's `client_id`, and press
**Connect to Ship**.

Other commands:

```bash
pnpm --filter @ship/browser-demo type-check   # tsc --noEmit
pnpm --filter @ship/browser-demo build        # vite build → dist/
pnpm --filter @ship/browser-demo preview      # serve the built bundle
```

## The redirect URI you must register

```
http://localhost:5173/
```

**Exactly that string, trailing slash included.** The server compares
`redirect_uri` against the registered list with an exact string match and
refuses to redirect to anything else — that check is what stops the endpoint
from becoming an open redirect, so it does not normalise, prefix-match, or
forgive a missing slash (`api/src/platform/oauth/routes.ts`,
`validateAuthorizeRequest`).

The page shows the value it will actually send in the read-only **Redirect URI**
field; copy it from there rather than typing it, and it cannot drift. If you run
Vite on another port, register that origin instead.

Register the app with the requested scopes the demo asks for — `documents:read`
is enough to list documents, and `/api/v1/me` needs the same scope. There is a
seed script for a first-party app (`pnpm --filter @ship/api seed:grader-app`);
for a third-party public client, create one through the developer portal or with
`registerApp()` and **do not** set a client secret expectation — the demo sends
none, by design.

## Configuration

Three values, all editable in the page and remembered in `localStorage`:

| Field | Default | Also settable via query string |
| --- | --- | --- |
| Ship API origin | `http://localhost:3000` | `?api=` |
| `client_id` | *(empty)* | `?client_id=` |
| scopes | `documents:read` | `?scope=` |

The API already allows CORS from `http://localhost:5173` with credentials
(`createApp(corsOrigin = 'http://localhost:5173')`), so no proxy is needed for a
local run.

## About the consent screen

Ship's `GET /oauth/authorize` returns consent **context as JSON** — app name and
a human description of each requested scope — rather than an HTML page. That
split is deliberate: rendering the consent screen is the first-party web app's
job, and keeping it out of the authorization server is what makes the whole
consent flow testable without a browser. See the header comment in
`api/src/platform/oauth/routes.ts`.

The consequence for this demo is worth stating plainly: pressing **Connect to
Ship** sends you to `/oauth/authorize`, and in a deployment with a consent screen
mounted there you approve and get redirected straight back. Running only the API
locally, you will see the JSON context instead. For that case the page has a
second entry point — **Finish a redirect by hand**: approve the grant wherever
you can (the Playwright flow in `e2e/oauth-pkce.spec.ts` shows the two calls),
then paste the resulting redirect URL into the field. It runs through the exact
same handler as a real redirect, so the pasted path cannot drift from the live
one.

## What to look at in the code

Everything is in `src/main.ts`:

- **PKCE, generated here.** `crypto.getRandomValues` for 32 random bytes →
  43 base64url characters of verifier; `crypto.subtle.digest('SHA-256', …)` for
  the challenge; base64url with the padding stripped, because RFC 7636 §4.2
  defines the encoding without it and the server's character-class check rejects
  `=`. `crypto.subtle` requires a secure context — `localhost` counts, a LAN IP
  does not.
- **Why the token exchange is a plain `fetch` and not
  `ShipClient.authorizationCodeFlow()`.** That helper awaits a `waitForRedirect`
  callback, which suits a CLI with a loopback listener. A full-page redirect
  destroys this page, so the verifier is parked in `sessionStorage` and picked
  up by a fresh page load. Everything after the token goes through `ShipClient`.
- **Token storage.** `LocalStorageTokenStore` from the SDK. Honest caveat, also
  in the source: `localStorage` is readable by any script running on this
  origin. For a high-value app the right answer is a same-origin backend holding
  an httpOnly cookie; for a demo whose subject is the grant, this is the right
  size, and saying so beats pretending otherwise.
- **The error path.** A failed exchange renders `ShipError.kind` (the SDK's
  closed union — the thing you branch on), the `code`, the status, and the
  `request_id`. `request_id` is blank for `/oauth/token` failures and that is not
  a bug: RFC 6749 §5.2 pins that body to `{error, error_description}`, so the id
  travels only in the `X-Request-Id` header, which a cross-origin page cannot
  read unless the server exposes it. Errors from `/api/v1` (e.g. an expired
  token on `documents.list()`) carry `request_id` in the body and do render it.

## Trying the failure path

Register the app, then change one character of the `client_id` in the page
before pressing Connect: the exchange comes back `kind: auth`,
`code: invalid_client`. Tampering with the stored verifier in
`sessionStorage` before finishing a redirect yields `code: invalid_grant` —
"PKCE verification failed" — which is the whole point of the exercise.
