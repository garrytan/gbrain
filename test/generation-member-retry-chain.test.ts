import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { latestMemberRequest } from '../src/core/generations/member-retry.ts';
import { memberRequestId } from '../src/core/generations/managed.ts';
import type { WriteRequest, RequestState } from '../src/core/persistence/model.ts';

describe('generation retry-chain lookup', () => {
  for (const state of ['queued', 'running', 'recovering', 'committed', 'conflict', 'failed', 'cancelled'] satisfies RequestState[]) {
    test(`follows terminal failures to ${state}, never probing beyond a live or committed attempt`, async () => {
      const member = { activation_id: randomUUID(), slug: 'notes/example', action: 'retire' };
      const principal = { kind: 'local_cli', id: randomUUID() } as const;
      const first = { id: randomUUID(), state: 'conflict' } as WriteRequest;
      const second = { id: randomUUID(), state: 'failed' } as WriteRequest;
      const third = { id: randomUUID(), state } as WriteRequest;
      const id = (action: string) => memberRequestId(member.activation_id, member.slug, action);
      const rows = new Map([[id('retire'), first], [id(`retire:after:${first.id}`), second], [id(`retire:after:${second.id}`), third]]);
      const reads: string[] = [];
      const engine = { executeRaw: async <T>(_sql: string, params: unknown[]): Promise<T[]> => {
        expect(params.slice(0, 2)).toEqual([principal.kind, principal.id]);
        const request = String(params[2]); reads.push(request);
        const row = rows.get(request); return row ? [row as T] : [];
      } };
      expect(await latestMemberRequest(engine, principal, member)).toBe(third);
      expect(reads).toHaveLength(['conflict', 'failed', 'cancelled'].includes(state) ? 4 : 3);
    });
  }
  test('finds a legacy missing-original retry and returns null when neither exists', async () => {
    const member = { activation_id: randomUUID(), slug: 'notes/example', action: 'retire' };
    const principal = { kind: 'local_cli', id: randomUUID() } as const;
    const row = { id: randomUUID(), state: 'committed' } as WriteRequest;
    const retry = memberRequestId(member.activation_id, member.slug, 'retire:after:missing');
    let present = true;
    const engine = { executeRaw: async <T>(_sql: string, params: unknown[]): Promise<T[]> => present && params[2] === retry ? [row as T] : [] };
    expect(await latestMemberRequest(engine, principal, member)).toBe(row);
    present = false;
    expect(await latestMemberRequest(engine, principal, member)).toBeNull();
  });
});
