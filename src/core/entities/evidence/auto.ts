/**
 * Automatic person links (GST-3609 PR C, `gbrain dedupe auto`): the candidate pairs of the classes that passed the
 * labelled sample gate are linked as one person. Each link is a "same" decision recorded the way an owner's confirm is
 * (in git first on a brain with a repository, in the database otherwise), with decided_by `dedupe:auto:<class>`, so
 * `gbrain dedupe undo <decision id>` removes one, `gbrain dedupe reject` keeps a pair apart for good, and
 * `gbrain dedupe auto --off <class>` removes every link of the class and stops it.
 *
 * The gate passed C2 only: an email or phone that only these two person pages hold, in two sources, where the names
 * differ only in form (a handle for a title, a contact card beside a page); two full names that disagree are held.
 * Not linked here: C1 and C3, whose samples were nearly all mirror copies of one page and are sampled again without
 * them; C5 and C6, with more than 2 wrong pairs in 100; and C7, two pages in one source, which are collapsed by a
 * pointer and an alias rather than linked.
 *
 * A pair is linked only when nothing holds it back: no family, minor or restricted page, no page that is not a person
 * and no full names that disagree (hold), no contradiction (Mx, or X2 from web searches already cached; auto sends
 * none), no page in another pair that would link, counted over every source whatever --source names, and no page
 * already in an identity group (either would join three pages on two signals), and, on a brain that keeps decisions in
 * git, no page that must stay out of the repository.
 */
import type { BrainEngine } from '../../engine.ts';
import type { IdentityDecisionsRead, IdentityMemberRef } from '../../engine-sql/identity-decisions.ts';
import { listEntityIdentities } from '../../entity-identity.ts';
import { canonicalOf, decisionId, forgetDecisions, identityHome, memberKey, recordDecisions, storeMismatch, unpublishableMembers, type DecisionInput, type RecordResult } from '../identity-decisions.ts';
import { classifyPairs, type ClassifiedPair } from './classes.ts';
import { exaSettings } from './exa.ts';

export const AUTO_CLASSES = ['C2'] as const;
export type AutoClass = typeof AUTO_CLASSES[number];
export const AUTO_DECIDED_BY = 'dedupe:auto:';
export const autoSwitchKey = (c: AutoClass) => `dedupe.auto.${c.toLowerCase()}`;

export function parseAutoClass(raw: string): AutoClass | null {
  return AUTO_CLASSES.find(c => c.toLowerCase() === raw.trim().toLowerCase()) ?? null;
}

/** The class a pair would be linked under, whatever the switches say, or null. */
export function autoClassOf(p: ClassifiedPair): AutoClass | null {
  if (p.base !== 'C2' || p.hold || p.signals.some(s => s === 'X2' || s === 'Mx')) return null;
  return 'C2';
}

export async function autoSwitches(engine: BrainEngine): Promise<Record<AutoClass, 'on' | 'off'>> {
  const out = {} as Record<AutoClass, 'on' | 'off'>;
  for (const c of AUTO_CLASSES) out[c] = (await engine.getConfig(autoSwitchKey(c)))?.trim().toLowerCase() === 'off' ? 'off' : 'on';
  return out;
}

export interface AutoLink { pair: string; class: AutoClass; decision: string; members: IdentityMemberRef[]; entity_id: string; canonical: IdentityMemberRef }
export interface AutoSetAside { pair: string; class: AutoClass; reason: 'shared_member' | 'in_group' | 'not_publishable'; members: IdentityMemberRef[] }
export interface AutoPlan { switches: Record<AutoClass, 'on' | 'off'>; links: AutoLink[]; set_aside: AutoSetAside[] }

const ref = (m: { source_id: string; slug: string }): IdentityMemberRef => ({ source_id: m.source_id, slug: m.slug });

/** What `gbrain dedupe auto --apply` would link now. Read-only. */
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
  const setAside: AutoSetAside[] = [];
  for (const { p, cls } of eligible) {
    if (opts.sourceId && !p.members.some(m => m.source_id === opts.sourceId)) continue;
    const members = p.members.map(ref);
    const aside = (reason: AutoSetAside['reason']) => setAside.push({ pair: p.id, class: cls, reason, members });
    if (members.some(m => (seen.get(memberKey(m)) ?? 0) > 1)) { aside('shared_member'); continue; }
    let grouped = false;
    for (const m of members) {
      grouped ||= (await listEntityIdentities(engine, { slug: m.slug, slugSourceId: m.source_id })).some(x => x.slug === m.slug && x.source_id === m.source_id);
    }
    if (grouped) { aside('in_group'); continue; }
    if (home && (await unpublishableMembers(engine, home.sourceId, [{ members }])).some(b => b !== null)) { aside('not_publishable'); continue; }
    const decision = decisionId(members);
    links.push({ pair: p.id, class: cls, decision, members, entity_id: `person-${decision}`, canonical: await canonicalOf(engine, members, home?.sourceId ?? null) });
  }
  return { switches, links, set_aside: setAside };
}

/** Records the plan's links in one write. */
export async function applyAutoLinks(engine: BrainEngine, plan: AutoPlan): Promise<RecordResult | null> {
  if (!plan.links.length) return null;
  if (!(await identityHome(engine))) {
    const read = await engine.listIdentityDecisions();
    if (read.decisions.some(d => d.origin === 'git')) throw storeMismatch(read.decisions);
  }
  const decisions: DecisionInput[] = plan.links.map(l => ({ verdict: 'same', members: l.members, group_id: l.pair, entity_id: l.entity_id,
    canonical: l.canonical, decided_by: `${AUTO_DECIDED_BY}${l.class}` }));
  const classes = [...new Set(plan.links.map(l => l.class))].join(', ');
  return recordDecisions(engine, decisions, `dedupe: link ${decisions.length} pair(s) of person pages automatically (${classes})`);
}

/** The automatic links recorded at or after `since` (epoch ms), newest first; one class when named. */
export function autoLinksSince(read: IdentityDecisionsRead, since: number, cls?: AutoClass) {
  return read.decisions.filter(d => d.verdict === 'same' && d.decided_by.startsWith(AUTO_DECIDED_BY)
    && (!cls || d.decided_by === `${AUTO_DECIDED_BY}${cls}`) && Date.parse(d.decided_at) >= since)
    .sort((a, b) => (a.decided_at < b.decided_at ? 1 : a.decided_at > b.decided_at ? -1 : 0));
}

/** Switches a class off and removes every link it made; the removal is one write, like gbrain dedupe undo. */
export async function switchAutoClassOff(engine: BrainEngine, cls: AutoClass): Promise<{ removed: string[] }> {
  await engine.setConfig(autoSwitchKey(cls), 'off');
  const ids = autoLinksSince(await engine.listIdentityDecisions(), 0, cls).map(d => d.decision_id);
  if (!ids.length) return { removed: [] };
  const r = await forgetDecisions(engine, ids, `dedupe: switch automatic ${cls} links off and remove ${ids.length}`);
  return { removed: r.removed };
}
