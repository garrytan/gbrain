/**
 * The page, belief, trust and derivation BrainEngine members that land ahead of their callers (P-0b), run on PGLite.
 * Each test calls the members of one area and checks a real result: a returned value with its content, a row written
 * and read back through another member or a plain SELECT, a count that changes, or a lock held for the transaction.
 * Companion to engine-landing-members.test.ts (same setup and helpers, copied, not imported).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BeliefEventInsertRow } from '../src/core/engine-sql/belief-ledger.ts';
import { publishSegmentedPage, segmentText, stageGeneration, flipInput } from './helpers/page-body-fixtures.ts';

let engine: PGLiteEngine;
let incarnation: string;
let otherIncarnation: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('other', 'other') ON CONFLICT DO NOTHING");
  incarnation = (await engine.readSourceMembership('default'))!.incarnation;
  otherIncarnation = (await engine.readSourceMembership('other'))!.incarnation;
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

const page = (slug: string, text = `Body of ${slug}.`, extra: { frontmatter?: Record<string, unknown>; type?: string } = {}) =>
  engine.putPage(slug, { type: (extra.type ?? 'note') as 'note', title: slug, compiled_truth: text, ...(extra.frontmatter ? { frontmatter: extra.frontmatter } : {}) });

const raw = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => engine.executeRaw<T>(sql, params);

/** Inserts one fact row and returns its id. */
async function fact(text: string, opts: { entity?: string | null; visibility?: string; sourceId?: string; slug?: string | null; rowNum?: number | null; tier?: string } = {}): Promise<number> {
  const [row] = await raw<{ id: number | string }>(
    `INSERT INTO facts (source_id, entity_slug, fact, visibility, source, source_markdown_slug, row_num, trust_tier)
     VALUES ($1, $2, $3, $4, 'test', $5, $6, $7) RETURNING id`,
    [opts.sourceId ?? 'default', opts.entity ?? null, text, opts.visibility ?? 'private', opts.slug ?? null, opts.rowNum ?? null, 'unknown']);
  // The trust trigger stamps a new row 'unknown' and only lets a tier fall, so a lower tier is set after the insert.
  if (opts.tier && opts.tier !== 'unknown') await raw('UPDATE facts SET trust_tier = $2 WHERE id = $1', [row!.id, opts.tier]);
  return Number(row!.id);
}

const fingerprint = async (text: string) => (await raw<{ h: string }>('SELECT gbrain_fact_fingerprint($1) AS h', [text]))[0]!.h;

/** Admits one queued write request under its own counter keys; returns its journal id. */
async function admit(tag: string, slug = `notes/${tag}`): Promise<{ id: string }> {
  const keys = [`principal:local_cli:${tag}`, `brain:${tag}`];
  await engine.lockPersistenceCounters(keys);
  return engine.insertWriteRequest({
    principalKind: 'local_cli', principalId: tag, requestId: randomUUID(), operation: 'remember', sourceId: 'default',
    sourceIncarnation: incarnation, pageId: null, slug, worktreeId: null,
    topologyGeneration: null, digest: 'd'.repeat(64), intent: { kind: 'remember', text: 'hello' }, authority: { scopes: ['write'] },
    intentBytes: 100, terminalReservation: 8192, targetKind: 'page', protocolVersion: 1, admitterVersion: 'landing',
    admitterHostId: null, counterKeys: keys, clientRequestId: null, state: 'queued', deferredRefreshId: null,
  });
}

let eventSeq = 0;
/** A belief event row as the append builds it; every field has a default, so a test names only what it checks. */
function beliefRow(over: Partial<BeliefEventInsertRow> = {}): BeliefEventInsertRow {
  eventSeq += 1;
  const seqHex = eventSeq.toString(16).padStart(8, '0');
  return {
    event_key: seqHex, source_id: 'default', source_incarnation: incarnation, page_lifetime: null, slug: 'belief/default',
    subject_kind: 'page', subject_key: 'belief/default', event_type: 'created', origin: 'live', trust_tier: 'unknown', writer_tier: null, tier_basis: 'row',
    visibility: 'private', publication_id: randomUUID(), ord: 0, source_time: null, valid_from: null, valid_until: null, value: JSON.stringify({ n: eventSeq }),
    value_hash: null, prior_hash: null, state_hash: 'state', cause: '{}', claim_fp: null, purged: false, redacted_fields: null, ...over,
  };
}

describe('fact purge: scope, derivation and tombstone reads', () => {
  test('countFactFingerprintLeftovers counts the copies of a claim outside the purge scope, not the copies inside it', async () => {
    const claim = 'Acme-example closed its seed round in March';
    await fact(claim, { entity: 'people/alice-example', visibility: 'private' });
    await fact(claim, { entity: 'people/alice-example', visibility: 'world' });
    await fact(claim, { entity: 'companies/acme-example', visibility: 'private' });
    await fact(claim, { entity: 'people/alice-example', visibility: 'private', sourceId: 'other' });
    await fact('An unrelated claim about nothing', { entity: 'people/alice-example', visibility: 'private' });
    const hash = await fingerprint(claim);
    expect(await engine.countFactFingerprintLeftovers('default', hash, 'private', 'people/alice-example')).toBe(2);
    expect(await engine.countFactFingerprintLeftovers('default', hash, 'private', '*')).toBe(1);
    expect(await engine.countFactFingerprintLeftovers('default', hash, 'world', '*')).toBe(2);
    expect(await engine.countFactFingerprintLeftovers('other', hash, 'private', '*')).toBe(0);
    expect(await engine.countFactFingerprintLeftovers('default', await fingerprint('never stored'), 'private', '*')).toBe(0);
  });

  test('countLegacyDerivedPages counts live atom and dream pages no derivation edge explains, and falls as an edge or a delete lands', async () => {
    expect(await engine.countLegacyDerivedPages('default')).toBe(0);
    const atom = await page('derived/atom-a', 'An atom.', { type: 'atom' });
    const dream = await page('derived/dream-a', 'A dream.', { frontmatter: { dream_generated: 'true' } });
    await page('derived/plain', 'A plain note.');
    expect(await engine.countLegacyDerivedPages('default')).toBe(2);
    expect(await engine.countLegacyDerivedPages('other')).toBe(0);
    await raw("INSERT INTO derivation_inputs (derived_table, derived_id, input_table, input_id, source_id) VALUES ('pages', $1, 'facts', '1', 'default')", [String(atom.id)]);
    expect(await engine.countLegacyDerivedPages('default')).toBe(1);
    await raw('UPDATE pages SET deleted_at = now() WHERE id = $1', [dream.id]);
    expect(await engine.countLegacyDerivedPages('default')).toBe(0);
  });

  test('listDerivedRows lists the rows derived from the frontier, distinct, in table and id order, within the limit', async () => {
    const edge = (derivedTable: string, derivedId: string, inputTable: string, inputId: string) => raw(
      'INSERT INTO derivation_inputs (derived_table, derived_id, input_table, input_id, source_id) VALUES ($1, $2, $3, $4, $5)',
      [derivedTable, derivedId, inputTable, inputId, 'default']);
    await edge('takes', '9', 'facts', '501');
    await edge('facts', '502', 'facts', '501');
    await edge('facts', '502', 'pages', '77');
    await edge('pages', '600', 'facts', '999');
    expect(await engine.listDerivedRows([{ table: 'facts', id: '501' }, { table: 'pages', id: '77' }], 10)).toEqual([
      { derived_table: 'facts', derived_id: '502' }, { derived_table: 'takes', derived_id: '9' },
    ]);
    expect(await engine.listDerivedRows([{ table: 'facts', id: '501' }], 1)).toEqual([{ derived_table: 'facts', derived_id: '502' }]);
    expect(await engine.listDerivedRows([{ table: 'facts', id: 'nope' }], 10)).toEqual([]);
    expect(await engine.listDerivedRows([], 10)).toEqual([]);
  });

  test('listPageChangeReasons returns each reason a page version or a request of the slug recorded, once', async () => {
    const owner = await page('purges/reasons');
    await raw(
      `INSERT INTO page_versions (page_id, compiled_truth, change_reason) VALUES ($1, 'v1', 'fixed a typo'), ($1, 'v2', 'fixed a typo'), ($1, 'v3', 'added the Acme-example detail')`,
      [owner.id]);
    const { id } = await admit('reasons', 'purges/reasons');
    await raw("UPDATE persistence_requests SET intent = intent || '{\"reason\":\"asked by alice-example\"}'::jsonb WHERE id = $1::uuid", [id]);
    const reasons = (await engine.listPageChangeReasons('default', 'purges/reasons', owner.id)).map((r) => r.reason);
    expect(reasons.filter((r) => r !== null).sort()).toEqual(['added the Acme-example detail', 'asked by alice-example', 'fixed a typo']);
    expect(reasons).toHaveLength(4); // the request's absent outcome reason is the one null row
    expect(await engine.listPageChangeReasons('other', 'purges/reasons', owner.id + 100_000)).toEqual([]);
  });

  test('redactVersionChangeReasons overwrites the reasons that quote the claim with [purged] and returns exactly those version ids', async () => {
    const owner = await page('purges/redact');
    const ids = await raw<{ id: number }>(
      `INSERT INTO page_versions (page_id, compiled_truth, change_reason) VALUES
         ($1, 'a', 'Mentioned the SECRET claim here'), ($1, 'b', 'unrelated edit'), ($1, 'c', 'the folded-reason claim appears') RETURNING id`, [owner.id]);
    const [quoted, , folded] = ids.map((r) => Number(r.id));
    const redacted = await engine.redactVersionChangeReasons('default', 'secret claim', 'folded-reason claim');
    expect(redacted.sort((a, b) => a - b)).toEqual([quoted!, folded!]);
    const after = await raw<{ id: number; change_reason: string }>('SELECT id, change_reason FROM page_versions WHERE page_id = $1 ORDER BY id', [owner.id]);
    expect(after.map((r) => r.change_reason)).toEqual(['[purged]', 'unrelated edit', '[purged]']);
    expect(await engine.redactVersionChangeReasons('default', 'secret claim', 'folded-reason claim')).toEqual([]);
    expect(await engine.redactVersionChangeReasons('other', 'unrelated edit', 'unrelated edit')).toEqual([]);
  });

  test('listPageGitEffectsForStrip lists the git effects of one slug that carry a commit line or trailers, locked, in id order', async () => {
    const effect = async (tag: string, kind: string, data: Record<string, unknown>) => {
      const { id } = await admit(`git-strip-${tag}`, 'purges/git-strip');
      await engine.insertPublicationEffects({ requestId: id, revision: null, sourceId: 'default', sourceIncarnation: incarnation, worktreeId: null, effects: [{ kind, data }] as never });
      return (await raw<{ request_id: string }>('SELECT request_id::text AS request_id FROM persistence_requests WHERE id = $1::uuid', [id]))[0]!.request_id;
    };
    const lineRequest = await effect('line', 'git', { slug: 'purges/git-strip', commit_line: 'edit page' });
    const trailerRequest = await effect('trailer', 'git', { slug: 'purges/git-strip', commit_trailers: ['Reason: x'] });
    await effect('plain', 'git', { slug: 'purges/git-strip' });
    await effect('other-slug', 'git', { slug: 'purges/elsewhere', commit_line: 'other page' });
    await effect('links', 'links', { slug: 'purges/git-strip', commit_line: 'not git' });
    const rows = await engine.transaction((tx) => tx.listPageGitEffectsForStrip('default', 'purges/git-strip'));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.data)).toEqual([{ slug: 'purges/git-strip', commit_line: 'edit page' }, { slug: 'purges/git-strip', commit_trailers: ['Reason: x'] }]);
    expect(rows.map((r) => r.request_id)).toEqual([lineRequest, trailerRequest]);
    expect(rows.every((r) => r.state === 'queued')).toBe(true);
    expect(await engine.listPageGitEffectsForStrip('other', 'purges/git-strip')).toEqual([]);
  });

  test('listRequestsHoldingStagings lists the unfinished requests that publish one of the staging ids, in sequence order', async () => {
    const first = await admit('hold-staging-1');
    const second = await admit('hold-staging-2');
    const done = await admit('hold-staging-3');
    const stagingA = randomUUID();
    const stagingB = randomUUID();
    await raw("UPDATE persistence_requests SET intent = jsonb_build_object('body_ref', jsonb_build_object('staging_id', $2::text)) WHERE id = $1::uuid", [first.id, stagingA]);
    await raw("UPDATE persistence_requests SET intent = jsonb_build_object('body_ref', jsonb_build_object('staging_id', $2::text)) WHERE id = $1::uuid", [second.id, stagingB]);
    await raw("UPDATE persistence_requests SET intent = jsonb_build_object('body_ref', jsonb_build_object('staging_id', $2::text)), state = 'committed' WHERE id = $1::uuid", [done.id, stagingA]);
    expect(await engine.listRequestsHoldingStagings('default', [stagingA])).toEqual([{ id: first.id, principal_kind: 'local_cli', principal_id: 'hold-staging-1' }]);
    expect((await engine.listRequestsHoldingStagings('default', [stagingB, stagingA])).map((r) => r.id)).toEqual([first.id, second.id]);
    expect(await engine.listRequestsHoldingStagings('other', [stagingA])).toEqual([]);
    expect(await engine.listRequestsHoldingStagings('default', [])).toEqual([]);
  });

  test('listPageProseHits returns the sorted slugs of live pages whose text in a store states a needle, and skips deleted pages', async () => {
    await page('prose/zeta', 'Zeta mentions the quokka-needle once.');
    await page('prose/alpha', 'Alpha also mentions the QUOKKA-NEEDLE.');
    const gone = await page('prose/gone', 'Gone mentions the quokka-needle too.');
    await page('prose/none', 'Nothing relevant here.');
    await raw('UPDATE pages SET deleted_at = now() WHERE id = $1', [gone.id]);
    expect(await engine.listPageProseHits('pages', 'default', ['quokka-needle'])).toEqual([{ slug: 'prose/alpha' }, { slug: 'prose/zeta' }]);
    expect(await engine.listPageProseHits('pages', 'default', ['no-such-needle'])).toEqual([]);
    expect(await engine.listPageProseHits('pages', 'other', ['quokka-needle'])).toEqual([]);

    const alpha = (await raw<{ id: number }>("SELECT id FROM pages WHERE slug = 'prose/alpha'"))[0]!;
    await raw("INSERT INTO page_versions (page_id, compiled_truth, timeline) VALUES ($1, 'old', 'the wallaby-needle was here')", [alpha.id]);
    await raw("INSERT INTO timeline_entries (page_id, date, summary, detail) VALUES ($1, '2026-01-02', 'Met the ocelot-needle', '')", [alpha.id]);
    await raw("INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source) VALUES ($1, 0, 'a chunk with the lynx-needle', 'compiled_truth')", [alpha.id]);
    expect(await engine.listPageProseHits('page_versions', 'default', ['wallaby-needle'])).toEqual([{ slug: 'prose/alpha' }]);
    expect(await engine.listPageProseHits('timeline_entries', 'default', ['ocelot-needle'])).toEqual([{ slug: 'prose/alpha' }]);
    expect(await engine.listPageProseHits('content_chunks', 'default', ['lynx-needle'])).toEqual([{ slug: 'prose/alpha' }]);
    expect(await engine.listPageProseHits('content_chunks', 'default', ['wallaby-needle'])).toEqual([]);
  });
});

describe('fact purge: derived row writers', () => {
  test('expireDerivedFacts expires the listed facts of the source once, and keeps an earlier expiry time', async () => {
    const [a, b, otherSource] = [await fact('derived fact a'), await fact('derived fact b'), await fact('derived fact c', { sourceId: 'other' })];
    expect(await engine.expireDerivedFacts([a, otherSource], 'default')).toBe(1);
    const state = () => raw<{ id: number; expired_at: Date | null }>('SELECT id, expired_at FROM facts WHERE id = ANY($1::bigint[]) ORDER BY id', [[a, b, otherSource]]);
    const first = await state();
    expect(first.map((r) => r.expired_at !== null)).toEqual([true, false, false]);
    expect(await engine.expireDerivedFacts([a], 'default')).toBe(1);
    expect(new Date((await state())[0]!.expired_at!).getTime()).toBe(new Date(first[0]!.expired_at!).getTime());
    expect(await engine.expireDerivedFacts([], 'default')).toBe(0);
  });

  test('deactivateDerivedTakes deactivates the listed takes on pages of the source and says how many', async () => {
    const owner = await page('derived/takes-owner');
    await engine.addTakesBatch([
      { page_id: owner.id, row_num: 1, claim: 'Take one', kind: 'take', holder: 'brain' },
      { page_id: owner.id, row_num: 2, claim: 'Take two', kind: 'take', holder: 'brain' },
    ]);
    const ids = (await raw<{ id: number }>('SELECT id FROM takes WHERE page_id = $1 ORDER BY row_num', [owner.id])).map((r) => Number(r.id));
    expect(await engine.deactivateDerivedTakes([ids[0]!], 'other')).toBe(0);
    expect(await engine.deactivateDerivedTakes([ids[0]!], 'default')).toBe(1);
    expect((await raw<{ active: boolean }>('SELECT active FROM takes WHERE page_id = $1 ORDER BY row_num', [owner.id])).map((r) => r.active)).toEqual([false, true]);
  });

  test('softDeleteDerivedPages hides live pages of the source now, reports one already hidden as not now, and ignores another source', async () => {
    const [a, b] = [await page('derived/soft-a'), await page('derived/soft-b')];
    await raw('UPDATE pages SET deleted_at = now() - interval \'1 day\' WHERE id = $1', [b.id]);
    const before = (await raw<{ deleted_at: Date }>('SELECT deleted_at FROM pages WHERE id = $1', [b.id]))[0]!.deleted_at;
    expect(await engine.softDeleteDerivedPages([a.id, b.id], 'other')).toEqual([]);
    const result = await engine.softDeleteDerivedPages([a.id, b.id], 'default');
    expect(result.map((r) => [Number(r.id), r.now]).sort()).toEqual([[a.id, true], [b.id, false]].sort());
    const after = await raw<{ id: number; deleted_at: Date | null }>('SELECT id, deleted_at FROM pages WHERE id = ANY($1::int[]) ORDER BY id', [[a.id, b.id]]);
    expect(after[0]!.deleted_at).not.toBeNull();
    expect(new Date(after[1]!.deleted_at!).getTime()).toBe(new Date(before).getTime());
  });

  test('markNeedsRederive writes one row per derived id, a later mark replaces the reason, and pageAwaitsRederive reads it back', async () => {
    const [hidden, kept] = [await page('derived/rederive-hidden'), await page('derived/rederive-kept')];
    await engine.softDeleteDerivedPages([hidden.id], 'default');
    const requestId = randomUUID();
    await engine.markNeedsRederive('pages', [String(hidden.id), String(kept.id)], 'default', requestId, 'purge: first', [String(hidden.id)]);
    const marks = () => raw<{ derived_id: string; reason: string; request_id: string | null; marked_at: Date }>(
      "SELECT derived_id, reason, request_id::text AS request_id, marked_at FROM needs_rederive WHERE derived_table = 'pages' AND derived_id = ANY($1::text[]) ORDER BY derived_id::int", [[String(hidden.id), String(kept.id)]]);
    const first = await marks();
    expect(first.map((m) => [m.derived_id, m.reason, m.request_id])).toEqual([[String(hidden.id), 'purge: first', requestId], [String(kept.id), 'purge: first', requestId]]);
    const hiddenAt = (await raw<{ deleted_at: Date }>('SELECT deleted_at FROM pages WHERE id = $1', [hidden.id]))[0]!.deleted_at;
    expect(new Date(first[0]!.marked_at).getTime()).toBe(new Date(hiddenAt).getTime());

    await engine.markNeedsRederive('pages', [String(hidden.id), String(kept.id)], 'default', null, 'purge: second', []);
    const second = await marks();
    expect(second.map((m) => [m.reason, m.request_id])).toEqual([['purge: second', null], ['purge: second', null]]);
    expect(new Date(second[0]!.marked_at).getTime()).toBe(new Date(hiddenAt).getTime()); // the hidden moment is kept
    expect(new Date(second[1]!.marked_at).getTime()).toBeGreaterThanOrEqual(new Date(first[1]!.marked_at).getTime()); // any other mark is stamped now

    expect(await engine.pageAwaitsRederive(kept.id)).toBe(true);
    const clear = await page('derived/rederive-clear');
    expect(await engine.pageAwaitsRederive(clear.id)).toBe(false);
    expect(await engine.pageAwaitsRederive(clear.id + 100_000)).toBe(false);
  });
});

describe('segmented page storage', () => {
  test('listSegmentedPageBodies lists the live segmented pages of the source in id order, within the limit', async () => {
    const [first, second] = [
      await publishSegmentedPage(engine, 'segmented/list-a', [segmentText('# A\nfirst\n')]),
      await publishSegmentedPage(engine, 'segmented/list-b', [segmentText('# B\nsecond\n')]),
    ];
    await page('segmented/list-inline');
    const gone = await publishSegmentedPage(engine, 'segmented/list-gone', [segmentText('# Gone\n')]);
    await raw('UPDATE pages SET deleted_at = now() WHERE id = $1', [gone.pageId]);
    expect(await engine.listSegmentedPageBodies('default', 10)).toEqual([
      { page_id: first.pageId, slug: 'segmented/list-a', generation: null, version_id: null },
      { page_id: second.pageId, slug: 'segmented/list-b', generation: null, version_id: null },
    ]);
    expect((await engine.listSegmentedPageBodies('default', 1)).map((r) => r.slug)).toEqual(['segmented/list-a']);
    expect(await engine.listSegmentedPageBodies('other', 10)).toEqual([]);
  });

  test('listSegmentedVersionBodies lists the retained segmented versions with their generation, in id order, within the limit', async () => {
    const published = await publishSegmentedPage(engine, 'segmented/versions', [segmentText('# V\nfirst body\n')]);
    const inserted = await raw<{ id: number }>(
      `INSERT INTO page_versions (page_id, body_storage, body_generation) VALUES ($1, 'segmented', 1), ($1, 'segmented', 2) RETURNING id`, [published.pageId]);
    const ids = inserted.map((r) => Number(r.id)).sort((a, b) => a - b);
    await raw("INSERT INTO page_versions (page_id, compiled_truth) VALUES ($1, 'inline version')", [published.pageId]);
    const rows = (await engine.listSegmentedVersionBodies('default', 100)).filter((r) => r.page_id === published.pageId);
    expect(rows).toEqual([
      { page_id: published.pageId, slug: 'segmented/versions', generation: 1, version_id: ids[0]! },
      { page_id: published.pageId, slug: 'segmented/versions', generation: 2, version_id: ids[1]! },
    ].map((r) => ({ ...r, generation: Number(r.generation), version_id: Number(r.version_id) })));
    expect(await engine.listSegmentedVersionBodies('default', 1)).toHaveLength(1);
    expect(await engine.listSegmentedVersionBodies('other', 100)).toEqual([]);
  });

  test('deletePageViewDigests deletes the cached read-view digests of the listed pages only', async () => {
    const [a, b] = [await page('digests/a'), await page('digests/b')];
    for (const p of [a, a, b]) {
      await raw(
        `INSERT INTO page_view_digests (page_id, revision, view, audience, total_bytes, total_lines) VALUES ($1, $2, 'markdown', 'remote', 10, 1)`,
        [p.id, randomUUID()]);
    }
    const count = (id: number) => raw<{ n: number }>('SELECT count(*)::int AS n FROM page_view_digests WHERE page_id = $1', [id]).then((r) => r[0]!.n);
    expect([await count(a.id), await count(b.id)]).toEqual([2, 1]);
    await engine.deletePageViewDigests([a.id]);
    expect([await count(a.id), await count(b.id)]).toEqual([0, 1]);
    await engine.deletePageViewDigests([]);
    expect(await count(b.id)).toBe(1);
  });

  test('storeSegmentDerivationsIfLive stores done rows only while the page is segmented at the generation, and deleteRewrittenSegmentDerivations removes the touched ones', async () => {
    const published = await publishSegmentedPage(engine, 'segmented/derive', [segmentText('# D\nbody\n')]);
    const row = (pipeline: string, occurrenceId: number, out: unknown) => ({
      pipeline, occurrence_id: occurrenceId, pipeline_version: 1, segment_sha256: 'ab'.repeat(32), context_hash: 'cd'.repeat(32), output: out,
    });
    const stored = () => raw<{ pipeline: string; occurrence_id: number; state: string; output: unknown; seg: string }>(
      "SELECT pipeline, occurrence_id::int AS occurrence_id, state, output, encode(segment_sha256, 'hex') AS seg FROM page_segment_derivations WHERE page_id = $1 ORDER BY pipeline, occurrence_id", [published.pageId]);

    expect(await engine.storeSegmentDerivationsIfLive(published.pageId, 99, [row('links', 1, { a: 1 })])).toBe(0);
    expect(await stored()).toEqual([]);
    const inline = await page('segmented/derive-inline');
    expect(await engine.storeSegmentDerivationsIfLive(inline.id, 1, [row('links', 1, { a: 1 })])).toBe(0);

    const rows = [row('links', 1, { a: 1 }), row('links', 2, { a: 2 }), row('mentions', 1, { m: 1 }), row('mentions', 3, { m: 3 })];
    expect(await engine.storeSegmentDerivationsIfLive(published.pageId, 1, rows)).toBe(4);
    expect((await stored()).map((r) => [r.pipeline, r.occurrence_id, r.state, r.seg])).toEqual([
      ['links', 1, 'done', 'ab'.repeat(32)], ['links', 2, 'done', 'ab'.repeat(32)], ['mentions', 1, 'done', 'ab'.repeat(32)], ['mentions', 3, 'done', 'ab'.repeat(32)],
    ]);
    expect(await engine.storeSegmentDerivationsIfLive(published.pageId, 1, [row('links', 1, { a: 'updated' })])).toBe(1);
    expect((await stored())[0]!.output).toEqual({ a: 'updated' });
    expect(await engine.storeSegmentDerivationsIfLive(published.pageId, 1, [])).toBe(0);

    const deleted = await engine.deleteRewrittenSegmentDerivations({
      pageId: published.pageId, touchedOccurrenceIds: [1], linkReachOccurrenceIds: [2], pipelines: ['mentions'], liveOccurrenceIds: [1],
    });
    expect(deleted).toBe(4);
    expect((await stored()).map((r) => [r.pipeline, r.occurrence_id])).toEqual([]);
    expect(await engine.deleteRewrittenSegmentDerivations({
      pageId: published.pageId, touchedOccurrenceIds: [1], linkReachOccurrenceIds: [], pipelines: [], liveOccurrenceIds: [],
    })).toBe(0);
  });

  test('readLiveStoredBody reads the stored body of a live page, with or without the row lock, and nothing for a deleted or missing page', async () => {
    const owner = await engine.putPage('stored/body', { type: 'note', title: 'Body', compiled_truth: 'The truth.', timeline: '- 2026-01-02: an event' });
    expect(await engine.readLiveStoredBody('default', 'stored/body')).toEqual({ compiled_truth: 'The truth.', timeline: '- 2026-01-02: an event' });
    expect(await engine.transaction((tx) => tx.readLiveStoredBody('default', 'stored/body', true))).toEqual({ compiled_truth: 'The truth.', timeline: '- 2026-01-02: an event' });
    expect(await engine.readLiveStoredBody('other', 'stored/body')).toBeNull();
    await raw('UPDATE pages SET deleted_at = now() WHERE id = $1', [owner.id]);
    expect(await engine.readLiveStoredBody('default', 'stored/body')).toBeNull();
  });
});

describe('page origin and import seal', () => {
  test('readPageOrigin reads a page by id or by slug, live or deleted, and nothing without a target or for another source', async () => {
    const owner = await page('origin/page');
    await raw("UPDATE pages SET source_path = 'origin/page.md' WHERE id = $1", [owner.id]);
    const expected = { id: owner.id, slug: 'origin/page', source_path: 'origin/page.md', deleted_at: null };
    expect(await engine.readPageOrigin({ sourceId: 'default', pageId: owner.id })).toEqual(expected);
    expect(await engine.readPageOrigin({ sourceId: 'default', slug: 'origin/page' })).toEqual(expected);
    expect(await engine.readPageOrigin({ sourceId: 'other', pageId: owner.id })).toBeNull();
    expect(await engine.readPageOrigin({ sourceId: 'default' })).toBeNull();
    await raw('UPDATE pages SET deleted_at = now() WHERE id = $1', [owner.id]);
    const gone = await engine.readPageOrigin({ sourceId: 'default', slug: 'origin/page' });
    expect(gone).toMatchObject({ id: owner.id, source_path: 'origin/page.md' });
    expect(gone!.deleted_at).not.toBeNull();
  });

  test('sealImportedPage stamps the chunker version, seals the projection only at the current revision, and answers null for an unknown page', async () => {
    const type = 'sealprobe';
    const stale = await page('seal/stale', 'Stale seal body.', { type });
    const current = await page('seal/current', 'Current seal body.', { type });
    await raw('UPDATE pages SET chunker_version = 1 WHERE id = ANY($1::int[])', [[stale.id, current.id]]);
    expect(await engine.hasUnsealedPages({ sourceId: 'default', types: [type] })).toBe(true);
    const revisions = async (id: number) => (await raw<{ rev: string; sealed: string | null; v: number }>(
      'SELECT knowledge_revision::text AS rev, text_projection_revision::text AS sealed, chunker_version AS v FROM pages WHERE id = $1', [id]))[0]!;
    const [staleBefore, currentBefore] = [await revisions(stale.id), await revisions(current.id)];

    expect(await engine.sealImportedPage('seal/stale', { sourceId: 'default', revision: randomUUID(), timelineText: 'wombat words', chunkerVersion: 4 })).toEqual({ id: stale.id });
    expect(await revisions(stale.id)).toEqual({ rev: staleBefore.rev, sealed: staleBefore.sealed, v: 4 });
    expect(await engine.sealImportedPage('seal/current', { sourceId: 'default', revision: currentBefore.rev, timelineText: 'wombat words', chunkerVersion: 4 })).toEqual({ id: current.id });
    expect(await revisions(current.id)).toEqual({ rev: currentBefore.rev, sealed: currentBefore.rev, v: 4 });
    const vectorHas = async (id: number) => (await raw<{ hit: boolean }>("SELECT search_vector::text LIKE '%''wombat''%' AS hit FROM pages WHERE id = $1", [id]))[0]!.hit;
    expect(await vectorHas(current.id)).toBe(true);
    expect(await vectorHas(stale.id)).toBe(false);
    expect(await engine.sealImportedPage('seal/missing', { sourceId: 'default', revision: null, timelineText: '', chunkerVersion: 4 })).toBeNull();
    expect(await engine.sealImportedPage('seal/current', { sourceId: 'other', revision: null, timelineText: '', chunkerVersion: 4 })).toBeNull();
  });

  test('hasUnsealedPages is true while a live page in scope is below the safe chunker version, and false once sealed, deleted or out of scope', async () => {
    const type = 'unsealed-probe';
    expect(await engine.hasUnsealedPages({ sourceId: 'default', types: [type] })).toBe(false);
    const owner = await page('unsealed/page', 'Unsealed body.', { type });
    await raw('UPDATE pages SET chunker_version = 1 WHERE id = $1', [owner.id]);
    expect(await engine.hasUnsealedPages({ sourceId: 'default', types: [type] })).toBe(true);
    expect(await engine.hasUnsealedPages({ types: [type] })).toBe(true);
    expect(await engine.hasUnsealedPages({ sourceId: 'other', types: [type] })).toBe(false);
    expect(await engine.hasUnsealedPages({ sourceIds: [], types: [type] })).toBe(false);
    expect(await engine.hasUnsealedPages({ sourceId: 'default', types: [type], excludeSlugPrefixes: ['unsealed/'] })).toBe(false);
    await raw('UPDATE pages SET chunker_version = 4 WHERE id = $1', [owner.id]);
    expect(await engine.hasUnsealedPages({ sourceId: 'default', types: [type] })).toBe(false);
    await raw('UPDATE pages SET chunker_version = 1, deleted_at = now() WHERE id = $1', [owner.id]);
    expect(await engine.hasUnsealedPages({ sourceId: 'default', types: [type] })).toBe(false);
  });
});

describe('belief ledger', () => {
  test('insertBeliefEvents appends rows in ord order, skips a recorded event key, and hasBeliefEvents turns true for that source only', async () => {
    expect(await engine.hasBeliefEvents('other')).toBe(false);
    expect(await engine.hasBeliefEvents('default')).toBe(false);
    const rows = [
      beliefRow({ source_id: 'other', source_incarnation: otherIncarnation, slug: 'belief/other', subject_key: 'k-second', ord: 1, event_type: 'updated' }),
      beliefRow({ source_id: 'other', source_incarnation: otherIncarnation, slug: 'belief/other', subject_key: 'k-first', ord: 0, writer_tier: 'agent_written', tier_basis: 'writer' }),
      beliefRow({ source_id: 'other', source_incarnation: otherIncarnation, slug: 'belief/other', subject_key: 'k-third', ord: 2, purged: true, redacted_fields: ['value'], value: null }),
    ];
    expect(await engine.insertBeliefEvents(rows)).toBe(3);
    expect(await engine.insertBeliefEvents(rows)).toBe(0);
    expect(await engine.insertBeliefEvents([])).toBe(0);
    const stored = await raw<{ subject_key: string; ord: number; event_type: string; writer_tier: string | null; tier_basis: string; purged: boolean; redacted_fields: string[] | null; value: unknown; ek: string }>(
      "SELECT subject_key, ord, event_type, writer_tier, tier_basis, purged, redacted_fields, value, encode(event_key, 'hex') AS ek FROM belief_events WHERE source_id = 'other' ORDER BY id");
    expect(stored.map((r) => [r.subject_key, r.ord])).toEqual([['k-first', 0], ['k-second', 1], ['k-third', 2]]);
    expect(stored[0]).toMatchObject({ event_type: 'created', writer_tier: 'agent_written', tier_basis: 'writer', purged: false, ek: rows[1]!.event_key });
    expect(stored[1]).toMatchObject({ event_type: 'updated' });
    expect(stored[2]).toMatchObject({ purged: true, redacted_fields: ['value'], value: null });
    expect(await engine.hasBeliefEvents('other')).toBe(true);
    expect(await engine.hasBeliefEvents('default')).toBe(false);
    expect(await engine.hasBeliefEvents('no-such-source')).toBe(false);
  });

  test('readOpenBeliefLifetimes reads the open lifetime of each pair, endBeliefLifetime closes it once, and listVisibleBeliefLifetimes keeps only live open lifetimes of visible pages', async () => {
    const live = await page('belief/life-live');
    const deleted = await page('belief/life-deleted');
    await raw('UPDATE pages SET deleted_at = now() WHERE id = $1', [deleted.id]);
    const [lifeLive, lifeDeleted, lifeNoPage, lifeEnded] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const open = (lifetime: string, slug: string, pageId: number | null, ended = false) => raw(
      `INSERT INTO belief_page_lifetimes (page_lifetime, source_id, source_incarnation, slug, page_id, ended_at)
       VALUES ($1::uuid, 'default', $2::uuid, $3, $4, ${ended ? 'now()' : 'NULL'})`, [lifetime, incarnation, slug, pageId]);
    await open(lifeLive, 'belief/life-live', live.id);
    await open(lifeDeleted, 'belief/life-deleted', deleted.id);
    await open(lifeNoPage, 'belief/life-nopage', null);
    await open(lifeEnded, 'belief/life-ended', null, true);

    const pairs = ['belief/life-live', 'belief/life-deleted', 'belief/life-nopage', 'belief/life-ended', 'belief/life-unknown'].map((slug) => ({ incarnation, slug }));
    const opened = await engine.readOpenBeliefLifetimes(pairs);
    expect(opened.map((r) => [r.slug, r.page_lifetime, r.page_id]).sort()).toEqual([
      ['belief/life-deleted', lifeDeleted, deleted.id], ['belief/life-live', lifeLive, live.id], ['belief/life-nopage', lifeNoPage, null],
    ].sort());
    expect(opened.every((r) => r.source_incarnation === incarnation)).toBe(true);
    expect(await engine.readOpenBeliefLifetimes([{ incarnation: otherIncarnation, slug: 'belief/life-live' }])).toEqual([]);
    expect(await engine.readOpenBeliefLifetimes([])).toEqual([]);

    expect(await engine.listVisibleBeliefLifetimes([lifeLive, lifeDeleted, lifeNoPage, lifeEnded])).toEqual([lifeLive]);
    await engine.endBeliefLifetime(lifeLive);
    const ended = await raw<{ ended_at: Date | null }>('SELECT ended_at FROM belief_page_lifetimes WHERE page_lifetime = $1::uuid', [lifeLive]);
    expect(ended[0]!.ended_at).not.toBeNull();
    expect((await engine.readOpenBeliefLifetimes([{ incarnation, slug: 'belief/life-live' }]))).toEqual([]);
    expect(await engine.listVisibleBeliefLifetimes([lifeLive])).toEqual([]);
    await engine.endBeliefLifetime(lifeLive);
    expect((await raw<{ ended_at: Date }>('SELECT ended_at FROM belief_page_lifetimes WHERE page_lifetime = $1::uuid', [lifeLive]))[0]!.ended_at.getTime()).toBe(new Date(ended[0]!.ended_at!).getTime());
    await engine.endBeliefLifetime(randomUUID());
  });

  test('readBeliefHistoryRows pages the source events by id with the filters, hides events a later derived.hidden covers, and marks a visible stream', async () => {
    const owner = await page('belief/history');
    const lifetime = randomUUID();
    await raw(`INSERT INTO belief_page_lifetimes (page_lifetime, source_id, source_incarnation, slug, page_id) VALUES ($1::uuid, 'default', $2::uuid, 'belief/history', $3)`, [lifetime, incarnation, owner.id]);
    const base = { slug: 'belief/history', page_lifetime: lifetime };
    await engine.insertBeliefEvents([
      beliefRow({ ...base, subject_key: 'belief/history', event_type: 'created', ord: 0 }),
      beliefRow({ ...base, subject_kind: 'fact', subject_key: 'fact:1', event_type: 'created', ord: 1, claim_fp: 'fp-claim', visibility: 'world' }),
      beliefRow({ ...base, subject_kind: 'fact', subject_key: 'fact:1', event_type: 'updated', ord: 2, claim_fp: 'fp-claim', visibility: 'private' }),
      beliefRow({ ...base, subject_kind: 'take', subject_key: 'take:1', event_type: 'created', ord: 3, value: JSON.stringify({ holder: 'alice-example' }) }),
      beliefRow({ ...base, subject_kind: 'fact', subject_key: 'fact:hidden', event_type: 'created', ord: 4 }),
      beliefRow({ ...base, subject_kind: 'fact', subject_key: 'fact:hidden', event_type: 'derived.hidden', ord: 5 }),
    ]);
    const query = { sourceId: 'default', slug: null, subjectKey: null, afterId: 0, limit: 100, recordedAfter: null, recordedUntil: null, subjectKeys: null, beforeId: null, descending: false };
    const all = await engine.readBeliefHistoryRows(query);
    const label = (r: Record<string, unknown>) => `${r.subject_key}:${r.event_type}`;
    expect(all.map(label)).toEqual(['belief/history:created', 'fact:1:created', 'fact:1:updated', 'take:1:created', 'fact:hidden:derived.hidden']);
    expect(all.every((r) => r.stream_visible === true)).toBe(true);
    expect(all.map((r) => [r.subject_key, r.event_type, r.later_private])).toContainEqual(['fact:1', 'created', true]);
    expect(all.map((r) => [r.subject_key, r.event_type, r.later_private])).toContainEqual(['fact:1', 'updated', false]);
    expect(all.find((r) => r.subject_key === 'take:1')).toMatchObject({ take_holder: 'alice-example', page_lifetime: lifetime });

    const ids = all.map((r) => Number(r.id));
    expect((await engine.readBeliefHistoryRows({ ...query, descending: true })).map(label)).toEqual([...all.map(label)].reverse());
    expect((await engine.readBeliefHistoryRows({ ...query, afterId: ids[1]!, limit: 2 })).map(label)).toEqual(['fact:1:updated', 'take:1:created']);
    expect((await engine.readBeliefHistoryRows({ ...query, beforeId: ids[2]! })).map(label)).toEqual(['belief/history:created', 'fact:1:created']);
    expect((await engine.readBeliefHistoryRows({ ...query, subjectKey: 'take:1' })).map(label)).toEqual(['take:1:created']);
    expect((await engine.readBeliefHistoryRows({ ...query, subjectKeys: ['fact:1', 'take:1'] })).map(label)).toEqual(['fact:1:created', 'fact:1:updated', 'take:1:created']);
    expect((await engine.readBeliefHistoryRows({ ...query, slug: 'belief/nowhere' }))).toEqual([]);
    expect((await engine.readBeliefHistoryRows({ ...query, recordedAfter: new Date(Date.now() + 3_600_000).toISOString() }))).toEqual([]);
    expect((await engine.readBeliefHistoryRows({ ...query, recordedUntil: new Date(Date.now() - 3_600_000).toISOString() }))).toEqual([]);
    // Its own second source and events, so the test does not read what another test left behind.
    await raw("INSERT INTO sources (id, name) VALUES ('history-other', 'history-other') ON CONFLICT DO NOTHING");
    const historyOtherIncarnation = (await engine.readSourceMembership('history-other'))!.incarnation;
    const otherBase = { source_id: 'history-other', source_incarnation: historyOtherIncarnation, slug: 'belief/history-other' };
    await engine.insertBeliefEvents([
      beliefRow({ ...otherBase, subject_key: 'k-second', ord: 1, event_type: 'updated' }),
      beliefRow({ ...otherBase, subject_key: 'k-first', ord: 0 }),
      beliefRow({ ...otherBase, subject_key: 'k-third', ord: 2 }),
    ]);
    expect((await engine.readBeliefHistoryRows({ ...query, sourceId: 'history-other' })).map((r) => r.subject_key)).toEqual(['k-first', 'k-second', 'k-third']);
    expect(await engine.readBeliefHistoryRows({ ...query, sourceId: 'no-such-source' })).toEqual([]);

    await engine.endBeliefLifetime(lifetime);
    expect((await engine.readBeliefHistoryRows(query)).every((r) => r.stream_visible === null)).toBe(true);
  });

  test('readBeliefFactsById reads fact rows by id with a fresh fingerprint, whatever the order, and nothing for no ids or an unknown id', async () => {
    const entity = await page('people/belief-entity');
    const a = await fact('Belief fact alpha', { entity: 'people/belief-entity', slug: 'belief/facts-page', rowNum: 1 });
    const b = await fact('Belief fact beta', { visibility: 'world' });
    const rows = await engine.readBeliefFactsById([b, a, a + 99_999]);
    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    expect(byId.get(a)).toMatchObject({ fact: 'Belief fact alpha', entity_slug: 'people/belief-entity', sms: 'belief/facts-page', entity_page_id: entity.id, fp: await fingerprint('Belief fact alpha') });
    expect(byId.get(b)).toMatchObject({ fact: 'Belief fact beta', entity_slug: null, sms: null, entity_page_id: null, fp: await fingerprint('Belief fact beta') });
    expect(await engine.readBeliefFactsById([])).toEqual([]);
  });
});

describe('trust scan and core pages', () => {
  const TIER = 'external_untrusted';
  const tiered = (table: string, ids: number[]) => raw(`UPDATE ${table} SET trust_tier = '${TIER}' WHERE id = ANY($1::bigint[])`, [ids]);

  test('listTrustScanRows and countUnscannedTrustRows read each scanned table above a cursor id, by id, for the listed tiers only', async () => {
    const [p1, p2, p3, pOther] = [await page('scan/p1'), await page('scan/p2'), await page('scan/p3'), await page('scan/p-untiered')];
    await tiered('pages', [p1.id, p2.id, p3.id]);
    await raw('UPDATE pages SET deleted_at = now() WHERE id = $1', [p3.id]);
    const [f1, f2] = [await fact('Scan fact one', { tier: TIER }), await fact('Scan fact two', { tier: TIER })];
    await fact('Scan fact untiered');
    await engine.addTakesBatch([{ page_id: p1.id, row_num: 1, claim: 'Scan take', kind: 'take', holder: 'brain' }, { page_id: pOther.id, row_num: 1, claim: 'Untiered take', kind: 'take', holder: 'brain' }]);
    const [take] = await raw<{ id: number }>("SELECT id FROM takes WHERE claim = 'Scan take'");
    await tiered('takes', [Number(take!.id)]);
    await engine.addTimelineEntry('scan/p1', { date: '2026-01-02', summary: 'Scan timeline entry', detail: 'Scan detail' });
    const [entry] = await raw<{ id: number }>("SELECT id FROM timeline_entries WHERE summary = 'Scan timeline entry'");
    await tiered('timeline_entries', [Number(entry!.id)]);
    await raw("UPDATE pages SET write_origin = '{\"tool\":\"put_page\"}'::jsonb WHERE id = $1", [p1.id]);

    const tiers = [TIER];
    const pages = await engine.listTrustScanRows({ table: 'pages', afterId: 0, limit: 10, tiers });
    expect(pages.map((r) => r.id)).toEqual([p1.id, p2.id]);
    expect(pages[0]).toMatchObject({ source_id: 'default', trust_tier: TIER, write_origin: { tool: 'put_page' }, title: 'scan/p1', compiled_truth: 'Body of scan/p1.' });
    expect(pages[1]!.write_origin).toBeNull();
    expect((await engine.listTrustScanRows({ table: 'pages', afterId: p1.id, limit: 10, tiers })).map((r) => r.id)).toEqual([p2.id]);
    expect((await engine.listTrustScanRows({ table: 'pages', afterId: 0, limit: 1, tiers })).map((r) => r.id)).toEqual([p1.id]);
    expect(await engine.listTrustScanRows({ table: 'pages', afterId: 0, limit: 10, tiers: ['tool_observed'] })).toEqual([]);
    expect((await engine.listTrustScanRows({ table: 'facts', afterId: 0, limit: 10, tiers })).map((r) => [r.id, r.fact])).toEqual([[f1, 'Scan fact one'], [f2, 'Scan fact two']]);
    expect(await engine.listTrustScanRows({ table: 'takes', afterId: 0, limit: 10, tiers })).toMatchObject([{ id: Number(take!.id), source_id: 'default', claim: 'Scan take', trust_tier: TIER }]);
    expect(await engine.listTrustScanRows({ table: 'timeline_entries', afterId: 0, limit: 10, tiers })).toMatchObject([{ id: Number(entry!.id), source_id: 'default', summary: 'Scan timeline entry', detail: 'Scan detail' }]);

    expect(await engine.countUnscannedTrustRows({ table: 'pages', afterId: 0, until: null, tiers })).toBe(2);
    expect(await engine.countUnscannedTrustRows({ table: 'pages', afterId: p1.id, until: null, tiers })).toBe(1);
    expect(await engine.countUnscannedTrustRows({ table: 'pages', afterId: 0, until: p1.id, tiers })).toBe(1);
    expect(await engine.countUnscannedTrustRows({ table: 'pages', afterId: p2.id, until: null, tiers })).toBe(0);
    expect(await engine.countUnscannedTrustRows({ table: 'facts', afterId: f1, until: null, tiers })).toBe(1);
    expect(await engine.countUnscannedTrustRows({ table: 'takes', afterId: 0, until: null, tiers })).toBe(1);
    expect(await engine.countUnscannedTrustRows({ table: 'timeline_entries', afterId: 0, until: null, tiers })).toBe(1);
    expect(await engine.countUnscannedTrustRows({ table: 'facts', afterId: 0, until: null, tiers: [] })).toBe(0);
  });

  test('readTrustScanCeilings answers each scanned table\'s max id, and the cursor round-trips through writeTrustScanCursor, replaced by each write', async () => {
    const ceilings = await engine.readTrustScanCeilings();
    expect(Object.keys(ceilings).sort()).toEqual(['facts', 'pages', 'takes', 'timeline_entries']);
    for (const table of ['pages', 'facts', 'takes', 'timeline_entries'] as const) {
      const [max] = await raw<{ n: number | string }>(`SELECT max(id) AS n FROM ${table}`);
      expect(ceilings[table]).toBe(Number(max!.n));
      expect(ceilings[table]).toBeGreaterThan(0);
    }
    const newest = await fact('A fact that raises the ceiling');
    expect((await engine.readTrustScanCeilings()).facts).toBe(newest);

    expect(await engine.readTrustScanCursor()).toBeNull();
    await engine.writeTrustScanCursor(['pages:5', 'facts:9']);
    expect(await engine.readTrustScanCursor()).toEqual(['pages:5', 'facts:9']);
    expect(await raw("SELECT op, fingerprint, completed_keys FROM op_checkpoints WHERE op = 'trust_scan'")).toEqual([{ op: 'trust_scan', fingerprint: 'v1', completed_keys: ['pages:5', 'facts:9'] }]);
    await engine.writeTrustScanCursor([]);
    expect(await engine.readTrustScanCursor()).toEqual([]);
    await engine.writeTrustScanCursor(['takes:1']);
    expect(await engine.readTrustScanCursor()).toEqual(['takes:1']);
    expect(await raw("SELECT count(*)::int AS n FROM op_checkpoints WHERE op = 'trust_scan'")).toEqual([{ n: 1 }]);
  });

  test('listCorePageRows lists the live always_load pages by source then slug, with the scope, exclusion, withdrawal and eligibility columns', async () => {
    const core = { always_load: true };
    const [a, b, c, low] = [
      await page('core/a', 'Core page a.', { frontmatter: core }), await page('core/b', 'Core page b.', { frontmatter: core }),
      await page('core/c', 'Core page c.', { frontmatter: core }), await page('core/low', 'Low tier core page.', { frontmatter: core }),
    ];
    await page('core/not-loaded', 'Not always loaded.');
    const deleted = await page('core/deleted', 'Deleted core page.', { frontmatter: core });
    await raw('UPDATE pages SET deleted_at = now() WHERE id = $1', [deleted.id]);
    await raw("UPDATE pages SET source_id = 'other' WHERE id = $1", [b.id]);
    await raw("UPDATE pages SET trust_tier = 'external_untrusted' WHERE id = $1", [low.id]);
    const segmented = await publishSegmentedPage(engine, 'core/segmented', [segmentText('# Segmented core\nlong body\n')]);
    await raw("UPDATE pages SET frontmatter = '{\"always_load\": true}'::jsonb WHERE id = $1", [segmented.pageId]);

    const all = await engine.listCorePageRows({ limit: 20 });
    expect(all.map((r) => [r.source_id, r.slug])).toEqual([['default', 'core/a'], ['default', 'core/c'], ['default', 'core/low'], ['default', 'core/segmented'], ['other', 'core/b']]);
    expect(all[0]).toEqual({
      id: a.id, source_id: 'default', slug: 'core/a', title: 'core/a', compiled_truth: 'Core page a.', frontmatter: core,
      segmented: false, body_bytes: null, withdrawn: false,
    });
    const seg = all.find((r) => r.slug === 'core/segmented')!;
    expect(seg.segmented).toBe(true);
    expect(seg.body_bytes).toBeGreaterThan(0);
    expect((await engine.listCorePageRows({ limit: 2 })).map((r) => r.slug)).toEqual(['core/a', 'core/c']);
    expect((await engine.listCorePageRows({ sourceIds: ['other'], limit: 20 })).map((r) => r.slug)).toEqual(['core/b']);
    expect((await engine.listCorePageRows({ exclude: { sourceId: 'default', slug: 'core/a' }, limit: 20 })).map((r) => r.slug)).not.toContain('core/a');

    await raw("INSERT INTO fact_withdrawals (source_id, visibility, subject, fact_hash) VALUES ('default', 'private', 'core/c', 'h')");
    expect((await engine.listCorePageRows({ limit: 20 })).filter((r) => r.withdrawn).map((r) => r.slug)).toEqual(['core/c']);
    await raw("INSERT INTO fact_withdrawals (source_id, visibility, subject, fact_hash) VALUES ('other', 'private', '*', 'h')");
    expect((await engine.listCorePageRows({ limit: 20 })).filter((r) => r.withdrawn).map((r) => r.slug)).toEqual(['core/c', 'core/b']);

    const eligible = await engine.listCorePageRows({ limit: 20, eligibility: { floor: 'unknown' } });
    expect(eligible.map((r) => r.slug)).not.toContain('core/low');
    expect(eligible.find((r) => r.id === c.id)).toMatchObject({ trust_tier: 'unknown', write_origin: null, suppressed: false });
    expect((await engine.listCorePageRows({ limit: 20, eligibility: { floor: 'tool_observed' } })).map((r) => r.slug)).toEqual([]);
  });

  test('listPageTrustTiersByKey reads the id and tier of each named page, deleted or not, and lockLivePagesByKey holds only the live ones for the transaction', async () => {
    const [live, gone] = [await page('keys/live'), await page('keys/gone')];
    await raw("UPDATE pages SET trust_tier = 'external_untrusted' WHERE id = $1", [live.id]);
    await raw('UPDATE pages SET deleted_at = now() WHERE id = $1', [gone.id]);
    const refs = [
      { source_id: 'default', slug: 'keys/live' }, { source_id: 'default', slug: 'keys/gone' },
      { source_id: 'default', slug: 'keys/missing' }, { source_id: 'other', slug: 'keys/live' },
    ];
    const tiers = await engine.listPageTrustTiersByKey(refs);
    expect(tiers.sort((x, y) => x.id - y.id)).toEqual([
      { id: live.id, source_id: 'default', slug: 'keys/live', trust_tier: 'external_untrusted' },
      { id: gone.id, source_id: 'default', slug: 'keys/gone', trust_tier: 'unknown' },
    ]);
    expect(await engine.listPageTrustTiersByKey([])).toEqual([]);

    const fresh = await page('keys/fresh-lock');
    const xmax = (tx: { executeRaw: typeof raw }) => tx.executeRaw<{ x: string }>('SELECT xmax::text AS x FROM pages WHERE id = $1', [fresh.id]).then((r) => r[0]!.x);
    const held = await engine.transaction(async (tx) => {
      const before = await xmax(tx);
      const locked = await tx.lockLivePagesByKey([...refs, { source_id: 'default', slug: 'keys/fresh-lock' }]);
      return { before, locked, after: await xmax(tx) };
    });
    expect(held.locked.sort((x, y) => x.slug.localeCompare(y.slug))).toEqual([{ source_id: 'default', slug: 'keys/fresh-lock' }, { source_id: 'default', slug: 'keys/live' }]);
    expect(held.before).toBe('0');
    expect(held.after).not.toBe('0');
    expect(await engine.lockLivePagesByKey([])).toEqual([]);
  });
});

describe('valid-time and as-of reads', () => {
  const version = async (pageId: number, over: { validFrom?: string; body: string; title?: string; revision?: string }) => Number((await raw<{ id: number }>(
    `INSERT INTO page_versions (page_id, compiled_truth, frontmatter, title, type, tags, knowledge_revision)
     VALUES ($1, $2, $3::text::jsonb, $4, 'note', '["a","b"]'::jsonb, $5::uuid) RETURNING id`,
    [pageId, over.body, JSON.stringify(over.validFrom ? { valid_from: over.validFrom } : {}), over.title ?? 'Old title', over.revision ?? null]))[0]!.id);

  test('pickValidTimeEdition picks the edition in force on the date among the current page and its versions, honours a pinned ordinal, and answers null for a gone page', async () => {
    const owner = await page('vt/page', 'Current body.', { frontmatter: { valid_from: '2026-03-01' } });
    const [v1, v2] = [await version(owner.id, { validFrom: '2025-01-01', body: 'First edition.' }), await version(owner.id, { validFrom: '2025-09-01', body: 'Second edition.' })];
    const pick = (asOf: string, pinOrd: number | null = null) => engine.pickValidTimeEdition({ pageId: owner.id, asOf, excludePrivate: false, pinOrd, inlineMaxBytes: 100_000 });

    const second = (await pick('2025-10-01'))!;
    expect([Number(second.version_id), Number(second.ord), second.valid_from, second.chosen]).toEqual([v2, v2, '2025-09-01', true]);
    expect(Number(second.undated)).toBe(0);
    const first = (await pick('2025-02-01'))!;
    expect([Number(first.version_id), first.valid_from, first.chosen]).toEqual([v1, '2025-01-01', true]);
    const current = (await pick('2026-04-01'))!;
    expect([current.version_id, Number(current.ord), current.valid_from, current.chosen]).toEqual([null, 2147483648, '2026-03-01', true]);
    const early = (await pick('2024-01-01'))!;
    expect([Number(early.version_id), early.chosen]).toEqual([v1, false]);
    const pinned = (await pick('2025-10-01', v1))!;
    expect([Number(pinned.version_id), pinned.valid_from]).toEqual([v1, '2025-01-01']);

    const undated = await page('vt/undated', 'No dates.');
    const row = (await engine.pickValidTimeEdition({ pageId: undated.id, asOf: '2025-10-01', excludePrivate: false, pinOrd: null, inlineMaxBytes: 100 }))!;
    expect([row.version_id, row.chosen, Number(row.undated)]).toEqual([null, null, 1]);
    expect(await engine.pickValidTimeEdition({ pageId: owner.id + 100_000, asOf: '2025-10-01', excludePrivate: false, pinOrd: null, inlineMaxBytes: 100 })).toBeNull();
  });

  test('readPageVersionEdition loads one retained version of the page, and readCursorEdition says whether a revision is current and which version recorded it', async () => {
    const owner = await page('vt/editions', 'Edition body.');
    const stale = randomUUID();
    const [first, second] = [await version(owner.id, { body: 'Version one.', title: 'Title one', revision: stale }), await version(owner.id, { body: 'Version two.', title: 'Title two', revision: stale })];
    expect(await engine.readPageVersionEdition({ pageId: owner.id, versionId: first })).toEqual({
      id: first, title: 'Title one', type: 'note', tags: ['a', 'b'], frontmatter: {}, compiled_truth: 'Version one.', timeline: null,
      revision: stale, body_storage: 'inline', body_generation: null,
    });
    expect(await engine.readPageVersionEdition({ pageId: owner.id, versionId: second })).toMatchObject({ id: second, compiled_truth: 'Version two.' });
    expect(await engine.readPageVersionEdition({ pageId: owner.id + 1, versionId: first })).toBeNull();
    expect(await engine.readPageVersionEdition({ pageId: owner.id, versionId: second + 100_000 })).toBeNull();

    const current = (await raw<{ rev: string }>('SELECT knowledge_revision::text AS rev FROM pages WHERE id = $1', [owner.id]))[0]!.rev;
    expect(await engine.readCursorEdition({ pageId: owner.id, revision: current })).toEqual({ current: true, version_id: null });
    expect(await engine.readCursorEdition({ pageId: owner.id, revision: stale })).toEqual({ current: false, version_id: second });
    expect(await engine.readCursorEdition({ pageId: owner.id + 100_000, revision: current })).toBeNull();
  });

  test('listValidTimeIdentities lists the live pages with a slug by source, filtered by source scope, and skips deleted pages', async () => {
    const [a, b] = [await page('vt/ident', 'Ident a.'), await page('vt/ident-b', 'Ident b.')];
    await raw("UPDATE pages SET slug = 'vt/ident', source_id = 'other', source_path = 'vt/ident.md' WHERE id = $1", [b.id]);
    await raw("UPDATE sources SET local_path = '/tmp/other-checkout' WHERE id = 'other'");
    const spec = { slug: 'vt/ident', sourceId: null, sourceIds: null, excludePrivate: false };
    expect(await engine.listValidTimeIdentities(spec)).toEqual([
      { id: a.id, source_id: 'default', slug: 'vt/ident', source_path: null, local_path: null, world: true },
      { id: b.id, source_id: 'other', slug: 'vt/ident', source_path: 'vt/ident.md', local_path: '/tmp/other-checkout', world: true },
    ]);
    expect((await engine.listValidTimeIdentities({ ...spec, sourceId: 'other' })).map((r) => r.id)).toEqual([b.id]);
    expect((await engine.listValidTimeIdentities({ ...spec, sourceIds: ['default'] })).map((r) => r.id)).toEqual([a.id]);
    expect((await engine.listValidTimeIdentities({ ...spec, excludePrivate: true })).map((r) => r.id)).toEqual([a.id, b.id]);
    expect(await engine.listValidTimeIdentities({ ...spec, slug: 'vt/none' })).toEqual([]);
    await raw('UPDATE pages SET deleted_at = now() WHERE id = $1', [b.id]);
    expect((await engine.listValidTimeIdentities(spec)).map((r) => r.id)).toEqual([a.id]);
  });

  test('listAmendmentsNotApplied lists the live amending pages dated after the edition and on or before the date, or undated, by slug', async () => {
    const target = await page('amend/target');
    const slugs = ['amend/undated', 'amend/in-window', 'amend/before-edition', 'amend/after-date', 'amend/deleted', 'amend/other-type'];
    const pages = new Map<string, number>();
    for (const slug of slugs) {
      const created = await page(slug);
      pages.set(slug, created.id);
      await engine.addLink(slug, 'amend/target', `${slug} amends the target`, slug === 'amend/other-type' ? 'mentions' : 'amends', 'markdown');
    }
    const since = async (slug: string, date: string) => {
      for (const scope of ['all', 'world']) {
        await raw(
          `INSERT INTO link_relationships (from_page_id, to_page_id, link_type, scope, source_id, semantics, valid_ranges, status_now, first_start, evidence_hash)
           VALUES ($1, $2, 'amends', $4, 'default', 'event', '{}'::datemultirange, 'event', $3::date, 'h')`, [pages.get(slug), target.id, date, scope]);
      }
    };
    await since('amend/in-window', '2026-02-01');
    await since('amend/before-edition', '2025-01-01');
    await since('amend/after-date', '2027-01-01');
    await raw('UPDATE pages SET deleted_at = now() WHERE id = $1', [pages.get('amend/deleted')]);
    const spec = { pageId: target.id, editionFrom: '2025-06-01', asOf: '2026-06-01', excludePrivate: false, sourceIds: null, limit: 10 };
    expect(await engine.listAmendmentsNotApplied(spec)).toEqual([
      { slug: 'amend/in-window', source_id: 'default', since: '2026-02-01' }, { slug: 'amend/undated', source_id: 'default', since: null },
    ]);
    expect(await engine.listAmendmentsNotApplied({ ...spec, limit: 1 })).toEqual([{ slug: 'amend/in-window', source_id: 'default', since: '2026-02-01' }]);
    expect(await engine.listAmendmentsNotApplied({ ...spec, sourceIds: ['other'] })).toEqual([]);
    expect((await engine.listAmendmentsNotApplied({ ...spec, asOf: '2027-06-01' })).map((r) => r.slug)).toEqual(['amend/after-date', 'amend/in-window', 'amend/undated']);
    expect(await engine.listAmendmentsNotApplied({ ...spec, editionFrom: '2026-03-01' })).toEqual([{ slug: 'amend/undated', source_id: 'default', since: null }]);
    expect(await engine.listAmendmentsNotApplied({ ...spec, excludePrivate: true })).toEqual(await engine.listAmendmentsNotApplied(spec));
  });
});

describe('write gate receipts and write context', () => {
  const receipt = (over: Record<string, unknown> = {}) => ({
    content_hash: 'hash-a', tier: 'agent_written', detector_version: 2, verdict: 'flag' as const,
    reason_families: ['injection'], reasons: ['ignore previous instructions'], detector_error: false, request_id: null, ...over,
  });

  test('upsertPageWriteGateReceipt records one receipt per page, content and detector, refreshes it on a repeat, and answers null for a missing or deleted page', async () => {
    const owner = await page('gate/receipt-page');
    const id = await engine.upsertPageWriteGateReceipt('default', 'gate/receipt-page', receipt());
    expect(typeof id).toBe('number');
    const stored = () => raw<Record<string, unknown>>(
      'SELECT id::int AS id, target_table, target_id, source_id, content_hash, tier, detector_version, verdict, reason_families, reasons, detector_error, request_id, created_at, last_seen_at FROM write_gate_receipts WHERE target_table = $1 AND target_id = $2 ORDER BY id',
      ['pages', String(owner.id)]);
    const first = await stored();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      id, target_table: 'pages', target_id: String(owner.id), source_id: 'default', content_hash: 'hash-a', tier: 'agent_written', detector_version: 2,
      verdict: 'flag', reason_families: ['injection'], reasons: ['ignore previous instructions'], detector_error: false, request_id: null,
    });

    expect(await engine.upsertPageWriteGateReceipt('default', 'gate/receipt-page', receipt({ verdict: 'quarantine', reasons: ['now quarantined'], request_id: 'req-1' }))).toBe(id);
    const again = await stored();
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ verdict: 'quarantine', reasons: ['now quarantined'], request_id: 'req-1' });
    expect(new Date(again[0]!.last_seen_at as Date).getTime()).toBeGreaterThanOrEqual(new Date(first[0]!.last_seen_at as Date).getTime());
    expect(new Date(again[0]!.created_at as Date).getTime()).toBe(new Date(first[0]!.created_at as Date).getTime());
    expect(await engine.upsertPageWriteGateReceipt('default', 'gate/receipt-page', receipt({ request_id: null }))).toBe(id);
    expect((await stored())[0]!.request_id).toBe('req-1');

    const newer = await engine.upsertPageWriteGateReceipt('default', 'gate/receipt-page', receipt({ content_hash: 'hash-b' }));
    expect(newer).not.toBe(id);
    expect((await engine.listWriteGateReceiptsFor('pages', String(owner.id), 10)).map((r) => r.id).sort()).toEqual([id!, newer!].sort());
    expect(await engine.upsertPageWriteGateReceipt('default', 'gate/never-written', receipt())).toBeNull();
    expect(await engine.upsertPageWriteGateReceipt('other', 'gate/receipt-page', receipt())).toBeNull();
    await raw('UPDATE pages SET deleted_at = now() WHERE id = $1', [owner.id]);
    expect(await engine.upsertPageWriteGateReceipt('default', 'gate/receipt-page', receipt({ content_hash: 'hash-c' }))).toBeNull();
  });

  test('setWriteContext sets the transaction settings and returns the persistence identity with what it replaced, nesting under the outer actor and the lower tier', async () => {
    const identity = (await raw<{ brain_id: string }>('SELECT brain_id::text AS brain_id FROM persistence_brain WHERE singleton = 1'))[0]!.brain_id;
    const settings = (tx: { executeRaw: typeof raw }) => tx.executeRaw<Record<string, string>>(
      `SELECT current_setting('gbrain.write_sources', true) AS sources, current_setting('gbrain.write_request', true) AS request,
              current_setting('gbrain.write_principal_kind', true) AS kind, current_setting('gbrain.write_principal_id', true) AS principal,
              current_setting('gbrain.write_trust_tier', true) AS tier, current_setting('gbrain.write_origin', true) AS origin,
              current_setting('gbrain.git_protocol', true) AS git`).then((r) => r[0]!);
    const requestId = randomUUID();
    const seen = await engine.transaction(async (tx) => {
      const outer = await tx.setWriteContext({ sourceIds: ['default'], requestId, principalKind: 'local_cli', principalId: 'alice-example', tier: 'tool_observed', origin: '{"tool":"outer"}' });
      const afterOuter = await settings(tx);
      const inner = await tx.setWriteContext({ sourceIds: ['other'], requestId: randomUUID(), principalKind: 'oauth_client', principalId: 'someone-else', tier: 'user_confirmed', origin: '' });
      const afterInner = await settings(tx);
      const lower = await tx.setWriteContext({ sourceIds: ['other'], requestId: null, principalKind: 'oauth_client', principalId: 'x', tier: 'external_untrusted', origin: '' });
      return { outer, afterOuter, inner, afterInner, lower, afterLower: await settings(tx) };
    });
    expect(seen.outer).toEqual({ brainId: identity, previous: ['', '', '', '', '', '', ''] });
    expect(seen.afterOuter).toMatchObject({ sources: '["default"]', request: requestId, kind: 'local_cli', principal: 'alice-example', tier: 'tool_observed', origin: '{"tool":"outer"}', git: '1' });
    expect(seen.inner.previous).toEqual(['["default"]', requestId, 'local_cli', 'alice-example', 'tool_observed', '{"tool":"outer"}', '1']);
    expect(seen.afterInner).toMatchObject({ sources: '["other"]', request: requestId, kind: 'local_cli', principal: 'alice-example', tier: 'tool_observed', origin: '{"tool":"outer"}' });
    expect(seen.afterLower).toMatchObject({ tier: 'external_untrusted', kind: 'local_cli' });
    expect(seen.lower.previous[4]).toBe('tool_observed');
    const after = await settings(engine);
    expect([after.sources, after.principal, after.tier]).toEqual(['', '', '']); // the settings last for the transaction only
  });
});

describe('fence cells and the fence overlay', () => {
  const claimA = 'Alice-example prefers green tea in the morning';
  const claimB = 'Acme-example hires new engineers every spring';
  const claimPurged = 'Acme-example once planned a secret merger';

  test('readFenceOverlayRows answers per incoming row the page and row tiers, the purge and hold flags, and the narrower flag for a world-only reader', async () => {
    const owner = await page('fence/page', 'Fence page body.');
    await raw("UPDATE pages SET trust_tier = 'external_untrusted' WHERE id = $1", [owner.id]);
    await fact(claimA, { slug: 'fence/page', rowNum: 1, visibility: 'private', tier: 'external_untrusted' });
    await fact(claimB, { slug: 'fence/page', rowNum: 2, visibility: 'world' });
    await raw("INSERT INTO fact_purges (source_id, visibility, subject, fact_hash) VALUES ('default', 'world', '*', gbrain_fact_fingerprint($1))", [claimPurged]);
    await raw(
      `INSERT INTO write_gate_holds (kind, source_id, slug, fingerprint, detector_version, tier, payload) VALUES ('fact', 'default', 'fence/page', 'fp-held', 1, 'agent_written', '{}'::jsonb)`);
    const incoming = [
      { row_num: 1, claim: claimA, visibility: 'private', fp: null },
      { row_num: 2, claim: claimB, visibility: 'world', fp: 'fp-held' },
      { row_num: 3, claim: claimPurged, visibility: 'world', fp: null },
    ];
    const target = { sourceId: 'default', slug: 'fence/page' };
    const rows = await engine.readFenceOverlayRows(target, incoming, { hideHeld: false });
    expect(rows.map((r) => r.row_num)).toEqual([1, 2, 3]);
    expect(rows[0]).toMatchObject({ page_tier: 'external_untrusted', row_tier: 'external_untrusted', purged: false, held: false, narrower: false });
    expect(rows[1]).toMatchObject({ page_tier: 'external_untrusted', row_tier: 'unknown', purged: false, held: true, narrower: false });
    expect(rows[2]).toMatchObject({ page_tier: 'external_untrusted', row_tier: null, row_flagged: null, purged: true, held: false });
    expect(typeof rows[0]!.row_flagged).toBe('boolean');

    const hidden = await engine.readFenceOverlayRows(target, incoming, { hideHeld: true });
    expect(hidden.map((r) => r.narrower)).toEqual([true, false, false]);
    expect(await engine.readFenceOverlayRows({ sourceId: 'other', slug: 'fence/page' }, incoming, { hideHeld: false })).toMatchObject([
      { row_num: 1, page_tier: null, row_tier: null, purged: false, held: false }, { row_num: 2, held: false }, { row_num: 3, purged: false },
    ]);
    expect(await engine.readFenceOverlayRows(target, [], { hideHeld: true })).toEqual([]);
  });

  test('listHeldFenceCells returns the cells a narrower stored fact holds from a world-only reader, one row per distinct held cell', async () => {
    // Its own page and facts (a private fact and a world fact on one page), not the overlay test's.
    const owner = await page('fence/held-page', 'Held fence page body.');
    await raw("UPDATE pages SET trust_tier = 'external_untrusted' WHERE id = $1", [owner.id]);
    await fact(claimA, { slug: 'fence/held-page', rowNum: 1, visibility: 'private', tier: 'external_untrusted' });
    await fact(claimB, { slug: 'fence/held-page', rowNum: 2, visibility: 'world' });
    const key = (rowNum: number, claim: string, partial = false) => ({ sourceId: 'default', slug: 'fence/held-page', rowNum, claim, partial });
    const held = await engine.listHeldFenceCells([key(1, claimA), key(2, claimB), key(3, claimPurged), key(1, claimA)]);
    expect(held).toEqual([{ source_id: 'default', slug: 'fence/held-page', row_num: 1, claim: claimA }]);
    const partial = await engine.listHeldFenceCells([key(-1, 'green tea in the', true), key(-1, 'hires new engineers', true), key(-1, 'green tea in the')]);
    expect(partial).toEqual([{ source_id: 'default', slug: 'fence/held-page', row_num: -1, claim: 'green tea in the' }]);
    expect(await engine.listHeldFenceCells([{ sourceId: 'other', slug: 'fence/held-page', rowNum: 1, claim: claimA, partial: false }])).toEqual([]);
    expect(await engine.listHeldFenceCells([])).toEqual([]);
  });
});

describe('link context reads', () => {
  test('readLinkContextMatches answers the stored rows behind each ask, exactly or by an ellipsis prefix, with the page that backs each one', async () => {
    const [from, to, origin] = [await page('lc/from'), await page('lc/to'), await page('lc/origin')];
    await engine.addLink('lc/from', 'lc/to', 'Alice-example joined Acme-example in March', 'works_at', 'markdown');
    await engine.addLink('lc/from', 'lc/to', 'Alice-example mentioned Acme-example on a call', 'mentions', 'markdown', 'lc/origin', 'frontmatter');
    const ask = (i: number, linkType: string, context: string, over: Record<string, string> = {}) => ({
      i, fromSourceId: 'default', fromSlug: 'lc/from', toSourceId: 'default', toSlug: 'lc/to', linkType, context, ...over,
    });
    const matches = await engine.readLinkContextMatches([
      ask(0, 'works_at', 'Alice-example joined Acme-example in March'),
      ask(1, 'works_at', 'Alice-example joined…'),
      ask(2, 'works_at', 'A different context entirely'),
      ask(3, 'mentions', 'Alice-example mentioned Acme-example on a call'),
      ask(4, 'works_at', 'Alice-example joined Acme-example in March', { toSlug: 'lc/from' }),
    ]);
    expect(matches.sort((x, y) => x.i - y.i)).toEqual([
      { i: 0, link_source: 'markdown', context: 'Alice-example joined Acme-example in March', page_id: from.id },
      { i: 1, link_source: 'markdown', context: 'Alice-example joined Acme-example in March', page_id: from.id },
      { i: 3, link_source: 'markdown', context: 'Alice-example mentioned Acme-example on a call', page_id: origin.id },
    ]);
    expect(to.id).not.toBe(from.id);
    await raw('UPDATE pages SET deleted_at = now() WHERE id = $1', [origin.id]);
    expect((await engine.readLinkContextMatches([ask(3, 'mentions', 'Alice-example mentioned Acme-example on a call')]))[0]).toMatchObject({ i: 3, page_id: null });
    expect(await engine.readLinkContextMatches([])).toEqual([]);
  });

  test('readLinkContextOriginPages reads the stored bodies of the listed pages, deleted or not, and leaves out a segmented page and an unknown id', async () => {
    const live = await engine.putPage('lc/body-live', { type: 'note', title: 'Live', compiled_truth: 'Live origin body.', timeline: '- 2026-01-02: live entry' });
    const gone = await page('lc/body-gone', 'Gone origin body.');
    await raw('UPDATE pages SET deleted_at = now() WHERE id = $1', [gone.id]);
    const segmented = await publishSegmentedPage(engine, 'lc/body-segmented', [segmentText('# Segmented\nbody\n')]);
    const rows = await engine.readLinkContextOriginPages([live.id, gone.id, segmented.pageId, live.id + 100_000]);
    expect(rows.sort((x, y) => x.id - y.id)).toEqual([
      { id: live.id, source_id: 'default', slug: 'lc/body-live', compiled_truth: 'Live origin body.', timeline: '- 2026-01-02: live entry' },
      { id: gone.id, source_id: 'default', slug: 'lc/body-gone', compiled_truth: 'Gone origin body.', timeline: '' },
    ]);
    expect(await engine.readLinkContextOriginPages([])).toEqual([]);
  });
});

describe('live takes and link effect re-arming', () => {
  test('listLiveTakesByIds returns the active takes the read policy and trust floor admit, with their page, and drops inactive or filtered ones', async () => {
    const owner = await page('takes/live-owner');
    await engine.addTakesBatch([
      { page_id: owner.id, row_num: 1, claim: 'Brain take', kind: 'take', holder: 'brain' },
      { page_id: owner.id, row_num: 2, claim: 'Alice-example take', kind: 'bet', holder: 'alice-example' },
      { page_id: owner.id, row_num: 3, claim: 'Retired take', kind: 'take', holder: 'brain' },
      { page_id: owner.id, row_num: 4, claim: 'Low tier take', kind: 'take', holder: 'brain' },
    ]);
    const ids = new Map((await raw<{ id: number; row_num: number }>('SELECT id, row_num FROM takes WHERE page_id = $1', [owner.id])).map((r) => [Number(r.row_num), Number(r.id)]));
    await engine.deactivateDerivedTakes([ids.get(3)!], 'default');
    await raw("UPDATE takes SET trust_tier = 'external_untrusted' WHERE id = $1", [ids.get(4)!]);
    const all = [...ids.values()];
    const byRow = (rows: Array<{ row_num: number }>) => rows.map((r) => r.row_num).sort();

    const open = await engine.listLiveTakesByIds(all, {}, undefined);
    expect(byRow(open)).toEqual([1, 2, 4]);
    expect(open.find((r) => r.row_num === 2)).toEqual({ id: ids.get(2)!, page_id: owner.id, slug: 'takes/live-owner', source_id: 'default', row_num: 2, claim: 'Alice-example take', holder: 'alice-example' });
    expect(byRow(await engine.listLiveTakesByIds(all, { takesHoldersAllowList: ['brain'] }, undefined))).toEqual([1, 4]);
    expect(byRow(await engine.listLiveTakesByIds(all, {}, 'unknown'))).toEqual([1, 2]);
    expect(byRow(await engine.listLiveTakesByIds(all, { sourceId: 'other' }, undefined))).toEqual([]);
    expect(await engine.listLiveTakesByIds([], {}, undefined)).toEqual([]);
  });

  test('rearmLinksEffects queues each unarmed links effect of the requests again, marks it re-armed once, and honours the slug filter', async () => {
    const effect = async (tag: string, slug: string) => {
      const { id } = await admit(`rearm-${tag}`, slug);
      await engine.insertPublicationEffects({
        requestId: id, revision: null, sourceId: 'default', sourceIncarnation: incarnation, worktreeId: null,
        effects: [{ kind: 'links', data: { slug } }] as never,
      });
      await raw("UPDATE persistence_effects SET state = 'failed', error_code = 'targets_parked', claim_owner = to_jsonb('worker-1'::text) WHERE request_id = $1::uuid", [id]);
      return { id };
    };
    const [one, two, three] = [await effect('one', 'rearm/one'), await effect('two', 'rearm/two'), await effect('three', 'rearm/three')];
    const state = (id: string) => raw<{ state: string; error_code: string | null; claim_owner: unknown; data: Record<string, unknown> }>(
      'SELECT state, error_code, claim_owner, data FROM persistence_effects WHERE request_id = $1::uuid', [id]).then((r) => r[0]!);
    expect(await state(one.id)).toMatchObject({ state: 'failed', error_code: 'targets_parked', claim_owner: 'worker-1' });

    expect(await engine.rearmLinksEffects({ sourceId: 'default', requestIds: [] })).toBe(0);
    expect(await engine.rearmLinksEffects({ sourceId: 'other', requestIds: [one.id] })).toBe(0);
    expect(await engine.rearmLinksEffects({ sourceId: 'default', requestIds: [one.id, two.id], slugs: ['rearm/one'] })).toBe(1);
    expect(await state(one.id)).toMatchObject({ state: 'queued', error_code: null, claim_owner: null, data: { slug: 'rearm/one', batch_reconciled: true } });
    expect(await state(two.id)).toMatchObject({ state: 'failed', error_code: 'targets_parked' });

    expect(await engine.rearmLinksEffects({ sourceId: 'default', requestIds: [one.id, two.id, three.id] })).toBe(2);
    expect(await state(two.id)).toMatchObject({ state: 'queued', data: { slug: 'rearm/two', batch_reconciled: true } });
    expect(await state(three.id)).toMatchObject({ state: 'queued', data: { slug: 'rearm/three', batch_reconciled: true } });
    expect(await engine.rearmLinksEffects({ sourceId: 'default', requestIds: [one.id, two.id, three.id] })).toBe(0);
  });
});

describe('access member reads', () => {
  test('readAccessMembers reads one member by id or by exact email, and all members with or without the removed ones', async () => {
    await raw(`INSERT INTO access_members (id, display_name, email, kind) VALUES ('read-alice', 'Alice', 'alice@example.com', 'person'), ('read-bob', 'Bob', 'bob@example.com', 'person')`);
    await raw(`UPDATE access_members SET tombstoned_at = now() WHERE id = 'read-bob'`);
    expect((await engine.readAccessMembers({ id: 'read-alice' })).map((m) => [m.id, m.email])).toEqual([['read-alice', 'alice@example.com']]);
    expect(await engine.readAccessMembers({ id: 'read-nobody' })).toEqual([]);
    expect((await engine.readAccessMembers({ email: 'bob@example.com' })).map((m) => m.id)).toEqual(['read-bob']);
    const live = (await engine.readAccessMembers({ includeRemoved: false })).map((m) => m.id);
    const all = (await engine.readAccessMembers({ includeRemoved: true })).map((m) => m.id);
    expect(live).toContain('read-alice');
    expect(live).not.toContain('read-bob');
    expect(all).toEqual(expect.arrayContaining(['read-alice', 'read-bob']));
    expect((await engine.readAccessMembers({ includeRemoved: true })).find((m) => m.id === 'read-bob')!.tombstoned_at).not.toBeNull();
  });
});
