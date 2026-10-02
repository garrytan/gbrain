/**
 * Group/world-readable files that gbrain wrote under a Google source
 * directory outside `~/.gbrain` (the home is forced 0700, so files inside it
 * are already private). Releases before the security fix wave wrote pages
 * and cursor state with the process umask, typically 0644, and only a
 * rewrite tightens them, so historical mail can stay readable by other local
 * users.
 *
 * Only gbrain's own layout is considered: the cursor state file and its
 * siblings (`.google-source.json*`), page files recorded for the source
 * under `emails/`, `calendar/` and `people/`, their stale `.tmp` files, and
 * the directories between the source root and those pages. The root the
 * user chose is never reported or changed, no path through a symlink is
 * followed, and entries another user owns are counted and left alone.
 * Tightening clears the group and other bits and keeps the owner bits.
 */
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { configDir } from '../config.ts';
import { isPathContained } from '../path-confine.ts';
import { parseGoogleSourceConfig } from './source-config.ts';

const LAYOUT = new Set(['emails', 'calendar', 'people']);
const STATE_PREFIX = '.google-source.json';

export interface LooseEntry { rel: string; kind: 'file' | 'dir'; mode: number }

export interface GoogleDirScan {
  sourceId: string;
  dir: string;
  loose: LooseEntry[];
  /** Entries left alone: a symlink on the path, another owner, or not the expected file type. */
  skipped: { symlink: number; foreign_owner: number; not_regular: number };
}

/** The source dir is outside the brain home, where its own permissions are the only protection. */
export function outsideGbrainHome(dir: string): boolean {
  const resolve = (path: string) => { try { return realpathSync(path); } catch { return path; } };
  return !isPathContained(resolve(dir), resolve(configDir()));
}

function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

type Verdict = { ok: true; mode: number } | { ok: false; reason: 'symlink' | 'foreign_owner' | 'not_regular' | 'missing' };

/** Lstat every component below `root` without following a symlink; the leaf must be `kind` and owned by this user. */
function inspect(root: string, rel: string, kind: LooseEntry['kind'], dirs: Map<string, Verdict>): Verdict {
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join('/');
    let verdict = dirs.get(prefix);
    if (!verdict) {
      verdict = check(join(root, ...parts.slice(0, i)), 'dir');
      dirs.set(prefix, verdict);
    }
    if (!verdict.ok) return verdict;
  }
  return check(join(root, ...parts), kind);
}

function check(path: string, kind: LooseEntry['kind']): Verdict {
  let stat;
  try { stat = lstatSync(path); } catch { return { ok: false, reason: 'missing' }; }
  if (stat.isSymbolicLink()) return { ok: false, reason: 'symlink' };
  if (kind === 'dir' ? !stat.isDirectory() : !stat.isFile()) return { ok: false, reason: 'not_regular' };
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) return { ok: false, reason: 'foreign_owner' };
  return { ok: true, mode: stat.mode & 0o7777 };
}

export async function scanGoogleFileModes(engine: BrainEngine, opts: { sourceIds?: string[] } = {}): Promise<GoogleDirScan[]> {
  if (process.platform === 'win32') return [];
  const sources = await engine.executeRaw<{ id: string; local_path: string | null; config: Record<string, unknown> }>(
    "SELECT id, local_path, config FROM sources WHERE archived IS NOT TRUE AND config->>'kind'='google' ORDER BY id");
  const scans: GoogleDirScan[] = [];
  for (const source of sources) {
    if (opts.sourceIds && !opts.sourceIds.includes(source.id)) continue;
    const dir = parseGoogleSourceConfig(source.config, source.local_path ?? '').dir;
    if (!dir || !outsideGbrainHome(dir)) continue;
    const scan: GoogleDirScan = { sourceId: source.id, dir, loose: [], skipped: { symlink: 0, foreign_owner: 0, not_regular: 0 } };
    const candidates = new Map<string, LooseEntry['kind']>();
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { /* a missing dir has nothing to tighten */ }
    for (const name of names) if (name.startsWith(STATE_PREFIX)) candidates.set(name, 'file');
    const pages = await engine.executeRaw<{ source_path: string }>(
      'SELECT source_path FROM pages WHERE source_id=$1 AND source_path IS NOT NULL ORDER BY source_path', [source.id]);
    for (const { source_path: rel } of pages) {
      const parts = rel.split('/');
      if (parts.length < 2 || !LAYOUT.has(parts[0]) || parts.some(part => !part || part === '.' || part === '..') || rel.includes('\\')) continue;
      for (let i = 1; i < parts.length; i++) candidates.set(parts.slice(0, i).join('/'), 'dir');
      candidates.set(rel, 'file');
      candidates.set(`${rel}.tmp`, 'file');
    }
    const dirs = new Map<string, Verdict>();
    for (const [rel, kind] of [...candidates].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const verdict = inspect(dir, rel, kind, dirs);
      if (verdict.ok) { if (verdict.mode & 0o077) scan.loose.push({ rel, kind, mode: verdict.mode }); }
      else if (verdict.reason !== 'missing' && !(rel.endsWith('.tmp') && verdict.reason === 'not_regular')) scan.skipped[verdict.reason]++;
    }
    scans.push(scan);
  }
  return scans;
}

/**
 * Clear the group and other bits of one scanned entry. The path is re-checked
 * (no symlink on the way, owned by this user) and the leaf is opened with
 * O_NOFOLLOW, so a swap after the scan is refused rather than followed.
 */
export function tightenGoogleEntry(root: string, entry: Pick<LooseEntry, 'rel' | 'kind'>):
  { outcome: 'tightened' | 'already_private' | 'skipped'; reason?: string; mode?: number } {
  const verdict = inspect(root, entry.rel, entry.kind, new Map());
  if (!verdict.ok) return verdict.reason === 'missing' ? { outcome: 'skipped', reason: 'missing' } : { outcome: 'skipped', reason: verdict.reason };
  let fd: number;
  try {
    fd = openSync(join(root, ...entry.rel.split('/')), constants.O_RDONLY | constants.O_NOFOLLOW | (entry.kind === 'dir' ? constants.O_DIRECTORY : 0));
  } catch (error) {
    return { outcome: 'skipped', reason: (error as NodeJS.ErrnoException).code ?? 'open_failed' };
  }
  try {
    const stat = fstatSync(fd);
    const uid = currentUid();
    if (uid !== null && stat.uid !== uid) return { outcome: 'skipped', reason: 'foreign_owner' };
    const mode = stat.mode & 0o7777;
    if (!(mode & 0o077)) return { outcome: 'already_private', mode };
    fchmodSync(fd, mode & ~0o077);
    return { outcome: 'tightened', mode: mode & ~0o077 };
  } finally {
    closeSync(fd);
  }
}

export function googleFileModesPreviewCommand(sourceId: string): string {
  return `gbrain repair google-file-modes --source ${sourceId}`;
}

export function googleFileModesApplyCommand(sourceId: string): string {
  return `gbrain repair google-file-modes --source ${sourceId} --apply`;
}
