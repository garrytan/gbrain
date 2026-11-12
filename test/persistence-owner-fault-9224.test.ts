/**
 * #9224: a fault inside the persistence owner that is not an OperationError reached a delegated caller as
 * "storage_error: The persistence owner could not complete this request", with a doctor fix that could not see it,
 * and the owner kept no trace of the cause.
 *
 * 1. Protects: the caller gets `internal_error` (detail `owner_internal`) naming an incident ID, that the request
 *    was not at fault, how to recover, the write's request ID when it was a write, and a read-only fix naming the
 *    owner; the cause goes to the owner's own stderr under the same incident ID and never crosses the socket.
 * 2. Fails when: the cause (a driver message, a connection string) crosses the socket, or the caller gets no code,
 *    fix or incident to act on.
 * 3. Real seams: the real persistence listener and client over a local socket.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationError } from '../src/core/ops/contract.ts';
import { requestPersistenceOperation, startPersistenceIpcServer, type PersistenceIpcBinding, type PersistenceIpcRequest } from '../src/core/persistence/ipc.ts';

const CANARY = 'OWNER_FAULT_CANARY_9224';
const BRAIN = randomUUID();
const home = mkdtempSync(join(tmpdir(), 'gbrain-owner-fault-'));
let ipc: PersistenceIpcBinding;
const logged: string[] = [];

function request(operation: PersistenceIpcRequest['operation'], params: Record<string, unknown>): PersistenceIpcRequest {
  return { version: 1, kind: 'operation', brain_id: BRAIN, operation, params,
    registration: { id: randomUUID(), credential: 'a'.repeat(64), lane: 'cli' }, routing: { source: 'source-a', cwd: home } };
}

async function refusal(req: PersistenceIpcRequest): Promise<OperationError> {
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { logged.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    return await requestPersistenceOperation(ipc.socketPath, req).then(() => { throw new Error('the owner fault was not refused'); }, (e: unknown) => e as OperationError);
  } finally { process.stderr.write = write; }
}

describe('an owner fault over the persistence socket (#9224)', () => {
  beforeAll(async () => {
    ipc = (await startPersistenceIpcServer(join(home, 'owner.sock'), {
      brainId: BRAIN,
      dispatch: async () => { throw new TypeError(`${CANARY} at postgres://writer:hunter2@db.example.invalid/brain`); },
    }))!;
  });
  afterAll(async () => { const closed = once(ipc.server, 'close'); ipc.close(); await closed; rmSync(home, { recursive: true, force: true }); });

  test('a read gets internal_error with an incident, the recovery and a read-only fix naming the owner', async () => {
    logged.length = 0;
    const error = await refusal(request('get_page', { slug: 'notes/alpha-example' }));
    expect(error).toBeInstanceOf(OperationError);
    expect(error.code).toBe('internal_error');
    expect(error.detail).toBe('owner_internal');
    const incident = /incident ([0-9a-f-]{36})/.exec(error.message)?.[1];
    expect(incident).toBeDefined();
    expect(error.message).toContain('the request itself was not at fault');
    expect(error.suggestion).toContain('Restart that owner');
    expect(error.suggestion).not.toContain('write-request');
    expect(error.fix).toMatchObject({ argv: ['gbrain', 'sources', 'writer', 'status', '--json'], actor: 'agent', consent: [] });
    const wire = JSON.stringify(error.toJSON());
    expect(wire).not.toContain(CANARY);
    expect(wire).not.toContain('hunter2');
    const line = logged.find(l => l.includes(incident!)) ?? '';
    expect(line).toContain('class=TypeError');
    expect(line).not.toContain(CANARY);
    expect(line).not.toContain('hunter2');
  });

  test('a write names its request ID to inspect before resubmitting', async () => {
    const requestId = randomUUID();
    const error = await refusal(request('put_page', { slug: 'notes/alpha-example', content: 'Alpha example.', request_id: requestId }));
    expect(error.code).toBe('internal_error');
    expect(error.suggestion).toContain(`gbrain write-request ${requestId}`);
    expect(JSON.stringify(error.toJSON())).not.toContain(CANARY);
  });
});
