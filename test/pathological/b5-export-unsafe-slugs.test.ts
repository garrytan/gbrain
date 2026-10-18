/**
 * B-5 (GBRA-130): a slug put_page or an entity stub accepted never wedges
 * `gbrain export`, and new identities that cannot be file names are refused
 * at admission.
 *
 * Protects (export): pages an older gbrain stored under slugs no portable file
 * name can hold (`ns:foo`, `meetings/2026-01-01:standup`, `companies/aux`,
 * `people/con`, `people/nul.x`, an 81-CJK-character segment) export under
 * escaped names with a `slug:` stamp instead of aborting the whole export;
 * import restores each exact slug from its escaped file (the over-long one is
 * reported as shortened, with the move as its fix); path collisions are all
 * collected and refused once, each with its typed code and fix, and the
 * per-source exports that fix names publish. A run-scoped failure still
 * aborts the export with nothing published.
 * Protects (write side): put_page, its dry run and put_pages refuse a NEW
 * identity whose segment is a Windows reserved name (invalid_params, detail
 * slug_not_portable, with a portable slug), also when another source holds
 * the same slug; colon slugs stay writable; an existing page keeps accepting
 * put_page and edit_page with an advisory; a replayed request returns its
 * receipt; slugifyEntity suffixes reserved names.
 * Fails when: export.ts calls exportPathKey on the raw slug (one unsafe page
 * throws inside the snapshot transaction: "Nothing was published"), stops at
 * the first collision, or admission ignores reserved names.
 * Seams: none; the run cases patch the engine instance. PGLite always,
 * Postgres when DATABASE_URL is set.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runExport } from '../../src/commands/export.ts';
import { importFromFile } from '../../src/core/import-file.ts';
import { parseMarkdown, serializePageToMarkdown } from '../../src/core/markdown.ts';
import { slugifyEntity } from '../../src/core/enrichment-service.ts';
import { operations, OperationError, type OperationContext } from '../../src/core/operations.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, managedBrain, pathologicalArms, runScopedErrors, snapshotItems } from './harness.ts';

const op = (name: string) => operations.find(o => o.name === name)!;
const CJK81 = 'notes/' + '漢'.repeat(81);
const UNSAFE = ['ns:foo', 'meetings/2026-01-01:standup', 'companies/aux', 'people/con', 'people/nul.x', CJK81];
const ESCAPED: Record<string, string> = {
  'ns:foo': 'ns~foo.md', 'meetings/2026-01-01:standup': 'meetings/2026-01-01~standup.md', 'companies/aux': 'companies/aux~.md',
  'people/con': 'people/con~.md', 'people/nul.x': 'people/nul~.x.md',
};
const body = (title: string) => `---\ntitle: ${title}\ntype: note\n---\n# ${title}\n\nBody of ${title}.\n`;

async function refusal(run: unknown): Promise<OperationError> {
  try { await run; } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a refusal');
}

function walk(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? walk(join(dir, entry.name), prefix + entry.name + '/') : [prefix + entry.name]).sort();
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`B-5 export of unportable slugs (${backend})`, () => {
    let engine: BrainEngine;
    let target: BrainEngine;
    const closers: Array<() => Promise<void>> = [];
    let dir: string;
    let messages: string[];
    let restore: () => void;

    beforeAll(async () => {
      for (const assign of [(e: BrainEngine) => { engine = e; }, (e: BrainEngine) => { target = e; }]) {
        if (databaseUrl) { const isolated = await isolatedPersistencePostgres(databaseUrl); assign(isolated.engine); closers.push(isolated.close); }
        else { const e = new PGLiteEngine(); await e.connect({}); await e.initSchema(); assign(e); closers.push(() => e.disconnect()); }
      }
      await engine.executeRaw("INSERT INTO sources (id,name) VALUES ('other','Other') ON CONFLICT DO NOTHING");
    }, 180_000);
    afterAll(async () => { for (const close of closers) await close(); });
    beforeEach(async () => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), 'b5-export-')));
      await engine.executeRaw('DELETE FROM pages');
      await target.executeRaw('DELETE FROM pages');
      messages = [];
      const [exit, log, error] = [process.exit, console.log, console.error];
      process.exit = ((code: number) => { throw new Error(`EXIT:${code}`); }) as never;
      console.log = console.error = (...args: unknown[]) => { messages.push(args.join(' ')); };
      restore = () => { process.exit = exit; console.log = log; console.error = error; };
    });
    afterEach(() => { restore(); rmSync(dir, { recursive: true, force: true }); });

    async function page(slug: string, sourceId = 'default') {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `body of ${slug}`, timeline: '' }, { sourceId });
      await engine.putRawData(slug, 'feed', { owner: slug }, { sourceId });
    }

    test('B-5 item: unportable slugs export under escaped names with a slug stamp and import restores each slug', async () => {
      for (const slug of [...UNSAFE, 'notes/healthy']) await page(slug);
      const before = await snapshotItems(engine, 'default');
      const report = await expectUnitNotAborted(() => runExport(engine, ['--dir', join(dir, 'out')]));
      const out = join(dir, 'out');
      expect(readFileSync(join(out, '.gbrain-export-status'), 'utf8')).toBe('GBRAIN EXPORT INCOMPLETE\nCOMPLETE\n');
      expect(report!.pages).toBe(UNSAFE.length + 1);
      const files = walk(out);
      for (const [slug, path] of Object.entries(ESCAPED)) {
        expect({ slug, file: files.includes(path) }).toEqual({ slug, file: true });
        expect(parseMarkdown(readFileSync(join(out, path), 'utf8'), path).frontmatter.slug ?? parseMarkdown(readFileSync(join(out, path), 'utf8'), path).slug).toBe(slug);
        const imported = await importFromFile(target, join(out, path), path, { sourceId: 'default', noEmbed: true });
        expect({ slug, imported: imported.slug, error: imported.error }).toEqual({ slug, imported: slug, error: undefined });
      }
      expect(files).toContain('companies/.raw/aux~.json');
      expect(files).toContain('notes/healthy.md');
      const long = report!.escaped.find(e => e.slug === CJK81)!;
      expect(long).toMatchObject({ source_id: 'default', restorable: false });
      expect(files).toContain(long.path);
      expectItemFailure({ key: long.slug, code: long.reason, fix: long.fix }, { key: CJK81, code: 'segment_too_long', fix: new RegExp(`^gbrain put notes/漢{78}`) });
      expect(report!.escaped.filter(e => e.restorable).map(e => e.slug).sort()).toEqual(Object.keys(ESCAPED).sort());
      expect(messages.join('\n')).toContain('companies/aux -> companies/aux~.md');
      expectOthersUnchanged(before, await snapshotItems(engine, 'default'));
    }, 120_000);

    test('B-5 item: every path collision is collected and refused once with its code and fix; the per-source exports publish', async () => {
      await page('notes/shared'); await page('notes/shared', 'other');
      await page('one'); await page('one.md/two');
      await page('companies/aux');
      const out = join(dir, 'out');
      await expect(runExport(engine, ['--dir', out])).rejects.toThrow('EXIT:1');
      expect(existsSync(out) ? readdirSync(out) : []).toEqual([]);
      const text = messages.join('\n');
      const lines = text.split('\n').filter(line => line.includes('(export_path_collision)'));
      const parsed = lines.map(line => /^ {2}- (\S+) -> (\S+) collides with (\S+) \((\w+)\); fix: (.*)$/.exec(line)!).map(m => ({ key: m[1], code: m[4], fix: m[5] }));
      expect(parsed.map(p => p.key).sort()).toEqual(['default:one.md/two', 'other:notes/shared']);
      expectItemFailure(parsed.find(p => p.key === 'other:notes/shared'), { key: 'other:notes/shared', code: 'export_path_collision', fix: new RegExp(`^gbrain export --source other --dir ${out}-other$`) });
      expectItemFailure(parsed.find(p => p.key === 'default:one.md/two'), { key: 'default:one.md/two', code: 'export_path_collision', fix: /delete_page one\.md\/two/ });
      for (const source of ['default', 'other']) {
        await engine.executeRaw('DELETE FROM pages WHERE slug = $1', ['one.md/two']);
        await expectUnitNotAborted(() => runExport(engine, ['--dir', `${out}-${source}`, '--source', source]));
        expect(readFileSync(join(`${out}-${source}`, 'notes/shared.md'), 'utf8')).toContain('body of notes/shared');
      }
    }, 120_000);

    for (const injected of runScopedErrors().filter(e => e.name === 'connection lost' || e.name === 'failed transaction (25P02)')) {
      test(`B-5 run: a run-scoped error (${injected.name}) reading an unportable page aborts the export and publishes nothing`, async () => {
        for (const slug of [...UNSAFE, 'notes/healthy']) await page(slug);
        const query = engine.executeRaw;
        engine.executeRaw = async function (this: BrainEngine, sql: string, params?: unknown[], options?: unknown) {
          if (sql.includes('AS export_tags')) throw injected.error();
          return (query as Function).call(this, sql, params, options);
        } as typeof engine.executeRaw;
        try {
          await expect(runExport(engine, ['--dir', join(dir, 'out')])).rejects.toThrow('EXIT:1');
        } finally { engine.executeRaw = query; }
        expect(existsSync(join(dir, 'out')) ? readdirSync(join(dir, 'out')) : []).toEqual([]);
        expect(messages.join('\n')).not.toContain('escaped');
      }, 120_000);
    }
  });

  describe(`B-5 new unportable identities (${backend})`, () => {
    const putPage = op('put_page');
    test('B-5 item: put_page, its dry run and put_pages refuse a new reserved-name slug with a portable one; colon slugs and siblings land', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await putPage.handler(ctx, { slug: 'notes/kept', content: body('Kept') });
        const before = await snapshotItems(engine, 'default');
        for (const [slug, suggestion] of [['companies/aux', 'companies/aux-page'], ['people/nul.x', 'people/nul-page.x'], ['people/con', 'people/con-page']]) {
          const error = await refusal(putPage.handler(ctx, { slug, content: body(slug) }));
          expectItemFailure({ key: slug, code: String(error.code), fix: error.fix }, { key: slug, code: 'invalid_params', fix: new RegExp(`^gbrain get ${suggestion.replace('.', '\\.')}$`) });
          expect(error.detail).toBe('slug_not_portable');
          const dry = await refusal(putPage.handler({ ...ctx, dryRun: true }, { slug, content: body(slug) }));
          expect(dry.detail).toBe('slug_not_portable');
        }
        const batch = await op('put_pages').handler(ctx, { request_id: randomUUID(), pages: [
          { slug: 'companies/lpt1', content: body('Lpt') }, { slug: 'notes/batch-sibling', content: body('Batch sibling') }] }) as { pages?: Array<Record<string, unknown>> };
        const refused = JSON.stringify(batch);
        expect(refused).toContain('slug_not_portable');
        for (const slug of ['ns:foo', 'meetings/2026-01-01:standup']) await expectUnitNotAborted(() => Promise.resolve(putPage.handler(ctx, { slug, content: body(slug) })));
        expect(await engine.getPage('companies/aux', { sourceId: 'default' })).toBeNull();
        expect(await engine.getPage('companies/lpt1', { sourceId: 'default' })).toBeNull();
        expect(await engine.getPage('notes/batch-sibling', { sourceId: 'default' })).not.toBeNull();
        expectOthersUnchanged(before, await snapshotItems(engine, 'default'), { changed: ['notes/batch-sibling', 'ns:foo', 'meetings/2026-01-01:standup'] });
        await expectUnitNotAborted(() => Promise.resolve(putPage.handler(ctx, { slug: 'companies/aux-page', content: body('Aux') })));
      }, { databaseUrl });
    }, 120_000);

    test('B-5 item: an existing reserved-name page keeps updating (put_page, edit_page, replay); another source holding the slug does not make it existing here', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        const write = async (slug: string, content: string, extra: Record<string, unknown> = {}, sourceId = 'default') => {
          const prior = await engine.readPageSnapshot(slug, { sourceId });
          return putPage.handler({ ...ctx, sourceId }, { slug, content, ...(prior ? { expected_revision: prior.revision } : {}), ...extra }) as Promise<Record<string, unknown>>;
        };
        const updated = await expectUnitNotAborted(() => write('companies/aux', body('Aux updated')));
        expect(String(updated.slug_advisory)).toContain('companies/aux-page');
        expect((await engine.getPage('companies/aux', { sourceId: 'default' }))!.compiled_truth).toContain('Aux updated');
        const snapshot = (await engine.readPageSnapshot('companies/aux', { sourceId: 'default' }))!;
        await expectUnitNotAborted(() => Promise.resolve(op('edit_page').handler(ctx, { slug: 'companies/aux', expected_revision: snapshot.revision,
          edits: [{ old_text: 'Body of Aux updated.', new_text: 'Body of Aux edited.' }] })));
        expect((await engine.getPage('companies/aux', { sourceId: 'default' }))!.compiled_truth).toContain('Aux edited');
        const requestId = randomUUID();
        const params = { slug: 'companies/aux', content: body('Aux replayed'), expected_revision: (await engine.readPageSnapshot('companies/aux', { sourceId: 'default' }))!.revision, request_id: requestId };
        await putPage.handler(ctx, params);
        await op('delete_page').handler(ctx, { slug: 'companies/aux', expected_revision: (await engine.readPageSnapshot('companies/aux', { sourceId: 'default' }))!.revision });
        expect(await engine.getPage('companies/aux', { sourceId: 'default' })).toBeNull();
        await expectUnitNotAborted(() => Promise.resolve(putPage.handler(ctx, params)));
        const other = await refusal(write('companies/con', body('Con'), {}, 'default'));
        expect(other.detail).toBe('slug_not_portable');
        const inOther = await expectUnitNotAborted(() => write('companies/con', body('Con other'), {}, 'other'));
        expect(String(inOther.slug_advisory)).toContain('companies/con-page');
      }, { databaseUrl, setup: async ({ engine, root }) => {
        await engine.executeRaw("INSERT INTO sources (id,name,local_path) VALUES ('other','Other',NULL) ON CONFLICT DO NOTHING");
        await engine.putPage('companies/aux', { type: 'note', title: 'Aux', compiled_truth: 'Body of Aux.', timeline: '' }, { sourceId: 'default' });
        const stored = (await engine.readPageSnapshot('companies/aux', { sourceId: 'default' }))!;
        mkdirSync(join(root, 'companies'));
        writeFileSync(join(root, 'companies/aux.md'), serializePageToMarkdown(stored.page, stored.tags));
        await engine.putPage('companies/con', { type: 'note', title: 'Con', compiled_truth: 'Body of Con.', timeline: '' }, { sourceId: 'other' });
      } });
    }, 120_000);

    test('B-5 item: slugifyEntity suffixes reserved names with the entity type', () => {
      expect(slugifyEntity('Con', 'person')).toBe('people/con-person');
      expect(slugifyEntity('Aux', 'company')).toBe('companies/aux-company');
      expect(slugifyEntity('COM1', 'company')).toBe('companies/com1-company');
      expect(slugifyEntity('Nul.x', 'person')).toBe('people/nul-x');
      expect(slugifyEntity('Connor Example', 'person')).toBe('people/connor-example');
    });

    for (const injected of runScopedErrors().filter(e => e.name === 'connection lost' || e.name === 'failed transaction (25P02)')) {
      test(`B-5 run: a run-scoped error (${injected.name}) while checking a reserved-name identity is not a slug refusal`, async () => {
        await managedBrain(async ({ engine, ctx }) => {
          const error = injected.error();
          const failing = new Proxy(engine, { get(t, prop) {
            if (prop === 'readPageSnapshot') return () => Promise.reject(error);
            const value = Reflect.get(t, prop, t);
            return typeof value === 'function' ? value.bind(t) : value;
          } });
          const dryCtx: OperationContext = { ...ctx, dryRun: true, engine: failing };
          let thrown: unknown;
          try { await putPage.handler(dryCtx, { slug: 'companies/aux', content: body('Aux') }); } catch (e) { thrown = e; }
          expect(thrown).toBe(error);
        }, { databaseUrl });
      }, 120_000);
    }
  });
}
