/**
 * Hermetic table test for `gbrain eval longmemeval` argument validation: every
 * invalid value exits 1 from parseArgs BEFORE any work (no dataset read, no
 * output file, no engine), and `--help` exits 0 without touching anything.
 *
 * The dataset path is deliberately a NON-EXISTENT file: if a case ever got
 * past the parser the harness would still exit 1 — but with the "dataset not
 * found" message, which the assertions below distinguish from the parser's.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEvalLongMemEval } from '../src/commands/eval-longmemeval.ts';

let tmp: string;
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'lme-parse-args-')); });
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

async function run(args: string[]): Promise<{ code: number | null; stderr: string }> {
  let code: number | null = null;
  let stderr = '';
  const originalExit = process.exit;
  const originalWrite = process.stderr.write;
  // @ts-ignore runtime override for the test
  process.exit = ((c: number) => { code = c; throw new Error('__exit__'); }) as any;
  // @ts-ignore runtime override for the test
  process.stderr.write = ((chunk: any) => { stderr += String(chunk); return true; }) as any;
  try {
    await runEvalLongMemEval(args, {});
  } catch (e) {
    if (!String(e).includes('__exit__')) throw e;
  } finally {
    // @ts-ignore runtime restore
    process.exit = originalExit;
    process.stderr.write = originalWrite;
  }
  return { code, stderr };
}

describe('gbrain eval longmemeval — invalid flag values exit 1 before any work', () => {
  const dataset = () => join(tmp, 'does-not-exist.jsonl');
  const out = () => join(tmp, 'never-written.jsonl');

  const cases: Array<{ name: string; args: string[]; message: string }> = [
    { name: '--limit 0', args: ['--limit', '0'], message: '--limit must be a positive integer (got: 0)' },
    { name: '--top-k abc', args: ['--top-k', 'abc'], message: '--top-k must be a positive integer (got: abc)' },
    { name: '--mode fast', args: ['--mode', 'fast'], message: '--mode must be one of conservative|balanced|tokenmax (got: fast)' },
    { name: '--reranker maybe', args: ['--reranker', 'maybe'], message: '--reranker must be on|off (got: maybe)' },
    { name: '--expansion-variant-budget 5', args: ['--expansion-variant-budget', '5'], message: '--expansion-variant-budget must be legacy or a number in (0, 4] (got: 5)' },
    { name: '--by-type-floor 2', args: ['--by-type-floor', '2'], message: '--by-type-floor must be a number in [0, 1] (got: 2)' },
    { name: '--by-type-floor-metric ndcg', args: ['--by-type-floor-metric', 'ndcg'], message: '--by-type-floor-metric must be recall_all|recall_any (got: ndcg)' },
    { name: '--judge-concurrency 0', args: ['--judge-concurrency', '0'], message: '--judge-concurrency must be a positive integer (got: 0)' },
    { name: '--search-pin autocut=true (key must start with search.)', args: ['--search-pin', 'autocut=true'], message: '--search-pin key must start with "search."' },
    { name: 'a missing value (--output at the end)', args: ['--output'], message: '--output requires a value (FILE)' },
    { name: 'a value that is another flag (--top-k --by-type)', args: ['--top-k', '--by-type'], message: '--top-k requires a value (K)' },
    { name: 'a second positional argument', args: ['extra.jsonl'], message: 'unexpected extra argument "extra.jsonl"' },
    { name: '--judge with --retrieval-only', args: ['--judge', '--retrieval-only'], message: '--judge cannot be combined with --retrieval-only' },
    { name: 'an unknown flag', args: ['--frobnicate'], message: "unknown flag --frobnicate for 'gbrain eval longmemeval'" },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const before = readdirSync(tmp).length;
      const { code, stderr } = await run([dataset(), '--keyword-only', '--retrieval-only', '--output', out(), ...c.args]);
      expect(code).toBe(1);
      expect(stderr).toContain(`Error: ${c.message}`);
      // Parser-level: the dataset was never opened, nothing was written.
      expect(stderr).not.toContain('dataset not found');
      expect(stderr).not.toContain('[longmemeval]');
      expect(existsSync(out())).toBe(false);
      expect(readdirSync(tmp).length).toBe(before);
    });
  }

  test('--help exits 0 (no process.exit) and prints the flag table to stderr', async () => {
    const { code, stderr } = await run(['--help']);
    expect(code).toBeNull();
    expect(stderr).toContain('gbrain eval longmemeval <dataset.jsonl> [options]');
    expect(stderr).toContain('--search-pin KEY=VALUE');
    expect(stderr).toContain('--expansion-variant-budget beat a pin');
    expect(stderr).toContain('max_tokens 16');
    expect(stderr).toContain('until all three are 0');
    expect(stderr).toContain('Search mode: conservative|balanced|tokenmax');
  });

  test('a missing <dataset.jsonl> is a usage error (exit 1 + help)', async () => {
    const { code, stderr } = await run(['--keyword-only']);
    expect(code).toBe(1);
    expect(stderr).toContain('<dataset.jsonl> is required');
  });

  test('valid values are accepted by the parser (the run then fails on the missing dataset, proving the parser passed)', async () => {
    const { code, stderr } = await run([
      dataset(), '--limit', '1', '--top-k', '8', '--mode', 'tokenmax', '--reranker', 'off', '--autocut', 'on',
      '--expansion-variant-budget', 'legacy', '--by-type-floor', '0.5', '--by-type-floor-metric', 'recall_any',
      '--judge-concurrency', '2', '--search-pin', 'search.adaptive_return=true', '--search-pin', 'search.x=a=b',
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain('dataset not found');
  });
});
