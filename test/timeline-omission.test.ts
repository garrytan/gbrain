/**
 * #5969 (D3): a put_page / put_pages body that leaves out the Timeline section.
 * Remote callers are refused unless they pass drop_timeline; a local writer
 * without a revision keeps the rows; an explicitly empty section and a partial
 * edit are ordinary deletes; every write that deletes rows reports
 * `timeline_rows_removed` (dates only). Runs on PGLite and, through test/e2e,
 * Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { operationsByName } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { MANAGED_WRITER_GUARD_FUNCTION_SQL } from '../src/core/persistence/writer-guard-schema.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { installPre5983Guard } from './helpers/pre-5983-guard.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-timeline-omission-'));
let closePostgres: (() => Promise<void>) | undefined;
const logger = { info() {}, warn() {}, error() {} };

beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
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
  await closePostgres?.(); resetGateway(); rmSync(dataDir, { recursive: true, force: true });
});

const slug = 'projects/example';
const head = '---\ntype: note\ntitle: Example project\n---\n';
const authored = '- **2026-08-01** | markdown — Launch review\n- **2026-08-03** | markdown — Pilot signed';
const withTimeline = (body: string, timeline = authored) => `${head}${body}\n\n## Timeline\n\n${timeline}\n`;
const withoutTimeline = (body: string) => `${head}${body}\n`;

interface Fixture {
  engine: BrainEngine; sourceId: string; local: OperationContext; remote: OperationContext;
  revision(): Promise<string>; rows(): Promise<string[]>; body(): Promise<string>;
  put(ctx: OperationContext, content: string, extra?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** A page with two authored bullets plus one add_timeline_entry row: three stored rows, all with bullets in the body. */
async function fixture(run: (f: Fixture) => Promise<void>, opts: { managed?: boolean } = {}) {
  for (const engine of engines) {
    const dir = mkdtempSync(join(dataDir, 'case-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    const sourceId = `omission-${randomUUID().slice(0, 8)}`;
    const local = { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true }, dryRun: false, logger } as unknown as OperationContext;
    const remote = { ...local, remote: true } as OperationContext;
    const f: Fixture = {
      engine, sourceId, local, remote,
      revision: async () => (await engine.readPageSnapshot(slug, { sourceId }))!.revision,
      rows: async () => (await engine.executeRaw<{ d: string }>(`SELECT t.date::text || ' ' || t.summary AS d FROM timeline_entries t JOIN pages p ON p.id=t.page_id
        WHERE p.source_id=$1 AND p.slug=$2 AND t.event_page_id IS NULL ORDER BY t.date, t.summary`, [sourceId, slug])).map(r => r.d),
      body: async () => { const s = (await engine.readPageSnapshot(slug, { sourceId }))!; return `${s.page.compiled_truth}\n${s.page.timeline ?? ''}`; },
      put: (ctx, content, extra = {}) => submitPageMutation(ctx, { operation: 'put_page', params: { slug, content, request_id: randomUUID(), ...extra } }),
    };
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await claimWorktree(engine, sourceId, root);
        if (opts.managed) {
          await engine.setConfig('sync.write_through', 'true');
          await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        }
        await f.put(local, withTimeline('First draft.'));
        await submitPageMutation(local, { operation: 'add_timeline_entry', params: { slug, date: '2026-08-05', summary: 'Customer call', source: 'operator', request_id: randomUUID() } });
        expect(await f.rows()).toEqual(['2026-08-01 Launch review', '2026-08-03 Pilot signed', '2026-08-05 Customer call']);
        await run(f);
      });
    } finally {
      installFaultHook(undefined);
      if (opts.managed) await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await disposePersistenceConsumer(engine);
    }
  }
}

const ALL = ['2026-08-01 Launch review', '2026-08-03 Pilot signed', '2026-08-05 Customer call'];
async function refusal(run: () => Promise<unknown>): Promise<OperationError> {
  try { await run(); } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a refusal');
}

describe('#5969 (D3) remote put_page that omits the Timeline section', () => {
  for (const [label, extra] of [['with expected_revision', 'revision'], ['with force', 'force']] as const) {
    test(`is refused ${label} and deletes nothing; the fix re-reads the page, then names drop_timeline`, async () => {
      await fixture(async f => {
        const params = extra === 'revision' ? { expected_revision: await f.revision() } : { force: true };
        const error = await refusal(() => f.put(f.remote, withoutTimeline('Remote rewrite.'), params));
        expect(error.code).toBe('timeline_rows_would_be_removed');
        expect(error.message).toContain('3 timeline row(s) dated 2026-08-01 to 2026-08-05');
        expect(error.message).not.toContain('Launch review');
        const json = error.toJSON() as { fix?: { mcp?: unknown; then?: { mcp?: unknown } } };
        expect(json.fix?.mcp).toEqual({ tool: 'get_page', arguments: { slug, source_id: f.sourceId, include_content: true } });
        expect(json.fix?.then?.mcp).toEqual({ tool: 'put_page', arguments: { slug, source_id: f.sourceId, drop_timeline: true } });
        expect(await f.rows()).toEqual(ALL);
        expect(await f.body()).toContain('First draft.');
        // A caller cannot declare its own section.
        expect((await refusal(() => f.put(f.remote, withoutTimeline('Remote rewrite.'), { ...params, timeline_section: 'present' }))).code)
          .toBe('timeline_rows_would_be_removed');
      });
    }, 120_000);
  }

  test('drop_timeline: true deletes and reports them (dates only); revert_version restores them', async () => {
    await fixture(async f => {
      const before = await f.revision();
      const receipt = await f.put(f.remote, withoutTimeline('Remote rewrite.'), { expected_revision: before, drop_timeline: true });
      expect(receipt.timeline_rows_removed).toMatchObject({ count: 3, earliest: '2026-08-01', latest: '2026-08-05',
        fix: { mcp: { tool: 'get_versions', arguments: { slug, limit: 5, include_body: false } } } });
      expect(JSON.stringify(receipt.timeline_rows_removed)).not.toContain('Launch review');
      expect(await f.rows()).toEqual([]);
      const versions = await operationsByName.get_versions.handler(f.local, { slug, include_body: false }) as Array<{ id: number }>;
      const prior = versions[0]!;
      await operationsByName.revert_version.handler(f.local, { slug, version_id: prior.id, expected_revision: await f.revision(), request_id: randomUUID() });
      expect(await f.rows()).toEqual(ALL);
    });
  }, 120_000);

  test('an explicitly empty section is a deliberate delete: not refused, reported', async () => {
    await fixture(async f => {
      const receipt = await f.put(f.remote, `${head}Remote rewrite.\n\n## Timeline\n`, { force: true });
      expect(receipt.timeline_rows_removed).toMatchObject({ count: 3, earliest: '2026-08-01', latest: '2026-08-05' });
      expect(await f.rows()).toEqual([]);
    });
  }, 120_000);

  test('a partially edited section is a normal diff, reported; an unchanged section reports nothing', async () => {
    await fixture(async f => {
      const current = (await operationsByName.get_page.handler(f.remote, { slug, include_content: true })) as { content: string };
      const kept = await f.put(f.remote, current.content.replace('First draft.', 'Second draft.'), { expected_revision: await f.revision() });
      expect(kept.timeline_rows_removed).toBeUndefined();
      expect(await f.rows()).toEqual(ALL);
      const partial = await f.put(f.remote, current.content.replace('First draft.', 'Third draft.').replace(/^- \*\*2026-08-03\*\*.*\n/m, ''),
        { expected_revision: await f.revision() });
      expect(partial.timeline_rows_removed).toMatchObject({ count: 1, earliest: '2026-08-03', latest: '2026-08-03' });
      expect(await f.rows()).toEqual(['2026-08-01 Launch review', '2026-08-05 Customer call']);
    });
  }, 120_000);
});

describe('#5969 (D3) local writers', () => {
  test('a local put without a revision (the preserving writer) keeps the rows and renders them back', async () => {
    await fixture(async f => {
      const receipt = await f.put(f.local, withoutTimeline('Local rewrite.'), { force: true });
      expect(receipt.timeline_rows_removed).toBeUndefined();
      expect(await f.rows()).toEqual(ALL);
      const body = await f.body();
      expect(body).toContain('Local rewrite.');
      for (const summary of ['Launch review', 'Pilot signed', 'Customer call']) expect(body).toContain(summary);
    });
  }, 120_000);

  test('a local revision-bound put that omits the section deletes the rows and reports them', async () => {
    await fixture(async f => {
      const receipt = await f.put(f.local, withoutTimeline('Local rewrite.'), { expected_revision: await f.revision() });
      expect(receipt.timeline_rows_removed).toMatchObject({ count: 3, earliest: '2026-08-01', latest: '2026-08-05' });
      expect(await f.rows()).toEqual([]);
    });
  }, 120_000);

  test('a local preserving put with an explicitly empty section deletes the rows', async () => {
    await fixture(async f => {
      const receipt = await f.put(f.local, `${head}Local rewrite.\n\n<!-- timeline -->\n`, { force: true });
      expect(receipt.timeline_rows_removed).toMatchObject({ count: 3 });
      expect(await f.rows()).toEqual([]);
    });
  }, 120_000);
});

describe('#5969 (D3) put_pages entries', () => {
  test('an entry that omits the section is refused on its own; with drop_timeline it commits and reports', async () => {
    await fixture(async f => {
      const putPages = operationsByName.put_pages;
      const refused = await putPages.handler(f.remote, { request_id: randomUUID(), source_id: f.sourceId,
        pages: [{ slug, content: withoutTimeline('Batch rewrite.'), expected_revision: await f.revision() }, { slug: 'notes/other', content: withoutTimeline('Other page.') }] }) as any;
      expect(refused.pages[0]).toMatchObject({ state: 'refused', error: { error: 'timeline_rows_would_be_removed' } });
      expect(refused.pages[1]).toMatchObject({ state: 'committed' });
      expect(await f.rows()).toEqual(ALL);
      const dropped = await putPages.handler(f.remote, { request_id: randomUUID(), source_id: f.sourceId,
        pages: [{ slug, content: withoutTimeline('Batch rewrite.'), expected_revision: await f.revision(), drop_timeline: true }] }) as any;
      expect(dropped.pages[0]).toMatchObject({ state: 'committed', timeline_rows_removed: { count: 3, earliest: '2026-08-01', latest: '2026-08-05' } });
      expect(await f.rows()).toEqual([]);
    });
  }, 120_000);
});

describe('#5969 (D3) concurrency and replay', () => {
  test('a row added between preparation and publication is neither deleted nor counted', async () => {
    await fixture(async f => {
      installFaultHook(async (point, detail) => {
        if (point !== 'consumer:prepared' || detail.operation !== 'put_page') return;
        installFaultHook(undefined);
        await f.engine.transaction(tx => withCoordinatedWrite(tx, [f.sourceId], () => tx.executeRaw(
          `INSERT INTO timeline_entries(page_id,date,source,summary,detail) SELECT id,'2026-08-09','operator','Late addition','' FROM pages WHERE source_id=$1 AND slug=$2`,
          [f.sourceId, slug]), TEST_WRITE_ATTRIBUTION));
      });
      const receipt = await f.put(f.remote, withoutTimeline('Remote rewrite.'), { force: true, drop_timeline: true });
      expect(receipt.timeline_rows_removed).toMatchObject({ count: 3, latest: '2026-08-05' });
      expect(await f.rows()).toEqual(['2026-08-09 Late addition']);
    });
  }, 120_000);

  test('failed-writes replay keeps drop_timeline and the section the first admission read', async () => {
    await fixture(async f => {
      for (const table of ['tags', 'timeline_entries', 'takes']) await f.engine.executeRaw(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS source_id TEXT`);
      await installPre5983Guard(f.engine);
      // A new tag makes the pre-#5983 guard refuse the publication, leaving a failed receipt to replay.
      const tagged = `---\ntype: note\ntitle: Example project\ntags: [launched]\n---\nRemote rewrite.\n`;
      await f.put(f.remote, tagged, { force: true, drop_timeline: true }).catch(() => undefined);
      const [failed] = await f.engine.executeRaw<{ intent: Record<string, unknown> }>(
        `SELECT intent FROM persistence_requests WHERE source_id=$1 AND slug=$2 AND state='failed' AND operation='put_page'`, [f.sourceId, slug]);
      expect(failed.intent).toMatchObject({ timeline_section: 'omitted', drop_timeline: true });
      await f.engine.executeRaw(MANAGED_WRITER_GUARD_FUNCTION_SQL);
      const scope = await resolveRepairScope(f.engine, f.sourceId);
      const preview = await (await repairRunner(f.engine, { apply: false, logger })).run('failed-writes', scope, { explicit: true, sourceFlag: f.sourceId });
      const applied = await (await repairRunner(f.engine, { apply: true, logger })).run('failed-writes', scope,
        { explicit: true, sourceFlag: f.sourceId, expect: preview.apply_command.split('--expect ')[1] });
      expect(applied.outcomes).toEqual({ replayed: 1 });
      expect(await f.rows()).toEqual([]);
      expect(await f.engine.getTags(slug, { sourceId: f.sourceId })).toEqual(['launched']);
    }, { managed: true });
  }, 120_000);
});
