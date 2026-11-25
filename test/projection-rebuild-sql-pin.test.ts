/**
 * The projection rebuild members (src/core/engine-sql/projection-rebuild.ts) send Postgres the statement text and binds
 * rebuildPendingPageProjections, planProjectionKeep, installPageProjection and the rebuild statistics' drained probe
 * (src/core/page-state/projections.ts) sent through `executeRaw` before they had members. A drift here changes a query
 * plan or a result on Postgres alone, which PGLite parity cannot see.
 *
 * Protects: the queue listing the rebuild sends for five option sets, and each member's text and binds, equal the old
 * raw statements (the texts below were recorded from the raw callers before the move). That includes the deferred
 * chunk replacement's reads and writes (continueDeferredProjectionStep) and the rebuild loop's queue stamps (re-key,
 * deferred stamp in both modes, unclaimed touch, defer), resealSafeChunks's pending count, the resident's window probe and the
 * drain's queue insert, backlog, preview, clock, work probe and row estimate; the image seal's drained probe reuses
 * hasDrainableProjectionJob({ media }) and the failed mark reuses markProjectionRebuildFailed, each of whose
 * texts differ from the old ones only in whitespace. The queue listing, the keep
 * plan and the vector clear are composed with sqlFragment, which numbers placeholders in text order: they are compared
 * with each placeholder replaced by the value it binds, so only the numbering may differ. The other statements match
 * byte for byte. Fails when a member reorders a clause, binds a value differently or in a different place, or moves
 * the listing off the pool. No database: the engine runs on the recording fake.
 */
import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { rebuildPendingPageProjections } from '../src/core/page-state/projections.ts';
import { makeFakeSql, type Responder } from './helpers/fake-postgres-sql.ts';
import { DELETE_PROJECTION_JOB_SQL, MARK_PROJECTION_REBUILD_FAILED_SQL } from '../src/core/engine-sql/persistence-housekeeping.ts';
import { DEFERRED_CHUNK_CLAIM } from '../src/core/engine-sql/projection-rebuild.ts';

function recordingEngine(responder?: Responder) {
  const fake = makeFakeSql(responder);
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  const last = () => {
    const s = fake.statements().at(-1)!;
    return { text: s.text, params: s.params };
  };
  return { engine, fake, last };
}

/** The statement with each `$n` replaced by the value it binds: equal for two texts that differ only in numbering. */
function bound(statement: { text: string; params: unknown[] }): string {
  return statement.text.replace(/\$(\d+)/g, (_, n: string) => `<${JSON.stringify(statement.params[Number(n) - 1])}>`);
}

/** The queue listing the rebuild sent, recorded before the move (one pool statement per option set). */
const OLD_LISTS = {
  pages: { text: "SELECT s.id AS source_id,j.source_incarnation,j.slug,j.revision,p.page_kind,j.updated_at::text AS updated_at\n    FROM (SELECT source_incarnation,slug,revision,updated_at FROM page_projection_jobs j\n      WHERE j.slug=ANY($2::text[])\n      ORDER BY updated_at,source_incarnation,slug COLLATE \"C\" OFFSET 0) j\n    CROSS JOIN LATERAL (SELECT s.id FROM sources s\n      WHERE s.incarnation=j.source_incarnation AND NOT s.archived OFFSET 0) s\n    CROSS JOIN LATERAL (SELECT p.page_kind FROM pages p WHERE p.id=(SELECT k.id FROM pages k WHERE k.source_id=s.id AND k.slug=j.slug)\n      AND p.deleted_at IS NULL AND p.page_kind IN ('markdown','code') AND p.body_storage IS DISTINCT FROM 'segmented' OFFSET 0) p WHERE s.id=$3\n    ORDER BY j.updated_at,j.source_incarnation,j.slug COLLATE \"C\" LIMIT $1",
    params: [20, ["a", "b"], "src-a"] },
  full: { text: "SELECT s.id AS source_id,j.source_incarnation,j.slug,j.revision,p.page_kind,j.updated_at::text AS updated_at\n    FROM (SELECT source_incarnation,slug,revision,updated_at FROM page_projection_jobs j\n      WHERE (j.reason IS DISTINCT FROM 'rebuild_failed' OR j.updated_at<now()-interval '30 seconds') AND NOT (split_part(j.reason,':',1)='segmented_projecting' AND j.updated_at>=now()-interval '60 seconds') AND NOT (split_part(j.reason,':',1)='chunk_replacement_continuing' AND j.updated_at>=now()-interval '60 seconds') AND j.updated_at<=$2::text::timestamptz AND j.reason=ANY($3::text[]) AND (j.updated_at,j.source_incarnation,j.slug COLLATE \"C\")>($4::text::timestamptz,$5::uuid,$6 COLLATE \"C\")\n      ORDER BY updated_at,source_incarnation,slug COLLATE \"C\" OFFSET 0) j\n    CROSS JOIN LATERAL (SELECT s.id FROM sources s\n      WHERE s.incarnation=j.source_incarnation AND NOT s.archived OFFSET 0) s\n    CROSS JOIN LATERAL (SELECT p.page_kind FROM pages p WHERE p.id=(SELECT k.id FROM pages k WHERE k.source_id=s.id AND k.slug=j.slug)\n      AND p.deleted_at IS NULL AND p.page_kind IN ('markdown','code') AND p.body_storage IS DISTINCT FROM 'segmented' OFFSET 0) p \n    ORDER BY j.updated_at,j.source_incarnation,j.slug COLLATE \"C\" LIMIT $1",
    params: [20, "2026-11-18 02:37:05.215+00", ["canonical_change"], "2026-11-18 02:37:05+00", "00000000-0000-0000-0000-0000000000aa", "x"] },
  waiting: { text: "SELECT s.id AS source_id,j.source_incarnation,j.slug,j.revision,p.page_kind,j.updated_at::text AS updated_at\n    FROM (SELECT source_incarnation,slug,revision,updated_at FROM page_projection_jobs j\n      \n      ORDER BY updated_at,source_incarnation,slug COLLATE \"C\" OFFSET 0) j\n    CROSS JOIN LATERAL (SELECT s.id FROM sources s\n      WHERE s.incarnation=j.source_incarnation AND NOT s.archived OFFSET 0) s\n    CROSS JOIN LATERAL (SELECT p.page_kind FROM pages p WHERE p.id=(SELECT k.id FROM pages k WHERE k.source_id=s.id AND k.slug=j.slug)\n      AND p.deleted_at IS NULL AND p.page_kind IN ('markdown','code') AND p.body_storage IS DISTINCT FROM 'segmented' OFFSET 0) p WHERE NOT EXISTS (SELECT 1 FROM pages q WHERE q.source_id=s.id AND q.slug=j.slug\n      AND q.text_projection_revision='00000000-0000-0000-0000-000000000153'::uuid)\n    ORDER BY j.updated_at,j.source_incarnation,j.slug COLLATE \"C\" LIMIT $1",
    params: [100] },
  served: { text: "SELECT s.id AS source_id,j.source_incarnation,j.slug,j.revision,p.page_kind,j.updated_at::text AS updated_at\n    FROM (SELECT source_incarnation,slug,revision,updated_at FROM page_projection_jobs j\n      WHERE j.reason=ANY($2::text[]) AND j.slug=ANY($3::text[])\n      ORDER BY updated_at,source_incarnation,slug COLLATE \"C\" OFFSET 0) j\n    CROSS JOIN LATERAL (SELECT s.id FROM sources s\n      WHERE s.incarnation=j.source_incarnation AND NOT s.archived OFFSET 0) s\n    CROSS JOIN LATERAL (SELECT p.page_kind FROM pages p WHERE p.id=(SELECT k.id FROM pages k WHERE k.source_id=s.id AND k.slug=j.slug)\n      AND p.deleted_at IS NULL AND p.page_kind IN ('markdown','code') AND p.body_storage IS DISTINCT FROM 'segmented' OFFSET 0) p WHERE s.id=$4 AND EXISTS (SELECT 1 FROM pages q WHERE q.source_id=s.id AND q.slug=j.slug\n      AND q.text_projection_revision='00000000-0000-0000-0000-000000000153'::uuid)\n    ORDER BY j.updated_at,j.source_incarnation,j.slug COLLATE \"C\" LIMIT $1",
    params: [20, ["protocol_activation"], ["q"], "s"] },
  none: { text: "SELECT s.id AS source_id,j.source_incarnation,j.slug,j.revision,p.page_kind,j.updated_at::text AS updated_at\n    FROM (SELECT source_incarnation,slug,revision,updated_at FROM page_projection_jobs j\n      \n      ORDER BY updated_at,source_incarnation,slug COLLATE \"C\" OFFSET 0) j\n    CROSS JOIN LATERAL (SELECT s.id FROM sources s\n      WHERE s.incarnation=j.source_incarnation AND NOT s.archived OFFSET 0) s\n    CROSS JOIN LATERAL (SELECT p.page_kind FROM pages p WHERE p.id=(SELECT k.id FROM pages k WHERE k.source_id=s.id AND k.slug=j.slug)\n      AND p.deleted_at IS NULL AND p.page_kind IN ('markdown','code') AND p.body_storage IS DISTINCT FROM 'segmented' OFFSET 0) p \n    ORDER BY j.updated_at,j.source_incarnation,j.slug COLLATE \"C\" LIMIT $1",
    params: [20] },
};

/** The other raw statements, recorded before the move. */
const OLD = {
  keep: "SELECT id,embedding_input_hash,(\"embedding\" IS NOT NULL AND embedded_text_hash IS NOT DISTINCT FROM md5(chunk_text)) AND EXISTS (SELECT 1 FROM (SELECT $2::text AS m) target WHERE model IS NOT DISTINCT FROM target.m OR (model = substr(target.m, strpos(target.m, ':') + 1) AND vector_dims(\"embedding\") = 1536)) AS movable FROM content_chunks WHERE page_id=$1",
  clear: "UPDATE content_chunks SET \"embedding\"=NULL,\n        embedded_at=NULL,embedded_text_hash=NULL,embedding_input_hash=NULL,\n        embedding_pending_since=COALESCE(embedding_pending_since,now()) WHERE page_id=$1 AND\n        (NOT EXISTS (SELECT 1 FROM (SELECT $2::text AS m) target WHERE model IS NOT DISTINCT FROM target.m OR (model = substr(target.m, strpos(target.m, ':') + 1) AND vector_dims(\"embedding\") = 1536)) OR embedded_text_hash <> md5(chunk_text) OR NOT(id=ANY($3::int[])))",
  chunker: "UPDATE pages SET chunker_version=$3\n        WHERE source_id=$1 AND slug=$2",
  reason: "SELECT reason FROM page_projection_jobs\n          WHERE source_incarnation=$1::uuid AND slug=$2 AND revision=$3::uuid",
  del: "DELETE FROM page_projection_jobs WHERE source_incarnation=$1::uuid AND slug=$2 AND revision=$3::uuid",
  drained: "SELECT 1 FROM page_projection_jobs j\n      CROSS JOIN LATERAL (SELECT s.id FROM sources s\n      WHERE s.incarnation=j.source_incarnation AND NOT s.archived OFFSET 0) s\n    CROSS JOIN LATERAL (SELECT p.page_kind FROM pages p WHERE p.id=(SELECT k.id FROM pages k WHERE k.source_id=s.id AND k.slug=j.slug)\n      AND p.deleted_at IS NULL AND p.page_kind IN ('markdown','code') AND p.body_storage IS DISTINCT FROM 'segmented' OFFSET 0) p\n      WHERE j.reason<>'rebuild_failed' LIMIT 1",
  drainedMedia: "SELECT 1 FROM page_projection_jobs j\n      CROSS JOIN LATERAL (SELECT s.id FROM sources s\n      WHERE s.incarnation=j.source_incarnation AND NOT s.archived OFFSET 0) s\n    CROSS JOIN LATERAL (SELECT p.page_kind FROM pages p WHERE p.id=(SELECT k.id FROM pages k WHERE k.source_id=s.id AND k.slug=j.slug)\n      AND p.deleted_at IS NULL AND ((p.page_kind IN ('markdown','code') AND p.body_storage IS DISTINCT FROM 'segmented') OR (p.page_kind = 'image' AND p.body_storage IS DISTINCT FROM 'segmented' AND NOT (CASE WHEN p.body_storage = 'segmented' THEN p.body_flags->>'has_protected' IS DISTINCT FROM 'false'\n    ELSE (COALESCE(p.compiled_truth, '') ~ '<!--- gbrain:(facts|takes):(begin|end) -->' OR COALESCE(p.timeline, '') ~ '<!--- gbrain:(facts|takes):(begin|end) -->') END)\n    AND p.chunker_version >= 4 AND (SELECT count(*) = 1 AND bool_and(c.chunk_index = 0 AND c.chunk_source = 'image_asset' AND c.modality = 'image'\n      AND char_length(c.chunk_text) < 65536 AND c.chunk_text = COALESCE(NULLIF(left(coalesce(p.compiled_truth, p.truth_lead), 65536), ''), p.title))\n    FROM content_chunks c WHERE c.page_id = p.id AND ((c.body_generation IS NULL AND p.body_storage <> 'segmented')\n       OR (c.body_generation <= p.body_generation\n           AND EXISTS (SELECT 1 FROM page_body_manifest lm WHERE lm.page_id = c.page_id AND lm.occurrence_id = c.occurrence_id\n             AND lm.staging_id IS NULL AND lm.gen_from <= p.body_generation AND (lm.gen_to IS NULL OR lm.gen_to > p.body_generation))))) IS TRUE)) OFFSET 0) p\n      WHERE j.reason<>'rebuild_failed' LIMIT 1",
};

/** The deferred chunk replacement's statements and the rebuild loop's queue stamps, recorded before the move. */
const OLD_STEP = {
  fingerprint: "SELECT count(*)::text||':'||COALESCE(sum(hashtext(id::text||':'||chunk_index::text)::bigint),0)::text AS f\n    FROM content_chunks WHERE page_id=$1",
  deleteUnkept: "DELETE FROM content_chunks WHERE page_id=$1 AND NOT(id=ANY($2::int[]))",
  stale: "SELECT id FROM content_chunks WHERE page_id=$1 AND \"embedding\" IS NOT NULL\n    AND (NOT EXISTS (SELECT 1 FROM (SELECT $2::text AS m) target WHERE model IS NOT DISTINCT FROM target.m OR (model = substr(target.m, strpos(target.m, ':') + 1) AND vector_dims(\"embedding\") = 1536)) OR embedded_text_hash <> md5(chunk_text) OR NOT(id=ANY($3::int[]))) ORDER BY chunk_index",
  head: "SELECT id, knowledge_revision::text AS revision,\n      text_projection_revision IS NOT DISTINCT FROM knowledge_revision AS sealed FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL",
  held: "SELECT 1 FROM page_projection_jobs j JOIN sources s ON s.incarnation=j.source_incarnation\n      WHERE s.id=$1 AND j.slug=$2 AND j.revision=$3::uuid AND split_part(j.reason,':',1)=$4 AND j.reason<>$5\n        AND j.updated_at>=now()-interval '60 seconds'",
  renew: "UPDATE page_projection_jobs SET reason=$4,updated_at=now() WHERE source_incarnation=$1::uuid AND slug=$2 AND revision=$3::uuid",
  release: "UPDATE page_projection_jobs SET reason=$1 WHERE slug=$2 AND reason=$3",
  clearVectors: "UPDATE content_chunks SET \"embedding\"=NULL,embedded_at=NULL,embedded_text_hash=NULL,embedding_input_hash=NULL,\n        embedding_pending_since=COALESCE(embedding_pending_since,now()) WHERE page_id=$1 AND id=ANY($2::int[])",
  segmented: "SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2 AND body_storage='segmented' AND deleted_at IS NULL",
  rekey: "UPDATE page_projection_jobs SET revision=$4::uuid,updated_at=now()\n          WHERE source_incarnation=$1::uuid AND slug=$2 AND revision=$3::uuid",
  touchDeferred_skipped: "UPDATE page_projection_jobs SET updated_at=now(),reason='canonical_change'\n            WHERE source_incarnation=$1::uuid AND slug=$2 AND revision=$3::uuid",
  touchDeferred_more: "UPDATE page_projection_jobs SET updated_at=now()\n            WHERE source_incarnation=$1::uuid AND slug=$2 AND revision=$3::uuid",
  touchUnclaimed: "UPDATE page_projection_jobs j SET updated_at=now() WHERE j.source_incarnation=$1::uuid AND j.slug=$2 AND j.revision=$3::uuid\n            AND NOT (split_part(j.reason,':',1)='segmented_projecting' AND j.updated_at>=now()-interval '60 seconds')",
  failed: "UPDATE page_projection_jobs j SET reason='rebuild_failed',updated_at=now()\n          WHERE j.source_incarnation=$1::uuid AND j.slug=$2 AND j.revision=$3::uuid AND NOT (split_part(j.reason,':',1)='segmented_projecting' AND j.updated_at>=now()-interval '60 seconds')",
  defer: "UPDATE page_projection_jobs SET updated_at=now()\n        WHERE source_incarnation=$1::uuid AND slug=$2 AND revision=$3::uuid RETURNING slug",
  pending: "SELECT COUNT(*)::int AS chunks,\n    COALESCE(SUM(length(chunk_text)),0)::int AS chars FROM content_chunks\n    WHERE page_id=$1 AND \"embedding\" IS NULL AND modality='text'",
  window: "SELECT k.i,s.id AS source_id,s.archived,p.page_kind,p.body_storage\n      FROM jsonb_to_recordset($1::text::jsonb) AS k(i int, source_incarnation uuid, slug text)\n      LEFT JOIN LATERAL (SELECT s.id,s.archived FROM sources s WHERE s.incarnation=k.source_incarnation OFFSET 0) s ON true\n      LEFT JOIN LATERAL (SELECT p.page_kind,p.body_storage FROM (SELECT p.id FROM pages p WHERE p.source_id=s.id AND p.slug=k.slug OFFSET 0) q\n        JOIN pages p ON p.id=q.id WHERE p.deleted_at IS NULL) p ON true",
};

const KEY = { sourceIncarnation: '00000000-0000-0000-0000-0000000000aa', slug: 'notes/a', revision: '00000000-0000-0000-0000-0000000000bb' };
const KEY_PARAMS = [KEY.sourceIncarnation, KEY.slug, KEY.revision];
const COLUMN = { name: 'embedding', dimensions: 1536 };

const VARIANTS: Record<keyof typeof OLD_LISTS, [number, Parameters<typeof rebuildPendingPageProjections>[2]]> = {
  pages: [20, { pages: { sourceId: 'src-a', slugs: ['a', 'b'] } }],
  full: [20, { retryCooldown: true, notAfter: '2026-11-18 02:37:05.215+00', reasons: ['canonical_change'],
    walk: { after: { updated_at: '2026-11-18 02:37:05+00', source_incarnation: '00000000-0000-0000-0000-0000000000aa', slug: 'x' } } } as never],
  waiting: [500, { served: 'waiting' }],
  served: [20, { served: 'answering', pages: { sourceId: 's', slugs: ['q'] }, reasons: ['protocol_activation'] }],
  none: [20, {}],
};

for (const [name, [limit, opts]] of Object.entries(VARIANTS)) {
  test(`the rebuild's queue listing (${name}) sends the recorded statement on the pool`, async () => {
    const { engine, fake } = recordingEngine();
    await rebuildPendingPageProjections(engine, limit, opts);
    const sent = fake.statements().map(s => ({ text: s.text, params: s.params, lane: s.lane }));
    const old = OLD_LISTS[name as keyof typeof OLD_LISTS];
    expect(sent.map(s => ({ statement: bound(s), lane: s.lane }))).toEqual([{ statement: bound(old), lane: 'pool' }]);
    expect(sent[0]!.params.length).toBe(old.params.length);
  });
}

test('the queue listing member, called directly, sends the same statement as the rebuild', async () => {
  const { engine, fake } = recordingEngine();
  expect(await engine.listQueuedPageProjections({ limit: 20 })).toEqual([]);
  expect(fake.statements().map(s => ({ text: s.text, params: s.params }))).toEqual([{ text: OLD_LISTS.none.text, params: OLD_LISTS.none.params }]);
  await engine.listQueuedPageProjections({ limit: 7, reasons: ['canonical_change'] });
  expect(bound(fake.statements().at(-1)!)).toBe(bound({ text: OLD_LISTS.served.text.replace(' AND j.slug=ANY($3::text[])', '')
    .replace(/ WHERE s\.id=\$4 AND EXISTS \(SELECT 1 FROM pages q WHERE q\.source_id=s\.id AND q\.slug=j\.slug\n      AND q\.text_projection_revision='[0-9-]+'::uuid\)/, ' '),
    params: [7, ['canonical_change']] }));
});

// The job delete is persistence_journal's deleteProjectionJob (engine-sql/persistence-housekeeping.ts): the same statement.
test('the job delete statement is the recorded one', () => {
  expect(DELETE_PROJECTION_JOB_SQL).toBe(OLD.del);
});

test('the job reason read sends the recorded statement', async () => {
  const { engine, last } = recordingEngine();
  expect(await engine.readProjectionJobReason(KEY)).toBeNull();
  expect(last()).toEqual({ text: OLD.reason, params: KEY_PARAMS });
});

test('the keep plan, the vector clear and the chunker stamp send the recorded statements', async () => {
  const { engine, last } = recordingEngine();
  await engine.readChunkKeepState(9, 'openai:text-embedding-3-large', COLUMN);
  expect(bound(last())).toBe(bound({ text: OLD.keep, params: [9, 'openai:text-embedding-3-large'] }));
  await engine.clearUnkeptChunkVectors(9, null, COLUMN, [3, 4]);
  expect(last()).toEqual({ text: OLD.clear, params: [9, null, [3, 4]] });
  await engine.setProjectionChunkerVersion('src-a', 'notes/a', 4);
  expect(last()).toEqual({ text: OLD.chunker, params: ['src-a', 'notes/a', 4] });
});

test('the drained probe sends the recorded statement, with and without media', async () => {
  const { engine, last } = recordingEngine();
  expect(await engine.hasDrainableProjectionJob()).toBe(false);
  expect(last()).toEqual({ text: OLD.drained, params: [] });
  expect(await engine.hasDrainableProjectionJob({ media: true })).toBe(false);
  expect(last()).toEqual({ text: OLD.drainedMedia, params: [] });
});

test('the deferred replacement reads send the recorded statements', async () => {
  const { engine, last } = recordingEngine(stmt => stmt.text.includes(' AS f\n') ? [{ f: '0:0' }] : undefined);
  expect(await engine.readChunkRowsFingerprint(9)).toBe('0:0');
  expect(last()).toEqual({ text: OLD_STEP.fingerprint, params: [9] });
  expect(await engine.listStaleChunkVectors(9, 'm', COLUMN, [3, 4])).toEqual([]);
  expect(last()).toEqual({ text: OLD_STEP.stale, params: [9, 'm', [3, 4]] });
  expect(await engine.readProjectionHead('src-a', 'notes/a')).toBeNull();
  expect(last()).toEqual({ text: OLD_STEP.head, params: ['src-a', 'notes/a'] });
  expect(await engine.isDeferredReplacementHeld('src-a', 'notes/a', KEY.revision, `${DEFERRED_CHUNK_CLAIM}:t`)).toBe(false);
  expect(last()).toEqual({ text: OLD_STEP.held, params: ['src-a', 'notes/a', KEY.revision, DEFERRED_CHUNK_CLAIM, `${DEFERRED_CHUNK_CLAIM}:t`] });
  expect(await engine.hasSegmentedPage('src-a', 'notes/a')).toBe(false);
  expect(last()).toEqual({ text: OLD_STEP.segmented, params: ['src-a', 'notes/a'] });
});

test("the re-seal's pending count sends the recorded statement and reads its numbers", async () => {
  const { engine, last } = recordingEngine(stmt => stmt.text.includes(' AS chunks,') ? [{ chunks: 2, chars: 7 }] : undefined);
  expect(await engine.countPendingTextChunks(9, COLUMN)).toEqual({ chunks: 2, chars: 7 });
  expect(last()).toEqual({ text: OLD_STEP.pending, params: [9] });
  const empty = recordingEngine();
  expect(await empty.engine.countPendingTextChunks(9, COLUMN)).toEqual({ chunks: 0, chars: 0 });
});

test("the resident's window probe sends the recorded statement and binds", async () => {
  const { engine, last } = recordingEngine();
  const candidates = [{ source_incarnation: KEY.sourceIncarnation, slug: 'notes/a' }, { source_incarnation: KEY.sourceIncarnation, slug: 'notes/b' }];
  expect(await engine.probeProjectionWindowCandidates(candidates)).toEqual([]);
  expect(last()).toEqual({ text: OLD_STEP.window, params: [JSON.stringify([
    { i: 0, source_incarnation: KEY.sourceIncarnation, slug: 'notes/a' }, { i: 1, source_incarnation: KEY.sourceIncarnation, slug: 'notes/b' }])] });
});

test('the deferred replacement writes send the recorded statements', async () => {
  const { engine, last } = recordingEngine();
  await engine.deleteUnkeptChunks(9, [3, 4]);
  expect(last()).toEqual({ text: OLD_STEP.deleteUnkept, params: [9, [3, 4]] });
  await engine.clearChunkVectors(9, COLUMN, [3]);
  expect(last()).toEqual({ text: OLD_STEP.clearVectors, params: [9, [3]] });
  await engine.renewDeferredReplacementClaim(KEY, `${DEFERRED_CHUNK_CLAIM}:t`);
  expect(last()).toEqual({ text: OLD_STEP.renew, params: [...KEY_PARAMS, `${DEFERRED_CHUNK_CLAIM}:t`] });
  await engine.releaseDeferredReplacementClaim('notes/a', `${DEFERRED_CHUNK_CLAIM}:t`);
  expect(last()).toEqual({ text: OLD_STEP.release, params: ['chunk_replacement_deferred', 'notes/a', `${DEFERRED_CHUNK_CLAIM}:t`] });
});

test('the rebuild loop queue stamps send the recorded statements', async () => {
  const { engine, last } = recordingEngine();
  const next = '00000000-0000-0000-0000-0000000000cc';
  await engine.rekeyProjectionJob(KEY, next);
  expect(last()).toEqual({ text: OLD_STEP.rekey, params: [...KEY_PARAMS, next] });
  await engine.stampDeferredProjectionJob(KEY, true);
  expect(last()).toEqual({ text: OLD_STEP.touchDeferred_skipped, params: KEY_PARAMS });
  await engine.stampDeferredProjectionJob(KEY, false);
  expect(last()).toEqual({ text: OLD_STEP.touchDeferred_more, params: KEY_PARAMS });
  await engine.touchUnclaimedProjectionJob(KEY);
  expect(last()).toEqual({ text: OLD_STEP.touchUnclaimed, params: KEY_PARAMS });
  expect(await engine.deferProjectionJob(KEY)).toBe(false);
  expect(last()).toEqual({ text: OLD_STEP.defer, params: KEY_PARAMS });
});

test('the defer reports whether the job was still at its revision', async () => {
  const { engine } = recordingEngine(stmt => stmt.text.includes('RETURNING slug') ? [{ slug: KEY.slug }] : undefined);
  expect(await engine.deferProjectionJob(KEY)).toBe(true);
});

// The failed mark reuses persistence_journal's markProjectionRebuildFailed: its text differs from the old raw text
// only in the whitespace after a comma, which Postgres parses the same.
test('the failed mark differs from the recorded statement only in whitespace', async () => {
  const { engine, last } = recordingEngine();
  await engine.markProjectionRebuildFailed(KEY);
  expect(last()).toEqual({ text: MARK_PROJECTION_REBUILD_FAILED_SQL, params: KEY_PARAMS });
  expect(MARK_PROJECTION_REBUILD_FAILED_SQL).not.toBe(OLD_STEP.failed);
  const squash = (text: string) => text.replace(/\s+/g, ' ').replace(/, /g, ',');
  expect(squash(MARK_PROJECTION_REBUILD_FAILED_SQL)).toBe(squash(OLD_STEP.failed));
});

/** The drain's own statements (queuePageProjection, projectionBacklog, previewProjectionDrain, noteProjectionRebuilds, drainProjections), recorded before the move. */
const OLD_DRAIN = {
  queue: "INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason)\n    SELECT s.incarnation,p.slug,p.knowledge_revision,$3 FROM pages p JOIN sources s ON s.id=p.source_id\n    WHERE p.source_id=$1 AND p.slug=$2 AND p.deleted_at IS NULL\n    ON CONFLICT(source_incarnation,slug) DO UPDATE SET revision=EXCLUDED.revision,reason=EXCLUDED.reason,updated_at=now()",
  backlog: "SELECT COUNT(*) FILTER (WHERE k.cls='text')::int AS pending,\n      COUNT(*) FILTER (WHERE k.cls='text' AND j.reason='rebuild_failed')::int AS failed,\n      COUNT(*) FILTER (WHERE k.cls='sealable')::int AS sealable,\n      COUNT(*) FILTER (WHERE k.cls='sealable' AND EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=p.id AND c.embedding_image IS NOT NULL\n        AND ((c.body_generation IS NULL AND p.body_storage <> 'segmented')\n       OR (c.body_generation <= p.body_generation\n           AND EXISTS (SELECT 1 FROM page_body_manifest lm WHERE lm.page_id = c.page_id AND lm.occurrence_id = c.occurrence_id\n             AND lm.staging_id IS NULL AND lm.gen_from <= p.body_generation AND (lm.gen_to IS NULL OR lm.gen_to > p.body_generation))))))::int AS sealable_with_visual,\n      COUNT(*) FILTER (WHERE k.cls='reimport')::int AS reimport,\n      COUNT(*) FILTER (WHERE k.cls='reimport' AND p.chunker_version < 0)::int AS ocr_required,\n      COUNT(*) FILTER (WHERE k.cls='protected')::int AS protected,\n      COUNT(*) FILTER (WHERE k.cls='archived')::int AS archived,\n      EXTRACT(EPOCH FROM now()-MIN(j.updated_at) FILTER (WHERE k.cls IN ('text','sealable','reimport')))::float8 AS oldest,\n      now()::text AS as_of\n    FROM page_projection_jobs j JOIN sources s ON s.incarnation=j.source_incarnation\n    JOIN pages p ON p.source_id=s.id AND p.slug=j.slug AND p.deleted_at IS NULL\n    CROSS JOIN LATERAL (SELECT (CASE WHEN s.archived THEN 'archived'\n    WHEN (p.page_kind IS DISTINCT FROM 'image' OR p.body_storage = 'segmented') THEN 'text'\n    WHEN (CASE WHEN p.body_storage = 'segmented' THEN p.body_flags->>'has_protected' IS DISTINCT FROM 'false'\n    ELSE (COALESCE(p.compiled_truth, '') ~ '<!--- gbrain:(facts|takes):(begin|end) -->' OR COALESCE(p.timeline, '') ~ '<!--- gbrain:(facts|takes):(begin|end) -->') END) THEN 'protected'\n    WHEN p.chunker_version >= 4 AND (SELECT count(*) = 1 AND bool_and(c.chunk_index = 0 AND c.chunk_source = 'image_asset' AND c.modality = 'image'\n      AND char_length(c.chunk_text) < 65536 AND c.chunk_text = COALESCE(NULLIF(left(coalesce(p.compiled_truth, p.truth_lead), 65536), ''), p.title))\n    FROM content_chunks c WHERE c.page_id = p.id AND ((c.body_generation IS NULL AND p.body_storage <> 'segmented')\n       OR (c.body_generation <= p.body_generation\n           AND EXISTS (SELECT 1 FROM page_body_manifest lm WHERE lm.page_id = c.page_id AND lm.occurrence_id = c.occurrence_id\n             AND lm.staging_id IS NULL AND lm.gen_from <= p.body_generation AND (lm.gen_to IS NULL OR lm.gen_to > p.body_generation))))) IS TRUE THEN 'sealable'\n    ELSE 'reimport' END) AS cls) k\n    WHERE p.source_id = $1",
  backlogIds: "SELECT COUNT(*) FILTER (WHERE k.cls='text')::int AS pending,\n      COUNT(*) FILTER (WHERE k.cls='text' AND j.reason='rebuild_failed')::int AS failed,\n      COUNT(*) FILTER (WHERE k.cls='sealable')::int AS sealable,\n      COUNT(*) FILTER (WHERE k.cls='sealable' AND EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=p.id AND c.embedding_image IS NOT NULL\n        AND ((c.body_generation IS NULL AND p.body_storage <> 'segmented')\n       OR (c.body_generation <= p.body_generation\n           AND EXISTS (SELECT 1 FROM page_body_manifest lm WHERE lm.page_id = c.page_id AND lm.occurrence_id = c.occurrence_id\n             AND lm.staging_id IS NULL AND lm.gen_from <= p.body_generation AND (lm.gen_to IS NULL OR lm.gen_to > p.body_generation))))))::int AS sealable_with_visual,\n      COUNT(*) FILTER (WHERE k.cls='reimport')::int AS reimport,\n      COUNT(*) FILTER (WHERE k.cls='reimport' AND p.chunker_version < 0)::int AS ocr_required,\n      COUNT(*) FILTER (WHERE k.cls='protected')::int AS protected,\n      COUNT(*) FILTER (WHERE k.cls='archived')::int AS archived,\n      EXTRACT(EPOCH FROM now()-MIN(j.updated_at) FILTER (WHERE k.cls IN ('text','sealable','reimport')))::float8 AS oldest,\n      now()::text AS as_of\n    FROM page_projection_jobs j JOIN sources s ON s.incarnation=j.source_incarnation\n    JOIN pages p ON p.source_id=s.id AND p.slug=j.slug AND p.deleted_at IS NULL\n    CROSS JOIN LATERAL (SELECT (CASE WHEN s.archived THEN 'archived'\n    WHEN (p.page_kind IS DISTINCT FROM 'image' OR p.body_storage = 'segmented') THEN 'text'\n    WHEN (CASE WHEN p.body_storage = 'segmented' THEN p.body_flags->>'has_protected' IS DISTINCT FROM 'false'\n    ELSE (COALESCE(p.compiled_truth, '') ~ '<!--- gbrain:(facts|takes):(begin|end) -->' OR COALESCE(p.timeline, '') ~ '<!--- gbrain:(facts|takes):(begin|end) -->') END) THEN 'protected'\n    WHEN p.chunker_version >= 4 AND (SELECT count(*) = 1 AND bool_and(c.chunk_index = 0 AND c.chunk_source = 'image_asset' AND c.modality = 'image'\n      AND char_length(c.chunk_text) < 65536 AND c.chunk_text = COALESCE(NULLIF(left(coalesce(p.compiled_truth, p.truth_lead), 65536), ''), p.title))\n    FROM content_chunks c WHERE c.page_id = p.id AND ((c.body_generation IS NULL AND p.body_storage <> 'segmented')\n       OR (c.body_generation <= p.body_generation\n           AND EXISTS (SELECT 1 FROM page_body_manifest lm WHERE lm.page_id = c.page_id AND lm.occurrence_id = c.occurrence_id\n             AND lm.staging_id IS NULL AND lm.gen_from <= p.body_generation AND (lm.gen_to IS NULL OR lm.gen_to > p.body_generation))))) IS TRUE THEN 'sealable'\n    ELSE 'reimport' END) AS cls) k\n    WHERE p.source_id = ANY($1::text[])",
  preview: "SELECT s.id AS source_id,j.slug,p.page_kind,j.reason,j.updated_at::text AS updated_at\n    FROM page_projection_jobs j CROSS JOIN LATERAL (SELECT s.id FROM sources s\n      WHERE s.incarnation=j.source_incarnation AND NOT s.archived OFFSET 0) s\n    CROSS JOIN LATERAL (SELECT p.page_kind FROM pages p WHERE p.id=(SELECT k.id FROM pages k WHERE k.source_id=s.id AND k.slug=j.slug)\n      AND p.deleted_at IS NULL AND ((p.page_kind IN ('markdown','code') AND p.body_storage IS DISTINCT FROM 'segmented') OR (p.page_kind = 'image' AND p.body_storage IS DISTINCT FROM 'segmented' AND NOT (CASE WHEN p.body_storage = 'segmented' THEN p.body_flags->>'has_protected' IS DISTINCT FROM 'false'\n    ELSE (COALESCE(p.compiled_truth, '') ~ '<!--- gbrain:(facts|takes):(begin|end) -->' OR COALESCE(p.timeline, '') ~ '<!--- gbrain:(facts|takes):(begin|end) -->') END)\n    AND p.chunker_version >= 4 AND (SELECT count(*) = 1 AND bool_and(c.chunk_index = 0 AND c.chunk_source = 'image_asset' AND c.modality = 'image'\n      AND char_length(c.chunk_text) < 65536 AND c.chunk_text = COALESCE(NULLIF(left(coalesce(p.compiled_truth, p.truth_lead), 65536), ''), p.title))\n    FROM content_chunks c WHERE c.page_id = p.id AND ((c.body_generation IS NULL AND p.body_storage <> 'segmented')\n       OR (c.body_generation <= p.body_generation\n           AND EXISTS (SELECT 1 FROM page_body_manifest lm WHERE lm.page_id = c.page_id AND lm.occurrence_id = c.occurrence_id\n             AND lm.staging_id IS NULL AND lm.gen_from <= p.body_generation AND (lm.gen_to IS NULL OR lm.gen_to > p.body_generation))))) IS TRUE)) OFFSET 0) p\n    ORDER BY CASE WHEN p.page_kind NOT IN ('markdown','code') THEN 1\n      WHEN EXISTS (SELECT 1 FROM pages q WHERE q.source_id=s.id AND q.slug=j.slug AND q.text_projection_revision='00000000-0000-0000-0000-000000000153'::uuid) THEN 2\n      ELSE 0 END,j.updated_at,j.source_incarnation,j.slug COLLATE \"C\" LIMIT $1",
  rows: "SELECT GREATEST(reltuples,0)::float8 AS rows FROM pg_class WHERE oid='pages'::regclass",
  runStart: 'SELECT now()::text AS "runStart"',
  passed: 'SELECT now()>$1::text::timestamptz AS passed',
  union: "SELECT 1 FROM page_projection_jobs j CROSS JOIN LATERAL (SELECT s.id FROM sources s\n      WHERE s.incarnation=j.source_incarnation AND NOT s.archived OFFSET 0) s\n    CROSS JOIN LATERAL (SELECT p.page_kind FROM pages p WHERE p.id=(SELECT k.id FROM pages k WHERE k.source_id=s.id AND k.slug=j.slug)\n      AND p.deleted_at IS NULL AND p.page_kind IN ('markdown','code') AND p.body_storage IS DISTINCT FROM 'segmented' OFFSET 0) p\n      UNION ALL SELECT 1 FROM page_projection_jobs j JOIN sources s ON s.incarnation=j.source_incarnation AND NOT s.archived\n    JOIN pages p ON p.source_id=s.id AND p.slug=j.slug AND p.deleted_at IS NULL AND p.body_storage='segmented' LIMIT 1",
  unionMedia: "SELECT 1 FROM page_projection_jobs j CROSS JOIN LATERAL (SELECT s.id FROM sources s\n      WHERE s.incarnation=j.source_incarnation AND NOT s.archived OFFSET 0) s\n    CROSS JOIN LATERAL (SELECT p.page_kind FROM pages p WHERE p.id=(SELECT k.id FROM pages k WHERE k.source_id=s.id AND k.slug=j.slug)\n      AND p.deleted_at IS NULL AND ((p.page_kind IN ('markdown','code') AND p.body_storage IS DISTINCT FROM 'segmented') OR (p.page_kind = 'image' AND p.body_storage IS DISTINCT FROM 'segmented' AND NOT (CASE WHEN p.body_storage = 'segmented' THEN p.body_flags->>'has_protected' IS DISTINCT FROM 'false'\n    ELSE (COALESCE(p.compiled_truth, '') ~ '<!--- gbrain:(facts|takes):(begin|end) -->' OR COALESCE(p.timeline, '') ~ '<!--- gbrain:(facts|takes):(begin|end) -->') END)\n    AND p.chunker_version >= 4 AND (SELECT count(*) = 1 AND bool_and(c.chunk_index = 0 AND c.chunk_source = 'image_asset' AND c.modality = 'image'\n      AND char_length(c.chunk_text) < 65536 AND c.chunk_text = COALESCE(NULLIF(left(coalesce(p.compiled_truth, p.truth_lead), 65536), ''), p.title))\n    FROM content_chunks c WHERE c.page_id = p.id AND ((c.body_generation IS NULL AND p.body_storage <> 'segmented')\n       OR (c.body_generation <= p.body_generation\n           AND EXISTS (SELECT 1 FROM page_body_manifest lm WHERE lm.page_id = c.page_id AND lm.occurrence_id = c.occurrence_id\n             AND lm.staging_id IS NULL AND lm.gen_from <= p.body_generation AND (lm.gen_to IS NULL OR lm.gen_to > p.body_generation))))) IS TRUE)) OFFSET 0) p\n      UNION ALL SELECT 1 FROM page_projection_jobs j JOIN sources s ON s.incarnation=j.source_incarnation AND NOT s.archived\n    JOIN pages p ON p.source_id=s.id AND p.slug=j.slug AND p.deleted_at IS NULL AND p.body_storage='segmented' LIMIT 1",
};

test("the drain's queue insert, backlog, preview, clock, work probe and row estimate send the recorded statements", async () => {
  const { engine, last } = recordingEngine();
  await engine.queuePageProjectionJob('src-a', 'notes/a', 'safe_chunk_reseal');
  expect(last()).toEqual({ text: OLD_DRAIN.queue, params: ["src-a", "notes/a", "safe_chunk_reseal"] });
  await engine.readProjectionBacklog({ sourceId: 'src-a' });
  expect(last()).toEqual({ text: OLD_DRAIN.backlog, params: ["src-a"] });
  await engine.readProjectionBacklog({ sourceIds: ['src-a', 'src-b'] });
  expect(last()).toEqual({ text: OLD_DRAIN.backlogIds, params: [["src-a", "src-b"]] });
  await engine.listProjectionDrainPreview(7);
  expect(last()).toEqual({ text: OLD_DRAIN.preview, params: [7] });
  expect(await engine.readPagesRowEstimate()).toBe(0);
  expect(last()).toEqual({ text: OLD_DRAIN.rows, params: [] });
  expect(await engine.isDrainClockPast('2026-11-18 02:37:05.215+00')).toBe(false);
  expect(last()).toEqual({ text: OLD_DRAIN.passed, params: ['2026-11-18 02:37:05.215+00'] });
  expect(await engine.hasQueuedProjectionWork()).toBe(false);
  expect(last()).toEqual({ text: OLD_DRAIN.union, params: [] });
  expect(await engine.hasQueuedProjectionWork({ media: true })).toBe(false);
  expect(last()).toEqual({ text: OLD_DRAIN.unionMedia, params: [] });
  const clock = recordingEngine(stmt => stmt.text === OLD_DRAIN.runStart ? [{ runStart: '2026-11-18 02:37:05.215+00' }] : undefined);
  expect(await clock.engine.readDrainRunStart()).toBe('2026-11-18 02:37:05.215+00');
  expect(clock.last()).toEqual({ text: OLD_DRAIN.runStart, params: [] });
});

/** The image seal's statements (sealImageProjections), recorded from the raw callers before the move; each is composed with sqlFragment, so only placeholder numbering may differ. */
const OLD_SEAL = {
  window: { text: "SELECT s.id AS source_id,j.source_incarnation::text AS source_incarnation,\n        j.slug,j.revision::text AS revision,p.sealable IS TRUE AS sealable\n      FROM (SELECT source_incarnation,slug,revision FROM page_projection_jobs j WHERE (j.source_incarnation,j.slug COLLATE \"C\") > ($1::uuid,$2 COLLATE \"C\") AND j.updated_at<=$4::text::timestamptz\n        ORDER BY j.source_incarnation,j.slug COLLATE \"C\" LIMIT $3) j\n      LEFT JOIN LATERAL (SELECT s.id FROM sources s WHERE s.incarnation=j.source_incarnation AND NOT s.archived OFFSET 0) s ON true\n      LEFT JOIN LATERAL (SELECT p.deleted_at IS NULL AND p.knowledge_revision=j.revision AND (p.page_kind = 'image' AND p.body_storage IS DISTINCT FROM 'segmented' AND NOT (CASE WHEN p.body_storage = 'segmented' THEN p.body_flags->>'has_protected' IS DISTINCT FROM 'false'\n    ELSE (COALESCE(p.compiled_truth, '') ~ '<!--- gbrain:(facts|takes):(begin|end) -->' OR COALESCE(p.timeline, '') ~ '<!--- gbrain:(facts|takes):(begin|end) -->') END)\n    AND p.chunker_version >= 4 AND (SELECT count(*) = 1 AND bool_and(c.chunk_index = 0 AND c.chunk_source = 'image_asset' AND c.modality = 'image'\n      AND char_length(c.chunk_text) < 65536 AND c.chunk_text = COALESCE(NULLIF(left(coalesce(p.compiled_truth, p.truth_lead), 65536), ''), p.title))\n    FROM content_chunks c WHERE c.page_id = p.id AND ((c.body_generation IS NULL AND p.body_storage <> 'segmented')\n       OR (c.body_generation <= p.body_generation\n           AND EXISTS (SELECT 1 FROM page_body_manifest lm WHERE lm.page_id = c.page_id AND lm.occurrence_id = c.occurrence_id\n             AND lm.staging_id IS NULL AND lm.gen_from <= p.body_generation AND (lm.gen_to IS NULL OR lm.gen_to > p.body_generation))))) IS TRUE) AS sealable\n        FROM pages p WHERE p.source_id=s.id AND p.slug=j.slug OFFSET 0) p ON true\n      ORDER BY j.source_incarnation,j.slug COLLATE \"C\"", params: ["00000000-0000-0000-0000-000000000000", "", 500, "2026-11-18 02:37:05.215+00"] },
  pages: { text: "SELECT p.id,p.knowledge_revision::text AS revision,p.title,\n          p.contextual_retrieval_mode AS mode,p.corpus_generation\n        FROM jsonb_to_recordset($1::text::jsonb) AS v(source_id text, slug text, revision uuid)\n        JOIN sources s ON s.id=v.source_id AND NOT s.archived\n        CROSS JOIN LATERAL (SELECT p.id FROM pages p WHERE p.source_id=v.source_id AND p.slug=v.slug OFFSET 0) k\n        JOIN pages p ON p.id=k.id\n        WHERE p.deleted_at IS NULL AND p.knowledge_revision=v.revision AND (p.page_kind = 'image' AND p.body_storage IS DISTINCT FROM 'segmented' AND NOT (CASE WHEN p.body_storage = 'segmented' THEN p.body_flags->>'has_protected' IS DISTINCT FROM 'false'\n    ELSE (COALESCE(p.compiled_truth, '') ~ '<!--- gbrain:(facts|takes):(begin|end) -->' OR COALESCE(p.timeline, '') ~ '<!--- gbrain:(facts|takes):(begin|end) -->') END)\n    AND p.chunker_version >= 4 AND (SELECT count(*) = 1 AND bool_and(c.chunk_index = 0 AND c.chunk_source = 'image_asset' AND c.modality = 'image'\n      AND char_length(c.chunk_text) < 65536 AND c.chunk_text = COALESCE(NULLIF(left(coalesce(p.compiled_truth, p.truth_lead), 65536), ''), p.title))\n    FROM content_chunks c WHERE c.page_id = p.id AND ((c.body_generation IS NULL AND p.body_storage <> 'segmented')\n       OR (c.body_generation <= p.body_generation\n           AND EXISTS (SELECT 1 FROM page_body_manifest lm WHERE lm.page_id = c.page_id AND lm.occurrence_id = c.occurrence_id\n             AND lm.staging_id IS NULL AND lm.gen_from <= p.body_generation AND (lm.gen_to IS NULL OR lm.gen_to > p.body_generation))))) IS TRUE)", params: ["[{\"source_id\":\"src-a\",\"slug\":\"images/a\",\"revision\":\"00000000-0000-0000-0000-0000000000bb\"}]"] },
  chunks: { text: "SELECT id,page_id,chunk_text,chunk_source,embedding_input_hash,\n          (\"embedding\" IS NOT NULL AND embedded_text_hash IS NOT DISTINCT FROM md5(chunk_text)) AND model IS NOT DISTINCT FROM $2 AS current\n        FROM content_chunks c WHERE c.page_id=ANY($1::int[]) AND c.\"embedding\" IS NOT NULL AND EXISTS (SELECT 1 FROM pages gp WHERE gp.id = c.page_id AND ((c.body_generation IS NULL AND gp.body_storage <> 'segmented')\n       OR (c.body_generation <= gp.body_generation\n           AND EXISTS (SELECT 1 FROM page_body_manifest lm WHERE lm.page_id = c.page_id AND lm.occurrence_id = c.occurrence_id\n             AND lm.staging_id IS NULL AND lm.gen_from <= gp.body_generation AND (lm.gen_to IS NULL OR lm.gen_to > gp.body_generation)))))", params: [[7], null] },
  clear: { text: "UPDATE content_chunks SET \"embedding\"=NULL,embedded_at=NULL,embedded_text_hash=NULL,embedding_input_hash=NULL,\n          embedding_pending_since=COALESCE(embedding_pending_since,now()) WHERE id=ANY($1::int[])", params: [[9]] },
  seal: { text: "UPDATE pages SET text_projection_revision=pages.knowledge_revision\n          FROM jsonb_to_recordset($1::text::jsonb) AS v(id int, revision uuid)\n          WHERE pages.id=v.id AND pages.knowledge_revision=v.revision\n          RETURNING EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=pages.id AND c.embedding_image IS NOT NULL\n            AND ((c.body_generation IS NULL AND pages.body_storage <> 'segmented')\n       OR (c.body_generation <= pages.body_generation\n           AND EXISTS (SELECT 1 FROM page_body_manifest lm WHERE lm.page_id = c.page_id AND lm.occurrence_id = c.occurrence_id\n             AND lm.staging_id IS NULL AND lm.gen_from <= pages.body_generation AND (lm.gen_to IS NULL OR lm.gen_to > pages.body_generation))))) AS has_visual", params: ["[{\"id\":7,\"revision\":\"00000000-0000-0000-0000-0000000000bb\"}]"] },
};

test("the image seal's window, page read, chunk read, vector clear and seal send the recorded statements", async () => {
  const { engine, last } = recordingEngine();
  await engine.listImageSealWindow({ sourceIncarnation: '00000000-0000-0000-0000-000000000000', slug: '' }, 500, '2026-11-18 02:37:05.215+00');
  expect(bound(last())).toBe(bound(OLD_SEAL.window));
  await engine.readImageSealPages([{ source_id: 'src-a', slug: 'images/a', revision: '00000000-0000-0000-0000-0000000000bb' }]);
  expect(bound(last())).toBe(bound(OLD_SEAL.pages));
  await engine.listImageSealChunks([7], COLUMN, null);
  expect(bound(last())).toBe(bound(OLD_SEAL.chunks));
  await engine.clearImageSealVectors(COLUMN, [{ id: 9, page_id: 7 }]);
  expect(bound(last())).toBe(bound(OLD_SEAL.clear));
  await engine.sealImagePages([{ id: 7, revision: '00000000-0000-0000-0000-0000000000bb' }]);
  expect(bound(last())).toBe(bound(OLD_SEAL.seal));
});
