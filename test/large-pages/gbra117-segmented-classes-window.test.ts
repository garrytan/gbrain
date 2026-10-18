/**
 * GBRA-117 conditions on the #6869 gate-ahead merge (the #6803 wave beside Wave B PR 2's segmented route).
 *
 * 1. Protects: a queued segmented page (over 1 MiB) is counted with Markdown in every backlog surface #6803 classes
 *    (projectionBacklog, the drain preview, doctor text_projection_readiness, the resident's projection_status cache,
 *    search readiness), pending, claimed, lapsed or left unsealed by a deferred retirement, and never as failed; it never
 *    takes the media flag, so sealImageProjections never seals it. The resident's bounded window (500 rows: the
 *    recency lane and the primary-key window) bounds the inline selector only: with 600 inline rows queued ahead of a
 *    segmented page (lower keys and newer), the resident builds the segmented page in its first tick, the drain builds
 *    it first, and the consumer's idle probe stays true while it is pending outside the window.
 * 2. Fails when: the backlog leaves segmented rows out of pending or counts a live claim as failed; projectionClassSql
 *    or sealableImageSql admit a segmented page as a sealable image; the segmented route reads only the resident's
 *    window; the idle probe's segmented clause is dropped.
 * 3. Existing coverage: projection-resident-window.test.ts (a fake one-byte segmented row and the idle probe on PGLite),
 *    segmented-create-searchable.test.ts (claim and lapse through the drain).
 * 4. Runs on PGLite, and on Postgres when DATABASE_URL is set. Bounds count resident ticks and drain work, never time.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { SEGMENTED_CREATE_SEAL_MAX_BYTES } from '../../src/core/page-body/limits.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { drainProjections, previewProjectionDrain, projectionBacklog, projectionDrainWork, SEGMENTED_PROJECTION_CLAIM,
  SEGMENTED_PROJECTION_LEASE_SECONDS } from '../../src/core/page-state/projections.ts';
import { sealImageProjections } from '../../src/core/page-state/image-seal.ts';
import { startProjectionStatusCache } from '../../src/core/page-state/projection-status.ts';
import { residentProjectionCursor, RESIDENT_PROBE_BUDGET } from '../../src/core/page-state/projection-window.ts';
import { SAFE_FENCE_CHUNKER_VERSION } from '../../src/core/search/safe-chunks.ts';
import { __resetProjectionReadinessCacheForTests, probeProjectionReadiness } from '../../src/core/search/projection-readiness.ts';
import { checkProjectionReadiness } from '../../src/commands/doctor/checks/projection-readiness.ts';
import { PersistenceConsumer, runResidentProjectionInvocation } from '../../src/core/persistence/consumer.ts';
import { conversationBody } from '../helpers/conversation-page.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';
import { testBackends } from '../helpers/test-backends.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-gbra117-'));
const PROJECTION_PAGE_READ = "FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL AND body_storage='segmented'";

/** The engine with the segmented projection's page read failing: the post-commit projection is lost before it retires anything. */
function projectionLost(engine: BrainEngine): BrainEngine {
  return new Proxy(engine, {
    get(target, prop) {
      if (prop === 'executeRaw') {
        return (sql: string, params?: unknown[]) => sql.includes(PROJECTION_PAGE_READ)
          ? Promise.reject(new Error('projection lost (probe)')) : target.executeRaw(sql, params);
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
const SEGMENTED = 'zz/segmented-chat';
const INLINE_AHEAD = RESIDENT_PROBE_BUDGET + 100;
const content = (needle: string) => `---\ntitle: Group chat\ntype: note\n---\n\n${conversationBody(SEGMENTED_CREATE_SEAL_MAX_BYTES + 256 * 1024, { seed: 11, needles: [{ at: 0.995, word: needle }] })}\n`;

for (const kind of testBackends()) {
  describe(`GBRA-117: segmented rows beside the #6803 queue classes and resident window (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
    }, 120_000);
    afterAll(async () => {
      await withEnv({ GBRAIN_HOME: home }, async () => { await disposePersistenceConsumer(engine); await close?.(); });
    });
    beforeEach(async () => {
      await engine.executeRaw('DELETE FROM page_projection_jobs');
      await engine.executeRaw('DELETE FROM pages');
      await engine.setConfig('pages.segmented_storage', 'on');
      __resetProjectionReadinessCacheForTests();
    });
    afterEach(() => installFaultHook(undefined));

    /** A segmented page over 1 MiB whose post-commit projection died: unsealed, one queued row. */
    async function unbuiltSegmented(needle: string): Promise<void> {
      installFaultHook(point => { if (point === 'segmented:projection_staged') throw new Error('post-commit build died'); });
      const imported = await importFromContent(engine, SEGMENTED, content(needle), { sourceId: 'default', noEmbed: true });
      installFaultHook(undefined);
      expect(imported.searchable).toBe('pending');
      const [row] = await engine.executeRaw<{ body_storage: string; body_bytes: number; sealed: boolean }>(`SELECT body_storage, body_bytes::int AS body_bytes,
        text_projection_revision IS NOT DISTINCT FROM knowledge_revision AS sealed FROM pages WHERE source_id='default' AND slug=$1`, [SEGMENTED]);
      expect(row).toMatchObject({ body_storage: 'segmented', sealed: false });
      expect(Number(row!.body_bytes)).toBeGreaterThan(1024 * 1024);
      expect(await queuedRows(SEGMENTED)).toBe(1);
    }
    const queuedRows = async (slug: string) => Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_projection_jobs WHERE slug=$1', [slug]))[0]!.n);
    const sealed = async (slug: string) => (await engine.executeRaw<{ sealed: boolean }>(`SELECT text_projection_revision IS NOT DISTINCT FROM knowledge_revision AS sealed
      FROM pages WHERE source_id='default' AND slug=$1`, [slug]))[0]?.sealed === true;
    const setJob = (reason: string, ageSeconds: number) => engine.executeRaw(`UPDATE page_projection_jobs SET reason=$2, updated_at=now()-make_interval(secs => $3)
      WHERE slug=$1`, [SEGMENTED, reason, ageSeconds]);

    /** Every backlog surface #6803 classes, read for the one queued segmented page. */
    async function surfaces() {
      __resetProjectionReadinessCacheForTests();
      const backlog = await projectionBacklog(engine);
      const preview = await previewProjectionDrain(engine);
      const doctor = await checkProjectionReadiness(engine);
      const cache = startProjectionStatusCache(engine, { checkMs: 3_600_000 });
      const status = await cache.read();
      cache.stop();
      const readiness = await probeProjectionReadiness(engine, {});
      const d = doctor.details as Record<string, unknown>;
      const counts = (b: { pending: number; failed: number; sealable?: number; reimport?: number; protected?: number; archived?: number }) =>
        ({ pending: b.pending, failed: b.failed, sealable: b.sealable, reimport: b.reimport, protected: b.protected, archived: b.archived });
      return {
        backlog: counts(backlog), preview: counts(preview), status: counts(status),
        doctor: { status: doctor.status, ...counts(d as never), segmented_pending: d.segmented_pending },
        readiness: readiness.status,
      };
    }
    const QUEUED = { pending: 1, failed: 0, sealable: 0, reimport: 0, protected: 0, archived: 0 };
    const EXPECTED = { backlog: QUEUED, preview: QUEUED, status: QUEUED, doctor: { status: 'warn' as const, ...QUEUED, segmented_pending: 1 }, readiness: 'projection_pending' as const };

    test('condition 1: a queued segmented page counts with Markdown and never as failed: pending, claimed, lapsed, deferred retirement', async () => {
      await unbuiltSegmented(`zzpending${kind}`);
      expect(await surfaces()).toEqual(EXPECTED);
      await setJob(SEGMENTED_PROJECTION_CLAIM, 1);
      expect(await surfaces()).toEqual(EXPECTED);
      await setJob(SEGMENTED_PROJECTION_CLAIM, SEGMENTED_PROJECTION_LEASE_SECONDS + 1);
      expect(await surfaces()).toEqual(EXPECTED);

      // Deferred retirement: built, then rewritten with flip retirement capped at one row and its projection lost.
      expect((await drainProjections(engine)).rebuilt).toBe(1);
      expect(await sealed(SEGMENTED)).toBe(true);
      await engine.setConfig('pages.flip_retire_max_rows', '1');
      try {
        await importFromContent(projectionLost(engine), SEGMENTED, content(`zzpending${kind}`).replace(`zzpending${kind}`, `zzrewritten${kind}`),
          { sourceId: 'default', noEmbed: true });
      } finally {
        await engine.setConfig('pages.flip_retire_max_rows', '20000');
      }
      const [stale] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM content_chunks c JOIN pages p ON p.id=c.page_id
        WHERE p.source_id='default' AND p.slug=$1 AND NOT EXISTS (SELECT 1 FROM page_body_manifest m WHERE m.page_id=c.page_id AND m.occurrence_id=c.occurrence_id
          AND m.gen_from <= p.body_generation AND (m.gen_to IS NULL OR m.gen_to > p.body_generation))`, [SEGMENTED]);
      expect(Number(stale!.n)).toBeGreaterThan(0);
      expect(await sealed(SEGMENTED)).toBe(false);
      expect(await surfaces()).toEqual(EXPECTED);
      expect((await drainProjections(engine)).rebuilt).toBe(1);
      expect(await sealed(SEGMENTED)).toBe(true);
    }, 300_000);

    test('condition 1: a segmented page never takes the media flag; sealImageProjections never seals it', async () => {
      await unbuiltSegmented(`zzmedia${kind}`);
      expect((await drainProjections(engine)).rebuilt).toBe(1);
      // Dress the segmented page as an importer-sealed image whose only change is a removed seal marker.
      const [page] = await engine.executeRaw<{ id: number; generation: number }>(`SELECT id, body_generation::int AS generation FROM pages
        WHERE source_id='default' AND slug=$1`, [SEGMENTED]);
      const [keep] = await engine.executeRaw<{ id: number }>('SELECT min(id)::int AS id FROM content_chunks WHERE page_id=$1', [page!.id]);
      await engine.executeRaw('DELETE FROM content_chunks WHERE page_id=$1 AND id<>$2', [page!.id, keep!.id]);
      await engine.executeRaw(`UPDATE content_chunks SET chunk_index=0, chunk_source='image_asset', modality='image', chunk_text='img' WHERE id=$1`, [keep!.id]);
      await engine.executeRaw(`UPDATE pages SET page_kind='image', chunker_version=$2, truth_lead='img', body_flags=COALESCE(body_flags,'{}'::jsonb) || '{"has_protected":false}'::jsonb,
        text_projection_revision=NULL WHERE id=$1`, [page!.id, SAFE_FENCE_CHUNKER_VERSION]);
      await engine.executeRaw(`INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason)
        SELECT s.incarnation,p.slug,p.knowledge_revision,'pages_trigger' FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.id=$1 ON CONFLICT DO NOTHING`, [page!.id]);
      await engine.executeRaw("UPDATE page_projection_jobs SET updated_at=now()-interval '1 minute'");
      const backlog = await projectionBacklog(engine);
      expect({ pending: backlog.pending, sealable: backlog.sealable, reimport: backlog.reimport }).toEqual({ pending: 1, sealable: 0, reimport: 0 });
      expect((await previewProjectionDrain(engine)).rows).toEqual([]);
      expect(await sealImageProjections(engine)).toEqual({ sealed: 0, sealed_with_visual: 0, sealed_text_only: 0 });
      expect(await sealed(SEGMENTED)).toBe(false);
      expect(await queuedRows(SEGMENTED)).toBe(1);
    }, 300_000);

    /** INLINE_AHEAD queued Markdown pages, all ahead of the segmented row: lower primary keys and newer updated_at. */
    async function inlineAhead(): Promise<void> {
      await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,page_kind,title,compiled_truth,timeline,chunker_version)
        SELECT 'default','aa/note-'||lpad(i::text,4,'0'),'note','markdown','note '||i,'Example note '||i||'.','',0 FROM generate_series(1,$1::int) i`, [INLINE_AHEAD]);
      await engine.executeRaw("UPDATE pages SET text_projection_revision=NULL WHERE slug LIKE 'aa/note-%'");
      await engine.executeRaw(`INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason)
        SELECT s.incarnation,p.slug,p.knowledge_revision,'pages_trigger' FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.slug LIKE 'aa/note-%'
        ON CONFLICT DO NOTHING`);
      await engine.executeRaw("UPDATE page_projection_jobs SET updated_at=now() WHERE slug LIKE 'aa/note-%'");
      await engine.executeRaw("UPDATE page_projection_jobs SET updated_at=now()-interval '1 hour' WHERE slug=$1", [SEGMENTED]);
      expect(Number((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM page_projection_jobs WHERE slug LIKE 'aa/note-%'"))[0]!.n)).toBe(INLINE_AHEAD);
      const cursor = residentProjectionCursor(engine);
      cursor.after = { source_incarnation: '00000000-0000-0000-0000-000000000000', slug: '' };
      cursor.highWater = (await engine.executeRaw<{ at: string }>('SELECT now()::text AS at'))[0]!.at;
    }
    const inlineQueued = async () => Number((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM page_projection_jobs WHERE slug LIKE 'aa/note-%'"))[0]!.n);

    test('condition 2: the resident builds the segmented page in its first tick with 600 inline rows ahead of it', async () => {
      await unbuiltSegmented(`zzresident${kind}`);
      await inlineAhead();
      const hostId = randomUUID();
      let ticks = 0;
      for (; ticks < 3 && !(await sealed(SEGMENTED)); ticks++) await runResidentProjectionInvocation(engine, hostId, [], () => 0);
      expect(ticks).toBe(1);
      expect(await sealed(SEGMENTED)).toBe(true);
      expect(await queuedRows(SEGMENTED)).toBe(0);
      // The inline selector took at most one batch from its window; most inline rows are still queued ahead.
      expect(await inlineQueued()).toBeGreaterThanOrEqual(INLINE_AHEAD - 100);
    }, 300_000);

    test('condition 2: projections drain builds the segmented page first with 600 inline rows ahead of it', async () => {
      await unbuiltSegmented(`zzdrain${kind}`);
      await inlineAhead();
      for (const k of Object.keys(projectionDrainWork) as Array<keyof typeof projectionDrainWork>) projectionDrainWork[k] = 0;
      const drained = await drainProjections(engine, { limit: 1 });
      expect(drained.rebuilt).toBe(1);
      expect(drained.limited).toBe(true);
      expect({ segmented: projectionDrainWork.segmented_pages, inline: projectionDrainWork.inline_pages }).toEqual({ segmented: 1, inline: 0 });
      expect(await sealed(SEGMENTED)).toBe(true);
      expect(await inlineQueued()).toBe(INLINE_AHEAD);
    }, 300_000);

    test('a limited drain that stops with only segmented rows left reports limited', async () => {
      await unbuiltSegmented(`zzlimited${kind}`);
      await engine.executeRaw("UPDATE page_projection_jobs SET updated_at=now()-interval '1 minute'");
      installFaultHook(point => { if (point === 'segmented:projection_staged') throw new Error('post-commit build died'); });
      await importFromContent(engine, 'zz/second-chat', content(`zzsecond${kind}`), { sourceId: 'default', noEmbed: true });
      installFaultHook(undefined);
      expect(await queuedRows('zz/second-chat')).toBe(1);
      const drained = await drainProjections(engine, { limit: 1 });
      expect(drained.rebuilt).toBe(1);
      expect(drained.remaining).toBe(1);
      expect(drained.limited).toBe(true);
      expect((await drainProjections(engine)).limited).toBe(false);
    }, 300_000);

    test('condition 2: the idle probe stays true while a segmented row is pending outside the window', async () => {
      await unbuiltSegmented(`zzprobe${kind}`);
      // 600 queued image rows the inline selector never builds fill the window ahead of the segmented row.
      await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,page_kind,title,compiled_truth,timeline,chunker_version)
        SELECT 'default','images/img-'||lpad(i::text,4,'0')||'.png','image','image','img','','',0 FROM generate_series(1,$1::int) i`, [INLINE_AHEAD]);
      await engine.executeRaw(`INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason)
        SELECT s.incarnation,p.slug,p.knowledge_revision,'pages_trigger' FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.slug LIKE 'images/%'
        ON CONFLICT DO NOTHING`);
      await engine.executeRaw("UPDATE page_projection_jobs SET updated_at=now()-interval '1 hour'");
      const consumer = new PersistenceConsumer(engine, {} as never, async () => { throw new Error('no preparation in this probe'); });
      const hasWork = () => (consumer as unknown as { hasWork(): Promise<boolean> }).hasWork();
      const cursor = residentProjectionCursor(engine);
      const reset = async () => {
        cursor.after = { source_incarnation: '00000000-0000-0000-0000-000000000000', slug: '' };
        cursor.highWater = (await engine.executeRaw<{ at: string }>('SELECT now()::text AS at'))[0]!.at;
      };
      for (let lap = 0; lap < 3; lap++) {
        await reset();
        expect(await hasWork()).toBe(true);
      }
      // Lapsed claim: still work. A live claim is another process's build: not this consumer's work.
      await setJob(SEGMENTED_PROJECTION_CLAIM, SEGMENTED_PROJECTION_LEASE_SECONDS + 1);
      await reset();
      expect(await hasWork()).toBe(true);
      await setJob(SEGMENTED_PROJECTION_CLAIM, 1);
      await reset();
      expect(await hasWork()).toBe(false);
    }, 300_000);
  });
}
