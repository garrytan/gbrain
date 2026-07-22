/**
 * T0 — `gbrain search diagnose` Phase-0 retrieval diagnostic. Seeds a synthetic
 * brain, forces the keyword+alias path (embed stubbed to throw → vector skipped),
 * and asserts the per-layer trace + verdict.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { runSearchDiagnose } from '../../src/commands/search-diagnose.ts';
import type { ChunkInput } from '../../src/core/types.ts';

let engine: PGLiteEngine;

async function captureJson(fn: () => Promise<void>): Promise<any> {
  const orig = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  try { await fn(); } finally { console.log = orig; }
  return JSON.parse(lines.join('\n'));
}

beforeAll(async () => {
  __setEmbedTransportForTests(() => { throw new Error('stub: no embed'); });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('projects/mingtang', {
    type: 'note' as never,
    title: 'The Example Hall — Indoor Greek Amphitheater',
    compiled_truth: 'Indoor greek amphitheater for adversarial debate.',
  });
  const ci: ChunkInput[] = [{ chunk_index: 0, chunk_text: 'Indoor greek amphitheater for adversarial debate.', chunk_source: 'compiled_truth', token_count: 10 }];
  await engine.upsertChunks('projects/mingtang', ci);
  await engine.setPageAliases('projects/mingtang', 'default', ['hall of light']);
});

afterAll(async () => { __setEmbedTransportForTests(null); await engine.disconnect(); });

describe('search diagnose', () => {
  test('alias query: trace shows alias match + hybrid rank 1', async () => {
    const report = await captureJson(() =>
      runSearchDiagnose(engine, ['diagnose', 'hall of light', '--target', 'projects/mingtang', '--source', 'default', '--json']),
    );
    expect(report.target).toBe('projects/mingtang');
    expect(report.alias_match).toBe(true);
    // vector probe degrades gracefully (no provider OR embed call failed) — the
    // point is it doesn't crash the diagnose. A note is present either way.
    expect(report.vector.rank).toBeNull();
    expect(typeof report.vector.note).toBe('string');
    expect(report.hybrid.rank).toBe(1);
    expect(report.hybrid.alias_hit).toBe(true);
    expect(report.verdict).toContain('rank 1');
  });

  test('title-phrase query: keyword + title boost surface the target', async () => {
    const report = await captureJson(() =>
      runSearchDiagnose(engine, ['diagnose', 'greek amphitheater', '--target', 'projects/mingtang', '--source', 'default', '--json']),
    );
    expect(report.keyword.rank).toBe(1);
    expect(report.hybrid.rank).toBe(1);
    // title boost fired (query is a phrase in the title)
    expect(report.hybrid.title_match_boost).toBeGreaterThan(1.0);
  });
});
