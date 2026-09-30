/**
 * `gbrain extract --workers N` (v0.41.15.0, T7): the flag is validated at the
 * CLI, threads into runExtractCore, and fans the per-page work out over N
 * concurrent workers on engines that allow parallel writes.
 *
 * Concurrency is observed at the engine boundary: a proxy reports the engine
 * as Postgres (so the PGLite single-writer clamp does not apply) and counts
 * the peak number of in-flight per-page `readPageSnapshot` calls. Meeting
 * pages take the snapshot path on both the incremental (slugs) and the
 * directory-walk link loops.
 */

import { describe, test, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExtract, runExtractCore } from '../src/commands/extract.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const PAGES = 8;
let engine: PGLiteEngine;
let brainDir: string;
const slugs: string[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-extract-workers-'));
  mkdirSync(join(brainDir, 'meetings'), { recursive: true });
  for (let i = 0; i < PAGES; i++) {
    const slug = `meetings/m${i}`;
    slugs.push(slug);
    await engine.putPage(slug, { type: 'meeting', title: `M${i}`, compiled_truth: '', timeline: '' });
    writeFileSync(join(brainDir, `${slug}.md`), `---\ntitle: M${i}\ntype: meeting\n---\n\nFollow-up: [M](../meetings/m${(i + 1) % PAGES}.md)\n`);
  }
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(brainDir, { recursive: true, force: true });
});

function parallelEngine(): { engine: BrainEngine; peak: () => number } {
  let inflight = 0;
  let peak = 0;
  const proxy = new Proxy(engine, {
    get(target, prop) {
      if (prop === 'kind') return 'postgres';
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (prop !== 'readPageSnapshot') return value.bind(target);
      return async (...args: unknown[]) => {
        inflight++;
        peak = Math.max(peak, inflight);
        try {
          await new Promise(r => setTimeout(r, 5));
          return await value.apply(target, args);
        } finally {
          inflight--;
        }
      };
    },
  });
  return { engine: proxy as unknown as BrainEngine, peak: () => peak };
}

describe('extract --workers', () => {
  for (const [label, extra] of [['incremental slugs', { slugs }], ['directory walk', {}]] as const) {
    test(`${label}: workers=4 runs pages concurrently, workers=1 runs them one at a time`, async () => {
      for (const [workers, expectPeak] of [[1, 1], [4, 4]] as const) {
        const probe = parallelEngine();
        const result = await runExtractCore(probe.engine, { mode: 'links', dir: brainDir, workers, quiet: true, ...extra });
        expect(result.pages_processed).toBe(PAGES);
        expect(probe.peak(), `workers=${workers}`).toBe(expectPeak);
      }
    }, 30_000);
  }

  test('the CLI rejects a non-positive --workers value and exits 1', async () => {
    const errors: string[] = [];
    const err = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
    const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`__exit_${code}__`); }) as never);
    try {
      for (const flag of ['--workers', '--concurrency']) {
        await expect(runExtract(engine, ['links', '--dir', brainDir, flag, '0'])).rejects.toThrow('__exit_1__');
      }
    } finally {
      err.mockRestore();
      exit.mockRestore();
    }
    expect(errors.filter(e => e.includes('--workers must be a positive integer'))).toHaveLength(2);
  });

  test('the CLI threads --workers and --concurrency into the core (PGLite clamps them to 1 and says so)', async () => {
    const errors: string[] = [];
    const err = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runExtract(engine, ['links', '--dir', brainDir, '--workers', '7']);
      await runExtract(engine, ['links', '--dir', brainDir, '--concurrency', '9']);
    } finally {
      err.mockRestore();
      log.mockRestore();
    }
    expect(errors.some(e => e.includes('workers=7 requested, clamped to 1 on PGLite'))).toBe(true);
    expect(errors.some(e => e.includes('workers=9 requested, clamped to 1 on PGLite'))).toBe(true);
  });
});
