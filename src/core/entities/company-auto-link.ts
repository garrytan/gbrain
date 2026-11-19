/**
 * Companies that share an id link automatically (GST-3127, Garry's A1 and E1 to E3): after a sync, the company groups the
 * changed pages belong to are linked as one identity ('dedupe:auto' rows in entity_identities, database only, never in
 * git), and the automatic groups that no longer qualify are removed. `gbrain dedupe reconcile` runs the same sweep over
 * every company. People are never linked automatically, and nothing merges, renames or deletes a page.
 *
 * A cross-source company group links when all of these hold: the finder classes it `clean` (one type, one member per
 * source, one strict name, no vetoing key, no two different domains, and a shared exclusive key no page outside the
 * group carries); its members share a LinkedIn company page or the domain of their own site (a site value with no URL
 * path); no two members name different countries; no member sits in a group a person linked or confirmed, or in a
 * "same" decision; no "different" decision covers two members, by slug or by fingerprint; and, on a brain that keeps
 * decisions in git, no member is a page that must stay out of the repository (unpublishableMembers), since a later
 * reject writes its slug there. On such a brain only a host with the checkout sweeps.
 *
 * The plan carries each member's page id and generation and the decisions' revision; engine.applyIdentityDecisions
 * writes it in the decisions' locked transaction and skips a group whose pages moved since, so an older sweep never
 * writes a stale link. The canonical page is the home-source page, else the oldest.
 */
import type { BrainEngine } from '../engine.ts';
import type { AutoLinkGroup } from '../engine-sql/identity-decisions.ts';
import { findTypedDuplicateGroups, type DuplicateMember, type EntityPage } from './duplicates.ts';
import { decidedSets, decisionId, identityHome, memberKey, unpublishableMembers } from './identity-decisions.ts';

export const AUTO_LINK_ORIGIN = 'dedupe:auto';

export interface AutoLinkResult { scope: 'changed' | 'all'; planned: number; linked: number; unlinked: number; skipped: number; skipped_sweep?: 'no_checkout' | 'stale' }

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const shareAll = (members: EntityPage[], values: (p: EntityPage) => Iterable<string>) => {
  const [first, ...rest] = members.map(m => new Set(values(m)));
  return [...first!].some(v => rest.every(s => s.has(v)));
};
const linkedinCompanies = (p: EntityPage) => [...p.keys.values()].filter(k => k.key === 'linkedin').flatMap(k => [...k.values]).filter(v => v.startsWith('company/'));

/** The sweep. `near` limits it to the groups of those pages (sync); without it every company is swept (reconcile). */
export async function autoLinkCompanies(engine: BrainEngine, opts: { near?: DuplicateMember[]; log?: (line: string) => void } = {}): Promise<AutoLinkResult> {
  const scope = opts.near ? 'changed' : 'all';
  const none = (extra: Partial<AutoLinkResult> = {}): AutoLinkResult => ({ scope, planned: 0, linked: 0, unlinked: 0, skipped: 0, ...extra });
  const read = await engine.listIdentityDecisions();
  const home = await identityHome(engine);
  if (!home && read.decisions.some(d => d.origin === 'git')) {
    opts.log?.('[dedupe] companies that share an id are linked by the host that holds the checkout of the decisions; skipped here');
    return none({ skipped_sweep: 'no_checkout' });
  }
  const { result, kindOf, pages } = await findTypedDuplicateGroups(engine, { decided: decidedSets(read), kind: 'cross_source', ...(opts.near ? { near: opts.near } : {}) });
  const touched = opts.near ? new Set(opts.near.map(memberKey)) : null;
  const inSame = new Set(read.decisions.filter(d => d.verdict === 'same').flatMap(d => d.members.map(memberKey)));

  const candidates = result.groups.filter(g => g.class === 'clean' && kindOf.get(g.id) === 'company')
    .map(g => g.members.map(m => pages.get(memberKey(m))!))
    .filter(members => members.every(Boolean))
    .filter(members => !touched || members.some(m => touched.has(memberKey(m)) || m.identity?.established_by === AUTO_LINK_ORIGIN))
    .filter(members => shareAll(members, linkedinCompanies) || shareAll(members, p => p.ownDomains))
    .filter(members => new Set(members.flatMap(m => [...m.countries])).size <= 1)
    .filter(members => members.every(m => !inSame.has(memberKey(m)) && (!m.identity || m.identity.established_by === AUTO_LINK_ORIGIN)));
  const blocked = home ? await unpublishableMembers(engine, home.sourceId, candidates.map(members => ({ members }))) : candidates.map(() => null);
  const link: AutoLinkGroup[] = candidates.filter((_, i) => blocked[i] === null).map(members => {
    const sorted = [...members].sort((a, b) => cmp(a.source_id, b.source_id) || cmp(a.slug, b.slug));
    const canonical = sorted.find(m => m.source_id === home?.sourceId)
      ?? [...sorted].sort((a, b) => cmp(a.created_at, b.created_at) || cmp(a.source_id, b.source_id) || cmp(a.slug, b.slug))[0]!;
    return { entity_id: `dedupe-auto/${decisionId(sorted)}`, canonical_page_id: canonical.page_id,
      members: sorted.map(m => ({ source_id: m.source_id, page_id: m.page_id, generation: m.generation })) };
  });
  const planned = new Set(link.map(g => g.entity_id));
  const unlink = [...new Set([...pages.values()]
    .filter(p => p.identity?.established_by === AUTO_LINK_ORIGIN && !planned.has(p.identity.entity_id))
    .map(p => p.identity!.entity_id))];
  const gone = !!touched && [...touched].some(k => !pages.has(k));
  if (touched && unlink.length) return autoLinkCompanies(engine, { log: opts.log });
  const byPage = new Map([...pages.values()].map(p => [p.page_id, p.identity?.entity_id]));
  const fresh = link.filter(g => !g.members.every(m => byPage.get(m.page_id) === g.entity_id));
  if (!fresh.length && !unlink.length && !gone) return none({ planned: link.length });
  const r = await engine.applyIdentityDecisions({ expectRevision: read.revision, auto: { link: fresh, unlink } });
  if (r.stale) return none({ planned: link.length, skipped: link.length, skipped_sweep: 'stale' });
  if (touched && r.auto?.unlinked) {
    const all = await autoLinkCompanies(engine, { log: opts.log });
    return { ...all, unlinked: all.unlinked + r.auto.unlinked };
  }
  return { scope, planned: link.length, linked: r.auto?.linked ?? 0, unlinked: r.auto?.unlinked ?? 0, skipped: r.auto?.skipped ?? 0 };
}
