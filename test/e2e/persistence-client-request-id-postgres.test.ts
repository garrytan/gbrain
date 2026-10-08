/**
 * F6 engine parity on Postgres: migration v220 adds persistence_requests.client_request_id
 * (nullable text) on an upgraded brain, and a write sent with a non-UUID request_id
 * journals its UUIDv5 with the client string, replays, reads by either id, refuses reuse
 * for a different write and keeps the string through compaction. Zero model calls.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { hasDatabase, runMigrationsUpTo, setConfigVersion, setupDB, teardownDB } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { compactWriteReceipts } from '../../src/core/persistence/journal.ts';
import { clientRequestUuid } from '../../src/core/persistence/preconditions.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;
let engine: PostgresEngine;

async function call(name: string, params: Record<string, unknown>) {
  const res = await dispatchToolCall(engine, name, params, { remote: true, transport: 'stdio', surface: 'starter', takesHoldersAllowList: ['world'], sourceId: 'default' });
  return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text!) as Record<string, any> };
}
const page = (title: string) => `---\ntitle: ${title}\ntype: note\n---\n# ${title}\n\nBody of ${title}.\n`;

d('client request ids on Postgres', () => {
  beforeAll(async () => { engine = await setupDB(); }, 120_000);
  afterAll(async () => { resetGateway(); await disposePersistenceConsumer(engine); await teardownDB(); });
  beforeEach(() => { configureGateway({ env: {} } as never); });

  test('v220 adds a nullable text column on an upgraded brain', async () => {
    await engine.executeRaw('ALTER TABLE persistence_requests DROP COLUMN IF EXISTS client_request_id');
    await setConfigVersion(215);
    await runMigrationsUpTo(engine, 220);
    const [column] = await engine.executeRaw<{ data_type: string; is_nullable: string }>(
      "SELECT data_type,is_nullable FROM information_schema.columns WHERE table_name='persistence_requests' AND column_name='client_request_id'");
    expect(column).toEqual({ data_type: 'text', is_nullable: 'YES' });
  });

  test('a string id journals its UUIDv5, replays, reads by either id, refuses other intent and survives compaction', async () => {
    const id = `pg-put-notes-${Date.now()}`;
    const uuid = clientRequestUuid(id);
    const first = await call('put_page', { slug: `notes/${id}`, content: page('Postgres one'), request_id: id });
    expect(first.isError).toBe(false);
    expect(first.body).toMatchObject({ request_id: uuid, client_request_id: id, state: 'committed' });
    const replay = await call('put_page', { slug: `notes/${id}`, content: page('Postgres one'), request_id: id });
    expect(replay.body).toMatchObject({ request_id: uuid, client_request_id: id, revision: first.body.revision });
    for (const request_id of [id, uuid]) {
      expect((await call('get_write_request', { request_id })).body).toMatchObject({ request_id: uuid, client_request_id: id, state: 'committed' });
    }
    const reuse = await call('put_page', { slug: `notes/${id}`, content: page('Postgres two'), request_id: uuid });
    expect(reuse.body).toMatchObject({ code: 'idempotency_conflict', message: 'This request_id was used for a different write; send a new one or omit it.' });

    await engine.executeRaw("UPDATE persistence_requests SET completed_at=now()-interval '400 days' WHERE request_id=$1::uuid", [uuid]);
    await engine.executeRaw("UPDATE persistence_effects SET state='committed' WHERE request_id IN (SELECT id FROM persistence_requests WHERE request_id=$1::uuid)", [uuid]);
    expect(await compactWriteReceipts(engine, 1)).toBeGreaterThanOrEqual(1);
    expect((await call('get_write_request', { request_id: id })).body).toMatchObject({ client_request_id: id, compacted: true });
  });
});
