/**
 * #6898 follow-ups (wave 19 L3, item 4): fact publication on a large entity page.
 *
 * Protects:
 * 1. Preparation renders the entity's `## Facts` fence once per request: a
 *    50-fact publication on a 6,000-row fence costs about what a 1-fact one
 *    does. Regression: one parse and one render of the whole fence per fact,
 *    O(facts x fence rows) (a 200-fact batch on an 8,000-row page spent 14.6 s
 *    there; 1,000 facts ran for minutes and the source's queue waited behind it).
 * 2. A group of more than MANAGED_FACTS_PUBLICATION_MAX facts for one entity is
 *    admitted as parts in the same batch and published one after another. Each
 *    part's receipt says it is a part (`publication`, `part.index/of`,
 *    `part.deferred_facts`, `part.follow_up`), so a partial publication never
 *    reads as the whole group; the batch completion counts every fact once.
 * 3. The brain-wide persistence_counters row, which a publication holds from
 *    its admission check to its commit, is held for one part, not for the whole
 *    group (window recorded from the coordinator's counter lock to its receipt
 *    write), and a put_page on another source admitted mid-group commits while
 *    later parts are still queued. Regression: one publication held the row for
 *    every fact's dedup check and insert, and every other admission waited on
 *    it (lock_timeout 1 s -> database_contention).
 * Runs on PGLite, and on Postgres when DATABASE_URL is set
 * (test/postgres-unit-arms.txt).
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { writeFactsToFence } from '../src/core/facts/fence-write.ts';
import * as journal from '../src/core/persistence/journal.ts';
import * as factsFence from '../src/core/facts-fence.ts';
import { MANAGED_FACTS_PUBLICATION_MAX } from '../src/core/persistence/facts-maintenance.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { checkPersistenceCounterDrift } from '../src/commands/doctor/checks/persistence-compaction.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const SLUG = 'people/alice-example';
const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-facts-large-fence-db-'));
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const backends = testBackends();
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir }); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); rmSync(dataDir, { recursive: true, force: true });
});

const claim = (tag: string, i: number) => `Claim ${tag}-${i} about the widget-co supply chain and its quarterly planning cadence, long enough to look real`;
const fence = (rows: number) => `## Facts\n\n<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${Array.from({ length: rows }, (_, i) => `| ${i + 1} | ${claim('seed', i)} | fact | 1.0 | private | medium | 2020-01-01 |  | chat |  |`).join('\n')}
<!--- gbrain:facts:end -->
`;
const person = (title: string, body = '') => `---\ntitle: ${title}\ntype: person\n---\n# ${title}\n\n${body}`;

interface Fixture { engine: BrainEngine; sourceId: string; root: string; otherSource: string;
  write(tag: string, n: number): Promise<{ inserted: number; ms: number }>;
  putOther(slug: string): Promise<void>; }

/** A managed brain whose entity page carries a `rows`-row fence (seeded unmanaged), plus a second claimed source. */
async function largeEntity(rows: number, run: (f: Fixture) => Promise<void>): Promise<void> {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-facts-large-fence-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    const otherRoot = join(dir, 'other'); mkdirSync(otherRoot);
    const sourceId = `large-${randomUUID().slice(0, 8)}`, otherSource = `other-${randomUUID().slice(0, 8)}`;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_AUDIT_DIR: join(dir, 'audit') }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        for (const [id, path] of [[sourceId, root], [otherSource, otherRoot]]) {
          await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [id, path]);
          await claimWorktree(engine, id, path);
        }
        await engine.setConfig('sync.write_through', 'true');
        const ctx = (source: string) => ({ engine, sourceId: source, remote: false as const, config: { engine: engine.kind, embedding_disabled: true },
          dryRun: false, logger: { info() {}, warn() {}, error() {} } });
        await submitPageMutation(ctx(sourceId), { operation: 'put_page', params: { slug: SLUG, content: person('Alice Example', fence(rows)), request_id: randomUUID() } });
        await disposePersistenceConsumer(engine);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        await run({ engine, sourceId, root, otherSource,
          write: async (tag, n) => {
            const started = performance.now();
            const result = await writeFactsToFence(engine, { sourceId, localPath: root, slug: SLUG, resolutionSource: 'exact_page' },
              Array.from({ length: n }, (_, i) => ({ fact: claim(tag, i), kind: 'fact' as const, source: 'fixture', visibility: 'private' as const,
                notability: 'medium' as const, embedding: null, sessionId: null })));
            return { inserted: result.inserted, ms: performance.now() - started };
          },
          putOther: async slug => { await submitPageMutation(ctx(otherSource), { operation: 'put_page',
            params: { slug, content: person('Beta Example'), request_id: randomUUID() } }); } });
      });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

async function entityRequests(engine: BrainEngine, sourceId: string) {
  return engine.executeRaw<{ request_id: string; state: string; outcome: Record<string, any> }>(
    `SELECT request_id::text, state, outcome FROM persistence_requests WHERE source_id=$1 AND slug=$2 AND operation='extract_facts' ORDER BY sequence`,
    [sourceId, SLUG]);
}

/** Records, per committed fact publication on SLUG, the time from the coordinator's counter lock to its receipt write. */
function recordCounterHolds(): { holds: number[]; restore(): void } {
  const holds: number[] = [];
  let locked = 0;
  const lockCounters = journal.lockCounters, completeWrite = journal.completeWrite;
  const lock = spyOn(journal, 'lockCounters').mockImplementation(async (tx, keys) => {
    if (keys.includes('brain')) locked = performance.now();
    return lockCounters(tx, keys);
  });
  const complete = spyOn(journal, 'completeWrite').mockImplementation(async (...args: Parameters<typeof completeWrite>) => {
    const done = await completeWrite(...args);
    if (args[2] === 'committed' && args[1].operation === 'extract_facts' && args[1].slug === SLUG) holds.push(performance.now() - locked);
    return done;
  });
  return { holds, restore: () => { lock.mockRestore(); complete.mockRestore(); } };
}

test('a cap-sized publication on a 6,000-row fence edits the fence once, never once per fact', async () => {
  await largeEntity(6000, async ({ write }) => {
    await write('warm', 1);
    const editor = spyOn(factsFence, 'factsFenceEditor');
    const perFact = [spyOn(factsFence, 'upsertFactRow'), spyOn(factsFence, 'strikeFactRowInPage')];
    try {
      const capped = await write('cap', MANAGED_FACTS_PUBLICATION_MAX);
      expect(capped.inserted).toBe(MANAGED_FACTS_PUBLICATION_MAX);
      expect(editor).toHaveBeenCalledTimes(1);
      expect(perFact.map(spy => spy.mock.calls.length)).toEqual([0, 0]);
    } finally { editor.mockRestore(); for (const spy of perFact) spy.mockRestore(); }
  });
}, 300_000);

test('a group over the cap publishes as parts whose receipts say they are parts', async () => {
  await largeEntity(20, async ({ engine, sourceId, write }) => {
    const total = 2 * MANAGED_FACTS_PUBLICATION_MAX + 20;
    expect((await write('parts', total)).inserted).toBe(total);
    const rows = await entityRequests(engine, sourceId);
    expect(rows.map(r => r.state)).toEqual(['committed', 'committed', 'committed']);
    const ids = rows.map(r => r.request_id);
    expect(rows.map(r => [r.outcome.publication, r.outcome.part, r.outcome.inserted])).toEqual([
      ['partial', { index: 1, of: 3, deferred_facts: MANAGED_FACTS_PUBLICATION_MAX + 20, follow_up: ids.slice(1) }, MANAGED_FACTS_PUBLICATION_MAX],
      ['partial', { index: 2, of: 3, deferred_facts: 20, follow_up: ids.slice(2) }, MANAGED_FACTS_PUBLICATION_MAX],
      ['final_part', { index: 3, of: 3, deferred_facts: 0, follow_up: [] }, 20]]);
    const [completion] = await engine.executeRaw<{ outcome: Record<string, any> }>(
      `SELECT outcome FROM persistence_requests WHERE source_id=$1 AND slug='__managed_facts_complete__' AND state='committed'`, [sourceId]);
    expect(completion.outcome).toMatchObject({ status: 'completed', entity_requests: 3, inserted: total });
    const facts = await engine.executeRaw<{ row_num: number }>(
      `SELECT row_num FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND fact LIKE 'Claim parts-%' ORDER BY row_num`, [sourceId, SLUG]);
    expect(facts.map(f => Number(f.row_num))).toEqual(Array.from({ length: total }, (_, i) => 21 + i));
    // Counter totals stay exact across the parts: receipt bytes (doctor) and, read directly, outstanding requests,
    // their intent bytes and the permanent request ids each brain and principal row has issued.
    expect((await checkPersistenceCounterDrift(engine)).status).toBe('ok');
    const counters = await engine.executeRaw<{ key: string; outstanding: string; intent: string; ids: string; want_outstanding: string; want_intent: string; want_ids: string }>(`
      WITH r AS (SELECT 'principal:'||principal_kind||':'||principal_id AS key,state,intent_bytes FROM persistence_requests
          UNION ALL SELECT 'brain',state,intent_bytes FROM persistence_requests),
        t AS (SELECT 'principal:local_cli:'||principal_id::text AS key FROM persistence_topology_changes UNION ALL SELECT 'brain' FROM persistence_topology_changes),
        want AS (SELECT key,count(*) FILTER (WHERE state NOT IN ('committed','conflict','failed','cancelled')) AS outstanding,
            COALESCE(SUM(intent_bytes) FILTER (WHERE state NOT IN ('committed','conflict','failed','cancelled')),0) AS intent,count(*) AS ids FROM r GROUP BY key)
      SELECT c.key,c.outstanding_count::text AS outstanding,c.intent_bytes::text AS intent,c.lifetime_ids::text AS ids,
        COALESCE(w.outstanding,0)::text AS want_outstanding,COALESCE(w.intent,0)::text AS want_intent,
        (COALESCE(w.ids,0)+(SELECT count(*) FROM t WHERE t.key=c.key))::text AS want_ids
      FROM persistence_counters c LEFT JOIN want w ON w.key=c.key WHERE c.key='brain' OR c.key LIKE 'principal:%' ORDER BY c.key`);
    expect(counters.length).toBeGreaterThan(1);
    for (const c of counters) expect([c.key, c.outstanding, c.intent, c.ids]).toEqual([c.key, c.want_outstanding, c.want_intent, c.want_ids]);
  });
}, 300_000);

test('the counter row is held for one part, and a put_page on another source commits mid-group', async () => {
  await largeEntity(2000, async ({ engine, sourceId, write, putOther }) => {
    await write('warm', 1);
    const probe = recordCounterHolds();
    try {
      await write('one-part', MANAGED_FACTS_PUBLICATION_MAX);
      const [onePart] = probe.holds.splice(0);
      const group = write('group', 16 * MANAGED_FACTS_PUBLICATION_MAX);
      let committed: Array<{ state: string }> = [];
      while (!committed.some(r => r.state === 'committed')) {
        await Bun.sleep(20);
        committed = (await entityRequests(engine, sourceId)).slice(2);
      }
      await putOther('people/beta-example');
      const atPut = (await entityRequests(engine, sourceId)).slice(2);
      expect((await group).inserted).toBe(16 * MANAGED_FACTS_PUBLICATION_MAX);
      expect(atPut.filter(r => r.state !== 'committed').length).toBeGreaterThan(0);
      expect(onePart).toBeGreaterThan(0);
      expect(probe.holds).toHaveLength(16);
      const parts = (await entityRequests(engine, sourceId)).slice(2);
      expect(parts.map(r => r.outcome.inserted)).toEqual(Array(16).fill(MANAGED_FACTS_PUBLICATION_MAX));
    } finally { probe.restore(); }
  });
}, 600_000);
