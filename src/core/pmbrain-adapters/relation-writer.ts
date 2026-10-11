import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../operation-error.ts';
export { replaceDerivedLinks } from '../derived-links.ts';

export async function relationMaintenanceTransaction<T>(engine: BrainEngine, sourceId: string, fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
  return engine.transaction(async tx => {
    await tx.executeRaw('SELECT id FROM sources WHERE id=$1 FOR SHARE', [sourceId]);
    return fn(tx);
  });
}

export async function lockRelationPages(engine: BrainEngine, keys: Array<{ sourceId: string; slug: string }>): Promise<void> {
  const unique = [...new Set(keys.map(key => JSON.stringify([key.sourceId, key.slug])))].sort();
  for (const key of unique) {
    await engine.executeRaw('SELECT pg_advisory_xact_lock(hashtext($1))', [`relation:${key}`]);
    const [sourceId, slug] = JSON.parse(key) as [string, string];
    await engine.executeRaw('SELECT id FROM pages WHERE source_id=$1 AND slug=$2 FOR SHARE', [sourceId, slug]);
  }
}

export async function readRelationSnapshot(engine: BrainEngine, slug: string, sourceId: string) {
  const [row] = await engine.executeRaw<{ id: string; slug: string; source_id: string; type: string; compiled_truth: string; timeline: string; frontmatter: Record<string, unknown>; deleted_at: string | null; revision: string | null; incarnation: string }>(
    `SELECT p.id, p.slug, p.source_id, p.type, p.compiled_truth, p.timeline, p.frontmatter, p.deleted_at, p.knowledge_revision::text AS revision,
            s.incarnation::text AS incarnation FROM pages p JOIN sources s ON s.id=p.source_id
      WHERE p.slug=$1 AND p.source_id=$2`, [slug, sourceId]);
  return row ? { page: row, revision: row.revision ?? 'backfill_pending', sourceIncarnation: row.incarnation } : null;
}

export function assertRelationRevision(snapshot: { revision: string } | null, precondition: { expectedRevision: string }) {
  if (snapshot?.revision === 'backfill_pending') throw new OperationError('revision_backfill_pending', 'Page revision backfill is pending.');
  if (!snapshot || snapshot.revision !== precondition.expectedRevision) throw new OperationError('revision_conflict', 'The page changed after it was read. Read its current revision before retrying.');
}
