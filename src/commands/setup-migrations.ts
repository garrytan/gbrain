/**
 * `gbrain setup`: finish the setup migrations `gbrain init` leaves pending on
 * the brain setup just created in this run (#6606 follow-up, Cat 41 run 4).
 * Every agent used to read init's "Finish setup" line and spend a turn
 * running that command. Setup runs the same command itself (FINISH_SETUP_ARGV
 * in fresh-install.ts), non-interactive, as a child process (its stdout stays
 * out of setup's own output and JSON document, and the PGLite lock is
 * released when it exits), without installing any service. It works offline: the migrations are local ledger, schema and
 * file work under GBRAIN_HOME plus a local `gbrain jobs smoke` child.
 * The one exception is v0.11.0's host phase, which appends a marker to an
 * existing ~/.claude/AGENTS.md or ~/.openclaw/AGENTS.md and rewrites
 * existing OpenClaw cron manifests: files setup does not own, so when any
 * exists, setup leaves v0.11.0 to the explicit command and says so.
 * Only a fresh brain (created by this setup run) reaches here; an existing
 * brain keeps today's output.
 */
import { migrationLedgerSummary } from '../core/migration-ledger.ts';
import { bunSpawnSync } from '../core/spawn.ts';
import { VERSION } from '../version.ts';
import { hostRewriteTargets } from './migrations/v0_11_0.ts';
import { FINISH_SETUP_COMMAND as FINISH, setupMigrationsArgv } from './migrations/fresh-install.ts';
const HOST_MIGRATION = '0.11.0';
const CHILD_TIMEOUT_MS = 60_000;

/** The init stderr line this replaces (src/commands/migrations/fresh-install.ts). */
export const INIT_MIGRATIONS_LINE = /^\[init\] Migrations: .*$/m;

function runApply(launcher: string, version?: string): { applied: string[]; failed: string | null } {
  const child = bunSpawnSync(setupMigrationsArgv(launcher, version), { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: CHILD_TIMEOUT_MS,
    env: { ...process.env, GBRAIN_NO_AUTOPILOT_INSTALL: '1' } });
  let doc: { results?: Array<{ version: string; status: string }>; code?: string; error?: { code?: string } } = {};
  try { doc = JSON.parse(child.stdout?.toString() ?? ''); } catch { /* reported below */ }
  const applied = (doc.results ?? []).filter(r => r.status === 'complete').map(r => r.version);
  if (child.exitCode === 0 && !(doc.results ?? []).some(r => r.status !== 'complete')) return { applied, failed: null };
  const failedRow = (doc.results ?? []).find(r => r.status !== 'complete');
  const code = child.signalCode ? 'timeout' : doc.error?.code ?? doc.code ?? (failedRow ? `${failedRow.version}_${failedRow.status}` : `exit_${child.exitCode}`);
  return { applied, failed: code };
}

/**
 * Run the pending setup migrations on the brain this setup run created and
 * return init's stderr with its migrations line replaced by the outcome.
 */
export function finishFreshSetupMigrations(launcher: string, initStderr: string): string {
  const initLine = initStderr.match(INIT_MIGRATIONS_LINE)?.[0];
  const pending = migrationLedgerSummary(VERSION).pending_fresh_install;
  if (!initLine || pending.length === 0) return initStderr;
  const stamped = initLine.match(/(\d+) recorded as not needed on a new brain/)?.[0] ?? '';
  const hostFiles = pending.includes(HOST_MIGRATION) ? hostRewriteTargets() : [];
  const toRun = hostFiles.length ? pending.filter(v => v !== HOST_MIGRATION) : pending;

  const applied: string[] = [];
  let failed: string | null = null;
  for (const version of hostFiles.length ? toRun : [undefined]) {
    const r = runApply(launcher, version);
    applied.push(...r.applied);
    if (r.failed) { failed = r.failed; break; }
  }
  const left = migrationLedgerSummary(VERSION).pending_fresh_install;
  let line: string;
  if (failed) {
    line = `${initLine} (setup ran it and it failed: ${failed})`;
  } else {
    const done = `${applied.length} setup migration(s) applied by setup without installing services (${applied.join(', ')})`;
    line = `[setup] Migrations: ${stamped ? `${stamped}; ` : ''}${done}; `
      + (left.length === 0 ? 'none pending.'
        : hostFiles.length && left.includes(HOST_MIGRATION)
          ? `${HOST_MIGRATION} left pending because it edits ${hostFiles.join(', ')}, which setup does not own. Finish it: ${FINISH}`
          : `${left.length} still pending (${left.join(', ')}). Finish setup: ${FINISH}`);
  }
  return initStderr.replace(INIT_MIGRATIONS_LINE, line);
}
