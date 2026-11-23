/**
 * Byte-identical pins for the dream-cycle statements that became typed engine members
 * (src/core/engine-sql/dream-cycle.ts): the retriage queue and lock reads, the dream breaker and write-deferral
 * config map, the provenance stamp, the consolidate phase, and the synthesize family.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member sends Postgres exactly the statement text and the bound params its caller ran through
 *    `executeRaw` before the move. Each expected text below is copied verbatim from the caller at 5e22f0c134 (the
 *    `from` of each pin names the file, line and function there).
 *  - Regression: an edited clause, a renumbered placeholder or a re-ordered param changes what Postgres answers while
 *    the parity cases may still pass on a small fixture; the config map writes and the stamp are read-modify-write
 *    statements whose text decides what a concurrent cycle sees.
 *  - Why existing coverage misses it: the sql-text goldens cover the W1 domains only (test/engine-sql-sql-text.test.ts),
 *    and these statements ran through `executeRaw`, which no parity case can call (D18).
 *  - Seam: the fake postgres.js driver (test/helpers/fake-postgres-sql.ts) records the text and params; no database runs.
 */
import { describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';
import { readersSourcedFactSql } from '../src/core/access/member-facts.ts';
import { privatePagesFilterFragment } from '../src/core/search/private-visibility.ts';

function recordingEngine() {
  const fake = makeFakeSql();
  const engine = new PostgresEngine() as any;
  engine._sql = fake.sql;
  engine._connectionStyle = 'instance';
  return { engine, statements: () => fake.statements().map(s => ({ text: s.text, params: s.params })) };
}

interface Pin {
  /** The caller site the statement came from, at 5e22f0c134. */
  from: string;
  run: (engine: any) => Promise<unknown>;
  /** The statements, in order, as the caller sent them. */
  sent: Array<{ text: string; params?: unknown[] }>;
}

const SINCE = new Date('2026-01-02T03:04:05.000Z');
const CONFIG_MAP_ENSURE = "INSERT INTO config (key, value) VALUES ($1, '{}') ON CONFLICT (key) DO NOTHING";
const CONFIG_MAP_LOCK = `SELECT value, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now FROM config WHERE key=$1 FOR UPDATE`;
const CONFIG_MAP_WRITE = 'UPDATE config SET value=$2 WHERE key=$1';

const PINS: Pin[] = [
  {
    from: 'src/commands/dream-retriage.ts:479 runDreamRetriage',
    run: e => e.listDreamQueueCandidates(),
    sent: [{ text: `SELECT id, queue, status, idempotency_key,
              COALESCE(NULLIF(data->>'source_id', ''), 'default') AS source_id
         FROM minion_jobs
        WHERE name = 'subagent'
          AND status IN ('waiting', 'delayed', 'paused')
          AND (idempotency_key LIKE 'dream:synth-v2:%' OR queue LIKE 'dream-inline-%')` }],
  },
  {
    from: 'src/commands/dream-retriage.ts:546 runDreamRetriage',
    run: e => e.listLiveDreamCycleLocks(300),
    sent: [{ text: `SELECT id, EXTRACT(EPOCH FROM acquired_at) * 1000 AS acquired_epoch_ms
         FROM gbrain_cycle_locks
        WHERE (ttl_expires_at > NOW()
               OR last_refreshed_at > NOW() - make_interval(secs => 300))
          AND id LIKE 'gbrain-cycle%'` }],
  },
  {
    from: 'src/commands/dream-retriage.ts:597 cancelRow',
    run: e => e.readDreamJobStatus(42),
    sent: [{ text: `SELECT status FROM minion_jobs WHERE id = $1`, params: [42] }],
  },
  {
    from: 'src/core/cycle/dream-breaker.ts:134 recordContainedPaidFailure and src/core/cycle/dream-write-deferral.ts:91 withDeferrals',
    run: e => e.ensureDreamMapConfigRow('dream.map'),
    sent: [{ text: CONFIG_MAP_ENSURE, params: ['dream.map'] }],
  },
  {
    from: 'src/core/cycle/dream-breaker.ts:135 recordContainedPaidFailure and src/core/cycle/dream-write-deferral.ts:92 withDeferrals',
    run: e => e.lockDreamMapConfigRow('dream.map'),
    sent: [{ text: CONFIG_MAP_LOCK, params: ['dream.map'] }],
  },
  {
    from: 'src/core/cycle/dream-breaker.ts:147 recordContainedPaidFailure and src/core/cycle/dream-write-deferral.ts:97 withDeferrals',
    run: e => e.writeDreamMapConfigRow('dream.map', '{"a":1}'),
    sent: [{ text: CONFIG_MAP_WRITE, params: ['dream.map', '{"a":1}'] }],
  },
  {
    from: 'src/core/cycle/dream-breaker.ts:229 resetDreamBreakerKey',
    run: e => e.recordDreamBreakerReset('dream.resets', 'dream:phase:synthesize:default'),
    sent: [{ text: `INSERT INTO config (key, value)
       VALUES ($1, jsonb_build_object($2::text, to_char((now() + interval '1 millisecond') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text)
     ON CONFLICT (key) DO UPDATE SET value = ((
       SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
         FROM jsonb_each_text(CASE WHEN jsonb_typeof(gbrain_try_jsonb(config.value)) = 'object' THEN gbrain_try_jsonb(config.value) ELSE '{}'::jsonb END) entry
        WHERE entry.key <> $2::text AND entry.value ~ '^[0-9]{4}-' AND entry.value::timestamptz > now() - interval '24 hours'
     ) || EXCLUDED.value::jsonb)::text`, params: ['dream.resets', 'dream:phase:synthesize:default'] }],
  },
  {
    from: 'src/core/cycle/dream-provenance.ts:37 stamp',
    run: e => e.stampDreamPageProvenance({
      slug: 'notes/a', sourceId: 'default', cycleDate: '2026-01-02', firstWriteAt: SINCE, clearSeat: true,
      frontmatter: { dream_generated: true, raw_source: 't.txt' },
    }),
    sent: [{ text: `UPDATE pages
            SET frontmatter = (COALESCE(frontmatter, '{}'::jsonb) - CASE WHEN $5::boolean THEN 'seat' ELSE '' END)
                              || $6::jsonb
                              || jsonb_build_object(
                                   'dream_cycle_date',
                                   COALESCE(NULLIF(frontmatter->>'dream_created_cycle_date', ''), NULLIF(frontmatter->>'dream_cycle_date', ''), $3),
                                   'dream_created_cycle_date',
                                   COALESCE(NULLIF(frontmatter->>'dream_created_cycle_date', ''), NULLIF(frontmatter->>'dream_cycle_date', ''), $3)
                                 )
          WHERE slug = $1 AND source_id = $2
            AND ($4::timestamptz IS NULL
                 OR frontmatter->>'dream_generated' = 'true'
                 OR created_at >= $4::timestamptz)`,
    params: ['notes/a', 'default', '2026-01-02', '2026-01-02T03:04:05.000Z', true, { dream_generated: true, raw_source: 't.txt' }] }],
  },
  {
    from: 'src/core/cycle/dream-provenance.ts:37 stamp (no first write, seat kept)',
    run: e => e.stampDreamPageProvenance({ slug: 'notes/a', sourceId: 'default', cycleDate: '2026-01-02', firstWriteAt: null, clearSeat: false, frontmatter: { dream_generated: true } }),
    sent: [{ text: `UPDATE pages
            SET frontmatter = (COALESCE(frontmatter, '{}'::jsonb) - CASE WHEN $5::boolean THEN 'seat' ELSE '' END)
                              || $6::jsonb
                              || jsonb_build_object(
                                   'dream_cycle_date',
                                   COALESCE(NULLIF(frontmatter->>'dream_created_cycle_date', ''), NULLIF(frontmatter->>'dream_cycle_date', ''), $3),
                                   'dream_created_cycle_date',
                                   COALESCE(NULLIF(frontmatter->>'dream_created_cycle_date', ''), NULLIF(frontmatter->>'dream_cycle_date', ''), $3)
                                 )
          WHERE slug = $1 AND source_id = $2
            AND ($4::timestamptz IS NULL
                 OR frontmatter->>'dream_generated' = 'true'
                 OR created_at >= $4::timestamptz)`,
    params: ['notes/a', 'default', '2026-01-02', null, false, { dream_generated: true }] }],
  },
  {
    from: 'src/core/cycle/dream-provenance.ts:69 stampDreamProvenance',
    run: e => e.listDreamPageIds('notes/a', 'default'),
    sent: [{ text: 'SELECT id FROM pages WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL', params: ['notes/a', 'default'] }],
  },
  {
    from: 'src/core/cycle/dream-provenance.ts:90 summaryProvenanceLines',
    run: e => e.countDreamProvenancePages('default', '2026-01-02', 'summary/x', ['notes/a', 'notes/b']),
    sent: [{ text: `SELECT count(*) FILTER (WHERE frontmatter->>'dream_cycle_date' = $2 AND slug <> $3)::int AS found,
            count(*) FILTER (WHERE slug = ANY($4::text[]) AND COALESCE(frontmatter->>'dream_cycle_date', '') NOT IN ('', $2))::int AS earlier
       FROM pages
      WHERE source_id = $1 AND deleted_at IS NULL AND frontmatter->>'dream_generated' = 'true'`,
    params: ['default', '2026-01-02', 'summary/x', ['notes/a', 'notes/b']] }],
  },
  {
    from: 'src/core/cycle/dream-write-deferral.ts:118 reconcileDreamWriteDeferrals',
    run: e => e.readDreamDeferralReceipt('00000000-0000-4000-8000-000000000001'),
    sent: [{ text: 'SELECT state, error_code, error_message FROM persistence_requests WHERE id=$1::uuid', params: ['00000000-0000-4000-8000-000000000001'] }],
  },
  {
    from: 'src/core/cycle/phases/consolidate.ts:139 writeValidUntilChain',
    run: e => e.listConsolidationClaimValues([1, 2]),
    sent: [{ text: 'SELECT id, claim_value FROM facts WHERE id = ANY($1::bigint[])', params: [[1, 2]] }],
  },
  {
    from: 'src/core/cycle/phases/consolidate.ts:142 writeValidUntilChain',
    run: e => e.setConsolidatedFactValidUntil(SINCE, 7),
    sent: [{ text: `UPDATE facts
         SET valid_until = $1
       WHERE id = $2
         AND (valid_until IS DISTINCT FROM $1)`, params: [SINCE, 7] }],
  },
  {
    from: 'src/core/cycle/phases/consolidate.ts:170 withoutReadersSourced',
    run: e => e.listReadersSourcedFactIds([1, 2]),
    sent: [{ text: `SELECT id FROM facts WHERE id = ANY($1::bigint[]) AND ${readersSourcedFactSql('facts')}`, params: [[1, 2]] }],
  },
  {
    from: 'src/core/cycle/phases/consolidate.ts:277 runPhaseConsolidate',
    run: e => e.findConsolidationPageIds('default', 'people/a'),
    sent: [{ text: `SELECT id FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL LIMIT 1`, params: ['default', 'people/a'] }],
  },
  {
    from: 'src/core/cycle/phases/consolidate.ts:285 runPhaseConsolidate',
    run: e => e.readConsolidationTakesMaxRowNum(5),
    sent: [{ text: `SELECT COALESCE(MAX(row_num), 0)::int AS max FROM takes WHERE page_id = $1`, params: [5] }],
  },
  {
    from: 'src/core/cycle/phases/consolidate.ts:362 runPhaseConsolidate',
    run: e => e.findConsolidatedTakes(5, 'Prefers email'),
    sent: [{ text: `SELECT id, resolved_at FROM takes
           WHERE page_id = $1 AND claim = $2 AND kind = 'fact' AND holder = 'self'
           ORDER BY id
           LIMIT 1`, params: [5, 'Prefers email'] }],
  },
  {
    from: 'src/core/cycle/phases/consolidate.ts:395 runPhaseConsolidate',
    run: e => e.refreshConsolidatedTakeSource('a, b', 9),
    sent: [{ text: `UPDATE takes SET source = $1, updated_at = now() WHERE id = $2`, params: ['a, b', 9] }],
  },
  {
    from: 'src/core/cycle/phases/consolidate.ts:400 runPhaseConsolidate',
    run: e => e.findConsolidatedTakeIds(5, 3),
    sent: [{ text: `SELECT id FROM takes WHERE page_id = $1 AND row_num = $2`, params: [5, 3] }],
  },
  {
    from: 'src/core/cycle/phases/consolidate.ts:528 loadClaimShapes',
    run: e => e.listConsolidationClaimShapes([1, 2]),
    sent: [{ text: `SELECT id, claim_metric, claim_unit, claim_period FROM facts WHERE id = ANY($1::bigint[])`, params: [[1, 2]] }],
  },
  {
    from: 'src/core/cycle/synthesize-completion.ts:78 loadRetainedOutputSources',
    run: e => e.listRetainedDreamOutputSources('default'),
    sent: [{ text: `SELECT DISTINCT frontmatter->>'raw_source' AS raw_source
       FROM pages
      WHERE source_id = $1
        AND deleted_at IS NULL
        AND frontmatter->>'dream_generated' = 'true'
        AND COALESCE(frontmatter->>'raw_source', '') <> ''`, params: ['default'] }],
  },
  {
    from: 'src/core/cycle/synthesize-completion.ts:98 readManagedSourceIncarnation',
    run: e => e.readDreamSourceIncarnation('default'),
    sent: [{ text: 'SELECT incarnation FROM sources WHERE id = $1', params: ['default'] }],
  },
  {
    from: 'src/core/cycle/synthesize-concepts.ts:178 runPhaseSynthesizeConcepts',
    run: e => e.listDreamAtomPages('default'),
    sent: [{ text: `SELECT slug, title, compiled_truth, knowledge_revision::text AS revision, frontmatter, NOT (${privatePagesFilterFragment('pages')}) AS private
           FROM pages
          WHERE type = 'atom'
            AND source_id = $1
            AND deleted_at IS NULL
            AND (frontmatter->>'imported_from') IS NULL`, params: ['default'] }],
  },
  {
    // Main join (da99c637a7): the cli-members line's caller (synthesize-generations.ts:68 at de72811022) sorted with
    // `ORDER BY slug COLLATE "C"`; the join re-applied that byte order to main's member, so the pin carries it too.
    from: 'src/core/cycle/synthesize-generations.ts:66 pages',
    run: e => e.listSynthesisPageBodies('default', ['notes/a', 'notes/b']),
    sent: [{ text: `SELECT slug, title, COALESCE(compiled_truth, '') || E'\\n' || COALESCE(timeline, '') AS body FROM pages
      WHERE source_id=$1 AND slug=ANY($2::text[]) AND deleted_at IS NULL AND body_storage <> 'segmented' ORDER BY slug COLLATE "C"`,
    params: ['default', ['notes/a', 'notes/b']] }],
  },
  {
    from: 'src/core/cycle/synthesize-postprocess.ts:51 laterRequests',
    run: e => e.listLaterPersistenceRequests('default', 'inc-1', 'notes/a', 12),
    sent: [{ text: `SELECT * FROM persistence_requests
      WHERE source_id=$1 AND source_incarnation=$2 AND slug=$3 AND sequence > $4
        AND state IN ('queued','running','recovering','committed')
      ORDER BY sequence`, params: ['default', 'inc-1', 'notes/a', 12] }],
  },
  {
    from: 'src/core/cycle/synthesize-postprocess.ts:110 committedRequestsFor (COMMITTED_OUTPUT_REQUESTS_SQL)',
    run: e => e.listCommittedOutputRequests(['00000000-0000-4000-8000-000000000001'], 'default', 'inc-1'),
    sent: [{ text: `SELECT row_to_json(p) AS request FROM persistence_requests p
      WHERE p.source_id=$2 AND p.request_id=ANY($1::uuid[]) AND p.source_incarnation=$3
        AND p.operation='put_page' AND p.state='committed'
      ORDER BY p.sequence DESC`, params: [['00000000-0000-4000-8000-000000000001'], 'default', 'inc-1'] }],
  },
  {
    from: 'src/core/cycle/synthesize-verify-epochs.ts:14 readVerifyEpoch',
    run: e => e.readDreamVerifyEpoch(),
    sent: [{ text: 'SELECT now() AS now' }],
  },
  {
    from: 'src/core/cycle/synthesize-verify-epochs.ts:33 loadChildWriteEpochs',
    run: e => e.listDreamJobCreatedAt([3, 4]),
    sent: [{ text: 'SELECT id, created_at FROM minion_jobs WHERE id = ANY($1::int[])', params: [[3, 4]] }],
  },
  {
    from: 'src/core/cycle/synthesize-verify-epochs.ts:50 loadPreRunRevision',
    run: e => e.readDreamPreRunRevision('notes/a', 'default', SINCE.toISOString()),
    sent: [{ text: `SELECT pv.compiled_truth, pv.timeline, pv.frontmatter
       FROM page_versions pv JOIN pages p ON p.id = pv.page_id
      WHERE p.slug = $1 AND p.source_id = $2 AND pv.snapshot_at >= $3::timestamptz
      ORDER BY pv.snapshot_at ASC, pv.id ASC LIMIT 1`, params: ['notes/a', 'default', '2026-01-02T03:04:05.000Z'] }],
  },
  {
    from: 'src/core/cycle/synthesize.ts:779 runPhaseSynthesizeInner',
    run: e => e.listCompletedSynthJobs('dream:synth-v2:x:filename:t.txt:abc'),
    sent: [{ text: "SELECT id,idempotency_key FROM minion_jobs WHERE status='completed' AND (idempotency_key=$1 OR left(idempotency_key,length($1)+2)=$1||':c') ORDER BY id",
      params: ['dream:synth-v2:x:filename:t.txt:abc'] }],
  },
  {
    from: 'src/core/cycle/synthesize.ts:836 runPhaseSynthesizeInner',
    run: e => e.countCoalescibleSynthJobs(['k1', 'k2']),
    sent: [{ text: `SELECT COUNT(*)::int AS n FROM minion_jobs
              WHERE idempotency_key = ANY($1::text[])
                AND status NOT IN ('cancelled', 'dead')`, params: [['k1', 'k2']] }],
  },
  {
    from: 'src/core/cycle/synthesize.ts:1084 runPhaseSynthesizeInner',
    run: e => e.listWaitingChildJobIds('dream-inline-1'),
    sent: [{ text: `SELECT id FROM minion_jobs WHERE queue = $1 AND status IN ('waiting', 'delayed')`, params: ['dream-inline-1'] }],
  },
  {
    from: 'src/core/cycle/synthesize.ts:1264 runPhaseSynthesizeInner',
    run: e => e.listDreamChildJobTimings([3, 4]),
    sent: [{ text: `SELECT created_at, started_at, finished_at, tokens_input, tokens_output, tokens_cache_read FROM minion_jobs WHERE id = ANY($1::bigint[])`, params: [[3, 4]] }],
  },
  {
    from: 'src/core/cycle/synthesize.ts:1804 countRecentSynthSubmissions',
    run: e => e.countRecentDreamSynthSubmissions('default'),
    sent: [{ text: `SELECT COUNT(*)::int AS n
       FROM minion_jobs
      WHERE name = 'subagent'
        AND (idempotency_key LIKE 'dream:synth-v2:%' OR idempotency_key IS NULL AND data->>'__released_idempotency_key' LIKE 'dream:synth-v2:%')
        AND COALESCE(NULLIF(data->>'source_id', ''), 'default') = $1
        AND status <> 'cancelled'
        AND created_at > NOW() - INTERVAL '24 hours'`, params: ['default'] }],
  },
];

describe('dream-cycle statements moved into typed members keep their Postgres text and params byte for byte', () => {
  for (const pin of PINS) {
    test(pin.from, async () => {
      const { engine, statements } = recordingEngine();
      await pin.run(engine);
      expect(statements()).toEqual(pin.sent.map(s => ({ text: s.text, params: s.params ?? [] })));
    });
  }
});
