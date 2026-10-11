/**
 * Fix wave 13 P1.18 (from PR #6400): OCR and multimodal embedding reserve on
 * the ambient BudgetTracker BEFORE the provider call, as embed() and chat do.
 * Protects: an exhausted tracker means zero OCR / multimodal provider calls;
 * OCR is sent with the explicit output bound its reservation holds; a
 * multimodal call settles at the provider's reported tokens when present;
 * outside a tracker nothing changes.
 * Seams: __setGenerateTextTransportForTests, a fetch stub (Voyage multimodal).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configureGateway, embedMultimodal, generateOcrText, resetGateway, withBudgetTracker, __setGenerateTextTransportForTests,
} from '../src/core/ai/gateway.ts';
import { BudgetExhausted, BudgetTracker } from '../src/core/budget/budget-tracker.ts';

const tmp = mkdtempSync(join(tmpdir(), 'gbrain-w13-reserve-'));
const tracker = (maxCostUsd?: number) => new BudgetTracker({ label: 'w13', auditPath: join(tmp, 'budget.jsonl'), ...(maxCostUsd !== undefined ? { maxCostUsd } : {}) });
const origFetch = globalThis.fetch;
afterEach(() => { __setGenerateTextTransportForTests(null); globalThis.fetch = origFetch; resetGateway(); });

describe('generateOcrText reserves before the call', () => {
  const ocrGateway = () => configureGateway({ expansion_model: 'anthropic:claude-haiku-4-5-20251001', env: { ANTHROPIC_API_KEY: 'sk-test-fake' } });
  test('an exhausted cap refuses with zero OCR calls; the call carries the bound it reserved', async () => {
    ocrGateway();
    const sent: Array<{ maxOutputTokens?: number }> = [];
    __setGenerateTextTransportForTests((async (opts: { maxOutputTokens?: number }) => { sent.push(opts); return { text: 'hi', usage: { inputTokens: 10, outputTokens: 2 } }; }) as never);
    await expect(withBudgetTracker(tracker(0.000001), () => generateOcrText(Buffer.from('x'), 'image/png'))).rejects.toBeInstanceOf(BudgetExhausted);
    expect(sent).toHaveLength(0);
    const t = tracker(1);
    await withBudgetTracker(t, () => generateOcrText(Buffer.from('x'), 'image/png'));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.maxOutputTokens).toBe(4096);
    expect(t.snapshot().callsRecorded).toBe(1);
  });
});

describe('embedMultimodal reserves before the call', () => {
  const voyage = (usage?: number) => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ data: [{ embedding: Array.from({ length: 1024 }, () => 0.1) }], ...(usage ? { usage: { total_tokens: usage } } : {}) }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    configureGateway({ embedding_model: 'voyage:voyage-multimodal-3', embedding_multimodal_model: 'voyage:voyage-multimodal-3', embedding_dimensions: 1024, env: { VOYAGE_API_KEY: 'test-key' } });
    return () => calls;
  };
  const image = [{ kind: 'image_base64' as const, data: 'aGk=', mime: 'image/png' }];

  test('an exhausted cap refuses with zero provider calls', async () => {
    const calls = voyage();
    await expect(withBudgetTracker(tracker(0.000001), () => embedMultimodal(image))).rejects.toBeInstanceOf(BudgetExhausted);
    expect(calls()).toBe(0);
  });

  test('the reported tokens settle the reservation; an overrun stops the next call', async () => {
    const calls = voyage(1_000_000);
    const t = tracker(0.1);
    await withBudgetTracker(t, () => embedMultimodal(image));
    expect(t.totalSpent).toBeCloseTo(0.12, 6);
    await expect(withBudgetTracker(t, () => embedMultimodal(image))).rejects.toBeInstanceOf(BudgetExhausted);
    expect(calls()).toBe(1);
  });

  test('outside a tracker nothing changes', async () => {
    const calls = voyage();
    expect(await embedMultimodal(image)).toHaveLength(1);
    expect(calls()).toBe(1);
  });
});
