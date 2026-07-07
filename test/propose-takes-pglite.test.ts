/**
 * Regression coverage for propose_takes proposal identity against real PGLite.
 * The mock-only unit file does not enforce SQL uniqueness, which is the bug
 * class that dropped same-page claim #2+.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';
import {
  PROPOSE_TAKES_PROMPT_VERSION,
  contentHash,
  proposalClaimHash,
  runPhaseProposeTakes,
  type ProposeTakesExtractor,
} from '../src/core/cycle/propose-takes.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function ctx(): OperationContext {
  return {
    engine,
    config: {} as never,
    logger: { info() {}, warn() {}, error() {} } as never,
    dryRun: false,
    remote: false,
    sourceId: 'default',
  };
}

describe('propose_takes — PGLite proposal identity', () => {
  test('same-page multi-claim extraction persists every claim and writes one scan marker', async () => {
    await engine.putPage('wiki/propose-multi', {
      title: 'Propose multi',
      type: 'analysis',
      compiled_truth: 'This page contains two independent gradeable claims.',
    });

    const extractor: ProposeTakesExtractor = async () => [
      { claim_text: 'First claim persists', kind: 'take', holder: 'brain', weight: 0.6 },
      { claim_text: 'Second claim also persists', kind: 'bet', holder: 'brain', weight: 0.7 },
    ];

    const result = await runPhaseProposeTakes(ctx(), { extractor, pageLimit: 1 });
    const details = result.details as Record<string, unknown>;
    expect(details.proposals_extracted).toBe(2);
    expect(details.proposals_inserted).toBe(2);

    const rows = await engine.executeRaw<{ count: number }>(
      `SELECT count(*)::int AS count FROM take_proposals WHERE page_slug = 'wiki/propose-multi'`,
    );
    expect(rows[0]!.count).toBe(2);

    const scans = await engine.executeRaw<{ extracted_count: number; inserted_count: number }>(
      `SELECT extracted_count, inserted_count FROM take_proposal_scans WHERE page_slug = 'wiki/propose-multi'`,
    );
    expect(scans).toHaveLength(1);
    expect(scans[0]!.extracted_count).toBe(2);
    expect(scans[0]!.inserted_count).toBe(2);
  });

  test('unchanged rerun hits scan cache and does not call extractor again', async () => {
    await engine.putPage('wiki/propose-cache', {
      title: 'Propose cache',
      type: 'analysis',
      compiled_truth: 'A stable page body.',
    });

    const calls: string[] = [];
    const extractor: ProposeTakesExtractor = async ({ pagePath }) => {
      calls.push(pagePath);
      if (pagePath !== 'wiki/propose-cache') return [];
      return [{ claim_text: 'Stable claim', kind: 'take', holder: 'brain', weight: 0.55 }];
    };

    await runPhaseProposeTakes(ctx(), { extractor, pageLimit: 5 });
    const second = await runPhaseProposeTakes(ctx(), { extractor, pageLimit: 5 });

    expect(calls.filter(slug => slug === 'wiki/propose-cache')).toHaveLength(1);
    const details = second.details as Record<string, unknown>;
    expect(details.cache_hits).toBeGreaterThanOrEqual(1);
    expect(details.proposals_inserted).toBe(0);
  });

  test('zero-claim extraction writes a scan marker so unchanged pages do not re-bill', async () => {
    await engine.putPage('wiki/propose-zero', {
      title: 'Propose zero',
      type: 'analysis',
      compiled_truth: 'Only factual notes, no gradeable claims.',
    });

    let calls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      calls += 1;
      return [];
    };

    const first = await runPhaseProposeTakes(ctx(), { extractor, pageLimit: 1 });
    const second = await runPhaseProposeTakes(ctx(), { extractor, pageLimit: 1 });

    expect(calls).toBe(1);
    expect((first.details as Record<string, unknown>).proposals_extracted).toBe(0);
    expect((second.details as Record<string, unknown>).cache_hits).toBe(1);

    const scans = await engine.executeRaw<{ extracted_count: number; inserted_count: number }>(
      `SELECT extracted_count, inserted_count FROM take_proposal_scans WHERE page_slug = 'wiki/propose-zero'`,
    );
    expect(scans).toHaveLength(1);
    expect(scans[0]!.extracted_count).toBe(0);
    expect(scans[0]!.inserted_count).toBe(0);
  });

  test('backfilled claim_hash blocks duplicate proposal after page content changes', async () => {
    const oldBody = 'Old body containing a claim.';
    const changedBody = 'Changed body still containing the same claim plus more context.';
    const claim = { claim_text: 'The same claim survives editing', kind: 'take' as const, holder: 'brain' };

    await engine.executeRaw(
      `INSERT INTO take_proposals
         (source_id, page_slug, content_hash, prompt_version, claim_hash, proposal_run_id,
          claim_text, kind, holder, weight, model_id)
       VALUES ('default', 'wiki/propose-changed', $1, $2, $3, 'legacy-run', $4, 'take', 'brain', 0.5, 'test-model')`,
      [contentHash(oldBody), PROPOSE_TAKES_PROMPT_VERSION, proposalClaimHash(claim), claim.claim_text],
    );
    await engine.putPage('wiki/propose-changed', {
      title: 'Propose changed',
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
      `SELECT count(*)::int AS count FROM take_proposals WHERE page_slug = 'wiki/propose-changed'`,
    );
    expect(rows[0]!.count).toBe(1);
  });

  test('migration v123 backfills claim_hash with runtime canonicalization', async () => {
    const migration = MIGRATIONS.find(m => m.version === 123);
    expect(migration).toBeDefined();

    await engine.executeRaw(`DELETE FROM take_proposal_scans`);
    await engine.executeRaw(`DELETE FROM take_proposals`);
    await engine.executeRaw(`DROP INDEX IF EXISTS take_proposals_claim_identity_idx`);
    await engine.executeRaw(`ALTER TABLE take_proposals DROP COLUMN IF EXISTS claim_hash`);
    await engine.executeRaw(`CREATE UNIQUE INDEX IF NOT EXISTS take_proposals_idempotency_idx
      ON take_proposals (source_id, page_slug, content_hash, prompt_version)`);

    const claim = { claim_text: '  Same\n\tClaim   Spacing  ', kind: 'take' as const, holder: 'Brain' };
    await engine.executeRaw(
      `INSERT INTO take_proposals
         (source_id, page_slug, content_hash, prompt_version, proposal_run_id,
          claim_text, kind, holder, weight, model_id)
       VALUES ('default', 'wiki/migration-parity', $1, $2, 'legacy-run', $3, 'take', 'Brain', 0.5, 'test-model')`,
      [contentHash('legacy body'), PROPOSE_TAKES_PROMPT_VERSION, claim.claim_text],
    );

    await (engine as any).db.exec(migration!.sql);

    const rows = await engine.executeRaw<{ claim_hash: string }>(
      `SELECT claim_hash FROM take_proposals WHERE page_slug = 'wiki/migration-parity'`,
    );
    expect(rows[0]!.claim_hash).toBe(proposalClaimHash(claim));
  });
});
