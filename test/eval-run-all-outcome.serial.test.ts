/**
 * `foresights eval run-all` outcomes for the wired suite (brainbench).
 *
 * Protects: a bare run sweeps only the wired suites, names the per-suite
 * commands for longmemeval and replay, writes no `skipped` record and returns
 * 0; a brainbench run whose record says `failed` makes run-all return 1 with
 * that record persisted. Regressions it catches: the old stub sweep (skipped
 * records, exit 0), a failed suite reported as success. The CLI refusal for an
 * explicit unwired suite lives in test/eval-run-all.test.ts.
 * Seam: mock.module replaces runBrainBenchCore (the real suite takes ~20 s and
 * cannot be made to fail on demand), hence the serial file.
 */
import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let core: { status: 'completed' | 'failed'; fixtures_hash?: string; error?: string } = { status: 'completed' };
mock.module('../src/commands/eval-brainbench.ts', () => ({
  runBrainBenchCore: async () => core,
}));
const { runEvalRunAll } = await import('../src/commands/eval-run-all.ts');

const tmp = mkdtempSync(join(tmpdir(), 'gbrain-runall-outcome-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function run(args: string[]): Promise<{ code: number; stderr: string; records: Array<{ suite: string; status: string; error?: string }> }> {
  const out = join(tmp, String(Math.random()).slice(2));
  const chunks: string[] = [];
  const spy = spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => { chunks.push(String(c)); return true; });
  let code: number;
  try {
    code = await runEvalRunAll(null, [...args, '--output', out]);
  } finally {
    spy.mockRestore();
  }
  const records = readFileSync(join(out, 'eval-results.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  return { code, stderr: chunks.join(''), records };
}

beforeEach(() => { core = { status: 'completed', fixtures_hash: 'abc' }; });

describe('eval run-all wired-suite outcomes', () => {
  test('bare run: brainbench only, a notice naming the per-suite commands, exit 0', async () => {
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.records.map(x => [x.suite, x.status])).toEqual([['brainbench', 'completed']]);
    expect(r.stderr).toContain('foresights eval longmemeval <dataset.jsonl> --mode <mode> --record');
    expect(r.stderr).toContain('foresights eval replay --mode <mode>');
  });

  test('a failed brainbench record makes run-all exit 1 and keeps the record', async () => {
    core = { status: 'failed', error: 'seed failures: fixture-a' };
    const r = await run(['--suites', 'brainbench']);
    expect(r.code).toBe(1);
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({ suite: 'brainbench', status: 'failed', error: 'seed failures: fixture-a' });
    expect(r.stderr).toContain('FAILED');
    expect(r.stderr).not.toContain('foresights eval replay --mode');
  });
});
