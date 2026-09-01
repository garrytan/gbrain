/**
 * #4583 review fix — the stdio unscoped-default-write advisory latches after
 * the FIRST assessment regardless of outcome.
 *
 * Pre-fix, the latch armed only when a warning actually printed, so on a
 * no-guard brain (fresh / default-dominant — the common case) the guard's
 * unindexed full-`pages` aggregate ran on EVERY mutating stdio call for the
 * life of the serve process.
 *
 * Hermetic: a counting stub engine answers the guard's page-distribution
 * aggregate and records how many times it ran.
 */

import { describe, test, expect } from 'bun:test';
import { createDefaultWriteAdvisory } from '../src/mcp/server.ts';
import type { BrainEngine } from '../src/core/engine.ts';

type Dist = { defaultPages: number; nonDefaultPages: number; nonDefaultSources: number };

function makeCountingStub(dist: Dist): { engine: BrainEngine; count: () => number } {
  let aggregateRuns = 0;
  const engine = {
    kind: 'pglite' as const,
    async executeRaw<T>(sql: string): Promise<T[]> {
      if (sql.includes('FROM pages')) {
        aggregateRuns++;
        return [{
          default_pages: dist.defaultPages,
          non_default_pages: dist.nonDefaultPages,
          non_default_sources: dist.nonDefaultSources,
        }] as unknown as T[];
      }
      return [];
    },
  } as unknown as BrainEngine;
  return { engine, count: () => aggregateRuns };
}

const NO_GUARD: Dist = { defaultPages: 100, nonDefaultPages: 0, nonDefaultSources: 0 };
const GUARDED: Dist = { defaultPages: 0, nonDefaultPages: 1467, nonDefaultSources: 2 };

describe('createDefaultWriteAdvisory (stdio lane, #4583 review fix)', () => {
  test('no-guard brain: the aggregate runs exactly ONCE across repeated mutating calls', async () => {
    const { engine, count } = makeCountingStub(NO_GUARD);
    const lines: string[] = [];
    const advise = createDefaultWriteAdvisory(engine, { enabled: true, write: (l) => lines.push(l) });
    await advise('seed_default', true);
    await advise('seed_default', true);
    await advise('seed_default', true);
    expect(count()).toBe(1);
    expect(lines).toEqual([]);
  });

  test('guarded brain: warns once, assesses once', async () => {
    const { engine, count } = makeCountingStub(GUARDED);
    const lines: string[] = [];
    const advise = createDefaultWriteAdvisory(engine, { enabled: true, write: (l) => lines.push(l) });
    await advise('seed_default', true);
    await advise('seed_default', true);
    expect(count()).toBe(1);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("writing to source 'default'");
  });

  test('cheap early-returns do not latch: a later mutating seed_default call still assesses', async () => {
    const { engine, count } = makeCountingStub(GUARDED);
    const lines: string[] = [];
    const advise = createDefaultWriteAdvisory(engine, { enabled: true, write: (l) => lines.push(l) });
    await advise('seed_default', false); // non-mutating — no assessment
    await advise('env', true);           // pinned tier — no assessment
    expect(count()).toBe(0);
    await advise('seed_default', true);
    expect(count()).toBe(1);
    expect(lines.length).toBe(1);
  });

  test('disabled (--source-guard lane): never assesses', async () => {
    const { engine, count } = makeCountingStub(GUARDED);
    const advise = createDefaultWriteAdvisory(engine, { enabled: false });
    await advise('seed_default', true);
    expect(count()).toBe(0);
  });

  test('a THROWING assessment still latches and never propagates (advisory, never blocks a write)', async () => {
    // The latch arms BEFORE the assessment runs, so a brain whose aggregate
    // throws (no pages table yet, a permissions error, a transient) is
    // assessed exactly once, prints nothing, and the mutating call proceeds.
    let aggregateRuns = 0;
    const engine = {
      kind: 'pglite' as const,
      async executeRaw<T>(sql: string): Promise<T[]> {
        if (sql.includes('FROM pages')) {
          aggregateRuns++;
          throw new Error('relation "pages" does not exist');
        }
        return [];
      },
    } as unknown as BrainEngine;
    const lines: string[] = [];
    const advise = createDefaultWriteAdvisory(engine, { enabled: true, write: (l) => lines.push(l) });
    await expect(advise('seed_default', true)).resolves.toBeUndefined();
    await advise('seed_default', true);
    await advise('seed_default', true);
    expect(aggregateRuns).toBe(1);
    expect(lines).toEqual([]);
  });

  test('a THROWING writer never propagates either', async () => {
    const { engine, count } = makeCountingStub(GUARDED);
    const advise = createDefaultWriteAdvisory(engine, {
      enabled: true,
      write: () => { throw new Error('EPIPE: stderr closed'); },
    });
    await expect(advise('seed_default', true)).resolves.toBeUndefined();
    await advise('seed_default', true);
    expect(count()).toBe(1);
  });
});
