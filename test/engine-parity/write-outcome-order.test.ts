/**
 * BrainEngine parity — the key order of a finished write's stored outcome and error detail
 * (engine-sql/persistence-journal.ts `completeWriteRow`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a request's `outcome` and `error_detail` come back from `completeWriteRow` and from a later
 *    `readWriteRequestById` with their object keys in jsonb order (shorter keys first, then bytes, at every depth), as
 *    Postgres and PGLite store a `jsonb` value, whatever order the caller wrote them in.
 *  - Regression: an engine that keeps the caller's key order prints a different receipt (`gbrain write-request --json`,
 *    the MCP remember and put_page answers) for the same write, so a census or a client that compares the text sees a
 *    split where there is none.
 *  - Why existing coverage misses it: the write-journal cases (persistence.test.ts) compare with `toEqual`, which
 *    ignores key order, and their outcomes have one key.
 *  - Seam: none. Typed members only; the values are compared as JSON text so key order counts.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const { parityTest } = parityArms(testBackends());

const KEYS = ['principal:local_cli:order-writer', 'brain'];

/** Admits one queued request and claims it; returns its journal id. */
async function admit(engine: BrainEngine, requestId: string): Promise<string> {
  const source = await engine.readSourceMembership('default');
  await engine.lockPersistenceCounters(KEYS);
  const { id } = await engine.insertWriteRequest({
    principalKind: 'local_cli', principalId: 'order-writer', requestId, operation: 'remember', sourceId: 'default',
    sourceIncarnation: source!.incarnation, pageId: null, slug: 'people/alice-example', worktreeId: null,
    topologyGeneration: null, digest: 'd'.repeat(64), intent: { kind: 'remember' }, authority: { scopes: ['write'] },
    intentBytes: 100, terminalReservation: 8192, targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity',
    admitterHostId: null, counterKeys: KEYS, clientRequestId: null, state: 'queued', deferredRefreshId: null,
  });
  await engine.stampWriteClaim(id, 'c0000000-0000-4000-8000-0000000000c1', 60_000, JSON.stringify({ phase: 'parity' }));
  return id;
}

/** Keys out of jsonb order at the top and one level down, as an operation builds its answer. */
const OUTCOME = { status: 'committed', entity_slug: 'people/alice-example', fact: { visibility: 'world', id: 7, kind: 'fact' } };
const DETAIL = { retryable: false, at: 'publish', why: { reason: 'parity', code: 'E1' } };

const texts = (row: { outcome?: unknown; error_detail?: unknown } | null) =>
  row && { outcome: JSON.stringify(row.outcome ?? null), detail: JSON.stringify(row.error_detail ?? null) };

describe('engine parity: write outcome key order', () => {
  parityTest('completeWriteRow stores a committed outcome and a failure detail with their keys in jsonb order', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow', 'readWriteRequestById'],
  }, async (engine) => {
    const complete = (id: string, state: 'committed' | 'failed') => engine.completeWriteRow({
      id, state, outcome: state === 'committed' ? OUTCOME : null, errorCode: state === 'failed' ? 'parity_failed' : null,
      errorMessage: state === 'failed' ? 'parity' : null, consumerVersion: 'parity', consumerHostId: null,
      errorDetail: state === 'failed' ? DETAIL : null, resultBytes: 1200, counterKeys: KEYS, intentBytes: 100, retainedBytes: 1500,
      terminalReservation: 8192, probePurges: false,
    });
    const committedId = await admit(engine, 'b0000000-0000-4000-8000-0000000000b1');
    const committed = texts(await complete(committedId, 'committed'));
    const committedRead = texts(await engine.readWriteRequestById(committedId));
    const failedId = await admit(engine, 'b0000000-0000-4000-8000-0000000000b2');
    const failed = texts(await complete(failedId, 'failed'));
    const failedRead = texts(await engine.readWriteRequestById(failedId));
    const ordered = '{"fact":{"id":7,"kind":"fact","visibility":"world"},"status":"committed","entity_slug":"people/alice-example"}';
    expect(committed).toEqual({ outcome: ordered, detail: 'null' });
    expect(committedRead).toEqual(committed);
    expect(failed?.detail).toBe('{"at":"publish","why":{"code":"E1","reason":"parity"},"retryable":false}');
    expect(failedRead).toEqual(failed);
    return { committed, committedRead, failed, failedRead };
  });
});
