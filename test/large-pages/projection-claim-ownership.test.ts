/**
 * A segmented projection that outlives its claim (switch-on blocker 2).
 *
 * 1. Protects: a builder whose claim on the page's queue row lapsed and was taken over stops at its next chunk batch
 *    with a `claimLost` result: that batch inserts nothing (the ownership check and the insert share one transaction),
 *    it does not seal (also when it lost the claim after staging its last batch) and it does not refresh the row; its
 *    error paths (the build's own release and the queue route's `rebuild_failed` mark) leave the new owner's claim as
 *    it was. The new owner's build stands: every live occurrence chunked, the page sealed once, by it.
 * 2. Fails when: the renewal refreshes the row without checking that this build still owns the claim, so the stale
 *    builder keeps staging next to the new owner and seals the page itself, a release or failure mark matches any
 *    claim on the row and clobbers the new owner's, or ownership is read from `updated_at` (ABA: two claims on one tick).
 *    The claim is a per-acquisition token, never the lease timestamp: a new claim stamped with the very `updated_at` the
 *    stale builder's claim had (a clock tick both share) is still not the stale builder's to renew, seal or release.
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set. The interleaving is forced through the
 *    `segmented:projection_batch` and `segmented:projection_staged` seams: builder 1 stalls, its claim is aged past the
 *    lease in SQL, builder 2 (another engine identity, as another process) claims and stalls, then builder 1 resumes.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { buildSegmentedProjection, rebuildPendingSegmentedProjections } from '../../src/core/page-body/projection.ts';
import { SEGMENTED_PROJECTION_CLAIM } from '../../src/core/page-state/projections.ts';
import { installFaultHook, type FaultPoint } from '../../src/core/persistence/fault-points.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { segmentedPageRow } from '../helpers/segmented-page-checks.ts';
import { testBackends } from '../helpers/test-backends.ts';

/** ~25 KB per section, each its own segment: 240 sections span two 4 MiB chunk batches, 60 fit in one. */
function sections(tag: string, n: number): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(`## Section ${tag}${i}\n\n` + `Paragraph ${i} of ${tag} about widgets and gadgets number ${i}. `.repeat(400) + '\n\n');
  return parts.join('');
}
const page = (body: string) => `---\ntitle: Claim race\ntype: note\n---\n\n${body}`;

/** Another process's view of the same database: a distinct engine identity, so its build does not queue behind builder 1's in this process. */
function otherProcess(engine: BrainEngine): BrainEngine {
  return new Proxy(engine, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { open, opened };
}

for (const kind of testBackends()) {
  describe(`projection claim ownership (${kind})`, () => {
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
    afterAll(async () => { await close?.(); });
    beforeEach(async () => { await engine.setConfig('pages.segmented_storage', 'on'); });
    afterEach(() => { installFaultHook(undefined); });

    const chunkRows = async (pageId: number) => Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM content_chunks WHERE page_id=$1', [pageId]))[0]!.n);
    const queueRow = async (slug: string) => (await engine.executeRaw<{ reason: string; updated_at: string }>(
      'SELECT reason, updated_at::text AS updated_at FROM page_projection_jobs WHERE slug=$1', [slug]))[0] ?? null;
    /** Live manifest occurrences with no chunk row. */
    const unchunked = async (pageId: number) => Number((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n
      FROM page_body_manifest m JOIN pages p ON p.id=m.page_id WHERE m.page_id=$1 AND m.staging_id IS NULL
        AND m.gen_from<=p.body_generation AND (m.gen_to IS NULL OR m.gen_to>p.body_generation)
        AND NOT EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=m.page_id AND c.occurrence_id=m.occurrence_id)`, [pageId]))[0]!.n);

    /** Import the page, count the chunk rows of its uninterrupted build, then leave it unsealed, chunkless and queued. */
    async function unprojectedPage(slug: string, n: number): Promise<{ id: number; total: number }> {
      await importFromContent(engine, slug, page(sections(slug.split('/')[1]!, n)), { sourceId: 'default', noEmbed: true });
      const { id, text_projection_revision, knowledge_revision } = await segmentedPageRow(engine, slug);
      expect(text_projection_revision).toBe(knowledge_revision);
      const total = await chunkRows(id);
      expect(total).toBeGreaterThan(0);
      await engine.executeRaw('DELETE FROM content_chunks WHERE page_id=$1', [id]);
      await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE id=$1', [id]);
      await engine.executeRaw(`INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason)
        SELECT s.incarnation,p.slug,p.knowledge_revision,'canonical_change' FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.id=$1
        ON CONFLICT (source_incarnation,slug) DO UPDATE SET revision=EXCLUDED.revision,reason=EXCLUDED.reason,updated_at=now()`, [id]);
      return { id, total };
    }

    /**
     * Builder 1 runs `first` and stalls at its `stallAt`-th reach of `point`; its claim is aged past the lease; builder 2
     * claims and stalls at its first reach of `point`. Returns once both are stalled, with the row builder 2 claimed.
     * `onResume` runs in builder 1's seam as it resumes (a throw there fails builder 1).
     */
    async function takeOver<T>(slug: string, stallAt: number, first: (builder: BrainEngine) => Promise<T>,
      opts: { point?: FaultPoint; onResume?: () => void; collide?: boolean } = {}) {
      const point = opts.point ?? 'segmented:projection_batch';
      const b1Stalled = gate(), b1Release = gate(), b2Stalled = gate(), b2Release = gate();
      let reached = 0;
      installFaultHook(async (at, detail) => {
        if (at !== point || detail.slug !== slug) return;
        const nth = ++reached;
        if (nth === stallAt) { b1Stalled.open(); await b1Release.opened; opts.onResume?.(); }
        if (nth === stallAt + 1) { b2Stalled.open(); await b2Release.opened; }
      });
      const b1 = first(otherProcess(engine));
      await b1Stalled.opened;
      const held = await queueRow(slug);
      expect(held?.reason.startsWith(SEGMENTED_PROJECTION_CLAIM)).toBe(true);
      await engine.executeRaw(`UPDATE page_projection_jobs SET updated_at=updated_at-interval '120 seconds' WHERE slug=$1`, [slug]);
      const b2 = buildSegmentedProjection(otherProcess(engine), { sourceId: 'default', slug });
      await b2Stalled.opened;
      if (opts.collide) await engine.executeRaw('UPDATE page_projection_jobs SET updated_at=$2::text::timestamptz WHERE slug=$1', [slug, held!.updated_at]);
      const claimed = await queueRow(slug);
      expect(claimed?.reason.startsWith(SEGMENTED_PROJECTION_CLAIM)).toBe(true);
      if (opts.collide) expect(claimed?.updated_at).toBe(held!.updated_at);
      return { claimed: claimed!, resumeB1: () => { b1Release.open(); return b1; }, resumeB2: () => { b2Release.open(); return b2; } };
    }

    test('a builder whose claim was taken over between chunk batches stops, stages nothing more and does not seal', async () => {
      const slug = 'notes/claim-batches';
      const { id, total } = await unprojectedPage(slug, 240);
      const race = await takeOver(slug, 2, builder => buildSegmentedProjection(builder, { sourceId: 'default', slug }));
      const stagedByB1 = await chunkRows(id);
      expect(stagedByB1).toBeGreaterThan(0);
      expect(stagedByB1).toBeLessThan(total);

      const first = await race.resumeB1();
      expect(first).toMatchObject({ sealed: false, claimLost: true, chunks: stagedByB1 });
      expect(await chunkRows(id)).toBe(stagedByB1);
      expect((await segmentedPageRow(engine, slug)).text_projection_revision).toBeNull();
      expect(await queueRow(slug)).toEqual(race.claimed);

      const second = await race.resumeB2();
      expect(second).toEqual({ chunks: total - stagedByB1, retired: 0, sealed: true });
      const sealed = await segmentedPageRow(engine, slug);
      expect(sealed.text_projection_revision).toBe(sealed.knowledge_revision);
      expect(await chunkRows(id)).toBe(total);
      expect(await unchunked(id)).toBe(0);
      expect(await queueRow(slug)).toBeNull();
    }, 300_000);

    test('a builder whose claim was taken over after it staged every chunk does not seal', async () => {
      const slug = 'notes/claim-seal';
      const { id, total } = await unprojectedPage(slug, 60);
      const race = await takeOver(slug, 1, builder => buildSegmentedProjection(builder, { sourceId: 'default', slug }), { point: 'segmented:projection_staged' });
      expect(await chunkRows(id)).toBe(total);

      expect(await race.resumeB1()).toEqual({ chunks: total, retired: 0, sealed: false, claimLost: true });
      expect((await segmentedPageRow(engine, slug)).text_projection_revision).toBeNull();
      expect(await queueRow(slug)).toEqual(race.claimed);

      expect(await race.resumeB2()).toEqual({ chunks: 0, retired: 0, sealed: true });
      const sealed = await segmentedPageRow(engine, slug);
      expect(sealed.text_projection_revision).toBe(sealed.knowledge_revision);
      expect(await chunkRows(id)).toBe(total);
      expect(await queueRow(slug)).toBeNull();
    }, 300_000);

    test('a builder that fails after its claim was taken over leaves the new owner\'s claim in place (build and queue route)', async () => {
      for (const route of ['build', 'queue'] as const) {
        const slug = `notes/claim-failure-${route}`;
        const { id, total } = await unprojectedPage(slug, 60);
        const race = await takeOver(slug, 1, builder => route === 'build'
          ? buildSegmentedProjection(builder, { sourceId: 'default', slug }).then(() => 'built', (error: Error) => error.message)
          : rebuildPendingSegmentedProjections(builder, 1, { reasons: ['canonical_change'] }).then(result => `failed:${result.failed}`),
        { onResume: () => { throw new Error('builder 1 died after losing its claim (probe)'); } });
        expect(await race.resumeB1()).toBe(route === 'build' ? 'builder 1 died after losing its claim (probe)' : 'failed:1');
        expect(await queueRow(slug)).toEqual(race.claimed);
        expect(await chunkRows(id)).toBe(0);

        expect(await race.resumeB2()).toEqual({ chunks: total, retired: 0, sealed: true });
        expect(await chunkRows(id)).toBe(total);
        expect(await queueRow(slug)).toBeNull();
      }
    }, 300_000);

    test('a new claim stamped with the stale builder\'s exact updated_at is not the stale builder\'s to renew, seal or release', async () => {
      for (const mode of ['renew', 'seal', 'release'] as const) {
        const slug = `notes/claim-same-tick-${mode}`;
        const { id, total } = await unprojectedPage(slug, 60);
        const race = await takeOver(slug, 1, builder => buildSegmentedProjection(builder, { sourceId: 'default', slug })
          .then(result => result, (error: Error) => error.message), {
          collide: true,
          point: mode === 'seal' ? 'segmented:projection_staged' : 'segmented:projection_batch',
          onResume: mode === 'release' ? () => { throw new Error('builder 1 died after losing its claim (probe)'); } : undefined,
        });
        const first = await race.resumeB1();
        if (mode === 'release') expect(first).toBe('builder 1 died after losing its claim (probe)');
        else expect(first).toEqual({ chunks: mode === 'seal' ? total : 0, retired: 0, sealed: false, claimLost: true });
        expect(await queueRow(slug)).toEqual(race.claimed);
        expect(await chunkRows(id)).toBe(mode === 'seal' ? total : 0);
        expect((await segmentedPageRow(engine, slug)).text_projection_revision).toBeNull();

        expect(await race.resumeB2()).toEqual({ chunks: mode === 'seal' ? 0 : total, retired: 0, sealed: true });
        const sealed = await segmentedPageRow(engine, slug);
        expect(sealed.text_projection_revision).toBe(sealed.knowledge_revision);
        expect(await chunkRows(id)).toBe(total);
        expect(await queueRow(slug)).toBeNull();
      }
    }, 300_000);
  });
}
