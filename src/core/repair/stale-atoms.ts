/**
 * `gbrain repair stale-atoms` (#5770, CEO-A7, ENG-O7, DX-O4): the one-time
 * cleanup of atoms that drifted before managed re-extraction retired them.
 *
 * Two classes of live, page-bound (`source_slug`) atoms, never one with
 * `imported_from` and never a file-bound (`source_path`-only) atom:
 *   (a) `origin_gone`: the source page is missing or soft-deleted (the page at
 *       `source_slug`, else the page a sync rename moved it to, #7462);
 *   (b) `origin_changed`: the atom's 16-character source hash (a managed
 *       `pending:` prefix stripped) differs from its live source page's
 *       current hash, and that page already completed an extraction at its
 *       current hash that produced atoms (managed: the completed
 *       `managed-atoms` checkpoint plus a live atom of that page carrying the
 *       hash; unmanaged: a non-managed atom of that page carrying the hash).
 *       A zero-yield extraction is no replacement, so it leaves the earlier
 *       atoms out of this class (#7013). A renamed origin's atoms keep their
 *       old `source_slug` (and owner key, which retires them); a replacement
 *       extracted under the new slug counts.
 *
 * The kind is explicit-only and preview-bound: the preview lists every atom
 * with its class and saves the set under its hash; `--apply --expect <hash>`
 * retires exactly that set. Each atom is rechecked when it is retired; one
 * whose revision, class, origin or completion evidence changed reports
 * `changed_since_preview` and is kept. GBRA-161 PR 1b: each atom retires as an
 * approved generation of its origin key (generations/publish.ts, no floor or
 * valve), bound to the atom's identity: unmanaged in one activation
 * transaction, managed as a `managed_generation_activate` request and then a
 * gated `managed_atom_delete` member (version first; no live origin is
 * required). Both stamp `retired_by: stale-atoms`, record the retirement in
 * the ledger (restorable through `gbrain repair generations`), and invalidate
 * the origin page's earlier completed extractions so a restored page is
 * extracted again. `managed_maintenance_retire_stale_atoms` requests journaled
 * by an earlier version still publish through their preparer below.
 */
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { opError, OperationError, type OperationContext } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { authorizeWrite } from '../persistence/authority.ts';
import { preparePageMutation } from '../persistence/page-prepare.ts';
import { bumpAtomGeneration, managedAtomSession, publishManagedAtomGeneration, type AtomOrigin } from '../persistence/atom-maintenance.ts';
import { atomGenerationAdapter, atomOwnerKey, readAtomInput } from '../generations/adapters/atoms.ts';
import { stampDerivedRetirement } from '../persistence/derived-retirement-hold.ts';
import { publishGeneration } from '../generations/publish.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { afterCursor, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairPlan, type RepairScope } from './core.ts';

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
  return db.listStaleAtoms(sourceIds, atomId ?? null);
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
  const sources = await engine.listSourceIncarnations(scope.source_ids);
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
    const approved = await loadApprovedSet<ApprovedStaleAtom>(engine, { command: 'stale-atoms', hash: opts.expect, previewCommand: command,
      emptyHash: async () => previewHash(await hashParts(engine, scope, [])) });
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
  // GBRA-161 PR 1b: the retirement is an approved generation of the atom's origin key (no floor or valve), bound to the
  // atom's identity now; the primitive rechecks it live, owned and unedited under the origin and atom locks.
  const key = { kind: atomGenerationAdapter.kind, sourceId: atom.source_id, ownerKey: atomOwnerKey({ kind: 'page', slug: atom.origin_slug }) };
  const row = (await atomGenerationAdapter.readItems(engine, key, [atom.slug])).get(atom.slug);
  if (!row?.live) return changed('the atom was removed');
  const approved = { retire: [atom.slug], retiredBy: STALE_ATOMS_RETIRED_BY, expect: { [atom.slug]: row.identityHash } } as const;
  try {
    const session = await managedAtomSession(engine, atom.source_id);
    if (session) {
      const origin: AtomOrigin = { kind: 'page', locator: atom.origin_slug, contentHash: atom.class === 'origin_changed' ? atom.origin_hash! : '', textHash: '',
        pageId: atom.origin_page_id, revision: null, visibility: 'world' };
      const outcome = await publishManagedAtomGeneration(engine, session, origin, [], { key, content: null, approved: { ...approved, retire: [...approved.retire] } });
      if (outcome.state !== 'admitted') return changed('the atom is no longer an owned, unedited atom of its origin');
      const receipt = outcome.receipts.at(-1);
      return receipt?.state === 'committed' ? { applied: true, outcome: 'retired' } : changed(`the retirement request ended ${receipt?.state ?? 'unrecorded'}`);
    }
    const outcome = await publishGeneration(engine, atomGenerationAdapter, { key, items: [], input: await readAtomInput(engine, key), approved,
      onRetired: tx => stampRetirement(tx, atom, false) });
    return outcome.state === 'published' && outcome.retired.includes(atom.slug) ? { applied: true, outcome: 'retired' }
      : changed('the atom is no longer an owned, unedited atom of its origin');
  } catch (error) {
    if (error instanceof OperationError && ['revision_conflict', 'page_not_found', 'page_identity_changed', 'generation_fenced', 'generation_live_conflict'].includes(error.code)) {
      return changed(error.message);
    }
    if (error instanceof OperationError && error.code === 'source_changed') return { applied: false, outcome: 'file_conflict', reason: error.message };
    throw error;
  }
}

async function stampRetirement(tx: BrainEngine, atom: StaleAtom, stamp = true): Promise<void> {
  if (stamp) await stampDerivedRetirement(tx, atom.source_id, [atom.slug], STALE_ATOMS_RETIRED_BY);
  if (atom.origin_page_id === null) return;
  const { incarnation } = (await tx.readSourceIncarnation(atom.source_id))!;
  await bumpAtomGeneration(tx, atom.source_id, incarnation, atom.origin_page_id, atom.class === 'origin_changed' ? atom.origin_hash : null);
}

/** Preparer for `managed_maintenance_retire_stale_atoms`: rechecks the atom's class under its and its origin's page locks, then retires it. */
const staleAtomsPreviewFix = (sourceId: string) => readFix('Previews the stale-atoms repair without changing anything.',
  { argv: ['gbrain', 'repair', 'stale-atoms', '--source', sourceId, '--json'] });

export async function prepareStaleAtomRetirement(engine: BrainEngine, row: WriteRequest, config: GBrainConfig): Promise<PreparedMutation> {
  const atom = row.intent!.atom as StaleAtom;
  if (!atom || atom.slug !== row.slug || atom.source_id !== row.source_id || atom.id !== Number(row.page_id)) {
    throw opError('invalid_params', 'The stale atom retirement intent does not name its atom.',
      `Request ${row.request_id} for ${row.slug} in source ${row.source_id} does not name the atom it retires, so nothing changed. Preview the repair again and apply the new preview after the user approves.`,
      { fix: staleAtomsPreviewFix(row.source_id) });
  }
  const unchanged = async (db: BrainEngine) => {
    if (!sameAtom((await staleAtoms(db, [row.source_id], atom.id))[0], atom)) {
      throw opError('revision_conflict', 'The stale atom or its source page changed since the preview.',
        `Atom ${row.slug} in source ${row.source_id} or its source page changed after the preview, so request ${row.request_id} retired nothing. Preview the repair again and apply the new preview after the user approves.`,
        { fix: staleAtomsPreviewFix(row.source_id) });
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
