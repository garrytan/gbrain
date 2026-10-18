/**
 * A segmented page over the single-string ceiling edited down to within it (Wave B).
 *
 * 1. Protects: a page imported streamed (body over PAGE_MAX_BYTES, its body
 *    never read back as one string) is rewritten by the string paths once its
 *    file shrinks: an unmanaged importFromContent (here demoting it inline),
 *    a managed file import and a managed sync each publish the smaller body,
 *    which round-trips byte-identical. The unread stored body compares unequal
 *    to the new one and contributes no fence or timeline rows of its own.
 * 2. Fails when: a comparison, fence merge, page spread or canonical
 *    projection reads the unread body and refuses with page_body_segmented.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent, importFromFile } from '../../src/core/import-file.ts';
import { parseMarkdown } from '../../src/core/markdown.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { importManagedFile } from '../../src/core/persistence/import-mutations.ts';
import { performManagedSync } from '../../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';
import { conversationPage } from '../helpers/conversation-page.ts';
import { reconstructedPage, segmentedPageRow } from '../helpers/segmented-page-checks.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-segmented-shrink-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const huge = conversationPage(PAGE_MAX_BYTES + 1024 * 1024, { seed: 71 });
const shrunk = conversationPage(2 * 1024 * 1024, { seed: 71 });

function git(root: string, ...args: string[]): string { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function commit(root: string): void { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'test content'); }

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);

afterAll(async () => {
  await withEnv(env, async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    await closePostgres?.();
  });
  rmSync(home, { recursive: true, force: true });
});

async function managedSource(engine: BrainEngine, root: string) {
  const sourceId = `shrink-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
  await registerLocalWriter(engine, 'cli');
  await claimWorktree(engine, sourceId, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return sourceId;
}

async function expectStreamed(engine: BrainEngine, slug: string, sourceId: string) {
  const row = (await engine.executeRaw<{ body_bytes: string }>('SELECT body_bytes::text AS body_bytes FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]))[0];
  expect(Number(row?.body_bytes)).toBeGreaterThan(PAGE_MAX_BYTES);
}

async function expectBody(engine: BrainEngine, slug: string, sourceId: string, content: string) {
  const { page, body, hash } = await reconstructedPage(engine, slug, sourceId);
  expect(page.body_storage).toBe('segmented');
  expect(body.compiled_truth).toBe(parseMarkdown(content, `${slug}.md`).compiled_truth);
  expect(page.content_hash).toBe(hash);
}

test('unmanaged: importFromContent rewrites a streamed page with a body within the ceiling', async () => withEnv(env, async () => {
  for (const engine of engines) {
    await engine.setConfig('pages.segmented_storage', 'on');
    const dir = join(home, `unmanaged-${randomUUID().slice(0, 8)}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'huge.md');
    writeFileSync(file, huge);
    const slug = `notes/shrink-${randomUUID().slice(0, 8)}`;
    expect(await importFromFile(engine, file, `${slug}.md`, { noEmbed: true, bodyPolicy: await readPageBodyPolicy(engine) })).toMatchObject({ status: 'imported' });
    await expectStreamed(engine, slug, 'default');
    const small = '---\ntitle: Conversation log\ntype: note\n---\n\nA short summary of the conversation.\n';
    expect(await importFromContent(engine, slug, small, { noEmbed: true })).toMatchObject({ slug, status: 'imported' });
    const page = await segmentedPageRow(engine, slug);
    expect(page.body_storage).toBe('inline');
    expect((await engine.getPage(slug))?.compiled_truth).toBe(parseMarkdown(small, `${slug}.md`).compiled_truth);
  }
}), 600_000);

test('managed import: a shrunk file publishes over a streamed page', async () => withEnv(env, async () => {
  for (const engine of engines) {
    await disposePersistenceConsumer(engine);
    await engine.setConfig('pages.segmented_storage', 'on');
    const root = join(home, `import-${randomUUID().slice(0, 8)}`);
    mkdirSync(join(root, 'notes'), { recursive: true });
    const sourceId = await managedSource(engine, root);
    const file = join(root, 'notes/huge.md');
    writeFileSync(file, huge);
    expect(await importManagedFile(engine, file, 'notes/huge.md', { sourceId, noEmbed: true })).toMatchObject({ status: 'imported' });
    await expectStreamed(engine, 'notes/huge', sourceId);
    writeFileSync(file, shrunk);
    expect(await importManagedFile(engine, file, 'notes/huge.md', { sourceId, noEmbed: true })).toMatchObject({ slug: 'notes/huge', status: 'imported' });
    await expectBody(engine, 'notes/huge', sourceId, shrunk);
    await disposePersistenceConsumer(engine);
  }
}), 600_000);

test('managed sync: a shrunk file syncs over a streamed page', async () => withEnv(env, async () => {
  for (const engine of engines) {
    await disposePersistenceConsumer(engine);
    await engine.setConfig('pages.segmented_storage', 'on');
    const root = join(home, `sync-${randomUUID().slice(0, 8)}`);
    mkdirSync(join(root, 'notes'), { recursive: true });
    git(root, 'init', '-q');
    const file = join(root, 'notes/huge.md');
    writeFileSync(file, huge);
    commit(root);
    const sourceId = await managedSource(engine, root);
    expect(await importManagedFile(engine, file, 'notes/huge.md', { sourceId, noEmbed: true })).toMatchObject({ status: 'imported' });
    await disposePersistenceConsumer(engine);
    await performManagedSync(engine, { sourceId, noPull: true });
    await expectStreamed(engine, 'notes/huge', sourceId);
    writeFileSync(file, shrunk);
    commit(root);
    expect(await performManagedSync(engine, { sourceId, noPull: true })).toMatchObject({ status: 'synced', modified: 1 });
    await expectBody(engine, 'notes/huge', sourceId, shrunk);
    await disposePersistenceConsumer(engine);
  }
}), 600_000);
