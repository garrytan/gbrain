/**
 * #6574: a canonical projection's statement count does not grow with the page.
 *
 * Publication ran one statement per timeline row, fact row and take; behind a
 * transaction-mode pooler with pipelining off, a 7,000-row page paid one round
 * trip each and never finished inside the publication ceiling. These cases
 * project a small and a large page and allow the large one only one more
 * statement per extra 500-row chunk, and check the projected rows are the
 * page's rows, once each.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { prepareCanonicalProjections } from '../src/core/persistence/canonical-projections.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-projection-statements-'));
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({}); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);

afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); if (engine.kind === 'pglite') await engine.disconnect(); }
  await closePostgres?.();
  rmSync(dataDir, { recursive: true, force: true });
});

function pageOf(size: number, prose: string): string {
  const day = (i: number) => new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
  const facts = ['<!--- gbrain:facts:begin -->',
    '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
    '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
    ...Array.from({ length: size }, (_, i) => `| ${i + 1} | Example claim ${i + 1} | fact | 1.0 | world | medium | 2026-01-01 |  | remember |  |`),
    '<!--- gbrain:facts:end -->'].join('\n');
  const takes = ['<!--- gbrain:takes:begin -->', '| # | claim | kind | who | weight | since | source |',
    '|---|-------|------|-----|--------|-------|--------|',
    ...Array.from({ length: 25 }, (_, i) => `| ${i + 1} | Example take ${i + 1} | take | brain | 0.5 | 2026-07 | notes |`),
    '<!--- gbrain:takes:end -->'].join('\n');
  const timeline = Array.from({ length: size }, (_, i) => `- **${day(i)}** | markdown — Example event ${i + 1}`).join('\n');
  return `---\ntype: company\ntitle: Example company\n---\n${prose}\n\n${facts}\n\n${takes}\n\n## Timeline\n\n${timeline}\n`;
}

/** Counts every statement the transaction handle runs: queries, execs, and a nested transaction's savepoint and release. */
function countingEngine(tx: BrainEngine): { engine: BrainEngine; count: () => number } {
  let statements = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrap = (handle: any): any => new Proxy(handle, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === 'query' || key === 'exec') return (...args: unknown[]) => { statements++; return value.apply(target, args); };
      if (key === 'transaction') return (fn: (inner: unknown) => unknown) => { statements += 2; return value.call(target, (inner: unknown) => fn(wrap(inner))); };
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = wrap((tx as any).db);
  return { engine: Object.create(tx, { db: { get: () => db } }) as BrainEngine, count: () => statements };
}

async function withSource(engine: BrainEngine, run: (sourceId: string, put: (slug: string, content: string) => Promise<unknown>) => Promise<void>) {
  const dir = mkdtempSync(join(dataDir, 'case-'));
  const root = join(dir, 'brain'); mkdirSync(root);
  const sourceId = `stmts-${randomUUID().slice(0, 8)}`;
  const ctx = { engine, sourceId, remote: false as const, config: { engine: engine.kind, embedding_disabled: true },
    dryRun: false, logger: { info() {}, warn() {}, error() {} } };
  try {
    await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      await claimWorktree(engine, sourceId, root);
      await run(sourceId, (slug, content) => submitPageMutation(ctx, { operation: 'put_page', params: { slug, content, request_id: randomUUID() } }));
    });
  } finally {
    await disposePersistenceConsumer(engine);
  }
}

async function projectEdit(engine: BrainEngine, sourceId: string, slug: string, content: string): Promise<number> {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
  const project = await prepareCanonicalProjections(engine, parseMarkdown(content, slug), slug, sourceId, snapshot, 'editing');
  let statements = -1;
  await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
    // The statement count reads PGLite's transaction handle; on Postgres the projection runs uncounted and only its rows are checked.
    if (tx.kind !== 'pglite') { await project(tx); return; }
    const counted = countingEngine(tx);
    await project(counted.engine);
    statements = counted.count();
  }, TEST_WRITE_ATTRIBUTION));
  return statements;
}

async function projectedRows(engine: BrainEngine, sourceId: string, slug: string) {
  const [row] = await engine.executeRaw<{ timeline: number; distinct_timeline: number; facts: number; takes: number }>(`SELECT
    (SELECT count(*)::int FROM timeline_entries t WHERE t.page_id=p.id) AS timeline,
    (SELECT count(DISTINCT (t.date, t.summary))::int FROM timeline_entries t WHERE t.page_id=p.id) AS distinct_timeline,
    (SELECT count(*)::int FROM facts f WHERE f.source_id=p.source_id AND f.source_markdown_slug=p.slug AND f.expired_at IS NULL) AS facts,
    (SELECT count(*)::int FROM takes k WHERE k.page_id=p.id) AS takes
    FROM pages p WHERE p.source_id=$1 AND p.slug=$2`, [sourceId, slug]);
  return row;
}

describe('#6574 canonical projection statements', () => {
  test('a large page projects with a statement count that grows only by chunk, and its rows land once each', async () => {
    for (const engine of engines) {
      await withSource(engine, async (sourceId, put) => {
        const counts: number[] = [];
        for (const size of [100, 2_000]) {
          const slug = `companies/example-${size}`;
          await put(slug, pageOf(size, 'First draft.'));
          expect(await projectedRows(engine, sourceId, slug)).toEqual({ timeline: size, distinct_timeline: size, facts: size, takes: 25 });
          const statements = await projectEdit(engine, sourceId, slug, pageOf(size, 'Second draft with one more sentence.'));
          expect(await projectedRows(engine, sourceId, slug)).toEqual({ timeline: size, distinct_timeline: size, facts: size, takes: 25 });
          counts.push(statements);
        }
        if (engine.kind !== 'pglite') return;
        // The only growth is one statement per extra 500-row chunk of timeline rows and of fact rows.
        expect(counts[0]).toBeGreaterThan(0);
        expect(counts[0]).toBeLessThan(40);
        expect(counts[1] - counts[0]).toBeLessThanOrEqual(2 * (Math.ceil(2_000 / 500) - 1));
      });
    }
  }, 300_000);
});
