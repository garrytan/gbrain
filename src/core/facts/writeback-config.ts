/**
 * Ambient memory writeback — config resolution (opt-in, default OFF).
 *
 * `memory.auto_writeback = off | salient | all` gates the activation layer:
 * the ambient-writeback section of the MCP initialize instructions, the
 * managed bootstrap instruction blocks, and the Stop-hook extraction
 * backstop. Two planes carry the keys and `gbrain config set memory.*`
 * DUAL-WRITES both (src/commands/config.ts):
 *
 *   - DB plane (`config` table) — AUTHORITATIVE. The serve-side harvest gate
 *     re-checks it before any extraction (`writeback_off` sidecar), so a
 *     stale file plane can never extract against operator intent.
 *   - file plane (`~/.gbrain/config.json` → `memory` slot) — the mirror the
 *     ENGINE-FREE readers use: the Stop-hook child (which must never open
 *     the engine — PGLite single-writer) and the bootstrap-harness renderer.
 *
 * The engine path resolves mode/ttl from the DB PLANE ONLY. The file mirror
 * never enables a brain whose DB never opted in — it is machine-global while
 * DB rows are per-brain, so a file fallback would let brain A's opt-in leak
 * into a mounted/selected brain B (adversarial review, this wave). When a
 * `fileCfg` is provided it serves two narrower jobs instead:
 *   - DRIFT detection: DB row absent + file mirror enabled ⇒ `plane_drift`
 *     (a failed dual-write, a reinitialized DB, or a foreign writer). Gate
 *     callers treat drift as NOT operator intent: skip WITHOUT the terminal
 *     sidecar so banked turns survive until the planes re-sync. An EXPLICIT
 *     DB 'off' row is intent and never drift.
 *   - LKG override: a file mirror that explicitly says 'off' beats the
 *     last-known-good ENABLED bundle on a read failure (an operator's flip
 *     to off must win even mid-blip).
 *
 * Fail direction is CLOSED: unset, unrecognized, or unreadable → `off`.
 * The per-request (OAuth) lane additionally keeps a LAST-KNOWN-GOOD bundle
 * per engine so a transient DB blip mid-session serves the previous resolved
 * bundle instead of silently dropping the ambient contract — the bundle is
 * cached ATOMICALLY (mode + ttl + visibility together); a cached mode is
 * never mixed with a freshly-defaulted visibility.
 *
 * Visibility posture (F5 — the unset trap): this resolver reads the RAW
 * `facts.default_visibility` value, NOT resolveDefaultVisibility(), because
 * that helper fail-closes UNSET to 'private' — correct for reads, wrong for
 * write guidance: a template telling agents to write private-by-default on
 * every default install would make ambient facts invisible to the very
 * remote agents that saved them (remote recall is world-only). So: unset →
 * 'world' (the `remember` verb's own documented default — the round-trip
 * works); only an explicit non-'world' value → 'private' posture, with the
 * recall trade-off surfaced by doctor and the guide. An explicit private is
 * never widened.
 */

import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { validateTtlConfig } from './ttl-parse.ts';

export const AUTO_WRITEBACK_KEY = 'memory.auto_writeback';
export const AUTO_WRITEBACK_TTL_KEY = 'memory.auto_writeback_transient_ttl';
/** Fire-once consent-nudge sentinel (WP8). */
export const AUTO_WRITEBACK_NOTICE_KEY = 'memory.auto_writeback_notice_shown';

export const WRITEBACK_MODES = Object.freeze(['off', 'salient', 'all'] as const);
export type WritebackMode = (typeof WRITEBACK_MODES)[number];
export const DEFAULT_TRANSIENT_TTL = '3d';

/** Engine-free resolution (hook child + stdio boot): no visibility arm. */
export interface WritebackFileConfig {
  mode: WritebackMode;
  enabled: boolean;
  /** false = a value was present but unrecognized (fell back to 'off'). */
  mode_valid: boolean;
  raw_mode: string | null;
  transient_ttl: string;
  ttl_valid: boolean;
  /** The visibility POSTURE stamped into the file mirror by `gbrain config
   * set memory.*` (which has the engine and resolves the DB-plane
   * `facts.default_visibility`). Engine-free consumers (the bootstrap
   * harness block renderer) use this; absent → 'world' (F5's unset default).
   * Staleness after a later `facts.default_visibility` flip is caught by
   * doctor's block-drift check (OV-A3), which compares against DB truth. */
  visibility_posture: 'world' | 'private';
}

/** F5 semantics in one place: unset/empty → world (the verb default — never
 * an explicit private to widen); ONLY the literal 'world' opts in on the
 * explicit side; anything else is honored as an explicit private posture
 * (matching visibility.ts's fail direction for garbage). */
export function visibilityPostureFromRaw(raw: string | null | undefined): { visibility: 'world' | 'private'; explicit_private: boolean } {
  const v = raw == null ? '' : raw.trim().toLowerCase();
  const explicit = v !== '' && v !== 'world';
  return { visibility: explicit ? 'private' : 'world', explicit_private: explicit };
}

export interface WritebackConfig extends WritebackFileConfig {
  /** Posture the instruction template embeds (see module header). */
  visibility: 'world' | 'private';
  /** true only when the operator explicitly set a non-world default. */
  visibility_explicit_private: boolean;
  /** Present when every read failed and no last-known-good existed. */
  read_error?: true;
  /** Present when the DB plane has NO row while the provided file mirror
   * says enabled — the planes diverged (see module header). Gate callers
   * skip WITHOUT the terminal sidecar; doctor names the re-sync command. */
  plane_drift?: true;
}

function normalizeMode(raw: unknown): Pick<WritebackFileConfig, 'mode' | 'mode_valid' | 'raw_mode'> {
  if (raw == null) return { mode: 'off', mode_valid: true, raw_mode: null };
  const s = String(raw).trim().toLowerCase();
  if (!s) return { mode: 'off', mode_valid: true, raw_mode: null };
  if ((WRITEBACK_MODES as readonly string[]).includes(s)) {
    return { mode: s as WritebackMode, mode_valid: true, raw_mode: s };
  }
  return { mode: 'off', mode_valid: false, raw_mode: s };
}

/** Engine-free variant for the Stop-hook child and the harness renderer. */
export function resolveWritebackConfigFromFile(cfg: GBrainConfig | null | undefined): WritebackFileConfig {
  const mem = cfg?.memory;
  const m = normalizeMode(mem?.auto_writeback);
  const t = validateTtlConfig(mem?.auto_writeback_transient_ttl, DEFAULT_TRANSIENT_TTL);
  const posture = mem?.visibility_posture === 'private' ? 'private' : 'world';
  return { ...m, enabled: m.mode !== 'off', transient_ttl: t.ttl, ttl_valid: t.valid, visibility_posture: posture };
}

const OFF_BUNDLE: WritebackConfig = Object.freeze({
  mode: 'off', enabled: false, mode_valid: true, raw_mode: null,
  transient_ttl: DEFAULT_TRANSIENT_TTL, ttl_valid: true,
  visibility: 'world', visibility_explicit_private: false,
  visibility_posture: 'world',
});

/** Last-known-good bundles, keyed per engine instance (per-brain). */
const lkg = new WeakMap<BrainEngine, WritebackConfig>();

/**
 * Shared transport-side mapping to the instruction builder's opts (three
 * transports render the section; one mapping keeps a future field a
 * one-site change).
 *
 * `avail` carries what THIS caller's token/surface can actually invoke:
 * no `remember` ⇒ NO section at all (instructions must never order calls
 * dispatch will deny — the bound-client fence hides `remember` from
 * slug-bound OAuth clients, and a clamped surface can drop it too);
 * `extract_facts` availability only shapes the multi-fact line.
 */
export function ambientOptsFrom(
  wb: WritebackConfig,
  avail: { remember: boolean; extractFacts: boolean },
): AmbientOptsShape | null {
  if (!wb.enabled || wb.mode === 'off') return null;
  if (!avail.remember) return null;
  return {
    mode: wb.mode,
    transientTtl: wb.transient_ttl,
    visibility: wb.visibility,
    extractFactsAvailable: avail.extractFacts,
  };
}
interface AmbientOptsShape {
  mode: 'salient' | 'all';
  transientTtl: string;
  visibility: 'world' | 'private';
  extractFactsAvailable: boolean;
}

/**
 * DB-plane resolution (fail-closed off) + the visibility posture. Never
 * throws. `fileCfg` is DRIFT/LKG input only, never an enablement source —
 * see the module header (the mirror is machine-global; DB rows are
 * per-brain).
 *
 * Failure semantics split by CONSUMER (security review, this wave):
 *   - default (instructions lanes): total read failure returns the engine's
 *     last-known-good bundle — a transient DB blip must not silently drop
 *     the ambient contract mid-session; no LKG → OFF + `read_error`. A file
 *     mirror that explicitly says 'off' overrides the LKG (an operator flip
 *     to off wins even mid-blip).
 *   - `{ gate: true }` (the EXTRACTION gates: serve harvest + sweep): NEVER
 *     serves an LKG-enabled bundle — an operator who flipped the setting off
 *     must win even during a DB blip, so a read failure is OFF +
 *     `read_error` unconditionally. Gate callers skip WITHOUT a terminal
 *     sidecar on `read_error` OR `plane_drift` OR an invalid mode value, so
 *     the banked work retries once the config is coherent again.
 */
export async function resolveWritebackConfig(
  engine: BrainEngine,
  fileCfg?: GBrainConfig | null,
  opts?: { gate?: boolean },
): Promise<WritebackConfig> {
  try {
    const [dbMode, dbTtl, rawVisibility] = await Promise.all([
      engine.getConfig(AUTO_WRITEBACK_KEY),
      engine.getConfig(AUTO_WRITEBACK_TTL_KEY),
      engine.getConfig('facts.default_visibility'),
    ]);
    const m = normalizeMode(dbMode);
    const t = validateTtlConfig(dbTtl, DEFAULT_TRANSIENT_TTL);
    const posture = visibilityPostureFromRaw(rawVisibility);
    // Drift: the DB has NO row while the file mirror claims enabled. An
    // explicit DB 'off' is operator intent — never drift.
    const fileClaims = fileCfg?.memory?.auto_writeback;
    const drift = dbMode == null && fileClaims != null && normalizeMode(fileClaims).mode !== 'off';
    const bundle: WritebackConfig = {
      ...m,
      enabled: m.mode !== 'off',
      transient_ttl: t.ttl,
      ttl_valid: t.valid,
      visibility: posture.visibility,
      visibility_explicit_private: posture.explicit_private,
      visibility_posture: posture.visibility,
      ...(drift ? { plane_drift: true as const } : {}),
    };
    lkg.set(engine, bundle);
    return bundle;
  } catch {
    const fileSaysOff = fileCfg?.memory?.auto_writeback != null
      && normalizeMode(fileCfg.memory.auto_writeback).mode === 'off';
    if (!opts?.gate && !fileSaysOff) {
      const cached = lkg.get(engine);
      if (cached) return cached;
    }
    return { ...OFF_BUNDLE, read_error: true };
  }
}
