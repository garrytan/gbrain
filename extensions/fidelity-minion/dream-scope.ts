import { listPendingMembers } from '../../src/core/generations/managed.ts';
import { ATOM_KIND, atomOwnerKey } from '../../src/core/generations/adapters/atoms.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { managedAtomCompletedSql } from '../../src/core/persistence/atom-maintenance.ts';
import type { MaintenanceInputGuard } from '../../src/core/persistence/maintenance-input-guard.ts';
import { prepareConcept } from './handler.ts';
import { parseFidelityContracts } from './concept-fidelity.ts';

export type DreamFidelityScope = { topic: string; pages: string[]; activation: NonNullable<MaintenanceInputGuard['activation']> };

export function dreamFidelityScopeKey(scope: DreamFidelityScope): string {
  return JSON.stringify([scope.topic, scope.pages, scope.activation.version]);
}

export async function readConfiguredDreamFidelityScope(engine: BrainEngine, sourceId: string): Promise<DreamFidelityScope | null> {
  if (engine.kind !== 'postgres') return null;
  const key = `cycle.synthesize_concepts.fidelity_dream.${sourceId}`;
  const [row] = await engine.executeRaw<{ value: string; version: string }>(
    'SELECT value, xmin::text AS version FROM config WHERE key=$1', [key]);
  if (!row) return null;
  const scope = JSON.parse(row.value) as Partial<DreamFidelityScope> | null;
  if (!scope || typeof scope.topic !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scope.topic) ||
      !Array.isArray(scope.pages) || !scope.pages.length || scope.pages.length > 16 ||
      !scope.pages.every(page => typeof page === 'string' && /^[a-z0-9]+(?:[/-][a-z0-9]+)*$/.test(page)) ||
      new Set(scope.pages).size !== scope.pages.length) {
    throw new Error('Fidelity Dream requires one approved topic and unique source page slugs');
  }
  return { topic: scope.topic, pages: scope.pages, activation: { key, version: row.version } };
}

export async function readDreamFidelityScope(engine: BrainEngine, sourceId: string): Promise<DreamFidelityScope | null> {
  const scope = await readConfiguredDreamFidelityScope(engine, sourceId);
  if (!scope) return null;
  const approved = parseFidelityContracts(await engine.getConfig(`cycle.synthesize_concepts.fidelity.${sourceId}`));
  if (!approved.has(scope.topic)) throw new Error('Fidelity Dream topic is not approved');
  return scope;
}

/** Empty backlog is insufficient: a held or truncated page can be absent from discovery. */
export async function readCompletedDreamInputs(engine: BrainEngine, sourceId: string,
    scope: DreamFidelityScope): Promise<MaintenanceInputGuard['pages'] | null> {
  const ownerKeys = scope.pages.map(slug => atomOwnerKey({ kind: 'page', slug }));
  if ((await listPendingMembers(engine, [sourceId], ATOM_KIND, ownerKeys)).length) return null;
  const checkpoint = managedAtomCompletedSql({ sourceId: 'p.source_id', slug: 'p.slug', pageId: 'p.id', contentHash: 'p.content_hash' });
  const rows = await engine.executeRaw<MaintenanceInputGuard['pages'][number]>(`
    SELECT p.slug, p.knowledge_revision::text AS revision, p.trust_tier AS "trustTier"
    FROM pages p JOIN sources src ON src.id=p.source_id
    WHERE p.source_id=$1 AND p.slug=ANY($2::text[]) AND NOT src.archived AND p.deleted_at IS NULL
      AND (
        EXISTS (SELECT 1 FROM op_checkpoints ac WHERE ${checkpoint}
          AND ac.completed_keys->0->>'partial' IS NULL)
        OR EXISTS (SELECT 1 FROM extract_atoms_page_state scan
          WHERE scan.source_incarnation=src.incarnation AND scan.page_id=p.id AND scan.content_hash=p.content_hash
            AND scan.tombstoned AND scan.fail_count=0 AND scan.partial_input_chars IS NULL)
      )
    ORDER BY p.slug`, [sourceId, scope.pages]);
  return rows.length === scope.pages.length ? rows : null;
}

/** Let the scheduler recover an interrupted handoff without re-extracting completed inputs. */
export async function fidelityHandoffNeeded(engine: BrainEngine, sourceId: string,
    scope: DreamFidelityScope): Promise<boolean> {
  if (!await readCompletedDreamInputs(engine, sourceId, scope)) return false;
  const prepared = await prepareConcept(engine, { sourceId, topic: scope.topic });
  const current = await engine.readPageSnapshot(prepared.slug, { sourceId, includeDeleted: true });
  return current?.page.frontmatter?.fidelity_input_digest !== prepared.digest;
}
