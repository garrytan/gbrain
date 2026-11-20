/**
 * Direction-evidence reads and the mirror page mark: the database side of persistence/git-gap.ts
 * `readDirectionEvidence` (which side moved since a page and its committed file last agreed: `gbrain sources git-gap`
 * and the rows-behind scan) and of persistence/mirror-read-only.ts `classifyMirrorPage`. Each statement is the one
 * those helpers ran through `executeRaw`, unchanged. The version ordering keys are digit-only text, which sorts the
 * same under every collation. The Rust engine refuses these members by name: its store keeps no
 * `database_only_reason` and does not serve the evidence read (rust/docs/store/direction-evidence.md).
 */
import type { EngineRawRead } from './cli-reads-ops.ts';
import type { SqlExecutor } from './executor.ts';
import { sqlFragment } from './fragment.ts';

export type { EngineRawRead } from './cli-reads-ops.ts';

/** A recorded file path of a page's version: one per distinct (page, path), for the history walk. */
export interface EvidenceVersionOrigin { page_id: string; slug: string; source_path: string }
/** A live page's knowledge revision (text) and whether its version history has a gap. */
export interface EvidencePageState { id: string; revision: string | null; gap: boolean }
/** A version the evidence read lists: `readable` when it is an inline, live snapshot with a body. */
export interface EvidenceVersionMeta { id: number | string; page_id: string; bytes: number | string; readable: boolean }
/** The body fields of one version, for its content digest. */
export interface EvidenceVersionBody {
  id: number; page_id: string; compiled_truth: string; frontmatter: unknown; timeline: string | null; title: string | null; type: string | null; tags: unknown;
}

/**
 * The evidence reads. They replaced statements the deadline wrapper bounded through executeRaw (a scan run under a
 * deadline reads evidence), so src/core/statement-deadline.ts keeps the bound on them (BOUNDED_TYPED_READS).
 */
export const DIRECTION_EVIDENCE_READS: readonly string[] = ['listEvidenceVersionOrigins', 'readEvidencePageStates', 'listEvidenceVersionMeta', 'readEvidenceVersionBodies'];

const idList = (ids: readonly (string | number)[]) => ids.map(String).join(',');

/** The distinct recorded file paths of the versions of `pageIds` (empty paths left out), with each page's slug. */
export async function listEvidenceVersionOrigins(raw: EngineRawRead, pageIds: readonly string[]): Promise<EvidenceVersionOrigin[]> {
  return raw<EvidenceVersionOrigin>(`SELECT DISTINCT v.page_id::text AS page_id, p.slug, v.source_path
    FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE v.page_id = ANY(string_to_array($1::text, ',')::int[]) AND v.source_path IS NOT NULL AND v.source_path <> ''`, [idList(pageIds)]);
}

/** The live pages among `pageIds` with their knowledge revision and version-history gap flag (soft-deleted pages left out). */
export async function readEvidencePageStates(raw: EngineRawRead, pageIds: readonly string[]): Promise<EvidencePageState[]> {
  return raw<EvidencePageState>(`SELECT id::text, knowledge_revision::text AS revision, version_history_gap_at IS NOT NULL AS gap
        FROM pages WHERE id = ANY(string_to_array($1::text, ',')::bigint[]) AND deleted_at IS NULL`, [idList(pageIds)]);
}

/** The newest `depth` versions of each of `pageIds` (by page, newest first): size and whether the body is readable. */
export async function listEvidenceVersionMeta(raw: EngineRawRead, pageIds: readonly string[], depth: number): Promise<EvidenceVersionMeta[]> {
  if (!pageIds.length) return [];
  return raw<EvidenceVersionMeta>(`SELECT id, page_id::text AS page_id, COALESCE(octet_length(compiled_truth), 0) + COALESCE(octet_length(timeline), 0) AS bytes,
          (COALESCE(body_storage,'inline')='inline' AND NOT COALESCE(is_deleted, false) AND compiled_truth IS NOT NULL) AS readable FROM (SELECT v.id, v.page_id, v.compiled_truth, v.timeline, v.body_storage,
          v.is_deleted, row_number() OVER (PARTITION BY v.page_id ORDER BY v.id DESC) AS rank FROM page_versions v WHERE v.page_id = ANY(string_to_array($1::text, ',')::int[])) ranked
          WHERE rank <= $2 ORDER BY page_id, id DESC`, [idList(pageIds), depth]);
}

/** The body fields of the versions `versionIds` names (any order). */
export async function readEvidenceVersionBodies(raw: EngineRawRead, versionIds: readonly (string | number)[]): Promise<EvidenceVersionBody[]> {
  return raw<EvidenceVersionBody>(`SELECT id, page_id::text AS page_id, compiled_truth, frontmatter, timeline, title, type, tags FROM page_versions
          WHERE id = ANY(string_to_array($1::text, ',')::int[])`, [idList(versionIds)]);
}

/**
 * Marks the page `slug` names in the source `database_only_reason='mirror_read_only'` when it has no reason yet and no
 * recorded file (live or a tombstone); returns the number of pages changed, 0 or 1.
 */
export async function markMirrorReadOnlyPage(exec: SqlExecutor, sourceId: string, slug: string): Promise<number> {
  const result = await exec.run(sqlFragment`UPDATE pages SET database_only_reason='mirror_read_only'
    WHERE source_id=${sourceId} AND slug=${slug} AND database_only_reason IS NULL AND NULLIF(source_path,'') IS NULL`);
  return result.affectedRows;
}
