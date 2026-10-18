/**
 * v0.11.0 Phase F: the autopilot install, and an upgrade on a brain that names
 * no repo (#6755).
 *
 * Phase F installs the daemon only for the repo the brain names in
 * sync.repo_path, the same one `gbrain autopilot --install` resolves first.
 * Without it the phase installs nothing during an upgrade: it is skipped with
 * the exact install command (the default source's local_path when there is
 * one), a pending host-work item records that command, and doctor's
 * `minions_migration` line carries it until an autopilot is installed for
 * this brain. The migration completes instead of ending partial.
 *
 * The old Phase F ran the install anyway and wedged such brains after three
 * partials. Its ledger rows cannot say why the install failed (the child's
 * stderr is not captured; `phases[].detail` is only execSync's
 * `Command failed: <command>`), so `clearRepoPathWedge` keys on the shape
 * and the brain as it is now: every trailing partial failed only the install
 * phase, and the new phase would skip because sync.repo_path is unset. Phase F
 * now records a `reason` code on its outcomes (`no_repo_path`,
 * `autopilot_already_installed`, `install_failed`) for later readers.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';
import { shellQuote } from '../../core/agent-output.ts';
import { resolveAutopilotJob } from '../../core/autopilot-paths.ts';
import { cliChildStdio } from '../../core/cli-force-exit.ts';
import { gbrainPath, loadConfig, type GBrainConfig } from '../../core/config.ts';
import { indexCompletedEntries, statusForVersion, trailingPartialCount } from '../../core/migration-ledger.ts';
import { appendCompletedMigration, type CompletedMigrationEntry } from '../../core/preferences.ts';
import { execSync } from '../../core/spawn.ts';
import { detectInstalledJob } from '../autopilot/jobs.ts';
import { defaultSourceLocalPath } from '../autopilot/install-repo.ts';
import { gbrainChildCommand } from './in-process.ts';
import { connectMigrationEngine } from './run-engine.ts';
import type { OrchestratorOpts, OrchestratorPhaseResult } from './types.ts';

export const AUTOPILOT_INSTALL_TODO = 'autopilot-install-needs-repo';
const REPO_INPUT = 'REPO_PATH';

export interface AutopilotInstallTodo {
  type: typeof AUTOPILOT_INSTALL_TODO;
  status: 'pending' | 'complete';
  detected_at: string;
  repo: string | null;
  install_argv: string[];
  recommendation: string;
}

const pendingHostWorkPath = () => gbrainPath('migrations', 'pending-host-work.jsonl');

/** The install command for this brain; `<REPO_PATH>` when the brain names no repo at all. */
export function autopilotInstallArgv(repo: string | null): string[] {
  return ['gbrain', 'autopilot', '--install', '--yes', '--repo', repo ?? `<${REPO_INPUT}>`];
}

export function autopilotInstallCommand(repo: string | null): string {
  return repo ? shellQuote(autopilotInstallArgv(repo)) : autopilotInstallArgv(null).join(' ');
}

/** The newest pending install item Phase F recorded, or null. */
export function pendingAutopilotInstall(): AutopilotInstallTodo | null {
  if (!existsSync(pendingHostWorkPath())) return null;
  let found: AutopilotInstallTodo | null = null;
  for (const line of readFileSync(pendingHostWorkPath(), 'utf-8').split('\n')) {
    try {
      const row = JSON.parse(line) as AutopilotInstallTodo;
      if (row.type === AUTOPILOT_INSTALL_TODO && row.status === 'pending') found = row;
    } catch { /* blank or malformed line */ }
  }
  return found;
}

/** Record the skipped install as a pending host-work item, once per install command. */
export function recordSkippedAutopilotInstall(repo: string | null): void {
  const argv = autopilotInstallArgv(repo);
  if (pendingAutopilotInstall()?.install_argv.join('\0') === argv.join('\0')) return;
  const todo: AutopilotInstallTodo = {
    type: AUTOPILOT_INSTALL_TODO,
    status: 'pending',
    detected_at: new Date().toISOString(),
    repo,
    install_argv: argv,
    recommendation: repo
      ? `The upgrade installed no autopilot because sync.repo_path is unset. Install it for this brain's repo: ${autopilotInstallCommand(repo)}`
      : `The upgrade installed no autopilot because the brain names no repo (no sync.repo_path, no default source path). Install it with the brain repo's path: ${autopilotInstallCommand(null)}`,
  };
  mkdirSync(dirname(pendingHostWorkPath()), { recursive: true });
  appendFileSync(pendingHostWorkPath(), JSON.stringify(todo) + '\n');
}

/** Whether an autopilot job for this brain is installed under any supervisor target. */
export function autopilotInstalledForBrain(): boolean {
  try { return detectInstalledJob(resolveAutopilotJob()).installed !== null; } catch { return false; }
}

async function readRepoPaths(config: GBrainConfig | null): Promise<{ syncRepoPath: string | null; defaultSourcePath: string | null }> {
  if (!config) throw new Error('no brain configured');
  const { engine, close } = await connectMigrationEngine(config);
  try {
    const syncRepoPath = (await engine.getConfig('sync.repo_path')) || null;
    return { syncRepoPath, defaultSourcePath: syncRepoPath ? null : await defaultSourceLocalPath(engine) };
  } finally { await close(); }
}

function skipWithoutRepo(defaultSourcePath: string | null): OrchestratorPhaseResult {
  if (autopilotInstalledForBrain()) {
    return { name: 'install', status: 'skipped', reason: 'autopilot_already_installed', detail: 'sync.repo_path is unset and an autopilot is already installed for this brain; left as is' };
  }
  recordSkippedAutopilotInstall(defaultSourcePath);
  const command = autopilotInstallCommand(defaultSourcePath);
  console.log(`No autopilot was installed: sync.repo_path is unset. Install it when you want background maintenance: ${command} `
    + `(recorded in ${pendingHostWorkPath()}; gbrain doctor shows it until an autopilot is installed)`);
  return {
    name: 'install', status: 'skipped', reason: 'no_repo_path', detail: `sync.repo_path is unset, so the upgrade installed no autopilot. Install it: ${command}`,
    ...(defaultSourcePath ? { argv: autopilotInstallArgv(defaultSourcePath) } : {}),
  };
}

export async function phaseFInstall(opts: OrchestratorOpts): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'install', status: 'skipped', detail: 'dry-run' };
  if (opts.noAutopilotInstall) return { name: 'install', status: 'skipped', detail: '--no-autopilot-install' };
  let repoNote = 'repo path not read';
  try {
    const config = loadConfig();
    if (config?.engine === 'pglite') {
      return { name: 'install', status: 'skipped', detail: 'PGLite is single-writer; use gbrain serve for background maintenance' };
    }
    try {
      const repo = await readRepoPaths(config);
      if (!repo.syncRepoPath) return skipWithoutRepo(repo.defaultSourcePath);
      repoNote = `sync.repo_path ${repo.syncRepoPath}`;
    } catch (e) {
      repoNote = `repo path unreadable (${e instanceof Error ? e.message : String(e)}); the install resolves it itself`;
    }
    execSync(gbrainChildCommand('gbrain autopilot --install --yes'), { stdio: cliChildStdio(), timeout: 60_000, env: process.env });
    return { name: 'install', status: 'complete' };
  } catch (e) {
    return { name: 'install', status: 'failed', reason: 'install_failed', detail: `${repoNote}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function failedOnlyInstall(entry: CompletedMigrationEntry): boolean {
  const failed = (entry.phases ?? []).filter(phase => phase.status === 'failed');
  return failed.length === 1 && failed[0]!.name === 'install';
}

/**
 * Un-wedge v0.11.0 when every partial behind the wedge failed only Phase F
 * (whatever its detail says) and Phase F would now skip because this Postgres
 * brain's sync.repo_path is unset: writes a `retry` marker (reason
 * `phase_f_no_repo_path`) and says so. Returns whether it wrote one. With
 * sync.repo_path set, an unreadable one or any other wedge, the runner's
 * `--force-retry` advice stands.
 */
export async function clearRepoPathWedge(completed: readonly CompletedMigrationEntry[]): Promise<boolean> {
  const byVersion = indexCompletedEntries([...completed]);
  if (statusForVersion('0.11.0', byVersion) !== 'wedged') return false;
  const history = byVersion.get('0.11.0') ?? [];
  if (!history.slice(history.length - trailingPartialCount(history)).every(failedOnlyInstall)) return false;
  const config = loadConfig();
  if (!config || config.engine === 'pglite') return false;
  const repo = await readRepoPaths(config).catch(() => null);
  if (!repo || repo.syncRepoPath) return false;
  appendCompletedMigration({ version: '0.11.0', status: 'retry', reason: 'phase_f_no_repo_path' });
  console.error('Cleared the v0.11.0 wedge: every partial run failed only the autopilot install, and sync.repo_path is unset. '
    + 'This version skips that install, so the migration runs again now.');
  return true;
}
