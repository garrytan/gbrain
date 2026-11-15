/**
 * #9426: `gbrain sources writer failures` listed a terminal `extract_facts`
 * receipt (`storage_error`, origin `owner_exception`) and named
 * `gbrain write-request <id> --json` as its inspect step, but that command
 * answered not_found. The receipt belongs to the principal the write ran under
 * (a fact extraction runs under the page write's MCP client), and the receipt
 * read matched only the caller's own principal. The brain host's trusted local
 * CLI now reads it by request_id, inside its own grant, with the owner-side
 * detail that names the exception (class, frame, attempt build). Remote callers
 * and a request_id two principals share keep the not_found answer.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { initializeLocalPersistence, submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { readTerminalFailures } from '../src/core/persistence/terminal-failures.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const dir = mkdtempSync(join(tmpdir(), 'gbrain-write-request-9426-'));
const home = join(dir, 'home');
const sourceId = `operator-read-${randomUUID().slice(0, 8)}`;
const logger = { info() {}, warn() {}, error() {} };
const ctx = (remote = false) => ({ engine, sourceId, remote, config: { engine: 'pglite', embedding_disabled: true }, dryRun: false, logger }) as never;
const readReceipt = (requestId: string, remote = false) => withEnv({ GBRAIN_HOME: home }, () =>
  operationsByName.get_write_request.handler(ctx(remote), { request_id: requestId })) as Promise<Record<string, any>>;

beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  const root = join(dir, 'brain'); mkdirSync(root);
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  await withEnv({ GBRAIN_HOME: home }, () => claimWorktree(engine, sourceId, root));
}, 60_000);
afterAll(async () => { installFaultHook(undefined); await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(dir, { recursive: true, force: true }); });

/** A write that ends on an owner exception, then handed to another principal, as an owner write submitted under an MCP client is. */
async function foreignOwnerException(): Promise<WriteRequest> {
  const requestId = randomUUID();
  const error = Object.assign(new TypeError('cannot read properties of undefined'), { stack: [
    'TypeError: cannot read properties of undefined',
    '    at extract (/opt/example/gbrain/src/core/persistence/facts-maintenance.ts:42:7)'].join('\n') });
  installFaultHook(async point => { if (point === 'consumer:prepared') throw error; });
  try {
    await withEnv({ GBRAIN_HOME: home }, () => submitPageMutation(ctx(), { operation: 'put_page',
      params: { slug: `notes/${randomUUID().slice(0, 8)}`, content: '---\ntype: note\ntitle: Example\n---\nBody.\n', request_id: requestId } }));
  } catch { /* the owner exception is the point */ } finally { installFaultHook(undefined); }
  await engine.executeRaw(`UPDATE persistence_requests SET principal_kind='oauth_client', principal_id='client-example' WHERE request_id=$1::uuid`, [requestId]);
  const [row] = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
  return row!;
}

describe('#9426 write-request reads the receipts writer failures lists', () => {
  test('the host CLI reads an owner-exception receipt another principal owns, with the detail that names the exception', async () => {
    const row = await foreignOwnerException();
    expect(row).toMatchObject({ state: 'failed', error_code: 'storage_error' });
    const listed = await readTerminalFailures(engine, { sourceId } as never) as { rows?: Array<{ request_id: string; inspect: { argv: string[] } }> };
    const inspect = listed.rows?.find(r => r.request_id === row.request_id)?.inspect.argv;
    expect(inspect).toEqual(['gbrain', 'write-request', row.request_id, '--json']);
    const receipt = await readReceipt(row.request_id);
    expect(receipt).toMatchObject({ request_id: row.request_id, state: 'failed', operation: 'put_page', source_id: sourceId });
    expect(receipt.error_detail).toMatchObject({ origin: 'owner_exception', error_class: 'TypeError', frame: 'src/core/persistence/facts-maintenance.ts:42', stage: 'publication' });
    expect(receipt.diagnosis).toMatchObject({ category: 'owner_exception', public_category: 'defect' });
  });

  test('a remote caller still gets no receipt it does not own', async () => {
    const row = await foreignOwnerException();
    await withEnv({ GBRAIN_HOME: home }, () => initializeLocalPersistence(ctx(true)));
    await expect(readReceipt(row.request_id, true)).rejects.toMatchObject({ code: 'not_found' });
  });

  test('a request_id two principals share stays not_found for the host CLI', async () => {
    const row = await foreignOwnerException();
    await engine.executeRaw(`INSERT INTO persistence_requests SELECT (jsonb_populate_record(NULL::persistence_requests, to_jsonb(r) || jsonb_build_object('id', gen_random_uuid(),
      'principal_id', 'client-other', 'sequence', nextval(pg_get_serial_sequence('persistence_requests', 'sequence'))))).* FROM persistence_requests r WHERE id=$1::uuid`, [row.id]);
    await expect(readReceipt(row.request_id)).rejects.toMatchObject({ code: 'not_found' });
  });
});
