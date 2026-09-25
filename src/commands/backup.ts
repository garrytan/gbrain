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
  currentBackupEvidence,
  type BackupStatus,
} from '../core/backup/status-file.ts';

export interface BackupCliResult {
  exitCode: 0 | 1 | 2;
}

const HELP =
  'gbrain backup <status|check|create|restore> [--json]\n\n' +
  '  status   Configured repos and recently verified remote commits. Git alone\n' +
  '           is not a full database backup. Uses the\n' +
  '           cached verdict, including warnings, while remote evidence is fresh.\n' +
  '  check    Force a bounded remote-ref sweep, prioritizing pending/older refs.\n' +
  '           Remote evidence expires after one hour; offline is not verified.\n' +
  '  create --output ABS   Snapshot local PGLite and installer-managed files.\n' +
  '                        Pause file writers. Archive contains sensitive full DB state.\n' +
  '  restore ARCHIVE --into ABS\n' +
  '                        Restore into a NEW absent root; preserve the old brain.\n' +
  '                        Default --mode new-brain resets shared identity and authority.\n' +
  '                        --mode recovery preserves brain identity only with\n' +
  '                        --confirm-quiesced --confirm-backup-compatible\n' +
  '                        --confirm-authority-reviewed. Old service exclusion is\n' +
  '                        operator-enforced, not verified by these attestations.\n' +
  '                        Both modes revoke archived authority and disable publication.\n' +
  '                        Quarantine unfinished jobs; never start automation.\n\n' +
  '  --json   Structured verdict (includes the recovery field).\n\n' +
  'Exit codes: 0 ok / 1 warn / 2 usage error. Off switches: GBRAIN_BACKUP_CHECK=0 or\n' +
  '`gbrain config set backup.check_enabled false`. Interval:\n' +
  '`gbrain config set backup.check_interval_days <n>` (default 30, min 1;\n' +
  'env GBRAIN_BACKUP_CHECK_DAYS wins over config).';

function exitFor(s: BackupStatus | null): 0 | 1 {
  return !s || s.overall === 'warn' ? 1 : 0;
}

function recoveryStatement(s: BackupStatus): string {
  const repos = s.totals.recoverable_repos;
  const risk = s.totals.pages_at_risk;
  const repoPart = `${repos} repo${repos === 1 ? '' : 's'} with recently verified remote commits`;
  const riskPart = risk > 0 ? `at least ${risk} page${risk === 1 ? '' : 's'} at risk` : 'DB-only recovery is not established by git';
  return `${repoPart}; ${riskPart}. ${s.recovery_scope ?? 'Git is not a full database backup.'}`;
}

function renderHuman(s: BackupStatus, out: (line: string) => void): void {
  const age = backupCacheAge(s);
  out(`backup coverage — ${s.overall === 'warn' ? 'WARN' : 'ok'} (checked ${age}, by ${s.computed_by})`);
  for (const a of s.assets) {
    const mark = a.state === 'ok' && a.verification?.state === 'verified' ? '✓' : a.state === 'no_remote' ? '✗' : a.state === 'info' ? '·' : '⚠';
    out(`  ${mark} [${a.kind}] ${a.id} — ${a.state}${a.verification ? `; remote evidence: ${a.verification.state}` : ''}${a.detail ? `: ${a.detail}` : ''}`);
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
  if (sub === 'create' || sub === 'restore') {
    const json = args.includes('--json');
    try {
      const { resolveBrainId } = await import('../core/brain-resolver.ts');
      if (resolveBrainId(getCliOptions().brain) !== 'host') throw new Error('Full local backup currently supports the selected host installation only; use --brain host with its explicit GBRAIN_HOME.');
      const values: Record<string, string> = {};
      const confirmations = new Set<string>();
      const positional: string[] = [];
      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--json') continue;
        if (arg === '--output' || arg === '--into' || arg === '--mode') {
          if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
          values[arg] = args[++i];
        } else if (['--confirm-quiesced', '--confirm-backup-compatible', '--confirm-authority-reviewed'].includes(arg)) confirmations.add(arg);
        else if (arg.startsWith('-')) throw new Error(`Unknown backup option: ${arg}`);
        else positional.push(arg);
      }
      const { createPgliteBackup, restorePgliteBackup } = await import('../core/backup/snapshot.ts');
      if (sub === 'create') {
        if (!values['--output'] || values['--into'] || values['--mode'] || confirmations.size || positional.length) throw new Error('Usage: gbrain backup create --output /absolute/private/path/archive.gbrain-backup');
        const result = await createPgliteBackup({ output: values['--output'] });
        if (json) console.log(JSON.stringify({ ok: true, ...result }));
        else console.log(`Backup created: ${result.archive}\nSensitive full database state; protect any off-VM copy.\nExcluded assets: ${(result.manifest.omitted as string[]).join('; ')}`);
      } else {
        if (!values['--into'] || values['--output'] || positional.length !== 1) throw new Error('Usage: gbrain backup restore ARCHIVE --into /absolute/new-root');
        if (values['--mode'] !== undefined && !['new-brain', 'recovery'].includes(values['--mode'])) throw new Error('Restore --mode must be new-brain or recovery.');
        const result = await restorePgliteBackup({ archive: positional[0], into: values['--into'], mode: values['--mode'] === 'recovery' ? 'recovery' : 'new_brain',
          confirmQuiesced: confirmations.has('--confirm-quiesced'), confirmBackupCompatible: confirmations.has('--confirm-backup-compatible'),
          confirmAuthorityReviewed: confirmations.has('--confirm-authority-reviewed') });
        if (json) console.log(JSON.stringify({ ok: true, ...result }));
        else console.log(`Restored memory: ${result.root}\n${result.quarantined_jobs} unfinished jobs quarantined; no automation started.\n${result.reconnect_required.join('\n')}\nRun setup-in-agent.sh for this root to restore its runtime, then reconnect excluded credentials/services and verify memory.`);
      }
      return { exitCode: 0 };
    } catch (error) {
      const detail = error as Error & { code?: string; retryable?: boolean };
      // #5312: some engine errors carry no .message (e.g. PGLite ErrnoError) —
      // fall back to String(error) so the JSON envelope is never bare.
      if (json) console.log(JSON.stringify({ ok: false, reason: detail.code ?? 'backup_failed', message: detail.message ?? String(error), ...(detail.retryable ? { retryable: true } : {}) }));
      else console.error(detail.message);
      return { exitCode: 1 };
    }
  }
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

  const raw = loadBackupStatus();
  const cached = raw ? currentBackupEvidence(raw) : null;
  let status: BackupStatus | null = cached;
  let lockNote: string | null = null;

  const stale = cached === null || isBackupStatusStale(cached);
  const needCompute = !disabled && (sub === 'check' || stale || cached?.overall === 'warn');
  if (disabled) lockNote = 'backup check disabled — verdict from cache only';
  if (needCompute) {
    try {
      const engine = await connect();
      try {
        status = await getBackupStatus(engine, {
          localGitProbes: true,
          verifyRemoteRefs: !quiet,
          computedBy: quiet ? 'spawn' : 'cli',
          forceRefresh: sub === 'check',
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
        status = cached ? { ...cached, degraded: true } : null;
      } else if (cached) {
        lockNote = `engine unavailable — verdict from cache (${backupCacheAge(cached)})`;
        status = { ...cached, degraded: true };
      } else {
        throw err;
      }
    }
  }

  if (quiet) return { exitCode: 0 };

  if (!status) {
    console.log(lockNote ?? 'no backup verdict yet — run: gbrain backup check');
    return { exitCode: disabled ? 0 : 1 };
  }

  status = currentBackupEvidence(status);
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
