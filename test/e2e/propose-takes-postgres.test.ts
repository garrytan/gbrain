/**
 * Real-Postgres coverage for propose_takes proposal identity.
 * PGLite caught the local regression; this pins the same unique-index behavior
 * on Postgres so engine/index parity does not silently drift.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';

import { setupDB, teardownDB, hasDatabase, getEngine } from './helpers.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import {
  PROPOSE_TAKES_PROMPT_VERSION,
  contentHash,
  proposalClaimHash,
  runPhaseProposeTakes,
  type ProposeTakesExtractor,
} from '../../src/core/cycle/propose-takes.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;

beforeAll(async () => {
  if (!RUN) return;
  await setupDB();
});

afterAll(async () => {
  if (!RUN) return;
  await teardownDB();
});

function ctx(): OperationContext {
  return {
    engine: getEngine(),
    config: {} as never,
    logger: { info() {}, warn() {}, error() {} } as never,
    dryRun: false,
    remote: false,
    sourceId: 'default',
  };
}

d('propose_takes — Postgres proposal identity', () => {
  test('same-page multi-claim extraction persists every claim', async () => {
    const engine = getEngine();
    await engine.putPage('wiki/pg-propose-multi', {
      title: 'PG propose multi',
      type: 'analysis',
      compiled_truth: 'Postgres page with two gradeable claims.',
    });

    const extractor: ProposeTakesExtractor = async () => [
      { claim_text: 'Postgres first claim persists', kind: 'take', holder: 'brain', weight: 0.6 },
      { claim_text: 'Postgres second claim also persists', kind: 'bet', holder: 'brain', weight: 0.7 },
    ];

    const result = await runPhaseProposeTakes(ctx(), { extractor, pageLimit: 1 });
    const details = result.details as Record<string, unknown>;
    expect(details.proposals_extracted).toBe(2);
    expect(details.proposals_inserted).toBe(2);

    const rows = await engine.executeRaw<{ count: number }>(
      `SELECT count(*)::int AS count FROM take_proposals WHERE page_slug = 'wiki/pg-propose-multi'`,
    );
    expect(rows[0]!.count).toBe(2);
  });

  test('claim_hash uniqueness blocks duplicate after page content changes', async () => {
    const engine = getEngine();
    const oldBody = 'Postgres old body with claim.';
    const changedBody = 'Postgres changed body with the same claim and extra context.';
    const claim = { claim_text: 'Postgres duplicate claim blocked', kind: 'take' as const, holder: 'brain' };

    await engine.executeRaw(
      `INSERT INTO take_proposals
         (source_id, page_slug, content_hash, prompt_version, claim_hash, proposal_run_id,
          claim_text, kind, holder, weight, model_id)
       VALUES ('default', 'wiki/pg-propose-changed', $1, $2, $3, 'legacy-run', $4, 'take', 'brain', 0.5, 'test-model')`,
      [contentHash(oldBody), PROPOSE_TAKES_PROMPT_VERSION, proposalClaimHash(claim), claim.claim_text],
    );
    await engine.putPage('wiki/pg-propose-changed', {
      title: 'PG propose changed',
      type: 'analysis',
      compiled_truth: changedBody,
    });

    const extractor: ProposeTakesExtractor = async () => [
      { ...claim, weight: 0.9 },
    ];

    const result = await runPhaseProposeTakes(ctx(), { extractor, pageLimit: 1 });
    const details = result.details as Record<string, unknown>;
    expect(details.proposals_extracted).toBe(1);
    expect(details.proposals_inserted).toBe(0);

    const rows = await engine.executeRaw<{ count: number }>(
      `SELECT count(*)::int AS count FROM take_proposals WHERE page_slug = 'wiki/pg-propose-changed'`,
    );
    expect(rows[0]!.count).toBe(1);
  });
});
