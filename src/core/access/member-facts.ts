/**
 * GST-359 C2 (GBRA-218): member facts. A fact a member saves remotely (an attested actor, or a credential bound to a
 * member reading as itself) lives on that member's own page, `memory/members/<member>`, whose frontmatter names the
 * member as its only reader. The fact row is `visibility: private`, so every fact read that admits only world facts
 * hides it from everyone, and the page's readers (git-backed where a repo exists, the database row on a repo-less
 * brain) decide the one caller allowed to read it back: `memberFactAdmitSql` admits a private fact only when it sits
 * on the caller's own member page and that page's readers admit the caller. A fence rebuild re-derives the row from
 * the page it lives on, so it keeps both.
 *
 * Caches and per-session state that a caller's identity changes are keyed by `callerIdentityKey()`, so two people
 * behind one attest credential and one session id never share an entry.
 */
import { createHash } from 'node:crypto';
import type { OperationContext } from '../ops/contract.ts';
import { callerAccessAllowedSql, currentCallerAccess, folderRestrictedSql } from '../search/private-visibility.ts';
import { ACCESS_ID_RE } from './principals.ts';

export const MEMBER_PAGE_PREFIX = 'memory/members/';

export const memberPageSlug = (member: string): string => `${MEMBER_PAGE_PREFIX}${member}`;

/** The member the current caller reads as: the attested actor's, else a lone member identity (never an audience of several). */
export function callerMember(): string | null {
  const access = currentCallerAccess();
  if (access.actor) return access.actor.member;
  if (access.audienceIdentities.length) return null;
  const member = access.identity.find(p => p.startsWith('member:'))?.slice('member:'.length) ?? null;
  return member && ACCESS_ID_RE.test(member) ? member : null;
}

/** The member page a remote memory write goes to, or null when the caller writes as no single member (local or unbound). */
export function memberFactPage(ctx: Pick<OperationContext, 'remote'>): string | null {
  if (ctx.remote === false) return null;
  const member = callerMember();
  return member ? memberPageSlug(member) : null;
}

/** The frontmatter of a member page its first fact creates: the member is its only reader. */
export function memberPageFrontmatter(member: string): string {
  return ['---', 'type: note', `title: Memory of ${member}`, 'readable_by:', `  - member:${member}`, '---', ''].join('\n');
}

/**
 * The private facts the current caller may read: those on its own member page, while that live page's readers (and
 * folder rules) admit the caller. FALSE outside a member caller record. `alias` is a code-provided facts alias; the
 * member id passed ACCESS_ID_RE, whose alphabet has no quote.
 */
export function memberFactAdmitSql(alias: string): string {
  const member = callerMember();
  if (!member) return 'FALSE';
  return `(${alias}.visibility = 'private' AND ${alias}.source_markdown_slug = '${memberPageSlug(member)}' AND EXISTS (
    SELECT 1 FROM pages member_page WHERE member_page.source_id = ${alias}.source_id AND member_page.slug = ${alias}.source_markdown_slug
      AND member_page.deleted_at IS NULL AND member_page.page_readers && ARRAY['member:${member}']::text[]
      AND ${callerAccessAllowedSql('member_page')}))`;
}

/** A remote fact read's visibility list as SQL: the listed values, widened only by memberFactAdmitSql. */
export function factVisibilitySql(alias: string, visibility: readonly string[]): string {
  const known = (['world', 'private'] as const).filter(v => visibility.includes(v));
  const listed = known.length ? `${alias}.visibility IN (${known.map(v => `'${v}'`).join(', ')})` : 'FALSE';
  if (known.includes('private')) return listed;
  const own = memberFactAdmitSql(alias);
  return own === 'FALSE' ? listed : `(${listed} OR ${own})`;
}

/** Facts on any member page, as SQL: writers that dedup, supersede or contest never cross from one member's page to another. */
export function onMemberPageSql(alias: string): string {
  return `starts_with(COALESCE(${alias}.source_markdown_slug, ''), '${MEMBER_PAGE_PREFIX}')`;
}

/**
 * GST-359 D: the withdrawal-ledger subject of a fact, as SQL. A fact on a member page is withdrawn for that page alone
 * (its slug), so forgetting it never reaches another member's copy of the same claim; any other fact keeps its entity
 * ('*' without one).
 */
export function factWithdrawalSubjectSql(alias: string): string {
  return `CASE WHEN ${onMemberPageSql(alias)} THEN ${alias}.source_markdown_slug ELSE COALESCE(${alias}.entity_slug, '*') END`;
}

/** Whether withdrawal row `w` covers fact `f`, as SQL: every subject ('*'), the fact's entity, or the member page it sits on. */
export function withdrawalCoversFactSql(w: string, f: string): string {
  return `(${w}.subject = '*' OR ${w}.subject = COALESCE(${f}.entity_slug, '*') OR (${onMemberPageSql(f)} AND ${w}.subject = ${f}.source_markdown_slug))`;
}

/** The member page a claim is checked on for withdrawals, or null: `slug` when it is one, so a page-scoped withdrawal applies there alone. */
export function memberWithdrawalSubject(slug: string | null | undefined): string | null {
  return slug && slug.startsWith(MEMBER_PAGE_PREFIX) ? slug : null;
}

/**
 * Facts whose source page names readers or sits under a folder rule, as SQL. Derivations that write their output onto
 * another page (consolidation into takes, relinking onto an entity page) skip them: the output would lose the readers.
 */
export function readersSourcedFactSql(alias: string): string {
  return `EXISTS (SELECT 1 FROM pages readers_page WHERE readers_page.source_id = ${alias}.source_id AND readers_page.slug = ${alias}.source_markdown_slug
    AND (readers_page.page_readers IS NOT NULL OR readers_page.frontmatter ? 'readable_by' OR ${folderRestrictedSql('readers_page')}))`;
}

/**
 * A short hash of everything about the current caller that changes what a read returns (the attested actor, the
 * member identity, an audience), or '' outside a member or audience record. Cache and session-state keys append it.
 */
export function callerIdentityKey(): string {
  const access = currentCallerAccess();
  if (!access.actor && !access.identity.length && !access.audienceIdentities.length && !access.audience) return '';
  const parts = { actor: access.actor ? [access.actor.system, access.actor.member] : null, identity: access.identity, audience: access.audienceIdentities, entries: access.audience };
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

/** A per-session state key (the delta cursor, context_pack's session) for the current caller: `base` plus the identity key. */
export function callerSessionKey(base: string | null): string | null {
  const key = callerIdentityKey();
  return key ? `${base ?? 'remote'}#id:${key}` : base;
}

/** Whether a stored write's actor is the current caller's: both unattested, or the same system and member. */
export function sameAttestedActor(stored: unknown): boolean {
  const actor = currentCallerAccess().actor ?? null;
  const row = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as { system?: unknown; member?: unknown } : null;
  if (!actor || !row) return !actor && !row;
  return row.system === actor.system && row.member === actor.member;
}
