/**
 * Serve-delegated maintenance sweep — the CLI half (#677).
 *
 * On a PGLite brain a live `gbrain serve` holds the single-writer lock for
 * its lifetime, so `gbrain sweep --once` used to exit 1 with
 * LiveServeLockError. The pre-connect hook in cli.ts calls
 * maybeDelegateSweepToServe: when the holder is a live serve, the sweep runs
 * INSIDE the serve over the resolve-IPC socket (sweep_start / sweep_status;
 * wire shapes in core/context/sweep-ipc.ts, execution in
 * core/serve-sweep-runner.ts) and this module polls to completion and prints
 * the report — same decision ladder as commands/sync-delegate.ts.
 *
 * Returns false = fall through to the normal connect path (no live serve, or
 * an explicit opt-out); true = handled (delegated or politely refused with an
 * exit verdict).
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { serr } from '../core/console-prefix.ts';
import { probeLivePgliteHolder } from '../core/bootstrap/uninstall.ts';
import {
  IPC_UNAVAILABLE,
  readIpcSecret,
  requestSweepStart,
  requestSweepStatus,
  resolveSocketPath,
  type SweepStartIpcResult,
} from '../core/context/resolve-ipc.ts';
import type { DelegatedSweepOptions, SweepStatusResponse } from '../core/context/sweep-ipc.ts';

const POLL_MS = 500;
const MAX_POLL_FAILURES = 60;
const PID_PROBE_EVERY = 5;

async function setVerdict(code: number): Promise<void> {
  const { setCliExitVerdict } = await import('../core/cli-force-exit.ts');
  setCliExitVerdict(code);
}

function remediation(pid: number, extra = ''): string {
  const tail = extra ? ` ${extra}` : '';
  return (
    `Alternatives: stop that serve (kill ${pid}) and re-run, or pass --no-delegate ` +
    `to skip delegation (the run will then fail while the serve holds the lock).${tail}`
  );
}

/** Flags this delegation understands (same default-deny posture as sync). */
const KNOWN_FLAGS = new Set(['--once', '--json', '--no-delegate', '--help', '-h']);
const VALUE_FLAGS = new Set(['--source', '--budget-ms', '--batch-limit']);

export type ParsedDelegatedSweepArgs =
  | { ok: true; options: DelegatedSweepOptions; jsonMode: boolean }
  | { ok: false; refused: string };

/** Pure argv classifier (exported for tests). Default-deny on unknown tokens. */
export function parseDelegatedSweepArgs(args: string[]): ParsedDelegatedSweepArgs {
  const options: DelegatedSweepOptions = {};
  let jsonMode = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.has(a)) {
      const v = args[i + 1];
      if (v === undefined) return { ok: false, refused: `${a} (missing value)` };
      if (a === '--source') options.sourceId = v;
      else {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0) return { ok: false, refused: `${a} ${v}` };
        if (a === '--budget-ms') options.budgetMs = n;
        else options.batchLimit = n;
      }
      i++;
      continue;
    }
    if (KNOWN_FLAGS.has(a)) {
      if (a === '--json') jsonMode = true;
      continue;
    }
    return { ok: false, refused: a };
  }
  return { ok: true, options, jsonMode };
}

/**
 * Delegate `gbrain sweep --once` to a live serve when one holds this PGLite
 * brain's lock. Mirrors maybeDelegateSyncToServe's ladder.
 */
export async function maybeDelegateSweepToServe(dataDir: string, args: string[]): Promise<boolean> {
  // 0. Explicit opt-outs + non-delegatable spellings (help prints locally;
  //    a missing --once is a local usage error).
  if (args.includes('--no-delegate') || process.env.GBRAIN_SWEEP_NO_DELEGATE === '1') return false;
  if (args.includes('--help') || args.includes('-h')) return false;
  if (!args.includes('--once')) return false;
  // 1. Mounts never delegate — the socket/secret/lock belong to the HOST brain.
  try {
    const { resolveBrainId } = await import('../core/brain-resolver.ts');
    const { getCliOptions } = await import('../core/cli-options.ts');
    if (resolveBrainId(getCliOptions().brain) !== 'host') return false;
  } catch { /* resolver trouble → normal path */ }
  // 2. Holder probe (read-only; never reaps).
  const holder = probeLivePgliteHolder(dataDir);
  if (!holder || !holder.serve) return false;

  // 3. Argv gate (default-deny).
  const parsed = parseDelegatedSweepArgs(args);
  if (!parsed.ok) {
    serr(
      `[sweep] a live \`gbrain serve\` (PID ${holder.pid}) holds this PGLite brain, and ` +
      `\`${parsed.refused}\` isn't supported through serve-delegated sweep. ` +
      remediation(holder.pid),
    );
    await setVerdict(1);
    return true;
  }

  // Engine-free source tier (env/dotfile); absent → the serve's bound/default.
  let sourceId = parsed.options.sourceId;
  if (!sourceId) {
    try {
      const { resolveSourceIdEngineFree } = await import('../core/source-resolver.ts');
      const resolved = resolveSourceIdEngineFree(null);
      if (resolved && resolved !== '__all__') sourceId = resolved;
    } catch { /* fall through to the serve's default */ }
  }

  // 4. Socket + secret.
  const sock = resolveSocketPath(dataDir);
  const secret = readIpcSecret(dataDir);
  if (!existsSync(sock) || !secret) {
    serr(
      `[sweep] a live \`gbrain serve\` (PID ${holder.pid}) holds this PGLite brain's ` +
      `single-writer lock but exposes no sweep IPC (older gbrain, or ` +
      `GBRAIN_SERVE_SYNC_IPC=0). ` + remediation(holder.pid, 'Restart that serve on this gbrain version.'),
    );
    await setVerdict(1);
    return true;
  }

  const options: DelegatedSweepOptions = { ...parsed.options, ...(sourceId ? { sourceId } : {}) };
  const clientToken = randomUUID();

  let start = await requestSweepStart(sock, { secret, clientToken, options });
  if (start === IPC_UNAVAILABLE) {
    const still = probeLivePgliteHolder(dataDir);
    if (!still || !still.serve) return false;
    start = await requestSweepStart(sock, { secret, clientToken, options });
    if (start === IPC_UNAVAILABLE) {
      serr(
        `[sweep] the live \`gbrain serve\` (PID ${holder.pid}) is not answering its IPC socket. ` +
        remediation(holder.pid, 'It may be wedged.'),
      );
      await setVerdict(1);
      return true;
    }
  }
  if ('degraded' in (start as object)) {
    serr(
      `[sweep] the running \`gbrain serve\` (PID ${holder.pid}) predates serve-delegated sweep. ` +
      remediation(holder.pid, 'Restart it on this gbrain version.'),
    );
    await setVerdict(1);
    return true;
  }
  const startResp = start as Exclude<SweepStartIpcResult, typeof IPC_UNAVAILABLE | { degraded: string }>;
  if (!startResp.ok) {
    const messages: Record<string, string> = {
      busy: `another delegated sweep is already running inside the serve — wait a moment and re-run.`,
      unauthorized: `the serve rejected the IPC secret — restart the serve (it re-provisions \`.gbrain-ipc-secret\`) and re-run.`,
      source_mismatch: `the serve is bound to a different source — run \`gbrain sweep --once --source <the serve's source>\`, or stop the serve.`,
      unsupported_kind: `the serve has delegation disabled (GBRAIN_SERVE_SYNC_IPC=0, an older serve, or a startup failure).`,
    };
    const detail = messages[startResp.error ?? ''] ??
      `the serve refused the delegated sweep (${startResp.error}).`;
    serr(`[sweep] ${detail} ${remediation(holder.pid, '')}`);
    await setVerdict(1);
    return true;
  }

  const jobId = startResp.jobId!;
  serr(
    `[sweep] live \`gbrain serve\` (PID ${holder.pid}) holds the PGLite lock — running ` +
    `the sweep inside it (job ${jobId}).`,
  );

  // Poll to completion (a sweep is bounded — default 5s budget).
  let failures = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const s = await requestSweepStatus(sock, { secret, jobId });
    if (s === IPC_UNAVAILABLE || 'degraded' in (s as object)) {
      failures++;
      if (failures % PID_PROBE_EVERY === 0) {
        const still = probeLivePgliteHolder(dataDir);
        if (!still || !still.serve) {
          serr(`[sweep] the serve (PID ${holder.pid}) died mid-sweep — re-run \`gbrain sweep --once\`.`);
          await setVerdict(1);
          return true;
        }
      }
      if (failures >= MAX_POLL_FAILURES) {
        serr(`[sweep] the serve (PID ${holder.pid}) stopped answering its IPC socket mid-sweep.`);
        await setVerdict(1);
        return true;
      }
      continue;
    }
    failures = 0;
    const status = s as SweepStatusResponse;
    if (!status.ok) {
      serr(
        status.error === 'unknown_job'
          ? `[sweep] the serve restarted mid-sweep (job ${jobId} is gone) — re-run \`gbrain sweep --once\`.`
          : `[sweep] delegated sweep failed: ${status.error}`,
      );
      await setVerdict(1);
      return true;
    }
    if (status.state === 'error') {
      serr(`[sweep] delegated sweep failed inside the serve: ${status.jobError ?? 'unknown error'}`);
      await setVerdict(1);
      return true;
    }
    if (status.state === 'done' && status.report) {
      const report = status.report;
      if (parsed.jsonMode) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(`Sweep complete (${report.durationMs}ms, source=${status.sourceId ?? 'default'}, via serve PID ${holder.pid}):`);
        console.log(`  facts reconciled:   ${report.factsReconciled}`);
        console.log(`  links extracted:    ${report.linksExtracted}`);
        console.log(`  links removed:      ${report.linksRemoved}`);
        console.log(`  timeline extracted: ${report.timelineExtracted}`);
        console.log(`  corpus ingested:    ${report.corpusIngested}`);
        if (report.skipped.length > 0) {
          console.log('  skipped:');
          for (const sk of report.skipped) console.log(`    ${sk.reason}: ${sk.count}`);
        }
      }
      // Mirror runSweep's exit rule: total failure exits nonzero.
      const { isTotalFailure } = await import('./sweep.ts');
      if (isTotalFailure(report)) {
        serr('[sweep] total failure — every pass errored. See skipped reasons above.');
        await setVerdict(1);
      }
      return true;
    }
    // running → keep polling.
  }
}
