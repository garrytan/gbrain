/**
 * Shadow write families for writes the shadow does not compare (src/shadow/write-capture.ts sampledStatements,
 * src/shadow/write-compare.ts writeFamily): a sampled raw SQL statement or a typed member outside the write map
 * is counted capability_missing under the first table it writes, so the swap report can name it.
 *
 * Protects: each of the 34 distinct raw statements a real PG17 serve run sampled is counted under the table it
 * writes (timeline_entries, takes, wanted_links, sources and the side and bookkeeping tables), never under one
 * opaque raw_sql key; each typed member the same run sampled outside the write map is counted under its table or
 * no_row:<member>; every such sample stays capability_missing, so the comparable count cannot move.
 * Regression it catches: a raw or unmapped write that lands on raw_sql or unmapped again (the report then hides
 * which user data went unverified), or a classified write that is sent as anything but capability_missing.
 * Existing coverage: test/engine-swap-cli.test.ts reads the report lines from a hand-made tally; nothing drove the
 * real sampler with the statements a real run sends. No production seam: the test calls the exported sampler.
 * Fixture: test/fixtures/shadow-raw-write-samples.json, the whitespace-squashed SQL of each distinct raw statement
 * from a 2,559-sample PG17 run, with its caller and the table it writes.
 */
import { describe, expect, test } from 'bun:test';
import samples from './fixtures/shadow-raw-write-samples.json';
import { createWriteSampler } from '../src/shadow/write-capture.ts';
import { sqlWrites } from '../src/shadow/sql-writes.ts';
import { memberKind } from '../src/shadow/write-map.ts';
import * as readiness from '../src/core/engine-swap/readiness.ts';

type Line = { t: string; op: string; outcome: string; family: string };

/** Drives one call through the real sampler at rate 1 and returns every line it sent. */
async function sampleOne(name: string, args: unknown[]): Promise<Line[]> {
  const inbox: Line[] = [];
  const sampler = createWriteSampler({ rate: 1, active: () => true, send: (line: string) => { inbox.push(JSON.parse(line)); return true; } });
  const wrapped = sampler.wrap(name, async () => 'done', { engine: {} as never, inTransaction: false, mayWrite: () => true });
  expect(await (wrapped as (...a: unknown[]) => Promise<unknown>)(...args)).toBe('done');
  return inbox;
}

describe('a sampled raw SQL statement is counted under the first table it writes', () => {
  test('the fixture is the full set the run sampled, and each entry parses to its named table', () => {
    expect(samples.length).toBe(34);
    for (const s of samples) expect((sqlWrites(s.sql)[0] as { relation?: string }).relation).toBe(s.family);
  });

  test.each(samples.map((s) => [`${s.family} (${s.caller})`, s] as const))('%s', async (_label, s) => {
    for (const raw of ['executeRaw', 'executeRawDirect']) {
      expect(await sampleOne(raw, [s.sql, []])).toEqual([{ t: 'write', op: raw, outcome: 'capability_missing', family: s.family }]);
    }
  });

  test('the user-data writes the run sampled land on their own type lines, not raw_sql', () => {
    const families = new Set(samples.map((s) => s.family));
    for (const t of ['timeline_entries', 'takes', 'wanted_links', 'sources']) expect(families.has(t)).toBe(true);
    // Read through the namespace so a missing export fails this test alone, not the file.
    const tables = readiness as unknown as { WRITE_SIDE_TABLES?: readonly string[]; WRITE_BOOKKEEPING_TABLES?: readonly string[] };
    const named = new Set(['timeline_entries', 'takes', 'sources', ...(tables.WRITE_SIDE_TABLES ?? []), ...(tables.WRITE_BOOKKEEPING_TABLES ?? [])]);
    expect([...families].filter((f) => !named.has(f))).toEqual([]);
  });

  test('a statement the parser cannot read stays raw_sql', async () => {
    expect(await sampleOne('executeRaw', ['DO $$ BEGIN PERFORM 1; END $$', []])).toEqual([{ t: 'write', op: 'executeRaw', outcome: 'capability_missing', family: 'raw_sql' }]);
    expect(await sampleOne('executeRaw', [{ text: 'not a string' }])).toEqual([{ t: 'write', op: 'executeRaw', outcome: 'capability_missing', family: 'raw_sql' }]);
  });

  // The PG17 run sampled lockTableForAnalyze's lock (src/core/analyze-lock.ts) twice; the write parser reads its
  // SHARE UPDATE EXCLUSIVE as an UPDATE of a table named "exclusive". A lock or a setting writes no row.
  test.each([
    ['LOCK TABLE content_chunks IN SHARE UPDATE EXCLUSIVE MODE NOWAIT'],
    ['LOCK TABLE minion_jobs IN SHARE ROW EXCLUSIVE MODE'],
    ['SET LOCAL statement_timeout = 1000'],
  ])('a raw statement that writes no row is no_row:executeRaw: %s', async (sql) => {
    expect(await sampleOne('executeRaw', [sql, []])).toEqual([{ t: 'write', op: 'executeRaw', outcome: 'capability_missing', family: 'no_row:executeRaw' }]);
  });
});

describe('a sampled typed member outside the write map is counted under the table its statements write', () => {
  // The nine members a real PG17 serve run sampled as unmapped besides onCheckout (it is pinned as sending nothing here and in
  // test/shadow-follow-producer.test.ts). no_row:<member> marks a member whose statements only set transaction
  // settings or take locks.
  const MEMBERS: Array<[string, string]> = [
    ['declarePersistence', 'no_row:declarePersistence'],
    ['lockEffectGuard', 'no_row:lockEffectGuard'],
    ['setEffectTransactionLimits', 'no_row:setEffectTransactionLimits'],
    ['lockEffectClaimRow', 'no_row:lockEffectClaimRow'],
    ['lockPersistenceCounters', 'persistence_counters'],
    ['completeEffectRow', 'persistence_effects'],
    ['insertPublicationEffects', 'persistence_effects'],
    ['completeWriteRow', 'persistence_requests'],
    ['sealImportedPage', 'pages:sealImportedPage'],
  ];

  test.each(MEMBERS)('%s is counted as %s', async (name, family) => {
    expect(memberKind(name)).toBe('unmapped');
    expect(await sampleOne(name, [])).toEqual([{ t: 'write', op: name, outcome: 'capability_missing', family }]);
  });

  test('a typed member with no known statements is counted under unmapped:<member>', async () => {
    expect(memberKind('mysteryMutate')).toBe('unmapped');
    expect(await sampleOne('mysteryMutate', [])).toEqual([{ t: 'write', op: 'mysteryMutate', outcome: 'capability_missing', family: 'unmapped:mysteryMutate' }]);
  });

  test('onCheckout is ignored: the sampler sends nothing for it', async () => {
    expect(memberKind('onCheckout')).toBe('ignored');
    expect(await sampleOne('onCheckout', [() => undefined])).toEqual([]);
  });
});
