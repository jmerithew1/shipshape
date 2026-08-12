<p align="center">
  <a href="https://github.com/US-Department-of-the-Treasury/ship">
    <img src="web/public/icons/blue/android-chrome-512x512.png" alt="Ship logo" width="120">
  </a>
</p>

<h1 align="center">Ship</h1>

<p align="center">
  <strong>Project management that helps teams learn and improve</strong>
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License"></a>
  <a href="https://github.com/US-Department-of-the-Treasury/ship/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome"></a>
  <img src="https://img.shields.io/badge/Section_508-Compliant-blue.svg" alt="Section 508 Compliant">
  <img src="https://img.shields.io/badge/WCAG_2.1-AA-blue.svg" alt="WCAG 2.1 AA">
</p>

---

## For graders — the Ship platform API

Ship exposes a versioned public API, an OAuth 2.0 authorization server, and a typed SDK.

| | |
| --- | --- |
| Deployed instance | `https://ship-api-r1om.onrender.com` |
| OpenAPI 3.1 spec (live, generated from the routes) | `/api/v1/openapi.json` |
| OpenAPI 3.1 spec (static copy) | [`docs/openapi.json`](docs/openapi.json) |
| Requirement → evidence ledger | [`docs/week6-requirements.md`](docs/week6-requirements.md) |
| Architecture + decisions | [`docs/defense-week6.md`](docs/defense-week6.md) · [`DECISIONS.md`](DECISIONS.md) |

### Grader credentials

A pre-registered OAuth app with **read-only** scopes (`documents:read`, `issues:read`,
`sprints:read` — it cannot modify anything) is seeded on the deployed instance by
`pnpm --filter @ship/api seed:grader-app`. That script prints the client secret exactly once and
rotates it on re-run, so the value published here is always the working one.

<!-- GRADER_CREDENTIALS_START -->
| | |
| --- | --- |
| `client_id` | `ship_app_e46d52564bc1f690` |
| `client_secret` | `ship_sec_bd48273402dbb7560d7a8f47d7cea4c95b0836743e108117ca9ef6adf88f9e80` |
| scopes | `documents:read` `issues:read` `sprints:read` (read-only) |
| redirect URIs | `http://localhost:8976/callback`, `http://127.0.0.1:8976/callback` |
| demo account for the approval step | `demo@ship.local` / `demo1234` |

**Device flow, end to end** (verified working against the deployed instance;
the `ship login` CLI will automate exactly these calls once it ships):

```bash
BASE=https://ship-api-r1om.onrender.com
CLIENT=ship_app_e46d52564bc1f690

# 1. ask for a device code
curl -s -X POST $BASE/oauth/device/code -H 'Content-Type: application/json'   -d "{\"client_id\":\"$CLIENT\",\"scope\":\"documents:read issues:read\"}"

# 2. approve the printed user_code while signed in as the demo account,
#    then exchange the device_code for a token
curl -s -X POST $BASE/oauth/token   -d grant_type=urn:ietf:params:oauth:grant-type:device_code   -d device_code=<device_code> -d client_id=$CLIENT

# 3. use it
curl -s $BASE/api/v1/me -H "Authorization: Bearer <access_token>"
```

Polling before approval returns `authorization_pending`; polling again inside
the interval returns `slow_down`. Requesting a scope the app was not granted
returns `403` naming the missing scope, e.g. `GET /api/v1/sprints` →
`{"code":"forbidden","message":"Insufficient scope: this request requires 'sprints:read'","details":{"missing_scope":"sprints:read"}}`.
<!-- GRADER_CREDENTIALS_END -->

### Try it against the deployed instance

The `@ship/sdk` package and the `ship` CLI are in the repo but **not yet
published or packaged** — the CLI lands with the reference-integration slice.
Until then this is the verified path, and it needs nothing but `curl`:

```bash
BASE=https://ship-api-r1om.onrender.com

# the public contract, no auth required
curl -s $BASE/api/v1/openapi.json | head

# authenticate with the grader app (device flow — see the credentials above)
curl -s -X POST $BASE/oauth/device/code -H 'Content-Type: application/json'   -d '{"client_id":"ship_app_e46d52564bc1f690","scope":"documents:read issues:read"}'

# approve the printed user_code as demo@ship.local, then exchange it
curl -s -X POST $BASE/oauth/token   -d grant_type=urn:ietf:params:oauth:grant-type:device_code   -d device_code=<device_code> -d client_id=ship_app_e46d52564bc1f690

# use the token
curl -s $BASE/api/v1/me -H "Authorization: Bearer <access_token>"
```

Every public failure returns the same envelope — `{code, message, details?, request_id}` — and
`request_id` matches the `X-Request-Id` header, so one id correlates a client-side error with the
server's audit trail.

---

## What is Ship?

Ship is a project management tool that combines documentation, issue tracking, and plan-driven weekly workflows in one place. Instead of switching between a wiki, a task tracker, and a spreadsheet, everything lives together.

**Built by the U.S. Department of the Treasury** for government teams, but useful for any organization that wants to work more effectively.

---

## How to Use Ship

Ship has four main views, each designed for different questions:

| View | What it answers |
|------|-----------------|
| **Docs** | "Where's that document?" — Wiki-style pages for team knowledge |
| **Issues** | "What needs to be done?" — Track tasks, bugs, and features |
| **Projects** | "What are we building?" — Group issues into deliverables |
| **Teams** | "Who's doing what?" — See workload across people and weeks |

### The Basics

1. **Create documents** for anything your team needs to remember — meeting notes, specs, onboarding guides
2. **Create issues** for work that needs to get done — assign them to people and track progress
3. **Group issues into projects** to organize related work
4. **Write weekly plans** to declare what you intend to accomplish each week

Everyone on the team can edit documents at the same time. You'll see other people's cursors as they type.

---

## The Ship Philosophy

### Everything is a Document

In Ship, there's no difference between a "wiki page" and an "issue" at the data level. They're all documents with different properties. This means:

- You can link any document to any other document
- Issues can have rich content, not just a title and description
- Projects and weeks are documents too — they can contain notes, decisions, and context

### Plans Are the Unit of Intent

Ship is plan-driven: each week starts with a written plan declaring what you intend to accomplish and ends with a retro capturing what you learned. Issues are a trailing indicator of what was done, not a leading indicator of what to do.

1. **Plan (Weekly Plan)** — Before the week, write down what you intend to accomplish and why
2. **Execute (The Week)** — Do the work; issues track what was actually done
3. **Reflect (Weekly Retro)** — After the week, write down what actually happened and what you learned

This isn't paperwork for paperwork's sake. Teams that skip retrospectives repeat the same mistakes. Teams that write things down learn and improve.

### Learning, Not Compliance

Documentation requirements in Ship are visible but not blocking. You can start a new week without finishing the last retro. But the system makes missing documentation obvious — it shows up as a visual indicator that escalates from yellow to red over time.

The goal isn't to check boxes. It's to capture what your team learned so you can get better.

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 20 or newer
- [pnpm](https://pnpm.io/) (`npm install -g pnpm`)
- [Docker](https://www.docker.com/) (for the database)

### Setup — one command from a clean checkout

```bash
git clone https://labs.gauntletai.com/jamesmerithew/shipshape.git
cd shipshape
./start.sh
```

`./start.sh` brings up the full composed system with Docker — PostgreSQL
(host port **5433**, to avoid a locally-installed PostgreSQL), the API on
:3000 (migrations and seed run automatically on startup), and the web app on
:5173 — and waits until the API health check passes. No manual environment
setup is required.

Variants:

```bash
./start.sh native   # postgres in Docker; api+web natively with hot reload (runs pnpm install for you)
./start.sh down     # stop everything
```

### Open the App

Once it's running, open your browser to:

**http://localhost:5173**

Log in with the demo account:
- **Email:** `dev@ship.local`
- **Password:** `admin123`

### What's Running

| Service | URL | Description |
|---------|-----|-------------|
| Web app | http://localhost:5173 | The Ship interface |
| API server | http://localhost:3000 | Backend services |
| Swagger UI | http://localhost:3000/api/docs | Interactive API documentation |
| OpenAPI spec | http://localhost:3000/api/openapi.json | OpenAPI 3.0 specification |
| PostgreSQL | localhost:5432 | Database (via Docker) |

### Common Commands

```bash
pnpm dev          # Start everything
pnpm dev:web      # Start just the web app
pnpm dev:api      # Start just the API
pnpm db:seed      # Reset database with sample data
pnpm db:migrate   # Run database migrations
pnpm test         # Run tests
```

---

## Technical Details

### Architecture

Ship is a monorepo with three packages:

- **web/** — React frontend with TipTap editor for real-time collaboration
- **api/** — Express backend with WebSocket support
- **shared/** — TypeScript types used by both

### Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React, Vite, TailwindCSS |
| Editor | TipTap + Yjs (real-time collaboration) |
| Backend | Express, Node.js |
| Database | PostgreSQL |
| Real-time | WebSocket |

### Design Decisions

- **Everything is a document** — Single `documents` table with a `document_type` field
- **Server is truth** — Offline-tolerant, syncs when reconnected
- **Boring technology** — Well-understood tools over cutting-edge experiments
- **E2E testing** — 73+ Playwright tests covering real user flows

See [docs/application-architecture.md](docs/application-architecture.md) for more.

### Repository Structure

```
ship/
├── api/                    # Express backend
│   ├── src/
│   │   ├── routes/         # REST endpoints
│   │   ├── collaboration/  # WebSocket + Yjs sync
│   │   └── db/             # Database queries
│   └── package.json
│
├── web/                    # React frontend
│   ├── src/
│   │   ├── components/     # UI components
│   │   ├── pages/          # Route pages
│   │   └── hooks/          # Custom hooks
│   └── package.json
│
├── shared/                 # Shared TypeScript types
├── e2e/                    # Playwright E2E tests
└── docs/                   # Architecture documentation
```

---

## Testing

```bash
# Run all E2E tests
pnpm test

# Run tests with UI
pnpm test:ui

# Run specific test file
pnpm test e2e/documents.spec.ts
```

Ship uses Playwright for end-to-end testing with 73+ tests covering all major functionality.

---

## Deployment

Ship supports multiple deployment patterns:

| Environment | Recommended Approach |
|-------------|---------------------|
| **Development** | Local with Docker Compose |
| **Staging** | AWS Elastic Beanstalk |
| **Production** | AWS GovCloud with Terraform |

### Docker

```bash
# Build production images
docker build -t ship-api ./api
docker build -t ship-web ./web

# Run with Docker Compose
docker-compose -f docker-compose.prod.yml up
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | Required |
| `SESSION_SECRET` | Cookie signing secret | Required |
| `PORT` | API server port | `3000` |

---

## Security

- **No external telemetry** — No Sentry, PostHog, or third-party analytics
- **No external CDN** — All assets served from your infrastructure
- **Session timeout** — 15-minute idle timeout (government standard)
- **Audit logging** — Track all document operations

> **Reporting Vulnerabilities:** See [SECURITY.md](./SECURITY.md) for our vulnerability disclosure policy.

---

## Accessibility

Ship targets Section 508 / WCAG 2.1 AA conformance. Current measured state
(2026-07-29, evidence in [`bench/cat7-a11y/out/`](bench/cat7-a11y/out/)):

- Zero Critical/Serious axe-core violations on the three primary pages
  (`/login`, `/docs`, `/my-week`), enforced by `e2e/axe-scan.spec.ts`
- Full keyboard navigation verified with real keystrokes
  (`e2e/keyboard-traversal.spec.ts`: reachability, no traps, Enter activation)
- Focus indicators visible on every traversed stop; focus-ring contrast 3.78:1
  (≥ the 3:1 WCAG 1.4.11 minimum)
- Screen-reader behaviour: manual NVDA protocol in
  [`docs/nvda-session-script.md`](docs/nvda-session-script.md); results recorded
  as executed — unverified areas are not claimed
- Remaining known gaps are tracked in `AUDIT_REPORT.md` Category 7 (moderate/minor
  findings and pages beyond the primary three)

---

## Contributing

We welcome contributions. See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

---

## Documentation

- [Application Architecture](./docs/application-architecture.md) — Tech stack and design decisions
- [Unified Document Model](./docs/unified-document-model.md) — Data model and sync architecture
- [Document Model Conventions](./docs/document-model-conventions.md) — Terminology and patterns
- [Week Documentation Philosophy](./docs/week-documentation-philosophy.md) — Why weekly plans and retros work the way they do
- [Accountability Philosophy](./docs/accountability-philosophy.md) — How Ship enforces accountability
- [Accountability Manager Guide](./docs/accountability-manager-guide.md) — Using approval workflows
- [Contributing Guidelines](./CONTRIBUTING.md) — How to contribute
- [Security Policy](./SECURITY.md) — Vulnerability reporting

---

## License

[MIT License](./LICENSE)
