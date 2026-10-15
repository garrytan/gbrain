import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { awaitPendingLastRetrievedWrites } from '../src/core/last-retrieved.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
const older = '2026-01-01T10:00:00.000Z', newer = '2026-01-02T10:00:00.000Z';
const context = (sourceId: string, remote = false): OperationContext => ({ engine, sourceId, remote, config: { engine: 'pglite' }, logger: console, dryRun: false } as OperationContext);
const call = (name: string, params: Record<string, unknown> = {}, source = 'alpha', remote = false) =>
  operations.find(op => op.name === name)!.handler(context(source, remote), params) as Promise<any>;
const iso = (value: unknown) => value == null ? value : new Date(value as string).toISOString();
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await awaitPendingLastRetrievedWrites(); await engine.disconnect(); });
beforeEach(async () => {
  await awaitPendingLastRetrievedWrites(); await resetPgliteState(engine);
  for (const source of ['alpha', 'beta']) {
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [source]);
    await engine.putPage('notes/example', { type: 'note', title: source, compiled_truth: 'Example body', frontmatter: {} }, { sourceId: source });
  }
});
async function stamp(source: string, legacy: string | null, telemetry: string | null) {
  const page = await engine.getPage('notes/example', { sourceId: source });
  await engine.executeRaw('UPDATE pages SET last_retrieved_at=$2::timestamptz WHERE id=$1', [page!.id, legacy]);
  if (telemetry) await engine.executeRaw('INSERT INTO page_retrievals(page_id,last_retrieved_at) VALUES($1,$2::timestamptz) ON CONFLICT(page_id) DO UPDATE SET last_retrieved_at=excluded.last_retrieved_at', [page!.id, telemetry]);
}

test('get_page returns the previous retrieval in full, content-only and partial shapes without changing revision', async () => {
  await stamp('alpha', older, newer);
  const before = await call('get_page', { slug: 'notes/example' });
  expect(iso(before.last_retrieved_at)).toBe(newer);
  await awaitPendingLastRetrievedWrites();
  for (const params of [{ include_content: true, content_only: true }, { body: 'none' }]) {
    const next = await call('get_page', { slug: 'notes/example', ...params });
    expect(new Date(next.last_retrieved_at).getTime()).toBeGreaterThan(new Date(newer).getTime());
    expect(next.revision).toBe(before.revision);
  }
  const canonical = await engine.getPage('notes/example', { sourceId: 'alpha' });
  expect(canonical).not.toHaveProperty('last_retrieved_at');
});

test('list and salience expose null or the newer legacy/side-table value without recording a read', async () => {
  await stamp('beta', older, newer);
  for (const op of ['list_pages', 'get_recent_salience']) {
    const alpha = await call(op);
    expect(alpha).toHaveLength(1);
    expect(alpha[0].last_retrieved_at).toBeNull();
    const beta = await call(op, {}, 'beta', true);
    expect(beta).toHaveLength(1);
    expect(beta[0].source_id).toBe('beta');
    expect(iso(beta[0].last_retrieved_at)).toBe(newer);
  }
  await stamp('beta', newer, older);
  for (const op of ['list_pages', 'get_recent_salience']) {
    expect(iso((await call(op, {}, 'beta'))[0].last_retrieved_at)).toBe(newer);
  }
  const rows = await engine.executeRaw('SELECT * FROM page_retrievals');
  expect(rows).toHaveLength(1);
  expect(iso(rows[0].last_retrieved_at)).toBe(older);
});

test('a first direct read returns null, then its asynchronous telemetry becomes visible', async () => {
  expect((await call('get_page', { slug: 'notes/example' })).last_retrieved_at).toBeNull();
  await awaitPendingLastRetrievedWrites();
  expect((await call('list_pages'))[0].last_retrieved_at).toBeInstanceOf(Date);
});
