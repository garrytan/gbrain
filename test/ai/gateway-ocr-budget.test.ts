/**
 * #4121 — generateOcrText() budget accounting (no OCR test existed anywhere).
 *
 * OCR was the last uninstrumented gateway spend path: a raw generateText()
 * with no tracker interaction. Pins:
 *   - success records one row with sub_label 'gateway.ocr' and chat's exact
 *     `${recipe.id}:${modelId}` model shape
 *   - transport failure records the pessimistic '.failed' row AND re-throws
 *     (importImageFile's ocr_failed_other contract is unchanged)
 *   - outside any withBudgetTracker scope it stays a budget no-op
 *   - the input estimate comes from prompt text + the image constant, never
 *     the base64 length (a 1MB image must not be billed as ~350k tokens)
 *
 * Hermetic via __setGenerateTextTransportForTests.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateOcrText,
  configureGateway,
  resetGateway,
  withBudgetTracker,
  __setGenerateTextTransportForTests,
} from '../../src/core/ai/gateway.ts';
import { BudgetTracker, _resetBudgetTrackerWarningsForTest } from '../../src/core/budget/budget-tracker.ts';

let tmp: string;
let auditPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-ocr-budget-'));
  auditPath = join(tmp, 'budget.jsonl');
  _resetBudgetTrackerWarningsForTest();
  configureGateway({
    expansion_model: 'anthropic:claude-haiku-4-5-20251001',
    env: { ANTHROPIC_API_KEY: 'sk-test-fake' },
  });
});

afterEach(() => {
  __setGenerateTextTransportForTests(null);
  resetGateway();
  rmSync(tmp, { recursive: true, force: true });
});

function readAudit(): any[] {
  return readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// A fat buffer: if base64 length ever leaks into the estimate, the recorded
// input for the FAILURE path (which uses the estimate) would be ~87k tokens.
const FAT_IMAGE = Buffer.alloc(256 * 1024, 7);

describe('generateOcrText budget accounting (#4121)', () => {
  test('success records one gateway.ocr row with chat model shape', async () => {
    __setGenerateTextTransportForTests(async () => ({
      text: '  extracted text  ',
      usage: { inputTokens: 900, outputTokens: 12 },
    }) as any);

    const tracker = new BudgetTracker({ label: 'test-ocr', auditPath });
    let text = '';
    await withBudgetTracker(tracker, async () => {
      text = await generateOcrText(FAT_IMAGE, 'image/png');
    });

    expect(text).toBe('extracted text');
    expect(tracker.snapshot().callsRecorded).toBe(1);
    const row = readAudit().find(r => r.event === 'record' || r.event === 'record_unpriced')!;
    expect(row.sub_label).toBe('gateway.ocr');
    expect(row.model).toBe('anthropic:claude-haiku-4-5-20251001');
    expect(row.input_tokens).toBe(900);
    expect(row.output_tokens).toBe(12);
  });

  test('transport failure records gateway.ocr.failed with a sane estimate and re-throws', async () => {
    __setGenerateTextTransportForTests(async () => {
      throw new Error('vision endpoint 500');
    });

    const tracker = new BudgetTracker({ label: 'test-ocr-fail', auditPath });
    let threw: unknown = null;
    await withBudgetTracker(tracker, async () => {
      try {
        await generateOcrText(FAT_IMAGE, 'image/png');
      } catch (err) {
        threw = err;
      }
    });

    expect(String(threw)).toContain('vision endpoint 500'); // caller contract: throw routes to ocr_failed_other
    const row = readAudit().find(r => r.sub_label === 'gateway.ocr.failed')!;
    expect(row).toBeTruthy();
    // Prompt text + image constant — NOT base64 length (256KiB → ~350k b64
    // chars → ~87k tokens if the bug ever creeps in).
    expect(row.input_tokens).toBeGreaterThan(1000);
    expect(row.input_tokens).toBeLessThan(10_000);
    expect(row.output_tokens).toBeGreaterThan(0);
  });

  test('outside any withBudgetTracker scope, OCR is a budget no-op', async () => {
    __setGenerateTextTransportForTests(async () => ({
      text: 'plain',
      usage: { inputTokens: 10, outputTokens: 2 },
    }) as any);
    const text = await generateOcrText(FAT_IMAGE, 'image/png');
    expect(text).toBe('plain'); // no throw, no tracker — just works
  });
});
