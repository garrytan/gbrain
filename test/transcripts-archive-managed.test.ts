/**
 * GST-2768 PR 2: the conversation archive on a writer-claimed (managed) brain. The direct importer is refused there,
 * so every day page and day index is submitted as a put_page write request through the CLI's trusted-local context
 * (makeContext, never a hand-built remote: false), built only after the archive source exists: on a fresh brain the
 * source does not exist until the first run creates it, and the CLI used to build the context first and fail. A rerun on the same input submits nothing, and on a shared brain
 * the committed pages still name their readers. Same harness as test/transcripts-managed-ingest.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { makeContext } from '../src/cli/main.ts';
import { disposePersistenceConsumer, stopPersistenceConsumer } from '../src/core/persistence/service.ts';
import { addMember } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { ARCHIVE_TIMEZONE_KEY, runTranscriptArchive, setArchiveEnabled } from '../src/core/transcripts/archive.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { archivedPages, conversation, staticReader } from './helpers/transcript-archive.ts';

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
  dir = mkdtempSync(join(tmpdir(), 'gb-managed-archive-'));
  await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
  await setArchiveEnabled(engine, true);
  await engine.executeRaw('UPDATE persistence_brain SET enabled = true WHERE singleton = 1');
  await withEnv({ GBRAIN_HOME: dir }, () => registerLocalWriter(engine, 'cli'));
  return () => rmSync(dir, { recursive: true, force: true });
});

const readers = () => [staticReader('codex', [conversation('codex', 'rollout-managed', [
  ['user', '2026-10-01T10:00:00.000Z', 'day one question'], ['assistant', '2026-10-01T10:01:00.000Z', 'day one answer'],
  ['user', '2026-10-02T09:00:00.000Z', 'day two question'],
])])];

async function archive() {
  return withEnv({ GBRAIN_HOME: dir, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    return runTranscriptArchive(engine, { mode: 'backfill', from: '2026-10-01', to: '2026-10-03', readers: readers(),
      makeContext: source => makeContext(engine, { source, dry_run: false }), now: new Date('2026-10-10T00:00:00Z') });
  });
}

const pageRequests = () => engine.executeRaw<{ slug: string; state: string; principal_kind: string }>(
  "SELECT slug, state, principal_kind FROM persistence_requests WHERE operation = 'put_page' ORDER BY slug");

describe('conversation archive on a writer-claimed brain', () => {
  test('day pages commit as local put_page write requests and a rerun submits nothing', async () => {
    const first = await archive();
    expect(first.errors).toEqual([]);
    expect(first.write_mode).toBe('coordinator');
    expect(first.held).toBe(0);
    const pages = await archivedPages(engine);
    expect(pages.map(p => p.slug.split('/').slice(0, 3).join('/'))).toEqual([
      'conversations/codex/2026-10-01', 'conversations/codex/2026-10-02', 'conversations/days/2026-10-01', 'conversations/days/2026-10-02']);
    const requests = await pageRequests();
    expect(requests).toEqual(pages.map(p => ({ slug: p.slug, state: 'committed', principal_kind: 'local_cli' })));
    const revisions = pages.map(p => p.revision);

    const again = await archive();
    expect(again.errors).toEqual([]);
    expect(again.written).toBe(0);
    expect(await pageRequests()).toHaveLength(requests.length);
    expect((await archivedPages(engine)).map(p => p.revision)).toEqual(revisions);
  }, 120_000);

  test('on a shared brain the committed pages name the owner in readable_by', async () => {
    await engine.setConfig('brain.audience', 'shared');
    await addMember(engine, 'alice-example');
    await addMember(engine, 'bob-example');
    await setOwner(engine, 'alice-example');
    const result = await archive();
    expect(result.errors).toEqual([]);
    expect(result.write_mode).toBe('coordinator');
    const pages = await archivedPages(engine);
    expect(pages.length).toBe(4);
    for (const p of pages) expect(p.frontmatter.readable_by).toEqual(['alice-example']);
    expect((await pageRequests()).every(r => r.state === 'committed')).toBe(true);
  }, 120_000);
});
