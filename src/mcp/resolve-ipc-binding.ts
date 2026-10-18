/**
 * Shared resolve-IPC listener wiring for BOTH serve transports (#4474).
 *
 * Retrieval Reflex (#1981, D9=C): on a PGLite brain, serve owns the single
 * connection, so the context engine (and the per-prompt hook command)
 * resolve salient entities THROUGH the serve over a local unix socket
 * rather than opening a second (impossible) connection. Engine-uniform
 * since #4245: Postgres brains listen too (the hook lane is engine-free by
 * design, so IPC through a serve is its only DB path there) — socket +
 * secret key off hash12(database_url) under ~/.gbrain/run via
 * resolveSocketPathForConfig.
 *
 * Pre-#4474 this block lived inline in the STDIO path (src/mcp/server.ts)
 * only, so `gbrain serve --http` — the exact posture `gbrain bootstrap
 * harness` targets — never bound the socket and every wired lifecycle hook
 * degraded to `no_serve` forever (with serve-delegated sync losing its
 * rung too). Both transports now bind through this helper.
 *
 * Best-effort by contract: failure to bind never blocks the serve.
 */
import { readPressureGate } from '../core/context/pressure.ts';
import type { Server } from 'node:net';
import type { BrainEngine } from '../core/engine.ts';
import { loadConfig } from '../core/config.ts';
import {
  resolveSocketPathForConfig,
  startResolveIpcServer,
  ensureIpcSecretForConfig,
  type IpcHandlers,
  type IpcServerOpts,
  type TurnContextRequest,
} from '../core/context/resolve-ipc.ts';
import { resolveEntitiesToPointers, logDeliveredReflexPointers } from '../core/context/retrieval-reflex.ts';
import { lexicalArmsEnabled } from '../core/context/reflex.ts';
import { VOLUNTEER_MAX_PAGES_CAP } from '../core/context/volunteer.ts';
import { assembleTurnContext, TURN_CONTEXT_DEFAULT_MAX_BYTES, type TurnContextResult } from '../core/context/turn-context.ts';
import { attachBrief, briefEnabled, BRIEF_MAX_BYTES, recordBriefDelivered, turnBrief, TURN_BRIEF_CUTOFF_MS, withBriefDeadline } from '../core/context/proactive-brief.ts';
import { proactiveEligibility } from '../core/eligibility/registry.ts';
import { makeContextPackIpcHandler } from './context-pack-handler.ts';
import { logBriefDeliveryFireAndForget, logTurnContextDeliveryFireAndForget } from '../core/context/volunteer-events.ts';
import { persistenceSocketPathForConfig, startPersistenceIpcServer, type PersistenceIpcProvider, type PersistenceIpcBinding } from '../core/persistence/ipc.ts';
import { residentPersistenceConfig } from '../core/persistence/local-client.ts';
import { findIpcPathTooLong, ipcPathTooLongMessage } from '../core/context/ipc-path-too-long.ts';

export interface ResolveIpcBinding {
  /** The bound listener for this serve's own resolve socket, or null while it is not bound (best-effort). */
  readonly server: Server | null;
  /** The socket path the listener bound (null while not bound). */
  readonly socketPath: string | null;
  /** Dedicated persistence listener; its larger frames never enter hook handlers. */
  persistence?: PersistenceIpcBinding;
  /** Idempotent teardown: close the listener + reap the socket file. */
  close(): void;
}

const NULL_BINDING: ResolveIpcBinding = { server: null, socketPath: null, close: () => {} };

/** #6647: a serve that could not bind a resolve socket retries it this often (plus jitter). */
export const RESOLVE_IPC_REBIND_INTERVAL_MS = 30_000;
const RESOLVE_IPC_REBIND_JITTER_MS = 5_000;

function defaultRebindDelayMs(): number {
  return RESOLVE_IPC_REBIND_INTERVAL_MS + Math.floor(Math.random() * RESOLVE_IPC_REBIND_JITTER_MS);
}

/**
 * The turn_context assembly the serve answers with (minus the pressure gate).
 * Wave 5 D5 proactive brief (default off): the legacy block is assembled
 * first and stands on its own; when `context.proactive_brief` is on, the
 * brief runs in what is left of a request-start cutoff (its queries stop once
 * it passes), inside a byte reservation taken from the legacy block, and
 * leads the text. Off, this is the legacy assembly exactly. Always assembles
 * against the serve's OWN registered source [CX2-10].
 */
export async function turnContextWithBrief(engine: BrainEngine, sourceId: string, req: TurnContextRequest): Promise<TurnContextResult> {
  const clock = { now: Date.now(), stopAt: Date.now() + TURN_BRIEF_CUTOFF_MS };
  const briefOn = await briefEnabled(engine);
  const base = await assembleTurnContext(engine, {
    sourceId,
    window: req.window ?? [],
    priorContextText: req.priorContextText,
    sessionId: req.sessionId,
    maxBytes: briefOn ? Math.max(1024, (req.maxBytes ?? TURN_CONTEXT_DEFAULT_MAX_BYTES) - BRIEF_MAX_BYTES - 2) : req.maxBytes,
    // Per-request config read: `gbrain serve` is long-running, and the
    // lexical-arms switch reverts a false-fire regression on the NEXT turn
    // (adversarial F3).
    lexicalArms: lexicalArmsEnabled(loadConfig()),
  });
  const last = req.window?.at(-1);
  const prompt = last?.role === 'user' ? last.text : '';
  if (!briefOn || !prompt.trim()) return base;
  const brief = await withBriefDeadline(proactiveEligibility({ engine }, 'hook.user_prompt').then((eligibility) => turnBrief(engine, {
    sourceId, prompt, sessionId: req.sessionId, priorContextText: req.priorContextText, eligibility, clock,
  })), clock);
  return attachBrief(base, brief);
}

/** A delivered block's brief: record its ids for the session, then log them. No-op without a brief. */
export function briefDelivered(engine: BrainEngine, sourceId: string, result: TurnContextResult, sessionId: string | undefined): void {
  if (!result.brief) return;
  recordBriefDelivered(sourceId, sessionId, result.brief.items.map((i) => i.id));
  logBriefDeliveryFireAndForget(engine, result.brief, sessionId);
}

/**
 * Bind the resolve/turn_context/context_pack (+ delegated sync/sweep) IPC
 * listener for a running serve. `defaultSource` is the serve's bound source
 * (resolveMcpStdioSourceScope) — the IPC layer rejects requests naming any
 * other source ([CX2-10]).
 */
/**
 * 2026-08 fix wave (ship security review): the volunteer probe claim is a
 * WIRE FIELD, so it is honored only when the request is volunteer-SHAPED —
 * slug-only suppression + the wide ungated pool cap volunteerStage always
 * sends. A normal pointer resolve stamping probe:'volunteer' to evade
 * delivery telemetry keeps logging. Exported for direct unit testing.
 *
 * ADVISORY, not a control (adversarial review, 2026-09): the shape is
 * publicly reproducible, so a client that deliberately sends the full
 * volunteer shape receives up to the wide pool with no delivery log line.
 * Delivery logging is precision/recall telemetry — the caller already holds
 * read access to the same pages via ordinary ops — but treat the audit
 * trail as best-effort until the server-side volunteer-report IPC kind
 * (filed) closes it.
 */
export function isVolunteerProbeShaped(req: {
  probe?: string;
  suppression?: string;
  maxPointers?: number;
} | undefined): boolean {
  return (
    req?.probe === 'volunteer' &&
    req.suppression === 'slug-only' &&
    req.maxPointers === VOLUNTEER_MAX_PAGES_CAP * 2
  );
}

export async function bindResolveIpcForServe(
  engine: BrainEngine,
  defaultSource: string,
  persistenceProvider?: PersistenceIpcProvider,
  opts: {
    rememberCallable?: boolean | (() => boolean);
    /** Delay before each re-bind attempt of a socket this serve does not hold; tests inject a short one. */
    rebindDelayMs?: () => number;
  } = {},
): Promise<ResolveIpcBinding> {
  let persistence: PersistenceIpcBinding | null = null;
  try {
    const cfg = loadConfig();
    // #5042: this serve's own source-keyed socket, plus the legacy URL-only
    // socket when it is free (older hooks and hooks naming no source).
    const resolveSocket = resolveSocketPathForConfig(cfg, 'resolve', defaultSource);
    const legacySocket = resolveSocketPathForConfig(cfg);
    if (!resolveSocket || !legacySocket) return NULL_BINDING;

    // #6573: a socket path the OS cannot bind (even after the per-user
    // run-dir fallback) is reported once, typed, and never retried.
    const tooLong = (path: string | null) => {
      const problem = findIpcPathTooLong([path]);
      if (problem) process.stderr.write(`[resolve-ipc] ${ipcPathTooLongMessage(problem)}\n`);
      return problem !== null;
    };

    // The owner socket follows the brain the engine opened, which may be a mount (#5237).
    const owner = residentPersistenceConfig(cfg);
    if (persistenceProvider && owner?.engine === 'pglite') {
      const persistenceSocket = persistenceSocketPathForConfig(owner);
      if (persistenceSocket && !tooLong(persistenceSocket)) {
        try { persistence = await startPersistenceIpcServer(persistenceSocket, persistenceProvider); }
        catch {
          process.stderr.write('[persistence-ipc] listener unavailable; local callers will receive owner_unavailable.\n');
        }
      }
    }

    // [S3#6] turn_context requires the shared secret from the config-keyed
    // path (created 0600 here if absent). If the secret can't be
    // provisioned, turn_context stays fail-closed ('unauthorized') while
    // the secret-free resolve kind keeps working.
    let ipcSecret: string | undefined;
    try {
      ipcSecret = ensureIpcSecretForConfig(cfg) ?? undefined;
    } catch { /* turn_context disabled; resolve unaffected */ }

    // Serve-delegated sync kinds — built in their OWN try/catch so a
    // runner import/registration failure can never take resolve /
    // turn_context / context_pack down with it (this whole block's shared
    // catch would otherwise swallow the error and start NO listener).
    // Kill switch: GBRAIN_SERVE_SYNC_IPC=0 → the kinds are simply not
    // registered and clients get 'unsupported_kind' (the polite refusal).
    let syncHandlers: Pick<IpcHandlers, 'sync_start' | 'sync_status' | 'sync_abort'> = {};
    if (process.env.GBRAIN_SERVE_SYNC_IPC !== '0') {
      try {
        const runner = await import('../core/serve-sync-runner.ts');
        syncHandlers = {
          sync_start: (req) =>
            runner.startDelegatedSync(engine, req.options, req.clientToken, {
              boundSourceId: defaultSource,
              // #6317: the CLI's writer registration for a managed drain (verified by the runner, never here).
              registration: req.registration,
            }),
          sync_status: (req) => runner.getDelegatedSyncStatus(req.jobId, typeof req.afterLine === 'number' ? req.afterLine : 0),
          sync_abort: (req) => runner.abortDelegatedSync(req.jobId),
        };
      } catch (e) {
        process.stderr.write(
          `[serve-sync] handlers unavailable: ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    }
    // Serve-delegated maintenance sweep (#677) — same posture, own
    // try/catch so a runner failure never takes the other kinds down.
    // Shares the GBRAIN_SERVE_SYNC_IPC kill switch (one delegation family).
    let sweepHandlers: Pick<IpcHandlers, 'sweep_start' | 'sweep_status'> = {};
    if (process.env.GBRAIN_SERVE_SYNC_IPC !== '0') {
      try {
        const sweepRunner = await import('../core/serve-sweep-runner.ts');
        sweepHandlers = {
          sweep_start: (req) =>
            sweepRunner.startDelegatedSweep(engine, req.options, req.clientToken, {
              boundSourceId: defaultSource,
            }),
          sweep_status: (req) => sweepRunner.getDelegatedSweepStatus(req.jobId),
        };
      } catch (e) {
        process.stderr.write(
          `[serve-sweep] handlers unavailable: ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    }

    const handlers: IpcHandlers = {
      // [CX2-10] Bound-source posture for BOTH kinds: the IPC layer
      // rejects any resolve/turn_context request naming a source other
      // than boundSourceId ('source_mismatch'), so the only sourceId that
      // reaches this handler is the bound one or absent — and the handler
      // resolves against the server's OWN registered source regardless.
      resolve: (req) =>
        resolveEntitiesToPointers(
          engine,
          defaultSource,
          req.candidates ?? [],
          {
            priorContextText: req.priorContextText,
            maxPointers: req.maxPointers,
            suppression: req.suppression,
            // v0.46.15 kill switch: either side may disable — a client
            // `false` wins, else the server's own file-config gate.
            // Config is re-read PER REQUEST (adversarial F3): `gbrain
            // serve` is long-running, and the switch's whole value is
            // reverting a false-fire regression on the NEXT TURN with a
            // config edit — a startup snapshot would freeze it until a
            // serve restart. loadConfig is a file read (~1ms) inside the
            // 400ms IPC budget.
            lexicalArms: req.lexicalArms === false ? false : lexicalArmsEnabled(loadConfig()),
          },
        ),
      // IPC v2 [ENG-3]: per-turn context assembly for the hook command.
      // [CX2-10] Always assembles against the server's OWN registered
      // source — cross-source requests are rejected in the IPC layer via
      // boundSourceId below, and the handler never honors a caller source.
      turn_context: async (req) => ({
        ...await turnContextWithBrief(engine, defaultSource, req),
        // Context-pressure gate for the harness hook (pressure.ts); a surface without remember never warns.
        pressure: await readPressureGate(engine, typeof opts.rememberCallable === 'function' ? opts.rememberCallable() : opts.rememberCallable ?? true),
      }),
      // v0.45.7 ambient recall: boundary context pack. Extracted to
      // context-pack-handler.ts (directly testable against a real engine);
      // the runtime owns entity merge, banking, the since-cursor, and the
      // complete-pack-only monotonic cursor advance.
      context_pack: makeContextPackIpcHandler(engine, defaultSource),
      ...syncHandlers,
      ...sweepHandlers,
    };
    const serverOpts: IpcServerOpts = {
      // The IPC resolve path IS the ambient reflex channel. Logging happens
      // at DELIVERY (post-write), not inside the resolver — a block the
      // client's 250ms budget abandoned was never injected, and counting it
      // would corrupt the volunteered-vs-used precision stats (red-team).
      // Volunteer-stage PROBE resolves (wide ungated pool) are skipped for
      // the same reason: the pool is not injected pointers. NOTE (ship
      // security review): on the PGLite/IPC rung the gated survivors are
      // NOT re-logged anywhere (the client has no engine handle) — openclaw
      // volunteer events cover the direct-Postgres rung only, see
      // reflex.ts. The probe claim is a WIRE FIELD, so it is honored only
      // when the request is volunteer-SHAPED (slug-only suppression + the
      // wide volunteer pool cap): a normal pointer resolve stamping
      // probe:'volunteer' to evade delivery telemetry still logs.
      onDelivered: (block, req) => {
        if (isVolunteerProbeShaped(req)) return;
        logDeliveredReflexPointers(engine, block.pointers);
      },
      // The hook lane's feedback loop (#2095 closed over turn_context):
      // the delivered block's post-trim volunteered pages + pointers land
      // in context_volunteer_events under the request's channel. Body
      // lives in volunteer-events.ts (logTurnContextDeliveryFireAndForget)
      // so the shipped wiring is unit-testable.
      // Wave 5 D5: a delivered brief (UserPromptSubmit or SessionStart) is
      // ledgered for repeat suppression and logged under channel 'brief'.
      onTurnContextDelivered: (result, req) => {
        logTurnContextDeliveryFireAndForget(engine, result, req);
        briefDelivered(engine, defaultSource, result, req.sessionId);
      },
      onContextPackDelivered: (result, req) => briefDelivered(engine, defaultSource, result, req.sessionId),
      boundSourceId: defaultSource,
      secret: ipcSecret,
    };
    // #6647: every socket this serve could not bind (its source socket, the
    // legacy socket) is retried on its own unref'd timer through the same
    // startResolveIpcServer, which still defers to a live or unknown owner
    // (#4896), so a surviving serve takes over only once the owner probes
    // dead. Bind attempts and close() run one at a time per serve; a bind
    // that completes after close() is closed at once. Persistence is never
    // re-set-up here.
    const slots = [resolveSocket, ...(legacySocket === resolveSocket ? [] : [legacySocket])]
      .filter(path => !tooLong(path))
      .map(path => ({ path, server: null as Server | null, timer: undefined as ReturnType<typeof setTimeout> | undefined }));
    const rebindDelayMs = opts.rebindDelayMs ?? defaultRebindDelayMs;
    let closed = false;
    let lifecycle: Promise<void> = Promise.resolve();
    const serialized = (step: () => Promise<void>): Promise<void> => (lifecycle = lifecycle.then(step, step));
    const bind = async (slot: (typeof slots)[number], retry: boolean): Promise<void> => {
      if (closed || slot.server) return;
      const server = await startResolveIpcServer(slot.path, handlers, serverOpts).catch(() => null);
      if (closed) { try { server?.close(); } catch { /* noop */ } return; }
      if (!server) { schedule(slot); return; }
      slot.server = server;
      if (retry) process.stderr.write(`[resolve-ipc] took over ${slot.path} after its previous owner exited\n`);
    };
    const schedule = (slot: (typeof slots)[number]): void => {
      if (closed) return;
      slot.timer = setTimeout(() => {
        slot.timer = undefined;
        void serialized(() => bind(slot, true));
      }, rebindDelayMs());
      slot.timer.unref?.();
    };
    await serialized(async () => { for (const slot of slots) await bind(slot, false); });

    const own = slots.find(slot => slot.path === resolveSocket);
    return {
      get server() { return own?.server ?? null; },
      get socketPath() { return own?.server ? resolveSocket : null; },
      ...(persistence ? { persistence } : {}),
      close: () => {
        if (closed) return;
        closed = true;
        for (const slot of slots) clearTimeout(slot.timer);
        // server.close() unlinks the pathname THIS listener bound; never
        // blind-unlink the path — it may belong to a newer live serve (#4896).
        for (const slot of slots) { try { slot.server?.close(); } catch { /* noop */ } }
        persistence?.close();
      },
    };
  } catch {
    if (persistence) {
      return { server: null, socketPath: null, persistence, close: () => persistence?.close() };
    }
    /* resolve IPC is best-effort; never block serve */
    return NULL_BINDING;
  }
}
