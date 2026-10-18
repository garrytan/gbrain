/**
 * Keyed belief subjects of a raw stream state (docs/designs/BELIEF_LEDGER.md
 * sections 3-4). Row ids and fence positions are payload: they ride along to
 * correlate guard notes and replacements inside one transaction, never in a key.
 */
import { factKey, linkKey, ontologyKey, takeKey, takeClaimHash, transitionKey, valueHash, lifetimeRef, slugRef, type SubjectRef } from './keys.ts';
import type { RawEndpoint, RawFact, RawPage, RawState, RawTake } from './state.ts';

export type SubjectKind = 'fact' | 'take' | 'link' | 'link_transition';
export interface Subject {
  kind: SubjectKind; key: string; stream: string; value: Record<string, unknown>; vhash: string; tier: string; visibility: string;
  rowIds: number[]; rowNum: number | null; dbOnly: boolean; claimFp: string | null; validFrom: string | null; validUntil: string | null;
  label: Record<string, unknown>;
}

export interface KeyContext {
  incarnation: string;
  /** page id -> page lifetime, for every page the state names. */
  lifetimes: ReadonlyMap<number, string>;
  /** Stream pages of this side by slug. */
  pagesBySlug: ReadonlyMap<string, RawPage>;
}

const pageRef = (ctx: KeyContext, id: number | null | undefined, slug: string | null): SubjectRef | null => {
  if (id != null && ctx.lifetimes.has(id)) return lifetimeRef(ctx.lifetimes.get(id)!);
  return slug == null ? null : slugRef(ctx.incarnation, slug);
};
const endpointRef = (ctx: KeyContext, e: RawEndpoint | null): SubjectRef | null => e == null ? null
  : ctx.lifetimes.has(e.id) ? lifetimeRef(ctx.lifetimes.get(e.id)!) : slugRef(e.incarnation, e.slug);

/** Built with its keys in canonical order, so `canonicalJson` does not sort them. */
export function factValue(f: RawFact, entity: SubjectRef | null, count: number): Record<string, unknown> {
  return { claim_metric: f.claim_metric, claim_period: f.claim_period, claim_unit: f.claim_unit, claim_value: f.claim_value, confidence: f.confidence,
    context: f.context, ...(count > 1 ? { count } : {}), ...(f.sms != null ? { entity } : {}), event_type: f.event_type, fact: f.fact, kind: f.kind,
    notability: f.notability, valid_from: f.valid_from, valid_until: f.valid_until, value: f.value };
}

/** Built with its keys in canonical order, so `canonicalJson` does not sort them. */
export function takeValue(t: RawTake): Record<string, unknown> {
  return { active: t.active, claim: t.claim, holder: t.holder, kind: t.kind, resolved_at: t.resolved_at, resolved_by: t.resolved_by,
    resolved_outcome: t.resolved_outcome, resolved_quality: t.resolved_quality, resolved_source: t.resolved_source, resolved_unit: t.resolved_unit,
    resolved_value: t.resolved_value, since_date: t.since_date, source: t.source, until_date: t.until_date, weight: t.weight };
}

/** One fact row keyed: claim facts by (subject, fp, visibility); ontology observations by their stint identity. */
export function keyFact(ctx: KeyContext, f: RawFact): { key: string; stream: string; entity: SubjectRef | null } {
  const stream = f.sms ?? f.entity_slug ?? '';
  const subjectPage = ctx.pagesBySlug.get(stream);
  const subject = pageRef(ctx, subjectPage?.id, stream)!;
  const entity = pageRef(ctx, f.entity_page_id, f.entity_slug);
  if (f.dimension != null) return { stream, entity, key: ontologyKey(entity ?? subject, f.dimension, f.value_hash ?? '', f.sms == null ? null : subject, f.valid_from) };
  return { stream, entity, key: factKey(subject, f.fp, f.visibility) };
}

/**
 * `earlier`: the same batch's other side, keyed with the same lifetimes. Its fact and take subjects are reused when
 * `state` carries the very same row arrays over the same pages at the same slugs (the post-read reused them), with
 * take visibility taken from this side.
 */
export function keyedSubjects(ctx: KeyContext, state: RawState, pageVisibility: (pageId: number) => string,
  earlier?: { state: RawState; subjects: Subject[] }): Subject[] {
  const samePages = earlier != null && earlier.state.pages.length === state.pages.length
    && state.pages.every(p => earlier.state.pages.some(q => q.id === p.id && q.slug === p.slug));
  const reuse = (kind: 'fact' | 'take', rows: unknown[], before: unknown[]) => samePages && rows === before ? earlier!.subjects.filter(s => s.kind === kind) : null;
  const pageIdBySlug = new Map(state.pages.map(p => [p.slug, p.id]));
  const out: Subject[] = [];
  const reusedFacts = reuse('fact', state.facts, earlier?.state.facts ?? []);
  const reusedTakes = reuse('take', state.takes, earlier?.state.takes ?? []);
  if (reusedFacts) out.push(...reusedFacts);
  const facts = new Map<string, { rows: RawFact[]; stream: string; entity: SubjectRef | null }>();
  for (const f of reusedFacts ? [] : state.facts) {
    const { key, stream, entity } = keyFact(ctx, f);
    const group = facts.get(key) ?? { rows: [], stream, entity };
    group.rows.push(f);
    facts.set(key, group);
  }
  for (const [key, { rows, stream, entity }] of facts) {
    rows.sort((a, b) => (a.row_num ?? Infinity) - (b.row_num ?? Infinity) || a.id - b.id);
    const head = rows[0]!;
    const value = factValue(head, entity, rows.length);
    out.push({ kind: 'fact', key, stream, value, vhash: valueHash(value), tier: head.tier, visibility: head.visibility, rowIds: rows.map(r => r.id),
      rowNum: head.row_num, dbOnly: head.sms == null || (head.dimension != null && head.row_num == null), claimFp: head.fp, validFrom: head.valid_from, validUntil: head.valid_until,
      label: { subject_slug: stream, ...(head.entity_slug && head.entity_slug !== stream ? { entity_slug: head.entity_slug } : {}) } });
  }
  const pagesById = new Map(state.pages.map(p => [p.id, p]));
  if (reusedTakes) out.push(...reusedTakes.map(t => ({ ...t, visibility: pageVisibility(pageIdBySlug.get(t.stream)!) })));
  const byClaim = new Map<string, RawTake[]>();
  for (const t of reusedTakes ? [] : state.takes) {
    const group = `${t.page_id}\u0000${takeClaimHash(t.claim, t.kind, t.holder)}`;
    byClaim.set(group, [...byClaim.get(group) ?? [], t]);
  }
  for (const [group, rows] of byClaim) {
    rows.sort((a, b) => (a.since_date ?? '').localeCompare(b.since_date ?? '') || a.row_num - b.row_num);
    const claimHash = group.split('\u0000')[1]!;
    rows.forEach((t, ordinal) => {
      const page = pagesById.get(t.page_id)!;
      const value = takeValue(t);
      out.push({ kind: 'take', key: takeKey(ctx.lifetimes.get(t.page_id)!, claimHash, ordinal), stream: page.slug, value, vhash: valueHash(value),
        tier: t.tier, visibility: pageVisibility(t.page_id), rowIds: [t.id], rowNum: t.row_num, dbOnly: false, claimFp: t.claim_fp,
        validFrom: null, validUntil: null, label: { slug: page.slug } });
    });
  }
  for (const l of state.links) {
    const streamPage = l.origin ?? l.from;
    const key = linkKey(endpointRef(ctx, l.from)!, endpointRef(ctx, l.to)!, l.link_type, l.link_source, endpointRef(ctx, l.origin));
    // The context snippet is carried text, not belief: a prose edit around a link rewrites it without changing the
    // assertion, so it rides in the event value (purge redacts it there) but not in the value the diff compares.
    const identity = { origin_field: l.origin_field, link_kind: l.link_kind, resolution_type: l.resolution_type, assertion_tense: l.assertion_tense };
    const value = { ...identity, context: l.context };
    out.push({ kind: 'link', key, stream: streamPage.slug, value, vhash: valueHash(identity), tier: '', visibility: pageVisibility(streamPage.id), rowIds: [l.id],
      rowNum: null, dbOnly: false, claimFp: null, validFrom: null, validUntil: null,
      label: { from: [l.from.source_id, l.from.slug], to: [l.to.source_id, l.to.slug], ...(l.origin ? { origin: [l.origin.source_id, l.origin.slug] } : {}) } });
  }
  for (const x of state.transitions) {
    const streamPage = x.origin ?? x.from;
    const link = linkKey(endpointRef(ctx, x.from)!, endpointRef(ctx, x.to)!, x.link_type, null, endpointRef(ctx, x.origin));
    const value = { date_precision: x.date_precision, line_hash: x.line_hash };
    out.push({ kind: 'link_transition', key: transitionKey(link, x.kind, x.occurred_on, x.producer), stream: streamPage.slug, value, vhash: valueHash(value),
      tier: '', visibility: pageVisibility(streamPage.id), rowIds: [x.id], rowNum: null, dbOnly: false, claimFp: null, validFrom: null, validUntil: null,
      label: { from: [x.from.source_id, x.from.slug], to: [x.to.source_id, x.to.slug] } });
  }
  return dedupeLinks(out);
}

/** Two link rows can serialize to one key only through the NULLS NOT DISTINCT unique; keep the first. */
function dedupeLinks(subjects: Subject[]): Subject[] {
  const seen = new Set<string>();
  return subjects.filter(s => {
    if (s.kind === 'fact' || s.kind === 'take') return true;
    const id = `${s.kind}\u0000${s.key}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Every page a state's keys need a lifetime for: stream pages, link endpoints and origins, fact entities. */
export function pageNeeds(sourceId: string, incarnation: string, state: RawState): Array<{ sourceId: string; incarnation: string; slug: string; pageId: number }> {
  const needs: Array<{ sourceId: string; incarnation: string; slug: string; pageId: number }> = [];
  for (const p of state.pages) needs.push({ sourceId, incarnation, slug: p.slug, pageId: p.id });
  for (const f of state.facts) if (f.entity_page_id != null && f.entity_slug) needs.push({ sourceId, incarnation, slug: f.entity_slug, pageId: f.entity_page_id });
  for (const l of [...state.links, ...state.transitions]) {
    for (const e of [l.from, l.to, l.origin]) if (e) needs.push({ sourceId: e.source_id, incarnation: e.incarnation, slug: e.slug, pageId: e.id });
  }
  return needs;
}
