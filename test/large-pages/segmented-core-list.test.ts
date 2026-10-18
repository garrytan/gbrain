/**
 * Wave B PR 2 fix lane P (decision #1): core memory lists a core page stored in segments.
 *
 * 1. Protects: listCorePages reads a core page (`always_load: true`) stored in segments just over 1 MiB back whole, as
 *    it reads its inline twin: the same compiled truth, rendered text, chars and priority, before a fact is withdrawn
 *    from it and after (the withdrawal overlay applies as on the inline page), so core usage, the session block and the
 *    write-path budget see the page as they see the inline one. A withdrawn core page over 24 MiB is left out of the
 *    list without reading a segment, the list, core usage and the session block still answer, doctor core_memory counts
 *    it (`skipped_segmented: 1`; the page within 24 MiB is not counted), and nothing stored changes.
 * 2. Fails when: a segmented core page lists as its title alone (its NULL compiled_truth column), a withdrawn one
 *    throws page_body_segmented out of listCorePages (session-start core, context_pack, gbrain core status and the core
 *    budget check then fail for every page), or a page over 24 MiB is read whole.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt). Cost assertions are segment read
 *    counts, never time.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromFile } from '../../src/core/import-file.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { coreUsage, listCorePages, loadCoreBlock } from '../../src/core/core-memory.ts';
import { coreMemoryCheck } from '../../src/commands/doctor/checks/core-memory.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

/** Twin slugs have equal lengths, so rendered text compares equal once the slug is replaced. */
const INLINE = 'notes/ina-core';
const SEGMENTED = 'notes/sei-core';
const HUGE = 'notes/hugo-core';
const HUGE_SOURCE = 'huge-core';

const fence = `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Withdrawn world claim | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |
| 2 | Kept world claim | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |
<!--- gbrain:facts:end -->`;
const line = (i: number) => '- ' + String(i).padStart(8, '0') + ' acme-example journal line with enough text to fill a segment quickly\n';
const body = (bytes: number) => Array.from({ length: Math.ceil(bytes / line(0).length) }, (_, i) => line(i)).join('');
/** A core page; the one over 24 MiB carries no facts fence (importing a fence needs the whole body as one string). */
const corePage = (bytes: number, withFence: boolean) => '---\ntype: note\ntitle: Core Twin\nalways_load: true\n---\n\n# Core Twin\n\n'
  + (withFence ? '## Facts\n\n' + fence + '\n\n' : '') + body(bytes);

const home = mkdtempSync(join(tmpdir(), 'gbrain-segmented-core-list-'));
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };

for (const kind of testBackends()) {
  describe(kind + ': core memory lists a core page stored in segments', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    const imported = async (sourceId: string, slug: string, bytes: number, segmented: boolean) => {
      await engine.setConfig('pages.segmented_storage', segmented ? 'on' : 'off');
      const root = join(home, kind, sourceId);
      mkdirSync(join(root, 'notes'), { recursive: true });
      writeFileSync(join(root, slug + '.md'), corePage(bytes, bytes <= PAGE_MAX_BYTES));
      expect(await importFromFile(engine, join(root, slug + '.md'), slug + '.md', { sourceId, noEmbed: true, bodyPolicy: await readPageBodyPolicy(engine) }))
        .toMatchObject({ status: 'imported' });
    };
    const withdraw = (sourceId: string, slug: string) => engine.executeRaw(
      "INSERT INTO fact_withdrawals(source_id, visibility, subject, fact_hash) VALUES ($1, 'world', $2, gbrain_fact_fingerprint('Withdrawn world claim'))", [sourceId, slug]);
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    /** Everything listCorePages gives a page (the texts as their head and digest), with the slug made neutral so twins compare equal. */
    const listed = async () => Object.fromEntries((await listCorePages(engine, { sourceIds: ['default'] })).map(p => {
      const rendered = p.rendered.split(p.slug).join('<slug>');
      return [p.slug, { title: p.title, priority: p.priority, chars: p.chars, truth: sha(p.compiled_truth), rendered: sha(rendered), head: rendered.slice(0, 1200) }];
    }));

    beforeAll(async () => withEnv(env, async () => {
      if (kind === 'postgres') { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engine = pg.engine; close = pg.close; }
      else { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite; close = () => lite.disconnect(); }
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{}')", [HUGE_SOURCE]);
      await imported('default', INLINE, 1_100_000, false);
      await imported('default', SEGMENTED, 1_100_000, true);
      await imported(HUGE_SOURCE, HUGE, PAGE_MAX_BYTES + 512 * 1024, true);
      await engine.setConfig('memory.core.enabled', 'true');
      const storage = await engine.executeRaw<{ slug: string; body_storage: string; body_bytes: string | null }>(
        'SELECT slug, body_storage, body_bytes::text AS body_bytes FROM pages ORDER BY slug');
      expect(Object.fromEntries(storage.map(r => [r.slug, r.body_storage]))).toEqual({ [HUGE]: 'segmented', [INLINE]: 'inline', [SEGMENTED]: 'segmented' });
      expect(Number(storage.find(r => r.slug === HUGE)!.body_bytes)).toBeGreaterThan(PAGE_MAX_BYTES);
    }), 600_000);

    afterAll(async () => { await close(); }, 120_000);

    test('a segmented core page just over 1 MiB lists as its inline twin, before and after a fact is withdrawn from both', async () => withEnv(env, async () => {
      const before = await listed();
      expect(before[SEGMENTED]!.head).toContain('| 1 | Withdrawn world claim |');
      expect(before[SEGMENTED]!.chars).toBeGreaterThan(1_100_000);
      expect(before[SEGMENTED]).toEqual(before[INLINE]!);
      await withdraw('default', INLINE);
      await withdraw('default', SEGMENTED);
      const after = await listed();
      expect(after[SEGMENTED]!.head).not.toContain('Withdrawn world claim');
      expect(after[SEGMENTED]!.head).toContain('| 2 | Kept world claim |');
      expect(after[SEGMENTED]!.truth).not.toBe(before[SEGMENTED]!.truth);
      expect(after[SEGMENTED]).toEqual(after[INLINE]!);
      const block = await loadCoreBlock(engine, { sessionSourceId: 'default', excludePrivate: true });
      expect(block.omitted.map(o => [o.slug, o.reason]).sort()).toEqual([[INLINE, 'budget'], [SEGMENTED, 'budget']]);
    }), 600_000);

    test('a withdrawn core page over 24 MiB is left out without a segment read; the list answers, doctor counts it and nothing changes', async () => withEnv(env, async () => {
      const state = () => engine.executeRaw<Record<string, string>>(`SELECT p.slug, p.title, p.body_generation::text AS generation, p.body_bytes::text AS bytes, p.content_hash,
          p.knowledge_revision::text AS revision, p.frontmatter::text AS frontmatter,
          (SELECT count(*) FROM page_body_manifest m WHERE m.page_id=p.id)::text AS manifest,
          (SELECT count(*) FROM page_segment_texts t WHERE t.source_id=p.source_id)::text AS texts,
          (SELECT count(*) FROM page_versions v WHERE v.page_id=p.id)::text AS versions,
          (SELECT count(*) FROM content_chunks c WHERE c.page_id=p.id)::text AS chunks
        FROM pages p ORDER BY p.source_id, p.slug`);
      await withdraw(HUGE_SOURCE, HUGE);
      const before = await state();
      const [huge] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [HUGE_SOURCE, HUGE]);
      const reads = { manifest: 0, texts: 0 };
      const e = engine as unknown as Record<string, (...args: any[]) => Promise<unknown>>;
      const originals = { manifest: e.readManifest!, texts: e.readSegmentTexts! };
      e.readManifest = function (this: unknown, ...args: any[]) { if (Number(args[0]) === Number(huge!.id)) reads.manifest++; return originals.manifest.apply(this, args); };
      e.readSegmentTexts = function (this: unknown, ...args: any[]) { if (args[0] === HUGE_SOURCE) reads.texts++; return originals.texts.apply(this, args); };
      try {
        expect((await listCorePages(engine)).map(p => p.slug).sort()).toEqual([INLINE, SEGMENTED]);
        expect((await coreUsage(engine)).pages.map(p => p.slug).sort()).toEqual([INLINE, SEGMENTED]);
        const block = await loadCoreBlock(engine, { sessionSourceId: HUGE_SOURCE, excludePrivate: true });
        expect(block.omitted.map(o => o.slug).sort()).toEqual([INLINE, SEGMENTED]);
        const check = await coreMemoryCheck(engine);
        expect(check.skipped_segmented).toBe(1);
        expect(check.message).toContain('skipped (segmented): 1 page(s) store their body in segments');
      } finally { e.readManifest = originals.manifest; e.readSegmentTexts = originals.texts; }
      expect(reads).toEqual({ manifest: 0, texts: 0 });
      expect(await state()).toEqual(before);
    }), 600_000);
  });
}

afterAll(() => rmSync(home, { recursive: true, force: true }));
