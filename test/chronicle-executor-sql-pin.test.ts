/**
 * The chronicle executor statements moved into `chronicleStore()` (engine-sql/chronicle-executor.ts) keep the SQL text
 * their callers ran through `executeRaw` at rust-engine/chronicle-decision-rust 2d1ee9e0d2 (chronicle/execute.ts,
 * campaign.ts, publish.ts, event-identity.ts and cycle/chronicle.ts), byte for byte, so PGLite and Postgres run the
 * same statements as before.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each of the 20 store methods sends exactly one statement, and its text is the pinned caller text.
 *  - Regression: a moved statement that changed text would change PGLite/Postgres behavior unnoticed.
 *  - Why existing coverage misses it: the SQL-text goldens cover engine members built from fragments, not this store.
 *  - Seam: a recording executor in place of the database.
 */
import { describe, expect, test } from 'bun:test';
import { chronicleStore, type ChronicleStore } from '../src/core/engine-sql/chronicle-executor.ts';

/** Each caller's statement at 2d1ee9e0d2, copied verbatim. */
const PINNED = {
  queueCampaignRow: "INSERT INTO chronicle_page_state AS c (source_id, page_id, content_hash, extractor_version, slug, state, reason, trigger,\n       campaign_id, attempt_cap_usd, max_attempts, pricing_policy, campaign_max_usd)\n     VALUES ($1, $2, $3, $4, $5, 'pending', NULL, 'backfill', $6, $7::numeric, $8, $9, $10::numeric)\n     ON CONFLICT (source_id, page_id, content_hash, extractor_version) DO UPDATE SET\n       slug=EXCLUDED.slug, state='pending', reason=NULL, trigger='backfill', principal_kind=NULL, principal_id=NULL,\n       request_id=NULL, no_extract=false, next_attempt_at=NULL, attempts=0, cost_attempts='{}',\n       campaign_id=EXCLUDED.campaign_id, attempt_cap_usd=EXCLUDED.attempt_cap_usd, max_attempts=EXCLUDED.max_attempts,\n       pricing_policy=EXCLUDED.pricing_policy, campaign_max_usd=EXCLUDED.campaign_max_usd, decided_at=now(), updated_at=now()\n     WHERE NOT (c.trigger='backfill' AND c.state IN ('pending','failed') AND c.attempts < COALESCE(c.max_attempts, $11))\n       AND NOT (c.state IN ('pending','failed') AND c.attempts > 0 AND c.next_attempt_at IS NOT NULL AND c.next_attempt_at > now())\n       AND (c.state <> 'extracted' OR EXISTS (SELECT 1 FROM chronicle_page_state newer\n         WHERE newer.source_id=c.source_id AND newer.page_id=c.page_id AND newer.content_hash<>c.content_hash\n           AND newer.state='extracted' AND newer.updated_at > c.updated_at))\n     RETURNING page_id",
  campaignSpent: "SELECT COALESCE(sum(cost_usd), 0)::float8 AS usd FROM chronicle_page_state WHERE campaign_id=$1",
  failExhaustedCampaign: "UPDATE chronicle_page_state SET state='failed', reason='campaign_exhausted', next_attempt_at=NULL, updated_at=now()\n      WHERE campaign_id IS NOT NULL AND state='pending' AND attempts >= COALESCE(max_attempts, $1)\n        AND (next_attempt_at IS NULL OR next_attempt_at <= now())",
  discoveryPages: "SELECT p.id, p.slug, p.type, coalesce(p.compiled_truth, p.truth_lead) AS compiled_truth, p.body_storage, p.body_bytes, p.frontmatter, p.effective_date, p.effective_date_source, p.content_hash, p.updated_at\n       FROM pages p\n      WHERE p.source_id=$1 AND p.deleted_at IS NULL AND p.content_hash IS NOT NULL AND p.updated_at >= $2::timestamptz\n        AND p.type <> 'event' AND p.slug NOT LIKE 'life/%'\n        AND (p.type = ANY($3::text[]) OR p.slug LIKE ANY($4::text[]) OR EXISTS (SELECT 1 FROM chronicle_page_state e\n          WHERE e.page_id=p.id AND e.state='extracted' AND cardinality(e.event_hashes) > 0))\n        AND NOT EXISTS (SELECT 1 FROM chronicle_page_state c\n          WHERE c.page_id=p.id AND c.content_hash=p.content_hash AND c.extractor_version=$5)\n      ORDER BY p.updated_at, p.id LIMIT $6",
  candidates: "SELECT c.* FROM chronicle_page_state c\n       JOIN pages p ON p.id=c.page_id AND p.source_id=c.source_id AND p.content_hash=c.content_hash AND p.deleted_at IS NULL\n      WHERE c.source_id=$1 AND c.extractor_version=$2\n        AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= now())\n        AND ((c.state='pending' AND ($3 OR c.trigger='backfill') AND (c.max_attempts IS NULL OR c.attempts < c.max_attempts))\n          OR (c.state='failed' AND c.attempts < COALESCE(c.max_attempts, $4) AND ($3 OR c.trigger='backfill')\n            AND (c.next_attempt_at IS NOT NULL OR c.reason IN ('judge_llm_unavailable','no_pricing')))\n          OR (c.state='skipped' AND c.next_attempt_at IS NOT NULL AND c.reason = ANY($5::text[])))\n      ORDER BY (c.state='skipped') DESC, (c.trigger='auto') DESC, c.decided_at, c.page_id\n      LIMIT $6",
  supersede: "UPDATE chronicle_page_state c SET state='skipped', reason='superseded', next_attempt_at=NULL, updated_at=now()\n        WHERE c.state IN ('pending','failed') AND NOT EXISTS (SELECT 1 FROM pages p\n          WHERE p.id=c.page_id AND p.content_hash=c.content_hash AND p.deleted_at IS NULL)",
  claim: "UPDATE chronicle_page_state SET next_attempt_at = now() + ($5::int * interval '1 millisecond'),\n       attempts = attempts + CASE WHEN campaign_id IS NOT NULL AND state IN ('pending','failed') THEN 1 ELSE 0 END\n      WHERE source_id=$1 AND page_id=$2 AND content_hash=$3 AND extractor_version=$4 AND state=$6\n        AND (next_attempt_at IS NULL OR next_attempt_at <= now())\n        AND NOT (campaign_id IS NOT NULL AND state IN ('pending','failed') AND attempts >= COALESCE(max_attempts, $7))\n      RETURNING *",
  setNextAttempt: "UPDATE chronicle_page_state SET next_attempt_at=$5::timestamptz\n      WHERE source_id=$1 AND page_id=$2 AND content_hash=$3 AND extractor_version=$4",
  addAttemptCost: "UPDATE chronicle_page_state SET cost_usd=COALESCE(cost_usd, 0) + $5::numeric, cost_attempts=array_append(cost_attempts, $6::int)\n        WHERE source_id=$1 AND page_id=$2 AND content_hash=$3 AND extractor_version=$4 AND NOT ($6::int = ANY(cost_attempts))",
  finish: "UPDATE chronicle_page_state SET state=$5, reason=$6, next_attempt_at=$7::timestamptz, unpriced=COALESCE($8::boolean, unpriced),\n       event_slugs=COALESCE($9::text[], event_slugs), event_hashes=COALESCE($10::text[], event_hashes),\n       judge_input_hash=CASE WHEN $15::boolean THEN judge_input_hash ELSE $12 END,\n       judge_window_chars=CASE WHEN $15::boolean THEN judge_window_chars ELSE $13::int END,\n       judge_window_hash=CASE WHEN $15::boolean THEN judge_window_hash ELSE $14 END,\n       judge_input_failures=judge_input_failures + $16::int, updated_at=now()\n      WHERE source_id=$1 AND page_id=$2 AND content_hash=$3 AND extractor_version=$4 AND attempts=$11",
  latestJudged: "SELECT c.state, c.judge_input_hash, EXISTS (SELECT 1 FROM pages e WHERE e.source_id=c.source_id AND e.slug = ANY(c.event_slugs)\n        AND e.deleted_at IS NOT NULL AND e.frontmatter->>'retired_by' = $6) AS retired\n       FROM chronicle_page_state c\n      WHERE c.source_id=$1 AND c.page_id=$2 AND c.extractor_version=$3 AND c.content_hash<>$4\n        AND (c.state='extracted' OR (c.state='skipped' AND c.reason = ANY($5::text[])))\n      ORDER BY c.decided_at DESC, c.updated_at DESC LIMIT 1",
  inputFailures: "SELECT sum(judge_input_failures) AS attempts, bool_or(state='skipped' AND reason='judge_refused') AS refused FROM chronicle_page_state\n      WHERE source_id=$1 AND page_id=$2 AND extractor_version=$3 AND judge_input_hash=$4",
  liveEventSlugs: "SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND type='event'\n        AND frontmatter->'event'->>'depth' = $2 AND frontmatter->>'captured_via' LIKE 'life-chronicle:%'",
  eventProducers: "SELECT event_slugs, judge_window_chars, judge_window_hash FROM chronicle_page_state\n      WHERE source_id=$1 AND page_id=$2 AND event_slugs && $3::text[]",
  addAttempt: "UPDATE chronicle_page_state SET attempts=attempts+1 WHERE source_id=$1 AND page_id=$2 AND content_hash=$3 AND extractor_version=$4 RETURNING attempts",
  liveEventHashes: "SELECT slug, content_hash FROM pages WHERE source_id=$1 AND slug=ANY($2::text[]) AND deleted_at IS NULL",
  livePageId: "SELECT id FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL",
  deleteEventTimeline: "DELETE FROM timeline_entries t USING pages p WHERE p.id=t.event_page_id AND p.source_id=$1 AND p.slug=$2",
  eventTimelineEntry: "SELECT id FROM timeline_entries WHERE event_page_id=$1 AND date=$2::date",
  eventDiscriminators: "SELECT slug, frontmatter->'event'->>'when' AS \"when\", frontmatter->'event'->>'where' AS \"where\", frontmatter->'event'->>'kind' AS kind\n       FROM pages WHERE source_id=$1 AND slug = ANY($2::text[])",
} as const;

const KEY = ['default', 1, 'h', 2] as const;

const CASES: Array<[keyof typeof PINNED, (s: ChronicleStore) => Promise<unknown>]> = [
  ["queueCampaignRow", s => s.queueCampaignRow({ sourceId: 'default', pageId: 1, contentHash: 'h', extractorVersion: 2, slug: 'meetings/a', campaignId: 'c', attemptCapUsd: 0.5, maxAttempts: 2, pricingPolicy: 'enforced', maxUsd: 5, defaultMaxAttempts: 3 })],
  ["campaignSpent", s => s.campaignSpentUsd('c')],
  ["failExhaustedCampaign", s => s.failExhaustedCampaignRows(3)],
  ["discoveryPages", s => s.discoveryPages('default', '2026-01-01T00:00:00.000Z', ['meeting'], ['meetings/%'], 2, 200)],
  ["candidates", s => s.candidates('default', 2, true, 3, ['retired'], 50)],
  ["supersede", s => s.supersedeStaleRows()],
  ["claim", s => s.claim(KEY, 600000, 'pending', 3)],
  ["setNextAttempt", s => s.setNextAttempt(KEY, null)],
  ["addAttemptCost", s => s.addAttemptCost(KEY, 0.01, 1)],
  ["finish", s => s.finish(KEY, { state: 'extracted', reason: null, nextAttemptAt: null, unpriced: false, eventSlugs: [], eventHashes: [], attempt: 1, judgeInputHash: null, judgeWindowChars: null, judgeWindowHash: null, keepJudged: false, failures: 0 })],
  ["latestJudged", s => s.latestJudged('default', 1, 2, 'h', ['retired'], 'life-chronicle')],
  ["inputFailures", s => s.inputFailures('default', 1, 2, 'i')],
  ["liveEventSlugs", s => s.liveEventSlugs('default', 'meetings/a')],
  ["eventProducers", s => s.eventProducers('default', 1, ['life/events/a'])],
  ["addAttempt", s => s.addAttempt(KEY)],
  ["liveEventHashes", s => s.liveEventHashes('default', ['life/events/a'])],
  ["livePageId", s => s.livePageId('default', 'life/events/a')],
  ["deleteEventTimeline", s => s.deleteEventTimeline('default', 'life/events/a')],
  ["eventTimelineEntry", s => s.eventTimelineEntry(3, '2026-11-21')],
  ["eventDiscriminators", s => s.eventDiscriminators('default', ['life/events/a'])],
];

describe('chronicle executor SQL pins', () => {
  for (const [name, run] of CASES) {
    test(`${name} sends the caller's statement byte for byte`, async () => {
      const sent: string[] = [];
      const exec = { executeRaw: async (text: string) => { sent.push(text); return name === 'addAttempt' ? [{ attempts: 1 }] : []; } };
      await run(await chronicleStore(exec as never));
      expect(sent).toEqual([PINNED[name]]);
    });
  }

  test('every statement is pinned', () => {
    expect(CASES.map(([name]) => name as string).sort()).toEqual(Object.keys(PINNED).sort());
  });
});
