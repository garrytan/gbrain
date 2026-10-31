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
import { isValidSourceId } from '../source-id.ts';
import { hasReaders, normalizePrincipal, readersAllow, validIdentity } from '../access/principals.ts';
import { validPrefix, validQualifiedRuleId } from '../access/folder-rules.ts';

export const REMOTE_PRIVATE_PAGES_KEY = 'search.remote_private_pages';

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
export function privatePagesFilterFragment(pageAlias: string): string {
  return `(${accessAllowedSql(pageAlias, [])} AND ${privacyPartSql(pageAlias)})`;
}

/** The privacy rules alone (visibility, aliases, pinned questions, lineage): what the escape hatches and granted_sources may relax. */
export function privacyPartSql(pageAlias: string): string {
  return `(${privateSnapshotFilterFragment(pageAlias)}
    AND NOT ${derivedOriginPrivateSql(pageAlias)}
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
export function accessAllowedSql(pageAlias: string, identity: readonly string[], satisfied: readonly string[] = satisfiedFor(identity)): string {
  return accessAllowedForAllSql(pageAlias, [identity], satisfied);
}

/**
 * GBRA-231 (shared agents): accessAllowedSql for an audience. A page passes only when every identity in
 * `identities` meets its readers (one conjunct each; a guest's empty identity meets no readers), and its folder rules
 * are all in `satisfied` (for an audience, the intersection of every entry's satisfied set).
 */
export function accessAllowedForAllSql(pageAlias: string, identities: readonly (readonly string[])[], satisfied: readonly string[]): string {
  if (!currentCallerAccess().restricted) return `(${pageAlias}.page_readers IS NULL AND ${pageAlias}.folder_rule_ids IS NULL)`;
  const readers = (identities.length ? identities : [[]]).map(identity => readersAllowedSql(pageAlias, identity)).join(' AND ');
  return `(${readers} AND ${folderRulesAllowedSql(pageAlias, satisfied)} AND ${originAllowedSql(pageAlias)})`;
}

/**
 * GBRA-218 (PR A2): the folder layer. `folder_rule_ids` holds the source-qualified ids
 * of every applied folder rule whose prefix the slug starts with (a trigger stamps it from the applied rulebook,
 * migration v282); a page passes only when the caller satisfies all of them (`<@`, set semantics), so nested member
 * and group rules both have to pass. `satisfied` is the caller's satisfied set (CallerAccess.satisfiedRuleIds); an
 * entry that is not a valid qualified id empties it (fail closed). Prefixes under a narrowing still being stamped,
 * or touched by a policy file that does not validate, read as nobody (CallerAccess.folderCoverage). Column tests
 * lead, so a page under no rule costs one NULL test.
 */
export function folderRulesAllowedSql(alias: string, satisfied: readonly string[]): string {
  const ids = satisfied.length && satisfied.every(validQualifiedRuleId) ? [...new Set(satisfied)].sort() : [];
  const listed = ids.length ? ` OR ${alias}.folder_rule_ids <@ ARRAY[${ids.map(id => `'${id}'`).join(', ')}]::text[]` : '';
  return `(${alias}.folder_rule_ids IS NULL${listed})${coverageSql(alias)}`;
}

/**
 * The pending or invalid prefixes of the current record as a conjunct (empty when none); an ill-formed entry hides
 * everything. Outside any caller record the prefixes are read live, so a page under a pending prefix stays hidden.
 */
function coverageSql(alias: string): string {
  if (!callerAccessStore.getStore()) return ` AND NOT gbrain_access_pending_covers(${alias}.source_id, ${alias}.slug)`;
  const coverage = currentCallerAccess().folderCoverage;
  if (!coverage.length) return '';
  return coverage.map(c => !isValidSourceId(c.source_id) || (c.prefix !== '' && !validPrefix(c.prefix)) ? ' AND FALSE'
    : c.prefix === '' ? ` AND ${alias}.source_id <> '${c.source_id}'`
    : ` AND NOT (${alias}.source_id = '${c.source_id}' AND starts_with(${alias}.slug, '${c.prefix}'))`).join('');
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
 * gbrain_access_origin_restricted (migration v281) behind a cheap type and
 * key guard, so a read plans one function call instead of four subplans. Both
 * parts lead with column tests (page_readers IS NULL, type) so the planner's
 * row estimate follows column statistics instead of a default guess.
 */
function originAllowedSql(p: string): string {
  return `((${p}.type NOT IN ('atom', 'question', 'concept', 'event') AND NOT (${p}.frontmatter ? 'derived_from'))
    OR NOT gbrain_access_origin_restricted(${p}.id, ${p}.source_id, ${p}.type, ${p}.frontmatter))`;
}

/**
 * `privatePagesFilterFragment` with a cheap first test: a page with no
 * `visibility` or `derived_from` key (nor, unless the operator turned
 * `visibility.honor_aliases` off, a privacy-alias key) whose type is not atom, concept or event is visible by every rule
 * above, so only the remaining pages run the full check. For scans over thousands of
 * candidate pages (an entity's referrers).
 */
export function privatePagesFilterFragmentFast(pageAlias: string): string {
  return `(${folderRulesAllowedSql(pageAlias, [])} AND ((${pageAlias}.frontmatter->'visibility' IS NULL AND ${pageAlias}.frontmatter->'derived_from' IS NULL${honorAliases()
      ? `\n      AND ${pageAlias}.frontmatter->'access' IS NULL AND ${pageAlias}.frontmatter->'confidentiality' IS NULL` : ''}
      AND ${pageAlias}.frontmatter->'readable_by' IS NULL
      AND ${pageAlias}.type NOT IN ('atom', 'concept', 'event'))
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
 *    (GBRAIN_REMOTE_PRIVATE_PAGES=1 or search.remote_private_pages=visible);
 *  - restricted: false only inside a remote request on a brain whose config
 *    access.restrictions_present was unset when the request began. Then no
 *    page named readers at that moment and none predates the migration (v281
 *    sets the flag when one does), so every readers value is in the derived
 *    column: accessAllowedSql tests only page_readers IS NULL and
 *    folder_rule_ids IS NULL (live, so a page gaining readers or a folder rule
 *    mid-request is still hidden, since the triggers fill both columns in that
 *    write) and skips lineage, member matching and the frontmatter test, whose
 *    per-row JSONB read cost keyword search about 3%. The flag is sticky and set
 *    in the same transaction as the first page that names readers, the first
 *    member and the first folder rule or pending folder prefix (v282).
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
  applyRemoteReadPolicy: boolean;
  restricted: boolean;
}
export interface FolderCoverage { source_id: string; prefix: string }
const callerAccessStore = new AsyncLocalStorage<CallerAccess>();

/** The current read's caller-access record (see CallerAccess). */
export function currentCallerAccess(): CallerAccess {
  return callerAccessStore.getStore() ?? { identity: [], audience: null, audienceIdentities: [], actor: null, satisfiedRuleIds: [], folderCoverage: [], privateReadableSources: [], hidePrivate: !processPrivacyRelaxed(), applyRemoteReadPolicy: false, restricted: true };
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
    hidePrivate: access.hidePrivate ?? base.hidePrivate,
    applyRemoteReadPolicy: access.applyRemoteReadPolicy ?? base.applyRemoteReadPolicy,
    restricted: access.restricted ?? base.restricted,
  }), fn);
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
export function callerReadersAllow(frontmatter: unknown): boolean {
  return callerIdentities().every(identity => readersAllow(frontmatter, identity));
}

/** GBRA-231: readersAllowedSql for the current caller, one conjunct per audience entry. */
export function callerReadersAllowedSql(alias: string, row: 'page' | 'snapshot' = 'page'): string {
  return callerIdentities().map(identity => readersAllowedSql(alias, identity, row)).join(' AND ');
}

const GUEST_ENTRY = 'guest';
function validAudienceEntry(entry: string): boolean {
  return entry === GUEST_ENTRY || normalizePrincipal(entry) === entry;
}

function callerAccessSql(pageAlias: string): string {
  const access = currentCallerAccess();
  return access.audienceIdentities.length ? accessAllowedForAllSql(pageAlias, access.audienceIdentities, access.satisfiedRuleIds)
    : accessAllowedSql(pageAlias, access.identity);
}

/**
 * `visiblePredicate` (a privacy-only predicate), widened to rows whose source
 * (`sourceIdSql`, a code-provided column reference) is in the current
 * private-readable set. Never pass a predicate that contains accessAllowedSql:
 * the widening would reach it. The ids are embedded as literals: each passed
 * isValidSourceId, whose alphabet has no quote or backslash.
 */
export function orPrivateReadableSource(sourceIdSql: string, visiblePredicate: string): string {
  const ids = privateReadableSources();
  if (ids.length === 0) return visiblePredicate;
  return `(${sourceIdSql} IN (${ids.map(id => `'${id}'`).join(', ')}) OR ${visiblePredicate})`;
}

/**
 * A privacy-only predicate for the current caller: TRUE when an operator
 * relaxed privacy, else widened only to private-readable sources. Never pass
 * a predicate that contains accessAllowedSql or readersAllowedSql.
 */
export function privacyForCaller(sourceIdSql: string, privacyPredicate: string): string {
  return currentCallerAccess().hidePrivate ? orPrivateReadableSource(sourceIdSql, privacyPredicate) : 'TRUE';
}

function callerPrivacySql(pageAlias: string, privacyPredicate: string): string {
  return privacyForCaller(`${pageAlias}.source_id`, privacyPredicate);
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
export function readPolicyFragment(pageAlias: string, identity: readonly string[] | { all: readonly (readonly string[])[] }, hidePrivate: boolean, satisfied?: readonly string[]): string {
  const access = 'all' in identity ? accessAllowedForAllSql(pageAlias, identity.all, satisfied ?? []) : accessAllowedSql(pageAlias, identity, satisfied);
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
      AND ${pageAlias}.type NOT IN ('atom', 'concept', 'event'))
    OR ${privacyPartSql(pageAlias)})`;
}

/**
 * isPrivatePage for a remote read: true when the page names readers the
 * caller does not meet; otherwise the privacy rule, false for a page whose
 * `source_id` is private-readable or when an operator relaxed privacy. A row
 * without `source_id` keeps the plain privacy rule.
 */
export function isPrivatePageForCaller(page: { type?: string | null; frontmatter?: unknown; source_id?: string | null }): boolean {
  const access = currentCallerAccess();
  if (!callerReadersAllow(page.frontmatter)) return true;
  if (!access.hidePrivate || !isPrivacyPrivatePage(page)) return false;
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
 */
function derivedOriginPrivateSql(p: string): string {
  const privateOrigin = (atom: string, alias: string) => `EXISTS (SELECT 1 FROM pages ${alias} WHERE ${alias}.source_id = ${atom}.source_id
      AND ${alias}.slug = ${atom}.frontmatter->>'source_slug' AND ${alias}.frontmatter->>'visibility' = 'private')`;
  return `(CASE WHEN ${p}.type = 'atom' THEN ${privateOrigin(p, 'derived_origin')}
    WHEN ${derivedPageSql(p)} THEN EXISTS (SELECT 1 FROM links derived_input_link
      JOIN pages derived_input ON derived_input.id = derived_input_link.to_page_id
      WHERE derived_input_link.from_page_id = ${p}.id AND derived_input_link.link_source = 'concept-provenance'
        AND derived_input_link.link_type = 'synthesized_from'
        AND (COALESCE(derived_input.frontmatter->>'visibility', CASE WHEN derived_input.type = 'atom' THEN 'private' ELSE 'world' END) = 'private'
          OR ${privateOrigin('derived_input', 'derived_input_origin')}))
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
 * values that mean private. Matching is case-insensitive on the trimmed value.
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
    return typeof value === 'string' && values.includes(value.trim().toLowerCase());
  });
}

/** SQL twin of hasPrivacyAlias on a page alias (a code-provided literal). */
export function privacyAliasSql(alias: string): string {
  return `(${Object.entries(PRIVACY_ALIASES).map(([key, values]) =>
    `COALESCE(lower(btrim(${alias}.frontmatter->>'${key}')) IN (${values.map(v => `'${v}'`).join(',')}), false)`).join(' OR ')})`;
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
const ALIAS_OPT_OUT_VALUES = ['false', '0', 'off', 'no'];
function honorAliases(): boolean {
  return honorAliasEngines.size > 0 || aliasOptOutEngines.size === 0;
}

/** Reads this brain's `visibility.honor_aliases` into the process setting; true unless it is false/0/off/no. Unreadable keeps the last value. */
export async function readHonorAliases(engine: BrainEngine): Promise<boolean> {
  try {
    const optOut = ALIAS_OPT_OUT_VALUES.includes((await engine.getConfig(HONOR_ALIASES_KEY))?.trim().toLowerCase() ?? '');
    (optOut ? aliasOptOutEngines : honorAliasEngines).add(engine);
    (optOut ? honorAliasEngines : aliasOptOutEngines).delete(engine);
    return !optOut;
  } catch {
    return !aliasOptOutEngines.has(engine);
  }
}

/**
 * A page whatever is derived from it must not outrank: private to remote readers, carrying a privacy alias, or under a
 * folder rule or a pending folder prefix (`folder_restricted`, selected with folderRestrictedSql or looked up with folderRestricted).
 */
export function isDerivationPrivate(page: { type?: string | null; frontmatter?: unknown; folder_restricted?: boolean | null }): boolean {
  if (page.folder_restricted === true || isPrivatePage(page)) return true;
  return typeof page.frontmatter === 'object' && page.frontmatter !== null && hasPrivacyAlias(page.frontmatter as Record<string, unknown>);
}

/** SQL twin of isDerivationPrivate. */
export function derivationPrivateSql(alias: string): string {
  return `(NOT ${privateSnapshotFilterFragment(alias)} OR ${privacyAliasSql(alias)} OR ${namesReadersSql(alias)} OR ${folderRestrictedSql(alias)})`;
}

/** GBRA-218 (A2): the page row sits under an applied folder rule (its stamp) or a pending or invalid folder prefix. */
export function folderRestrictedSql(alias: string): string {
  return `(${alias}.folder_rule_ids IS NOT NULL OR gbrain_access_pending_covers(${alias}.source_id, ${alias}.slug))`;
}

/**
 * folderRestrictedSql for a page known by its slug (a parsed page, a row read without the column, a page about to be
 * written): judged against the applied folder rules, not the stamp. A failed read counts as restricted.
 */
export async function folderRestricted(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, slug: string): Promise<boolean> {
  try {
    const [row] = await engine.executeRaw<{ restricted: boolean }>(
      'SELECT (gbrain_access_folder_rules($1, $2) IS NOT NULL OR gbrain_access_pending_covers($1, $2)) AS restricted', [sourceId, slug]);
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
 * Outside a remote record nothing relaxes it.
 */
export function privateProvenanceFilterUnderPolicy(factAlias: string): string {
  return `NOT EXISTS (SELECT 1 FROM pages pp WHERE pp.source_id = ${factAlias}.source_id ` +
    `AND pp.slug = ${factAlias}.source_markdown_slug AND NOT ${readPolicyFragment('pp', [], !callerRelaxesPrivacy())})`;
}

/** True only inside a remote caller record whose read an operator relaxed (the env hatch or the config opt-out). */
export function callerRelaxesPrivacy(): boolean {
  return callerAccessStore.getStore()?.hidePrivate === false;
}

export function privateProvenanceFilterFragment(factAlias: string): string {
  return `NOT EXISTS (SELECT 1 FROM pages pp WHERE pp.source_id = ${factAlias}.source_id ` +
    `AND pp.slug = ${factAlias}.source_markdown_slug AND NOT (${privatePagesFilterFragment('pp')}))`;
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

/** Test helper: drop the per-engine config cache. */
export function __resetPrivateVisibilityCacheForTests(): void {
  cache = new WeakMap();
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
  return process.env.GBRAIN_REMOTE_PRIVATE_PAGES === '1' || (exposeEngines.size > 0 && strictEngines.size === 0);
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
  (expose ? exposeEngines : strictEngines).add(engine);
  (expose ? strictEngines : exposeEngines).delete(engine);
  return expose;
}

/**
 * The remote read policy read fresh, for publication: whether an operator
 * relaxed privacy (the env hatch or the config opt-out, uncached) and whether
 * the brain holds member-access restrictions. Takes any executeRaw engine (a
 * transaction included). An unreadable config counts as not opted out and
 * restricted (fail closed); the env hatch needs no read.
 */
export async function readRemotePolicyNow(engine: Pick<BrainEngine, 'executeRaw'>): Promise<{ privacyRelaxed: boolean; restricted: boolean }> {
  const hatch = process.env.GBRAIN_REMOTE_PRIVATE_PAGES === '1';
  try {
    const rows = await engine.executeRaw<{ key: string; value: string }>('SELECT key, value FROM config WHERE key = ANY($1::text[])', [[REMOTE_PRIVATE_PAGES_KEY, ACCESS_RESTRICTIONS_KEY]]);
    const value = (key: string) => rows.find(r => r.key === key)?.value ?? '';
    return { privacyRelaxed: hatch || ['visible', 'true', '1'].includes(value(REMOTE_PRIVATE_PAGES_KEY)), restricted: value(ACCESS_RESTRICTIONS_KEY) === '1' };
  } catch {
    return { privacyRelaxed: hatch, restricted: true };
  }
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
