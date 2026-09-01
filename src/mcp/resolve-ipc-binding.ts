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
import type { Server } from 'node:net';
import type { BrainEngine } from '../core/engine.ts';
import { loadConfig } from '../core/config.ts';
import {
  resolveSocketPathForConfig,
  startResolveIpcServer,
  cleanupStaleSocket,
  ensureIpcSecretForConfig,
  type IpcHandlers,
} from '../core/context/resolve-ipc.ts';
import { resolveEntitiesToPointers, logDeliveredReflexPointers } from '../core/context/retrieval-reflex.ts';
import { lexicalArmsEnabled } from '../core/context/reflex.ts';
import { VOLUNTEER_MAX_PAGES_CAP } from '../core/context/volunteer.ts';
import { assembleTurnContext } from '../core/context/turn-context.ts';
import { makeContextPackIpcHandler } from './context-pack-handler.ts';
import { logTurnContextDeliveryFireAndForget } from '../core/context/volunteer-events.ts';

export interface ResolveIpcBinding {
  /** The bound listener, or null when binding was skipped/failed (best-effort). */
  server: Server | null;
  /** The socket path the listener bound (null when not bound). */
  socketPath: string | null;
  /** Idempotent teardown: close the listener + reap the socket file. */
  close(): void;
}

const NULL_BINDING: ResolveIpcBinding = { server: null, socketPath: null, close: () => {} };

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
): Promise<ResolveIpcBinding> {
  try {
    const cfg = loadConfig();
    const resolveSocket = resolveSocketPathForConfig(cfg);
    if (!resolveSocket) return NULL_BINDING;

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
            }),
          sync_status: (req) => runner.getDelegatedSyncStatus(req.jobId),
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

    const server = await startResolveIpcServer(
      resolveSocket,
      {
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
        turn_context: (req) =>
          assembleTurnContext(engine, {
            sourceId: defaultSource,
            window: req.window ?? [],
            priorContextText: req.priorContextText,
            sessionId: req.sessionId,
            maxBytes: req.maxBytes,
            // Per-request config read — same next-turn-revert rationale as
            // the resolve handler above (adversarial F3).
            lexicalArms: lexicalArmsEnabled(loadConfig()),
          }),
        // v0.45.7 ambient recall: boundary context pack. Extracted to
        // context-pack-handler.ts (directly testable against a real engine);
        // the runtime owns entity merge, banking, the since-cursor, and the
        // complete-pack-only monotonic cursor advance.
        context_pack: makeContextPackIpcHandler(engine, defaultSource),
        ...syncHandlers,
        ...sweepHandlers,
      },
      {
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
        onTurnContextDelivered: (result, req) =>
          logTurnContextDeliveryFireAndForget(engine, result, req),
        boundSourceId: defaultSource,
        secret: ipcSecret,
      },
    );

    // startResolveIpcServer returns null when the socket is already owned
    // by a live listener (another serve) — that serve is the IPC provider.
    if (!server) return NULL_BINDING;

    let closed = false;
    return {
      server,
      socketPath: resolveSocket,
      close: () => {
        if (closed) return;
        closed = true;
        try { server.close(); } catch { /* noop */ }
        cleanupStaleSocket(resolveSocket);
      },
    };
  } catch {
    /* resolve IPC is best-effort; never block serve */
    return NULL_BINDING;
  }
}
