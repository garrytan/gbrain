/**
 * The Postgres arm of the non-ranking `amends` link cases (test/amends-link.test.ts runs them on PGLite): the
 * per-consumer final-output invariance table, amendments versus replacement in final search scores and labels,
 * frontmatter `since`, and the frozen-clock liveness exemption. One cloned database per scenario. Shared by
 * test/e2e/amends-link-postgres.test.ts and the typed preparation reads guard, so no test file imports another.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, setSystemTime, test } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase } from '../e2e/helpers.ts';
import { persistencePostgresTemplate } from './persistence-postgres.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { setPackRelationSemantics } from '../../src/core/link-validity.ts';
import { INVARIANCE_ROWS, amendmentsVersusReplacement, databaseToday, frontmatterRecordsSince, futureAmendsStayVisible,
  runInvarianceRow, useExamplePack } from './amends-ranking-scenarios.ts';

/** Registers the cases; they skip without DATABASE_URL. */
export function defineAmendsLinkPostgresCases(): void {
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
}
