/**
 * #7177: recall and entity misses exited 0 with nothing to tell them from a
 * hit, so an agent that piped them through grep could not tell. A lookup
 * that matches nothing now says `status: "no_results"` under --json, and
 * with GBRAIN_FAIL_ON_EMPTY=1 exits NO_RESULTS_EXIT_CODE (12) with one stderr
 * line; a feed read with nothing new, and every hit, never do. The default
 * exit stays 0. PGLite only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runRecall } from '../src/commands/recall.ts';
import { formatEntityResult, markEntityMiss } from '../src/cli/entity-format.ts';
import { currentExitCode, _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { NO_RESULTS_EXIT_CODE } from '../src/core/exit-codes.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const failOnEmpty = <T>(fn: () => T | Promise<T>) => withEnv({ GBRAIN_FAIL_ON_EMPTY: '1' }, fn);

let engine: PGLiteEngine;
const origOut = process.stdout.write.bind(process.stdout);
const origErr = process.stderr.write.bind(process.stderr);
let err = '';
let out = '';

async function recall(args: string[]): Promise<number> {
  _resetCliExitVerdictForTests();
  err = '';
  out = '';
  process.stdout.write = ((c: string | Uint8Array) => { out += typeof c === 'string' ? c : Buffer.from(c).toString(); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => { err += typeof c === 'string' ? c : Buffer.from(c).toString(); return true; }) as typeof process.stderr.write;
  try {
    await runRecall(engine, [...args, '--source', 'default']);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return currentExitCode();
}

function silenced<T>(fn: () => T): T {
  err = '';
  process.stderr.write = ((c: string | Uint8Array) => { err += typeof c === 'string' ? c : Buffer.from(c).toString(); return true; }) as typeof process.stderr.write;
  try { return fn(); } finally { process.stderr.write = origErr; }
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => {
  await engine.disconnect();
});
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.putPage('people/alice-example', { title: 'Alice Example', type: 'person', compiled_truth: 'Founder.' } as never);
  await engine.insertFact({ fact: 'prefers morning meetings', kind: 'preference', entity_slug: 'people/alice-example', source: 'test', visibility: 'world' } as never, { source_id: 'default' });
});
afterEach(() => {
  _resetCliExitVerdictForTests();
  process.exitCode = 0;
});

describe('recall, default', () => {
  test('a miss exits 0 and prints nothing extra; --json says status no_results, a hit has no status', async () => {
    expect(await recall(['people/carol-example'])).toBe(0);
    expect(err).not.toContain('no_results');
    expect(await recall(['people/carol-example', '--json'])).toBe(0);
    expect(JSON.parse(out).status).toBe('no_results');
    expect(await recall(['people/alice-example', '--json'])).toBe(0);
    expect(JSON.parse(out).status).toBeUndefined();
    await recall(['--grep', 'zebra', '--since-last-run', '--json']);
    expect(JSON.parse(out).status).toBeUndefined();
  });
});

describe('recall, GBRAIN_FAIL_ON_EMPTY=1', () => {
  test('a hit exits 0', () => failOnEmpty(async () => {
    expect(await recall(['people/alice-example'])).toBe(0);
    expect(await recall(['--grep', 'morning'])).toBe(0);
  }));

  test('an entity, text or --grep lookup that matches nothing exits 12 with one stderr line', () => failOnEmpty(async () => {
    for (const args of [['people/carol-example'], ['zebra'], ['--grep', 'zebra'], ['people/alice-example', '--grep', 'zebra']]) {
      expect(await recall(args)).toBe(NO_RESULTS_EXIT_CODE);
      expect(err).toContain('[recall] exit 12 (no_results): nothing matched (GBRAIN_FAIL_ON_EMPTY=1).');
    }
  }));

  test('a --json miss exits 12 too', () => failOnEmpty(async () => {
    expect(await recall(['people/carol-example', '--json'])).toBe(NO_RESULTS_EXIT_CODE);
  }));

  test('a feed read with nothing new is not a miss', () => failOnEmpty(async () => {
    expect(await recall(['--grep', 'zebra', '--since-last-run'])).toBe(0);
  }));
});

describe('entity', () => {
  const miss = { found: false, latency_ms: 2613, coverage: { state: 'pending', pending_pages: 40 }, suggestions: [] };

  test('by default a miss exits 0', () => {
    _resetCliExitVerdictForTests();
    silenced(() => markEntityMiss('entity', miss));
    expect(currentExitCode()).toBe(0);
  });

  test('with GBRAIN_FAIL_ON_EMPTY=1 a miss exits 12; the miss line is plain, timing and coverage on their own lines', () => failOnEmpty(() => {
    _resetCliExitVerdictForTests();
    silenced(() => markEntityMiss('entity', miss));
    expect(currentExitCode()).toBe(NO_RESULTS_EXIT_CODE);
    expect(err).toContain('[entity] exit 12 (no_results)');
    expect(formatEntityResult(miss).split('\n')).toEqual(['No entity found.', '  mention coverage: pending, 40 page(s) pending', '  (2613ms)', '']);
  }));

  test('a miss whose lookup read failed is not "nothing matched": exit 0 even with GBRAIN_FAIL_ON_EMPTY=1', () => failOnEmpty(() => {
    _resetCliExitVerdictForTests();
    silenced(() => markEntityMiss('entity', miss, { degraded: [{ stage: 'entity_lookup_failed' }] }));
    expect(currentExitCode()).toBe(0);
    expect(err).not.toContain('no_results');
  }));

  test('a found card, a miss with text mentions and other ops exit 0', () => failOnEmpty(() => {
    for (const [op, r] of [
      ['entity', { found: true, card: {} }],
      ['entity', { ...miss, text_mentions: { total: 2, pages: [] } }],
      ['search', miss],
    ] as const) {
      _resetCliExitVerdictForTests();
      silenced(() => markEntityMiss(op, r));
      expect(currentExitCode()).toBe(0);
    }
  }));
});
