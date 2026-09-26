import type { BrainEngine } from '../engine.ts';
import type { SearchResult } from '../types.ts';

/** A source-backed atom is unverified when its original page is gone, deleted,
 * or its recorded source hash no longer matches. Resolve against the atom's
 * own source_id, never an identically named page in another source. */
export async function stampAtomSourceDrift(engine: BrainEngine, results: SearchResult[]): Promise<void> {
  const atoms = results.filter(r => r.type === 'atom');
  if (!atoms.length) return;
  // Cached results can outlive a source edit: discard the old stamp first.
  for (const atom of atoms) delete atom.unverified_source_drift;
  try {
    const ids = [...new Set(atoms.map(r => r.page_id))];
    const rows = await engine.executeRaw<{ id: number; drifted: boolean }>(
      `SELECT atom.id,
              (origin.id IS NULL OR origin.deleted_at IS NOT NULL
                OR origin.content_hash IS NULL
                OR atom.frontmatter->>'source_hash' <> substring(origin.content_hash from 1 for 16)) AS drifted
         FROM pages atom
         LEFT JOIN pages origin
           ON origin.slug = atom.frontmatter->>'source_slug'
          AND origin.source_id = atom.source_id
        WHERE atom.id = ANY($1::int[])
          AND atom.type = 'atom'
          AND atom.frontmatter->>'source_slug' IS NOT NULL
          AND atom.frontmatter->>'source_hash' IS NOT NULL`,
      [ids],
    );
    const drifted = new Set(rows.filter(r => r.drifted === true).map(r => Number(r.id)));
    for (const atom of atoms) if (drifted.has(atom.page_id)) atom.unverified_source_drift = true;
  } catch {
    // A provenance lookup failure must not silently certify an atom. The
    // fallback is conservative (including legacy atoms) rather than false-safe.
    for (const atom of atoms) atom.unverified_source_drift = true;
  }
}

export async function atomSourceDrift(engine: BrainEngine, page: { id: number; type: string }): Promise<boolean> {
  if (page.type !== 'atom') return false;
  const result = [{ page_id: page.id, type: 'atom' }] as SearchResult[];
  await stampAtomSourceDrift(engine, result);
  return result[0].unverified_source_drift === true;
}
