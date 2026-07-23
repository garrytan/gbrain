/**
 * #2138 — take_proposals per-claim idempotency (DB-level proof).
 *
 * Hermetic PGLite. The mock-engine tests in propose-takes.test.ts can't
 * observe an ON CONFLICT DO NOTHING drop — only a real unique index can.
 * Pre-fix the idempotency index was per-PAGE (source_id, page_slug,
 * content_hash, prompt_version), so every claim after the first on a
 * multi-claim page was silently dropped. Covers:
 *  - fresh-install blob: every claim on a multi-claim page lands
 *  - extractor repeating a claim: dropped without inflating the counter
 *  - re-run: page-level cache hit, no duplicate rows
 *  - migration v125: upgrades the old per-page index to the per-claim key
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
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

async function countProposals(slug: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM take_proposals WHERE page_slug = $1 AND source_id = 'default'`,
    [slug],
  );
  return parseInt(rows[0]!.n, 10);
}

describe('#2138: per-claim idempotency against the real unique index', () => {
  test('multi-claim page keeps every claim; dup claim dropped; re-run cache-hits', async () => {
    await engine.putPage('wiki/essays/thesis', {
      title: 'thesis',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type: 'analysis' as any,
      compiled_truth: 'Two strong claims live in this essay.',
      frontmatter: {},
      timeline: '',
    });
    const extractor: ProposeTakesExtractor = async () => [
      { claim_text: 'Claim one', kind: 'take', holder: 'brain', weight: 0.6 },
      { claim_text: 'Claim two', kind: 'bet', holder: 'brain', weight: 0.8 },
      // Extractor repeating itself — the per-claim key conflicts it away.
      { claim_text: 'Claim one', kind: 'take', holder: 'brain', weight: 0.6 },
    ];

    const result = await runPhaseProposeTakes(ctx(), { extractor });
    const details = result.details as Record<string, unknown>;
    expect(details.proposals_inserted).toBe(2);
    expect(await countProposals('wiki/essays/thesis')).toBe(2);

    // Re-run: page-level (content_hash, prompt_version) cache hit — the
    // extractor is not consulted for the thesis page and no rows are added
    // for it. (Run 1's receipt page also gets scanned on the re-run — that's
    // existing Wave B3 behavior, so assertions stay scoped to the thesis slug.)
    const again = await runPhaseProposeTakes(ctx(), { extractor });
    const d2 = again.details as Record<string, unknown>;
    expect(d2.cache_hits).toBe(1);
    expect(await countProposals('wiki/essays/thesis')).toBe(2);
  });

  test('migration v125 upgrades the old per-page index to the per-claim key', async () => {
    // Recreate the pre-v125 shape (table exists, per-page unique index).
    await engine.executeRaw(`DROP INDEX IF EXISTS take_proposals_idempotency_idx`);
    await engine.executeRaw(
      `CREATE UNIQUE INDEX take_proposals_idempotency_idx
         ON take_proposals (source_id, page_slug, content_hash, prompt_version)`,
    );

    const m = MIGRATIONS.find((x) => x.version === 125);
    expect(m).toBeDefined();
    for (const stmt of m!.sql!.split(';').map((s) => s.trim()).filter(Boolean)) {
      await engine.executeRaw(stmt);
    }

    await engine.putPage('wiki/essays/thesis', {
      title: 'thesis',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type: 'analysis' as any,
      compiled_truth: 'Two strong claims live in this essay.',
      frontmatter: {},
      timeline: '',
    });
    const extractor: ProposeTakesExtractor = async () => [
      { claim_text: 'Claim one', kind: 'take', holder: 'brain', weight: 0.6 },
      { claim_text: 'Claim two', kind: 'bet', holder: 'brain', weight: 0.8 },
    ];
    const result = await runPhaseProposeTakes(ctx(), { extractor });
    const details = result.details as Record<string, unknown>;
    expect(details.proposals_inserted).toBe(2);
    expect(await countProposals('wiki/essays/thesis')).toBe(2);
  });
});
