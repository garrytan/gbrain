#!/usr/bin/env bun
/**
 * Engine-sql dynamic-SQL guard (refactor wave 1, A2b / CQ3 / EO8 / EO17;
 * docs/ci-guards.md#engine-sql-dynamic-sql).
 *
 * In src/core/engine-sql/** every value reaches SQL as a bound parameter
 * (`sqlFragment`), and only constant text is spliced. This guard parses each
 * file (TypeScript compiler API) and fails on:
 *
 *   1. `trustedSql(arg)` where arg is not trusted text (below).
 *   2. An untagged template literal or `+` concatenation passed as the SQL
 *      argument of `.query(` / `.unsafe(` / `.executeRaw(` (first argument)
 *      or `executeRawJsonb(` (second), directly or through a local variable,
 *      with a substitution / operand that is not trusted text.
 *   3. A literal `$<digit>` (or a `$` right before a substitution) inside a
 *      composed string: a template with substitutions, any `sqlFragment`
 *      template, or an operand of a `+` concatenation. Placeholders are
 *      numbered by renderFragment; a static string passed as-is may carry them.
 *   4. An expanded list: `IN (` right before a substitution or a
 *      non-literal `+` operand. Lists bind as `= ANY($n::type[])`.
 *
 * Trusted text is: a string literal; an identifier or member / element
 * access whose root is a `const` in this file initialized with trusted text
 * or an `as const` object / array literal, or a CONSTANT_ALLOWLIST name; a
 * call to a VETTED_BUILDERS entry; a template whose substitutions are all
 * trusted or are numeric expressions the same function checked earlier with
 * `Number.isFinite(<same expression>)` (a `+` chain under the same rule); a
 * conditional whose branches are both trusted.
 *
 * Seam: GBRAIN_GUARD_ROOT (fixture tree root).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = process.env.GBRAIN_GUARD_ROOT ?? join(import.meta.dir, '..');
const SCAN_DIR = 'src/core/engine-sql';
const ANCHOR = 'docs/ci-guards.md#engine-sql-dynamic-sql';

const EXEMPT_FILES: Record<string, string> = {
  'fragment.ts': 'the renderer itself: it writes the $n placeholders and splices trustedSql text by design',
};

const CONSTANT_ALLOWLIST: Record<string, string> = {
  ENRICH_ORDER_SQL: 'src/core/types.ts: ORDER BY text keyed by the EnrichCandidatesOpts order union (whitelisted enum)',
  SOURCE_CONFIG_OBJECT_SQL: 'src/core/source-config-sql.ts: static sources.config coercion expression (no input)',
  EMBED_SKIP_FILTER_FRAGMENT: 'src/core/embed-skip.ts: constant embed_skip predicate over alias p',
  QUARANTINE_FILTER_FRAGMENT: 'src/core/quarantine.ts: constant quarantine visibility predicate over the pages alias p',
  PAGE_SORT_SQL: 'src/core/types.ts: ORDER BY text keyed by the PageFilters sort union (whitelisted enum)',
  TEMPORAL_LINK_SELECT_SQL: 'src/core/link-validity.ts: constant select list over the lr_t relationship-state join',
  GUEST_SOURCES_HIDDEN_SQL: 'src/core/guests/note.ts: constant row-security probe of guest_sources (no input)',
  RELEASE_STAGED_CTE: 'src/core/persistence/limits.ts: constant CTE releasing upload reservations of a preceding gone CTE (no input)',
  ANY_OWNER_ONLY_SQL: 'src/core/access/owner-only.ts: constant any-owner-only-source EXISTS over sources read_source; the kinds and flag key are module constants (no input)',
  OWNER_ONLY_LINEAGE_PRESENT_SQL: 'src/core/access/owner-only.ts: the constant v320 lineage function call `gbrain_owner_only_lineage()` (no input)',
  FACT_POOL_COLUMNS: 'src/core/engine-sql/facts-trust.ts: constant select list of the facts pool columns (no input)',
  READ_SOURCE_OWNER_ONLY_SQL: 'src/core/access/owner-only.ts: constant owner-only row test of the sources alias read_source; the kinds and flag key are module constants (no input)',
  EXPIRED_ARCHIVE_SQL: 'src/core/engine-sql/sources.ts: constant archive-window-elapsed predicate over sources (no input)',
  UNVERIFIED_ARCHIVE_SQL: 'src/core/engine-sql/sources.ts: constant missing-or-epoch archive-time predicate over sources (no input)',
  TRUST_CLAIMED_COLUMN_SQL: 'src/core/engine-sql/doctor-facts-trust.ts: a module constant built only from code constants (as on the main branch); no values',
  TRUST_NOT_CONNECTOR_SQL: 'src/core/engine-sql/doctor-facts-trust.ts: a module constant built only from code constants (as on the main branch); no values',
  NON_TEXT_FRONTMATTER_KEYS_SQL: 'src/core/persistence/content-author-schema.ts: constant text[] literal of the code-constant NON_TEXT_FRONTMATTER_KEYS (GST-4056); no values',
};

const VETTED_BUILDERS: Record<string, string> = {
  pageReadFilter: 'src/core/search/read-policy-sql.ts: binds scope values as params, splices only the caller alias',
  buildHardExcludeClause: 'src/core/search/sql-ranking.ts: LIKE-escaped and SQL-escaped slug prefix literals (buildLikePrefixLiteral), the ranked-search hard-exclude clause',
  buildRecencyComponentSql: 'src/core/search/sql-ranking.ts: inlines LIKE literals + numeric coefficients from the decay map, as master (planner behavior)',
  privatePagesFilterFragment: 'src/core/search/private-visibility.ts: constant visibility predicate over a caller alias',
  privatePagesFilterForCaller: 'src/core/search/private-visibility.ts: privatePagesFilterFragment ORed with the private-readable source ids, each checked by isValidSourceId (alphabet [a-z0-9-], no quote) before it is quoted in',
  privateLinkOriginFilterForCaller: 'src/core/search/private-visibility.ts: constant link-origin predicate ORed with isValidSourceId-checked private-readable source ids',
  privateTimelineEventFilterForCaller: 'src/core/search/private-visibility.ts: constant timeline-event predicate ORed with isValidSourceId-checked private-readable source ids',
  ownerOnlyTakeAllowedSql: 'src/core/search/private-visibility.ts: empty for the owner, else NOT the owner-only lineage test (access/owner-only.ts) on a code-provided take alias: constant function names and table literal, no values',
  orPrivateReadableSource: 'src/core/search/private-visibility.ts: wraps a caller predicate with isValidSourceId-checked private-readable source ids quoted as literals',
  replacedBecauseSql: 'src/core/engine-sql/pages.ts: constant GBRA-217 reason projection over a caller alias, with callerReadersAllowedSql on the successor (identities checked by validIdentity before they are quoted in); the boolean picks one of two constant texts',
  validDateSql: 'src/core/valid-time.ts: constant GBRA-217 date normaliser over a caller column expression; engine-sql passes only constant pv.frontmatter keys',
  quarantineFilterFragment: 'src/core/quarantine.ts: constant quarantine predicate over a caller alias',
  guestSourceExclusionSql: 'src/core/guests/derived.ts: GBRA-504 constant guest-source NOT EXISTS predicate (guests/note.ts guestSourceSql) over a caller alias, or TRUE for a producer that takes guest input; the producer key is a typed union member; no values',
  currentCodeEdgeFilter: 'src/core/code-intel/read-scope.ts: constant current-edge predicate over a caller alias',
  buildCJKKeywordSql: 'src/core/search/cjk-keyword-sql.ts: binds the query as params; shared by both engines',
  currentTextProjectionFilter: 'src/core/search/safe-chunks.ts: constant projection predicate over a caller alias',
  servedTextProjectionFilter: 'src/core/search/safe-chunks.ts: constant projection predicate over a caller alias, ORed with the constant v153 served-index marker (#9192)',
  chunkVisibleFilter: 'src/core/search/safe-chunks.ts: constant projection + live body generation predicate over caller page/chunk aliases (Wave B)',
  chunkGenerationFilter: 'src/core/search/safe-chunks.ts: constant live body generation predicate over caller page/chunk aliases (Wave B)',
  chunkManifestJoin: 'src/core/search/safe-chunks.ts: constant LEFT JOIN onto the live page_body_manifest row over caller aliases (Wave B)',
  chunkDocumentOrder: 'src/core/search/safe-chunks.ts: constant ORDER BY column list over caller chunk/manifest aliases (Wave B)',
  quoteIdentifier: 'src/core/search/embedding-column.ts: double-quoted identifier (embedded quotes doubled); callers pass registry-resolved or COLUMN_NAME_REGEX-checked embedding column names',
  vectorCastSuffix: 'src/core/search/embedding-column.ts: constant ::vector / ::halfvec cast suffix from the resolved column type',
  safeChunksFilter: 'src/core/search/safe-chunks.ts: constant safe-chunk predicate over a caller alias',
  pageBudgetLimitedFilter: 'src/core/page-size-policy.ts: constant held-or-capped budget predicate over a caller page alias; no values',
  movableChunkSql: 'src/core/search/safe-chunks.ts: constant vector-matches-its-text predicate over a caller-quoted embedding column; no values',
  bodyWriteChunkVersion: 'src/core/search/safe-chunks.ts: constant chunker-version CASE over caller column expressions (or master\'s literal $1/$2 bind reuse); no values',
  privateLinkOriginFilterFragment: 'src/core/search/private-visibility.ts: constant link-origin visibility predicate over a caller alias',
  privateTimelineEventFilterFragment: 'src/core/search/private-visibility.ts: constant timeline-event visibility predicate over a caller alias',
  privateSnapshotFilterFragment: 'src/core/search/private-visibility.ts: constant snapshot visibility predicate over a caller alias',
  rederiveHiddenSql: 'src/core/eligibility/sql.ts: constant needs_rederive NOT EXISTS predicate over a literal table name and caller alias; no values',
  deletedPageProjectionHiddenSql: 'src/core/eligibility/sql.ts: constant soft-deleted-page NOT EXISTS predicate over a literal table name and caller alias; no values',
  privateFactFilterForCaller: 'src/core/search/private-visibility.ts: privateProvenanceFilterFragment ANDed with privateEntityFilterForCaller (the caller page policy over a constant entity-page alias); no values',
  privateProvenanceFilterFragment: 'src/core/search/private-visibility.ts: constant fact-provenance visibility predicate over a caller alias',
  readersAllowedSql: 'src/core/search/private-visibility.ts: GBRA-218 readers predicate over a caller alias; splices only identities that pass validIdentity (member:/group: plus [a-z0-9._-]), else none',
  callerReadersAllowedSql: 'src/core/search/private-visibility.ts: GBRA-231 readersAllowedSql for the current caller, one conjunct per audience identity; each identity passes validIdentity',
  privacyForCaller: 'src/core/search/private-visibility.ts: the caller privacy arm (TRUE, or the given predicate ORed with private-readable source ids checked by isValidSourceId); callers pass a constant alias and a vetted predicate builder',
  factVisibilitySql: 'src/core/access/member-facts.ts: visibility values filtered to the constant set world/private; widened only by memberFactAdmitSql, whose member id passed ACCESS_ID_RE (no quote) and whose page test is privatePagesFilterForCaller; no values',
  onOwnedMemoryPageSql: 'src/core/access/member-facts.ts: constant memory/members/ prefix and memory/scope slug test over a code-provided facts alias; no values',
  privateProvenanceFilterUnderPolicy: 'src/core/search/private-visibility.ts: constant fact-provenance predicate (readers part with no identity, or the caller identity on its own member page whose id passed ACCESS_ID_RE; privacy part dropped only under an operator relaxation); no values',
  liveTilingSql: 'src/core/page-body/schema.ts: constant LATERAL aggregate of the live manifest rows of a caller page alias (count, covered bytes, gapless); no values (GST-1209)',
  untiledSql: 'src/core/page-body/schema.ts: constant predicate over caller page and tiling aliases; no values (GST-1209)',
  stagingNeedsTextSql: 'src/core/page-body/schema.ts: constant live-staging text-reference EXISTS predicate over a caller text alias; no values (Wave B purge)',
  atomRetirementPurgeHold: 'src/core/persistence/atom-retirement-hold.ts: constant #7013 restorable-atom purge-hold predicate over a caller pages alias; no values',
  derivedRetirementPurgeHold: 'src/core/persistence/derived-retirement-hold.ts: constant GBRA-161 derived-retirement purge-hold predicate over a caller pages alias; no values',
  derivedOriginPurgeHold: 'src/core/persistence/derived-origin-hold.ts: constant GST-2689 parked-origin purge-hold predicate over a caller pages alias; no values',
  pageSearchVectorSql: 'src/core/fts-language.ts: constant page search_vector expression (setweight/to_tsvector) over caller SQL expressions; the language passes VALID_CONFIG_NAME ([a-z][a-z0-9_]*) or falls back to the default, and PAGE_TIMELINE_FTS_MAX_CHARS is a code constant',
  rankingLinkSql: 'src/core/link-ranking-policy.ts: constant non-ranking link-type predicate (code-constant type names) over a caller alias',
  boundedBodyPrefixSql: 'src/core/page-window/bounded-lead.ts: constant bounded body-prefix expression (BOUNDED_PREFIX_BYTES literal) over a caller page alias; no values',
  retiredPageSql: 'src/core/entities/resolve.ts: constant retired-page frontmatter predicate over a caller alias; no values',
  vectorLiteralSql: 'src/core/engine-sql/facts.ts: master\'s inlined vector literal; toPgVectorLiteral output (numbers joined by commas) + a ::vector/::halfvec constant',
  temporalLinkJoinSql: 'src/core/link-validity.ts: constant LEFT JOIN onto link_relationships over a caller alias; scope is one of two literals',
  projectionEligibleSql: 'src/core/eligibility/sql.ts: read-eligibility predicate over a caller alias; splices only closed tier and reason-family vocabularies (no values)',
  pageEligibleSql: 'src/core/eligibility/sql.ts: page trust-floor and activation predicate over a caller alias; closed vocabularies only',
  relationshipFilterSql: 'src/core/link-validity.ts: relationship-state probe over a caller alias; dates pass isCalendarDate and inline as DATE literals, status/scope are literals',
  tokenGrantSelectList: 'src/core/engine-sql/persistence-journal.ts: the constant TOKEN_GRANT_ROW_COLUMNS names (grants/model.ts) this brain\'s access_tokens has, joined by commas; no values',
  projectionClassSql: 'src/core/page-state/projection-class.ts: constant projection class CASE over caller page/source aliases (module constants only, no values)',
  remoteReadFloorSql: 'src/core/search/private-visibility.ts: privatePagesFilterFragment, plus the constant labelledOnlySql conjunct for a labelled-only caller, over a caller page alias; no values',
  renderWriterReadPolicy: 'src/core/engine-sql/remote-links.ts: readPolicyFragment over a code-provided alias, ANDed (labelled-only writer) with labelledOnlyForSql, whose identities pass validIdentity and rule ids validQualifiedRuleId before they are quoted in; no values',
  privacyPartSql: 'src/core/search/private-visibility.ts: the constant privacy part (snapshot, derived-origin and declared-lineage tests) over a code-provided page alias; no values',
  activationSuppressedSql: 'src/core/eligibility/sql.ts: constant activation-suppression predicate over a caller alias; tier ranks and reason families come from constant tables',
  textFrontmatterSql: 'src/core/persistence/content-author-schema.ts: constant CASE removing NON_TEXT_FRONTMATTER_KEYS_SQL from a code-provided frontmatter expression (GST-4056); no values',
  edgeTrimSql: 'src/core/edge-whitespace.ts: btrim of a code-provided constant expression over the constant EDGE_WHITESPACE set; no values',
  precedenceSql: 'src/core/eligibility/precedence.ts: constant source-precedence CASE over caller-given constant aliases and the vetted guest predicate (no input)',
  guestSourceSql: 'src/core/guests/note.ts: constant guest-source predicate over caller-given constant aliases (no input)',
  contestedRefSql: 'src/core/eligibility/sql.ts: constant pending-supersede-proposal subquery over a caller alias; the table name comes from the facts/takes union, the actions are literals; no values',
  holdAppliesToPageSql: 'src/core/write-gate-binding.ts: the quarantine-hold page match (bound id, unbound slug, candidates, rename reach) over constant hold alias and SQL expressions the caller passes as literals; no input',
  heldRowSql: 'src/core/eligibility/fence-overlay.ts: the held fence-cell test over constant key column aliases; widened only by memberFactAdmitSql (member id passed ACCESS_ID_RE) and grantedPrivateFactSql (each source id checked by isValidSourceId before it is quoted in); no values',
  embeddingCandidateWhere: 'src/core/engine-sql/persistence-effect-scans.ts: the constant stale-embedding-effect predicate; its error codes pass assertCandidateCodes (each code must match /^[a-z0-9_]+$/) before they are spliced into the text[] literal; no caller values',
  outcomeMarkerSql: 'src/core/facts/audit-sources.ts: constant checkpoint-row predicate over a caller facts alias; the source and fact lists are module constants',
  unbackedEntitySql: 'src/core/facts/withdrawal-schema.ts: constant unbacked-name-key predicate over a caller facts alias; the callers pass constant aliases',
  remoteProvenanceFloorSql: 'src/core/search/private-visibility.ts: constant remote provenance floor (private-provenance filter plus labelled-only) over a caller facts alias',
  ownedMemorySubjectSql: 'src/core/facts/withdrawal-schema.ts: constant owned-memory-subject predicate over a caller column expression; engine-sql passes only the constant column q.subject',
  holdingSlugSql: 'src/core/facts-fence.ts: constant holding-page slug predicate over a caller column expression; the callers pass constant aliases (hp.slug, f.entity_slug); no values',
  derivationSweepScopeSql: 'src/core/page-body/schema.ts: constant sweep-scope predicate over caller aliases d and p with a hand-numbered page-id placeholder bound by the caller; no values',
  derivationAfterSql: 'src/core/page-body/segment-derive.ts: constant key-after predicate over the caller alias d with three hand-numbered cursor placeholders bound by the caller; no values',
  derivationHoldsClaimSql: 'src/core/page-body/schema.ts: constant holds-claim predicate over the caller alias d with hand-numbered needle and pattern placeholders bound by the caller; no values',
  derivationClaimCandidateSql: 'src/core/page-body/schema.ts: constant claim-candidate predicate over the caller alias d with a hand-numbered pattern placeholder bound by the caller; no values',
  liveStagingSql: 'src/core/page-body/schema.ts: constant live-staging predicate over the staging alias s; no values',
  carriesClaimSql: 'src/core/facts/purge-verify.ts: constant carries-claim predicate over a caller alias; the caller passes the placeholder number, no values',
  conversationSlotSql: 'src/core/engine-sql/facts-trust.ts: CONVERSATION_SLOT_SQL, the constant conversation-source prefix test; no values',
  quarantinedProvenanceFilterFragment: 'src/core/quarantine.ts: constant fact-provenance quarantine predicate over a caller alias; no values',
  withdrawalCoversFactSql: 'src/core/access/member-facts.ts: constant withdrawal-covers-fact predicate over caller withdrawal and fact aliases; no values',
  contextHeadSql: 'src/core/facts/gone-page-facts.ts: constant head-of-context expression over a caller facts alias; no values',
  factsFtsDocument: 'src/core/fts-language.ts: constant facts full-text document expression over a caller alias; the language passes VALID_CONFIG_NAME or falls back to the default',
  getFtsLanguage: 'src/core/fts-language.ts: the brain full-text config name; passes VALID_CONFIG_NAME ([a-z][a-z0-9_]*) or falls back to the default',
  grantedPrivateFactSql: 'src/core/access/member-facts.ts: private-facts grant predicate over a caller alias; granted source ids passed isValidSourceId, so they embed as literals',
  privateFactFilterForReader: 'src/core/search/private-visibility.ts: constant private-provenance predicate over a caller facts alias; the caller record picks among constant fragments and binds no value',
  savedFactCollapseColumns: 'src/core/engine-sql/facts-trust.ts: SAVED_FACT_COLLAPSE_COLUMNS, the constant select list the capture-dedup collapse reads; no values',
  trustRankSql: 'src/core/trust/tier.ts: CASE mapping a caller column expression to a rank from the constant tier table; callers pass a column, never a value',
  claimPendingSql: 'src/core/trust/claim-state.ts: constant claim-pending predicate over a caller sources alias; config keys are module constants',
  claimBucketSql: 'src/core/facts/typed-claim.ts: constant CASE bucketing a caller facts alias\'s claim_period and valid_from from the constant cadence tables; no values',
  oversizedEligibleSql: 'src/core/engine-sql/facts-trust.ts: returns the constant eligibleFactEmbedding predicate (embedding-identity.ts, placeholder $2 audit sources bound by the caller); no values',
  oversizedStaleSql: 'src/core/engine-sql/facts-trust.ts: returns the constant staleFactEmbedding predicate (embedding-identity.ts, placeholders $3 model and $4 width bound by the caller); no values',
  oversizedScanCapSql: 'src/core/engine-sql/facts-trust.ts: the OVERSIZED_SCAN_CAP module constant as text (a fixed integer, no input)',
  contestedReadableSql: 'src/core/engine-sql/facts-trust.ts: constant active and readable predicate over a caller-given constant facts alias; the policy picks among constant fragments (privateFactFilterForCaller, projectionEligibleSql) and binds no value',
  withdrawalReachedFactSql: 'src/core/access/member-facts.ts: constant withdrawal-reached-fact predicate over caller withdrawal and fact aliases; no values',
  memberReadsSql: 'src/core/engine-sql/facts-trust.ts: ownerReadPolicyFragment or readPolicyFragment over a constant page alias; identities and rule ids are checked by validIdentity and validQualifiedRuleId before they are quoted in (see those entries)',
  readPolicyFragment: 'src/core/search/private-visibility.ts: accessAllowedForAllSql (readers identities checked by validIdentity before they are quoted in) AND the constant privacyPartSql or TRUE over a caller page alias; no values',
};

const SQL_ARG_METHODS: Record<string, number> = { query: 0, unsafe: 0, executeRaw: 0 };
const SQL_ARG_FUNCTIONS: Record<string, number> = { executeRawJsonb: 1 };

const FIX = {
  trusted: "bind the value through sqlFragment (`${value}`), or splice only a string literal, an `as const` allowlist member, a VETTED_BUILDERS call or a Number.isFinite-checked number",
  composed: 'build the statement with sqlFragment and run it with executor.run(fragment)',
  placeholder: 'drop the hand-written $n: interpolate the value in sqlFragment and let renderFragment number it',
  list: 'bind the array as one parameter: `= ANY(${ids}::text[])` in sqlFragment (renders `= ANY($n::text[])`)',
};

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)) {
    if (ts.isAsExpression(e) && isConstAssertion(e)) return e;
    e = e.expression;
  }
  return e;
}

function isConstAssertion(e: ts.AsExpression): boolean {
  return ts.isTypeReferenceNode(e.type) && ts.isIdentifier(e.type.typeName) && e.type.typeName.text === 'const';
}

function rootIdentifier(expr: ts.Expression): ts.Identifier | null {
  let e = unwrap(expr);
  while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) e = unwrap(e.expression);
  return ts.isIdentifier(e) ? e : null;
}

function enclosingFunction(node: ts.Node): ts.Node | undefined {
  for (let n = node.parent; n; n = n.parent) if (ts.isFunctionLike(n)) return n;
  return undefined;
}

function isNumericGuarded(expr: ts.Expression, sf: ts.SourceFile): boolean {
  const e = unwrap(expr);
  if (ts.isNumericLiteral(e)) return true;
  if (!ts.isIdentifier(e) && !ts.isPropertyAccessExpression(e)) return false;
  const fn = enclosingFunction(e);
  if (!fn) return false;
  const target = e.getText(sf);
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found || n.getStart(sf) >= e.getStart(sf)) return;
    if (
      ts.isCallExpression(n) && n.arguments.length === 1 && n.expression.getText(sf) === 'Number.isFinite'
      && unwrap(n.arguments[0]).getText(sf) === target
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(fn);
  return found;
}

class FileScan {
  readonly violations: string[] = [];
  private readonly consts = new Map<string, ts.VariableDeclaration[]>();
  private readonly lets = new Map<string, ts.VariableDeclaration[]>();

  constructor(private readonly sf: ts.SourceFile, private readonly rel: string) {
    const collect = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && ts.isVariableDeclarationList(n.parent)) {
        const map = n.parent.flags & ts.NodeFlags.Const ? this.consts : this.lets;
        map.set(n.name.text, [...(map.get(n.name.text) ?? []), n]);
      }
      ts.forEachChild(n, collect);
    };
    collect(sf);
  }

  private fail(node: ts.Node, what: string, fix: string): void {
    const line = this.sf.getLineAndCharacterOfPosition(node.getStart(this.sf)).line + 1;
    this.violations.push(`FAIL: ${this.rel}:${line} ${what}\n      Fix: ${fix}`);
  }

  private text(node: ts.Node): string {
    return node.getText(this.sf).replace(/\s+/g, ' ').slice(0, 80);
  }

  private declarationFor(id: ts.Identifier, map: Map<string, ts.VariableDeclaration[]>): ts.VariableDeclaration | undefined {
    const decls = map.get(id.text);
    if (!decls) return undefined;
    const scopeOf = (n: ts.Node) => enclosingFunction(n) ?? this.sf;
    const scopes: ts.Node[] = [];
    for (let s: ts.Node | undefined = scopeOf(id); s; s = s === this.sf ? undefined : scopeOf(s)) scopes.push(s);
    for (const scope of scopes) {
      const hit = decls.find((d) => scopeOf(d) === scope && d.getStart(this.sf) < id.getStart(this.sf));
      if (hit) return hit;
    }
    return undefined;
  }

  isTrusted(expr: ts.Expression, seen = new Set<ts.Node>()): boolean {
    const e = unwrap(expr);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return true;
    if (ts.isAsExpression(e)) return ts.isObjectLiteralExpression(unwrap(e.expression)) || ts.isArrayLiteralExpression(unwrap(e.expression));
    if (ts.isConditionalExpression(e)) return this.isTrusted(e.whenTrue, seen) && this.isTrusted(e.whenFalse, seen);
    if (ts.isTemplateExpression(e)) return e.templateSpans.every((s) => this.isTrusted(s.expression, seen) || isNumericGuarded(s.expression, this.sf));
    if (ts.isCallExpression(e)) return ts.isIdentifier(e.expression) && e.expression.text in VETTED_BUILDERS;
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return plusOperands(e).every((o) => this.isTrusted(o, seen) || isNumericGuarded(o, this.sf));
    }
    const root = rootIdentifier(e);
    if (!root || (root !== e && !ts.isPropertyAccessExpression(e) && !ts.isElementAccessExpression(e))) return false;
    if (root.text in CONSTANT_ALLOWLIST) return true;
    const decl = this.declarationFor(root, this.consts);
    if (!decl?.initializer || seen.has(decl)) return false;
    seen.add(decl);
    return this.isTrusted(decl.initializer, seen);
  }

  private checkComposedSql(arg: ts.Expression, call: ts.CallExpression, seen = new Set<ts.Node>()): void {
    const e = unwrap(arg);
    if (ts.isTemplateExpression(e)) {
      for (const span of e.templateSpans) {
        if (!this.isTrusted(span.expression) && !isNumericGuarded(span.expression, this.sf)) {
          this.fail(span.expression, `untrusted \${${this.text(span.expression)}} in SQL passed to ${this.text(call.expression)}()`, FIX.composed);
        }
      }
      return;
    }
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      for (const operand of plusOperands(e)) {
        if (!this.isTrusted(operand) && !isNumericGuarded(operand, this.sf)) {
          this.fail(operand, `untrusted operand '${this.text(operand)}' concatenated into SQL passed to ${this.text(call.expression)}()`, FIX.composed);
        }
      }
      return;
    }
    if (!ts.isIdentifier(e)) return;
    const decl = this.declarationFor(e, this.consts) ?? this.declarationFor(e, this.lets);
    if (!decl || seen.has(decl)) return;
    seen.add(decl);
    if (decl.initializer) this.checkComposedSql(decl.initializer, call, seen);
    const fn = enclosingFunction(decl) ?? this.sf;
    const visit = (n: ts.Node): void => {
      if (
        ts.isBinaryExpression(n) && ts.isIdentifier(n.left) && n.left.text === e.text
        && (n.operatorToken.kind === ts.SyntaxKind.EqualsToken || n.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)
      ) {
        if (n.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken && !this.isTrusted(n.right) && !isNumericGuarded(n.right, this.sf)) {
          this.fail(n.right, `untrusted '${this.text(n.right)}' appended to SQL passed to ${this.text(call.expression)}()`, FIX.composed);
        } else this.checkComposedSql(n.right, call, seen);
      }
      ts.forEachChild(n, visit);
    };
    visit(fn);
  }

  private checkTemplateText(node: ts.TemplateExpression | ts.NoSubstitutionTemplateLiteral, composed: boolean): void {
    const pieces = ts.isTemplateExpression(node) ? [node.head, ...node.templateSpans.map((s) => s.literal)] : [node];
    pieces.forEach((piece, i) => {
      const beforeSub = i < pieces.length - 1;
      if (composed && (/\$\d/.test(piece.text) || (beforeSub && piece.text.endsWith('$')))) {
        this.fail(piece, 'literal $<digit> placeholder in a composed SQL string', FIX.placeholder);
      }
      if (beforeSub && /\bIN\s*\(\s*$/i.test(piece.text)) this.fail(piece, 'expanded IN (...) list built from a substitution', FIX.list);
    });
  }

  private checkConcat(node: ts.BinaryExpression): void {
    const operands = plusOperands(node);
    operands.forEach((operand, i) => {
      if (!ts.isStringLiteral(operand) && !ts.isNoSubstitutionTemplateLiteral(operand)) return;
      if (/\$\d/.test(operand.text)) this.fail(operand, 'literal $<digit> placeholder in a concatenated SQL string', FIX.placeholder);
      const next = operands[i + 1];
      if (next && !ts.isStringLiteral(next) && !ts.isNoSubstitutionTemplateLiteral(next) && /\bIN\s*\(\s*$/i.test(operand.text)) {
        this.fail(operand, 'expanded IN (...) list built by concatenation', FIX.list);
      }
    });
  }

  run(): void {
    const visit = (n: ts.Node): void => {
      if (ts.isTaggedTemplateExpression(n)) {
        const isFragment = ts.isIdentifier(n.tag) && n.tag.text === 'sqlFragment';
        this.checkTemplateText(n.template, isFragment);
      } else if (ts.isTemplateExpression(n) && !ts.isTaggedTemplateExpression(n.parent)) {
        this.checkTemplateText(n, true);
      } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken
        && !(ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === ts.SyntaxKind.PlusToken)) {
        this.checkConcat(n);
      }
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        if (ts.isIdentifier(callee) && callee.text === 'trustedSql') {
          const arg = n.arguments[0];
          if (!arg || !this.isTrusted(arg)) {
            this.fail(n, `trustedSql(${arg ? this.text(arg) : ''}) splices text that is not constant`, FIX.trusted);
          }
        }
        const index = ts.isPropertyAccessExpression(callee)
          ? SQL_ARG_METHODS[callee.name.text]
          : ts.isIdentifier(callee) ? SQL_ARG_FUNCTIONS[callee.text] : undefined;
        const sqlArg = index === undefined ? undefined : n.arguments[index];
        if (sqlArg) this.checkComposedSql(sqlArg, n);
      }
      ts.forEachChild(n, visit);
    };
    visit(this.sf);
  }
}

function plusOperands(node: ts.Expression): ts.Expression[] {
  const e = unwrap(node);
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) return [...plusOperands(e.left), ...plusOperands(e.right)];
  return [e];
}

const files = tsFiles(join(ROOT, SCAN_DIR)).filter((abs) => !(relative(join(ROOT, SCAN_DIR), abs).replace(/\\/g, '/') in EXEMPT_FILES));
const violations: string[] = [];
for (const abs of files) {
  const rel = relative(ROOT, abs).replace(/\\/g, '/');
  const scan = new FileScan(ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), rel);
  scan.run();
  violations.push(...scan.violations);
}

if (violations.length) {
  for (const v of violations) console.error(v);
  console.error('Why:  engine-sql binds every value as a parameter and splices only constant text; composed $n, expanded IN lists and raw interpolation are how injection and unbounded prepared-statement caches start (CQ3 / EO8).');
  console.error(`See:  ${ANCHOR}`);
  console.error(`check-engine-sql-dynamic: ${violations.length} violation(s)`);
  process.exit(1);
}
console.log(`check-engine-sql-dynamic: ok (${files.length} files)`);
