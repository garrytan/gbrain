/**
 * Automatic company links (plan autoplan-20261117192252, Decision F as narrowed at gate_rev 7): two company pages in
 * different sources that the finder calls `clean` (a shared LinkedIn company page, GitHub login or declared id that no
 * other page carries, exactly the same strict name, one page per source, no id that disagrees) are linked as one identity
 * without asking. Person pages are never linked here: a person pair with the same evidence waits on the confirm list.
 *
 * The rows are `entity_identities` with established_by 'dedupe:auto', derived from the pages' own keys and recomputed by
 * every sweep (sync's hook, gbrain dedupe reconcile and reject); they are never written to git and never written to a page.
 * A sweep touches only 'dedupe:auto' rows, leaves out a group with a page already in another identity group (a hand link
 * or a confirm), with a quarantined page, an unverified auto-extracted stub or a flagged page, and, on a brain whose
 * decisions go to git, a group reject could not record there (a page in an owner-only source or a restricted page). It never
 * links a pair the owner recorded as different (gbrain dedupe reject), even one recorded while it ran, so a rejected pair
 * is never linked again. A host that sees no checkout of a brain whose decisions are in git leaves the links alone.
 */
import type { BrainEngine } from '../engine.ts';
import { isUnverifiedExtraction } from '../extraction-review.ts';
import { hasContentFlag, isQuarantined } from '../quarantine.ts';
import { findTypedDuplicateGroups, type DuplicateGroup } from './duplicates.ts';
import type { AutoLinkWrite, IdentityDecisionsRead } from '../engine-sql/identity-decisions.ts';
import { canonicalOf, decidedSets, identityHome, memberKey, unpublishableMembers } from './identity-decisions.ts';
import { DEFAULT_SOURCE_ID } from '../sync-failure-ledger.ts';

export const AUTO_LINK = 'dedupe:auto';

export interface AutoLink { entity_id: string; source_id: string; slug: string; canonical: boolean }
export interface SkippedGroup { group_id: string; reason: 'in_identity_group' | 'untrusted_page' | 'unpublishable' }
export interface CompanySweepResult { groups: number; linked: number; unlinked: number; skipped: SkippedGroup[]; stale?: true; store_mismatch?: true }

/** Every page the sweep linked, by identity. */
export async function listAutoLinks(engine: BrainEngine): Promise<AutoLink[]> {
  return (await engine.readAutoLinkState([])).auto.map(r => ({ entity_id: r.entity_id, source_id: r.source_id, slug: r.slug, canonical: r.canonical }));
}

/**
 * Clean cross-source company groups the owner has not decided: what the sweep links. The finder reads person and company
 * pages alike, so an id a person page also carries keeps the company pair out of `clean`, as in the preview.
 */
export async function companyLinkGroups(engine: BrainEngine, read?: IdentityDecisionsRead): Promise<DuplicateGroup[]> {
  const { result, kindOf } = await findTypedDuplicateGroups(engine, { kind: 'cross_source', decided: decidedSets(read ?? await engine.listIdentityDecisions()) });
  return result.groups.filter(g => g.class === 'clean' && kindOf.get(g.id) === 'company');
}

const rowKey = (r: AutoLinkWrite) => `${r.entity_id}\t${r.source_id}\t${r.page_id}\t${r.canonical}`;

/** Recompute the automatic company links: one transaction, writing only when something changed. */
export async function sweepCompanyLinks(engine: BrainEngine): Promise<CompanySweepResult> {
  const read = await engine.listIdentityDecisions();
  const home = await identityHome(engine);
  if (!home && read.decisions.some(d => d.origin === 'git')) return { groups: 0, linked: 0, unlinked: 0, skipped: [], store_mismatch: true };
  const groups = await companyLinkGroups(engine, read);
  const state = await engine.readAutoLinkState(groups.flatMap(g => g.members));
  const blocked = home ? await unpublishableMembers(engine, home.sourceId, groups) : groups.map(() => null);
  const byMember = new Map(state.candidates.map(p => [memberKey(p), p]));
  const skipped: SkippedGroup[] = [];
  const want: AutoLinkWrite[] = [];
  for (const [i, g] of groups.entries()) {
    const found = g.members.map(m => byMember.get(memberKey(m)));
    if (found.some(p => !p)) continue;
    const pages = found.map(p => p!);
    if (pages.some(p => p.entity_id !== null && p.established_by !== AUTO_LINK)) { skipped.push({ group_id: g.id, reason: 'in_identity_group' }); continue; }
    if (pages.some(p => isQuarantined(p.frontmatter) || isUnverifiedExtraction(p.frontmatter) || hasContentFlag(p.frontmatter))) { skipped.push({ group_id: g.id, reason: 'untrusted_page' }); continue; }
    if (blocked[i]) { skipped.push({ group_id: g.id, reason: 'unpublishable' }); continue; }
    const canonical = await canonicalOf(engine, g.members, DEFAULT_SOURCE_ID);
    for (const p of pages) want.push({ entity_id: g.id, page_id: p.id, source_id: p.source_id, canonical: p.source_id === canonical.source_id && p.slug === canonical.slug });
  }
  const haveKeys = new Set(state.auto.map(rowKey));
  const wantKeys = new Set(want.map(rowKey));
  const linked = want.filter(r => !haveKeys.has(rowKey(r))).length;
  const unlinked = state.auto.filter(r => !wantKeys.has(rowKey(r))).length;
  const result = { groups: groups.length - skipped.length, linked, unlinked, skipped };
  if (!linked && !unlinked) return result;
  const written = await engine.replaceAutoLinks({ rows: want, expectRevision: read.revision });
  return written.stale ? { ...result, linked: 0, unlinked: 0, stale: true } : result;
}
