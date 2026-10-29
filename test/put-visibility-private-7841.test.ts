/**
 * #7841: a page write that asks for `visibility: private` publishes a private
 * page or is refused with `visibility_not_applied`; it never commits, or
 * reports a no-op, while the page stays world-readable.
 *
 * Before the fix `visibility: Private` (or `Visibility: private`) on an existing
 * world page committed as success and the page stayed world-readable: page
 * privacy reads only the exact lowercase key and value. A plain
 * `visibility: private` keeps working: the supported way to make a page
 * private. Runs on a repo-less brain and on a managed brain with a Git
 * checkout, on PGLite and, with DATABASE_URL, Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { operations } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { declaredVisibilities, readPrivateRequest } from '../src/core/persistence/visibility-request.ts';
import { isPrivatePage } from '../src/core/search/private-visibility.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let dataDir: string;
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'gbrain-7841-db-'));
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
});

const putPage = operations.find(op => op.name === 'put_page')!;
const editPage = operations.find(op => op.name === 'edit_page')!;
const capturePage = operations.find(op => op.name === 'capture')!;
const page = (extra = '') => `---\ntitle: Example\ntype: note\n${extra}---\nA page about acme-example.\n`;
type Outcome = Record<string, any> & { thrown?: string; message?: string };
const put = (ctx: OperationContext, slug: string, content: string, expectedRevision?: string): Promise<Outcome> =>
  (putPage.handler(ctx, { slug, content, request_id: randomUUID(), wait_ms: 25_000, ...(expectedRevision ? { expected_revision: expectedRevision } : {}) }) as Promise<Outcome>)
    .catch((e: { code?: string; message?: string }) => ({ thrown: e.code, message: e.message }));

/** A source per run: repo-less (no Git) or a managed checkout with Git. */
async function brain(managed: boolean, run: (ctx: OperationContext, engine: BrainEngine) => Promise<void>) {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-7841-'));
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

test('declaredVisibilities reads the frontmatter block only, any key case, lowercased values', () => {
  expect(declaredVisibilities(page('visibility: private\n'))).toEqual(['private']);
  expect(declaredVisibilities(page('Visibility: "Private" # hidden\n'))).toEqual(['private']);
  expect(declaredVisibilities(page('summary: >\n  visibility: private\n'))).toEqual([]);
  expect(declaredVisibilities('A body.\nvisibility: private\n')).toEqual([]);
  expect(declaredVisibilities('---\nvisibility: private\n')).toEqual([]);
  expect(declaredVisibilities('\uFEFF\n\n---\r\nvisibility: private\r\n---\r\nA body.\r\n')).toEqual(['private']);
  expect(declaredVisibilities('---\nvisibility: private\n...\nA body.\n')).toEqual(['private']);
  expect(declaredVisibilities(page('"visibility": private # keep\n'))).toEqual(['private']);
  expect(declaredVisibilities(page('visibility: private\nvisibility: public\n'))).toEqual(['private', 'public']);
});

test('readPrivateRequest rethrows a parse failure when a visibility line asks for private, and passes it otherwise', () => {
  const failing = () => { throw new Error('bad frontmatter'); };
  expect(() => readPrivateRequest(page('visibility: private\n'), failing)).toThrow('bad frontmatter');
  expect(readPrivateRequest(page('visibility: public\n'), failing)).toBeNull();
  expect(readPrivateRequest(page(), failing)).toBeNull();
});

for (const managed of [false, true]) describe(`${managed ? 'managed brain with a Git checkout' : 'repo-less brain'}: put_page visibility: private (#7841)`, () => {
  test('edit_page and capture refuse a private request they would store as Visibility: Private', async () => {
    await brain(managed, async (ctx, engine) => {
      await put(ctx, 'notes/example', page());
      const before = (await snapshot(engine, ctx, 'notes/example'))!;
      const edited = await (editPage.handler(ctx, { slug: 'notes/example', expected_revision: before.revision, request_id: randomUUID(), wait_ms: 25_000,
        edits: [{ old_text: 'title: Example', new_text: 'title: Example\nVisibility: Private' }] }) as Promise<Outcome>)
        .catch((e: { code?: string; message?: string }) => ({ thrown: e.code, message: e.message }));
      expect(edited.thrown).toBe('visibility_not_applied');
      const unchanged = (await snapshot(engine, ctx, 'notes/example'))!;
      expect(unchanged.revision).toBe(before.revision);
      const captured = await (capturePage.handler(ctx, { slug: 'notes/captured', content: page('Visibility: Private\n'), request_id: randomUUID(), wait_ms: 25_000 }) as Promise<Outcome>)
        .catch((e: { code?: string; message?: string }) => ({ thrown: e.code, message: e.message }));
      expect(captured.thrown).toBe('visibility_not_applied');
      expect(await snapshot(engine, ctx, 'notes/captured')).toBeNull();
    });
  }, 120_000);

  test('an existing world page turned private with visibility: private publishes private', async () => {
    await brain(managed, async (ctx, engine) => {
      const first = await put(ctx, 'notes/example', page());
      expect(first.thrown).toBeUndefined();
      const before = (await snapshot(engine, ctx, 'notes/example'))!;
      expect(isPrivatePage(before.page)).toBe(false);
      const turned = await put(ctx, 'notes/example', page('visibility: private\n'), before.revision);
      expect(turned.thrown).toBeUndefined();
      const after = (await snapshot(engine, ctx, 'notes/example'))!;
      expect(after.page.frontmatter.visibility).toBe('private');
      expect(isPrivatePage(after.page)).toBe(true);
    });
  }, 120_000);

  for (const [label, extra] of [['visibility: Private', 'visibility: Private\n'], ['Visibility: private', 'Visibility: private\n'], ['VISIBILITY: "PRIVATE"', 'VISIBILITY: "PRIVATE"\n'],
    ['visibility with Private on the next line', 'visibility:\n  Private\n'], ['visibility as a block scalar', 'visibility: |\n  private\n'], ['visibility as a flow list', 'visibility: [private]\n'],
    ['an explicit key', '? visibility\n: Private\n'], ['a merge key', 'base: &base\n  Visibility: Private\n<<: *base\n'], ['an escaped key', '"Visib\\u0069lity": Private\n']] as const) {
    test(`${label} on an existing world page is refused noncanonical_value, and the page and its revision are unchanged`, async () => {
      await brain(managed, async (ctx, engine) => {
        await put(ctx, 'notes/example', page());
        const before = (await snapshot(engine, ctx, 'notes/example'))!;
        const result = await put(ctx, 'notes/example', page(extra), before.revision);
        expect(result.thrown).toBe('visibility_not_applied');
        expect(result.message).toContain('(noncanonical_value). Write visibility: private on its own frontmatter line');
        const after = (await snapshot(engine, ctx, 'notes/example'))!;
        expect(after.revision).toBe(before.revision);
        expect(after.page.frontmatter).toEqual(before.page.frontmatter);
      });
    }, 120_000);
  }

  test('a flow-mapping frontmatter that spells Visibility: Private is refused, and the page is unchanged', async () => {
    await brain(managed, async (ctx, engine) => {
      await put(ctx, 'notes/example', page());
      const before = (await snapshot(engine, ctx, 'notes/example'))!;
      const result = await put(ctx, 'notes/example', '---\n{title: Example, type: note, Visibility: Private}\n---\nA page about acme-example.\n', before.revision);
      expect(result.thrown).toBe('visibility_not_applied');
      expect((await snapshot(engine, ctx, 'notes/example'))!.revision).toBe(before.revision);
    });
  }, 120_000);

  test('a quoted key with a trailing comment still publishes private, with CRLF line endings too', async () => {
    await brain(managed, async (ctx, engine) => {
      for (const [slug, content] of [['notes/quoted', page('"visibility": private # keep\n')], ['notes/crlf', page('visibility: private\n').replace(/\n/g, '\r\n')]] as const) {
        expect((await put(ctx, slug, content)).thrown).toBeUndefined();
        expect(isPrivatePage((await snapshot(engine, ctx, slug))!.page)).toBe(true);
      }
    });
  }, 120_000);

  test('a remote caller is refused the same way, and its plain private request still publishes private', async () => {
    await brain(managed, async (ctx, engine) => {
      const remote = { ...ctx, remote: true };
      await put(ctx, 'notes/example', page());
      const before = (await snapshot(engine, ctx, 'notes/example'))!;
      expect(await put(remote, 'notes/example', page('visibility: Private\n'), before.revision)).toMatchObject({ thrown: 'visibility_not_applied' });
      expect((await snapshot(engine, ctx, 'notes/example'))!.revision).toBe(before.revision);
      expect((await put(remote, 'notes/remote-example', page('visibility: private\n'))).thrown).toBeUndefined();
      expect(isPrivatePage((await snapshot(engine, ctx, 'notes/remote-example'))!.page)).toBe(true);
    });
  }, 120_000);

  test('a new page created with visibility: Private is refused, never stored world-readable', async () => {
    await brain(managed, async (ctx, engine) => {
      expect(await put(ctx, 'notes/new-example', page('visibility: Private\n'))).toMatchObject({ thrown: 'visibility_not_applied' });
      expect(await snapshot(engine, ctx, 'notes/new-example')).toBeNull();
    });
  }, 120_000);

  test('a remote put_page on an always_load page keeps a private request even when the server rewrites the content (core marking carry)', async () => {
    await brain(managed, async (ctx, engine) => {
      await put(ctx, 'notes/example', page('always_load: true\n'));
      const before = (await snapshot(engine, ctx, 'notes/example'))!;
      expect(before.page.frontmatter.always_load).toBe(true);
      const remote = { ...ctx, remote: true };
      for (const [extra, code] of [['Visibility: Private\n', 'visibility_not_applied'], ['visibility:\n  - private\n', 'visibility_not_applied'],
        ['visibility: private\nfoo: [unclosed\n', 'invalid_params'], ['visibility: private\nvisibility: world\n', 'invalid_params']] as const) {
        const result = await put(remote, 'notes/example', page(extra), before.revision);
        expect(result.thrown).toBe(code);
        const after = (await snapshot(engine, ctx, 'notes/example'))!;
        expect(after.revision).toBe(before.revision);
        expect(isPrivatePage(after.page)).toBe(false);
      }
    });
  }, 120_000);

  test('an unchanged private page re-put with visibility: private is still a no-op', async () => {
    await brain(managed, async (ctx, engine) => {
      await put(ctx, 'notes/example', page('visibility: private\n'));
      const before = (await snapshot(engine, ctx, 'notes/example'))!;
      const again = await put(ctx, 'notes/example', page('visibility: private\n'), before.revision);
      expect(again.thrown).toBeUndefined();
      expect((await snapshot(engine, ctx, 'notes/example'))!.revision).toBe(before.revision);
    });
  }, 120_000);
});

test('a derived write (add_tag) on a page that already stores Visibility: Private is not refused: the guard governs authored content only', async () => {
  await brain(false, async (ctx, engine) => {
    const [{ local_path: root }] = await engine.executeRaw<{ local_path: string }>('SELECT local_path FROM sources WHERE id=$1', [ctx.sourceId]);
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes/legacy.md'), page('Visibility: Private\n'));
    await importFromContent(engine, 'notes/legacy', page('Visibility: Private\n'), { sourceId: ctx.sourceId, noEmbed: true });
    const addTag = operations.find(op => op.name === 'add_tag')!;
    const result = await (addTag.handler(ctx, { slug: 'notes/legacy', tag: 'alice-example', request_id: randomUUID(), wait_ms: 25_000 }) as Promise<Outcome>)
      .catch((e: { code?: string }) => ({ thrown: e.code }));
    expect(result.thrown).toBeUndefined();
    expect((await engine.getTags('notes/legacy', { sourceId: ctx.sourceId })).includes('alice-example')).toBe(true);
  });
}, 120_000);
