/**
 * F6 (Cat 40 Hard): write ids any agent can send. A write op's request_id may be any
 * 1-128 printable ASCII string; a non-UUID maps to a deterministic UUIDv5 under one
 * fixed namespace, responses keep request_id as that UUID and echo the client's string
 * as client_request_id (stored outside the intent digest, kept through restart and
 * compaction), and the receipt helpers accept either id.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { compactWriteReceipts } from '../src/core/persistence/journal.ts';
import { childRequestId } from '../src/core/remember-batch.ts';
import { CLIENT_REQUEST_ID_MAX, clientRequestIdOf, clientRequestUuid, parseWriteRequestId } from '../src/core/persistence/preconditions.ts';

const ID = 'remember-acme-example-1';
const ID_UUID = 'ef1eabdc-3cd7-523b-934a-f6e477fe2211';
const CONFLICT = 'This request_id was used for a different write; send a new one or omit it.';
let engine: PGLiteEngine;

async function callOn(target: PGLiteEngine, name: string, params: Record<string, unknown>) {
  // The Cat 40 serve path: `gbrain serve --surface starter` over stdio.
  const res = await dispatchToolCall(target, name, params, { remote: true, transport: 'stdio', surface: 'starter', takesHoldersAllowList: ['world'], sourceId: 'default' });
  return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text!) as Record<string, any> };
}
const call = (name: string, params: Record<string, unknown>) => callOn(engine, name, params);
async function local(name: string, params: Record<string, unknown>) {
  const res = await dispatchToolCall(engine, name, params, { remote: false });
  return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text!) as Record<string, any> };
}
const page = (title: string) => `---\ntitle: ${title}\ntype: note\n---\n# ${title}\n\nBody of ${title}.\n`;
const remember = (fact: string, request_id?: string) =>
  call('remember', { fact, provenance: 'test', entity: 'crm/acme-example', ...(request_id !== undefined ? { request_id } : {}) });

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { resetGateway(); await engine.disconnect(); });
beforeEach(async () => {
  await disposePersistenceConsumer(engine);
  await resetPgliteState(engine);
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  await local('put_page', { slug: 'crm/acme-example', content: '---\ntitle: Acme Example\ntype: company\n---\n# Acme Example\n\nA company.\n' });
});

describe('request_id normalization', () => {
  test('a non-UUID maps to its RFC 4122 UUIDv5; a UUID passes through; uppercase UUIDs keep their identity', () => {
    expect(parseWriteRequestId(ID)).toBe(ID_UUID);
    expect(parseWriteRequestId('a')).toBe('14c7da2e-51c2-50fc-b390-2d6941235ec7');
    expect(parseWriteRequestId('x'.repeat(CLIENT_REQUEST_ID_MAX))).toBe('ba100e41-aa89-5d75-8d67-4adc9af858a2');
    const uuid = randomUUID();
    expect(parseWriteRequestId(uuid)).toBe(uuid);
    expect(parseWriteRequestId(uuid.toUpperCase())).toBe(uuid);
    expect(clientRequestIdOf(uuid.toUpperCase())).toBeUndefined();
    expect(clientRequestIdOf(ID)).toBe(ID);
    expect(parseWriteRequestId(undefined)).toBeUndefined();
  });

  test('invalid ids name the limits, the actual length and a valid example', () => {
    for (const [value, actual] of [['', 'this one has 0 characters'], ['x'.repeat(129), 'this one has 129 characters'],
      ['two words', 'this one has 9 characters, including a space or non-ASCII character'], ['café-1', 'this one has 6 characters'], [42, 'this one is a number'], [null, 'this one is null']] as const) {
      let error: any;
      try { parseWriteRequestId(value); } catch (e) { error = e; }
      expect(error?.code).toBe('invalid_params');
      expect(error.message).toContain('request_id must be 1 to 128 printable ASCII characters with no spaces');
      expect(error.message).toContain(actual);
      expect(error.suggestion).toContain('"remember-acme-example-1"');
    }
  });

  test('distinct ids never collide in the test set, and no mapped id equals its own input', () => {
    const seen = new Map<string, string>();
    for (let i = 0; i < 20_000; i++) {
      for (const id of [`r${i}`, `R${i}`, `remember-${i}`, `${i}`]) {
        const mapped = clientRequestUuid(id);
        expect(seen.get(mapped) ?? id).toBe(id);
        seen.set(mapped, id);
      }
    }
    expect(seen.size).toBe(80_000);
  });
});

describe('write ops with a client request_id', () => {
  test('the same non-UUID replays to the same receipt; get_write_request finds it by the string and by the UUID', async () => {
    const first = await remember('Alice Example leads procurement at Acme Example.', ID);
    expect(first.isError).toBe(false);
    expect(first.body).toMatchObject({ status: 'inserted', request_id: ID_UUID, client_request_id: ID, state: 'committed' });
    const replay = await remember('Alice Example leads procurement at Acme Example.', ID);
    expect(replay.body).toMatchObject({ id: first.body.id, status: 'inserted', request_id: ID_UUID, client_request_id: ID });
    const [{ n }] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM facts");
    expect(Number(n)).toBe(1);
    for (const request_id of [ID, ID_UUID, ID_UUID.toUpperCase()]) {
      const receipt = await call('get_write_request', { request_id });
      expect(receipt.isError).toBe(false);
      expect(receipt.body).toMatchObject({ request_id: ID_UUID, client_request_id: ID, state: 'committed', operation: 'remember' });
    }
    const listed = await call('list_write_requests', {});
    expect(listed.body.requests.find((r: any) => r.request_id === ID_UUID)).toMatchObject({ client_request_id: ID });
    const [row] = await engine.executeRaw<{ client_request_id: string; intent: Record<string, unknown> }>(
      'SELECT client_request_id,intent FROM persistence_requests WHERE request_id=$1::uuid', [ID_UUID]);
    expect(row!.client_request_id).toBe(ID);
    expect(JSON.stringify(row!.intent)).not.toContain(ID);
  });

  test('replaying by the canonical UUID returns the same receipt; a UUID sent as such has no client_request_id', async () => {
    const first = await remember('Alice Example prefers async updates.', ID);
    const byUuid = await remember('Alice Example prefers async updates.', ID_UUID);
    expect(byUuid.body).toMatchObject({ id: first.body.id, request_id: ID_UUID, client_request_id: ID });
    const upper = randomUUID().toUpperCase();
    const plain = await remember('Alice Example joined in 2025.', upper);
    expect(plain.body.request_id).toBe(upper.toLowerCase());
    expect(plain.body.client_request_id).toBeUndefined();
    expect((await remember('Alice Example joined in 2025.', upper.toLowerCase())).body.id).toBe(plain.body.id);
  });

  test('reuse for a different write is refused by the string and by the UUID (remember keeps its frozen shape)', async () => {
    await remember('Alice Example works remotely.', ID);
    for (const request_id of [ID, ID_UUID]) {
      const reuse = await remember('Alice Example works from the office.', request_id);
      expect(reuse.isError).toBe(true);
      expect(reuse.body).toMatchObject({ code: 'invalid_params', write_error: 'idempotency_conflict', message: CONFLICT });
      expect(reuse.body.fix).toMatchObject({ next: 'run', mcp: { tool: 'get_write_request', arguments: { request_id: ID } } });
    }
    await call('put_page', { slug: 'notes/reuse', content: page('Reuse one'), request_id: 'page-write-1' });
    const pageReuse = await call('put_page', { slug: 'notes/reuse', content: page('Reuse two'), request_id: 'page-write-1' });
    expect(pageReuse.body).toMatchObject({ code: 'idempotency_conflict', message: CONFLICT });
    expect(pageReuse.body.fix.next).toBe('run');
  });

  test('a lost reply is recovered by replaying with the string or reading by the UUID', async () => {
    const id = 'put-notes-lost-reply';
    const first = await call('put_page', { slug: 'notes/lost', content: page('Lost reply'), request_id: id });
    expect(first.isError).toBe(false);
    expect(first.body).toMatchObject({ request_id: clientRequestUuid(id), client_request_id: id, state: 'committed' });
    const replay = await call('put_page', { slug: 'notes/lost', content: page('Lost reply'), request_id: id });
    expect(replay.body).toMatchObject({ request_id: first.body.request_id, revision: first.body.revision, client_request_id: id });
    expect((await call('get_write_request', { request_id: clientRequestUuid(id) })).body).toMatchObject({ state: 'committed', client_request_id: id });
  });

  test('a pending write is read and cancelled by the string or the UUID', async () => {
    // Hold every claim of notes/pending so the write stays queued.
    await engine.executeRaw(`CREATE OR REPLACE FUNCTION f6_hold_claim() RETURNS trigger AS $$
      BEGIN IF NEW.state = 'running' AND NEW.slug LIKE 'notes/pending%' THEN RETURN NULL; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await engine.executeRaw('CREATE TRIGGER f6_hold_claim BEFORE UPDATE ON persistence_requests FOR EACH ROW EXECUTE FUNCTION f6_hold_claim()');
    try {
      for (const [slug, id, cancelBy] of [['notes/pending-a', 'pending-by-string', 'string'], ['notes/pending-b', 'pending-by-uuid', 'uuid']] as const) {
        const accepted = await call('put_page', { slug, content: page(slug), request_id: id, wait_ms: 0 });
        expect(accepted.isError).toBe(true);
        expect(accepted.body).toMatchObject({ code: 'write_pending', write_request: { request_id: clientRequestUuid(id), client_request_id: id, state: 'queued' } });
        for (const request_id of [id, clientRequestUuid(id)]) {
          expect((await call('get_write_request', { request_id })).body).toMatchObject({ state: 'queued', client_request_id: id });
        }
        const cancelled = await call('cancel_write_request', { request_id: cancelBy === 'string' ? id : clientRequestUuid(id) });
        expect(cancelled.body).toMatchObject({ request_id: clientRequestUuid(id), client_request_id: id, state: 'cancelled' });
        const replay = await call('put_page', { slug, content: page(slug), request_id: id, wait_ms: 0 });
        expect(replay.body.write_request).toMatchObject({ request_id: clientRequestUuid(id), client_request_id: id, state: 'cancelled' });
      }
    } finally {
      await engine.executeRaw('DROP TRIGGER IF EXISTS f6_hold_claim ON persistence_requests');
      await engine.executeRaw('DROP FUNCTION IF EXISTS f6_hold_claim()');
    }
  });

  test('principals are independent: the same string from two callers is two writes', async () => {
    const id = 'shared-client-id';
    const remote = await call('put_page', { slug: 'notes/remote', content: page('Remote'), request_id: id });
    const cli = await local('put_page', { slug: 'notes/cli', content: page('Cli'), request_id: id });
    expect(remote.isError).toBe(false);
    expect(cli.isError).toBe(false);
    expect(cli.body.request_id).toBe(remote.body.request_id);
    const rows = await engine.executeRaw<{ principal_kind: string; slug: string; client_request_id: string }>(
      'SELECT principal_kind,slug,client_request_id FROM persistence_requests WHERE request_id=$1::uuid ORDER BY slug', [clientRequestUuid(id)]);
    expect(rows.map(r => [r.slug, r.client_request_id])).toEqual([['notes/cli', id], ['notes/remote', id]]);
    expect(new Set(rows.map(r => r.principal_kind)).size).toBe(2);
  });

  test('compaction keeps client_request_id, and the compacted receipt still replays', async () => {
    const first = await remember('Alice Example signs renewals.', ID);
    await engine.executeRaw("UPDATE persistence_requests SET completed_at=now()-interval '400 days' WHERE request_id=$1::uuid", [ID_UUID]);
    // Keyless brains leave the embedding effect queued; compaction retains receipts with unfinished effects.
    await engine.executeRaw("UPDATE persistence_effects SET state='committed' WHERE request_id=(SELECT id FROM persistence_requests WHERE request_id=$1::uuid)", [ID_UUID]);
    expect(await compactWriteReceipts(engine, 1)).toBeGreaterThanOrEqual(1);
    const receipt = await call('get_write_request', { request_id: ID });
    expect(receipt.body).toMatchObject({ request_id: ID_UUID, client_request_id: ID, compacted: true, state: 'committed' });
    const replay = await remember('Alice Example signs renewals.', ID);
    expect(replay.body).toMatchObject({ id: first.body.id, client_request_id: ID, compacted: true });
  });
});

describe('remember(items) with a non-UUID root', () => {
  test('children derive from the root string, so a batch accepted before the upgrade replays to the same receipts', async () => {
    const root = 'batch-legacy-root';
    const items = [{ fact: 'Alice Example owns the renewal.', provenance: 'test', entity: 'crm/acme-example' },
      { fact: 'Alice Example approves discounts.', provenance: 'test', entity: 'crm/acme-example' }];
    const first = await call('remember', { items, request_id: root });
    expect(first.body).toMatchObject({ request_id: clientRequestUuid(root), client_request_id: root, saved: 2, failed: 0 });
    expect(first.body.items.map((i: any) => i.request_id)).toEqual([childRequestId(root, 0), childRequestId(root, 1)]);
    // What an older server stored: the same child rows, without client_request_id.
    await engine.executeRaw('UPDATE persistence_requests SET client_request_id=NULL');
    const replay = await call('remember', { items, request_id: root });
    expect(replay.body.items).toEqual(first.body.items);
    expect(replay.body).toMatchObject({ request_id: clientRequestUuid(root), client_request_id: root, saved: 2 });
    for (const child of first.body.items) {
      expect((await call('get_write_request', { request_id: child.request_id })).body).toMatchObject({ request_id: child.request_id, state: 'committed' });
    }
    const [{ n }] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE operation='remember'");
    expect(Number(n)).toBe(2);
  });
});

describe('restart', () => {
  let dir: string;
  let disk: PGLiteEngine | null = null;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'gbrain-f6-restart-')); });
  async function reopen(): Promise<PGLiteEngine> {
    if (disk) { await disposePersistenceConsumer(disk); await disk.disconnect(); }
    disk = new PGLiteEngine();
    await disk.connect({ database_path: join(dir, 'brain.pglite') } as never);
    await disk.initSchema();
    return disk;
  }
  afterAll(async () => {
    if (disk) { await disposePersistenceConsumer(disk); await disk.disconnect(); }
    rmSync(dir, { recursive: true, force: true });
  });

  test('a write sent with a string id replays after the brain reopens', async () => {
    let brain = await reopen();
    await dispatchToolCall(brain, 'put_page', { slug: 'crm/acme-example', content: '---\ntitle: Acme Example\ntype: company\n---\n# Acme Example\n\nA company.\n' }, { remote: false });
    const fact = { fact: 'Alice Example renews in March.', provenance: 'test', entity: 'crm/acme-example', request_id: ID };
    const first = await callOn(brain, 'remember', fact);
    expect(first.body).toMatchObject({ client_request_id: ID, request_id: ID_UUID });
    brain = await reopen();
    const replay = await callOn(brain, 'remember', fact);
    expect(replay.body).toMatchObject({ id: first.body.id, client_request_id: ID, request_id: ID_UUID });
    expect((await callOn(brain, 'get_write_request', { request_id: ID })).body).toMatchObject({ client_request_id: ID, state: 'committed' });
  }, 60_000);
});
