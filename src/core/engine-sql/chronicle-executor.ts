/**
 * The chronicle executor's statements (chronicle/execute.ts, chronicle/campaign.ts, cycle/chronicle.ts,
 * chronicle/publish.ts, chronicle/event-identity.ts) as one typed engine member, `chronicleStore()`: SQL once for both
 * SQL engines, each statement with the text and parameters its caller ran through `executeRaw`, so the Rust store
 * serves the same calls over its chronicle records (rust/docs/store/chronicle-ledger.md). Called on a transaction
 * engine, every call runs in that transaction. Rows come back as the SQL engines return them; the callers keep their
 * own coercions (`Number(...)`), so their output is unchanged.
 */
import type { BrainEngine } from '../engine.ts';
import type { ChronicleLedgerRow } from '../chronicle/contract.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** `(source_id, page_id, content_hash, extractor_version)`, the ledger row's primary key, in that order. */
export type ChronicleKeyTuple = readonly [sourceId: string, pageId: number, contentHash: string, extractorVersion: number];

/** One page the phase's discovery reads. */
export interface ChronicleDiscoveryPage {
  id: number; slug: string; type: string; compiled_truth: string | null; frontmatter: Record<string, unknown> | null;
  effective_date: Date | string | null; effective_date_source: string | null; content_hash: string; updated_at: Date | string;
  body_storage: 'inline' | 'segmented'; body_bytes: number | null;
}

/** The stamp a backfill campaign queues a row under (chronicle/campaign.ts). */
export interface ChronicleCampaignQueue {
  sourceId: string; pageId: number; contentHash: string; extractorVersion: number; slug: string;
  campaignId: string; attemptCapUsd: number; maxAttempts: number; pricingPolicy: string; maxUsd: number; defaultMaxAttempts: number;
}

/** The outcome columns `finish` writes, in the order of its statement's parameters $5 to $16. */
export interface ChronicleFinish {
  state: string; reason: string | null; nextAttemptAt: string | null; unpriced: boolean | null;
  eventSlugs: string[] | null; eventHashes: string[] | null; attempt: number;
  judgeInputHash: string | null; judgeWindowChars: number | null; judgeWindowHash: string | null;
  keepJudged: boolean; failures: number;
}

export interface ChronicleStore {
  queueCampaignRow(q: ChronicleCampaignQueue): Promise<boolean>;
  campaignSpentUsd(campaignId: string): Promise<{ usd: number | string | null } | undefined>;
  failExhaustedCampaignRows(defaultMaxAttempts: number): Promise<void>;
  discoveryPages(sourceId: string, activatedAt: string, types: string[], slugPatterns: string[], extractorVersion: number,
    limit: number): Promise<ChronicleDiscoveryPage[]>;
  candidates(sourceId: string, extractorVersion: number, enabled: boolean, defaultMaxAttempts: number, retireReasons: string[],
    limit: number): Promise<ChronicleLedgerRow[]>;
  supersedeStaleRows(): Promise<void>;
  claim(key: ChronicleKeyTuple, leaseMs: number, state: string, defaultMaxAttempts: number): Promise<ChronicleLedgerRow | null>;
  setNextAttempt(key: ChronicleKeyTuple, at: string | null): Promise<void>;
  addAttemptCost(key: ChronicleKeyTuple, costUsd: number, attempt: number): Promise<void>;
  finish(key: ChronicleKeyTuple, f: ChronicleFinish): Promise<void>;
  latestJudged(sourceId: string, pageId: number, extractorVersion: number, contentHash: string, retireReasons: string[],
    retiredBy: string): Promise<{ state: string; judge_input_hash: string | null; retired: boolean } | undefined>;
  inputFailures(sourceId: string, pageId: number, extractorVersion: number, inputHash: string):
    Promise<{ attempts: number | string | null; refused: boolean | null } | undefined>;
  liveEventSlugs(sourceId: string, depthSlug: string): Promise<{ slug: string }[]>;
  eventProducers(sourceId: string, pageId: number, slugs: string[]):
    Promise<{ event_slugs: string[]; judge_window_chars: number | null; judge_window_hash: string | null }[]>;
  addAttempt(key: ChronicleKeyTuple): Promise<{ attempts: number }[]>;
  liveEventHashes(sourceId: string, slugs: string[]): Promise<{ slug: string; content_hash: string | null }[]>;
  livePageId(sourceId: string, slug: string): Promise<{ id: number } | undefined>;
  deleteEventTimeline(sourceId: string, slug: string): Promise<void>;
  eventTimelineEntry(eventPageId: number, date: string): Promise<{ id: number } | undefined>;
  eventDiscriminators(sourceId: string, slugs: string[]):
    Promise<{ slug: string; when: string | null; where: string | null; kind: string | null }[]>;
}

/** Each statement as its caller ran it. */
export const CHRONICLE_EXECUTOR_SQL = {
  queueCampaignRow: `INSERT INTO chronicle_page_state AS c (source_id, page_id, content_hash, extractor_version, slug, state, reason, trigger,
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
  campaignSpent: `SELECT COALESCE(sum(cost_usd), 0)::float8 AS usd FROM chronicle_page_state WHERE campaign_id=$1`,
  failExhaustedCampaign: `UPDATE chronicle_page_state SET state='failed', reason='campaign_exhausted', next_attempt_at=NULL, updated_at=now()
      WHERE campaign_id IS NOT NULL AND state='pending' AND attempts >= COALESCE(max_attempts, $1)
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())`,
  discoveryPages: `SELECT p.id, p.slug, p.type, coalesce(p.compiled_truth, p.truth_lead) AS compiled_truth, p.body_storage, p.body_bytes, p.frontmatter, p.effective_date, p.effective_date_source, p.content_hash, p.updated_at
       FROM pages p
      WHERE p.source_id=$1 AND p.deleted_at IS NULL AND p.content_hash IS NOT NULL AND p.updated_at >= $2::timestamptz
        AND p.type <> 'event' AND p.slug NOT LIKE 'life/%'
        AND (p.type = ANY($3::text[]) OR p.slug LIKE ANY($4::text[]) OR EXISTS (SELECT 1 FROM chronicle_page_state e
          WHERE e.page_id=p.id AND e.state='extracted' AND cardinality(e.event_hashes) > 0))
        AND NOT EXISTS (SELECT 1 FROM chronicle_page_state c
          WHERE c.page_id=p.id AND c.content_hash=p.content_hash AND c.extractor_version=$5)
      ORDER BY p.updated_at, p.id LIMIT $6`,
  candidates: `SELECT c.* FROM chronicle_page_state c
       JOIN pages p ON p.id=c.page_id AND p.source_id=c.source_id AND p.content_hash=c.content_hash AND p.deleted_at IS NULL
      WHERE c.source_id=$1 AND c.extractor_version=$2
        AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= now())
        AND ((c.state='pending' AND ($3 OR c.trigger='backfill') AND (c.max_attempts IS NULL OR c.attempts < c.max_attempts))
          OR (c.state='failed' AND c.attempts < COALESCE(c.max_attempts, $4) AND ($3 OR c.trigger='backfill')
            AND (c.next_attempt_at IS NOT NULL OR c.reason IN ('judge_llm_unavailable','no_pricing')))
          OR (c.state='skipped' AND c.next_attempt_at IS NOT NULL AND c.reason = ANY($5::text[])))
      ORDER BY (c.state='skipped') DESC, (c.trigger='auto') DESC, c.decided_at, c.page_id
      LIMIT $6`,
  supersede: `UPDATE chronicle_page_state c SET state='skipped', reason='superseded', next_attempt_at=NULL, updated_at=now()
        WHERE c.state IN ('pending','failed') AND NOT EXISTS (SELECT 1 FROM pages p
          WHERE p.id=c.page_id AND p.content_hash=c.content_hash AND p.deleted_at IS NULL)`,
  claim: `UPDATE chronicle_page_state SET next_attempt_at = now() + ($5::int * interval '1 millisecond'),
       attempts = attempts + CASE WHEN campaign_id IS NOT NULL AND state IN ('pending','failed') THEN 1 ELSE 0 END
      WHERE source_id=$1 AND page_id=$2 AND content_hash=$3 AND extractor_version=$4 AND state=$6
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        AND NOT (campaign_id IS NOT NULL AND state IN ('pending','failed') AND attempts >= COALESCE(max_attempts, $7))
      RETURNING *`,
  setNextAttempt: `UPDATE chronicle_page_state SET next_attempt_at=$5::timestamptz
      WHERE source_id=$1 AND page_id=$2 AND content_hash=$3 AND extractor_version=$4`,
  addAttemptCost: `UPDATE chronicle_page_state SET cost_usd=COALESCE(cost_usd, 0) + $5::numeric, cost_attempts=array_append(cost_attempts, $6::int)
        WHERE source_id=$1 AND page_id=$2 AND content_hash=$3 AND extractor_version=$4 AND NOT ($6::int = ANY(cost_attempts))`,
  finish: `UPDATE chronicle_page_state SET state=$5, reason=$6, next_attempt_at=$7::timestamptz, unpriced=COALESCE($8::boolean, unpriced),
       event_slugs=COALESCE($9::text[], event_slugs), event_hashes=COALESCE($10::text[], event_hashes),
       judge_input_hash=CASE WHEN $15::boolean THEN judge_input_hash ELSE $12 END,
       judge_window_chars=CASE WHEN $15::boolean THEN judge_window_chars ELSE $13::int END,
       judge_window_hash=CASE WHEN $15::boolean THEN judge_window_hash ELSE $14 END,
       judge_input_failures=judge_input_failures + $16::int, updated_at=now()
      WHERE source_id=$1 AND page_id=$2 AND content_hash=$3 AND extractor_version=$4 AND attempts=$11`,
  latestJudged: `SELECT c.state, c.judge_input_hash, EXISTS (SELECT 1 FROM pages e WHERE e.source_id=c.source_id AND e.slug = ANY(c.event_slugs)
        AND e.deleted_at IS NOT NULL AND e.frontmatter->>'retired_by' = $6) AS retired
       FROM chronicle_page_state c
      WHERE c.source_id=$1 AND c.page_id=$2 AND c.extractor_version=$3 AND c.content_hash<>$4
        AND (c.state='extracted' OR (c.state='skipped' AND c.reason = ANY($5::text[])))
      ORDER BY c.decided_at DESC, c.updated_at DESC LIMIT 1`,
  inputFailures: `SELECT sum(judge_input_failures) AS attempts, bool_or(state='skipped' AND reason='judge_refused') AS refused FROM chronicle_page_state
      WHERE source_id=$1 AND page_id=$2 AND extractor_version=$3 AND judge_input_hash=$4`,
  liveEventSlugs: `SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND type='event'
        AND frontmatter->'event'->>'depth' = $2 AND frontmatter->>'captured_via' LIKE 'life-chronicle:%'`,
  eventProducers: `SELECT event_slugs, judge_window_chars, judge_window_hash FROM chronicle_page_state
      WHERE source_id=$1 AND page_id=$2 AND event_slugs && $3::text[]`,
  addAttempt: `UPDATE chronicle_page_state SET attempts=attempts+1 WHERE source_id=$1 AND page_id=$2 AND content_hash=$3 AND extractor_version=$4 RETURNING attempts`,
  liveEventHashes: `SELECT slug, content_hash FROM pages WHERE source_id=$1 AND slug=ANY($2::text[]) AND deleted_at IS NULL`,
  livePageId: `SELECT id FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL`,
  deleteEventTimeline: `DELETE FROM timeline_entries t USING pages p WHERE p.id=t.event_page_id AND p.source_id=$1 AND p.slug=$2`,
  eventTimelineEntry: `SELECT id FROM timeline_entries WHERE event_page_id=$1 AND date=$2::date`,
  eventDiscriminators: `SELECT slug, frontmatter->'event'->>'when' AS "when", frontmatter->'event'->>'where' AS "where", frontmatter->'event'->>'kind' AS kind
       FROM pages WHERE source_id=$1 AND slug = ANY($2::text[])`,
} as const;

/** The chronicle store over `exec` (the engine, or a transaction engine). */
export async function chronicleStore(exec: Raw): Promise<ChronicleStore> {
  const S = CHRONICLE_EXECUTOR_SQL;
  return {
    async queueCampaignRow(q) {
      const written = await exec.executeRaw(S.queueCampaignRow, [q.sourceId, q.pageId, q.contentHash, q.extractorVersion, q.slug, q.campaignId,
        q.attemptCapUsd, q.maxAttempts, q.pricingPolicy, q.maxUsd, q.defaultMaxAttempts]);
      return written.length > 0;
    },
    async campaignSpentUsd(campaignId) {
      const [row] = await exec.executeRaw<{ usd: number | string | null }>(S.campaignSpent, [campaignId]);
      return row;
    },
    async failExhaustedCampaignRows(defaultMaxAttempts) { await exec.executeRaw(S.failExhaustedCampaign, [defaultMaxAttempts]); },
    discoveryPages: (sourceId, activatedAt, types, slugPatterns, extractorVersion, limit) =>
      exec.executeRaw<ChronicleDiscoveryPage>(S.discoveryPages, [sourceId, activatedAt, types, slugPatterns, extractorVersion, limit]),
    candidates: (sourceId, extractorVersion, enabled, defaultMaxAttempts, retireReasons, limit) =>
      exec.executeRaw<ChronicleLedgerRow>(S.candidates, [sourceId, extractorVersion, enabled, defaultMaxAttempts, retireReasons, limit]),
    async supersedeStaleRows() { await exec.executeRaw(S.supersede); },
    async claim(key, leaseMs, state, defaultMaxAttempts) {
      const [claimed] = await exec.executeRaw<ChronicleLedgerRow>(S.claim, [...key, leaseMs, state, defaultMaxAttempts]);
      return claimed ?? null;
    },
    async setNextAttempt(key, at) { await exec.executeRaw(S.setNextAttempt, [...key, at]); },
    async addAttemptCost(key, costUsd, attempt) { await exec.executeRaw(S.addAttemptCost, [...key, costUsd, attempt]); },
    async finish(key, f) {
      await exec.executeRaw(S.finish, [...key, f.state, f.reason, f.nextAttemptAt, f.unpriced, f.eventSlugs, f.eventHashes, f.attempt,
        f.judgeInputHash, f.judgeWindowChars, f.judgeWindowHash, f.keepJudged, f.failures]);
    },
    async latestJudged(sourceId, pageId, extractorVersion, contentHash, retireReasons, retiredBy) {
      const [latest] = await exec.executeRaw<{ state: string; judge_input_hash: string | null; retired: boolean }>(S.latestJudged,
        [sourceId, pageId, extractorVersion, contentHash, retireReasons, retiredBy]);
      return latest;
    },
    async inputFailures(sourceId, pageId, extractorVersion, inputHash) {
      const [prior] = await exec.executeRaw<{ attempts: number | string | null; refused: boolean | null }>(S.inputFailures,
        [sourceId, pageId, extractorVersion, inputHash]);
      return prior;
    },
    liveEventSlugs: (sourceId, depthSlug) => exec.executeRaw<{ slug: string }>(S.liveEventSlugs, [sourceId, depthSlug]),
    eventProducers: (sourceId, pageId, slugs) =>
      exec.executeRaw<{ event_slugs: string[]; judge_window_chars: number | null; judge_window_hash: string | null }>(S.eventProducers, [sourceId, pageId, slugs]),
    addAttempt: (key) => exec.executeRaw<{ attempts: number }>(S.addAttempt, [...key]),
    liveEventHashes: (sourceId, slugs) => exec.executeRaw<{ slug: string; content_hash: string | null }>(S.liveEventHashes, [sourceId, slugs]),
    async livePageId(sourceId, slug) { const [row] = await exec.executeRaw<{ id: number }>(S.livePageId, [sourceId, slug]); return row; },
    async deleteEventTimeline(sourceId, slug) { await exec.executeRaw(S.deleteEventTimeline, [sourceId, slug]); },
    async eventTimelineEntry(eventPageId, date) { const [row] = await exec.executeRaw<{ id: number }>(S.eventTimelineEntry, [eventPageId, date]); return row; },
    eventDiscriminators: (sourceId, slugs) =>
      exec.executeRaw<{ slug: string; when: string | null; where: string | null; kind: string | null }>(S.eventDiscriminators, [sourceId, slugs]),
  };
}
