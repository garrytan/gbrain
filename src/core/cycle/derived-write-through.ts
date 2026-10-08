/**
 * Opt-in markdown write-through for pages the dream cycle generates on an
 * unmanaged brain (#5041): atoms (`extract_atoms`) and concepts
 * (`synthesize_concepts`). Off by default, so the cycle never adds files to a
 * user's repository unasked; managed brains publish these pages through
 * maintenance publication instead and never reach this module.
 *
 * Enabled by `cycle.extract_atoms.write_through` /
 * `cycle.synthesize_concepts.write_through`. Each written page goes through
 * `writePageThrough` (honouring `sync.write_through=off`, source containment
 * and case collisions). A page whose target is ignored by git or sits in a
 * declared `storage.db_only` directory (which sync gitignores) stays
 * database-only. The first run after the key is enabled also writes the
 * generated pages that have no file yet, a bounded batch per run. A page the
 * phase retires has its file removed, so sync cannot bring it back.
 */
import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { isDbOnly, loadStorageConfig } from '../storage-config.ts';
import { deletePageThrough, resolvePageWriteTarget, writePageThrough } from '../write-through.ts';

export const DERIVED_WRITE_THROUGH_KEYS = {
  extract_atoms: 'cycle.extract_atoms.write_through',
  synthesize_concepts: 'cycle.synthesize_concepts.write_through',
} as const;

/** Pages without a file written per run by the enable-time backfill. */
export const DERIVED_BACKFILL_LIMIT = 200;

const ON_VALUES = new Set(['true', '1', 'yes', 'on']);

export async function derivedWriteThroughEnabled(engine: BrainEngine, phase: keyof typeof DERIVED_WRITE_THROUGH_KEYS): Promise<boolean> {
  const raw = await engine.getConfig(DERIVED_WRITE_THROUGH_KEYS[phase]).catch(() => null);
  return raw != null && ON_VALUES.has(raw.trim().toLowerCase());
}

function gitIgnores(root: string, filePath: string): boolean {
  try {
    execFileSync('git', ['-C', root, 'check-ignore', '-q', '--', relative(root, filePath)], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Write one generated page's markdown file. Never throws; the result says
 * whether a file was written, why not, or the write error. Ignored and db_only
 * targets are skipped on purpose (`skipped: 'not_canonical'`).
 * `expectedFileBytes` binds the write to the file the caller read.
 */
export async function writeDerivedPageThrough(engine: BrainEngine, slug: string, sourceId: string,
  opts: { expectedFileBytes?: string | null } = {}): Promise<{ written: boolean; skipped?: string; error?: string }> {
  const target = await resolvePageWriteTarget(engine, slug, sourceId);
  if (!target.ok) return { written: false, skipped: target.skipped };
  let storage = null;
  try { storage = loadStorageConfig(target.writeRoot); } catch { /* unreadable gbrain.yml: sync reports it */ }
  if ((storage && isDbOnly(slug, storage)) || gitIgnores(target.writeRoot, target.filePath)) return { written: false, skipped: 'not_canonical' };
  const result = await writePageThrough(engine, slug, { sourceId, expectedFileBytes: opts.expectedFileBytes });
  if (result.error) console.error(`[write-through] ${slug}: ${result.error}`);
  return result;
}

/**
 * The phase's write-through hook, or null when it does not apply (key off,
 * managed brain, dry run): writes the given pages and removes the files of
 * the retired ones. Creating it writes the bounded backfill of generated
 * pages of the phase's type in the source that have no file yet.
 */
export async function derivedWriteThrough(
  engine: BrainEngine,
  phase: keyof typeof DERIVED_WRITE_THROUGH_KEYS,
  sourceId: string,
  opts: { managed: boolean; dryRun: boolean },
): Promise<((slugs: readonly string[], retired?: readonly string[]) => Promise<void>) | null> {
  if (opts.managed || opts.dryRun || !await derivedWriteThroughEnabled(engine, phase)) return null;
  const write = async (slugs: readonly string[], retired: readonly string[] = []) => {
    for (const slug of slugs) await writeDerivedPageThrough(engine, slug, sourceId);
    for (const slug of retired) await deletePageThrough(engine, slug, { sourceId });
  };
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages
      WHERE source_id = $1 AND deleted_at IS NULL AND source_path IS NULL
        AND type = $2 AND ($2 <> 'concept' OR frontmatter->>'synthesized_by' LIKE 'synthesize_concepts%')
        AND COALESCE(frontmatter->>'source_hash', '') NOT LIKE 'pending:%'
      ORDER BY id LIMIT $3`,
    [sourceId, phase === 'extract_atoms' ? 'atom' : 'concept', DERIVED_BACKFILL_LIMIT],
  );
  await write(rows.map(r => r.slug));
  return write;
}
