/**
 * Automatic person links and collapses (GST-3609 PR C and its follow-up, `gbrain dedupe auto`): the candidate pairs of
 * the classes that passed the labelled sample gate are joined without asking. A C2 pair is linked as one person: a "same"
 * decision recorded the way an owner's confirm is (in git first on a brain with a repository, in the database otherwise),
 * with decided_by `dedupe:auto:C2`, so `gbrain dedupe undo <decision id>` removes one and `gbrain dedupe reject` keeps a
 * pair apart for good. A C7 pair (two pages in one source, same name, a shared id) is collapsed instead: the newer page
 * points at the older one (merged_into plus an alias, collapse.ts), in one commit on a source with a repository or
 * through the page door otherwise, and `gbrain dedupe undo <collapse id>` takes it back. `gbrain dedupe auto --off
 * <class>` removes everything the class did and stops it.
 *
 * The gate passed C2 (an email or phone that only these two person pages hold, in two sources, where the names differ
 * only in form) and C7 (every sampled pair the same person). Not joined here: C1 and C3, whose samples were nearly all mirror copies
 * of one page and are sampled again without them; C5 and C6, with more than 2 wrong pairs in 100.
 *
 * A pair is joined only when nothing holds it back: no family, minor or restricted page, no page that is not a person
 * and no names that disagree unless one is a handle (hold), no contradiction (Mx, or X2 from web searches already cached;
 * auto sends none), no page in another pair that would be joined, counted over every source whatever --source names, and
 * no page already in an identity group (either would join three pages on two signals). A link also needs, on a brain
 * that keeps decisions in git, no page that must stay out of the repository; a collapse needs a writable source and,
 * there, both pages' files.
 *
 * Every write checks again inside itself: a link whose class was switched off, whose pages were rejected, linked or
 * decided meanwhile is left out (under the commit lock, or against the database revision it read), and a collapse
 * re-reads both pages, so a stale plan never writes over a concurrent reject or --off.
 */
import type { BrainEngine } from '../../engine.ts';
import type { GBrainConfig } from '../../config.ts';
import type { IdentityDecisionsRead, IdentityMemberRef } from '../../engine-sql/identity-decisions.ts';
import { listEntityIdentities } from '../../entity-identity.ts';
import { canonicalOf, committedDecisions, decidedSets, decisionId, forgetDecisions, identityHome, memberKey, recordDecisions, storeMismatch,
  unpublishableMembers, type DecisionInput, type RecordResult } from '../identity-decisions.ts';
import { classifyPairs, type ClassifiedPair } from './classes.ts';
import { exaSettings } from './exa.ts';
import { applyCollapse, listCollapses, planCollapse, undoCollapse, type CollapseOutcome, type CollapsePlan, type CollapseRecord } from './collapse.ts';

export const AUTO_CLASSES = ['C2', 'C7'] as const;
export type AutoClass = typeof AUTO_CLASSES[number];
export const AUTO_DECIDED_BY = 'dedupe:auto:';
/** decided_by of a reject that corrects an automatic link or collapse: `owner:corrects:dedupe:auto:<class>`. */
export const CORRECTS_PREFIX = 'owner:corrects:';
export const autoSwitchKey = (c: AutoClass) => `dedupe.auto.${c.toLowerCase()}`;

export function parseAutoClass(raw: string): AutoClass | null {
  return AUTO_CLASSES.find(c => c.toLowerCase() === raw.trim().toLowerCase()) ?? null;
}

/** The class a pair would be joined under, whatever the switches say, or null. */
export function autoClassOf(p: ClassifiedPair): AutoClass | null {
  if ((p.base !== 'C2' && p.base !== 'C7') || p.hold || p.signals.some(s => s === 'X2' || s === 'Mx')) return null;
  return p.base;
}

export async function autoSwitches(engine: BrainEngine): Promise<Record<AutoClass, 'on' | 'off'>> {
  const out = {} as Record<AutoClass, 'on' | 'off'>;
  for (const c of AUTO_CLASSES) out[c] = (await engine.getConfig(autoSwitchKey(c)))?.trim().toLowerCase() === 'off' ? 'off' : 'on';
  return out;
}

export interface AutoLink { pair: string; class: AutoClass; decision: string; members: IdentityMemberRef[]; entity_id: string; canonical: IdentityMemberRef }
export interface AutoSetAside { pair: string; class: AutoClass; reason: 'shared_member' | 'in_group' | 'not_publishable' | 'read_only_source' | 'no_file'; members: IdentityMemberRef[] }
export interface AutoPlan { switches: Record<AutoClass, 'on' | 'off'>; links: AutoLink[]; collapses: CollapsePlan[]; set_aside: AutoSetAside[] }

const ref = (m: { source_id: string; slug: string }): IdentityMemberRef => ({ source_id: m.source_id, slug: m.slug });

async function inGroup(engine: BrainEngine, members: IdentityMemberRef[]): Promise<boolean> {
  for (const m of members) {
    if ((await listEntityIdentities(engine, { slug: m.slug, slugSourceId: m.source_id })).some(x => x.slug === m.slug && x.source_id === m.source_id)) return true;
  }
  return false;
}

/** What `gbrain dedupe auto --apply` would link and collapse now. Read-only. */
export async function planAutoLinks(engine: BrainEngine, opts: { sourceId?: string } = {}): Promise<AutoPlan> {
  const switches = await autoSwitches(engine);
  const { pairs } = await classifyPairs(engine, { exa: { mode: 'dry_run', settings: await exaSettings(engine, {}) } });
  const eligible = pairs.flatMap(p => {
    const cls = autoClassOf(p);
    return cls && switches[cls] === 'on' ? [{ p, cls }] : [];
  });
  const seen = new Map<string, number>();
  for (const { p } of eligible) for (const m of p.members) seen.set(memberKey(m), (seen.get(memberKey(m)) ?? 0) + 1);
  const home = await identityHome(engine);
  const links: AutoLink[] = [];
  const collapses: CollapsePlan[] = [];
  const setAside: AutoSetAside[] = [];
  for (const { p, cls } of eligible) {
    if (opts.sourceId && !p.members.some(m => m.source_id === opts.sourceId)) continue;
    const members = p.members.map(ref);
    const aside = (reason: AutoSetAside['reason']) => setAside.push({ pair: p.id, class: cls, reason, members });
    if (members.some(m => (seen.get(memberKey(m)) ?? 0) > 1)) { aside('shared_member'); continue; }
    if (await inGroup(engine, members)) { aside('in_group'); continue; }
    if (cls === 'C7') {
      const c = await planCollapse(engine, p.id, members);
      if ('reason' in c) aside(c.reason); else collapses.push(c.plan);
      continue;
    }
    if (home && (await unpublishableMembers(engine, home.sourceId, [{ members }])).some(b => b !== null)) { aside('not_publishable'); continue; }
    const decision = decisionId(members);
    links.push({ pair: p.id, class: cls, decision, members, entity_id: `person-${decision}`, canonical: await canonicalOf(engine, members, home?.sourceId ?? null) });
  }
  return { switches, links, collapses, set_aside: setAside };
}

export interface AutoApplied {
  /** The decisions recorded, when any link was. */
  record: RecordResult | null;
  linked: string[];
  /** Links the write left out: their class is off now, or their pages were rejected, linked or decided since the plan. */
  changed: string[];
  collapses: CollapseOutcome[];
}

/**
 * Records the plan's links in one write, re-checked inside it, then collapses each planned C7 pair in its own write
 * (one commit each on a source with a repository), each re-reading its pages and the switch first.
 */
export async function applyAutoLinks(engine: BrainEngine, plan: AutoPlan, config: GBrainConfig | null = null): Promise<AutoApplied> {
  let record: RecordResult | null = null;
  if (plan.links.length) {
    if (!(await identityHome(engine))) {
      const read = await engine.listIdentityDecisions();
      if (read.decisions.some(d => d.origin === 'git')) throw storeMismatch(read.decisions);
    }
    const decisions: DecisionInput[] = plan.links.map(l => ({ verdict: 'same', members: l.members, group_id: l.pair, entity_id: l.entity_id,
      canonical: l.canonical, decided_by: `${AUTO_DECIDED_BY}${l.class}` }));
    const classes = [...new Set(plan.links.map(l => l.class))].join(', ');
    record = await recordDecisions(engine, decisions, `dedupe: link ${decisions.length} pair(s) of person pages automatically (${classes})`, [],
      { recheck: (pending, read) => stillLinkable(engine, pending, read) });
  }
  const linked = record?.recorded ?? [];
  const collapses: CollapseOutcome[] = [];
  for (const c of plan.collapses) {
    collapses.push(await applyCollapse(engine, c, config, () => stillCollapsible(engine, c))
      .catch((error): CollapseOutcome => ({ collapse: c.collapse, status: 'skipped', reason: 'failed', store: c.store, note: error instanceof Error ? error.message : String(error) })));
  }
  return { record, linked, changed: plan.links.map(l => l.decision).filter(id => !linked.includes(id)), collapses };
}

/** The pending automatic links still to record: class still on, no decision on the pair yet, no reject covering it, no page in a group. */
async function stillLinkable(engine: BrainEngine, pending: DecisionInput[], read: IdentityDecisionsRead): Promise<DecisionInput[]> {
  const switches = await autoSwitches(engine);
  const taken = new Set(read.decisions.map(d => d.decision_id));
  const apart = decidedSets(read).apart.map(set => new Set(set.map(memberKey)));
  const out: DecisionInput[] = [];
  for (const d of pending) {
    const cls = parseAutoClass(d.decided_by.slice(AUTO_DECIDED_BY.length));
    if (!cls || switches[cls] !== 'on' || taken.has(decisionId(d.members))) continue;
    const keys = d.members.map(memberKey);
    if (apart.some(set => (set.size === 1 ? keys.some(k => set.has(k)) : keys.every(k => set.has(k))))) continue;
    if (await inGroup(engine, d.members)) continue;
    out.push(d);
  }
  return out;
}

/**
 * A planned collapse may still be written: C7 is on, neither page has become restricted, and no "different" decision
 * covers the pair (in the database, or committed to the decisions repository for this pair or either page and not read
 * back yet). applyCollapse runs it inside the write.
 */
async function stillCollapsible(engine: BrainEngine, c: CollapsePlan): Promise<boolean> {
  if ((await autoSwitches(engine))[c.class] !== 'on') return false;
  const members = [c.retired, c.canonical].map(slug => ({ source_id: c.source_id, slug }));
  if ((await engine.listRestrictedIdentityMembers(members)).length) return false;
  const home = await identityHome(engine);
  const keys = members.map(memberKey);
  const ids = new Set([decisionId(members), ...members.map(m => decisionId([m]))]);
  return ![...(await engine.listIdentityDecisions()).decisions, ...(home ? await committedDecisions(home, ids) : [])].some(d => {
    if (d.verdict !== 'different') return false;
    const set = new Set(d.members.map(memberKey));
    return set.size === 1 ? keys.some(k => set.has(k)) : keys.every(k => set.has(k));
  });
}

/** The automatic links recorded at or after `since` (epoch ms), newest first; one class when named. */
export function autoLinksSince(read: IdentityDecisionsRead, since: number, cls?: AutoClass) {
  return read.decisions.filter(d => d.verdict === 'same' && d.decided_by.startsWith(AUTO_DECIDED_BY)
    && (!cls || d.decided_by === `${AUTO_DECIDED_BY}${cls}`) && Date.parse(d.decided_at) >= since)
    .sort((a, b) => (a.decided_at < b.decided_at ? 1 : a.decided_at > b.decided_at ? -1 : 0));
}

/** The automatic links and collapses of one class the owner rejected at or after `since`: the corrections a weekly sample keeps. */
export function correctionsSince(read: IdentityDecisionsRead, since: number, cls: AutoClass) {
  return read.decisions.filter(d => d.verdict === 'different' && d.decided_by === `${CORRECTS_PREFIX}${AUTO_DECIDED_BY}${cls}` && Date.parse(d.decided_at) >= since);
}

/** The collapses in place made at or after `since` (epoch ms), newest first. */
export async function collapsesSince(engine: BrainEngine, since: number): Promise<CollapseRecord[]> {
  return (await listCollapses(engine)).filter(c => Date.parse(c.at) >= since);
}

/** Every automatic link of a class, read from the committed decision files too on a brain that keeps them in git. */
async function autoDecisionIds(engine: BrainEngine, cls: AutoClass): Promise<string[]> {
  const home = await identityHome(engine);
  const committed = new Map((home ? await committedDecisions(home) : []).map(d => [d.decision_id, d]));
  const auto = (d: { verdict: string; decided_by: string }) => d.verdict === 'same' && d.decided_by === `${AUTO_DECIDED_BY}${cls}`;
  const all = [...(await engine.listIdentityDecisions()).decisions, ...committed.values()];
  return [...new Set(all.filter(d => auto(d) && (!committed.has(d.decision_id) || auto(committed.get(d.decision_id)!))).map(d => d.decision_id))];
}

/**
 * Switches a class off, then removes everything it did, twice, so a run that read the switch before it flipped and wrote
 * meanwhile is removed too (each write also re-reads the switch). Links go in one write (like gbrain dedupe undo); each
 * collapse is undone in its own write. `left` names collapses that were not undone (a page changed, a read-only source,
 * or a write that failed): undo each one by hand.
 */
export async function switchAutoClassOff(engine: BrainEngine, cls: AutoClass, config: GBrainConfig | null = null): Promise<{ removed: string[]; left: string[] }> {
  const removed: string[] = [];
  const left = new Set<string>();
  const sweep = async () => {
    if (cls === 'C7') {
      for (const c of (await listCollapses(engine)).filter(x => !removed.includes(x.collapse))) {
        const r = await undoCollapse(engine, c, config).catch((): null => null);
        if (!r) { left.add(c.collapse); continue; }
        if (r.status === 'undone') { removed.push(c.collapse); left.delete(c.collapse); } else left.add(c.collapse);
      }
      return;
    }
    const ids = (await autoDecisionIds(engine, cls)).filter(id => !removed.includes(id));
    if (!ids.length) return;
    removed.push(...(await forgetDecisions(engine, ids, `dedupe: switch automatic ${cls} links off and remove ${ids.length}`)).removed);
  };
  await engine.setConfig(autoSwitchKey(cls), 'off');
  await sweep();
  await sweep();
  return { removed, left: [...left] };
}
