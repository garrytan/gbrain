/**
 * The chronicle statements that `chronicle_backfill` and the advisor's chronicle collector ran through `executeRaw`
 * beside the members of chronicle-ledger.ts, as typed members: SQL once for both SQL engines, so the Rust store serves
 * the same members (rust/docs/store/chronicle-reads.md). Each statement keeps the text its caller ran.
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

/** One queued page of a `--max-usd` campaign and the stamp it carries (src/core/chronicle/campaign.ts). */
export interface ChronicleCampaignRow {
  sourceId: string;
  pageId: number;
  contentHash: string;
  extractorVersion: number;
  slug: string;
  campaignId: string;
  attemptCapUsd: number;
  maxAttempts: number;
  pricingPolicy: string;
  maxUsd: number;
  /** The attempt limit of a row with no stamp (CHRONICLE_DEFAULTS.maxAttempts). */
  defaultMaxAttempts: number;
}

/** The campaign statements of src/core/chronicle/campaign.ts, as they ran. */
export const CHRONICLE_CAMPAIGN_SQL = {
  queue: `INSERT INTO chronicle_page_state AS c (source_id, page_id, content_hash, extractor_version, slug, state, reason, trigger,
       campaign_id, attempt_cap_usd, max_attempts, pricing_policy, campaign_max_usd)
     VALUES ($1, $2, $3, $4, $5, 'pending', NULL, 'backfill', $6, $7::numeric, $8, $9, $10::numeric)
     ON CONFLICT (source_id, page_id, content_hash, extractor_version) DO UPDATE SET
       slug=EXCLUDED.slug, state='pending', reason=NULL, trigger='backfill', principal_kind=NULL, principal_id=NULL,
       request_id=NULL, no_extract=false, next_attempt_at=NULL, attempts=0, cost_attempts='{}',
       campaign_id=EXCLUDED.campaign_id, attempt_cap_usd=EXCLUDED.attempt_cap_usd, max_attempts=EXCLUDED.max_attempts,
       pricing_policy=EXCLUDED.pricing_policy, campaign_max_usd=EXCLUDED.campaign_max_usd, decided_at=now(), updated_at=now()
     WHERE NOT (c.trigger='backfill' AND c.state IN ('pending','failed') AND c.attempts < COALESCE(c.max_attempts, $11))
       AND NOT (c.state IN ('pending','failed') AND c.attempts > 0 AND c.next_attempt_at IS NOT NULL AND c.next_attempt_at > now())
       AND (c.state <> 'extracted' OR EXISTS (SELECT 1 FROM chronicle_page_state newer
         WHERE newer.source_id=c.source_id AND newer.page_id=c.page_id AND newer.content_hash<>c.content_hash
           AND newer.state='extracted' AND newer.updated_at > c.updated_at))
     RETURNING page_id`,
  spent: 'SELECT COALESCE(sum(cost_usd), 0)::float8 AS usd FROM chronicle_page_state WHERE campaign_id=$1',
} as const;

/** Queues one page into a campaign; false when a guard leaves the existing row as it was (see campaign.ts queueCampaignRow). */
export async function queueChronicleCampaignRow(tx: Raw, w: ChronicleCampaignRow): Promise<boolean> {
  const written = await tx.executeRaw(CHRONICLE_CAMPAIGN_SQL.queue,
    [w.sourceId, w.pageId, w.contentHash, w.extractorVersion, w.slug, w.campaignId, w.attemptCapUsd,
      w.maxAttempts, w.pricingPolicy, w.maxUsd, w.defaultMaxAttempts]);
  return written.length > 0;
}

/** The recorded spend of a campaign's rows in USD, unrounded. */
export async function readChronicleCampaignSpentUsd(tx: Raw, campaignId: string): Promise<number> {
  const [row] = await tx.executeRaw<{ usd: number | string | null }>(CHRONICLE_CAMPAIGN_SQL.spent, [campaignId]);
  return Number(row?.usd ?? 0);
}

/** One recent meeting, conversation or calendar page with no event in the timeline, and the fields that date it. */
export interface ChronicleCoverageGapPage {
  type: string;
  effective_date: Date | string | null;
  effective_date_source: string | null;
  fm_date: string | null;
  fm_start: string | null;
}

/** The coverage-gap scan of src/core/advisor/collect-chronicle.ts, as it ran. */
export const CHRONICLE_COVERAGE_SQL = {
  gap: `SELECT p.type, p.effective_date, p.effective_date_source, p.frontmatter->>'date' AS fm_date, p.frontmatter->>'start' AS fm_start
           FROM pages p
          WHERE p.type IN ('meeting','conversation','calendar-event') AND p.deleted_at IS NULL
            AND p.updated_at > now() - interval '30 days'
            AND NOT EXISTS (
              SELECT 1 FROM timeline_entries te
              WHERE te.page_id = p.id AND te.event_page_id IS NOT NULL
            )`,
} as const;

/** Meeting, conversation and calendar pages updated in the last 30 days that no timeline entry links to an event. */
export async function listChronicleCoverageGapPages(tx: Raw): Promise<ChronicleCoverageGapPage[]> {
  return tx.executeRaw<ChronicleCoverageGapPage>(CHRONICLE_COVERAGE_SQL.gap);
}
