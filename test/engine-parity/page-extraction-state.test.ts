/**
 * BrainEngine parity — the extraction watermark and partial-input receipt (engine-sql/page-extraction-state.ts;
 * extraction-watermark.ts owns the policy): the live page's watermark read, the commit of a successful extraction, the
 * receipt read, the row delete and the receipt upsert, the rows a page delete, a purge and a source delete remove, and the
 * two doctor reads that list the receipts.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: readPageExtractionWatermark, commitPageExtraction, readPageExtractionReceipt, clearPageExtractionState and
 *    writePageExtractionReceipt return the same answer, and leave the same row, on every engine arm (PGLite always;
 *    Postgres with DATABASE_URL; the Rust arm through test/engine-parity/harness.ts); a hard page delete, a purge and a
 *    source delete drop the page's rows; listAmbiguousExtractionInputs and listExtractionInputReceipts list them.
 *  - Regression: a Rust brain kept no page_extraction_state, so the five statements failed softly (a warning once), the
 *    extraction watermark and the partial-input receipt were never stored, extraction re-read large pages from the start, and
 *    doctor's extraction_input_truncated never saw a receipt.
 *  - Why existing coverage misses it: extraction-watermark.ts sent the statements through `executeRaw`, which the parity
 *    cases cannot call (D18), and caught every error.
 *  - Seam: none. A timestamp is not compared (the arms stamp their own clocks); the doctor samples are compared as sets because
 *    rows written in one millisecond have no order.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import {
  commitExtractionPlan, planExtraction, readExtractionReceipt, readPageWatermark, setExtractionReceipt,
  type ExtractionPipeline, type InputTruncated,
} from '../../src/core/extraction-watermark.ts';

const { parityTest } = parityArms(testBackends());

const NOTE = { type: 'note' as const, title: 'Extraction note', compiled_truth: 'An extraction example.', timeline: '' };
const BODY = `${'First paragraph of a long conversation. '.repeat(40)}\n`;

async function put(engine: BrainEngine, slug: string, sourceId = 'default'): Promise<number> {
  await engine.putPage(slug, { ...NOTE, title: slug }, { sourceId });
  const id = await engine.readPageIdInSource(slug, sourceId);
  expect(id).not.toBeNull();
  return id!;
}

/** What a refused write was refused for: PGLite's foreign key (23503) or CHECK (23514), the Rust store's constraint_violation. */
async function refusal(run: Promise<void>): Promise<string> {
  try {
    await run;
    return 'stored';
  } catch (error) {
    const code = String((error as { code?: unknown }).code);
    if (code === '23503' || code === '23514' || code === 'constraint_violation') return 'constraint';
    return `other:${code}`;
  }
}

describe('engine parity: page extraction state', () => {
  parityTest('the watermark read, commit and receipt round trip through the extraction watermark policy', {
    methods: ['putPage', 'readPageIdInSource', 'readPageExtractionWatermark', 'commitPageExtraction', 'readPageExtractionReceipt',
      'clearPageExtractionState', 'writePageExtractionReceipt'],
  }, async (engine) => {
    const id = await put(engine, 'calls/long');
    const none = await readPageWatermark(engine, 'default', 'calls/long', 'facts_backstop');
    const missing = await readPageWatermark(engine, 'default', 'calls/missing', 'facts_backstop');

    // A first extraction of a body past the cap reads the head: the watermark is stored with a head receipt.
    const head = planExtraction(BODY, none.stored, { cap: 200, pipeline: 'facts_backstop', emptyTail: 'skip' });
    await commitExtractionPlan(engine, id, head);
    const afterHead = await readPageWatermark(engine, 'default', 'calls/long', 'facts_backstop');
    const headReceipt = await readExtractionReceipt(engine, id, 'facts_backstop');

    // The appended text is read from the watermark; a complete tail read keeps the head's gap.
    const grown = `${BODY}Appended line.\n`;
    const tail = planExtraction(grown, afterHead.stored, { cap: 200, pipeline: 'facts_backstop', emptyTail: 'skip' });
    await commitExtractionPlan(engine, id, tail);
    const afterTail = await readPageWatermark(engine, 'default', 'calls/long', 'facts_backstop');
    const tailReceipt = await readExtractionReceipt(engine, id, 'facts_backstop');

    // A full read (a body inside the cap) clears the receipt.
    const full = planExtraction('Short.', afterTail.stored, { cap: 200, pipeline: 'facts_backstop', emptyTail: 'skip' });
    await commitExtractionPlan(engine, id, full);
    const afterFull = await readPageWatermark(engine, 'default', 'calls/long', 'facts_backstop');
    const fullReceipt = await readExtractionReceipt(engine, id, 'facts_backstop');

    // The pipelines of one page keep their own rows; a receipt write keeps a row's watermark and version, a clear deletes the row.
    const other = await readPageWatermark(engine, 'default', 'calls/long', 'extract_atoms');
    const skipped: InputTruncated = { kind: 'skipped_too_large', pipeline: 'conversation_facts', processed_chars: 0, total_bytes: 9000, cap_bytes: 8000, origin: 'page' };
    await setExtractionReceipt(engine, id, 'conversation_facts', skipped);
    const receiptOnly = await readPageWatermark(engine, 'default', 'calls/long', 'conversation_facts');
    const skippedBack = await readExtractionReceipt(engine, id, 'conversation_facts');
    await engine.commitPageExtraction({ pageId: id, pipeline: 'conversation_facts', pipelineVersion: 1, watermarkBytes: 77, watermarkSha256: 'abc', receipt: null, keepReceipt: true });
    await setExtractionReceipt(engine, id, 'conversation_facts', { kind: 'no_messages', pipeline: 'conversation_facts', processed_chars: 0 });
    const keptWatermark = await readPageWatermark(engine, 'default', 'calls/long', 'conversation_facts');
    await setExtractionReceipt(engine, id, 'conversation_facts', null);
    const cleared = await readPageWatermark(engine, 'default', 'calls/long', 'conversation_facts');
    const clearedReceipt = await readExtractionReceipt(engine, id, 'conversation_facts');

    const modes = [head.mode, tail.mode, full.mode];
    expect(modes).toEqual(['head', 'tail', 'full']);
    expect(afterHead.stored).not.toBeNull();
    expect(headReceipt?.kind).toBe('head');
    expect(tailReceipt?.kind).toBe('head');
    expect(fullReceipt).toBeNull();
    expect(keptWatermark.stored).toEqual({ pipelineVersion: 1, bytes: 77, sha256: 'abc' });
    expect(cleared.stored).toBeNull();
    const idLess = <T extends { pageId: number | null }>(r: T) => ({ ...r, pageId: r.pageId === null ? null : 'id' });
    return {
      modes, none: idLess(none), missing, afterHead: idLess(afterHead), headReceipt, afterTail: idLess(afterTail), tailReceipt,
      afterFull: idLess(afterFull), fullReceipt, other: idLess(other), receiptOnly: idLess(receiptOnly), skippedBack,
      keptWatermark: idLess(keptWatermark), cleared: idLess(cleared), clearedReceipt,
    };
  });

  parityTest('the engine members answer the same rows, and a write the table constraints refuse stores nothing', {
    methods: ['putPage', 'readPageIdInSource', 'readPageExtractionWatermark', 'commitPageExtraction', 'readPageExtractionReceipt',
      'clearPageExtractionState', 'writePageExtractionReceipt'],
  }, async (engine) => {
    const id = await put(engine, 'notes/a');
    const empty = await engine.readPageExtractionWatermark('default', 'notes/a', 'extract_atoms');
    const missing = await engine.readPageExtractionWatermark('default', 'notes/zzz', 'extract_atoms');
    await engine.commitPageExtraction({ pageId: id, pipeline: 'extract_atoms', pipelineVersion: 1, watermarkBytes: 0, watermarkSha256: 'e3b0',
      receipt: { kind: 'tail_window', processed_chars: 5, total_chars: 9, pipeline: 'extract_atoms' }, keepReceipt: false });
    const committed = await engine.readPageExtractionWatermark('default', 'notes/a', 'extract_atoms');
    const receipt = await engine.readPageExtractionReceipt(id, 'extract_atoms');
    const noRow = await engine.readPageExtractionReceipt(id, 'facts_backstop');
    await engine.clearPageExtractionState(id, 'extract_atoms');
    await engine.clearPageExtractionState(id, 'extract_atoms');
    const afterClear = await engine.readPageExtractionReceipt(id, 'extract_atoms');

    const refused = {
      noPage: await refusal(engine.commitPageExtraction({ pageId: id + 999, pipeline: 'extract_atoms', pipelineVersion: 1, watermarkBytes: 1, watermarkSha256: 'x', receipt: null, keepReceipt: false })),
      badPipeline: await refusal(engine.commitPageExtraction({ pageId: id, pipeline: 'nope' as ExtractionPipeline, pipelineVersion: 1, watermarkBytes: 1, watermarkSha256: 'x', receipt: null, keepReceipt: false })),
      negative: await refusal(engine.commitPageExtraction({ pageId: id, pipeline: 'extract_atoms', pipelineVersion: 1, watermarkBytes: -1, watermarkSha256: 'x', receipt: null, keepReceipt: false })),
      receiptNoPage: await refusal(engine.writePageExtractionReceipt(id + 999, 'extract_atoms', 1, { kind: 'head' })),
      receiptBadPipeline: await refusal(engine.writePageExtractionReceipt(id, 'nope' as ExtractionPipeline, 1, { kind: 'head' })),
    };
    const stored = await engine.readPageExtractionWatermark('default', 'notes/a', 'extract_atoms');
    expect(refused).toEqual({ noPage: 'constraint', badPipeline: 'constraint', negative: 'constraint', receiptNoPage: 'constraint', receiptBadPipeline: 'constraint' });
    return { empty: { ...empty, page_id: 'id' }, missing, committed: { ...committed, page_id: 'id' }, receipt, noRow, afterClear, refused, stored: { ...stored, page_id: 'id' } };
  });

  parityTest('a hard delete, a purge and a source delete remove the rows; a soft delete keeps them', {
    methods: ['putPage', 'readPageIdInSource', 'readPageExtractionWatermark', 'commitPageExtraction', 'readPageExtractionReceipt',
      'softDeletePage', 'restorePage', 'deletePage', 'purgeDeletedPages', 'deleteSourceRecord'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const receipt = { kind: 'head', pipeline: 'facts_backstop', processed_chars: 8000, total_chars: 9000 };
    const seed = async (slug: string, source = 'default') => {
      const id = await put(engine, slug, source);
      for (const pipeline of ['facts_backstop', 'extract_atoms'] as const) {
        await engine.commitPageExtraction({ pageId: id, pipeline, pipelineVersion: 1, watermarkBytes: 10, watermarkSha256: 'abc', receipt, keepReceipt: false });
      }
      return id;
    };
    const rows = async (id: number) => (await Promise.all((['facts_backstop', 'extract_atoms'] as const).map((p) => engine.readPageExtractionReceipt(id, p))))
      .filter((r) => r !== null).length;
    const soft = await seed('notes/soft');
    const hard = await seed('notes/hard');
    const purged = await seed('notes/purged');
    const inSource = await seed('notes/in-source', 'other');

    await engine.softDeletePage('notes/soft');
    const softKept = await rows(soft);
    const softRead = await engine.readPageExtractionWatermark('default', 'notes/soft', 'facts_backstop');
    await engine.restorePage('notes/soft');
    const restored = await engine.readPageExtractionWatermark('default', 'notes/soft', 'facts_backstop');

    await engine.deletePage('notes/hard');
    const hardRows = await rows(hard);
    // A page created again under the slug starts with no rows.
    const again = await put(engine, 'notes/hard');
    const againRead = await engine.readPageExtractionWatermark('default', 'notes/hard', 'facts_backstop');

    await engine.softDeletePage('notes/purged');
    const purgedBefore = await rows(purged);
    await engine.purgeDeletedPages(0);
    const purgedRows = await rows(purged);

    const sourceBefore = await rows(inSource);
    const deleted = await engine.deleteSourceRecord('other');
    const sourceRows = await rows(inSource);
    const survivor = await rows(soft);

    expect({ softKept, hardRows, purgedBefore, purgedRows, sourceBefore, sourceRows, survivor }).toEqual(
      { softKept: 2, hardRows: 0, purgedBefore: 2, purgedRows: 0, sourceBefore: 2, sourceRows: 0, survivor: 2 });
    expect(again).not.toBe(hard);
    return {
      softKept, softRead, restored: { ...restored, page_id: 'id' }, hardRows, againRead: { ...againRead, page_id: 'id' }, purgedBefore, purgedRows,
      sourceBefore, deleted, sourceRows, survivor,
    };
  });

  parityTest('the doctor lists the extraction receipts by pipeline and kind and the pages held for an undetected format', {
    methods: ['putPage', 'readPageIdInSource', 'writePageExtractionReceipt', 'softDeletePage', 'listExtractionInputReceipts', 'listAmbiguousExtractionInputs'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const a = await put(engine, 'notes/a');
    const b = await put(engine, 'notes/b');
    const c = await put(engine, 'notes/c', 'other');
    const gone = await put(engine, 'notes/gone');
    await engine.writePageExtractionReceipt(a, 'extract_atoms', 1, { kind: 'head' });
    await engine.writePageExtractionReceipt(b, 'extract_atoms', 1, { kind: 'head' });
    await engine.writePageExtractionReceipt(c, 'facts_backstop', 1, { kind: 'tail_window' });
    await engine.writePageExtractionReceipt(gone, 'extract_atoms', 1, { kind: 'head' });
    // A receipt with no kind reads `unknown`; a chosen format is not a truncation; a held page is listed by itself.
    await engine.writePageExtractionReceipt(a, 'conversation_facts', 1, { other: 1 });
    await engine.writePageExtractionReceipt(b, 'conversation_facts', 1, { kind: 'grammar_chosen', grammar: 'slack' });
    await engine.writePageExtractionReceipt(c, 'conversation_facts', 1, { kind: 'detection_ambiguous', grammars: { slack: 2, irc: 1 } });
    await engine.softDeletePage('notes/gone');
    const groups = (await engine.listExtractionInputReceipts()).map((g) => ({ ...g, samples: [...g.samples].sort() }));
    const held = await engine.listAmbiguousExtractionInputs();
    expect(groups.map((g) => `${g.pipeline}/${g.kind}/${g.pages}`)).toEqual(['conversation_facts/unknown/1', 'extract_atoms/head/2', 'facts_backstop/tail_window/1']);
    expect(held.map((h) => h.page)).toEqual(['other:notes/c']);
    return { groups, held };
  });
});
