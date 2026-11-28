/**
 * The CLI's telemetry seam (docs/guides/telemetry.md), called once per
 * one-shot command from runCli and the fatal seam in main.ts. At tier off it
 * reads one settings file and returns. Before any answer it only holds setup,
 * init and failed-upgrade outcomes in the local pending file. At tier on it counts the command (only
 * names from gbrain's command and operation tables) and the registered error
 * codes the command rendered, records setup, init and upgrade outcomes, writes
 * the counts, and starts a detached gbrain telemetry sync when one is due.
 * It never throws, never waits on the network, and never starts a send from a
 * --json run, a hook, a server or the telemetry command itself.
 */
import { CLI_COMMANDS } from './command-table.ts';
import { cliCommandOf } from './cli-error.ts';
import { parseGlobalFlags } from '../core/cli-options.ts';
import { jsonRequested } from '../core/cli-force-exit.ts';
import { OPERATION_MANIFEST } from '../core/operation-manifest.generated.ts';
import { codeEntry } from '../core/error-catalogue.ts';
import { loadConfigFileOnly } from '../core/config.ts';
import { currentReleaseChannel } from '../core/self-upgrade.ts';
import { spawn } from '../core/spawn.ts';
import { VERSION } from '../version.ts';
import { renderedCliErrorCodes } from '../core/telemetry/error-tally.ts';
import {
  awaitingAnswer, countCommand, countCrash, countErrorCode, currentTier, flushCounts, harnessOf, noteRunVersion, recordEvent, shouldSpawnSync, telemetryDir,
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
  const named = argv.filter(a => !a.startsWith('-')).slice(1).map(harnessOf);
  recordEvent({
    event_type: 'setup',
    harness: command === 'setup' ? named.find(h => h !== 'other') ?? named[0] : undefined,
    step: command === 'init' ? 'brain_create' : 'done',
    outcome: exitCode === 0 ? 'success' : 'error',
    error_code: exitCode === 0 ? undefined : lastRegisteredCode(),
    duration_s: Math.round(performance.now() / 1000),
    embedding: loadConfigFileOnly()?.embedding_model ? 'configured' : 'none',
  });
}

/** Setup, init and failed-upgrade outcomes: queued at tier on, held for the answer before one. */
function recordOutcomes(command: string, argv: readonly string[], exitCode: number): void {
  if (command === 'setup' || command === 'init') recordSetupRun(command, argv, exitCode);
  if (UPGRADE_COMMANDS.has(command) && exitCode !== 0 && !argv.includes('--dry-run')) {
    recordEvent({ event_type: 'upgrade', from_version: VERSION, outcome: 'error', error_code: lastRegisteredCode(), channel: channelName() });
  }
}

function spawnSync(): void {
  const exec = process.execPath ?? '';
  const isDevRuntime = /[/\\](bun|node)(\.exe)?$/.test(exec);
  const args = ['telemetry', 'sync', '--background'];
  const child = spawn(exec, isDevRuntime ? [process.argv[1], ...args] : args, {
    detached: true,
    stdio: 'ignore',
    cwd: telemetryDir(),
    env: { ...process.env, GBRAIN_SKIP_STARTUP_HOOKS: '1' },
  });
  child.on('error', () => {});
  child.unref();
}

/** Once per one-shot command, after it finished (crash: the fatal error, when it threw). */
export function telemetryAfterCli(exitCode: number, crash?: unknown, rawArgv: readonly string[] = process.argv.slice(2)): void {
  try {
    const argv = parseGlobalFlags([...rawArgv]).rest;
    const waiting = currentTier() === 'off' && awaitingAnswer();
    if (currentTier() === 'off' && !waiting) return;
    const command = cliCommandOf(argv);
    if (!knownCommands().has(command)) return;
    if (waiting) {
      recordOutcomes(command, argv, exitCode);
      return;
    }
    countCommand(command);
    for (const code of renderedCliErrorCodes()) if (codeEntry(code)) countErrorCode(code);
    if (crash !== undefined) countCrash((crash as { constructor?: { name?: string } } | null)?.constructor?.name);
    noteRunVersion(channelName());
    recordOutcomes(command, argv, exitCode);
    flushCounts();
    if (!jsonRequested(rawArgv) && !NO_SEND_COMMANDS.has(command) && process.env.GBRAIN_ENFORCED_MEMBER === undefined && shouldSpawnSync()) spawnSync();
  } catch { /* silent-read-ok: telemetry never breaks a command, and a failed read sends nothing */ }
}
