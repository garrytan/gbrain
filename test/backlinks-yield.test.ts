/**
 * Backlinks scan yields to the event loop (wave 14 P1.1, #6438).
 *
 * Protects: the autopilot `backlinks` phase runs under a heartbeat and the
 * minion RSS watchdog, both timers. A synchronous walk never lets them fire,
 * so on a 350k-page brain the worker grew to 14 GB with no watchdog action.
 * Regression: the async walker stops yielding. Existing coverage asserts
 * gap results, never scheduling. The seam is the global `setImmediate` the
 * walker yields through (spied, not injected).
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKLINKS_YIELD_EVERY, findBacklinkGapsAsync, runBacklinks, runBacklinksCore } from '../src/commands/backlinks.ts';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function corpus(pages: number): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-backlinks-yield-'));
  roots.push(root);
  mkdirSync(join(root, 'people'));
  mkdirSync(join(root, 'notes'));
  writeFileSync(join(root, 'people/alice.md'), '# Alice\n');
  for (let i = 0; i < pages; i++) writeFileSync(join(root, `notes/n${i}.md`), `# Note ${i}\n\n[Alice](../people/alice)\n`);
  return root;
}

describe('findBacklinkGapsAsync yields', () => {
  test('1000 pages yield at least ceil(1000 / N) times and let a timer fire mid-scan', async () => {
    const root = corpus(1000);
    const setImmediateSpy = spyOn(globalThis, 'setImmediate');
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 1);
    try {
      const gaps = await findBacklinkGapsAsync(root);
      expect(gaps).toHaveLength(1000);
      expect(setImmediateSpy.mock.calls.length).toBeGreaterThanOrEqual(Math.ceil(1000 / BACKLINKS_YIELD_EVERY));
      expect(ticks).toBeGreaterThan(0);
    } finally {
      clearInterval(timer);
      setImmediateSpy.mockRestore();
    }
  });

  test('runBacklinksCore check runs the yielding walker and reports the gap list once', async () => {
    const root = corpus(300);
    const setImmediateSpy = spyOn(globalThis, 'setImmediate');
    try {
      const result = await runBacklinksCore({ action: 'check', dir: root });
      expect(result.gaps_found).toBe(300);
      expect(result.gaps).toHaveLength(300);
      expect(setImmediateSpy.mock.calls.length).toBeGreaterThanOrEqual(Math.ceil(300 / BACKLINKS_YIELD_EVERY));
    } finally {
      setImmediateSpy.mockRestore();
    }
  });
});

describe('one scan per run (#6438)', () => {
  test('the CLI check path reads each page once in pass 1 and each referenced target once in pass 2, with no second walk', async () => {
    const root = corpus(40);
    const reads = spyOn(fs, 'readFileSync');
    const dirs = spyOn(fs, 'readdirSync');
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runBacklinks(['check', root]);
      const pageReads = reads.mock.calls.map(c => String(c[0])).filter(p => p.startsWith(root));
      const counts = new Map<string, number>();
      for (const p of pageReads) counts.set(p, (counts.get(p) ?? 0) + 1);
      for (let i = 0; i < 40; i++) expect(counts.get(join(root, `notes/n${i}.md`))).toBe(1);
      // alice: once as a page in pass 1, once as the referenced target in pass 2.
      expect(counts.get(join(root, 'people/alice.md'))).toBe(2);
      expect(pageReads).toHaveLength(42);
      // root, notes, people: one directory walk, not two.
      expect(dirs.mock.calls.map(c => String(c[0])).filter(p => p.startsWith(root))).toHaveLength(3);
      expect(log.mock.calls.some(c => String(c[0]).includes('Found 40 missing back-link(s)'))).toBe(true);
    } finally {
      reads.mockRestore(); dirs.mockRestore(); log.mockRestore();
    }
  });
});
