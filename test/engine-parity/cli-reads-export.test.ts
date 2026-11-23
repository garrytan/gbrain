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
import { createSource, parityArms, restrictFolder } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { flipInput, manifestRow, pageMeta, segmentText, stagingInput } from '../helpers/page-body-fixtures.ts';
import { stageGeneration } from '../helpers/page-body-fixtures.ts';
import type { BodyFlipInput, ManifestRowInput } from '../../src/core/page-body/types.ts';
import { confirmBodyPin, openSegmentedBody, projectedOutline } from '../../src/core/page-body/read-range.ts';
import { untiledSegmentedPages } from '../../src/core/page-body/body-tiling.ts';
import { REVISION_BACKFILL_PENDING } from '../../src/core/page-state/types.ts';
import { readExportPages, readExportWithdrawals } from '../../src/core/export-snapshot.ts';
import { parseFactsFenceFor, renderFactsTable } from '../../src/core/facts-fence.ts';

const { parityTest } = parityArms(testBackends());

const SEGMENTS = [segmentText('# Intro\nfirst segment\n'), segmentText('## Next\nsecond segment\n')];

/** Publish SEGMENTS as generation 1 of segmented page `slug`, through typed members only. */
async function publishSegmented(engine: BrainEngine, slug: string, opts: { row?: (seq: number) => Partial<ManifestRowInput>; flip?: Partial<BodyFlipInput> } = {}) {
  const { id: pageId } = await engine.createSegmentedPageShell(slug, pageMeta('Big page'), { sourceId: 'default' });
  const occurrences = await engine.allocateBodyOccurrenceIds(SEGMENTS.length);
  const staging = stagingInput({ slug, pageId, mode: 'create' });
  await engine.transaction(async (tx) => {
    await tx.openBodyStaging(staging);
    await tx.stageSegmentTexts('default', SEGMENTS, { stagingId: staging.id });
    let byteStart = 0;
    await tx.stageManifestRows(SEGMENTS.map((text, seq) => {
      const row = { ...manifestRow({ pageId, occurrenceId: occurrences[seq]!, genFrom: 1, seq, text, byteStart, stagingId: staging.id }), ...opts.row?.(seq) };
      byteStart += text.body.byteLength;
      return row;
    }));
  });
  await engine.transaction(async (tx) => {
    await tx.flipBodyGeneration(flipInput(pageId, 0, staging.id, SEGMENTS, opts.flip));
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

  // A purge tombstone is a ledger row too (`purged` true, its time the purge's): the export drops the purged fact's row.
  parityTest('listExportWithdrawals lists purge tombstones beside withdrawals', {
    methods: ['listExportWithdrawals', 'insertFactWithdrawal', 'insertFactPurge'],
  }, async (engine) => {
    await engine.insertFactWithdrawal('default', 'world', 'Alice founded Acme', '*', '2026-01-03T00:00:00.000Z');
    const before = Date.now() - 60_000;
    await engine.insertFactPurge({ sourceId: 'default', visibility: 'private', subject: 'people/bob', factHash: 'a1b2c3',
      requestId: null, actor: 'owner:local', reason: 'parity' });
    await engine.insertFactPurge({ sourceId: 'default', visibility: 'world', subject: '*', factHash: 'ffff', requestId: null, actor: null, reason: null });
    const rows = await engine.listExportWithdrawals('default');
    for (const row of rows) expect(row.withdrawn_at).toBeInstanceOf(Date);
    return rows.map(r => ({ ...r,
      // A tombstone's time is the engine's clock at the purge, so it is compared by relation, not value.
      withdrawn_at: r.purged ? r.withdrawn_at.getTime() >= before : r.withdrawn_at.toISOString() }));
  });

  // The pages the export writes, looked up by id: live ones only, with their tags in tag order.
  parityTest('readExportPageRows reads live pages by id with their tags', {
    methods: ['readExportPageRows', 'putPage', 'addTag', 'softDeletePage', 'getPage'],
  }, async (engine) => {
    await engine.putPage('export/a', { type: 'note', title: 'A', compiled_truth: 'alpha', timeline: '- 2026: one', frontmatter: { status: 'v', nested: { bb: 1, a: 2 }, n: 2 } });
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
        compiled_truth: page.compiled_truth, timeline: page.timeline, frontmatter: page.frontmatter, tags,
        // The export writes keys in the order the row gives them: jsonb's (shorter keys first, then by bytes), at every depth.
        keyOrder: JSON.stringify(page.frontmatter) }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  });

  // The overlay compares fact rows in the fingerprint's normalized form, so every arm must lower-case and fold whitespace
  // alike, by one explicit list whatever the database locale: U+0085 folds (Postgres en_US.utf8's [[:space:]] leaves it
  // out), U+1680 and U+00A0 do not (en_US.utf8 folds U+1680).
  parityTest('normalizeFenceLines lower-cases and folds whitespace line by line', {
    methods: ['normalizeFenceLines'],
  }, async (engine) => {
    const bodies = ['MiXeD\t  Claim\r\nSecond   LINE\n', '', 'Ünïcode\u0085x\u00a0y\u2003z\u1680w', 'one'];
    const timelines = ['', 'A\n\nB', 'x', ''];
    const rows = await engine.normalizeFenceLines(bodies, timelines);
    return [...rows].map(r => ({ ...r, i: Number(r.i) })).sort((a, b) => a.i - b.i);
  });

  // A withdrawal strikes its claim in the export on every arm, whatever whitespace spells it: the ledger hash and the
  // overlay fold one explicit whitespace list. A claim withdrawn with U+0085 matches the fence row spelled with a space
  // (and the reverse); U+1680 is not whitespace to the fingerprint, so that row stays live.
  parityTest('a withdrawal of a claim holding U+0085 exports its fence row struck', {
    methods: ['insertFactWithdrawal', 'listExportWithdrawals', 'readExportWithdrawalLedgerBytes', 'readExportPageRows', 'normalizeFenceLines', 'putPage', 'getPage'],
  }, async (engine) => {
    const fence = (...claims: string[]) => renderFactsTable(claims.map((claim, i) => ({ rowNum: i + 1, claim, kind: 'fact', confidence: 1,
      visibility: 'world', notability: 'medium', active: true, context: '' })));
    await engine.insertFactWithdrawal('default', 'world', 'Alpha\u0085withdrawn claim', '*', '2026-01-03T00:00:00.000Z');
    await engine.insertFactWithdrawal('default', 'world', 'Beta withdrawn claim', '*', '2026-01-04T00:00:00.000Z');
    await engine.insertFactWithdrawal('default', 'world', 'Gamma kept claim', '*', '2026-01-05T00:00:00.000Z');
    await engine.putPage('export/fenced', { type: 'note', title: 'Fenced',
      compiled_truth: 'Lead.\n\n' + fence('Alpha withdrawn claim', 'Beta\u0085withdrawn claim', 'Gamma\u1680kept claim', 'A live claim') });
    const page = (await engine.getPage('export/fenced'))!;
    const withdrawals = await readExportWithdrawals(engine, 'default');
    const [snapshot] = await readExportPages(engine, [{ id: String(page.id), source_id: 'default', slug: 'export/fenced' }], withdrawals);
    const rows = parseFactsFenceFor(snapshot!.page.compiled_truth, { slug: 'export/fenced' }).facts
      .map(f => ({ claim: f.claim, active: f.active, forgotten: f.forgotten ?? false, validUntil: f.validUntil ?? null }));
    expect(rows.map(r => r.forgotten)).toEqual([true, true, false, false]);
    return { rows, hashes: withdrawals.map(w => w.fact_hash).sort() };
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

  // The entry state and protected regions a segmented read projects each segment with, read a batch of occurrences
  // at a time: only the named occurrences of the named generation, none for a generation or page that has none.
  parityTest('readBodyManifestMeta reads the entry state and protected regions of named occurrences', {
    methods: ['readBodyManifestMeta', 'createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'openBodyStaging', 'stageSegmentTexts',
      'stageManifestRows', 'flipBodyGeneration', 'setBodyStagingState', 'transaction'],
  }, async (engine) => {
    const { pageId, occurrences } = await publishSegmented(engine, 'notes/big');
    const toJson = (v: unknown) => typeof v === 'string' ? JSON.parse(v) as unknown : v;
    const view = (rows: Awaited<ReturnType<typeof engine.readBodyManifestMeta>>) => rows.map(r => ({
      occurrence: occurrences.indexOf(Number(r.occurrence_id)), entry_state: toJson(r.entry_state), protected_regions: toJson(r.protected_regions),
    })).sort((a, b) => a.occurrence - b.occurrence);
    return {
      all: view(await engine.readBodyManifestMeta(pageId, occurrences, 1)),
      some: view(await engine.readBodyManifestMeta(pageId, [occurrences[1]!], 1)),
      none: view(await engine.readBodyManifestMeta(pageId, [], 1)),
      gen0: view(await engine.readBodyManifestMeta(pageId, occurrences, 0)),
      missing: view(await engine.readBodyManifestMeta(pageId + 1000, occurrences, 1)),
    };
  });

  // The sources an export of every source writes a folder rulebook for: each source with an access policy, in id
  // order. A brain with no folder rules lists none (the Rust store keeps none; seeding one stops on its typed refusal).
  parityTest('listAccessPolicySourceIds lists no source on a brain without folder rules', { methods: ['listAccessPolicySourceIds'] }, async (engine) => {
    return engine.listAccessPolicySourceIds();
  });

  parityTest('listAccessPolicySourceIds lists each source with folder rules in id order', { methods: ['listAccessPolicySourceIds'] }, async (engine, backend) => {
    await createSource(engine, backend, 'work');
    await restrictFolder(engine, backend, 'work', 'private/', 'rule');
    await restrictFolder(engine, backend, 'default', 'queued/', 'pending');
    return engine.listAccessPolicySourceIds();
  });

  // A live segmented read whose readable rows do not cover the body (a role that cannot read every manifest row)
  // reads the page's live generation once more: a body published between the reads is read again, an unchanged
  // generation refuses page_body_rows_unreadable. The handle hides the last live row from the first read only.
  parityTest('a live segmented read that does not tile reads the live generation again', {
    methods: ['readSegmentedPageHead', 'readBodyManifestRows', 'createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'openBodyStaging',
      'stageSegmentTexts', 'stageManifestRows', 'flipBodyGeneration', 'setBodyStagingState', 'transaction'],
  }, async (engine) => {
    const { pageId, occurrences } = await publishSegmented(engine, 'notes/big');
    let hide = 0;
    let publishOnHide = false;
    const hiding = new Proxy(engine, {
      get(target, key, receiver) {
        if (key !== 'readBodyManifestRows') return Reflect.get(target, key, receiver);
        return async (id: number, generation: number | null) => {
          const rows = await target.readBodyManifestRows(id, generation);
          if (generation !== null || hide <= 0) return rows;
          hide--;
          if (publishOnHide) {
            publishOnHide = false;
            const next = await stageGeneration(target, { pageId, slug: 'notes/big', genFrom: 2, texts: SEGMENTS });
            await target.transaction(async (tx) => {
              await tx.flipBodyGeneration(flipInput(pageId, 1, next.stagingId, SEGMENTS, { closeOccurrences: occurrences }));
              await tx.setBodyStagingState(next.stagingId, 'committed');
            });
          }
          return rows.slice(0, -1);
        };
      },
    });
    hide = 3;
    const refused = await openSegmentedBody(hiding, { pageId }).then(() => null, (e: { code?: string; detail?: string }) => ({ code: e.code, detail: e.detail }));
    hide = 1;
    publishOnHide = true;
    const reread = await openSegmentedBody(hiding, { pageId });
    expect(refused?.code).toBe('page_body_rows_unreadable');
    expect(reread.generation).toBe(2);
    return { refused, reread: { generation: reread.generation, rows: reread.rows.length, bytes: reread.bodyBytes }, hidden_left: hide };
  });

  // A pinned read checks the page again before its text is returned: the same revision and generation pass, a later
  // publish refuses revision_changed.
  parityTest('confirmBodyPin passes at the pinned revision and refuses after a publish', {
    methods: ['readSegmentedPageHead', 'readBodyManifestRows', 'createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'openBodyStaging',
      'stageSegmentTexts', 'stageManifestRows', 'flipBodyGeneration', 'setBodyStagingState', 'transaction'],
  }, async (engine) => {
    const { pageId, occurrences } = await publishSegmented(engine, 'notes/big');
    const head = await engine.readSegmentedPageHead(pageId);
    const pin = { revision: head?.revision == null ? REVISION_BACKFILL_PENDING : String(head.revision), generation: 1 };
    const body = await openSegmentedBody(engine, { pageId, pin });
    const before = await confirmBodyPin(engine, body).then(() => 'ok', (e: { code?: string; canonical?: string }) => e.canonical ?? e.code);
    const next = await stageGeneration(engine, { pageId, slug: 'notes/big', genFrom: 2, texts: SEGMENTS });
    await engine.transaction(async (tx) => {
      await tx.flipBodyGeneration(flipInput(pageId, 1, next.stagingId, SEGMENTS, { closeOccurrences: occurrences }));
      await tx.setBodyStagingState(next.stagingId, 'committed');
    });
    const after = await confirmBodyPin(engine, body).then(() => 'ok', (e: { code?: string; canonical?: string }) => e.canonical ?? e.code);
    expect(before).toBe('ok');
    expect(after).toBe('revision_changed');
    return { before, after };
  });

  // The stored outline of a segmented page, paged by heading index: each heading's projected byte offset, read from
  // the named occurrences' manifest metadata without any segment text.
  parityTest('projectedOutline reads the stored headings of a segmented page', {
    methods: ['readBodyManifestOutline', 'readSegmentedPageHead', 'readBodyManifestRows', 'createSegmentedPageShell', 'allocateBodyOccurrenceIds',
      'openBodyStaging', 'stageSegmentTexts', 'stageManifestRows', 'flipBodyGeneration', 'setBodyStagingState', 'transaction'],
  }, async (engine) => {
    const titles = ['Intro', 'Next'];
    const { pageId, occurrences } = await publishSegmented(engine, 'notes/big', {
      row: seq => ({ outline: [{ level: seq + 1, text: titles[seq]!, proj_byte: 0 }], factsSlots: [] }),
    });
    const body = await openSegmentedBody(engine, { pageId });
    const toJson = (v: unknown) => typeof v === 'string' ? JSON.parse(v) as unknown : v;
    const stored = (await engine.readBodyManifestOutline(pageId, occurrences, 1))
      .map(r => ({ occurrence: occurrences.indexOf(Number(r.occurrence_id)), outline: toJson(r.outline), facts_slots: toJson(r.facts_slots) }))
      .sort((a, b) => a.occurrence - b.occurrence);
    return {
      stored,
      all: await projectedOutline(engine, body, 0, 10),
      second: await projectedOutline(engine, body, 1, 1),
      past: await projectedOutline(engine, body, 5, 1),
    };
  });

  // The segmented body's small typed reads: the forced cuts of a generation, the row holding a byte offset, and the
  // size a segmented version records for a generation. Each answers null or empty outside the published rows.
  parityTest('segmented reads find forced cuts, the row at an offset and a version\'s recorded size', {
    methods: ['listForcedCutSeqs', 'readManifestSeqAt', 'readSegmentedVersionBodyBytes', 'createVersion', 'createSegmentedPageShell',
      'allocateBodyOccurrenceIds', 'openBodyStaging', 'stageSegmentTexts', 'stageManifestRows', 'flipBodyGeneration', 'setBodyStagingState',
      'transaction'],
  }, async (engine) => {
    const { pageId } = await publishSegmented(engine, 'notes/big', { row: seq => ({ cutKind: seq === 1 ? 'forced' : 'heading' }) });
    const first = SEGMENTS[0]!.body.byteLength;
    const forced = await engine.listForcedCutSeqs(pageId, 1);
    const seqAt = {
      start: await engine.readManifestSeqAt(pageId, 1, 0),
      lastOfFirst: await engine.readManifestSeqAt(pageId, 1, first - 1),
      second: await engine.readManifestSeqAt(pageId, 1, first),
      past: await engine.readManifestSeqAt(pageId, 1, 100000),
      before: await engine.readManifestSeqAt(pageId, 1, -1),
      unpublished: await engine.readManifestSeqAt(pageId, 0, 0),
    };
    const unversioned = await engine.readSegmentedVersionBodyBytes(pageId, 1);
    await engine.createVersion('notes/big');
    const versioned = await engine.readSegmentedVersionBodyBytes(pageId, 1);
    const otherGeneration = await engine.readSegmentedVersionBodyBytes(pageId, 2);
    expect(forced).toEqual([1]);
    expect(seqAt).toEqual({ start: 0, lastOfFirst: 0, second: 1, past: 1, before: null, unpublished: null });
    expect(unversioned).toBeNull();
    expect(versioned).toBe(SEGMENTS.reduce((n, t) => n + t.body.byteLength, 0));
    expect(otherGeneration).toBeNull();
    return {
      forced, seqAt, unversioned, versioned, otherGeneration,
      missing: [await engine.listForcedCutSeqs(999999, 1), await engine.readManifestSeqAt(999999, 1, 0), await engine.readSegmentedVersionBodyBytes(999999, 1)],
    };
  });

  // GST-1209's doctor and repair read: the live segmented pages whose live rows do not tile the body. A publish refuses
  // rows that do not tile (generation_incomplete), so no typed write can damage a page: here every segmented page tiles
  // and none is listed, whatever the source, slug and limit narrowing. The damaged pages are pinned on the SQL arms by
  // test/large-pages/segmented-tiling-repair.test.ts and on the store by its cargo test
  // (untiled_pages_list_a_short_or_gapped_live_generation).
  parityTest('listUntiledSegmentedPages lists no page whose live rows tile the body', {
    methods: ['listUntiledSegmentedPages', 'createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'openBodyStaging', 'stageSegmentTexts',
      'stageManifestRows', 'flipBodyGeneration', 'setBodyStagingState', 'transaction', 'softDeletePage'],
  }, async (engine) => {
    await publishSegmented(engine, 'notes/tiled');
    await publishSegmented(engine, 'notes/deleted');
    await engine.softDeletePage('notes/deleted');
    const lists = {
      all: await untiledSegmentedPages(engine),
      bySlug: await untiledSegmentedPages(engine, { slugs: ['notes/tiled', 'notes/deleted'] }),
      bySource: await engine.listUntiledSegmentedPages({ sourceIds: ['default'] }),
      none: await untiledSegmentedPages(engine, { limit: 0 }),
    };
    const negative = await untiledSegmentedPages(engine, { limit: -1 }).then(() => 'listed', () => 'refused');
    expect(lists).toEqual({ all: [], bySlug: [], bySource: [], none: [] });
    expect(negative).toBe('refused');
    return { lists, negative };
  });
});
