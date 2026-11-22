import type { ScopedRead } from './brands.ts';
import { sqlFragment, trustedSql } from './fragment.ts';
import type { PageInput } from '../types.ts';
import { boundedBodyPrefixSql } from '../page-window/bounded-lead.ts';

type PageMetadata = Pick<PageInput, 'title' | 'type' | 'frontmatter' | 'tags'>;
export const ATOM_SCAN_REVISION_BATCH_SIZE = 8;

export interface AtomScanRevisionQuery {
  sourceId?: string;
  types: string[];
  slugs?: string[];
  afterPageId: number;
  afterVersionId: number;
  signal?: AbortSignal;
}

export interface AtomScanRevisionCandidate {
  page_id: number;
  revision: string;
  incarnation: string;
  version_id: number;
  archive_hash: string;
  old_page: PageMetadata;
  old_hash: string | null;
  old_truth: string;
  old_timeline: string;
  current_truth: string;
  current_tags: string[];
}

// The column alias is the same in the candidate read and in the final eligibility check.
// Some legacy inline versions have no content_hash. The pin still covers their exact stored body and metadata.
const archiveTruth = trustedSql(boundedBodyPrefixSql('archive', 'truth'));
const archiveTimeline = trustedSql(boundedBodyPrefixSql('archive', 'timeline'));
export const archiveAtomPinSql = sqlFragment`encode(sha256(convert_to(jsonb_build_array(
  ${archiveTruth}, ${archiveTimeline}, archive.title, archive.type, archive.frontmatter, archive.tags,
  archive.trust_tier, archive.content_hash, archive.archived_write_request_id, archive.is_deleted)::text, 'UTF8')), 'hex')`;

/** Source-scoped preimages of retained publications with any prior completed scan. */
export async function readAtomScanRevisionCandidates(exec: ScopedRead, opts: AtomScanRevisionQuery): Promise<AtomScanRevisionCandidate[]> {
  const currentTruth = trustedSql(boundedBodyPrefixSql('p', 'truth'));
  const currentTimeline = trustedSql(boundedBodyPrefixSql('p', 'timeline'));
  const scope = opts.sourceId === undefined ? sqlFragment`` : sqlFragment`AND p.source_id=${opts.sourceId}`;
  const slugs = opts.slugs === undefined ? sqlFragment`` : sqlFragment`AND p.slug=ANY(${opts.slugs}::text[])`;
  const { rows } = await exec.run<AtomScanRevisionCandidate>(sqlFragment`SELECT p.id AS page_id, p.knowledge_revision AS revision,
    s.incarnation, archive.id AS version_id, archive.content_hash AS old_hash, ${archiveAtomPinSql} AS archive_hash,
    ${currentTruth} AS current_truth, ${archiveTruth} AS old_truth, ${archiveTimeline} AS old_timeline,
    ARRAY(SELECT t.tag FROM tags t WHERE t.page_id=p.id) AS current_tags,
    jsonb_build_object('title',archive.title,'type',archive.type,'frontmatter',archive.frontmatter,'tags',archive.tags) AS old_page
    FROM pages p JOIN sources s ON s.id=p.source_id AND NOT s.archived
    JOIN persistence_requests current_write ON current_write.id=p.revision_write_request_id
      AND current_write.source_id=s.id AND current_write.source_incarnation=s.incarnation
      AND current_write.page_id=p.id AND current_write.slug=p.slug
      AND current_write.operation IN ('remember','put_page') AND current_write.state='committed'
    JOIN page_versions archive ON archive.page_id=p.id
    JOIN persistence_requests archived_by ON archived_by.id=archive.archived_write_request_id
      AND archived_by.source_id=s.id AND archived_by.source_incarnation=s.incarnation
      AND archived_by.page_id=p.id AND archived_by.slug=p.slug
      AND archived_by.operation IN ('remember','put_page') AND archived_by.state='committed'
    WHERE p.deleted_at IS NULL AND p.type=ANY(${opts.types}::text[]) ${scope} ${slugs}
      AND (p.id,archive.id)>(${opts.afterPageId}::integer,${opts.afterVersionId}::integer)
      AND archive.is_deleted=false AND p.title=archive.title AND p.type=archive.type
      AND p.trust_tier IS NOT DISTINCT FROM archive.trust_tier AND p.frontmatter=archive.frontmatter
      AND ${currentTimeline}=${archiveTimeline} AND ${currentTruth}<>${archiveTruth} AND archive.tags IS NOT NULL
      AND EXISTS (SELECT 1 FROM extract_atoms_page_state scan WHERE scan.source_incarnation=s.incarnation
        AND scan.page_id=p.id AND scan.tombstoned AND scan.partial_input_chars IS NULL)
    ORDER BY p.id, archive.id LIMIT ${ATOM_SCAN_REVISION_BATCH_SIZE}`, { signal: opts.signal });
  return rows;
}
