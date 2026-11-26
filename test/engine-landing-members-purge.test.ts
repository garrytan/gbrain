/**
 * The page-purge and persistence BrainEngine members that land ahead of their callers (engine-sql/facts-purge.ts,
 * belief-purge.ts, sync-reason-reads.ts, trust-withdrawals.ts and calibration-profiles.ts), run on PGLite. Each test calls
 * the members of one area and checks a real result: a returned value with specific content, a row written and read back
 * through another member or a plain SELECT, or a count that changes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { UNATTRIBUTED_MEMORY_SLUG } from '../src/core/facts-fence.ts';
import { stageGeneration, publishSegmentedPage, segmentText, sha256, hexOf, stagingInput } from './helpers/page-body-fixtures.ts';

let engine: PGLiteEngine;
let incarnation: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('other', 'other') ON CONFLICT DO NOTHING");
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('purge-example', 'purge-example') ON CONFLICT DO NOTHING");
  incarnation = (await engine.readSourceMembership('default'))!.incarnation;
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

const page = (slug: string, text = `Body of ${slug}.`) =>
  engine.putPage(slug, { type: 'note', title: slug, compiled_truth: text });

const raw = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => engine.executeRaw<T>(sql, params);

const fingerprint = async (claim: string) => (await raw<{ h: string }>('SELECT gbrain_fact_fingerprint($1) AS h', [claim]))[0]!.h;

/** A 1536-dimension vector text with a one in position `hot`. */
const vec = (hot: number) => `[${Array.from({ length: 1536 }, (_, i) => (i === hot ? 1 : 0)).join(',')}]`;

/** Admits one queued write request under its own counter keys; returns its journal id and request id. */
async function admit(tag: string, slug: string): Promise<{ id: string; requestId: string }> {
  const keys = [`principal:local_cli:${tag}`, `brain:${tag}`];
  const requestId = randomUUID();
  await engine.lockPersistenceCounters(keys);
  const { id } = await engine.insertWriteRequest({
    principalKind: 'local_cli', principalId: tag, requestId, operation: 'remember', sourceId: 'default',
    sourceIncarnation: incarnation, pageId: null, slug, worktreeId: null,
    topologyGeneration: null, digest: 'd'.repeat(64), intent: { kind: 'remember', text: 'hello' }, authority: { scopes: ['write'] },
    intentBytes: 100, terminalReservation: 8192, targetKind: 'page', protocolVersion: 1, admitterVersion: 'landing',
    admitterHostId: null, counterKeys: keys, clientRequestId: null, state: 'queued', deferredRefreshId: null,
  });
  return { id, requestId };
}

/** Inserts one saved version of a page; returns its id. */
async function version(pageId: number, over: { compiled?: string | null; timeline?: string | null; reason?: string | null; segmented?: boolean } = {}): Promise<number> {
  const [row] = await raw<{ id: number }>(
    `INSERT INTO page_versions (page_id, compiled_truth, timeline, title, type, frontmatter, change_reason, body_storage, body_generation)
     VALUES ($1, $2, $3, 'Version title', 'note', '{}'::jsonb, $4, $5, $6) RETURNING id`,
    [pageId, over.segmented ? null : (over.compiled ?? 'plain version text'), over.timeline ?? null, over.reason ?? null, over.segmented ? 'segmented' : 'inline', over.segmented ? 1 : null]);
  return Number(row!.id);
}

describe('purge probes over the ledger and the facts', () => {
  test('listBeliefEventsForPurgeProbe pages the source\'s events that record a value, in id order, after a cursor', async () => {
    const insert = (n: number, value: string | null, source = 'purge-example') => raw<{ id: number }>(
      `INSERT INTO belief_events (event_key, source_id, source_incarnation, slug, subject_kind, subject_key, event_type, trust_tier, visibility,
                                  publication_id, ord, state_hash, cause, value)
       VALUES (decode($1, 'hex'), $2, $3::uuid, 'people/alice-example', 'fact', $4, 'created', 'unknown', 'private', $5::uuid, 0, 'state', '{}', $6::jsonb)
       RETURNING id`,
      [`0${n}`.padEnd(8, 'b'), source, incarnation, `fact:${n}`, randomUUID(), value]);
    const [{ id: first }] = await insert(1, '{"fact":"alice-example likes tea"}');
    await insert(2, null);
    const [{ id: third }] = await insert(3, '{"fact":"alice-example likes coffee"}');
    await insert(4, '{"fact":"elsewhere"}', 'other');

    const all = await engine.listBeliefEventsForPurgeProbe('purge-example', 0);
    expect(all.map((e) => Number(e.id))).toEqual([Number(first), Number(third)]);
    expect(all[0]).toMatchObject({ subject_kind: 'fact', subject_key: 'fact:1', value: { fact: 'alice-example likes tea' } });
    expect(all[1]).toMatchObject({ subject_key: 'fact:3', value: { fact: 'alice-example likes coffee' } });
    expect((await engine.listBeliefEventsForPurgeProbe('purge-example', Number(first))).map((e) => Number(e.id))).toEqual([Number(third)]);
    expect(await engine.listBeliefEventsForPurgeProbe('purge-example', Number(third))).toEqual([]);
    expect((await engine.listBeliefEventsForPurgeProbe('other', 0)).map((e) => e.subject_key)).toEqual(['fact:4']);
  });

  test('listFactContextsForPurgeProbe lists the live facts of the source that have a context, in id order, after a cursor', async () => {
    const add = async (fact: string, context: string | null, source = 'purge-example') =>
      (await engine.insertFact({ fact, entity_slug: 'people/alice-example', source: 'test:purge', context }, { source_id: source })).id;
    const withContext = await add('Context probe fact one', 'met at the acme-example offsite');
    await add('Context probe fact without context', null);
    const expired = await add('Context probe expired fact', 'expired context');
    await raw('UPDATE facts SET expired_at = now() WHERE id = $1', [expired]);
    const second = await add('Context probe fact two', 'second context');
    await add('Context probe fact elsewhere', 'other source context', 'other');

    const rows = await engine.listFactContextsForPurgeProbe('purge-example', 0);
    expect(rows.map((r) => ({ id: Number(r.id), context: r.context }))).toEqual([
      { id: withContext, context: 'met at the acme-example offsite' }, { id: second, context: 'second context' },
    ]);
    expect((await engine.listFactContextsForPurgeProbe('purge-example', withContext)).map((r) => Number(r.id))).toEqual([second]);
    expect(await engine.listFactContextsForPurgeProbe('purge-example', second)).toEqual([]);
  });

  test('listNearestFactsForPurge ranks the source\'s same-model facts by distance and flags the ones that contain the claim', async () => {
    const claim = 'Alice-Example moved to Lisbon';
    const add = async (fact: string, hot: number, model: string, source = 'purge-example') => {
      const { id } = await engine.insertFact({ fact, entity_slug: 'people/alice-example', source: 'test:purge' }, { source_id: source });
      await raw('UPDATE facts SET embedding = $2::halfvec, embedding_model = $3 WHERE id = $1', [id, vec(hot), model]);
      return id;
    };
    const exact = await add(`${claim} last spring`, 0, 'model-example');
    const far = await add('Unrelated nearest probe fact', 1, 'model-example');
    await add(`${claim} (other model)`, 0, 'model-other');
    await add(`${claim} (other source)`, 0, 'model-example', 'other');

    const near = await engine.listNearestFactsForPurge(vec(0), 'purge-example', 'model-example', claim);
    expect(near.map((n) => Number(n.id))).toEqual([exact, far]);
    expect(near[0]).toMatchObject({ contains_claim: true });
    expect(Number(near[0]!.similarity)).toBeCloseTo(1, 5);
    expect(near[1]).toMatchObject({ contains_claim: false });
    expect(Number(near[1]!.similarity)).toBeCloseTo(0, 5);
    expect(await engine.listNearestFactsForPurge(vec(0), 'purge-example', 'model-none', claim)).toEqual([]);
  });

  test('countPurgeFingerprintResidue counts the facts and takes that still carry the claim, for any subject or one', async () => {
    const claim = 'Alice-Example residue claim';
    await engine.insertFact({ fact: claim, entity_slug: 'people/alice-example', source: 'test:purge' }, { source_id: 'default' });
    await engine.insertFact({ fact: claim, entity_slug: 'companies/acme-example', source: 'test:purge' }, { source_id: 'default' });
    await engine.insertFact({ fact: claim, entity_slug: 'people/alice-example', source: 'test:purge' }, { source_id: 'other' });
    const carrier = await page('people/alice-example');
    await engine.addTakesBatch([{ page_id: carrier.id, row_num: 1, claim, kind: 'take', holder: 'brain' }]);
    const hash = await fingerprint(claim);

    expect(await engine.countPurgeFingerprintResidue('default', hash, '*')).toEqual({ facts: 2, takes: 1 });
    expect(await engine.countPurgeFingerprintResidue('default', hash, 'people/alice-example')).toEqual({ facts: 1, takes: 1 });
    expect(await engine.countPurgeFingerprintResidue('default', hash, 'companies/acme-example')).toEqual({ facts: 1, takes: 0 });
    expect(await engine.countPurgeFingerprintResidue('other', hash, '*')).toEqual({ facts: 1, takes: 0 });
    expect(await engine.countPurgeFingerprintResidue('default', await fingerprint('A claim no row carries'), '*')).toEqual({ facts: 0, takes: 0 });
  });

  test('listPurgeStreamSlugs answers each belief stream once, the holding page before the entity, and none for a fact with neither', async () => {
    const add = async (fact: string, entity: string | null, markdown: string | null) => {
      const { id } = await engine.insertFact({ fact, entity_slug: entity, source: 'test:purge' }, { source_id: 'default' });
      if (markdown) await raw('UPDATE facts SET source_markdown_slug = $2 WHERE id = $1', [id, markdown]);
      return id;
    };
    const a = await add('Stream fact a', 'people/stream-alice-example', 'people/stream-alice-example');
    const b = await add('Stream fact b', 'people/stream-alice-example', 'people/stream-alice-example');
    const c = await add('Stream fact c', 'companies/stream-acme-example', null);
    const d = await add('Stream fact d', 'people/stream-bob-example', 'meetings/stream-notes-example');
    const e = await add('Stream fact e', null, null);

    expect((await engine.listPurgeStreamSlugs([a, b, c, d, e])).sort()).toEqual([
      'companies/stream-acme-example', 'meetings/stream-notes-example', 'people/stream-alice-example',
    ]);
    expect(await engine.listPurgeStreamSlugs([e])).toEqual([]);
    expect(await engine.listPurgeStreamSlugs([])).toEqual([]);
  });

  test('listPageSourcePathsForPurge answers the distinct relative file paths of the pages and their versions, none absolute or climbing', async () => {
    const a = await page('purge-paths/a');
    const b = await page('purge-paths/b');
    const c = await page('purge-paths/c');
    const bare = await page('purge-paths/bare');
    await raw('UPDATE pages SET source_path = $2 WHERE id = $1', [a.id, 'notes/a.md']);
    await raw('UPDATE pages SET source_path = $2 WHERE id = $1', [b.id, '/abs/b.md']);
    await raw('UPDATE pages SET source_path = $2 WHERE id = $1', [c.id, 'x/../escape.md']);
    const v1 = await version(a.id);
    const v2 = await version(a.id);
    const v3 = await version(bare.id);
    await raw('UPDATE page_versions SET source_path = $2 WHERE id = $1', [v1, 'notes/a-old.md']);
    await raw('UPDATE page_versions SET source_path = $2 WHERE id = $1', [v2, 'notes/a.md']);
    await raw('UPDATE page_versions SET source_path = $2 WHERE id = $1', [v3, '']);

    const paths = async (ids: number[]) => (await engine.listPageSourcePathsForPurge(ids)).map((r) => r.source_path).sort();
    expect(await paths([a.id, b.id, c.id, bare.id])).toEqual(['notes/a-old.md', 'notes/a.md']);
    expect(await paths([b.id, c.id])).toEqual([]);
    expect(await paths([])).toEqual([]);
  });

  test('readPurgeReceiptSourcePath answers the checkout of the source, and null for a source with none or an unknown one', async () => {
    expect(await engine.readPurgeReceiptSourcePath('purge-example')).toBeNull();
    await raw("UPDATE sources SET local_path = '/srv/acme-example/brain' WHERE id = 'purge-example'");
    expect(await engine.readPurgeReceiptSourcePath('purge-example')).toBe('/srv/acme-example/brain');
    expect(await engine.readPurgeReceiptSourcePath('no-such-source')).toBeNull();
    await raw("UPDATE sources SET local_path = NULL WHERE id = 'purge-example'");
    expect(await engine.readPurgeReceiptSourcePath('purge-example')).toBeNull();
  });

  test('vacuumPurgedTables compacts the purge tables, with or without the query cache, and leaves their rows readable', async () => {
    const { id } = await engine.insertFact({ fact: 'Vacuum probe fact', entity_slug: 'people/alice-example', source: 'test:purge' }, { source_id: 'default' });
    const gone = await engine.insertFact({ fact: 'Vacuum probe fact to delete', entity_slug: 'people/alice-example', source: 'test:purge' }, { source_id: 'default' });
    await raw('DELETE FROM facts WHERE id = $1', [gone.id]);

    expect(await engine.vacuumPurgedTables(false)).toBeUndefined();
    expect(await engine.vacuumPurgedTables(true)).toBeUndefined();
    expect(await raw('SELECT fact FROM facts WHERE id = $1', [id])).toEqual([{ fact: 'Vacuum probe fact' }]);
    expect(await raw('SELECT fact FROM facts WHERE id = $1', [gone.id])).toEqual([]);
    expect((await raw<{ t: string }>("SELECT to_regclass('query_cache')::text AS t"))[0]!.t).toBe('query_cache');
  });
});

describe('purge planning over review rows, versions and persistence', () => {
  test('countPurgeReviewRows counts the review queue, review proposal and decide proposal rows that name the facts', async () => {
    await raw(`INSERT INTO decide_review_queue (kind, source_id, a_ref, b_ref) VALUES
      ('dup', 'default', '9001', '9002'), ('dup', 'default', '9003', '9001'), ('dup', 'default', '9004', '9005'), ('dup', 'other', '9001', '9002')`);
    await raw(`INSERT INTO decide_review_proposals (kind, source_id, sweep_id, a_ref, b_ref, p_action) VALUES
      ('dup', 'default', 'sweep-a', '9001', '9009', 0.9), ('dup', 'default', 'sweep-a', '9008', '9009', 0.9)`);
    await raw(`INSERT INTO decide_proposals (source_id, sweep_id, pair_index, new_fact_id, old_fact_id, p_supersede, proposal_floor) VALUES
      ('default', 'sweep-a', 0, 9001, 9100, 0.8, 0.5), ('default', 'sweep-a', 1, 9101, 9002, 0.8, 0.5), ('default', 'sweep-a', 2, 9102, 9103, 0.8, 0.5)`);

    expect(await engine.countPurgeReviewRows('default', ['9001', '9002'], [9001, 9002]))
      .toEqual({ decide_review_queue: 2, decide_review_proposals: 1, decide_proposals: 2 });
    expect(await engine.countPurgeReviewRows('default', ['9004'], [9102]))
      .toEqual({ decide_review_queue: 1, decide_review_proposals: 0, decide_proposals: 1 });
    expect(await engine.countPurgeReviewRows('other', ['9001'], [9001]))
      .toEqual({ decide_review_queue: 1, decide_review_proposals: 0, decide_proposals: 0 });
    expect(await engine.countPurgeReviewRows('default', [], [])).toEqual({ decide_review_queue: 0, decide_review_proposals: 0, decide_proposals: 0 });
  });

  test('countPurgeVersionsCarryingClaim counts the versions that carry the claim in text, timeline, change reason or segments', async () => {
    const claim = 'quokka-claim-example';
    const owner = await page('purge-versions/owner');
    await version(owner.id, { compiled: `The ${claim} appears here` });
    await version(owner.id, { timeline: `2026-01-01 ${claim}` });
    await version(owner.id, { reason: `redacted ${claim}` });
    await version(owner.id, { compiled: 'a version that does not mention it' });
    const seg = await publishSegmentedPage(engine, 'purge-versions/segmented', [segmentText(`# Intro\nthe ${claim} is in a segment\n`)]);
    await version(seg.pageId, { segmented: true });

    expect(await engine.countPurgeVersionsCarryingClaim('default', claim, claim, claim)).toBe(4);
    expect(await engine.countPurgeVersionsCarryingClaim('default', 'no-such-claim-example', 'no-such-claim-example', 'no-such-claim-example')).toBe(0);
    expect(await engine.countPurgeVersionsCarryingClaim('other', claim, claim, claim)).toBe(0);
  });

  test('listSegmentedVersionsForPurge lists the segmented versions of the pages or whose generation holds the claim, after a cursor', async () => {
    const claim = 'okapi-claim-example';
    const carrying = await publishSegmentedPage(engine, 'purge-segv/carrying', [segmentText(`# Intro\nthe ${claim} is here\n`)]);
    const clean = await publishSegmentedPage(engine, 'purge-segv/clean', [segmentText('# Intro\nnothing to see\n')]);
    const vCarrying = await version(carrying.pageId, { segmented: true });
    const vClean = await version(clean.pageId, { segmented: true });
    await version(clean.pageId); // an inline version never lists

    const byClaim = await engine.listSegmentedVersionsForPurge('default', claim, [], 0);
    expect(byClaim.map((v) => Number(v.id))).toEqual([vCarrying]);
    expect(byClaim[0]).toMatchObject({ page_id: carrying.pageId, slug: 'purge-segv/carrying', title: 'Version title', type: 'note', frontmatter: {} });
    expect(Number(byClaim[0]!.generation)).toBe(1);

    expect((await engine.listSegmentedVersionsForPurge('default', 'no-such-claim-example', [clean.pageId], 0)).map((v) => Number(v.id))).toEqual([vClean]);
    expect((await engine.listSegmentedVersionsForPurge('default', claim, [clean.pageId], 0)).map((v) => Number(v.id))).toEqual([vCarrying, vClean]);
    expect((await engine.listSegmentedVersionsForPurge('default', claim, [clean.pageId], vCarrying)).map((v) => Number(v.id))).toEqual([vClean]);
    expect(await engine.listSegmentedVersionsForPurge('other', claim, [clean.pageId], 0)).toEqual([]);
  });

  test('findPurgeBlockedPublication names an unfinished write or withdrawal mirror on the pages, except the purge\'s own request', async () => {
    const write = await admit('purge-blocked', 'purge-blocked/page');
    const own = await admit('purge-own', 'purge-blocked/own');
    const none = randomUUID();

    expect(await engine.findPurgeBlockedPublication('default', ['purge-blocked/page'], none))
      .toEqual({ request_id: write.requestId, slug: 'purge-blocked/page', state: 'queued' });
    expect(await engine.findPurgeBlockedPublication('default', ['purge-blocked/page'], write.id)).toBeNull();
    expect(await engine.findPurgeBlockedPublication('default', ['purge-blocked/elsewhere'], none)).toBeNull();
    expect(await engine.findPurgeBlockedPublication('other', ['purge-blocked/page'], none)).toBeNull();

    await engine.insertPurgeEffects(own.id, 'default', { targets: [{ slug: 'purge-blocked/mirrored' }] });
    expect(await engine.findPurgeBlockedPublication('default', ['purge-blocked/mirrored'], none))
      .toEqual({ request_id: own.requestId, slug: 'purge-blocked/mirrored', state: 'queued' });
    expect(await engine.findPurgeBlockedPublication('default', ['purge-blocked/mirrored'], own.id)).toBeNull();
    await raw("UPDATE persistence_effects SET state = 'committed' WHERE request_id = $1::uuid AND kind = 'withdrawal-mirror'", [own.id]);
    expect(await engine.findPurgeBlockedPublication('default', ['purge-blocked/mirrored'], none)).toBeNull();
  });

  test('insertPurgeEffects queues the three purge effects under the source\'s incarnation, none twice', async () => {
    const request = await admit('purge-effects', 'purge-effects/page');
    const payload = { targets: [{ slug: 'purge-effects/page' }], note: 'alice-example purge' };
    await engine.insertPurgeEffects(request.id, 'default', payload);
    await engine.insertPurgeEffects(request.id, 'default', { targets: [], note: 'second call is ignored' });

    const rows = await raw<{ kind: string; state: string; source_id: string; source_incarnation: string; data: unknown }>(
      `SELECT kind, state, source_id, source_incarnation::text AS source_incarnation, data FROM persistence_effects WHERE request_id = $1::uuid ORDER BY kind`, [request.id]);
    expect(rows.map((r) => r.kind)).toEqual(['embedding', 'git', 'withdrawal-mirror']);
    for (const row of rows) {
      expect(row).toMatchObject({ state: 'queued', source_id: 'default', source_incarnation: incarnation, data: payload });
    }

    const stranger = await admit('purge-effects-none', 'purge-effects/none');
    await engine.insertPurgeEffects(stranger.id, 'no-such-source', payload);
    expect(await raw('SELECT 1 FROM persistence_effects WHERE request_id = $1::uuid', [stranger.id])).toEqual([]);
  });
});

describe('purge writes', () => {
  test('insertHoldingPagePurges tombstones each holding page that holds a listed fact about an entity, none twice', async () => {
    const claim = 'Alice-Example holding page purge claim';
    const hash = await fingerprint(claim);
    const holding = `people/${UNATTRIBUTED_MEMORY_SLUG}`;
    const add = async (entity: string | null, markdown: string) => {
      const { id } = await engine.insertFact({ fact: claim, entity_slug: entity, source: 'test:purge', visibility: 'world' }, { source_id: 'default' });
      await raw('UPDATE facts SET source_markdown_slug = $2 WHERE id = $1', [id, markdown]);
      return id;
    };
    const held = await add('people/alice-example', holding);
    const heldAgain = await add('people/bob-example', holding);
    const noEntity = await add(null, UNATTRIBUTED_MEMORY_SLUG);
    const ordinary = await add('people/carol-example', 'people/carol-example');
    const requestId = randomUUID();

    await engine.insertHoldingPagePurges('default', 'world', hash, requestId, 'owner', 'wrong fact', [held, heldAgain, noEntity, ordinary]);
    const stored = () => raw<{ subject: string; visibility: string; actor: string; reason: string; request_id: string }>(
      'SELECT subject, visibility, actor, reason, request_id::text AS request_id FROM fact_purges WHERE fact_hash = $1 ORDER BY subject', [hash]);
    expect(await stored()).toEqual([{ subject: holding, visibility: 'world', actor: 'owner', reason: 'wrong fact', request_id: requestId }]);

    await engine.insertHoldingPagePurges('default', 'world', hash, randomUUID(), 'someone-else', null, [held]);
    expect(await stored()).toEqual([{ subject: holding, visibility: 'world', actor: 'owner', reason: 'wrong fact', request_id: requestId }]);
    expect(await engine.isFactPurged('default', 'world', claim, holding)).toBe(true);
    expect(await engine.isFactPurged('default', 'world', claim, 'people/carol-example')).toBe(false);
  });

  test('deletePurgeTakeProposals deletes the source\'s take proposals whose claim carries the fingerprint, and says how many', async () => {
    const claim = 'Alice-Example take proposal claim';
    const insert = (slug: string, text: string, source = 'default') => raw(
      `INSERT INTO take_proposals (source_id, page_slug, content_hash, prompt_version, proposal_run_id, claim_text, kind, holder, weight, model_id)
       VALUES ($1, $2, $3, 'p1', 'run-1', $4, 'take', 'brain', 0.5, 'model-example')`, [source, slug, `hash-${slug}`, text]);
    await insert('proposals/one', claim);
    await insert('proposals/two', `  ${claim.toUpperCase()}  `);
    await insert('proposals/three', 'A different take proposal claim');
    await insert('proposals/four', claim, 'other');
    const hash = await fingerprint(claim);
    const remaining = (source: string) => raw<{ page_slug: string }>('SELECT page_slug FROM take_proposals WHERE source_id = $1 ORDER BY page_slug', [source]);

    expect(await engine.deletePurgeTakeProposals('default', await fingerprint('No proposal carries this'))).toBe(0);
    expect(await engine.deletePurgeTakeProposals('default', hash)).toBe(2);
    expect(await remaining('default')).toEqual([{ page_slug: 'proposals/three' }]);
    expect(await remaining('other')).toEqual([{ page_slug: 'proposals/four' }]);
    expect(await engine.deletePurgeTakeProposals('default', hash)).toBe(0);
  });

  test('setPurgeVersionBody stores the two body parts of a saved version, and a null timeline stays null', async () => {
    const owner = await page('purge-body/owner');
    const id = await version(owner.id, { compiled: 'old compiled text', timeline: '2026-01-01 old timeline' });
    const other = await version(owner.id, { compiled: 'untouched text', timeline: 'untouched timeline' });

    await engine.setPurgeVersionBody(id, 'redacted compiled text', 'redacted timeline');
    expect(await raw('SELECT compiled_truth, timeline FROM page_versions WHERE id = $1', [id])).toEqual([{ compiled_truth: 'redacted compiled text', timeline: 'redacted timeline' }]);
    await engine.setPurgeVersionBody(id, 'compiled only', null);
    expect(await raw('SELECT compiled_truth, timeline FROM page_versions WHERE id = $1', [id])).toEqual([{ compiled_truth: 'compiled only', timeline: null }]);
    expect(await raw('SELECT compiled_truth, timeline FROM page_versions WHERE id = $1', [other])).toEqual([{ compiled_truth: 'untouched text', timeline: 'untouched timeline' }]);
  });

  test('listPurgedPageRevisions answers the id, slug and knowledge revision of the source\'s listed pages, in slug order', async () => {
    const b = await page('purge-revisions/b');
    const a = await page('purge-revisions/a');
    const [{ r: revisionA }] = await raw<{ r: string }>('SELECT knowledge_revision::text AS r FROM pages WHERE id = $1', [a.id]);

    const rows = await engine.listPurgedPageRevisions('default', [b.id, a.id, a.id + 100_000]);
    expect(rows.map((r) => ({ id: Number(r.id), slug: r.slug }))).toEqual([{ id: a.id, slug: 'purge-revisions/a' }, { id: b.id, slug: 'purge-revisions/b' }]);
    expect(rows[0]!.knowledge_revision).toBe(revisionA);
    expect(typeof rows[1]!.knowledge_revision).toBe('string');
    expect(await engine.listPurgedPageRevisions('other', [a.id, b.id])).toEqual([]);
    expect(await engine.listPurgedPageRevisions('default', [])).toEqual([]);
  });
});

describe('purge of segmented storage', () => {
  test('abortPurgedStagings aborts the uncommitted stagings and answers the pages they belonged to, and leaves a committed one', async () => {
    const { id: openPage } = await engine.createSegmentedPageShell('purge-stage/open', { type: 'note', title: 'Open', frontmatter: {} }, { sourceId: 'default' });
    const open = await stageGeneration(engine, { pageId: openPage, slug: 'purge-stage/open', genFrom: 1, texts: [segmentText('open staging text\n')] });
    const committed = await publishSegmentedPage(engine, 'purge-stage/committed', [segmentText('committed text\n')]);
    const pageless = stagingInput({ slug: 'purge-stage/pageless', pageId: null });
    await engine.transaction(async (tx) => { await tx.openBodyStaging(pageless); });
    const state = async (id: string) => (await raw<{ state: string }>('SELECT state FROM page_body_stagings WHERE id = $1::uuid', [id]))[0]!.state;
    expect([await state(open.stagingId), await state(committed.stagingId), await state(pageless.id)]).toEqual(['open', 'committed', 'open']);

    const aborted = await engine.abortPurgedStagings([open.stagingId, committed.stagingId, pageless.id]);
    expect(aborted.map(Number)).toEqual([openPage]);
    expect([await state(open.stagingId), await state(committed.stagingId), await state(pageless.id)]).toEqual(['aborted', 'committed', 'aborted']);
    expect(await engine.abortPurgedStagings([])).toEqual([]);
  });

  test('deletePurgedStagingParts deletes the upload parts of the listed stagings, and says how many', async () => {
    const [one, two, keep] = [stagingInput({ slug: 'purge-parts/one' }), stagingInput({ slug: 'purge-parts/two' }), stagingInput({ slug: 'purge-parts/keep' })];
    await engine.transaction(async (tx) => { for (const s of [one, two, keep]) await tx.openBodyStaging(s); });
    const part = (staging: string, no: number) => raw(
      `INSERT INTO page_body_staging_parts (staging_id, part_no, byte_start, byte_len, sha256, body)
       VALUES ($1::uuid, $2, $3, 3, decode($4, 'hex'), decode('616263', 'hex'))`, [staging, no, no * 3, hexOf(sha256(`part ${staging} ${no}`))]);
    await part(one.id, 0);
    await part(one.id, 1);
    await part(two.id, 0);
    await part(keep.id, 0);
    const counts = async () => (await raw<{ id: string; n: number }>(
      'SELECT staging_id::text AS id, count(*)::int AS n FROM page_body_staging_parts WHERE staging_id = ANY($1::uuid[]) GROUP BY staging_id', [[one.id, two.id, keep.id]]))
      .sort((a, b) => a.id.localeCompare(b.id));

    expect(await engine.deletePurgedStagingParts([one.id, two.id])).toBe(3);
    expect(await counts()).toEqual([{ id: keep.id, n: 1 }]);
    expect(await engine.deletePurgedStagingParts([one.id, two.id])).toBe(0);
    expect(await engine.deletePurgedStagingParts([])).toBe(0);
  });

  test('deleteUnreferencedPurgedTexts deletes the unreferenced segment texts that were replaced or hold the claim, and keeps a referenced one', async () => {
    const claim = 'Narwhal-Claim-Example';
    const replaced = segmentText('replaced purge text without the sentence\n');
    const holding = segmentText(`an unreferenced text that holds the ${claim.toLowerCase()} in plain form\n`);
    const unrelated = segmentText('an unreferenced text the purge leaves alone\n');
    const published = await publishSegmentedPage(engine, 'purge-texts/live', [segmentText(`a live segment that still holds the ${claim}\n`)]);
    await engine.transaction(async (tx) => { await tx.stageSegmentTexts('default', [replaced, holding, unrelated]); });
    const present = async () => (await raw<{ h: string }>(
      "SELECT encode(sha256, 'hex') AS h FROM page_segment_texts WHERE source_id = 'default' AND sha256 = ANY(SELECT decode(h, 'hex') FROM unnest($1::text[]) AS h)",
      [[replaced, holding, unrelated].map((t) => hexOf(t.sha256))])).map((r) => r.h).sort();
    expect(await present()).toEqual([replaced, holding, unrelated].map((t) => hexOf(t.sha256)).sort());

    expect(await engine.deleteUnreferencedPurgedTexts('default', [replaced.sha256], claim)).toBe(2);
    expect(await present()).toEqual([hexOf(unrelated.sha256)]);
    expect(await raw("SELECT count(*)::int AS n FROM page_body_manifest WHERE page_id = $1", [published.pageId])).toEqual([{ n: 1 }]);
    expect((await raw<{ n: number }>(
      "SELECT count(*)::int AS n FROM page_segment_texts t WHERE strpos(lower(convert_from(t.body, 'UTF8')), 'a live segment that still holds') > 0"))[0]!.n).toBe(1);
    expect(await engine.deleteUnreferencedPurgedTexts('default', [], claim)).toBe(0);
  });
});

describe('purge flags, epochs, tombstone matches and calibration waves', () => {
  test('bumpSourcePurgeEpoch raises the epoch by one and readSourcePurgeEpoch reads it back, null for an unknown source', async () => {
    const before = Number(await engine.readSourcePurgeEpoch('purge-example'));
    expect(Number.isInteger(before)).toBe(true);
    expect(await engine.bumpSourcePurgeEpoch('purge-example')).toBe(before + 1);
    expect(Number(await engine.readSourcePurgeEpoch('purge-example'))).toBe(before + 1);
    expect(await engine.bumpSourcePurgeEpoch('purge-example')).toBe(before + 2);
    expect(Number(await engine.readSourcePurgeEpoch('purge-example'))).toBe(before + 2);
    expect(Number(await engine.readSourcePurgeEpoch('other'))).toBe(Number((await raw<{ e: string }>("SELECT purge_epoch::text AS e FROM sources WHERE id = 'other'"))[0]!.e));

    expect(await engine.bumpSourcePurgeEpoch('no-such-source')).toBeNull();
    expect(await engine.readSourcePurgeEpoch('no-such-source')).toBeNull();
  });

  test('bumpSourcePurgeEpoch inside a transaction rolls back with it', async () => {
    const before = Number(await engine.readSourcePurgeEpoch('other'));
    await expect(engine.transaction(async (tx) => {
      expect(await tx.bumpSourcePurgeEpoch('other')).toBe(before + 1);
      expect(Number(await tx.readSourcePurgeEpoch('other'))).toBe(before + 1);
      throw new Error('abandon the purge');
    })).rejects.toThrow('abandon the purge');
    expect(Number(await engine.readSourcePurgeEpoch('other'))).toBe(before);
  });

  test('readSourcePurgeFlags reports whether the source has a fact or take tombstone, and listPurgedTakeRows names the takes one matches', async () => {
    await raw("INSERT INTO sources (id, name) VALUES ('flags-example', 'flags-example') ON CONFLICT DO NOTHING");
    expect(await engine.readSourcePurgeFlags('flags-example')).toEqual({ facts: false, takes: false });

    expect(await engine.insertFactPurge({ sourceId: 'flags-example', visibility: 'world', subject: '*', factHash: await fingerprint('Flags fact claim'), requestId: null, actor: 'owner', reason: null })).toBe(true);
    expect(await engine.readSourcePurgeFlags('flags-example')).toEqual({ facts: true, takes: false });

    const claimed = 'Alice-Example purged take claim';
    const scoped = 'Alice-Example subject scoped take claim';
    expect(await engine.insertTakePurge({ sourceId: 'flags-example', subject: '*', requestId: null, claimHash: await fingerprint(claimed) })).toBe(true);
    expect(await engine.insertTakePurge({ sourceId: 'flags-example', subject: 'people/alice-example', requestId: null, claimHash: await fingerprint(scoped) })).toBe(true);
    expect(await engine.readSourcePurgeFlags('flags-example')).toEqual({ facts: true, takes: true });
    // Another source with only a fact tombstone of its own reads {facts, no takes}; no other test's rows are relied on.
    await raw("INSERT INTO sources (id, name) VALUES ('flags-facts-only', 'flags-facts-only') ON CONFLICT DO NOTHING");
    expect(await engine.insertFactPurge({ sourceId: 'flags-facts-only', visibility: 'world', subject: '*', factHash: await fingerprint('Facts-only claim'), requestId: null, actor: 'owner', reason: null })).toBe(true);
    expect(await engine.readSourcePurgeFlags('flags-facts-only')).toEqual({ facts: true, takes: false });
    expect(await engine.readSourcePurgeFlags('no-such-source')).toEqual({ facts: false, takes: false });

    const takes = [
      { row_num: 1, claim: `  ${claimed.toUpperCase()}  ` }, { row_num: 2, claim: 'An incoming take nobody purged' },
      { row_num: 3, claim: scoped }, { row_num: 4, claim: claimed },
    ];
    const rows = async (subject: string | null, source = 'flags-example') => (await engine.listPurgedTakeRows(source, takes, subject)).sort();
    expect(await rows(null)).toEqual([1, 3, 4]);
    expect(await rows('people/alice-example')).toEqual([1, 3, 4]);
    expect(await rows('people/bob-example')).toEqual([1, 4]);
    expect(await rows(null, 'other')).toEqual([]);
    expect(await engine.listPurgedTakeRows('flags-example', [], null)).toEqual([]);
  });

  test('purgeCalibrationProfilesByWave counts a wave\'s profiles on a dry run and deletes them otherwise, leaving other waves', async () => {
    const profile = (waveVersion: string, over: Record<string, unknown> = {}) => ({
      sourceId: 'default', holder: 'wave-holder-example', totalResolved: 5, brier: 0.2, accuracy: 0.7, partialRate: 0.1, gradeCompletion: 1,
      domainScorecards: {}, patternStatements: ['pattern'], voiceGatePassed: true, voiceGateAttempts: 1, activeBiasTags: [], modelId: 'model-a',
      waveVersion, ...over,
    });
    await engine.insertCalibrationProfile(profile('v-wave-a', { totalResolved: 1 }));
    await engine.insertCalibrationProfile(profile('v-wave-a', { totalResolved: 2, sourceId: 'other' }));
    await engine.insertCalibrationProfile(profile('v-wave-a', { totalResolved: 3, holder: 'wave-holder-two' }));
    await engine.insertCalibrationProfile(profile('v-wave-b', { totalResolved: 4 }));
    const left = (wave: string) => raw<{ total_resolved: number }>('SELECT total_resolved FROM calibration_profiles WHERE wave_version = $1 ORDER BY total_resolved', [wave]);

    expect(await engine.purgeCalibrationProfilesByWave({ waveVersion: 'v-wave-a', dryRun: true })).toBe(3);
    expect(await left('v-wave-a')).toHaveLength(3);
    expect(await engine.purgeCalibrationProfilesByWave({ waveVersion: 'no-such-wave', dryRun: true })).toBe(0);

    expect(await engine.purgeCalibrationProfilesByWave({ waveVersion: 'v-wave-a', dryRun: false })).toBe(3);
    expect(await left('v-wave-a')).toEqual([]);
    expect(await left('v-wave-b')).toEqual([{ total_resolved: 4 }]);
    expect(await engine.purgeCalibrationProfilesByWave({ waveVersion: 'v-wave-a', dryRun: false })).toBe(0);
  });

  test('the purge writers run inside a transaction and commit or roll back with it', async () => {
    const claim = 'Alice-Example transactional purge claim';
    const hash = await fingerprint(claim);
    const { id } = await engine.insertFact({ fact: claim, entity_slug: 'people/alice-example', source: 'test:purge', visibility: 'world' }, { source_id: 'default' });
    await raw('UPDATE facts SET source_markdown_slug = $2 WHERE id = $1', [id, `people/${UNATTRIBUTED_MEMORY_SLUG}`]);
    const stored = () => raw<{ subject: string }>('SELECT subject FROM fact_purges WHERE fact_hash = $1', [hash]);

    await expect(engine.transaction(async (tx) => {
      await tx.insertHoldingPagePurges('default', 'world', hash, randomUUID(), 'owner', null, [id]);
      expect(await tx.countPurgeFingerprintResidue('default', hash, '*')).toEqual({ facts: 1, takes: 0 });
      throw new Error('abandon the purge');
    })).rejects.toThrow('abandon the purge');
    expect(await stored()).toEqual([]);

    await engine.transaction(async (tx) => {
      await tx.insertHoldingPagePurges('default', 'world', hash, randomUUID(), 'owner', null, [id]);
    });
    expect(await stored()).toEqual([{ subject: `people/${UNATTRIBUTED_MEMORY_SLUG}` }]);
  });
});
