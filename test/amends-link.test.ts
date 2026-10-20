/**
 * The non-ranking `amends` link on PGLite (Postgres twin:
 * test/e2e/amends-link-postgres.test.ts): one final-output invariance row per
 * link-counting ranking consumer, amendments versus genuine replacement in
 * final search scores and labels, the example pack's frontmatter mapping and
 * `since`, and the frozen-clock liveness exemption.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, setSystemTime, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { setPackRelationSemantics } from '../src/core/link-validity.ts';
import { linkTypeRanks, NON_RANKING_LINK_TYPES, rankingLinkSql } from '../src/core/link-ranking-policy.ts';
import { loadPackFromFile } from '../src/core/schema-pack/loader.ts';
import { fileURLToPath } from 'node:url';
import { INVARIANCE_ROWS, amendmentsVersusReplacement, databaseToday, frontmatterRecordsSince, futureAmendsStayVisible,
  runInvarianceRow, useExamplePack } from './helpers/amends-ranking-scenarios.ts';

setDefaultTimeout(60_000);
let engine: PGLiteEngine;
let restorePacks: () => void;

beforeAll(async () => {
  restorePacks = useExamplePack();
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); resetGateway(); setPackRelationSemantics(new Map()); restorePacks(); });
beforeEach(async () => { await resetPgliteState(engine); configureGateway({ env: {} } as never); setPackRelationSemantics(new Map()); });

describe('ranking participation policy', () => {
  test('amends is the non-ranking link type; the SQL predicate inlines it', () => {
    expect(NON_RANKING_LINK_TYPES).toEqual(['amends']);
    expect(linkTypeRanks('amends')).toBe(false);
    expect(linkTypeRanks('supersedes')).toBe(true);
    expect(linkTypeRanks('mentions')).toBe(true);
    expect(rankingLinkSql('l')).toBe(`l.link_type <> ALL(ARRAY['amends']::text[])`);
  });

  test('the bundled example pack is a valid manifest declaring amends as an event mapped from frontmatter', () => {
    const manifest = loadPackFromFile(fileURLToPath(new URL('../examples/schema-packs/amends-example/pack.yaml', import.meta.url)));
    expect(manifest.link_types).toEqual([{ name: 'amends', temporal: 'event' }, { name: 'supersedes' }]);
    expect(manifest.frontmatter_links).toEqual([
      { page_type: 'contract', fields: ['amends'], link_type: 'amends' },
      { page_type: 'contract', fields: ['supersedes'], link_type: 'supersedes' },
    ]);
  });
});

describe('final-output invariance: one row per link-counting ranking consumer', () => {
  for (const row of INVARIANCE_ROWS) {
    test(`${row.consumer} — threshold: ${row.threshold}`, () => runInvarianceRow(engine, row));
  }
});

describe('amendments versus replacement', () => {
  test('current and future amendments leave scores and labels unchanged; supersedes halves and labels', () => amendmentsVersusReplacement(engine));
  test('frontmatter amends objects record since as first_start in both scopes, each on its exact target', () => frontmatterRecordsSince(engine));
});

describe('liveness exemption (frozen clock)', () => {
  test('a future-since amends edge stays visible in get_backlinks, traverse_graph and card edges', async () => {
    const today = await databaseToday(engine);
    setSystemTime(new Date(`${today}T12:00:00Z`));
    try { await futureAmendsStayVisible(engine, today); } finally { setSystemTime(); }
  });
});
