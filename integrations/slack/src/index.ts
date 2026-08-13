/**
 * Entry point. Reads config from the environment, wires the pieces, listens.
 *
 * Everything meaningful is in server.ts / slack.ts / oauth.ts and takes its
 * dependencies as arguments; this file is the only place that touches
 * `process.env`, which is why the whole suite runs without a single env var set.
 */

import {
  createSlackPoster,
  type SlackPoster,
  type SlackMessage,
} from './slack.js';
import { createApp } from './server.js';
import {
  FileInstallationStore,
  MemoryInstallationStore,
  type Installation,
  type InstallationStore,
  type OAuthRouterDeps,
} from './oauth.js';
import { WEBHOOK_PATH } from './server.js';

const env = process.env;

function required(name: string): string {
  const value = env[name];
  if (!value || value.trim() === '') {
    console.error(
      `Missing ${name}. It is the subscription's signing secret, printed exactly once by\n` +
        `  ship webhooks create --event document.created --url <your-url>${WEBHOOK_PATH}`
    );
    process.exit(1);
  }
  return value;
}

/**
 * A poster whose token can be swapped at runtime by a completed OAuth install.
 * Before an install (and with no `SLACK_BOT_TOKEN`) this is the dry-run poster,
 * so the receiver is useful from the first second rather than after a setup step.
 */
function createSwappablePoster(initial: SlackPoster): SlackPoster & {
  swap(next: SlackPoster): void;
} {
  let current = initial;
  return {
    get dryRun(): boolean {
      return current.dryRun;
    },
    get channel(): string {
      return current.channel;
    },
    post(message: SlackMessage): Promise<void> {
      return current.post(message);
    },
    swap(next: SlackPoster): void {
      current = next;
    },
  };
}

function main(): void {
  const secret = required('SHIP_WEBHOOK_SECRET');
  const channel = env['SLACK_CHANNEL_ID'] ?? '';
  const port = Number(env['PORT'] ?? 3210);

  const poster = createSwappablePoster(
    createSlackPoster({ token: env['SLACK_BOT_TOKEN'], channel })
  );

  let oauth: OAuthRouterDeps | undefined;
  const clientId = env['SLACK_CLIENT_ID'];
  const clientSecret = env['SLACK_CLIENT_SECRET'];
  const redirectUri = env['SLACK_REDIRECT_URI'];

  if (clientId && clientSecret && redirectUri) {
    const storePath = env['SLACK_INSTALL_STORE'];
    const store: InstallationStore = storePath
      ? new FileInstallationStore(storePath)
      : new MemoryInstallationStore();

    const installSecret = env['SLACK_INSTALL_SECRET'];
    const expectedTeamId = env['SLACK_TEAM_ID'];
    if (!installSecret) {
      console.warn(
        '[ship] WARNING: SLACK_INSTALL_SECRET is unset — /slack/install is open to anyone. Set it in production.'
      );
    }

    oauth = {
      config: {
        clientId,
        clientSecret,
        redirectUri,
        ...(installSecret ? { installSecret } : {}),
        ...(expectedTeamId ? { expectedTeamId } : {}),
      },
      store,
      onInstalled: (installation: Installation) => {
        poster.swap(createSlackPoster({ token: installation.bot_token, channel }));
      },
    };
  }

  const { app } = createApp({
    secret,
    poster,
    ...(oauth ? { oauth } : {}),
  });

  app.listen(port, () => {
    console.log(`[ship] Slack integration listening on :${port}${WEBHOOK_PATH}`);
    if (poster.dryRun) {
      console.log(
        '[ship] DRY RUN — set SLACK_BOT_TOKEN and SLACK_CHANNEL_ID (or complete /slack/install) to post for real.'
      );
    }
    if (oauth) console.log('[ship] OAuth install flow at /slack/install');
  });
}

main();
