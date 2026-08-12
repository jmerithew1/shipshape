import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import { csrfSync } from 'csrf-sync';
import rateLimit from 'express-rate-limit';
import authRoutes from './routes/auth.js';
import documentsRoutes from './routes/documents.js';
import issuesRoutes from './routes/issues.js';
import feedbackRoutes, { publicFeedbackRouter } from './routes/feedback.js';
import programsRoutes from './routes/programs.js';
import projectsRoutes from './routes/projects.js';
import weeksRoutes from './routes/weeks.js';
import standupsRoutes from './routes/standups.js';
import iterationsRoutes from './routes/iterations.js';
import teamRoutes from './routes/team.js';
import workspacesRoutes from './routes/workspaces.js';
import adminRoutes from './routes/admin.js';
import invitesRoutes from './routes/invites.js';
import setupRoutes from './routes/setup.js';
import backlinksRoutes from './routes/backlinks.js';
import { searchRouter } from './routes/search.js';
import { filesRouter } from './routes/files.js';
import caiaAuthRoutes from './routes/caia-auth.js';
import apiTokensRoutes from './routes/api-tokens.js';
import adminCredentialsRoutes from './routes/admin-credentials.js';
import claudeRoutes from './routes/claude.js';
import activityRoutes from './routes/activity.js';
import dashboardRoutes from './routes/dashboard.js';
import associationsRoutes from './routes/associations.js';
import accountabilityRoutes from './routes/accountability.js';
import agentRoutes from './routes/agent.js';
import aiRoutes from './routes/ai.js';
import weeklyPlansRoutes, { weeklyRetrosRouter } from './routes/weekly-plans.js';
import { documentCommentsRouter, commentsRouter } from './routes/comments.js';
import { setupSwagger } from './swagger.js';
import { initializeCAIA } from './services/caia.js';
import { createV1Router } from './platform/api/v1/router.js';
import { registerV1Routes } from './platform/api/v1/resources/routes.js';
import oauthAppsRoutes from './routes/oauth-apps.js';
import { createOAuthRouter } from './platform/oauth/routes.js';
import { auditTrail } from './platform/audit/middleware.js';
import { createAuditRouter } from './platform/audit/routes.js';
import { authMiddleware } from './middleware/auth.js';

// Validate SESSION_SECRET in production
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET environment variable is required in production');
}

const sessionSecret = process.env.SESSION_SECRET || 'dev-only-secret-do-not-use-in-production';

// CSRF protection setup
const { csrfSynchronisedProtection, generateToken } = csrfSync({
  getTokenFromRequest: (req) => req.headers['x-csrf-token'] as string,
});

// Conditional CSRF middleware - skip for API token auth (Bearer tokens are not vulnerable to CSRF)
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import path, { join } from 'node:path';
import { existsSync } from 'node:fs';
const conditionalCsrf = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers?.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    // Skip CSRF for API token requests - Bearer tokens are not auto-attached by browsers
    return next();
  }
  // Apply CSRF protection for session-based auth
  return csrfSynchronisedProtection(req, res, next);
};

// Rate limiting configurations
// In test/dev environment, use much higher limits to avoid issues
// Production limits: login=5/15min (failed only), api=100/min
const isTestEnv = process.env.NODE_ENV === 'test' || process.env.E2E_TEST === '1';
const isDevEnv = process.env.NODE_ENV !== 'production';

// Strict rate limit for login (5 failed attempts / 15 min) - brute force protection
// skipSuccessfulRequests: true means only failed attempts count toward the limit
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isTestEnv ? 1000 : 5, // High limit for tests
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  skipSuccessfulRequests: true, // Only count failed login attempts
});

// General API rate limit (100 req/min in prod, 1000 in dev)
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: isTestEnv ? 10000 : isDevEnv ? 1000 : 100, // High limit for tests/dev
  standardHeaders: true,
  // legacyHeaders emits the X-RateLimit-* family. The Week-6 brief names those
  // headers verbatim ("Public responses carry X-RateLimit-Limit,
  // X-RateLimit-Remaining, X-RateLimit-Reset"), and express-rate-limit v8's
  // `standardHeaders: true` alone emits only the draft-6 `RateLimit-*` names —
  // so the required headers were absent in production and the SDK's
  // rate-limit reader was permanently null. Both families are now sent.
  legacyHeaders: true,
  message: { error: 'Too many requests. Please slow down.' },
  // The limiter is mounted on '/api/' — ABOVE the /api/v1 router — and
  // express-rate-limit writes its `message` straight to the response instead
  // of calling next(). Without this branch a 429 on a public route shipped
  // `{error}` while the generated OpenAPI spec promised the ApiError envelope
  // with code `rate_limited`: the published contract lied, and the shape was
  // unreachable by the fitness test because the test environment raises `max`
  // to 10000 so a 429 can never be provoked. Found by the contract audit.
  handler: (req, res, _next, options) => {
    if (!req.path.startsWith('/v1')) {
      res.status(options.statusCode).json(options.message);
      return;
    }
    const requestId = randomUUID();
    const retryAfterSeconds = Math.ceil(options.windowMs / 1000);
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).json({
      code: 'rate_limited',
      message: 'Rate limit exceeded',
      details: { retry_after_seconds: retryAfterSeconds },
      request_id: requestId,
    });
  },
});


export function createApp(corsOrigin: string = 'http://localhost:5173'): express.Express {
  const app = express();

  // Trust proxy headers (CloudFront) for secure cookies and correct protocol detection
  if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);

    // CloudFront with viewer_protocol_policy="redirect-to-https" always serves viewers over HTTPS.
    // However, CloudFront -> EB uses HTTP (origin_protocol_policy="http-only"), so CloudFront
    // sets X-Forwarded-Proto to "http". Override it to "https" when request comes via CloudFront.
    app.use((req, _res, next) => {
      // CloudFront adds Via header like "2.0 <id>.cloudfront.net (CloudFront)"
      const viaHeader = req.headers['via'] as string;
      if (viaHeader && viaHeader.includes('cloudfront')) {
        req.headers['x-forwarded-proto'] = 'https';
      }
      next();
    });
  }

  // Middleware - Security headers
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },  // Allow images to be loaded cross-origin
    // Content Security Policy - prevents XSS attacks
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"], // Admin credentials page uses inline scripts
        styleSrc: ["'self'", "'unsafe-inline'"], // TipTap editor needs inline styles
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        connectSrc: ["'self'", "wss:", "ws:"], // WebSocket connections
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        frameSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      }
    },
    // HTTP Strict Transport Security
    hsts: {
      maxAge: 31536000, // 1 year in seconds
      includeSubDomains: true,
      preload: true,
    },
  }));

  // Apply rate limiting to all API routes
  app.use('/api/', apiLimiter);
  app.use(cors({
    origin: corsOrigin,
    credentials: true,
  }));
  app.use(express.json({ limit: '10mb' }));  // Large wiki documents can be several MB
  app.use(express.urlencoded({ extended: true, limit: '10mb' })); // For HTML form submissions

  // Body-parser failures (malformed JSON, oversized payload) are raised by
  // middleware mounted ABOVE the /api/v1 router, so the public error handler
  // inside that router never sees them — Express's default handler would ship
  // an HTML error page, breaking the contract that EVERY public failure
  // returns the ApiError envelope. Caught here, while the request is still
  // identifiable by path. Found by the contract audit, not by a unit test.
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    const parseFailure =
      err instanceof SyntaxError ||
      (typeof err === 'object' && err !== null && 'type' in err &&
        ['entity.parse.failed', 'entity.too.large'].includes(String((err as { type: unknown }).type)));

    if (!parseFailure) return next(err);
    if (!req.path.startsWith('/api/v1')) return next(err);

    const tooLarge =
      typeof err === 'object' && err !== null && 'type' in err &&
      String((err as { type: unknown }).type) === 'entity.too.large';
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    res.status(tooLarge ? 413 : 400).json({
      code: 'validation_failed',
      message: tooLarge ? 'Request body is too large' : 'Request body is not valid JSON',
      request_id: requestId,
    });
  });

  app.use(cookieParser(sessionSecret));

  // Session middleware for CSRF token storage
  app.use(session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 15 * 60 * 1000, // 15 minutes
    },
  }));

  // CSRF token endpoint (must be before CSRF protection middleware)
  app.get('/api/csrf-token', (req, res) => {
    res.json({ token: generateToken(req) });
  });

  // Health check (no CSRF needed)
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Readiness check (Week 5 Terraform requirement): proves the service can
  // actually serve — DB reachable AND the FleetGraph agent tables exist.
  // The agent-tables assertion exists so a silently-skipped migration can
  // never hide again (cold-critic finding, DECISIONS.md 2026-08-03).
  app.get('/ready', async (_req, res) => {
    try {
      const { pool } = await import('./db/client.js');
      await pool.query(`SELECT 1 FROM agent_findings LIMIT 0`);
      await pool.query(`SELECT 1 FROM agent_runs LIMIT 0`);
      await pool.query(`SELECT 1 FROM agent_credibility LIMIT 0`);
      // Week 6 platform tables (migration 039) — same silent-migration guard.
      await pool.query(`SELECT 1 FROM oauth_apps LIMIT 0`);
      await pool.query(`SELECT 1 FROM oauth_authorization_codes LIMIT 0`);
      await pool.query(`SELECT 1 FROM oauth_device_codes LIMIT 0`);
      await pool.query(`SELECT 1 FROM oauth_refresh_tokens LIMIT 0`);
      res.json({ status: 'ready', agent_tables: true, platform_tables: true });
    } catch (err) {
      res.status(503).json({
        status: 'not_ready',
        reason: err instanceof Error ? err.message : 'unknown',
      });
    }
  });

  // API documentation (no auth needed)
  setupSwagger(app);

  // OAuth 2.0 authorization server (Week 6).
  //
  // CSRF is applied SELECTIVELY here, and the split matters:
  //   - /oauth/token and /oauth/device/code are called by CLIs, servers and
  //     SDKs that hold no session and no CSRF token. Requiring one would make
  //     the grants unusable by every standard OAuth client.
  //   - /oauth/authorize/decision and /oauth/device/verify are submitted by a
  //     logged-in human's browser. A forged POST there is a SILENT CONSENT
  //     GRANT, so these keep full CSRF protection.
  //
  // The match MUST normalize exactly the way Express's router does. Express
  // Routers default to `strict: false, caseSensitive: false`, so
  // `/device/verify/` and `/device/VERIFY` both reach the handler. An exact
  // string comparison therefore skipped CSRF while the route still ran —
  // a forged POST to /oauth/device/verify/ would approve an attacker's device
  // flow as the victim. Only SameSite=Strict cookies were preventing it, which
  // is not the control this comment claimed. Found by the security audit.
  const humanConsentPaths = new Set(['/authorize/decision', '/device/verify']);
  const oauthCsrf = (req: Request, res: Response, next: NextFunction) => {
    const normalized = req.path.replace(/\/+$/, '').toLowerCase();
    if (req.method === 'POST' && humanConsentPaths.has(normalized)) {
      return conditionalCsrf(req, res, next);
    }
    return next();
  };
  app.use('/oauth', oauthCsrf, createOAuthRouter({ auth: authMiddleware }));

  // Public platform API (Week 6). Bearer-token-only surface: no CSRF wrapper
  // (no cookie auth is accepted here), no shared middleware with the internal
  // /api routes below — the public/internal boundary is structural. Mounted
  // before the internal routes so nothing can shadow the /api/v1 prefix.
  app.use(
    '/api/v1',
    createV1Router((router) => {
      // Records every public call on response finish. Mounted here rather than
      // per-route so a route added tomorrow is audited by default.
      router.use(auditTrail());
      registerV1Routes(router);
    })
  );

  // Setup routes (CSRF protected - first-time setup only)
  app.use('/api/setup', conditionalCsrf, setupRoutes);

  // Public feedback routes - no auth or CSRF required (must be before protected routes)
  app.use('/api/feedback', publicFeedbackRouter);

  // Apply stricter rate limiting to login endpoint (brute force protection)
  app.use('/api/auth/login', loginLimiter);

  // Apply CSRF protection to all state-changing API routes
  app.use('/api/auth', conditionalCsrf, authRoutes);
  app.use('/api/documents', conditionalCsrf, documentsRoutes);
  app.use('/api/documents', conditionalCsrf, backlinksRoutes);
  app.use('/api/documents', conditionalCsrf, associationsRoutes);
  app.use('/api/issues', conditionalCsrf, issuesRoutes);
  app.use('/api/feedback', conditionalCsrf, feedbackRoutes);
  app.use('/api/programs', conditionalCsrf, programsRoutes);
  app.use('/api/projects', conditionalCsrf, projectsRoutes);
  app.use('/api/weeks', conditionalCsrf, weeksRoutes);
  app.use('/api/weeks', conditionalCsrf, iterationsRoutes);
  app.use('/api/standups', conditionalCsrf, standupsRoutes);
  app.use('/api/team', conditionalCsrf, teamRoutes);
  app.use('/api/workspaces', conditionalCsrf, workspacesRoutes);
  app.use('/api/admin', conditionalCsrf, adminRoutes);
  app.use('/api/invites', conditionalCsrf, invitesRoutes);
  app.use('/api/api-tokens', conditionalCsrf, apiTokensRoutes);

  // OAuth app management for the developer portal (Week 6). Session-authed
  // by design: registering your first app is the bootstrap step, so it cannot
  // itself require an OAuth token (see the file header for the full rationale).
  app.use('/api/oauth-apps', conditionalCsrf, oauthAppsRoutes);

  // Developer-portal read surfaces (session-authed, like app registration).
  app.use('/api/devportal', conditionalCsrf, createAuditRouter({ auth: authMiddleware }));

  // Claude context routes - read-only GET endpoints for Claude skills
  app.use('/api/claude', claudeRoutes);

  // Search routes are read-only GET endpoints - no CSRF needed
  app.use('/api/search', searchRouter);

  // Activity routes are read-only GET endpoints - no CSRF needed
  app.use('/api/activity', activityRoutes);

  // Dashboard routes are read-only GET endpoints - no CSRF needed
  app.use('/api/dashboard', dashboardRoutes);

  // Accountability routes - inference-based action items (read-only GET)
  app.use('/api/accountability', accountabilityRoutes);

  // FleetGraph agent findings + dispositions (Week 5)
  app.use('/api/agent', conditionalCsrf, agentRoutes);

  // AI analysis routes - plan and retro quality feedback (CSRF protected)
  app.use('/api/ai', conditionalCsrf, aiRoutes);

  // Weekly plans routes - per-person accountability documents (CSRF protected)
  app.use('/api/weekly-plans', conditionalCsrf, weeklyPlansRoutes);

  // Weekly retros routes - per-person accountability documents (CSRF protected)
  app.use('/api/weekly-retros', conditionalCsrf, weeklyRetrosRouter);

  // CAIA auth routes - no CSRF protection (OAuth flow with external callback)
  // This is the single identity provider for PIV authentication
  // Mount at both /caia and /piv paths - /piv/callback is registered with CAIA
  app.use('/api/auth/caia', caiaAuthRoutes);
  app.use('/api/auth/piv', caiaAuthRoutes);

  // Admin credentials management (CSRF protected, super-admin only)
  app.use('/api/admin/credentials', conditionalCsrf, adminCredentialsRoutes);

  // File upload routes (CSRF protected for POST endpoints)
  app.use('/api/files', conditionalCsrf, filesRouter);

  // Comments routes
  app.use('/api/documents', conditionalCsrf, documentCommentsRouter);
  app.use('/api/comments', conditionalCsrf, commentsRouter);

  // Initialize CAIA OAuth client at startup
  initializeCAIA().catch((err) => {
    console.warn('CAIA initialization failed:', err);
  });

  // Serve the built frontend from the API when SERVE_WEB is set.
  //
  // Locally, Vite dev serves the SPA on :5173 and proxies /api to :3000, so this
  // stays off. In a single-service deployment there is no Vite, so the API serves
  // web/dist itself. That works because web's build runs `VITE_API_URL=` (empty),
  // which makes the client issue *relative* API calls — same origin, no CORS, and
  // no need to know the deployed hostname at build time.
  //
  // Mounted last on purpose: every /api route above is already registered, so the
  // SPA fallback below cannot shadow an API endpoint. Unmatched /api/* returns a
  // JSON 404 rather than index.html, so a missing endpoint fails loudly instead of
  // handing the client HTML it will try to parse as JSON.
  if (process.env.SERVE_WEB === 'true') {
    const webDist = process.env.WEB_DIST_PATH
      ? path.resolve(process.env.WEB_DIST_PATH)
      : path.resolve(process.cwd(), '../web/dist');

    if (existsSync(join(webDist, 'index.html'))) {
      app.use(express.static(webDist, { index: false, maxAge: '1h' }));

      app.get(/^\/(?!api\/).*/, (_req: Request, res: Response) => {
        res.sendFile(join(webDist, 'index.html'));
      });

      app.use('/api', (_req: Request, res: Response) => {
        res.status(404).json({ error: 'Not found' });
      });

      console.log(`Serving frontend from ${webDist}`);
    } else {
      console.warn(`SERVE_WEB=true but no index.html at ${webDist} — API only`);
    }
  }

  return app;
}
