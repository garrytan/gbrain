/**
 * BrainEngine parity — the statements `gbrain export` ran through `executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member below returns the same observable result on every engine arm (PGLite always; Postgres
 *    with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1), or the Rust arm's documented answer where the store
 *    keeps nothing to read (rust/docs/store/cli-reads-export.md).
 *  - Regression: an engine that answers one of these differently writes a different export tree; the Rust engine has
 *    no SQL, so each statement has to exist as a typed member it can implement.
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call
 *    (D18), so no case compared them across engines.
 *  - Seam: none; every row is written through typed members on every arm. Generated values (page ids, timestamps)
 *    are compared by relation or shape, never by value.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { flipInput, manifestRow, pageMeta, segmentText, stagingInput } from '../helpers/page-body-fixtures.ts';

const { parityTest } = parityArms(testBackends());

const SEGMENTS = [segmentText('# Intro\nfirst segment\n'), segmentText('## Next\nsecond segment\n')];

/** Publish SEGMENTS as generation 1 of segmented page `slug`, through typed members only. */
async function publishSegmented(engine: BrainEngine, slug: string) {
  const { id: pageId } = await engine.createSegmentedPageShell(slug, pageMeta('Big page'), { sourceId: 'default' });
  const occurrences = await engine.allocateBodyOccurrenceIds(SEGMENTS.length);
  const staging = stagingInput({ slug, pageId, mode: 'create' });
  await engine.transaction(async (tx) => {
    await tx.openBodyStaging(staging);
    await tx.stageSegmentTexts('default', SEGMENTS, { stagingId: staging.id });
    let byteStart = 0;
    await tx.stageManifestRows(SEGMENTS.map((text, seq) => {
      const row = manifestRow({ pageId, occurrenceId: occurrences[seq]!, genFrom: 1, seq, text, byteStart, stagingId: staging.id });
      byteStart += text.body.byteLength;
      return row;
    }));
  });
  await engine.transaction(async (tx) => {
    await tx.flipBodyGeneration(flipInput(pageId, 0, staging.id, SEGMENTS));
    await tx.setBodyStagingState(staging.id, 'committed');
  });
  return { pageId, occurrences };
}

/** Bigint columns as numbers: Postgres answers them as strings. */
const num = (v: unknown) => (v === null || v === undefined ? v : Number(v));

describe('engine parity: export reads', () => {
  // The export bounds its snapshot transaction to 60 s. The store has no statement timeout, so the Rust member does
  // nothing; the transaction's reads answer the same on every arm, and a bad value refuses on every arm.
  parityTest('setLocalStatementTimeout bounds the transaction and leaves its reads alone', {
    methods: ['transaction', 'setLocalStatementTimeout', 'putPage', 'getPage'],
  }, async (engine) => {
    await engine.putPage('export/one', { type: 'note', title: 'One', compiled_truth: 'body one' });
    const title = await engine.transaction(async (tx) => {
      await tx.setLocalStatementTimeout(60000);
      return (await tx.getPage('export/one'))?.title ?? null;
    });
    const refusal = await engine.transaction(tx => tx.setLocalStatementTimeout(-1)).then(() => null, (e: Error) => e.message);
    expect(refusal).toContain('non-negative integer');
    return { title, refusal };
  });

  // The batch keys: live pages after the cursor, in id order, within the source, type and slug prefix, each with its
  // raw_data count and payload size. Postgres answers bigint columns as strings, so the counts are compared as numbers.
  parityTest('listExportPageKeys pages live keys after the cursor with their payload sizes', {
    methods: ['listExportPageKeys', 'putPage', 'putRawData', 'addTag', 'softDeletePage'],
  }, async (engine) => {
    await engine.putPage('export/a', { type: 'note', title: 'A', compiled_truth: 'alpha body', frontmatter: { k: 'v' } });
    await engine.putPage('export/b', { type: 'person', title: 'Bee', compiled_truth: 'beta', timeline: '- 2026: met' });
    await engine.putPage('other/c', { type: 'note', title: 'C', compiled_truth: 'gamma' });
    await engine.putPage('export/gone', { type: 'note', title: 'Gone', compiled_truth: 'deleted' });
    await engine.putRawData('export/a', 'crm', { id: 7, name: 'x' });
    await engine.putRawData('export/a', 'mail', { n: 1 });
    await engine.addTag('export/b', 'friend');
    await engine.softDeletePage('export/gone');
    const shape = (rows: Awaited<ReturnType<typeof engine.listExportPageKeys>>) => rows.map(r => ({
      segmented: r.segmented, slug: r.slug, source_id: r.source_id, source_path: r.source_path,
      source_path_bytes: r.source_path_bytes === null ? null : Number(r.source_path_bytes),
      raw_count: Number(r.raw_count), bytes: r.bytes === null ? null : Number(r.bytes),
    }));
    const q = { afterId: '0', sourceId: null, type: null, slugPrefix: null };
    const all = await engine.listExportPageKeys(q);
    const ids = all.map(r => BigInt(r.id));
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    const afterFirst = await engine.listExportPageKeys({ ...q, afterId: all[0]!.id });
    return {
      all: shape(all),
      afterFirst: afterFirst.map(r => r.slug),
      byType: (await engine.listExportPageKeys({ ...q, type: 'person' })).map(r => r.slug),
      byPrefix: (await engine.listExportPageKeys({ ...q, slugPrefix: 'export/' })).map(r => r.slug),
      bySource: (await engine.listExportPageKeys({ ...q, sourceId: 'default' })).length,
      otherSource: (await engine.listExportPageKeys({ ...q, sourceId: 'nowhere' })).length,
    };
  });

  // The export refuses a withdrawal ledger over its payload limit, so the ledger's size must be the same on every arm.
  parityTest('readExportWithdrawalLedgerBytes sizes the ledger as jsonb text', {
    methods: ['readExportWithdrawalLedgerBytes', 'insertFactWithdrawal'],
  }, async (engine) => {
    const empty = await engine.readExportWithdrawalLedgerBytes('default');
    await engine.insertFactWithdrawal('default', 'world', 'Alice founded Acme', '*', '2026-01-03T00:00:00.000Z');
    await engine.insertFactWithdrawal('default', 'private', 'Bob likes tea', 'people/bob', '2026-02-04T05:06:07.250Z');
    return { empty, two: await engine.readExportWithdrawalLedgerBytes('default'), other: await engine.readExportWithdrawalLedgerBytes('nowhere') };
  });

  // The ledger the export overlays fenced bodies with: same rows, same order, the time a Date on every arm.
  parityTest('listExportWithdrawals lists the ledger by visibility, hash and subject', {
    methods: ['listExportWithdrawals', 'insertFactWithdrawal'],
  }, async (engine) => {
    await engine.insertFactWithdrawal('default', 'world', 'Alice founded Acme', '*', '2026-01-03T00:00:00.000Z');
    await engine.insertFactWithdrawal('default', 'private', 'Bob likes tea', 'people/bob', '2026-02-04T05:06:07.250Z');
    await engine.insertFactWithdrawal('default', 'world', 'Alice founded Acme', 'people/alice', '2026-03-01T00:00:00.000Z');
    const rows = await engine.listExportWithdrawals('default');
    for (const row of rows) expect(row.withdrawn_at).toBeInstanceOf(Date);
    return {
      rows: rows.map(r => ({ ...r, withdrawn_at: r.withdrawn_at.toISOString() })),
      other: await engine.listExportWithdrawals('nowhere'),
    };
  });

  // The pages the export writes, looked up by id: live ones only, with their tags in tag order.
  parityTest('readExportPageRows reads live pages by id with their tags', {
    methods: ['readExportPageRows', 'putPage', 'addTag', 'softDeletePage', 'getPage'],
  }, async (engine) => {
    await engine.putPage('export/a', { type: 'note', title: 'A', compiled_truth: 'alpha', timeline: '- 2026: one', frontmatter: { k: 'v', n: 2 } });
    await engine.putPage('export/b', { type: 'person', title: 'B', compiled_truth: 'beta' });
    await engine.putPage('export/gone', { type: 'note', title: 'Gone', compiled_truth: 'deleted' });
    await engine.addTag('export/a', 'zeta');
    await engine.addTag('export/a', 'alpha');
    const ids = await Promise.all(['export/a', 'export/b', 'export/gone'].map(async slug => String((await engine.getPage(slug))!.id)));
    await engine.softDeletePage('export/gone');
    const rows = await engine.readExportPageRows(ids);
    expect(rows.every(row => ids.includes(String(row.page.id)))).toBe(true);
    return rows
      .map(({ page, tags }) => ({ slug: page.slug, source_id: page.source_id, type: page.type, title: page.title,
        compiled_truth: page.compiled_truth, timeline: page.timeline, frontmatter: page.frontmatter, tags }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  });

  // The overlay compares fact rows in Postgres' normalized form, so every arm must lower-case and fold whitespace alike,
  // including the classes JavaScript's \s disagrees on (U+0085 is space to Postgres, U+00A0 is not).
  parityTest('normalizeFenceLines lower-cases and folds whitespace line by line', {
    methods: ['normalizeFenceLines'],
  }, async (engine) => {
    const bodies = ['MiXeD\t  Claim\r\nSecond   LINE\n', '', 'Ünïcode\u0085x\u00a0y\u2003z', 'one'];
    const timelines = ['', 'A\n\nB', 'x', ''];
    const rows = await engine.normalizeFenceLines(bodies, timelines);
    return [...rows].map(r => ({ ...r, i: Number(r.i) })).sort((a, b) => a.i - b.i);
  });

  // A segmented body read opens with the page row: its body columns and revision. An inline page reads the column
  // defaults, a deleted page still reads, and an id no page has reads nothing.
  parityTest('readSegmentedPageHead reads the body columns and revision of a page', {
    methods: ['readSegmentedPageHead', 'putPage', 'getPage', 'softDeletePage', 'createSegmentedPageShell', 'allocateBodyOccurrenceIds',
      'openBodyStaging', 'stageSegmentTexts', 'stageManifestRows', 'flipBodyGeneration', 'setBodyStagingState', 'transaction'],
  }, async (engine) => {
    const { pageId } = await publishSegmented(engine, 'notes/big');
    await engine.putPage('notes/small', { type: 'note', title: 'Small', compiled_truth: 'inline body' });
    await engine.putPage('notes/gone', { type: 'note', title: 'Gone', compiled_truth: 'deleted' });
    const small = Number((await engine.getPage('notes/small'))!.id);
    const gone = Number((await engine.getPage('notes/gone'))!.id);
    await engine.softDeletePage('notes/gone');
    const view = (head: Awaited<ReturnType<typeof engine.readSegmentedPageHead>>) => head && ({
      ...head, id: num(head.id), body_generation: num(head.body_generation), body_bytes: num(head.body_bytes),
      body_lines: num(head.body_lines), truth_bytes: num(head.truth_bytes), segmenter_version: num(head.segmenter_version),
      revision: typeof head.revision === 'string' && /^[0-9a-f-]{36}$/.test(head.revision),
    });
    const big = view(await engine.readSegmentedPageHead(pageId));
    expect(big?.id).toBe(pageId);
    return {
      big: { ...big, id: 'big' },
      small: { ...view(await engine.readSegmentedPageHead(small)), id: 'small' },
      gone: { ...view(await engine.readSegmentedPageHead(gone)), id: 'gone' },
      missing: await engine.readSegmentedPageHead(pageId + small + gone + 1000) ?? null,
    };
  });

  // The manifest rows a segmented read tiles the body from: the live generation's when none is named, a named
  // generation's otherwise, none for a generation or page that has none. Occurrence ids map to ordinals.
  parityTest('readBodyManifestRows reads a generation\'s published rows in seq order', {
    methods: ['readBodyManifestRows', 'createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'openBodyStaging', 'stageSegmentTexts',
      'stageManifestRows', 'flipBodyGeneration', 'setBodyStagingState', 'transaction'],
  }, async (engine) => {
    const { pageId, occurrences } = await publishSegmented(engine, 'notes/big');
    const view = (rows: Awaited<ReturnType<typeof engine.readBodyManifestRows>>) => rows.map(r => {
      expect(r.sha256).toBeInstanceOf(Uint8Array);
      return {
        seq: num(r.seq), occurrence: occurrences.indexOf(Number(r.occurrence_id)), region: r.region, sha256: Buffer.from(r.sha256).toString('hex'),
        byte_start: num(r.byte_start), byte_len: num(r.byte_len), line_start: num(r.line_start), line_count: num(r.line_count),
        static_proj_bytes: num(r.static_proj_bytes), static_proj_lines: num(r.static_proj_lines), outline_count: num(r.outline_count),
        has_facts: r.has_facts, has_date: r.has_date, generation: num(r.generation),
      };
    });
    return {
      live: view(await engine.readBodyManifestRows(pageId, null)),
      gen1: view(await engine.readBodyManifestRows(pageId, 1)),
      gen0: view(await engine.readBodyManifestRows(pageId, 0)),
      missing: view(await engine.readBodyManifestRows(pageId + 1000, null)),
    };
  });
});
