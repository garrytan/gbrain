/**
 * #5004 (pre-landing review) — the `safe_index_pending` probe in
 * `src/core/ops/search.ts` (`hasUnsealedPagesInScope`) runs on EVERY empty
 * remote search/query. On a fully sealed brain it must be an index probe, not
 * a walk of every markdown page: `NOT (COALESCE(chunker_version, 0) >= N)` is
 * not sargable, so the partial btree `pages_chunker_version_idx` can only be
 * scanned whole with the predicate as a post-scan Filter. `pages.chunker_version`
 * is `SMALLINT NOT NULL DEFAULT 1` (cjk_wave migration), so the plain range
 * `chunker_version < N` is the same set and lets the planner use an Index Cond.
 *
 * Pins both layers: the SQL text the probe issues, and the PGLite plan for it
 * (seq scans disabled so a non-sargable predicate cannot hide behind a small
 * table).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { SAFE_FENCE_CHUNKER_VERSION } from '../src/core/search/safe-chunks.ts';

let engine: PGLiteEngine;
const captured: Array<{ sql: string; params: unknown[] | undefined }> = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Keyword-only keeps the op keyless (no embedding call); the probe fires on
  // this path too — it is the one producer of the `retrieval` meta channel.
  await engine.setConfig('search.mcp_keyword_only', 'true');
});

afterAll(async () => {
  await engine.disconnect();
});

/** The real engine, with the op-level `executeRaw` calls recorded. */
function recordingCtx(): OperationContext {
  const recording = new Proxy(engine, {
    get(target, prop) {
      if (prop === 'executeRaw') {
        return (sql: string, params?: unknown[]) => {
          captured.push({ sql, params });
          return target.executeRaw(sql, params);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    engine: recording,
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: true,
    sourceId: 'default',
    emitResponseMeta: () => {},
  } as unknown as OperationContext;
}

describe('safe_index_pending probe stays sargable (#5004)', () => {
  test('an empty remote search issues a plain chunker_version range the partial index serves as an Index Cond', async () => {
    captured.length = 0;
    const rows = await operationsByName.search.handler(recordingCtx(), { query: 'nosuchtokenanywhere', limit: 5 });
    expect(rows).toEqual([]);

    const probe = captured.find(c => c.sql.includes("page_kind = 'markdown'") && /LIMIT 1/.test(c.sql));
    expect(probe).toBeDefined();
    expect(probe!.sql).not.toContain('COALESCE');
    expect(probe!.sql).toContain(`p.chunker_version < ${SAFE_FENCE_CHUNKER_VERSION}`);

    await engine.executeRaw('SET enable_seqscan = off');
    try {
      const plan = (await engine.executeRaw<Record<string, string>>(`EXPLAIN ${probe!.sql}`, probe!.params))
        .map(r => Object.values(r)[0]).join('\n');
      expect(plan).toContain('Index Scan using pages_chunker_version_idx');
      expect(plan).toContain(`Index Cond: (chunker_version < ${SAFE_FENCE_CHUNKER_VERSION})`);
    } finally {
      await engine.executeRaw('RESET enable_seqscan');
    }
  });
});
