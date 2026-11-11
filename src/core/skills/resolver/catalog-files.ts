/**
 * The catalog files the turn path reads: a catalog's receipt, the list of
 * built catalogs and the sliced stat freshness check over a directory
 * catalog's fingerprint. It imports no source parser (no SKILL.md
 * frontmatter, no YAML), so the hook lane's worker loads only what a turn
 * needs; build.ts and sources.ts take these from here.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readBounded } from './fsutil.ts';
import { catalogFile, skillIndexRoot, validCatalogName } from './paths.ts';
import type { BuildReceipt } from './build.ts';
import type { DirFingerprint } from './sources.ts';

const RECEIPT_CAP_BYTES = 32 * 1024 * 1024;

export function readReceipt(home: string, name: string): BuildReceipt | null {
  try {
    const b = readBounded(catalogFile(home, name, 'receipt.json'), RECEIPT_CAP_BYTES);
    if (b === 'too_large') return null;
    const r = JSON.parse(b.toString('utf8')) as BuildReceipt;
    return r && typeof r === 'object' && r.catalog && r.index ? r : null;
  } catch { return null; }
}

export function listCatalogs(home: string): string[] {
  try {
    return readdirSync(skillIndexRoot(home)).filter(n => validCatalogName(n) && existsSync(join(skillIndexRoot(home), n, 'receipt.json'))).sort();
  } catch { return []; }
}

/** Recheck a directory fingerprint by stat only (the turn-path freshness tier). */
export function fingerprintChanged(fp: DirFingerprint, routing?: [string, number, number]): boolean {
  try {
    for (const [d, m] of fp.dirs) if (statSync(d).mtimeMs !== m) return true;
    for (const [f, size, m] of fp.files) { const st = statSync(f); if (st.size !== size || st.mtimeMs !== m) return true; }
    if (routing) { const st = statSync(routing[0]); if (st.size !== routing[1] || st.mtimeMs !== routing[2]) return true; }
    return false;
  } catch {
    return true;
  }
}

export function dirFingerprintSlice(home: string, name: string, cursor: number, limit: number): { changed: boolean; next: number } {
  try {
    const f = JSON.parse(readFileSync(catalogFile(home, name, 'fingerprint.json'), 'utf8')) as { fingerprint: DirFingerprint; routing: [string, number, number] | null };
    const { dirs, files } = f.fingerprint;
    const total = dirs.length + files.length;
    const from = cursor > 0 && cursor < total ? cursor : 0;
    const to = Math.min(total, from + limit);
    const part: DirFingerprint = { dirs: dirs.slice(Math.min(from, dirs.length), Math.min(to, dirs.length)), files: files.slice(Math.max(0, from - dirs.length), Math.max(0, to - dirs.length)) };
    return { changed: fingerprintChanged(part, f.routing ?? undefined), next: to >= total ? 0 : to };
  } catch { return { changed: true, next: 0 }; }
}
