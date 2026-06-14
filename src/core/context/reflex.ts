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
import { extractCandidates, type EntityCandidate } from './entity-salience.ts';
import {
  resolveEntitiesToPointers,
  DEFAULT_MAX_POINTERS,
  type PointerBlock,
} from './retrieval-reflex.ts';
import { resolveViaIpc, resolveSocketPath, IPC_UNAVAILABLE } from './resolve-ipc.ts';

/** Host capability shape (D1=A): candidates in, pointers out. Narrow by design. */
export type ResolveEntitiesFn = (
  candidates: EntityCandidate[],
  opts: { priorContextText?: string; maxPointers?: number },
) => Promise<PointerBlock | null>;

export interface ReflexParams {
  workspaceDir: string;
  /** The current turn's user text (drives extraction). */
  currentUserText: string;
  /** Joined PRIOR turns + loaded page bodies — EXCLUDES the current turn (suppression). */
  priorContextText: string;
  /** Host-provided resolver, if the OpenClaw plugin contract supplied one. */
  resolveEntities?: ResolveEntitiesFn;
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

    // Zero-candidate fast path: one regex pass, no brain touch.
    const candidates = extractCandidates(params.currentUserText);
    if (!candidates.length) return null;

    const opts = { priorContextText: params.priorContextText, maxPointers: maxPointers(cfg) };
    const block = await withTimeout(resolve(params, cfg, candidates, opts), TIMEOUT_MS);
    if (!block || !block.pointers.length) return null;

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
  opts: { priorContextText?: string; maxPointers?: number },
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
