/**
 * GBRA-161 PR 1b: managed generations (D2 on the existing page target; docs/architecture/generations.md#managed-sources).
 *
 * A managed source never composes a generation inside one transaction: every page write is its own coordinated request
 * with its own file. So a managed publication is admitted as one batch, in this order:
 *   1. `create` members: page writes of new identities only (a key no live row holds), so a crash leaves old and new
 *      both live, never neither;
 *   2. one `managed_generation_activate` request: under the member page locks and then the generation key lock it
 *      rechecks the expected generation, the input pin and every member at its planned identity (`generation_fenced`,
 *      `generation_live_conflict` otherwise), flips the ledger and marks every item a member still overwrites or retires
 *      `pending` (retire_pending: still live);
 *   3. `overwrite` and `retire` members: the existing per-page managed put and delete requests (version first, stamp),
 *      each refusing unless its item is pending on the activation's live generation and clearing the mark when it commits.
 * Every request id is deterministic: the activation's is digest(operation id, the producer's run scope), a member's
 * digest(activation id, member slug, action). The activation row (`derived_generation_activations`) is written with the batch, before any member runs:
 * a crash after activation resumes the pending members on the next run (`listPendingMembers`); members created by an
 * activation that never happened are orphan candidates (`listOrphanCandidates`), listed and never retired automatically.
 * Doctor counts both (`generation_pending`) and `gbrain repair generations --mode cleanup` lists them, read-only.
 */
import type { BrainEngine } from '../engine.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import type { WriteRequest } from '../persistence/model.ts';
import type { DerivedRetiredBy } from '../persistence/derived-retirement-hold.ts';
import { opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { digest } from '../persistence/digest.ts';
import { faultPoint } from '../persistence/fault-points.ts';
import { generationAdapter } from './adapters/index.ts';
import { readGenerationsConfig, restoreDaysHint } from './config.ts';
import type { GenerationAdapter, GenerationKey, InputState, ProposedItem } from './contract.ts';
import { proofHolds, type EmptySourceProof } from './proofs.ts';
import { activateGeneration, bumpValve, exhaustedHold, generationKeyLock, generationFenced, liveConflict, planPublication, publishOperationId,
  readLiveGeneration, recordHeld, requestSetHash, type LedgerItem, type PublishOutcome, type PublishRequest } from './publish.ts';

export const GENERATION_ACTIVATE_INTENT = 'managed_generation_activate';
/** The pseudo slug the activation request is journaled under (it writes no page). */
export const GENERATION_ACTIVATE_SLUG = '__generation_activate__';

export type MemberAction = 'create' | 'overwrite' | 'retire';
/**
 * One member of an activation: `identity` is what it leaves (the retired identity for a retirement), `before` what the
 * target held when planned. A database-only kind's overwrite carries `preimage`, the before-state its request replaces
 * ahead of the activation.
 */
export interface ActivationMember { slug: string; action: MemberAction; identity: string; before: string | null; preimage?: Record<string, unknown> | null }

export interface ActivationPlanIntent {
  kind: typeof GENERATION_ACTIVATE_INTENT;
  activationId: string;
  key: GenerationKey;
  expectedGeneration: number;
  input: InputState | null;
  operationId: string;
  setHash: string;
  runId: string | null;
  partial: boolean;
  proof: EmptySourceProof | null;
  retiredBy: DerivedRetiredBy;
  approved: boolean;
  members: ActivationMember[];
  /** Items the generation keeps without a member (an approved retirement keeps the rest; a partial result carries them). */
  kept: string[];
  carried: string[];
  /** The adapter context the activation reads the input and items with (atoms: the transcript file). */
  context: unknown;
  locator: string | null;
  /** Completeness evidence the producer adds (PublishRequest.note). */
  note?: Record<string, unknown>;
}
/** The journaled activation intent: the plan plus the run key its batch shares. */
export type ActivationIntent = ActivationPlanIntent & { runKey: string } & Record<string, unknown>;

/** A request id in UUID form from a hex digest (the journal keys requests by UUID). */
export function requestUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export const activationRequestId = (operationId: string, scope: string | null = null): string =>
  requestUuid(digest(['generation-activate-v1', operationId, ...(scope ? [scope] : [])]));
export const memberRequestId = (activationId: string, slug: string, action: string): string => requestUuid(digest([activationId, slug, action]));

export type ManagedPlan =
  | { kind: 'held'; outcome: Extract<PublishOutcome, { state: 'held' }> }
  | { kind: 'unchanged' }
  | { kind: 'publish'; intent: ActivationPlanIntent; members: Array<ActivationMember & { item?: ProposedItem }> };

/**
 * Plans a managed publication without locks (the activation rechecks everything under them): a held result is recorded
 * as held and admits nothing; otherwise every proposed item is a member (`create` when no live row holds its key, else
 * `overwrite`, so stamps such as the completion hash stay current), and every retirement a `retire` member.
 */
export async function planManagedGeneration<C>(engine: BrainEngine, adapter: GenerationAdapter<C>, request: PublishRequest<C>,
  opts: { retiredBy?: DerivedRetiredBy; locator?: string | null; scope?: string | null } = {}): Promise<ManagedPlan> {
  const config = await readGenerationsConfig(engine);
  const live = await readLiveGeneration(engine, request.key);
  const planned: PublishRequest<C> = { ...request, expectedGeneration: request.expectedGeneration ?? live?.generation ?? 0 };
  const setHash = requestSetHash(planned);
  const stopped = await exhaustedHold(engine, planned as PublishRequest<unknown>, config, setHash);
  if (stopped?.state === 'held') return { kind: 'held', outcome: stopped };
  const { input, rows, plan } = await planPublication(engine, adapter, planned, config, live);
  if (request.input && input?.pin !== request.input.pin) throw generationFenced('pin_moved', request.key, 'its input changed after the producer read it');
  if (plan.kind === 'held') {
    const outcome = await engine.transaction(tx => recordHeld(tx, request.key, config, planned as PublishRequest<unknown>, setHash, plan.reason, plan.context));
    return { kind: 'held', outcome: outcome as Extract<PublishOutcome, { state: 'held' }> };
  }
  if (plan.kind === 'unchanged' && (!request.items.length || adapter.publishesInPlace)) return { kind: 'unchanged' };
  const retires = plan.kind === 'publish' ? plan.retires : [];
  // A kind whose producer already wrote its items (publishesInPlace) keeps each one live at its identity without a member.
  const inPlace = adapter.publishesInPlace === true ? request.items.filter(item => { const row = rows.get(item.key); return row?.live && row.identityHash === item.identityHash; }) : [];
  if (adapter.publishesInPlace && inPlace.length !== request.items.length) {
    throw liveConflict(request.key, request.items.filter(item => !inPlace.includes(item)).map(item => item.key));
  }
  const members: Array<ActivationMember & { item?: ProposedItem }> = [
    ...request.items.filter(item => !inPlace.includes(item)).map(item => { const row = rows.get(item.key);
      return row?.live ? { slug: item.key, action: 'overwrite' as const, identity: item.identityHash, before: row.identityHash, item,
          ...(adapter.databaseOnly && item.identityHash !== row.identityHash ? { preimage: row.preimage().json } : {}) }
        : { slug: item.key, action: 'create' as const, identity: item.identityHash, before: null, item }; }),
    ...retires.map(slug => ({ slug, action: 'retire' as const, identity: rows.get(slug)!.identityHash, before: rows.get(slug)!.identityHash })),
  ];
  const operationId = publishOperationId(planned as PublishRequest<unknown>, setHash);
  const kept = request.approved && plan.kind === 'publish' ? plan.kept : inPlace.map(item => item.key);
  return { kind: 'publish', members, intent: { kind: GENERATION_ACTIVATE_INTENT, activationId: activationRequestId(operationId, opts.scope ?? null), key: request.key,
    expectedGeneration: planned.expectedGeneration!, input: request.input ?? input, operationId, setHash, runId: request.runId ?? null, partial: request.partial === true,
    proof: request.proof ?? null, retiredBy: request.approved?.retiredBy ?? opts.retiredBy ?? adapter.retiredBy, approved: request.approved !== undefined,
    members: members.map(({ item: _item, ...member }) => member), kept, carried: plan.kind === 'publish' ? plan.carried : [],
    context: request.context ?? null, locator: opts.locator ?? null, ...(request.note ? { note: request.note } : {}) } };
}

/** Records an admitted activation and its members, in the admission transaction (before any member runs). */
export async function recordActivation(tx: BrainEngine, intent: ActivationPlanIntent): Promise<void> {
  await tx.executeRaw(`INSERT INTO derived_generation_activations (id, source_id, kind, owner_key, expected_generation, input_pin, item_set_hash, state, members)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8::text::jsonb) ON CONFLICT (id) DO NOTHING`,
  [intent.activationId, intent.key.sourceId, intent.key.kind, intent.key.ownerKey, intent.expectedGeneration, intent.input?.pin ?? null, intent.setHash,
    JSON.stringify(intent.members.map(member => ({ slug: member.slug, action: member.action, identity: member.identity })))]);
}

const memberFix = (sourceId: string, kind: string) => readFix('Lists pending generation members and orphan candidates, read-only.',
  { argv: ['gbrain', 'repair', 'generations', '--kind', kind, '--mode', 'cleanup', '--source', sourceId, '--since', `${restoreDaysHint()}d`, '--json'] });

/** Preparer of `managed_generation_activate` (trusted local only): the ledger flip and the retire_pending marks; it writes no page or file. */
export async function prepareGenerationActivation(engine: BrainEngine, row: WriteRequest): Promise<PreparedMutation> {
  const p = row.intent as ActivationIntent | null;
  const adapter = p?.key ? generationAdapter(p.key.kind) : undefined;
  if (!p || p.kind !== GENERATION_ACTIVATE_INTENT || row.authority.remote || !adapter || p.key.sourceId !== row.source_id || p.activationId !== row.request_id) {
    throw opError('permission_denied', 'Unsupported generation activation request.',
      `Request ${row.request_id} in source ${row.source_id} is not a generation activation the trusted local writer admitted, so the coordinator refused it before any change. Activations run only from the gbrain CLI on the brain host.`,
      { fix: readFix('Shows the source owner and any write in flight, read-only.', { argv: ['gbrain', 'sources', 'writer', 'status', '--source', row.source_id, '--json'] }) });
  }
  const memberKeys = [...new Set([...p.members.map(member => member.slug), ...p.kept])];
  // A database-only kind journals its activation on the input page, bound to the revision it planned against.
  return { observedRevision: typeof p.expected_revision === 'string' ? p.expected_revision : null, noop: true, additionalPageKeys: adapter.lockKeys(p.key, memberKeys),
    validate: async tx => { await tx.executeRaw('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [generationKeyLock(p.key)]); },
    apply: async tx => {
      const live = await readLiveGeneration(tx, p.key);
      if ((live?.generation ?? 0) !== p.expectedGeneration) {
        throw generationFenced('stale_generation', p.key, `the live generation is ${live?.generation ?? 0}, the producer planned against ${p.expectedGeneration} (activation ${p.activationId})`);
      }
      const input = await adapter.readInput(tx, p.key, p.context);
      const proven = p.proof?.kind === 'originIneligible' ? await adapter.proofHolds?.(tx, p.key, p.proof) === true && (!p.input || input?.pin === p.input.pin)
        : p.proof ? proofHolds(p.proof, input, live?.inputPin) : !p.input || input?.pin === p.input.pin;
      if (!proven) {
        throw generationFenced('pin_moved', p.key, `its input changed after the producer read it (activation ${p.activationId})`);
      }
      const rows = await adapter.readItems(tx, p.key, memberKeys, p.context);
      // A database-only kind wrote its new and changed items before the activation; it retires inside it.
      const databaseOnly = adapter.databaseOnly === true;
      const wrong = p.members.filter(member => { const current = rows.get(member.slug);
        return !current?.live || current.identityHash !== (member.action === 'create' || (databaseOnly && member.action === 'overwrite') ? member.identity : member.before); })
        .map(member => member.slug);
      if (wrong.length) throw liveConflict(p.key, wrong);
      const items: LedgerItem[] = [
        ...p.members.map(member => { const current = rows.get(member.slug)!;
          const pending = databaseOnly ? {} : { pending: true };
          if (member.action === 'create') return { key: member.slug, identityHash: member.identity, action: 'published' as const };
          if (member.action === 'retire') return { key: member.slug, identityHash: member.identity, action: 'retired' as const, preimage: current.preimage(), ...pending };
          if (member.identity === member.before) return { key: member.slug, identityHash: member.identity, action: 'kept' as const, ...pending };
          const preimage = !databaseOnly ? current.preimage() : member.preimage ? { json: member.preimage, bytes: Buffer.byteLength(JSON.stringify(member.preimage)) } : undefined;
          return { key: member.slug, identityHash: member.identity, action: 'published' as const, ...(preimage ? { preimage } : {}), ...pending }; }),
        ...p.kept.filter(slug => rows.get(slug)?.live).map(slug => ({ key: slug, identityHash: rows.get(slug)!.identityHash, action: 'kept' as const })),
        ...p.carried.filter(slug => live?.items.has(slug)).map(slug => ({ key: slug, identityHash: live!.items.get(slug)!, action: 'kept' as const })),
      ];
      if (databaseOnly) await adapter.retireItems(tx, p.key, p.members.filter(member => member.action === 'retire').map(member => member.slug), p.retiredBy);
      const activated = await activateGeneration(tx, p.key, live, { operationId: p.operationId, runId: p.runId ?? undefined, input, setHash: p.setHash,
        completeness: { complete: !p.partial, proof: p.proof?.kind ?? null, managed: true, ...(p.approved ? { approved: p.retiredBy } : {}), ...p.note },
        activationId: p.activationId, locator: p.locator }, items);
      await tx.executeRaw(`UPDATE derived_generation_activations SET state='activated', generation_id=$2, updated_at=now() WHERE id=$1`, [p.activationId, activated.id]);
      const retires = p.members.filter(member => member.action === 'retire').length;
      if (retires) await bumpValve(tx, p.key, p.runId ?? undefined, retires);
      return { activation_id: p.activationId, generation: activated.generation, members: p.members.length, pending: items.filter(item => item.pending).length };
    } };
}

/**
 * Refuses a member overwrite or retirement unless its item is pending on the live generation its activation made:
 * an activation that never happened, a generation superseded since, or an item already settled changes nothing.
 */
export async function assertMemberPending(db: BrainEngine, row: Pick<WriteRequest, 'request_id' | 'source_id' | 'slug'>, activationId: string, kind: string): Promise<void> {
  await faultPoint('generation:member', { sourceId: row.source_id, operation: kind });
  const [state] = await db.executeRaw<{ state: string; generation_state: string | null; pending: boolean | null }>(
    `SELECT a.state, g.state AS generation_state, i.pending FROM derived_generation_activations a
       LEFT JOIN derived_generations g ON g.id=a.generation_id
       LEFT JOIN derived_generation_items i ON i.generation_id=a.generation_id AND i.item_key=$2
      WHERE a.id=$1 AND a.source_id=$3`, [activationId, row.slug, row.source_id]);
  const why = !state || state.state !== 'activated' ? 'its generation was never activated'
    : state.generation_state !== 'live' ? 'a later generation superseded it' : state.pending !== true ? 'the item is already settled' : null;
  if (!why) return;
  throw opError('revision_conflict', `The generation member was not applied: ${why}.`,
    `Request ${row.request_id} would overwrite or retire ${row.slug} in source ${row.source_id} for activation ${activationId}, but ${why}, so the page keeps its content. Read the pending list; nothing needs undoing.`,
    { fix: memberFix(row.source_id, kind) });
}

/** Clears an item's pending mark once its member request committed (in the member's publication transaction). */
export async function settleMember(tx: BrainEngine, activationId: string, slug: string): Promise<void> {
  await tx.executeRaw(`UPDATE derived_generation_items SET pending=false
    WHERE generation_id=(SELECT generation_id FROM derived_generation_activations WHERE id=$1) AND item_key=$2`, [activationId, slug]);
}

export interface PendingMember { source_id: string; kind: string; owner_key: string; generation_id: number; activation_id: string; slug: string; action: 'overwrite' | 'retire'; identity: string }

/** Items live generations still wait on a member request for (retire_pending and pending overwrites). */
export async function listPendingMembers(db: BrainEngine, sourceIds: readonly string[], kind?: string): Promise<PendingMember[]> {
  const rows = await db.executeRaw<PendingMember & { item_action: string }>(
    `SELECT g.source_id, g.kind, g.owner_key, g.id AS generation_id, g.activation_id, i.item_key AS slug, i.action AS item_action, i.identity_hash AS identity
       FROM derived_generation_items i JOIN derived_generations g ON g.id=i.generation_id
      WHERE i.pending AND g.state='live' AND g.source_id=ANY($1::text[]) AND ($2::text IS NULL OR g.kind=$2) ORDER BY g.source_id, g.kind, g.owner_key, i.item_key`,
    [[...sourceIds], kind ?? null]);
  return rows.map(row => ({ source_id: row.source_id, kind: row.kind, owner_key: row.owner_key, generation_id: Number(row.generation_id), activation_id: row.activation_id,
    slug: row.slug, action: row.item_action === 'retired' ? 'retire' as const : 'overwrite' as const, identity: row.identity }));
}

export interface OrphanCandidate { source_id: string; kind: string; owner_key: string; activation_id: string; slug: string; created_at: string }

/**
 * Pages a `create` member wrote for an activation that never happened (its request ended without committing, or was
 * never journaled) that no live generation owns. Listed for the operator; never retired automatically.
 */
export async function listOrphanCandidates(db: BrainEngine, sourceIds: readonly string[], kind?: string): Promise<OrphanCandidate[]> {
  const rows = await db.executeRaw<OrphanCandidate>(
    `SELECT a.source_id, a.kind, a.owner_key, a.id AS activation_id, m->>'slug' AS slug, a.created_at::text AS created_at
       FROM derived_generation_activations a CROSS JOIN LATERAL jsonb_array_elements(a.members) m
      WHERE a.state='pending' AND a.source_id=ANY($1::text[]) AND ($2::text IS NULL OR a.kind=$2) AND m->>'action'='create'
        AND NOT EXISTS (SELECT 1 FROM persistence_requests r WHERE r.request_id=a.id::uuid AND r.state IN ('queued','running','recovering'))
        AND EXISTS (SELECT 1 FROM pages p WHERE p.source_id=a.source_id AND p.slug=m->>'slug' AND p.deleted_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM derived_generation_items i JOIN derived_generations g ON g.id=i.generation_id
          WHERE g.source_id=a.source_id AND g.kind=a.kind AND g.state='live' AND i.item_key=m->>'slug' AND i.action<>'retired')
      ORDER BY a.source_id, a.kind, a.owner_key, slug`, [[...sourceIds], kind ?? null]);
  return rows;
}
