/**
 * Life Chronicle event publication (#5876, E5/E8, C4b/C12; GBRA-161 PR 3).
 *
 * One extraction generation of a depth page (meeting, conversation, calendar
 * page) is published against the immutable snapshot the judge read, through the
 * generation primitive (generations/adapters/chronicle-events.ts):
 *
 *   - The activation re-validates that the depth page still has the judged
 *     revision, content hash, source incarnation and privacy, and that the
 *     writer whose revision was decided still holds the extraction grant. Any
 *     change → `superseded`; no model call or transaction spans the judge.
 *   - Events carry the depth page's effective visibility.
 *   - Ownership is content-addressed: an event is the extractor's while its
 *     live content_hash is one the ledger recorded for this depth page. An
 *     operator-edited event (hash changed) is never overwritten or retired;
 *     an operator-deleted event (deleted without a verified retirement) is
 *     never resurrected.
 *   - A complete generation (`replaces`) retires the previous generation's
 *     owned events it did not reproduce, with their timeline projection rows, in
 *     the activation: versioned, soft-deleted, `retired_by: life-chronicle`, and
 *     restorable with `gbrain repair generations --kind chronicle-event`. A result
 *     below the shrink floor is held and retires nothing; so does an empty or
 *     partial one (#7013). An empty generation retires only with a proof: the
 *     revision became ineligible (`originIneligible`) or the depth page is gone
 *     (`originGone`).
 *
 * Managed brains publish each new or changed event through the chronicle event
 * intent (database-only), then one `managed_generation_activate` request that
 * retires and flips the ledger; unmanaged brains do it all in one transaction.
 */
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { computeContentHash } from '../ingestion/types.ts';
import { serializeMarkdown } from '../markdown.ts';
import { digest } from '../persistence/digest.ts';
import { maintenancePreflight, submitDatabaseMaintenanceIntent, type MaintenanceAuthority } from '../persistence/prepared-maintenance.ts';
import { preparePageMutation } from '../persistence/page-prepare.ts';
import type { Visibility } from '../search/private-visibility.ts';
import type { ChronicleEventProposal } from './extract-events.ts';
import { resolveChronicleEventSlugs } from './event-identity.ts';
import { declareDerivation, deriveTrust } from '../trust/taint.ts';
import { derivationWriteTrust } from '../trust/page-write.ts';
import { derivedGateConfig, derivedGateInput, timelineRowAllowed } from '../trust/derived-gate.ts';
import { assessTimelineForGate, type WriteGateAssessment } from '../write-gate.ts';
import { recordWriteGateReceipt } from '../write-gate-store.ts';
import type { InputState, ProposedItem } from '../generations/contract.ts';
import { originGone, type EmptySourceProof } from '../generations/proofs.ts';
import { publishGeneration, type PublishOutcome, type PublishRequest } from '../generations/publish.ts';
import { planManagedGeneration, recordActivation, type ActivationIntent } from '../generations/managed.ts';
import { CHRONICLE_EVENT_KIND, CHRONICLE_RETIRED_BY, chronicleEventAdapter, chronicleEventItem, chronicleOwnerKey, depthInputPin, depthPinBroken,
  orphanedDepthKeys, ownedEventHashes, pinDepth, verifiedChronicleRetirement, type ChronicleDepthPin, type ChronicleGenerationContext } from '../generations/adapters/chronicle-events.ts';

export { CHRONICLE_RETIRED_BY, depthPinBroken, ownedEventHashes, pinDepth, type ChronicleDepthPin };
export const CHRONICLE_EVENT_INTENT = 'managed_maintenance_chronicle_event';
export const CHRONICLE_RETIRE_INTENT = 'managed_maintenance_chronicle_retire';
export const CHRONICLE_CAPTURED_VIA = 'life-chronicle:auto';

export interface BuiltChronicleEvent {
  slug: string;
  title: string;
  compiledTruth: string;
  frontmatter: Record<string, unknown>;
  when: string;
  day: string;
  summary: string;
}

/** Event identity is content-addressed on (who, what, depth): a re-run upserts the same page. Same-day collisions are resolved at publication (event-identity.ts). */
export function buildChronicleEvent(ev: ChronicleEventProposal, ctx: {
  depthSlug: string; attendees: string[]; effectiveDate: string | null; tz: string; visibility: Visibility; depthHash: string;
  isoDay: (when: string, tz: string) => string; normalizeKind: (kind: string) => string;
}): BuiltChronicleEvent {
  const who = ev.who.length ? ev.who : ctx.attendees;
  const when = ev.when || ctx.effectiveDate || ctx.isoDay(new Date(0).toISOString(), ctx.tz);
  const day = ctx.isoDay(when, ctx.tz);
  const hash = computeContentHash(`${who.join(',')}|${ev.what}|${ctx.depthSlug}`).slice(0, 8);
  const event = { when, who, what: ev.what, where: ev.where ?? null, kind: ctx.normalizeKind(ev.kind), depth: ctx.depthSlug };
  return {
    slug: `life/events/${day}-${hash}`,
    title: ev.what.slice(0, 120),
    compiledTruth: `${ev.what} — see [[${ctx.depthSlug}]].`,
    frontmatter: { event, event_date: when, captured_via: CHRONICLE_CAPTURED_VIA, visibility: ctx.visibility, chronicle_depth_hash: ctx.depthHash },
    when, day, summary: ev.what,
  };
}

type TargetVerdict = { write: true; restore: boolean; expectedRevision: string | null } | { write: false; reason: 'operator_deleted' | 'operator_edited' };

/** Whether an event slug may be written: absent, owned and live, or retired by a verified chronicle retirement (restored). */
async function judgeTarget(db: BrainEngine, sourceId: string, existing: PageSnapshot | null, owned: Set<string>): Promise<TargetVerdict> {
  if (!existing) return { write: true, restore: false, expectedRevision: null };
  if (existing.page.deleted_at) {
    return await verifiedChronicleRetirement(db, sourceId, existing.page)
      ? { write: true, restore: true, expectedRevision: existing.revision }
      : { write: false, reason: 'operator_deleted' };
  }
  return owned.has(String(existing.page.content_hash ?? ''))
    ? { write: true, restore: false, expectedRevision: existing.revision }
    : { write: false, reason: 'operator_edited' };
}

function requestIdFor(value: unknown): string {
  const key = digest(value);
  return `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-a${key.slice(17, 20)}-${key.slice(20, 32)}`;
}

function supersededError(reason: string): OperationError {
  return opError('revision_conflict', `chronicle_superseded: ${reason}. The depth page, its privacy or its writer grant changed after it was judged; nothing from this generation is published.`,
    'Nothing to do: the newer revision carries its own extraction decision, and the next chronicle cycle judges it.');
}

/** A publication failure that means the judged generation no longer applies. */
export function isSupersession(error: unknown): boolean {
  return error instanceof OperationError
    && ['revision_conflict', 'page_identity_changed', 'source_changed', 'permission_denied', 'page_not_found', 'generation_fenced', 'generation_live_conflict'].includes(error.code);
}

export interface ChronicleGenerationResult {
  written: Array<{ slug: string; hash: string }>;
  retired: string[];
  protected: Array<{ slug: string; reason: 'operator_deleted' | 'operator_edited' }>;
  superseded?: string;
  /** The result was held (`generation_held`): nothing was published or retired. */
  held?: string;
}

/**
 * Publish one generation (possibly empty) for a pinned depth page. `replaces`: a complete judged generation, which may
 * retire the previous generation's owned events it did not reproduce (within the shrink floor and valve); without it
 * (an empty or partial judged generation, #7013) it adds and retires nothing. `proof` makes an empty `replaces`
 * generation retire every owned event: `originIneligible` (the revision no longer qualifies) or `originGone` (the
 * depth page is gone; `pin` is then null).
 */
export async function publishChronicleGeneration(engine: BrainEngine, opts: {
  sourceId: string; pin: ChronicleDepthPin | null; depthSlug?: string; events: BuiltChronicleEvent[]; decisionRequestId: string | null;
  replaces: boolean; proof?: EmptySourceProof; maintenance?: MaintenanceAuthority | null; signal?: AbortSignal;
}): Promise<ChronicleGenerationResult> {
  const { sourceId, pin } = opts;
  const depthSlug = pin?.slug ?? opts.depthSlug!;
  const maintenance = opts.maintenance === undefined ? await maintenancePreflight(engine, sourceId) : opts.maintenance;
  const result: ChronicleGenerationResult = { written: [], retired: [], protected: [] };
  if (opts.signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
  const key = { kind: CHRONICLE_EVENT_KIND, sourceId, ownerKey: chronicleOwnerKey(depthSlug) };
  const context: ChronicleGenerationContext = { decisionRequestId: opts.decisionRequestId };
  let input: InputState | null = null;
  const items: ProposedItem[] = [];
  const members = new Map<string, { event: BuiltChronicleEvent; verdict: Extract<TargetVerdict, { write: true }>; markdown: string }>();
  if (pin) {
    const broken = await depthPinBroken(engine, sourceId, pin, opts.decisionRequestId);
    if (broken) return { ...result, superseded: broken };
    input = await chronicleEventAdapter.readInput(engine, key, context);
    if (input?.pin !== depthInputPin(pin)) return { ...result, superseded: 'superseded' };
    const owned = await ownedEventHashes(engine, sourceId, pin.pageId);
    for (const event of await resolveChronicleEventSlugs(engine, sourceId, opts.events)) {
      const verdict = await judgeTarget(engine, sourceId, await engine.readPageSnapshot(event.slug, { sourceId, includeDeleted: true }), owned);
      if (!verdict.write) { result.protected.push({ slug: event.slug, reason: verdict.reason }); continue; }
      const markdown = serializeMarkdown(event.frontmatter, event.compiledTruth, '', { type: 'event', title: event.title, tags: [] });
      items.push(chronicleEventItem(event.slug, { markdown, title: event.title, compiledTruth: event.compiledTruth, frontmatter: event.frontmatter,
        when: event.when, day: event.day, summary: event.summary }));
      members.set(event.slug, { event, verdict, markdown });
    }
  }
  if (!opts.replaces && !items.length) return result;
  context.planned = Object.fromEntries(items.map(item => [item.key, item.identityHash]));
  const request = { key, items, input, partial: !opts.replaces, ...(opts.proof ? { proof: opts.proof } : {}), context };
  let outcome: PublishOutcome | null;
  try {
    outcome = maintenance ? await publishManagedChronicle(engine, maintenance, request, pin, members, opts.decisionRequestId)
      : await publishGeneration(engine, chronicleEventAdapter, request);
  } catch (error) {
    if (!isSupersession(error)) throw error;
    return { ...result, written: await writtenEvents(engine, sourceId, items), superseded: 'superseded' };
  }
  if (outcome?.state === 'held') return { ...result, held: outcome.reason };
  return { ...result, written: await writtenEvents(engine, sourceId, items), retired: outcome?.state === 'published' ? outcome.retired : [] };
}

/** The live content hash of each proposed event (what the chronicle ledger records as the extractor's). */
async function writtenEvents(engine: BrainEngine, sourceId: string, items: readonly ProposedItem[]): Promise<Array<{ slug: string; hash: string }>> {
  if (!items.length) return [];
  const rows = await engine.executeRaw<{ slug: string; content_hash: string | null }>(
    'SELECT slug, content_hash FROM pages WHERE source_id=$1 AND slug=ANY($2::text[]) AND deleted_at IS NULL', [sourceId, items.map(item => item.key)]);
  const hashes = new Map(rows.map(row => [row.slug, row.content_hash]));
  return items.flatMap(item => hashes.get(item.key) ? [{ slug: item.key, hash: String(hashes.get(item.key)) }] : []);
}

/**
 * The managed publication (database-only): the plan's new and changed events go through the chronicle event intent,
 * one request each, then one `managed_generation_activate` request, journaled on the depth page and bound to its
 * revision, rechecks the pin and every member, retires the dropped events with their projection rows and flips the
 * ledger in one transaction. null: nothing to publish.
 */
async function publishManagedChronicle(engine: BrainEngine, maintenance: MaintenanceAuthority, request: PublishRequest<ChronicleGenerationContext>,
  pin: ChronicleDepthPin | null, members: Map<string, { event: BuiltChronicleEvent; verdict: Extract<TargetVerdict, { write: true }>; markdown: string }>,
  decisionRequestId: string | null): Promise<PublishOutcome | null> {
  const plan = await planManagedGeneration(engine, chronicleEventAdapter, request, { scope: decisionRequestId });
  if (plan.kind === 'held') return plan.outcome;
  if (plan.kind === 'unchanged') return { state: 'unchanged', generation: null, retired: [], protected: [] };
  await engine.transaction(tx => recordActivation(tx, plan.intent));
  const owned = pin ? await ownedEventHashes(engine, request.key.sourceId, pin.pageId) : new Set<string>();
  const derivation = pin ? await deriveTrust(engine, [{ table: 'pages', id: pin.pageId }], { channel: 'derive:chronicle' }) : null;
  const gateCfg = pin ? await derivedGateConfig(engine) : null;
  for (const member of plan.members) {
    if (member.action === 'retire' || !pin || !derivation || !gateCfg) continue;
    const { event, verdict, markdown } = members.get(member.slug)!;
    if (member.action === 'overwrite' && member.identity === member.before) continue;
    // #5575 B3: the event's summary lands on the depth page's timeline; a quarantined or rejected one projects nothing.
    const gate = assessTimelineForGate({ summary: event.summary, source: `life-chronicle:event:${event.slug}` }, derivedGateInput(derivation.trust), gateCfg);
    const projection = timelineRowAllowed(gate) ? { depth_slug: pin.slug, date: event.day, summary: event.summary } : undefined;
    const intent = { kind: CHRONICLE_EVENT_INTENT, content: markdown, expected_revision: verdict.expectedRevision,
      restore_retired: verdict.restore, depth: pin, decision_request_id: decisionRequestId, activation_id: plan.intent.activationId,
      owned_hashes: [...owned], ...(projection ? { event_projection: projection } : {}), derivation: declareDerivation(derivation.trust, derivation.inputs) };
    await submitDatabaseMaintenanceIntent(engine, maintenance, event.slug, intent, requestIdFor({ writer: maintenance.writer.principal, slug: event.slug, intent }));
  }
  const depth = await engine.readPageSnapshot(request.key.ownerKey.slice('depth:'.length), { sourceId: request.key.sourceId, includeDeleted: true });
  const activation: ActivationIntent & { expected_revision: string | null } = { ...plan.intent, runKey: plan.intent.activationId,
    expected_revision: depth?.revision ?? null, ...(depth?.page.deleted_at ? { deleted_page: true } : {}) };
  await submitDatabaseMaintenanceIntent(engine, maintenance, request.key.ownerKey.slice('depth:'.length), activation, plan.intent.activationId);
  const retired = plan.members.filter(member => member.action === 'retire').map(member => member.slug);
  return { state: 'published', generationId: 0, generation: plan.intent.expectedGeneration + 1, puts: [], kept: [], adopted: [], retired, protected: [] };
}

/** C-6: retires the events of up to `limit` depth pages of `sourceId` that are gone, each through `originGone`; returns the count. */
export async function retireOrphanedChronicleEvents(engine: BrainEngine, sourceId: string, maintenance?: MaintenanceAuthority | null, limit = 50): Promise<number> {
  let retired = 0;
  const keys = await orphanedDepthKeys(engine, sourceId, limit);
  if (keys.length && maintenance === undefined) maintenance = await maintenancePreflight(engine, sourceId);
  for (const ownerKey of keys) {
    const generation = await publishChronicleGeneration(engine, { sourceId, pin: null, depthSlug: ownerKey.slice('depth:'.length), events: [],
      decisionRequestId: null, replaces: true, proof: originGone(), maintenance });
    retired += generation.retired.length;
  }
  return retired;
}

interface ChronicleIntent extends Record<string, unknown> {
  kind: string;
  depth: ChronicleDepthPin;
  decision_request_id: string | null;
  owned_hashes: string[];
  restore_retired?: boolean;
  event_projection?: { depth_slug: string; date: string; summary: string };
}

/** Preparer for the two chronicle maintenance intents; validation re-runs under the publication's page locks. */
export async function prepareChronicleMutation(engine: BrainEngine, row: WriteRequest, config: GBrainConfig): Promise<PreparedMutation> {
  const p = row.intent as ChronicleIntent | null;
  if (!p || !p.depth || !Array.isArray(p.owned_hashes) || row.authority.remote) {
    throw opError('invalid_params', 'Unsupported Life Chronicle maintenance intent.',
      'Life Chronicle maintenance is submitted only by the chronicle phase on the brain host; let `gbrain dream --phase chronicle` resubmit it rather than replaying this request.');
  }
  const owned = new Set(p.owned_hashes);
  const retire = p.kind === CHRONICLE_RETIRE_INTENT;
  const check = async (tx: BrainEngine) => {
    const reason = await depthPinBroken(tx, row.source_id, p.depth, p.decision_request_id);
    if (reason) throw supersededError(reason);
    const target = await tx.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
    if (retire) {
      if (!target || target.page.deleted_at || !owned.has(String(target.page.content_hash ?? ''))) throw supersededError('event_changed');
      return;
    }
    const verdict = await judgeTarget(tx, row.source_id, target, owned);
    if (!verdict.write) throw supersededError(verdict.reason);
  };
  await check(engine);
  const operation = retire ? 'delete_page' : 'put_page';
  const intent = row.intent!.expected_revision === null ? { ...row.intent, expected_revision: undefined } : row.intent;
  const prepared = await preparePageMutation(engine, { ...row, operation, intent }, config, undefined, undefined, { allowMissingFile: true });
  return { ...prepared, additionalPageKeys: [...prepared.additionalPageKeys ?? [], { sourceId: row.source_id, slug: p.depth.slug }],
    validate: async (tx) => { await prepared.validate?.(tx); await check(tx); },
    apply: async (tx) => {
      const outcome = await prepared.apply(tx);
      if (retire) {
        if (!prepared.noop) await stampRetired(tx, row.source_id, row.slug);
        return { ...outcome, retired_by: CHRONICLE_RETIRED_BY };
      }
      const projection = p.event_projection;
      if (!projection) return outcome;
      const { projected } = await tx.upsertEventProjection({ depthSlug: projection.depth_slug, eventSlug: row.slug,
        date: projection.date, summary: projection.summary, sourceId: row.source_id });
      const trust = derivationWriteTrust({ derivation: p.derivation } as never);
      if (projected && trust) {
        const assessment = assessTimelineForGate({ summary: projection.summary, source: `life-chronicle:event:${row.slug}` },
          derivedGateInput(trust, row.id), await derivedGateConfig(tx));
        const [event] = await tx.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [row.source_id, row.slug]);
        if (event) await recordProjectionFlag(tx, assessment, Number(event.id), projection.date, row.source_id, row.id);
      }
      return { ...outcome, event_projected: projected };
    } };
}

/** A retirement journaled by an earlier release (`managed_maintenance_chronicle_retire`): the stamp, and its projection row goes with it (C-3). */
async function stampRetired(tx: BrainEngine, sourceId: string, slug: string): Promise<void> {
  await tx.executeRaw(`UPDATE pages SET frontmatter=frontmatter||jsonb_build_object('retired_by',$1::text,'retired_at',$2::text)
    WHERE source_id=$3 AND slug=$4 AND deleted_at IS NOT NULL`, [CHRONICLE_RETIRED_BY, new Date().toISOString(), sourceId, slug]);
  await tx.executeRaw('DELETE FROM timeline_entries t USING pages p WHERE p.id=t.event_page_id AND p.source_id=$1 AND p.slug=$2', [sourceId, slug]);
}

/** A flagged event projection's receipt on its timeline row (found by its event page and date). */
async function recordProjectionFlag(tx: BrainEngine, assessment: WriteGateAssessment, eventPageId: number, date: string, sourceId: string, requestId?: string): Promise<void> {
  if (assessment.verdict !== 'flag') return;
  const [entry] = await tx.executeRaw<{ id: number }>('SELECT id FROM timeline_entries WHERE event_page_id=$1 AND date=$2::date', [eventPageId, date]);
  if (entry) await recordWriteGateReceipt(tx, { targetTable: 'timeline_entries', targetId: Number(entry.id), sourceId, assessment, requestId });
}
