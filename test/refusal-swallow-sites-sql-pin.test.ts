/**
 * Pins the statements the code walk's language gate (code-intel/recursive-walk.ts), the two-pass walk's near-symbol
 * anchor and unresolved-edge target lookups (search/two-pass.ts), the reindex spend estimate
 * (reindex-consent.ts) and the remediation impact log (onboard/impact-capture.ts) ran through `executeRaw` before they
 * moved to engine-sql/chunk-reads.ts and engine-sql/remediation-records.ts. The language read gains only a byte-order
 * `ORDER BY` (its caller asks only whether some language is supported). The two-pass symbol lookups are master's four
 * statements byte for byte. Every other statement and parameter list is the text the callers composed.
 */
import { expect, test } from 'bun:test';
import { listSupportedChunkIds, listSymbolChunkIds, listSymbolLanguages } from '../src/core/engine-sql/chunk-reads.ts';
import { insertImpactLogRow, readReindexSpendInputs, REMEDIATION_RECORDS_SQL } from '../src/core/engine-sql/remediation-records.ts';
import { codeReadFilter } from '../src/core/code-intel/read-scope.ts';
import { MARKDOWN_CHUNKER_VERSION } from '../src/core/chunkers/recursive.ts';

const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

function recorder(answer: unknown[] = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const exec = {
    executeRaw: async (sql: string, params: unknown[] = []) => { calls.push({ sql: squash(sql), params }); return answer; },
  };
  return { calls, exec: exec as never };
}

test('the language gate reads master\'s statement, in byte order', async () => {
  const { calls, exec } = recorder([{ language: 'cobol' }, { language: 'typescript' }]);
  expect(await listSymbolLanguages(exec, 'src-a', 'pkg.mod.helper')).toEqual(['cobol', 'typescript']);
  const filter = codeReadFilter([], {});
  expect(calls).toHaveLength(1);
  expect(calls[0]!.sql).toBe(squash(`SELECT DISTINCT content_chunks.language COLLATE "C" AS language
         FROM content_chunks
         JOIN pages p ON p.id = content_chunks.page_id
        WHERE p.source_id = $1 AND ${filter}
          AND content_chunks.symbol_name_qualified = $2
          AND content_chunks.language IS NOT NULL
        ORDER BY language`));
  expect(calls[0]!.params).toEqual(['src-a', 'pkg.mod.helper']);
});

test('the mixed-language filter reads master\'s statement, in id order, and skips an empty list', async () => {
  const { calls, exec } = recorder([{ id: '7' }, { id: 9 }]);
  expect(await listSupportedChunkIds(exec, [9, 7, 8], ['typescript', 'rust'])).toEqual([7, 9]);
  expect(calls).toEqual([{
    sql: 'SELECT id FROM content_chunks WHERE id = ANY($1::int[]) AND language = ANY($2::text[]) ORDER BY id',
    params: [[9, 7, 8], ['typescript', 'rust']],
  }]);
  expect(await listSupportedChunkIds(exec, [], ['typescript'])).toEqual([]);
  expect(await listSupportedChunkIds(exec, [1], [])).toEqual([]);
  expect(calls).toHaveLength(1);
});

test('the reindex spend read is master\'s statement and parameters', async () => {
  const { calls, exec } = recorder([{ n: '3', chars: '120' }]);
  expect(await readReindexSpendInputs(exec, MARKDOWN_CHUNKER_VERSION, 'note')).toEqual({ pages: 3, chars: 120 });
  expect(calls).toEqual([{
    sql: squash(`SELECT COUNT(*)::bigint AS n, COALESCE(SUM(LENGTH(compiled_truth) + LENGTH(timeline)), 0)::bigint AS chars
         FROM pages
        WHERE page_kind = 'markdown' AND (chunker_version < $1 OR contextual_retrieval_mode IS NULL)
          AND deleted_at IS NULL AND ($2::text IS NULL OR type = $2)`),
    params: [MARKDOWN_CHUNKER_VERSION, 'note'],
  }]);
  expect(squash(REMEDIATION_RECORDS_SQL.reindexSpend)).toBe(calls[0]!.sql);
});

test('the impact log insert is master\'s statement; details bind as text for the jsonb cast', async () => {
  const { calls, exec } = recorder();
  await insertImpactLogRow(exec, {
    remediation_id: 'step-1', metric_name: 'takes_count', metric_before: 0, metric_after: 2, job_id: 5,
    source_id: null, brain_id: null, started_at: '2026-01-01T00:00:00.000Z', idempotency_key: 'key', applied_by: null,
    details: { job: 'embed', status: 'completed' },
  });
  expect(calls).toEqual([{
    sql: squash(`INSERT INTO migration_impact_log (
         remediation_id, metric_name, metric_before, metric_after,
         job_id, source_id, brain_id, started_at, idempotency_key,
         applied_by, details
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text::jsonb)`),
    params: ['step-1', 'takes_count', 0, 2, 5, null, null, '2026-01-01T00:00:00.000Z', 'key', null, '{"job":"embed","status":"completed"}'],
  }]);
});

/** Master's four statements in search/two-pass.ts at a597e7a6c6, byte for byte (whitespace included). */
const MASTER_TWO_PASS = {
  nearScoped: "SELECT cc.id FROM content_chunks cc\n             JOIN pages p ON p.id = cc.page_id\n             WHERE cc.symbol_name_qualified = $1 AND p.source_id = $2\n             LIMIT 50",
  nearAnySource: "SELECT id FROM content_chunks WHERE symbol_name_qualified = $1 LIMIT 50",
  targetsScoped: "SELECT cc.id FROM content_chunks cc\n                 JOIN pages p ON p.id = cc.page_id\n                 WHERE cc.symbol_name_qualified = ANY($1::text[])\n                   AND p.source_id = $2\n                 LIMIT 50",
  targetsAnySource: "SELECT id FROM content_chunks WHERE symbol_name_qualified = ANY($1::text[]) LIMIT 50",
};

test('the two-pass symbol lookups send master\'s four statements byte for byte, with master\'s parameters', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const exec = { executeRaw: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return [{ id: '3' }, { id: 5 }]; } } as never;
  expect(await listSymbolChunkIds(exec, 'near_symbol', ['mod.helper'], 'src-a')).toEqual([3, 5]);
  expect(await listSymbolChunkIds(exec, 'near_symbol', ['mod.helper'])).toEqual([3, 5]);
  expect(await listSymbolChunkIds(exec, 'edge_targets', ['mod.a', 'mod.b'], 'src-a')).toEqual([3, 5]);
  expect(await listSymbolChunkIds(exec, 'edge_targets', ['mod.a', 'mod.b'])).toEqual([3, 5]);
  expect(await listSymbolChunkIds(exec, 'edge_targets', [])).toEqual([]);
  expect(calls).toEqual([
    { sql: MASTER_TWO_PASS.nearScoped, params: ['mod.helper', 'src-a'] },
    { sql: MASTER_TWO_PASS.nearAnySource, params: ['mod.helper'] },
    { sql: MASTER_TWO_PASS.targetsScoped, params: [['mod.a', 'mod.b'], 'src-a'] },
    { sql: MASTER_TWO_PASS.targetsAnySource, params: [['mod.a', 'mod.b']] },
  ]);
});
