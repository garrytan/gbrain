import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runEvalLongMemEval, resolveExpansionLimitSearchOpts } from '../src/commands/eval-longmemeval.ts';
import { createBenchmarkBrain } from '../src/eval/longmemeval/harness.ts';

const FIXTURE_PATH = join(import.meta.dir, 'fixtures', 'longmemeval-mini.jsonl');

async function withTmpDir<T>(fn: (tmp: string) => Promise<T>): Promise<T> {
  const tmp = mkdtempSync(join(tmpdir(), 'lme-search-config-cli-'));
  try {
    return await fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

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
});

describe('runEvalLongMemEval — --search-config CLI flag', () => {
  test('repeatable --search-config KEY=VAL pairs reach the isolated benchmark brain', async () => {
    const engine = await createBenchmarkBrain();
    try {
      await withTmpDir(async (tmp) => {
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
            '--search-config',
            'search.reranker.enabled=true',
            '--search-config',
            'search.reranker.model=llama-server-reranker:qwen3-reranker-4b',
          ],
          { engine },
        );

        expect(await engine.getConfig('search.reranker.enabled')).toBe('true');
        expect(await engine.getConfig('search.reranker.model'))
          .toBe('llama-server-reranker:qwen3-reranker-4b');
      });
    } finally {
      await engine.disconnect();
    }
  }, 60_000);

  test('--search-config wins over an injected runOpts.searchConfigSnapshot for the same key', async () => {
    const engine = await createBenchmarkBrain();
    try {
      await withTmpDir(async (tmp) => {
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
            '--search-config',
            'search.reranker.enabled=true',
          ],
          {
            engine,
            searchConfigSnapshot: {
              'search.reranker.enabled': 'false',
              // Key with no --search-config counterpart: the snapshot value
              // must still land untouched.
              'search.reranker.timeout_ms': '30000',
            },
          },
        );

        // Explicit CLI flag wins over the programmatic snapshot for the
        // overlapping key...
        expect(await engine.getConfig('search.reranker.enabled')).toBe('true');
        // ...while a snapshot key with no CLI counterpart is untouched.
        expect(await engine.getConfig('search.reranker.timeout_ms')).toBe('30000');
      });
    } finally {
      await engine.disconnect();
    }
  }, 60_000);

  test('--search-config VALUE-with-no-equals throws a clear usage error', async () => {
    // Codex review (PR #4770, round 2 Nit): an un-awaited `.rejects` lets
    // the test function return before the assertion settles, so a failing
    // assertion could surface after the test already reported pass.
    await expect(runEvalLongMemEval([FIXTURE_PATH, '--search-config', 'noequalssign'], {}))
      .rejects.toThrow(/--search-config must be KEY=VAL/);
  });
});

// Codex review (PR #4770, 2 rounds): resolveExpansionLimitSearchOpts is the
// pure extraction of the precedence rule that fixes the finding — a
// `search.expansion`/`search.searchLimit` key set via EITHER --search-config
// OR runOpts.searchConfigSnapshot must win over the CLI's
// --expansion/--top-k defaults, not be silently shadowed by them.
// Round 2 widened the signature from `searchConfig` alone to the caller-
// computed union `configuredSearchKeys` (round 1 missed the
// searchConfigSnapshot-only caller, nightly-probe-adapters.ts). Unit-tested
// directly (no engine/DB) so the exact defect stays pinned.
describe('resolveExpansionLimitSearchOpts', () => {
  test('nothing configured: both fields come from the CLI flags (unchanged default behavior)', () => {
    expect(resolveExpansionLimitSearchOpts({ expansion: false, topK: 8 }, new Set()))
      .toEqual({ limit: 8, expansion: false });
    expect(resolveExpansionLimitSearchOpts({ expansion: true, topK: 8 }, new Set()))
      .toEqual({ limit: 8, expansion: true });
  });

  test('search.expansion configured: expansion field is omitted so the injected config wins', () => {
    expect(
      resolveExpansionLimitSearchOpts({ expansion: false, topK: 8 }, new Set(['search.expansion'])),
    ).toEqual({ limit: 8 });
  });

  test('search.searchLimit configured: limit field is omitted so the injected config wins', () => {
    expect(
      resolveExpansionLimitSearchOpts({ expansion: false, topK: 8 }, new Set(['search.searchLimit'])),
    ).toEqual({ expansion: false });
  });

  test('both configured: both fields are omitted', () => {
    expect(
      resolveExpansionLimitSearchOpts(
        { expansion: false, topK: 8 },
        new Set(['search.expansion', 'search.searchLimit']),
      ),
    ).toEqual({});
  });

  test('an unrelated configured key does not affect expansion/limit resolution', () => {
    expect(
      resolveExpansionLimitSearchOpts({ expansion: true, topK: 8 }, new Set(['search.reranker.enabled'])),
    ).toEqual({ limit: 8, expansion: true });
  });
});

// The round-1 gap (this function ignored runOpts.searchConfigSnapshot) is
// fixed at the CALL SITE, not in this pure function: work() (in
// eval-longmemeval.ts) now computes `configuredSearchKeys` as the union of
// Object.keys(runOpts.searchConfigSnapshot ?? {}) and
// Object.keys(opts.searchConfig ?? {}) before calling
// resolveExpansionLimitSearchOpts — a snapshot-only key is indistinguishable
// from a --search-config key once unioned, so the cases above already cover
// it from this function's point of view. Not re-tested with a fake
// snapshot-only Set here since that would just be the same assertion under
// a different docstring.
