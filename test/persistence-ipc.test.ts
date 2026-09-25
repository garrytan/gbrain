import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import net, { type Server } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationError } from '../src/core/ops/contract.ts';
import { ERROR_SCHEMA } from '../src/core/verbs.ts';
import { validateAgainstSchema } from '../src/core/verbs/conformance.ts';
import type { WriteReceipt } from '../src/core/persistence/types.ts';
import { reportPersistenceCliError } from '../src/commands/persistence-delegate.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import {
  PERSISTENCE_IPC_MAX_BYTES, PersistenceIpcTransportError,
  persistenceSocketPathForConfig, requestPersistenceCapabilities, requestPersistenceOperation,
  startPersistenceIpcServer, type PersistenceIpcBinding, type PersistenceIpcRequest,
} from '../src/core/persistence/ipc.ts';

const BRAIN = '10000000-0000-4000-8000-000000000001';
const ID = '20000000-0000-4000-8000-000000000001';
const REGISTRATION = { id: '30000000-0000-4000-8000-000000000001', credential: 'a'.repeat(64), lane: 'cli' as const };
const dirs: string[] = [];
const bindings: PersistenceIpcBinding[] = [];
const rawServers: Server[] = [];

function socketPath() {
  const dir = mkdtempSync(join(tmpdir(), 'gb-write-ipc-'));
  dirs.push(dir);
  return join(dir, 'write.sock');
}

function request(params: Record<string, unknown> = {}): PersistenceIpcRequest {
  return { version: 1, kind: 'operation', brain_id: BRAIN, operation: 'put_page',
    params: { request_id: ID, slug: 'test/page', content: 'hello', ...params },
    registration: REGISTRATION, routing: { source: null, cwd: tmpdir() } };
}

async function bind(path: string, dispatch: (request: PersistenceIpcRequest) => Promise<unknown>) {
  const result = await startPersistenceIpcServer(path, { brainId: BRAIN, dispatch });
  expect(result).not.toBeNull();
  bindings.push(result!);
  return result!;
}

async function rawExchange(path: string, payload: string): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    let result = '';
    socket.once('error', reject);
    socket.once('connect', () => socket.write(payload));
    socket.on('data', chunk => { result += chunk.toString(); });
    socket.once('end', () => { socket.destroy(); resolve(JSON.parse(result)); });
  });
}

afterEach(async () => {
  for (const binding of bindings.splice(0)) {
    const closed = binding.server.listening ? once(binding.server, 'close') : Promise.resolve();
    binding.close();
    await closed;
  }
  for (const server of rawServers.splice(0)) {
    if (server.listening) { const closed = once(server, 'close'); server.close(); await closed; }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('dedicated persistence IPC', () => {
  test('capabilities identify the durable brain and operations; socket is private', async () => {
    const path = socketPath();
    await bind(path, async () => { throw new Error('Capabilities must not dispatch.'); });
    const capabilities = await requestPersistenceCapabilities(path);
    expect(capabilities.brain_id).toBe(BRAIN);
    expect(capabilities.operations).toContain('get_write_request');
    expect(capabilities.operations).toContain('fetch');
    expect(capabilities.max_frame_bytes).toBe(PERSISTENCE_IPC_MAX_BYTES);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(persistenceSocketPathForConfig({ engine: 'pglite', database_path: tmpdir() })).toBe(join(tmpdir(), '.gbrain-persistence.sock'));
  });

  test('preserves explicit source, client cwd, principal credential, and request ID', async () => {
    const path = socketPath();
    let received: PersistenceIpcRequest | undefined;
    await bind(path, async value => { received = value; return { status: 'created', revision: ID }; });
    const sent = request();
    sent.routing.source = 'client-source';
    const result = await requestPersistenceOperation(path, sent);
    expect(received).toEqual(sent);
    expect(result).toEqual({ status: 'created', revision: ID });
  });

  test('five million maximally escaped content bytes fit without truncation', async () => {
    const path = socketPath();
    await bind(path, async value => ({ bytes: Buffer.byteLength(value.params.content as string), tail: (value.params.content as string).slice(-1) }));
    const content = '\0'.repeat(4_999_999) + 'z';
    const result = await requestPersistenceOperation(path, request({ content }));
    expect(result).toEqual({ bytes: 5_000_000, tail: 'z' });
  });

  test('oversized request refuses before delivery', async () => {
    const path = socketPath();
    let calls = 0;
    await bind(path, async () => { calls++; return {}; });
    await expect(requestPersistenceOperation(path, request({ content: 'x'.repeat(PERSISTENCE_IPC_MAX_BYTES) }))).rejects.toThrow('transport limit');
    expect(calls).toBe(0);
  });

  test('unknown operations, forged context, wrong brain and missing IDs cannot dispatch', async () => {
    const path = socketPath();
    let calls = 0;
    await bind(path, async () => { calls++; return {}; });
    for (const malformed of [
      { ...request(), operation: 'execute_sql' },
      { ...request(), remote: false },
      { ...request(), auth: { scopes: ['admin'] } },
      { ...request(), registration: { ...REGISTRATION, principal: 'admin' } },
      { ...request(), params: { slug: 'test/page', content: 'hello' } },
      { ...request(), brain_id: '10000000-0000-4000-8000-000000000002' },
    ]) {
      const response = await rawExchange(path, JSON.stringify(malformed) + '\n');
      expect(response.ok).toBe(false);
    }
    expect(calls).toBe(0);
  });

  test('multiple frames on one connection dispatch at most once', async () => {
    const path = socketPath();
    let calls = 0;
    await bind(path, async () => { calls++; await Bun.sleep(5); return { ok: true }; });
    await rawExchange(path, (JSON.stringify(request()) + '\n').repeat(2));
    expect(calls).toBe(1);
  });

  test('frozen pending envelopes and revision errors survive transport', async () => {
    const path = socketPath();
    await bind(path, async () => {
      const error = new OperationError('unavailable', 'Write queued.', 'Retry the same request ID.');
      error.protocolVersion = 1;
      error.writeError = 'write_pending';
      error.writeRequest = { request_id: ID, state: 'queued', retry_after_ms: 100 };
      throw error;
    });
    try { await requestPersistenceOperation(path, request()); throw new Error('Expected pending error.'); }
    catch (error) {
      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).toJSON()).toMatchObject({ error: 'unavailable', protocol_version: 1,
        write_error: 'write_pending', write_request: { request_id: ID, state: 'queued' } });
    }
  });

  test('owner-unavailable pending receipts keep their blocked reason across transport', async () => {
    const path = socketPath();
    await bind(path, async () => {
      const error = new OperationError('write_pending', 'The write is accepted and is still pending.');
      error.writeError = 'write_pending';
      error.writeRequest = { request_id: ID, state: 'queued', retry_after_ms: 1000, blocked_reason: 'owner_unavailable' };
      throw error;
    });
    try { await requestPersistenceOperation(path, request()); throw new Error('Expected pending error.'); }
    catch (error) {
      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).toJSON().write_request).toEqual(
        { request_id: ID, state: 'queued', retry_after_ms: 1000, blocked_reason: 'owner_unavailable' });
    }
  });

  test('an oversized committed result is reported with its committed receipt, never as a receiptless failure', async () => {
    const path = socketPath();
    const receipt = { request_id: ID, state: 'committed', retry_after_ms: null, revision: ID,
      outcome: { status: 'created_or_updated', slug: 'test/page' }, persistence: { mode: 'filesystem', file_written: true } };
    await bind(path, async () => ({ ...receipt, write_request: receipt, pages: 'x'.repeat(PERSISTENCE_IPC_MAX_BYTES) }));
    try { await requestPersistenceOperation(path, request()); throw new Error('Expected oversized result error.'); }
    catch (error) {
      expect(error).toBeInstanceOf(OperationError);
      const body = (error as OperationError).toJSON();
      expect(body.error).toBe('response_too_large');
      expect(body.write_error).toBe('response_too_large');
      expect(body.write_request).toEqual({ request_id: ID, state: 'committed', retry_after_ms: null, revision: ID,
        persistence: { mode: 'filesystem', file_written: true } });
      expect(body.message).toContain('committed');
      expect(body.suggestion).toContain('Do not resubmit');
    }
  });

  const committedReceipt = (id: string) => ({ request_id: id, state: 'committed', retry_after_ms: null,
    outcome: { status: 'inserted', text: 'x'.repeat(64) } });
  const OTHER = '20000000-0000-4000-8000-000000000002';
  const THIRD = '20000000-0000-4000-8000-000000000003';

  test('an oversized batch result keeps every receipt, outcome-free, instead of failing receiptless', async () => {
    const path = socketPath();
    await bind(path, async () => ({ inserted: 3, write_requests: [committedReceipt(ID), committedReceipt(OTHER), committedReceipt(THIRD)],
      fact_ids: 'x'.repeat(PERSISTENCE_IPC_MAX_BYTES) }));
    try { await requestPersistenceOperation(path, { ...request(), operation: 'extract_facts' }); throw new Error('Expected oversized result error.'); }
    catch (error) {
      expect(error).toBeInstanceOf(OperationError);
      const body = (error as OperationError).toJSON();
      expect(body).toMatchObject({ error: 'response_too_large', write_error: 'response_too_large' });
      expect(body).not.toHaveProperty('write_request');
      expect(body.write_requests).toEqual([ID, OTHER, THIRD].map(id => ({ request_id: id, state: 'committed', retry_after_ms: null })));
      expect(body.message).toContain('3 writes committed');
    }
  });

  test('a nested administration receipt (sync managedWrite) survives an oversized result', async () => {
    const path = socketPath();
    const pending: WriteReceipt = { request_id: OTHER, state: 'queued', retry_after_ms: 1000, blocked_reason: 'owner_unavailable' };
    await bind(path, async () => ({ status: 'partial', managedWrite: { reason: 'owner_unavailable', write_request: pending },
      pagesAffected: 'x'.repeat(PERSISTENCE_IPC_MAX_BYTES) }));
    try { await requestPersistenceOperation(path, request()); throw new Error('Expected oversized result error.'); }
    catch (error) {
      const body = (error as OperationError).toJSON();
      expect(body.write_request).toEqual(pending);
      expect(body.message).toContain('queued');
      expect(body.suggestion).toContain('do not generate replacement IDs');
    }
  });

  test('a frozen memory verb keeps the frozen error enum when its result cannot be framed', async () => {
    const path = socketPath();
    await bind(path, async () => ({ ...committedReceipt(ID), write_request: committedReceipt(ID), padding: 'x'.repeat(PERSISTENCE_IPC_MAX_BYTES) }));
    try { await requestPersistenceOperation(path, { ...request(), operation: 'remember' }); throw new Error('Expected oversized result error.'); }
    catch (error) {
      const body = (error as OperationError).toJSON();
      expect(body).toMatchObject({ error: 'unavailable', protocol_version: 1, write_error: 'response_too_large',
        write_request: { request_id: ID, state: 'committed' } });
      expect(validateAgainstSchema(body, ERROR_SCHEMA)).toEqual([]);
    }
  });

  test('a committed result that cannot be encoded reports storage_error with its receipt', async () => {
    const path = socketPath();
    await bind(path, async () => ({ write_request: committedReceipt(ID), count: 1n }));
    try { await requestPersistenceOperation(path, request()); throw new Error('Expected encoding error.'); }
    catch (error) {
      const body = (error as OperationError).toJSON();
      expect(body).toMatchObject({ error: 'storage_error', write_error: 'storage_error',
        write_request: { request_id: ID, state: 'committed', retry_after_ms: null } });
      expect(body.message).toContain('could not be encoded');
    }
  });

  /** Real socket, then the CLI reporter: returns the envelope, printed lines and exit verdict. */
  async function framedCli(result: Record<string, unknown>, operation: PersistenceIpcRequest['operation'] = 'put_page') {
    const path = socketPath();
    await bind(path, async () => result);
    let caught: unknown;
    try { await requestPersistenceOperation(path, { ...request(), operation }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(OperationError);
    _resetCliExitVerdictForTests();
    const stderr = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await reportPersistenceCliError(caught, false)).toBe(true);
      return { body: (caught as OperationError).toJSON(), lines: stderr.mock.calls.map(args => args.join(' ')).join('\n'), exit: currentExitCode() };
    } finally { stderr.mockRestore(); _resetCliExitVerdictForTests(); process.exitCode = 0; }
  }
  const pad = 'x'.repeat(PERSISTENCE_IPC_MAX_BYTES);

  test('attested committed salvage exits 0 for singular, plural, nested and frozen-verb envelopes', async () => {
    const single = await framedCli({ ...committedReceipt(ID), write_request: committedReceipt(ID), pad });
    expect(single).toMatchObject({ exit: 0, body: { detail: 'result_unframed_committed', write_request: { state: 'committed' } } });
    const plural = await framedCli({ write_requests: [committedReceipt(ID), committedReceipt(OTHER)], pad }, 'extract_facts');
    expect(plural).toMatchObject({ exit: 0, body: { detail: 'result_unframed_committed' } });
    expect(plural.body.write_requests).toHaveLength(2);
    const nested = await framedCli({ status: 'synced', managedWrite: { write_request: committedReceipt(ID) }, pad });
    expect(nested).toMatchObject({ exit: 0, body: { write_request: { request_id: ID } } });
    const frozen = await framedCli({ ...committedReceipt(ID), write_request: committedReceipt(ID), pad }, 'remember');
    expect(frozen.exit).toBe(0);
    expect(frozen.body).toMatchObject({ error: 'unavailable', protocol_version: 1, write_error: 'response_too_large', detail: 'result_unframed_committed' });
    expect(validateAgainstSchema(frozen.body, ERROR_SCHEMA)).toEqual([]);
    expect(Object.keys(JSON.parse(JSON.stringify(frozen.body))).sort()).toEqual(['detail', 'error', 'message', 'protocol_version', 'suggestion', 'write_error', 'write_request']);
    for (const run of [single, plural, nested, frozen]) expect(run.lines).toContain('Committed [response_too_large]');
  });

  test.each([
    ['singular', 'put_page', { status: 'error', write_request: undefined as unknown, single: true }],
    ['plural', 'extract_facts', { status: 'error' }],
    ['nested', 'put_page', { managedWrite: { status: 'partial', write_request: 'NESTED' } }],
    ['frozen', 'remember', { error: 'page-level failure', single: true }],
  ] as const)('a %s result that itself failed never exits 0 even when every receipt committed', async (_label, operation, shape) => {
    const receipts = 'managedWrite' in shape ? {} : 'single' in shape ? { write_request: committedReceipt(ID) }
      : { write_requests: [committedReceipt(ID), committedReceipt(OTHER)] };
    const result: Record<string, unknown> = { ...shape, ...receipts, pad };
    delete result.single;
    if ('managedWrite' in shape) result.managedWrite = { status: 'partial', write_request: committedReceipt(ID) };
    const run = await framedCli(result, operation as PersistenceIpcRequest['operation']);
    expect(run.exit).toBe(1);
    expect(run.body.detail).toBe('result_unframed');
    expect(run.body.message).toContain('the result reported a failure');
    expect(run.body.suggestion).not.toContain('Do not resubmit');
    expect(run.lines).not.toContain('Committed');
    if (operation === 'remember') expect(validateAgainstSchema(run.body, ERROR_SCHEMA)).toEqual([]);
  });

  test.each([
    ['malformed singular beside a batch', { write_request: { request_id: ID, state: 'future_state', retry_after_ms: null }, write_requests: [committedReceipt(OTHER)] }],
    ['one malformed batch entry', { write_requests: [committedReceipt(ID), { request_id: OTHER, state: 'future_state', retry_after_ms: null }] }],
    ['non-array batch', { write_request: committedReceipt(ID), write_requests: 'corrupt' }],
    ['malformed nested receipt', { write_request: committedReceipt(ID), managedWrite: { write_request: { state: 'committed' } } }],
  ])('an owner-dropped receipt (%s) makes the decision conservative', async (_label, shape) => {
    const run = await framedCli({ ...shape, pad }, 'extract_facts');
    expect(run.exit).toBe(1);
    expect(run.body.detail).toBe('result_unframed');
    expect(run.body.message).toMatch(/could not be validated/);
    expect(run.lines).not.toContain('Committed');
  });

  test.each([
    ['nested committed copy after a pending top-level copy', { write_request: { request_id: ID, state: 'queued', retry_after_ms: 1000 },
      managedWrite: { write_request: committedReceipt(ID) } }, 'queued'],
    ['committed batch copy after a failed singular copy', { write_request: { request_id: ID, state: 'failed', retry_after_ms: null },
      write_requests: [committedReceipt(ID)] }, 'failed'],
  ])('a disagreeing duplicate receipt (%s) never upgrades the request to committed', async (_label, shape, state) => {
    const run = await framedCli({ ...shape, pad }, 'extract_facts');
    expect(run.exit).toBe(1);
    expect(run.body.detail).toBe('result_unframed');
    expect(run.body.write_request).toMatchObject({ request_id: ID, state });
    expect(run.lines).not.toContain('Committed');
  });

  test.each([
    ['status warn (extract-atoms partial failure)', { status: 'warn' }],
    ['status fail', { status: 'fail' }],
    ['a non-empty failures list', { details: { failures: [{ slug: 'a', error: 'x' }] } }],
    ['failedFiles above zero', { failedFiles: 1 }],
  ])('a result reporting failure through %s never exits 0', async (_label, shape) => {
    const run = await framedCli({ ...shape, write_requests: [committedReceipt(ID), committedReceipt(OTHER)], pad }, 'extract_facts');
    expect(run.exit).toBe(1);
    expect(run.body.detail).toBe('result_unframed');
    expect(run.body.message).toContain('the result reported a failure');
  });

  test('empty failure lists and zero failedFiles do not withhold the attestation', async () => {
    const run = await framedCli({ status: 'ok', failures: [], failedFiles: 0, write_requests: [committedReceipt(ID)], pad }, 'extract_facts');
    expect(run).toMatchObject({ exit: 0, body: { detail: 'result_unframed_committed' } });
  });

  test('a receipt the client cannot validate withdraws the owner attestation', async () => {
    const path = socketPath();
    const envelope = { version: 1, ok: false, error: { error: 'response_too_large', write_error: 'response_too_large',
      detail: 'result_unframed_committed', message: 'The 2 writes committed.', suggestion: 'Do not resubmit.',
      write_requests: [{ request_id: ID, state: 'committed', retry_after_ms: null }, { request_id: OTHER, state: 'future_state', retry_after_ms: null }] } };
    const server = net.createServer(socket => { socket.once('data', () => socket.end(JSON.stringify(envelope) + '\n')); });
    rawServers.push(server);
    server.listen(path);
    await once(server, 'listening');
    let caught: unknown;
    try { await requestPersistenceOperation(path, request()); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(OperationError);
    expect((caught as OperationError).detail).toBe('result_unframed');
    expect((caught as OperationError).writeRequests).toEqual([{ request_id: ID, state: 'committed', retry_after_ms: null }]);
    _resetCliExitVerdictForTests();
    const stderr = spyOn(console, 'error').mockImplementation(() => {});
    try { await reportPersistenceCliError(caught, false); expect(currentExitCode()).toBe(1); }
    finally { stderr.mockRestore(); _resetCliExitVerdictForTests(); process.exitCode = 0; }
  });

  test('an oversized result without a receipt stays a plain transport-limit error', async () => {
    const path = socketPath();
    await bind(path, async () => ({ pages: 'x'.repeat(PERSISTENCE_IPC_MAX_BYTES) }));
    try { await requestPersistenceOperation(path, request()); throw new Error('Expected oversized result error.'); }
    catch (error) {
      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).code).toBe('response_too_large');
      expect((error as OperationError).writeRequest).toBeUndefined();
    }
  });

  test('an oversized read result cannot counterfeit a committed write receipt', async () => {
    const path = socketPath();
    await bind(path, async () => ({
      page: { write_request: committedReceipt(ID) },
      content: 'x'.repeat(PERSISTENCE_IPC_MAX_BYTES),
    }));
    try {
      await requestPersistenceOperation(path, { ...request(), operation: 'get_page' });
      throw new Error('Expected oversized result error.');
    } catch (error) {
      expect(error).toBeInstanceOf(OperationError);
      const body = (error as OperationError).toJSON();
      expect(body.error).toBe('response_too_large');
      expect(body).not.toHaveProperty('write_request');
      expect(body).not.toHaveProperty('write_requests');
      expect(body.detail).toBeUndefined();
    }
  });

  test('private driver failures are not reflected', async () => {
    const path = socketPath();
    await bind(path, async () => { throw new Error(`secret=${REGISTRATION.credential}`); });
    try { await requestPersistenceOperation(path, request()); throw new Error('Expected error.'); }
    catch (error) {
      expect(error).toBeInstanceOf(OperationError);
      expect((error as Error).message).not.toContain(REGISTRATION.credential);
    }
  });

  test('optional safe health survives IPC without private nested fields', async () => {
    const path = socketPath();
    const diagnostic = { age_ms: 120000, assessment: 'stalled' as const,
      reason: 'cause_unknown' as const, next_action: 'inspect_owner' as const };
    await bind(path, async () => {
      const error = new OperationError('write_pending', 'Still pending.');
      error.writeRequest = { request_id: ID, state: 'queued', retry_after_ms: 30000,
        diagnostic: { ...diagnostic, ...{ predecessor_id: 'PRIVATE_PREDECESSOR' } } };
      throw error;
    });
    try { await requestPersistenceOperation(path, request()); throw new Error('Expected pending error.'); }
    catch (error) {
      const body = (error as OperationError).toJSON();
      expect(body).toMatchObject({ write_request: { request_id: ID, diagnostic } });
      expect(JSON.stringify(body)).not.toContain('PRIVATE_PREDECESSOR');
    }
  });

  test('lost acknowledgement is unknown, keeps original ID, and never auto-retries', async () => {
    const path = socketPath();
    let calls = 0;
    const server = net.createServer(socket => {
      socket.once('data', () => { calls++; socket.destroy(); });
    });
    rawServers.push(server);
    server.listen(path);
    await once(server, 'listening');
    try { await requestPersistenceOperation(path, request()); throw new Error('Expected lost response.'); }
    catch (error) {
      expect(error).toBeInstanceOf(PersistenceIpcTransportError);
      expect((error as PersistenceIpcTransportError).toJSON()).toMatchObject({ request_id: ID, submission_status: 'unknown' });
      expect((error as PersistenceIpcTransportError).toJSON()).not.toHaveProperty('write_request');
    }
    expect(calls).toBe(1);
  });

  test('timeout does not abort work already dispatched', async () => {
    const path = socketPath();
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    let completed = false;
    await bind(path, async () => { await gate; completed = true; return {}; });
    await expect(requestPersistenceOperation(path, request(), 30)).rejects.toMatchObject({ sent: true, requestId: ID });
    finish();
    await Bun.sleep(5);
    expect(completed).toBe(true);
  });

  test('live owners are preserved and close is idempotent', async () => {
    const path = socketPath();
    const first = await bind(path, async () => ({ owner: 'first' }));
    const second = await startPersistenceIpcServer(path, { brainId: BRAIN, dispatch: async () => ({ owner: 'second' }) });
    expect(second).toBeNull();
    expect(await requestPersistenceOperation(path, request())).toEqual({ owner: 'first' });
    const closed = once(first.server, 'close');
    first.close(); first.close();
    await closed;
    await bind(path, async () => ({ owner: 'next' }));
    expect(await requestPersistenceOperation(path, request())).toEqual({ owner: 'next' });
  });

  test('ordinary files at the discovery path are never removed', async () => {
    const path = socketPath();
    writeFileSync(path, 'keep');
    await expect(startPersistenceIpcServer(path, { brainId: BRAIN, dispatch: async () => ({}) })).rejects.toThrow('not a socket');
    expect(readFileSync(path, 'utf8')).toBe('keep');
  });
});
