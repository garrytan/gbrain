/**
 * Always-loaded core tier write-path guard (src/core/persistence/core-guard.ts)
 * through the coordinated write path: owner-only marking, brain-wide budget,
 * remote-edit policy and notices, remote delete. PGLite in-memory ($0).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test as bunTest } from 'bun:test';
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
import { coreLockSources, lockCoreSources } from '../src/core/persistence/core-guard.ts';
import { listCorePages } from '../src/core/core-memory.ts';

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
  fixture = mkdtempSync(join(tmpdir(), 'gb-core-guard-'));
  mkdirSync(join(fixture, 'brain'));
  await engine.setConfig('sync.repo_path', join(fixture, 'brain'));
});
afterEach(async () => { await disposePersistenceConsumer(engine); rmSync(fixture, { recursive: true, force: true }); });

function test(name: string, run: () => Promise<void>, timeout = 30_000) {
  bunTest(name, () => withEnv({ GBRAIN_HOME: join(fixture, 'home') }, async () => {
    remoteRegistration = await registerLocalWriter(engine, 'stdio', { sourceIds: ['*'], operations: null, scopes: ['read', 'write'], slugPrefixes: null });
    cliRegistration = await registerLocalWriter(engine, 'cli');
    try { await run(); } finally { await disposePersistenceConsumer(engine); }
  }), timeout);
}

async function call(name: string, params: Record<string, unknown>, remote = true) {
  const response = await withVerifiedLocalRegistration(engine, remote ? remoteRegistration : cliRegistration, () => dispatchToolCall(engine, name, params, {
    remote, config: { engine: 'pglite' }, sourceId: 'default', ...(remote ? { auth: remoteAuth } : {}),
    logger: { info() {}, warn() {}, error() {} },
  }));
  const text = (response.content[0] as { text: string }).text;
  return { isError: response.isError === true, body: JSON.parse(text), text };
}
const page = (title: string, body: string, fm: Record<string, unknown> = {}) =>
  `---\ntitle: ${title}\ntype: note\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')}${Object.keys(fm).length ? '\n' : ''}---\n\n${body}\n`;
async function put(slug: string, content: string, remote: boolean, extra: Record<string, unknown> = {}) {
  return call('put_page', { slug, content, request_id: randomUUID(), ...extra }, remote);
}
async function revision(slug: string) {
  const r = await call('get_page', { slug, include_content: true }, false);
  return r.body.revision as string;
}
const corePages = async () => (await listCorePages(engine)).map(p => p.slug).sort();

describe('owner-only marking', () => {
  test('the owner (local CLI) designates a page; a remote caller cannot add or remove always_load', async () => {
    const owner = await put('people/alice-example', page('Alice Example', 'Prefers tea.', { always_load: true }), false);
    expect({ isError: owner.isError, text: owner.text }).toMatchObject({ isError: false });
    expect(await corePages()).toEqual(['people/alice-example']);
    expect(owner.body.core).toMatchObject({ chars_limit: 4000 });

    const add = await put('notes/remote', page('Remote', 'x', { always_load: true }), true);
    expect(add.body).toMatchObject({ error: 'core_mark_owner_only' });
    expect(add.body.message).toContain('gbrain core add --source default notes/remote');

    const rev = await revision('people/alice-example');
    const flip = await put('people/alice-example', page('Alice Example', 'Prefers tea.', { always_load: false }), true, { expected_revision: rev });
    expect(flip.body).toMatchObject({ error: 'core_mark_owner_only' });
    const prio = await put('people/alice-example', page('Alice Example', 'Prefers tea.', { always_load: true, core_priority: 1 }), true, { expected_revision: rev });
    expect(prio.body).toMatchObject({ error: 'core_mark_owner_only' });
    expect(await corePages()).toEqual(['people/alice-example']);
  });

  test('a remote rewrite that omits always_load keeps the page in core', async () => {
    await put('people/alice-example', page('Alice Example', 'Prefers tea.', { always_load: true, core_priority: 3 }), false);
    const rev = await revision('people/alice-example');
    const rewrite = await put('people/alice-example', page('Alice Example', 'Prefers green tea.'), true, { expected_revision: rev });
    expect({ isError: rewrite.isError, text: rewrite.text }).toMatchObject({ isError: false });
    const [row] = await engine.executeRaw<{ frontmatter: Record<string, unknown>; compiled_truth: string }>(
      `SELECT frontmatter, compiled_truth FROM pages WHERE slug='people/alice-example'`);
    expect(row.frontmatter.always_load).toBe(true);
    expect(Number(row.frontmatter.core_priority)).toBe(3);
    expect(row.compiled_truth).toContain('green tea');
  });

  test('a remote always_load: false on a non-core page is a no-op, not a refusal', async () => {
    const r = await put('notes/plain', page('Plain', 'x', { always_load: false }), true);
    expect({ isError: r.isError, text: r.text }).toMatchObject({ isError: false });
  });

  test('a remote caller cannot delete a core page', async () => {
    await put('people/alice-example', page('Alice Example', 'Prefers tea.', { always_load: true }), false);
    const del = await call('delete_page', { slug: 'people/alice-example', expected_revision: await revision('people/alice-example'), request_id: randomUUID() }, true);
    expect(del.body).toMatchObject({ error: 'core_delete_owner_only' });
    expect(await corePages()).toEqual(['people/alice-example']);
  });
});

describe('budget', () => {
  test('growth past the brain-wide budget is refused; shrinking passes; timeline never counts', async () => {
    await engine.setConfig('memory.core.max_chars', '600');
    const ok = await put('people/alice-example', page('Alice Example', 'a'.repeat(300), { always_load: true }), false);
    expect(ok.isError).toBe(false);
    const big = await put('notes/big', page('Big', 'b'.repeat(400), { always_load: true }), false);
    expect(big.body).toMatchObject({ error: 'core_budget_exceeded' });
    expect(big.body.message).toContain('over the 600-char budget');
    expect(big.body.fix?.argv.slice(0, 4)).toEqual(['gbrain', 'core', 'status', '--json']);
    expect(await corePages()).toEqual(['people/alice-example']);

    // Lower the limit below current usage: growth refused, shrinking passes.
    await engine.setConfig('memory.core.max_chars', '500');
    let rev = await revision('people/alice-example');
    const grow = await put('people/alice-example', page('Alice Example', 'a'.repeat(600), { always_load: true }), true, { expected_revision: rev });
    expect(grow.body).toMatchObject({ error: 'core_budget_exceeded' });
    const shrink = await put('people/alice-example', page('Alice Example', 'a'.repeat(100), { always_load: true }), true, { expected_revision: rev });
    expect({ isError: shrink.isError, text: shrink.text }).toMatchObject({ isError: false });

    rev = await revision('people/alice-example');
    const tl = await call('add_timeline_entry', { slug: 'people/alice-example', date: '2026-10-04', summary: 'x'.repeat(280), request_id: randomUUID() }, true);
    expect({ isError: tl.isError, text: tl.text }).toMatchObject({ isError: false });
  });

  test('remote budget diagnostics never name pages in other sources', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('wiki', 'wiki') ON CONFLICT DO NOTHING`);
    await engine.putPage('projects/secret-wiki-core', { type: 'project', title: 'Secret wiki core', compiled_truth: 'w'.repeat(300), frontmatter: { always_load: true } }, { sourceId: 'wiki' });
    await engine.setConfig('memory.core.max_chars', '500');
    await put('people/alice-example', page('Alice Example', 'a', { always_load: true }), false);
    const rev = await revision('people/alice-example');
    const grow = await put('people/alice-example', page('Alice Example', 'a'.repeat(400), { always_load: true }), true, { expected_revision: rev });
    expect(grow.body).toMatchObject({ error: 'core_budget_exceeded' });
    expect(grow.text).not.toContain('secret-wiki-core');
    expect(grow.text).toContain('sources you cannot read');
  });
});

describe('remote-edit policy', () => {
  test('notify records a notice; refuse rejects the edit', async () => {
    await put('people/alice-example', page('Alice Example', 'Prefers tea.', { always_load: true }), false);
    let rev = await revision('people/alice-example');
    const edit = await call('edit_page', { slug: 'people/alice-example', expected_revision: rev, edits: [{ old_text: 'Prefers tea.', new_text: 'Prefers coffee.' }], request_id: randomUUID() }, true);
    expect({ isError: edit.isError, text: edit.text }).toMatchObject({ isError: false });
    const notices = await engine.executeRaw<{ slug: string; actor: string; revision: string | null }>(`SELECT slug, actor, revision FROM core_edit_notices`);
    expect(notices).toHaveLength(1);
    expect(notices[0].slug).toBe('people/alice-example');
    expect(notices[0].revision).toBe(edit.body.revision);

    await engine.setConfig('memory.core.remote_edit', 'refuse');
    rev = await revision('people/alice-example');
    const refused = await call('edit_page', { slug: 'people/alice-example', expected_revision: rev, edits: [{ old_text: 'Prefers coffee.', new_text: 'Prefers water.' }], request_id: randomUUID() }, true);
    expect(refused.body).toMatchObject({ error: 'core_remote_edit_refused' });
    // The owner still edits freely.
    const owner = await call('edit_page', { slug: 'people/alice-example', expected_revision: rev, edits: [{ old_text: 'Prefers coffee.', new_text: 'Prefers water.' }], request_id: randomUUID() }, false);
    expect({ isError: owner.isError, text: owner.text }).toMatchObject({ isError: false });
    expect((await engine.executeRaw(`SELECT 1 FROM core_edit_notices`)).length).toBe(1);
  });

  test('remember writing a facts row into a core page is budget-checked and noticed', async () => {
    await put('people/alice-example', page('Alice Example', 'Prefers tea.', { always_load: true }), false);
    const r = await call('remember', { fact: 'Alice prefers oolong over green tea', provenance: 'user told me, 2026-10-04', entity: 'people/alice-example', request_id: randomUUID() }, true);
    expect({ isError: r.isError, text: r.text }).toMatchObject({ isError: false });
    const [row] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM core_edit_notices`);
    expect(row.n).toBe(1);
    await engine.setConfig('memory.core.max_chars', '500');
    const before = await engine.executeRaw<{ compiled_truth: string }>(`SELECT compiled_truth FROM pages WHERE slug='people/alice-example'`);
    const over = await call('remember', { fact: 'z'.repeat(400), provenance: 'user told me, 2026-10-04', entity: 'people/alice-example', request_id: randomUUID() }, true);
    // The frozen verb contract keeps its code; the core refusal rides detail + write_error.
    expect(over.body).toMatchObject({ error: 'invalid_params', detail: 'core_budget_exceeded', write_error: 'core_budget_exceeded' });
    expect(over.body.message).toContain('over the 500-char budget');
    const after = await engine.executeRaw<{ compiled_truth: string }>(`SELECT compiled_truth FROM pages WHERE slug='people/alice-example'`);
    expect(after[0].compiled_truth).toBe(before[0].compiled_truth);
  });
});

describe('lock function', () => {
  bunTest('locks own source and default, deduplicated, in id order', async () => {
    expect(coreLockSources('wiki')).toEqual(['default', 'wiki']);
    expect(coreLockSources('default')).toEqual(['default']);
    await engine.transaction(async tx => { await lockCoreSources(tx, ['wiki', 'default', 'wiki']); });
  });
});
