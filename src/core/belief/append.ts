/**
 * The one ledger insert (docs/designs/BELIEF_LEDGER.md sections 5.2, 6.5).
 * Every appender (publication finalization, baseline, reconcile, backfill,
 * purge, restore replay) builds drafts and calls `appendBeliefEvents` inside
 * its own transaction. Before the insert it enforces this table's own
 * tombstones and the redaction register: an asserting event for a purged
 * fingerprint is written as a redacted skeleton, and a carrying field under an
 * active suppression is written as the redaction marker until an owner release.
 */
import type { BrainEngine } from '../engine.ts';
import type { BeliefEventInsertRow, BeliefSuppression } from '../engine-sql/belief-ledger.ts';
import { OWNER_TIER_FLOOR, TRUST_TIER_RANK, isTrustTier } from '../trust/tier.ts';
import { CARRYING_FIELDS, REDACTION_MARKER, canonicalJson, eventKeyHex, fieldHash, valueHash } from './keys.ts';
import { mayHaveLegacyFingerprint } from './legacy-fingerprint.ts';

export type BeliefOrigin = 'live' | 'unmanaged' | 'baseline' | 'backfill' | 'reconcile';
export interface BeliefEventDraft {
  sourceId: string; incarnation: string; lifetime: string | null; slug: string;
  subjectKind: 'page' | 'fact' | 'take' | 'link' | 'link_transition' | 'coverage';
  subjectKey: string; eventType: string; trustTier: string; writerTier?: string | null; tierBasis?: 'row' | 'writer' | 'unknown';
  visibility: string; value: Record<string, unknown> | null; priorHash?: string | null; stateHash: string;
  cause: Record<string, unknown>; claimFp?: string | null; sourceTime?: string | null; validFrom?: string | null; validUntil?: string | null;
  /** Purge skeletons and backfill rows under a derived.hidden suppression. */
  purged?: boolean;
  /** Ordering bucket inside one publication: stream slug, then kind rank, then key. */
  stream?: string;
}
export interface AppendContext {
  publicationId: string; origin: BeliefOrigin;
  /** Writer of this transaction: an owner release needs a trusted local write at or above OWNER_TIER_FLOOR. */
  writerTier?: string | null; remote?: boolean;
  /**
   * The batch is an explicit owner edit of the subjects' fields (section 6.5). Only such a write can release a
   * redaction; sync, import, reconcile, file repair, gate release and held accept never set it, whatever their tier.
   */
  ownerEdit?: boolean;
  /** Skip the tombstone and register reads when the source never had a purge (begin's probe). */
  purgesPossible?: boolean;
  /**
   * The source's purge_epoch when a payload prepared outside this transaction (backfill, a refresh proposal) was
   * built; the append refuses with `belief_stale_preparation` when a purge committed since (section 6.5).
   */
  preparedEpoch?: number;
}

/** One suppression an owner release bound to a new value: never the value itself, only its hash. */
export interface RedactionRelease { field: string; purge_request: string; released_hash: string }
export const REDACTION_RELEASED = 'redaction.released';

/**
 * The `redaction.released` event of one subject (section 6.5): on the redacted key and its stream, in the publication
 * that `belief_redactions.released_by` names, carrying the released fields, their purge requests and the hashes the
 * release bound (never the released text).
 */
export function redactionReleasedDraft(base: Pick<BeliefEventDraft, 'sourceId' | 'incarnation' | 'lifetime' | 'slug' | 'stream' | 'subjectKind' | 'subjectKey'
  | 'trustTier' | 'visibility' | 'stateHash'>, releases: readonly RedactionRelease[], releasedBy: string): BeliefEventDraft {
  const sorted = [...releases].sort((a, b) => a.field.localeCompare(b.field) || a.purge_request.localeCompare(b.purge_request));
  return { sourceId: base.sourceId, incarnation: base.incarnation, lifetime: base.lifetime, slug: base.slug, stream: base.stream, subjectKind: base.subjectKind,
    subjectKey: base.subjectKey, eventType: REDACTION_RELEASED, trustTier: base.trustTier, tierBasis: 'row', visibility: base.visibility,
    value: { releases: sorted }, stateHash: base.stateHash, cause: { op: 'redaction.release', released_by: releasedBy } };
}

let dropReleaseEvents = false;
/** Tests: the forced probe that drops every `redaction.released` event before the insert. */
export function __dropRedactionReleaseEventsForTests(dropped: boolean): void { dropReleaseEvents = dropped; }

const KIND_RANK: Record<string, number> = { coverage: 0, page: 1, fact: 2, take: 3, link: 4, link_transition: 5 };
const ASSERTING = /\.(asserted|revised|resolved|unresolved|adopted|transferred)$|^baseline$|^reconcile$/;

export function orderDrafts(drafts: BeliefEventDraft[]): BeliefEventDraft[] {
  return [...drafts].sort((a, b) => (a.stream ?? a.slug).localeCompare(b.stream ?? b.slug) || KIND_RANK[a.subjectKind]! - KIND_RANK[b.subjectKind]!
    || (a.subjectKey < b.subjectKey ? -1 : a.subjectKey > b.subjectKey ? 1 : 0) || a.eventType.localeCompare(b.eventType));
}

const isOwnerWrite = (ctx: AppendContext) => ctx.ownerEdit === true && ctx.remote === false && isTrustTier(ctx.writerTier)
  && TRUST_TIER_RANK[ctx.writerTier] >= TRUST_TIER_RANK[OWNER_TIER_FLOOR];

/** Tombstoned fingerprints among the drafts' asserting events (fact_purges/take_purges match rules, subject '*' included). */
async function tombstoned(tx: BrainEngine, sourceId: string, drafts: BeliefEventDraft[]): Promise<Set<string>> {
  const facts = drafts.filter(d => d.subjectKind === 'fact' && d.claimFp && ASSERTING.test(d.eventType));
  const takes = drafts.filter(d => d.subjectKind === 'take' && d.claimFp && ASSERTING.test(d.eventType));
  if (!facts.length && !takes.length) return new Set();
  const rows = await tx.readBeliefTombstones(sourceId, facts.map(d => d.claimFp!), takes.map(d => d.claimFp!));
  const out = new Set(rows);
  // A claim whose fingerprint form differs from its tombstone's (a purge recorded before v341, or a draft keyed by the claim's
  // pre-v341 fingerprint after it) matches by its text: its current fingerprint or a pre-v341 one no current fingerprint can equal.
  const text = (d: BeliefEventDraft) => { const v = d.value as Record<string, unknown> | null | undefined; const c = v?.[d.subjectKind === 'fact' ? 'fact' : 'claim'];
    return typeof c === 'string' && mayHaveLegacyFingerprint(c) ? c : null; };
  const probes = [...facts, ...takes].flatMap(d => { const c = text(d); return c && !out.has(d.claimFp!) ? [{ kind: d.subjectKind as 'fact' | 'take', claimFp: d.claimFp!, claim: c }] : []; });
  if (!probes.length) return out;
  for (const fp of await tx.readLegacyBeliefTombstones(sourceId, probes)) out.add(fp);
  return out;
}

type Suppression = BeliefSuppression;

/**
 * Applies the redaction register to the drafts' carrying fields and records
 * releases and successor copies. Returns each draft's redacted field list.
 */
async function applyRedactions(tx: BrainEngine, sourceId: string, drafts: BeliefEventDraft[], ctx: AppendContext): Promise<{ redacted: Map<BeliefEventDraft, string[]>; released: BeliefEventDraft[] }> {
  const redacted = new Map<BeliefEventDraft, string[]>();
  const released: BeliefEventDraft[] = [];
  const carrying = drafts.filter(d => d.value && CARRYING_FIELDS[d.subjectKind]?.some(f => typeof d.value![f] === 'string' && d.value![f] !== ''));
  if (!carrying.length) return { redacted, released };
  const predecessors = carrying.map(d => (d.cause.replaces ?? d.cause.from_key) as string | undefined).filter((k): k is string => !!k);
  const hashes = carrying.flatMap(d => CARRYING_FIELDS[d.subjectKind]!.map(f => d.value![f]).filter((v): v is string => typeof v === 'string' && v !== '').map(fieldHash));
  const rows: Suppression[] = await tx.readBeliefRedactions(sourceId, [...carrying.map(d => d.subjectKey), ...predecessors], hashes);
  if (!rows.length) return { redacted, released };
  const owner = isOwnerWrite(ctx);
  for (const draft of carrying) {
    const releases: RedactionRelease[] = [];
    const predecessor = (draft.cause.replaces ?? draft.cause.from_key) as string | undefined;
    for (const field of CARRYING_FIELDS[draft.subjectKind]!) {
      const text = draft.value![field];
      if (typeof text !== 'string' || text === '') continue;
      const hash = fieldHash(text);
      const own = rows.filter(r => r.field === field && r.subject_key === draft.subjectKey);
      const inherited = predecessor ? rows.filter(r => r.field === field && r.subject_key === predecessor && r.released_hash == null) : [];
      const copied = rows.filter(r => r.field === field && r.field_hash === hash && r.released_hash == null && r.subject_key !== draft.subjectKey);
      for (const s of [...inherited, ...copied]) {
        if (own.some(o => o.purge_request === s.purge_request)) continue;
        const id = await tx.insertBeliefRedaction({ sourceId, subjectKey: draft.subjectKey, field, purgeRequest: s.purge_request, fieldHash: s.field_hash });
        own.push({ ...s, id, subject_key: draft.subjectKey, released_hash: null });
      }
      if (!own.length) continue;
      if (own.every(s => s.released_hash === hash)) continue;
      if (owner && own.every(s => s.field_hash !== hash)) {
        await tx.releaseBeliefRedactions(own.map(s => Number(s.id)), ctx.publicationId, hash);
        releases.push(...own.map(s => ({ field, purge_request: s.purge_request, released_hash: hash })));
        continue;
      }
      draft.value = { ...draft.value!, [field]: REDACTION_MARKER(own[0]!.purge_request) };
      redacted.set(draft, [...redacted.get(draft) ?? [], field]);
    }
    if (releases.length) released.push(redactionReleasedDraft({ ...draft, stream: draft.stream ?? draft.slug }, releases, ctx.publicationId));
  }
  return { redacted, released };
}

let emitterFault: ((drafts: BeliefEventDraft[]) => BeliefEventDraft[]) | null = null;
/**
 * Test seam for the forced probes (section 11): a deliberately broken emitter
 * rewrites the drafts before the insert (drop a type, corrupt a value), and the
 * probe that must catch it is asserted to fail. Null restores the real emitter.
 */
export function __setBeliefEmitterFaultForTests(fault: ((drafts: BeliefEventDraft[]) => BeliefEventDraft[]) | null): void {
  emitterFault = fault;
}

export async function appendBeliefEvents(tx: BrainEngine, input: BeliefEventDraft[], ctx: AppendContext): Promise<number> {
  const drafts = (emitterFault ? emitterFault(input) : input).filter(d => !(dropReleaseEvents && d.eventType === REDACTION_RELEASED));
  if (!drafts.length) return 0;
  const ordered = orderDrafts(drafts);
  const sourceId = ordered[0]!.sourceId;
  if (ctx.preparedEpoch !== undefined) {
    // The shared purge epoch read (engine-sql/sync-reason-reads.ts), the same member the sync reason scan calls; the
    // Rust store answers it from the source record. An unknown source reads as epoch 0.
    const epoch = await tx.readSourcePurgeEpoch(sourceId);
    if (Number(epoch ?? 0) !== ctx.preparedEpoch) {
      throw Object.assign(new Error(`belief_stale_preparation: a purge committed in source ${sourceId} since this payload was prepared (epoch ${ctx.preparedEpoch}, now ${epoch}); prepare it again from current state`),
        { code: 'belief_stale_preparation' });
    }
  }
  const purgedFps = ctx.purgesPossible === false ? new Set<string>() : await tombstoned(tx, sourceId, ordered);
  const { redacted: redactions, released } = ctx.purgesPossible === false ? { redacted: new Map<BeliefEventDraft, string[]>(), released: [] }
    : await applyRedactions(tx, sourceId, ordered, ctx);
  const rows = [...ordered, ...(dropReleaseEvents ? [] : released)].map((d, ord): BeliefEventInsertRow => {
    const purged = d.purged === true || (!!d.claimFp && purgedFps.has(d.claimFp) && ASSERTING.test(d.eventType));
    const value = purged ? null : d.value;
    return {
      event_key: eventKeyHex(ctx.publicationId, d.subjectKey, d.eventType), source_id: d.sourceId, source_incarnation: d.incarnation,
      page_lifetime: d.lifetime, slug: d.slug, subject_kind: d.subjectKind, subject_key: d.subjectKey, event_type: d.eventType, origin: ctx.origin,
      trust_tier: d.trustTier, writer_tier: d.writerTier && d.writerTier !== d.trustTier ? d.writerTier : null, tier_basis: d.tierBasis ?? 'row',
      visibility: d.visibility, publication_id: ctx.publicationId, ord, source_time: d.sourceTime ?? null, valid_from: d.validFrom ?? null,
      valid_until: d.validUntil ?? null, value: value == null ? null : canonicalJson(value), value_hash: value == null ? null : valueHash(value),
      prior_hash: purged || d.eventType.endsWith('.purged') || redactions.has(d) ? null : d.priorHash ?? null, state_hash: d.stateHash, cause: canonicalJson(d.cause), claim_fp: d.claimFp ?? null, purged,
      redacted_fields: redactions.get(d) ?? null,
    };
  });
  return tx.insertBeliefEvents(rows);
}

/**
 * The post-commit observation (section 5.3): `observed_at` is clock_timestamp()
 * in the statement that reads the committed event, never below its recorded_at.
 * Called after commit by each appender; readers that find an unmarked committed
 * publication call it too. A group's members share one statement and one time.
 */
export async function markBeliefCommits(engine: Pick<BrainEngine, 'markBeliefCommits'>, publicationIds: readonly string[]): Promise<void> {
  if (!publicationIds.length) return;
  await engine.markBeliefCommits(publicationIds);
}
