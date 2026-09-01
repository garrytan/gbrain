/**
 * Retrieval Reflex — per-turn orchestrator (issue #1981, Layer 1).
 *
 * Glues the pure extractor to the engine-aware resolver ladder and returns the
 * context markdown to append to `systemPromptAddition`. Called from the context
 * engine's `assemble()` on every turn, so it is:
 *   - zero-candidate fast path: no brain touched when nothing is salient
 *   - fully fail-open: any error returns null (the turn never breaks)
 *   - time-bounded: a hard timeout caps the per-turn cost
 *
 * Two arms (2026-08 fix wave — parity with turn-context's Arm A):
 *
 *   window/turn ─ extract ──▶ Arm 1: resolve pointers ── withTimeout(1500ms)
 *        │                        │ (maxPointers budget, precision-biased)
 *        │                        ▼
 *        └──(windowed only)──▶ Arm 2: volunteerStage ── withTimeout(remaining)
 *                                 │ (wide probe resolve → 0.7 confidence gate,
 *                                 │  excludeSlugs = Arm 1's pointers; expiry
 *                                 ▼  falls back to the pointer-only block)
 *                        pointers text + volunteered section
 *
 * Arm 2 never wraps Arm 1's timeout: a slow volunteer resolve degrades to
 * pointers-only (today's behavior is the fail-open floor — a volunteer stall
 * must never discard already-resolved pointers).
 *
 * Resolver ladder (engine-aware — see plan D1/D9), shared by both arms:
 *   1. host-injected resolveEntities (ctx.brainQuery)   — any engine
 *   2. PGLite → serve resolve IPC socket                 — through the lock holder
 *   3. Postgres → cached direct connection              — multi-connection, safe
 *   4. else → disabled (policy skill carries; doctor reports it)
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, appendFileSync } from 'node:fs';
import { loadConfig, isEnvDisabled, type GBrainConfig } from '../config.ts';
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
import {
  volunteerStage,
  VOLUNTEER_DEFAULT_MAX_PAGES,
  type VolunteeredPage,
} from './volunteer.ts';
import { resolveViaIpc, resolveSocketPath, IPC_UNAVAILABLE } from './resolve-ipc.ts';

/** Per-turn resolver options shared by every rung of the ladder. */
export interface ResolveEntitiesOpts {
  priorContextText?: string;
  maxPointers?: number;
  /** v0.43 (#2095): 'slug-only' under windowing — see ResolvePointersOpts. */
  suppression?: 'slug-and-title' | 'slug-only';
  /** v0.46.15: lexical-arms kill switch — see ResolvePointersOpts.lexicalArms. */
  lexicalArms?: boolean;
  /**
   * 2026-08 fix wave: marks the volunteer stage's WIDE UNGATED pool resolve.
   * Delivery-point loggers (the resolve-ipc binding's onDelivered) must skip
   * probe resolves — counting the pool as injected pointers would corrupt the
   * reflex channel's precision stats; gated survivors log once through the
   * volunteer-events sink instead. Host resolvers may ignore it (extra field);
   * an older serve ignores it too (accepted mixed-version stat noise, minor).
   */
  probe?: 'volunteer';
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
/**
 * Minimum remaining budget (ms) worth spending on the Arm 2 volunteer probe.
 * Below this, a resolve round-trip cannot realistically complete — skip the
 * arm rather than start work the timeout will immediately discard.
 */
const MIN_VOLUNTEER_BUDGET_MS = 50;
const HEARTBEAT_PATH = join(homedir(), '.gbrain', 'integrations', 'retrieval-reflex', 'heartbeat.jsonl');

/**
 * File-plane + env gate. Default ON. DB-plane does NOT gate (assemble() is sync).
 *
 * 2026-08 fix wave (red-team): widened from the strict legacy parse
 * ('false'|'0' only) to the same robust negative family the child switches
 * (volunteer, lexical arms) honor — an operator disabling the WHOLE reflex
 * mid-incident with GBRAIN_RETRIEVAL_REFLEX=off used to get a silent no-op
 * while the same value worked on the children. Widening a disable-parse is
 * safe: no enabled-today value becomes disabled except intended negatives.
 */
export function reflexEnabled(cfg: GBrainConfig | null): boolean {
  const env = process.env.GBRAIN_RETRIEVAL_REFLEX;
  if (env != null && env !== '') return !isEnvDisabled(env);
  return cfg?.retrieval_reflex !== false;
}

/**
 * 2026-08 fix wave — kill switch for the volunteer arm (Arm 2). Default ON:
 * the volunteer layer has been default-on in the shipped claude-code
 * turn-context lane since v0.43; this is harness parity for the OpenClaw
 * lane, with the switch as the incident lever. Env above config (an operator
 * mid-incident may not be able to reach config), same robust negative parse
 * as lexicalArmsEnabled.
 */
export function volunteerEnabled(cfg: GBrainConfig | null): boolean {
  const env = process.env.GBRAIN_RETRIEVAL_REFLEX_VOLUNTEER;
  if (env != null && env !== '') return !isEnvDisabled(env);
  return cfg?.retrieval_reflex_volunteer !== false;
}

/**
 * v0.46.15 identity wave — kill switch for the lexical recall arms
 * (weak-candidate alias arm + surname arm). Default ON; same env-direct
 * pattern as reflexEnabled/windowTurnCount so a config-less environment
 * still honors the escape hatch.
 */
export function lexicalArmsEnabled(cfg: GBrainConfig | null): boolean {
  const env = process.env.GBRAIN_RETRIEVAL_REFLEX_LEXICAL_ARMS;
  // Shared isEnvDisabled parse (adversarial F11): the incident escape hatch —
  // an operator typing FALSE/off/no mid-incident must not get a silent no-op.
  // (reflexEnabled/windowTurnCount keep the stricter legacy parse.)
  if (env != null && env !== '') return !isEnvDisabled(env);
  return cfg?.retrieval_reflex_lexical_arms !== false;
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
    const windowSlice = windowed ? params.windowTurns!.slice(-windowN) : null;
    const windowCandidates = windowSlice ? extractCandidatesFromWindow(windowSlice) : null;
    const candidates: EntityCandidate[] = windowCandidates ?? extractCandidates(params.currentUserText);
    // Zero-candidate fast path: regex passes only, no brain touch.
    if (!candidates.length) return null;

    const opts: ResolveEntitiesOpts = {
      priorContextText: params.priorContextText,
      maxPointers: maxPointers(cfg),
      suppression: windowed ? 'slug-only' : 'slug-and-title',
      lexicalArms: lexicalArmsEnabled(cfg),
    };
    const startedAt = Date.now();
    const block = await withTimeout(resolve(params, cfg, candidates, opts), TIMEOUT_MS);
    const pointers = block?.pointers ?? [];

    // Arm 2 (2026-08 fix wave): volunteer stage — windowed lanes only (the
    // gate needs window occurrence metadata). Same shared primitive the
    // claude-code turn-context lane and the BrainBench openclaw adapter run.
    // REMAINING-budget timeout, never a shared wrapper: expiry falls back to
    // the pointer-only block instead of discarding resolved pointers.
    let volunteered: VolunteeredPage[] = [];
    if (windowCandidates && windowSlice && volunteerEnabled(cfg)) {
      const remaining = TIMEOUT_MS - (Date.now() - startedAt);
      if (remaining > MIN_VOLUNTEER_BUDGET_MS) {
        // Own try/catch, NOT just the timeout race (codex adversarial,
        // 2026-09): a non-timeout REJECTION of the volunteer resolve would
        // otherwise propagate through Promise.race to the outer catch and
        // return null — destroying Arm 1's already-resolved pointer block, a
        // floor regression vs the pointer-only lane. Arm 2 fails open to the
        // pointer-only block on ANY failure mode, not just expiry.
        try {
          const v = await withTimeout(
            volunteerStage(
              (cands, ropts) => resolve(params, cfg, cands, ropts),
              windowCandidates,
              windowSlice.length,
              {
                excludeSlugs: new Set(pointers.map((p) => p.slug)),
                priorContextText: params.priorContextText,
                lexicalArms: opts.lexicalArms,
                maxPages: VOLUNTEER_DEFAULT_MAX_PAGES,
              },
            ),
            remaining,
          );
          volunteered = v ?? [];
        } catch {
          volunteered = [];
        }
      }
    }

    if (!pointers.length && !volunteered.length) return null;

    // Accept-side reflex-channel logging (red-team): the block survived the
    // per-turn timeout, so these pointers ARE being injected. Only the
    // direct-Postgres rung has an engine here; the IPC rung logs POINTER
    // deliveries server-side (probe resolves excluded — see
    // ResolveEntitiesOpts.probe); host-injected resolvers can't log
    // (documented gap). Volunteered survivors log through the
    // volunteer-events sink under the in-process 'openclaw' channel (NEVER
    // wire-claimable — see HARNESS_CHANNELS) — on the DIRECT-POSTGRES RUNG
    // ONLY: the PGLite/IPC rung has no engine handle client-side and the
    // server only sees the ungated probe pool, so openclaw volunteer events
    // are not logged there (documented gap, same class as the host-resolver
    // one; a server-side volunteer-report IPC kind is the fix if stats ever
    // need PGLite coverage).
    if (!params.resolveEntities && isPostgres(cfg)) {
      const engine = await getPostgresEngine(cfg);
      if (engine) {
        if (pointers.length) {
          const { logDeliveredReflexPointers } = await import('./retrieval-reflex.ts');
          logDeliveredReflexPointers(engine, pointers);
        }
        if (volunteered.length) {
          const { volunteerEventRowsFrom, logVolunteerEventsFireAndForget } = await import('./volunteer-events.ts');
          logVolunteerEventsFireAndForget(
            engine,
            volunteerEventRowsFrom(volunteered, { channel: 'openclaw' }),
          );
        }
      }
    }

    writeHeartbeat(cfg, pointers.length + volunteered.length);
    return renderReflexAddition(block?.text ?? null, volunteered);
  } catch {
    return null; // fail-open: the live-context block still ships
  }
}

/**
 * Compose the final markdown: Arm 1's pointer block (pre-rendered) plus the
 * volunteered section in turn-context's exact idiom (the two lanes must not
 * drift in wire shape).
 */
export function renderReflexAddition(
  pointerText: string | null,
  volunteered: VolunteeredPage[],
): string | null {
  if (!volunteered.length) return pointerText;
  const lines: string[] = pointerText ? [pointerText, ''] : [];
  lines.push('## Brain pages the brain volunteers');
  for (const v of volunteered) {
    const syn = v.synopsis ? ` — ${v.synopsis}` : '';
    lines.push(`- **${v.display}** → \`${v.slug}\` (${v.confidence.toFixed(2)}, ${v.rationale})${syn}`);
  }
  return lines.join('\n');
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

export function isPostgres(cfg: GBrainConfig | null): boolean {
  if (cfg?.engine === 'postgres') return true;
  // engine unset but a database_url present → postgres (createEngine default).
  return !cfg?.engine && !!cfg?.database_url;
}

/**
 * Cathedral 5 — narrow EXPORTED accessor for the ladder's rung-3 cached
 * direct-Postgres connection (the checkpoint step in context-engine.ts's
 * compact() shares the SAME process-singleton — never a second connection,
 * never a duplicated cache). Returns null off-Postgres or during the
 * connect-failure cooldown.
 */
export async function getDirectPostgresEngine(cfg: GBrainConfig | null): Promise<BrainEngine | null> {
  if (!isPostgres(cfg)) return null;
  return getPostgresEngine(cfg);
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
  // Clear the race timer on settle (2026-08 wave, perf review): the volunteer
  // arm added a second instance per windowed turn, and an uncleared timer
  // parks the event loop for up to TIMEOUT_MS after the winner settled. The
  // LOSING promise itself is not cancelled (no AbortSignal threading through
  // the resolver rungs yet — noted on the single-pool micro-opt TODO).
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<null>((r) => {
        timer = setTimeout(() => r(null), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
