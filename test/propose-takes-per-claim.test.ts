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

async function countProposals(slug: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM take_proposals
      WHERE page_slug = $1 AND source_id = 'default'`,
    [slug],
  );
  return Number(rows[0]!.n);
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

describe('#2138 per-claim proposal idempotency', () => {
  test('keeps distinct claims, drops repeated claim, then page-cache hits', async () => {
    await putThesis();
    const result = await runPhaseProposeTakes(context(), { extractor: proposals });
    expect((result.details as Record<string, unknown>).proposals_inserted).toBe(2);
    expect(await countProposals('wiki/essays/thesis')).toBe(2);

    const rerun = await runPhaseProposeTakes(context(), { extractor: proposals });
    expect((rerun.details as Record<string, unknown>).cache_hits).toBe(1);
    expect(await countProposals('wiki/essays/thesis')).toBe(2);
  });

  test('migration v125 replaces the old-shaped index', async () => {
    await engine.executeRaw('DROP INDEX IF EXISTS take_proposals_idempotency_idx');
    await engine.executeRaw(
      `CREATE INDEX take_proposals_idempotency_idx
         ON take_proposals (source_id, page_slug, content_hash, prompt_version)`,
    );
    const migration = MIGRATIONS.find((entry) => entry.version === 125);
    expect(migration).toBeDefined();
    for (const statement of migration!.sql!.split(';').map(value => value.trim()).filter(Boolean)) {
      await engine.executeRaw(statement);
    }

    await putThesis();
    const result = await runPhaseProposeTakes(context(), { extractor: proposals });
    expect((result.details as Record<string, unknown>).proposals_inserted).toBe(2);
    expect(await countProposals('wiki/essays/thesis')).toBe(2);
  });
});
