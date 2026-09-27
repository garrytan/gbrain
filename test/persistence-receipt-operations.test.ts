import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { withVerifiedLocalRegistration, type LocalGrant, type LocalRegistration } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, getWriteRequest } from '../src/core/persistence/journal.ts';
import { sha256 } from '../src/core/persistence/digest.ts';

const RECEIPTS = ['get_write_request', 'list_write_requests', 'cancel_write_request'];
let engine: PGLiteEngine;
let source: string;
let otherSource: string;
let owner: LocalRegistration;
let foreign: LocalRegistration;
let sequence = 0;
const grant = (): LocalGrant => ({ sourceIds: ['*'], operations: ['put_page', ...RECEIPTS], scopes: ['read', 'write'], slugPrefixes: null });
const context = (target: BrainEngine = engine, sourceId = source): OperationContext => ({
  engine: target, config: { engine: 'pglite' }, remote: false, sourceId, dryRun: false,
  logger: { info() {}, warn() {}, error() {} },
});

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine?.disconnect(); });

async function registration(): Promise<LocalRegistration> {
  const local: LocalRegistration = { id: randomUUID(), credential: randomBytes(32).toString('hex'), lane: 'cli' };
  await engine.executeRaw('INSERT INTO persistence_local_writers(id,lane,credential_hash,grant_ceiling) VALUES($1,$2,$3,$4::jsonb)',
    [local.id, local.lane, sha256(local.credential), JSON.stringify(grant())]);
  return local;
}
beforeEach(async () => {
  source = `receipt-op-${++sequence}`;
  otherSource = `receipt-other-${sequence}`;
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1),($2,$2)', [source, otherSource]);
  owner = await registration(); foreign = await registration();
});

async function setGrant(local: LocalRegistration, patch: Partial<LocalGrant>) {
  const [row] = await engine.executeRaw<{ grant_ceiling: LocalGrant }>('SELECT grant_ceiling FROM persistence_local_writers WHERE id=$1', [local.id]);
  await engine.executeRaw('UPDATE persistence_local_writers SET grant_ceiling=$2::jsonb WHERE id=$1', [local.id, JSON.stringify({ ...row.grant_ceiling, ...patch })]);
}
async function accept(local = owner, slug = 'allowed/page', sourceId = source, requestId = randomUUID()) {
  return withVerifiedLocalRegistration(engine, local, async () => {
    const [s] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
    const authority = await submissionAuthority(context(engine, sourceId), 'put_page', sourceId, s.incarnation, slug);
    return admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId,
      sourceIncarnation: s.incarnation, slug, requestId,
      callerIntent: { content: 'PRIVATE_INPUT_MARKER' }, intent: { content: 'PRIVATE_INPUT_MARKER' } });
  });
}
async function call(name: string, params: Record<string, unknown>, local = owner, ctx = context()): Promise<any> {
  const op = operations.find(operation => operation.name === name)!;
  return withVerifiedLocalRegistration(ctx.engine, local, () => op.handler(ctx, params));
}

describe('own-principal write receipt operations', () => {
  test('get_write_request returns public metadata and never journal payload, execution or recovery bytes', async () => {
    const row = await accept();
    await engine.executeRaw('UPDATE persistence_requests SET execution_token=$2,recovery=$3::jsonb,error_message=$4,error_code=$5 WHERE id=$1',
      [row.id, randomUUID(), JSON.stringify({ before: 'PRIVATE_RECOVERY_MARKER' }), 'PRIVATE_DRIVER_MARKER', 'revision_conflict']);
    const receipt = await call('get_write_request', { request_id: row.request_id });
    expect(receipt).toMatchObject({ request_id: row.request_id, state: 'queued', operation: 'put_page', source_id: source, slug: 'allowed/page', write_error: 'revision_conflict' });
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE_');
    for (const key of ['principal_id', 'authority', 'intent', 'execution_token', 'recovery', 'digest']) expect(receipt).not.toHaveProperty(key);
  });

  test('foreign and missing UUIDs have the same get/cancel not_found envelope', async () => {
    const row = await accept(foreign);
    for (const operation of ['get_write_request', 'cancel_write_request']) {
      const errors: unknown[] = [];
      for (const id of [row.request_id, randomUUID()]) {
        try { await call(operation, { request_id: id }); throw new Error('Expected not_found.'); }
        catch (error) { expect(error).toMatchObject({ code: 'not_found' }); errors.push((error as { toJSON(): unknown }).toJSON()); }
      }
      expect(errors[0]).toEqual(errors[1]);
    }
  });

  test('the same UUID under two principals returns each principal’s own request', async () => {
    const id = randomUUID();
    await accept(owner, 'allowed/own', source, id);
    await accept(foreign, 'allowed/foreign', source, id);
    expect((await call('get_write_request', { request_id: id })).slug).toBe('allowed/own');
    expect((await call('get_write_request', { request_id: id }, foreign)).slug).toBe('allowed/foreign');
  });

  test('list_write_requests paginates only the principal and selected source', async () => {
    const first = await accept(owner, 'allowed/first');
    await accept(foreign, 'allowed/foreign');
    await accept(owner, 'allowed/other-source', otherSource);
    const second = await accept(owner, 'allowed/second');
    const page = await call('list_write_requests', { limit: 1 });
    expect(page.requests.map((r: any) => r.request_id)).toEqual([second.request_id]);
    expect(page.next).toBe(String(second.sequence));
    const next = await call('list_write_requests', { limit: 1, before: page.next });
    expect(next.requests.map((r: any) => r.request_id)).toEqual([first.request_id]);
    expect(next.next).toBeNull();
    expect(JSON.stringify(page)).not.toContain('PRIVATE_INPUT_MARKER');
  });

  test('SQL current prefix filtering reaches old visible history beyond 1000 now-hidden rows', async () => {
    const first = await accept(owner, 'allowed/oldest');
    await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,
      slug,digest,intent,authority,intent_bytes,terminal_reservation,state,outcome)
      SELECT principal_kind,principal_id,gen_random_uuid(),operation,source_id,source_incarnation,
      'hidden/'||g.n,digest,NULL,authority,0,terminal_reservation,'committed','{}'::jsonb
      FROM persistence_requests CROSS JOIN generate_series(1,1100) AS g(n) WHERE id=$1`, [first.id]);
    await setGrant(owner, { slugPrefixes: ['allowed/*'] });
    const result = await call('list_write_requests', { limit: 25 });
    expect(result.requests.map((r: any) => r.request_id)).toEqual([first.request_id]);
    expect(result.next).toBeNull();
  });

  test('regrant adds receipt access without changing the accepted write snapshot', async () => {
    await setGrant(owner, { operations: ['put_page'] });
    const row = await accept();
    await expect(call('get_write_request', { request_id: row.request_id })).rejects.toMatchObject({ code: 'permission_denied' });
    await setGrant(owner, { operations: ['put_page', ...RECEIPTS] });
    expect((await call('get_write_request', { request_id: row.request_id })).state).toBe('queued');
    const stored = await getWriteRequest(engine, row.authority.principal, row.request_id);
    expect(stored!.authority.operations).toEqual(['put_page']);
    await setGrant(owner, { operations: [...RECEIPTS] });
    await expect(call('get_write_request', { request_id: row.request_id })).rejects.toMatchObject({ code: 'not_found' });
    expect((await call('list_write_requests', {})).requests).toEqual([]);
  });

  test('read-only grants, narrowed sources, archived sources and revoked principals fail closed', async () => {
    const row = await accept();
    await setGrant(owner, { scopes: ['read'] });
    await expect(call('get_write_request', { request_id: row.request_id })).rejects.toMatchObject({ code: 'permission_denied' });
    await setGrant(owner, { scopes: ['read', 'write'], sourceIds: [otherSource] });
    expect((await call('list_write_requests', {})).requests).toEqual([]);
    await expect(call('get_write_request', { request_id: row.request_id })).rejects.toMatchObject({ code: 'not_found' });
    await setGrant(owner, { sourceIds: ['*'] });
    await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [source]);
    expect((await call('list_write_requests', {})).requests).toEqual([]);
    await expect(call('get_write_request', { request_id: row.request_id })).rejects.toMatchObject({ code: 'not_found' });
    await engine.executeRaw('UPDATE persistence_local_writers SET revoked_at=now() WHERE id=$1', [owner.id]);
    await expect(call('get_write_request', { request_id: row.request_id })).rejects.toMatchObject({ code: 'permission_denied' });
  });

  test('cancel_write_request cancels before publication and replay reports the same terminal state', async () => {
    const row = await accept();
    expect((await call('cancel_write_request', { request_id: row.request_id })).state).toBe('cancelled');
    expect((await call('cancel_write_request', { request_id: row.request_id })).state).toBe('cancelled');
    expect((await call('get_write_request', { request_id: row.request_id })).retry_after_ms).toBeNull();
  });

  test('cancel does not promise rollback once publication/recovery has started', async () => {
    const row = await accept();
    await engine.executeRaw("UPDATE persistence_requests SET state='recovering',publication_started=true WHERE id=$1", [row.id]);
    expect((await call('cancel_write_request', { request_id: row.request_id })).state).toBe('recovering');
  });

  test('cancellation rechecks its own operation grant after preflight under the transaction lock', async () => {
    const row = await accept();
    let narrowed = false;
    const proxy = new Proxy(engine, { get(target, property) {
      if (property === 'executeRaw') return async (sql: string, params?: unknown[]) => {
        const result = await target.executeRaw(sql, params);
        if (!narrowed && sql.startsWith('SELECT * FROM persistence_requests WHERE principal_kind=')) {
          narrowed = true;
          await setGrant(owner, { operations: ['put_page', 'get_write_request', 'list_write_requests'] });
        }
        return result;
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await expect(call('cancel_write_request', { request_id: row.request_id }, owner, context(proxy))).rejects.toMatchObject({ code: 'permission_denied' });
    expect((await getWriteRequest(engine, row.authority.principal, row.request_id))!.state).toBe('queued');
  });

  test('limits, UUIDs, all-source sentinels and bigint cursors validate before querying history', async () => {
    for (const params of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { source_id: '__all__' }, { before: '-1' }, { before: '9999999999999999999' }]) {
      await expect(call('list_write_requests', params)).rejects.toMatchObject({ code: 'invalid_params' });
    }
    await expect(call('get_write_request', { request_id: '../other' })).rejects.toMatchObject({ code: 'invalid_params' });
  });
});
