/**
 * A page whose frontmatter names its readers with a key that is not exactly `readable_by` (`Readable_By`, `readable-by`,
 * `READABLE_BY`, `readable by`, `readableBy`) was stored as a page every member could read: page access reads only the exact
 * key, so the author's restriction was lost without a word. Now `put_page`, `edit_page` and `capture` refuse it
 * `readers_noncanonical` and store nothing, and sync and import hold the file under the same code (as `visibility: Private`
 * is refused `visibility_not_applied` / held `visibility_noncanonical`).
 *
 * Runs on a repo-less brain and on a managed brain with a Git checkout, on PGLite and, with DATABASE_URL, Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistSavedIdea } from '../src/commands/brainstorm.ts';
import { runImport } from '../src/commands/import.ts';
import { performSync } from '../src/commands/sync.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { importFile, importFromContent } from '../src/core/import-file.ts';
import { screenImportContent } from '../src/core/import-screen.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { misspelledReaderKeys, noncanonicalReadersHold } from '../src/core/persistence/readers-request.ts';
import { gitHeldFilesCheck } from '../src/commands/doctor/checks/git-holds.ts';
import { fileHeldField, recordRoute } from '../src/core/persistence/held-reads.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { gitHoldFix, readGitSourceHolds, type GitHoldRecord } from '../src/core/persistence/sync-holds.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isWriteErrorCode } from '../src/core/persistence/types.ts';
import { normalizeReaders } from '../src/core/access/principals.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { readPageBodyPolicy } from '../src/core/page-body/limits.ts';
import { importStreamedMarkdownFile } from '../src/core/page-body/streamed-import.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let dataDir: string;
let closePostgres: (() => Promise<void>) | undefined;
const home = mkdtempSync(join(tmpdir(), 'gbrain-readers-'));
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home };

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'gbrain-readers-db-'));
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir });
    await engine.initSchema();
    engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine);
    closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  resetGateway();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const putPage = operations.find(op => op.name === 'put_page')!;
const editPage = operations.find(op => op.name === 'edit_page')!;
const capturePage = operations.find(op => op.name === 'capture')!;
const page = (extra = '') => `---\ntitle: Example\ntype: note\n${extra}---\nA page about acme-example.\n`;
type Outcome = Record<string, any> & { thrown?: string; message?: string };
const caught = (e: { code?: string; message?: string }): Outcome => ({ thrown: e.code, message: e.message });
const put = (ctx: OperationContext, slug: string, content: string, expectedRevision?: string): Promise<Outcome> =>
  (putPage.handler(ctx, { slug, content, request_id: randomUUID(), wait_ms: 25_000, ...(expectedRevision ? { expected_revision: expectedRevision } : {}) }) as Promise<Outcome>).catch(caught);

/** The spellings page access does not read, each a line of frontmatter. */
const MISSPELLED: Array<[string, string]> = [
  ['Readable_By', 'Readable_By: [alice-example]\n'],
  ['readable-by', 'readable-by: [alice-example]\n'],
  ['READABLE_BY', 'READABLE_BY: [alice-example]\n'],
  ['readable by', 'readable by: [alice-example]\n'],
  ['readableBy', 'readableBy: [alice-example]\n'],
  ['a quoted key', '"Readable_By": [alice-example]\n'],
  ['a key beside the exact readable_by', 'readable_by: [alice-example]\nReadable_By: [bob-example]\n'],
];

/** A source per run: repo-less (no Git) or a managed checkout with Git. */
async function brain(managed: boolean, run: (ctx: OperationContext, engine: BrainEngine) => Promise<void>) {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-readers-'));
    const root = join(dir, 'brain');
    mkdirSync(root);
    const sourceId = `source-${randomUUID().slice(0, 8)}`;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        if (managed) { writeFileSync(join(root, '.gitignore'), 'tmp/\n'); durableGitRepo(root, ['.gitignore']); }
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        await claimWorktree(engine, sourceId, root);
        if (managed) await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        await run({ engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false,
          logger: { info() {}, warn() {}, error() {} } }, engine);
      });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

const snapshot = (engine: BrainEngine, ctx: OperationContext, slug: string) => engine.readPageSnapshot(slug, { sourceId: ctx.sourceId! });

describe('readers key detection', () => {
  test('a spelling of readable_by that page access does not read is found, in the line scan and in the parse', () => {
    for (const [label, extra] of MISSPELLED) {
      const content = page(extra);
      expect({ label, keys: misspelledReaderKeys(content, parseMarkdown(content, 'notes/example.md').frontmatter).length > 0 }).toEqual({ label, keys: true });
      expect({ label, scan: misspelledReaderKeys(content, null).length > 0 }).toEqual({ label, scan: true });
    }
    expect(misspelledReaderKeys('---\n{title: Example, Readable_By: [alice-example]}\n---\nBody\n', null)).toEqual([]);
    expect(misspelledReaderKeys('', { title: 'Example', 'Readable-By': ['alice-example'] })).toEqual(['Readable-By']);
    expect(misspelledReaderKeys('', { title: 'Example', readableBy: 'alice-example', 'readable by': 'x' })).toEqual(['readableBy', 'readable by']);
  });

  test('the exact key, other keys, nested keys, block scalars and the body are not misspellings', () => {
    expect(misspelledReaderKeys(page('readable_by: [alice-example]\n'), { readable_by: ['alice-example'] })).toEqual([]);
    expect(misspelledReaderKeys(page(), { title: 'Example', type: 'note' })).toEqual([]);
    expect(misspelledReaderKeys(page('notes: >\n  Readable_By: [alice-example]\n'), { notes: 'Readable_By: [alice-example]' })).toEqual([]);
    expect(misspelledReaderKeys(page('meta:\n  Readable_By: [alice-example]\n'), { meta: { Readable_By: ['alice-example'] } })).toEqual([]);
    expect(misspelledReaderKeys('A body.\nReadable_By: [alice-example]\n', null)).toEqual([]);
    expect(misspelledReaderKeys('---\nReadable_By: [alice-example]\n', null)).toEqual([]);
    expect(noncanonicalReadersHold(page(), {})).toBeNull();
  });

  test('a key-looking line inside a flow collection or a multiline quoted scalar is nested data, not a top-level key; a real one after it is still found', () => {
    const nested = ['meta: {\nReadable_By: [alice-example]\n}\n', 'meta: [\n  a,\nReadable_By: [alice-example]\n]\n', 'note: "first line\nReadable_By: x\nlast"\n',
      "note: 'it''s\nReadable_By: x'\n", 'meta: { a: "}", b: [1, 2] }\nnote: it\'s plain\n', 'meta: {\n  a: 1 # {\n}\n'];
    for (const extra of nested) expect({ extra, keys: misspelledReaderKeys(page(extra), null) }).toEqual({ extra, keys: [] });
    for (const extra of nested) expect({ extra, keys: misspelledReaderKeys(page(`${extra}Readable_By: [alice-example]\n`), null) }).toEqual({ extra, keys: ['Readable_By'] });
    expect(misspelledReaderKeys(page(nested[0]), parseMarkdown(page(nested[0]), 'notes/example.md').frontmatter)).toEqual([]);
  });

  test('an anchor or a tag before a flow collection still opens it: the key-looking line inside is nested data; a real one after it is still found', () => {
    const decorated = ['meta: &defaults {\nReadable_By: [alice-example]\n}\n', 'meta: !!map {\nReadable_By: [alice-example]\n}\n', 'meta: !<tag:yaml.org,2002:map> {\nReadable_By: [alice-example]\n}\n',
      'meta: &base !!map {\nReadable_By: [alice-example]\n}\n', 'list: &items [\n  a,\nReadable_By: x\n]\n'];
    for (const extra of decorated) expect({ extra, keys: misspelledReaderKeys(page(extra), null) }).toEqual({ extra, keys: [] });
    for (const extra of decorated) expect({ extra, keys: misspelledReaderKeys(page(`${extra}Readable_By: [alice-example]\n`), null) }).toEqual({ extra, keys: ['Readable_By'] });
    expect(misspelledReaderKeys(page(decorated[0]), parseMarkdown(page(decorated[0]), 'notes/example.md').frontmatter)).toEqual([]);
    // An anchor or tag inside a plain scalar is not a decoration, and an unclosed decorated collection still counts every key-looking line.
    expect(misspelledReaderKeys(page('note: see &ref {\nReadable_By: x\n'), null)).toEqual(['Readable_By']);
    expect(misspelledReaderKeys(page('meta: &defaults {\nReadable_By: [alice-example]\n'), null)).toEqual(['Readable_By']);
  });

  test('a top-level flow mapping and a block-style key under either fence are still misspellings', () => {
    const flow = '---\n{title: Example, Readable_By: [alice-example]}\n---\nBody\n';
    expect(misspelledReaderKeys(flow, parseMarkdown(flow, 'notes/example.md').frontmatter)).toEqual(['Readable_By']);
    for (const fenced of ['---\ntitle: Example\nReadable_By: [alice-example]\n---\nBody\n', ' ---\ntitle: Example\nReadable_By: [alice-example]\n---\nBody\n'])
      expect({ fenced, keys: misspelledReaderKeys(fenced, parseMarkdown(fenced, 'notes/example.md').frontmatter) }).toEqual({ fenced, keys: ['Readable_By'] });
  });

  test('a flow collection or quote that never closes before the block ends counts every key-looking line (the guard only refuses)', () => {
    expect(misspelledReaderKeys(page('meta: {\nReadable_By: [alice-example]\n'), null)).toEqual(['Readable_By']);
    expect(misspelledReaderKeys(page('note: "open\nReadable_By: x\n'), null)).toEqual(['Readable_By']);
  });

  test('a hold names the spelling for a file and leaves it out when asked, and tells the fix', () => {
    const named = noncanonicalReadersHold(page('Readable_By: [alice-example]\n'), null)!;
    expect(named.code).toBe('readers_noncanonical');
    expect(named.message).toContain('`Readable_By`');
    expect(named.message).toContain('readable by every member');
    expect(named.message).toContain('readable_by (lowercase, with an underscore)');
    const hidden = noncanonicalReadersHold(page('Readable_By: [alice-example]\n'), null, false)!;
    expect(hidden.message).not.toContain('Readable_By');
    expect(isWriteErrorCode('readers_noncanonical')).toBe(true);
  });

  test('screenImportContent holds it only for file ingestion (holdNoncanonicalPrivate); a page write screen admits it for its own guard', () => {
    const content = page('Readable_By: [alice-example]\n');
    const held = screenImportContent({ content, path: 'notes/example.md', holdNoncanonicalPrivate: true });
    expect(held.status === 'refused' ? held.refusal.code : held.status).toBe('readers_noncanonical');
    expect(screenImportContent({ content, path: 'notes/example.md' }).status).toBe('importable');
    expect(screenImportContent({ content: page('readable_by: [alice-example]\n'), path: 'notes/example.md', holdNoncanonicalPrivate: true }).status).toBe('importable');
  });
});

for (const managed of [false, true]) describe(`${managed ? 'managed brain with a Git checkout' : 'repo-less brain'}: put_page readers key`, () => {
  for (const [label, extra] of MISSPELLED) {
    test(`${label} is refused readers_noncanonical, and nothing is stored`, async () => {
      await brain(managed, async (ctx, engine) => {
        const result = await put(ctx, 'notes/example', page(extra));
        expect(result.thrown).toBe('readers_noncanonical');
        expect(result.message).toContain('would be readable by every member and nothing was written');
        expect(result.message).toContain('readable_by (lowercase, with an underscore)');
        expect(await snapshot(engine, ctx, 'notes/example')).toBeNull();
        expect(await engine.getPage('notes/example', { sourceId: ctx.sourceId! })).toBeNull();
        expect(await engine.searchKeyword('acme-example', { limit: 5, sourceId: ctx.sourceId! })).toEqual([]);
      });
    }, 120_000);
  }

  test('the message names the misspelled key for a local caller; a remote caller is refused the same way without it', async () => {
    await brain(managed, async (ctx, engine) => {
      const local = await put(ctx, 'notes/example', page('Readable_By: [alice-example]\n'));
      expect(local).toMatchObject({ thrown: 'readers_noncanonical' });
      expect(local.message).toContain('`Readable_By`');
      const remote = await put({ ...ctx, remote: true }, 'notes/example', page('Readable_By: [alice-example]\n'));
      expect(remote).toMatchObject({ thrown: 'readers_noncanonical' });
      expect(remote.message).not.toContain('Readable_By');
      expect(await snapshot(engine, ctx, 'notes/example')).toBeNull();
    });
  }, 120_000);

  test('the exact readable_by key still restricts the page, and a page with no readers key still stores', async () => {
    await brain(managed, async (ctx, engine) => {
      expect((await put(ctx, 'notes/restricted', page('readable_by: [alice-example]\n'))).thrown).toBeUndefined();
      expect(normalizeReaders((await snapshot(engine, ctx, 'notes/restricted'))!.page.frontmatter)).toEqual(['member:alice-example']);
      expect((await put(ctx, 'notes/plain', page())).thrown).toBeUndefined();
      expect(normalizeReaders((await snapshot(engine, ctx, 'notes/plain'))!.page.frontmatter)).toBeNull();
      expect((await put({ ...ctx, remote: true }, 'notes/remote-plain', page())).thrown).toBeUndefined();
    });
  }, 120_000);

  test('a Readable_By line that is nested data in a flow collection or a multiline quoted scalar is stored as it is; a top-level misspelling after it is refused', async () => {
    await brain(managed, async (ctx, engine) => {
      for (const [slug, extra] of [['notes/flow', 'meta: {\nReadable_By: [alice-example]\n}\n'], ['notes/quoted', 'note: \"first\nReadable_By: x\nlast\"\n']] as const) {
        expect({ slug, thrown: (await put(ctx, slug, page(extra))).thrown }).toEqual({ slug, thrown: undefined });
        expect(normalizeReaders((await snapshot(engine, ctx, slug))!.page.frontmatter)).toBeNull();
        expect({ slug, thrown: (await put(ctx, `${slug}-bad`, page(`${extra}Readable_By: [alice-example]\n`))).thrown }).toEqual({ slug, thrown: 'readers_noncanonical' });
        expect(await snapshot(engine, ctx, `${slug}-bad`)).toBeNull();
      }
    });
  }, 120_000);

  test('a Readable_By line nested under an anchored or tagged flow collection is stored as it is; a flow mapping or a block key under either fence is still refused', async () => {
    await brain(managed, async (ctx, engine) => {
      for (const [slug, extra] of [['notes/anchor', 'meta: &defaults {\nReadable_By: [alice-example]\n}\n'], ['notes/tag', 'meta: !!map {\nReadable_By: [alice-example]\n}\n']] as const) {
        expect({ slug, thrown: (await put(ctx, slug, page(extra))).thrown }).toEqual({ slug, thrown: undefined });
        expect(normalizeReaders((await snapshot(engine, ctx, slug))!.page.frontmatter)).toBeNull();
        expect({ slug, thrown: (await put(ctx, `${slug}-bad`, page(`${extra}Readable_By: [alice-example]\n`))).thrown }).toEqual({ slug, thrown: 'readers_noncanonical' });
        expect(await snapshot(engine, ctx, `${slug}-bad`)).toBeNull();
      }
      for (const [slug, content] of [['notes/flow-map', '---\n{title: Example, Readable_By: [alice-example]}\n---\nBody\n'],
        ['notes/block', '---\ntitle: Example\nReadable_By: [alice-example]\n---\nBody\n'], ['notes/block-indented', ' ---\ntitle: Example\nReadable_By: [alice-example]\n---\nBody\n']] as const) {
        expect({ slug, thrown: (await put(ctx, slug, content)).thrown }).toEqual({ slug, thrown: 'readers_noncanonical' });
        expect(await snapshot(engine, ctx, slug)).toBeNull();
      }
    });
  }, 120_000);

  test('a misspelling on an existing page is refused and the page and its revision are unchanged', async () => {
    await brain(managed, async (ctx, engine) => {
      await put(ctx, 'notes/example', page('readable_by: [alice-example]\n'));
      const before = (await snapshot(engine, ctx, 'notes/example'))!;
      const result = await put(ctx, 'notes/example', page('readable_by: [alice-example]\nreadable-by: [bob-example]\n'), before.revision);
      expect(result.thrown).toBe('readers_noncanonical');
      const after = (await snapshot(engine, ctx, 'notes/example'))!;
      expect(after.revision).toBe(before.revision);
      expect(after.page.frontmatter).toEqual(before.page.frontmatter);
    });
  }, 120_000);

  test('edit_page and capture refuse it too', async () => {
    await brain(managed, async (ctx, engine) => {
      await put(ctx, 'notes/example', page());
      const before = (await snapshot(engine, ctx, 'notes/example'))!;
      const edited = await (editPage.handler(ctx, { slug: 'notes/example', expected_revision: before.revision, request_id: randomUUID(), wait_ms: 25_000,
        edits: [{ old_text: 'title: Example', new_text: 'title: Example\nReadable_By: [alice-example]' }] }) as Promise<Outcome>).catch(caught);
      expect(edited.thrown).toBe('readers_noncanonical');
      expect((await snapshot(engine, ctx, 'notes/example'))!.revision).toBe(before.revision);
      const captured = await (capturePage.handler(ctx, { slug: 'notes/captured', content: page('readable-by: [alice-example]\n'), request_id: randomUUID(), wait_ms: 25_000 }) as Promise<Outcome>).catch(caught);
      expect(captured.thrown).toBe('readers_noncanonical');
      expect(await snapshot(engine, ctx, 'notes/captured')).toBeNull();
    });
  }, 120_000);
});

test('the streamed (segmented-body) import holds a readers key the parse drops (a leading space before the opening fence), and stores the fixed file restricted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-readers-stream-'));
  const path = join(dir, 'large.md');
  const body = 'A line about acme-example.\n'.repeat(2000);
  try {
    for (const engine of engines) {
      const policy = { ...(await readPageBodyPolicy(engine)), segmented: true };
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      try {
        for (const [slug, head] of [['notes/large-spaced', ' ---\nReadable_By: [alice-example]\n---\n'], ['notes/large-plain', '---\nReadable_By: [alice-example]\n---\n']] as const) {
          writeFileSync(path, head + body);
          expect({ slug, result: await importStreamedMarkdownFile(engine, path, `${slug}.md`, { noEmbed: true }, statSync(path), policy) })
            .toMatchObject({ result: { status: 'skipped', skip_reason: 'readers_noncanonical' } });
          expect(await engine.getPage(slug)).toBeNull();
        }
        writeFileSync(path, '---\nreadable_by: [alice-example]\n---\n' + body);
        expect((await importStreamedMarkdownFile(engine, path, 'notes/large-fixed.md', { noEmbed: true }, statSync(path), policy)).status).not.toBe('skipped');
        expect(normalizeReaders((await engine.getPage('notes/large-fixed'))!.frontmatter)).toEqual(['member:alice-example']);
      } finally {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000);

test('a derived write (add_tag) on a page that already stores a misspelled key is not refused: the guard governs authored content only', async () => {
  await brain(false, async (ctx, engine) => {
    const [{ local_path: root }] = await engine.executeRaw<{ local_path: string }>('SELECT local_path FROM sources WHERE id=$1', [ctx.sourceId]);
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes/legacy.md'), page('Readable_By: [alice-example]\n'));
    await importFromContent(engine, 'notes/legacy', page('Readable_By: [alice-example]\n'), { sourceId: ctx.sourceId, noEmbed: true });
    const addTag = operations.find(op => op.name === 'add_tag')!;
    const result = await (addTag.handler(ctx, { slug: 'notes/legacy', tag: 'alice-example', request_id: randomUUID(), wait_ms: 25_000 }) as Promise<Outcome>).catch(caught);
    expect(result.thrown).toBeUndefined();
    expect((await engine.getTags('notes/legacy', { sourceId: ctx.sourceId! })).includes('alice-example')).toBe(true);
  });
}, 120_000);

describe('brainstorm --save', () => {
  test('refuses a readers key page access does not read, saves the exact one', async () => {
    await brain(false, async (ctx, engine) => {
      const save = (content: string) => persistSavedIdea(engine, { slug: `wiki/ideas/example-${randomUUID().slice(0, 8)}`, content, sourceId: ctx.sourceId!, provenanceVia: 'brainstorm' });
      const refused = await save(page('Readable_By: [alice-example]\n'));
      expect({ dbSaved: refused.dbSaved, dbError: refused.dbError }).toEqual({ dbSaved: false, dbError: expect.stringContaining('would be readable by every member and nothing was written') });
      expect((await save(page('readable_by: [alice-example]\n'))).dbSaved).toBe(true);
    });
  }, 120_000);
});

// ---- file ingestion: import and sync ----

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string, extra = '') => `---\ntitle: ${title}\ntype: note\n${extra}---\nA note about acme-example.\n`;

const HELD: Record<string, string> = {
  'notes/upper-key.md': note('Upper key', 'Readable_By: [alice-example]\n'),
  'notes/hyphen.md': note('Hyphen', 'readable-by: [alice-example]\n'),
  'notes/shouting.md': note('Shouting', 'READABLE_BY: [alice-example]\n'),
  'notes/spaced.md': note('Spaced', 'readable by: [alice-example]\n'),
  'notes/camel.md': note('Camel', 'readableBy: [alice-example]\n'),
  'notes/both.md': note('Both', 'readable_by: [alice-example]\nReadable_By: [bob-example]\n'),
  'notes/flow-mapping.md': '---\n{title: Flow mapping, type: note, Readable_By: [alice-example]}\n---\nA note about acme-example.\n',
};
const KEPT: Record<string, string> = {
  'notes/restricted.md': note('Restricted', 'readable_by: [alice-example]\n'),
  'notes/plain.md': note('Plain'),
};
const slugOf = (path: string) => path.replace(/\.md$/, '');
const paths = (files: Record<string, string>) => Object.keys(files).sort();
const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);

function writeTree(root: string, files: Record<string, string>): void {
  mkdirSync(join(root, 'notes'), { recursive: true });
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
}

async function newSource(engine: BrainEngine, root: string): Promise<string> {
  const id = `source-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  return id;
}

/** Every held file left no page; the restricted file stored its readers and the plain file none. */
async function expectStored(engine: BrainEngine, sourceId: string): Promise<void> {
  for (const path of paths(HELD)) expect({ path, page: await engine.getPage(slugOf(path), { sourceId }) }).toEqual({ path, page: null });
  expect(normalizeReaders((await engine.getPage('notes/restricted', { sourceId }))!.frontmatter)).toEqual(['member:alice-example']);
  expect(normalizeReaders((await engine.getPage('notes/plain', { sourceId }))!.frontmatter)).toBeNull();
}

const holdCodes = async (engine: BrainEngine, sourceId: string) =>
  ((await readGitSourceHolds(engine, { sourceIds: [sourceId] }))[0]?.holds ?? []).map(hold => ({ path: hold.path, code: String(hold.code) })).sort(byPath);
const heldAs = (code: string, extra: string[] = []) => [...paths(HELD), ...extra].map(path => ({ path, code })).sort(byPath);

for (const backend of backends) describe(`[${backend}] readers_noncanonical on file ingestion`, () => {
  const engine = () => engines[backends.indexOf(backend)]!;

  test('gbrain import of a plain directory refuses each file with a misspelled readers key; the rest imports unchanged', () => withEnv(env, async () => {
    await engine().executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const root = mkdtempSync(join(home, 'plain-'));
    writeTree(root, { ...HELD, ...KEPT });
    const sourceId = await newSource(engine(), root);
    const result = await runImport(engine(), [root, '--no-embed'], { sourceId });
    expect(result.imported).toBe(paths(KEPT).length);
    expect(result.failures.map(failure => failure.path).sort()).toEqual(paths(HELD));
    for (const failure of result.failures) expect(failure.error).toContain('readable by every member');
    await expectStored(engine(), sourceId);
    const direct = await importFile(engine(), join(root, 'notes/upper-key.md'), 'notes/upper-key.md', { noEmbed: true, sourceId });
    expect({ status: direct.status, code: direct.refusal?.code, skip_reason: direct.skip_reason }).toEqual({ status: 'skipped', code: 'readers_noncanonical', skip_reason: 'readers_noncanonical' });
  }), 180_000);

  test('classic Git sync holds each such file readers_noncanonical, keeps an existing page, and imports it once the key is fixed', () => withEnv(env, async () => {
    await engine().executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const root = mkdtempSync(join(home, 'classic-'));
    git(root, 'init', '-q');
    writeTree(root, { 'notes/turned.md': note('Turned', 'readable_by: [alice-example]\n') });
    commit(root, 'seed');
    const sourceId = await newSource(engine(), root);
    const sync = () => performSync(engine(), { repoPath: root, sourceId, noPull: true, noEmbed: true, noExtract: true, concurrency: 1 });
    await sync();
    const before = (await engine().getPage('notes/turned', { sourceId }))!;
    writeTree(root, { ...HELD, ...KEPT, 'notes/turned.md': note('Turned', 'Readable_By: [alice-example, bob-example]\n') });
    commit(root, 'misspell the key');
    await sync();
    expect(await holdCodes(engine(), sourceId)).toEqual(heldAs('readers_noncanonical', ['notes/turned.md']));
    await expectStored(engine(), sourceId);
    const kept = (await engine().getPage('notes/turned', { sourceId }))!;
    expect({ hash: kept.content_hash, readers: normalizeReaders(kept.frontmatter) }).toEqual({ hash: before.content_hash, readers: ['member:alice-example'] });
    writeTree(root, { 'notes/turned.md': note('Turned', 'readable_by: [alice-example, bob-example]\n') });
    commit(root, 'fix the key');
    await sync();
    expect(await holdCodes(engine(), sourceId)).toEqual(heldAs('readers_noncanonical'));
    expect(normalizeReaders((await engine().getPage('notes/turned', { sourceId }))!.frontmatter)).toEqual(['member:alice-example', 'member:bob-example']);
  }), 180_000);
});

describe('managed brains', () => {
  for (const backend of backends) {
    const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
    const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };

    test(`[${backend}] managed Git sync holds each such file readers_noncanonical, the rest syncs, and a fixed file imports`, () => managedBrain(async ({ engine, root }) => {
      writeTree(root, KEPT);
      commit(root, 'seed');
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      writeTree(root, HELD);
      commit(root, 'misspell the key');
      const result = await performManagedSync(engine, OPTS);
      expect((result.held ?? []).map(hold => ({ path: hold.path, code: String(hold.code) })).sort(byPath)).toEqual(heldAs('readers_noncanonical'));
      expect(await holdCodes(engine, 'default')).toEqual(heldAs('readers_noncanonical'));
      await expectStored(engine, 'default');
      writeTree(root, { 'notes/upper-key.md': note('Upper key', 'readable_by: [alice-example]\n') });
      commit(root, 'fix the key');
      await performManagedSync(engine, OPTS);
      expect((await holdCodes(engine, 'default')).map(hold => hold.path)).not.toContain('notes/upper-key.md');
      expect(normalizeReaders((await engine.getPage('notes/upper-key', { sourceId: 'default' }))!.frontmatter)).toEqual(['member:alice-example']);
    }, { ...(databaseUrl ? { databaseUrl } : {}), setup: ({ root }) => { git(root, 'init', '-q'); } }), 180_000);

    test(`[${backend}] managed gbrain import of a directory with no Git checkout refuses each such file; the rest imports unchanged`, () => managedBrain(async ({ engine, root }) => {
      writeTree(root, { ...HELD, ...KEPT });
      const result = await runImport(engine, [root, '--no-embed'], { sourceId: 'default' });
      expect(result.failures.map(failure => failure.path).sort()).toEqual(paths(HELD));
      for (const failure of result.failures) expect(failure.error).toContain('readable_by');
      await expectStored(engine, 'default');
    }, databaseUrl ? { databaseUrl } : {}), 180_000);
  }
});

// ---- fix round: the doctor count, the fix text and the remote route ----

/** The three sentences every fix names: the rename restricts the page, the owner's member joins the list, and the verify step. */
const FIX_TEXT = ['restricts the page to the members it lists', "list the owner's member too", 'gbrain access check --token <name> --as <member>'];

for (const backend of backends) describe(`[${backend}] doctor git_held_files counts stored pages with a misspelled readers key`, () => {
  const engine = () => engines[backends.indexOf(backend)]!;
  const put = (sourceId: string, slug: string, frontmatter: Record<string, unknown>) =>
    engine().putPage(slug, { type: 'note', title: slug, compiled_truth: 'A note about acme-example.', frontmatter }, { sourceId });

  test('a stored page with a misspelled top-level key is counted, never rewritten, and named with the fix', () => withEnv(env, async () => {
    const sourceId = await newSource(engine(), mkdtempSync(join(home, 'doctor-stored-')));
    await put(sourceId, 'notes/legacy-upper', { Readable_By: ['alice-example'] });
    await put(sourceId, 'notes/legacy-hyphen', { 'readable-by': ['alice-example'] });
    await put(sourceId, 'notes/legacy-both', { readable_by: ['alice-example'], readableBy: ['bob-example'] });
    await put(sourceId, 'notes/exact', { readable_by: ['alice-example'] });
    await put(sourceId, 'notes/plain', { title: 'Plain' });
    await put(sourceId, 'notes/nested', { meta: { Readable_By: ['alice-example'] } });
    const before = await engine().executeRaw<{ slug: string; frontmatter: unknown }>('SELECT slug, frontmatter FROM pages WHERE source_id=$1 ORDER BY slug', [sourceId]);
    const doctor = await gitHeldFilesCheck(engine(), [sourceId]);
    expect(doctor.details?.readers_noncanonical).toEqual({ held: 0, stored: 3 });
    expect(doctor.status).toBe('warn');
    expect(doctor.message).toContain('3 stored page(s)');
    expect(doctor.message).toContain('readable_by');
    for (const text of FIX_TEXT) expect(`${doctor.message} ${JSON.stringify(doctor.fix)}`).toContain(text);
    expect(await engine().executeRaw('SELECT slug, frontmatter FROM pages WHERE source_id=$1 ORDER BY slug', [sourceId])).toEqual(before);
  }), 180_000);

  test('a brain with no misspelled readers key reports no readers_noncanonical detail', () => withEnv(env, async () => {
    const sourceId = await newSource(engine(), mkdtempSync(join(home, 'doctor-clean-')));
    await put(sourceId, 'notes/exact', { readable_by: ['alice-example'] });
    const doctor = await gitHeldFilesCheck(engine(), [sourceId]);
    expect(doctor.details?.readers_noncanonical).toBeUndefined();
    expect(doctor.status).toBe('ok');
  }), 180_000);

  test('files held readers_noncanonical are counted beside the stored pages', () => withEnv(env, async () => {
    await engine().executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const root = mkdtempSync(join(home, 'doctor-held-'));
    git(root, 'init', '-q');
    writeTree(root, KEPT);
    commit(root, 'seed');
    const sourceId = await newSource(engine(), root);
    const sync = () => performSync(engine(), { repoPath: root, sourceId, noPull: true, noEmbed: true, noExtract: true, concurrency: 1 });
    await sync();
    writeTree(root, HELD);
    commit(root, 'misspell the key');
    await sync();
    await put(sourceId, 'notes/legacy-upper', { Readable_By: ['alice-example'] });
    const doctor = await gitHeldFilesCheck(engine(), [sourceId]);
    expect(doctor.details?.readers_noncanonical).toEqual({ held: paths(HELD).length, stored: 1 });
  }), 180_000);
});

describe('the readers_noncanonical fix text says what the rename does and how to check it', () => {
  const record = { source_id: 'source-a', path: 'notes/upper-key.md', slug: 'notes/upper-key', code: 'readers_noncanonical', meta: {} } as Parameters<typeof gitHoldFix>[0];

  test('the local message and suggestion of a refused write', async () => {
    await brain(false, async (ctx) => {
      const refused = await (putPage.handler(ctx, { slug: 'notes/keycase', content: page('Readable_By: [alice-example]\n'), request_id: randomUUID(), wait_ms: 25_000 }) as Promise<Outcome>).catch((e: any) => e);
      const text = `${refused.message} ${refused.suggestion ?? ''} ${JSON.stringify(refused.details ?? {})}`;
      for (const part of FIX_TEXT) expect(text).toContain(part);
    });
  }, 120_000);

  test('the file ingestion message of a held file', () => {
    const hold = noncanonicalReadersHold(note('Upper key', 'Readable_By: [alice-example]\n'), { Readable_By: ['alice-example'] })!;
    for (const part of FIX_TEXT) expect(hold.message).toContain(part);
  });

  test('the sync hold fix user_message', () => {
    const fix = gitHoldFix(record);
    for (const part of FIX_TEXT) expect(fix.user_message).toContain(part);
    expect(fix.user_message).toContain('gbrain sync --source source-a --no-pull');
  });

  test('the docs anchor', () => {
    const row = readFileSync(join(import.meta.dir, '..', 'docs/guides/write-refusals.md'), 'utf8').split('\n').find(line => line.includes('<a id="readers_noncanonical">'))!;
    for (const part of FIX_TEXT) expect(row).toContain(part);
  });
});

describe('the remote get_page.file_held fix for a readers_noncanonical hold', () => {
  const hold = (code: string): GitHoldRecord => ({ version: 1, source_id: 'source-a', incarnation: 'i1', path: 'notes/Readable_By-secret.md', source_path: 'notes/Readable_By-secret.md', slug: 'notes/secret', page_id: 1,
    code, meta: {}, held_at: '2026-11-20T00:00:00.000Z' } as unknown as GitHoldRecord);

  test('routes to the file edit, never to repair frontmatter, and leaves out the path and the key spelling', () => {
    expect(recordRoute({ code: 'readers_noncanonical' })).toMatchObject({ fences: 0, others: 0, readers: 1 });
    const field = fileHeldField({ record: hold('readers_noncanonical'), revision: 'r1' }, true);
    const fix = field.fix as { argv?: string[]; user_message?: string };
    const text = JSON.stringify(field);
    expect(field).not.toHaveProperty('path');
    expect(text).not.toContain('repair frontmatter');
    expect(text).not.toContain('Readable_By');
    expect(text).not.toContain('notes/secret.md');
    expect(fix.argv).not.toContain('repair');
    expect(`${fix.user_message}`).toContain('readable_by');
    for (const part of FIX_TEXT) expect(`${fix.user_message}`).toContain(part);
  });

  test('a local caller still gets the hold fix with the path', () => {
    const field = fileHeldField({ record: hold('readers_noncanonical'), revision: 'r1' }, false);
    expect(field).toMatchObject({ code: 'readers_noncanonical', path: 'notes/Readable_By-secret.md' });
    expect(field.fix.user_message).toContain('notes/Readable_By-secret.md');
  });

  test('the visibility_noncanonical route is unchanged (a follow-up owns it)', () => {
    expect(recordRoute({ code: 'visibility_noncanonical' })).toEqual({ fences: 0, others: 1 });
    expect(JSON.stringify(fileHeldField({ record: hold('visibility_noncanonical'), revision: 'r1' }, true))).toContain('repair frontmatter');
  });
});
