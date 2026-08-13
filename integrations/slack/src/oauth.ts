/**
 * The Slack OAuth v2 install flow.
 *
 *   GET /slack/install          → 302 to slack.com/oauth/v2/authorize?...&state=...
 *   GET /slack/oauth/callback   → exchange `code` at oauth.v2.access, store the
 *                                 bot token, and from then on post as that app.
 *
 * WHY OAUTH AT ALL, WHEN A BOT TOKEN IN ENV ALSO WORKS
 * ----------------------------------------------------
 * A pasted `xoxb-` token means every workspace that wants this integration
 * needs an operator with server access. OAuth is what turns it into software
 * other people can install: an admin clicks Add to Slack, approves the scopes
 * Slack itself renders, and the token is minted for their workspace and
 * revocable by them. Same reason Ship makes third parties do the OAuth dance
 * instead of handing out API keys.
 *
 * STATE IS NOT DECORATION
 * -----------------------
 * `state` is the CSRF defence on the install flow. Without it, an attacker
 * sends an admin a crafted callback URL carrying the ATTACKER's `code`; the
 * integration exchanges it and stores a token for the attacker's workspace,
 * and thereafter posts this workspace's document titles into a Slack the
 * attacker controls. So: state is minted here, single-use, TTL-bounded, and a
 * callback whose state we did not mint is a 400 with no token exchange.
 *
 * STORAGE
 * -------
 * `MemoryInstallationStore` by default; `FileInstallationStore` when
 * `SLACK_INSTALL_STORE` names a path. Both are honest about what they are — a
 * bot token is a bearer credential for someone else's Slack, and production
 * belongs in a secrets manager (or at minimum a database column encrypted with
 * a KMS data key), not a JSON file mode 0600. The file store exists so the
 * flow is demonstrable across a restart, and it is what a reviewer should
 * expect to replace first.
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Router, type Request, type Response } from 'express';
import type { FetchLike } from './slack.js';

export const SLACK_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
export const SLACK_ACCESS_URL = 'https://slack.com/api/oauth.v2.access';

/** Scopes needed to post into a channel the app has been added to. */
export const DEFAULT_SCOPES = ['chat:write', 'chat:write.public'];

/** Default lifetime of a minted `state`, in ms. Short: it is a round trip. */
export const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000;

export interface Installation {
  team_id: string;
  team_name: string;
  bot_token: string;
  bot_user_id: string;
  installed_at: string;
}

export interface InstallationStore {
  save(installation: Installation): Promise<void>;
  get(teamId: string): Promise<Installation | undefined>;
  /** The most recently completed install — what a single-tenant deploy posts as. */
  latest(): Promise<Installation | undefined>;
}

export class MemoryInstallationStore implements InstallationStore {
  private readonly byTeam = new Map<string, Installation>();
  private mostRecent: Installation | undefined;

  async save(installation: Installation): Promise<void> {
    this.byTeam.set(installation.team_id, installation);
    this.mostRecent = installation;
  }

  async get(teamId: string): Promise<Installation | undefined> {
    return this.byTeam.get(teamId);
  }

  async latest(): Promise<Installation | undefined> {
    return this.mostRecent;
  }
}

/** JSON-file backed store. See the storage note in the module header. */
export class FileInstallationStore implements InstallationStore {
  constructor(private readonly path: string) {}

  private async readAll(): Promise<Installation[]> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as Installation[]) : [];
    } catch {
      return [];
    }
  }

  async save(installation: Installation): Promise<void> {
    const all = (await this.readAll()).filter((i) => i.team_id !== installation.team_id);
    all.push(installation);
    // mode 0600: a bot token is a bearer credential.
    await writeFile(this.path, JSON.stringify(all, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  async get(teamId: string): Promise<Installation | undefined> {
    return (await this.readAll()).find((i) => i.team_id === teamId);
  }

  async latest(): Promise<Installation | undefined> {
    const all = await this.readAll();
    return all[all.length - 1];
  }
}

/**
 * Single-use, TTL-bounded state values. Bounded in size for the same reason the
 * idempotency store is: an endpoint anyone can hit must not be a way to grow a
 * server's heap without limit.
 */
export class StateStore {
  private readonly issued = new Map<string, number>();

  constructor(
    private readonly ttlMs: number = DEFAULT_STATE_TTL_MS,
    private readonly now: () => number = () => Date.now(),
    private readonly maxEntries = 1000
  ) {}

  issue(value: string): string {
    this.prune();
    if (this.issued.size >= this.maxEntries) {
      const oldest = this.issued.keys().next();
      if (!oldest.done) this.issued.delete(oldest.value);
    }
    this.issued.set(value, this.now() + this.ttlMs);
    return value;
  }

  /** True exactly once per issued value, and only inside the TTL. */
  consume(value: string): boolean {
    const expiresAt = this.issued.get(value);
    if (expiresAt === undefined) return false;
    this.issued.delete(value);
    return expiresAt > this.now();
  }

  private prune(): void {
    const now = this.now();
    for (const [key, expiresAt] of this.issued) {
      if (expiresAt <= now) this.issued.delete(key);
    }
  }
}

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Must byte-match the redirect URL registered in the Slack app manifest. */
  redirectUri: string;
  scopes?: string[];
  /**
   * Shared secret gating who may START an install. Without it `/slack/install`
   * was open to the whole internet: anyone could install the app into their own
   * workspace and, via onInstalled, swap the process-wide bot token — hijacking
   * the deployment's poster. The operator hits
   * `/slack/install?key=<installSecret>`; a mismatch or absence is refused.
   * Found by the security review. Undefined disables the gate (dev only).
   */
  installSecret?: string;
  /**
   * The one Slack workspace this deployment is allowed to serve. Even a
   * completed OAuth exchange is refused unless team.id matches — so an install
   * that somehow reaches the callback for a DIFFERENT workspace cannot replace
   * the poster. Undefined disables the pin (dev/single-tenant convenience).
   */
  expectedTeamId?: string;
}

export interface OAuthRouterDeps {
  config: OAuthConfig;
  store: InstallationStore;
  stateStore?: StateStore;
  fetchImpl?: FetchLike;
  /** Injected so a test can assert on the exact `state` that was minted. */
  generateState?: () => string;
  logger?: (line: string) => void;
  authorizeUrl?: string;
  accessUrl?: string;
  /** Called after a successful install, e.g. to swap in the new bot token. */
  onInstalled?: (installation: Installation) => void;
}

export function buildAuthorizeUrl(
  config: OAuthConfig,
  state: string,
  authorizeUrl: string = SLACK_AUTHORIZE_URL
): string {
  const url = new URL(authorizeUrl);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('scope', (config.scopes ?? DEFAULT_SCOPES).join(','));
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

interface SlackAccessResponse {
  ok: boolean;
  error?: string;
  access_token?: string;
  bot_user_id?: string;
  team?: { id?: string; name?: string };
}

/**
 * Mounts `/slack/install` and `/slack/oauth/callback`.
 *
 * Status choices here answer to a BROWSER, not to Ship's retry ladder, so they
 * are ordinary web statuses: 400 for a bad/absent/expired state or a missing
 * code, 502 when Slack itself is unreachable or refuses the exchange.
 */
export function createOAuthRouter(deps: OAuthRouterDeps): Router {
  const router = Router();
  const stateStore = deps.stateStore ?? new StateStore();
  const generateState = deps.generateState ?? (() => randomBytes(32).toString('hex'));
  const log = deps.logger ?? ((line: string) => console.log(line));
  const authorizeUrl = deps.authorizeUrl ?? SLACK_AUTHORIZE_URL;
  const accessUrl = deps.accessUrl ?? SLACK_ACCESS_URL;
  const doFetch: FetchLike =
    deps.fetchImpl ?? ((input, init) => fetch(input, init) as unknown as ReturnType<FetchLike>);

  router.get('/slack/install', (req: Request, res: Response) => {
    // Operator gate. Compared in constant time so the secret cannot be
    // recovered by timing the response. Absent config secret = open (dev only),
    // and that case is logged so it is never silently relied on in production.
    const required = deps.config.installSecret;
    if (required !== undefined && required !== '') {
      const provided = typeof req.query['key'] === 'string' ? req.query['key'] : '';
      const a = Buffer.from(provided);
      const b = Buffer.from(required);
      const ok = a.length === b.length && timingSafeEqual(a, b);
      if (!ok) {
        log('[slack:oauth] refused /slack/install — missing or wrong operator key');
        res.status(403).type('text/plain').send('Not authorized to install this app.');
        return;
      }
    } else {
      log('[slack:oauth] WARNING: /slack/install is UNGATED (no installSecret configured)');
    }
    const state = stateStore.issue(generateState());
    res.redirect(302, buildAuthorizeUrl(deps.config, state, authorizeUrl));
  });

  router.get('/slack/oauth/callback', (req: Request, res: Response) => {
    void (async () => {
      const code = typeof req.query['code'] === 'string' ? req.query['code'] : '';
      const state = typeof req.query['state'] === 'string' ? req.query['state'] : '';

      // Slack reports a user who clicked Cancel as `error=access_denied`.
      if (typeof req.query['error'] === 'string' && req.query['error'].length > 0) {
        res.status(400).type('text/plain').send(`Slack install cancelled: ${req.query['error']}`);
        return;
      }

      // State FIRST. Consuming state before touching `code` means a forged
      // callback never reaches the token exchange at all.
      if (state === '' || !stateStore.consume(state)) {
        log('[slack:oauth] rejected callback with unknown or expired state');
        res.status(400).type('text/plain').send('Invalid or expired state. Restart at /slack/install.');
        return;
      }

      if (code === '') {
        res.status(400).type('text/plain').send('Missing ?code from Slack.');
        return;
      }

      let payload: SlackAccessResponse;
      try {
        // oauth.v2.access takes form encoding, not JSON. The client secret goes
        // in the body, never the query string — query strings land in access
        // logs and browser history.
        const body = new URLSearchParams({
          client_id: deps.config.clientId,
          client_secret: deps.config.clientSecret,
          code,
          redirect_uri: deps.config.redirectUri,
        }).toString();

        const response = await doFetch(accessUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        });
        payload = JSON.parse(await response.text()) as SlackAccessResponse;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        log(`[slack:oauth] token exchange failed: ${detail}`);
        res.status(502).type('text/plain').send('Could not reach Slack to complete the install.');
        return;
      }

      if (!payload.ok || !payload.access_token) {
        log(`[slack:oauth] token exchange refused: ${payload.error ?? 'unknown_error'}`);
        res
          .status(502)
          .type('text/plain')
          .send(`Slack refused the install: ${payload.error ?? 'unknown_error'}`);
        return;
      }

      const teamId = payload.team?.id ?? randomUUID();

      // Workspace pin. Even a fully valid OAuth exchange is refused if it is for
      // a workspace this deployment was not configured to serve — so a
      // completed install for a stranger's workspace can never reach save() or
      // onInstalled() and cannot swap the poster's bot token.
      if (deps.config.expectedTeamId !== undefined && teamId !== deps.config.expectedTeamId) {
        log(`[slack:oauth] refused install for unexpected workspace ${teamId}`);
        res.status(403).type('text/plain').send('This app is not configured for that Slack workspace.');
        return;
      }

      const installation: Installation = {
        team_id: teamId,
        team_name: payload.team?.name ?? 'unknown workspace',
        bot_token: payload.access_token,
        bot_user_id: payload.bot_user_id ?? '',
        installed_at: new Date().toISOString(),
      };

      await deps.store.save(installation);
      deps.onInstalled?.(installation);
      // Never log the token itself — this line exists to prove an install
      // happened, not to leak the credential into a log aggregator.
      log(`[slack:oauth] installed into ${installation.team_name} (${installation.team_id})`);

      res
        .status(200)
        .type('text/plain')
        .send(`Ship is installed in ${installation.team_name}. You can close this tab.`);
    })();
  });

  return router;
}
