/**
 * #7170: `foresights query --explain` (and `search --explain`) reported
 * `rrf: single_arm_path` and `blend: no_query_embedding` on every row of a
 * hybrid brain. The CLI claims the global --explain flag for its formatter, so
 * the op never received `explain: true`, fusion never stamped its attribution,
 * and the formatter then projected unstamped rows. The fix forwards the flag
 * to both ops; the hybrid test pins that a fused row reports rrf and blend as
 * applied after every post-fusion stage, through the op the CLI calls.
 * Seams: gateway embed transport stub (deterministic bag-of-words vectors);
 * in-memory PGLite.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { parseOpArgs } from '../../src/cli/main.ts';
import { getCliOptions, setCliOptions, _resetCliOptionsForTest } from '../../src/core/cli-options.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { operationsByName } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import type { ScoreDetails } from '../../src/core/search/explain-formatter.ts';

const DIMS = 1536;
function vectorFor(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % DIMS] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}

afterEach(() => _resetCliOptionsForTest());

describe('CLI --explain reaches the search and query ops', () => {
  for (const name of ['search', 'query'] as const) {
    test(`${name}: the claimed global flag becomes explain: true`, () => {
      setCliOptions({ ...getCliOptions(), explain: true });
      expect(parseOpArgs(operationsByName[name], ['quokka habitat']).explain).toBe(true);
    });
    test(`${name}: no flag, no explain param`, () => {
      expect(parseOpArgs(operationsByName[name], ['quokka habitat']).explain).toBeUndefined();
    });
  }
});

describe('hybrid brain: fused rows report rrf and blend as applied (PGLite)', () => {
  let engine: PGLiteEngine;
  const ctx = {
    get engine() { return engine; }, remote: false, sourceId: 'default', config: { engine: 'pglite' }, dryRun: false,
    logger: { info() {}, warn() {}, error() {} }, emitNotice() {}, emitResponseMeta() {},
  } as unknown as OperationContext;

  beforeAll(async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    await importFromContent(engine, 'notes/quokka-habitat', '# Quokka habitat\nQuokka island habitat notes: scrub, burrows and shade.');
    await importFromContent(engine, 'notes/quokka-diet', '# Quokka diet\nQuokka eats leaves and grasses; diet notes.');
    await importFromContent(engine, 'notes/ferries', '# Ferries\nFerry timetable to the island.');
  }, 120_000);
  afterAll(async () => {
    __setEmbedTransportForTests(null);
    resetGateway();
    if (engine) await engine.disconnect();
  });

  for (const name of ['search', 'query'] as const) {
    test(`${name} with explain: score_details.rrf and .blend are applied`, async () => {
      const params = { query: 'quokka island habitat', explain: true, ...(name === 'query' ? { expand: false } : {}) };
      const rows = await operationsByName[name].handler(ctx, params) as Array<{ slug: string; score_details?: ScoreDetails }>;
      expect(rows.length).toBeGreaterThan(0);
      const top = rows[0].score_details!;
      expect(top.rrf.state).toBe('applied');
      expect(top.blend.state).toBe('applied');
      expect(top.arms.map(a => a.arm)).toContain('keyword');
      expect(top.arms.some(a => a.arm.startsWith('vector'))).toBe(true);
    });
  }
});
