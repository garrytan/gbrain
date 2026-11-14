/**
 * #4352 — page-level `visibility: private` enforcement for untrusted callers.
 *
 * Pages have carried `frontmatter.visibility` for a long time (the `remember`
 * verb documents "private: local CLI reads only"), but nothing on the READ
 * side ever enforced it for pages: a remote/MCP caller could retrieve a
 * `visibility: private` page through search, recall's query arm, entity
 * cards, context_pack — and the sibling read ops (get_page/fetch/list_pages,
 * get_chunks/get_versions/get_timeline/get_raw_data, resolve_slugs,
 * get_links/get_backlinks/traverse_graph). This module is the single
 * trust+config resolver:
 *
 *   ctx.remote === false          → see everything (trusted local CLI)
 *   GBRAIN_REMOTE_PRIVATE_PAGES=1 → operator escape hatch, see everything
 *   config search.remote_private_pages ∈ {visible,true,1}
 *                                 → operator opt-out, see everything
 *   otherwise                     → exclude private pages (FAIL-CLOSED default)
 *
 * The SQL predicate itself lives in buildVisibilityClause (sql-ranking.ts)
 * behind SearchOpts.excludePrivate; this resolver decides whether to set it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrainEngine } from '../engine.ts';
import { embeddedKey, embeddedKeyInScope, engineScopeStore, unscopedWithOpenEmbeddedEngines } from '../engine-scope-store.ts';
import { schemaVersionSeen } from '../migrate-pending.ts';
import { requestConfigRows } from '../config-snapshot.ts';
import { isValidSourceId } from '../source-id.ts';
import { asciiLower, asciiLowerSql, edgeTrimSql } from '../edge-whitespace.ts';
import { ACCESS_ID_RE, hasReaders, MEMBER_PAGE_PREFIX, normalizePrincipal, readersAllow, validIdentity } from '../access/principals.ts';
import { ruleCoversSql, validPrefix, validQualifiedRuleId } from '../access/folder-rules.ts';
import { holdingSlugSql } from '../facts-fence.ts';
import { atomMovedOriginPrivateSql, atomOriginSlugsSql } from '../persistence/atom-origin.ts';

export const REMOTE_PRIVATE_PAGES_KEY = 'search.remote_private_pages';

/**
 * GST-2059: the member who owns this brain (`gbrain access owner set <member>`). A remote credential or stdio server
 * bound to that live member reads as the owner: its privacy is relaxed in every source its grant reads (CallerAccess.owner).
 * Written only by the trusted local CLI, like mcp.stdio_member; unset, ill-formed or unreadable names no owner.
 */
export const OWNER_MEMBER_KEY = 'access.owner_member';

/**
 * GST-2490 (G6 of GST-2476): the owner opt-in. Set to '1' only by the trusted local operator (`gbrain access owner
 * reads-restricted on`); with it on, a read by a credential bound to the owner (CallerAccess.ownerReadsRestricted) reads
 * pages a readers list, folder rule or page rule would close to the owner, and their derived pages and facts, except
 * another member's own member page (memory/members/<id>) and anything derived from it. Off or unset changes nothing.
 */
export const OWNER_READS_RESTRICTED_KEY = 'access.owner_reads_restricted';

/**
 * GBRA-108 design 3: listed members read lineage. Set to '1' only by the trusted local operator (`gbrain access
 * members-read-lineage on`, access/lineage.ts); with it on, a read by a credential bound to one member speaking for itself (or for an audience of that
 * one member) passes a derived page or fact when that member reads every origin of it, as an owner read does
 * (CallerAccess.lineage). Never an audience of several, an unbound credential or an attested call. Off or unset
 * changes nothing.
 */
export const MEMBERS_READ_LINEAGE_KEY = 'access.members_read_lineage';

/**
 * #5525 — extracted atoms and synthesized concept pages are derived from
 * other pages or from private transcripts, so a missing `visibility` field on
 * them means "origin unknown", not "world". Pinned-question pages (`type:
 * question`) are owner-private. They fail closed; every other page keeps the
 * documented default (absent visibility is world).
 */
function derivedPageSql(pageAlias: string): string {
  return `(${pageAlias}.type IN ('atom', 'question') OR (${pageAlias}.type = 'concept' AND ${pageAlias}.frontmatter->>'synthesized_by' IS NOT NULL))`;
}

/**
 * Raw SQL predicate hiding `visibility: private` pages (absent visibility
 * defaults to 'world', except on derived atoms and concepts where it defaults
 * to 'private'). Single source of truth for the fragment — consumed by
 * buildVisibilityClause (search paths), both engines' listPages, the
 * relational-arm hydrate, and get_page's fuzzy-candidate filter. `pageAlias`
 * is a code-provided literal, never user input.
 */
export function privatePagesFilterFragment(pageAlias: string, derived = false): string {
  return `(${accessAllowedSql(pageAlias, [], [], derived)} AND ${privacyPartSql(pageAlias)})`;
}

/**
 * The privacy rules alone (visibility, aliases, pinned questions, lineage): what the escape hatches and granted_sources may relax.
 * `shadowedPages`: the statement shadows `pages` with a CTE (a postimage, repair/private-labels.ts), which a SQL
 * function body never reads, so the concept-input test runs inline over the shadow.
 */
export function privacyPartSql(pageAlias: string, shadowedPages = false): string {
  return `(${privateSnapshotFilterFragment(pageAlias)}
    AND NOT ${derivedOriginPrivateSql(pageAlias, shadowedPages)}
    AND NOT ${declaredLineagePrivateSql(pageAlias)})`;
}

/**
 * GBRA-218: the mandatory member-access predicate. A page that names readers
 * in frontmatter `readable_by` passes only for a caller whose identity
 * (`member:<id>` and its `group:<g>` entries) meets them, through the one SQL
 * normalization gbrain_access_readers() (malformed values read as nobody). A
 * page derived from a page that names readers is readable by no remote caller
 * (originAllowedSql). No escape hatch, operator opt-out or granted source
 * relaxes this part; with an empty identity it hides every restricted page.
 * `identity` must pass validIdentity (its alphabet has no quote), so it is
 * embedded as literals; anything else empties it (fail closed).
 */
export function accessAllowedSql(pageAlias: string, identity: readonly string[], satisfied: readonly string[] = satisfiedFor(identity), derived = false): string {
  return accessAllowedForAllSql(pageAlias, [identity], satisfied, derived);
}

/**
 * GBRA-231 (shared agents): accessAllowedSql for an audience. A page passes only when every identity in
 * `identities` meets its readers (one conjunct each; a guest's empty identity meets no readers), and its folder rules
 * are all in `satisfied` (for an audience, the intersection of every entry's satisfied set). `derived` tests a page as
 * the origin of what was derived from it (a fact's provenance page): raw-only rules (covers_derived false) do not count.
 */
export function accessAllowedForAllSql(pageAlias: string, identities: readonly (readonly string[])[], satisfied: readonly string[], derived = false): string {
  if (!currentCallerAccess().restricted) return `(${pageAlias}.page_readers IS NULL AND ${pageAlias}.folder_rule_ids IS NULL)`;
  const readers = (identities.length ? identities : [[]]).map(identity => readersAllowedSql(pageAlias, identity)).join(' AND ');
  return `(${readers} AND ${folderRulesAllowedSql(pageAlias, satisfied, derived)} AND ${originAllowedSql(pageAlias)})`;
}

/**
 * GBRA-218 (PR A2): the folder layer. `folder_rule_ids` holds the source-qualified ids
 * of every applied folder rule whose prefix the slug starts with (a trigger stamps it from the applied rulebook,
 * migration v283); a page passes only when the caller satisfies all of them (`<@`, set semantics), so nested member
 * and group rules both have to pass. `satisfied` is the caller's satisfied set (CallerAccess.satisfiedRuleIds); an
 * entry that is not a valid qualified id empties it (fail closed). Prefixes under a narrowing still being stamped,
 * or touched by a policy file that does not validate, read as nobody (CallerAccess.folderCoverage). Column tests
 * lead, so a page under no rule costs one NULL test. With `derived` (a fact judged by its provenance page), only the
 * rules that cover derived pages count (gbrain_access_lineage_rules, v305): a raw-only rule keeps its pages, not what
 * was derived from them.
 */
export function folderRulesAllowedSql(alias: string, satisfied: readonly string[], derived = false): string {
  const ids = satisfied.length && satisfied.every(validQualifiedRuleId) ? [...new Set(satisfied)].sort() : [];
  const array = ids.length ? `ARRAY[${ids.map(id => `'${id}'`).join(', ')}]::text[]` : 'ARRAY[]::text[]';
  const listed = ids.length ? ` OR ${alias}.folder_rule_ids <@ ${array}` : '';
  const lineage = derived ? ` OR COALESCE(gbrain_access_lineage_rules(${alias}.source_id, ${alias}.folder_rule_ids) <@ ${array}, true)` : '';
  return `(${alias}.folder_rule_ids IS NULL${listed}${lineage})${coverageSql(alias)}`;
}

/**
 * The pending or invalid prefixes of the current record as a conjunct (empty when none); an ill-formed entry hides
 * everything. Outside any caller record the prefixes are read live, so a page under a pending prefix stays hidden;
 * a database role that row-level security keeps from reading them reads every page as covered.
 */
function coverageSql(alias: string): string {
  if (!callerAccessStore.getStore()) return ` AND NOT EXISTS (SELECT 1 FROM access_pending_coverage pc WHERE pc.source_id = ${alias}.source_id AND ${ruleCoversSql(`${alias}.slug`, 'pc.prefix')}) AND NOT (SELECT gbrain_access_state_unreadable())`;
  const coverage = currentCallerAccess().folderCoverage;
  if (!coverage.length) return '';
  return coverage.map(c => !isValidSourceId(c.source_id) || (c.prefix !== '' && !validPrefix(c.prefix)) ? ' AND FALSE'
    : c.prefix === '' ? ` AND ${alias}.source_id <> '${c.source_id}'`
    : ` AND NOT (${alias}.source_id = '${c.source_id}' AND ${ruleCoversSql(`${alias}.slug`, `'${c.prefix}'`)})`).join('');
}

/** The satisfied rule ids for `identity`: the current record's set when it is the record's identity, else none. */
function satisfiedFor(identity: readonly string[]): readonly string[] {
  const access = currentCallerAccess();
  if (!identity.length || identity.length !== access.identity.length) return [];
  const sorted = [...identity].sort();
  return sorted.every((p, i) => p === access.identity[i]) ? access.satisfiedRuleIds : [];
}

/**
 * The readers test alone, without lineage. On a pages row it reads the
 * derived `page_readers` column (a trigger keeps it equal to
 * gbrain_access_readers(frontmatter)); a row that names readers but has no
 * derived value yet (written before the migration, not yet repaired by
 * `gbrain repair access`) reads as nobody. `row: 'snapshot'` evaluates a
 * version snapshot's own frontmatter directly (bounded to one page's versions).
 */
export function readersAllowedSql(alias: string, identity: readonly string[], row: 'page' | 'snapshot' = 'page'): string {
  const ids = identity.length && validIdentity(identity) ? identity : [];
  const readers = row === 'page' ? `${alias}.page_readers` : `gbrain_access_readers(${alias}.frontmatter)`;
  const listed = ids.length ? ` OR ${readers} && ARRAY[${ids.map(id => `'${id}'`).join(', ')}]::text[]` : '';
  const none = row === 'page' ? `(${alias}.page_readers IS NULL AND NOT (${alias}.frontmatter ? 'readable_by'))` : `NOT (${alias}.frontmatter ? 'readable_by')`;
  return `(${none}${listed})`;
}

/** A page names readers (valid or not); SQL twin of hasReaders. */
function namesReadersSql(alias: string): string {
  return `(${alias}.frontmatter ? 'readable_by')`;
}

/**
 * GBRA-218 (plan D4): a derived page whose origin names readers is readable
 * by no remote caller, members included, whatever its own fields say: an atom
 * of such a page, a synthesized concept with such an input (or an input
 * atom's origin), a Life Chronicle event extracted from one, or a page whose
 * declared `derived_from` names one. Read-time, so derivatives written before
 * the origin gained readers are covered; new derivations are stamped private
 * by isDerivationPrivate. The lineage test lives in the SQL function
 * gbrain_access_origin_restricted (migration v282) behind a cheap type and
 * key guard, so a read plans one function call instead of four subplans. Both
 * parts lead with column tests (page_readers IS NULL, type) so the planner's
 * row estimate follows column statistics instead of a default guess.
 */
function originAllowedSql(p: string): string {
  return `((${p}.type NOT IN ('atom', 'question', 'concept', 'event') AND NOT (${p}.frontmatter ? 'derived_from'))
    OR NOT gbrain_access_origin_restricted(${p}.id, ${p}.source_id, ${p}.type, ${p}.frontmatter))`;
}

/**
 * GST-2490 / GBRA-108 design 3: the reader's own member page for a lineage read (CallerAccess.lineage: an owner read,
 * or a listed member's read under access.members_read_lineage), else null.
 */
function lineageReadPage(access: CallerAccess): string | null {
  if (!access.lineage) return null;
  const member = access.identity.find(p => p.startsWith('member:'))?.slice('member:'.length);
  return member && ACCESS_ID_RE.test(member) ? `${MEMBER_PAGE_PREFIX}${member}` : null;
}

/** GST-2490: the owner's own member page for an owner read under the opt-in (access.owner_reads_restricted), else null. */
function ownerOptInPage(access: CallerAccess): string | null {
  return access.ownerReadsRestricted ? lineageReadPage(access) : null;
}

/** GBRA-108 design 2: the member pages of the audience members an owner read treats as naming the owner; none for any other read. */
function audiencePages(access: CallerAccess): string[] {
  return access.owner && access.lineage ? access.audienceKindMembers.filter(id => ACCESS_ID_RE.test(id)).map(id => `${MEMBER_PAGE_PREFIX}${id}`) : [];
}

/** GBRA-108 design 2: `alias` is an audience member's own member page (FALSE when there is none). */
function audiencePageSql(alias: string, pages: readonly string[]): string {
  return pages.length ? `${alias}.slug IN (${pages.map(p => `'${p}'`).join(', ')})` : 'FALSE';
}

/** GST-2490: `alias` is not another member's own member page (the reader's own one, and GBRA-108 an audience member's for the owner, pass). */
function notOtherMemberPageSql(alias: string, ownPage: string, audience: readonly string[] = []): string {
  return `(NOT starts_with(${alias}.slug, '${MEMBER_PAGE_PREFIX}') OR ${alias}.slug = '${ownPage}'${audience.length ? ` OR ${audiencePageSql(alias, audience)}` : ''})`;
}

const textArraySql = (values: readonly string[]): string => values.length ? `ARRAY[${values.map(v => `'${v}'`).join(', ')}]::text[]` : 'ARRAY[]::text[]';

/**
 * GST-2490: originAllowedSql for a lineage read. A derived page passes when the reader reads every origin of it
 * (gbrain_access_origin_hidden_for with the reader's identity and satisfied rules, v304/v305), so a page whose readers or
 * rule name the reader keeps its derivatives for it; under the owner opt-in every origin passes except another member's
 * own member page and pending coverage. GBRA-108: an owner read passes audience members' pages as origins naming the
 * owner. The identity, rule ids and member ids are validated on the record, so they embed as literals.
 */
function lineageOriginAllowedSql(p: string, access: CallerAccess, ownPage: string): string {
  const identity = validIdentity(access.identity) ? access.identity : [];
  const satisfied = access.satisfiedRuleIds.every(validQualifiedRuleId) ? access.satisfiedRuleIds : [];
  return `((${p}.type NOT IN ('atom', 'question', 'concept', 'event') AND NOT (${p}.frontmatter ? 'derived_from'))
    OR NOT gbrain_access_origin_hidden_for(${p}.id, ${p}.source_id, ${p}.type, ${p}.frontmatter, ${textArraySql(identity)}, ${textArraySql(satisfied)}, ${access.ownerReadsRestricted}, '${ownPage}', ${textArraySql(audiencePages(access))}))`;
}

/**
 * GST-2490: the member-access part for a lineage read: the reader's readers and folder rules as for any member, with
 * its lineage (lineageOriginAllowedSql) instead of the every-caller one. Under the owner opt-in, a page that is not
 * another member's own member page passes too, outside a prefix that reads as nobody. GBRA-108 design 2: for an owner
 * read an audience member's own member page reads as if its readers named the owner. `derived` judges the page as an
 * origin (a fact's provenance page; raw-only rules do not count).
 */
function lineageAccessSql(pageAlias: string, access: CallerAccess, ownPage: string, derived = false): string {
  const audience = audiencePages(access);
  const notOther = notOtherMemberPageSql(pageAlias, ownPage, audience);
  if (!access.restricted) {
    const unrestricted = `(${pageAlias}.page_readers IS NULL AND ${pageAlias}.folder_rule_ids IS NULL)`;
    return access.ownerReadsRestricted ? `(${unrestricted} OR ${notOther})` : unrestricted;
  }
  const readers = audience.length ? `(${readersAllowedSql(pageAlias, access.identity)} OR ${audiencePageSql(pageAlias, audience)})` : readersAllowedSql(pageAlias, access.identity);
  const listed = `(${readers} AND ${folderRulesAllowedSql(pageAlias, access.satisfiedRuleIds, derived)})`;
  const page = access.ownerReadsRestricted ? `(${listed} OR (${notOther}${coverageSql(pageAlias)}))` : listed;
  return `(${page} AND ${lineageOriginAllowedSql(pageAlias, access, ownPage)})`;
}

/**
 * GST-2346: GST-2490's owner read rule (lineageAccessSql, the opt-in off) and the privacy part, for the owner's explicit
 * identity and satisfied folder rules outside its read record, so a stored write can judge what its owner writer reads.
 * access.owner_reads_restricted and audience members never apply here: a page kept to other members stays closed.
 */
export function ownerReadPolicyFragment(pageAlias: string, identity: readonly string[], satisfied: readonly string[]): string {
  const access: CallerAccess = { ...currentCallerAccess(), identity, satisfiedRuleIds: satisfied, lineage: true, ownerReadsRestricted: false, audienceKindMembers: [], restricted: true };
  const ownPage = lineageReadPage(access);
  return ownPage ? `(${lineageAccessSql(pageAlias, access, ownPage)} AND ${privacyPartSql(pageAlias)})` : 'FALSE';
}

/**
 * `privatePagesFilterFragment` with a cheap first test: a page with no
 * `visibility` or `derived_from` key (nor, unless the operator turned
 * `visibility.honor_aliases` off, a privacy-alias key, nor `readable_by` or `pinned_question`) whose type is not atom, concept,
 * event or question is visible by every rule
 * above, so only the remaining pages run the full check. For scans over thousands of
 * candidate pages (an entity's referrers).
 */
export function privatePagesFilterFragmentFast(pageAlias: string): string {
  return `(${folderRulesAllowedSql(pageAlias, [])} AND ((${pageAlias}.frontmatter->'visibility' IS NULL AND ${pageAlias}.frontmatter->'derived_from' IS NULL${honorAliases()
      ? `\n      AND ${pageAlias}.frontmatter->'access' IS NULL AND ${pageAlias}.frontmatter->'confidentiality' IS NULL` : ''}
      AND ${pageAlias}.frontmatter->'readable_by' IS NULL AND ${pageAlias}.frontmatter->'pinned_question' IS NULL
      AND ${pageAlias}.type NOT IN ('atom', 'concept', 'event', 'question'))
    OR ${privatePagesFilterFragment(pageAlias)}))`;
}

/**
 * The current caller's access record. MCP dispatch sets it around every remote
 * operation (src/mcp/dispatch.ts), and a local `--as <member>` read sets it
 * with applyRemoteReadPolicy. Fields:
 *  - identity: GBRA-218, the caller's member and group principals (empty when
 *    the credential is bound to no member);
 *  - privateReadableSources: GBRA-156, the sources whose private pages the read
 *    may see, from its grant's `private_pages: granted_sources` axis (never the
 *    no-grant floor, federation, an OAuth client's bound source or a request's
 *    `source_ids`); empty for writes;
 *  - hidePrivate: false only when an operator relaxed privacy for remote reads
 *    (GBRAIN_REMOTE_PRIVATE_PAGES=1 or search.remote_private_pages=visible),
 *    or the caller is the brain owner (owner);
 *  - owner: GST-2059, the caller's credential (or stdio server) is bound to the
 *    live member config access.owner_member names, and it asserts no audience
 *    other than that member; never an attested actor. The owner sees
 *    visibility: private pages, privacy aliases, derived and pinned-question
 *    pages and private facts in every source its grant reads; member access
 *    (readable_by, folder rules) stays mandatory;
 *  - restricted: false only inside a remote request on a brain whose config
 *    access.restrictions_present was unset when the request began. Then no
 *    page named readers at that moment and none predates the migration (v282
 *    sets the flag when one does), so every readers value is in the derived
 *    column: accessAllowedSql tests only page_readers IS NULL and
 *    folder_rule_ids IS NULL (live, so a page gaining readers or a folder rule
 *    mid-request is still hidden, since the triggers fill both columns in that
 *    write) and skips lineage, member matching and the frontmatter test, whose
 *    per-row JSONB read cost keyword search about 3%. The flag is sticky and set
 *    in the same transaction as the first page that names readers, the first
 *    member and the first folder rule or pending folder prefix (v283).
 * Outside any record (local CLI, jobs, cycles) the identity is empty, no
 * source is private-readable and hidePrivate follows the process's hatch
 * state, so caller-aware fragments still fail closed on restricted pages.
 */
export interface CallerAccess {
  identity: readonly string[];
  /**
   * GBRA-231 (shared agents): the normalized audience a request asserted (member:<id>, group:<g>, guest), or null.
   * Reported in _meta.access and whoami, carried by queued writes and agent jobs. With one entry, `identity` is that
   * entry's identity; with more, `identity` is empty (a site that reads it alone over-hides) and
   * `audienceIdentities` holds one identity per entry, every one of which must meet a page's readers.
   */
  audience: readonly string[] | null;
  audienceIdentities: readonly (readonly string[])[];
  /**
   * GST-359 C1: the attested actor (a trusted system named the person; access/actor.ts), or null. Its audience is that
   * one member and its privacy is never relaxed. Queued writes and agent jobs carry it and re-resolve it live.
   */
  actor?: Readonly<{ system: string; external_id: string; member: string }> | null;
  /** GBRA-218 (A2): the source-qualified folder-rule ids (`<source>:<rule>`) the identity satisfies, from the applied rulebook. */
  satisfiedRuleIds: readonly string[];
  /** GBRA-218 (A2): prefixes that read as nobody (a narrowing being stamped, an invalid policy file); prefix '' is the whole source. */
  folderCoverage: readonly FolderCoverage[];
  privateReadableSources: readonly string[];
  hidePrivate: boolean;
  owner: boolean;
  /**
   * GST-2490 / GBRA-108 design 3: a lineage read, one member speaking for itself in a non-mutating operation: the owner
   * always, any other member only under access.members_read_lineage. Derived pages and facts pass when that member reads
   * every origin (lineageOriginAllowedSql) instead of being hidden from every remote caller. Never an audience of
   * several, an unbound credential or an attested call.
   */
  lineage: boolean;
  /**
   * GST-2490: an owner read (owner and lineage) on a brain whose operator turned on access.owner_reads_restricted:
   * readers lists, folder rules and page rules stop closing pages, their derivatives and their facts to the owner,
   * except another member's own member page and what derives from it (lineageAccessSql).
   */
  ownerReadsRestricted: boolean;
  /**
   * GBRA-108 design 2: the enabled members of kind audience (a group chat, a shared assistant), kept only on an owner
   * read (owner and lineage): the owner reads each one's own member page, its older versions, its derived pages and its
   * facts as if its readers named the owner. Ids pass ACCESS_ID_RE, so they embed as literals; empty otherwise.
   */
  audienceKindMembers: readonly string[];
  /**
   * GBRA-108 design 1 (labelled-only grant): the caller's member carries access_members.labelled_only (the labelled-only migration), so every
   * credential bound to it reads only pages that name it: its member id or one of its groups in readable_by, or a folder
   * or page rule that lists it (labelledOnlySql). An unlabelled page its source grant would otherwise open is hidden; a
   * derived page or fact with no readers and no rule of its own is hidden too, except under access.members_read_lineage
   * where every origin is labelled for the caller (gbrain_access_origin_labelled_for). Never on the owner.
   */
  labelledOnly: boolean;
  applyRemoteReadPolicy: boolean;
  restricted: boolean;
  /** The fresh remote policy (readRemotePolicyNow) a remote request read when it started; null outside one. */
  remotePolicy: RemotePolicy | null;
}
export interface FolderCoverage { source_id: string; prefix: string }
const callerAccessStore = new AsyncLocalStorage<CallerAccess>();

/** The current read's caller-access record (see CallerAccess). */
export function currentCallerAccess(): CallerAccess {
  return callerAccessStore.getStore() ?? { identity: [], audience: null, audienceIdentities: [], actor: null, satisfiedRuleIds: [], folderCoverage: [], privateReadableSources: [], hidePrivate: !processPrivacyRelaxed(), owner: false, lineage: false, ownerReadsRestricted: false, audienceKindMembers: [], labelledOnly: false, applyRemoteReadPolicy: false, restricted: true, remotePolicy: null };
}

/** Runs `fn` under `access` merged over the current record; an invalid identity or source id empties that set (fail closed). */
export function withCallerAccess<T>(access: Partial<CallerAccess>, fn: () => T): T {
  const base = currentCallerAccess();
  const identity = access.identity ?? base.identity;
  const sources = access.privateReadableSources ?? base.privateReadableSources;
  const validIds = identity.length > 0 && validIdentity(identity);
  const fresh = access.identity !== undefined || access.audienceIdentities !== undefined;
  const audienceIdentities = (access.audienceIdentities ?? (fresh ? [] : base.audienceIdentities))
    .map(id => id.length && validIdentity(id) ? Object.freeze([...new Set(id)].sort()) : Object.freeze([] as string[]));
  const audience = access.audience !== undefined ? access.audience : fresh ? null : base.audience;
  const actor = access.actor !== undefined ? access.actor : fresh ? null : base.actor ?? null;
  const satisfiedOk = validIds || audienceIdentities.some(id => id.length > 0);
  const satisfied = satisfiedOk ? access.satisfiedRuleIds ?? (fresh ? [] : base.satisfiedRuleIds) : [];
  return callerAccessStore.run(Object.freeze({
    identity: validIds && audienceIdentities.length <= 1 ? Object.freeze([...new Set(identity)].sort()) : Object.freeze([]),
    audience: audience && audience.every(validAudienceEntry) ? Object.freeze([...audience]) : audience ? Object.freeze([GUEST_ENTRY]) : null,
    audienceIdentities: Object.freeze(audienceIdentities.length > 1 ? audienceIdentities : []),
    actor: actor ? Object.freeze({ system: actor.system, external_id: actor.external_id, member: actor.member }) : null,
    satisfiedRuleIds: satisfied.length && satisfied.every(validQualifiedRuleId) ? Object.freeze([...new Set(satisfied)].sort()) : Object.freeze([]),
    folderCoverage: Object.freeze([...(access.folderCoverage ?? base.folderCoverage)].map(c => Object.freeze({ source_id: c.source_id, prefix: c.prefix }))),
    privateReadableSources: sources.length && sources.every(isValidSourceId) ? Object.freeze([...new Set(sources)]) : Object.freeze([]),
    hidePrivate: access.hidePrivate ?? (fresh ? true : base.hidePrivate),
    owner: access.owner ?? (fresh ? false : base.owner),
    ...lineageReads(access.owner ?? (fresh ? false : base.owner), audienceIdentities.length <= 1,
      access.lineage ?? (fresh ? false : base.lineage), access.ownerReadsRestricted ?? (fresh ? false : base.ownerReadsRestricted),
      access.audienceKindMembers ?? (fresh ? [] : base.audienceKindMembers)),
    labelledOnly: access.labelledOnly ?? (fresh ? false : base.labelledOnly),
    applyRemoteReadPolicy: access.applyRemoteReadPolicy ?? base.applyRemoteReadPolicy,
    restricted: access.restricted ?? base.restricted,
    remotePolicy: access.remotePolicy ?? base.remotePolicy,
  }), fn);
}

/**
 * GST-2490 / GBRA-108: the lineage flags of a record. Lineage needs one identity (never an audience of several); the owner
 * opt-in and the audience members need an owner read.
 */
function lineageReads(owner: boolean, single: boolean, lineage: boolean, readsRestricted: boolean, audienceKind: readonly string[]): Pick<CallerAccess, 'lineage' | 'ownerReadsRestricted' | 'audienceKindMembers'> {
  const read = single && lineage;
  const ownerRead = owner && read;
  return { lineage: read, ownerReadsRestricted: ownerRead && readsRestricted,
    audienceKindMembers: Object.freeze(ownerRead && audienceKind.every(id => ACCESS_ID_RE.test(id)) ? [...new Set(audienceKind)].sort() : []) };
}

/** Runs `fn` outside any caller's record, for work a request spawns that must not inherit its view. */
export function withoutCallerAccess<T>(fn: () => T): T {
  return callerAccessStore.exit(fn);
}

/** Runs `fn` with `sourceIds` as the private-readable set; an invalid id empties the whole set (fail closed). */
export function withPrivateReadableSources<T>(sourceIds: readonly string[] | undefined, fn: () => T): T {
  return withCallerAccess({ privateReadableSources: sourceIds ?? [] }, fn);
}

/** The private-readable set of the current read; empty outside a granted remote read. */
export function privateReadableSources(): readonly string[] {
  return currentCallerAccess().privateReadableSources;
}

/** GST-2059: is the current caller the brain owner (CallerAccess.owner)? False outside a remote record or a local --as of the owner. */
export function callerIsOwner(): boolean {
  return currentCallerAccess().owner;
}

/**
 * GST-2089: whether a fact read stays world-only (visibility = 'world'). Only the trusted local CLI (remote strictly
 * false) and the brain owner (CallerAccess.owner, the page rule) read private facts; provenance, source grants and
 * member access still apply to both. Fact arms decide their visibility list here and nowhere else.
 */
export function worldOnlyFacts(remote: boolean | undefined): boolean {
  return remote !== false && !callerIsOwner();
}

/** The current caller's member identity; empty outside a bound remote read or a local --as, and for an audience of several entries (see callerIdentities). */
export function callerIdentity(): readonly string[] {
  return currentCallerAccess().identity;
}

/** GBRA-231: every identity a page's readers must meet for the current caller: one per audience entry, else the caller's own. */
export function callerIdentities(): readonly (readonly string[])[] {
  const access = currentCallerAccess();
  return access.audienceIdentities.length ? access.audienceIdentities : [access.identity];
}

/** GBRA-231: readersAllow for the current caller (every audience entry must be a reader). */
export function callerReadersAllow(frontmatter: unknown, slug?: string): boolean {
  const access = currentCallerAccess();
  const ownPage = ownerOptInPage(access);
  if (typeof slug === 'string' && audiencePages(access).includes(slug)) return true;
  if (ownPage && typeof slug === 'string' && (!slug.startsWith(MEMBER_PAGE_PREFIX) || slug === ownPage)) return true;
  return callerIdentities().every(identity => readersAllow(frontmatter, identity));
}

/** GBRA-231: readersAllowedSql for the current caller, one conjunct per audience entry. */
export function callerReadersAllowedSql(alias: string, row: 'page' | 'snapshot' = 'page'): string {
  const access = currentCallerAccess();
  const ownPage = ownerOptInPage(access);
  const audience = audiencePages(access);
  const onPage = (test: (pageAlias: string) => string) => row === 'snapshot' ? `EXISTS (SELECT 1 FROM pages sp WHERE sp.id = ${alias}.page_id AND ${test('sp')})` : test(alias);
  const readers = ownPage ? `(${readersAllowedSql(alias, access.identity, row)} OR ${onPage(a => notOtherMemberPageSql(a, ownPage, audience))})`
    : audience.length ? `(${readersAllowedSql(alias, access.identity, row)} OR ${onPage(a => audiencePageSql(a, audience))})`
    : callerIdentities().map(identity => readersAllowedSql(alias, identity, row)).join(' AND ');
  if (!access.labelledOnly) return readers;
  if (row === 'page') return `(${readers} AND ${labelledOnlySql(alias, access)})`;
  return `(${readers} AND (COALESCE(gbrain_access_readers(${alias}.frontmatter) && ${textArraySql(labelledIdentity(access))}, false)
    OR EXISTS (SELECT 1 FROM pages sp WHERE sp.id = ${alias}.page_id AND ${labelledOnlySql('sp', access, false)})))`;
}

type LabelledRecord = Pick<CallerAccess, 'identity' | 'audienceIdentities' | 'satisfiedRuleIds' | 'lineage' | 'owner'>;

/** GBRA-108 design 1: every principal a labelled-only read may be named by (the identity, or each audience entry's). */
function labelledIdentity(access: LabelledRecord): string[] {
  const identity = [...new Set([...access.identity, ...access.audienceIdentities.flat()])].sort();
  return identity.length && validIdentity(identity) ? identity : [];
}

/**
 * GBRA-108 design 1: `alias` names a labelled-only caller (CallerAccess.labelledOnly): its readable_by holds the caller's
 * member or one of its groups, or one of its folder or page rules lists them (a rule the caller satisfies). Under
 * access.members_read_lineage (a member read with lineage) a derived page with no label of its own passes only when it
 * has an origin and every origin names the caller (gbrain_access_origin_labelled_for, the labelled-only migration); with it off a derived page
 * that names nobody is hidden, whatever its origins say. ANDed with the caller's ordinary access, so it only narrows.
 * `readers` false tests only the rules (a version snapshot carries its own readers). Ids embed as validated literals.
 */
function labelledOnlySql(alias: string, access: LabelledRecord, readers = true): string {
  const identity = textArraySql(labelledIdentity(access));
  const satisfied = textArraySql(access.satisfiedRuleIds.every(validQualifiedRuleId) ? access.satisfiedRuleIds : []);
  const named = `(${readers ? `COALESCE(${alias}.page_readers && ${identity}, false) OR ` : ''}COALESCE(${alias}.folder_rule_ids && ${satisfied}, false))`;
  if (!access.lineage || access.owner) return named;
  return `(${named} OR ((${alias}.type IN ('atom', 'question', 'concept', 'event') OR ${alias}.frontmatter ? 'derived_from')
    AND gbrain_access_origin_labelled_for(${alias}.id, ${alias}.source_id, ${alias}.type, ${alias}.frontmatter, ${identity}, ${satisfied})))`;
}

/**
 * GBRA-108 design 1: the fact conjunct of a labelled-only read. A fact has no readers or rule of its own, so it is hidden,
 * except on the caller's own member page while that page names the member (the member's own memory), and under
 * access.members_read_lineage when its provenance page exists and names the caller (labelledOnlySql). Empty for every
 * other caller.
 */
function labelledOnlyFactSql(factAlias: string): string {
  const access = currentCallerAccess();
  if (!access.labelledOnly) return '';
  const lone = access.audienceIdentities.length ? null : access.identity.find(p => p.startsWith('member:'))?.slice('member:'.length) ?? null;
  const member = access.actor?.member ?? lone;
  const own = member && ACCESS_ID_RE.test(member) ? `EXISTS (SELECT 1 FROM pages lp WHERE lp.source_id = ${factAlias}.source_id AND lp.slug = ${factAlias}.source_markdown_slug
    AND lp.slug = '${MEMBER_PAGE_PREFIX}${member}' AND COALESCE(lp.page_readers && ARRAY['member:${member}']::text[], false))` : 'FALSE';
  if (!access.lineage || access.owner) return ` AND ${own}`;
  return ` AND (${own} OR EXISTS (SELECT 1 FROM pages lp WHERE lp.source_id = ${factAlias}.source_id AND lp.slug = ${factAlias}.source_markdown_slug AND ${labelledOnlySql('lp', access)}))`;
}

/**
 * GBRA-108 design 1: the floor of a remote read gate that is not caller-aware. For any caller that is not labelled-only
 * it is exactly privatePagesFilterFragment; a labelled-only caller also gets its labelled-only conjunct, so a page that
 * does not name it never answers. Write-side, maintenance and derived-visibility decisions keep the plain fragment; test/remote-read-floor.test.ts pins which call sites do.
 */
export function remoteReadFloorSql(pageAlias: string, derived = false): string {
  const plain = privatePagesFilterFragment(pageAlias, derived);
  const access = currentCallerAccess();
  return access.labelledOnly ? `(${plain} AND ${labelledOnlySql(pageAlias, access)})` : plain;
}

/** remoteReadFloorSql for a fact lookup: privateProvenanceFilterFragment, plus the labelled-only fact conjunct for a labelled-only caller. */
export function remoteProvenanceFloorSql(factAlias: string): string {
  const plain = privateProvenanceFilterFragment(factAlias);
  const labelled = labelledOnlyFactSql(factAlias);
  return labelled ? `(${plain}${labelled})` : plain;
}

const GUEST_ENTRY = 'guest';
function validAudienceEntry(entry: string): boolean {
  return entry === GUEST_ENTRY || normalizePrincipal(entry) === entry;
}

function callerAccessSql(pageAlias: string): string {
  const access = currentCallerAccess();
  const ownPage = lineageReadPage(access);
  const allowed = ownPage ? lineageAccessSql(pageAlias, access, ownPage)
    : access.audienceIdentities.length ? accessAllowedForAllSql(pageAlias, access.audienceIdentities, access.satisfiedRuleIds)
    : accessAllowedSql(pageAlias, access.identity);
  return access.labelledOnly ? `(${allowed} AND ${labelledOnlySql(pageAlias, access)})` : allowed;
}

/**
 * GBRA-108 design 1: the labelled-only conjunct for a page row checked outside the caller's read (a stored write's writer,
 * the enforced member CLI): the page names one of `identities` or sits under a rule in `satisfied` (`readers` false: the
 * rule alone, for a slug with no row yet). No lineage: a write never reads through it.
 */
export function labelledOnlyForSql(pageAlias: string, identities: readonly (readonly string[])[], satisfied: readonly string[], readers = true): string {
  return labelledOnlySql(pageAlias, { identity: [], audienceIdentities: identities, satisfiedRuleIds: satisfied, lineage: false, owner: false }, readers);
}

/**
 * `visiblePredicate` (a privacy-only predicate), widened to pages
 * (`pageAlias`, a code-provided alias) whose source is in the current
 * private-readable set. A page carrying the `pinned_question` marker never
 * widens: pinned questions stay owner-private (src/core/questions/pages.ts).
 * Never pass a predicate that contains accessAllowedSql: the widening would
 * reach it. The ids are embedded as literals: each passed
 * isValidSourceId, whose alphabet has no quote or backslash.
 */
export function orPrivateReadableSource(pageAlias: string, visiblePredicate: string): string {
  const ids = privateReadableSources();
  if (ids.length === 0) return visiblePredicate;
  return `((${pageAlias}.source_id IN (${ids.map(id => `'${id}'`).join(', ')}) AND NOT COALESCE(${pageAlias}.frontmatter ? 'pinned_question', false)) OR ${visiblePredicate})`;
}

/**
 * A privacy-only predicate for the current caller: TRUE when an operator
 * relaxed privacy, else widened only to private-readable sources. Never pass
 * a predicate that contains accessAllowedSql or readersAllowedSql.
 */
export function privacyForCaller(pageAlias: string, privacyPredicate: string): string {
  return currentCallerAccess().hidePrivate ? orPrivateReadableSource(pageAlias, privacyPredicate) : 'TRUE';
}

function callerPrivacySql(pageAlias: string, privacyPredicate: string): string {
  return privacyForCaller(pageAlias, privacyPredicate);
}

/** privatePagesFilterFragment for a remote read: the caller's member access, then the privacy part with its grant and hatch. Read sites only; derived-visibility decisions keep the plain fragment. */
export function privatePagesFilterForCaller(pageAlias: string): string {
  return `(${callerAccessSql(pageAlias)} AND ${callerPrivacySql(pageAlias, privacyPartSql(pageAlias))})`;
}

/** The mandatory member-access part alone (readers and lineage) for the current caller; privacy is not tested. */
export function callerAccessAllowedSql(pageAlias: string): string {
  return callerAccessSql(pageAlias);
}

/**
 * The read policy for an explicit identity, outside any caller record (a
 * write's publication re-resolves its writer's identity): the member-access
 * part, then the privacy part unless `hidePrivate` is false. With an empty
 * identity and `hidePrivate` it equals privatePagesFilterFragment.
 */
export function readPolicyFragment(pageAlias: string, identity: readonly string[] | { all: readonly (readonly string[])[] }, hidePrivate: boolean, satisfied?: readonly string[], derived = false): string {
  const access = 'all' in identity ? accessAllowedForAllSql(pageAlias, identity.all, satisfied ?? [], derived) : accessAllowedSql(pageAlias, identity, satisfied ?? satisfiedFor(identity), derived);
  return `(${access} AND ${hidePrivate ? privacyPartSql(pageAlias) : 'TRUE'})`;
}

/** privatePagesFilterFragmentFast for a remote read. */
export function privatePagesFilterFastForCaller(pageAlias: string): string {
  return `(${callerAccessSql(pageAlias)} AND ${callerPrivacySql(pageAlias, privacyPartFastSql(pageAlias))})`;
}

/** The fast form of privacyPartSql (see privatePagesFilterFragmentFast). */
function privacyPartFastSql(pageAlias: string): string {
  return `((${pageAlias}.frontmatter->'visibility' IS NULL AND ${pageAlias}.frontmatter->'derived_from' IS NULL${honorAliases()
      ? `\n      AND ${pageAlias}.frontmatter->'access' IS NULL AND ${pageAlias}.frontmatter->'confidentiality' IS NULL` : ''}
      AND ${pageAlias}.frontmatter->'pinned_question' IS NULL
      AND ${pageAlias}.type NOT IN ('atom', 'concept', 'event', 'question'))
    OR ${privacyPartSql(pageAlias)})`;
}

/**
 * isPrivatePage for a remote read: true when the page names readers the
 * caller does not meet; otherwise the privacy rule, false for a page whose
 * `source_id` is private-readable or when an operator relaxed privacy. A row
 * without `source_id` keeps the plain privacy rule.
 */
export function isPrivatePageForCaller(page: { type?: string | null; frontmatter?: unknown; source_id?: string | null; slug?: string | null }): boolean {
  const access = currentCallerAccess();
  if (!callerReadersAllow(page.frontmatter, page.slug ?? undefined)) return true;
  if (!access.hidePrivate || !isPrivacyPrivatePage(page)) return false;
  if (typeof page.frontmatter === 'object' && page.frontmatter !== null && (page.frontmatter as Record<string, unknown>).pinned_question != null) return true;
  return !(typeof page.source_id === 'string' && access.privateReadableSources.includes(page.source_id));
}

/**
 * Declared lineage: a page whose frontmatter `derived_from` names a page (one
 * slug or a list, `.md` optional) that is explicitly `visibility: private` in
 * the same source is private too, whatever its own field says. Summaries,
 * digests and reports written from finance-only or other private material
 * therefore stay behind the same boundary as their inputs. Only an explicitly
 * private input propagates; a missing input does not hide the page.
 */
function declaredLineagePrivateSql(p: string): string {
  return `(CASE WHEN jsonb_typeof(${p}.frontmatter->'derived_from') IN ('array', 'string') THEN EXISTS (
    SELECT 1 FROM pages declared_origin
    WHERE declared_origin.source_id = ${p}.source_id
      AND declared_origin.frontmatter->>'visibility' = 'private'
      AND declared_origin.slug = ANY(ARRAY(
        SELECT regexp_replace(declared.slug, '\\.md$', '') FROM jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(${p}.frontmatter->'derived_from') = 'array' THEN ${p}.frontmatter->'derived_from'
            ELSE jsonb_build_array(${p}.frontmatter->'derived_from') END) AS declared(slug)))) ELSE false END)`;
}

/**
 * The same rule on a row's own `type`/`frontmatter` only, for snapshots such
 * as `page_versions` that have no page identity to follow to an origin. Callers
 * pair it with privatePagesFilterFragment on the live page. A page carrying the
 * `pinned_question` marker is private whatever its `visibility` says (pinned
 * questions are owner-private, src/core/questions/pages.ts). A page with no
 * `visibility` but a privacy alias is private too, unless the operator turned
 * `visibility.honor_aliases` off; the row-side isPrivatePage applies the same rule.
 */
export function privateSnapshotFilterFragment(alias: string): string {
  return `(COALESCE(${alias}.frontmatter->>'visibility', CASE WHEN ${derivedPageSql(alias)} THEN 'private' ELSE 'world' END) <> 'private'
    AND NOT COALESCE(${alias}.frontmatter ? 'pinned_question', false)${honorAliases()
      ? `\n    AND NOT (${alias}.frontmatter->>'visibility' IS NULL AND ${privacyAliasSql(alias)})` : ''})`;
}

/**
 * #5525 — a later private flip of an origin page reaches its derived pages
 * before any repair runs: an atom whose origin page is explicitly private, and
 * a synthesized concept with a private input atom (or an input atom whose
 * origin is private), are private whatever their own field says.
 * `gbrain repair visibility` then stamps the stricter value on the rows.
 * An atom whose origin a sync rename moved (#7462) is private when the page at
 * its `source_slug` or the page the rename moved it to is private, including a
 * move whose alias a later rename onto the old slug dropped (#8920). A concept's
 * inputs are judged the same way, moved origins included (GST-2687), by the SQL
 * function gbrain_concept_inputs_private (migration v311), one planned call per
 * page instead of the subplans, when the read's schema version is at or above v311: the one its remote, scope or
 * attested caller record carries, or, with no remote policy, the one the engine in scope recorded at connect or
 * migration (schemaVersionSeen). Over a shadowed `pages` (privacyPartSql), outside an engine scope, and on a brain
 * whose schema predates v311 or whose version was not read, the same test runs inline, as gbrain_access_origin_restricted is
 * skipped inside a request on a brain that never set access.restrictions_present.
 */
/** The schema version (migration v311) that creates gbrain_concept_inputs_private; a literal so the CLI dispatcher never loads a migration module. */
export const CONCEPT_INPUTS_PRIVATE_SINCE = 311;

function derivedOriginPrivateSql(p: string, shadowedPages: boolean): string {
  const privateOrigin = (atom: string, alias: string) => `EXISTS (SELECT 1 FROM pages ${alias} WHERE ${alias}.source_id = ${atom}.source_id
      AND ${alias}.slug = ANY(${atomOriginSlugsSql(atom)}) AND ${alias}.frontmatter->>'visibility' = 'private')`;
  const { remotePolicy } = currentCallerAccess();
  const scoped = engineScopeStore.getStore();
  const schema = remotePolicy ? remotePolicy.schemaVersion : scoped ? schemaVersionSeen(scoped) : undefined;
  const conceptInputsPrivate = !shadowedPages && schema !== undefined && schema >= CONCEPT_INPUTS_PRIVATE_SINCE ? `gbrain_concept_inputs_private((${p}.id)::integer)`
    : `EXISTS (SELECT 1 FROM links derived_input_link
      JOIN pages derived_input ON derived_input.id = derived_input_link.to_page_id
      WHERE derived_input_link.from_page_id = ${p}.id AND derived_input_link.link_source = 'concept-provenance'
        AND derived_input_link.link_type = 'synthesized_from'
        AND (COALESCE(derived_input.frontmatter->>'visibility', CASE WHEN derived_input.type = 'atom' THEN 'private' ELSE 'world' END) = 'private'
          OR ${privateOrigin('derived_input', 'derived_input_origin')} OR ${atomMovedOriginPrivateSql('derived_input')}))`;
  return `(CASE WHEN ${p}.type = 'atom' THEN (${privateOrigin(p, 'derived_origin')} OR ${atomMovedOriginPrivateSql(p)})
    WHEN ${derivedPageSql(p)} THEN ${conceptInputsPrivate}
    WHEN ${p}.type = 'event' AND ${p}.frontmatter->>'captured_via' LIKE 'life-chronicle:%' THEN ${chronicleOriginNotVisibleSql(p)}
    ELSE false END)`;
}

/**
 * #5876 (C4a/E7) — a Life Chronicle event is private whenever the meeting,
 * conversation or calendar page it was extracted from (`event.depth`, same
 * source) is private by its own field or its declared lineage, and fails
 * closed when that origin is missing (renamed or purged). Covers events
 * written before the rule existed, at read time.
 */
function chronicleOriginNotVisibleSql(p: string): string {
  return `NOT EXISTS (SELECT 1 FROM pages chronicle_origin WHERE chronicle_origin.source_id = ${p}.source_id
      AND chronicle_origin.slug = ${p}.frontmatter->'event'->>'depth'
      AND ${privateSnapshotFilterFragment('chronicle_origin')}
      AND NOT ${declaredLineagePrivateSql('chronicle_origin')})`;
}

export type Visibility = 'private' | 'world';

/**
 * Privacy aliases: keys a page may carry instead of `visibility` (the
 * bulk-ingestion template's `access`, a `confidentiality` field), with the
 * values that mean private. Matching is ASCII case-insensitive on the value trimmed of
 * edge whitespace, the same on the TypeScript and SQL sides.
 * Everything derived from an aliased page (facts, chronicle events, timeline
 * rows, remember saves into it) is private. Remote page reads honor the aliases
 * too unless the operator sets `visibility.honor_aliases false`.
 */
export const PRIVACY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  access: ['private', 'restricted', 'confidential'],
  confidentiality: ['confidential', 'secret', 'private', 'restricted'],
};
export const HONOR_ALIASES_KEY = 'visibility.honor_aliases';

function hasPrivacyAlias(frontmatter: Record<string, unknown>): boolean {
  return Object.entries(PRIVACY_ALIASES).some(([key, values]) => {
    const value = frontmatter[key];
    return typeof value === 'string' && values.includes(asciiLower(value.trim()));
  });
}

/** SQL twin of hasPrivacyAlias on a page alias (a code-provided literal). */
export function privacyAliasSql(alias: string): string {
  return `(${Object.entries(PRIVACY_ALIASES).map(([key, values]) =>
    `COALESCE(${asciiLowerSql(edgeTrimSql(`${alias}.frontmatter->>'${key}'`))} IN (${values.map(v => `'${v}'`).join(',')}), false)`).join(' OR ')})`;
}

/**
 * `visibility.honor_aliases` per brain in this process, as last read by
 * resolveExcludePrivatePages (the resolver every remote read runs before it builds
 * SQL). The fragments are synchronous, so the setting is process-wide and leans
 * private: the aliases are honored unless a brain turned them off and no brain in
 * the process keeps them on. Unset means on.
 */
const honorAliasEngines = new Set<BrainEngine>();
const aliasOptOutEngines = new Set<BrainEngine>();
/**
 * An engine opened from settings keeps its own policy here instead (keyed by engineKey, so it goes with the engine and a
 * per-call engine is never retained): inside its scope its own setting decides, and it never sways the process sets.
 */
let embeddedPolicy = new WeakMap<object, { honorAliases?: boolean; expose?: boolean }>();
const embeddedPolicyOf = (key: object) => {
  let policy = embeddedPolicy.get(key);
  if (!policy) embeddedPolicy.set(key, policy = {});
  return policy;
};
const ALIAS_OPT_OUT_VALUES = ['false', '0', 'off', 'no'];
function honorAliases(): boolean {
  const scoped = embeddedKeyInScope();
  if (scoped) return embeddedPolicy.get(scoped)?.honorAliases ?? true;
  if (unscopedWithOpenEmbeddedEngines()) return true;
  return honorAliasEngines.size > 0 || aliasOptOutEngines.size === 0;
}

/** Reads this brain's `visibility.honor_aliases` into the process setting (an embedded engine's: its own); true unless it is false/0/off/no. Unreadable keeps the last value. */
export async function readHonorAliases(engine: BrainEngine): Promise<boolean> {
  try {
    const optOut = ALIAS_OPT_OUT_VALUES.includes((await engine.getConfig(HONOR_ALIASES_KEY))?.trim().toLowerCase() ?? '');
    const embedded = embeddedKey(engine);
    if (embedded) {
      embeddedPolicyOf(embedded).honorAliases = !optOut;
      return !optOut;
    }
    (optOut ? aliasOptOutEngines : honorAliasEngines).add(engine);
    (optOut ? honorAliasEngines : aliasOptOutEngines).delete(engine);
    return !optOut;
  } catch {
    const embedded = embeddedKey(engine);
    return embedded ? embeddedPolicy.get(embedded)?.honorAliases ?? true : !aliasOptOutEngines.has(engine);
  }
}

/**
 * A page whatever is derived from it must not outrank: private to remote readers, carrying a privacy alias, or under a
 * folder rule or a pending folder prefix (`folder_restricted`, selected with folderRestrictedSql or looked up with folderRestricted).
 */
export function isDerivationPrivate(page: { type?: string | null; frontmatter?: unknown; folder_restricted?: boolean | null }): boolean {
  return page.folder_restricted === true || hasReaders(page.frontmatter) || isPrivacyDerivationPrivate(page);
}

/** isDerivationPrivate by privacy alone (visibility, aliases, pinned questions): what decides where a page lives in Git. */
export function isPrivacyDerivationPrivate(page: { type?: string | null; frontmatter?: unknown }): boolean {
  if (isPrivacyPrivatePage(page)) return true;
  return typeof page.frontmatter === 'object' && page.frontmatter !== null && hasPrivacyAlias(page.frontmatter as Record<string, unknown>);
}

/** SQL twin of isDerivationPrivate. */
export function derivationPrivateSql(alias: string): string {
  return `(NOT ${privateSnapshotFilterFragment(alias)} OR ${privacyAliasSql(alias)} OR ${namesReadersSql(alias)} OR ${folderRestrictedSql(alias)})`;
}

/**
 * GBRA-218 (A2): the page row sits under an applied folder rule (its stamp) or a pending or invalid folder prefix, or
 * this database role cannot read the folder access tables.
 */
export function folderRestrictedSql(alias: string): string {
  return `(${alias}.folder_rule_ids IS NOT NULL OR gbrain_access_pending_covers(${alias}.source_id, ${alias}.slug) OR (SELECT gbrain_access_state_unreadable()))`;
}

/**
 * folderRestrictedSql for a page known by its slug (a parsed page, a row read without the column, a page about to be
 * written): judged against the applied folder rules, not the stamp. A failed read counts as restricted.
 */
export async function folderRestricted(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, slug: string): Promise<boolean> {
  try {
    const [row] = await engine.executeRaw<{ restricted: boolean }>(
      'SELECT (gbrain_access_folder_rules($1, $2) IS NOT NULL OR gbrain_access_pending_covers($1, $2) OR gbrain_access_state_unreadable()) AS restricted', [sourceId, slug]);
    return row?.restricted === true;
  } catch {
    return true;
  }
}

/** `page` with folder_restricted looked up (folderRestricted), for a page read without it, such as a page snapshot. */
export async function withFolderRestricted(engine: Pick<BrainEngine, 'executeRaw'>, page: { source_id: string; slug: string; type?: string | null; frontmatter?: unknown }): Promise<{ type?: string | null; frontmatter?: unknown; folder_restricted: boolean }> {
  return { type: page.type, frontmatter: page.frontmatter, folder_restricted: await folderRestricted(engine, page.source_id, page.slug) };
}

/**
 * #5525 — the visibility a derived page takes from its origin: transcripts and
 * missing origins are private, and a page origin is private when remote
 * readers cannot see it or it carries a privacy alias.
 */
export function effectiveVisibility(origin: { kind: 'transcript' } | { kind: 'page'; page: { type?: string | null; frontmatter?: unknown; folder_restricted?: boolean | null } | null }): Visibility {
  if (origin.kind === 'transcript' || !origin.page) return 'private';
  return isDerivationPrivate(origin.page) ? 'private' : 'world';
}

/** Derived outputs take the strictest visibility of their inputs. */
export function strictestVisibility(values: Iterable<Visibility>): Visibility {
  for (const value of values) if (value === 'private') return 'private';
  return 'world';
}

/** Check the actual origin, independently of joins that redact its source. */
export function privateLinkOriginFilterFragment(linkAlias: string): string {
  return `(${linkAlias}.origin_page_id IS NULL OR EXISTS (
    SELECT 1 FROM pages origin_private
    WHERE origin_private.id = ${linkAlias}.origin_page_id
      AND ${privatePagesFilterFragment('origin_private')}
  ))`;
}

/** A projection's private event must stay hidden even when its join is source-redacted. */
export function privateTimelineEventFilterFragment(timelineAlias: string): string {
  return `(${timelineAlias}.event_page_id IS NULL OR EXISTS (
    SELECT 1 FROM pages event_private
    WHERE event_private.id = ${timelineAlias}.event_page_id
      AND ${privatePagesFilterFragment('event_private')}
  ))`;
}

/** privateLinkOriginFilterFragment for a remote read: an origin page in a private-readable source passes. */
export function privateLinkOriginFilterForCaller(linkAlias: string): string {
  return `(${linkAlias}.origin_page_id IS NULL OR EXISTS (
    SELECT 1 FROM pages origin_private
    WHERE origin_private.id = ${linkAlias}.origin_page_id
      AND ${privatePagesFilterForCaller('origin_private')}
  ))`;
}

/** privateTimelineEventFilterFragment for a remote read. */
export function privateTimelineEventFilterForCaller(timelineAlias: string): string {
  return `(${timelineAlias}.event_page_id IS NULL OR EXISTS (
    SELECT 1 FROM pages event_private
    WHERE event_private.id = ${timelineAlias}.event_page_id
      AND ${privatePagesFilterForCaller('event_private')}
  ))`;
}

/**
 * Fact-row twin for ontology provenance: hide an observation whose provenance
 * page (`source_markdown_slug`, looked up in the fact's own source) is
 * private. Non-page provenance (e.g. `manual`) has no page row and passes;
 * deleted page rows still count (fail-closed). Keys on (facts.source_id, slug),
 * so a provenance page living in a DIFFERENT source than the fact is not
 * consulted — fail-open for cross-source provenance, acceptable under source
 * isolation because ontology_propose stamps the fact with ctx.sourceId.
 */
/**
 * GBRA-218: privateProvenanceFilterFragment for the fact reads a caller gates on `excludePrivate`. The readers part
 * always applies (a world fact held in or extracted from a page that names readers stays hidden from every remote
 * caller, as with the plain fragment); the privacy part is dropped when an operator relaxed privacy for this remote
 * read, which is what the hatches did to these reads before member access (`excludePrivate` was false then).
 * Outside a remote record nothing relaxes it. GST-359 C2: a fact on the caller's own member page
 * (`memory/members/<member>`, one attested or bound member) alone is judged as the caller, so its member reads it back;
 * every other page, other members' pages included, keeps the empty identity. GST-2490 / GBRA-108: a lineage read judges
 * every other page that is not a member page as the reader, and an owner read an audience member's page too. The
 * provenance page is judged as an origin: a raw-only rule (covers_derived false) does not hide the facts from its pages.
 */
export function privateProvenanceFilterUnderPolicy(factAlias: string): string {
  const access = currentCallerAccess();
  const hide = !callerRelaxesPrivacy();
  const member = access.actor?.member ?? (access.audienceIdentities.length ? null : access.identity.find(p => p.startsWith('member:'))?.slice('member:'.length));
  const ownPage = lineageReadPage(access);
  const audience = audiencePages(access);
  const memberPage = audience.length ? `(starts_with(pp.slug, '${MEMBER_PAGE_PREFIX}') AND NOT ${audiencePageSql('pp', audience)})` : `starts_with(pp.slug, '${MEMBER_PAGE_PREFIX}')`;
  const otherwise = ownPage
    ? `CASE WHEN ${memberPage} THEN ${readPolicyFragment('pp', [], hide, [], true)} ELSE (${lineageAccessSql('pp', access, ownPage, true)} AND ${hide ? privacyPartSql('pp') : 'TRUE'}) END`
    : readPolicyFragment('pp', [], hide, [], true);
  const policy = member && ACCESS_ID_RE.test(member)
    ? `CASE WHEN pp.slug = '${MEMBER_PAGE_PREFIX}${member}' THEN ${readPolicyFragment('pp', access.identity, hide, access.satisfiedRuleIds, true)} ELSE ${otherwise} END`
    : otherwise;
  return `(NOT EXISTS (SELECT 1 FROM pages pp WHERE pp.source_id = ${factAlias}.source_id AND pp.slug = ${factAlias}.source_markdown_slug AND NOT (${policy})) AND ${privateEntityFilterForCaller(factAlias)}${labelledOnlyFactSql(factAlias)})`;
}

/**
 * A fact is never wider than the page it is about: hide a fact whose entity page (`entity_slug`, looked up in the fact's
 * own source) the current caller cannot read under the read policy its page reads use, so a member the page's readers
 * name keeps the fact and every other remote caller loses it. A fact held on a holding page (GST-2492) is also judged by
 * that page as a page, not as lineage, so a folder's holding page hides its facts exactly as it hides itself. A fact with
 * no entity page passes. Read sites only; it only ever narrows. GBRA-108 design 1: the entity page and the holding page
 * are judged by the caller's ordinary access, not its labelled-only grant: a labelled-only caller's fact is already kept
 * to provenance that names it (labelledOnlyFactSql), and that conjunct is what narrows it.
 */
export function privateEntityFilterForCaller(factAlias: string, perCandidate = false): string {
  const entityPolicy = currentCallerAccess().labelledOnly ? withCallerAccess({ labelledOnly: false }, () => privatePagesFilterForCaller('entity_pp')) : privatePagesFilterForCaller('entity_pp');
  const held = `CASE WHEN ${factAlias}.entity_slug IS NOT NULL AND ${holdingSlugSql(`${factAlias}.source_markdown_slug`)} THEN ${factAlias}.source_markdown_slug END`;
  return `(NOT EXISTS (SELECT 1 FROM pages entity_pp WHERE entity_pp.source_id = ${factAlias}.source_id AND entity_pp.slug IN (${factAlias}.entity_slug, ${held}) AND NOT ${entityPolicy}${perCandidate ? ' OFFSET 0' : ''})${sharedHeldRuledSql(factAlias)})`;
}

/**
 * GST-2492: a fact still held on a holding page for an entity a rule now narrows below that page (a folder rule over the
 * shared page, an exact page rule over a folder's holding page; applied by sync, or a remember planned before the rule,
 * until the held-fact move takes it away) reads as that entity's page would: only for a caller who satisfies every
 * covering rule, and for nobody while a pending narrowing covers it. The owner under the opt-in reads it, as it reads every restricted page.
 */
function sharedHeldRuledSql(factAlias: string): string {
  const access = currentCallerAccess();
  if (access.ownerReadsRestricted) return '';
  const satisfied = access.restricted ? access.satisfiedRuleIds : [];
  const ids = satisfied.length && satisfied.every(validQualifiedRuleId) ? [...new Set(satisfied)].sort() : [];
  const array = ids.length ? `ARRAY[${ids.map(id => `'${id}'`).join(', ')}]::text[]` : 'ARRAY[]::text[]';
  return ` AND NOT (${factAlias}.entity_slug IS NOT NULL AND ${holdingSlugSql(`${factAlias}.source_markdown_slug`)}`
    + ` AND (NOT COALESCE(gbrain_access_folder_rules(${factAlias}.source_id, ${factAlias}.entity_slug) <@ ${array}, true)`
    + ` OR gbrain_access_pending_covers(${factAlias}.source_id, ${factAlias}.entity_slug)))`;
}

/**
 * privateProvenanceFilterFragment for a remote fact read: the provenance page gate plus the caller's entity-page gate.
 * perCandidate keeps the entity gate a lookup per candidate row (OFFSET 0 stops the planner turning it into a join), so
 * a scan an index serves, such as the saved-fact keyword match, keeps that index.
 */
export function privateFactFilterForCaller(factAlias: string, perCandidate = false): string {
  return `(${privateProvenanceFilterFragment(factAlias)} AND ${privateEntityFilterForCaller(factAlias, perCandidate)}${labelledOnlyFactSql(factAlias)})`;
}

/** True only inside a remote caller record whose read an operator relaxed (the env hatch or the config opt-out). */
export function callerRelaxesPrivacy(): boolean {
  return callerAccessStore.getStore()?.hidePrivate === false;
}

export function privateProvenanceFilterFragment(factAlias: string): string {
  return `NOT EXISTS (SELECT 1 FROM pages pp WHERE pp.source_id = ${factAlias}.source_id ` +
    `AND pp.slug = ${factAlias}.source_markdown_slug AND NOT (${privatePagesFilterFragment('pp', true)}))`;
}

/**
 * Row-side twin of privatePagesFilterFragment for pages already fetched
 * (get_page / fetch read one row by slug; re-querying just to filter would
 * be a second round-trip). Same semantics: an explicit 'private' hides a
 * page, and an absent value hides only derived atoms and concepts.
 */
export function isPrivatePage(page: { type?: string | null; frontmatter?: unknown }): boolean {
  return hasReaders(page.frontmatter) || isPrivacyPrivatePage(page);
}

/** isPrivatePage without the member-access rule: visibility, aliases and pinned questions only. */
export function isPrivacyPrivatePage(page: { type?: string | null; frontmatter?: unknown }): boolean {
  const frontmatter = typeof page.frontmatter === 'object' && page.frontmatter !== null
    ? page.frontmatter as Record<string, unknown> : {};
  if (frontmatter.pinned_question != null) return true;
  if (frontmatter.visibility == null && honorAliases() && hasPrivacyAlias(frontmatter)) return true;
  const derived = page.type === 'atom' || page.type === 'question' || (page.type === 'concept' && frontmatter.synthesized_by != null);
  return (frontmatter.visibility ?? (derived ? 'private' : 'world')) === 'private';
}

/**
 * Slugs an untrusted caller must not see enumerated: every in-scope page row
 * for the slug is `visibility: private`. A slug with at least one non-private
 * in-scope page stays visible (multi-source: private in one source, world in
 * another). Slugs with no page row at all (dangling link endpoints) are not
 * returned — they reveal nothing private. Used only for get_page's fuzzy
 * candidate enumeration; data-bearing reads authorize concrete rows in the
 * engine instead of treating a visible namesake as authorization. `scope` follows the
 * canonical precedence (federated array > scalar > nothing); with
 * `includeDeleted` unset, only live rows are considered.
 */
export async function findPrivateOnlySlugs(
  engine: BrainEngine,
  slugs: string[],
  scope: { sourceId?: string; sourceIds?: string[] } = {},
  opts: { includeDeleted?: boolean } = {},
): Promise<Set<string>> {
  if (slugs.length === 0) return new Set();
  const params: unknown[] = [slugs];
  let scopeClause = '';
  if (scope.sourceIds && scope.sourceIds.length > 0) {
    params.push(scope.sourceIds);
    scopeClause = `AND p.source_id = ANY($${params.length}::text[])`;
  } else if (scope.sourceId) {
    params.push(scope.sourceId);
    scopeClause = `AND p.source_id = $${params.length}`;
  }
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT p.slug FROM pages p
      WHERE p.slug = ANY($1::text[])
        ${opts.includeDeleted ? '' : 'AND p.deleted_at IS NULL'}
        ${scopeClause}
      GROUP BY p.slug
      HAVING bool_and(NOT (${privatePagesFilterForCaller('p')}))`,
    params,
  );
  return new Set(rows.map(r => r.slug));
}

const CACHE_TTL_MS = 30_000;
let cache = new WeakMap<BrainEngine, { at: number; expose: boolean }>();
const exposeEngines = new Set<BrainEngine>();
const strictEngines = new Set<BrainEngine>();

/** GBRA-218: set once a page names readers or a member exists (sticky; a trigger and `gbrain access` write it). */
export const ACCESS_RESTRICTIONS_KEY = 'access.restrictions_present';

/**
 * GST-363: whom the brain serves. SERVES_KEY is the explicit `one` or `several` (`gbrain setup --serves several`
 * writes it, and it wins); SERVES_DERIVED_KEY is `several` while two or more members are enabled, `one` otherwise;
 * SERVES_SINCE_KEY is when the brain first served several people, set once and never cleared. A trigger on
 * access_members and on config access.serves keeps the last two (migration v309), so a request reads them from its
 * config snapshot with no query. REQUESTER_SCOPE_ENFORCE_KEY `false` turns the unscoped-read refusal into a notice
 * (hosted, until its control plane binds each connection to a member).
 */
export const SERVES_KEY = 'access.serves';
export const SERVES_DERIVED_KEY = 'access.serves_derived';
export const SERVES_SINCE_KEY = 'access.serves_since';
export const REQUESTER_SCOPE_ENFORCE_KEY = 'access.requester_scope_enforce';
/** The schema version migrate.ts records in config. */
const SCHEMA_VERSION_KEY = 'version';

/** @internal exported for tests: engines the process-wide policy sets hold. */
export function __aliasPolicyEngineCountForTests(): number {
  return honorAliasEngines.size + aliasOptOutEngines.size + exposeEngines.size + strictEngines.size;
}

/** Test helper: drop the per-engine config cache. */
export function __resetPrivateVisibilityCacheForTests(): void {
  cache = new WeakMap();
  embeddedPolicy = new WeakMap();
  honorAliasEngines.clear();
  aliasOptOutEngines.clear();
  exposeEngines.clear();
  strictEngines.clear();
}

/**
 * The process-wide privacy relaxation used when no caller record exists:
 * the env hatch, or a brain that opted out while none in this process stayed
 * strict (the same lean-private rule as visibility.honor_aliases).
 */
function processPrivacyRelaxed(): boolean {
  if (process.env.GBRAIN_REMOTE_PRIVATE_PAGES === '1') return true;
  const scoped = embeddedKeyInScope();
  if (scoped) return embeddedPolicy.get(scoped)?.expose === true;
  if (unscopedWithOpenEmbeddedEngines()) return false;
  return exposeEngines.size > 0 && strictEngines.size === 0;
}

/**
 * Has an operator relaxed privacy for remote reads on this brain
 * (GBRAIN_REMOTE_PRIVATE_PAGES=1 or search.remote_private_pages=visible)?
 * The only reader of either switch: every privacy decision comes through here
 * or through resolveExcludePrivatePages. Config lookups are cached 30s per
 * engine; a failed lookup counts as "not relaxed" (fail-closed).
 */
export async function remotePrivacyRelaxed(engine: BrainEngine): Promise<boolean> {
  if (process.env.GBRAIN_REMOTE_PRIVATE_PAGES === '1') return true; // incident escape hatch
  const hit = cache.get(engine);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.expose;
  let expose: boolean;
  try {
    const v = await engine.getConfig(REMOTE_PRIVATE_PAGES_KEY);
    expose = v === 'visible' || v === 'true' || v === '1';
  } catch {
    expose = false; // config unreadable → enforce (fail-closed)
  }
  await readHonorAliases(engine);
  cache.set(engine, { at: Date.now(), expose });
  const embedded = embeddedKey(engine);
  if (embedded) {
    embeddedPolicyOf(embedded).expose = expose;
    return expose;
  }
  (expose ? exposeEngines : strictEngines).add(engine);
  (expose ? strictEngines : exposeEngines).delete(engine);
  return expose;
}

/** GST-363: whom the brain serves, as a remote request reads it from config (no query). `since` is epoch seconds. */
export interface ServesPolicy { several: boolean; from: 'config' | 'members'; since: number | null; enforce: boolean }

/** `servesUnknown`: the config read failed, so whom the brain serves is not known (never read as one person, GST-363). */
/** `schemaVersion`: config `version` as the request read it; below v311, or absent, the concept-input test runs inline (derivedOriginPrivateSql). A local read has no policy and uses its engine's recorded version instead. */
export interface RemotePolicy { privacyRelaxed: boolean; restricted: boolean; ownerMember?: string | null; ownerReadsRestricted?: boolean; membersReadLineage?: boolean; serves?: ServesPolicy; servesUnknown?: boolean; schemaVersion?: number }

/** GST-363: an explicit access.serves wins over the trigger-kept member count; enforcement is on unless set to false. */
export function servesPolicyFrom(config: Record<string, string | undefined>): ServesPolicy {
  const explicit = config[SERVES_KEY]?.trim().toLowerCase();
  const fromConfig = explicit === 'one' || explicit === 'several';
  const since = Date.parse(config[SERVES_SINCE_KEY]?.trim() ?? '');
  return {
    several: (fromConfig ? explicit : config[SERVES_DERIVED_KEY]?.trim()) === 'several',
    from: fromConfig ? 'config' : 'members',
    since: Number.isFinite(since) ? Math.floor(since / 1000) : null,
    enforce: !['false', '0', 'off', 'no'].includes(config[REQUESTER_SCOPE_ENFORCE_KEY]?.trim().toLowerCase() ?? ''),
  };
}

/**
 * The remote read policy read fresh, for publication: whether an operator
 * relaxed privacy (the env hatch or the config opt-out, uncached) and whether
 * the brain holds member-access restrictions. Takes any executeRaw engine (a
 * transaction included). An unreadable config counts as not opted out and
 * restricted (fail closed); the env hatch needs no read. Whom the brain serves
 * is then unknown (servesUnknown, GST-363): the requester-scope gate reads the
 * serves keys once more (readServesPolicy) and refuses an unbound read when that
 * fails too, because a timeout or a dropped pooled connection can fail this one
 * statement while the next read succeeds.
 */
export async function readRemotePolicyNow(engine: Pick<BrainEngine, 'executeRaw'>): Promise<RemotePolicy> {
  try {
    const rows = await engine.executeRaw<{ key: string; value: string }>('SELECT key, value FROM config WHERE key = ANY($1::text[])', [[REMOTE_PRIVATE_PAGES_KEY, ACCESS_RESTRICTIONS_KEY, OWNER_MEMBER_KEY, OWNER_READS_RESTRICTED_KEY, MEMBERS_READ_LINEAGE_KEY,
      SERVES_KEY, SERVES_DERIVED_KEY, SERVES_SINCE_KEY, REQUESTER_SCOPE_ENFORCE_KEY, SCHEMA_VERSION_KEY]]);
    return remotePolicyFrom(Object.fromEntries(rows.map(r => [r.key, r.value])));
  } catch {
    return { privacyRelaxed: process.env.GBRAIN_REMOTE_PRIVATE_PAGES === '1', restricted: true, ownerMember: null, ownerReadsRestricted: false, membersReadLineage: false, servesUnknown: true };
  }
}

/** GST-2687: the schema version a scope or attested caller record carries, read now; absent when unreadable, so the read rule stays inline. */
export async function schemaVersionNow(engine: Pick<BrainEngine, 'executeRaw'>): Promise<Pick<RemotePolicy, 'schemaVersion'>> {
  const { schemaVersion } = await readRemotePolicyNow(engine);
  return schemaVersion === undefined ? {} : { schemaVersion };
}

/** GST-363: whom the brain serves, read on its own (the requester-scope gate's re-read after an unreadable policy read). Throws when unreadable. */
export async function readServesPolicy(engine: Pick<BrainEngine, 'executeRaw'>): Promise<ServesPolicy> {
  const rows = await engine.executeRaw<{ key: string; value: string }>('SELECT key, value FROM config WHERE key = ANY($1::text[])', [[SERVES_KEY, SERVES_DERIVED_KEY, SERVES_SINCE_KEY, REQUESTER_SCOPE_ENFORCE_KEY]]);
  return servesPolicyFrom(Object.fromEntries(rows.map(r => [r.key, r.value])));
}

/**
 * The remote read policy a request starts under: answered from the read request's config snapshot when one is open
 * (taken when the request started, so no staler than readRemotePolicyNow there, and no extra round trip, #6721);
 * otherwise (a write reads config live, or the snapshot's bulk read failed) readRemotePolicyNow's one statement.
 */
export async function requestRemotePolicy(engine: BrainEngine): Promise<RemotePolicy> {
  const rows = await requestConfigRows(engine).catch(() => undefined);
  return rows ? remotePolicyFrom(rows) : readRemotePolicyNow(engine);
}

function remotePolicyFrom(config: Record<string, string>): RemotePolicy {
  const hatch = process.env.GBRAIN_REMOTE_PRIVATE_PAGES === '1';
  const owner = config[OWNER_MEMBER_KEY]?.trim();
  const schemaVersion = Number.parseInt(config[SCHEMA_VERSION_KEY] ?? '', 10);
  return { privacyRelaxed: hatch || ['visible', 'true', '1'].includes(config[REMOTE_PRIVATE_PAGES_KEY] ?? ''), restricted: config[ACCESS_RESTRICTIONS_KEY] === '1',
    ownerMember: owner && ACCESS_ID_RE.test(owner) ? owner : null, ownerReadsRestricted: config[OWNER_READS_RESTRICTED_KEY]?.trim() === '1',
    membersReadLineage: config[MEMBERS_READ_LINEAGE_KEY]?.trim() === '1', serves: servesPolicyFrom(config),
    ...(Number.isFinite(schemaVersion) ? { schemaVersion } : {}) };
}

/** GBRA-218: does this brain hold member-access restrictions? Read live (the request snapshot answers it inside a read); unreadable counts as yes. */
export async function accessRestrictionsPresent(engine: BrainEngine): Promise<boolean> {
  try {
    return (await engine.getConfig(ACCESS_RESTRICTIONS_KEY)) === '1';
  } catch {
    return true;
  }
}

/**
 * Should this caller's page reads apply the read-policy fragment
 * (`excludePrivate`)? `remote` follows the repo trust convention: anything
 * that is not strictly `false` is untrusted. A trusted local caller applies
 * it only under a local `--as <member>` record. A remote caller always
 * applies it, except when an operator relaxed privacy and the brain holds no
 * member-access restriction, where the hatches keep their pre-GBRA-218
 * meaning. With restrictions present the fragment still applies under a
 * hatch: caller-aware fragments relax only their privacy part, and the
 * member-access part (accessAllowedSql) stays mandatory. A shared-agent audience the hatch does not relax (a
 * channel: several entries, a group or a guest) always applies it, restrictions or not.
 */
export async function resolveExcludePrivatePages(
  engine: BrainEngine,
  remote: boolean | undefined,
): Promise<boolean> {
  if (remote === false) return currentCallerAccess().applyRemoteReadPolicy;
  if (!await remotePrivacyRelaxed(engine)) return true;
  const access = currentCallerAccess();
  if (access.audience?.length && access.hidePrivate) return true;
  return accessRestrictionsPresent(engine);
}
