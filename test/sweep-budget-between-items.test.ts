/**
 * E-N2 (D17): the sweep budget stops the corpus pass BETWEEN items, never
 * mid-extraction. Before the fix the budget's abort signal reached the corpus
 * extraction, so an extraction slower than `--budget-ms` (claude-cli median
 * 8 s against the 5 s default) was cut off without a sidecar on every run:
 * each scheduled `sweep --once` paid one model call and finished nothing.
 *
 * Hermetic in-memory PGLite + chat-transport stub (sweep-corpus-windows harness).
 * The budget reads an injected clock that only the (stubbed) extraction
 * advances, by 400 ms per call: the passes before the corpus take no budget
 * however loaded the machine is, so the first extraction always starts, runs
 * past the 150 ms budget, and the budget then holds the next file. The stub
 * also really waits 400 ms, past the real budget timer, so an abort reaching
 * the extraction would still cut it off.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { CORPUS_INGESTED_SUFFIX, runMaintenanceSweep } from '../src/core/sweep.ts';
import { __setChatTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import type { CapabilityReport } from '../src/core/capability.ts';
import { toCorpusText } from '../src/core/transcripts/claude-code-jsonl.ts';
import { __resetCheckpointHarvestForTests } from '../src/core/context/checkpoint-harvest.ts';

const KEYED: CapabilityReport = {
  embeddings: { available: false },
  extraction: { available: true, provider: 'anthropic' },
  search: 'keyword-only',
  mode: 'keyed',
};

let engine: PGLiteEngine;
let dir: string;
let calls = 0;
/** The sweep's clock: advanced only by extractions. */
let clock = 0;
const now = () => clock;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => {
  await engine.disconnect();
});
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-sweep-budget-'));
  await engine.setConfig('dream.synthesize.session_corpus_dir', dir);
  calls = 0;
  clock = 1_000_000;
  __resetCheckpointHarvestForTests();
  __setChatTransportForTests(async (): Promise<ChatResult> => {
    calls++;
    clock += 400;
    await new Promise((r) => setTimeout(r, 400));
    return {
      text: JSON.stringify({ facts: [] }),
      blocks: [],
      stopReason: 'end',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:test-stub',
      providerId: 'anthropic',
    };
  });
});
afterEach(() => {
  __setChatTransportForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

test('an extraction slower than the budget finishes and writes its sidecar; the next file waits for a later sweep', async () => {
  const text = toCorpusText([{ role: 'user', text: 'I moved the weekly sync to Thursdays.' }, { role: 'assistant', text: 'Noted.' }]);
  writeFileSync(join(dir, 'a.txt'), text);
  writeFileSync(join(dir, 'b.txt'), text.replace('Thursdays', 'Fridays'));

  const r = await runMaintenanceSweep(engine, { sourceId: 'default', capabilities: KEYED, budgetMs: 150, batchLimit: 20, now });

  expect(calls).toBe(1);
  expect(existsSync(join(dir, 'a.txt' + CORPUS_INGESTED_SUFFIX))).toBe(true);
  expect(r.corpusIngested).toBe(1);
  expect(existsSync(join(dir, 'b.txt' + CORPUS_INGESTED_SUFFIX))).toBe(false);
  expect(r.skipped.some((s) => s.reason === 'budget_exhausted:corpus')).toBe(true);

  const again = await runMaintenanceSweep(engine, { sourceId: 'default', capabilities: KEYED, budgetMs: 150, batchLimit: 20, now });
  expect(calls).toBe(2);
  expect(again.corpusIngested).toBe(1);
  expect(existsSync(join(dir, 'b.txt' + CORPUS_INGESTED_SUFFIX))).toBe(true);
});
