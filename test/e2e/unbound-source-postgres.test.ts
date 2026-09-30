/**
 * #5254: a Postgres put_page to a filesystem source with no canonical owner.
 *
 * Contract: refused by default with detail `unbound_source` and a hint naming
 * both exits (bind through `sources writer claim`, or opt in with
 * `persistence.unbound_write=database_only`). The opt-in writes new or already
 * database-only pages to the database only, classifies them durably, rechecks
 * the binding at publication, and keeps them database-only after binding.
 * Regression: the refusal carried only the generic writer-inspection hint and
 * there was no opt-in, so every Postgres brain with an unbound filesystem
 * source could not save pages at all. Existing Postgres put_page coverage
 * always claims the worktree first, so none of these paths ran.
 */
import { describe, expect, spyOn, test as bunTest } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasDatabase } from './helpers.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { LEGACY_EMBEDDING_CONFIG } from '../helpers/legacy-embedding-config.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { registerLocalWriter, withVerifiedLocalRegistration, type LocalRegistration } from '../../src/core/persistence/identity.ts';
import { disposePersistenceConsumer, registerMutationPreparer } from '../../src/core/persistence/service.ts';
import { preparePageMutation } from '../../src/core/persistence/page-prepare.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { performManagedSync } from '../../src/core/persistence/sync-run.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { runConfig } from '../../src/commands/config.ts';

const d = hasDatabase() ? describe : describe.skip;
let engine: PostgresEngine;
let root: string;
let registration: LocalRegistration;
const config = { engine: 'postgres' as const, embedding_disabled: true };
const slug = 'notes/unbound-example';
const content = (body: string) => `---\ntitle: Example\ntype: note\n---\n\n${body}`;
const DOCS = 'docs/guides/write-refusals.md#unbound-sources-on-postgres';

// Held between admission and publication by the gated preparer below; every
// put_page in this file is a plain page write, so delegating is exact.
let gate: { entered: () => void; release: Promise<void> } | null = null;
registerMutationPreparer('put_page', async (e, row, cfg, signal) => {
  if (gate) { gate.entered(); await gate.release; }
  return preparePageMutation(e, row, cfg, undefined, signal);
});

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function commit(dir: string): void {
  git(dir, 'add', '.');
  git(dir, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'fixture');
}

function test(name: string, run: () => Promise<void>) {
  bunTest(name, async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'gbrain-unbound-pg-'));
    configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engine = pg.engine;
    root = join(fixtureDir, 'brain'); mkdirSync(join(root, 'notes'), { recursive: true });
    git(root, 'init', '-q');
    writeFileSync(join(root, 'notes', 'seed.md'), content('Seed file.'));
    commit(root);
    resetGateway(); _resetWriteThroughCacheForTest();
    try {
      await withEnv({ GBRAIN_HOME: join(fixtureDir, 'home') }, async () => {
        await engine.setConfig('sync.repo_path', root);
        registration = await registerLocalWriter(engine, 'stdio', {
          sourceIds: ['default'], operations: null, scopes: ['read', 'write'], slugPrefixes: ['notes'],
        });
        try { await run(); } finally { gate = null; await disposePersistenceConsumer(engine); }
      });
    } finally {
      resetGateway(); _resetWriteThroughCacheForTest();
      await pg.close();
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  }, 60_000);
}

async function dispatch(name: string, params: Record<string, unknown>) {
  const response = await withVerifiedLocalRegistration(engine, registration, () => dispatchToolCall(engine, name, params, {
    remote: true, config, sourceId: 'default',
    auth: { token: 'fixture', clientId: 'fixture-client', scopes: ['read', 'write'], sourceId: 'default', boundSlugPrefixes: ['notes'] },
    logger: { info() {}, warn() {}, error() {} },
  }));
  return { response, payload: JSON.parse((response.content[0] as { text: string }).text), params };
}
async function put(body: string, pageSlug = slug) {
  const current = await engine.readPageSnapshot(pageSlug, { sourceId: 'default', includeDeleted: true });
  return dispatch('put_page', { slug: pageSlug, content: content(body), request_id: randomUUID(),
    ...(current ? { expected_revision: current.revision } : {}) });
}
function localContext(): OperationContext {
  return { engine, config, remote: false, sourceId: 'default', dryRun: false, logger: { info() {}, warn() {}, error() {} } } as OperationContext;
}
async function classification(pageSlug = slug): Promise<string | null | undefined> {
  const [row] = await engine.executeRaw<{ database_only_reason: string | null }>(
    'SELECT database_only_reason FROM pages WHERE source_id=$1 AND slug=$2', ['default', pageSlug]);
  return row?.database_only_reason;
}
async function bindAndActivate(): Promise<void> {
  await claimWorktree(engine, 'default', root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
}
async function setUnboundWrite(value: string): Promise<{ exitCode: number | null; errors: string }> {
  const errors: string[] = [];
  let exitCode: number | null = null;
  const errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
  const logSpy = spyOn(console, 'log').mockImplementation(() => {});
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => { exitCode = code ?? 0; throw new Error(`EXIT:${code}`); }) as never);
  try { await runConfig(engine, ['set', 'persistence.unbound_write', value]); }
  catch (error) { if (!(error as Error).message.startsWith('EXIT:')) throw error; }
  finally { errSpy.mockRestore(); logSpy.mockRestore(); exitSpy.mockRestore(); }
  return { exitCode, errors: errors.join('\n') };
}

d('#5254 Postgres put_page to an unbound filesystem source', () => {
  test('default refuses with detail unbound_source and names the bind command and the opt-in key', async () => {
    const refused = await put('First note.');
    expect(refused.response.isError).toBe(true);
    expect(refused.payload.error).toBe('owner_unavailable');
    expect(refused.payload.detail).toBe('unbound_source');
    expect(refused.payload.docs).toBe(DOCS);
    const hint = refused.payload.suggestion as string;
    expect(hint).toContain('gbrain sources writer status default --json');
    expect(hint).toContain('gbrain sources writer claim default --path');
    expect(hint).toContain('--admin-intent writer_claim --expected-state <admin_state>');
    expect(hint).toContain('ask the operator to unlock it first');
    expect(hint).toContain('gbrain config set persistence.unbound_write database_only');
    expect(hint).toContain('stay database-only and are not materialized');
    expect(await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true })).toBeNull();
    // An explicit refuse behaves exactly like the default.
    await engine.setConfig('persistence.unbound_write', 'refuse');
    expect((await put('First note.')).payload.detail).toBe('unbound_source');
  });

  test('a trusted local caller gets the real checkout path filled into the bind command', async () => {
    let error: { code?: string; detail?: string; suggestion?: string } | undefined;
    try { await submitPageMutation(localContext(), { operation: 'put_page', params: { slug, content: content('Local note.') } }); }
    catch (caught) { error = caught as typeof error; }
    expect(error?.code).toBe('owner_unavailable');
    expect(error?.detail).toBe('unbound_source');
    expect(error?.suggestion).toContain(`gbrain sources writer claim default --path ${root} --admin-intent writer_claim`);
  });

  test('config set accepts refuse and database_only and rejects anything else', async () => {
    expect(await setUnboundWrite('database_only')).toEqual({ exitCode: null, errors: '' });
    expect(await engine.getConfig('persistence.unbound_write')).toBe('database_only');
    expect(await setUnboundWrite('refuse')).toEqual({ exitCode: null, errors: '' });
    const bad = await setUnboundWrite('auto_claim');
    expect(bad.exitCode).toBe(1);
    expect(bad.errors).toContain('persistence.unbound_write must be one of: refuse, database_only');
    expect(await engine.getConfig('persistence.unbound_write')).toBe('refuse');
  });

  test('database_only writes a new page database-only, says why, and classifies it durably', async () => {
    await engine.setConfig('persistence.unbound_write', 'database_only');
    const written = await put('Database-only note.');
    expect(written.response.isError).not.toBe(true);
    expect(written.payload.state).toBe('committed');
    expect(written.payload.persistence).toEqual({ mode: 'database' });
    expect(written.payload.write_through.written).toBe(false);
    expect(written.payload.write_through.skipped).toBe('unbound_source');
    expect(written.payload.write_through.warning).toContain('has no canonical owner');
    expect(await classification()).toBe('unbound_source');
    expect(existsSync(join(root, `${slug}.md`))).toBe(false);
    // A page that is already database-only keeps accepting edits.
    const edited = await put('Edited database-only note.');
    expect(edited.payload.state).toBe('committed');
    expect(edited.payload.write_through.skipped).toBe('unbound_source');
    expect((await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth).toContain('Edited database-only note.');
  });

  test('database_only still refuses an edit to a page that came from a canonical file, with the bind branch only', async () => {
    await engine.setConfig('persistence.unbound_write', 'database_only');
    await engine.putPage('notes/seed', { type: 'note', title: 'Seed', compiled_truth: 'Seed file.', timeline: '', frontmatter: {} }, { sourceId: 'default' });
    await engine.executeRaw("UPDATE pages SET source_path='notes/seed.md' WHERE source_id='default' AND slug='notes/seed'");
    const refused = await put('Edited seed.', 'notes/seed');
    expect(refused.payload.error).toBe('owner_unavailable');
    expect(refused.payload.detail).toBe('unbound_source');
    expect(refused.payload.suggestion).toContain('gbrain sources writer claim default --path');
    expect(refused.payload.suggestion).not.toContain('gbrain config set persistence.unbound_write database_only');
    expect(refused.payload.suggestion).toContain('came from a canonical file');
    expect((await engine.getPage('notes/seed', { sourceId: 'default' }))?.compiled_truth).toBe('Seed file.');
  });

  test('binding between admission and publication fails the write with owner_unavailable/unbound_source', async () => {
    await engine.setConfig('persistence.unbound_write', 'database_only');
    let entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    gate = { entered, release: new Promise<void>(resolve => { release = resolve; }) };
    const pending = put('Accepted before binding.');
    await Promise.race([reached, pending.then(early => { throw new Error(`settled before publication: ${JSON.stringify(early.payload)}`); })]);
    await claimWorktree(engine, 'default', root);
    gate = null;
    release();
    const result = await pending;
    expect(result.response.isError).toBe(true);
    expect(result.payload.error).toBe('owner_unavailable');
    expect(result.payload.detail).toBe('unbound_source');
    expect(result.payload.docs).toBe(DOCS);
    expect(result.payload.write_request.state).toBe('failed');
    expect(result.payload.suggestion).toContain('new request_id');
    expect(await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true })).toBeNull();
  });

  test('after binding, sync keeps the database-only page and later writes stay database-only', async () => {
    await engine.setConfig('persistence.unbound_write', 'database_only');
    expect((await put('Written while unbound.')).payload.state).toBe('committed');
    await bindAndActivate();
    const first = await performManagedSync(engine, { sourceId: 'default', noPull: true });
    expect(first.status).toBe('first_sync');
    expect((await engine.getPage('notes/seed', { sourceId: 'default' }))?.source_path).toBe('notes/seed.md');
    const kept = await engine.getPage(slug, { sourceId: 'default' });
    expect(kept?.compiled_truth).toContain('Written while unbound.');
    expect(kept?.source_path ?? null).toBeNull();
    expect(await classification()).toBe('unbound_source');
    // A later edit on the now-bound source publishes no canonical file.
    const edited = await put('Edited after binding.');
    expect(edited.payload.state).toBe('committed');
    expect(edited.payload.write_through).toMatchObject({ written: false, skipped: 'unbound_source' });
    expect(existsSync(join(root, `${slug}.md`))).toBe(false);
    expect(await classification()).toBe('unbound_source');
    // A canonical file appearing at the same path never overwrites the page.
    writeFileSync(join(root, `${slug}.md`), content('Colliding canonical file.'));
    commit(root);
    const collision = await performManagedSync(engine, { sourceId: 'default', noPull: true });
    expect(collision.status).toBe('blocked_by_failures');
    expect(collision.managedWrite).toMatchObject({ slug, write_error: 'source_changed', reason: 'unbound_source' });
    const after = await engine.getPage(slug, { sourceId: 'default' });
    expect(after?.compiled_truth).toContain('Edited after binding.');
    expect(after?.source_path ?? null).toBeNull();
    expect(await classification()).toBe('unbound_source');
  });

  test('after binding, delete, restore and revert of a database-only page never touch a canonical file', async () => {
    await engine.setConfig('persistence.unbound_write', 'database_only');
    expect((await put('Original while unbound.')).payload.state).toBe('committed');
    expect((await put('Second while unbound.')).payload.state).toBe('committed');
    await bindAndActivate();
    const file = join(root, `${slug}.md`);
    const mutate = async (name: string, params: Record<string, unknown> = {}) => {
      const current = await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true });
      const result = await dispatch(name, { slug, request_id: randomUUID(), expected_revision: current!.revision, ...params });
      expect(result.response.isError, JSON.stringify(result.payload)).not.toBe(true);
      expect(result.payload.state).toBe('committed');
      expect(existsSync(file)).toBe(false);
      expect(await classification()).toBe('unbound_source');
      return result;
    };
    await mutate('delete_page');
    expect((await mutate('restore_page')).payload.write_through).toMatchObject({ written: false, skipped: 'unbound_source' });
    expect((await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth).toContain('Second while unbound.');
    const [version] = await engine.executeRaw<{ id: number }>(
      "SELECT v.id FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id='default' AND p.slug=$1 AND v.compiled_truth LIKE '%Original while unbound.%' ORDER BY v.id LIMIT 1", [slug]);
    await mutate('delete_page');
    await mutate('revert_version', { version_id: Number(version.id) });
    expect((await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth).toContain('Original while unbound.');
    // An unrelated file at the page's path is neither refused against nor removed by a delete.
    writeFileSync(file, content('Unrelated file.'));
    const current = await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true });
    const deleted = await dispatch('delete_page', { slug, request_id: randomUUID(), expected_revision: current!.revision });
    expect(deleted.payload.state, JSON.stringify(deleted.payload)).toBe('committed');
    expect(existsSync(file)).toBe(true);
    const tombstone = await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true });
    const purged = await submitPageMutation(localContext(), { operation: 'delete_page',
      params: { slug, purge: true, request_id: randomUUID(), expected_revision: tombstone!.revision } });
    expect(purged.state).toBe('committed');
    expect(await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true })).toBeNull();
    expect(existsSync(file)).toBe(true);
  });

  test('doctor reports the unbound_source count: ok with the bind command while unbound, warn after binding', async () => {
    const { checkUnboundSource } = await import('../../src/commands/doctor/checks/unbound-source.ts');
    const empty = await checkUnboundSource(engine);
    expect(empty.name).toBe('unbound_source');
    expect(empty.status).toBe('ok');
    await engine.setConfig('persistence.unbound_write', 'database_only');
    expect((await put('Counted note.')).payload.state).toBe('committed');
    const unbound = await checkUnboundSource(engine);
    expect(unbound.status).toBe('ok');
    expect(unbound.message).toContain('default: 1');
    expect(unbound.message).toContain('gbrain sources writer claim default --path');
    expect(unbound.details).toMatchObject({ sources: [{ source_id: 'default', pages: 1, bound: false }] });
    await claimWorktree(engine, 'default', root);
    const bound = await checkUnboundSource(engine);
    expect(bound.status).toBe('warn');
    expect(bound.message).toContain('default: 1');
    expect(bound.message).toContain('outside canonical files');
    expect(bound.details).toMatchObject({ sources: [{ source_id: 'default', pages: 1, bound: true }] });
  });
});
