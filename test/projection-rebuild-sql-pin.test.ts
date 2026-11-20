/**
 * The projection rebuild members (src/core/engine-sql/projection-rebuild.ts) send Postgres the statement text and binds
 * rebuildPendingPageProjections, planProjectionKeep, installPageProjection and the rebuild statistics' drained probe
 * (src/core/page-state/projections.ts) sent through `executeRaw` before they had members. A drift here changes a query
 * plan or a result on Postgres alone, which PGLite parity cannot see.
 *
 * Protects: the queue listing the rebuild sends for five option sets, and each member's text and binds, equal the old
 * raw statements (the texts below were recorded from the raw callers before the move). The queue listing, the keep
 * plan and the vector clear are composed with sqlFragment, which numbers placeholders in text order: they are compared
 * with each placeholder replaced by the value it binds, so only the numbering may differ. The other statements match
 * byte for byte. Fails when a member reorders a clause, binds a value differently or in a different place, or moves
 * the listing off the pool. No database: the engine runs on the recording fake.
 */
import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { rebuildPendingPageProjections } from '../src/core/page-state/projections.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';
import { DELETE_PROJECTION_JOB_SQL } from '../src/core/engine-sql/persistence-housekeeping.ts';

function recordingEngine() {
  const fake = makeFakeSql();
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
