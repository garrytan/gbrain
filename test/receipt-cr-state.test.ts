/**
 * test/receipt-cr-state.test.ts — #4009.
 *
 * Extract receipts are audit artifacts written via putPage; nothing ever
 * ran them through the contextual-retrieval ladder, so every receipt was
 * born with contextual_retrieval_mode = NULL and tripped doctor's
 * contextual_retrieval_coverage warn ("N page(s) never evaluated against
 * CR ladder") — an unclearable-by-design warn that recurred on every
 * extraction run right after a `gbrain reindex --markdown`.
 *
 * Two-layer fix pinned here:
 *   1. writeReceipt stamps mode 'none' after putPage — receipts are born
 *      CR-evaluated (deliberately no CR wrapper; they're audit pages).
 *   2. Belt+braces: the doctor check excludes type='extract_receipt' from
 *      mode_null, because layer 1 is not permanent — a reindex that takes
 *      the DB fallback can clear the stamp, and it recurs per receipt.
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { writeReceipt, type ExtractReceiptInput } from '../src/core/extract/receipt-writer.ts';
import { checkContextualRetrievalCoverage } from '../src/commands/doctor/checks/calibration.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function receiptInput(overrides: Partial<ExtractReceiptInput> = {}): ExtractReceiptInput {
  return {
    kind: 'links',
    source_id: 'default',
    run_id: 'run-abcdef1234',
    round: 'single',
    extracted_at: '2026-08-21T00:00:00.000Z',
    total_rows: 3,
    cost_usd: 0,
    ...overrides,
  };
}

describe('receipts are born CR-evaluated (#4009)', () => {
  test('writeReceipt stamps contextual_retrieval_mode = none', async () => {
    const { slug } = await writeReceipt(engine, receiptInput());
    const rows = await engine.executeRaw<{ mode: string | null }>(
      `SELECT contextual_retrieval_mode AS mode FROM pages WHERE slug = $1 AND source_id = 'default'`,
      [slug],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].mode).toBe('none');
  });

  test('doctor calibration check does not count receipts in mode_null (belt+braces)', async () => {
    const { slug } = await writeReceipt(engine, receiptInput());
    // Simulate the non-permanence path: a reindex DB fallback clearing the stamp.
    await engine.executeRaw(
      `UPDATE pages SET contextual_retrieval_mode = NULL WHERE slug = $1`,
      [slug],
    );
    const check = await checkContextualRetrievalCoverage(engine);
    expect(check.message).not.toContain('never evaluated against CR ladder');
  });

  test('non-receipt markdown pages still count in mode_null', async () => {
    await engine.putPage('notes/plain', {
      type: 'note', title: 'Plain', compiled_truth: 'body', frontmatter: {},
    }, { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE pages SET contextual_retrieval_mode = NULL WHERE slug = 'notes/plain'`,
    );
    const check = await checkContextualRetrievalCoverage(engine);
    expect(check.message).toContain('never evaluated against CR ladder');
  });
});
