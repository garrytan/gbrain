import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { timelineOperations } from '../src/core/ops/timeline.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';

const root = mkdtempSync(join(tmpdir(), 'gbrain-timeline-identity-'));
const sourceId = 'timeline-identity-test';
let engine: PGLiteEngine;
let ctx: OperationContext;
const submit = (operation: string, params: Record<string, unknown>) => submitPageMutation(ctx, {
  operation, params: { request_id: randomUUID(), ...params },
});

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  ctx = { engine, config: { engine: 'pglite' }, sourceId, remote: false, dryRun: false,
    logger: { info() {}, warn() {}, error() {} } };
  await submit('put_page', { slug: 'page', content: '---\ntype: note\ntitle: Example\n---\nStable prose\n' });
}, 120_000);

afterAll(async () => {
  if (engine) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  rmSync(root, { recursive: true, force: true });
});

test('timeline identity collisions retain a failed replay receipt without changing canonical state', async () => {
  const original = { slug: 'page', date: '2026-09-16', summary: 'Example milestone', source: 'manual', detail: 'Original evidence' };
  await submit('add_timeline_entry', original);
  const before = (await engine.readPageSnapshot('page', { sourceId }))!;
  const file = join(root, 'page.md');
  const bytes = readFileSync(file, 'utf8');
  const mtime = statSync(file).mtimeMs;
  const versions = await engine.executeRaw('SELECT id FROM page_versions WHERE page_id=$1 ORDER BY id', [before.page.id]);
  const rows = await engine.getTimeline('page', { sourceId });
  const requestId = randomUUID();
  const conflict = { ...original, detail: 'Different evidence', request_id: requestId };

  for (let replay = 0; replay < 2; replay++) {
    await expect(submit('add_timeline_entry', conflict)).rejects.toMatchObject({
      code: 'invalid_params', message: 'This timeline identity already exists with different detail.',
      writeRequest: { request_id: requestId, state: 'failed' },
    });
  }
  await expect(submit('add_timeline_entry', { ...original, request_id: requestId }))
    .rejects.toMatchObject({ code: 'idempotency_conflict' });
  const replay = await submit('add_timeline_entry', original);
  expect(replay).toMatchObject({ status: 'skipped', reason: 'duplicate', revision: before.revision });
  expect((await engine.readPageSnapshot('page', { sourceId }))!.revision).toBe(before.revision);
  expect(readFileSync(file, 'utf8')).toBe(bytes);
  expect(statSync(file).mtimeMs).toBe(mtime);
  expect(await engine.executeRaw('SELECT id FROM page_versions WHERE page_id=$1 ORDER BY id', [before.page.id])).toEqual(versions);
  expect(await engine.getTimeline('page', { sourceId })).toEqual(rows);
  expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE request_id=$1::uuid', [requestId])).toHaveLength(1);
});

test('public timeline replay survives page removal and recreation without touching the replacement', async () => {
  const slug = 'retained-receipt';
  await submit('put_page', { slug, content: '---\ntype: note\ntitle: Retained receipt\n---\nOriginal prose\n' });
  const operation = timelineOperations.find(operation => operation.name === 'add_timeline_entry')!;
  const params = { slug, date: '2026-09-16', summary: 'Original milestone', request_id: randomUUID() };
  const first = await operation.handler(ctx, params);
  await submit('delete_page', { slug, expected_revision: (await engine.readPageSnapshot(slug, { sourceId }))!.revision });
  await disposePersistenceConsumer(engine);
  // Model later purge without removing durable receipts or source authority.
  await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.deletePage(slug, { sourceId })));
  expect(await engine.readPageSnapshot(slug, { sourceId })).toBeNull();
  expect(await operation.handler(ctx, params)).toEqual(first);
  await expect(operation.handler(ctx, { ...params, summary: 'Altered retry' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
  await submit('put_page', { slug, content: '---\ntype: note\ntitle: Replacement\n---\nReplacement prose\n' });
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
  const file = join(root, `${slug}.md`);
  const bytes = readFileSync(file, 'utf8');
  expect(await operation.handler(ctx, params)).toEqual(first);
  expect(await engine.readPageSnapshot(slug, { sourceId })).toEqual(snapshot);
  expect(readFileSync(file, 'utf8')).toBe(bytes);
  expect(await engine.getTimeline(slug, { sourceId })).toHaveLength(0);
  expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE request_id=$1::uuid', [params.request_id])).toHaveLength(1);
});
