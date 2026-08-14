/**
 * `gbrain pglite-repair` — diagnose and repair a torn-WAL PGLite data dir
 * in place (#223 / #1670 / #2575 recovery, the manual surface for the
 * auto-repair that `PGLiteEngine.connect()` runs on `wasm-abort` failures).
 *
 * Never connects an engine (the whole point is that the DB won't open), so it
 * works when auto-repair is disabled (GBRAIN_PGLITE_WAL_REPAIR=off) or was
 * skipped. `--dry-run` is strictly read-only. The real run:
 *
 *   validate (BEFORE locking — `acquireLock` mkdirs the data dir, and a
 *   typo'd --path must not create directories) → TTY confirm unless --yes →
 *   acquireLock (refuses a reaped acquisition: a corrupt-lock reap cannot
 *   prove the holder is dead, and WAL surgery under a possibly-live writer is
 *   never correct; a live `gbrain serve` holder fast-fails via
 *   LiveServeLockError) → re-validate under the lock → repair → receipt.
 *
 * There is deliberately NO --force: force-removing `.gbrain-lock` while the
 * holder is alive would reopen exactly the concurrent-writer corruption hole
 * #2348 closed. For catalog corruption (the `corrupt` classifier verdict) WAL
 * repair does not help — `gbrain reinit-pglite` is the rebuild path.
 */

import { createInterface } from 'readline';
import { loadConfig, gbrainPath } from '../core/config.ts';
import { acquireLock, releaseLock, LiveServeLockError, msSinceLastReap } from '../core/pglite-lock.ts';
import {
  inspectPgliteDataDir,
  listRepairBackups,
  readRepairSidecar,
  recordRepairAttempt,
  repairPgliteWal,
  validateWalRepairTarget,
  WalRepairError,
} from '../core/pglite-repair.ts';

interface RepairCmdOpts {
  dryRun: boolean;
  yes: boolean;
  jsonOutput: boolean;
  customPath: string | null;
  help: boolean;
}

class UnknownFlagError extends Error {}

function parseArgs(args: string[]): RepairCmdOpts {
  const opts: RepairCmdOpts = { dryRun: false, yes: false, jsonOutput: false, customPath: null, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--json') opts.jsonOutput = true;
    else if (a === '--path') {
      const val = args[++i];
      // F1: a valueless --path (typo / shell mangling) must NOT fall through
      // to the configured default brain and run surgery on the wrong dir.
      if (val === undefined || val.startsWith('-')) throw new UnknownFlagError('--path requires a directory argument');
      opts.customPath = val;
    }
    else if (a === '--help' || a === '-h') opts.help = true;
    // Reject unknown args on a DESTRUCTIVE command (codex): silently ignoring
    // a typo like `--dry-rnu` would run a real WAL reset instead of a dry run.
    else throw new UnknownFlagError(`unknown argument: ${a}`);
  }
  return opts;
}

function printHelp(): void {
  console.log(`gbrain pglite-repair — repair a torn-WAL PGLite data dir in place

The default gbrain engine (PGLite) can fail to open after an unclean shutdown
(commonly a macOS-upgrade reboot) with "RuntimeError: Aborted()". The cause is
torn WAL/checkpoint state on disk, not a macOS WASM bug. This command resets
the WAL in place (pg_resetwal semantics): data files are preserved;
transactions not checkpointed before the corruption may be lost. The
pre-repair pg_wal + pg_control are kept in a sibling backup directory.

Usage:
  gbrain pglite-repair --dry-run [--json] [--path <dir>]   diagnose only
  gbrain pglite-repair [--yes] [--json] [--path <dir>]     repair (confirm on TTY)

Flags:
  --dry-run     Read-only diagnosis of the data dir. Mutates nothing.
  --yes, -y     Skip the confirmation prompt (required in non-TTY runs).
  --json        Machine-readable output on stdout.
  --path <dir>  Repair a specific data dir (default: the configured brain).

Notes:
  Auto-repair runs on ordinary commands by default; disable it with
  GBRAIN_PGLITE_WAL_REPAIR=off and use this command deliberately.
  Catalog corruption (58P01 / pgvector load failure) is NOT repairable in
  place — use \`gbrain reinit-pglite\` for that class.`);
}

function emitError(jsonOutput: boolean, code: string, message: string): void {
  if (jsonOutput) {
    console.log(JSON.stringify({ status: 'error', code, message }));
  } else {
    console.error(`Error (${code}): ${message}`);
  }
}

async function promptYesNo(question: string): Promise<boolean> {
  // Prompt on stderr: stdout stays clean for --json payloads.
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

export async function runPgliteRepair(args: string[]): Promise<number> {
  let opts: RepairCmdOpts;
  try {
    opts = parseArgs(args);
  } catch (err) {
    if (err instanceof UnknownFlagError) {
      const jsonOut = args.includes('--json');
      emitError(jsonOut, 'unknown_flag', `${err.message}. Run \`gbrain pglite-repair --help\`.`);
      return 2;
    }
    throw err;
  }
  if (opts.help) {
    printHelp();
    return 0;
  }

  // Resolve dir: --path > config > default brain path. With an explicit
  // --path we skip the engine check (repairing an arbitrary dir is the point).
  let dataDir = opts.customPath;
  if (!dataDir) {
    const cfg = loadConfig();
    if (cfg?.engine !== 'pglite') {
      emitError(
        opts.jsonOutput,
        'not_pglite',
        `gbrain pglite-repair is for PGLite brains (current engine: ${cfg?.engine || 'none'}). ` +
          'Pass --path <dir> to repair a specific data dir.',
      );
      return 1;
    }
    dataDir = cfg.database_path || gbrainPath('brain.pglite');
  }

  // Read-only diagnosis first — BEFORE any lock (acquireLock mkdirs the data
  // dir; a typo'd --path must produce a clean refusal with zero side effects).
  const validation = validateWalRepairTarget(dataDir);
  const diagnosis = inspectPgliteDataDir(dataDir);

  if (opts.dryRun) {
    if (opts.jsonOutput) {
      console.log(JSON.stringify({
        status: 'ok',
        action: 'dry-run',
        data_dir: dataDir,
        validation,
        diagnosis,
      }));
    } else {
      console.log(`PGLite data dir: ${dataDir}`);
      console.log(`  Verdict: ${diagnosis.verdict} — ${diagnosis.detail}`);
      console.log(`  PG_VERSION: ${diagnosis.pgVersion ?? '(unreadable)'}  pg_control: ${diagnosis.pgControlOk ? 'ok (8192 bytes)' : 'BAD'}`);
      console.log(`  WAL segments: ${diagnosis.walSegments.length}  stale postmaster.pid: ${diagnosis.postmasterPid ? 'YES' : 'no'}`);
      console.log(`  Lock: ${diagnosis.lockHeld ? `HELD by live PID ${diagnosis.lockHolderPid}` : 'free'}`);
      if (diagnosis.recentAttempts.length > 0) {
        console.log(`  Repair attempts on record: ${diagnosis.recentAttempts.map((a) => `${a.outcome}@${new Date(a.ts).toISOString()}`).join(', ')}`);
      }
      if (diagnosis.backupDirs.length > 0) {
        console.log(`  Repair backups on disk: ${diagnosis.backupDirs.join(', ')}`);
      }
      if (!validation.ok) {
        console.log(`  Repairable: NO — ${validation.detail}`);
      } else if (diagnosis.verdict === 'looks-healthy') {
        console.log('  Repairable: yes — but no unclean-shutdown markers found; repair is likely');
        console.log('  unnecessary. Run `gbrain pglite-repair --yes` ONLY if PGLite fails to open');
        console.log('  with `RuntimeError: Aborted()` (repair discards the un-checkpointed WAL tail).');
      } else {
        console.log('  Repairable: yes — run `gbrain pglite-repair --yes` to reset the WAL in place.');
      }
    }
    return 0;
  }

  if (!validation.ok) {
    emitError(opts.jsonOutput, `refused_${validation.reason}`, validation.detail);
    return 1;
  }
  if (diagnosis.lockHeld) {
    emitError(
      opts.jsonOutput,
      'refused_locked',
      `another gbrain process (PID ${diagnosis.lockHolderPid}) is using this brain — stop it, then re-run.`,
    );
    return 1;
  }
  const sinceReap = msSinceLastReap(dataDir);
  const REAP_QUARANTINE_MS = 10 * 60 * 1000;
  if (sinceReap !== null && sinceReap >= 0 && sinceReap < REAP_QUARANTINE_MS) {
    emitError(
      opts.jsonOutput,
      'refused_reap_quarantine',
      `a lock on this brain was reaped ${Math.round(sinceReap / 1000)}s ago from a holder whose ` +
        'liveness could not be verified — that process may still be writing. Confirm no gbrain ' +
        `process is running (\`pgrep -af gbrain\`), wait ${Math.ceil((REAP_QUARANTINE_MS - sinceReap) / 60000)} more minute(s), then re-run.`,
    );
    return 1;
  }

  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      emitError(opts.jsonOutput, 'no_tty_no_yes', 'Non-TTY environment requires --yes to confirm the WAL reset.');
      return 1;
    }
    console.error(`About to reset the WAL of ${dataDir} in place.`);
    console.error('Data files are preserved; un-checkpointed transactions may be lost.');
    console.error('The current pg_wal + pg_control are kept in a sibling backup directory.');
    const confirmed = await promptYesNo('Repair now?');
    if (!confirmed) {
      if (opts.jsonOutput) {
        console.log(JSON.stringify({ status: 'aborted', reason: 'user_declined' }));
      } else {
        console.log('Aborted. Data dir untouched.');
      }
      return 0;
    }
  }

  // Short timeout: the diagnosis said the lock is free; if we still can't get
  // it quickly, someone raced us — refuse rather than queue behind them.
  let lock;
  try {
    lock = await acquireLock(dataDir, { timeoutMs: 5_000 });
  } catch (err) {
    if (err instanceof LiveServeLockError) {
      emitError(
        opts.jsonOutput,
        'refused_live_serve',
        `a live \`gbrain serve\` (MCP) process holds this brain — stop \`gbrain serve\` first, then re-run. ${String((err as Error).message)}`,
      );
      return 1;
    }
    emitError(opts.jsonOutput, 'refused_lock_timeout', String((err as Error)?.message ?? err));
    return 1;
  }
  try {
    if (!lock.acquired) {
      emitError(opts.jsonOutput, 'refused_locked', 'could not acquire the PGLite data-dir lock — another gbrain process is using this brain.');
      return 1;
    }
    if (lock.reaped) {
      // A reaped acquisition (dead-PID or corrupt-lock-file reap) cannot prove
      // the prior holder is gone. WAL surgery under a possibly-live writer is
      // never correct — no --force by design.
      emitError(
        opts.jsonOutput,
        'refused_reaped_lock',
        'the data-dir lock was acquired by reaping a prior holder’s lock — ' +
          'another gbrain process may still be using this brain. Confirm no gbrain ' +
          'process is running, then re-run (a cleanly-acquired lock enables repair).',
      );
      return 1;
    }

    // Cheap re-validate under the lock (TOCTOU window between diagnosis and
    // lock acquisition).
    const revalidation = validateWalRepairTarget(dataDir);
    if (!revalidation.ok) {
      emitError(opts.jsonOutput, `refused_${revalidation.reason}`, revalidation.detail);
      return 1;
    }

    process.stderr.write(`Repairing WAL of ${dataDir} in place…\n`);
    const sidecar = readRepairSidecar(dataDir);
    // F4: only reuse a FRESH (<24h) episode backup — a stale pin may predate
    // real data (same bound as the auto seam's episodeFresh).
    const episodeFresh =
      sidecar.episodeStartedAt !== null &&
      Date.now() - sidecar.episodeStartedAt >= 0 &&
      Date.now() - sidecar.episodeStartedAt < 24 * 3600 * 1000;
    let receipt;
    try {
      receipt = await repairPgliteWal(dataDir, {
        reuseBackupPath: episodeFresh ? sidecar.episodeBackupPath ?? undefined : undefined,
      });
    } catch (err) {
      if (err instanceof WalRepairError) {
        // Reset failed after the backup was taken — report the restore's REAL
        // outcome so the user knows whether the dir is back or in reset state.
        recordRepairAttempt(dataDir, 'failed', err.receipt.backupPath);
        emitError(
          opts.jsonOutput,
          'repair_failed',
          err.message + (err.restore.restored
            ? ` (data dir restored to its pre-repair state; backup kept at ${err.receipt.backupPath})`
            : ` (RESTORE ALSO FAILED — the dir is in a reset state; your pre-repair files are intact at ${err.receipt.backupPath}: ${err.restore.detail ?? ''})`),
        );
        return 1;
      }
      recordRepairAttempt(dataDir, 'failed', sidecar.episodeBackupPath);
      emitError(opts.jsonOutput, 'repair_failed', String((err as Error)?.message ?? err));
      return 1;
    }
    // "repaired" here means the reset completed; the next connect PROVES it.
    // Record a FAILED attempt (not repaired-with-closeEpisode:false, which
    // leaves the episode null when none was open — codex): this opens/keeps an
    // episode pinned to this backup so a later healthy connect closes it and
    // prunes, and repeated manual runs during one incident reuse the pinned
    // backup instead of deleting the pre-damage forensic copy.
    recordRepairAttempt(dataDir, 'failed', receipt.backupPath);

    if (opts.jsonOutput) {
      console.log(JSON.stringify({
        status: 'ok',
        action: 'repaired',
        data_dir: receipt.dataDir,
        backup_path: receipt.backupPath,
        backed_up: receipt.backedUpFiles,
        reused_episode_backup: receipt.reusedEpisodeBackup,
        reset_segment: receipt.resetSegment,
        timeline_id: receipt.timelineId,
        wal_seg_size: receipt.walSegSize,
        repaired_at: receipt.repairedAt,
        backups_on_disk: listRepairBackups(dataDir),
      }));
    } else {
      console.log('WAL reset complete.');
      console.log(`  Data dir:      ${receipt.dataDir}`);
      console.log(`  Backup:        ${receipt.backupPath}${receipt.reusedEpisodeBackup ? ' (reused this episode’s existing backup)' : ''}`);
      console.log(`  Reset segment: ${receipt.resetSegment} (timeline ${receipt.timelineId}, ${receipt.walSegSize / (1024 * 1024)}MB segments)`);
      console.log('  Data files were preserved; un-checkpointed transactions may be lost.');
      console.log('  Next: run any gbrain command to reopen the brain, then `gbrain doctor`.');
    }
    return 0;
  } finally {
    await releaseLock(lock);
  }
}
