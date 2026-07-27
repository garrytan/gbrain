/**
 * Retrieval Reflex — per-turn orchestrator (issue #1981, Layer 1).
 *
 * Glues the pure extractor to the engine-aware resolver ladder and returns the
 * pointer markdown to append to `systemPromptAddition`. Called from the context
 * engine's `assemble()` on every turn, so it is:
 *   - zero-candidate fast path: no brain touched when nothing is salient
 *   - fully fail-open: any error returns null (the turn never breaks)
 *   - time-bounded: a hard timeout caps the per-turn cost
 *
 * Resolver ladder (engine-aware — see plan D1/D9):
 *   1. host-injected resolveEntities (ctx.brainQuery)   — any engine
 *   2. PGLite → serve resolve IPC socket                 — through the lock holder
 *   3. Postgres → cached direct connection              — multi-connection, safe
 *   4. else → disabled (policy skill carries; doctor reports it)
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, appendFileSync } from 'node:fs';
import { loadConfig, type GBrainConfig } from '../config.ts';
import type { BrainEngine } from '../engine.ts';
import {
  extractCandidates,
  extractCandidatesFromWindow,
  type EntityCandidate,
  type WindowTurn,
} from './entity-salience.ts';
import {
  resolveEntitiesToPointers,
  DEFAULT_MAX_POINTERS,
  type PointerBlock,
} from './retrieval-reflex.ts';
import { resolveViaIpc, resolveSocketPath, IPC_UNAVAILABLE } from './resolve-ipc.ts';

/** Per-turn resolver options shared by every rung of the ladder. */
export interface ResolveEntitiesOpts {
  priorContextText?: string;
  maxPointers?: number;
  /** v0.43 (#2095): 'slug-only' under windowing — see ResolvePointersOpts. */
  suppression?: 'slug-and-title' | 'slug-only';
}

/**
 * Host capability shape (D1=A): candidates in, pointers out. Narrow by design.
 *
 * CONTRACT (red-team): a host resolver MUST honor `opts.suppression`. Under
 * windowing the orchestrator passes 'slug-only' — a resolver that keeps
 * applying the legacy title-whole-word rule will suppress every entity merely
 * mentioned in a prior window turn and silently disable the feature. Hosts
 * built against the pre-window contract should be upgraded or pinned to
 * `retrieval_reflex_window_turns: 1`. (A capability/version gate so the
 * orchestrator can detect a stale host is a filed TODO.)
 */
export type ResolveEntitiesFn = (
  candidates: EntityCandidate[],
  opts: ResolveEntitiesOpts,
) => Promise<PointerBlock | null>;

export interface ReflexParams {
  workspaceDir: string;
  /** The current turn's user text (drives extraction when no window is given). */
  currentUserText: string;
  /** Joined PRIOR turns + loaded page bodies — EXCLUDES the current turn (suppression). */
  priorContextText: string;
  /**
   * v0.43 (#2095): recent turns (oldest → newest, current turn last). When
   * present and the configured window is > 1, extraction widens to the last
   * N turns (assistant-introduced entities + named-antecedent follow-ups now
   * resolve) and suppression switches to slug-only (codex D7 — the title rule
   * would suppress every entity merely mentioned in a prior window turn).
   */
  windowTurns?: WindowTurn[];
  /** Host-provided resolver, if the OpenClaw plugin contract supplied one. */
  resolveEntities?: ResolveEntitiesFn;
}

/** Default extraction window (turns). 1 = legacy current-turn-only. */
export const DEFAULT_WINDOW_TURNS = 4;

export function windowTurnCount(cfg: GBrainConfig | null): number {
  // Env plane is read DIRECTLY here (mirroring reflexEnabled's direct
  // process.env read), not just via loadConfig's env→config mapping. When
  // there's no config file AND no DATABASE_URL, loadConfig() returns null and
  // drops that mapping entirely — so without this, the documented
  // GBRAIN_RETRIEVAL_REFLEX_WINDOW_TURNS escape hatch would be silently
  // ignored and the window would fall back to the default of 4 (a real
  // config-less-environment bug, e.g. a clean CI shard with no brain).
  const env = process.env.GBRAIN_RETRIEVAL_REFLEX_WINDOW_TURNS;
  if (env != null && env !== '') {
    const e = Number(env);
    if (Number.isFinite(e) && e >= 1) return Math.floor(e);
  }
  const n = cfg?.retrieval_reflex_window_turns;
  if (typeof n === 'number' && Number.isFinite(n) && n >= 1) return Math.floor(n);
  return DEFAULT_WINDOW_TURNS;
}

const TIMEOUT_MS = 1500; // generous per-turn ceiling; the work is usually <100ms
const HEARTBEAT_PATH = join(homedir(), '.gbrain', 'integrations', 'retrieval-reflex', 'heartbeat.jsonl');

/** File-plane + env gate. Default ON. DB-plane does NOT gate (assemble() is sync). */
export function reflexEnabled(cfg: GBrainConfig | null): boolean {
  const env = process.env.GBRAIN_RETRIEVAL_REFLEX;
  if (env != null && env !== '') return !(env === 'false' || env === '0');
  return cfg?.retrieval_reflex !== false;
}

function maxPointers(cfg: GBrainConfig | null): number {
  const n = cfg?.retrieval_reflex_max_pointers;
  return typeof n === 'number' && n > 0 ? n : DEFAULT_MAX_POINTERS;
}

/**
 * Build the pointer-block markdown for this turn, or null to inject nothing.
 * Never throws.
 */
export async function buildReflexAddition(params: ReflexParams): Promise<string | null> {
  try {
    const cfg = loadConfig();
    if (!reflexEnabled(cfg)) return null;

    // v0.43 (#2095): widen extraction across the last N turns when a window
    // is supplied and configured > 1. Window=1 reproduces the legacy
    // current-turn-only behavior exactly (including suppression mode).
    const windowN = windowTurnCount(cfg);
    const windowed = windowN > 1 && (params.windowTurns?.length ?? 0) > 0;
    const candidates: EntityCandidate[] = windowed
      ? extractCandidatesFromWindow(params.windowTurns!.slice(-windowN))
      : extractCandidates(params.currentUserText);
    // Zero-candidate fast path: regex passes only, no brain touch.
    if (!candidates.length) return null;

    const opts: ResolveEntitiesOpts = {
      priorContextText: params.priorContextText,
      maxPointers: maxPointers(cfg),
      suppression: windowed ? 'slug-only' : 'slug-and-title',
    };
    const block = await withTimeout(resolve(params, cfg, candidates, opts), TIMEOUT_MS);
    if (!block || !block.pointers.length) return null;

    // Accept-side reflex-channel logging (red-team): the block survived the
    // per-turn timeout, so these pointers ARE being injected. Only the
    // direct-Postgres rung has an engine here; the IPC rung logs server-side
    // at delivery; host-injected resolvers can't log (documented gap).
    if (!params.resolveEntities && isPostgres(cfg)) {
      const engine = await getPostgresEngine(cfg);
      if (engine) {
        const { logDeliveredReflexPointers } = await import('./retrieval-reflex.ts');
        logDeliveredReflexPointers(engine, block.pointers);
      }
    }

    writeHeartbeat(cfg, block.pointers.length);
    return block.text;
  } catch {
    return null; // fail-open: the live-context block still ships
  }
}

async function resolve(
  params: ReflexParams,
  cfg: GBrainConfig | null,
  candidates: EntityCandidate[],
  opts: ResolveEntitiesOpts,
): Promise<PointerBlock | null> {
  // 1. Host capability (any engine).
  if (params.resolveEntities) {
    return params.resolveEntities(candidates, opts);
  }
  // 2. PGLite → serve resolve IPC.
  if (cfg?.engine === 'pglite' && cfg.database_path) {
    const sock = resolveSocketPath(cfg.database_path);
    const r = await resolveViaIpc(sock, { candidates, ...opts });
    return r === IPC_UNAVAILABLE ? null : r;
  }
  // 3. Postgres → cached direct connection.
  if (isPostgres(cfg)) {
    const engine = await getPostgresEngine(cfg);
    if (!engine) return null;
    const { resolveSourceId } = await import('../source-resolver.ts');
    const sourceId = await resolveSourceId(engine, null, params.workspaceDir);
    return resolveEntitiesToPointers(engine, sourceId, candidates, opts);
  }
  // 4. Disabled (PGLite with no serve / unknown engine). Policy skill carries.
  return null;
}

function isPostgres(cfg: GBrainConfig | null): boolean {
  if (cfg?.engine === 'postgres') return true;
  // engine unset but a database_url present → postgres (createEngine default).
  return !cfg?.engine && !!cfg?.database_url;
}

// ── Postgres process-singleton ──────────────────────────────────────────
// One connection per process, reused across sessions/turns. Avoids the
// connection-multiplication a per-session open would cause (Codex finding).
let _pgEngine: BrainEngine | null = null;
let _pgPending: Promise<BrainEngine | null> | null = null;
let _pgFailedUntil = 0; // cooldown so a transient connect failure doesn't storm

async function getPostgresEngine(cfg: GBrainConfig | null): Promise<BrainEngine | null> {
  if (_pgEngine) return _pgEngine;
  if (Date.now() < _pgFailedUntil) return null;
  if (_pgPending) return _pgPending;
  _pgPending = (async () => {
    try {
      const { createEngine } = await import('../engine-factory.ts');
      const engineConfig = {
        engine: 'postgres' as const,
        database_url: cfg?.database_url,
        database_path: cfg?.database_path,
      };
      const engine = await createEngine(engineConfig);
      await engine.connect(engineConfig);
      _pgEngine = engine;
      return engine;
    } catch {
      _pgFailedUntil = Date.now() + 60_000; // 60s cooldown
      return null;
    } finally {
      _pgPending = null;
    }
  })();
  return _pgPending;
}

/**
 * Warm the Postgres connection ahead of the first salient turn (called by the
 * context-engine factory). No-op for PGLite/host paths. Fire-and-forget.
 */
export function warmReflex(): void {
  try {
    const cfg = loadConfig();
    if (reflexEnabled(cfg) && isPostgres(cfg)) void getPostgresEngine(cfg);
  } catch {
    /* best effort */
  }
}

/** Dispose the cached Postgres connection (tests + clean shutdown). */
export async function disposeReflex(): Promise<void> {
  const e = _pgEngine;
  _pgEngine = null;
  _pgPending = null;
  _pgFailedUntil = 0;
  if (e) {
    try { await e.disconnect(); } catch { /* noop */ }
  }
}

function writeHeartbeat(cfg: GBrainConfig | null, count: number): void {
  try {
    mkdirSync(join(homedir(), '.gbrain', 'integrations', 'retrieval-reflex'), { recursive: true });
    const engine = cfg?.engine ?? 'unknown';
    appendFileSync(
      HEARTBEAT_PATH,
      JSON.stringify({ ts: new Date().toISOString(), event: 'inject', pointers: count, engine }) + '\n',
    );
  } catch {
    /* heartbeat is advisory; never block the turn */
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((r) => setTimeout(() => r(null), ms)),
  ]);
}
