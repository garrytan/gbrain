/**
 * When a new segmented page becomes searchable (N14 large-page fidelity,
 * Wave B PR 1: a 20 MB create replied `write_pending`, then took 9.3 s more
 * to become searchable, with nothing in the receipt saying so).
 *
 * 1. Protects: a create within SEGMENTED_CREATE_SEAL_MAX_BYTES chunks during
 *    preparation and seals in its publication, so the put_page reply says
 *    `searchable: true` and keyword search finds text from its last segment
 *    as soon as the call returns, with no post-commit projection; a larger
 *    create's receipt says `searchable: 'pending'` with the poll interval and
 *    the get_write_request read that tells, and that read turns
 *    `searchable: true` exactly when search finds the page; one projection
 *    builds it (the write's post-commit build claims the page's queue row, so
 *    the resident's queue route does not chunk it a second time). A create
 *    within the bound that dies inside its publication leaves nothing behind.
 *    A larger create whose post-commit build died is named by doctor and
 *    built by `gbrain projections drain` once the dead build's claim lapses
 *    (exactly one build; a live claim is left alone), and the receipt's
 *    `searchable_fix` names that drain as its fallback.
 * 2. Fails when: a small create publishes unsealed (its reply would depend on
 *    the post-commit projection beating the reply deadline), the receipt has
 *    no `searchable` contract, a receipt claims searchable before search sees
 *    the page, two projections chunk the same body, or the drain skips (or
 *    races a live build of) a page stored in segments.
 * 3. Existing coverage: segmented-embedding-paths.test.ts covers an unsealed
 *    create recovered by the projection queue and `embed`.
 * 4. Runs on PGLite, and on Postgres when DATABASE_URL is set. Each test
 *    starts with this process's persistence consumer stopped (stop waits for
 *    its resident projection build): a put_page starts it again, and a
 *    resident left running from an earlier test is a live builder that
 *    claims a queued page (the drain then rightly skips it) and reaches the
 *    next test's projection hook.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { segmentChunkWork } from '../../src/core/page-body/ingest.ts';
import { SEGMENTED_CREATE_SEAL_MAX_BYTES } from '../../src/core/page-body/limits.ts';
import { buildSegmentedProjection } from '../../src/core/page-body/projection.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { drainProjections, projectionDrainWork, SEGMENTED_PROJECTION_CLAIM, SEGMENTED_PROJECTION_LEASE_SECONDS } from '../../src/core/page-state/projections.ts';
import { checkProjectionReadiness } from '../../src/commands/doctor/checks/projection-readiness.ts';
import { conversationBody } from '../helpers/conversation-page.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';
import { testBackends } from '../helpers/test-backends.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-segmented-searchable-'));
const page = (bytes: number, needle: string) => `---\ntitle: Group chat\ntype: note\n---\n\n${conversationBody(bytes, { seed: 7, needles: [{ at: 0.995, word: needle }] })}\n`;

for (const kind of testBackends()) {
  describe(`a new segmented page is searchable when its receipt says so (${kind})`, () => {
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
      await withEnv({ GBRAIN_HOME: home }, () => disposePersistenceConsumer(engine));
      await engine.executeRaw('DELETE FROM pages');
      await engine.setConfig('pages.segmented_storage', 'on');
    });
    afterEach(() => installFaultHook(undefined));

    const call = (name: string, params: Record<string, unknown>) => withEnv({ GBRAIN_HOME: home }, async () => {
      const registration = await registerLocalWriter(engine, 'cli');
      const response = await withVerifiedLocalRegistration(engine, registration, () => dispatchToolCall(engine, name, params,
        { remote: false, config: { engine: engine.kind }, sourceId: 'default', logger: { info() {}, warn() {}, error() {} } } as never));
      return JSON.parse((response.content[0] as { text: string }).text) as Record<string, unknown>;
    });
    const found = async (needle: string, slug: string) => (await engine.searchKeyword(needle)).some(hit => hit.slug === slug);
    const pageChunks = async (slug: string) => Number((await engine.executeRaw<{ n: number }>(
      "SELECT count(*)::int AS n FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id='default' AND p.slug=$1", [slug]))[0]!.n);

    test('a create within the inline-seal bound is searchable when put_page returns, with no post-commit projection', async () => {
      const slug = 'chats/inline-sealed';
      const needle = `zzsealed${kind}`;
      const content = page(2_000_000, needle);
      expect(Buffer.byteLength(content)).toBeLessThan(SEGMENTED_CREATE_SEAL_MAX_BYTES);
      let projections = 0;
      installFaultHook(point => { if (point === 'segmented:projection_staged') { projections++; throw new Error('post-commit projection blocked'); } });
      const reply = await call('put_page', { slug, content, request_id: randomUUID() });
      expect(reply.state).toBe('committed');
      expect(reply.searchable).toBe(true);
      expect(reply.projection).toBeUndefined();
      expect(await found(needle, slug)).toBe(true);
      expect(projections).toBe(0);
      expect(reply.chunks).toBe(await pageChunks(slug));
    }, 120_000);

    test('a create within the bound that dies inside its publication leaves no page and no chunk rows; its retry is searchable', async () => {
      const slug = 'chats/crashed-create';
      const needle = `zzcrashed${kind}`;
      const content = page(1_500_000, needle);
      installFaultHook(point => { if (point === 'segmented:flipped') throw new Error('publication died'); });
      await expect(importFromContent(engine, slug, content, { sourceId: 'default', noEmbed: true })).rejects.toThrow('publication died');
      installFaultHook(undefined);
      expect(await engine.executeRaw("SELECT 1 FROM pages WHERE source_id='default' AND slug=$1", [slug])).toEqual([]);
      expect(await engine.executeRaw('SELECT 1 FROM content_chunks c LEFT JOIN pages p ON p.id=c.page_id WHERE p.id IS NULL')).toEqual([]);
      expect(await found(needle, slug)).toBe(false);
      const retried = await importFromContent(engine, slug, content, { sourceId: 'default', noEmbed: true });
      expect(retried.searchable).toBe(true);
      expect(await found(needle, slug)).toBe(true);
    }, 120_000);

    test('two projections of one unsealed page in this process run one after the other: the second waits and finds it sealed (#6143)', async () => {
      const slug = 'chats/single-flight';
      installFaultHook(point => { if (point === 'segmented:projection_staged') throw new Error('post-commit build died'); });
      const imported = await importFromContent(engine, slug, page(SEGMENTED_CREATE_SEAL_MAX_BYTES + 256 * 1024, `zzflight${kind}`), { sourceId: 'default', noEmbed: true });
      installFaultHook(undefined);
      expect(imported.searchable).toBe('pending');
      let inside = 0, most = 0, staged = 0;
      installFaultHook(async point => {
        if (point !== 'segmented:projection_staged') return;
        staged++; inside++; most = Math.max(most, inside);
        await new Promise(resolve => setTimeout(resolve, 300));
        inside--;
      });
      const ref = { sourceId: 'default', slug };
      const [first, second] = await Promise.all([buildSegmentedProjection(engine, ref), buildSegmentedProjection(engine, ref)]);
      expect(first.sealed).toBe(true);
      expect(second).toEqual({ chunks: 0, retired: 0, sealed: true });
      expect({ staged, most }).toEqual({ staged: 1, most: 1 });
    }, 120_000);

    test('a larger create whose post-commit build died is built by projections drain once its claim lapses, exactly once', async () => {
      const slug = 'chats/drained';
      const needle = `zzdrained${kind}`;
      installFaultHook(point => { if (point === 'segmented:projection_staged') throw new Error('post-commit build died'); });
      const imported = await importFromContent(engine, slug, page(SEGMENTED_CREATE_SEAL_MAX_BYTES + 256 * 1024, needle), { sourceId: 'default', noEmbed: true });
      installFaultHook(undefined);
      expect(imported.searchable).toBe('pending');
      // Killed before any of its chunk rows committed.
      await engine.executeRaw("DELETE FROM content_chunks WHERE page_id=(SELECT id FROM pages WHERE source_id='default' AND slug=$1)", [slug]);
      const claim = (ageSeconds: number) => engine.executeRaw(`UPDATE page_projection_jobs SET reason=$2, updated_at=now()-make_interval(secs => $3)
        WHERE slug=$1 AND source_incarnation=(SELECT incarnation FROM sources WHERE id='default')`, [slug, SEGMENTED_PROJECTION_CLAIM, ageSeconds]);
      const reset = () => { for (const k of Object.keys(projectionDrainWork) as Array<keyof typeof projectionDrainWork>) projectionDrainWork[k] = 0; segmentChunkWork.chunks = 0; };

      const doctor = await checkProjectionReadiness(engine);
      expect(doctor.message).toContain('`gbrain projections drain` builds them as well');
      expect((doctor.details as { segmented_pending?: number }).segmented_pending).toBe(1);

      // A build another process holds (its claim is live) is left to it.
      await claim(1);
      reset();
      const skipped = await drainProjections(engine);
      expect(skipped.rebuilt).toBe(0);
      expect(projectionDrainWork.segmented_pages).toBe(0);
      expect(segmentChunkWork.chunks).toBe(0);
      expect(await found(needle, slug)).toBe(false);

      // The process died: its claim lapses and the drain builds the page.
      await claim(SEGMENTED_PROJECTION_LEASE_SECONDS + 1);
      let builds = 0;
      installFaultHook(point => { if (point === 'segmented:projection_staged') builds++; });
      reset();
      const drained = await drainProjections(engine);
      expect(drained.failed).toEqual([]);
      expect(drained.rebuilt).toBe(1);
      expect(drained.remaining).toBe(0);
      expect(builds).toBe(1);
      expect(projectionDrainWork.segmented_pages).toBe(1);
      expect(segmentChunkWork.chunks).toBe(await pageChunks(slug));
      expect(await found(needle, slug)).toBe(true);
      expect((await checkProjectionReadiness(engine)).status).toBe('ok');
    }, 180_000);

    test('a larger create says pending, and the documented wait reaches searchable; one projection chunks it', async () => {
      const slug = 'chats/projected';
      const needle = `zzpending${kind}`;
      const content = page(SEGMENTED_CREATE_SEAL_MAX_BYTES + 512 * 1024, needle);
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      let projections = 0;
      installFaultHook(async point => { if (point === 'segmented:projection_staged') { projections++; await held; } });
      segmentChunkWork.chunks = 0;
      const requestId = randomUUID();
      const reply = await call('put_page', { slug, content, request_id: requestId, wait_ms: 100 });
      expect(reply.searchable === undefined || reply.searchable === 'pending').toBe(true);

      let receipt = await call('get_write_request', { request_id: requestId });
      for (let i = 0; receipt.state !== 'committed' && i < 600; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        receipt = await call('get_write_request', { request_id: requestId });
      }
      expect(receipt.state).toBe('committed');
      expect(receipt.searchable).toBe('pending');
      expect(await found(needle, slug)).toBe(false);
      expect(receipt.searchable_retry_after_ms).toBeGreaterThanOrEqual(1_000);
      const fix = receipt.searchable_fix as { argv: string[]; next: string; mcp?: unknown };
      expect(fix.argv).toEqual(['gbrain', 'write-request', '--', requestId]);
      expect(fix.next).toBe('run');
      expect((fix as { then?: { argv: string[] } }).then?.argv).toEqual(['gbrain', 'projections', 'drain']);

      release();
      for (let i = 0; receipt.searchable === 'pending' && i < 600; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        const hit = await found(needle, slug);
        receipt = await call('get_write_request', { request_id: requestId });
        if (hit) expect(receipt.searchable).toBe(true);
      }
      expect(receipt.searchable).toBe(true);
      expect(await found(needle, slug)).toBe(true);
      expect(projections).toBe(1);
      expect(segmentChunkWork.chunks).toBe(await pageChunks(slug));
    }, 180_000);
  });
}
