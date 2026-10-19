/**
 * `gbrain repair atoms-restore` (#7013): bring back atoms a managed re-extraction retired when its model
 * returned no atoms for their origin. An empty extraction retired every earlier atom of the origin by soft delete
 * stamped `retired_by: managed-reextract`, and the purge then removed them for good.
 *
 * The candidate rule is one SQL query (`atomRetirementsSql`, persistence/atom-retirement-hold.ts, column `restorable`):
 * the latest retired generation of a live origin (a page in the same source, or a transcript) that no later
 * generation replaced. Imported atoms, `stale-atoms` retirements and older generations are never listed; the
 * preview counts what it keeps (`origin_gone`, `replaced`, `older_generation`).
 *
 * The kind is explicit-only and preview-bound: the preview lists every atom with its origin, source hash and
 * retirement time and saves the set under its hash; `--apply --expect <hash>` restores exactly that set. Each atom
 * is rechecked when it is restored; one whose revision or rule match changed reports `changed_since_preview` and
 * stays deleted. A managed brain restores one atom per `managed_maintenance_restore_reextract_atom` request bound to
 * the atom's deleted revision: its preparer rechecks the rule under the atom's and its origin's page locks and
 * publishes the atom live through a revision-bound `revert_version` to the live version its retirement archived (same
 * source hash, no `retired_by`/`retired_at`; the canonical file is written back, at the derived tier an extraction
 * gives it), and the outcome names the request id; an atom with no such version reports `no_version`. An unmanaged brain versions the atom, clears `deleted_at` and drops the two keys in one
 * maintenance transaction. Neither changes the origin's extraction state.
 */
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { opError, OperationError, type OperationContext } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { authorizeWrite } from '../persistence/authority.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { preparePageMutation } from '../persistence/page-prepare.ts';
import { maintenancePreflight, submitMaintenanceIntent } from '../persistence/prepared-maintenance.ts';
import { atomOriginScopeSql, atomRetirementsSql, ATOM_REEXTRACT_RETIRED_BY } from '../persistence/atom-retirement-hold.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { declareDerivation, deriveTrust, lowerToDerivedTier, recordTaintEdges } from '../trust/taint.ts';
import { afterCursor, repairRequestId, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairPlan, type RepairScope } from './core.ts';

export const ATOMS_RESTORE_INTENT = 'managed_maintenance_restore_reextract_atom';

/** Everything the preview showed for one atom; the apply rechecks each field. */
export interface RestorableAtom {
  id: number;
  source_id: string;
  /** The source incarnation the preview saw; a re-created source is a different atom. */
  incarnation: string;
  slug: string;
  /** The deleted atom's revision; the managed request is bound to it. */
  revision: string;
  origin_kind: 'page' | 'transcript';
  /** The origin page slug, or the transcript path. */
  origin: string;
  origin_page_id: number | null;
  /** The atom's source hash with a `pending:` prefix stripped. */
  hash: string;
  retired_at: string | null;
  /** The newest live version of the atom (the one its retirement archived) at the same hash and unstamped; a managed restore reverts to it. */
  version_id: number | null;
}

interface RestoreItem extends RepairItem { atom: RestorableAtom; hash: string; last: boolean }

/** An approved atom carries the preview's source selection, so an apply under another `--source` refuses. */
interface ApprovedAtom extends RestorableAtom { selection: string[] }

/** Restorable atoms of these sources in id order; `atomId` narrows to one atom (and its origin) for the apply recheck. */
async function restorableAtoms(db: BrainEngine, sourceIds: string[], atomId?: number): Promise<RestorableAtom[]> {
  const scope = atomId === undefined ? 'p.source_id=ANY($1::text[])' : `p.source_id=ANY($1::text[]) AND ${atomOriginScopeSql('$2::bigint')}`;
  const rows = await db.executeRaw<RestorableAtom>(`
    SELECT c.id, c.source_id, (SELECT s.incarnation::text FROM sources s WHERE s.id=c.source_id) AS incarnation,
           a.slug, a.knowledge_revision::text AS revision, c.origin_kind, c.origin, c.origin_page_id, c.hash, c.retired_at,
           (SELECT v.id FROM page_versions v WHERE v.page_id=a.id AND v.is_deleted=false AND v.frontmatter->>'retired_by' IS NULL
               AND regexp_replace(COALESCE(v.frontmatter->>'source_hash',''),'^pending:','')=c.hash
             ORDER BY v.id DESC LIMIT 1) AS version_id
      FROM (${atomRetirementsSql(scope)}) c JOIN pages a ON a.id=c.id
     WHERE c.restorable${atomId === undefined ? '' : ' AND c.id=$2::bigint'}
     ORDER BY c.id`, atomId === undefined ? [sourceIds] : [sourceIds, atomId]);
  return rows.map(row => ({ ...row, id: Number(row.id), origin_page_id: row.origin_page_id === null ? null : Number(row.origin_page_id),
    version_id: row.version_id === null ? null : Number(row.version_id) }));
}

/** The re-extraction retirements of these sources the rule keeps, by reason. */
async function keptCounts(db: BrainEngine, sourceIds: string[]): Promise<{ origin_gone: number; replaced: number; older_generation: number }> {
  const [row] = await db.executeRaw<{ origin_gone: number; replaced: number; older_generation: number }>(`
    SELECT count(*) FILTER (WHERE NOT origin_live)::int AS origin_gone,
           count(*) FILTER (WHERE origin_live AND replaced)::int AS replaced,
           count(*) FILTER (WHERE origin_live AND NOT replaced AND NOT latest)::int AS older_generation
      FROM (${atomRetirementsSql('p.source_id=ANY($1::text[])')}) kept`, [sourceIds]);
  return { origin_gone: Number(row?.origin_gone ?? 0), replaced: Number(row?.replaced ?? 0), older_generation: Number(row?.older_generation ?? 0) };
}

function sameAtom(live: RestorableAtom | undefined, approved: RestorableAtom): boolean {
  return !!live && (['id', 'source_id', 'incarnation', 'slug', 'revision', 'origin_kind', 'origin', 'origin_page_id', 'hash', 'retired_at', 'version_id'] as const)
    .every(field => live[field] === approved[field]);
}

function previewCommand(scope: RepairScope): string {
  return `gbrain repair atoms-restore${scope.source_ids.length === 1 ? ` --source ${scope.source_ids[0]}` : ''}`;
}

function item(atom: RestorableAtom, hash: string, last: boolean): RestoreItem {
  return { cursor: { phase: 1, id: atom.id }, source_id: atom.source_id, slug: atom.slug, chars: 0, action: 'restore', atom, hash, last };
}

async function hashParts(engine: BrainEngine, scope: RepairScope, atoms: RestorableAtom[]) {
  const sources = await engine.executeRaw<{ id: string; incarnation: string }>(
    'SELECT id, incarnation::text AS incarnation FROM sources WHERE id=ANY($1::text[]) ORDER BY id', [scope.source_ids]);
  return { kind: 'atoms-restore-v1', brain_id: scope.brain_id, sources, selection: { source_ids: scope.source_ids }, atoms };
}

export const atomsRestoreRepair: RepairHandler = {
  kind: 'atoms-restore',
  embeds: true,
  outcomeItemsLimit: 1000,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    const command = previewCommand(scope);
    if (!opts?.apply) {
      const atoms = await restorableAtoms(engine, scope.source_ids);
      const hash = previewHash(await hashParts(engine, scope, atoms));
      if (atoms.length) await saveApprovedSet<ApprovedAtom>(engine, { command: 'atoms-restore', hash }, atoms.map(atom => ({ ...atom, selection: scope.source_ids })));
      return { items: atoms.map((atom, index) => item(atom, hash, index === atoms.length - 1)), preview_hash: hash,
        residuals: { restorable: atoms.length, origins: new Set(atoms.map(atom => `${atom.source_id}:${atom.origin_kind}:${atom.origin}`)).size,
          ...await keptCounts(engine, scope.source_ids) },
        listing: atoms.map(atom => ({ item: `${atom.source_id}:${atom.slug}`, class: 'restorable',
          detail: `origin ${atom.origin_kind} ${atom.origin}, hash ${atom.hash}, retired ${atom.retired_at ?? 'at an unrecorded time'}` })) };
    }
    if (!opts.expect) {
      throw new OperationError('invalid_params', 'gbrain repair atoms-restore --apply restores only the set a preview printed.',
        `Preview first: ${command} — then run the apply command it prints: ${command} --apply --expect <preview-hash>`,
        'docs/guides/repair.md#explicit-only-repair-kinds');
    }
    const approved = await loadApprovedSet<ApprovedAtom>(engine, { command: 'atoms-restore', hash: opts.expect, previewCommand: command,
      emptyHash: async () => previewHash(await hashParts(engine, scope, [])) });
    if (approved.items.some(atom => JSON.stringify(atom.selection) !== JSON.stringify(scope.source_ids))) throw previewChangedError(opts.expect, command);
    const items = approved.items.map(({ selection: _selection, ...atom }, index) => item(atom, opts.expect!, index === approved.items.length - 1));
    return { items: items.filter(entry => afterCursor(entry.cursor, after)), preview_hash: opts.expect, residuals: {} };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { atom, hash, last } = entry as RestoreItem;
    const outcome = await restoreAtom(ctx, atom);
    if (last) await clearApprovedSet(ctx.engine, { command: 'atoms-restore', hash });
    return outcome;
  },
};

async function restoreAtom(ctx: OperationContext, atom: RestorableAtom): Promise<RepairItemOutcome> {
  const engine = ctx.engine;
  const changed = (reason: string): RepairItemOutcome => ({ applied: false, outcome: 'changed_since_preview', reason });
  if (!sameAtom((await restorableAtoms(engine, [atom.source_id], atom.id))[0], atom)) return changed('the atom, its origin or a later generation changed');
  if (await managedPersistenceEnabled(engine)) {
    if (atom.version_id === null) return { applied: false, outcome: 'no_version',
      reason: 'the atom has no archived live version at its source hash to revert to, so a managed restore cannot rebuild it' };
    const authority = (await maintenancePreflight(engine, atom.source_id))!;
    const requestId = await repairRequestId(ctx, 'atoms-restore', atom, atom.revision);
    try {
      await submitMaintenanceIntent(engine, authority, atom.slug, { kind: ATOMS_RESTORE_INTENT, expected_revision: atom.revision, deleted_page: true, atom }, requestId);
    } catch (error) {
      if (error instanceof OperationError && ['revision_conflict', 'page_not_found', 'page_identity_changed'].includes(error.code)) return changed(error.message);
      if (error instanceof OperationError && error.code === 'source_changed') return { applied: false, outcome: 'file_conflict', reason: error.message, detail: { request_id: requestId } };
      throw error;
    }
    return { applied: true, outcome: 'restored', detail: { request_id: requestId } };
  }
  const restored = await maintenanceTransaction(engine, async tx => {
    await tx.lockPageKeys([{ sourceId: atom.source_id, slug: atom.slug }, ...(atom.origin_kind === 'page' ? [{ sourceId: atom.source_id, slug: atom.origin }] : [])]);
    if (!sameAtom((await restorableAtoms(tx, [atom.source_id], atom.id))[0], atom)) return false;
    await tx.createVersion(atom.slug, { sourceId: atom.source_id });
    await tx.restorePage(atom.slug, { sourceId: atom.source_id });
    await tx.executeRaw(`UPDATE pages SET frontmatter=frontmatter-'retired_by'-'retired_at' WHERE id=$1 AND source_id=$2 AND deleted_at IS NULL`,
      [atom.id, atom.source_id]);
    return true;
  });
  return restored ? { applied: true, outcome: 'restored' } : changed('the atom, its origin or a later generation changed');
}

const previewFix = (sourceId: string) => readFix('Previews the atoms-restore repair without changing anything.',
  { argv: ['gbrain', 'repair', 'atoms-restore', '--source', sourceId, '--json'] });

/** Preparer for `managed_maintenance_restore_reextract_atom`: rechecks the rule under the atom's and its origin's page locks, then publishes the atom live. */
export async function prepareAtomRestore(engine: BrainEngine, row: WriteRequest, config: GBrainConfig): Promise<PreparedMutation> {
  const atom = row.intent!.atom as RestorableAtom;
  if (!atom || atom.slug !== row.slug || atom.source_id !== row.source_id || atom.id !== Number(row.page_id) || atom.version_id === null) {
    throw opError('invalid_params', 'The atom restore intent does not name its atom.',
      `Request ${row.request_id} for ${row.slug} in source ${row.source_id} does not name the atom it restores, so nothing changed. Preview the repair again and apply the new preview after the user approves.`,
      { fix: previewFix(row.source_id) });
  }
  const unchanged = async (db: BrainEngine) => {
    if (!sameAtom((await restorableAtoms(db, [row.source_id], atom.id))[0], atom)) {
      throw opError('revision_conflict', 'The retired atom, its origin or a later generation changed since the preview.',
        `Atom ${row.slug} in source ${row.source_id} no longer matches the restore preview (it changed, its origin is gone, or a later extraction replaced it), so request ${row.request_id} restored nothing. Preview the repair again and apply the new preview after the user approves.`,
        { fix: previewFix(row.source_id) });
    }
  };
  await unchanged(engine);
  await authorizeWrite(engine, row.authority, 'revert_version', row.slug);
  const derivation = await deriveTrust(engine, atom.origin_page_id !== null ? [{ table: 'pages', id: atom.origin_page_id }] : [],
    { channel: 'derive:atoms', requestId: row.id });
  const page = await preparePageMutation(engine, { ...row, operation: 'revert_version', intent: { kind: ATOMS_RESTORE_INTENT, expected_revision: atom.revision,
    version_id: atom.version_id, derivation: declareDerivation(derivation.trust, derivation.inputs) } }, config, undefined, undefined, { allowMissingFile: true });
  return { ...page, trust: derivation.trust,
    additionalPageKeys: [...(page.additionalPageKeys ?? []), ...(atom.origin_kind === 'page' ? [{ sourceId: row.source_id, slug: atom.origin }] : [])],
    validate: async tx => { await page.validate?.(tx); await authorizeWrite(tx, row.authority, 'revert_version', row.slug); await unchanged(tx); },
    apply: async tx => {
      const outcome = await page.apply(tx);
      const [live] = await tx.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [row.source_id, row.slug]);
      if (live) {
        await lowerToDerivedTier(tx, 'pages', [Number(live.id)], derivation.trust);
        await recordTaintEdges(tx, { table: 'pages', id: Number(live.id), sourceId: row.source_id }, derivation.inputs);
      }
      return { ...outcome, restored_from: ATOM_REEXTRACT_RETIRED_BY };
    } };
}
