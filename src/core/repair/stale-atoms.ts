/**
 * `gbrain repair stale-atoms` (#5770, CEO-A7, ENG-O7, DX-O4): the one-time
 * cleanup of atoms that drifted before managed re-extraction retired them.
 *
 * Two classes of live, page-bound (`source_slug`) atoms, never one with
 * `imported_from` and never a file-bound (`source_path`-only) atom:
 *   (a) `origin_gone`: the source page is missing or soft-deleted;
 *   (b) `origin_changed`: the atom's 16-character source hash (a managed
 *       `pending:` prefix stripped) differs from its live source page's
 *       current hash, and that page already completed an extraction at its
 *       current hash (managed: the completed `managed-atoms` checkpoint;
 *       unmanaged: a non-managed atom of that page carrying the hash).
 *
 * The kind is explicit-only and preview-bound: the preview lists every atom
 * with its class and saves the set under its hash; `--apply --expect <hash>`
 * retires exactly that set. Each atom is rechecked when it is retired; one
 * whose revision, class, origin or completion evidence changed reports
 * `changed_since_preview` and is kept. A managed brain retires one atom per
 * `managed_maintenance_retire_stale_atoms` request bound to the atom's
 * revision (no live origin is required); an unmanaged brain soft-deletes it
 * directly. Both stamp `retired_by: stale-atoms`, so a later extraction that
 * produces the atom again restores it, and both invalidate the origin page's
 * earlier completed extractions so a restored page is extracted again.
 */
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { authorizeWrite } from '../persistence/authority.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { preparePageMutation } from '../persistence/page-prepare.ts';
import { maintenancePreflight, submitMaintenanceIntent } from '../persistence/prepared-maintenance.ts';
import { bumpAtomGeneration, managedAtomCompletedSql } from '../persistence/atom-maintenance.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { afterCursor, repairRequestId, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairPlan, type RepairScope } from './core.ts';

export const STALE_ATOMS_RETIRED_BY = 'stale-atoms';
export const STALE_ATOMS_INTENT = 'managed_maintenance_retire_stale_atoms';

export type StaleAtomClass = 'origin_gone' | 'origin_changed';

/** Everything the preview showed for one atom; the apply rechecks each field. */
export interface StaleAtom {
  id: number;
  source_id: string;
  /** The source incarnation the preview saw; a re-created source is a different atom. */
  incarnation: string;
  slug: string;
  revision: string;
  class: StaleAtomClass;
  managed: boolean;
  origin_slug: string;
  origin_page_id: number | null;
  origin_hash: string | null;
  /** Class (b): the completed-extraction evidence at the origin's current hash. */
  evidence: string | null;
}

interface StaleAtomItem extends RepairItem { atom: StaleAtom; hash: string; last: boolean }

/** An approved atom carries the preview's source selection, so an apply under another `--source` refuses. */
interface ApprovedStaleAtom extends StaleAtom { selection: string[] }

/** Live stale atoms of these sources, in (class, id) order; `atomId` narrows to one atom for the apply recheck. */
async function staleAtoms(db: BrainEngine, sourceIds: string[], atomId?: number): Promise<Array<StaleAtom & { chars: number }>> {
  const rows = await db.executeRaw<StaleAtom & { chars: number }>(`
    WITH atom AS (
      SELECT a.id, a.source_id, (SELECT s.incarnation::text FROM sources s WHERE s.id=a.source_id) AS incarnation,
             a.slug, a.knowledge_revision::text AS revision,
             a.frontmatter->>'source_slug' AS origin_slug,
             COALESCE(a.frontmatter->>'managed_extraction','')='true' AS managed,
             regexp_replace(COALESCE(a.frontmatter->>'source_hash',''),'^pending:','') AS atom_hash,
             length(COALESCE(a.compiled_truth,'')) AS chars,
             o.id AS origin_page_id, o.slug AS origin_live_slug, o.source_id AS origin_source_id,
             o.content_hash AS origin_hash, o.deleted_at IS NOT NULL AS origin_deleted
        FROM pages a
        LEFT JOIN pages o ON o.source_id=a.source_id AND o.slug=a.frontmatter->>'source_slug'
       WHERE a.source_id=ANY($1::text[]) AND a.type='atom' AND a.deleted_at IS NULL
         AND NULLIF(a.frontmatter->>'source_slug','') IS NOT NULL
         AND NULLIF(a.frontmatter->>'imported_from','') IS NULL
         AND ($2::int IS NULL OR a.id=$2::int)
    ), classified AS (
      SELECT atom.*, CASE
          WHEN origin_page_id IS NULL OR origin_deleted THEN 'origin_gone'
          WHEN origin_hash IS NOT NULL AND atom_hash<>substring(origin_hash from 1 for 16) THEN 'origin_changed'
        END AS class,
        CASE WHEN managed THEN (SELECT ac.fingerprint FROM op_checkpoints ac WHERE ${managedAtomCompletedSql({ sourceId: 'atom.origin_source_id',
            slug: 'atom.origin_live_slug', pageId: 'atom.origin_page_id', contentHash: 'atom.origin_hash' })} ORDER BY ac.fingerprint LIMIT 1)
          ELSE (SELECT 'unmanaged:'||e.id FROM pages e WHERE e.source_id=atom.source_id AND e.type='atom' AND e.deleted_at IS NULL
            AND COALESCE(e.frontmatter->>'managed_extraction','')<>'true' AND e.frontmatter->>'source_slug'=atom.origin_slug
            AND e.frontmatter->>'source_hash'=substring(atom.origin_hash from 1 for 16) ORDER BY e.id LIMIT 1)
        END AS completion
        FROM atom
    )
    SELECT id, source_id, incarnation, slug, revision, class, managed, origin_slug,
           origin_page_id,
           CASE WHEN class='origin_gone' THEN NULL ELSE origin_hash END AS origin_hash,
           CASE WHEN class='origin_gone' THEN NULL ELSE completion END AS evidence, chars
      FROM classified
     WHERE class='origin_gone' OR (class='origin_changed' AND completion IS NOT NULL)
     ORDER BY CASE class WHEN 'origin_gone' THEN 1 ELSE 2 END, id`, [sourceIds, atomId ?? null]);
  return rows.map(row => ({ ...row, id: Number(row.id), managed: row.managed === true,
    origin_page_id: row.origin_page_id === null ? null : Number(row.origin_page_id), chars: Number(row.chars) }));
}

function sameAtom(live: StaleAtom | undefined, approved: StaleAtom): boolean {
  return !!live && (['id', 'source_id', 'incarnation', 'slug', 'revision', 'class', 'managed', 'origin_slug', 'origin_page_id', 'origin_hash', 'evidence'] as const)
    .every(field => live[field] === approved[field]);
}

function previewCommand(scope: RepairScope): string {
  return `gbrain repair stale-atoms${scope.source_ids.length === 1 ? ` --source ${scope.source_ids[0]}` : ''}`;
}

function item(atom: StaleAtom, hash: string, last: boolean): StaleAtomItem {
  return { cursor: { phase: atom.class === 'origin_gone' ? 1 : 2, id: atom.id }, source_id: atom.source_id, slug: atom.slug,
    chars: 0, action: `retire:${atom.class}`, atom, hash, last };
}

async function hashParts(engine: BrainEngine, scope: RepairScope, atoms: StaleAtom[]) {
  const sources = await engine.executeRaw<{ id: string; incarnation: string }>(
    'SELECT id, incarnation::text AS incarnation FROM sources WHERE id=ANY($1::text[]) ORDER BY id', [scope.source_ids]);
  return { kind: 'stale-atoms-v1', brain_id: scope.brain_id, sources, selection: { source_ids: scope.source_ids }, atoms };
}

export const staleAtomsRepair: RepairHandler = {
  kind: 'stale-atoms',
  embeds: false,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    const command = previewCommand(scope);
    if (!opts?.apply) {
      const atoms = (await staleAtoms(engine, scope.source_ids)).map(({ chars: _chars, ...atom }) => atom);
      const hash = previewHash(await hashParts(engine, scope, atoms));
      if (atoms.length) await saveApprovedSet<ApprovedStaleAtom>(engine, { command: 'stale-atoms', hash }, atoms.map(atom => ({ ...atom, selection: scope.source_ids })));
      return { items: atoms.map((atom, index) => item(atom, hash, index === atoms.length - 1)), preview_hash: hash,
        residuals: { origin_gone: atoms.filter(atom => atom.class === 'origin_gone').length,
          origin_changed: atoms.filter(atom => atom.class === 'origin_changed').length },
        listing: atoms.map(atom => ({ item: `${atom.source_id}:${atom.slug}`, class: atom.class,
          detail: atom.class === 'origin_gone' ? `source page ${atom.origin_slug} is gone`
            : `source page ${atom.origin_slug} now at ${atom.origin_hash!.slice(0, 16)}` })) };
    }
    if (!opts.expect) {
      throw new OperationError('invalid_params', 'gbrain repair stale-atoms --apply retires only the set a preview printed.',
        `Preview first: ${command} — then run the apply command it prints: ${command} --apply --expect <preview-hash>`,
        'docs/guides/repair.md#explicit-only-repair-kinds');
    }
    const approved = await loadApprovedSet<ApprovedStaleAtom>(engine, { command: 'stale-atoms', hash: opts.expect, previewCommand: command });
    if (approved.items.some(atom => JSON.stringify(atom.selection) !== JSON.stringify(scope.source_ids))) throw previewChangedError(opts.expect, command);
    const items = approved.items.map(({ selection: _selection, ...atom }, index) => item(atom, opts.expect!, index === approved.items.length - 1));
    return { items: items.filter(entry => afterCursor(entry.cursor, after)), preview_hash: opts.expect, residuals: {} };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { atom, hash, last } = entry as StaleAtomItem;
    const outcome = await retireStaleAtom(ctx, atom);
    if (last) await clearApprovedSet(ctx.engine, { command: 'stale-atoms', hash });
    return outcome;
  },
};

async function retireStaleAtom(ctx: OperationContext, atom: StaleAtom): Promise<RepairItemOutcome> {
  const engine = ctx.engine;
  const changed = (reason: string): RepairItemOutcome => ({ applied: false, outcome: 'changed_since_preview', reason });
  if (!sameAtom((await staleAtoms(engine, [atom.source_id], atom.id))[0], atom)) return changed('the atom or its source page changed');
  if (await managedPersistenceEnabled(engine)) {
    const authority = (await maintenancePreflight(engine, atom.source_id))!;
    try {
      await submitMaintenanceIntent(engine, authority, atom.slug, { kind: STALE_ATOMS_INTENT, expected_revision: atom.revision, atom },
        await repairRequestId(ctx, 'stale-atoms', atom, atom.revision));
    } catch (error) {
      if (error instanceof OperationError && ['revision_conflict', 'page_not_found', 'page_identity_changed'].includes(error.code)) return changed(error.message);
      if (error instanceof OperationError && error.code === 'source_changed') return { applied: false, outcome: 'file_conflict', reason: error.message };
      throw error;
    }
    return { applied: true, outcome: 'retired' };
  }
  const retired = await engine.transaction(async tx => {
    await tx.lockPageKeys([{ sourceId: atom.source_id, slug: atom.slug }, { sourceId: atom.source_id, slug: atom.origin_slug }]);
    if (!sameAtom((await staleAtoms(tx, [atom.source_id], atom.id))[0], atom)) return false;
    await tx.createVersion(atom.slug, { sourceId: atom.source_id });
    await tx.softDeletePage(atom.slug, { sourceId: atom.source_id });
    await stampRetirement(tx, atom);
    return true;
  });
  return retired ? { applied: true, outcome: 'retired' } : changed('the atom or its source page changed');
}

async function stampRetirement(tx: BrainEngine, atom: StaleAtom): Promise<void> {
  await tx.executeRaw(`UPDATE pages SET frontmatter=frontmatter||jsonb_build_object('retired_by',$1::text,'retired_at',$2::text)
    WHERE id=$3 AND source_id=$4 AND deleted_at IS NOT NULL`, [STALE_ATOMS_RETIRED_BY, new Date().toISOString(), atom.id, atom.source_id]);
  if (atom.origin_page_id === null) return;
  const [{ incarnation }] = await tx.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [atom.source_id]);
  await bumpAtomGeneration(tx, atom.source_id, incarnation, atom.origin_page_id, atom.class === 'origin_changed' ? atom.origin_hash : null);
}

/** Preparer for `managed_maintenance_retire_stale_atoms`: rechecks the atom's class under its and its origin's page locks, then retires it. */
export async function prepareStaleAtomRetirement(engine: BrainEngine, row: WriteRequest, config: GBrainConfig): Promise<PreparedMutation> {
  const atom = row.intent!.atom as StaleAtom;
  if (!atom || atom.slug !== row.slug || atom.source_id !== row.source_id || atom.id !== Number(row.page_id)) {
    throw new OperationError('invalid_params', 'The stale atom retirement intent does not name its atom.');
  }
  const unchanged = async (db: BrainEngine) => {
    if (!sameAtom((await staleAtoms(db, [row.source_id], atom.id))[0], atom)) {
      throw new OperationError('revision_conflict', 'The stale atom or its source page changed since the preview.');
    }
  };
  await unchanged(engine);
  await authorizeWrite(engine, row.authority, 'delete_page', row.slug);
  const page = await preparePageMutation(engine, { ...row, operation: 'delete_page' }, config, undefined, undefined, { allowMissingFile: true });
  return { ...page, additionalPageKeys: [...(page.additionalPageKeys ?? []), { sourceId: row.source_id, slug: atom.origin_slug }],
    validate: async tx => { await page.validate?.(tx); await authorizeWrite(tx, row.authority, 'delete_page', row.slug); await unchanged(tx); },
    apply: async tx => {
      const outcome = await page.apply(tx);
      await stampRetirement(tx, atom);
      return { ...outcome, retired_by: STALE_ATOMS_RETIRED_BY };
    } };
}
