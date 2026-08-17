/**
 * skillpack/bridge-state.ts — machine-owned harness-bridge install ledger at
 * `~/.gbrain/skillpack-bridge-state.json`.
 *
 * Sibling of skillpack-state.json (whose loader deliberately DROPS unknown
 * top-level keys and re-saves the reduced object — an additive key there
 * would be erased by the next load+save cycle; see state.ts). Same atomic
 * .tmp+rename + schema-version conventions as nag-state.ts.
 *
 * Ownership model [CX7]: `written` accumulates ONLY `wrote_new` outcomes.
 * A `skipped_existing` file was NEVER ours — pre-existing user files stay
 * unowned, so rollback/remove can only ever touch files the bridge itself
 * created. Each written file carries its INSTALL-TIME sha256 [OV3] so the
 * reference lens can run a true three-way comparison: installed-hash vs
 * current-file vs current-source separates a LOCAL EDIT (file no longer
 * matches what we wrote) from UPSTREAM DRIFT (file untouched, source moved).
 *
 * Load is FAIL-OPEN: a corrupt or unknown-schema file degrades the lens
 * (the in-file stub marker is the fallback mode discriminator), it never
 * blocks an install.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname } from 'path';

import { gbrainPath } from '../config.ts';

export const SKILLPACK_BRIDGE_SCHEMA_VERSION = 'gbrain-skillpack-bridge-v1' as const;

export type BridgeMode = 'full' | 'stub';

export interface BridgeSlugRecord {
  /** Mode the bridge last WROTE files for this slug in. */
  mode: BridgeMode;
  /** relpath (under the install dest) → sha256 of the content we wrote. */
  files: Record<string, string>;
}

export interface BridgeEntry {
  /** Harness id (bridge vocabulary, e.g. 'claude-code'). */
  harness: string;
  /** Absolute install destination (the harness skills dir). */
  dest: string;
  /** Install scope when the harness distinguishes one. */
  scope?: 'user' | 'project';
  /** Persona requested on the most recent run (null = explicit --skill picks). */
  last_persona: string | null;
  /** Mode requested on the most recent run. */
  last_mode: BridgeMode;
  /** Per-slug written-file ledger (wrote_new outcomes only). */
  written: Record<string, BridgeSlugRecord>;
  /** gbrain VERSION at the most recent write. */
  gbrain_version: string;
  /** ISO 8601 UTC of the first install into this (harness, dest). */
  installed_at: string;
  /** ISO 8601 UTC of the most recent write. */
  updated_at: string;
}

export interface BridgeState {
  schema_version: typeof SKILLPACK_BRIDGE_SCHEMA_VERSION;
  entries: BridgeEntry[];
}

export class BridgeStateError extends Error {
  constructor(
    message: string,
    public code: 'bridge_state_atomic_write_failed',
  ) {
    super(message);
    this.name = 'BridgeStateError';
  }
}

const EMPTY: BridgeState = { schema_version: SKILLPACK_BRIDGE_SCHEMA_VERSION, entries: [] };

export function defaultBridgeStatePath(): string {
  return gbrainPath('skillpack-bridge-state.json');
}

/**
 * Load bridge state. Missing file → empty. Corrupt / unknown schema →
 * empty (fail-open: state only powers the lens and remove; the in-file
 * stub marker recovers mode detection after state loss).
 */
export function loadBridgeState(opts: { statePath?: string } = {}): BridgeState {
  const path = opts.statePath ?? defaultBridgeStatePath();
  if (!existsSync(path)) return { ...EMPTY, entries: [] };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    if (raw.schema_version !== SKILLPACK_BRIDGE_SCHEMA_VERSION || !Array.isArray(raw.entries)) {
      return { ...EMPTY, entries: [] };
    }
    // Fail-open applies PER ENTRY too: a shape-corrupt entry (right schema
    // version, wrong shape) must degrade to "dropped", never crash a
    // downstream consumer like `skillpack status` — the fail-open promise
    // is about the whole plane, not just the envelope.
    const entries = (raw.entries as unknown[]).filter((e): e is BridgeEntry => {
      if (typeof e !== 'object' || e === null) return false;
      const entry = e as Partial<BridgeEntry>;
      return (
        typeof entry.harness === 'string' &&
        typeof entry.dest === 'string' &&
        typeof entry.written === 'object' &&
        entry.written !== null &&
        !Array.isArray(entry.written) &&
        Object.values(entry.written).every(
          rec =>
            typeof rec === 'object' &&
            rec !== null &&
            (rec as BridgeSlugRecord).files !== null &&
            typeof (rec as BridgeSlugRecord).files === 'object' &&
            !Array.isArray((rec as BridgeSlugRecord).files) &&
            Object.values((rec as BridgeSlugRecord).files).every(h => typeof h === 'string'),
        )
      );
    });
    return { schema_version: SKILLPACK_BRIDGE_SCHEMA_VERSION, entries };
  } catch {
    return { ...EMPTY, entries: [] };
  }
}

export function saveBridgeState(state: BridgeState, opts: { statePath?: string } = {}): void {
  const path = opts.statePath ?? defaultBridgeStatePath();
  // Unique tmp name: two concurrent gbrain processes must not rename each
  // other's half-written tmp into place.
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o644 });
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    throw new BridgeStateError(
      `failed to atomically write skillpack-bridge-state.json to ${path}: ${(err as Error).message}`,
      'bridge_state_atomic_write_failed',
    );
  }
}

export function findBridgeEntry(
  state: BridgeState,
  key: { harness: string; dest: string },
): BridgeEntry | undefined {
  return state.entries.find(e => e.harness === key.harness && e.dest === key.dest);
}

export interface BridgeWriteRecord {
  slug: string;
  mode: BridgeMode;
  /** relpath under dest → sha256 of written content. */
  files: Record<string, string>;
}

/**
 * Record a run's writes into the (harness, dest) entry. Additive across
 * runs: written maps UNION in (per-slug; a re-write of the same relpath
 * updates its hash, a new slug adds a record). skipped_existing files are
 * never passed here — callers only report wrote_new outcomes.
 */
export function recordBridgeWrites(
  state: BridgeState,
  key: {
    harness: string;
    dest: string;
    scope?: 'user' | 'project';
    persona: string | null;
    mode: BridgeMode;
    gbrainVersion: string;
    nowIso: string;
  },
  writes: BridgeWriteRecord[],
): BridgeState {
  const prior = findBridgeEntry(state, key);
  const written: Record<string, BridgeSlugRecord> = { ...(prior?.written ?? {}) };
  for (const w of writes) {
    const existing = written[w.slug];
    written[w.slug] = {
      mode: w.mode,
      files: { ...(existing?.files ?? {}), ...w.files },
    };
  }
  const entry: BridgeEntry = {
    harness: key.harness,
    dest: key.dest,
    // A later run that omits scope must not erase the recorded one.
    ...((key.scope ?? prior?.scope) ? { scope: key.scope ?? prior?.scope } : {}),
    last_persona: key.persona,
    last_mode: key.mode,
    written,
    gbrain_version: key.gbrainVersion,
    installed_at: prior?.installed_at ?? key.nowIso,
    updated_at: key.nowIso,
  };
  const others = state.entries.filter(e => !(e.harness === key.harness && e.dest === key.dest));
  return { schema_version: SKILLPACK_BRIDGE_SCHEMA_VERSION, entries: [...others, entry] };
}

/**
 * Drop slugs from an entry's written ledger (the remove command). Returns
 * the new state; the entry itself is dropped once its ledger is empty.
 */
export function removeBridgeSlugs(
  state: BridgeState,
  key: { harness: string; dest: string; nowIso: string },
  slugs: readonly string[],
): BridgeState {
  const prior = findBridgeEntry(state, key);
  if (!prior) return state;
  const written = { ...prior.written };
  for (const slug of slugs) delete written[slug];
  const others = state.entries.filter(e => !(e.harness === key.harness && e.dest === key.dest));
  if (Object.keys(written).length === 0) {
    return { schema_version: SKILLPACK_BRIDGE_SCHEMA_VERSION, entries: others };
  }
  return {
    schema_version: SKILLPACK_BRIDGE_SCHEMA_VERSION,
    entries: [...others, { ...prior, written, updated_at: key.nowIso }],
  };
}
