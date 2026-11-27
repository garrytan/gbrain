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
  SPELLING_KEY_SQL: 'src/core/slug-spelling-key.ts: the constant spelling-index key expression over pages.slug (no input); the migration v335 index uses the same text, so the planner matches it',
  SCAN_KEY_SQL: 'src/core/slug-spelling-key.ts: the constant ASCII scan key expression over pages.slug (no input)',
  EFFECT_BYTES_SQL: 'src/core/persistence/receipt-bytes.ts: constant per-row byte expression over persistence_effects columns (no input); spliced by engine-sql/page-purge-journal.ts readEffectBytes',
  ENRICH_ORDER_SQL: 'src/core/types.ts: ORDER BY text keyed by the EnrichCandidatesOpts order union (whitelisted enum)',
  SOURCE_CONFIG_OBJECT_SQL: 'src/core/source-config-sql.ts: static sources.config coercion expression (no input)',
  EMBED_SKIP_FILTER_FRAGMENT: 'src/core/embed-skip.ts: constant embed_skip predicate over alias p',
  QUARANTINE_FILTER_FRAGMENT: 'src/core/quarantine.ts: constant quarantine visibility predicate over the pages alias p',
  PAGE_SORT_SQL: 'src/core/types.ts: ORDER BY text keyed by the PageFilters sort union (whitelisted enum)',
  TEMPORAL_LINK_SELECT_SQL: 'src/core/link-validity.ts: constant select list over the lr_t relationship-state join',
  GUEST_SOURCES_HIDDEN_SQL: 'src/core/guests/note.ts: constant row-security probe of guest_sources (no input)',
  ANY_OWNER_ONLY_SQL: 'src/core/access/owner-only.ts: constant any-owner-only-source EXISTS over sources read_source; the kinds and flag key are module constants (no input)',
  OWNER_ONLY_LINEAGE_PRESENT_SQL: 'src/core/access/owner-only.ts: the constant v320 lineage function call `gbrain_owner_only_lineage()` (no input)',
  READ_SOURCE_OWNER_ONLY_SQL: 'src/core/access/owner-only.ts: constant owner-only row test of the sources alias read_source; the kinds and flag key are module constants (no input)',
  CONNECTOR_KIND_LIST_SQL: 'src/core/persistence/connector-kinds.ts: constant parenthesized list of the code-constant connector kinds (no input)',
  ACTIVATION_SERVED_REVISION: 'src/core/search/safe-chunks.ts: the constant v153 served-index marker uuid (#9192); no input',
  UNBACKED_FACT_SQL: 'src/core/engine-sql/fact-relink-writes.ts: constant live-row-on-an-unbacked-name-key predicate over the facts alias f (unbackedEntitySql plus LIVE_FACT_SQL); no input',
  ACTIVE_UNLINKED_FACT_SQL: 'src/core/engine-sql/fact-relink-writes.ts: constant live-row-with-no-entity predicate over the facts alias f; no input',
  REDACT_PURGED_KEYS_LEGACY_SQL: 'src/core/belief/legacy-fingerprint.ts: the constant purged-key redaction UPDATE with the legacySubjectKeysSql CTE over the constant factFingerprintV2Sql (placeholders $1 to $4 bound by redactPurgedBeliefKeys); no input',
  FACT_POOL_COLUMNS: 'src/core/engine-sql/facts-trust.ts: constant select list of the facts pool columns (no input)',
  RELEASE_STAGED_CTE: 'src/core/persistence/limits.ts: constant CTE releasing upload reservations of a preceding gone CTE (no input)',
  EXPIRED_ARCHIVE_SQL: 'src/core/engine-sql/sources.ts: constant archive-window-elapsed predicate over sources (no input)',
  UNVERIFIED_ARCHIVE_SQL: 'src/core/engine-sql/sources.ts: constant missing-or-epoch archive-time predicate over sources (no input)',
  CREDENTIAL_RESEAL_HELD: 'src/core/page-state/credential-reseal-hold.ts: constant live-credential-re-chunk-hold predicate over the pages alias p; the op and producer are module constants (no input)',
  NOT_CONVERSATION_SLOT_SQL: 'src/core/chronicle/ontology.ts: constant conversation-source prefix exclusion over the facts source column (no input)',
};

const VETTED_BUILDERS: Record<string, string> = {
  catalogIdentifierSql: 'src/core/engine-sql/eval-harness-reads.ts: a table or column name read from information_schema (listTextBearingColumns), double-quoted with every double quote doubled; no values',
  catalogScanHeadSql: 'src/core/engine-sql/eval-harness-reads.ts: constant slug, page id and entity projections over alias x, with catalog column names quoted by catalogIdentifierSql; no values',
  catalogScanColumnSql: 'src/core/engine-sql/eval-harness-reads.ts: one catalog column of alias x, quoted by catalogIdentifierSql, cast to text; no values',
  catalogScanJoinSql: 'src/core/engine-sql/eval-harness-reads.ts: the constant LEFT JOIN of pages on alias x\'s page id, or nothing; no values',
  catalogScanLiveSql: 'src/core/engine-sql/eval-harness-reads.ts: constant live-row predicates (expired_at, deleted_at, takes.active, the page join) chosen by which catalog columns exist; no values',
  // access-grants.ts builders
  tokenGrantColumnList: 'src/core/engine-sql/access-grants.ts (from grants/model.ts): joins only TOKEN_GRANT_ROW_COLUMNS constant names, filtered by which ones pg_attribute reports present; no values',
  // facts-rest-sites builders (facts-trust.ts, facts-recall.ts)
  oversizedEligibleSql: 'src/core/engine-sql/facts-trust.ts: returns the constant eligibleFactEmbedding predicate (embedding-identity.ts, placeholder $2 audit sources bound by the caller); no values',
  oversizedStaleSql: 'src/core/engine-sql/facts-trust.ts: returns the constant staleFactEmbedding predicate (embedding-identity.ts, placeholders $3 model and $4 width bound by the caller); no values',
  oversizedScanCapSql: 'src/core/engine-sql/facts-trust.ts: the OVERSIZED_SCAN_CAP module constant as text (a fixed integer, no input)',
  contestedReadableSql: 'src/core/engine-sql/facts-trust.ts: constant active and readable predicate over a caller-given constant facts alias; the policy picks among constant fragments (privateFactFilterForCaller, projectionEligibleSql) and binds no value',
  memberReadsSql: 'src/core/engine-sql/facts-trust.ts: ownerReadPolicyFragment or readPolicyFragment over a constant page alias; identities and rule ids are checked by validIdentity and validQualifiedRuleId before they are quoted in (see those entries)',
  withdrawalReachedFactSql: 'src/core/access/member-facts.ts: constant withdrawal-reached-fact predicate over caller withdrawal and fact aliases; no values',
  // belief-ledger.ts builders (pre-v353 fingerprint probes)
  factFingerprintV2Sql: 'src/core/facts/withdrawal-schema.ts: the pre-v353 fingerprint expression with the caller\'s constant column or alias name substituted for `claim`, over the FACT_SPACE_CLASS and FINGERPRINT_PUNCTUATION constants; no values',
  legacyFingerprintV2Sql: 'src/core/facts/withdrawal-schema.ts: CASE over the same constants around factFingerprintV2Sql of the caller\'s constant column or alias name; no values',
  // facts-doctor.ts builders
  entityLinkableSql: 'src/core/engine-sql/facts-doctor.ts: returns the constant ENTITY_LINKABLE_SQL predicate (attribution.ts) over the facts alias f; no values',
  relinkTriedSql: 'src/core/engine-sql/facts-doctor.ts: the constant conversationTriedSql EXISTS predicate (conversation-memo.ts; code-constant outcome and reason codes) or the literal false; no values',
  relinkPaidSql: 'src/core/engine-sql/facts-doctor.ts: the constant conversationPaidSql EXISTS predicate (conversation-memo.ts; code-constant tier) or the literal false; no values',
  staleFactEmbeddingSql: 'src/core/engine-sql/facts-doctor.ts: returns the constant staleFactEmbedding predicate (embedding-identity.ts, placeholders $3 model and $4 width bound by the caller); no values',
  partiallyEmbeddedFactSql: 'src/core/engine-sql/facts-doctor.ts: returns the constant partiallyEmbeddedFact predicate (embedding-identity.ts, EMBED_MAX_CHARS literal); no values',
  eligibleFactEmbeddingSql: 'src/core/engine-sql/facts-doctor.ts: returns the constant eligibleFactEmbedding predicate (embedding-identity.ts, placeholder $2 audit sources bound by the caller); no values',
  factSourceScopeSql: 'src/core/engine-sql/facts-doctor.ts: constant optional-source scope over the facts alias f with the hand-numbered $1 source id bound by the caller; no values',

  // doctor-derived.ts builders
  withEmbeddingColumn: 'src/core/engine-sql/doctor-derived.ts: constant statement with one "__COL__" marker replaced by an embedding column that matches COLUMN_NAME_REGEX (^[a-z_][a-z0-9_]*$) or throws; no values',

  // facts-cycle.ts builders
  readersSourcedFactSql: 'src/core/access/member-facts.ts: constant readers-sourced predicate over a caller facts alias; the folder-rule fragment it embeds is constant',
  privateFactFilterForReader: 'src/core/search/private-visibility.ts: constant private-provenance predicate over a caller facts alias; the caller record picks among constant fragments and binds no value',
  claimDateSql: 'src/core/engine-sql/facts-cycle.ts: constant date-claim predicate over caller-given constant column aliases; the date token and floor are module constants (no input)',

  // facts-purge.ts builders
  outcomeMarkerSql: 'src/core/facts/audit-sources.ts: constant checkpoint-row predicate over a caller facts alias; the source and fact lists are module constants',
  unbackedEntitySql: 'src/core/facts/withdrawal-schema.ts: constant unbacked-name-key predicate over a caller facts alias; the callers pass constant aliases',
  ownedMemorySubjectSql: 'src/core/facts/withdrawal-schema.ts: constant owned-memory-subject predicate over a caller column expression; engine-sql passes only the constant column q.subject',
  remoteProvenanceFloorSql: 'src/core/search/private-visibility.ts: constant remote provenance floor (private-provenance filter plus labelled-only) over a caller facts alias',
  liveStagingSql: 'src/core/page-body/schema.ts: constant live-staging predicate over the staging alias s; no values',
  carriesClaimSql: 'src/core/facts/purge-verify.ts: constant carries-claim predicate over a caller alias; the caller passes the placeholder number, no values',
  holdingSlugSql: 'src/core/facts-fence.ts: constant holding-page slug predicate over a caller column expression; the callers pass constant aliases (hp.slug, f.entity_slug); no values',
  extractedFromPageSql: 'src/core/facts/gone-page-facts.ts: constant extracted-from-page predicate over a caller facts alias and slug expression; the source list is a module constant; engine-sql passes f and g.slug; no values',
  derivationSweepScopeSql: 'src/core/page-body/schema.ts: constant sweep-scope predicate over caller aliases d and p with a hand-numbered page-id placeholder bound by the caller; no values',
  derivationAfterSql: 'src/core/page-body/segment-derive.ts: constant key-after predicate over the caller alias d with three hand-numbered cursor placeholders bound by the caller; no values',
  foldSql: 'src/core/page-body/schema.ts: wraps the caller-given constant expression in the constant replace and translate fold; the one caller passes the literal gbrain_fact_normalize(c); no values',
  derivationHoldsClaimSql: 'src/core/page-body/schema.ts: constant holds-claim predicate over the caller alias d with hand-numbered needle and pattern placeholders bound by the caller; no values',
  derivationClaimCandidateSql: 'src/core/page-body/schema.ts: constant claim-candidate predicate over the caller alias d with a hand-numbered pattern placeholder bound by the caller; no values',

  // memory-mutation-reads.ts builders (ownerReachesFact)
  ownerReadPolicyFragment: 'src/core/search/private-visibility.ts: the owner read rule over a caller page alias; it splices an identity only after validIdentity and rule ids only after validQualifiedRuleId (each a quoted literal of a checked shape), else FALSE',
  // access-control.ts builders
  edgeTrimSql: 'src/core/edge-whitespace.ts: btrim of a code-provided constant expression over the constant EDGE_WHITESPACE set; no values',

  // trust-tier-reads.ts builders
  versionPrivacySql: 'src/core/engine-sql/pages.ts: the get_versions excludePrivate predicate, built only from the vetted privatePagesFilterForCaller, callerReadersAllowedSql, privacyForCaller and privateSnapshotFilterFragment builders over the constant aliases p and pv, plus one constant pinned_question conjunct; no values',
  remoteReadFloorSql: 'src/core/search/private-visibility.ts: privatePagesFilterFragment, plus the constant labelledOnlySql conjunct for a labelled-only caller, over a caller page alias; no values',

  // facts-repair.ts builders
  contextHeadSql: 'src/core/facts/gone-page-facts.ts: constant head-of-context expression over a caller facts alias; no values',
  withdrawalCoversFactSql: 'src/core/access/member-facts.ts: constant withdrawal-covers-fact predicate over caller withdrawal and fact aliases; no values',
  factProvenanceSlugSql: 'src/core/facts/private-fact-pages.ts: constant provenance-slug expression over a caller facts alias; prefixes and source lanes are module constants; no values',
  derivationPrivateSql: 'src/core/search/private-visibility.ts: constant derivation-private predicate over a caller page alias; no values',
  expiryTextSql: 'src/core/engine-sql/facts-repair.ts: constant to_char UTC microsecond text of a caller column expression (code-provided); no values',
  instantTextSql: 'src/core/engine-sql/facts-repair.ts: constant to_char UTC microsecond text of a caller column expression (code-provided); no values',
  DUPLICATE_SQL: 'src/core/engine-sql/facts-repair.ts: constant same-dedup-key EXISTS over a caller facts alias (code-provided); no values',
  syncDeleteOrigin: 'src/core/persistence/sync-delete-tombstones.ts: constant managed-sync-deletion EXISTS predicate over a caller pages alias (code-provided); the op, intent kind and state are module constants; no values',

  // files-ops.ts builders
  fileReadableSql: 'src/core/engine-sql/files-ops.ts: the literal TRUE, or the constant files-readable NOT EXISTS predicate over the files alias f with the vetted caller private-pages filter spliced in; the choice is a boolean; no values',
  pageReadableSql: 'src/core/engine-sql/files-ops.ts: the literal TRUE, or the vetted caller private-pages filter over the pages alias fp; the choice is a boolean; no values',
  fileListFilterSql: 'src/core/engine-sql/files-ops.ts: the literal TRUE or the constant page filter with the hand-numbered $2 slug bound by the caller; the choice is whether a slug was given; no values',
  fileListOrderSql: 'src/core/engine-sql/files-ops.ts: one of two constant ORDER BY column lists chosen by whether a slug was given; no values',

  // contradictions-cycle.ts, ontology-repair.ts builders
  takeHolderSql: 'src/core/engine-sql/contradictions-cycle.ts: the constant holder allow-list conjunct with one positive integer position (checked by Number.isSafeInteger) spliced as its hand-numbered placeholder; no values',
  rekeyMoveSql: 'src/core/engine-sql/ontology-repair.ts: a re-key move text, returned only when it is a member of a closed constant list of shapes (anything else throws); no values',
  rekeyConversationSlotSql: 'src/core/engine-sql/ontology-repair.ts: CONVERSATION_SLOT_SQL, the constant conversation-source prefix test; no values',
  ontologyConversationSlotSql: 'src/core/engine-sql/ontology-repair.ts: NOT_CONVERSATION_SLOT_SQL, the constant not-a-conversation-source prefix test; no values',

  // facts-trust.ts builders
  quarantinedProvenanceFilterFragment: 'src/core/quarantine.ts: constant fact-provenance quarantine predicate over a caller alias; no values',
  factsFtsDocument: 'src/core/fts-language.ts: constant facts full-text document expression over a caller alias; the language passes VALID_CONFIG_NAME or falls back to the default',
  getFtsLanguage: 'src/core/fts-language.ts: the brain full-text config name; passes VALID_CONFIG_NAME ([a-z][a-z0-9_]*) or falls back to the default',
  memberFactAdmitSql: 'src/core/access/member-facts.ts: own-member-page fact predicate over a caller alias; the member id passed ACCESS_ID_RE (no quote) and the page test is privatePagesFilterForCaller; no values',
  grantedPrivateFactSql: 'src/core/access/member-facts.ts: private-facts grant predicate over a caller alias; granted source ids passed isValidSourceId, so they embed as literals',
  trustRankSql: 'src/core/trust/tier.ts: CASE mapping a caller column expression to a rank from the constant tier table; callers pass a column, never a value',
  trustRankArmsSql: 'src/core/trust/tier.ts: the constant WHEN ... ELSE 0 END) tail of trustRankSql from the constant tier table; takes no input, the subject is bound through sqlFragment',
  claimPendingSql: 'src/core/trust/claim-state.ts: constant claim-pending predicate over a caller sources alias; config keys are module constants',
  conversationSlotSql: 'src/core/engine-sql/facts-trust.ts: CONVERSATION_SLOT_SQL, the constant conversation-source prefix test; no values',
  savedFactCollapseColumns: 'src/core/engine-sql/facts-trust.ts: SAVED_FACT_COLLAPSE_COLUMNS, the constant select list the capture-dedup collapse reads; no values',
  claimBucketSql: 'src/core/facts/typed-claim.ts: constant CASE bucketing a caller facts alias\'s claim_period and valid_from from the constant cadence tables; no values',

  // facts-conversation.ts builders
  folderRestrictedSql: 'src/core/search/private-visibility.ts: constant folder-restriction predicate over a caller page alias; no values',

  tokenGrantSelectList: 'src/core/engine-sql/persistence-journal.ts: the constant TOKEN_GRANT_ROW_COLUMNS names (grants/model.ts) this brain\'s access_tokens has, joined by commas; no values',
  openedFactRowSql: 'src/core/persistence/context.ts: constant opened-row predicate over caller-given constant aliases; the setting name is a module constant, the opened ids are read by the statement itself',
  guestSourceSql: 'src/core/guests/note.ts: constant guest-source predicate over caller-given constant aliases (no input)',
  activationSuppressedSql: 'src/core/eligibility/sql.ts: constant activation-suppression predicate over a caller alias; tier ranks and reason families come from constant tables',
  contestedRefSql: 'src/core/eligibility/sql.ts: constant pending-supersede-proposal subquery over a caller alias; the table name comes from the facts/takes union, the actions are literals; no values',
  unverifiedExtractionFragment: 'src/core/extraction-review.ts: constant frontmatter predicate over a caller alias; keys and values are module constants',
  buildVisibilityClause: 'src/core/search/sql-ranking.ts: constant page visibility predicates over caller page/source aliases; options pick among constant fragments',
  pageReadFilter: 'src/core/search/read-policy-sql.ts: binds scope values as params, splices only the caller alias',
  buildHardExcludeClause: 'src/core/search/sql-ranking.ts: LIKE-escaped and SQL-escaped slug prefix literals (buildLikePrefixLiteral), the ranked-search hard-exclude clause',
  buildRecencyComponentSql: 'src/core/search/sql-ranking.ts: inlines LIKE literals + numeric coefficients from the decay map, as master (planner behavior)',
  readPolicyFragment: 'src/core/search/private-visibility.ts: accessAllowedForAllSql (readers identities checked by validIdentity before they are quoted in) AND the constant privacyPartSql or TRUE over a caller page alias; no values',
  hiddenSlugsPolicySql: 'src/core/engine-sql/page-mutation-reads.ts: callerAccessAllowedSql and the constant privacyPartSql over the constant alias p (the output guard\'s per-row test); no values',
  memberViewPolicySql: 'src/core/engine-sql/page-mutation-reads.ts: readPolicyFragment over the constant alias p, ANDed (labelled-only member) with labelledOnlyForSql over the same alias, whose identities pass validIdentity and rule ids validQualifiedRuleId before they are quoted in; no values',
  renderWriterReadPolicy: 'src/core/engine-sql/remote-links.ts: readPolicyFragment over a code-provided alias, ANDed (labelled-only writer) with labelledOnlyForSql, whose identities pass validIdentity and rule ids validQualifiedRuleId before they are quoted in; no values',
  privacyPartSql: 'src/core/search/private-visibility.ts: the constant privacy part (snapshot, derived-origin and declared-lineage tests) over a code-provided page alias; no values',
  privatePagesFilterFragment: 'src/core/search/private-visibility.ts: constant visibility predicate over a caller alias',
  openPageSql: 'src/core/engine-sql/access-setup.ts: the constant deleted_at test AND accessAllowedSql with an empty identity and no satisfied rules over a caller page alias; no values',
  callerAccessAllowedSql: 'src/core/search/private-visibility.ts: the member-access part of privatePagesFilterForCaller alone (callerAccessSql); readers identities pass validIdentity before they are quoted in, and a satisfied rule id that is not a valid qualified id empties the set (fail closed); no values',
  dependentsSql: 'src/core/repair/dependents-sql.ts: the constant dependents statement (namingSql and privacyPartSql over constant aliases); its $1-$4 placeholders (cleared ids, source ids, slugs, label keys) are bound by the caller as four arrays; the mode picks between constant texts; no values',
  privatePagesFilterForCaller: 'src/core/search/private-visibility.ts: privatePagesFilterFragment ORed with the private-readable source ids, each checked by isValidSourceId (alphabet [a-z0-9-], no quote) before it is quoted in',
  privateLinkOriginFilterForCaller: 'src/core/search/private-visibility.ts: constant link-origin predicate ORed with isValidSourceId-checked private-readable source ids',
  privateTimelineEventFilterForCaller: 'src/core/search/private-visibility.ts: constant timeline-event predicate ORed with isValidSourceId-checked private-readable source ids',
  ownerOnlyTakeAllowedSql: 'src/core/search/private-visibility.ts: empty for the owner, else NOT the owner-only lineage test (access/owner-only.ts) on a code-provided take alias: constant function names and table literal, no values',
  ownerOnlyTimelineAllowedSql: 'src/core/search/private-visibility.ts: empty for the owner, else NOT the owner-only lineage test (access/owner-only.ts) on a code-provided timeline alias: constant function names and table literal, no values',
  orPrivateReadableSource: 'src/core/search/private-visibility.ts: wraps a caller predicate with isValidSourceId-checked private-readable source ids quoted as literals',
  replacedBecauseSql: 'src/core/engine-sql/pages.ts: constant GBRA-217 reason projection over a caller alias, with callerReadersAllowedSql on the successor (identities checked by validIdentity before they are quoted in); the boolean picks one of two constant texts',
  validDateSql: 'src/core/valid-time.ts: constant GBRA-217 date normaliser over a caller column expression; engine-sql passes only constant pv.frontmatter keys',
  quarantineFilterFragment: 'src/core/quarantine.ts: constant quarantine predicate over a caller alias',
  guestSourceExclusionSql: 'src/core/guests/derived.ts: GBRA-504 constant guest-source NOT EXISTS predicate (guests/note.ts guestSourceSql) over a caller alias, or TRUE for a producer that takes guest input; the producer key is a typed union member; no values',
  currentCodeEdgeFilter: 'src/core/code-intel/read-scope.ts: constant current-edge predicate over a caller alias',
  buildCJKKeywordSql: 'src/core/search/cjk-keyword-sql.ts: binds the query as params; shared by both engines',
  currentTextProjectionFilter: 'src/core/search/safe-chunks.ts: constant projection predicate over a caller alias',
  projectionClassSql: 'src/core/page-state/projection-class.ts: constant projection class CASE over caller page/source aliases (module constants only, no values)',
  textClassSql: 'src/core/page-state/projection-class.ts: constant text-class predicate over caller page/source aliases (module constants only, no values; #10000)',
  budgetRowAppliesFilter: 'src/core/page-size-policy.ts: constant applying-budget-row predicate over caller budget/page aliases (module constants only, no values)',
  servedTextProjectionFilter: 'src/core/search/safe-chunks.ts: constant projection predicate over a caller alias, ORed with the constant v153 served-index marker (#9192)',
  waitingTextProjectionFilter: 'src/core/search/safe-chunks.ts: constant waiting-projection predicate over a caller alias with the constant v153 served-index marker, the v317 index predicate (#9192)',
  chunkVisibleFilter: 'src/core/search/safe-chunks.ts: constant projection + live body generation predicate over caller page/chunk aliases (Wave B)',
  chunkGenerationFilter: 'src/core/search/safe-chunks.ts: constant live body generation predicate over caller page/chunk aliases (Wave B)',
  chunkGenerationProbe: 'src/core/search/safe-chunks.ts: chunkGenerationFilter as an EXISTS over the chunk\'s page, for a statement with no page row joined; constant text over a caller chunk alias',
  sealableImageSql: 'src/core/page-state/projection-class.ts: constant sealable-image predicate (safe fence, protected-marker filter and the importer chunk probe) over a caller page alias; no values',
  chunkManifestJoin: 'src/core/search/safe-chunks.ts: constant LEFT JOIN onto the live page_body_manifest row over caller aliases (Wave B)',
  chunkDocumentOrder: 'src/core/search/safe-chunks.ts: constant ORDER BY column list over caller chunk/manifest aliases (Wave B)',
  syncImportPagesSql: 'src/core/persistence/sync-pass-pages-sql.ts: the constant sync pass I⋈P statement (module constants MARKDOWN_CHUNKER_VERSION and syncDeleteOrigin(\'p\') only), its placeholders $1..$5 bound by the caller; the keyset LIMIT is a Number.isSafeInteger-checked integer',
  syncAdmissionEffectsSql: 'src/core/persistence/sync-admission-sql.ts: the constant sync.admission effective-probe statement (effectProbes over literal $1..$7 placeholders only), every value bound by the caller',
  embeddingCandidateWhere: 'src/core/engine-sql/persistence-effect-scans.ts: the constant stale-embedding-effect predicate; its error codes pass assertCandidateCodes (each code must match /^[a-z0-9_]+$/) before they are spliced into the text[] literal; no caller values',
  quoteIdentifier: 'src/core/search/embedding-column.ts: double-quoted identifier (embedded quotes doubled); callers pass registry-resolved or COLUMN_NAME_REGEX-checked embedding column names',
  vectorCastSuffix: 'src/core/search/embedding-column.ts: constant ::vector / ::halfvec cast suffix from the resolved column type',
  safeChunksFilter: 'src/core/search/safe-chunks.ts: constant safe-chunk predicate over a caller alias',
  pageBudgetLimitedFilter: 'src/core/page-size-policy.ts: constant held-or-capped budget predicate over a caller page alias; no values',
  projectionJobProbes: 'src/core/engine-sql/projection-rebuild.ts: constant source and live-inline-page lateral probes over the queue alias j; `media` picks between module constants (projection-class.ts sealableImageSql); no values',
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
  openFactClassSql: 'src/core/engine-sql/open-facts-scans.ts: the constant open-facts class CASE over a caller-given constant facts alias (the literal f), built only from the vetted unpagedFactSql; no values',
  openFactsReasonSql: 'src/core/engine-sql/open-facts-scans.ts: the constant open-facts exclusion CASE over a caller-given constant facts alias (the literal f), built only from the vetted factOnMemberPageSql and factPageReasons predicates and constant reason names; no values',
  privacyAliasSql: 'src/core/search/private-visibility.ts: the constant privacy-alias predicate over a caller-given constant pages alias; splices only the PRIVACY_ALIASES constant keys and values as quoted literals; no values',
  folderRulesAllowedSql: 'src/core/search/private-visibility.ts: the folder-rule predicate over a caller alias; splices only rule ids that pass validQualifiedRuleId (sorted, deduped) as quoted literals and the constant coverage conjunct; engine-sql/open-twins.ts passes only the literal alias t',
  atomMovedOriginPrivateSql: 'src/core/persistence/atom-origin.ts: the constant moved-origin EXISTS predicate (slug_rename_history joined to pages) over a caller-given constant pages alias; engine-sql/visibility-scans.ts passes only the literal alias a; no values',
  aliasOnlyPagesSql: 'src/core/engine-sql/visibility-scans.ts: the constant alias-only private-page predicate, built only from the vetted privacyAliasSql over a caller-given constant pages alias (the literal p); no values',
  atomOriginSlugSql: 'src/core/persistence/atom-origin.ts: the constant origin-slug expression (the atom\'s source_slug, else its rename target) over a caller-given constant pages alias; engine-sql/stale-atom-reads.ts passes only the literal alias a; no values',
  managedAtomCompletedSql: 'src/core/persistence/managed-atom-sql.ts: the constant failure-free managed-atoms checkpoint predicate over the op_checkpoints alias ac, for caller-given constant column expressions; engine-sql/stale-atom-reads.ts passes only the atom CTE columns; no values',
  atomRetirementsSql: 'src/core/persistence/atom-retirement-hold.ts: the constant re-extraction retirement CTE over the pages alias p with a scope predicate spliced in; engine-sql/atom-restore-reads.ts passes only module constants (the source-id ANY($1) predicate, optionally with atomOriginScopeSql over $2); no values',
  atomOriginScopeSql: 'src/core/persistence/atom-retirement-hold.ts: the constant same-source-and-origin predicate over the pages alias p for the atom id placeholder it is given; engine-sql/atom-restore-reads.ts passes only the literal $2::bigint; no values',
  privacyForCaller: 'src/core/search/private-visibility.ts: the caller privacy arm (TRUE, or the given predicate ORed with private-readable source ids checked by isValidSourceId); callers pass a constant alias and a vetted predicate builder',
  factVisibilitySql: 'src/core/access/member-facts.ts: visibility values filtered to the constant set world/private; widened only by memberFactAdmitSql, whose member id passed ACCESS_ID_RE (no quote) and whose page test is privatePagesFilterForCaller; no values',
  heldRowSql: 'src/core/eligibility/fence-overlay.ts: the held fence-cell test over constant key column aliases; widened only by memberFactAdmitSql (member id passed ACCESS_ID_RE) and grantedPrivateFactSql (each source id checked by isValidSourceId before it is quoted in); no values',
  onOwnedMemoryPageSql: 'src/core/access/member-facts.ts: constant memory/members/ prefix and memory/scope slug test over a code-provided facts alias; no values',
  factWithdrawalSubjectSql: 'src/core/access/member-facts.ts: constant CASE over onOwnedMemoryPageSql and unbackedEntitySql for a code-provided facts alias; no values',
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
  holdAppliesToPageSql: 'src/core/write-gate-binding.ts: constant hold-reaches-page predicate over caller-given constant aliases and column expressions; no values',
  holdOwnedByDeletedPageSql: 'src/core/write-gate-binding.ts: constant hold-owned-by-purged-page predicate over caller-given constant aliases and column expressions; no values',
  guestPredicateSql: 'src/core/engine-sql/cli-reads-import.ts: constant guest predicate (guestSourceSql, or the config record alone) over caller-given constant aliases; no values',
  precedenceSql: 'src/core/eligibility/precedence.ts: constant source-precedence CASE over caller-given constant aliases and a constant guest predicate; class names come from a constant list; no values',
  noteKeptHoldsCte: 'src/core/write-gate-binding.ts: constant data-modifying CTE that notes the holds a purge keeps for another page, over caller-given constant aliases and column expressions (a sub-select of the purge CTE, never a value); no values',
  holdResidueOfDeletedPageSql: 'src/core/write-gate-binding.ts: constant hold-left-behind-by-purged-page predicate over caller-given constant aliases and column expressions; no values',
  privacyLabelKeySql: 'src/core/search/ignored-privacy-labels.ts: constant has-a-privacy-label-key predicate (code-constant PRIVACY_LABEL_KEYS) over a caller alias; no values',
  ignoredPrivacyLabelSql: 'src/core/search/ignored-privacy-labels.ts: constant ignored-privacy-label predicate (code-constant keys and type names) over a caller alias; no values',
  vectorLiteralSql: 'src/core/engine-sql/facts.ts: master\'s inlined vector literal; toPgVectorLiteral output (numbers joined by commas) + a ::vector/::halfvec constant',
  temporalLinkJoinSql: 'src/core/link-validity.ts: constant LEFT JOIN onto link_relationships over a caller alias; scope is one of two literals',
  projectionEligibleSql: 'src/core/eligibility/sql.ts: read-eligibility predicate over a caller alias; splices only closed tier and reason-family vocabularies (no values)',
  pageEligibleSql: 'src/core/eligibility/sql.ts: page trust-floor and activation predicate over a caller alias; closed vocabularies only',
  relationshipFilterSql: 'src/core/link-validity.ts: relationship-state probe over a caller alias; dates pass isCalendarDate and inline as DATE literals, status/scope are literals',
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
