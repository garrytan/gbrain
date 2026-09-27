/**
 * A managed purge removes the recorded artifact before hard deletion and its
 * durable receipt commit. Failed publication preserves the prior row; existing
 * tombstones remain tombstones. Unknown bytes are never removed speculatively.
 * Permission cases skip explicitly when chmod cannot constrain this process.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let tmpRoot: string;
let brainDir: string;
const home = mkdtempSync(join(tmpdir(), 'gbrain-purge-artifact-'));
const deletePage = operations.find(o => o.name === 'delete_page')!;
const putPage = operations.find(o => o.name === 'put_page')!;
const SLUG = 'secrets/leaked-key';
const REL_PATH = 'secrets/leaked-key.md';
const CONTENT = '---\ntitle: Leaked key\ntype: note\n---\n\n# Body\n\nAKIA-EXAMPLE-NOT-REAL\n';

function chmodBites(): boolean {
  if (process.platform === 'win32' || process.getuid?.() === 0) return false;
  const probe = mkdtempSync(join(tmpdir(), 'gbrain-chmod-probe-'));
  const dir = join(probe, 'd'), file = join(dir, 'f');
  try {
    mkdirSync(dir); writeFileSync(file, 'x'); chmodSync(dir, 0o555);
    try { unlinkSync(file); return false; } catch { return true; }
  } finally {
    try { chmodSync(dir, 0o755); } catch { /* probe may not have reached mkdir */ }
    rmSync(probe, { recursive: true, force: true });
  }
}
const CHMOD_BITES = chmodBites();
const chmodTest = CHMOD_BITES ? test : test.skip;
const CHMOD_NOTE = CHMOD_BITES ? '' : ' [skipped: chmod does not constrain this uid/capabilities/platform]';
function context(): OperationContext {
  return { engine, config: { engine: 'pglite', embedding_disabled: true },
    logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default' };
}
async function seedPageWithFile(rel = REL_PATH): Promise<string> {
  await importFromContent(engine, SLUG, CONTENT, { noEmbed: true, sourceId: 'default', sourcePath: rel });
  const path = join(brainDir, rel); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, CONTENT);
  return path;
}
function replaceFileWithDirectory(path: string): void {
  rmSync(path); mkdirSync(path); writeFileSync(join(path, 'keep'), 'preserved directory contents');
}
function restoreFile(path: string): void {
  rmSync(path, { recursive: true, force: true }); writeFileSync(path, CONTENT);
}
async function rowState(): Promise<'absent' | 'live' | 'tombstone'> {
  const page = await engine.readPageSnapshot(SLUG, { sourceId: 'default', includeDeleted: true });
  return !page ? 'absent' : page.page.deleted_at === null ? 'live' : 'tombstone';
}
async function parameters(extra: Record<string, unknown> = {}) {
  const snapshot = await engine.readPageSnapshot(SLUG, { sourceId: 'default', includeDeleted: true });
  return { slug: SLUG, request_id: randomUUID(), ...(snapshot ? { expected_revision: snapshot.revision } : {}), ...extra };
}
const invoke = (params: Record<string, unknown>) => withEnv({ GBRAIN_HOME: home },
  () => deletePage.handler(context(), params)) as Promise<Record<string, any>>;
async function purge() { return invoke(await parameters({ purge: true })); }
async function failure(params: Record<string, unknown>, state: 'failed' | 'conflict' = 'failed'): Promise<OperationError> {
  try { await invoke(params); } catch (error) {
    expect(error).toBeInstanceOf(OperationError);
    expect((error as OperationError).writeRequest?.state).toBe(state);
    return error as OperationError;
  }
  throw new Error('Expected a terminal publication failure');
}

beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
}, 60_000);
afterAll(async () => {
  await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(home, { recursive: true, force: true });
}, 60_000);
beforeEach(async () => {
  await disposePersistenceConsumer(engine); await resetPgliteState(engine); _resetWriteThroughCacheForTest();
  tmpRoot = mkdtempSync(join(home, 'case-')); brainDir = join(tmpRoot, 'brain'); mkdirSync(brainDir);
  await engine.setConfig('sync.repo_path', brainDir);
});
afterEach(async () => {
  await disposePersistenceConsumer(engine);
  try { chmodSync(join(brainDir, 'secrets'), 0o755); } catch { /* no secrets directory in this case */ }
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('managed purge artifact and receipt boundaries', () => {
  for (const tombstone of [false, true]) {
    test(`${tombstone ? 'tombstone' : 'live row'}: undeletable artifact keeps row and bytes; repaired new request purges`, async () => {
      const file = await seedPageWithFile();
      if (tombstone) await engine.softDeletePage(SLUG, { sourceId: 'default' });
      const before = await engine.readPageSnapshot(SLUG, { sourceId: 'default', includeDeleted: true });
      replaceFileWithDirectory(file);
      const failedParams = await parameters({ purge: true });
      const error = await failure(failedParams);
      expect(error.code).toBe('storage_error');
      expect(error.message).not.toContain(brainDir); // durable diagnostics contain no private paths
      expect(await engine.readPageSnapshot(SLUG, { sourceId: 'default', includeDeleted: true })).toEqual(before);
      expect(readFileSync(join(file, 'keep'), 'utf8')).toBe('preserved directory contents');
      restoreFile(file);
      const replay = await failure(failedParams);
      expect(replay.writeRequest).toEqual(error.writeRequest);
      expect(readFileSync(file, 'utf8')).toBe(CONTENT);
      const result = await purge();
      expect(result).toMatchObject({ status: 'purged', state: 'committed', write_through: { written: true } });
      expect(String(result.residuals)).toContain('git history');
      expect(existsSync(file)).toBe(false); expect(await rowState()).toBe('absent');
    });
    chmodTest(`${tombstone ? 'tombstone' : 'live row'}: permission failure preserves prior state until a new request after repair${CHMOD_NOTE}`, async () => {
      const file = await seedPageWithFile();
      if (tombstone) await engine.softDeletePage(SLUG, { sourceId: 'default' });
      const before = await engine.readPageSnapshot(SLUG, { sourceId: 'default', includeDeleted: true });
      chmodSync(dirname(file), 0o555);
      const error = await failure(await parameters({ purge: true }));
      expect(error.code).toBe('storage_error');
      expect(await engine.readPageSnapshot(SLUG, { sourceId: 'default', includeDeleted: true })).toEqual(before);
      expect(readFileSync(file, 'utf8')).toBe(CONTENT);
      chmodSync(dirname(file), 0o755);
      expect((await purge()).status).toBe('purged');
      expect(existsSync(file)).toBe(false); expect(await rowState()).toBe('absent');
    });
  }
  for (const absent of [false, true]) {
    test(`tombstone uses its recorded non-slug artifact path (${absent ? 'already absent' : 'still present'})`, async () => {
      const file = await seedPageWithFile('archive/original-secret.md');
      await engine.softDeletePage(SLUG, { sourceId: 'default' });
      if (absent) rmSync(file);
      const result = await purge();
      expect(result).toMatchObject({ status: 'purged', state: 'committed', persistence: { mode: 'filesystem' } });
      expect(existsSync(file)).toBe(false); expect(existsSync(join(brainDir, `${SLUG}.md`))).toBe(false);
      expect(await rowState()).toBe('absent');
    });
  }
  test('same-ID committed replay survives hard deletion and never purges a recreated page', async () => {
    const file = await seedPageWithFile();
    const original = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!;
    const params = await parameters({ purge: true });
    const committed = await invoke(params);
    expect(committed.state).toBe('committed'); expect(await rowState()).toBe('absent');
    expect(await invoke(params)).toEqual(committed);
    await expect(invoke({ ...params, purge: false })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await withEnv({ GBRAIN_HOME: home }, () => putPage.handler(context(), { slug: SLUG, content: CONTENT, request_id: randomUUID() }));
    const recreated = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!;
    expect(recreated.page.id).not.toBe(original.page.id);
    expect(recreated.revision).not.toBe(original.revision);
    const bytes = readFileSync(file, 'utf8');
    expect(await invoke(params)).toEqual(committed);
    expect(await engine.readPageSnapshot(SLUG, { sourceId: 'default' })).toEqual(recreated);
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    await expect(invoke({ ...params, request_id: randomUUID() })).rejects.toMatchObject({ code: 'revision_conflict' });
  });
  test('purge preserves unknown tombstone artifact bytes even with explicit force', async () => {
    const file = await seedPageWithFile(); await engine.softDeletePage(SLUG, { sourceId: 'default' });
    writeFileSync(file, 'Unknown local edit must survive.');
    const params = { slug: SLUG, purge: true, force: true, request_id: randomUUID() };
    expect((await failure(params, 'conflict')).code).toBe('source_changed');
    expect(readFileSync(file, 'utf8')).toBe('Unknown local edit must survive.'); expect(await rowState()).toBe('tombstone');
  });
  test('ordinary soft-delete also rolls back when its artifact cannot be removed', async () => {
    const file = await seedPageWithFile(); replaceFileWithDirectory(file);
    const error = await failure(await parameters());
    expect(error.code).toBe('storage_error'); expect(await rowState()).toBe('live');
    expect(readFileSync(join(file, 'keep'), 'utf8')).toBe('preserved directory contents');
  });
});
