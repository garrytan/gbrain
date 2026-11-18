/**
 * Automatic company links (plan autoplan-20261117192252, Decision F as narrowed at gate_rev 7): two company pages in
 * different sources that the finder calls `clean` (a shared LinkedIn company page, GitHub login or declared id that no
 * other page carries, exactly the same strict name, one page per source, no id that disagrees) are linked as one identity
 * without asking. Person pages are never linked here: a person pair with the same evidence waits on the confirm list.
 *
 * The rows are `entity_identities` with established_by 'dedupe:auto', derived from the pages' own keys and recomputed by
 * every sweep (sync's hook, gbrain dedupe reconcile and reject); they are never written to git and never written to a page.
 * A sweep touches only 'dedupe:auto' rows, leaves out a group with a page already in another identity group (a hand link
 * or a confirm), with a quarantined page, an unverified auto-extracted stub or a flagged page, and never links a pair the
 * owner recorded as different (gbrain dedupe reject), so a rejected pair is never linked again.
 */
import type { BrainEngine } from '../engine.ts';
import { isUnverifiedExtraction } from '../extraction-review.ts';
import { hasContentFlag, isQuarantined } from '../quarantine.ts';
import { findTypedDuplicateGroups, type DuplicateGroup } from './duplicates.ts';
import { canonicalOf, decidedSets, identityHome, memberKey } from './identity-decisions.ts';

export const AUTO_LINK = 'dedupe:auto';

export interface AutoLink { entity_id: string; source_id: string; slug: string; canonical: boolean }
export interface SkippedGroup { group_id: string; reason: 'in_identity_group' | 'untrusted_page' }
export interface CompanySweepResult { groups: number; linked: number; unlinked: number; skipped: SkippedGroup[] }

/** Every page the sweep linked, by identity. */
export async function listAutoLinks(engine: BrainEngine): Promise<AutoLink[]> {
  const rows = await engine.executeRaw<AutoLink>(
    `SELECT ei.entity_id, p.source_id, p.slug, ei.canonical
       FROM entity_identities ei JOIN pages p ON p.id = ei.page_id AND p.source_id = ei.source_id
      WHERE ei.established_by = $1
      ORDER BY ei.entity_id, p.source_id, p.slug`, [AUTO_LINK]);
  return rows.map(r => ({ entity_id: r.entity_id, source_id: r.source_id, slug: r.slug, canonical: r.canonical === true }));
}

/** Clean cross-source company groups the owner has not decided: what the sweep links. */
export async function companyLinkGroups(engine: BrainEngine): Promise<DuplicateGroup[]> {
  const read = await engine.listIdentityDecisions();
  const { result } = await findTypedDuplicateGroups(engine, { entityKinds: ['company'], kind: 'cross_source', decided: decidedSets(read) });
  return result.groups.filter(g => g.class === 'clean');
}

interface Row { entity_id: string; page_id: number; source_id: string; canonical: boolean }
const rowKey = (r: Row) => `${r.entity_id}\t${r.source_id}\t${r.page_id}\t${r.canonical}`;

/** Recompute the automatic company links: one transaction, writing only when something changed. */
export async function sweepCompanyLinks(engine: BrainEngine): Promise<CompanySweepResult> {
  const groups = await companyLinkGroups(engine);
  const members = groups.flatMap(g => g.members);
  const pages = members.length ? await engine.executeRaw<{ id: number; source_id: string; slug: string; frontmatter: unknown; entity_id: string | null; established_by: string | null }>(
    `SELECT p.id, p.source_id, p.slug, p.frontmatter, ei.entity_id, ei.established_by
       FROM pages p
       JOIN unnest($1::text[], $2::text[]) AS t(source_id, slug) ON p.source_id = t.source_id AND p.slug = t.slug
       LEFT JOIN entity_identities ei ON ei.source_id = p.source_id AND ei.page_id = p.id
      WHERE p.deleted_at IS NULL`, [members.map(m => m.source_id), members.map(m => m.slug)]) : [];
  const byMember = new Map(pages.map(p => [memberKey(p), p]));
  const home = (await identityHome(engine))?.sourceId ?? null;
  const skipped: SkippedGroup[] = [];
  const want: Row[] = [];
  for (const g of groups) {
    const found = g.members.map(m => byMember.get(memberKey(m)));
    if (found.some(p => !p)) continue;
    if (found.some(p => p!.entity_id !== null && p!.established_by !== AUTO_LINK)) { skipped.push({ group_id: g.id, reason: 'in_identity_group' }); continue; }
    const fm = (p: typeof pages[number]) => (typeof p.frontmatter === 'string' ? JSON.parse(p.frontmatter) : p.frontmatter) as Record<string, unknown> | null;
    if (found.some(p => isQuarantined(fm(p!)) || isUnverifiedExtraction(fm(p!)) || hasContentFlag(fm(p!)))) { skipped.push({ group_id: g.id, reason: 'untrusted_page' }); continue; }
    const canonical = await canonicalOf(engine, g.members, home);
    for (const p of found) want.push({ entity_id: g.id, page_id: Number(p!.id), source_id: p!.source_id, canonical: p!.source_id === canonical.source_id && p!.slug === canonical.slug });
  }
  const have = (await engine.executeRaw<Row>(
    `SELECT entity_id, page_id, source_id, canonical FROM entity_identities WHERE established_by = $1`, [AUTO_LINK]))
    .map(r => ({ entity_id: r.entity_id, page_id: Number(r.page_id), source_id: r.source_id, canonical: r.canonical === true }));
  const haveKeys = new Set(have.map(rowKey));
  const wantKeys = new Set(want.map(rowKey));
  const linked = want.filter(r => !haveKeys.has(rowKey(r))).length;
  const unlinked = have.filter(r => !wantKeys.has(rowKey(r))).length;
  if (linked || unlinked) {
    await engine.transaction(async tx => {
      if (engine.kind === 'postgres') await tx.executeRaw(`SELECT pg_advisory_xact_lock(hashtextextended('gbrain:identity-decisions', 0))`);
      await tx.executeRaw(`DELETE FROM entity_identities WHERE established_by = $1`, [AUTO_LINK]);
      if (want.length) {
        await tx.executeRaw(
          `INSERT INTO entity_identities (entity_id, source_id, page_id, confidence, established_by, canonical)
           SELECT t.entity_id, t.source_id, t.page_id, 1.0, $5, t.canonical
             FROM unnest($1::text[], $2::text[], $3::int[], $4::text[]::boolean[]) AS t(entity_id, source_id, page_id, canonical)
             JOIN pages p ON p.id = t.page_id AND p.source_id = t.source_id AND p.deleted_at IS NULL
           ON CONFLICT (source_id, page_id) DO NOTHING`,
          [want.map(r => r.entity_id), want.map(r => r.source_id), want.map(r => r.page_id), want.map(r => (r.canonical ? 'true' : 'false')), AUTO_LINK]);
      }
    });
  }
  return { groups: groups.length - skipped.length, linked, unlinked, skipped };
}
