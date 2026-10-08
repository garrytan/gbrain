/**
 * Serve-delegated sync — the CLI half (decision ladders + poll loop).
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
 * PGLite decision ladder (returns false = fall through to the normal connect path):
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
 *
 * #6317 (D1 a′), Postgres managed brains: maybeDelegateManagedSyncToServe is
 * the same family one rung later. Postgres has no lock to lose, so the CLI
 * connects as usual and `runSingleSourceSync` asks this ladder right before
 * `performSync`: when a live full `serve` consumer owns this host (the B3
 * heartbeat row in `persistence_consumers`, read through the database, never
 * a socket), the managed drain runs inside that serve as THIS CLI's verified
 * `cli` writer (the registration rides in sync_start) and the CLI prints the
 * drain's own lines from sync_status. The result comes back as a SyncResult,
 * so the caller's printing, JSON envelope and exit verdict are the in-process
 * ones. Every rung that cannot delegate falls back to today's own consumer
 * with ONE actionable line, never a refusal: an unsupported flag, a missing
 * socket, GBRAIN_SERVE_SYNC_IPC=0, an older serve (`unknown_kind` /
 * `stale_serve` / `unsupported_kind`), a serve bound to another source, or a
 * serve that dies mid-drain (the durable cursor resumes in-process). Only an
 * authorization refusal of the hand-off is terminal, thrown as the same
 * OperationError the in-process path would raise.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { serr } from '../core/console-prefix.ts';
import { probeLivePgliteHolder } from '../core/bootstrap/uninstall.ts';
import {
  IPC_UNAVAILABLE,
  hookResolveSocketForConfig,
  readIpcSecret,
  readIpcSecretForConfig,
  requestSyncAbort,
  requestSyncStart,
  requestSyncStatus,
  resolveSocketPath,
  type IpcPathConfig,
  type SyncStartIpcResult,
} from '../core/context/resolve-ipc.ts';
import {
  DELEGATED_SYNC_LANES_MAX,
  type DelegatedSyncOptions,
  type SyncStartRegistration,
  type SyncStatusResponse,
  type WireSyncResult,
} from '../core/context/sync-ipc.ts';
import { OperationError } from '../core/ops/contract.ts';
import type { BrainEngine } from '../core/engine.ts';
import type { ConsumerRow } from '../core/persistence/consumer-heartbeat.ts';
import type { SyncOpts, SyncResult } from './sync.ts';

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
  '--no-bulk': 'noBulk',
};
/** Value-taking flags the ladder consumes itself (`--lanes` is validated and forwarded; the deadlines are derived). */
export const VALUE_FLAGS = new Set(['--source', '--timeout', '--hard-deadline', '--lanes']);
/** Flags that are meaningful only outside delegation, handled pre-ladder, or rendered by this client (`--json`). */
export const IGNORED_FLAGS = new Set(['--yes', '--no-delegate', '--no-hard-deadline', '--json']);
/** `--no-lanes` is `--lanes 1` (`src/commands/sync/args.ts`). */
const NO_LANES_FLAG = '--no-lanes';

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
    if (tok === NO_LANES_FLAG) {
      options.lanes = 1;
      continue;
    }
    if (IGNORED_FLAGS.has(tok)) continue;
    if (VALUE_FLAGS.has(tok)) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) return { ok: false, refused: `${tok} (missing value)` };
      if (tok === '--source') explicitSource = v;
      if (tok === '--lanes') {
        const lanes = Number(v);
        if (!Number.isInteger(lanes) || lanes < 1 || lanes > DELEGATED_SYNC_LANES_MAX) return { ok: false, refused: `${tok} (invalid value)` };
        options.lanes = lanes;
      }
      i++; // --timeout / --hard-deadline are consumed by the deadline derivation
      continue;
    }
    // Default-deny: subcommands (`trigger`), unsupported flags (--repo,
    // --all, --watch, --exclude, --workers, …) and anything future.
    return { ok: false, refused: tok };
  }
  const explicitProcessing = (['noEmbed', 'noExtract', 'noSchemaPack'] as const).filter(key => options[key] === true);
  if (explicitProcessing.length) options.explicitProcessing = explicitProcessing;
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
    serr(`[sync] ${startRefusalText(startResp)} ${remediation(holder.pid, '')}`);
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

  const polled = await pollDelegatedJob({
    sock, secret, jobId, pid: holder.pid,
    alive: () => { const still = probeLivePgliteHolder(dataDir); return !!still && still.serve; },
  });
  if (polled.kind === 'lost') { await setVerdict(1); return true; }
  if (polled.kind === 'failed') {
    if (polled.error instanceof OperationError) {
      const { reportPersistenceCliError } = await import('./persistence-delegate.ts');
      if (await reportPersistenceCliError(polled.error, args.includes('--json'))) return true;
    }
    serr(`[sync] delegated sync failed inside the serve: ${polled.error.message}`);
    await setVerdict(1);
    return true;
  }
  await printDelegatedResult(polled.result, options, { args, sourceId: polled.status.sourceId ?? sourceId ?? 'default', json: args.includes('--json') });
  return true;
}

function startRefusalText(resp: { error?: string; jobId?: string }): string {
  const messages: Record<string, string> = {
    busy: `another delegated sync (job ${resp.jobId ?? '?'}) is already running inside the serve — wait for it to finish and re-run.`,
    unauthorized: `the serve rejected the IPC secret — restart the serve (it re-provisions \`.gbrain-ipc-secret\`) and re-run.`,
    shutting_down: `the serve is shutting down — re-run in a moment (or after it exits, sync runs directly).`,
    source_mismatch: `the serve is bound to a different source than this sync targets — run \`gbrain sync --source <the serve's source>\`, or stop the serve to sync this source directly.`,
    unsupported_kind: `the serve has sync delegation disabled (GBRAIN_SERVE_SYNC_IPC=0 or a startup failure).`,
  };
  return messages[resp.error ?? ''] ?? `the serve refused the delegated sync (${resp.error}).`;
}

/** The serve's `refusal` / `jobErrorEnvelope` (an OperationError.toJSON()) back into the error the in-process path throws. */
export function operationErrorFromEnvelope(envelope: Record<string, unknown>): OperationError {
  const code = typeof envelope.error === 'string' ? envelope.error : typeof envelope.code === 'string' ? envelope.code : 'unavailable';
  const error = new OperationError(code as OperationError['code'], typeof envelope.message === 'string' ? envelope.message : 'The serve refused the delegated sync.',
    typeof envelope.suggestion === 'string' ? envelope.suggestion : undefined, typeof envelope.docs === 'string' ? envelope.docs : undefined);
  if (typeof envelope.code === 'string' && envelope.code !== code) error.canonical = envelope.code as OperationError['canonical'];
  if (typeof envelope.detail === 'string') error.detail = envelope.detail;
  if (typeof envelope.reason === 'string') error.reason = envelope.reason;
  if (typeof envelope.why === 'string') error.why = envelope.why;
  if (envelope.fix && typeof envelope.fix === 'object') error.fix = envelope.fix as OperationError['fix'];
  if (envelope.contract_version === 1) error.contractVersion = 1;
  return error;
}

type PolledJob =
  | { kind: 'done'; result: WireSyncResult; status: SyncStatusResponse }
  | { kind: 'failed'; error: Error }
  /** The serve died, restarted or stopped answering; the failure was printed. */
  | { kind: 'lost' };

/**
 * Shared poll loop. Prints the job's human lines (a managed drain's own
 * progress, stall and lanes lines) or, for a legacy job, phase changes and
 * banked counts. `signal` (the caller's deadline or interrupt) and Ctrl-C both
 * send sync_abort once and keep polling until the serve settles the typed
 * partial; a second Ctrl-C exits without waiting. `alive` tells a busy serve
 * (transient poll timeouts) from a dead one.
 */
async function pollDelegatedJob(ctx: {
  sock: string;
  secret: string;
  jobId: string;
  pid: number;
  alive: () => boolean | Promise<boolean>;
  signal?: AbortSignal;
}): Promise<PolledJob> {
  const { sock, secret, jobId, pid } = ctx;
  let failures = 0;
  let lastPhase: string | undefined;
  let lastBanked: number | undefined;
  let afterLine = 0;
  let abortRequested = false;

  const abort = (why: string): void => {
    if (abortRequested) return;
    abortRequested = true;
    serr(`[sync] ${why} — aborting the delegated sync (progress is checkpointed; re-run to resume).`);
    void requestSyncAbort(sock, { secret, jobId });
  };
  const onSigint = () => {
    if (abortRequested) process.exit(130);
    abort('Ctrl-C');
    serr('[sync] Ctrl-C again to exit without waiting.');
    process.once('SIGINT', onSigint);
  };
  process.once('SIGINT', onSigint);
  const onAbort = () => abort('deadline reached');
  ctx.signal?.addEventListener('abort', onAbort, { once: true });

  const crashHint = () =>
    serr(
      `[sync] progress is checkpointed — re-run \`gbrain sync\` to resume. Note: the dead ` +
      `serve's sync lock row may take up to 60s to become reclaimable; if the re-run reports ` +
      `a dead-PID lock, \`gbrain sync --break-lock\` clears it.`,
    );

  try {
    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const s = await requestSyncStatus(sock, { secret, jobId, afterLine });
      if (s === IPC_UNAVAILABLE || 'degraded' in (s as object)) {
        failures++;
        if (failures % PID_PROBE_EVERY === 0 && !(await ctx.alive())) {
          serr(`[sync] the serve (PID ${pid}) died mid-sync.`);
          crashHint();
          return { kind: 'lost' };
        }
        if (failures >= MAX_POLL_FAILURES) {
          serr(`[sync] the serve (PID ${pid}) stopped answering its IPC socket mid-sync.`);
          crashHint();
          return { kind: 'lost' };
        }
        continue;
      }
      failures = 0;
      const status = s as SyncStatusResponse;
      if (!status.ok) {
        if (status.error === 'unknown_job') {
          serr(`[sync] the serve restarted mid-sync (job ${jobId} is gone).`);
          crashHint();
          return { kind: 'lost' };
        }
        return { kind: 'failed', error: new Error(`delegated sync failed: ${status.error}`) };
      }
      if (status.managed) {
        for (const line of status.lines ?? []) {
          process.stderr.write(line.text + '\n');
          afterLine = Math.max(afterLine, line.seq);
        }
      } else {
        if (status.phase && status.phase !== lastPhase) {
          lastPhase = status.phase;
          serr(`[sync] serve: ${status.phase}`);
        }
        if (status.bankedFiles !== undefined && status.bankedFiles !== lastBanked) {
          lastBanked = status.bankedFiles;
          serr(`[sync] serve: banked ${status.bankedFiles} file(s)`);
        }
      }
      if (status.state === 'error') {
        return { kind: 'failed', error: status.jobErrorEnvelope ? operationErrorFromEnvelope(status.jobErrorEnvelope) : new Error(status.jobError ?? 'unknown error') };
      }
      if (status.state === 'done' && status.result) return { kind: 'done', result: status.result, status };
      // running / aborting → keep polling.
    }
  } finally {
    process.off('SIGINT', onSigint);
    ctx.signal?.removeEventListener('abort', onAbort);
  }
}

/** The wire result as the SyncResult the in-process printers take (the page list is capped on the wire). */
export function syncResultFromWire(wire: WireSyncResult): { result: SyncResult; pagesAffectedTotal: number } {
  const { pagesAffectedTotal, ...rest } = wire;
  return { result: { ...rest, pagesAffected: wire.pagesAffected }, pagesAffectedTotal };
}

async function printDelegatedResult(wire: WireSyncResult, options: DelegatedSyncOptions, ctx: { args: string[]; sourceId: string; json: boolean }): Promise<void> {
  const { printSyncResult } = await import('./sync.ts');
  const { result, pagesAffectedTotal } = syncResultFromWire(wire);
  const human = ctx.json ? process.stderr : process.stdout;
  printSyncResult(result, human);
  if (pagesAffectedTotal > wire.pagesAffected.length) {
    serr(`[sync] (+${pagesAffectedTotal - wire.pagesAffected.length} more pages affected — list truncated for the IPC wire)`);
  }
  if (!options.dryRun && !options.noEmbed && result.added + result.modified > 0) {
    serr('[sync] embeds deferred — the serve drains them in background sweeps (its environment/keys apply).');
  }
  const { drainJsonFields, formatDrainSummary, syncOutcome } = await import('../core/persistence/sync-drain.ts');
  const { syncResumeCommand } = await import('../core/sync-reconcile.ts');
  const { getCliOptions } = await import('../core/cli-options.ts');
  const resume = syncResumeCommand(ctx.args.filter(a => a !== '--json'), getCliOptions().brain);
  for (const line of formatDrainSummary(result, resume, ctx.sourceId)) human.write(line + '\n');
  if (ctx.json) {
    // The single-source envelope the in-process `--json` path emits (#4888: stdout carries that one document).
    const { buildSingleSyncJsonEnvelope } = await import('../core/sync-embed-backfill.ts');
    const { writeStdoutFinal } = await import('../core/cli-force-exit.ts');
    await writeStdoutFinal(JSON.stringify({ ...buildSingleSyncJsonEnvelope(ctx.sourceId, result),
      ...(result.managedWrite ? { managed_write: result.managedWrite } : {}), ...drainJsonFields(result, resume, ctx.sourceId) }) + '\n');
  }
  // Mirror runSync's verdict rule (#3068): a pull_failed partial will not
  // self-heal — exit non-zero so cron sees the wedge. #5984: a blocked drain too.
  if ((result.status === 'partial' && result.reason === 'pull_failed') || syncOutcome(result) === 'blocked') {
    await setVerdict(1);
  }
}

// ── #6317: Postgres managed brains ─────────────────────────────────────────

/** Test seams for the Postgres ladder: the brain config, the heartbeat probe and the socket/secret discovery. */
export interface ManagedDelegationDeps {
  config?: IpcPathConfig | null;
  probe?: (engine: BrainEngine) => Promise<ConsumerRow | null>;
  socket?: (sourceId: string) => Promise<{ sock: string | null; secret: string | null }>;
  env?: Record<string, string | undefined>;
}

export type ManagedDelegationOutcome =
  | { kind: 'delegated'; result: SyncResult; pid: number }
  /** Not delegated; `reason` names the rung, `line` is the one line printed (null when nothing was printed). */
  | { kind: 'own_consumer'; reason: 'opted_out' | 'not_host' | 'not_postgres' | 'not_managed' | 'no_owner' | 'owner_not_serve' | 'probe_failed'
      | 'kill_switch' | 'unsupported_flag' | 'no_socket' | 'older_serve' | 'serve_refused' | 'serve_lost'; line: string | null };

const fallbackLine = (pid: number, cause: string, fix = 'Restart that serve on this gbrain version to remove the second consumer.'): string =>
  `[sync] ${cause}; this run uses its own consumer beside the serve (PID ${pid}). ${fix}`;

/**
 * The Postgres rung of the delegation ladder (#6317). Called with the connected
 * engine and the sync's resolved options right before `performSync`; returns
 * the drain's SyncResult when the resident serve ran it, else the rung that
 * kept today's own consumer. Throws the hand-off's authorization refusal
 * (denied, revoked or stdio registration) as the OperationError the in-process
 * `managedSyncAuthority` would have thrown.
 */
export async function maybeDelegateManagedSyncToServe(engine: BrainEngine, args: string[], opts: SyncOpts, deps: ManagedDelegationDeps = {}): Promise<ManagedDelegationOutcome> {
  const env = deps.env ?? process.env;
  const own = (reason: Extract<ManagedDelegationOutcome, { kind: 'own_consumer' }>['reason'], line: string | null = null): ManagedDelegationOutcome => {
    if (line) serr(line);
    return { kind: 'own_consumer', reason, line };
  };
  // 0. Opt-outs bypass the ladder before anything is probed or classified.
  if (args.includes('--no-delegate') || env.GBRAIN_SYNC_NO_DELEGATE === '1') return own('opted_out');
  const { resolveBrainId } = await import('../core/brain-resolver.ts');
  const { getCliOptions } = await import('../core/cli-options.ts');
  if (resolveBrainId(getCliOptions().brain) !== 'host') return own('not_host');
  // The host brain's config decides the engine (the PGLite ladder ran pre-connect; a PGLite mount never reaches here).
  const cfg = deps.config !== undefined ? deps.config : (await import('../core/config.ts')).loadConfig();
  if (cfg?.engine !== 'postgres' || !cfg.database_url) return own('not_postgres');
  const sourceId = opts.sourceId ?? 'default';
  // 1. Only a managed source has the two-consumer problem; classic sync keeps its own path.
  const [brain] = await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1');
  if (!brain?.enabled) return own('not_managed');
  // 2. The owner probe: the B3 heartbeat row, through the database (the persistence socket does not exist on Postgres).
  let owner: ConsumerRow | null;
  try {
    owner = deps.probe ? await deps.probe(engine) : await (async () => {
      const { probeLiveFullConsumer, consumerIdentity } = await import('../core/persistence/consumer-heartbeat.ts');
      const { localHostId } = await import('../core/persistence/identity.ts');
      return probeLiveFullConsumer(engine, localHostId(), consumerIdentity());
    })();
  } catch (e) {
    return own('probe_failed', `[sync] could not read this host's consumer heartbeat (${e instanceof Error ? e.message : String(e)}); this run uses its own consumer.`);
  }
  if (!owner) return own('no_owner');
  const pid = owner.pid;
  if (owner.kind !== 'serve') {
    return own('owner_not_serve', `[sync] the live write owner on this host is a ${owner.kind} process (PID ${pid}), which cannot host a delegated sync; this run uses its own consumer beside it.`);
  }
  if (env.GBRAIN_SERVE_SYNC_IPC === '0') {
    return own('kill_switch', fallbackLine(pid, 'GBRAIN_SERVE_SYNC_IPC=0 turns serve-delegated sync off', 'Unset it to run the catch-up inside the serve.'));
  }
  // 3. Argv gate (default-deny). On Postgres an unsupported flag keeps today's own consumer instead of refusing.
  const parsed = parseDelegatedSyncArgs(args);
  if (!parsed.ok) {
    return own('unsupported_flag', fallbackLine(pid, `\`${parsed.refused}\` isn't supported through serve-delegated sync`, 'Drop the flag to run the catch-up inside the serve.'));
  }
  // 4. Socket + secret: the serve bound to this source, else the legacy URL-keyed socket.
  const { sock, secret } = deps.socket ? await deps.socket(sourceId)
    : { sock: await hookResolveSocketForConfig(cfg, sourceId), secret: readIpcSecretForConfig(cfg) };
  if (!sock || !existsSync(sock) || !secret) {
    return own('no_socket', fallbackLine(pid, 'the running gbrain serve exposes no sync IPC socket (older gbrain, or GBRAIN_SERVE_SYNC_IPC=0 on the serve)'));
  }
  // 5. The hand-off: this CLI's durable writer registration (the one its own consumer would run under).
  const { registerLocalWriter } = await import('../core/persistence/identity.ts');
  const local = await registerLocalWriter(engine, 'cli');
  const registration: SyncStartRegistration = { id: local.id, credential: local.credential, lane: 'cli' };
  const { parseDurationSeconds } = await import('../core/sync-concurrency.ts');
  const soft = parseDurationSeconds(args.find((_, i) => args[i - 1] === '--timeout'), '--timeout');
  const hard = await deriveDelegatedTimeoutSeconds(args, { env });
  const timeoutSeconds = soft && soft > 0 ? (hard > 0 ? Math.min(soft, hard) : soft) : hard;
  const options: DelegatedSyncOptions = {
    sourceId, timeoutSeconds,
    ...pick(opts, ['dryRun', 'full', 'noPull', 'noEmbed', 'noExtract', 'noSchemaPack', 'skipFailed', 'retryFailed', 'includeGitignored', 'noBulk'] as const),
    ...(opts.lanes !== undefined ? { lanes: opts.lanes } : {}),
    ...(opts.explicitProcessing?.length ? { explicitProcessing: [...opts.explicitProcessing] } : {}),
  };
  const clientToken = randomUUID();
  const { probeLiveFullConsumer, consumerIdentity } = await import('../core/persistence/consumer-heartbeat.ts');
  const { localHostId } = await import('../core/persistence/identity.ts');
  const ownerAlive = async (): Promise<boolean> => {
    try {
      const row = deps.probe ? await deps.probe(engine) : await probeLiveFullConsumer(engine, localHostId(), consumerIdentity());
      return !!row && row.pid === pid && row.nonce === owner!.nonce;
    } catch { return true; }
  };
  let start = await requestSyncStart(sock, { secret, clientToken, options, registration });
  if (start === IPC_UNAVAILABLE && await ownerAlive()) start = await requestSyncStart(sock, { secret, clientToken, options, registration });
  if (start === IPC_UNAVAILABLE) {
    return own('no_socket', fallbackLine(pid, 'the running gbrain serve is not answering its IPC socket'));
  }
  if ('degraded' in (start as object)) {
    return own('older_serve', fallbackLine(pid, 'the running gbrain serve predates serve-delegated managed sync'));
  }
  const startResp = start as Exclude<SyncStartIpcResult, typeof IPC_UNAVAILABLE | { degraded: string }>;
  if (!startResp.ok) {
    if (startResp.refusal) throw operationErrorFromEnvelope(startResp.refusal);
    if (startResp.error === 'unsupported_kind') {
      return own('older_serve', fallbackLine(pid, 'the running gbrain serve predates serve-delegated managed sync, or runs with GBRAIN_SERVE_SYNC_IPC=0'));
    }
    if (startResp.error === 'permission_denied') throw operationErrorFromEnvelope({ error: 'permission_denied', message: 'The serve refused this CLI\'s writer registration.' });
    return own('serve_refused', fallbackLine(pid, startRefusalText(startResp).replace(/\.$/, ''), 'Fix that, or let this run finish with its own consumer.'));
  }
  const jobId = startResp.jobId!;
  serr(startResp.completed
    ? `[sync] attached to an already-completed delegated sync inside the serve (job ${jobId}).`
    : `[sync] a live gbrain serve (PID ${pid}) owns this host's writes — running the managed catch-up inside it as this CLI's writer (job ${jobId}; Ctrl-C aborts, the cursor is durable).`);
  const polled = await pollDelegatedJob({ sock, secret, jobId, pid, alive: ownerAlive, signal: opts.signal });
  if (polled.kind === 'lost') return own('serve_lost', '[sync] continuing the catch-up with this process\'s own consumer; the durable cursor resumes where the serve left it.');
  if (polled.kind === 'failed') throw polled.error;
  const { result, pagesAffectedTotal } = syncResultFromWire(polled.result);
  if (pagesAffectedTotal > polled.result.pagesAffected.length) {
    serr(`[sync] (+${pagesAffectedTotal - polled.result.pagesAffected.length} more pages affected — list truncated for the IPC wire)`);
  }
  return { kind: 'delegated', result, pid };
}

function pick<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}
