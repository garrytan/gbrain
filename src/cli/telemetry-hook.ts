/**
 * The CLI's telemetry seam (docs/guides/telemetry.md), called once per
 * one-shot command from runCli and the fatal seam in main.ts. At tier off it
 * reads one settings file and returns. At tier on it counts the command (only
 * names from gbrain's command and operation tables) and the registered error
 * codes the command rendered, records setup, init and upgrade outcomes, writes
 * the counts, and starts a detached gbrain telemetry sync when one is due.
 * It never throws, never waits on the network, and never starts a send from a
 * --json run, a hook, a server or the telemetry command itself.
 */
import { CLI_COMMANDS } from './command-table.ts';
import { cliCommandOf } from './cli-error.ts';
import { OPERATION_MANIFEST } from '../core/operation-manifest.generated.ts';
import { codeEntry } from '../core/error-catalogue.ts';
import { loadConfigFileOnly } from '../core/config.ts';
import { currentReleaseChannel } from '../core/self-upgrade.ts';
import { spawn } from '../core/spawn.ts';
import { VERSION } from '../version.ts';
import { renderedCliErrorCodes } from '../core/telemetry/error-tally.ts';
import {
  countCommand, countCrash, countErrorCode, currentTier, flushCounts, harnessOf, noteRunVersion, recordEvent, shouldSpawnSync,
} from '../core/telemetry/client.ts';

const NO_SEND_COMMANDS = new Set(['serve', 'hook', 'mcp', 'telemetry', 'check-update', 'self-upgrade', 'upgrade', 'post-upgrade']);
const UPGRADE_COMMANDS = new Set(['upgrade', 'self-upgrade', 'post-upgrade', 'apply-migrations']);

let known: Set<string> | null = null;
function knownCommands(): Set<string> {
  known ??= new Set([
    ...CLI_COMMANDS.map(c => c.name),
    ...OPERATION_MANIFEST.flatMap(op => [op.cliHints?.name, ...(op.cliHints?.aliases ?? [])]).filter((n): n is string => typeof n === 'string'),
  ]);
  return known;
}

const channelName = () => {
  const channel = currentReleaseChannel();
  return channel === 'stable' ? 'stable' : channel === 'alpha' ? 'latest' : 'unknown';
};

function lastRegisteredCode(): string | undefined {
  return renderedCliErrorCodes().filter(c => codeEntry(c)).at(-1);
}

function recordSetupRun(command: string, argv: readonly string[], exitCode: number): void {
  if (['--dry-run', '--help', '-h', '--remove'].some(f => argv.includes(f))) return;
  const positional = argv.filter(a => !a.startsWith('-'));
  recordEvent({
    event_type: 'setup',
    harness: command === 'setup' ? harnessOf(positional[1]) : undefined,
    step: command === 'init' ? 'brain_create' : 'done',
    outcome: exitCode === 0 ? 'success' : 'error',
    error_code: exitCode === 0 ? undefined : lastRegisteredCode(),
    duration_s: Math.round(performance.now() / 1000),
    embedding: loadConfigFileOnly()?.embedding_model ? 'configured' : 'none',
  });
}

function spawnSync(): void {
  const exec = process.execPath ?? '';
  const isDevRuntime = /[/\\](bun|node)(\.exe)?$/.test(exec);
  const args = ['telemetry', 'sync', '--background'];
  const child = spawn(exec, isDevRuntime ? [process.argv[1], ...args] : args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, GBRAIN_SKIP_STARTUP_HOOKS: '1' },
  });
  child.on('error', () => {});
  child.unref();
}

/** Once per one-shot command, after it finished (crash: the fatal error, when it threw). */
export function telemetryAfterCli(exitCode: number, crash?: unknown, argv: readonly string[] = process.argv.slice(2)): void {
  try {
    if (currentTier() === 'off') return;
    const command = cliCommandOf(argv);
    if (!knownCommands().has(command)) return;
    countCommand(command);
    for (const code of renderedCliErrorCodes()) if (codeEntry(code)) countErrorCode(code);
    if (crash !== undefined) countCrash((crash as { constructor?: { name?: string } } | null)?.constructor?.name);
    noteRunVersion(channelName());
    if (command === 'setup' || command === 'init') recordSetupRun(command, argv, exitCode);
    if (UPGRADE_COMMANDS.has(command) && exitCode !== 0 && !argv.includes('--dry-run')) {
      recordEvent({ event_type: 'upgrade', from_version: VERSION, outcome: 'error', error_code: lastRegisteredCode(), channel: channelName() });
    }
    flushCounts();
    if (!argv.includes('--json') && !NO_SEND_COMMANDS.has(command) && shouldSpawnSync()) spawnSync();
  } catch { /* telemetry never breaks a command */ }
}
