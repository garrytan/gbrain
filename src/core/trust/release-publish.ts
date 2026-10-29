/**
 * Owner release of a held fact through the page-mutation door (G5 lane C, #5575 CEO-9).
 *
 * On a managed brain a released fact whose page exists is published as that page's `## Facts` fence row, the way a
 * remember with an entity is: `submitTrustRelease` admits one journaled `trust_release` request (local CLI or the
 * resident owner's IPC only; the owner confirmation is established by `applyOwnerAction` before it), and
 * `prepareTrustReleaseMutation` prepares it with `prepareFenceFactAppend` (facts/fence-fact-append.ts):
 * - append: a held fact with an entity slug gets a new fence row on that entity's page;
 * - index-existing: a hold whose payload names `row_num` (a fence-guard or fence-reconcile hold) was gated while its
 *   page's file already held the row, so the facts row is indexed from that cell and no file changes (no twin row).
 * The publication transaction marks the hold released and writes the fact at user_confirmed (origin `trust_release`,
 * under the promotion capability); the page keeps its tier. #7656: an index-existing release raises the cell's fields
 * too (kind, confidence, notability, validity, typed claim, attribution), so the owner's preview shows them and binds
 * them (`releaseCell`, `releaseCellFields`); the request carries the approved fields' digest and preparation refuses
 * `preview_changed` when the cell no longer matches it, and the released row's origin records `fields_previewed`. The hold is locked and rechecked in `validate`, and a
 * hold decided meanwhile refuses `preview_changed` with nothing written. The request id derives from the hold and the
 * state the owner approved (its last_seen_at), so a retry of the same approval replays one receipt while it is pending or
 * committed; a request that ended without committing (the page was deleted meanwhile, its file was held) leaves the next
 * retry a fresh attempt, so the owner can release again once the cause is fixed.
 *
 * Every other hold returns null: a held take, which owner-actions.ts refuses (`unavailable`), and an unmanaged brain,
 * a hold with no entity slug, or one whose page is missing (GBRA-190 G4 owns that class), which take its transactional
 * database-only release. A
 * deleted or private page refuses and the fact stays held; a segmented page over the ceiling, a malformed fence or a
 * row that no longer reads back refuse at preparation the same way.
 */
import type { BrainEngine, NewFact } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { OperationContext } from '../ops/contract.ts';
import { opError } from '../ops/contract.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { isTerminal, type WriteRequest } from '../persistence/model.ts';
import { pageIdentityError } from '../persistence/page-identity.ts';
import { withTrustPromotion } from '../persistence/context.ts';
import { digest } from '../persistence/digest.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { prepareFenceFactAppend } from '../facts/fence-fact-append.ts';
import { assertFactNotWithdrawn } from '../facts/single-prepare.ts';
import { FENCE_SOURCE_DEFAULT } from '../facts/extract-from-fence.ts';
import { parseFactsFence, type ParsedFact } from '../facts-fence.ts';
import { materializedPage, segmentedOverCeiling } from '../persistence/segmented-apply.ts';
import { getWriteGateHold, releaseWriteGateHold, type WriteGateHold } from '../write-gate-store.ts';

export const TRUST_RELEASE_OPERATION = 'trust_release';
export const DOOR_WAIT_MS = 60_000;
/** The CLI's wait for trust_apply over the owner socket: the door's own wait plus room for the owner's work before admission. */
export const OWNER_APPLY_TIMEOUT_MS = DOOR_WAIT_MS + 30_000;

interface ReleaseIntent { hold_id: number; last_seen_at: string; by: string; mode: 'append' | 'index-existing'; row_num?: number; cell_fields?: string }

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

function decidedMeanwhile(holdId: number): Error {
  return opError('preview_changed', `h${holdId} was decided meanwhile; nothing was changed.`, 'Run gbrain trust review.');
}

/** Where a held fact publishes: its own fence row (index-existing) or a new row on its entity's page; null takes the database-only release. */
function releaseTarget(hold: Pick<WriteGateHold, 'slug' | 'payload'>): { slug: string; mode: ReleaseIntent['mode']; rowNum?: number } | null {
  const rowNum = hold.payload.row_num;
  if (typeof rowNum === 'number' && Number.isSafeInteger(rowNum) && hold.slug) return { slug: hold.slug, mode: 'index-existing', rowNum };
  const entity = str(hold.payload.entity_slug);
  return entity ? { slug: entity, mode: 'append' } : null;
}

/** The fence cell at `rowNum`; null on a segmented page over the ceiling, which preparation refuses (prepareFenceFactAppend). */
async function cellAt(engine: BrainEngine, page: PageSnapshot['page'], rowNum: number): Promise<ParsedFact | null> {
  if (segmentedOverCeiling(page)) return null;
  const base = await materializedPage(engine, page);
  return [base.compiled_truth, base.timeline ?? ''].flatMap(text => parseFactsFence(text).facts).find(f => f.rowNum === rowNum) ?? null;
}

/**
 * #7656: the fields of an index-existing release's cell that it raises to user_confirmed and the owner must have
 * previewed. The claim and visibility are checked against the hold by the read-back, and the context and source by
 * `held_row_edited`, so they are left out here and those refusals keep their codes.
 */
export function releaseCellFields(cell: ParsedFact): Record<string, unknown> {
  const { rowNum: _rowNum, claim: _claim, visibility: _visibility, context: _context, source: _source, ...fields } = cell;
  return fields;
}
const cellFieldsDigest = (cell: ParsedFact | null) => digest(cell ? releaseCellFields(cell) : null);

/**
 * #7656: the fence cell a release of this hold indexes (the live row its page holds), whose fields the owner previews
 * and approves; null for a release that publishes the held payload instead (append, database-only, a missing page).
 * Routes the way `submitTrustRelease` does.
 */
export async function releaseCell(engine: BrainEngine, hold: Pick<WriteGateHold, 'kind' | 'slug' | 'source_id' | 'payload'>): Promise<ParsedFact | null> {
  if (hold.kind !== 'fact' || !(await managedPersistenceEnabled(engine))) return null;
  const target = releaseTarget(hold);
  if (target?.mode !== 'index-existing') return null;
  const snapshot = await engine.readPageSnapshot(target.slug, { sourceId: hold.source_id, includeDeleted: true });
  return snapshot ? cellAt(engine, snapshot.page, target.rowNum!) : null;
}

/**
 * Publishes a managed release through the door and waits for it; true once committed. Null when the hold takes the
 * transactional release instead (see the module comment); false when it is no longer held and no request of this
 * approval exists. `approved` (the owner's preview binding, re-read by owner-actions.ts) is checked after the replay of
 * an existing request and before admission: a hold re-gated since the owner confirmed it, or (index-existing) whose
 * cell it is given no longer matches the one the owner previewed, refuses `preview_changed`.
 */
export async function submitTrustRelease(engine: BrainEngine, holdId: number, by: string, config?: GBrainConfig,
  approved?: (hold: WriteGateHold, cell: ParsedFact | null) => Promise<boolean>): Promise<boolean | null> {
  if (!(await managedPersistenceEnabled(engine))) return null;
  const hold = await getWriteGateHold(engine, holdId);
  if (!hold || hold.kind !== 'fact') return null;
  const target = releaseTarget(hold);
  if (!target) return null;
  const snapshot = await engine.readPageSnapshot(target.slug, { sourceId: hold.source_id, includeDeleted: true });
  if (!snapshot) return null;
  const { initializeLocalPersistence, requestPrincipalForContext } = await import('../persistence/page-mutations.ts');
  const { submissionAuthority } = await import('../persistence/authority.ts');
  const { admitWrite, getWriteRequest } = await import('../persistence/journal.ts');
  const { assertPersistenceAccepting, waitForWrite, writeResponse } = await import('../persistence/service.ts');
  const cfg = config ?? ({ engine: engine.kind } as GBrainConfig);
  const ctx = { engine, sourceId: hold.source_id, remote: false, config: cfg, dryRun: false, logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
  assertPersistenceAccepting(engine);
  await initializeLocalPersistence(ctx);
  const principal = await requestPrincipalForContext(ctx);
  let requestId = '';
  let prior: WriteRequest | null = null;
  for (let attempt = 0; ; attempt++) {
    const key = digest({ operation: TRUST_RELEASE_OPERATION, sourceId: hold.source_id, hold: hold.id, last_seen_at: hold.last_seen_at, ...(attempt ? { attempt } : {}) });
    requestId = `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-a${key.slice(17, 20)}-${key.slice(20, 32)}`;
    prior = await getWriteRequest(engine, principal, requestId);
    if (!prior || prior.state === 'committed' || !isTerminal(prior)) break;
  }
  if (prior) { writeResponse(await waitForWrite(engine, prior, cfg, DOOR_WAIT_MS)); return true; }
  if (hold.status !== 'held') return false;
  const cell = target.mode === 'index-existing' ? await cellAt(engine, snapshot.page, target.rowNum!) : null;
  if (approved && !(await approved(hold, cell))) {
    throw opError('preview_changed', `h${hold.id} changed after you approved it; nothing was changed.`,
      'Run the command again: it shows the current state and asks for a new confirmation.');
  }
  const ref = `${hold.source_id}/${target.slug}`;
  if (snapshot.page.deleted_at) {
    throw opError('page_not_found', `The page h${hold.id} would be released into (${ref}) is deleted; nothing was changed and the fact stays held.`,
      `Restore the page first (gbrain restore ${target.slug}), or drop the hold with gbrain trust drop h${hold.id}.`);
  }
  if (!(await engine.readPageSnapshot(target.slug, { sourceId: hold.source_id, excludePrivate: true }))) {
    throw opError('page_not_found', `The page h${hold.id} would be released into (${ref}) is private; nothing was changed and the fact stays held.`,
      `Drop the hold with gbrain trust drop h${hold.id} and remember the fact on the page yourself if it belongs there.`);
  }
  const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean; local_path: string | null; kind: string | null }>(
    "SELECT incarnation, archived, local_path, config->>'kind' AS kind FROM sources WHERE id = $1", [hold.source_id]);
  if (!source || source.archived) throw opError('source_changed', `Source ${hold.source_id} is archived or missing; nothing was changed and the fact stays held.`, 'Restore the source first (the user\'s call).');
  const authority = await submissionAuthority(ctx, TRUST_RELEASE_OPERATION, hold.source_id, source.incarnation, target.slug);
  let binding: { worktree_id: string; topology_generation: string | number } | null = null;
  if (target.mode === 'append') {
    const { resolveFactWriteTarget } = await import('../persistence/fact-write-target.ts');
    const write = await resolveFactWriteTarget(engine, hold.source_id, source, { fileBacked: Boolean(snapshot.page.source_path), remote: false });
    if (write.kind === 'publish') {
      binding = write.binding;
      if (write.databaseOnlyReason) authority.databaseOnlyReason = write.databaseOnlyReason;
    } else {
      const { claimWorktree } = await import('../persistence/ownership.ts');
      binding = await claimWorktree(engine, hold.source_id, write.root, undefined, undefined, { automatic: true });
    }
  }
  const intent: ReleaseIntent = { hold_id: hold.id, last_seen_at: hold.last_seen_at, by, mode: target.mode,
    ...(target.rowNum !== undefined ? { row_num: target.rowNum, cell_fields: cellFieldsDigest(cell) } : {}) };
  const row = await admitWrite(engine, {
    principal, operation: TRUST_RELEASE_OPERATION, sourceId: hold.source_id, sourceIncarnation: source.incarnation, slug: target.slug,
    pageId: snapshot.page.id, requestId, callerIntent: { ...intent }, intent: { ...intent }, authority,
    worktreeId: binding?.worktree_id ?? null, topologyGeneration: binding?.topology_generation ?? null,
  });
  writeResponse(await waitForWrite(engine, row, cfg, DOOR_WAIT_MS));
  return true;
}

/** The coordinator preparer for `trust_release` (persistence/service.ts). */
export async function prepareTrustReleaseMutation(engine: BrainEngine, row: WriteRequest, config: GBrainConfig): Promise<PreparedMutation> {
  const intent = row.intent as unknown as ReleaseIntent | null;
  if (row.operation !== TRUST_RELEASE_OPERATION || row.authority.remote || !intent || !Number.isSafeInteger(intent.hold_id) || typeof intent.last_seen_at !== 'string'
    || typeof intent.by !== 'string' || (intent.mode !== 'append' && intent.mode !== 'index-existing') || (intent.mode === 'index-existing' && (!Number.isSafeInteger(intent.row_num) || typeof intent.cell_fields !== 'string'))) {
    throw opError('confirmation_required', 'This release is not confirmed by the owner; nothing was changed.',
      'Run gbrain trust release on the brain host in an interactive terminal.');
  }
  const current = (hold: WriteGateHold | null): hold is WriteGateHold =>
    hold !== null && hold.kind === 'fact' && hold.status === 'held' && hold.last_seen_at === intent.last_seen_at && hold.source_id === row.source_id;
  const hold = await getWriteGateHold(engine, intent.hold_id);
  if (!current(hold)) throw decidedMeanwhile(intent.hold_id);
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
  if (!snapshot || snapshot.page.deleted_at || snapshot.page.id !== row.page_id) {
    throw pageIdentityError(Boolean(snapshot && !snapshot.page.deleted_at), `The page h${hold.id} is released into was deleted or recreated; the fact stays held.`);
  }
  const p = hold.payload;
  const fact: NewFact & { valid_from: Date } = {
    fact: String(p.fact ?? ''), kind: (str(p.kind) ?? 'fact') as NewFact['kind'], entity_slug: str(p.entity_slug) ?? row.slug,
    visibility: p.visibility === 'world' ? 'world' : 'private', source: str(p.source) ?? `trust release h${hold.id}`, context: str(p.context),
    source_session: str(p.source_session), confidence: 1, valid_from: str(p.valid_from) ? new Date(String(p.valid_from)) : new Date(),
    valid_until: str(p.valid_until) ? new Date(String(p.valid_until)) : null, embedding: null, embedding_model: null,
  };
  const claim = { fact: fact.fact, kind: fact.kind ?? 'fact', visibility: fact.visibility ?? 'private', entity_slug: fact.entity_slug ?? null };
  await assertFactNotWithdrawn(engine, row.source_id, claim);
  const append = await prepareFenceFactAppend(engine, row, config, snapshot, intent.mode === 'index-existing'
    ? { mode: 'index-existing', rowNum: intent.row_num!, fact, pendingTier: 'user_confirmed' }
    : { fact, pendingTier: 'user_confirmed' });
  if (intent.mode === 'index-existing') {
    const cell = await cellAt(engine, snapshot.page, intent.row_num!);
    if (cell && ((cell.context ?? null) !== (str(p.context) ?? null) || (cell.source ?? FENCE_SOURCE_DEFAULT) !== (str(p.source) ?? FENCE_SOURCE_DEFAULT))) {
      throw opError('fence_row_changed', `Fence row ${intent.row_num} of ${row.slug} was edited after h${hold.id} was held (held_row_edited); nothing was changed and the fact stays held.`,
        `The row's context or source no longer matches what h${hold.id} held, so releasing it would index content the owner did not review, and releasing h${hold.id} again refuses the same way. Drop it (gbrain trust drop h${hold.id}); if the edit was itself held, gbrain trust review lists it separately.`,
        { reason: 'held_row_edited', detail: JSON.stringify({ slug: row.slug, row_num: intent.row_num, problem: 'held_row_edited' }) });
    }
    if (cellFieldsDigest(cell) !== intent.cell_fields) {
      throw opError('preview_changed', `Fence row ${intent.row_num} of ${row.slug} changed after you approved releasing h${hold.id}; nothing was changed and the fact stays held.`,
        'Run the command again: it shows the row as it stands and asks for a new confirmation.');
    }
  }
  const lockHold = async (tx: BrainEngine) => {
    await tx.executeRaw('SELECT id FROM write_gate_holds WHERE id = $1 FOR UPDATE', [intent.hold_id]);
    if (!current(await getWriteGateHold(tx, intent.hold_id))) throw decidedMeanwhile(intent.hold_id);
  };
  const page = append.prepared;
  return {
    ...(page ?? {}), observedRevision: snapshot.revision,
    trust: { tier: 'user_confirmed', origin: { channel: 'trust_release', ...(hold.request_id ? { request_id: hold.request_id } : {}),
      ...(intent.mode === 'index-existing' ? { fields_previewed: true as const } : {}) } },
    validate: async tx => { await lockHold(tx); await assertFactNotWithdrawn(tx, row.source_id, claim); await page?.validate?.(tx); },
    apply: tx => withTrustPromotion(tx, 'user_confirmed', async () => {
      if (!(await releaseWriteGateHold(tx, intent.hold_id, intent.by))) throw decidedMeanwhile(intent.hold_id);
      const { id, pageReceipt } = await append.apply(tx);
      return { ...pageReceipt, ...append.fencesNormalized, status: 'released', hold_ref: `h${intent.hold_id}`, fact_id: id, row_num: append.rowNum, slug: row.slug };
    }),
  } as PreparedMutation;
}
