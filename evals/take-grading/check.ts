/**
 * The $0 instrument checks (W6 take-grading eval). Each returns a list of
 * violations; an empty list means the fixtures have the shape the
 * preregistration claims.
 */
import { formatEvidenceBlock, type EvidenceHit } from '../../src/core/cycle/grade-takes.ts';
import type { Take } from '../../src/core/engine.ts';
import { daysBetween, SET_COUNTS, type Fixture, type SetName, type Split } from './cases.ts';

/** The fixture's take in the shape the production judge and formatter read. */
export function productionTake(f: Fixture): Take {
  return {
    id: f.take.id, page_id: 0, page_slug: f.take.page_slug, row_num: 1, claim: f.take.claim, kind: f.take.kind,
    holder: f.take.holder, weight: f.take.weight, since_date: f.take.since_date, until_date: null, source: null,
    superseded_by: null, active: true, resolved_at: null, resolved_outcome: null, resolved_quality: null,
    resolved_value: null, resolved_unit: null, resolved_source: null, resolved_by: null,
  } as Take;
}

/** The hits as the production retriever returns them (no gold-only fields). */
export function productionHits(f: Fixture): EvidenceHit[] {
  return f.hits.map(h => ({ slug: h.slug, title: h.title, chunk_text: h.chunk_text, effective_date: h.effective_date } as EvidenceHit));
}

/** The evidence block the judge sees, through the production formatter. */
export function evidenceBlock(f: Fixture): string {
  return formatEvidenceBlock(productionTake(f), productionHits(f));
}

const SLUG = /^(companies|people|meetings|notes|updates|research)\/[a-z0-9-]+-example$/;
const PLACEHOLDER_NAME = /\b([A-Za-z][A-Za-z-]*-example)\b/g;

export function checkFixtures(fixtures: Fixture[]): string[] {
  const out: string[] = [];
  const counts: Record<string, number> = {};
  const claims = new Map<string, string>();
  const ids = new Set<string>();
  for (const f of fixtures) {
    counts[`${f.split}/${f.set}`] = (counts[`${f.split}/${f.set}`] ?? 0) + 1;
    if (ids.has(f.id)) out.push(`${f.id}: duplicate id`);
    ids.add(f.id);
    const prior = claims.get(f.take.claim);
    if (prior) out.push(`${f.id}: claim repeats ${prior}`);
    claims.set(f.take.claim, f.id);
    if (!SLUG.test(f.take.page_slug)) out.push(`${f.id}: take page ${f.take.page_slug} is not a placeholder slug`);
    for (const h of f.hits) if (!SLUG.test(h.slug)) out.push(`${f.id}: hit slug ${h.slug} is not a placeholder slug`);
    if (!/-example$/.test(f.take.holder)) out.push(`${f.id}: holder ${f.take.holder} is not a placeholder`);

    const world = f.set === 'world_no_evidence' || f.set === 'world_counterfactual';
    const names = [f.take.claim, ...f.hits.map(h => h.chunk_text)].join(' ').match(PLACEHOLDER_NAME) ?? [];
    if (world && f.take.claim.replace(/, as [a-z]+-example put it$/, '').match(PLACEHOLDER_NAME)) out.push(`${f.id}: a world claim names a placeholder entity`);
    if (!world && !names.length) out.push(`${f.id}: names no placeholder entity`);

    const block = evidenceBlock(f);
    if (block.includes('[evidence truncated]')) out.push(`${f.id}: evidence block is truncated`);
    if (f.hits.length === 0 && !block.startsWith('No evidence found')) out.push(`${f.id}: empty hits do not give the no-evidence note`);

    const decisive = f.hits.filter(h => h.decisive);
    const since = f.take.since_date;
    const H = f.horizon;
    const fail = (why: string) => out.push(`${f.id} (${f.set}): ${why}`);
    switch (f.set as SetName) {
      case 'resolved_correct':
        if (decisive.length !== 1 || decisive[0]!.about !== f.subject) fail('needs one decisive hit about the subject');
        else if (daysBetween(since, decisive[0]!.effective_date) <= 0) fail('decisive hit is not after the claim');
        else if (H && daysBetween(decisive[0]!.effective_date, H) >= 0 && f.hits.some(h => h.about === f.subject && !h.decisive && daysBetween(decisive[0]!.effective_date, h.effective_date) >= 0)) fail('progress is dated after the achievement');
        break;
      case 'resolved_incorrect':
      case 'restatement':
      case 'partial':
        if (decisive.length !== 1 || decisive[0]!.about !== f.subject) fail('needs one decisive hit about the subject');
        else if (!H || daysBetween(H, decisive[0]!.effective_date) <= 0) fail('decisive hit is not after the horizon');
        break;
      case 'pre_horizon':
        if (!decisive.length || !H) fail('needs decisive hits and a horizon');
        for (const h of decisive) if (daysBetween(since, h.effective_date) <= 0 || daysBetween(h.effective_date, H!) <= 0) fail(`hit ${h.effective_date} is not between the claim and the horizon`);
        break;
      case 'pre_claim':
        if (!decisive.length) fail('needs decisive hits');
        for (const h of f.hits) if (h.about === f.subject && daysBetween(h.effective_date, since) <= 0) fail(`subject hit ${h.effective_date} is not before the claim`);
        break;
      case 'no_evidence':
      case 'world_no_evidence':
        if (f.hits.length) fail('must carry no hits');
        break;
      case 'distractor':
        if (decisive.length !== 1 || decisive[0]!.about === f.subject || !decisive[0]!.about.startsWith(f.subject.replace(/-example$/, '-'))) fail('needs one decisive hit about a near-name entity');
        if (f.hits.some(h => h.about === f.subject)) fail('carries a hit about the subject itself');
        break;
      case 'world_counterfactual':
        if (decisive.length !== 1 || !f.world_truth || f.world_truth === f.gold) fail('needs one decisive hit that contradicts the real outcome');
        break;
    }
    if (f.set !== 'pre_claim' && f.set !== 'world_counterfactual' && f.set !== 'distractor') {
      for (const h of f.hits) if (h.about === f.subject && !h.decisive && f.set !== 'resolved_correct' && f.set !== 'resolved_incorrect') fail('non-decisive hit about the subject');
    }
  }
  for (const split of ['dev', 'counted'] as Split[]) {
    for (const [set, n] of Object.entries(SET_COUNTS[split])) {
      if ((counts[`${split}/${set}`] ?? 0) !== n) out.push(`${split}/${set}: ${counts[`${split}/${set}`] ?? 0} fixtures, expected ${n}`);
    }
  }
  return out;
}
