/**
 * skillpack/nag-state.ts — machine-owned install-nag state at
 * `~/.gbrain/skillpack-nag-state.json`.
 *
 * Sibling of skillpack-state.json (the install-provenance ledger keyed by pack
 * name). This file tracks the OPPOSITE: declines of brain-resident packs the
 * user has NOT installed, keyed by (brain_id, source_id, pack_name), so the
 * connect-time advisory can escalate-then-suppress instead of nagging forever.
 *
 * Why a separate file: skillpack-state.json's identity check
 * (`isAlreadyTrusted`) is keyed by name and is the source of truth for trusted
 * installs; folding decline-counts in would pollute it with "seen but never
 * installed" rows. Same atomic .tmp+rename + schema-version conventions.
 *
 * `decideNagAction` is a pure function — the heart of the nag policy — so the
 * escalation logic is unit-testable without touching disk.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname } from 'path';

import { gbrainPath } from '../config.ts';

export const SKILLPACK_NAG_SCHEMA_VERSION = 'gbrain-skillpack-nag-v1' as const;

/** Default declines before the advisory goes quiet for a given pack version. */
export const DEFAULT_NAG_CEILING = 3;

export interface NagEntry {
  /**
   * Stable identifier for the brain/source REPO that carries the pack —
   * derived from the source's canonical git remote when available, else a
   * deterministic fallback. NOT a bare local-path hash (diverges across
   * machines) and NOT the brain DB identity (which is a different axis).
   */
  brain_id: string;
  /** The source id the pack was discovered under. */
  source_id: string;
  /** Pack name (matches skillpack.json `name`). */
  pack_name: string;
  /** Pack version at the last prompt; a bump re-surfaces once + resets count. */
  pack_version: string;
  /** ISO 8601 UTC timestamp of the last advisory display. */
  prompted_at: string;
  /** Count of CLI-interactive displays the user did not act on. */
  declined_count: number;
  /** Hard-off: hit the ceiling or `--no-skill-nag`. */
  suppressed: boolean;
}

export interface NagState {
  schema_version: typeof SKILLPACK_NAG_SCHEMA_VERSION;
  entries: NagEntry[];
}

export type NagStateErrorCode = 'nag_malformed_json' | 'nag_schema_unknown' | 'nag_atomic_write_failed';

export class NagStateError extends Error {
  constructor(
    message: string,
    public code: NagStateErrorCode,
  ) {
    super(message);
    this.name = 'NagStateError';
  }
}

const EMPTY: NagState = { schema_version: SKILLPACK_NAG_SCHEMA_VERSION, entries: [] };

export function defaultNagStatePath(): string {
  return gbrainPath('skillpack-nag-state.json');
}

/**
 * Load nag state. Returns empty on missing file. On corrupt/unknown-schema
 * content, returns empty (fail-open: a broken nag file must never block a
 * `sources add`; the cost is one extra advisory display, not a crash).
 */
export function loadNagState(opts: { statePath?: string } = {}): NagState {
  const path = opts.statePath ?? defaultNagStatePath();
  if (!existsSync(path)) return { ...EMPTY, entries: [] };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    if (raw.schema_version !== SKILLPACK_NAG_SCHEMA_VERSION || !Array.isArray(raw.entries)) {
      return { ...EMPTY, entries: [] };
    }
    return { schema_version: SKILLPACK_NAG_SCHEMA_VERSION, entries: raw.entries as NagEntry[] };
  } catch {
    return { ...EMPTY, entries: [] };
  }
}

export function saveNagState(state: NagState, opts: { statePath?: string } = {}): void {
  const path = opts.statePath ?? defaultNagStatePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o644 });
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    throw new NagStateError(
      `failed to atomically write skillpack-nag-state.json to ${path}: ${(err as Error).message}`,
      'nag_atomic_write_failed',
    );
  }
}

export function findNag(
  state: NagState,
  key: { brain_id: string; source_id: string; pack_name: string },
): NagEntry | undefined {
  return state.entries.find(
    (e) => e.brain_id === key.brain_id && e.source_id === key.source_id && e.pack_name === key.pack_name,
  );
}

/** Upsert by (brain_id, source_id, pack_name). Returns a new state value. */
export function upsertNag(state: NagState, entry: NagEntry): NagState {
  const others = state.entries.filter(
    (e) =>
      !(e.brain_id === entry.brain_id && e.source_id === entry.source_id && e.pack_name === entry.pack_name),
  );
  return { schema_version: SKILLPACK_NAG_SCHEMA_VERSION, entries: [...others, entry] };
}

export interface NagDecision {
  show: boolean;
  /** Present only when show=true. */
  level?: 'full' | 'short';
  reason?: 'first' | 'reminder' | 'version_bump';
}

/**
 * Pure nag policy. Given the prior entry (or undefined) for a pack and the
 * current pack version + flags, decide whether and how to surface the advisory.
 *
 * - No prior entry → full advisory ('first').
 * - noNagFlag, prior suppressed, or declined_count >= ceiling → hidden.
 * - Same version, under ceiling → short reminder.
 * - Version bumped while still uninstalled → full advisory ('version_bump');
 *   the caller resets declined_count to 0 (a new version is new information).
 */
export function decideNagAction(
  entry: NagEntry | undefined,
  current: { pack_version: string; noNagFlag?: boolean; ceiling?: number },
): NagDecision {
  if (current.noNagFlag) return { show: false };
  if (!entry) return { show: true, level: 'full', reason: 'first' };
  if (entry.pack_version !== current.pack_version) {
    return { show: true, level: 'full', reason: 'version_bump' };
  }
  if (entry.suppressed) return { show: false };
  const ceiling = current.ceiling ?? DEFAULT_NAG_CEILING;
  if (entry.declined_count >= ceiling) return { show: false };
  return { show: true, level: 'short', reason: 'reminder' };
}

/**
 * Apply a decision: bump the entry for persistence. On version_bump the count
 * resets to 1 (this display). Otherwise increments. Marks suppressed once the
 * ceiling is reached so the next call short-circuits.
 */
export function recordNagDisplay(
  prior: NagEntry | undefined,
  key: { brain_id: string; source_id: string; pack_name: string },
  current: { pack_version: string; ceiling?: number; nowIso: string },
): NagEntry {
  const ceiling = current.ceiling ?? DEFAULT_NAG_CEILING;
  const versionChanged = !prior || prior.pack_version !== current.pack_version;
  const declined_count = versionChanged ? 1 : prior.declined_count + 1;
  return {
    brain_id: key.brain_id,
    source_id: key.source_id,
    pack_name: key.pack_name,
    pack_version: current.pack_version,
    prompted_at: current.nowIso,
    declined_count,
    suppressed: declined_count >= ceiling,
  };
}
