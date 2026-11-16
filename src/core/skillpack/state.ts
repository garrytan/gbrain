/**
 * skillpack/state.ts — machine-owned install-state file at
 * `~/.gbrain/skillpack-state.json`.
 *
 * Codex outside-voice G1 fix: the original spec put TOFU SHA, pinned
 * commits, source URLs, rename maps, and per-source receipts inside
 * markdown comments in the user's RESOLVER.md / AGENTS.md. Codex
 * pointed out that an editable markdown trust store is fragile —
 * any agent or human edit corrupts provenance. v0.36 retired the
 * managed-block model entirely, so this file becomes the single
 * source of truth for "what third-party scaffolds happened, when,
 * from where, with what verified hash."
 *
 * v2 adds `roots`: per skills root (a workspace's `skills/` dir or a
 * harness skills dir, absolute) and skill, the sha256 of each file as gbrain
 * installed it (the install's base) and whether the skill is pinned.
 * `gbrain skillpack reference --update-untouched` updates a skill only when
 * every file still matches its base. A v1 file loads as v2 with no roots.
 *
 * Atomic update via a unique temp file + `rename()`. Schema-versioned.
 * Writers that read-modify-write go through `updateState`, which holds the
 * shared state lock (file-lock.ts) across the load and the save.
 */

import { assertLegacySkillFilesystemWrite } from './writer-guard.ts';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { dirname } from 'path';

import { acquireFileLock } from './file-lock.ts';

import { gbrainPath } from '../config.ts';

/** Schema version stamped on every state file. */
export const SKILLPACK_STATE_SCHEMA_VERSION = 'gbrain-skillpack-state-v2' as const;
const SKILLPACK_STATE_SCHEMA_V1 = 'gbrain-skillpack-state-v1';

/** Per-pack scaffold record. */
export interface SkillpackStateEntry {
  /** Pack name (matches skillpack.json `name`). */
  name: string;
  /** Pack version when scaffold ran. */
  version: string;
  /** Author display name (whatever the manifest declared). */
  author: string;
  /** Source URL or local path scaffold pulled from. */
  source: string;
  /** Source kind. */
  source_kind: 'git' | 'tarball' | 'local';
  /** Resolved git commit SHA when source_kind=git; null for tarball/local. */
  pinned_commit: string | null;
  /** SHA-256 of the tarball that was extracted when source_kind=tarball; null otherwise. */
  tarball_sha256: string | null;
  /** Tier the pack was on in the registry at scaffold time (informational only). */
  tier: 'endorsed' | 'community' | 'experimental' | 'dead' | 'local';
  /** ISO 8601 wall-clock timestamp of the scaffold (UTC). */
  scaffolded_at: string;
  /** Absolute path of the workspace where files were written. */
  workspace: string;
  /** Skill slugs the pack contributed (relative paths under skills/). */
  skill_slugs: string[];
}

/** One installed skill's base under a skills root. */
export interface InstalledSkillRecord {
  /** Path relative to the skills root (posix) → sha256 of the bytes gbrain wrote. */
  files: Record<string, string>;
  /** Pinned skills are never updated by --update-untouched. */
  pinned?: boolean;
  /** ISO 8601 UTC of the last base write. */
  recorded_at: string;
}

export interface SkillpackState {
  schema_version: typeof SKILLPACK_STATE_SCHEMA_VERSION;
  packs: SkillpackStateEntry[];
  /** Absolute skills root → skill slug → base record. loadState always fills it. */
  roots?: Record<string, Record<string, InstalledSkillRecord>>;
}

export type SkillpackStateErrorCode =
  | 'state_malformed_json'
  | 'state_schema_unknown'
  | 'state_atomic_write_failed';

export class SkillpackStateError extends Error {
  constructor(
    message: string,
    public code: SkillpackStateErrorCode,
  ) {
    super(message);
    this.name = 'SkillpackStateError';
  }
}



/** Default state file path. Override via `opts.statePath` in calling code. */
export function defaultStatePath(): string {
  return gbrainPath('skillpack-state.json');
}

/**
 * Load the state file. Returns an empty state on missing file (cold start).
 * Throws on malformed JSON or unknown schema version (forward-compat: a
 * future state.v2 file should not be silently downgraded).
 */
export function loadState(opts: { statePath?: string } = {}): SkillpackState {
  const path = opts.statePath ?? defaultStatePath();
  if (!existsSync(path)) return { schema_version: SKILLPACK_STATE_SCHEMA_VERSION, packs: [], roots: {} };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new SkillpackStateError(
      `skillpack-state.json is not valid JSON (${path}): ${(err as Error).message}`,
      'state_malformed_json',
    );
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SkillpackStateError(
      `skillpack-state.json must be a JSON object`,
      'state_malformed_json',
    );
  }

  const obj = raw as Record<string, unknown>;
  if (obj.schema_version !== SKILLPACK_STATE_SCHEMA_VERSION && obj.schema_version !== SKILLPACK_STATE_SCHEMA_V1) {
    throw new SkillpackStateError(
      `skillpack-state.json has unknown schema_version ${JSON.stringify(obj.schema_version)}; expected ${SKILLPACK_STATE_SCHEMA_VERSION}`,
      'state_schema_unknown',
    );
  }

  if (!Array.isArray(obj.packs)) {
    throw new SkillpackStateError(
      `skillpack-state.json.packs must be an array`,
      'state_malformed_json',
    );
  }

  const roots = obj.schema_version === SKILLPACK_STATE_SCHEMA_V1 ? {} : (obj.roots ?? {});
  if (typeof roots !== 'object' || roots === null || Array.isArray(roots)) {
    throw new SkillpackStateError(`skillpack-state.json.roots must be an object`, 'state_malformed_json');
  }
  return {
    schema_version: SKILLPACK_STATE_SCHEMA_VERSION,
    packs: obj.packs as SkillpackStateEntry[],
    roots: roots as NonNullable<SkillpackState['roots']>,
  };
}

/**
 * Persist state via atomic .tmp + rename. Caller is responsible for ensuring
 * the directory exists (gbrainPath returns paths under ~/.gbrain which
 * setup-gbrain ensures, but we mkdir defensively).
 */
export function saveState(state: SkillpackState, opts: { statePath?: string } = {}): void {
  const path = opts.statePath ?? defaultStatePath();
  assertLegacySkillFilesystemWrite(path);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  assertLegacySkillFilesystemWrite(tmp);
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o644 });
    assertLegacySkillFilesystemWrite(path);
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    throw new SkillpackStateError(
      `failed to atomically write skillpack-state.json to ${path}: ${(err as Error).message}`,
      'state_atomic_write_failed',
    );
  }
}

/** Find a pack entry by name. Returns undefined if not installed. */
export function findEntry(state: SkillpackState, name: string): SkillpackStateEntry | undefined {
  return state.packs.find((p) => p.name === name);
}

/**
 * Upsert a pack entry. Replaces any existing entry with the same name (e.g.
 * a re-scaffold at a newer version). Returns a new state value (immutable
 * update so tests can compare references).
 */
export function upsertEntry(state: SkillpackState, entry: SkillpackStateEntry): SkillpackState {
  const others = state.packs.filter((p) => p.name !== entry.name);
  return { ...state, packs: [...others, entry] };
}

/** Remove a pack entry by name. Returns a new state value. */
export function removeEntry(state: SkillpackState, name: string): SkillpackState {
  return { ...state, packs: state.packs.filter((p) => p.name !== name) };
}

/**
 * Identity check for the first-install-confirm prompt (codex G4).
 * Returns true when state already has an entry with the same name AND
 * same author AND same pinned-commit-or-tarball-SHA. The TOFU prompt
 * skips when this returns true.
 */
export function isAlreadyTrusted(
  state: SkillpackState,
  candidate: Pick<SkillpackStateEntry, 'name' | 'author' | 'pinned_commit' | 'tarball_sha256'>,
): boolean {
  const existing = findEntry(state, candidate.name);
  if (!existing) return false;
  if (existing.author !== candidate.author) return false;
  // Either pinned commit or tarball SHA must match (whichever is non-null).
  if (candidate.pinned_commit !== null) {
    return existing.pinned_commit === candidate.pinned_commit;
  }
  if (candidate.tarball_sha256 !== null) {
    return existing.tarball_sha256 === candidate.tarball_sha256;
  }
  // Local-path source — no identity to pin; treat as untrusted (always re-confirm).
  return false;
}

/**
 * Read-modify-write under the shared state lock. `fn` receives the current
 * state and returns the state to save (or null to save nothing). Callers that
 * also hold a workspace lock take it first.
 */
export async function updateState<T>(
  fn: (state: SkillpackState) => { state: SkillpackState | null; result: T },
  opts: { statePath?: string; timeoutMs?: number } = {},
): Promise<T> {
  const path = opts.statePath ?? defaultStatePath();
  const lock = await acquireFileLock(`${path}.lock`, { code: 'skillpack_state_locked', timeoutMs: opts.timeoutMs });
  try {
    const { state, result } = fn(loadState({ statePath: path }));
    if (state) saveState(state, { statePath: path });
    return result;
  } finally {
    lock.release();
  }
}

/** Record each file's base hash per skill under `skillsRoot` (merged over any existing record; pins are kept). */
export function withSkillBases(
  state: SkillpackState,
  skillsRoot: string,
  bases: Record<string, Record<string, string>>,
  now = new Date().toISOString(),
): SkillpackState {
  const root = { ...(state.roots?.[skillsRoot] ?? {}) };
  for (const [slug, files] of Object.entries(bases)) {
    if (Object.keys(files).length === 0) continue;
    const existing = root[slug];
    root[slug] = { ...existing, files: { ...(existing?.files ?? {}), ...files }, recorded_at: now };
  }
  return { ...state, roots: { ...state.roots, [skillsRoot]: root } };
}
