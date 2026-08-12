#!/usr/bin/env node
/**
 * `ship` — the Ship CLI.
 *
 * This file is wiring and nothing else: argument parsing, one process-wide
 * error handler, one line writer. Every command's behaviour lives in a
 * function that takes its dependencies as arguments (src/commands/*, src/tail.ts)
 * so the behaviour is testable and this file has nothing in it worth testing.
 *
 * The only thing this binary knows about Ship is `@ship/sdk`. There is no
 * import of `api/src` anywhere under integrations/, and an ESLint rule
 * (`no-restricted-imports`, eslint.config.mjs) fails the build if one appears.
 * That is what makes "the CLI is a platform citizen" a checked property rather
 * than a claim in a README.
 */
import { Command, Option } from 'commander';
import { authenticatedClient, type GlobalOptions } from './client.js';
import { docsCreate, docsGet, docsList } from './commands/docs.js';
import { loginCommand } from './commands/login.js';
import { webhooksCreate, webhooksList, webhooksTail } from './commands/webhooks.js';
import { DEFAULT_TAIL_INTERVAL_MS, ENV } from './config.js';
import { EXIT, reportError } from './errors.js';

const write = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
const writeErr = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/**
 * Every command body funnels through here. A ShipError becomes a readable
 * message and a kind-specific exit code; nothing ever reaches Node's default
 * handler, so a user never sees a stack trace for a expired token.
 */
async function run(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    process.exitCode = reportError(error, writeErr);
  }
}

/** Reads a numeric option, rejecting garbage at parse time rather than in a request. */
function toInt(name: string): (value: string) => number {
  return (value: string): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`--${name} must be a positive number, got "${value}"`);
    }
    return Math.floor(parsed);
  };
}

const program = new Command();

program
  .name('ship')
  .description('The Ship CLI — talks to Ship exclusively through @ship/sdk.')
  .version('0.1.0')
  .addOption(
    new Option('--base-url <url>', 'Ship API origin').env(ENV.baseUrl)
  )
  .addOption(new Option('--client-id <id>', 'OAuth client id').env(ENV.clientId))
  .addOption(
    new Option('--token <token>', 'Bearer token; skips the stored session').env(ENV.token)
  );

const globals = (): GlobalOptions => program.opts<GlobalOptions>();

// ── login ───────────────────────────────────────────────────────────────────

program
  .command('login')
  .description('Authenticate with the OAuth device grant and store the tokens (0600).')
  .option('--scope <scope>', 'Space-separated scopes to request')
  .action(async (options: { scope?: string }) => {
    await run(async () => {
      await loginCommand({ ...globals(), scope: options.scope }, { write });
    });
  });

// ── docs ────────────────────────────────────────────────────────────────────

const docs = program.command('docs').description('Documents.');

docs
  .command('ls')
  .description('List documents. Pagination is handled for you — no cursors.')
  .option('-n, --limit <n>', 'Stop after N documents', toInt('limit'))
  .option('--type <type>', 'Filter by document type (wiki, issue, sprint)')
  .option('--state <state>', 'Filter by state')
  .action(async (options: { limit?: number; type?: string; state?: string }) => {
    await run(async () => {
      const client = await authenticatedClient(globals());
      await docsList(client, options, { write });
    });
  });

docs
  .command('get <id>')
  .description('Show one document.')
  .action(async (id: string) => {
    await run(async () => {
      const client = await authenticatedClient(globals());
      await docsGet(client, id, { write });
    });
  });

docs
  .command('create')
  .description('Create a document. Prints the new id on its own line.')
  .requiredOption('--title <title>', 'Document title')
  .option('--type <type>', 'Document type (wiki, issue, sprint)', 'wiki')
  .option('--content <text>', 'Plain-text body')
  .action(async (options: { title: string; type?: string; content?: string }) => {
    await run(async () => {
      const client = await authenticatedClient(globals());
      await docsCreate(client, options, { write });
    });
  });

// ── webhooks ────────────────────────────────────────────────────────────────

const webhooks = program.command('webhooks').description('Webhook subscriptions and deliveries.');

webhooks
  .command('ls')
  .description('List webhook subscriptions.')
  .action(async () => {
    await run(async () => {
      const client = await authenticatedClient(globals());
      await webhooksList(client, { write });
    });
  });

webhooks
  .command('create')
  .description('Subscribe to an event. Prints the signing secret — the only time it is returned.')
  .requiredOption('--event <event>', 'Event type, e.g. document.created')
  .requiredOption('--url <url>', 'Target URL for deliveries')
  .action(async (options: { event: string; url: string }) => {
    await run(async () => {
      const client = await authenticatedClient(globals());
      await webhooksCreate(client, options, { write });
    });
  });

webhooks
  .command('tail')
  .description('Stream webhook deliveries and verify each signature locally.')
  .addHelpText(
    'after',
    `
How this works, and why it is a poll:

  Your laptop has no public address, so this command cannot receive real
  inbound webhook POSTs. It follows the Stripe CLI's model instead: it reads
  the delivery log through the API and verifies each delivery's Ship-Signature
  LOCALLY, using the subscription's signing secret.

  The secret never leaves this machine and is never sent to the server. The
  server is only ever asked "what did you send?" — never "was this signature
  good?". A verdict you compute yourself is the only verdict worth printing.

  The secret comes from --secret or ${ENV.webhookSecret}. It is shown exactly
  once, by \`ship webhooks create\`.

Example:
  ship webhooks create --event document.created --url https://example.com/hook
  ship webhooks tail --webhook <id> --secret <secret>
`
  )
  .option('--webhook <id>', 'Only deliveries for this subscription')
  .option('--secret <secret>', `Signing secret (or set ${ENV.webhookSecret})`)
  .option(
    '--interval <ms>',
    `Poll interval in ms (default ${DEFAULT_TAIL_INTERVAL_MS})`,
    toInt('interval')
  )
  .option('--tolerance <seconds>', 'Signature replay window in seconds', toInt('tolerance'))
  .option('--from-start', 'Also print deliveries already in the log')
  .action(
    async (options: {
      webhook?: string;
      secret?: string;
      interval?: number;
      tolerance?: number;
      fromStart?: boolean;
    }) => {
      await run(async () => {
        const client = await authenticatedClient(globals());
        const controller = new AbortController();
        // Ctrl-C ends the loop cooperatively — a tail should exit 0, not 130
        // with a half-written line.
        process.on('SIGINT', () => {
          controller.abort();
          write('');
          write('stopped');
          process.exitCode = EXIT.ok;
        });
        await webhooksTail(client, options, { write }, controller.signal);
      });
    }
  );

program.parseAsync(process.argv).catch((error: unknown) => {
  process.exitCode = reportError(error, writeErr);
});
