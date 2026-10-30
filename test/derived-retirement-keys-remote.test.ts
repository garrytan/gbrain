/**
 * GBRA-161 PR 0: the derived-retirement stamp keys (`retired_by`, `retired_at`, `retired_generation`) are set only by
 * trusted derived writers. A remote put_page that adds or changes one is refused with `reserved_frontmatter_key` and
 * writes nothing; carrying the stored value unchanged (a round-trip of a restored page) or dropping it writes; a local
 * write keeps them. Fails when a remote caller can stamp a page so the purge hold or a restore treats it as a derived
 * retirement.
 * PGLite in-memory, through the coordinated write path ($0).
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test as bunTest } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { registerLocalWriter, withVerifiedLocalRegistration, type LocalRegistration } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';

let engine: PGLiteEngine;
let fixture: string;
let remoteRegistration: LocalRegistration;
let cliRegistration: LocalRegistration;
const remoteAuth = { token: 'fixture', clientId: 'fixture-client', scopes: ['read', 'write'], sourceId: 'default' };

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await disposePersistenceConsumer(engine);
  await resetPgliteState(engine);
  _resetWriteThroughCacheForTest();
  fixture = mkdtempSync(join(tmpdir(), 'gb-retire-keys-'));
  mkdirSync(join(fixture, 'brain'));
  await engine.setConfig('sync.repo_path', join(fixture, 'brain'));
});
afterEach(async () => { await disposePersistenceConsumer(engine); rmSync(fixture, { recursive: true, force: true }); });

function test(name: string, run: () => Promise<void>) {
  bunTest(name, () => withEnv({ GBRAIN_HOME: join(fixture, 'home') }, async () => {
    remoteRegistration = await registerLocalWriter(engine, 'stdio', { sourceIds: ['*'], operations: null, scopes: ['read', 'write'], slugPrefixes: null });
    cliRegistration = await registerLocalWriter(engine, 'cli');
    try { await run(); } finally { await disposePersistenceConsumer(engine); }
  }), 30_000);
}

async function put(slug: string, content: string, remote: boolean) {
  return withVerifiedLocalRegistration(engine, remote ? remoteRegistration : cliRegistration, () => dispatchToolCall(engine, 'put_page',
    { slug, content, force: true, request_id: randomUUID() }, { remote, config: { engine: 'pglite' }, sourceId: 'default', ...(remote ? { auth: remoteAuth } : {}),
      logger: { info() {}, warn() {}, error() {} } }));
}
async function written(slug: string, content: string, remote: boolean) {
  const response = await put(slug, content, remote);
  expect(response.isError === true).toBe(false);
}
const stamped = '---\ntitle: Stamped\ntype: note\nretired_by: life-chronicle\nretired_at: 2026-01-01T00:00:00.000Z\nretired_generation: 7\nowner: alice-example\n---\n\nBody.\n';
const frontmatter = async (slug: string) => (await engine.executeRaw<{ frontmatter: Record<string, unknown> }>(
  'SELECT frontmatter FROM pages WHERE slug=$1', [slug]))[0]!.frontmatter;

test('a remote put_page that adds the retirement stamp keys is refused and writes nothing', async () => {
  const response = await put('notes/remote-example', stamped, true);
  expect(response.isError).toBe(true);
  expect(JSON.stringify(response.content)).toContain('reserved_frontmatter_key');
  expect(await engine.executeRaw('SELECT 1 FROM pages WHERE slug=$1', ['notes/remote-example'])).toHaveLength(0);
});

test('a trusted local put_page keeps them', async () => {
  await written('notes/local-example', stamped, false);
  expect(await frontmatter('notes/local-example')).toMatchObject({ retired_by: 'life-chronicle', owner: 'alice-example' });
});

test('a remote put_page that changes a stored stamp is refused; carrying it unchanged or dropping it writes', async () => {
  await written('notes/round-trip-example', stamped, false);
  const changed = await put('notes/round-trip-example', stamped.replace('retired_by: life-chronicle', 'retired_by: stale-atoms'), true);
  expect(changed.isError).toBe(true);
  expect(JSON.stringify(changed.content)).toContain('reserved_frontmatter_key');
  await written('notes/round-trip-example', stamped.replace('Body.', 'Edited body.'), true);
  expect(await frontmatter('notes/round-trip-example')).toMatchObject({ retired_by: 'life-chronicle', owner: 'alice-example' });
  await written('notes/round-trip-example', stamped.replace(/retired_[a-z]+: .*\n/g, ''), true);
  expect(await frontmatter('notes/round-trip-example')).not.toHaveProperty('retired_by');
});

test('a remote edit_page that writes a stamp key into the frontmatter is refused', async () => {
  await written('notes/edit-example', '---\ntitle: Edit\ntype: note\nowner: alice-example\n---\n\nBody.\n', false);
  const read = await withVerifiedLocalRegistration(engine, remoteRegistration, () => dispatchToolCall(engine, 'get_page', { slug: 'notes/edit-example', include_content: true },
    { remote: true, config: { engine: 'pglite' }, sourceId: 'default', auth: remoteAuth, logger: { info() {}, warn() {}, error() {} } }));
  const revision = JSON.parse((read.content as Array<{ text: string }>)[0]!.text).revision as string;
  const response = await withVerifiedLocalRegistration(engine, remoteRegistration, () => dispatchToolCall(engine, 'edit_page',
    { slug: 'notes/edit-example', expected_revision: revision, request_id: randomUUID(), edits: [{ old_text: 'owner: alice-example', new_text: 'owner: alice-example\nretired_by: stale-atoms' }] },
    { remote: true, config: { engine: 'pglite' }, sourceId: 'default', auth: remoteAuth, logger: { info() {}, warn() {}, error() {} } }));
  expect(response.isError).toBe(true);
  expect(JSON.stringify(response.content)).toContain('reserved_frontmatter_key');
  expect(await frontmatter('notes/edit-example')).not.toHaveProperty('retired_by');
});
