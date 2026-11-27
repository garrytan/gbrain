/**
 * GBRA-582 item 9 (leaver handover, PR 1): name the pages no enabled member reads remotely after a member is disabled
 * or a folder rule changes, and the label write that gives one back. Messages only: nothing here writes.
 */
import type { BrainEngine } from '../core/engine.ts';
import { appliedRules } from '../core/access/policy.ts';
import { folderRulesAllow, ruleCovers, ruleCoversSql, type FolderRule } from '../core/access/folder-rules.ts';
import { identityFor, MEMBER_PAGE_PREFIX, normalizeReaders, readersAllow, NOBODY } from '../core/access/principals.ts';
import { listMembers, type MemberRecord } from '../core/access/members.ts';
import { ownerMemberId, ownerReadsRestrictedOn } from '../core/access/owner.ts';
import { whoCanRead } from './access.ts';
import { LIVE_PAGES_NAMING_READER_LIMIT } from '../core/engine-sql/access-control.ts';

const SAMPLES = 5;
/** Pages naming a disabled member that member disable checks one by one with who-can-read (the live read takes one more to see a cut). */
const DISABLE_CHECK_LIMIT = LIVE_PAGES_NAMING_READER_LIMIT - 1;

interface PageRef { source_id: string; slug: string }

const plain = (p: string) => (p.startsWith('member:') ? p.slice(7) : p);
const sample = (refs: PageRef[], withSource: boolean) =>
  refs.slice(0, SAMPLES).map(r => (withSource ? `${r.source_id}:${r.slug}` : r.slug)).join(', ') + (refs.length > SAMPLES ? ', ...' : '');
const labelFix = (slug: string, readers: string) => `gbrain repair visibility --slug ${slug} --readers ${readers}`;
const withOwner = (readers: string[], owner: string | null) => (owner && !readers.includes(owner) ? [...readers, owner] : readers);

/** The who-can-read note for a page no enabled member reads remotely; null when someone does or the page is open. */
export function readByNobodyNote(entry: { slug: string; source_id: string; readers: string[] | null }, ruled: boolean, admitted: number,
  members: MemberRecord[], owner: string | null): string | null {
  if (admitted > 0 || (entry.readers === null && !ruled) || entry.readers?.includes(NOBODY)) return null;
  const down = (entry.readers ?? []).filter(r => r.startsWith('member:')).map(plain)
    .filter(id => members.find(m => m.id === id)?.status !== 'enabled');
  const named = (entry.readers ?? []).some(r => !down.includes(plain(r)));
  const why = down.length && !named ? `its readable_by names ${down.join(', ')}, which ${down.length === 1 ? 'is' : 'are'} disabled, removed or unknown`
    : entry.readers === null ? 'the folder rules covering it admit no enabled member'
    : ruled ? 'no enabled member meets both its readable_by and the folder rules covering it'
    : 'its readable_by names no enabled member';
  const fix = entry.readers === null
    ? `change the rule's readers (gbrain access rule list --source ${entry.source_id})`
    : labelFix(entry.slug, withOwner(['<member>'], owner).join(','));
  return `No enabled member reads it remotely: ${why}. The owner still reads it on the brain host. To give it to a member: ${fix}.`;
}

/** Pages whose readable_by names `memberId` that no enabled member reads remotely now (checked with who-can-read). */
export async function pagesReadByNobodyNaming(engine: BrainEngine, memberId: string): Promise<{ pages: PageRef[]; truncated: boolean }> {
  const rows = await engine.listPagesNamingReader(`member:${memberId}`, { live: true });
  const pages: PageRef[] = [];
  for (const row of rows.slice(0, DISABLE_CHECK_LIMIT)) {
    const [entry] = await whoCanRead(engine, row.slug, row.source_id);
    if (Array.isArray(entry?.members) && entry.members.length === 0) pages.push(row);
  }
  return { pages, truncated: rows.length > DISABLE_CHECK_LIMIT };
}

/** The member disable lines for the pages it leaves readable by no member. */
export async function disableReadByNobodyLines(engine: BrainEngine, memberId: string): Promise<string[]> {
  const { pages, truncated } = await pagesReadByNobodyNaming(engine, memberId);
  if (!pages.length) return [];
  const owner = await ownerMemberId(engine);
  return [
    `Pages naming it that no enabled member reads remotely now (${pages.length}${truncated ? ` among the first ${DISABLE_CHECK_LIMIT} checked` : ''}): ${sample(pages, true)}.`,
    `  The owner still reads them on the brain host. To give one to a member: ${labelFix(pages[0]!.slug, withOwner(['<member>'], owner).join(','))} (gbrain access who-can-read <slug> shows who reads a page).`,
  ];
}

/**
 * The rule-preview lines for pages under the changed prefixes that some enabled member reads under the applied rules
 * and no enabled member reads under `desired` (audit case 9c: a page written before its folder's rule named readers).
 */
export async function ruleReadByNobodyLines(engine: BrainEngine, sourceId: string, desired: FolderRule[], prefixes: string[]): Promise<string[]> {
  if (!prefixes.length) return [];
  const current = await appliedRules(engine, sourceId);
  const owner = await ownerMemberId(engine);
  const enabled = (await listMembers(engine)).filter(m => m.status === 'enabled');
  const ownerOptIn = !!owner && enabled.some(m => m.id === owner) && await ownerReadsRestrictedOn(engine);
  const identities = enabled.map(m => identityFor(m.id, m.groups));
  const rows = await engine.executeRaw<{ slug: string; frontmatter: unknown }>(
    `SELECT slug, frontmatter FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM unnest($2::text[]) AS pfx WHERE ${ruleCoversSql('slug', 'pfx')}) ORDER BY slug COLLATE "C"`,
    [sourceId, prefixes]);
  const someoneReads = (slug: string, fm: unknown, rules: FolderRule[]) => {
    const restricted = normalizeReaders(fm) !== null || rules.some(r => ruleCovers(slug, r.prefix));
    if (!restricted) return true;
    if (ownerOptIn && !slug.startsWith(MEMBER_PAGE_PREFIX)) return true;
    return identities.some(identity => folderRulesAllow(slug, rules, identity) && readersAllow(fm, identity));
  };
  const stranded: PageRef[] = [];
  for (const row of rows) {
    const fm = typeof row.frontmatter === 'string' ? JSON.parse(row.frontmatter) : row.frontmatter;
    if (someoneReads(row.slug, fm, current) && !someoneReads(row.slug, fm, desired)) stranded.push({ source_id: sourceId, slug: row.slug });
  }
  if (!stranded.length) return [];
  const rule = desired.find(r => ruleCovers(stranded[0]!.slug, r.prefix));
  const readers = withOwner((rule?.readable_by ?? ['member:<member>']).map(plain), owner).join(',');
  return [
    `  Pages this change leaves readable by no member remotely (${stranded.length}): ${sample(stranded, false)}. Their readable_by names no member the rules admit; the owner still reads them on the brain host.`,
    `  To give one to the members the rule lists: ${labelFix(stranded[0]!.slug, readers)}`,
  ];
}
