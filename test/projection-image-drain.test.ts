/**
 * #6803 part 2: `gbrain projections drain` makes the projection queue v153 left
 * drainable and truthful. Every queued row falls in exactly one class
 * (text, sealable, reimport, protected, archived); the drain rebuilds the text
 * rows and restores the importer's own seal on `sealable` images in place (no
 * chunk write, no provider call), so image search ranks them again, while every
 * other image stays queued and out of search. PGLite here;
 * test/e2e/projection-image-drain-postgres.test.ts runs the file on Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importImageFile, _resetOcrRunBudgetForTests } from '../src/core/import-file.ts';
import { PAGE_PROJECTION_ACTIVATION_SQL } from '../src/core/page-state/projection-schema.ts';
import { drainProjections, previewProjectionDrain, projectionBacklog } from '../src/core/page-state/projections.ts';
import { formatDrainResult, residentDrainAction } from '../src/commands/projections.ts';
import { embedStaleImages } from '../src/core/embed-stale-images.ts';
import { runEmbed } from '../src/commands/embed.ts';
import { prepareEmbeddingProjections } from '../src/core/embedding-readiness.ts';
import { checkProjectionReadiness, residentProjectionReadiness } from '../src/commands/doctor/checks/projection-readiness.ts';
import { IMAGE_SEAL_PAGES_PER_SECOND, projectionDrainLimit } from '../src/core/page-state/image-seal.ts';
import { projectionUpgradeNotice } from '../src/core/page-state/projection-upgrade-notice.ts';
import { operationsByName } from '../src/core/operations.ts';
import { configureGateway, resetGateway, __setGenerateTextTransportForTests } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const PROTECTED_OCR = '<!--- gbrain:takes:begin -->\nSYNTHETIC_PRIVATE_IMAGE_CANARY\n<!--- gbrain:takes:end -->';
const VISUAL = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
const backends = testBackends();
const origFetch = globalThis.fetch;
const closers: Array<() => Promise<void>> = [];
const roots: string[] = [];
let ocrText = '';

beforeAll(() => {
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ data: [{ embedding: VISUAL, index: 0 }], model: 'voyage-multimodal-3', usage: { total_tokens: 10 } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
  configureGateway({
    expansion_model: 'anthropic:claude-sonnet-5-5', embedding_model: 'voyage:voyage-multimodal-3',
    embedding_multimodal_model: 'voyage:voyage-multimodal-3', embedding_dimensions: 1024,
    env: { ANTHROPIC_API_KEY: 'synthetic-test-key', VOYAGE_API_KEY: 'synthetic-test-key' },
  });
  __setGenerateTextTransportForTests((async () => ({ text: ocrText, usage: { inputTokens: 10, outputTokens: 10 } })) as never);
});

afterAll(async () => {
  for (const close of closers) await close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  globalThis.fetch = origFetch;
  __setGenerateTextTransportForTests(null);
  resetGateway();
  _resetOcrRunBudgetForTests();
});

async function freshEngine(backend: string): Promise<BrainEngine> {
  if (backend === 'postgres') {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    closers.push(pg.close);
    return pg.engine;
  }
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  closers.push(() => engine.disconnect());
  return engine;
}

async function importImage(engine: BrainEngine, root: string, slug: string, opts: { sourceId?: string; noEmbed?: boolean; ocr?: string } = {}) {
  mkdirSync(join(root, slug, '..'), { recursive: true });
  writeFileSync(join(root, slug), PNG);
  ocrText = opts.ocr ?? '';
  _resetOcrRunBudgetForTests();
  await withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: 'true', GBRAIN_EMBEDDING_IMAGE_OCR: opts.ocr ? 'true' : 'false' }, async () => {
    expect((await importImageFile(engine, join(root, slug), slug, { sourceId: opts.sourceId, noEmbed: opts.noEmbed })).status).toBe('imported');
  });
}

/**
 * One image per class plus Markdown, then the v153 activation: sealable with
 * and without a visual vector, pre-fence, distrusted (protected OCR edited
 * clean), multi-chunk, protected, an archived-source image and Markdown.
 */
async function classFixture(engine: BrainEngine) {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-image-drain-'));
  roots.push(root);
  await engine.executeRaw('UPDATE sources SET local_path = $1 WHERE id = $2', [root, 'default']);
  await engine.executeRaw("INSERT INTO sources(id,name,local_path) VALUES('img-archive','img-archive',$1)", [root]);
  await importImage(engine, root, 'images/sealable-visual.png');
  await importImage(engine, root, 'images/sealable-text-only.png', { noEmbed: true });
  await importImage(engine, root, 'images/pre-fence.png');
  await engine.executeRaw("UPDATE pages SET chunker_version = 3 WHERE slug = 'images/pre-fence.png'");
  await importImage(engine, root, 'images/distrusted.png', { ocr: PROTECTED_OCR });
  const page = (await engine.getPage('images/distrusted.png'))!;
  await engine.putPage('images/distrusted.png', { ...page, page_kind: 'image', compiled_truth: 'Public caption.' });
  await importImage(engine, root, 'images/multi-chunk.png');
  const [multi] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug = 'images/multi-chunk.png'");
  await engine.executeRaw(`INSERT INTO content_chunks(page_id,chunk_index,chunk_text,chunk_source,modality) VALUES($1,1,'second','image_asset','image')`, [multi!.id]);
  await importImage(engine, root, 'images/protected.png', { ocr: PROTECTED_OCR });
  await importImage(engine, root, 'images/archived.png', { sourceId: 'img-archive' });
  await engine.executeRaw("UPDATE sources SET archived = true WHERE id = 'img-archive'");
  for (const slug of ['notes/alpha', 'notes/beta']) await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `Example note ${slug}.` });
  await activate(engine);
}

/** Migration v153's activation, one statement at a time. */
async function activate(engine: BrainEngine) {
  for (const statement of PAGE_PROJECTION_ACTIVATION_SQL.split(';').map(part => part.trim()).filter(Boolean)) await engine.executeRaw(statement);
}

async function remoteImageHits(engine: BrainEngine): Promise<string[]> {
  await engine.setConfig('search.image_query.daily_budget_usd_per_client', '5');
  const results = await operationsByName.search_by_image.handler(
    { engine, remote: true, auth: { token: 't', clientId: 'remote-client', scopes: ['read'] } } as never,
    { image_data: PNG.toString('base64') },
  ) as Array<{ slug: string }>;
  return results.map(r => r.slug);
}

const visual = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ v: string | null }>(
  'SELECT c.embedding_image::text AS v FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.slug = $1', [slug]))[0]?.v ?? null;
const queued = async (engine: BrainEngine) => (await engine.executeRaw<{ slug: string }>('SELECT slug FROM page_projection_jobs ORDER BY slug')).map(r => r.slug);

for (const backend of backends) {
  describe(`projection image drain (${backend})`, () => {
    test('classes partition the queue; the drain seals only importer-attested images and image search ranks them again', async () => {
      const engine = await freshEngine(backend);
      await classFixture(engine);
      const total = (await queued(engine)).length;
      const backlog = await projectionBacklog(engine);
      expect(backlog).toMatchObject({ pending: 2, sealable: 2, sealable_with_visual: 1, reimport: 3, ocr_required: 1, protected: 1, archived: 1 });
      expect(backlog.pending + backlog.sealable! + backlog.reimport! + backlog.protected! + backlog.archived!).toBe(total);
      const before = await visual(engine, 'images/sealable-visual.png');
      expect(before).not.toBeNull();
      expect(await remoteImageHits(engine)).not.toContain('images/sealable-visual.png');

      const preview = await previewProjectionDrain(engine);
      expect(preview.rows.filter(row => row.page_kind === 'image').map(row => row.slug).sort()).toEqual(['images/sealable-text-only.png', 'images/sealable-visual.png']);
      const drained = await drainProjections(engine, { media: true });
      expect(drained).toMatchObject({ rebuilt: preview.pending, sealed: preview.sealable, sealed_with_visual: preview.sealable_with_visual, sealed_text_only: 1, failed: [] });
      expect(drained.remaining_by_class).toMatchObject({ pending: 0, sealable: 0, reimport: 3, protected: 1, archived: 1 });

      expect(await visual(engine, 'images/sealable-visual.png')).toBe(before);
      const hits = await remoteImageHits(engine);
      expect(hits).toContain('images/sealable-visual.png');
      for (const slug of ['images/pre-fence.png', 'images/distrusted.png', 'images/multi-chunk.png', 'images/protected.png']) expect(hits).not.toContain(slug);
      expect(await queued(engine)).toEqual(['images/archived.png', 'images/distrusted.png', 'images/multi-chunk.png', 'images/pre-fence.png', 'images/protected.png']);
      const human = formatDrainResult(drained);
      expect(human).not.toContain('backlog is empty');
      expect(human).toContain('3 image pages need their importer');
    }, 180_000);

    test('101 unsealable rows ahead of a sealable one do not stop the drain; a limited batch says so', async () => {
      const engine = await freshEngine(backend);
      const root = mkdtempSync(join(tmpdir(), 'gbrain-image-drain-'));
      roots.push(root);
      await engine.executeRaw('UPDATE sources SET local_path = $1 WHERE id = $2', [root, 'default']);
      await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,page_kind,title,compiled_truth,timeline,chunker_version)
        SELECT 'default','images/a-legacy-'||lpad(i::text,3,'0')||'.png','image','image','legacy','','',0 FROM generate_series(1,101) i`);
      await importImage(engine, root, 'images/z-attested-1.png');
      await importImage(engine, root, 'images/z-attested-2.png');
      await activate(engine);
      await engine.executeRaw(`UPDATE page_projection_jobs SET updated_at = now() - interval '1 hour' WHERE slug LIKE 'images/a-legacy-%'`);
      expect(await projectionBacklog(engine)).toMatchObject({ reimport: 101, sealable: 2 });
      const limited = await drainProjections(engine, { media: true, limit: 1 });
      expect(limited).toMatchObject({ sealed: 1, limited: true, remaining_by_class: expect.objectContaining({ sealable: 1, reimport: 101 }) });
      expect(formatDrainResult(limited, 1)).toContain('run `gbrain projections drain --limit 1` again to continue');
      expect(await drainProjections(engine, { media: true })).toMatchObject({ sealed: 1, limited: false });
    }, 180_000);

    test('doctor counts each class, asks before sealing, routes reimport to the paid sweep and leaves by-design rows to judgement', async () => {
      const engine = await freshEngine(backend);
      await classFixture(engine);
      const queuedCheck = await checkProjectionReadiness(engine);
      expect(queuedCheck).toMatchObject({ status: 'warn', details: { pending: 2, sealable: 2, sealable_with_visual: 1, reimport: 3, ocr_required: 1, protected: 1, archived: 1 } });
      expect(queuedCheck.fix).toMatchObject({ argv: ['gbrain', 'projections', 'drain', '--limit', String(projectionDrainLimit(2))],
        preview_argv: ['gbrain', 'projections', 'drain', '--dry-run', '--json'], actor: 'agent', ask_user: true, consent: [] });
      expect(queuedCheck.fix!.user_message).toContain('2 image page(s) are out of search');
      expect((await checkProjectionReadiness(engine, {}, { remote: true })).fix).toMatchObject({ actor: 'host_admin' });
      // The drain takes text first, so queued text sizes the run at the slower text rate; images alone get the seal rate.
      expect(projectionDrainLimit(2)).toBeLessThan(projectionDrainLimit());

      await drainProjections(engine, { media: true });
      const reimport = await withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: 'true' }, () => checkProjectionReadiness(engine));
      expect(reimport.status).toBe('warn');
      expect(reimport.fix).toMatchObject({ argv: ['gbrain', 'embed', '--stale', '--images', '--max-usd', '<USD>'], consent: ['paid', 'egress'], ask_user: true,
        preview_argv: ['gbrain', 'embed', '--stale', '--images', '--dry-run', '--json'] });
      expect(reimport.message).toContain('GBRAIN_EMBEDDING_IMAGE_OCR=true');
      const blocked = await withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: 'false' }, () => checkProjectionReadiness(engine));
      expect(blocked.fix).toBeUndefined();
      expect(blocked).toMatchObject({ fix_unavailable_reason: 'operator_judgement', details: { reimport_blocked_by: 'GBRAIN_EMBEDDING_MULTIMODAL' } });

      await engine.executeRaw("UPDATE pages SET deleted_at = now() WHERE slug IN ('images/pre-fence.png','images/distrusted.png','images/multi-chunk.png')");
      const byDesign = await checkProjectionReadiness(engine);
      expect(byDesign).toMatchObject({ status: 'ok', severity: 'info', fix_unavailable_reason: 'operator_judgement', details: { protected: 1, archived: 1 } });
      expect(byDesign.message).toContain('stay unsealed by design');
    }, 180_000);

    test('post-upgrade names the drain preview with a measured estimate while image pages wait, and writes nothing', async () => {
      const engine = await freshEngine(backend);
      expect(await projectionUpgradeNotice(engine)).toBeNull();
      await classFixture(engine);
      const jobs = await queued(engine);
      const notice = (await projectionUpgradeNotice(engine))!.join('\n');
      expect(notice).toContain('[AGENT]');
      expect(notice).toContain(`2 image page(s) the importer already attested can be sealed keyless by gbrain projections drain (about 1 minute(s) at ${IMAGE_SEAL_PAGES_PER_SECOND} pages/s, the rate measured`);
      expect(notice).toContain('3 image page(s) need their importer');
      expect(notice).toContain('next: run: gbrain projections drain --dry-run');
      expect(await queued(engine)).toEqual(jobs);
      await engine.executeRaw("UPDATE pages SET deleted_at = now() WHERE slug IN ('images/pre-fence.png','images/distrusted.png','images/multi-chunk.png')");
      await drainProjections(engine, { media: true });
      expect(await projectionUpgradeNotice(engine)).toBeNull();
    }, 180_000);

    test('embedding recovery never queues or re-stamps image rows, and a rebuild_failed image keeps its reason', async () => {
      const engine = await freshEngine(backend);
      await classFixture(engine);
      await engine.executeRaw("UPDATE page_projection_jobs SET reason = 'rebuild_failed' WHERE slug = 'images/pre-fence.png'");
      const images = async () => engine.executeRaw<{ slug: string; reason: string; revision: string; updated_at: string }>(`SELECT slug,reason,revision::text AS revision,
        updated_at::text AS updated_at FROM page_projection_jobs WHERE slug LIKE 'images/%' ORDER BY slug`);
      const before = await images();
      expect(before.find(row => row.slug === 'images/pre-fence.png')?.reason).toBe('rebuild_failed');
      const recovered = await prepareEmbeddingProjections(engine, { repair: true });
      expect(recovered.rebuilt).toBe(2);
      expect(await images()).toEqual(before);
      expect(await projectionBacklog(engine)).toMatchObject({ pending: 0, sealable: 2, reimport: 3 });
    }, 180_000);

    test('embed --stale --images counts every class: sealable is never a candidate and an ocr_required refusal is its own count', async () => {
      const engine = await freshEngine(backend);
      await classFixture(engine);
      const lines: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
      try {
        await withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: 'true', GBRAIN_EMBEDDING_IMAGE_OCR: 'false' }, async () => {
          await runEmbed(engine, ['--stale', '--images', '--dry-run']);
          await runEmbed(engine, ['--stale', '--images', '--dry-run', '--json']);
        });
      } finally { console.log = origLog; }
      expect(JSON.parse(lines.at(-1)!)).toMatchObject({ candidates: 3, reimport: 3, incomplete_sealed: 0, ocr_required: 1, sealable: 2, protected: 1, archived: 1 });
      expect(lines[0]).toContain('3 incomplete (3 to reimport, 0 sealed but incomplete)');
      expect(lines[1]).toContain('1 would be refused until OCR is enabled (ocr_required; GBRAIN_EMBEDDING_IMAGE_OCR=true), 2 sealable (not candidates');
      expect(lines[1]).toContain('1 protected and 1 archived (not candidates, by design)');

      ocrText = '';
      _resetOcrRunBudgetForTests();
      const swept = await withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: 'true', GBRAIN_EMBEDDING_IMAGE_OCR: 'false' },
        async () => embedStaleImages(engine, { dryRun: false }));
      expect(swept).toMatchObject({ candidates: 3, rebuilt: 2, ocr_required: 1, skipped: 0, failures: 0 });
      expect(await projectionBacklog(engine)).toMatchObject({ sealable: 2, reimport: 1, ocr_required: 1 });
    }, 180_000);

    if (backend === 'pglite') {
      test('a resident that predates the class counts is named, with the restart step', () => {
        const old = residentProjectionReadiness(4242, { pending: 2, failed: 0, oldest_age_seconds: 5 }, 'STOP-DRAIN-RESTART');
        expect(old).toMatchObject({ status: 'warn', fix_unavailable_reason: 'operator_judgement', details: { readiness: 'unknown', owner_pid: 4242 } });
        expect(old.message).toContain('predates this upgrade');
        expect(old.message).toContain('STOP-DRAIN-RESTART');
      });

      test('a resident holding sealable images gets the exclusive two-step action: stop, drain, restart, verify through doctor', () => {
        const status = { pending: 4, failed: 0, oldest_age_seconds: 5, sealable: 3000, sealable_with_visual: 2000, reimport: 7, ocr_required: 1, protected: 1, archived: 0, as_of: 'now' };
        const holder = { held: true, pid: 4242, subcommand: 'serve' } as Parameters<typeof residentDrainAction>[0];
        const check = residentProjectionReadiness(4242, status, 'STOP-DRAIN-RESTART', residentDrainAction(holder, 'host', status));
        expect(check.status).toBe('warn');
        expect(check.fix).toMatchObject({ argv: ['kill', '4242'], actor: 'user', requires_exclusive: false,
          then: { argv: ['gbrain', 'projections', 'drain', '--limit', String(projectionDrainLimit(4))], actor: 'user', requires_exclusive: true,
            verify: { argv: ['gbrain', 'doctor', '--only', 'text_projection_readiness', '--json'] } } });
        expect(check.fix!.user_message).toContain('3000 image page(s) the drain can seal and 4 queued text page(s)');
        expect(check.fix!.user_message).toContain('stopped for about 3 second(s) per drain run; harnesses connected through that serve disconnect');
      });

      test('projection statistics reflect the sealed share after the drain', async () => {
        const engine = await freshEngine(backend);
        await classFixture(engine);
        const drained = await drainProjections(engine, { media: true });
        expect(drained.statistics_refreshed).toBe(true);
        const [stats] = await engine.executeRaw<{ vals: string | null; freqs: number[] | null }>(`SELECT most_common_vals::text AS vals, most_common_freqs AS freqs
          FROM pg_stats_ext_exprs WHERE statistics_name = 'pages_text_projection_current_stats'`);
        const [share] = await engine.executeRaw<{ sealed: number }>(`SELECT avg(CASE WHEN text_projection_revision = knowledge_revision THEN 1.0 ELSE 0 END)::float8 AS sealed FROM pages`);
        const vals = String(stats?.vals ?? '').replace(/[{}]/g, '').split(',');
        const sealedFreq = Number(stats?.freqs?.[vals.indexOf('t')] ?? 0);
        expect(sealedFreq).toBeCloseTo(Number(share!.sealed), 2);
      }, 180_000);
    }
  });
}
