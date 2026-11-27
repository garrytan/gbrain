/**
 * The page batch that `chronicle-backfill` (src/core/chronicle/backfill.ts) ran through `executeRaw`, as a typed member:
 * SQL once for both SQL engines, so the Rust store serves the same member (rust/docs/store/chronicle-reads.md). The text
 * is the one the caller built (pinned in test/engine-sql-caller-raw-sql-pins.test.ts). Carried from 6f801f6d17
 * (rust-engine/chronicle-reads-rebased c827c0c60c), the batch read only.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** The two constants the backfill page batch spells into its text: the batch size and CHRONICLE_DEFAULTS.maxAttempts. */
export const CHRONICLE_BACKFILL_BATCH = { pageBatch: 500, maxAttempts: 5 } as const;

/** One page batch of `chronicle-backfill`: chronicle-shaped pages after `afterId`, in id order. */
export interface ChronicleBackfillBatchQuery {
  /** Page types that qualify (CHRONICLE_TYPES). */
  types: string[];
  /** `LIKE` patterns of slugs that qualify whatever their type (RESCUE_SLUG_PREFIXES with `%`). */
  slugPatterns: string[];
  extractorVersion: number;
  /** The federated source scope; wins over `sourceId`. Neither means every source. */
  sourceIds?: string[];
  sourceId?: string;
  /** `YYYY-MM-DD`: only pages updated on or after that date. */
  since?: string;
  afterId: number;
}

/** One page of the batch; `done` is a ledger row at the page's content and extractor version that needs no new queue. */
export interface ChronicleBackfillPage {
  id: number;
  source_id: string;
  slug: string;
  type: string;
  compiled_truth: string | null;
  frontmatter: Record<string, unknown> | null;
  effective_date: Date | string | null;
  effective_date_source: string | null;
  content_hash: string | null;
  done: boolean;
}

/** The page batch of src/core/chronicle/backfill.ts, one text per scope and `since` shape, as it ran. */
export const CHRONICLE_BACKFILL_BATCH_SQL = {
  all: `SELECT p.id, p.source_id, p.slug, p.type, coalesce(p.compiled_truth, p.truth_lead) AS compiled_truth, p.frontmatter, p.effective_date, p.effective_date_source, p.content_hash,
              EXISTS (SELECT 1 FROM chronicle_page_state c WHERE c.page_id=p.id AND c.content_hash=p.content_hash
                AND c.extractor_version=$3 AND (c.state='extracted' OR (c.state IN ('pending','failed') AND c.trigger='backfill' AND c.attempts < 5))) AS done
         FROM pages p
        WHERE p.deleted_at IS NULL AND (p.type = ANY($1::text[]) OR p.slug LIKE ANY($2::text[])) AND p.id > $4
        ORDER BY p.id LIMIT 500`,
  allSince: `SELECT p.id, p.source_id, p.slug, p.type, coalesce(p.compiled_truth, p.truth_lead) AS compiled_truth, p.frontmatter, p.effective_date, p.effective_date_source, p.content_hash,
              EXISTS (SELECT 1 FROM chronicle_page_state c WHERE c.page_id=p.id AND c.content_hash=p.content_hash
                AND c.extractor_version=$3 AND (c.state='extracted' OR (c.state IN ('pending','failed') AND c.trigger='backfill' AND c.attempts < 5))) AS done
         FROM pages p
        WHERE p.deleted_at IS NULL AND (p.type = ANY($1::text[]) OR p.slug LIKE ANY($2::text[])) AND p.updated_at >= $4::date AND p.id > $5
        ORDER BY p.id LIMIT 500`,
  sources: `SELECT p.id, p.source_id, p.slug, p.type, coalesce(p.compiled_truth, p.truth_lead) AS compiled_truth, p.frontmatter, p.effective_date, p.effective_date_source, p.content_hash,
              EXISTS (SELECT 1 FROM chronicle_page_state c WHERE c.page_id=p.id AND c.content_hash=p.content_hash
                AND c.extractor_version=$3 AND (c.state='extracted' OR (c.state IN ('pending','failed') AND c.trigger='backfill' AND c.attempts < 5))) AS done
         FROM pages p
        WHERE p.deleted_at IS NULL AND (p.type = ANY($1::text[]) OR p.slug LIKE ANY($2::text[])) AND p.source_id = ANY($4::text[]) AND p.id > $5
        ORDER BY p.id LIMIT 500`,
  sourcesSince: `SELECT p.id, p.source_id, p.slug, p.type, coalesce(p.compiled_truth, p.truth_lead) AS compiled_truth, p.frontmatter, p.effective_date, p.effective_date_source, p.content_hash,
              EXISTS (SELECT 1 FROM chronicle_page_state c WHERE c.page_id=p.id AND c.content_hash=p.content_hash
                AND c.extractor_version=$3 AND (c.state='extracted' OR (c.state IN ('pending','failed') AND c.trigger='backfill' AND c.attempts < 5))) AS done
         FROM pages p
        WHERE p.deleted_at IS NULL AND (p.type = ANY($1::text[]) OR p.slug LIKE ANY($2::text[])) AND p.source_id = ANY($4::text[]) AND p.updated_at >= $5::date AND p.id > $6
        ORDER BY p.id LIMIT 500`,
  source: `SELECT p.id, p.source_id, p.slug, p.type, coalesce(p.compiled_truth, p.truth_lead) AS compiled_truth, p.frontmatter, p.effective_date, p.effective_date_source, p.content_hash,
              EXISTS (SELECT 1 FROM chronicle_page_state c WHERE c.page_id=p.id AND c.content_hash=p.content_hash
                AND c.extractor_version=$3 AND (c.state='extracted' OR (c.state IN ('pending','failed') AND c.trigger='backfill' AND c.attempts < 5))) AS done
         FROM pages p
        WHERE p.deleted_at IS NULL AND (p.type = ANY($1::text[]) OR p.slug LIKE ANY($2::text[])) AND p.source_id = $4 AND p.id > $5
        ORDER BY p.id LIMIT 500`,
  sourceSince: `SELECT p.id, p.source_id, p.slug, p.type, coalesce(p.compiled_truth, p.truth_lead) AS compiled_truth, p.frontmatter, p.effective_date, p.effective_date_source, p.content_hash,
              EXISTS (SELECT 1 FROM chronicle_page_state c WHERE c.page_id=p.id AND c.content_hash=p.content_hash
                AND c.extractor_version=$3 AND (c.state='extracted' OR (c.state IN ('pending','failed') AND c.trigger='backfill' AND c.attempts < 5))) AS done
         FROM pages p
        WHERE p.deleted_at IS NULL AND (p.type = ANY($1::text[]) OR p.slug LIKE ANY($2::text[])) AND p.source_id = $4 AND p.updated_at >= $5::date AND p.id > $6
        ORDER BY p.id LIMIT 500`,
} as const;

/** The next page batch of a backfill scan. */
export async function readChronicleBackfillBatch(tx: Raw, q: ChronicleBackfillBatchQuery): Promise<ChronicleBackfillPage[]> {
  const params: unknown[] = [q.types, q.slugPatterns, q.extractorVersion];
  let scope: 'all' | 'sources' | 'source' = 'all';
  if (q.sourceIds?.length) { params.push(q.sourceIds); scope = 'sources'; }
  else if (q.sourceId) { params.push(q.sourceId); scope = 'source'; }
  if (q.since) params.push(q.since);
  params.push(q.afterId);
  const key = q.since ? (`${scope}Since` as const) : scope;
  return tx.executeRaw<ChronicleBackfillPage>(CHRONICLE_BACKFILL_BATCH_SQL[key], params);
}
