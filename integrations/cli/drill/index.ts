/**
 * Drill runner: `pnpm drill <name>`.
 *
 * A dispatcher rather than a direct entry point so that `pnpm drill ttfe`
 * names the drill it is running — the next drill (rate-limit behaviour, token
 * refresh under load) lands here without renaming a script.
 */
import { readConfig, runTtfe } from './ttfe.js';
import { reportError } from '../src/errors.js';

const DRILLS = ['ttfe'] as const;
type DrillName = (typeof DRILLS)[number];

function isDrill(value: string | undefined): value is DrillName {
  return value !== undefined && (DRILLS as readonly string[]).includes(value);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const name = argv.find((arg) => !arg.startsWith('--'));

  if (!isDrill(name)) {
    process.stderr.write(
      `usage: pnpm drill <${DRILLS.join('|')}> [--threshold <ms>] [--base-url <url>] [--listen [port]] [--json] [--keep]\n`
    );
    process.exitCode = 2;
    return;
  }

  const result = await runTtfe(readConfig(argv));
  // Over the threshold is a failing build, not a warning. That is the entire
  // reason the drill is a script and not a paragraph in a README.
  process.exitCode = result.ok ? 0 : 1;
}

main().catch((error: unknown) => {
  process.exitCode = reportError(error, (line) => process.stderr.write(`${line}\n`));
  if (process.exitCode === 0) process.exitCode = 1;
});
