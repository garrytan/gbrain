/**
 * Wave B PR 2 fix lane P (decision #1): `gbrain repair frontmatter` re-imports a page stored in segments.
 *
 * 1. Protects: a page whose stored title was derived from its slug while its file names one is re-imported by
 *    `--include-ambiguous` when the page is stored in segments just over 1 MiB, with the inline twin's result: the
 *    same preview (diff, class, listing, residuals) and apply outcome, then the same page (title, body bytes,
 *    frontmatter, tags, content_hash, canonical file). A page over 24 MiB is listed needs_review with
 *    page_body_segmented, naming the 24 MiB limit; the rest of the preview still proposes its repairs, and the page,
 *    its segments, versions and file are unchanged.
 * 2. Fails when: the re-import check reads the segmented page's body getters, so page_body_segmented fails the whole
 *    preview (every file of the source), or the segmented re-import differs from the inline one, or a page over 24 MiB
 *    is read whole or written.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt). Cost assertions are row counts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { withVerifiedLocalRegistration } from '../../src/core/persistence/identity.ts';
import { resolveRepairScope, type RepairResult } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { openTwinBrain, twinPage, type TwinBrain } from '../helpers/segmented-twins.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const INLINE = 'people/ina-example';
/** Twin slugs have equal lengths, so outputs that print the slug compare equal once it is replaced. */
const SEGMENTED = 'people/sei-example';
const HUGE = 'people/hugo-example';
const quiet = { info() {}, warn() {}, error() {} };

for (const kind of testBackends()) {
  describe(kind + ': repair frontmatter re-imports a page stored in segments', () => {
    let brain: TwinBrain;

    /** The title parseMarkdown derives from the slug, which an older import stored although the file names one. */
    const damageTitle = async (slug: string) => {
      const derived = slug.split('/').pop()!.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      await brain.engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await brain.engine.executeRaw('UPDATE pages SET title=$3 WHERE source_id=$1 AND slug=$2', [brain.sourceId, slug, derived]);
      await brain.engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    };
    const run = (opts: { only?: string[]; apply?: boolean; expect?: string }) => withEnv(brain.env(), () => withVerifiedLocalRegistration(brain.engine, brain.cli, async () => {
      const runner = await repairRunner(brain.engine, { apply: opts.apply === true, noEmbed: true, logger: quiet });
      return runner.run('frontmatter', await resolveRepairScope(brain.engine, brain.sourceId),
        { explicit: true, sourceFlag: brain.sourceId, includeAmbiguous: true, only: opts.only, expect: opts.expect });
    }));
    const hashOf = (result: RepairResult) => result.apply_command.split('--expect ')[1]!.split(' ')[0]!;
    const title = async (slug: string) => (await brain.engine.executeRaw<{ title: string }>('SELECT title FROM pages WHERE source_id=$1 AND slug=$2', [brain.sourceId, slug]))[0]!.title;

    beforeAll(async () => {
      brain = await openTwinBrain(kind, [INLINE], async seed => {
        await seed.setSwitch(false);
        await seed.imported(INLINE, 1_100_000);
        await seed.setSwitch(true);
        await seed.imported(SEGMENTED, 1_100_000);
        await seed.imported(HUGE, PAGE_MAX_BYTES + 512 * 1024);
      });
      const storage = await brain.engine.executeRaw<{ slug: string; body_storage: string; body_bytes: string | null }>(
        'SELECT slug, body_storage, body_bytes::text AS body_bytes FROM pages WHERE source_id=$1 ORDER BY slug', [brain.sourceId]);
      expect(Object.fromEntries(storage.map(r => [r.slug, r.body_storage]))).toEqual({ [HUGE]: 'segmented', [INLINE]: 'inline', [SEGMENTED]: 'segmented' });
      expect(Number(storage.find(r => r.slug === HUGE)!.body_bytes)).toBeGreaterThan(PAGE_MAX_BYTES);
      for (const slug of [INLINE, SEGMENTED, HUGE]) await damageTitle(slug);
      // The page over 24 MiB keeps its body; its file was edited down to one within the limit that names the title.
      writeFileSync(join(brain.root, HUGE + '.md'), twinPage(1_100_000));
    }, 600_000);

    afterAll(() => brain.close(), 120_000);

    test('over 24 MiB: the page is listed needs_review naming the limit, the other files are still proposed, and nothing changes', async () => {
      const state = () => brain.engine.executeRaw<Record<string, string>>(`SELECT p.title, p.body_generation::text AS generation, p.body_bytes::text AS bytes,
          p.content_hash, p.knowledge_revision::text AS revision,
          (SELECT string_agg(m.occurrence_id::text || ':' || encode(m.sha256, 'hex'), ',' ORDER BY m.seq) FROM page_body_manifest m WHERE m.page_id=p.id AND m.gen_to IS NULL AND m.staging_id IS NULL) AS live,
          (SELECT count(*) FROM page_versions v WHERE v.page_id=p.id)::text AS versions,
          (SELECT count(*) FROM content_chunks c WHERE c.page_id=p.id)::text AS chunks
        FROM pages p WHERE p.source_id=$1 AND p.slug=$2`, [brain.sourceId, HUGE]);
      const file = () => createHash('sha256').update(readFileSync(join(brain.root, HUGE + '.md'))).digest('hex');
      const before = { page: await state(), file: file() };
      await brain.setSwitch(true);
      const preview = await run({});
      const listing = Object.fromEntries((preview.listing ?? []).map(entry => [entry.item, entry.class]));
      expect(listing).toEqual({ [brain.sourceId + ':' + INLINE + '.md']: 'interpretive', [brain.sourceId + ':' + SEGMENTED + '.md']: 'interpretive',
        [brain.sourceId + ':' + HUGE + '.md']: 'needs_review' });
      const review = (preview.details as { needs_review: Array<{ path: string; code: string; resolution: string }> }).needs_review;
      expect(review).toEqual([expect.objectContaining({ path: HUGE + '.md', code: 'page_body_segmented' })]);
      expect(review[0]!.resolution).toContain('over the 24 MiB (' + PAGE_MAX_BYTES + '-byte) limit');
      expect(review[0]!.resolution).toContain('Nothing was read or changed.');
      expect(preview.residuals['needs_review:page_body_segmented']).toBe(1);
      expect(preview.affected).toBe(2);
      // A preview of that file alone approves nothing to apply.
      const applied = await run({ only: [HUGE + '.md'] });
      expect(applied.affected).toBe(0);
      expect({ page: await state(), file: file() }).toEqual(before);
      expect(before.page[0]!.title).toBe('Hugo Example');
    }, 600_000);

    test('just over 1 MiB: the segmented re-import previews, applies and stores what the inline twin does', async () => {
      /** The preview hash binds the page's id and revision, which twins never share. */
      const neutral = (slug: string, hash: string, value: unknown) => JSON.parse(JSON.stringify(value).split(slug).join('<slug>').split(hash).join('<hash>'));
      const once = async (slug: string) => {
        await brain.setSwitch(slug !== INLINE);
        const preview = await run({ only: [slug + '.md'] });
        const applied = await run({ only: [slug + '.md'], apply: true, expect: hashOf(preview) });
        return neutral(slug, hashOf(preview), {
          preview: { affected: preview.affected, residuals: preview.residuals, listing: preview.listing, details: preview.details },
          applied: { applied: applied.applied, failed: applied.failed, outcomes: applied.outcomes,
            outcome_items: applied.outcome_items?.map(({ detail, ...rest }) => ({ ...rest, detail: { ...detail, committed: undefined } })) },
        });
      };
      const inline = await once(INLINE);
      const segmented = await once(SEGMENTED);
      expect(inline.preview.affected).toBe(1);
      expect(inline.applied.applied).toBe(1);
      expect(segmented).toEqual(inline);
      expect([await title(INLINE), await title(SEGMENTED)]).toEqual(['Twin Example', 'Twin Example']);
      expect(await brain.view(SEGMENTED)).toEqual(await brain.view(INLINE));
      expect([await brain.storageOf(INLINE), await brain.storageOf(SEGMENTED)]).toEqual(['inline', 'segmented']);
      const sealed = await brain.engine.executeRaw<{ slug: string; sealed: boolean }>(
        'SELECT slug, text_projection_revision = knowledge_revision AS sealed FROM pages WHERE source_id=$1 AND slug = ANY($2::text[]) ORDER BY slug', [brain.sourceId, [INLINE, SEGMENTED]]);
      expect(sealed.map(r => [r.slug, r.sealed])).toEqual([[INLINE, true], [SEGMENTED, true]]);
    }, 600_000);
  });
}
