/**
 * `gbrain transcripts ingest` on a writer-claimed (managed) brain (#5235).
 *
 * Protects: on a managed brain the direct importer is refused
 * (writer_coordinator_required), so each rendered part must be submitted as a
 * `put_page` write request through the CLI's trusted-local context. Fails
 * when: the ingest still calls the direct importer (every page errors), a
 * replacement is sent without the page's revision, or the coordinator path
 * leaks onto an unmanaged brain or a dry run. The context comes from the
 * CLI's own constructor (`makeContext`), so `remote: false` is never
 * hand-built here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { makeContext } from '../src/cli/main.ts';
import { runTranscriptsIngest } from '../src/core/transcripts/ingest.ts';
import { runTranscripts } from '../src/commands/transcripts.ts';
import { disposePersistenceConsumer, stopPersistenceConsumer } from '../src/core/persistence/service.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let dir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
});

beforeEach(async () => {
  await stopPersistenceConsumer(engine);
  await resetPgliteState(engine);
  dir = mkdtempSync(join(tmpdir(), 'gb-managed-ingest-'));
  return () => rmSync(dir, { recursive: true, force: true });
});

function exportFile(name: string, grown: boolean): string {
  const message = (role: string, t: number, text: string) => ({ author: { role }, create_time: t, content: { content_type: 'text', parts: [text] } });
  const mapping: Record<string, unknown> = {
    root: { id: 'root', parent: null, children: ['n1'], message: null },
    n1: { id: 'n1', parent: 'root', children: ['n2'], message: message('user', 1786080005, 'First question about acme-example.') },
    n2: { id: 'n2', parent: 'n1', children: grown ? ['n3'] : [], message: message('assistant', 1786080015, 'First answer.') },
  };
  if (grown) {
    mapping.n3 = { id: 'n3', parent: 'n2', children: ['n4'], message: message('user', 1786090005, 'FOLLOWUP-MARKER new question') };
    mapping.n4 = { id: 'n4', parent: 'n3', children: [], message: message('assistant', 1786090015, 'Follow-up answer.') };
  }
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify([{ title: 'Managed ingest', create_time: 1786080000, update_time: grown ? 1786090015 : 1786080015,
    conversation_id: 'cgpt-managed-1', current_node: grown ? 'n4' : 'n2', mapping }]));
  return path;
}

async function ingest(path: string, opts: { context?: boolean; dryRun?: boolean } = {}) {
  return withEnv({ GBRAIN_HOME: dir, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    const context = opts.context === false ? undefined : await makeContext(engine, { source: 'default', dry_run: opts.dryRun === true });
    return runTranscriptsIngest(engine, { paths: [path], sourceId: 'default', format: 'chatgpt', dryRun: opts.dryRun, context });
  });
}

const conversationPages = () => engine.executeRaw<{ slug: string; has_new: boolean }>(
  `SELECT slug, compiled_truth LIKE '%FOLLOWUP-MARKER%' AS has_new FROM pages
    WHERE deleted_at IS NULL AND slug LIKE 'conversations/%' ORDER BY slug`);
const pageRequests = () => engine.executeRaw<{ slug: string; state: string; principal_kind: string }>(
  `SELECT slug, state, principal_kind FROM persistence_requests WHERE operation = 'put_page' ORDER BY sequence`);
const claimBrain = () => engine.executeRaw('UPDATE persistence_brain SET enabled = true WHERE singleton = 1');

describe('transcripts ingest on a writer-claimed brain', () => {
  test('parts commit as local put_page write requests; a grown session updates in place by revision; a repeat is skipped', async () => {
    await claimBrain();
    const first = await ingest(exportFile('a.json', false));
    expect(first).toMatchObject({ erroredFiles: 0, sessionsErrored: 0, pages: { imported: 1, errored: 0 } });
    const [page] = await conversationPages();
    expect(await pageRequests()).toEqual([{ slug: page.slug, state: 'committed', principal_kind: 'local_cli' }]);

    const grown = await ingest(exportFile('b.json', true));
    expect(grown).toMatchObject({ sessionsErrored: 0, pages: { imported: 1, errored: 0 } });
    expect(await conversationPages()).toEqual([{ slug: page.slug, has_new: true }]);
    expect((await pageRequests()).map(r => r.state)).toEqual(['committed', 'committed']);

    const repeat = await ingest(exportFile('c.json', true));
    expect(repeat.pages).toMatchObject({ imported: 0, skipped: 1, errored: 0 });
  }, 120_000);

  test('`gbrain transcripts ingest` passes the dispatcher\'s makeContext through to the coordinated path', async () => {
    await claimBrain();
    const path = exportFile('a.json', false);
    await withEnv({ GBRAIN_HOME: dir, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, () =>
      runTranscripts(engine, ['ingest', path, '--format', 'chatgpt', '--source', 'default', '--quiet'], { makeContext }));
    const [page] = await conversationPages();
    expect(await pageRequests()).toEqual([{ slug: page!.slug, state: 'committed', principal_kind: 'local_cli' }]);
  }, 120_000);

  test('without the trusted context the direct importer is still refused (the gate this routes around)', async () => {
    await claimBrain();
    await expect(ingest(exportFile('a.json', false), { context: false })).rejects.toThrow(/cannot mutate a managed brain through the legacy writer/);
    expect(await conversationPages()).toEqual([]);
  }, 120_000);

  test('a dry run on a managed brain plans without submitting anything', async () => {
    await claimBrain();
    const planned = await ingest(exportFile('a.json', false), { dryRun: true });
    expect(planned.pages).toMatchObject({ planned: 1, imported: 0 });
    expect(await pageRequests()).toEqual([]);
    expect(await conversationPages()).toEqual([]);
  }, 120_000);
});

test('an unmanaged brain keeps the direct importer: no write requests are journaled', async () => {
  const result = await ingest(exportFile('a.json', false));
  expect(result.pages).toMatchObject({ imported: 1, errored: 0 });
  expect(await conversationPages()).toHaveLength(1);
  expect(await pageRequests()).toEqual([]);
}, 120_000);
