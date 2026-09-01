/**
 * #4730/#4731 — `gbrain dream --drain` surfaces the bounded per-item failure
 * records: the `--json` payload carries `failures` + `omitted_failure_count`
 * verbatim, and the human stderr summary names the record cap whenever
 * failures were omitted beyond it ("N beyond the record cap") — so a capped
 * list is visible, never silent.
 *
 * The drain loop itself (capping, sanitizing, reconciling failure_count) is
 * pinned in test/extract-atoms-drain*.test.ts. This file pins dream.ts's
 * rendering of the drain RESULT, so the shared drain helper is replaced by a
 * stub that returns a hand-built result. Serial: a top-level mock.module.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { ExtractAtomsDrainResult } from '../src/core/cycle/extract-atoms-drain.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let nextResult: ExtractAtomsDrainResult;
let drainCalls: Array<{ sourceId: string | undefined }> = [];

mock.module('../src/core/cycle/extract-atoms-drain.ts', () => ({
  MAX_DRAIN_FAILURE_RECORDS: 25,
  MAX_DRAIN_FAILURE_SOURCE_CHARS: 256,
  MAX_DRAIN_FAILURE_REASON_CHARS: 200,
  runExtractAtomsDrainForSource: async (_engine: unknown, opts: { sourceId: string | undefined }) => {
    drainCalls.push({ sourceId: opts.sourceId });
    return nextResult;
  },
}));

let runDream: typeof import('../src/commands/dream.ts').runDream;
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  ({ runDream } = await import('../src/commands/dream.ts'));
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(() => {
  drainCalls = [];
});

function baseResult(overrides: Partial<ExtractAtomsDrainResult>): ExtractAtomsDrainResult {
  return {
    phase: 'extract_atoms',
    status: 'ok',
    extracted: 1,
    skipped: 0,
    remaining: 0, // fully drained → dream exits 0 (no process.exit call)
    batches: 1,
    stopped: 'drained',
    failure_count: 0,
    failures: [],
    omitted_failure_count: 0,
    last_error: null,
    ...overrides,
  };
}

/** Drive `dream --drain …` capturing stderr (progress/diagnostics) and stdout (data). */
async function runDrainCaptured(args: string[]): Promise<{ stderr: string; stdout: string[]; exitCode: number | undefined }> {
  const stderr: string[] = [];
  const stdout: string[] = [];
  let exitCode: number | undefined;
  const origWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: typeof origWrite }).write = ((chunk: unknown): boolean => {
    stderr.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof origWrite;
  const errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { stderr.push(a.map(String).join(' ')); });
  const logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { stdout.push(a.map(String).join(' ')); });
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error('__exit__');
  }) as never);
  try {
    await runDream(engine, ['--drain', ...args]);
  } catch (e) {
    if ((e as Error).message !== '__exit__') throw e;
  } finally {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
    (process.stderr as unknown as { write: typeof origWrite }).write = origWrite;
  }
  return { stderr: stderr.join(''), stdout, exitCode };
}

describe('dream --drain failure summary (#4730)', () => {
  test('stderr names the record cap when omitted_failure_count > 0', async () => {
    nextResult = baseResult({
      failure_count: 3,
      failures: [
        { batch: 1, source: 'writings/a', reason: 'provider timeout' },
        { batch: 1, source: 'writings/b', reason: 'bad json' },
      ],
      omitted_failure_count: 1,
      last_error: 'writings/b: bad json',
    });

    const r = await runDrainCaptured([]);
    expect(drainCalls).toHaveLength(1);
    expect(r.exitCode).toBeUndefined();
    expect(r.stderr).toContain('[drain] 3 item failure(s) (2 detailed, 1 beyond the record cap); last error: writings/b: bad json');
    expect(r.stderr).toContain('beyond the record cap');
    // Data stream stays clean of the diagnostic line.
    expect(r.stdout.join('\n')).not.toContain('beyond the record cap');
    expect(r.stdout.join('\n')).toContain('[drain] extracted 1 atom(s) across 1 batch(es); 0 remaining (stopped: drained)');
  });

  test('stderr omits the cap clause when every failure was recorded (omitted_failure_count = 0)', async () => {
    nextResult = baseResult({
      failure_count: 2,
      failures: [
        { batch: 1, source: 'writings/a', reason: 'provider timeout' },
        { batch: 2, source: 'writings/b', reason: 'bad json' },
      ],
      omitted_failure_count: 0,
      last_error: 'writings/b: bad json',
    });

    const r = await runDrainCaptured([]);
    expect(r.stderr).toContain('[drain] 2 item failure(s); last error: writings/b: bad json');
    expect(r.stderr).not.toContain('beyond the record cap');
    expect(r.stderr).not.toContain('detailed');
  });

  test('a clean run prints no failure line at all', async () => {
    nextResult = baseResult({});
    const r = await runDrainCaptured([]);
    expect(r.stderr).not.toContain('item failure');
    expect(r.stderr).not.toContain('beyond the record cap');
  });

  test('--json carries failures[] and omitted_failure_count verbatim; the cap clause still goes to stderr', async () => {
    nextResult = baseResult({
      failure_count: 27,
      failures: Array.from({ length: 25 }, (_, i) => ({ batch: 1, source: `writings/p${i}`, reason: 'provider timeout' })),
      omitted_failure_count: 2,
      last_error: 'writings/p24: provider timeout',
    });

    const r = await runDrainCaptured(['--json']);
    const payload = JSON.parse(r.stdout.find(l => l.trim().startsWith('{'))!);
    expect(payload.failure_count).toBe(27);
    expect(payload.failures).toHaveLength(25);
    expect(payload.failures[0]).toEqual({ batch: 1, source: 'writings/p0', reason: 'provider timeout' });
    expect(payload.omitted_failure_count).toBe(2);
    expect(payload.failure_count).toBe(payload.failures.length + payload.omitted_failure_count);
    // Stderr discipline: the summary (with the cap clause) never lands in the JSON stream.
    expect(r.stderr).toContain('(25 detailed, 2 beyond the record cap)');
    expect(r.stdout.join('\n')).not.toContain('beyond the record cap');
  });
});
