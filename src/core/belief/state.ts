/**
 * Raw canonical state of belief streams (docs/designs/BELIEF_LEDGER.md sections 3-4).
 *
 * A stream is one slug of one source: its page, the fence facts it projects
 * (`source_markdown_slug`), the database-only facts about it (`entity_slug`
 * with no `source_markdown_slug`), its takes, and the links and link
 * transitions whose origin (else from) page it is. The finalization contract
 * reads it under the publication's page keys before and after the transaction's
 * projections and diffs the two on logical keys, so projection churn (rows
 * rewritten with identical values, renumbered, re-inserted) yields no event.
 */
import type { BrainEngine } from '../engine.ts';
import { legacyClaimFingerprints, mayHaveLegacyFingerprint } from './legacy-fingerprint.ts';

export interface RawPage {
  id: number; slug: string; deleted: boolean; revision: string; content_hash: string | null; tier: string;
  visible: boolean; large: boolean; incarnation: string;
}
export interface RawFact {
  id: number; entity_slug: string | null; sms: string | null; entity_page_id: number | null; fact: string; fp: string;
  /** SHA-256 of `fact` (the fingerprint cache key); set by the stream reads. */
  th?: string;
  kind: string; visibility: string; notability: string; context: string | null; confidence: number;
  valid_from: string | null; valid_until: string | null; claim_metric: string | null; claim_value: number | null;
  claim_unit: string | null; claim_period: string | null; event_type: string | null; dimension: string | null;
  value: string | null; value_hash: string | null; row_num: number | null; tier: string;
}
export interface RawTake {
  id: number; page_id: number; row_num: number; claim: string; claim_fp: string; th?: string; kind: string; holder: string; weight: number;
  since_date: string | null; until_date: string | null; source: string | null; active: boolean;
  resolved_at: string | null; resolved_outcome: boolean | null; resolved_value: number | null; resolved_unit: string | null;
  resolved_source: string | null; resolved_by: string | null; resolved_quality: string | null; tier: string;
}
export interface RawEndpoint { id: number; slug: string; source_id: string; incarnation: string }
export interface RawLink {
  id: number; from: RawEndpoint; to: RawEndpoint; origin: RawEndpoint | null; link_type: string; link_source: string | null;
  context: string; origin_field: string | null; link_kind: string | null; resolution_type: string | null; assertion_tense: string | null;
}
export interface RawTransition {
  id: number; from: RawEndpoint; to: RawEndpoint; origin: RawEndpoint | null; link_type: string; kind: string;
  occurred_on: string; date_precision: string; producer: string; line_hash: string;
}
/** `counts`: the transaction's write counters for facts, takes, links and link_transitions at the read (null: `track_counts` is off). */
export interface RawState { pages: RawPage[]; facts: RawFact[]; takes: RawTake[]; links: RawLink[]; transitions: RawTransition[]; writerTier: string | null;
  counts?: string[] | null }

const iso = (value: unknown): string | null => value == null ? null : new Date(value as string).toISOString();
const num = (value: unknown): number | null => value == null ? null : Number(value);

export const FINGERPRINT_CACHE_MAX = 20_000;
export const FINGERPRINT_STREAMS_MAX = 2_000;
/**
 * Process-local fingerprint cache: claim-text SHA-256 to its `gbrain_fact_fingerprint`, the stream reads' costliest
 * column (a regexp normalization per row). It holds hashes only, never claim text, and is bounded: the oldest entries
 * go first. `streamHashes` names the text hashes each stream's last read saw, so a read passes the database the
 * hashes whose fingerprints it already has and the database fingerprints only the rest.
 */
const fingerprints = new Map<string, string>();
const streamHashes = new Map<string, string[]>();
const remember = <V>(map: Map<string, V>, key: string, value: V, max: number) => {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value!);
};
/** Test-only: the cache's contents, to poison an entry or clear it. */
export function __fingerprintCacheForTests(): { fingerprints: Map<string, string>; streams: Map<string, string[]> } { return { fingerprints, streams: streamHashes }; }

let touchedSignalSuppressed = false;
/** Test-only: report every counted table as unwritten, so a re-read reuses the earlier rows whatever the transaction wrote. */
export function __suppressBeliefTouchedSignalForTests(suppressed: boolean): void { touchedSignalSuppressed = suppressed; }

/**
 * One state read (engine-sql/belief-state.ts). `slugs` select the stream pages and the facts
 * keyed to them; `pageIds` add pages by id (a renamed page is found at its new
 * slug). With `known` (the batch's pre-read), a counted table this transaction
 * has not written since `known` was read is not read again while the stream
 * pages are the same pages at the same slugs: its rows are `known`'s, with fact
 * entity pages and link endpoints read fresh. With `track_counts` off every part is read.
 */
export async function readBeliefState(tx: BrainEngine, sourceId: string, slugs: readonly string[], pageIds: readonly number[] = [], known?: RawState,
  planModePrev?: string): Promise<RawState> {
  // Fingerprints of claim texts whose hash `known` (the batch's pre-read) or the cache already has are not recomputed;
  // the statement and its reuse rules are engine-sql/belief-state.ts readBeliefStateRows.
  const streamKey = (slug: string) => `${sourceId}\u0000${slug}`;
  const knownFp = new Map<string, string>([...(known?.facts ?? []).map(f => [f.th, f.fp] as const), ...(known?.takes ?? []).map(k => [k.th, k.claim_fp] as const)]
    .flatMap(([th, fp]) => th === undefined ? [] : [[th, fp] as [string, string]]));
  for (const slug of new Set([...slugs, ...(known?.pages ?? []).map(p => p.slug)])) {
    for (const hash of streamHashes.get(streamKey(slug)) ?? []) { const fp = fingerprints.get(hash); if (fp !== undefined) knownFp.set(hash, fp); }
  }
  const row = await tx.readBeliefStateRows({ sourceId, slugs, pageIds, knownFp: Object.fromEntries(knownFp), knownCounts: known?.counts ?? null,
    knownPages: (known?.pages ?? []).map(p => `${p.id}:${p.slug}`),
    knownEntitySlugs: [...new Set((known?.facts ?? []).flatMap(f => f.entity_slug == null ? [] : [f.entity_slug]))], suppressed: touchedSignalSuppressed,
    planModePrev: planModePrev ?? null });
  const { pages: pageRows, counts, facts, entity_pages: entityPages, takes, links, transitions, endpoints } = row;
  const byId = new Map(endpoints.map(r => [Number(r.id), { id: Number(r.id), slug: String(r.slug), source_id: String(r.source_id), incarnation: String(r.incarnation) }]));
  const endpoint = (id: unknown): RawEndpoint | null => id == null ? null : byId.get(Number(id)) ?? null;
  const pages: RawPage[] = pageRows.map(r => ({ id: Number(r.id), slug: String(r.slug), deleted: r.deleted === true, revision: String(r.revision),
    content_hash: (r.content_hash as string | null) ?? null, tier: String(r.trust_tier), visible: r.visible === true, large: r.large === true,
    incarnation: String(r.incarnation) }));
  const entityPageOf = new Map((entityPages ?? []).map(([slug, id]) => [slug, Number(id)]));
  const factRows = facts ? facts.map(toFact) : null;
  const takeRows = takes ? takes.map(toTake) : null;
  // Fingerprints computed here (not known or cached, which already are) take a claim's pre-v353 fingerprint where its history has it.
  const fresh = <T extends { th?: string }>(rows: T[] | null, text: (r: T) => string) => (rows ?? []).filter(r => r.th === undefined || !knownFp.has(r.th))
    .filter(r => mayHaveLegacyFingerprint(text(r)));
  const freshFacts = fresh(factRows, f => f.fact), freshTakes = fresh(takeRows, k => k.claim);
  if (freshFacts.length || freshTakes.length) {
    const legacy = await legacyClaimFingerprints(tx, sourceId, [...freshFacts.map(f => f.fact), ...freshTakes.map(k => k.claim)]);
    for (const f of freshFacts) f.fp = legacy.get(f.fact) ?? f.fp;
    for (const k of freshTakes) k.claim_fp = legacy.get(k.claim) ?? k.claim_fp;
  }
  const slugOfPage = new Map(pages.map(p => [p.id, p.slug]));
  const seen = new Map<string, string[]>();
  for (const [slug, th, fp] of [...(factRows ?? known!.facts).map(f => [f.sms ?? f.entity_slug ?? '', f.th, f.fp] as const),
    ...(takeRows ?? known!.takes).map(k => [slugOfPage.get(k.page_id) ?? '', k.th, k.claim_fp] as const)]) {
    if (th === undefined) continue;
    remember(fingerprints, th, fp, FINGERPRINT_CACHE_MAX);
    const hashes = seen.get(slug);
    if (hashes) hashes.push(th); else seen.set(slug, [th]);
  }
  for (const [slug, hashes] of seen) remember(streamHashes, streamKey(slug), hashes, FINGERPRINT_STREAMS_MAX);
  return {
    pages,
    facts: factRows ?? (known!.facts.some(f => f.entity_page_id !== (f.entity_slug == null ? null : entityPageOf.get(f.entity_slug) ?? null))
      ? known!.facts.map(f => ({ ...f, entity_page_id: f.entity_slug == null ? null : entityPageOf.get(f.entity_slug) ?? null })) : known!.facts),
    takes: takeRows ?? known!.takes,
    links: links ? links.map(r => ({ id: Number(r.id), from: endpoint(r.f)!, to: endpoint(r.t)!, origin: endpoint(r.o), link_type: String(r.link_type),
      link_source: (r.link_source as string | null) ?? null, context: String(r.context ?? ''), origin_field: (r.origin_field as string | null) ?? null,
      link_kind: (r.link_kind as string | null) ?? null, resolution_type: (r.resolution_type as string | null) ?? null,
      assertion_tense: (r.assertion_tense as string | null) ?? null }))
      : known!.links.map(l => ({ ...l, from: endpoint(l.from.id)!, to: endpoint(l.to.id)!, origin: endpoint(l.origin?.id) })),
    transitions: transitions ? transitions.map(r => ({ id: Number(r.id), from: endpoint(r.f)!, to: endpoint(r.t)!, origin: endpoint(r.o),
      link_type: String(r.link_type), kind: String(r.kind), occurred_on: String(r.occurred_on), date_precision: String(r.date_precision),
      producer: String(r.producer), line_hash: String(r.line_hash) }))
      : known!.transitions.map(x => ({ ...x, from: endpoint(x.from.id)!, to: endpoint(x.to.id)!, origin: endpoint(x.origin?.id) })),
    writerTier: row.writer_tier || null,
    counts,
  };
}

/** Rows by id, for a guard event whose row lives outside the batch's streams. */
export async function readFactsById(tx: BrainEngine, sourceId: string, ids: readonly number[]): Promise<RawFact[]> {
  const facts = (await tx.readBeliefFactsById(ids)).map(toFact);
  const legacy = await legacyClaimFingerprints(tx, sourceId, facts.map(f => f.fact));
  for (const f of facts) f.fp = legacy.get(f.fact) ?? f.fp;
  return facts;
}

function toFact(r: Record<string, unknown>): RawFact {
  return { id: Number(r.id), entity_slug: (r.entity_slug as string | null) ?? null, sms: (r.sms as string | null) ?? null,
    entity_page_id: num(r.entity_page_id), fact: String(r.fact), fp: String(r.fp), th: String(r.th), kind: String(r.kind), visibility: String(r.visibility),
    notability: String(r.notability), context: (r.context as string | null) ?? null, confidence: Number(r.confidence),
    valid_from: iso(r.valid_from), valid_until: iso(r.valid_until), claim_metric: (r.claim_metric as string | null) ?? null,
    claim_value: num(r.claim_value), claim_unit: (r.claim_unit as string | null) ?? null, claim_period: (r.claim_period as string | null) ?? null,
    event_type: (r.event_type as string | null) ?? null, dimension: (r.dimension as string | null) ?? null, value: (r.value as string | null) ?? null,
    value_hash: (r.value_hash as string | null) ?? null, row_num: num(r.row_num), tier: String(r.trust_tier) };
}

function toTake(r: Record<string, unknown>): RawTake {
  return { id: Number(r.id), page_id: Number(r.page_id), row_num: Number(r.row_num), claim: String(r.claim), claim_fp: String(r.claim_fp), th: String(r.th),
    kind: String(r.kind), holder: String(r.holder), weight: Number(r.weight), since_date: (r.since_date as string | null) ?? null,
    until_date: (r.until_date as string | null) ?? null, source: (r.source as string | null) ?? null, active: r.active === true,
    resolved_at: iso(r.resolved_at), resolved_outcome: (r.resolved_outcome as boolean | null) ?? null, resolved_value: num(r.resolved_value),
    resolved_unit: (r.resolved_unit as string | null) ?? null, resolved_source: (r.resolved_source as string | null) ?? null,
    resolved_by: (r.resolved_by as string | null) ?? null, resolved_quality: (r.resolved_quality as string | null) ?? null, tier: String(r.trust_tier) };
}
