/**
 * An approved `doctor --remediate --include-repairs` run survives a server
 * ANALYZE between preview and run (GBRA-101, after LHF wave 2 item 6).
 *
 * Contract protected: the plan_hash an operator approves binds the repair
 * steps that rewrite stored records. planner-stats plans from live server
 * statistics (pg_stat counters, pg_stats rows for expression indexes) that
 * autovacuum changes on its own schedule, and its ANALYZE changes no stored
 * record, so it is not part of the approval: an autoanalyze landing between
 * `--remediation-plan` and the run must not refuse it with preview_changed.
 * A real plan change (a new pending repair) still refuses. Regression that
 * fails it: the selection carried planner-stats with its table count as the
 * revision, so the approved hash went stale the moment the table was analyzed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { PAGES_NAME_LOOKUP_INDEXES } from '../../src/core/schema-migrations/v240-pages-name-lookup-indexes.ts';
import { readExpressionIndexesWithoutStats } from '../../src/core/planner-stats.ts';
import { planRepairSteps } from '../../src/core/remediation/repairs.ts';
import { runRemediate } from '../../src/commands/doctor/remediate.ts';
import { approvedRemediateArgs } from '../helpers/remediate-approval.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;
const TITLE_INDEX = PAGES_NAME_LOOKUP_INDEXES[0];
const ARGS = ['--remediate', '--yes', '--include-repairs', '--no-embed', '--max-usd', '0', '--json'];

async function quiet(fn: () => Promise<void>): Promise<string | null> {
  const log = console.log, error = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    await fn();
    return null;
  } catch (err) {
    return String((err as { code?: unknown }).code ?? (err as Error).message);
  } finally {
    console.log = log;
    console.error = error;
  }
}

d('remediation approval and planner statistics (Postgres)', () => {
  beforeAll(async () => {
    const engine = await setupDB();
    await engine.executeRaw('ALTER TABLE pages SET (autovacuum_enabled = false)');
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title) SELECT 'default', 'people/approval-' || g, 'person', 'Person Example ' || g FROM generate_series(1, 20) g`);
  });
  afterAll(async () => {
    const engine = getEngine();
    await engine.executeRaw('ALTER TABLE pages RESET (autovacuum_enabled)');
    await teardownDB();
  });

  /** The state an upgrade leaves before autoanalyze: pages analyzed, then the expression index built with no ANALYZE after it. */
  async function unanalyzedIndex(): Promise<void> {
    const engine = getEngine();
    await engine.executeRaw(`DROP INDEX IF EXISTS ${TITLE_INDEX.name}`);
    await engine.executeRaw('ANALYZE pages');
    await engine.executeRaw(TITLE_INDEX.sql);
    expect(await readExpressionIndexesWithoutStats(engine)).toEqual([{ index: TITLE_INDEX.name, table: 'pages' }]);
    expect((await planRepairSteps(engine, { noEmbed: true })).map(step => step.kind)).toContain('planner-stats');
  }

  test('an ANALYZE between the approval and the run does not invalidate the approved plan', async () => {
    const engine = getEngine();
    await unanalyzedIndex();
    const approved = await approvedRemediateArgs(engine, ARGS);
    await engine.executeRaw('ANALYZE pages');
    expect(await readExpressionIndexesWithoutStats(engine)).toEqual([]);
    expect(await quiet(() => runRemediate(engine, approved))).toBeNull();
  }, 120_000);

  test('a new pending repair between the approval and the run still refuses with preview_changed', async () => {
    const engine = getEngine();
    await unanalyzedIndex();
    const approved = await approvedRemediateArgs(engine, ARGS);
    await engine.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) VALUES('managed-connector',$1,'[]'::jsonb,now()-interval '9 days')", [`orphan-${randomUUID()}`]);
    expect((await planRepairSteps(engine, { noEmbed: true })).map(step => step.kind)).toContain('connector-checkpoints');
    expect(await quiet(() => runRemediate(engine, approved))).toBe('preview_changed');
  }, 120_000);
});
