/** #6826: real renames retain unfenced extraction provenance, without alias-based subject guesses. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runFactsRelink } from '../src/core/facts/relink.ts';
import { inferFactSubject, recordedPageSlug } from '../src/core/facts/subject-infer.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { persistencePostgresTemplate } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const OLD = 'people/old-example';
const NEW = 'people/new-example';
const config = { engine: 'pglite', embedding_disabled: true } as GBrainConfig;

for (const backend of testBackends()) {
  describe(`fact rename provenance (${backend})`, () => {
    let engine: BrainEngine;
    let pglite: PGLiteEngine | undefined;
    let template: Awaited<ReturnType<typeof persistencePostgresTemplate>> | undefined;
    let close: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      if (backend === 'postgres') template = await persistencePostgresTemplate(requirePostgresTestDatabase());
      else { pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); }
    }, 120_000);
    afterAll(async () => { await template?.dispose(); await pglite?.disconnect(); });
    beforeEach(async () => {
      if (pglite) { engine = pglite; await resetPgliteState(pglite); }
      else { const clone = await template!.clone(); engine = clone.engine; close = clone.close; }
      await engine.setConfig('decide.slots.conflict.mode', 'off');
      await page(OLD);
    }, 120_000);
    afterEach(async () => { await disposePersistenceConsumer(engine); await close?.(); close = undefined; });

    async function page(slug: string, sourceId = 'default') {
      await importFromContent(engine, slug, '---\ntitle: Example Person\ntype: person\n---\n\nAn example person.\n', { sourceId, noEmbed: true });
    }
    async function fact(context = OLD, source = 'mcp:put_page', sourceId = 'default', text = 'prefers early appointments') {
      return (await engine.insertFact({ fact: text, kind: 'fact', entity_slug: null, visibility: 'world', source, context }, { source_id: sourceId })).id;
    }
    async function row(id: number) {
      return (await engine.executeRaw<{ context: string; entity_slug: string | null; source_markdown_slug: string | null; row_num: number | null }>(
        'SELECT context, entity_slug, source_markdown_slug, row_num FROM facts WHERE id=$1', [id]))[0]!;
    }
    const relink = (dryRun = false) => runFactsRelink(engine, { sourceId: 'default', config, llm: false, conflictQueue: false, dryRun });

    test('rename, dry run and publication retain fact identity and notes across chained moves', async () => {
      const id = await fact(`${OLD} — original note — retained note`);
      const original = (await engine.getPage(OLD, { sourceId: 'default' }))!.id;
      expect(await engine.updateSlug(OLD, NEW, { sourceId: 'default' })).toBe(1);
      expect((await engine.getPage(NEW, { sourceId: 'default' }))!.id).toBe(original);
      expect((await row(id)).context).toBe(`${NEW} — original note — retained note`);
      const final = 'people/final-example';
      await engine.updateSlug(NEW, final, { sourceId: 'default' });
      expect((await row(id)).context).toBe(`${final} — original note — retained note`);
      expect((await relink(true)).linked_by_tier.page).toBe(1);
      expect((await row(id)).entity_slug).toBeNull();
      expect((await relink()).linked_by_tier.page).toBe(1);
      const stored = await row(id);
      expect(stored.entity_slug).toBe(final);
      expect(stored.source_markdown_slug).toBe(final);
      const target = (await engine.getPage(final, { sourceId: 'default' }))!;
      expect(parseFactsFence(target.compiled_truth).facts.find(f => f.rowNum === Number(stored.row_num))?.claim).toBe('prefers early appointments');
      expect((await relink()).linked).toBe(0);
      expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM facts WHERE id=$1', [id]))[0]!.n).toBe(1);
    }, 120_000);

    test('only the trusted extraction source and exact context head move; free prose and other sources do not', async () => {
      await engine.executeRaw("INSERT INTO sources(id, name) VALUES ('other', 'Other')");
      await page(OLD, 'other');
      const accepted = await Promise.all(['mcp:put_page', 'sync:import', 'file_upload', 'code_import'].map(s => fact(OLD, s)));
      const controls = await Promise.all([
        fact(OLD, 'chat'), fact(`${OLD}-suffix`), fact(`note about ${OLD}`), fact(OLD, 'mcp:put_page', 'other'),
      ]);
      const before = await Promise.all(controls.map(row));
      await engine.updateSlug(OLD, NEW, { sourceId: 'default' });
      for (const id of accepted) expect((await row(id)).context).toBe(NEW);
      expect(await Promise.all(controls.map(row))).toEqual(before);
    }, 120_000);

    test('fenced and retired rows retain their canonical context; missing-page renames change nothing', async () => {
      const fenced = await fact();
      const retired = await fact();
      const missing = await fact('people/missing-example');
      await engine.executeRaw('UPDATE facts SET source_markdown_slug=$1, row_num=1 WHERE id=$2', [OLD, fenced]);
      await engine.executeRaw('UPDATE facts SET expired_at=now() WHERE id=$1', [retired]);
      await engine.updateSlug(OLD, NEW, { sourceId: 'default' });
      expect((await row(fenced)).context).toBe(OLD);
      expect((await row(fenced)).source_markdown_slug).toBe(NEW);
      expect((await row(retired)).context).toBe(OLD);
      expect(await engine.updateSlug('people/missing-example', 'people/no-example', { sourceId: 'default' })).toBe(0);
      expect((await row(missing)).context).toBe('people/missing-example');
    }, 120_000);

    test('a failed rename rolls back provenance together with the page and alias', async () => {
      const id = await fact();
      await expect(engine.transaction(async tx => {
        await tx.updateSlug(OLD, NEW, { sourceId: 'default' });
        throw new Error('rollback rename');
      })).rejects.toThrow('rollback rename');
      expect((await row(id)).context).toBe(OLD);
      expect(await engine.getPage(NEW, { sourceId: 'default' })).toBeNull();
      expect(await engine.executeRaw('SELECT 1 FROM slug_aliases WHERE source_id=$1 AND alias_slug=$2', ['default', OLD])).toEqual([]);
    }, 120_000);

    test('provenance follows the renamed page, not a different page reusing its old slug', async () => {
      const id = await fact();
      await engine.updateSlug(OLD, NEW, { sourceId: 'default' });
      await page(OLD);
      expect((await relink()).linked_by_tier.page).toBe(1);
      expect((await row(id)).entity_slug).toBe(NEW);
    }, 120_000);

    test('renamed provenance still honors private/deleted pages and competing subjects', async () => {
      const id = await fact();
      await engine.updateSlug(OLD, NEW, { sourceId: 'default' });
      const context = recordedPageSlug((await row(id)).context, 'mcp:put_page');
      expect(context).toBe(NEW);
      await engine.executeRaw("UPDATE pages SET frontmatter=frontmatter || '{\"visibility\":\"private\"}'::jsonb WHERE source_id='default' AND slug=$1", [NEW]);
      expect((await inferFactSubject(engine, 'default', { fact: 'prefers early appointments', pageSlug: context, mode: 'relink', excludePrivate: true })).slug).toBeNull();
      await page('people/alice-example');
      expect((await inferFactSubject(engine, 'default', { fact: 'people/alice-example prefers early appointments', pageSlug: context, mode: 'relink' })).slug).toBeNull();
      await engine.deletePage(NEW, { sourceId: 'default' });
      expect((await relink(true)).linked).toBe(0);
    }, 120_000);
  });
}
