/**
 * Unit tests for src/core/onboard/init-nudge.ts (runInitNudge).
 *
 * runInitNudge fires 6 parallel COUNT probes (stale chunks, entities, linked
 * entities, timeline entities, takes, total pages) and prints a one-line
 * nudge to stderr. These tests pin the DX-wave behavior:
 *   - EMPTY brain (pages count 0) → the whole nudge is suppressed, even
 *     when takes === 0 (no "0 takes" jargon-noise on first init)
 *   - pages probe REJECTS → fail-open sentinel treats the brain as
 *     non-empty, so the takes nudge still fires
 *   - non-empty + healthy + one rejected arm → partial-checks notice
 *   - non-empty + takes 0 → "0 takes" opportunity nudge
 *
 * The gate is process.stderr.isTTY (NOT process.env), so monkeypatching it
 * here does not trip the serial-isolation rules for env-mutating tests.
 * Both isTTY and stderr.write are restored in finally.
 */

import { describe, test, expect } from 'bun:test';
import { runInitNudge } from '../src/core/onboard/init-nudge.ts';
import type { BrainEngine } from '../src/core/engine.ts';

/** Per-probe result: a count, or an Error to make that arm reject. */
interface ProbeCounts {
  stale?: number | Error;
  entities?: number | Error;
  linked?: number | Error;
  timeline?: number | Error;
  takes?: number | Error;
  pages?: number | Error;
}

/**
 * Stub engine shaped like { executeRaw: async (sql) => [...] }. Routes each
 * of runInitNudge's 6 COUNT queries by a distinctive SQL fragment. Order
 * matters: the linked/timeline queries also contain "type IN ('person'",
 * so they are matched first.
 */
function stubEngine(counts: ProbeCounts): BrainEngine {
  const route = (sql: string): number | Error => {
    if (sql.includes('content_chunks')) return counts.stale ?? 0;
    if (sql.includes('FROM takes')) return counts.takes ?? 0;
    if (sql.includes('FROM links')) return counts.linked ?? 0;
    if (sql.includes('timeline_entries')) return counts.timeline ?? 0;
    if (sql.includes("type IN ('person'")) return counts.entities ?? 0;
    // 6th probe: SELECT COUNT(*) FROM pages WHERE deleted_at IS NULL
    return counts.pages ?? 0;
  };
  return {
    executeRaw: async (sql: string) => {
      const r = route(sql);
      if (r instanceof Error) throw r;
      return [{ count: r }];
    },
  } as unknown as BrainEngine;
}

/**
 * Run the nudge with stderr forced to look like a TTY and its writes
 * captured. Restores both in finally so no other test sees the patch.
 */
async function runNudgeCaptured(engine: BrainEngine): Promise<string> {
  const origIsTTY = process.stderr.isTTY;
  const origWrite = process.stderr.write;
  let out = '';
  try {
    (process.stderr as unknown as { isTTY: boolean }).isTTY = true;
    process.stderr.write = ((chunk: unknown) => {
      out += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    await runInitNudge(engine);
  } finally {
    process.stderr.write = origWrite;
    (process.stderr as unknown as { isTTY: boolean | undefined }).isTTY = origIsTTY;
  }
  return out;
}

describe('runInitNudge — empty-brain suppression', () => {
  test('empty brain (pages 0, takes 0) prints NOTHING', async () => {
    const out = await runNudgeCaptured(
      stubEngine({ stale: 0, entities: 0, linked: 0, timeline: 0, takes: 0, pages: 0 }),
    );
    expect(out).toBe('');
  });
});

describe('runInitNudge — pages probe failure is fail-open', () => {
  test('pages probe REJECTS with takes 0 → nudge still fires with "0 takes"', async () => {
    // The -1 sentinel means "count unknown" — treat as non-empty so the
    // pre-existing behavior (nudge on 0 takes) is preserved.
    const out = await runNudgeCaptured(
      stubEngine({
        stale: 0,
        entities: 0,
        linked: 0,
        timeline: 0,
        takes: 0,
        pages: new Error('pages probe failed'),
      }),
    );
    expect(out).toContain('Brain has opportunities');
    expect(out).toContain('0 takes');
  });
});

describe('runInitNudge — partial-checks notice', () => {
  test('non-empty healthy brain with one rejected arm → "Init checks incomplete"', async () => {
    // pages > 0 (non-empty), takes > 0 (no opportunity part), entities 0
    // (coverage arms vacuous), stale 0 — but the linked probe rejects, so
    // partial=true with zero parts → the incomplete-checks line.
    const out = await runNudgeCaptured(
      stubEngine({
        stale: 0,
        entities: 0,
        linked: new Error('linked probe failed'),
        timeline: 0,
        takes: 5,
        pages: 10,
      }),
    );
    expect(out).toContain('Init checks incomplete');
    expect(out).toContain('(5/6)');
    expect(out).toContain('gbrain onboard --check');
    expect(out).not.toContain('Brain has opportunities');
  });
});

describe('runInitNudge — non-empty brain opportunities', () => {
  test('non-empty brain with takes 0 → "Brain has opportunities: 0 takes"', async () => {
    const out = await runNudgeCaptured(
      stubEngine({ stale: 0, entities: 0, linked: 0, timeline: 0, takes: 0, pages: 10 }),
    );
    expect(out).toContain('Brain has opportunities: 0 takes');
    expect(out).toContain("Run 'gbrain onboard --check' to see the plan");
    // All 6 probes succeeded — no partial-checks suffix.
    expect(out).not.toContain('checks complete');
  });
});
