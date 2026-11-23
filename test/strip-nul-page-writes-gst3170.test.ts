/**
 * GST-3170: a page write whose text holds U+0000 is stored with the U+0000 removed, never lost.
 *
 * 1. Protects: Postgres text and jsonb cannot hold U+0000, so a put_page whose body, title or frontmatter carried one
 *    (a chat turn like "canap<U+0000>es") failed with internal_error "unsupported Unicode escape sequence" and the whole
 *    conversation page was lost. The write now removes every U+0000 and keeps every other character as written.
 * 2. Fails when: a remote put_page, put_pages, edit_page, add_timeline_entry or a transcript ingest with U+0000 in its text errors, stores a U+0000, drops the
 *    characters beside it, writes a canonical file that differs from the stored page, or fails the facts and timeline rows
 *    the page derives.
 * 3. Real seams: MCP dispatch with remote: true through the persistence service and its write-through file, and
 *    runTranscriptsIngest on an unmanaged brain (direct importer) and a writer-claimed brain (put_page write requests),
 *    on PGLite and Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { makeContext } from '../src/cli/main.ts';
import { runTranscriptsIngest } from '../src/core/transcripts/ingest.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { parseDataFrontmatter } from '../src/core/data-frontmatter.ts';
import { disposePersistenceConsumer, stopPersistenceConsumer } from '../src/core/persistence/service.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const NUL = '\u0000';
const fact = (claim: string) => ({ rowNum: 1, claim, kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium', active: true });
const auth = { token: 'fixture', clientId: 'fixture-client', scopes: ['read', 'write'], sourceId: 'default', boundSlugPrefixes: ['notes'] };

for (const kind of testBackends()) {
  describe(`GST-3170 page writes remove U+0000 instead of failing (${kind})`, () => {
    let engine: BrainEngine; let close: () => Promise<void>;
    let dir: string; let root: string;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      dir = mkdtempSync(join(tmpdir(), 'gb-strip-nul-'));
      root = join(dir, 'brain'); mkdirSync(root);
    }, 300_000);
    afterAll(async () => { await disposePersistenceConsumer(engine); await close?.(); rmSync(dir, { recursive: true, force: true }); }, 60_000);

    test('a remote put_page, edit_page, add_timeline_entry and put_pages store page text with U+0000 removed, and the file matches', async () => {
      await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await disposePersistenceConsumer(engine);
        _resetWriteThroughCacheForTest();
        await engine.setConfig('sync.repo_path', root);
        await claimWorktree(engine, 'default', root);
        const registration = await registerLocalWriter(engine, 'stdio', { sourceIds: ['*'], operations: null, scopes: ['read', 'write'], slugPrefixes: ['notes'] });
        const slug = 'notes/chat-canapes';
        const content = `---\ntitle: Chat about canap${NUL}es\ntype: note\nsnack${NUL}_kind: canap${NUL}es\nescaped: "canap\\0es"\ntags: [canap${NUL}es]\n---\n\n`
          + `alice-example said: canap${NUL}es, then ${NUL}${NUL}twice.\n\n## Facts\n\n${renderFactsTable([fact(`Likes canap${NUL}es`)] as never)}\n\n`
          + `## Timeline\n\n- **2026-01-02** | chat — Talked about canap${NUL}es\n`;
        const warnings: string[] = [];
        try {
          const response = await withVerifiedLocalRegistration(engine, registration, () => dispatchToolCall(engine, 'put_page',
            { slug, content, request_id: randomUUID() }, {
              remote: true, config: { engine: kind } as never, sourceId: 'default', auth,
              logger: { info() {}, warn(message: string) { warnings.push(message); }, error() {} },
            }));
          const text = (response.content[0] as { text: string }).text;
          expect(response.isError, text.slice(0, 400)).toBeFalsy();
          expect(JSON.parse(text).state).toBe('committed');

          const page = (await engine.getPage(slug, { sourceId: 'default' }))!;
          expect(page.title).toBe('Chat about canapes');
          expect(page.compiled_truth).toContain('alice-example said: canapes, then twice.');
          expect(page.compiled_truth).toContain('Likes canapes');
          expect(page.timeline).toContain('Talked about canapes');
          expect(page.frontmatter.snack_kind).toBe('canapes');
          expect(page.frontmatter.escaped).toBe('canapes');
          expect(await engine.getTags(slug, { sourceId: 'default' })).toEqual(['canapes']);
          expect(JSON.stringify(page)).not.toContain('\\u0000');

          const file = readFileSync(join(root, `${slug}.md`), 'utf8');
          expect(file).not.toContain(NUL);
          expect(file).toContain('alice-example said: canapes, then twice.');
          expect(file).toContain('title: Chat about canapes');

          const timeline = await engine.executeRaw<{ summary: string }>(
            'SELECT t.summary FROM timeline_entries t JOIN pages p ON p.id = t.page_id WHERE p.source_id = $1 AND p.slug = $2', ['default', slug]);
          expect(timeline.map(r => r.summary)).toEqual(['Talked about canapes']);
          const facts = await engine.executeRaw<{ fact: string }>('SELECT fact FROM facts WHERE source_id = $1 AND source_markdown_slug = $2', ['default', slug]);
          expect(facts.map(r => r.fact)).toEqual(['Likes canapes']);
          expect(warnings.some(w => w.includes('U+0000') && w.includes(slug))).toBe(true);

          const call = async (op: string, params: Record<string, unknown>) => {
            const out = await withVerifiedLocalRegistration(engine, registration, () => dispatchToolCall(engine, op, params, {
              remote: true, config: { engine: kind } as never, sourceId: 'default', auth, logger: { info() {}, warn() {}, error() {} },
            }));
            expect(out.isError, op + ': ' + (out.content[0] as { text: string }).text.slice(0, 400)).toBeFalsy();
          };
          const { revision } = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
          await call('edit_page', { slug, expected_revision: revision, request_id: randomUUID(), edits: [{ old_text: 'then twice.', new_text: `then thrice, canap${NUL}es.` }] });
          await call('add_timeline_entry', { slug, date: '2026-01-03', summary: `Served canap${NUL}es`, detail: `Both canap${NUL}es trays` });
          await call('put_pages', { request_id: randomUUID(), pages: [{ slug: 'notes/batch-canapes', content: `---\ntitle: Batch\n---\n\nBatch canap${NUL}es.\n` }] });
          expect((await engine.getPage(slug, { sourceId: 'default' }))!.compiled_truth).toContain('alice-example said: canapes, then thrice, canapes.');
          expect((await engine.getPage('notes/batch-canapes', { sourceId: 'default' }))!.compiled_truth).toBe('Batch canapes.');
          expect(readFileSync(join(root, 'notes/batch-canapes.md'), 'utf8')).toContain('Batch canapes.');
          const entries = await engine.executeRaw<{ summary: string; detail: string }>(
            'SELECT t.summary, t.detail FROM timeline_entries t JOIN pages p ON p.id = t.page_id WHERE p.source_id = $1 AND p.slug = $2 ORDER BY t.date', ['default', slug]);
          expect(entries.map(r => [r.summary, r.detail])).toEqual([['Talked about canapes', ''], ['Served canapes', 'Both canapes trays']]);
          const { revision: next } = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
          const refused = await withVerifiedLocalRegistration(engine, registration, () => dispatchToolCall(engine, 'edit_page',
            { slug, expected_revision: next, request_id: randomUUID(), edits: [{ old_text: `the${NUL}n thrice`, new_text: 'then never' }] },
            { remote: true, config: { engine: kind } as never, sourceId: 'default', auth, logger: { info() {}, warn() {}, error() {} } }));
          expect((refused.content[0] as { text: string }).text).toContain('edit_no_match');
          expect((await engine.getPage(slug, { sourceId: 'default' }))!.compiled_truth).toContain('then thrice, canapes.');
        } finally {
          await disposePersistenceConsumer(engine);
          await engine.unsetConfig('sync.repo_path');
        }
      });
    }, 120_000);

    for (const managed of [false, true]) {
      test(`a transcript ingest ${managed ? 'on a writer-claimed brain (put_page write requests)' : 'through the direct importer'} stores the conversation with U+0000 removed`, async () => {
        const path = join(dir, `export-${managed}.json`);
        const message = (role: string, t: number, text: string) => ({ author: { role }, create_time: t, content: { content_type: 'text', parts: [text] } });
        writeFileSync(path, JSON.stringify([{ title: `Canap${NUL}es ${managed}`, create_time: 1786080000, update_time: 1786080015, conversation_id: `cgpt-nul-${managed}`, current_node: 'n2',
          mapping: {
            root: { id: 'root', parent: null, children: ['n1'], message: null },
            n1: { id: 'n1', parent: 'root', children: ['n2'], message: message('user', 1786080005, `Bring canap${NUL}es for acme-example.`) },
            n2: { id: 'n2', parent: 'n1', children: [], message: message('assistant', 1786080015, `Sure, canap${NUL}es it is.`) },
          } }]));
        const result = await withEnv({ GBRAIN_HOME: join(dir, 'home'), DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
          await stopPersistenceConsumer(engine);
          await engine.executeRaw('UPDATE persistence_brain SET enabled = $1 WHERE singleton = 1', [managed]);
          try {
            const context = managed ? await makeContext(engine, { source: 'default' }) : undefined;
            return await runTranscriptsIngest(engine, { paths: [path], sourceId: 'default', format: 'chatgpt', context });
          } finally {
            await disposePersistenceConsumer(engine);
            await engine.executeRaw('UPDATE persistence_brain SET enabled = false WHERE singleton = 1');
          }
        });
        expect({ imported: result.sessionsImported, errored: result.sessionsErrored, pages: result.pages.errored }).toEqual({ imported: 1, errored: 0, pages: 0 });
        const [row] = await engine.executeRaw<{ slug: string; title: string; compiled_truth: string; frontmatter: unknown }>(
          "SELECT slug, title, compiled_truth, frontmatter FROM pages WHERE deleted_at IS NULL AND slug LIKE 'conversations/%' AND title LIKE $1", [`%${managed}%`]);
        expect(row).toBeDefined();
        expect(row!.title).toContain(`Canapes ${managed}`);
        expect(row!.compiled_truth).toContain('Bring canapes for acme-example.');
        expect(row!.compiled_truth).toContain('Sure, canapes it is.');
        expect(JSON.stringify(row)).not.toContain('\\u0000');
        if (managed) {
          const states = await engine.executeRaw<{ state: string }>("SELECT state FROM persistence_requests WHERE operation = 'put_page' AND slug = $1", [row!.slug]);
          expect(states.map(s => s.state)).toEqual(['committed']);
        }
      }, 120_000);
    }
  });
}

test('a frontmatter key that only U+0000 told apart from another is refused, never merged over it', () => {
  expect(() => parseDataFrontmatter(`---\nreadable_by: [alice-example]\n"readable\\0_by": null\n---\nbody\n`)).toThrow(/appears twice once U\+0000 is removed/);
  expect(parseDataFrontmatter(`---\nsnack\\0: "canap\\0es"\n---\nbody\n`).data).toEqual({ 'snack\\0': 'canapes' });
});
