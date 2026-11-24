/**
 * The mention pass, the entity gazetteer, the full extract walk's snapshot, `extract mentions --explain` and the segmented
 * derive pass's conditional store. Declarations moved verbatim out of engine.ts (lane 6, extract-mentions-rust);
 * `BrainEngine` extends this interface, so the member set is unchanged.
 */
import type * as MentionPassSql from '../engine-sql/mention-pass.ts';
import type * as MentionReadsSql from '../engine-sql/mention-reads.ts';
import type * as SegmentDeriveStoreSql from '../engine-sql/segment-derive-store.ts';

export interface MentionPassMembers {
  // The segmented page path's projection check and the derive pass's conditional store (engine-sql/segment-derive-store.ts).
  /** Whether the live page's text projection is sealed at its current revision (no row: no live page). */
  readSegmentedPageSealed(sourceId: string, slug: string): Promise<Array<{ sealed: boolean }>>;
  /** Upsert `rows` as done derivations while the page is live, segmented and at body `generation`; how many were written. */
  storeSegmentDerivationsIfLive(pageId: number, generation: number, rows: readonly SegmentDeriveStoreSql.SegmentDerivationStoreRow[]): Promise<number>;
  // The mention pass, the entity gazetteer, the full extract walk's snapshot and `extract mentions --explain` (engine-sql/mention-pass.ts, mention-reads.ts).
  /** Every source id, by id (pass.ts sourcesInScope). */
  listMentionSourceIds(): Promise<Array<{ id: string }>>;
  /** Insert or update one source's status row (pass.ts writeStatus). */
  writeMentionIndexStatus(sourceId: string, patch: MentionPassSql.MentionStatusPatch): Promise<void>;
  /** #9548: the per-source publish lock, exclusive or shared, for the caller's transaction (pass.ts lockMentionSources). */
  lockMentionSources(sourceIds: readonly string[], shared: boolean): Promise<void>;
  /** The slugs of the source's pages that hold a plain mention link (pass.ts disableSource). */
  listMentionLinkOrigins(sourceId: string): Promise<Array<{ slug: string }>>;
  /** Delete the source's plain mention links, of the pages in `origins` when given; returns the deleted ids. */
  deleteSourceMentionLinks(sourceId: string, origins: readonly string[] | null): Promise<Array<{ id: number }>>;
  /** Drop the source's derived aliases, gazetteer entries and page mention state (pass.ts disableSource). */
  clearMentionSourceIndex(sourceId: string): Promise<void>;
  /** The source's slugs whose derived aliases belong to no live page of `types` (pass.ts refreshAliases). */
  listStaleDerivedAliasSlugs(sourceId: string, types: readonly string[]): Promise<Array<{ slug: string }>>;
  /** Delete the derived aliases of `slugs` in the source. */
  deleteDerivedAliasesForSlugs(sourceId: string, slugs: readonly string[]): Promise<void>;
  /** Inline live pages of `types` after id `after` whose derived aliases are behind their content or `version`, by id. */
  listAliasDuePages(sourceId: string, types: readonly string[], after: number, version: number, limit: number): Promise<MentionPassSql.MentionDuePageRow[]>;
  /** The derived alias rows of `slugs` in the source. */
  listDerivedAliasRows(sourceId: string, slugs: readonly string[]): Promise<MentionPassSql.DerivedAliasStateRow[]>;
  /** The content revision of each live page in `ids` (`forShare`: row-locked, the reconcile's read). */
  readMentionPageRevisions(ids: readonly number[], opts: { forShare: boolean }): Promise<Array<{ id: number; revision: string }>>;
  /** Insert derived alias rows for the source (existing rows are kept). */
  insertDerivedAliasRows(sourceId: string, rows: readonly MentionPassSql.DerivedAliasInsertRow[]): Promise<void>;
  /** Record that each page's derived aliases are current at its revision and `version`. */
  upsertPageAliasState(sourceId: string, pages: ReadonlyArray<{ id: number; revision: string }>, version: number): Promise<void>;
  /** Live pages of `sourceIds` after id `after`, by id, up to `limit`, with their text; with `patterns` only segmented pages and pages whose lowered text is LIKE one of them (pass.ts pagesMatchingNames). */
  listMentionCandidatePages(sourceIds: readonly string[], after: number, limit: number, patterns: readonly string[] | null): Promise<MentionPassSql.MentionCandidatePageRow[]>;
  /** The source's saved gazetteer entries (pass.ts saveEntries). */
  listGazetteerEntryKeys(sourceId: string): Promise<MentionPassSql.GazetteerEntryKeyRow[]>;
  /** The pages linking with a mention link to `slugs` in the source. */
  listMentionLinkersOfTargets(sourceId: string, slugs: readonly string[]): Promise<Array<{ id: number }>>;
  /** The source's entry-save lock for the caller's transaction. */
  lockMentionEntries(sourceId: string): Promise<void>;
  /** Remove `removed` and add `added` to the source's saved entries. */
  applyGazetteerEntryChanges(sourceId: string, removed: readonly MentionPassSql.GazetteerEntryKeyRow[], added: readonly MentionPassSql.GazetteerEntryKeyRow[]): Promise<void>;
  /** Mark pages due for the reconcile: every page of `sourceIds`, or the pages in `pageIds`. */
  resetMentionRevisions(by: MentionPassSql.MentionResetBy): Promise<void>;
  /** Each source's generation (`lock`: row-locked FOR SHARE, the publish check). */
  readMentionGenerations(sourceIds: readonly string[], lock: boolean): Promise<Array<{ source_id: string; generation: string }>>;
  /** Live pages of the source after id `after` due for the mention pass at extractor `version`, by id, up to `limit`. */
  listMentionDuePages(sourceId: string, version: number, after: number, limit: number): Promise<MentionPassSql.MentionDuePageRow[]>;
  /** Every outbound link of the pages in `ids`, with its target and whether it is a plain mention link. */
  listPageOutLinks(ids: readonly number[]): Promise<MentionPassSql.PageOutLinkRow[]>;
  /** Delete the links in `ids`. */
  deleteLinksById(ids: readonly number[]): Promise<void>;
  /** Record that each page's mention links are current at its revision, `version` and the source `generation`. */
  upsertPageMentionState(sourceId: string, pages: ReadonlyArray<{ id: number; revision: string }>, version: number, generation: string): Promise<void>;
  /** Each source's status state. */
  readMentionStatusStates(sourceIds: readonly string[]): Promise<Array<{ source_id: string; state: string }>>;
  /** Each source's stored policy fingerprint. */
  readMentionPolicyFingerprints(sourceIds: readonly string[]): Promise<Array<{ source_id: string; policy_fingerprint: string | null }>>;
  /** A changed policy: every page of the source is due for the alias refresh and the reconcile. */
  resetSourceMentionIndexRevisions(sourceId: string): Promise<void>;
  /** The sources that hold a live page (buildGazetteer). */
  listLivePageSourceIds(): Promise<Array<{ id: string }>>;
  /** Live pages of `types`, with the four handle frontmatter keys `handleKeys` names and whether a connector made it. */
  listGazetteerPages(types: readonly string[], handleKeys: readonly [string, string, string, string]): Promise<MentionReadsSql.GazetteerPageRow[]>;
  /** The alias rows of live pages of `types`, with each page's title, type and frontmatter identity. */
  listGazetteerAliases(types: readonly string[]): Promise<MentionReadsSql.GazetteerAliasRow[]>;
  /** Each live page among (`slugs[i]`, `sourceIds[i]`) with its updated_at as ISO microseconds (the full walk's snapshot). */
  readPageStampTimes(slugs: readonly string[], sourceIds: readonly string[]): Promise<MentionReadsSql.PageStampTimeRow[]>;
  /** The live page's content revision, row-locked FOR SHARE (the by-mention rebuild's conditional publish). */
  readPageRevisionForShare(sourceId: string, slug: string): Promise<Array<{ revision: string }>>;
  /** The live page at the slug, if any (explain). */
  readExplainPage(sourceId: string, slug: string): Promise<Array<{ slug: string; type: string | null; title: string | null }>>;
  /** The live page's text, its `mention_ignore` and whether it is due for the mention pass at extractor `version`. */
  readExplainScanPage(sourceId: string, slug: string, version: number): Promise<MentionReadsSql.ExplainScanPageRow[]>;
  /** How many mention links the page has to `targets` in the source. */
  countMentionLinksTo(pageId: number, sourceId: string, targets: readonly string[]): Promise<Array<{ n: number }>>;
  /** The live page's title, body and frontmatter. */
  readPageNameText(sourceId: string, slug: string): Promise<MentionReadsSql.PageNameTextRow[]>;
  /** The page's frontmatter alias rows, by alias. */
  listFrontmatterAliasNorms(sourceId: string, slug: string): Promise<Array<{ alias_norm: string }>>;
  /** Up to 50 live pages of `types` whose title or body ILIKE `pattern` (explain's rejected-declaration search). */
  listRejectedDeclarationPages(sourceId: string, types: readonly string[], pattern: string): Promise<MentionReadsSql.PageNameTextRow[]>;
}
