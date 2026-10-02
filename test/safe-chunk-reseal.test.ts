/**
 * #5050 + #5247: pages chunked before the safe-chunk fence (chunker v4) are
 * withheld from every remote read. Re-importing their unchanged content
 * re-seals them projection-only (no page write, no journal admission, no
 * lifetime ID); doctor and the `safe_index_pending` hint count code pages as
 * well as markdown and fire on partial results; `gbrain repair safe-chunks`
 * drains the rest on a managed brain with zero admissions.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SearchResult } from '../src/core/types.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importCodeFile, importFromContent } from '../src/core/import-file.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { rebuildPendingPageProjections } from '../src/core/page-state/projections.ts';
import { SAFE_FENCE_CHUNKER_VERSION } from '../src/core/search/safe-chunks.ts';
import { checkContextualRetrievalCoverage } from '../src/commands/doctor/checks/calibration.ts';
import { runImport } from '../src/commands/import.ts';
import { contentHashLegacy } from '../src/core/utils.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { resolveRepairScope, runRepair } from '../src/core/repair/core.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const home = mkdtempSync(join(tmpdir(), 'gbrain-safe-chunks-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const md = (body: string) => `---\ntitle: Synthetic note\ntype: note\nvisibility: world\n---\n\n${body}\n`;
const code = `export function verifyTurnstile(token: string) {\n  const secret = process.env.TURNSTILE_SECRET_KEY;\n  return secret + token;\n}\n`;

async function openPostgres(): Promise<{ engine: BrainEngine; close: () => Promise<void> }> {
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
  return { engine: pg.engine, close: pg.close };
}

const pageState = async (engine: BrainEngine, sourceId: string, slug: string) => (await engine.executeRaw<{ chunker_version: number; revision: string; sealed: boolean; versions: number }>(
  `SELECT p.chunker_version, p.knowledge_revision::text AS revision, (p.text_projection_revision = p.knowledge_revision) AS sealed,
     (SELECT COUNT(*)::int FROM page_versions v WHERE v.page_id = p.id) AS versions
   FROM pages p WHERE p.source_id=$1 AND p.slug=$2`, [sourceId, slug]))[0];
const journal = async (engine: BrainEngine) => (await engine.executeRaw<{ requests: number; ids: string }>(
  `SELECT (SELECT COUNT(*)::int FROM persistence_requests) AS requests,
     COALESCE((SELECT lifetime_ids::text FROM persistence_counters WHERE key='brain'), '0') AS ids`))[0];

for (const kind of backends) {
  describe(`#5050/#5247 safe-chunk re-seal ${kind}`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const sourceId = 'reseal-src';
    let meta: Record<string, unknown> = {};
    const ctx = (remote: boolean): OperationContext => ({ engine, config: { engine: engine.kind }, dryRun: false, remote, sourceId,
      logger: { info() {}, warn() {}, error() {} }, emitResponseMeta: (key: string, value: unknown) => { meta[key] = value; } }) as OperationContext;
    const degraded = () => ((meta.retrieval as { degraded?: Array<{ stage: string }> } | undefined)?.degraded ?? []).map(d => d.stage);
    const remoteSearch = async (query: string) => {
      meta = {};
      __resetPrivateVisibilityCacheForTests();
      return (await operationsByName.search.handler(ctx(true), { query, limit: 10 }) as SearchResult[]).map(r => r.slug);
    };

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await openPostgres());
      else {
        const pglite = new PGLiteEngine();
        await pglite.connect({}); await pglite.initSchema();
        engine = pglite; close = () => pglite.disconnect();
      }
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [sourceId]);
      await engine.setConfig('search.mcp_keyword_only', 'true');
      await engine.setConfig('search.crag_escalation', 'false');
    }, 120_000);
    afterAll(async () => { await close(); });

    test('re-importing unchanged markdown below the fence re-seals it without a page write', async () => {
      const slug = 'people/zebra-keeper';
      const content = md('The keeper likes zebras and pottery.');
      expect((await importFromContent(engine, slug, content, { sourceId, noEmbed: true })).status).toBe('imported');
      await engine.executeRaw('UPDATE pages SET chunker_version=3 WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
      expect(await remoteSearch('zebras')).toEqual([]);
      const before = await pageState(engine, sourceId, slug);
      expect((await importFromContent(engine, slug, content, { sourceId, noEmbed: true })).status).toBe('skipped');
      const after = await pageState(engine, sourceId, slug);
      expect(after.chunker_version).toBeGreaterThanOrEqual(SAFE_FENCE_CHUNKER_VERSION);
      expect(after.sealed).toBe(true);
      expect([after.revision, after.versions]).toEqual([before.revision, before.versions]);
      expect(await remoteSearch('zebras')).toEqual([slug]);
      expect(await journal(engine)).toEqual({ requests: 0, ids: '0' });
    });

    test('the pre-#3694 legacy content-hash branch re-seals too', async () => {
      const slug = 'people/legacy-hash-keeper';
      const content = md('The legacy keeper counts herons.');
      await importFromContent(engine, slug, content, { sourceId, noEmbed: true });
      const [page] = await engine.executeRaw<{ title: string; type: string; compiled_truth: string; timeline: string; frontmatter: Record<string, unknown> }>(
        'SELECT title,type,compiled_truth,timeline,frontmatter FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
      await engine.executeRaw('UPDATE pages SET chunker_version=3, content_hash=$3 WHERE source_id=$1 AND slug=$2',
        [sourceId, slug, contentHashLegacy(page as never)]);
      expect((await importFromContent(engine, slug, content, { sourceId, noEmbed: true })).status).toBe('skipped');
      expect((await pageState(engine, sourceId, slug)).chunker_version).toBeGreaterThanOrEqual(SAFE_FENCE_CHUNKER_VERSION);
    });

    test('re-importing an unchanged code file below the fence re-seals it, with or without --no-embed', async () => {
      for (const [path, noEmbed] of [['lib/turnstile-a.ts', true], ['lib/turnstile-b.ts', false]] as const) {
        const imported = await importCodeFile(engine, path, code, { sourceId, noEmbed: true });
        expect(imported.status).toBe('imported');
        await engine.executeRaw('UPDATE pages SET chunker_version=1 WHERE source_id=$1 AND slug=$2', [sourceId, imported.slug]);
        const before = await pageState(engine, sourceId, imported.slug);
        await importCodeFile(engine, path, code, { sourceId, noEmbed });
        const after = await pageState(engine, sourceId, imported.slug);
        expect(after.chunker_version).toBeGreaterThanOrEqual(SAFE_FENCE_CHUNKER_VERSION);
        expect([after.revision, after.versions]).toEqual([before.revision, before.versions]);
      }
      expect(await journal(engine)).toEqual({ requests: 0, ids: '0' });
    });

    test('a coordinated re-import of unchanged legacy content is a no-op that queues a projection-only re-seal', async () => {
      const slug = 'people/prepared-keeper';
      const content = md('The prepared keeper studies granite.');
      await importFromContent(engine, slug, content, { sourceId, noEmbed: true });
      await engine.executeRaw('UPDATE pages SET chunker_version=2 WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
      let noop: boolean | undefined;
      let apply: ((tx: BrainEngine) => Promise<unknown>) | undefined;
      await importFromContent(engine, slug, content, { sourceId, noEmbed: true,
        prepare: async value => { noop = value.noop; apply = value.apply as never; return value.result; } });
      expect(noop).toBe(true);
      await engine.transaction(tx => apply!(tx));
      const jobs = await engine.executeRaw<{ reason: string }>('SELECT reason FROM page_projection_jobs WHERE slug=$1', [slug]);
      expect(jobs.map(j => j.reason)).toEqual(['safe_chunk_reseal']);
      expect(await rebuildPendingPageProjections(engine, 10)).toMatchObject({ rebuilt: 1 });
      expect((await pageState(engine, sourceId, slug)).chunker_version).toBeGreaterThanOrEqual(SAFE_FENCE_CHUNKER_VERSION);
      expect(await journal(engine)).toEqual({ requests: 0, ids: '0' });
    });

    test('a directory import (the sync --full path) reports re-sealed pages and the embedding work they left', async () => {
      const dir = mkdtempSync(join(home, `import-${kind}-`));
      writeFileSync(join(dir, 'walrus.md'), md('Walruses rest on sea ice.'));
      await withEnv({ GBRAIN_HOME: join(home, `import-home-${kind}`) }, async () => {
        const first = await runImport(engine, [dir, '--fresh', '--no-embed', '--json'], { sourceId });
        expect(first.imported).toBe(1);
        expect(first.resealed).toBeUndefined();
        await engine.executeRaw("UPDATE pages SET chunker_version=3 WHERE source_id=$1 AND slug='walrus'", [sourceId]);
        const second = await runImport(engine, [dir, '--fresh', '--no-embed', '--json'], { sourceId });
        expect(second).toMatchObject({ imported: 0, resealed: { pages: 1, pending_chunks: 1 } });
      });
      expect((await pageState(engine, sourceId, 'walrus')).chunker_version).toBeGreaterThanOrEqual(SAFE_FENCE_CHUNKER_VERSION);
    });

    test('doctor and safe_index_pending count legacy code pages; the hint fires on partial results', async () => {
      const imported = await importCodeFile(engine, 'lib/legacy-only.ts', code.replace('verifyTurnstile', 'legacyOnlyMarker'), { sourceId, noEmbed: true });
      await engine.executeRaw('UPDATE pages SET chunker_version=1 WHERE source_id=$1 AND slug=$2', [sourceId, imported.slug]);
      const check = await checkContextualRetrievalCoverage(engine, { sourceIds: [sourceId] });
      expect(check.message).toContain('1 page(s) below the safe-chunk index version');
      expect(check.message).toContain('gbrain repair safe-chunks');
      expect(await remoteSearch('legacyOnlyMarker')).toEqual([]);
      expect(degraded()).toContain('safe_index_pending');
      // A sealed page still matches, so the result is partial, not empty.
      const hits = await remoteSearch('zebras');
      expect(hits.length).toBeGreaterThan(0);
      expect(degraded()).toContain('safe_index_pending');
      await engine.executeRaw('DELETE FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, imported.slug]);
      await remoteSearch('zebras');
      expect(degraded()).not.toContain('safe_index_pending');
    });
  });

  describe(`gbrain repair safe-chunks ${kind}`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await openPostgres());
      else {
        const pglite = new PGLiteEngine();
        await pglite.connect({}); await pglite.initSchema();
        engine = pglite; close = () => pglite.disconnect();
      }
    }, 120_000);
    afterAll(async () => { await disposePersistenceConsumer(engine); await close(); });

    const repairCtx = (sourceId: string) => ({ engine, sourceId, remote: false as const, config: { engine: engine.kind, embedding_disabled: true },
      dryRun: false, logger: { info() {}, warn() {}, error() {} } }) as never;

    test('previews, then re-seals legacy markdown and code pages on a managed brain with zero admissions; a rerun changes nothing', async () => {
      await withEnv({ GBRAIN_HOME: join(home, `managed-${kind}`) }, async () => {
        const sourceId = `repair-${randomUUID().slice(0, 8)}`;
        const root = join(home, `root-${kind}-${sourceId}`); mkdirSync(root, { recursive: true });
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await claimWorktree(engine, sourceId, root);
        const ctx = repairCtx(sourceId);
        for (const slug of ['notes/a', 'notes/b']) {
          await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content: md(`Legacy body of ${slug}.`), request_id: randomUUID() } });
        }
        let codeSlug = '';
        await importCodeFile(engine, 'lib/legacy.ts', code, { sourceId, noEmbed: true, prepare: async value => {
          codeSlug = value.slug;
          await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => value.apply(tx)));
          return value.result;
        } });
        await engine.executeRaw('UPDATE pages SET chunker_version=1 WHERE source_id=$1', [sourceId]);
        const scope = await resolveRepairScope(engine, sourceId);
        const safeChunksModule = await import('../src/core/repair/safe-chunks.ts');
        const { safeChunksRepair } = safeChunksModule;
        // Retired (wave 5): the pending count lives only in the doctor check.
        expect('safeChunkUpgradeAdvisory' in safeChunksModule).toBe(false);
        const { safeIndexPendingCheck } = await import('../src/commands/doctor/checks/safe-index.ts');
        const pending = await safeIndexPendingCheck(engine);
        expect(pending).toMatchObject({ status: 'warn', details: { pages_pending: 3, repair: 'safe-chunks' } });
        expect(pending.message).toContain('3 page(s) are below the safe-chunk index version');
        expect(pending.message).toContain('gbrain repair safe-chunks --apply');
        const preview = await runRepair(ctx, safeChunksRepair, scope, { apply: false, sourceFlag: sourceId });
        expect(preview).toMatchObject({ kind: 'safe-chunks', mode: 'dry_run', affected: 3,
          cost: { lifetime_ids: 0, receipt_bytes: 0, embedding_pages: 3 }, apply_command: `gbrain repair safe-chunks --source ${sourceId} --apply` });
        expect(preview.sample).toEqual(expect.arrayContaining([`${sourceId}:notes/a`, `${sourceId}:${codeSlug}`]));
        const before = await journal(engine);
        const first = await runRepair(ctx, safeChunksRepair, scope, { apply: true, limit: 1, sourceFlag: sourceId });
        expect(first).toMatchObject({ applied: 1, complete: false });
        const rest = await runRepair(ctx, safeChunksRepair, scope, { apply: true, sourceFlag: sourceId });
        expect(rest).toMatchObject({ affected: 2, applied: 2, complete: true });
        expect(rest.resumed_from).not.toBeNull();
        expect(await journal(engine)).toEqual(before);
        const versions = await engine.executeRaw<{ v: number }>('SELECT chunker_version AS v FROM pages WHERE source_id=$1', [sourceId]);
        expect(versions.every(r => Number(r.v) >= SAFE_FENCE_CHUNKER_VERSION)).toBe(true);
        const again = await runRepair(ctx, safeChunksRepair, scope, { apply: true, sourceFlag: sourceId });
        expect(again).toMatchObject({ affected: 0, applied: 0, complete: true });
        expect(await safeIndexPendingCheck(engine)).toMatchObject({ status: 'ok', details: { pages_pending: 0 } });

        // A provider failure after the re-seal keeps the re-seal and names the recovery command.
        await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'notes/c', content: md('Legacy body of notes/c.'), request_id: randomUUID() } });
        await engine.executeRaw("UPDATE pages SET chunker_version=1 WHERE source_id=$1 AND slug='notes/c'", [sourceId]);
        const warnings: string[] = [];
        configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-fake' } });
        __setEmbedTransportForTests((async () => { throw new Error('synthetic provider outage'); }) as never);
        try {
          const failing = { ...(ctx as object), logger: { info() {}, warn: (m: string) => { warnings.push(m); }, error() {} } } as never;
          const embedded = await runRepair(failing, safeChunksRepair, scope, { apply: true, embed: true, sourceFlag: sourceId });
          expect(embedded).toMatchObject({ applied: 1, complete: true });
        } finally {
          __setEmbedTransportForTests(null);
          resetGateway();
        }
        expect(warnings.join('\n')).toContain(`gbrain embed --stale --source ${sourceId}`);
        expect((await pageState(engine, sourceId, 'notes/c')).chunker_version).toBeGreaterThanOrEqual(SAFE_FENCE_CHUNKER_VERSION);
      });
    }, 120_000);
  });
}
