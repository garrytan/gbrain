/**
 * Serve-delegated sync — the CLI half (decision ladder + poll loop).
 *
 * On a PGLite brain a live `gbrain serve` holds the single-writer lock for
 * its lifetime, so `gbrain sync` cannot open the brain (LiveServeLockError
 * since #2348 — a live holder is never displaced). Instead of failing, the
 * pre-connect hook in cli.ts calls maybeDelegateSyncToServe: when the holder
 * is a live serve, the sync runs INSIDE the serve over the resolve-IPC socket
 * (sync_start / sync_status / sync_abort; wire shapes in
 * core/context/sync-ipc.ts, execution in core/serve-sync-runner.ts) and this
 * module polls progress and prints the result.
 *
 * Decision ladder (returns false = fall through to the normal connect path):
 *   0. --no-delegate / GBRAIN_SYNC_NO_DELEGATE=1 → false (opt-out).
 *   1. Non-host brain (mounts) → false — delegation targets the host data dir.
 *   2. No live holder, or a live NON-serve holder → false (existing behavior:
 *      dead-PID reap / bounded wait in acquireLock).
 *   3. Live serve + any argv token outside the explicit allowlist →
 *      DEFAULT-DENY refusal naming the flag (a silently-dropped --exclude
 *      would perform the WRONG sync; refusing is the only safe default).
 *   4. Live serve + socket answers → delegate: banner, 1s status polls,
 *      Ctrl-C → sync_abort (second Ctrl-C hard-exits), printSyncResult.
 *   5. Live serve + no socket / stale serve / unauthorized → polite typed
 *      refusal with remediation, exit verdict 1 — never a raw stack.
 *
 * Every refusal names three ways out: drop the flag (when flag-caused), stop
 * the serve, or --no-delegate.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { serr } from '../core/console-prefix.ts';
import { probeLivePgliteHolder } from '../core/bootstrap/uninstall.ts';
import {
  IPC_UNAVAILABLE,
  readIpcSecret,
  requestSyncAbort,
  requestSyncStart,
  requestSyncStatus,
  resolveSocketPath,
  type SyncStartIpcResult,
} from '../core/context/resolve-ipc.ts';
import type { DelegatedSyncOptions, SyncStatusResponse, WireSyncResult } from '../core/context/sync-ipc.ts';
import type { SyncResult } from './sync.ts';

/** Poll cadence for sync_status while a delegated job runs. */
const POLL_MS = 1000;
/**
 * Consecutive failed polls tolerated before declaring the socket dead. A
 * delegated import can block the serve's event loop for stretches (long
 * synchronous WASM statements), so transient timeouts are EXPECTED; the PID
 * probe below distinguishes "busy" from "gone" every PID_PROBE_EVERY misses.
 */
const MAX_POLL_FAILURES = 60;
const PID_PROBE_EVERY = 5;

/**
 * Flags forwardable over the wire (boolean → DelegatedSyncOptions field).
 * Everything not in this table, VALUE_FLAGS, or IGNORED_FLAGS refuses —
 * default-deny is what keeps a future flag from being silently dropped.
 */
export const WIRE_BOOL_FLAGS: Record<string, keyof DelegatedSyncOptions> = {
  '--full': 'full',
  '--dry-run': 'dryRun',
  '--no-pull': 'noPull',
  '--no-embed': 'noEmbed',
  '--no-extract': 'noExtract',
  '--no-schema-pack': 'noSchemaPack',
  '--skip-failed': 'skipFailed',
  '--retry-failed': 'retryFailed',
  '--include-gitignored': 'includeGitignored',
};
/** Value-taking flags the ladder consumes itself (never forwarded verbatim). */
export const VALUE_FLAGS = new Set(['--source', '--timeout', '--hard-deadline']);
/** Flags that are meaningful only outside delegation (or handled pre-ladder). */
export const IGNORED_FLAGS = new Set(['--yes', '--no-delegate', '--no-hard-deadline']);

export type ParsedDelegatedArgs =
  | { ok: true; options: Omit<DelegatedSyncOptions, 'timeoutSeconds'>; explicitSource: string | null }
  | { ok: false; refused: string };

/**
 * Pure argv classifier (exported for the drift-pin test). timeoutSeconds is
 * derived separately (resolveSyncHardDeadline needs env/TTY context).
 */
export function parseDelegatedSyncArgs(args: string[]): ParsedDelegatedArgs {
  const options: Record<string, unknown> = {};
  let explicitSource: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (WIRE_BOOL_FLAGS[tok]) {
      options[WIRE_BOOL_FLAGS[tok]] = true;
      continue;
    }
    if (IGNORED_FLAGS.has(tok)) continue;
    if (VALUE_FLAGS.has(tok)) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) return { ok: false, refused: `${tok} (missing value)` };
      if (tok === '--source') explicitSource = v;
      i++; // --timeout / --hard-deadline are consumed by the deadline derivation
      continue;
    }
    // Default-deny: subcommands (`trigger`), unsupported flags (--repo,
    // --all, --watch, --exclude, --workers, --json, …) and anything future.
    return { ok: false, refused: tok };
  }
  return { ok: true, options: options as Omit<DelegatedSyncOptions, 'timeoutSeconds'>, explicitSource };
}

/**
 * The client's hard deadline for the delegated job, in seconds. 0 = the user
 * explicitly waived the bound (--no-hard-deadline) — the ONLY unbounded
 * encoding; an interactive TTY default (null from resolveSyncHardDeadline)
 * maps to the same 3600s the non-TTY default uses, so a job whose client
 * dies is always bounded.
 */
export async function deriveDelegatedTimeoutSeconds(
  args: string[],
  opts: { isTty?: boolean; env?: Record<string, string | undefined> } = {},
): Promise<number> {
  if (args.includes('--no-hard-deadline')) return 0;
  const { resolveSyncHardDeadline } = await import('../core/sync-reconcile.ts');
  const res = resolveSyncHardDeadline(args, {
    isTty: opts.isTty ?? Boolean(process.stdout.isTTY),
    env: opts.env ?? process.env,
  });
  if (!res) return 3600;
  return Math.max(1, Math.round(res.deadlineMs / 1000));
}

async function setVerdict(code: number): Promise<void> {
  const { setCliExitVerdict } = await import('../core/cli-force-exit.ts');
  setCliExitVerdict(code);
}

function remediation(pid: number, extra?: string): string {
  return (
    (extra ? `${extra} ` : '') +
    `Ways out: ${extra ? '' : 'drop the unsupported flag, '}stop the serve (PID ${pid}) and re-run, ` +
    `or pass --no-delegate to skip delegation.`
  );
}

/**
 * Pre-connect delegation ladder. Returns true when the sync was HANDLED here
 * (delegated to a live serve, or politely refused with the exit verdict set);
 * false falls through to the normal connectEngine path unchanged.
 */
export async function maybeDelegateSyncToServe(dataDir: string, args: string[]): Promise<boolean> {
  // 0. Explicit opt-outs.
  if (args.includes('--no-delegate') || process.env.GBRAIN_SYNC_NO_DELEGATE === '1') return false;
  // 1. Mounts never delegate — the socket/secret/lock all belong to the HOST
  //    brain's data dir; a mounted brain's sync must take the normal path.
  try {
    const { resolveBrainId } = await import('../core/brain-resolver.ts');
    const { getCliOptions } = await import('../core/cli-options.ts');
    if (resolveBrainId(getCliOptions().brain) !== 'host') return false;
  } catch { /* resolver trouble → normal path (fail open to old behavior) */ }
  // 2. Holder probe (read-only; never reaps).
  const holder = probeLivePgliteHolder(dataDir);
  if (!holder || !holder.serve) return false;

  // 3. Argv gate (default-deny).
  const parsed = parseDelegatedSyncArgs(args);
  if (!parsed.ok) {
    serr(
      `[sync] a live \`gbrain serve\` (PID ${holder.pid}) holds this PGLite brain, and ` +
      `\`${parsed.refused}\` isn't supported through serve-delegated sync. ` +
      remediation(holder.pid),
    );
    await setVerdict(1);
    return true;
  }

  // Engine-free source tiers (env var, .gbrain-source dotfile) — the client
  // has no engine to run the DB tiers; absent → the serve's bound/default.
  let sourceId: string | undefined;
  try {
    const { resolveSourceIdEngineFree } = await import('../core/source-resolver.ts');
    const resolved = resolveSourceIdEngineFree(parsed.explicitSource);
    if (resolved === '__all__') {
      serr(
        `[sync] --source __all__ isn't supported through serve-delegated sync (the client has ` +
        `no engine to enumerate sources). ${remediation(holder.pid, 'Sync one source at a time (--source <id>).')}`,
      );
      await setVerdict(1);
      return true;
    }
    sourceId = resolved ?? undefined;
  } catch (e) {
    serr(`[sync] ${e instanceof Error ? e.message : String(e)}`);
    await setVerdict(1);
    return true;
  }

  // 4. Socket + secret.
  const sock = resolveSocketPath(dataDir);
  const secret = readIpcSecret(dataDir);
  if (!existsSync(sock) || !secret) {
    serr(
      `[sync] a live \`gbrain serve\` (PID ${holder.pid}) holds this PGLite brain's ` +
      `single-writer lock but exposes no sync IPC (older gbrain, \`serve --http\`, or ` +
      `GBRAIN_SERVE_SYNC_IPC=0). ` + remediation(holder.pid, 'Restart that serve on this gbrain version.'),
    );
    await setVerdict(1);
    return true;
  }

  const options: DelegatedSyncOptions = {
    ...parsed.options,
    ...(sourceId ? { sourceId } : {}),
    timeoutSeconds: await deriveDelegatedTimeoutSeconds(args),
  };
  const clientToken = randomUUID();

  let start = await requestSyncStart(sock, { secret, clientToken, options });
  if (start === IPC_UNAVAILABLE) {
    // Race: the serve may have died between probe and connect — or it started
    // the job and the ack was lost. Re-probe; alive → ONE retry with the SAME
    // token (busy/attach semantics make it safe), dead → normal path.
    const still = probeLivePgliteHolder(dataDir);
    if (!still || !still.serve) return false;
    start = await requestSyncStart(sock, { secret, clientToken, options });
    if (start === IPC_UNAVAILABLE) {
      serr(
        `[sync] the live \`gbrain serve\` (PID ${holder.pid}) is not answering its IPC socket. ` +
        remediation(holder.pid, 'It may be wedged.'),
      );
      await setVerdict(1);
      return true;
    }
  }
  if ('degraded' in (start as object)) {
    serr(
      `[sync] the running \`gbrain serve\` (PID ${holder.pid}) predates serve-delegated sync. ` +
      remediation(holder.pid, 'Restart it on this gbrain version.'),
    );
    await setVerdict(1);
    return true;
  }
  const startResp = start as Exclude<SyncStartIpcResult, typeof IPC_UNAVAILABLE | { degraded: string }>;
  if (!startResp.ok) {
    const messages: Record<string, string> = {
      busy: `another delegated sync (job ${startResp.jobId ?? '?'}) is already running inside the serve — wait for it to finish and re-run.`,
      unauthorized: `the serve rejected the IPC secret — restart the serve (it re-provisions \`.gbrain-ipc-secret\`) and re-run.`,
      shutting_down: `the serve is shutting down — re-run in a moment (or after it exits, sync runs directly).`,
      source_mismatch: `the serve is bound to a different source than this sync targets — run \`gbrain sync --source <the serve's source>\`, or stop the serve to sync this source directly.`,
      unsupported_kind: `the serve has sync delegation disabled (GBRAIN_SERVE_SYNC_IPC=0 or a startup failure).`,
    };
    const detail = messages[startResp.error ?? ''] ??
      `the serve refused the delegated sync (${startResp.error}).`;
    serr(`[sync] ${detail} ${remediation(holder.pid, '')}`);
    await setVerdict(1);
    return true;
  }

  const jobId = startResp.jobId!;
  if (startResp.completed) {
    serr(`[sync] attached to an already-completed delegated sync (job ${jobId}).`);
  } else {
    serr(
      `[sync] live \`gbrain serve\` (PID ${holder.pid}) holds the PGLite lock — delegating ` +
      `the sync through it (job ${jobId}; Ctrl-C aborts, progress is checkpointed).`,
    );
  }

  return pollToCompletion({ dataDir, sock, secret, jobId, pid: holder.pid, options });
}

async function pollToCompletion(ctx: {
  dataDir: string;
  sock: string;
  secret: string;
  jobId: string;
  pid: number;
  options: DelegatedSyncOptions;
}): Promise<boolean> {
  const { dataDir, sock, secret, jobId, pid, options } = ctx;
  let failures = 0;
  let lastPhase: string | undefined;
  let lastBanked: number | undefined;
  let abortRequested = false;

  const onSigint = () => {
    if (abortRequested) process.exit(130);
    abortRequested = true;
    serr('[sync] Ctrl-C — aborting the delegated sync (progress is checkpointed; re-run to resume). Ctrl-C again to exit without waiting.');
    void requestSyncAbort(sock, { secret, jobId });
    process.once('SIGINT', onSigint);
  };
  process.once('SIGINT', onSigint);

  const crashHint = () =>
    serr(
      `[sync] progress is checkpointed — re-run \`gbrain sync\` to resume. Note: the dead ` +
      `serve's sync lock row may take up to 60s to become reclaimable; if the re-run reports ` +
      `a dead-PID lock, \`gbrain sync --break-lock\` clears it.`,
    );

  try {
    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const s = await requestSyncStatus(sock, { secret, jobId });
      if (s === IPC_UNAVAILABLE || 'degraded' in (s as object)) {
        failures++;
        if (failures % PID_PROBE_EVERY === 0) {
          const still = probeLivePgliteHolder(dataDir);
          if (!still || !still.serve) {
            serr(`[sync] the serve (PID ${pid}) died mid-sync.`);
            crashHint();
            await setVerdict(1);
            return true;
          }
        }
        if (failures >= MAX_POLL_FAILURES) {
          serr(`[sync] the serve (PID ${pid}) stopped answering its IPC socket mid-sync.`);
          crashHint();
          await setVerdict(1);
          return true;
        }
        continue;
      }
      failures = 0;
      const status = s as SyncStatusResponse;
      if (!status.ok) {
        if (status.error === 'unknown_job') {
          serr(`[sync] the serve restarted mid-sync (job ${jobId} is gone).`);
          crashHint();
        } else {
          serr(`[sync] delegated sync failed: ${status.error}`);
        }
        await setVerdict(1);
        return true;
      }
      if (status.phase && status.phase !== lastPhase) {
        lastPhase = status.phase;
        serr(`[sync] serve: ${status.phase}`);
      }
      if (status.bankedFiles !== undefined && status.bankedFiles !== lastBanked) {
        lastBanked = status.bankedFiles;
        serr(`[sync] serve: banked ${status.bankedFiles} file(s)`);
      }
      if (status.state === 'error') {
        serr(`[sync] delegated sync failed inside the serve: ${status.jobError ?? 'unknown error'}`);
        await setVerdict(1);
        return true;
      }
      if (status.state === 'done' && status.result) {
        await printDelegatedResult(status.result, options);
        return true;
      }
      // running / aborting → keep polling.
    }
  } finally {
    process.off('SIGINT', onSigint);
  }
}

async function printDelegatedResult(wire: WireSyncResult, options: DelegatedSyncOptions): Promise<void> {
  const { printSyncResult } = await import('./sync.ts');
  const { pagesAffectedTotal, ...rest } = wire;
  const result: SyncResult = { ...rest, pagesAffected: wire.pagesAffected };
  printSyncResult(result);
  if (pagesAffectedTotal > wire.pagesAffected.length) {
    serr(`[sync] (+${pagesAffectedTotal - wire.pagesAffected.length} more pages affected — list truncated for the IPC wire)`);
  }
  if (!options.dryRun && !options.noEmbed && result.added + result.modified > 0) {
    serr('[sync] embeds deferred — the serve drains them in background sweeps (its environment/keys apply).');
  }
  // Mirror runSync's verdict rule (#3068): a pull_failed partial will not
  // self-heal — exit non-zero so cron sees the wedge.
  if (result.status === 'partial' && result.reason === 'pull_failed') {
    await setVerdict(1);
  }
}
