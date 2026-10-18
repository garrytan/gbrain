/**
 * D9: stored contradiction findings for a scoped reader (remote, source-scoped
 * or under a trust floor).
 *
 * A stored probe report carries no source identity and copies both sides'
 * text verbatim, private takes and sealed fence rows included, and its
 * resolution commands can quote a take claim. None of that is returned here.
 * Each side is re-read live by its global id (chunk or take) under the
 * caller's read policy: source scope, page visibility, live and unarchived
 * source, quarantine, current text projection, safe chunks for untrusted
 * callers, the takes holder allow-list and the trust floor. A finding survives
 * only when both sides are visible and both still read exactly as judged, so
 * its axis never describes text the caller cannot see. Text, source identity,
 * trust labels and the resolution command all come from the live rows.
 */
import type { BrainEngine } from '../engine.ts';
import { parseDateLoose } from '../effective-date.ts';
import { projectionEligibleSql } from '../eligibility/sql.ts';
import { stampPageTrust, stampRowTrust } from '../eligibility/stamp.ts';
import type { Contested } from '../eligibility/labels.ts';
import { pageReadFilter } from '../search/read-policy-sql.ts';
import { chunkVisibleFilter, requiresSafeChunks, safeChunksFilter } from '../search/safe-chunks.ts';
import { admitsTrust, compareTrust, storedTrustTier, type TrustTier } from '../trust/tier.ts';
import type { PageReadPolicy } from '../types.ts';
import { renderResolutionCommand } from './auto-supersession.ts';
import type { ContradictionFinding, PairMember } from './types.ts';

export interface ScopedMember extends PairMember {
  source_id: string;
  trust_tier: TrustTier;
  origin: string;
  unconfirmed?: true;
  contested?: Contested;
}

export interface ScopedFinding extends Omit<ContradictionFinding, 'a' | 'b' | 'combined_score'> {
  a: ScopedMember;
  b: ScopedMember;
  /** Set when the stored proposal would let the lower-trust side supersede a higher-trust take; the command is then a manual review. */
  supersede_withheld?: 'higher_trust_target';
}

interface Labels { trust_tier: TrustTier; origin: string; unconfirmed?: true; contested?: Contested }
interface LiveChunk { id: number; page_id: number; slug: string; source_id: string; chunk_text: string }
interface LiveTake { id: number; page_id: number; slug: string; source_id: string; row_num: number; claim: string; holder: string }
type LabeledChunk = LiveChunk & Labels & { judged_text: string };
type LabeledTake = LiveTake & Labels;

const finiteIds = (values: Array<number | null | undefined>) =>
  [...new Set(values.map(Number).filter(n => Number.isSafeInteger(n) && n > 0))];

async function loadChunks(engine: Pick<BrainEngine, 'executeRaw'>, ids: number[], policy: PageReadPolicy, floor: TrustTier | undefined) {
  if (!ids.length) return new Map<number, LabeledChunk>();
  const params: unknown[] = [ids];
  const pageSql = pageReadFilter('p', { ...policy, ...(floor ? { minTrust: floor } : {}) }, params, true);
  const safe = requiresSafeChunks(policy) ? ` AND ${safeChunksFilter('p')}` : '';
  const rows = await engine.executeRaw<LiveChunk>(
    `SELECT cc.id, cc.page_id, cc.chunk_text, p.slug, p.source_id
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE cc.id = ANY($1::int[]) AND ${pageSql} AND ${chunkVisibleFilter('p', 'cc')}${safe}`, params);
  const live = rows.map(r => ({ ...r, id: Number(r.id), page_id: Number(r.page_id), judged_text: r.chunk_text } as LiveChunk & { judged_text: string; trust_tier?: string; origin?: string; unconfirmed?: true; contested?: Contested }));
  const stamped = await stampPageTrust(engine, live, floor);
  return new Map(stamped.map((r): [number, LabeledChunk] => [r.id, { ...r, trust_tier: storedTrustTier(r.trust_tier), origin: r.origin ?? 'unrecorded' }]));
}

async function loadTakes(engine: Pick<BrainEngine, 'executeRaw'>, ids: number[], policy: PageReadPolicy, floor: TrustTier | undefined) {
  if (!ids.length) return new Map<number, LabeledTake>();
  const params: unknown[] = [ids];
  const pageSql = pageReadFilter('p', policy, params, true);
  let holderSql = '';
  if (policy.takesHoldersAllowList !== undefined) {
    params.push(policy.takesHoldersAllowList);
    holderSql = ` AND t.holder = ANY($${params.length}::text[])`;
  }
  const rows = await engine.executeRaw<LiveTake>(
    `SELECT t.id, t.page_id, t.row_num, t.claim, t.holder, p.slug, p.source_id
       FROM takes t JOIN pages p ON p.id = t.page_id
      WHERE t.id = ANY($1::bigint[]) AND t.active AND ${pageSql}${holderSql}
        AND ${projectionEligibleSql('takes', 't', floor ? { floor } : undefined)}`, params);
  const stamped = await stampRowTrust(engine, 'takes', rows.map(r => ({ ...r, id: Number(r.id), page_id: Number(r.page_id), row_num: Number(r.row_num) })), r => r.id);
  return new Map(stamped
    .map((r): LabeledTake => ({ ...r, trust_tier: storedTrustTier(r.trust_tier) }))
    .filter(r => !floor || admitsTrust(r.trust_tier, floor))
    .map((r): [number, LabeledTake] => [r.id, r]));
}

/**
 * The side a supersede proposal would replace, and the side whose content
 * would replace it; null when the command supersedes nothing.
 */
function supersedeSides(f: ScopedFinding): { target: ScopedMember; winner: ScopedMember } | null {
  if (f.resolution_kind === 'takes_supersede') {
    const target = f.b.take_id !== null ? f.b : f.a.take_id !== null ? f.a : null;
    return target ? { target, winner: target === f.a ? f.b : f.a } : null;
  }
  if (f.resolution_kind !== 'temporal_supersede') return null;
  const aMs = parseDateLoose(f.a.effective_date)?.getTime();
  const bMs = parseDateLoose(f.b.effective_date)?.getTime();
  if (aMs === undefined || bMs === undefined || aMs === bMs) return null;
  const [older, newer] = aMs < bMs ? [f.a, f.b] : [f.b, f.a];
  return older.take_id !== null ? { target: older, winner: newer } : null;
}

/** Resolve stored findings for a scoped reader; findings with a hidden, missing or changed side are dropped. */
export async function resolveScopedFindings(
  engine: Pick<BrainEngine, 'executeRaw'>,
  findings: ContradictionFinding[],
  policy: PageReadPolicy,
  floor: TrustTier | undefined,
): Promise<ScopedFinding[]> {
  const members = findings.flatMap(f => [f.a, f.b]);
  const [chunks, takes] = await Promise.all([
    loadChunks(engine, finiteIds(members.filter(m => m?.take_id == null).map(m => m?.chunk_id)), policy, floor),
    loadTakes(engine, finiteIds(members.map(m => m?.take_id)), policy, floor),
  ]);

  const live = (m: PairMember | undefined): ScopedMember | null => {
    if (!m) return null;
    const labels = (r: Labels) => ({
      trust_tier: r.trust_tier, origin: r.origin,
      ...(r.unconfirmed ? { unconfirmed: true as const } : {}),
      ...(r.contested ? { contested: r.contested } : {}),
    });
    if (m.take_id != null) {
      const t = takes.get(Number(m.take_id));
      if (!t || t.slug !== m.slug || t.claim !== m.text || (m.take_row_num != null && t.row_num !== Number(m.take_row_num))) return null;
      return {
        ...m, slug: t.slug, source_id: t.source_id, chunk_id: null, take_id: t.id, take_row_num: t.row_num,
        holder: t.holder, text: t.claim, ...labels(t),
      };
    }
    const c = m.chunk_id != null ? chunks.get(Number(m.chunk_id)) : undefined;
    if (!c || c.slug !== m.slug || c.judged_text !== m.text) return null;
    return {
      ...m, slug: c.slug, source_id: c.source_id, chunk_id: c.id, take_id: null, take_row_num: null,
      holder: null, text: c.chunk_text, ...labels(c),
    };
  };

  const out: ScopedFinding[] = [];
  for (const f of findings) {
    const a = live(f.a);
    const b = live(f.b);
    if (!a || !b) continue;
    const scoped: ScopedFinding = {
      kind: f.kind, verdict: f.verdict, severity: f.severity, axis: f.axis, confidence: f.confidence,
      resolution_kind: f.resolution_kind, resolution_command: '', a, b,
    };
    const sides = supersedeSides(scoped);
    if (sides && compareTrust(sides.target.trust_tier, sides.winner.trust_tier) > 0) {
      scoped.resolution_kind = 'manual_review';
      scoped.supersede_withheld = 'higher_trust_target';
    }
    scoped.resolution_command = renderResolutionCommand({ kind: f.kind, a, b, combined_score: 0 }, scoped.resolution_kind);
    out.push(scoped);
  }
  return out;
}
