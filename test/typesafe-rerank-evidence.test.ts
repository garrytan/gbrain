/** Recorded native receipts are external evidence; keep reproduction separate from new timing samples. */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import receipt from '../docs/eval/typesafe-rerank/receipt.json';
import knownCases from '../docs/eval/typesafe-rerank/known-case-results.json';
import { createJevRerankWorkloads } from '../scripts/fixtures/jev-rerank-workloads.ts';
import { buildTypeSafeRerankBatches } from '../src/core/ai/rerank-typesafe.ts';
import { capRerankDoc } from '../src/core/search/rerank.ts';
import { parsePools } from '../scripts/typesafe-rerank-ab.ts';

const pools = createJevRerankWorkloads();
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

test('portable generator reproduces the captured canonical input fingerprint', () => {
  expect(sha(JSON.stringify(pools))).toBe(receipt.shortlist_sha256);
  expect(pools.every(pool => pool.candidates.every(doc => capRerankDoc(doc.text) === doc.text))).toBe(true);
  expect(receipt.status).toBe('complete');
  expect(receipt.repeats).toBe(1);
  expect(receipt.requests).toHaveLength(31);
});

describe.each(parsePools(readFileSync(new URL('./fixtures/retrieval-quality/typesafe-rerank-cases.jsonl', import.meta.url), 'utf8')))
  ('$id selected Jev known-case evidence', pool => {
    test('captured native judgment and required pair checks refer to the current exact payload', () => {
      const run = knownCases.runs.find(row => row.pool === pool.id)!;
      const request = knownCases.requests.find(row => row.profile_id === `question-local-packed/${pool.id}`)!;
      const batches = buildTypeSafeRerankBatches('jev-1.13.0', pool.query, pool.candidates.map(doc => doc.text));
      expect(batches).toHaveLength(1);
      expect(sha(batches[0]!.body)).toBe(request.request_sha256);
      expect(sha(JSON.stringify(pool.candidates))).toBe(run.shortlist_sha256);
      expect(run.status).toBe('complete');
      expect(request.http_status).toBe(200);
      expect(request.result_count).toBe(pool.candidates.length);
      expect(new Set(run.scores.map(row => row.id))).toEqual(new Set(pool.candidates.map(doc => doc.id)));
      expect(pool.relevant).toContain(run.scores[0]!.id);
      const authored = pool as typeof pool & { required_pairs: [string, string][] };
      expect(run.pair_checks.map(pair => [pair.higher, pair.lower])).toEqual(authored.required_pairs);
      const scores = new Map(run.scores.map(row => [row.id, row.score]));
      for (const pair of run.pair_checks) {
        expect(pair.pass).toBe(true);
        expect(scores.get(pair.higher)!).toBeGreaterThan(scores.get(pair.lower)!);
      }
    });
  });

describe.each(pools)('$id completed pilot evidence', pool => {
  test('current Jev planner reproduces every captured native request body', () => {
    const batches = buildTypeSafeRerankBatches('jev-1.13.0', pool.query, pool.candidates.map(doc => doc.text));
    const requests = receipt.requests.filter(row => row.profile_id === pool.id && row.model === 'typesafe:jev-1.13.0');
    expect(batches).toHaveLength(requests.length);
    for (const [i, batch] of batches.entries()) {
      expect(sha(batch.body)).toBe(requests[i]!.request_sha256);
      expect(batch.indices[0]).toBe(requests[i]!.document_offset);
      expect(batch.indices.length).toBe(requests[i]!.document_count);
      expect(batch.estimatedInputTokens).toBe(requests[i]!.estimated_input_tokens);
    }
  });

  test.each(['voyage:rerank-3', 'typesafe:jev-1.13.0'])('%s coverage and actual usage/cost reconcile', model => {
    const requests = receipt.requests.filter(row => row.profile_id === pool.id && row.model === model);
    const result = receipt.rows.find(row => row.id === pool.id)!;
    const arm = model === 'voyage:rerank-3' ? result['voyage:rerank-3'] : result['typesafe:jev-1.13.0'];
    expect(sha(JSON.stringify(pool.candidates))).toBe(result.shortlist_sha256);
    let covered = 0;
    for (const request of requests) {
      expect(request.document_offset).toBe(covered);
      covered += request.document_count;
      expect(request.result_count).toBe(request.document_count);
      expect(request.http_status).toBe(200);
      expect(request.response_complete).toBe(true);
      expect(request.failure).toBeNull();
      expect(request.input_tokens).not.toBeNull();
      expect(request.cost_usd).toBeCloseTo(request.input_tokens * (model.startsWith('voyage:') ? 0.05 : 0.042) / 1_000_000, 12);
    }
    expect(covered).toBe(pool.candidates.length);
    expect(requests.length).toBe(arm.provider_calls);
    expect(requests.reduce((n, request) => n + request.input_tokens, 0)).toBe(arm.input_tokens);
    expect(requests.reduce((n, request) => n + request.cost_usd, 0)).toBeCloseTo(arm.cost_usd, 12);
    expect(arm.order).toHaveLength(pool.candidates.length);
    expect(new Set(arm.order)).toEqual(new Set(pool.candidates.map(doc => doc.id)));
    expect(pool.relevant).toContain(arm.order[0]!);
    expect(arm.latency_samples_ms).toHaveLength(1);
    expect(arm.wall_samples_ms[0]).toBeGreaterThanOrEqual(arm.latency_samples_ms[0]!);
  });
});
