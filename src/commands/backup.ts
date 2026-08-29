/**
 * commands/backup.ts — `gbrain backup` CLI surface (monthly backup-coverage
 * check: "if this disk died, could I recreate my agent?").
 *
 *   gbrain backup status [--json]   # verdict + per-asset table + fix commands
 *   gbrain backup check  [--json]   # force a recompute + write the cache
 *
 * Exit codes: 0 ok / 1 warn (both subcommands). `--quiet` (global flag) is
 * the detached-spawn mode: no output, always exit 0.
 *
 * ENGINE HANDLING: dispatched in cli.ts's PRE-engine lane and connects via an
 * injected thunk, because the shared connectEngine would die on the PGLite
 * single-writer lock while a `gbrain serve` runs — exactly the primary cohort
 * this command serves. On an engine-acquire failure both subcommands fall
 * back to the cached verdict + age (cache-derived exit code), never a crash;
 * absent cache + lock held → unknown, exit 0 (fail-open). The stdio serve
 * refresher's warn+24h rule is what makes "it refreshes within a day" true.
 */

import type { BrainEngine } from '../core/engine.ts';
import { getCliOptions } from '../core/cli-options.ts';
import { getBackupStatus } from '../core/backup/coverage.ts';
import {
  backupCacheAge,
  backupCheckDisabled,
  backupNagGate,
  isBackupStatusStale,
  loadBackupStatus,
  type BackupStatus,
} from '../core/backup/status-file.ts';

export interface BackupCliResult {
  exitCode: 0 | 1 | 2;
}

const HELP =
  'gbrain backup <status|check> [--json]\n\n' +
  '  status   Backup-coverage verdict: which knowledge repos have a git remote,\n' +
  '           what survives a disk loss, and the exact fix commands. Uses the\n' +
  '           cached verdict when it is ok; recomputes when it is warn or stale.\n' +
  '  check    Force a recompute and write the cache.\n\n' +
  '  --json   Structured verdict (includes the recovery field).\n\n' +
  'Exit codes: 0 ok / 1 warn / 2 usage error. Off switches: GBRAIN_BACKUP_CHECK=0 or\n' +
  '`gbrain config set backup.check_enabled false`. Interval:\n' +
  '`gbrain config set backup.check_interval_days <n>` (default 30, min 1;\n' +
  'env GBRAIN_BACKUP_CHECK_DAYS wins over config).';

function exitFor(s: BackupStatus | null): 0 | 1 {
  return s?.overall === 'warn' ? 1 : 0;
}

function recoveryStatement(s: BackupStatus): string {
  const repos = s.totals.recoverable_repos;
  const risk = s.totals.pages_at_risk;
  const repoPart = `${repos} repo${repos === 1 ? '' : 's'} recoverable from a git remote`;
  const riskPart = risk > 0 ? `${risk} page${risk === 1 ? '' : 's'} at risk` : 'no pages at risk';
  return `What survives a disk loss today: ${repoPart}; ${riskPart}.`;
}

function renderHuman(s: BackupStatus, out: (line: string) => void): void {
  const age = backupCacheAge(s);
  out(`backup coverage — ${s.overall === 'warn' ? 'WARN' : 'ok'} (checked ${age}, by ${s.computed_by})`);
  for (const a of s.assets) {
    const mark = a.state === 'ok' ? '✓' : a.state === 'no_remote' ? '✗' : a.state === 'info' ? '·' : '⚠';
    out(`  ${mark} [${a.kind}] ${a.id} — ${a.state}${a.detail ? `: ${a.detail}` : ''}`);
    if (a.fix_argv && a.fix_argv.length > 0) out(`      fix: ${a.fix_argv.join(' ')}`);
  }
  out(recoveryStatement(s));
  if (s.degraded) {
    out('note: the brain database was unreadable during this check — verdict is partial (not cached)');
  }
  if (s.overall === 'warn') {
    out('Fix the ✗ rows above, then run: gbrain backup check');
  }
}

function isLockError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('Could not acquire PGLite lock');
}

export async function runBackupCli(
  args: string[],
  connect: () => Promise<BrainEngine>,
): Promise<BackupCliResult> {
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    console.log(HELP);
    return { exitCode: 0 };
  }
  const sub = args[0];
  if (sub !== 'status' && sub !== 'check') {
    console.error(`Unknown backup subcommand: ${sub}\n\n${HELP}`);
    return { exitCode: 2 };
  }
  const json = args.includes('--json');
  const quiet = getCliOptions().quiet === true;

  const disabled = backupCheckDisabled();
  if (disabled && sub === 'check') {
    if (!quiet) console.error('backup check is disabled (GBRAIN_BACKUP_CHECK=0 or backup.check_enabled=false)');
    return { exitCode: 0 };
  }

  const cached = loadBackupStatus();
  let status: BackupStatus | null = cached;
  let lockNote: string | null = null;

  // status recomputes when the cached verdict is warn (a raw `git remote add`
  // fix must show up immediately) or stale/absent; check always recomputes.
  // A fresh ok cache answers `status` without touching the engine (no lock
  // risk). Disabled silences COMPUTE on both subcommands (the ops-doc
  // contract) — a disabled `status` is a cache-only reader.
  const stale = cached === null || isBackupStatusStale(cached);
  const needCompute = !disabled && (sub === 'check' || stale || cached?.overall === 'warn');
  if (disabled) lockNote = 'backup check disabled — verdict from cache only';
  if (needCompute) {
    try {
      const engine = await connect();
      try {
        status = await getBackupStatus(engine, {
          localGitProbes: true,
          computedBy: quiet ? 'spawn' : 'cli',
          forceRefresh: sub === 'check' || cached?.overall === 'warn',
        });
      } finally {
        try {
          await engine.disconnect();
        } catch {
          /* best-effort teardown */
        }
      }
    } catch (err) {
      if (isLockError(err)) {
        lockNote = cached
          ? `DB locked by serve — verdict from cache (${backupCacheAge(cached)}); it refreshes automatically within a day`
          : 'no cached verdict; DB locked by serve — it refreshes automatically within a day';
        status = cached;
      } else if (cached) {
        lockNote = `engine unavailable — verdict from cache (${backupCacheAge(cached)})`;
        status = cached;
      } else {
        throw err;
      }
    }
  }

  if (quiet) return { exitCode: 0 };

  if (!status) {
    console.log(lockNote ?? 'no backup verdict yet — run: gbrain backup check');
    return { exitCode: 0 };
  }

  if (json) {
    const payload = {
      ...status,
      recovery: {
        recoverable_repos: status.totals.recoverable_repos,
        pages_at_risk: status.totals.pages_at_risk,
        statement: recoveryStatement(status),
      },
      ...(lockNote ? { note: lockNote } : {}),
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else {
    renderHuman(status, (l) => process.stdout.write(l + '\n'));
    if (lockNote) process.stdout.write(`note: ${lockNote}\n`);
  }

  // The output itself is never suppressed — only the other channels' budgets
  // learn about this impression (uniform global-cap enforcement in the gate).
  if (status.overall === 'warn' && !disabled) {
    try {
      backupNagGate('status', status).record();
    } catch {
      /* best-effort */
    }
  }
  // Disabled means silent for automation too: a stale warn cache that can
  // never refresh must not fail crons with exit 1.
  return { exitCode: disabled ? 0 : exitFor(status) };
}
