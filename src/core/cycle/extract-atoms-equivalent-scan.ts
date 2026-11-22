import type { BrainEngine } from '../engine.ts';
import { publicBody } from '../mentions/aliases.ts';
import { managedAtomCompletedSql } from '../persistence/atom-maintenance.ts';
import { ContentHashStream } from '../page-body/content-hash-stream.ts';
import { ATOM_SCAN_REVISION_BATCH_SIZE, archiveAtomPinSql } from '../engine-sql/atom-scans.ts';
import { renderFragment } from '../engine-sql/fragment.ts';

const LEGACY_EXTRACTABLE_TYPES = [
  'meeting', 'source', 'article', 'video', 'book', 'original',
] as const;

// Synthesis outputs are never extraction inputs: extracting atoms from atoms or
// concepts would loop (concepts are synthesized FROM atoms). Mirrors
// facts/eligibility.ts, which likewise excludes `concept` despite its
// extractable:true flag being a documented forward-compat marker.
const SYNTHESIS_OUTPUT_TYPES = new Set<string>(['atom', 'concept']);

/**
 * Pure allowlist policy: the legacy floor (minus floor types the pack declares not extractable, #5756: the floor
 * covers only types the pack is silent about) UNION the pack's `extractable: true` types, MINUS synthesis outputs.
 * Exported for unit tests; keep I/O-free.
 */
export function unionExtractableTypes(packExtractable: Iterable<string>, packExcluded: Iterable<string> = []): string[] {
  const types = new Set<string>(LEGACY_EXTRACTABLE_TYPES);
  for (const t of packExcluded) types.delete(t);
  for (const t of packExtractable) types.add(t);
  for (const t of SYNTHESIS_OUTPUT_TYPES) types.delete(t);
  return [...types];
}

type Revision = { page_id: number; revision: string; incarnation: string };
const archivePin = renderFragment(archiveAtomPinSql).text;

/** Use only evidence that still matches the live page and Atom generation in this query snapshot. */
export function excludeEquivalentAtomScans(parameter: number): string {
  return `AND NOT EXISTS (
    SELECT 1 FROM jsonb_to_recordset($${parameter}::text::jsonb)
      AS prior(page_id integer, revision uuid, incarnation uuid, version_id integer, archive_hash text, old_hash text)
    JOIN sources source ON source.id=p.source_id AND source.incarnation=prior.incarnation
    JOIN page_versions archive ON archive.id=prior.version_id AND archive.page_id=p.id
      AND ${archivePin}=prior.archive_hash
    JOIN extract_atoms_page_state scan ON scan.source_incarnation=prior.incarnation AND scan.page_id=prior.page_id
      AND scan.content_hash=prior.old_hash AND scan.tombstoned AND scan.partial_input_chars IS NULL
    JOIN op_checkpoints ac ON ${managedAtomCompletedSql({ sourceId: 'p.source_id', pageId: 'prior.page_id', contentHash: 'prior.old_hash' })}
      AND ac.completed_keys->0->>'partial' IS NULL AND ac.completed_keys->0->>'locator'=p.slug
    JOIN persistence_requests completed ON completed.source_id=p.source_id AND completed.source_incarnation=prior.incarnation
      AND completed.request_id::text=ac.completed_keys->0->>'requestId'
      AND completed.state='committed' AND completed.outcome->>'status'='completed'
      AND COALESCE(completed.intent->>'kind',completed.outcome->>'atom_kind')='managed_atom_complete'
    WHERE prior.page_id=p.id AND prior.revision=p.knowledge_revision
    AND (completed.intent->>'activationId' IS NULL OR EXISTS (
      SELECT 1 FROM derived_generations generation WHERE generation.activation_id::text=completed.intent->>'activationId'
        AND generation.source_id=p.source_id AND generation.kind='atom' AND generation.state='live'
    )) AND jsonb_typeof(completed.intent->'children')='array'
    AND (SELECT COUNT(DISTINCT atom.id) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(completed.intent->'children')='array'
      THEN completed.intent->'children' ELSE '[]'::jsonb END) AS child(id)
      JOIN persistence_requests item ON item.id::text=child.id AND item.state='committed'
        AND item.source_incarnation=prior.incarnation AND item.source_id=p.source_id
        AND COALESCE(item.intent->>'kind',item.outcome->>'atom_kind')='managed_atom_page'
        AND COALESCE(item.intent->>'runKey',item.outcome->>'atom_run_key')=completed.intent->>'runKey'
      JOIN pages atom ON atom.slug=item.slug AND atom.source_id=p.source_id AND atom.type='atom'
        AND atom.knowledge_revision::text=item.outcome->>'revision' AND atom.deleted_at IS NULL
    )::text=completed.outcome->>'atoms'
  )`;
}

/** A completed managed scan can still answer for a later publication with identical projected input. */
export async function equivalentAtomScanRevisions(engine: BrainEngine, sourceId: string | undefined,
  types: string[], slugs?: string[], signal?: AbortSignal): Promise<string> {
  const finished = new Map<string, Revision & { version_id: number; archive_hash: string; old_hash: string }>();
  let pageId = 0, versionId = 0;
  for (;;) {
    const rows = await engine.readAtomScanRevisionCandidates({
      sourceId, types, slugs, afterPageId: pageId, afterVersionId: versionId, signal,
    });
    for (const row of rows) {
      if (JSON.stringify([...row.current_tags].sort()) !== JSON.stringify([...(row.old_page.tags ?? [])].sort())
        || publicBody(row.old_truth) !== publicBody(row.current_truth)) continue;
      const oldHash = ContentHashStream.begin(row.old_page)
        .pushTruth(row.old_truth).pushTimeline(row.old_timeline).finish(row.old_page);
      if (row.old_hash && row.old_hash !== oldHash) continue;
      const { page_id, revision, incarnation, version_id, archive_hash } = row;
      const key = page_id + ':' + revision + ':' + oldHash;
      if (!finished.has(key)) finished.set(key, { page_id, revision, incarnation, version_id, archive_hash, old_hash: oldHash });
    }
    if (rows.length < ATOM_SCAN_REVISION_BATCH_SIZE) break;
    ({ page_id: pageId, version_id: versionId } = rows[rows.length - 1]);
  }
  return JSON.stringify([...finished.values()]);
}
