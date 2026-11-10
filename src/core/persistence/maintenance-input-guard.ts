import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';

type GuardedPage = { slug: string; revision: string; trustTier: string | null };

export interface MaintenanceInputGuard {
  approvalKey: string;
  approvalVersion: string;
  sourceIncarnation: string;
  activation?: { key: string; version: string };
  pages: ReadonlyArray<GuardedPage>;
  evidencePages?: ReadonlyArray<GuardedPage>;
}

export async function validateMaintenanceInputs(tx: BrainEngine, sourceId: string, guard: MaintenanceInputGuard): Promise<void> {
  const changed = () => opError('revision_conflict', 'Maintenance inputs changed before publication.',
    'Read the current approval and source pages before preparing a new maintenance request.');
  const [source] = await tx.executeRaw<{ incarnation: string }>(
    'SELECT incarnation::text AS incarnation FROM sources WHERE id=$1 AND NOT archived FOR SHARE', [sourceId]);
  if (source?.incarnation !== guard.sourceIncarnation) throw changed();
  const [approval] = await tx.executeRaw<{ version: string }>(
    'SELECT xmin::text AS version FROM config WHERE key=$1 FOR SHARE', [guard.approvalKey]);
  if (approval?.version !== guard.approvalVersion) throw changed();
  if (guard.activation) {
    const [activation] = await tx.executeRaw<{ version: string }>(
      'SELECT xmin::text AS version FROM config WHERE key=$1 FOR SHARE', [guard.activation.key]);
    if (activation?.version !== guard.activation.version) throw changed();
  }
  const expected = new Map([...guard.pages, ...(guard.evidencePages ?? [])].map(page => [page.slug, page]));
  const current = await tx.executeRaw<{ slug: string; revision: string; trust_tier: string | null }>(
    'SELECT slug, knowledge_revision::text AS revision, trust_tier FROM pages WHERE source_id=$1 AND slug=ANY($2::text[]) AND deleted_at IS NULL ORDER BY slug FOR SHARE',
    [sourceId, [...expected.keys()]]);
  if (current.length !== expected.size || current.some(page => expected.get(page.slug)?.revision !== page.revision || expected.get(page.slug)?.trustTier !== page.trust_tier)) throw changed();
}
