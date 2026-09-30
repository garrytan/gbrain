import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import { extractTakesFromPages } from '../src/core/extract-takes-from-pages.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { parseTakesFence } from '../src/core/takes-fence.ts';
import { activatePersistence } from '../src/core/persistence/activation.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase } from './helpers/test-backends.ts';

// Postgres runs through test/e2e/persistence-managed-takes-extract.test.ts.
const backend = process.env.GBRAIN_TEST_BACKEND === 'postgres' ? 'postgres' : 'pglite';
let closeEngine: () => Promise<void> = async () => {};

const BODY = 'A durable opinion with enough context to be classified as a stable claim. '.repeat(5);
const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-takes-extract-'));
const repo = join(home, 'canonical');
let engine: BrainEngine;
let chatSlug: string | undefined;
let editStaleDuringChat = false;

beforeAll(async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SOURCE: undefined, GBRAIN_BRAIN_ID: 'host' }, async () => {
  const fixture = await isolatedSharedSkillsEngine(backend === 'postgres' ? requirePostgresTestDatabase() : undefined);
  engine = fixture.engine; closeEngine = fixture.close;
  mkdirSync(join(repo, 'concepts'), { recursive: true });
  await engine.setConfig('sync.repo_path', repo);
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [repo]);
  configureGateway({ chat_model: 'anthropic:claude-haiku-4-5-20251001', env: { ANTHROPIC_API_KEY: 'test-key' } });
  __setChatTransportForTests(async opts => {
      const user = opts.messages?.find((message: { role: string }) => message.role === 'user');
      const text = typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content ?? '');
      chatSlug = text.match(/<page slug="([^"]+)"/)?.[1];
      if (editStaleDuringChat && chatSlug === 'concepts/stale') {
        editStaleDuringChat = false;
        await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
          await tx.executeRaw('UPDATE pages SET compiled_truth=$1 WHERE source_id=$2 AND slug=$3', ['concurrent edit', 'default', chatSlug]);
        }));
      }
      const claim = text.includes('SNAPSHOT VERSION: NEW') ? 'snapshot version claim' : 'managed bootstrap claim';
      const response = JSON.stringify([{ claim, kind: 'take', weight: 0.7 }]);
      return { text: response, blocks: [{ type: 'text' as const, text: response }], stopReason: 'end' as const,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-haiku-4-5-20251001', providerId: 'anthropic' };
  });
}));

async function seedPage(slug: string, writeFile = true): Promise<void> {
  await engine.putPage(slug, { type: 'concept', title: slug, compiled_truth: BODY, timeline: '', frontmatter: {} });
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
  if (!snapshot) throw new Error(`missing fixture ${slug}`);
  if (writeFile) writeFileSync(join(repo, `${slug}.md`), serializePageToMarkdown(snapshot.page, snapshot.tags));
}

afterAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
  __setChatTransportForTests(null); resetGateway();
  await disposePersistenceConsumer(engine); await closeEngine();
  rmSync(home, { recursive: true, force: true });
}));

test(`${backend}: unmanaged from-pages extraction keeps its md-first fence and takes mirror`, async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const slug = 'concepts/unmanaged'; await seedPage(slug);
  const result = await extractTakesFromPages(engine, { bootstrapEnabled: true, sourceIdFilter: 'default' });
  expect(result).toMatchObject({ claims_extracted: 1, pages_skipped: 0 });
  expect(parseTakesFence(readFileSync(join(repo, `${slug}.md`), 'utf8')).takes[0]?.claim).toBe('managed bootstrap claim');
  expect(await engine.executeRaw('SELECT claim FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.slug=$1', [slug]))
    .toEqual([{ claim: 'managed bootstrap claim' }]);
}));

test(`${backend}: managed extraction journals one atomic page fence and continues after a revision conflict`, async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const staleSlug = 'concepts/stale'; const goodSlug = 'concepts/good';
  const racedSlug = 'concepts/selection-race';
  await engine.putPage(racedSlug, { type: 'concept', title: racedSlug, compiled_truth: 'short', timeline: '', frontmatter: {} });
  const initialRaceSnapshot = await engine.readPageSnapshot(racedSlug, { sourceId: 'default' });
  if (!initialRaceSnapshot) throw new Error(`missing fixture ${racedSlug}`);
  writeFileSync(join(repo, `${racedSlug}.md`), serializePageToMarkdown(initialRaceSnapshot.page, initialRaceSnapshot.tags));
  await claimWorktree(engine, 'default', repo);
  await registerLocalWriter(engine, 'cli');
  await activatePersistence(engine, { confirmQuiesced: true });
  const { operations } = await import('../src/core/operations.ts');
  const putPage = operations.find(operation => operation.name === 'put_page')!;
  const ctx = { engine, config: { engine: engine.kind }, logger: { info: () => {}, warn: () => {}, error: () => {} }, dryRun: false, remote: false, sourceId: 'default' } as any;
  for (const slug of [staleSlug, goodSlug])
    await putPage.handler(ctx, { slug, content: `---\ntype: concept\ntitle: ${slug}\n---\n\n${BODY}` });
  await engine.executeRaw('UPDATE pages SET updated_at=now()+interval \'1 second\' WHERE source_id=$1 AND slug=$2', ['default', staleSlug]);
  editStaleDuringChat = true;
  const result = await extractTakesFromPages(engine, { bootstrapEnabled: true, sourceIdFilter: 'default' });
  expect(result).toMatchObject({ claims_extracted: 1, pages_skipped: 1, skipped: [{ slug: staleSlug, reason: 'revision_conflict' }] });
  expect(parseTakesFence(readFileSync(join(repo, `${goodSlug}.md`), 'utf8')).takes[0]?.claim).toBe('managed bootstrap claim');
  expect(await engine.executeRaw('SELECT claim FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.slug=$1', [goodSlug]))
    .toEqual([{ claim: 'managed bootstrap claim' }]);
  expect(parseTakesFence(readFileSync(join(repo, `${staleSlug}.md`), 'utf8')).takes).toHaveLength(0);
  expect(await engine.executeRaw('SELECT claim FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.slug=$1', [staleSlug])).toHaveLength(0);
  expect(await engine.executeRaw("SELECT operation,state,error_code FROM persistence_requests WHERE operation='put_page' AND slug=$1 ORDER BY sequence", [staleSlug]))
    .toEqual([
      { operation: 'put_page', state: 'committed', error_code: null },
      { operation: 'put_page', state: 'conflict', error_code: 'revision_conflict' },
    ]);
  expect(await engine.executeRaw("SELECT operation,state FROM persistence_requests WHERE operation='put_page' AND slug=$1 ORDER BY sequence", [goodSlug]))
    .toEqual([
      { operation: 'put_page', state: 'committed' },
      { operation: 'put_page', state: 'committed' },
    ]);
  expect(chatSlug).toBe(goodSlug);
}), 120_000);

test(`${backend}: managed extraction classifies the pinned snapshot after a selection race`, async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const slug = 'concepts/selection-race';
  const { operations } = await import('../src/core/operations.ts');
  const putPage = operations.find(operation => operation.name === 'put_page')!;
  const originalHandler = putPage.handler;
  if (!await engine.readPageSnapshot(slug, { sourceId: 'default' })) throw new Error(`missing fixture ${slug}`);
  await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
    await tx.putPage(slug, { type: 'concept', title: slug, compiled_truth: BODY, timeline: '', frontmatter: {} }, { sourceId: 'default' });
  }));
  let submittedContent = '';
  putPage.handler = async (_context, params) => { submittedContent = String(params.content); return { state: 'committed' }; };
  const originalReadPageSnapshot = engine.readPageSnapshot.bind(engine);
  let editedAfterSelection = false;
  (engine as any).readPageSnapshot = async (selectedSlug: string, options?: { sourceId?: string }) => {
    if (!editedAfterSelection && selectedSlug === slug) {
      editedAfterSelection = true;
      (engine as any).readPageSnapshot = originalReadPageSnapshot;
      await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
        await tx.putPage(slug, { type: 'concept', title: slug, compiled_truth: `SNAPSHOT VERSION: NEW\n${BODY}`, timeline: '', frontmatter: {} }, { sourceId: 'default' });
      }));
      const updated = await originalReadPageSnapshot(slug, { sourceId: 'default' });
      if (!updated) throw new Error(`missing fixture ${slug}`);
      writeFileSync(join(repo, `${slug}.md`), serializePageToMarkdown(updated.page, updated.tags));
      return updated;
    }
    return originalReadPageSnapshot(selectedSlug, options);
  };
  try {
    const result = await extractTakesFromPages(engine, { bootstrapEnabled: true, sourceIdFilter: 'default' });
    expect(editedAfterSelection).toBe(true);
    expect(result.claims_extracted).toBe(1);
    expect(parseTakesFence(submittedContent).takes[0]?.claim).toBe('snapshot version claim');
  } finally {
    (engine as any).readPageSnapshot = originalReadPageSnapshot;
    putPage.handler = originalHandler;
  }
}));

test(`${backend}: managed extraction composes from the DB snapshot when the canonical file is stale`, async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const slug = 'concepts/selection-race';
  const { operations } = await import('../src/core/operations.ts');
  const putPage = operations.find(operation => operation.name === 'put_page')!;
  const dbBody = `SNAPSHOT VERSION: NEW\n${BODY}`;
  await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
    await tx.putPage(slug, { type: 'concept', title: slug, compiled_truth: dbBody, timeline: '', frontmatter: {} }, { sourceId: 'default' });
  }));
  const newer = await engine.readPageSnapshot(slug, { sourceId: 'default' });
  if (!newer) throw new Error(`missing updated fixture ${slug}`);
  writeFileSync(join(repo, `${slug}.md`), serializePageToMarkdown({ ...newer.page, compiled_truth: `DISK VERSION: STALE\n${BODY}` }, newer.tags));
  await engine.executeRaw("UPDATE pages SET updated_at=now()+interval '10 seconds' WHERE source_id=$1 AND slug=$2", ['default', slug]);

  const originalHandler = putPage.handler;
  let submittedContent = '';
  putPage.handler = async (_context, params) => {
    submittedContent = String(params.content);
    return { state: 'committed' };
  };
  try {
    const result = await extractTakesFromPages(engine, { bootstrapEnabled: true, sourceIdFilter: 'default', maxPages: 1 });
    expect(result.claims_extracted).toBe(1);
    expect(submittedContent).toContain('SNAPSHOT VERSION: NEW');
    expect(submittedContent).not.toContain('DISK VERSION: STALE');
    expect(parseTakesFence(submittedContent).takes[0]?.claim).toBe('snapshot version claim');
  } finally {
    putPage.handler = originalHandler;
  }
}), 120_000);

test(`${backend}: managed duplicate filtering reads the pinned snapshot takes fence`, async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const slug = 'concepts/snapshot-duplicate';
  const compiledTruth = `${BODY}\n\n## Takes\n\n<!--- gbrain:takes:begin -->\n| # | claim | kind | who | weight | since | source |\n|---|-------|------|-----|--------|-------|--------|\n| 1 | managed bootstrap claim | take | system | 0.7 |  | manual |\n<!--- gbrain:takes:end -->`;
  await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
    await tx.putPage(slug, { type: 'concept', title: slug, compiled_truth: compiledTruth, timeline: '', frontmatter: {} }, { sourceId: 'default' });
  }));
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
  if (!snapshot) throw new Error(`missing fixture ${slug}`);
  writeFileSync(join(repo, `${slug}.md`), serializePageToMarkdown(snapshot.page, snapshot.tags).replace(/managed bootstrap claim/g, 'stale disk claim'));
  await engine.executeRaw("UPDATE pages SET updated_at=now()+interval '20 seconds' WHERE source_id=$1 AND slug=$2", ['default', slug]);
  const result = await extractTakesFromPages(engine, { bootstrapEnabled: true, sourceIdFilter: 'default', maxPages: 1 });
  expect(result).toMatchObject({ claims_extracted: 0, duplicates_skipped: 1 });
  expect(parseTakesFence(serializePageToMarkdown(snapshot.page, snapshot.tags)).takes[0]?.claim).toBe('managed bootstrap claim');
}), 120_000);
