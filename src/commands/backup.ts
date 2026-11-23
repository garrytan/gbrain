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

import { isAbsolute } from 'node:path';
import { OperationError, opError } from '../core/ops/contract.ts';
import { redactUrlsInText } from '../core/url-redact.ts';
import { redactConnectionInfo } from '../core/audit/redact-connection-info.ts';
import type { BrainEngine } from '../core/engine.ts';
import { getCliOptions } from '../core/cli-options.ts';
import { getBackupStatus } from '../core/backup/coverage.ts';
import {
  backupCacheAge,
  backupCheckDisabled,
  backupNagGate,
  isBackupStatusStale,
  isVerifiedRecoverable,
  isRemoteTimeout,
  loadBackupStatus,
  currentBackupEvidence,
  type BackupAssetVerdict,
  type BackupStatus,
} from '../core/backup/status-file.ts';

const BACKUP_USAGE: Record<string, { usage: string; example: string }> = {
  create: { usage: 'gbrain backup create --output /absolute/private/path/archive.gbrain-backup [--json]',
    example: 'gbrain backup create --output /srv/private/brain-2026-10-03.gbrain-backup' },
  'verify-store': { usage: 'gbrain backup verify-store /absolute/copied/brain.rust [--json]',
    example: 'gbrain backup verify-store /srv/restore-home/.gbrain/brain.rust --json' },
  restore: { usage: 'gbrain backup restore ARCHIVE --into /absolute/new-root [--mode new-brain|recovery] [--purge-mirror /absolute/purge-events.jsonl] [--confirm-quiesced] [--confirm-backup-compatible] [--confirm-authority-reviewed] [--json]',
    example: 'gbrain backup restore /srv/private/brain-2026-10-03.gbrain-backup --into /srv/gbrain-restored' },
};

/** A3/D4: a malformed `backup create|restore` invocation is a caller mistake (exit 2) with the usage and an example. */
function backupUsageError(sub: string, message: string): OperationError {
  const u = BACKUP_USAGE[sub] ?? BACKUP_USAGE.create!;
  return opError('invalid_params', message, `Usage: ${u.usage}. Example: ${u.example}`);
}

/** Codes a backup command reports as they are (each carries its own fix), instead of the generic storage failure. */
const PASS_THROUGH_CODES: ReadonlySet<string> = new Set(['backup_too_large', 'unmanaged_database_path', 'restore_step_unsupported', 'rust_snapshot_stopped', 'rust_store_unreadable', 'rust_store_locked']);

const SAFE_ERROR_FIELD = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * A nonempty diagnostic for a failed create/restore (#5312). An error's own
 * message is used, URL- and connection-redacted. A message-less thrown value
 * (PGLite's ErrnoError) is described only by its bounded name/code/errno,
 * never `String(object)`, which prints `[object Object]` or serializes
 * whatever the object carries.
 */
export function backupFailureMessage(error: unknown): string {
  const e = (typeof error === 'object' && error !== null ? error : {}) as { message?: unknown; name?: unknown; code?: unknown; errno?: unknown };
  const own = typeof error === 'string' ? error : typeof e.message === 'string' ? e.message : '';
  if (own.trim()) return redactConnectionInfo(redactUrlsInText(own));
  const fields = [
    typeof e.name === 'string' && SAFE_ERROR_FIELD.test(e.name) && e.name !== 'Error' ? e.name : null,
    typeof e.code === 'string' && SAFE_ERROR_FIELD.test(e.code) ? `code ${e.code}` : null,
    typeof e.errno === 'number' && Number.isInteger(e.errno) ? `errno ${e.errno}` : null,
  ].filter((f): f is string => f !== null);
  return fields.length ? `Backup failed with no error message (${fields.join(', ')}).` : 'Backup failed with no error message.';
}

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
  '  create --output ABS   Snapshot a local PGLite or Rust brain and installer-managed files.\n' +
  '                        Pause file writers. Archive contains sensitive full DB state.\n' +
  '                        A Rust brain over the 8 GiB archive cap, and a Postgres brain\n' +
  '                        (pg_dump), are backed up as the docs describe.\n' +
  '  verify-store DIR      Read-only check of a copied Rust brain directory (the physical-copy\n' +
  '                        runbook): identity, format, generation, digests, index state.\n' +
  '  restore ARCHIVE --into ABS\n' +
  '                        Restore into a NEW absent root; preserve the old brain.\n' +
  '                        Default --mode new-brain resets shared identity and authority.\n' +
  '                        --mode recovery preserves brain identity only with\n' +
  '                        --confirm-quiesced --confirm-backup-compatible\n' +
  '                        --confirm-authority-reviewed. Old service exclusion is\n' +
  '                        operator-enforced, not verified by these attestations.\n' +
  '                        Both modes revoke archived authority and disable publication.\n' +
  '                        Quarantine unfinished jobs; never start automation.\n' +
  '                        Replays purges made after the archive from the original\n' +
  '                        brain\'s .gbrain/purge-events.jsonl, or the copy named by\n' +
  '                        --purge-mirror ABS when that root is gone.\n\n' +
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

/**
 * #5505: coverage leaves dirty trees and unverified remotes without fix_argv
 * (no single mechanical fix at compute time); the CLI still names the command
 * that clears each one. A deduped root lists several source ids; any of them
 * pushes the shared repository.
 */
function suggestedFix(a: BackupAssetVerdict): string[] | null {
  if (a.fix_argv && a.fix_argv.length > 0) return a.fix_argv;
  if (a.state === 'dirty') {
    return a.kind === 'bootstrap_workspace' ? ['gbrain', 'sources', 'push', '--path', a.id] : ['gbrain', 'sources', 'push', a.id.split(', ')[0]];
  }
  if (a.state === 'ok' && !isVerifiedRecoverable(a)) return ['gbrain', 'backup', 'check'];
  return null;
}

function renderHuman(s: BackupStatus, out: (line: string) => void): void {
  const age = backupCacheAge(s);
  out(`backup coverage — ${s.overall === 'warn' ? 'WARN' : 'ok'} (checked ${age}, by ${s.computed_by})`);
  for (const a of s.assets) {
    const mark = isVerifiedRecoverable(a) ? '✓' : a.state === 'no_remote' ? '✗' : a.state === 'info' ? '·' : '⚠';
    out(`  ${mark} [${a.kind}] ${a.id} — ${a.state}${a.verification ? `; remote evidence: ${isRemoteTimeout(a) ? 'timed out (unconfirmed, not missing)' : a.verification.state}` : ''}${a.detail ? `: ${a.detail}` : ''}`);
    const fix = suggestedFix(a);
    if (fix) out(`      fix: ${fix.join(' ')}`);
  }
  out(recoveryStatement(s));
  const timeouts = s.totals.remote_timeouts ?? 0;
  if (timeouts > 0) {
    out(`note: ${timeouts} remote check(s) timed out, so those backups are unconfirmed, not missing; for a slow remote raise the slot (default 2000 ms, max 30000): gbrain config set backup.remote_timeout_ms <ms>`);
  }
  if (s.degraded) {
    out('note: the brain database was unreadable during this check — verdict is partial (not cached)');
  }
  if (s.overall === 'warn') {
    out('Fix the ✗ and ⚠ rows above, then run: gbrain backup check');
  }
}

function isLockError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('Could not acquire PGLite lock');
}

/** `gbrain backup verify-store DIR`: the mandatory step of the Rust physical-copy runbook. Reads the copy; changes nothing. */
async function runVerifyStore(args: string[]): Promise<BackupCliResult> {
  const json = args.includes('--json');
  const positional = args.slice(1).filter(a => a !== '--json');
  try {
    if (positional.length !== 1 || positional[0].startsWith('-')) throw backupUsageError('verify-store', 'gbrain backup verify-store takes exactly one absolute directory.');
    const { verifyRustStoreDir } = await import('../core/backup/rust-snapshot.ts');
    const report = await verifyRustStoreDir(positional[0]);
    const ok = report.verdict === 'ok';
    if (json) console.log(JSON.stringify({ ok, dir: positional[0], ...report }));
    else {
      const tags = Object.entries(report.tags);
      console.log([`verify-store ${positional[0]}: ${report.verdict.toUpperCase()}`,
        `  brain id ${report.brain_id ?? 'unknown'}, record format ${report.engine_format_version ?? 'unknown'} (FORMAT file ${report.format_file_version ?? 'missing'}), schema ${report.schema_version ?? 'unknown'}, generation ${report.generation ?? 'unknown'}`,
        `  ${report.keys} keys, ${report.bytes} bytes, ${tags.length} tags${report.relations ? `, ${Object.keys(report.relations).length} seeded relations` : ''}`,
        `  keyword index: ${report.keyword_index ? `${report.keyword_index.state}${report.keyword_index.ok ? '' : ' (NOT ok)'}` : 'not checked'}`,
        ...(report.integrity ? [`  integrity: ${report.integrity}`] : []), ...(report.mismatches.length ? [`  mismatches: ${report.mismatches.join(', ')}`] : []),
        ok ? 'The copy was read, not opened: no file in it changed. Point a new GBRAIN_HOME at it to use it.' : 'Do not rely on this copy; copy the stopped brain again.'].join('\n'));
    }
    return { exitCode: ok ? 0 : 1 };
  } catch (error) {
    const { writeCliError } = await import('../cli/cli-error.ts');
    if (error instanceof OperationError && error.code === 'invalid_params') { writeCliError(error, 'backup', { json, legacy: { ok: false, reason: 'invalid_params', message: error.message } }); return { exitCode: 2 }; }
    const detail = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown };
    const reason = typeof detail.code === 'string' && SAFE_ERROR_FIELD.test(detail.code) ? detail.code : 'verify_failed';
    const message = backupFailureMessage(error);
    if (error instanceof OperationError && PASS_THROUGH_CODES.has(error.code)) writeCliError(error, 'backup', { json, legacy: { ok: false, reason, message } });
    else writeCliError(opError('storage_error', message, 'Tell the user the copy could not be read: it is missing, was not closed cleanly (copy only a stopped brain), or is not a Rust brain directory.', {
      why: 'verify-store reads the copy without opening it, so it refuses what it cannot read safely.' }), 'backup', { json, legacy: { ok: false, reason, message } });
    return { exitCode: 1 };
  }
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
  if (sub === 'verify-store') return runVerifyStore(args);
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
        if (arg === '--output' || arg === '--into' || arg === '--mode' || arg === '--purge-mirror') {
          if (!args[i + 1] || args[i + 1].startsWith('--')) throw backupUsageError(sub, `Missing value for ${arg}.`);
          values[arg] = args[++i];
        } else if (['--confirm-quiesced', '--confirm-backup-compatible', '--confirm-authority-reviewed'].includes(arg)) confirmations.add(arg);
        else if (arg.startsWith('-')) throw backupUsageError(sub, `Unknown backup option: ${arg}.`);
        else positional.push(arg);
      }
      const { createBackup, restoreBackup } = await import('../core/backup/rust-snapshot.ts');
      if (sub === 'create') {
        if (!values['--output'] || values['--into'] || values['--mode'] || values['--purge-mirror'] || confirmations.size || positional.length) throw backupUsageError(sub, 'gbrain backup create takes exactly --output <absolute archive path>.');
        const result = await createBackup({ output: values['--output'] });
        const restoreBlockers = 'restore_blockers' in result ? result.restore_blockers : [];
        if (json) console.log(JSON.stringify({ ok: true, ...result }));
        else console.log(`Backup created: ${result.archive}\nSensitive full database state; protect any off-VM copy.\nExcluded assets: ${(result.manifest.omitted as string[]).join('; ')}${restoreBlockers.length ? `\n${restoreBlockers.join('\n')}` : ''}`);
      } else {
        if (!values['--into'] || values['--output'] || positional.length !== 1) throw backupUsageError(sub, 'gbrain backup restore takes one ARCHIVE and --into <absolute new root>.');
        if (values['--mode'] !== undefined && !['new-brain', 'recovery'].includes(values['--mode'])) throw new Error('Restore --mode must be new-brain or recovery.');
        if (values['--purge-mirror'] !== undefined && !isAbsolute(values['--purge-mirror'])) throw backupUsageError(sub, '--purge-mirror takes an absolute path to a copy of the original brain\'s .gbrain/purge-events.jsonl.');
        const result = await restoreBackup({ archive: positional[0], into: values['--into'], mode: values['--mode'] === 'recovery' ? 'recovery' : 'new_brain',
          confirmQuiesced: confirmations.has('--confirm-quiesced'), confirmBackupCompatible: confirmations.has('--confirm-backup-compatible'),
          confirmAuthorityReviewed: confirmations.has('--confirm-authority-reviewed'), ...(values['--purge-mirror'] ? { purgeMirror: values['--purge-mirror'] } : {}) });
        if (json) console.log(JSON.stringify({ ok: true, ...result }));
        else console.log(`Restored memory: ${result.root}\n${result.quarantined_jobs} unfinished jobs quarantined; no automation started.\n${result.reconnect_required.join('\n')}\nRun setup-in-agent.sh for this root to restore its runtime, then reconnect excluded credentials/services and verify memory.`);
      }
      return { exitCode: 0 };
    } catch (error) {
      if (error instanceof OperationError && error.code === 'invalid_params') {
        const { writeCliError } = await import('../cli/cli-error.ts');
        writeCliError(error, 'backup', { json, legacy: { ok: false, reason: 'invalid_params', message: error.message } });
        return { exitCode: 2 };
      }
      if (error instanceof OperationError && PASS_THROUGH_CODES.has(error.code)) {
        const { writeCliError } = await import('../cli/cli-error.ts');
        writeCliError(error, 'backup', { json, legacy: { ok: false, reason: error.code, ...(error.code === 'restore_step_unsupported' && error.reason ? { refusal_reason: error.reason } : {}), message: error.message } });
        return { exitCode: 1 };
      }
      if (error instanceof OperationError && error.reason === 'pglite_required') {
        const { writeCliError } = await import('../cli/cli-error.ts');
        writeCliError(error, 'backup', { json, legacy: { ok: false, reason: error.reason, message: error.message } });
        return { exitCode: 1 };
      }
      const detail = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown; retryable?: unknown };
      const reason = typeof detail.code === 'string' && SAFE_ERROR_FIELD.test(detail.code) ? detail.code : 'backup_failed';
      const message = backupFailureMessage(error);
      const { writeCliError } = await import('../cli/cli-error.ts');
      writeCliError(opError('storage_error', message,
        'Tell the user the backup failed with this message, then run `gbrain doctor --json` to check storage and locks before retrying.', {
          why: `gbrain backup ${sub} stopped on a database or filesystem error before it finished.`,
          fix: { argv: ['gbrain', 'doctor', '--json'], consent: [], actor: 'agent', requires_exclusive: false,
            why: 'Doctor reports the brain\'s storage, lock and connection state, read-only.', verify: { argv: ['gbrain', 'doctor', '--json'] } },
        }), 'backup', { json, legacy: { ok: false, reason, message, ...(detail.retryable === true ? { retryable: true } : {}) } });
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
