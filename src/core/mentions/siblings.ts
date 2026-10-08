/**
 * Identity siblings: pages in one source whose titles name the same subject
 * under different prefixes ("Account sheet: Widget Co" and "CRM record:
 * Widget Co"). gbrain never treats them as one identity on the title alone
 * (no `entity_identities` row, no union of aliases or references). It shows
 * them side by side instead: the entity card lists them with their own aliases
 * and identity lines, search's alias fan-out also searches their names (each
 * spliced row names the alias and page that found it), and the gazetteer links
 * a name both pages claim to every candidate instead of dropping it.
 *
 * One rule decides a group, shared by the card, the fan-out and the
 * gazetteer: same source, the same normalized title subject, pairwise
 * different title prefixes, every page a linkable entity of one canonical
 * type that is not `person`, none in `mentions.exclude_slugs`, none with
 * frontmatter `identity: separate`, and at most SIBLING_GROUP_CAP pages (a
 * larger group is `capped` and groups nothing). `mentions.sibling_merge=false`
 * turns the rule off. Untrusted callers never see a private page as a sibling.
 */

import type { BrainEngine } from '../engine.ts';
import { normalizeAlias } from '../search/alias-normalize.ts';
import { canonicalTypeOf, linkableTypesFor, loadSourcePack, readMentionPolicy, type MentionPolicy, type PackTypes } from './policy.ts';
import { titleName } from './aliases.ts';

export const SIBLING_GROUP_CAP = 3;

export interface SiblingCandidate { slug: string; title: string | null; type: string | null; identity?: unknown }

export type SiblingVerdict = 'group' | 'disabled' | 'capped' | 'person' | 'type_mismatch' | 'separate' | 'excluded' | 'same_prefix' | 'subject_mismatch';

/** The prefix of a title before its last `: ` (empty for an unprefixed title), normalized. */
function titlePrefix(title: string | null): string {
  const t = (title ?? '').trim();
  const at = t.lastIndexOf(': ');
  return at < 0 ? '' : normalizeAlias(t.slice(0, at));
}

/** Whether `pages` (two or more) form one identity-sibling group under the rule above. */
export function siblingVerdict(pages: SiblingCandidate[], pack: PackTypes | null, policy: Pick<MentionPolicy, 'siblingMerge' | 'excludeSlugs'>): SiblingVerdict {
  if (!policy.siblingMerge) return 'disabled';
  if (pages.length > SIBLING_GROUP_CAP) return 'capped';
  const types = new Set(pages.map(p => canonicalTypeOf(p.type, pack)));
  if (types.has('person')) return 'person';
  if (types.size > 1) return 'type_mismatch';
  if (pages.some(p => String(p.identity ?? '').trim().toLowerCase() === 'separate')) return 'separate';
  if (pages.some(p => policy.excludeSlugs.includes(p.slug))) return 'excluded';
  if (new Set(pages.map(p => normalizeAlias(titleName(p.title ?? '')))).size > 1) return 'subject_mismatch';
  if (new Set(pages.map(p => titlePrefix(p.title))).size < pages.length) return 'same_prefix';
  return 'group';
}

export interface IdentitySiblings {
  /** The other pages of the group (the asked page excluded), by slug. */
  pages: Array<{ slug: string; title: string; type: string | null }>;
  /** True when more than SIBLING_GROUP_CAP pages share the subject, so none are shown. */
  capped: boolean;
  /** Why no group formed, for `extract mentions --explain`; absent when `pages` is non-empty. */
  verdict?: SiblingVerdict;
}

/**
 * The identity siblings of one page. Fail-soft: a read error returns no
 * siblings. `excludePrivate` applies the private-page predicate to every
 * candidate (untrusted callers).
 */
export async function readIdentitySiblings(engine: BrainEngine, sourceId: string, page: { slug: string; title: string | null },
  opts: { excludePrivate: boolean; policy?: MentionPolicy; pack?: PackTypes | null }): Promise<IdentitySiblings> {
  const subject = normalizeAlias(titleName(page.title ?? ''));
  if (!subject) return { pages: [], capped: false, verdict: 'subject_mismatch' };
  try {
    const policy = opts.policy ?? await readMentionPolicy(engine);
    if (!policy.siblingMerge) return { pages: [], capped: false, verdict: 'disabled' };
    const pack = opts.pack !== undefined ? opts.pack : await loadSourcePack(engine, sourceId);
    const types = linkableTypesFor(pack, policy);
    const { privatePagesFilterFragment } = await import('../search/private-visibility.ts');
    const privacy = opts.excludePrivate ? ` AND ${privatePagesFilterFragment('pages')}` : '';
    const like = `%: ${subject.replace(/[\\%_]/g, m => `\\${m}`)}`;
    const rows = await engine.executeRaw<{ slug: string; title: string | null; type: string | null; identity: unknown }>(
      `SELECT slug, title, type, frontmatter->>'identity' AS identity FROM pages
        WHERE source_id = $1 AND deleted_at IS NULL AND type = ANY($2::text[])
          AND (lower(title) = $3 OR lower(title) LIKE $4)${privacy}
        ORDER BY slug LIMIT ${SIBLING_GROUP_CAP + 2}`,
      [sourceId, types, subject, like]);
    const members = rows.filter(r => normalizeAlias(titleName(r.title ?? '')) === subject);
    if (!members.some(r => r.slug === page.slug) || members.length < 2) return { pages: [], capped: false };
    const verdict = siblingVerdict(members, pack, policy);
    if (verdict !== 'group') return { pages: [], capped: verdict === 'capped', verdict };
    return { pages: members.filter(r => r.slug !== page.slug).map(r => ({ slug: r.slug, title: r.title ?? r.slug, type: r.type })), capped: false };
  } catch {
    return { pages: [], capped: false };
  }
}

/**
 * The page facts about an identity-sibling group are attributed to: when
 * `slugs` (two or three live pages one name resolved to) form one group, the
 * lowest slug; otherwise null (a real ambiguity). Fact writers use it so a
 * name both siblings claim ("Telostra Robotics" for its account sheet and
 * CRM record) resolves instead of falling back to a slug no page has.
 */
export async function siblingCanonical(engine: BrainEngine, sourceId: string, slugs: string[], opts: { excludePrivate?: boolean } = {}): Promise<string | null> {
  const unique = [...new Set(slugs)].sort();
  if (unique.length < 2 || unique.length > SIBLING_GROUP_CAP) return null;
  try {
    const policy = await readMentionPolicy(engine);
    if (!policy.siblingMerge) return null;
    const { privatePagesFilterFragment } = await import('../search/private-visibility.ts');
    const rows = await engine.executeRaw<{ slug: string; title: string | null; type: string | null; identity: unknown }>(
      `SELECT slug, title, type, frontmatter->>'identity' AS identity FROM pages
        WHERE source_id = $1 AND deleted_at IS NULL AND slug = ANY($2::text[])${opts.excludePrivate ? ` AND ${privatePagesFilterFragment('pages')}` : ''}`,
      [sourceId, unique]);
    if (rows.length !== unique.length) return null;
    const pack = await loadSourcePack(engine, sourceId);
    const types = new Set(linkableTypesFor(pack, policy));
    if (!rows.every(r => r.type != null && types.has(r.type))) return null;
    return siblingVerdict(rows, pack, policy) === 'group' ? unique[0]! : null;
  } catch {
    return null;
  }
}

/**
 * Every `entity_slug` facts about this page may be stored under: the page,
 * its identity siblings and the slug of its title subject (what a fact saved
 * by name got before its siblings resolved). The entity card and recall read
 * all of them, so a saved fact shows up whichever sibling a reader asks for.
 */
export async function factEntitySlugs(engine: BrainEngine, sourceId: string, slug: string, opts: { excludePrivate?: boolean } = {}): Promise<string[]> {
  const [page] = await engine.executeRaw<{ title: string | null }>(
    'SELECT title FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL', [sourceId, slug]).catch(() => []);
  if (!page) return [slug];
  const siblings = await readIdentitySiblings(engine, sourceId, { slug, title: page.title }, { excludePrivate: opts.excludePrivate ?? true });
  const { slugify } = await import('../entities/resolve.ts');
  const subject = slugify(titleName(page.title ?? ''));
  return [...new Set([slug, ...siblings.pages.map(p => p.slug), ...(subject && subject !== slug ? [subject] : [])])];
}
