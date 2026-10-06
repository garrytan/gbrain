/**
 * Always-loaded core memory surfaces over the real write path: the
 * `gbrain core` CLI (add/remove/status/diff/ack), notices and the delivery
 * sensitivity policy in the rendered block, the core_memory doctor check,
 * and `remember` with items[]. PGLite in-memory ($0).
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
import { listCorePages, loadCoreBlock } from '../src/core/core-memory.ts';
import { runCore } from '../src/commands/core.ts';
import { coreMemoryCheck } from '../src/commands/doctor/checks/core-memory.ts';

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
  fixture = mkdtempSync(join(tmpdir(), 'gb-core-cli-'));
  mkdirSync(join(fixture, 'brain'));
  await engine.setConfig('sync.repo_path', join(fixture, 'brain'));
  await engine.setConfig('memory.core.enabled', 'true');
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

async function cli(args: string[]): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log, error = console.error;
  console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.join(' ')); };
  try { await withVerifiedLocalRegistration(engine, cliRegistration, () => runCore(engine, args)); }
  finally { console.log = log; console.error = error; }
  return { out: out.join('\n'), err: err.join('\n') };
}

describe('gbrain core CLI', () => {
  test('add, list, status, remove round-trip through put_page as the owner', async () => {
    await put('notes/prefs', page('Working preferences', 'Prefers short answers.'), false);
    expect((await cli(['add', 'notes/prefs', '--priority', '5'])).out).toContain('Now in core: default:notes/prefs');
    expect(await corePages()).toEqual(['notes/prefs']);
    const listed = JSON.parse((await cli(['list', '--json'])).out);
    expect(listed.pages).toEqual([expect.objectContaining({ slug: 'notes/prefs', priority: 5 })]);
    const status = JSON.parse((await cli(['status', '--json'])).out);
    expect(status).toMatchObject({ enabled: true, pages: 1, chars_limit: 4000, over_budget: false });
    expect((await cli(['add', 'notes/prefs', '--priority', '5'])).out).toContain('Already in core');
    expect((await cli(['remove', 'notes/prefs'])).out).toContain('Now out of core');
    expect(await corePages()).toEqual([]);
    expect((await cli(['add', 'notes/missing'])).err).toContain('No live page default:notes/missing');
  });

  test('core is opt-in: with memory.core.enabled unset, add and init say how to turn it on', async () => {
    await engine.unsetConfig('memory.core.enabled');
    await put('notes/prefs', page('Working preferences', 'Prefers short answers.'), false);
    const added = (await cli(['add', 'notes/prefs'])).out;
    expect(added).toContain('Now in core: default:notes/prefs');
    expect(added).toContain('gbrain config set memory.core.enabled true');
    expect((await cli(['init'])).out).toContain('gbrain config set memory.core.enabled true');
    expect(JSON.parse((await cli(['status', '--json'])).out)).toMatchObject({ enabled: false, pages: 2 });
  });

  test('init creates a marked starter page; the owner add is held to the budget', async () => {
    expect((await cli(['init'])).out).toContain('Created default:core/about-the-user');
    expect(await corePages()).toEqual(['core/about-the-user']);
    await engine.setConfig('memory.core.max_chars', '500');
    await put('notes/long', page('Long', 'x'.repeat(400)), false);
    expect((await cli(['add', 'notes/long'])).err).toContain('over the 500-char budget');
    expect(await corePages()).toEqual(['core/about-the-user']);
  });

  test('a remote edit shows a notice in the block until diff + ack', async () => {
    await put('people/alice-example', page('Alice Example', 'Prefers tea.', { always_load: true }), false);
    const rev = await revision('people/alice-example');
    await put('people/alice-example', page('Alice Example', 'Prefers coffee.'), true, { expected_revision: rev });
    const block = await loadCoreBlock(engine, { sessionSourceId: 'default' });
    expect(block.text).toContain('Core page default:people/alice-example was edited remotely');
    const diff = (await cli(['diff', 'people/alice-example'])).out;
    expect(diff).toContain('- Prefers tea.');
    expect(diff).toContain('+ Prefers coffee.');
    const current = await revision('people/alice-example');
    expect((await cli(['ack', 'people/alice-example', '--revision', current])).out).toContain('Acknowledged 1 edit');
    expect((await loadCoreBlock(engine, { sessionSourceId: 'default' })).text).not.toContain('edited remotely');
  });
});

describe('delivery sensitivity policy', () => {
  test('contact details are redacted in place; a credential withholds the page with a visible line', async () => {
    await put('notes/contact', page('Contact', 'Reach the user at alice@example.com.', { always_load: true }), false);
    await put('notes/key', page('Key', `Deploy key ghp_${'a1B2c3D4e5F6g7H8i9J0'.repeat(2)}`, { always_load: true }), false);
    const block = await loadCoreBlock(engine, { sessionSourceId: 'default' });
    expect(block.text).toContain('[redacted email]');
    expect(block.text).not.toContain('alice@example.com');
    expect(block.text).toContain('[core page default:notes/key withheld: secret:');
    expect(block.text).not.toContain('ghp_');
  });
});

describe('core_memory doctor check', () => {
  test('ok when empty; warns over budget and on bad stored config', async () => {
    expect((await coreMemoryCheck(engine)).status).toBe('ok');
    await put('notes/a', page('A', 'y'.repeat(700), { always_load: true }), false);
    await engine.setConfig('memory.core.max_chars', '500');
    await engine.setConfig('memory.pressure.warn_ratio', '2');
    const check = await coreMemoryCheck(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('over the 500-char budget');
    expect(check.message).toContain('memory.pressure.warn_ratio=2 is ignored');
  });
});

describe('remember items[]', () => {
  test('saves each item, and a replay with the same request_id writes nothing new', async () => {
    const request_id = randomUUID();
    const params = { request_id, provenance: 'user said, 2026-10-04', items: [{ fact: 'Prefers tea over coffee', entity: 'people/alice-example' }, { fact: 'Ships on Fridays' }] };
    const first = await call('remember', params, true);
    expect({ isError: first.isError, text: first.text }).toMatchObject({ isError: false });
    expect(first.body).toMatchObject({ saved: 2, failed: 0, partial: false });
    const [{ n }] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM facts`);
    const replay = await call('remember', params, true);
    expect(replay.body.items.map((i: { request_id: string }) => i.request_id)).toEqual(first.body.items.map((i: { request_id: string }) => i.request_id));
    const [{ n: after }] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM facts`);
    expect(after).toBe(n);
  });

  test('provenance may be given per item instead of at the top level', async () => {
    const r = await call('remember', { items: [{ fact: 'Runs on Saturdays', provenance: 'user said' }, { fact: 'Uses Hoka shoes', provenance: 'user said' }] }, true);
    expect({ isError: r.isError, text: r.text }).toMatchObject({ isError: false });
    expect(r.body).toMatchObject({ saved: 2, failed: 0 });
    const missing = await call('remember', { items: [{ fact: 'No source' }] }, true);
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('items[0]');
  });

  test('one invalid item refuses the batch before any write', async () => {
    const bad = await call('remember', { provenance: 'p', items: [{ fact: 'ok' }, { fact: '' }] }, true);
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('items[1]');
    const [{ n }] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM facts`);
    expect(n).toBe(0);
  });
});
