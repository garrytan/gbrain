/**
 * #5616 edit_page (O-DX-3, O-ENG-6): exact-string partial edits through the
 * coordinated write path, matched against the caller's authorized view.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test as bunTest } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { buildToolDefs } from '../src/mcp/tool-defs.ts';
import { operations } from '../src/core/operations.ts';
import { registerLocalWriter, withVerifiedLocalRegistration, type LocalRegistration } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { renderTakesFence } from '../src/core/takes-fence.ts';
import { editDiff, editableView } from '../src/core/persistence/page-edit.ts';
import { STARTER_OPS } from '../src/mcp/surface.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import type { Page } from '../src/core/types.ts';

let engine: PGLiteEngine;
let fixture: string;
let remoteRegistration: LocalRegistration;
let cliRegistration: LocalRegistration;
const remoteAuth = { token: 'fixture', clientId: 'fixture-client', scopes: ['read', 'write'], sourceId: 'default', boundSlugPrefixes: ['notes'] };
const SECRET_FACT = 'private-fact-canary-example';
const SECRET_TAKE = 'private-take-canary-example';

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await disposePersistenceConsumer(engine);
  await resetPgliteState(engine);
  _resetWriteThroughCacheForTest();
  fixture = mkdtempSync(join(tmpdir(), 'gb-edit-page-'));
  mkdirSync(join(fixture, 'brain'));
  await engine.setConfig('sync.repo_path', join(fixture, 'brain'));
});
afterEach(async () => { await disposePersistenceConsumer(engine); rmSync(fixture, { recursive: true, force: true }); });

function test(name: string, run: () => Promise<void>, timeout = 30_000) {
  bunTest(name, () => withEnv({ GBRAIN_HOME: join(fixture, 'home') }, async () => {
    remoteRegistration = await registerLocalWriter(engine, 'stdio', { sourceIds: ['*'], operations: null, scopes: ['read', 'write'], slugPrefixes: ['notes'] });
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
async function read(slug: string, remote = true) {
  const result = await call('get_page', { slug, include_content: true }, remote);
  expect(result.isError).toBe(false);
  return result.body as { content: string; revision: string };
}
async function edit(slug: string, edits: Array<{ old_text: string; new_text: string }>, opts: { remote?: boolean; revision?: string; request_id?: string } = {}) {
  const revision = opts.revision ?? (await read(slug, opts.remote ?? true)).revision;
  const params = { slug, expected_revision: revision, edits, request_id: opts.request_id ?? randomUUID() };
  return { ...await call('edit_page', params, opts.remote ?? true), params };
}
const fm = (title: string) => `---\ntitle: ${title}\ntype: note\n---\n\n`;
const fencedBody = () => [
  'Intro line.',
  'Line one.',
  renderTakesFence([{ rowNum: 1, claim: SECRET_TAKE, kind: 'take', holder: 'people/alice-example', weight: 0.6, active: true } as never]),
  'Line two to change.',
  renderFactsTable([
    { rowNum: 1, claim: 'Public fact example', kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium', active: true } as never,
    { rowNum: 2, claim: SECRET_FACT, kind: 'fact', confidence: 1, visibility: 'private', notability: 'medium', active: true } as never,
  ]),
  'Line three.',
].join('\n\n');
async function seed(slug: string, body: string) {
  const put = await call('put_page', { slug, content: fm('Example') + body, request_id: randomUUID() }, false);
  expect({ isError: put.isError, text: put.text }).toMatchObject({ isError: false });
}
const versions = async (slug: string) => (await engine.executeRaw<{ n: number }>(
  'SELECT count(*)::int AS n FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.slug=$1', [slug]))[0].n;

describe('edit_page schema and catalog', () => {
  bunTest('tools/list shows the nested, closed edit object schema', () => {
    const def = buildToolDefs(operations.filter(op => op.name === 'edit_page'))[0];
    expect(def.inputSchema.required).toEqual(['slug', 'expected_revision', 'edits']);
    expect(def.inputSchema.properties.edits).toMatchObject({ type: 'array', items: {
      type: 'object', required: ['old_text', 'new_text'], additionalProperties: false,
      properties: { old_text: { type: 'string' }, new_text: { type: 'string' } } } });
    expect(def.description).toContain('prefer this over put_page');
    expect(STARTER_OPS.has('edit_page')).toBe(true);
  });
});

describe('edit_page receipt diff', () => {
  bunTest('each change block lists removed lines before added lines', () => {
    const { diff } = editDiff('notes/order', 'Keep.\nOld one.\nOld two.\nKeep too.\nOld three.\n', 'Keep.\nNew one.\nNew two.\nKeep too.\nNew three.\n');
    expect(diff.split('\n').filter(l => /^[-+ ]/.test(l) && !/^(---|\+\+\+) /.test(l))).toEqual([
      ' Keep.', '-Old one.', '-Old two.', '+New one.', '+New two.', ' Keep too.', '-Old three.', '+New three.',
    ]);
  });
});

describe('edit_page matching', () => {
  test('a unique match publishes one new revision with a caller-view diff and write-through', async () => {
    await seed('notes/a', 'First line.\n\nSecond line.\n');
    const before = await read('notes/a');
    const result = await edit('notes/a', [{ old_text: 'Second line.', new_text: 'Second line, edited.' }]);
    expect({ isError: result.isError, text: result.text }).toMatchObject({ isError: false });
    expect(result.body.state).toBe('committed');
    expect(result.body.revision).toBeString();
    expect(result.body.revision).not.toBe(before.revision);
    expect(result.body.diff).toContain('-Second line.');
    expect(result.body.diff).toContain('+Second line, edited.');
    expect(result.body.diff.indexOf('-Second line.')).toBeLessThan(result.body.diff.indexOf('+Second line, edited.'));
    expect((await read('notes/a')).content).toBe(before.content.replace('Second line.', 'Second line, edited.'));
    expect(readFileSync(join(fixture, 'brain', 'notes/a.md'), 'utf8')).toContain('Second line, edited.');
  });

  test('zero and multiple matches refuse with the edit index and match count, admitting nothing', async () => {
    await seed('notes/b', 'Repeat.\n\nRepeat.\n\nOnce.\n');
    const requests = async () => (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_requests')).at(0)!.n;
    const admitted = await requests();
    const none = await edit('notes/b', [{ old_text: 'Once.', new_text: 'One.' }, { old_text: 'Missing', new_text: 'x' }]);
    expect(none.body).toMatchObject({ error: 'edit_no_match', detail: 'edit_index=1 match_count=0' });
    const many = await edit('notes/b', [{ old_text: 'Repeat.', new_text: 'x' }]);
    expect(many.body).toMatchObject({ error: 'edit_ambiguous_match', detail: 'edit_index=0 match_count=2' });
    const empty = await edit('notes/b', [{ old_text: '', new_text: 'x' }]);
    expect(empty.body).toMatchObject({ error: 'edit_invalid', detail: 'edit_index=0' });
    expect(await requests()).toBe(admitted);
  });

  test('edits apply in order against the previous result, and a failing third edit rolls back all three', async () => {
    await seed('notes/c', 'Alpha.\n\nBeta.\n');
    const before = await read('notes/c');
    const chained = await edit('notes/c', [{ old_text: 'Alpha.', new_text: 'Gamma.' }, { old_text: 'Gamma.', new_text: 'Delta.' }]);
    expect(chained.isError).toBe(false);
    expect((await read('notes/c')).content).toContain('Delta.');
    const mid = await read('notes/c');
    const failed = await edit('notes/c', [{ old_text: 'Delta.', new_text: 'One.' }, { old_text: 'Beta.', new_text: 'Two.' }, { old_text: 'Alpha.', new_text: 'Three.' }]);
    expect(failed.body).toMatchObject({ error: 'edit_no_match', detail: 'edit_index=2 match_count=0' });
    expect(await read('notes/c')).toEqual(mid);
    expect(mid.revision).not.toBe(before.revision);
  });

  test('a large edit still commits; its retained diff is capped at 8 KB encoded and marked truncated', async () => {
    const lines = Array.from({ length: 400 }, (_, i) => `Line ${i} "quoted" text with a tab\tand more words to widen it.`);
    await seed('notes/big', `${lines.join('\n')}\n`);
    const result = await edit('notes/big', [{ old_text: lines.join('\n'), new_text: lines.map(line => `${line} Edited.`).join('\n') }]);
    expect({ isError: result.isError, text: result.text.slice(0, 300) }).toMatchObject({ isError: false });
    expect(result.body.diff_truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.body.diff))).toBeLessThanOrEqual(8 * 1024);
    const poll = await call('get_write_request', { request_id: result.params.request_id });
    expect(poll.body.outcome.diff).toBe(result.body.diff);
  });

  test('a stale revision is a revision_conflict that carries the current revision', async () => {
    await seed('notes/d', 'Body.\n');
    const stale = (await read('notes/d')).revision;
    expect((await edit('notes/d', [{ old_text: 'Body.', new_text: 'Changed.' }])).isError).toBe(false);
    const current = (await read('notes/d')).revision;
    const conflict = await edit('notes/d', [{ old_text: 'Changed.', new_text: 'Again.' }], { revision: stale });
    expect(conflict.body).toMatchObject({ error: 'revision_conflict', detail: `current_revision=${current}` });
  });

  test('a bound client cannot edit outside its slug prefix', async () => {
    await seed('other/e', 'Body.\n');
    const refused = await call('edit_page', { slug: 'other/e', expected_revision: (await read('other/e', false)).revision,
      edits: [{ old_text: 'Body.', new_text: 'x' }], request_id: randomUUID() });
    expect(refused.body.error).toBe('permission_denied');
  });
});

describe('edit_page protected fences and privacy', () => {
  test('protected text never matches; canonical fences stay in place; private rows never reach diff, receipt, replay or poll', async () => {
    await seed('notes/f', fencedBody());
    const canonicalBefore = (await read('notes/f', false)).content;
    expect(canonicalBefore).toContain(SECRET_FACT);
    expect(canonicalBefore).toContain(SECRET_TAKE);
    // Local callers see the fences but may not edit inside them.
    expect((await edit('notes/f', [{ old_text: SECRET_TAKE, new_text: 'x' }], { remote: false })).body.error).toBe('edit_protected_span');
    expect((await edit('notes/f', [{ old_text: 'Public fact example', new_text: 'x' }], { remote: false })).body.error).toBe('edit_protected_span');
    // Remote callers cannot see hidden rows: they do not match and are never echoed.
    const hidden = await edit('notes/f', [{ old_text: SECRET_FACT, new_text: 'x' }]);
    expect(hidden.body.error).toBe('edit_no_match');
    expect(hidden.text).not.toContain(SECRET_FACT);
    expect((await edit('notes/f', [{ old_text: 'Public fact example', new_text: 'x' }])).body.error).toBe('edit_protected_span');
    expect((await edit('notes/f', [{ old_text: 'Line one.\n\n\n\nLine two', new_text: 'x' }])).body.error).toBe('edit_protected_span');
    const result = await edit('notes/f', [{ old_text: 'Line two to change.', new_text: 'Line two, changed.' }]);
    expect({ isError: result.isError, text: result.text }).toMatchObject({ isError: false });
    const replay = await call('edit_page', result.params);
    const poll = await call('get_write_request', { request_id: result.params.request_id });
    for (const surface of [result.text, replay.text, poll.text]) {
      expect(surface).not.toContain(SECRET_FACT);
      expect(surface).not.toContain(SECRET_TAKE);
    }
    expect(replay.body.revision).toBe(result.body.revision);
    expect(result.body.diff).toContain('+Line two, changed.');
    const canonicalAfter = (await read('notes/f', false)).content;
    expect(canonicalAfter).toBe(canonicalBefore.replace('Line two to change.', 'Line two, changed.'));
  });

  test('the edit surface is byte-equal to get_page content for remote and local readers', async () => {
    const bodies = ['Plain body.\n', fencedBody(), `${fencedBody()}\n\n<!-- timeline -->\n\n- 2026-01-02 Example entry`,
      `Body.\n\n<!-- timeline -->\n\n${renderTakesFence([{ rowNum: 1, claim: SECRET_TAKE, kind: 'take', holder: 'people/alice-example', weight: 0.5, active: true } as never])}`];
    for (const [i, body] of bodies.entries()) {
      const slug = `notes/view-${i}`;
      await seed(slug, body);
      const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
      for (const remote of [true, false]) {
        expect({ slug, remote, view: editableView(snapshot.page as Page, snapshot.tags, remote) }).toEqual({ slug, remote, view: (await read(slug, remote)).content });
      }
      expect(serializePageToMarkdown(snapshot.page as Page, snapshot.tags)).toBe((await read(slug, false)).content);
    }
  });
});

describe('edit_page timeline semantics', () => {
  test('removing a materialized timeline bullet deletes its row in one version; replay changes nothing', async () => {
    await seed('notes/t', 'Body.\n');
    // A database-only row: the next coordinated write materializes it with a marker.
    await engine.addTimelineEntry('notes/t', { date: '2026-03-04', summary: 'Example milestone', source: 'conformance' }, { sourceId: 'default' });
    expect((await edit('notes/t', [{ old_text: 'Body.', new_text: 'Body, touched.' }])).isError).toBe(false);
    const view = (await read('notes/t')).content;
    const lines = view.split('\n');
    const bullet = lines.findIndex(line => line.includes('Example milestone'));
    expect(bullet).toBeGreaterThan(0);
    expect(lines[bullet - 1]).toContain('gbrain:materialized');
    const versionsBefore = await versions('notes/t');
    const removed = await edit('notes/t', [{ old_text: `${lines[bullet - 1]}\n${lines[bullet]}`, new_text: '' }]);
    expect({ isError: removed.isError, text: removed.text }).toMatchObject({ isError: false });
    expect((await read('notes/t')).content).not.toContain('Example milestone');
    expect(await engine.getTimeline('notes/t', { sourceId: 'default' })).toEqual([]);
    expect(await versions('notes/t')).toBe(versionsBefore + 1);
    const poll = await call('get_write_request', { request_id: removed.params.request_id });
    expect(poll.body.operation).toBe('edit_page');
    const replay = await call('edit_page', removed.params);
    expect(replay.body.revision).toBe(removed.body.revision);
    expect(await versions('notes/t')).toBe(versionsBefore + 1);
    expect(await engine.getTimeline('notes/t', { sourceId: 'default' })).toEqual([]);
  });
});
