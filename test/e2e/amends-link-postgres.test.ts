/**
 * Postgres twin of test/amends-link.test.ts: the per-consumer final-output
 * invariance table for the non-ranking `amends` link, amendments versus
 * replacement in final search scores and labels, frontmatter `since`, and the
 * frozen-clock liveness exemption. One cloned database per scenario.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, setSystemTime, test } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase } from './helpers.ts';
import { persistencePostgresTemplate } from '../helpers/persistence-postgres.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { setPackRelationSemantics } from '../../src/core/link-validity.ts';
import { INVARIANCE_ROWS, amendmentsVersusReplacement, databaseToday, frontmatterRecordsSince, futureAmendsStayVisible,
  runInvarianceRow, useExamplePack } from '../helpers/amends-ranking-scenarios.ts';

const d = hasDatabase() ? describe : describe.skip;
let template: Awaited<ReturnType<typeof persistencePostgresTemplate>>;
let engine: PostgresEngine;
let close: () => Promise<void>;
let restorePacks: () => void;

d('non-ranking amends link (Postgres)', () => {
  beforeAll(async () => { restorePacks = useExamplePack(); template = await persistencePostgresTemplate(process.env.DATABASE_URL!); }, 120_000);
  afterAll(async () => { await template.dispose(); restorePacks(); });
  beforeEach(async () => { ({ engine, close } = await template.clone()); configureGateway({ env: {} } as never); setPackRelationSemantics(new Map()); }, 60_000);
  afterEach(async () => { resetGateway(); setPackRelationSemantics(new Map()); await close(); });

  for (const row of INVARIANCE_ROWS) {
    test(`invariance: ${row.consumer} — threshold: ${row.threshold}`, () => runInvarianceRow(engine, row), 60_000);
  }
  test('current and future amendments leave scores and labels unchanged; supersedes halves and labels', () => amendmentsVersusReplacement(engine), 60_000);
  test('frontmatter amends objects record since as first_start in both scopes, each on its exact target', () => frontmatterRecordsSince(engine), 60_000);
  test('frozen clock: a future-since amends edge stays visible in get_backlinks, traverse_graph and card edges', async () => {
    const today = await databaseToday(engine);
    setSystemTime(new Date(`${today}T12:00:00Z`));
    try { await futureAmendsStayVisible(engine, today); } finally { setSystemTime(); }
  }, 60_000);
});
