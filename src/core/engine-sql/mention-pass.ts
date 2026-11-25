/**
 * The mention pass's statements (src/core/mentions/pass.ts), each with the text and parameters the pass ran through
 * `executeRaw`; only their home moved. Each member runs on the engine it is called on, so a member called on a
 * transaction's engine runs in that transaction, as the statement did. The Rust engine answers the same members from
 * its store (rust/crates/gbrain-store/src/mention_state.rs, rust/docs/store/mention-state.md).
 */

/** The engine's own `executeRaw`, so each statement takes the path it took before (Postgres counts the raw gauge). */
export interface MentionRaw {
  executeRaw<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
}

/** lockMentionSources, shared and exclusive: one whole statement each (the caller chose the lock function by `shared`). */
export const LOCK_MENTION_SOURCES_SHARED_SQL = "SELECT count(pg_advisory_xact_lock_shared(hashtext('gbrain:mention-publish:' || s)::bigint))\n    FROM (SELECT DISTINCT s FROM unnest($1::text[]) AS x(s) ORDER BY s) k";
export const LOCK_MENTION_SOURCES_EXCLUSIVE_SQL = "SELECT count(pg_advisory_xact_lock(hashtext('gbrain:mention-publish:' || s)::bigint))\n    FROM (SELECT DISTINCT s FROM unnest($1::text[]) AS x(s) ORDER BY s) k";
/** listMentionCandidatePages with and without the LIKE prefilter: one whole statement each. */
export const MENTION_CANDIDATES_MATCHING_SQL = "SELECT p.id, p.slug, p.source_id, p.body_storage,\n              CASE WHEN p.body_storage = 'segmented' OR lower(COALESCE(p.title, '') || ' ' || COALESCE(p.compiled_truth, '') || ' ' || COALESCE(p.timeline, '')) LIKE ANY($4::text[])\n                   THEN COALESCE(p.title, '') || E'\\n\\n' || COALESCE(p.compiled_truth, '') || E'\\n\\n' || COALESCE(p.timeline, '') END AS body,\n              p.frontmatter->'mention_ignore' AS mention_ignore\n         FROM (SELECT id FROM pages WHERE deleted_at IS NULL AND source_id = ANY($1::text[]) AND id > $2 ORDER BY id LIMIT $3) w\n         JOIN pages p ON p.id = w.id ORDER BY p.id";
export const MENTION_CANDIDATES_ALL_SQL = "SELECT p.id, p.slug, p.source_id, p.body_storage,\n              CASE WHEN true\n                   THEN COALESCE(p.title, '') || E'\\n\\n' || COALESCE(p.compiled_truth, '') || E'\\n\\n' || COALESCE(p.timeline, '') END AS body,\n              p.frontmatter->'mention_ignore' AS mention_ignore\n         FROM (SELECT id FROM pages WHERE deleted_at IS NULL AND source_id = ANY($1::text[]) AND id > $2 ORDER BY id LIMIT $3) w\n         JOIN pages p ON p.id = w.id ORDER BY p.id";
/** readMentionGenerations, plain and row-locked: one whole statement each. */
export const MENTION_GENERATIONS_SQL = "SELECT source_id, generation::text AS generation FROM mention_index_status WHERE source_id = ANY($1::text[])";
export const MENTION_GENERATIONS_FOR_SHARE_SQL = "SELECT source_id, generation::text AS generation FROM mention_index_status WHERE source_id = ANY($1::text[]) FOR SHARE";
/** listMentionDuePages: the due predicate (`DUE_PREDICATE` of pass.ts) spelled into the statement. */
export const MENTION_DUE_PAGES_SQL = "SELECT p.id, p.slug, p.source_id, p.knowledge_revision::text AS revision, p.title, p.type, p.compiled_truth, p.timeline,\n              p.frontmatter->'mention_ignore' AS mention_ignore, p.body_storage\n         FROM pages p LEFT JOIN page_mention_state s ON s.page_id = p.id\n        WHERE p.source_id = $1 AND p.deleted_at IS NULL AND p.id > $3 AND (s.page_id IS NULL OR s.mention_revision IS DISTINCT FROM p.knowledge_revision OR s.mention_version IS DISTINCT FROM $2)\n        ORDER BY p.id LIMIT $4";

export type MentionStatusState = 'complete' | 'pending' | 'disabled' | 'failed';

/** One status write: the columns `writeStatus` set (null keeps the stored value, except `error`). */
export interface MentionStatusPatch {
  state: MentionStatusState;
  pending: number | null;
  lastPassAt: string | null;
  error: string | null;
  bumpGeneration: boolean;
  /** The policy fingerprint to store; `setFingerprint` false keeps the stored one. */
  fingerprint: string | null;
  setFingerprint: boolean;
}

/** A page the alias refresh or the reconcile reads: its content and its revision at the read. */
export interface MentionDuePageRow {
  id: number; slug: string; source_id: string; revision: string; title: string | null; type: string | null;
  compiled_truth: string | null; timeline: string | null; mention_ignore: unknown; frontmatter?: Record<string, unknown> | null; body_storage?: string;
}

export interface DerivedAliasStateRow { slug: string; alias_norm: string; origin: string; case_sensitive: boolean; alias_text: string | null }
export interface DerivedAliasInsertRow { slug: string; alias_norm: string; origin: string; case_sensitive: boolean; alias_text: string | null }
export interface MentionCandidatePageRow { id: number; slug: string; source_id: string; body_storage: string; /** null: a prefiltered page that is neither segmented nor matches a pattern. */ body: string | null; mention_ignore: unknown }
export interface GazetteerEntryKeyRow { source_id: string; name_norm: string; target_slug: string; case_sensitive: boolean }
export interface PageOutLinkRow { id: number; from_page_id: number; to_slug: string; to_source_id: string; plain: boolean }

/** Every source id, by id (pass.ts sourcesInScope). */
export function listMentionSourceIds(raw: MentionRaw): Promise<Array<{ id: string }>> {
  return raw.executeRaw<{ id: string }>('SELECT id FROM sources ORDER BY id COLLATE "C"');
}

/** Insert or update one source's status row (pass.ts writeStatus). */
export async function writeMentionIndexStatus(raw: MentionRaw, sourceId: string, patch: MentionStatusPatch): Promise<void> {
  await raw.executeRaw(
    `INSERT INTO mention_index_status (source_id, generation, state, pending, counted_at, last_pass_at, policy_fingerprint, error, updated_at)
     VALUES ($1, CASE WHEN $6::boolean THEN 1 ELSE 0 END, $2, COALESCE($3::int, 0), now(), $4::timestamptz, $7, $5, now())
     ON CONFLICT (source_id) DO UPDATE SET
       state = EXCLUDED.state,
       pending = COALESCE($3::int, mention_index_status.pending),
       counted_at = CASE WHEN $3::int IS NULL THEN mention_index_status.counted_at ELSE now() END,
       last_pass_at = COALESCE($4::timestamptz, mention_index_status.last_pass_at),
       error = $5,
       generation = mention_index_status.generation + CASE WHEN $6::boolean THEN 1 ELSE 0 END,
       policy_fingerprint = CASE WHEN $8::boolean THEN $7 ELSE mention_index_status.policy_fingerprint END,
       updated_at = now()`,
    [sourceId, patch.state, patch.pending ?? null, patch.lastPassAt ?? null, patch.error ?? null, patch.bumpGeneration === true,
      patch.fingerprint ?? null, patch.setFingerprint]);
}

/** #9548: the per-source publish lock, exclusive or shared, for the caller's transaction (pass.ts lockMentionSources). */
export async function lockMentionSources(raw: MentionRaw, sourceIds: readonly string[], shared: boolean): Promise<void> {
  await raw.executeRaw(shared ? LOCK_MENTION_SOURCES_SHARED_SQL : LOCK_MENTION_SOURCES_EXCLUSIVE_SQL, [sourceIds]);
}

/** The slugs of the source's pages that hold a plain mention link (pass.ts disableSource). */
export function listMentionLinkOrigins(raw: MentionRaw, sourceId: string): Promise<Array<{ slug: string }>> {
  return raw.executeRaw<{ slug: string }>(
      `SELECT DISTINCT f.slug FROM links l JOIN pages f ON f.id = l.from_page_id
        WHERE f.source_id = $1 AND l.link_source = 'mentions' AND (l.link_kind IS NULL OR l.link_kind = 'plain')`, [sourceId]);
}

/** Delete the source's plain mention links, of the pages in `origins` when given; returns the deleted ids. */
export function deleteSourceMentionLinks(raw: MentionRaw, sourceId: string, origins: readonly string[] | null): Promise<Array<{ id: number }>> {
  return raw.executeRaw<{ id: number }>(
      `DELETE FROM links l USING pages f
        WHERE f.id = l.from_page_id AND f.source_id = $1 AND l.link_source = 'mentions'
          AND (l.link_kind IS NULL OR l.link_kind = 'plain') AND ($2::text[] IS NULL OR f.slug = ANY($2::text[])) RETURNING l.id`, [sourceId, origins]);
}

/** Drop the source's derived aliases, gazetteer entries and page mention state (pass.ts disableSource). */
export async function clearMentionSourceIndex(raw: MentionRaw, sourceId: string): Promise<void> {
  await raw.executeRaw(`DELETE FROM page_aliases WHERE source_id = $1 AND origin IN ('declared','subject')`, [sourceId]);
  await raw.executeRaw('DELETE FROM mention_gazetteer_entries WHERE source_id = $1', [sourceId]);
  await raw.executeRaw('DELETE FROM page_mention_state WHERE source_id = $1', [sourceId]);
}

/** The source's slugs whose derived aliases belong to no live page of `types` (pass.ts refreshAliases). */
export function listStaleDerivedAliasSlugs(raw: MentionRaw, sourceId: string, types: readonly string[]): Promise<Array<{ slug: string }>> {
  return raw.executeRaw<{ slug: string }>(
    `SELECT DISTINCT pa.slug FROM page_aliases pa
       LEFT JOIN pages p ON p.slug = pa.slug AND p.source_id = pa.source_id
      WHERE pa.source_id = $1 AND pa.origin IN ('declared','subject')
        AND (p.id IS NULL OR p.deleted_at IS NOT NULL OR NOT (p.type = ANY($2::text[])))`, [sourceId, types]);
}

/** Delete the derived aliases of `slugs` in the source. */
export async function deleteDerivedAliasesForSlugs(raw: MentionRaw, sourceId: string, slugs: readonly string[]): Promise<void> {
  await raw.executeRaw(
      `DELETE FROM page_aliases WHERE source_id = $1 AND slug = ANY($2::text[]) AND origin IN ('declared','subject')`,
      [sourceId, slugs]);
}

/** Inline live pages of `types` after id `after` whose derived aliases are behind their content or `version`, by id. */
export function listAliasDuePages(raw: MentionRaw, sourceId: string, types: readonly string[], after: number, version: number, limit: number): Promise<MentionDuePageRow[]> {
  return raw.executeRaw<MentionDuePageRow>(
      `SELECT p.id, p.slug, p.source_id, p.knowledge_revision::text AS revision, p.title, p.type, p.compiled_truth, p.timeline, NULL AS mention_ignore, p.frontmatter
         FROM pages p LEFT JOIN page_mention_state s ON s.page_id = p.id
        WHERE p.source_id = $1 AND p.deleted_at IS NULL AND p.body_storage = 'inline' AND p.type = ANY($2::text[]) AND p.id > $3
          AND (s.page_id IS NULL OR s.alias_revision IS DISTINCT FROM p.knowledge_revision OR s.alias_version IS DISTINCT FROM $4)
        ORDER BY p.id LIMIT $5`, [sourceId, types, after, version, limit]);
}

/** The derived alias rows of `slugs` in the source. */
export function listDerivedAliasRows(raw: MentionRaw, sourceId: string, slugs: readonly string[]): Promise<DerivedAliasStateRow[]> {
  return raw.executeRaw<DerivedAliasStateRow>(
      `SELECT slug, alias_norm, origin, case_sensitive, alias_text FROM page_aliases
        WHERE source_id = $1 AND slug = ANY($2::text[]) AND origin IN ('declared','subject')`, [sourceId, slugs]);
}

/** The content revision of each live page in `ids` (`forShare`: row-locked, the reconcile's read). */
export function readMentionPageRevisions(raw: MentionRaw, ids: readonly number[], opts: { forShare: boolean }): Promise<Array<{ id: number; revision: string }>> {
  return opts.forShare
    ? raw.executeRaw<{ id: number; revision: string }>(
        `SELECT id, knowledge_revision::text AS revision FROM pages WHERE id = ANY($1::int[]) AND deleted_at IS NULL FOR SHARE`,
        [ids])
    : raw.executeRaw<{ id: number; revision: string }>(
        `SELECT id, knowledge_revision::text AS revision FROM pages WHERE id = ANY($1::int[]) AND deleted_at IS NULL`,
        [ids]);
}

/** Insert derived alias rows for the source (existing rows are kept). */
export async function insertDerivedAliasRows(raw: MentionRaw, sourceId: string, rows: readonly DerivedAliasInsertRow[]): Promise<void> {
  await raw.executeRaw(
            `INSERT INTO page_aliases (source_id, alias_norm, slug, origin, case_sensitive, alias_text)
             SELECT $1, a, s, o, c::boolean, t FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) AS x(a, s, o, c, t)
             ON CONFLICT DO NOTHING`,
            [sourceId, rows.map(r => r.alias_norm), rows.map(r => r.slug), rows.map(r => r.origin), rows.map(r => String(r.case_sensitive)), rows.map(r => r.alias_text)]);
}

/** Record that each page's derived aliases are current at its revision and `version`. */
export async function upsertPageAliasState(raw: MentionRaw, sourceId: string, pages: ReadonlyArray<{ id: number; revision: string }>, version: number): Promise<void> {
  await raw.executeRaw(
          `INSERT INTO page_mention_state (page_id, source_id, alias_revision, alias_version, aliases_refreshed_at)
           SELECT id, $1, rev::uuid, $4, now() FROM unnest($2::int[], $3::text[]) AS x(id, rev)
           ON CONFLICT (page_id) DO UPDATE SET alias_revision = EXCLUDED.alias_revision, alias_version = EXCLUDED.alias_version,
             aliases_refreshed_at = EXCLUDED.aliases_refreshed_at`,
          [sourceId, pages.map(p => p.id), pages.map(p => p.revision), version]);
}

/**
 * The next `limit` live pages of `sourceIds` after id `after`, by id, with their text; with `patterns` a page that is
 * neither segmented nor has lowered text LIKE one of them comes back with a null body (pass.ts pagesMatchingNames).
 */
export function listMentionCandidatePages(raw: MentionRaw, sourceIds: readonly string[], after: number, limit: number, patterns: readonly string[] | null): Promise<MentionCandidatePageRow[]> {
  return patterns !== null
    ? raw.executeRaw<MentionCandidatePageRow>(MENTION_CANDIDATES_MATCHING_SQL, [sourceIds, after, limit, patterns])
    : raw.executeRaw<MentionCandidatePageRow>(MENTION_CANDIDATES_ALL_SQL, [sourceIds, after, limit]);
}

/** The source's saved gazetteer entries (pass.ts saveEntries). */
export function listGazetteerEntryKeys(raw: MentionRaw, sourceId: string): Promise<GazetteerEntryKeyRow[]> {
  return raw.executeRaw<GazetteerEntryKeyRow>(
    'SELECT source_id, name_norm, target_slug, case_sensitive FROM mention_gazetteer_entries WHERE source_id = $1', [sourceId]);
}

/** The pages linking with a mention link to `slugs` in the source. */
export function listMentionLinkersOfTargets(raw: MentionRaw, sourceId: string, slugs: readonly string[]): Promise<Array<{ id: number }>> {
  return raw.executeRaw<{ id: number }>(
      `SELECT DISTINCT l.from_page_id AS id FROM links l JOIN pages t ON t.id = l.to_page_id
        WHERE t.source_id = $1 AND t.slug = ANY($2::text[]) AND l.link_source = 'mentions'`,
      [sourceId, slugs]);
}

/** The source's entry-save lock for the caller's transaction. */
export async function lockMentionEntries(raw: MentionRaw, sourceId: string): Promise<void> {
  await raw.executeRaw('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`gbrain:mention-entries:${sourceId}`]);
}

/** Remove `removed` and add `added` to the source's saved entries. */
export async function applyGazetteerEntryChanges(raw: MentionRaw, sourceId: string, removed: readonly GazetteerEntryKeyRow[], added: readonly GazetteerEntryKeyRow[]): Promise<void> {
  if (removed.length) {
    await raw.executeRaw(
        `DELETE FROM mention_gazetteer_entries e USING unnest($2::text[], $3::text[], $4::text[]) AS x(n, t, c)
          WHERE e.source_id = $1 AND e.name_norm = x.n AND e.target_slug = x.t AND e.case_sensitive = x.c::boolean`,
        [sourceId, removed.map(k => k.name_norm), removed.map(k => k.target_slug), removed.map(k => String(k.case_sensitive))]);
  }
  if (added.length) {
    await raw.executeRaw(
        `INSERT INTO mention_gazetteer_entries (source_id, name_norm, target_slug, case_sensitive)
         SELECT $1, n, t, c::boolean FROM unnest($2::text[], $3::text[], $4::text[]) AS x(n, t, c) ON CONFLICT DO NOTHING`,
        [sourceId, added.map(k => k.name_norm), added.map(k => k.target_slug), added.map(k => String(k.case_sensitive))]);
  }
}

/**
 * What `resetMentionRevisions` marks due: every page of `sourceIds`, the pages in `pageIds`, or `pageIds` plus every page of
 * `sourceIds` after page id `afterPageId` (the tail a deadline-stopped scan did not read).
 */
export type MentionResetBy = { sourceIds: readonly string[] } | { pageIds: readonly number[] }
  | { pageIds: readonly number[]; sourceIds: readonly string[]; afterPageId: number };

/** Mark pages due for the reconcile (see `MentionResetBy`). */
export async function resetMentionRevisions(raw: MentionRaw, by: MentionResetBy): Promise<void> {
  if ('afterPageId' in by) {
    await raw.executeRaw(
      `UPDATE page_mention_state SET mention_revision = NULL
          WHERE page_id = ANY($1::int[]) OR ($3::int IS NOT NULL AND source_id = ANY($2::text[]) AND page_id > $3::int)`,
      [by.pageIds, by.sourceIds, by.afterPageId]);
  } else if ('sourceIds' in by) await raw.executeRaw('UPDATE page_mention_state SET mention_revision = NULL WHERE source_id = ANY($1::text[])', [by.sourceIds]);
  else await raw.executeRaw('UPDATE page_mention_state SET mention_revision = NULL WHERE page_id = ANY($1::int[])', [by.pageIds]);
}

/** Each source's generation (`lock`: row-locked FOR SHARE, the publish check). */
export function readMentionGenerations(raw: MentionRaw, sourceIds: readonly string[], lock: boolean): Promise<Array<{ source_id: string; generation: string }>> {
  return raw.executeRaw<{ source_id: string; generation: string }>(lock ? MENTION_GENERATIONS_FOR_SHARE_SQL : MENTION_GENERATIONS_SQL, [sourceIds]);
}

/** Live pages of the source after id `after` due for the mention pass at extractor `version`, by id, up to `limit`. */
export function listMentionDuePages(raw: MentionRaw, sourceId: string, version: number, after: number, limit: number): Promise<MentionDuePageRow[]> {
  return raw.executeRaw<MentionDuePageRow>(MENTION_DUE_PAGES_SQL, [sourceId, version, after, limit]);
}

/** Every outbound link of the pages in `ids`, with its target and whether it is a plain mention link. */
export function listPageOutLinks(raw: MentionRaw, ids: readonly number[]): Promise<PageOutLinkRow[]> {
  return raw.executeRaw<PageOutLinkRow>(
        `SELECT l.id, l.from_page_id, t.slug AS to_slug, t.source_id AS to_source_id,
                (l.link_source = 'mentions' AND (l.link_kind IS NULL OR l.link_kind = 'plain')) AS plain
           FROM links l JOIN pages t ON t.id = l.to_page_id WHERE l.from_page_id = ANY($1::int[])`,
        [ids]);
}

/** Delete the links in `ids`. */
export async function deleteLinksById(raw: MentionRaw, ids: readonly number[]): Promise<void> {
  await raw.executeRaw('DELETE FROM links WHERE id = ANY($1::int[])', [ids]);
}

/** Record that each page's mention links are current at its revision, `version` and the source `generation`. */
export async function upsertPageMentionState(raw: MentionRaw, sourceId: string, pages: ReadonlyArray<{ id: number; revision: string }>, version: number, generation: string): Promise<void> {
  await raw.executeRaw(
        `INSERT INTO page_mention_state (page_id, source_id, mention_revision, mention_version, mention_generation, mentions_scanned_at)
         SELECT id, $1, rev::uuid, $4, $5::bigint, now() FROM unnest($2::int[], $3::text[]) AS x(id, rev)
         ON CONFLICT (page_id) DO UPDATE SET mention_revision = EXCLUDED.mention_revision, mention_version = EXCLUDED.mention_version,
           mention_generation = EXCLUDED.mention_generation, mentions_scanned_at = EXCLUDED.mentions_scanned_at`,
        [sourceId, pages.map(p => p.id), pages.map(p => p.revision), version, generation]);
}

/** Each source's status state. */
export function readMentionStatusStates(raw: MentionRaw, sourceIds: readonly string[]): Promise<Array<{ source_id: string; state: string }>> {
  return raw.executeRaw<{ source_id: string; state: string }>(
      'SELECT source_id, state FROM mention_index_status WHERE source_id = ANY($1::text[])', [sourceIds]);
}

/** Each source's stored policy fingerprint. */
export function readMentionPolicyFingerprints(raw: MentionRaw, sourceIds: readonly string[]): Promise<Array<{ source_id: string; policy_fingerprint: string | null }>> {
  return raw.executeRaw<{ source_id: string; policy_fingerprint: string | null }>(
    'SELECT source_id, policy_fingerprint FROM mention_index_status WHERE source_id = ANY($1::text[])', [sourceIds]);
}

/** A changed policy: every page of the source is due for the alias refresh and the reconcile. */
export async function resetSourceMentionIndexRevisions(raw: MentionRaw, sourceId: string): Promise<void> {
  await raw.executeRaw('UPDATE page_mention_state SET mention_revision = NULL, alias_revision = NULL WHERE source_id = $1', [sourceId]);
}
