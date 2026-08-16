/**
 * discover.ts — harness-root discovery + the status gap table (cathedral-4).
 *
 * Discovery is CONFINED to the static harness roots (detect.ts) — this is
 * the untrusted-enumeration side of the trust split, so symlinks are
 * lstat-rejected and only the expected extensions are picked up. Consumer
 * exports have no canonical root and never appear here.
 *
 * The status table derives its "imported" side from PAGES (one paginated
 * listPages walk, client-side transcript_import filtering, distinct
 * session ids) — durable truth that catches late-arriving sessions no
 * watermark can. File↔session matching for the gap column uses the
 * session-id-in-filename property of the three JSONL harnesses; the Hermes
 * store is one file holding many sessions, so its gap is reported at
 * session granularity only.
 */

import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { TranscriptFormat } from './types.ts';
import { harnessRoots, type HarnessRoot } from './detect.ts';
import { isOpenclawCheckpointFile } from './openclaw.ts';

export interface DiscoveredFile {
  format: TranscriptFormat;
  path: string;
  bytes: number;
}

/** Recursively list regular files under root (lstat: symlinks are skipped). */
function walk(dir: string, out: string[], depth = 0): void {
  if (depth > 6) return; // harness layouts are shallow; don't wander
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(p, out, depth + 1);
    else if (st.isFile()) out.push(p);
  }
}

export function discoverTranscriptFiles(roots?: HarnessRoot[]): DiscoveredFile[] {
  const out: DiscoveredFile[] = [];
  for (const { format, root, extension } of harnessRoots(roots)) {
    if (format === 'hermes') {
      const store = join(root, 'state.db');
      try {
        const st = lstatSync(store);
        if (st.isFile()) out.push({ format, path: store, bytes: st.size });
      } catch {
        // No store — hermes simply absent from discovery.
      }
      continue;
    }
    const files: string[] = [];
    walk(root, files);
    for (const p of files) {
      if (!p.endsWith(extension)) continue;
      if (isOpenclawCheckpointFile(p)) continue;
      let bytes = 0;
      try {
        bytes = lstatSync(p).size;
      } catch {
        continue;
      }
      out.push({ format, path: p, bytes });
    }
  }
  return out;
}

export interface ImportedSessionIndex {
  /** harness → distinct imported session ids. */
  byHarness: Map<string, Set<string>>;
  pagesScanned: number;
}

/**
 * ONE frontmatter-only query — never a query per harness, and never
 * `SELECT p.*`: conversation pages carry bodies up to the split target
 * (~300KB per part by design), so a full-page walk at backfill scale
 * (thousands of sessions) would stream hundreds of MB just to read two
 * frontmatter keys. Both engines serve executeRaw.
 */
export async function indexImportedSessions(
  engine: BrainEngine,
  sourceId: string,
): Promise<ImportedSessionIndex> {
  const byHarness = new Map<string, Set<string>>();
  let pagesScanned = 0;
  const rows = await engine.executeRaw<{ frontmatter: unknown }>(
    `SELECT frontmatter FROM pages
     WHERE type = 'conversation' AND source_id = $1 AND deleted_at IS NULL`,
    [sourceId],
  );
  for (const row of rows) {
    pagesScanned++;
    const fm = (typeof row.frontmatter === 'string' ? JSON.parse(row.frontmatter) : row.frontmatter) as
      | Record<string, unknown>
      | null;
    const ti = fm?.transcript_import as { harness?: string; session_id?: string } | undefined;
    if (!ti || typeof ti.harness !== 'string' || typeof ti.session_id !== 'string') continue;
    let set = byHarness.get(ti.harness);
    if (!set) {
      set = new Set();
      byHarness.set(ti.harness, set);
    }
    set.add(ti.session_id);
  }
  return { byHarness, pagesScanned };
}

export interface StatusRow {
  format: TranscriptFormat;
  /** Files (stores, for hermes) found under the harness root. */
  found: number;
  /** Distinct imported session ids for this harness. */
  importedSessions: number;
  /** Found files with no imported session id in their basename (JSONL harnesses; null for hermes). */
  gapFiles: number | null;
}

export function buildStatusRows(
  discovered: DiscoveredFile[],
  imported: ImportedSessionIndex,
  roots?: HarnessRoot[],
): StatusRow[] {
  // The harness list derives from the ONE registry (harnessRoots) — a new
  // adapter added there appears in status automatically instead of silently
  // vanishing from the gap table.
  const formats = [...new Set(harnessRoots(roots).map((r) => r.format))];
  return formats.map((format) => {
    const files = discovered.filter((d) => d.format === format);
    const sessionIds = imported.byHarness.get(format) ?? new Set<string>();
    let gapFiles: number | null = null;
    if (format !== 'hermes') {
      gapFiles = files.filter((f) => {
        const base = f.path.split('/').pop() ?? '';
        // Fast path: for claude-code/openclaw the basename stem IS the
        // session id — a Set hit avoids the O(ids) substring scan.
        const stem = base.replace(/\.jsonl$/, '');
        if (sessionIds.has(stem)) return false;
        for (const id of sessionIds) {
          if (id && base.includes(id)) return false;
        }
        return true;
      }).length;
    }
    return { format, found: files.length, importedSessions: sessionIds.size, gapFiles };
  });
}
