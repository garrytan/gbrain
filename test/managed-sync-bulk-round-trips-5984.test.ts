/**
 * #5984 (v0.60.58.0): the database statements a draining managed sync spends per page in a bulk group, on Postgres.
 *
 * Far from its database, a managed sync's speed is its round trips per page. v0.60.58.0 cut a page's publication inside
 * a bulk group from about 48 round trips to about 17, and a distant backlog drained about 2.7 times faster. Only the
 * opt-in bench (scripts/bench/managed-sync-catchup.ts) measured it, so a per-page statement that slipped back in would
 * show only as a slower catch-up on a distant brain.
 *
 * Protects: two numbers, both statement counts on the wire (deterministic on a local database, unlike round trips,
 * which also depend on timing):
 * - a page's share of its group's publication transaction, from the bench's own analysis of the trace
 *   (publicationBreakdown): measured 24.2 statements (14.3 round trips);
 * - everything else a page costs the run (freeze, admission, claims, preparation, queued effects): two drains of the
 *   same shape, the statements the extra pages add divided by their count, so fixed costs cancel; measured 67.1 to 67.4.
 * Each budget is about 10% over its measurement.
 * Fails when: a statement starts running once per page or per link inside a bulk group, the group stops publishing its
 * pages in one transaction, or the bench's trace classification stops recognising a group publication.
 * Seams: the wire trace (GBRAIN_SQL_TRACE, src/core/sql-trace.ts) and the bench analyzer
 * (scripts/bench/managed-sync-catchup-phases.ts). Postgres only: bulk groups publish on Postgres.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performSync } from '../src/commands/sync/perform.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { readTrace, type TraceRecord } from '../scripts/bench/managed-sync-catchup-lib.ts';
import { publicationBreakdown } from '../scripts/bench/managed-sync-catchup-phases.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const PUBLICATION_PER_PAGE_BUDGET = 27;
const RUN_PER_PAGE_BUDGET = 74;
const BULK_SIZE = 8;
const SMALL = 16;
const LARGE = 48;

const home = mkdtempSync(join(tmpdir(), 'gbrain-bulk-round-trips-'));
let databaseUrl: string | undefined;
let setup: PostgresEngine | undefined;
let closePostgres: (() => Promise<void>) | undefined;

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const pad = (i: number) => String(i).padStart(3, '0');
const isStatement = (r: TraceRecord) => r.kind === 'execute' || r.kind === 'simple';

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL, 'instance', 12);
  databaseUrl = pg.databaseUrl; setup = pg.engine; closePostgres = pg.close;
}, 120_000);
afterAll(async () => {
  if (setup) await withEnv({ GBRAIN_HOME: home }, () => disposePersistenceConsumer(setup!));
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

/** Drains a fresh managed source of `count` cross-linked notes through its own traced pool; returns the run's trace. */
async function tracedDrain(id: string, count: number): Promise<TraceRecord[]> {
  const root = join(home, id);
  mkdirSync(join(root, 'notes'), { recursive: true });
  git(root, 'init', '-q');
  for (let i = 0; i < count; i++) {
    writeFileSync(join(root, 'notes', `n${pad(i)}.md`), `---\ntitle: Note ${i}\n---\nA durable observation number ${i}, see [[notes/n${pad((i + 7) % count)}]].\n`);
  }
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
  await withEnv({ GBRAIN_HOME: home }, async () => {
    await setup!.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await setup!.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
    await claimWorktree(setup!, id, root);
    await setup!.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  });
  const trace = join(home, `${id}.jsonl`);
  const engine = new PostgresEngine();
  await withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_BULK_SIZE: String(BULK_SIZE), GBRAIN_SQL_TRACE: trace, GBRAIN_SQL_TRACE_LABEL: id }, async () => {
    await engine.connect({ database_url: databaseUrl!, poolSize: 12 });
    try {
      const result = await performSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true, drain: true, lanes: 1 });
      expect(result.drain).toMatchObject({ outcome: 'synced', bulk: { enabled: true } });
      await disposePersistenceConsumer(engine);
    } finally { await engine.disconnect(); }
  });
  // The trace buffers its records and flushes them once a second.
  await Bun.sleep(1500);
  const [pages] = await setup!.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND deleted_at IS NULL', [id]);
  expect(pages!.n).toBe(count);
  return readTrace(trace);
}

test('a bulk group page costs a bounded number of statements to publish and to bring there, at any backlog size', async () => {
  if (!databaseUrl) return;
  const small = await tracedDrain('bulk-rt-small', SMALL);
  const large = await tracedDrain('bulk-rt-large', LARGE);

  const publication = publicationBreakdown(large) as { committed: number; rolled_back: number; members_total: number; per_page_publication_statements: number | null };
  expect(publication.rolled_back).toBe(0);
  expect(publication.committed).toBeGreaterThanOrEqual(LARGE / BULK_SIZE);
  expect(publication.members_total).toBeGreaterThanOrEqual(LARGE - BULK_SIZE);
  expect(publication.per_page_publication_statements ?? Infinity).toBeLessThanOrEqual(PUBLICATION_PER_PAGE_BUDGET);

  const runPerPage = (large.filter(isStatement).length - small.filter(isStatement).length) / (LARGE - SMALL);
  expect(runPerPage).toBeLessThanOrEqual(RUN_PER_PAGE_BUDGET);
}, 300_000);
