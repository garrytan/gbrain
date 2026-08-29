/**
 * Postgres-only regression for the propose_takes JSONB binds (D3, #2339 class).
 *
 * `runPhaseProposeTakes` writes `take_proposals.dedup_against_fence_rows`
 * (JSONB) at two sites — the per-proposal dedup write and the empty-extraction
 * tombstone — binding `JSON.stringify(existingTakes)` positionally. Under
 * postgres.js `.unsafe()`, a JS string bound to a param whose described type
 * is jsonb gets re-serialized by the driver's json serializer, landing as a
 * double-encoded jsonb STRING scalar instead of an array. PGLite parses the
 * text natively and hides the bug, so this is DATABASE_URL-gated per the
 * engine-parity convention.
 *
 * Pins: both write sites produce `jsonb_typeof = 'array'` and the dedup rows'
 * elements round-trip their fields (`-> 0 ->> 'claim'` resolves).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupDB, teardownDB, hasDatabase } from './helpers.ts';
import {
  runPhaseProposeTakes,
  EMPTY_EXTRACTION_TOMBSTONE_TEXT,
  type ProposeTakesExtractor,
} from '../../src/core/cycle/propose-takes.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { OperationContext } from '../../src/core/operations.ts';

const skip = !hasDatabase();
const describeIfDB = skip ? describe.skip : describe;

let engine: PostgresEngine;

const FENCE = [
  '<!-- gbrain:takes:begin -->',
  '| # | Claim | Kind | Holder | Weight |',
  '|---|-------|------|--------|--------|',
  '| 1 | Cities send messages | take | brain | 0.65 |',
  '<!-- gbrain:takes:end -->',
].join('\n');

function buildCtx(e: PostgresEngine): OperationContext {
  return {
    engine: e,
    config: {} as never,
    logger: { info() {}, warn() {}, error() {} } as never,
    dryRun: false,
    remote: false,
    sourceId: 'default',
  };
}

beforeAll(async () => {
  if (skip) return;
  engine = await setupDB();
  // take_proposals is not in the helpers' truncate list; clear stale rows so
  // idempotency-cache hits from a prior run can't skip the write under test.
  await engine.executeRaw(`TRUNCATE take_proposals CASCADE`);

  // Page A: carries a takes fence → non-empty existingTakes; extractor
  // proposes one claim → exercises the dedup write (site 1).
  await engine.putPage('takes/fence-page', {
    type: 'analysis',
    title: 'Fence page',
    compiled_truth: `Prose about cities.\n\n${FENCE}\n`,
    timeline: '',
  });
  // Page B: also carries a fence (non-empty existingTakes) but the extractor
  // returns zero claims → exercises the tombstone write (site 2).
  await engine.putPage('takes/empty-page', {
    type: 'analysis',
    title: 'Empty page',
    compiled_truth: `Nothing gradeable here.\n\n${FENCE}\n`,
    timeline: '',
  });
});

afterAll(async () => {
  if (skip) return;
  await teardownDB();
});

describeIfDB('propose_takes dedup_against_fence_rows JSONB — Postgres regression (D3)', () => {
  test('both write sites land jsonb arrays, never double-encoded strings', async () => {
    const extractor: ProposeTakesExtractor = async ({ pagePath }) => {
      if (pagePath === 'takes/fence-page') {
        return [{ claim_text: 'A brand-new claim', kind: 'take', holder: 'brain', weight: 0.7 }];
      }
      return [];
    };

    const result = await runPhaseProposeTakes(buildCtx(engine), {
      extractor,
      pageLimit: 10,
    });

    // The phase catches thrown errors into status:'fail' — surface them.
    expect(result.error?.message ?? '').toBe('');
    expect(result.status).not.toBe('fail');
    expect(result.details.proposals_inserted).toBe(1);
    expect(result.details.tombstones_written).toBe(1);

    // Site 1: the dedup write. Must be a real jsonb array whose first element
    // round-trips the fence row it recorded.
    const dedup = await engine.executeRaw<{
      kind: string;
      first_claim: string | null;
      first_weight: string | null;
    }>(
      `SELECT jsonb_typeof(dedup_against_fence_rows) AS kind,
              dedup_against_fence_rows -> 0 ->> 'claim' AS first_claim,
              dedup_against_fence_rows -> 0 ->> 'weight' AS first_weight
         FROM take_proposals
        WHERE page_slug = $1 AND claim_text = $2`,
      ['takes/fence-page', 'A brand-new claim'],
    );
    expect(dedup.length).toBe(1);
    expect(dedup[0]!.kind).toBe('array');
    expect(dedup[0]!.first_claim).toBe('Cities send messages');
    expect(dedup[0]!.first_weight).toBe('0.65');

    // Site 2: the empty-extraction tombstone. Same column, same doctrine —
    // an array (here non-empty, from page B's fence), never a jsonb string.
    const tomb = await engine.executeRaw<{
      kind: string;
      first_claim: string | null;
      status: string;
    }>(
      `SELECT jsonb_typeof(dedup_against_fence_rows) AS kind,
              dedup_against_fence_rows -> 0 ->> 'claim' AS first_claim,
              status
         FROM take_proposals
        WHERE page_slug = $1 AND claim_text = $2`,
      ['takes/empty-page', EMPTY_EXTRACTION_TOMBSTONE_TEXT],
    );
    expect(tomb.length).toBe(1);
    expect(tomb[0]!.status).toBe('rejected');
    expect(tomb[0]!.kind).toBe('array');
    expect(tomb[0]!.first_claim).toBe('Cities send messages');
  });
});
