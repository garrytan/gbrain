/**
 * The decide egress gate: one consent contract for every path.
 *
 * A third-party provider receives a data class (query, candidates, facts,
 * conversation) only with consent for that provider (decide.egress.typesafe.
 * <class>, written by `gbrain decide enable`; for S1 `on`, the reranker
 * selection is the consent for query and candidate text). Denied sources are
 * refused on every provider. Private content never leaves without
 * decide.egress.private=allow: page candidates are checked by ONE batched
 * query per decision on (source_id, slug) with privatePagesFilterFragment
 * (which carries the #5525 derived-origin rule); facts use their own
 * visibility (default private); conversation text is private by nature.
 * Items with missing provenance are refused. The llm: provider follows
 * today's chat egress rules (only denied sources apply).
 *
 * A slot on by the key-aware default (DecideSlotConfig.keyDefault) treats the
 * TypeSafe key as consent for its own data classes and as the private opt-in
 * for its conversation and fact items only; page candidates keep the batched
 * visibility check and denied sources are refused as always.
 */
import type { BrainEngine } from '../../engine.ts';
import { privatePagesFilterFragment } from '../../search/private-visibility.ts';
import type { DecideConfig } from './config.ts';
import { SLOT_SPECS } from './slots.ts';
import type { DecideQuestion, DecideSlot, EvidenceItem } from './types.ts';

export type EgressRefusal = 'egress_private_denied' | 'egress_class_denied' | 'missing_provenance' | 'denied_source';

export interface EgressVerdict {
  /** The state itself is refused: nothing may be sent. */
  stateRefused?: EgressRefusal;
  /** Question ids withheld, with the reason. */
  refused: Record<string, EgressRefusal>;
}

function provenanceMissing(item: EvidenceItem): boolean {
  if (item.class === 'candidates') return !item.slug;
  if (item.class === 'facts') return item.fact_id === undefined;
  if (item.class === 'conversation') return !item.transcript_ref;
  return false;
}

/** Visible (non-private) page keys among `items`, by one query. */
async function visiblePages(engine: BrainEngine, items: EvidenceItem[]): Promise<Set<string>> {
  const pairs = items.filter((i) => i.class === 'candidates' && i.slug);
  if (pairs.length === 0) return new Set();
  const sources = pairs.map((i) => i.source_id ?? 'default');
  const slugs = pairs.map((i) => i.slug!);
  const rows = await engine.executeRaw<{ source_id: string; slug: string }>(
    `SELECT p.source_id, p.slug FROM pages p
       JOIN unnest($1::text[], $2::text[]) AS want(source_id, slug) ON want.source_id = p.source_id AND want.slug = p.slug
      WHERE p.deleted_at IS NULL AND ${privatePagesFilterFragment('p')}`,
    [sources, slugs],
  );
  return new Set(rows.map((r) => `${r.source_id}\u0000${r.slug}`));
}

export async function checkEgress(
  engine: BrainEngine | null,
  cfg: DecideConfig,
  provider: string,
  state: Record<string, EvidenceItem>,
  questions: readonly DecideQuestion[],
  opts: { consent?: 'decide' | 'reranker'; slot?: DecideSlot } = {},
): Promise<EgressVerdict> {
  const thirdParty = provider.startsWith('typesafe:');
  const keyDefaultClasses: readonly string[] = opts.slot && cfg.slots[opts.slot]?.keyDefault ? SLOT_SPECS[opts.slot].egressClasses : [];
  const denied = new Set(cfg.denySources);
  const all = [...Object.values(state), ...questions.flatMap((q) => Object.values(q.inputs ?? {}))];
  const needsPageCheck = thirdParty && opts.consent !== 'reranker' && cfg.egressPrivate === 'deny' && all.some((i) => i.class === 'candidates');
  let visible = new Set<string>();
  let pageCheckFailed = false;
  if (needsPageCheck) {
    try {
      visible = engine ? await visiblePages(engine, all) : new Set();
      if (!engine) pageCheckFailed = true;
    } catch {
      pageCheckFailed = true;
    }
  }
  const judge = (item: EvidenceItem): EgressRefusal | undefined => {
    if (item.source_id && denied.has(item.source_id)) return 'denied_source';
    if (!thirdParty) return undefined;
    if (provenanceMissing(item)) return 'missing_provenance';
    // S1 `on`: the reranker selection is the consent for query and candidate text (as with Voyage).
    if (opts.consent === 'reranker' && (item.class === 'query' || item.class === 'candidates')) return undefined;
    if (!cfg.consent[item.class] && !keyDefaultClasses.includes(item.class)) return 'egress_class_denied';
    if (cfg.egressPrivate === 'allow') return undefined;
    if (keyDefaultClasses.includes(item.class) && (item.class === 'conversation' || item.class === 'facts')) return undefined;
    if (item.class === 'conversation') return 'egress_private_denied';
    if (item.class === 'facts') return item.visibility === 'world' ? undefined : 'egress_private_denied';
    if (item.class === 'candidates') {
      if (pageCheckFailed) return 'egress_private_denied';
      return visible.has(`${item.source_id ?? 'default'}\u0000${item.slug}`) ? undefined : 'egress_private_denied';
    }
    return undefined;
  };
  for (const item of Object.values(state)) {
    const reason = judge(item);
    if (reason) return { stateRefused: reason, refused: Object.fromEntries(questions.map((q) => [q.id, reason])) };
  }
  const refused: Record<string, EgressRefusal> = {};
  for (const q of questions) {
    for (const item of Object.values(q.inputs ?? {})) {
      const reason = judge(item);
      if (reason) { refused[q.id] = reason; break; }
    }
  }
  return { refused };
}
