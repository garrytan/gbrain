import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { addSource, setSourceKindDirectory } from '../src/core/sources-ops.ts';
import { performSync } from '../src/commands/sync.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import {
  __deferredEmbedsPendingForTests,
  __deferredExtractionsPendingForTests,
  __resetDelegatedSyncForTests,
} from '../src/core/serve-sync-runner.ts';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
let root: string;
let oldHome: string | undefined;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
});

beforeEach(async () => {
  await disposePersistenceConsumer(engine);
  await resetPgliteState(engine);
  __resetDelegatedSyncForTests();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-directory-source-'));
  oldHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = path.join(root, 'state');
  resetGateway();
});

afterEach(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await disposePersistenceConsumer(engine);
  if (oldHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = oldHome;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('directory source sync', () => {
  test('large git-less directory initial sync imports 5,000 markdown files without a spurious timeout', async () => {
    const vault = path.join(root, 'vault');
    fs.mkdirSync(vault, { recursive: true });
    for (let i = 0; i < 5_000; i++) {
      fs.writeFileSync(path.join(vault, `note-${String(i).padStart(4, '0')}.md`), `# Note ${i}\n\nBody ${i}.\n`);
    }
    await addSource(engine, { id: 'vault', localPath: vault, directory: {} });

    const result = await performSync(engine, { sourceId: 'vault', noEmbed: true, noExtract: true });

    expect(result.status).toBe('first_sync');
    expect(result.reason).toBeUndefined();
    expect(result.added).toBe(5_000);
    expect(result.modified).toBe(0);
    expect(await engine.getPage('note-0000', { sourceId: 'vault' })).not.toBeNull();
    expect(await engine.getPage('note-4999', { sourceId: 'vault' })).not.toBeNull();
    expect(fs.existsSync(path.join(vault, '.git'))).toBe(false);
  }, 180_000);

  test('large-directory incremental sync imports exactly the two changed files', async () => {
    const vault = path.join(root, 'vault');
    fs.mkdirSync(vault, { recursive: true });
    for (let i = 0; i < 40; i++) {
      fs.writeFileSync(path.join(vault, `note-${String(i).padStart(2, '0')}.md`), `# Note ${i}\n\nFirst ${i}.\n`);
    }
    await addSource(engine, { id: 'vault', localPath: vault, directory: {} });
    await performSync(engine, { sourceId: 'vault', noEmbed: true, noExtract: true });

    fs.writeFileSync(path.join(vault, 'note-07.md'), '# Note 7\n\nChanged seven.\n');
    fs.writeFileSync(path.join(vault, 'note-31.md'), '# Note 31\n\nChanged thirty-one.\n');
    const result = await performSync(engine, { sourceId: 'vault', noEmbed: true, noExtract: true });

    expect(result.status).toBe('synced');
    expect(result.added).toBe(0);
    expect(result.modified).toBe(2);
    expect(result.reason).toBeUndefined();
    expect((await engine.getPage('note-07', { sourceId: 'vault' }))?.compiled_truth).toContain('Changed seven.');
    expect((await engine.getPage('note-31', { sourceId: 'vault' }))?.compiled_truth).toContain('Changed thirty-one.');
  });

  test('timeout with zero imports does not advance the directory watermark', async () => {
    const vault = path.join(root, 'vault');
    fs.mkdirSync(vault, { recursive: true });
    const note = path.join(vault, 'page.md');
    fs.writeFileSync(note, '# Page\n\nFirst.\n');
    await addSource(engine, { id: 'vault', localPath: vault, directory: {} });
    await performSync(engine, { sourceId: 'vault', noEmbed: true, noExtract: true });
    const watermark = path.join(process.env.GBRAIN_HOME!, '.gbrain', 'directory-sync', 'vault.json');
    const before = fs.readFileSync(watermark, 'utf8');

    fs.writeFileSync(note, '# Page\n\nChanged but cancelled.\n');
    const controller = new AbortController();
    controller.abort();
    const timedOut = await performSync(engine, {
      sourceId: 'vault', noEmbed: true, noExtract: true, signal: controller.signal,
    });

    expect(timedOut.status).toBe('partial');
    expect(timedOut.reason).toBe('timeout');
    expect(timedOut.filesImported).toBe(0);
    expect(fs.readFileSync(watermark, 'utf8')).toBe(before);

    const retry = await performSync(engine, { sourceId: 'vault', noEmbed: true, noExtract: true });
    expect(retry.status).toBe('synced');
    expect(retry.modified).toBe(1);
    expect((await engine.getPage('page', { sourceId: 'vault' }))?.compiled_truth).toContain('Changed but cancelled.');
  });

  test('directory import failures are blocked failures, never mislabeled as timeout', async () => {
    const vault = path.join(root, 'vault');
    fs.mkdirSync(vault, { recursive: true });
    fs.writeFileSync(path.join(vault, 'valid.md'), '# Valid\n');
    fs.writeFileSync(path.join(vault, 'invalid.md'), '---\nslug: [broken\n---\n# Invalid\n');
    await addSource(engine, { id: 'vault', localPath: vault, directory: {} });

    const result = await performSync(engine, { sourceId: 'vault', noEmbed: true, noExtract: true });

    expect(result.status).toBe('blocked_by_failures');
    expect(result.reason).toBeUndefined();
    expect(result.failedFiles).toBe(1);
    expect(result.added).toBe(1);
    expect(await engine.getPage('valid', { sourceId: 'vault' })).not.toBeNull();
    expect(await engine.getPage('invalid', { sourceId: 'vault' })).toBeNull();
  });

  test('git-less directory demo: register, sync, edit, re-sync, and update with no .git anywhere', async () => {
    const vault = path.join(root, 'vault');
    fs.mkdirSync(path.join(vault, 'Garden'), { recursive: true });
    const note = path.join(vault, 'Garden', 'Bed.md');
    fs.writeFileSync(note, '# Bed\n\nFirst crop.\n');
    await addSource(engine, { id: 'vault', localPath: vault, directory: {} });

    const first = await performSync(engine, { sourceId: 'vault', noEmbed: true, noExtract: true });
    expect(first.status).toBe('first_sync');
    expect(first.added).toBe(1);
    expect(fs.existsSync(path.join(vault, '.git'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.git'))).toBe(false);

    fs.writeFileSync(note, '# Bed\n\nSecond crop, updated.\n');
    const second = await performSync(engine, { sourceId: 'vault', noEmbed: true, noExtract: true });
    const page = await engine.getPage('garden/bed', { sourceId: 'vault' });

    expect(second.status).toBe('synced');
    expect(second.modified).toBe(1);
    expect(page?.compiled_truth).toContain('Second crop, updated.');
    expect(fs.existsSync(path.join(vault, '.git'))).toBe(false);
  });

  test('put_page persists a directory-source page and updates its recorded file', async () => {
    const worktree = path.join(root, 'worktree');
    fs.mkdirSync(worktree, { recursive: true });
    execFileSync('git', ['init', worktree], { stdio: 'ignore' });
    const vault = path.join(worktree, 'vault');
    fs.mkdirSync(path.join(vault, 'Example Garden'), { recursive: true });
    await addSource(engine, { id: 'vault', localPath: vault, directory: {} });
    const putPage = operations.find(operation => operation.name === 'put_page')!;
    const ctx: OperationContext = {
      engine,
      config: { engine: 'pglite', embedding_disabled: true },
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote: false,
      sourceId: 'vault',
    };
    const first = await putPage.handler(ctx, {
      slug: 'example-garden/bed-notes',
      content: '---\ntype: note\ntitle: Bed Notes\n---\n\nFirst crop.\n',
    }) as Record<string, unknown>;
    const file = path.join(vault, 'Example Garden', 'bed-notes.md');

    expect(first.state).toBe('committed');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toContain('First crop.');
    expect(fs.existsSync(path.join(vault, '.git'))).toBe(false);
    const created = await engine.readPageSnapshot('example-garden/bed-notes', { sourceId: 'vault' });
    expect(created?.page.source_path).toBe('Example Garden/bed-notes.md');

    const second = await putPage.handler(ctx, {
      slug: 'example-garden/bed-notes',
      content: '---\ntype: note\ntitle: Bed Notes\n---\n\nSecond crop.\n',
      expected_revision: created?.revision,
    }) as Record<string, unknown>;

    expect(second.state).toBe('committed');
    expect(fs.readFileSync(file, 'utf8')).toContain('Second crop.');
    expect((await engine.readPageSnapshot('example-garden/bed-notes', { sourceId: 'vault' }))?.page.source_path)
      .toBe('Example Garden/bed-notes.md');
    expect(fs.existsSync(path.join(vault, 'example-garden', 'bed-notes.md'))).toBe(false);
  });

  test('put_page cannot write through a directory-source exclude fence', async () => {
    const vault = path.join(root, 'vault');
    fs.mkdirSync(vault, { recursive: true });
    await addSource(engine, { id: 'vault', localPath: vault, directory: { exclude: ['private/**'] } });
    const putPage = operations.find(operation => operation.name === 'put_page')!;
    const ctx: OperationContext = {
      engine,
      config: { engine: 'pglite', embedding_disabled: true },
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote: false,
      sourceId: 'vault',
    };

    await expect(putPage.handler(ctx, {
      slug: 'private/secret',
      content: '---\ntype: note\ntitle: Secret\n---\n\nExcluded.\n',
    })).rejects.toThrow(/excluded by the directory source policy/);
    expect(await engine.getPage('private/secret', { sourceId: 'vault' })).toBeNull();
    expect(fs.existsSync(path.join(vault, 'private', 'secret.md'))).toBe(false);
  });

  test('exclude globs fence both walk and reconcile', async () => {
    const vault = path.join(root, 'vault');
    fs.mkdirSync(path.join(vault, 'public'), { recursive: true });
    fs.mkdirSync(path.join(vault, 'private'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'public', 'yes.md'), '# Yes\n');
    fs.writeFileSync(path.join(vault, 'private', 'no.md'), '# No\n');
    await addSource(engine, { id: 'vault', localPath: vault, directory: { exclude: ['private/**'] } });

    await performSync(engine, { sourceId: 'vault', noEmbed: true, noExtract: true });

    expect(await engine.getPage('public/yes', { sourceId: 'vault' })).not.toBeNull();
    expect(await engine.getPage('private/no', { sourceId: 'vault' })).toBeNull();
  });

  test('directory sync defers embed and extract by default', async () => {
    const vault = path.join(root, 'vault');
    fs.mkdirSync(vault, { recursive: true });
    fs.writeFileSync(path.join(vault, 'page.md'), '# Deferred\n');
    await addSource(engine, { id: 'vault', localPath: vault, directory: {} });

    const result = await performSync(engine, { sourceId: 'vault' });

    expect(result.embedded).toBe(0);
    expect(__deferredEmbedsPendingForTests()).toBe(true);
    expect(__deferredExtractionsPendingForTests()).toBe(true);
  });

  test('directory sync embeds inline only when explicitly requested', async () => {
    const vault = path.join(root, 'vault');
    fs.mkdirSync(vault, { recursive: true });
    fs.writeFileSync(path.join(vault, 'page.md'), '# Inline\n\nA useful directory note.\n');
    await addSource(engine, { id: 'vault', localPath: vault, directory: {} });
    let embeddedInputs = 0;
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'sk-test' },
    });
    __setEmbedTransportForTests(async ({ values }: { values: string[] }) => {
      embeddedInputs += values.length;
      return {
        embeddings: values.map(() => new Array(1536).fill(0.01)),
        usage: { tokens: values.length },
      } as never;
    });

    const result = await performSync(engine, {
      sourceId: 'vault', embedInline: true, noExtract: true,
    });

    expect(result.embedded).toBe(1);
    expect(embeddedInputs).toBeGreaterThan(0);
    expect(__deferredEmbedsPendingForTests()).toBe(false);
  });

  test('delete reconcile soft-deletes a missing file only with explicit force above 10%', async () => {
    const vault = path.join(root, 'vault');
    fs.mkdirSync(vault, { recursive: true });
    const note = path.join(vault, 'gone.md');
    fs.writeFileSync(note, '# Gone\n');
    await addSource(engine, { id: 'vault', localPath: vault, directory: {} });
    await performSync(engine, { sourceId: 'vault', noEmbed: true, noExtract: true });
    fs.unlinkSync(note);
    fs.writeFileSync(path.join(vault, '.dropbox'), 'keeps root non-empty');

    await expect(performSync(engine, { sourceId: 'vault', noEmbed: true, noExtract: true }))
      .rejects.toThrow(/reconcile refused/);
    expect(await engine.getPage('gone', { sourceId: 'vault' })).not.toBeNull();

    const forced = await performSync(engine, {
      sourceId: 'vault', noEmbed: true, noExtract: true, forceReconcile: true,
    });
    expect(forced.deleted).toBe(1);
    expect(await engine.getPage('gone', { sourceId: 'vault' })).toBeNull();
  });

  test('vanished or empty roots never reconcile pages away, even with force', async () => {
    const vault = path.join(root, 'vault');
    fs.mkdirSync(vault, { recursive: true });
    fs.writeFileSync(path.join(vault, 'kept.md'), '# Kept\n');
    await addSource(engine, { id: 'vault', localPath: vault, directory: {} });
    await performSync(engine, { sourceId: 'vault', noEmbed: true, noExtract: true });

    fs.rmSync(vault, { recursive: true });
    await expect(performSync(engine, { sourceId: 'vault', forceReconcile: true, noEmbed: true, noExtract: true }))
      .rejects.toThrow(/missing or not a directory/);
    expect(await engine.getPage('kept', { sourceId: 'vault' })).not.toBeNull();

    fs.mkdirSync(vault);
    await expect(performSync(engine, { sourceId: 'vault', forceReconcile: true, noEmbed: true, noExtract: true }))
      .rejects.toThrow(/root is empty/);
    expect(await engine.getPage('kept', { sourceId: 'vault' })).not.toBeNull();
  });

  test('set-kind directory preserves existing pages while removing git ownership config', async () => {
    const vault = path.join(root, 'vault');
    fs.mkdirSync(vault, { recursive: true });
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config) VALUES ($1,$2,$3,$4::text::jsonb)`,
      ['vault', 'Vault', vault, JSON.stringify({ remote_url: 'https://example.invalid/vault.git', managed_clone: true })],
    );
    await importFromContent(engine, 'kept/page', '# Kept\n', { noEmbed: true, sourceId: 'vault' });

    const source = await setSourceKindDirectory(engine, 'vault', ['tmp/**']);

    expect(source.config).toMatchObject({ kind: 'directory', exclude: ['tmp/**'] });
    expect(source.config.remote_url).toBeUndefined();
    expect(source.config.managed_clone).toBeUndefined();
    expect(await engine.getPage('kept/page', { sourceId: 'vault' })).not.toBeNull();
  });
});
