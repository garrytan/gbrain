import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Tamper-evidence manifest for the bundled `skills/` tree (#159).
 *
 * NOT a signature system: the manifest is a committed sha256 inventory that
 * makes silent edits to bundled skill files visible (doctor warns, CI diffs).
 * Anyone who can edit skills/ can also regenerate the manifest — the value is
 * that the edit becomes an explicit, reviewable diff instead of an invisible
 * behavior change in a fat-markdown skill an agent will later execute.
 *
 * Regenerate after any change under skills/:
 *   bun run scripts/generate-skills-manifest.ts
 * Freshness is CI-guarded by scripts/check-skills-manifest-fresh.sh.
 */

/** Committed manifest filename, lives inside the skills dir it describes. */
export const SKILLS_MANIFEST_FILENAME = 'skills.lock.json';

/** Relative posix path → sha256 hex digest. */
export type SkillsManifest = Record<string, string>;

export interface SkillsManifestDrift {
  /** Present in manifest and on disk, but content hash differs. */
  modified: string[];
  /** Present in manifest, absent on disk. */
  missing: string[];
  /** Present on disk, absent from manifest. */
  extra: string[];
}

/**
 * Hash every regular file under `dir` (recursive). Paths are '/'-separated
 * relative paths, sorted, so output is deterministic across platforms. The
 * manifest file itself is excluded from its own hash set. Symlinks and other
 * non-regular entries are skipped.
 */
export function computeSkillsManifest(dir: string): SkillsManifest {
  const files: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(relPath);
      else if (entry.isFile() && relPath !== SKILLS_MANIFEST_FILENAME) files.push(relPath);
    }
  };
  walk('');
  files.sort();
  const manifest: SkillsManifest = {};
  for (const f of files) {
    manifest[f] = createHash('sha256').update(readFileSync(join(dir, f))).digest('hex');
  }
  return manifest;
}

/** Canonical serialized form: 2-space JSON + trailing newline. */
export function renderSkillsManifest(dir: string): string {
  return JSON.stringify(computeSkillsManifest(dir), null, 2) + '\n';
}

/** Compare `dir`'s current contents against a previously computed manifest. */
export function verifySkillsManifest(dir: string, manifest: SkillsManifest): SkillsManifestDrift {
  const actual = computeSkillsManifest(dir);
  const modified: string[] = [];
  const missing: string[] = [];
  for (const [path, hash] of Object.entries(manifest)) {
    if (!(path in actual)) missing.push(path);
    else if (actual[path] !== hash) modified.push(path);
  }
  const extra = Object.keys(actual).filter((p) => !(p in manifest));
  return { modified, missing, extra };
}

/** Append-only record of every released hash of each bundled file; lives beside the lock, which records its hash. */
export const SKILLS_LOCK_HISTORY_FILENAME = 'skills.lock.history.json';
export const SKILLS_LOCK_HISTORY_SCHEMA = 'gbrain-skills-lock-history-v1';

export interface SkillsLockHistory {
  schema_version: typeof SKILLS_LOCK_HISTORY_SCHEMA;
  /** Skills-relative posix path → every released sha256 of that file, sorted. */
  files: Record<string, string[]>;
}

export function parseSkillsLockHistory(text: string): SkillsLockHistory {
  const raw = JSON.parse(text) as Partial<SkillsLockHistory>;
  if (raw?.schema_version !== SKILLS_LOCK_HISTORY_SCHEMA || typeof raw.files !== 'object' || raw.files === null || Array.isArray(raw.files)) {
    throw new Error(`${SKILLS_LOCK_HISTORY_FILENAME} is not a ${SKILLS_LOCK_HISTORY_SCHEMA} document`);
  }
  for (const [path, hashes] of Object.entries(raw.files)) {
    if (!Array.isArray(hashes) || !hashes.every(h => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h))) {
      throw new Error(`${SKILLS_LOCK_HISTORY_FILENAME}: ${path} must list sha256 hex digests`);
    }
  }
  return { schema_version: SKILLS_LOCK_HISTORY_SCHEMA, files: raw.files as Record<string, string[]> };
}

/** Union of `history` and the lock's hashes (the lock's own entry for the history file is skipped). Sorted, deterministic. */
export function mergeSkillsLockHistory(history: SkillsLockHistory | null, lock: SkillsManifest): SkillsLockHistory {
  const merged = new Map<string, Set<string>>();
  for (const [path, hashes] of Object.entries(history?.files ?? {})) merged.set(path, new Set(hashes));
  for (const [path, hash] of Object.entries(lock)) {
    if (path === SKILLS_LOCK_HISTORY_FILENAME) continue;
    (merged.get(path) ?? merged.set(path, new Set()).get(path)!).add(hash);
  }
  const files: Record<string, string[]> = {};
  for (const path of [...merged.keys()].sort()) files[path] = [...merged.get(path)!].sort();
  return { schema_version: SKILLS_LOCK_HISTORY_SCHEMA, files };
}

export function renderSkillsLockHistory(history: SkillsLockHistory): string {
  return JSON.stringify(history, null, 2) + '\n';
}

/** Every (path, hash) in `previous` that `current` dropped: the append-only contract's violations. */
export function droppedHistoryEntries(previous: SkillsLockHistory, current: SkillsLockHistory): string[] {
  const dropped: string[] = [];
  for (const [path, hashes] of Object.entries(previous.files)) {
    const kept = new Set(current.files[path] ?? []);
    for (const hash of hashes) if (!kept.has(hash)) dropped.push(`${path} ${hash}`);
  }
  return dropped;
}

export type VerifiedSkillsLockHistory =
  | { ok: true; history: SkillsLockHistory }
  | { ok: false; reason: string };

/**
 * Read the history beside `skillsDir`'s lock and verify its sha256 against
 * the lock's entry for it. Corruption detection only: a missing lock, a
 * missing history, a hash mismatch or an unparseable file is `ok: false`.
 */
export function loadVerifiedSkillsLockHistory(skillsDir: string): VerifiedSkillsLockHistory {
  let lock: SkillsManifest;
  let bytes: Buffer;
  try {
    lock = JSON.parse(readFileSync(join(skillsDir, SKILLS_MANIFEST_FILENAME), 'utf-8')) as SkillsManifest;
    bytes = readFileSync(join(skillsDir, SKILLS_LOCK_HISTORY_FILENAME));
  } catch (err) {
    return { ok: false, reason: `cannot read ${SKILLS_MANIFEST_FILENAME} or ${SKILLS_LOCK_HISTORY_FILENAME}: ${(err as Error).message}` };
  }
  const expected = lock[SKILLS_LOCK_HISTORY_FILENAME];
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (!expected) return { ok: false, reason: `${SKILLS_MANIFEST_FILENAME} records no hash for ${SKILLS_LOCK_HISTORY_FILENAME}` };
  if (expected !== actual) return { ok: false, reason: `${SKILLS_LOCK_HISTORY_FILENAME} sha256 ${actual.slice(0, 12)} does not match the lock's ${expected.slice(0, 12)}` };
  try {
    return { ok: true, history: parseSkillsLockHistory(bytes.toString('utf-8')) };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}
