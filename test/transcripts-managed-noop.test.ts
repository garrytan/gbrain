/**
 * #6741 B: on a writer-claimed brain, a transcript part whose page would not
 * change takes no admission, so it burns no permanent request id. The screen is
 * the publication preparer on an unadmitted request judged by the #5470 no-op
 * kernel; anything the publication would still do admits as before.
 *
 * Fails when: an unchanged re-ingest admits a put_page (one permanent id per
 * part per run), or when the skip hides pending work: a text projection behind
 * the page revision, chunks below the safe-chunk fence, a missing canonical file,
 * a recorded source path the publication would not record, or a canonical file
 * edited outside coordination.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { makeContext } from '../src/cli/main.ts';
import { runTranscriptsIngest } from '../src/core/transcripts/ingest.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { rebuildPendingPageProjections } from '../src/core/page-state/projections.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const SOURCE = 'transcripts-managed';
let engine: PGLiteEngine;
let dir: string;
let root: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
});

const env = () => ({ GBRAIN_HOME: dir, GBRAIN_SOURCE: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
  OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined });

beforeEach(async () => {
  await disposePersistenceConsumer(engine);
  await resetPgliteState(engine);
  dir = mkdtempSync(join(tmpdir(), 'gb-transcript-noop-'));
  root = join(dir, 'brain');
  mkdirSync(root);
  await withEnv(env(), async () => {
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [SOURCE, root]);
    await registerLocalWriter(engine, 'cli');
    await claimWorktree(engine, SOURCE, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  });
  return () => rmSync(dir, { recursive: true, force: true });
});

function exportFile(): string {
  const message = (role: string, t: number, text: string) => ({ author: { role }, create_time: t, content: { content_type: 'text', parts: [text] } });
  const mapping = {
    root: { id: 'root', parent: null, children: ['n1'], message: null },
    n1: { id: 'n1', parent: 'root', children: ['n2'], message: message('user', 1786080005, 'A question about widget-co.') },
    n2: { id: 'n2', parent: 'n1', children: [], message: message('assistant', 1786080015, 'An answer.') },
  };
  const path = join(dir, 'export.json');
  writeFileSync(path, JSON.stringify([{ title: 'Managed no-op', create_time: 1786080000, update_time: 1786080015,
    conversation_id: 'cgpt-noop-1', current_node: 'n2', mapping }]));
  return path;
}

const ingest = (writeWaitMs?: number) => withEnv(env(), async () => {
  const context = await makeContext(engine, { source: SOURCE, dry_run: false });
  if (writeWaitMs !== undefined) context.writeWaitMs = writeWaitMs;
  return runTranscriptsIngest(engine, { paths: [exportFile()], sourceId: SOURCE, format: 'chatgpt', context });
});
const admissions = async () => (await engine.executeRaw<{ n: number }>(
  "SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND operation='put_page'", [SOURCE]))[0]!.n;
const page = async () => (await engine.executeRaw<{ slug: string; source_path: string }>(
  "SELECT slug, source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND slug LIKE 'conversations/%'", [SOURCE]))[0]!;
async function drainProjections(): Promise<void> {
  await disposePersistenceConsumer(engine);
  for (let attempt = 0; attempt < 10; attempt++) {
    const [{ n }] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_projection_jobs');
    if (n === 0) return;
    await withEnv(env(), () => rebuildPendingPageProjections(engine));
  }
}
async function imported(): Promise<{ slug: string; file: string }> {
  expect((await ingest()).pages).toMatchObject({ imported: 1, errored: 0 });
  expect(await admissions()).toBe(1);
  await drainProjections();
  const { slug, source_path } = await page();
  return { slug, file: join(root, source_path) };
}

describe('#6741 B: an unchanged transcript part takes no admission', () => {
  test('a current no-op re-ingest makes zero admissions', async () => {
    await imported();
    expect((await ingest()).pages).toMatchObject({ imported: 0, skipped: 1, errored: 0 });
    expect((await ingest()).pages).toMatchObject({ imported: 0, skipped: 1, errored: 0 });
    expect(await admissions()).toBe(1);
  }, 120_000);

  test('a page with a request still pending (not yet published) still submits', async () => {
    const { slug } = await imported();
    await engine.executeRaw("UPDATE persistence_requests SET state='queued', completed_at=NULL WHERE source_id=$1 AND slug=$2", [SOURCE, slug]);
    // The new request waits behind the pending one; a short wait leaves it pending, which is enough here.
    await ingest(1).catch(() => undefined);
    expect(await admissions()).toBe(2);
  }, 120_000);

  test('a text projection behind the page revision still submits', async () => {
    const { slug } = await imported();
    await engine.executeRaw('UPDATE pages SET text_projection_revision=gen_random_uuid() WHERE source_id=$1 AND slug=$2', [SOURCE, slug]);
    await ingest();
    expect(await admissions()).toBe(2);
  }, 120_000);

  test('chunks below the safe-chunk fence still submit', async () => {
    const { slug } = await imported();
    await engine.executeRaw('UPDATE pages SET chunker_version=1 WHERE source_id=$1 AND slug=$2', [SOURCE, slug]);
    await ingest();
    expect(await admissions()).toBe(2);
  }, 120_000);

  test('a missing canonical file still submits', async () => {
    const { file } = await imported();
    unlinkSync(file);
    // The publication refuses the write (the file was removed outside coordination); it is admitted, never skipped.
    await ingest().catch(() => undefined);
    expect(await admissions()).toBe(2);
  }, 120_000);

  test('canonical metadata drift (the page no longer records its file path) still submits', async () => {
    const { slug } = await imported();
    await engine.executeRaw('UPDATE pages SET source_path=NULL WHERE source_id=$1 AND slug=$2', [SOURCE, slug]);
    await ingest().catch(() => undefined);
    expect(await admissions()).toBe(2);
  }, 120_000);

  test('a canonical file edited outside coordination still submits', async () => {
    const { file } = await imported();
    const bytes = readFileSync(file, 'utf8');
    const [, front, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(bytes)!;
    // The frontmatter lines reversed: no longer the page the database holds.
    writeFileSync(file, `---\n${front!.split('\n').reverse().join('\n')}\n---\n${body}`);
    await ingest().catch(() => undefined);
    expect(await admissions()).toBe(2);
  }, 120_000);
});
