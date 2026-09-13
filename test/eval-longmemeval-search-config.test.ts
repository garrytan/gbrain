import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runEvalLongMemEval } from '../src/commands/eval-longmemeval.ts';
import { createBenchmarkBrain } from '../src/eval/longmemeval/harness.ts';

const FIXTURE_PATH = join(import.meta.dir, 'fixtures', 'longmemeval-mini.jsonl');

describe('runEvalLongMemEval — injected search config snapshot', () => {
  test('copies live search-mode/reranker config into the isolated benchmark brain', async () => {
    const engine = await createBenchmarkBrain();
    const tmp = mkdtempSync(join(tmpdir(), 'lme-search-config-'));
    try {
      await runEvalLongMemEval(
        [
          FIXTURE_PATH,
          '--keyword-only',
          '--retrieval-only',
          '--no-trajectory',
          '--limit',
          '1',
          '--output',
          join(tmp, 'out.jsonl'),
          '--mode',
          'tokenmax',
        ],
        {
          engine,
          searchConfigSnapshot: {
            'search.mode': 'balanced',
            'search.reranker.enabled': 'false',
            'search.reranker.model': 'llama-server-reranker:qwen3-reranker-4b',
            'search.reranker.timeout_ms': '30000',
          },
        },
      );

      expect(await engine.getConfig('search.mode')).toBe('tokenmax');
      expect(await engine.getConfig('search.reranker.enabled')).toBe('false');
      expect(await engine.getConfig('search.reranker.model'))
        .toBe('llama-server-reranker:qwen3-reranker-4b');
      expect(await engine.getConfig('search.reranker.timeout_ms')).toBe('30000');
    } finally {
      await engine.disconnect();
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  test('explicit --reranker off / --autocut off / --expansion-variant-budget beat a snapshot that turned them on', async () => {
    const engine = await createBenchmarkBrain();
    const tmp = mkdtempSync(join(tmpdir(), 'lme-search-config-pins-'));
    try {
      await runEvalLongMemEval(
        [
          FIXTURE_PATH,
          '--keyword-only', '--retrieval-only', '--no-trajectory', '--by-type',
          '--limit', '1',
          '--output', join(tmp, 'out.jsonl'),
          '--reranker', 'off',
          '--autocut', 'off',
          '--expansion-variant-budget', '0.5',
        ],
        {
          engine,
          searchConfigSnapshot: {
            'search.reranker.enabled': 'true',
            'search.autocut': 'true',
            'search.expansion_variant_budget': 'legacy',
          },
        },
      );
      expect(await engine.getConfig('search.reranker.enabled')).toBe('false');
      expect(await engine.getConfig('search.autocut')).toBe('false');
      expect(await engine.getConfig('search.expansion_variant_budget')).toBe('0.5');
      // The summary's run_config reports the PINNED values, not the snapshot's.
      const lines = readFileSync(join(tmp, 'out.jsonl'), 'utf8').split('\n').filter(l => l.trim());
      const summary = JSON.parse(lines[lines.length - 1]);
      expect(summary.kind).toBe('by_type_summary');
      expect(summary.run_config.reranker.enabled).toBe(false);
      expect(summary.run_config.autocut).toBe(false);
      expect(summary.run_config.expansion_variant_budget).toBe(0.5);
    } finally {
      await engine.disconnect();
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
