import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  runPhaseProposeTakes,
  type ProposeTakesExtractor,
} from '../src/core/cycle/propose-takes.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';
import type { OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function context(): OperationContext {
  return {
    engine,
    config: {} as never,
    logger: { info() {}, warn() {}, error() {} } as never,
    dryRun: false,
    remote: false,
    sourceId: 'default',
  };
}

const proposals: ProposeTakesExtractor = async () => [
  { claim_text: 'Claim one', kind: 'take', holder: 'brain', weight: 0.6 },
  { claim_text: 'Claim two', kind: 'bet', holder: 'brain', weight: 0.8 },
  { claim_text: 'Claim one', kind: 'take', holder: 'brain', weight: 0.6 },
];

async function putThesis(): Promise<void> {
  await engine.putPage('wiki/essays/thesis', {
    title: 'thesis',
    type: 'analysis' as never,
    compiled_truth: 'Two strong claims live in this essay.',
    frontmatter: {},
    timeline: '',
  });
}

async function countProposals(): Promise<number> {
  const rows = await engine.executeRaw<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM take_proposals
      WHERE source_id = 'default' AND page_slug = 'wiki/essays/thesis'`,
  );
  return Number(rows[0]!.n);
}

describe('per-claim proposal idempotency', () => {
  test('persists an empty-result tombstone so unchanged pages are not re-sent to the model', async () => {
    await putThesis();
    let calls = 0;
    const empty: ProposeTakesExtractor = async () => {
      calls += 1;
      return [];
    };
    const first = await runPhaseProposeTakes(context(), {
      extractor: empty,
      requireChunks: false,
    });
    const second = await runPhaseProposeTakes(context(), {
      extractor: empty,
      requireChunks: false,
    });
    expect(calls).toBe(1);
    expect((first.details as Record<string, unknown>).tombstones_written).toBe(1);
    expect((second.details as Record<string, unknown>).cache_hits).toBe(1);
    const rows = await engine.executeRaw<{ claim_text: string; status: string }>(
      `SELECT claim_text, status FROM take_proposals
        WHERE page_slug = 'wiki/essays/thesis'`,
    );
    expect(rows).toEqual([{ claim_text: '(no gradeable claims)', status: 'rejected' }]);
  });

  test('keeps distinct same-page claims and drops a repeated claim', async () => {
    await putThesis();
    const result = await runPhaseProposeTakes(context(), {
      extractor: proposals,
      requireChunks: false,
    });
    expect((result.details as Record<string, unknown>).proposals_inserted).toBe(2);
    expect(await countProposals()).toBe(2);
  });

  test('migration v112 replaces the old-shaped index', async () => {
    await engine.executeRaw('DROP INDEX IF EXISTS take_proposals_idempotency_idx');
    await engine.executeRaw(
      `CREATE INDEX take_proposals_idempotency_idx
         ON take_proposals (source_id, page_slug, content_hash, prompt_version)`,
    );
    const migration = MIGRATIONS.find((entry) => entry.version === 112);
    expect(migration).toBeDefined();
    for (const statement of migration!.sql!.split(';').map(value => value.trim()).filter(Boolean)) {
      await engine.executeRaw(statement);
    }

    await putThesis();
    const result = await runPhaseProposeTakes(context(), {
      extractor: proposals,
      requireChunks: false,
    });
    expect((result.details as Record<string, unknown>).proposals_inserted).toBe(2);
    expect(await countProposals()).toBe(2);
  });
});
