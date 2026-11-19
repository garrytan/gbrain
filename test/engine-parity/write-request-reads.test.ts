/**
 * BrainEngine parity — the two reads a remote receipt request runs after the registration check: the memory proposal
 * a principal holds under a request id (readMemoryProposal) and one candidate page of the principal's write requests
 * (listWriteRequestRows), and the get_write_request, cancel_write_request and list_write_requests answers they decide.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: readMemoryProposal returns the stored proposal row or null; listWriteRequestRows returns one principal's
 *    requests in one live source, newest sequence first, after the cursor and through the slug-prefix, operation and
 *    slug-allow-list fences (a null list skips its fence, an empty one matches nothing). The three receipt operations
 *    answer a remote caller with no such request the same on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm through test/engine-parity/harness.ts): not_found, not_found and an empty page.
 *  - Regression: on a Rust brain the proposal lookup (memory-proposals.ts getProposal) and the receipt list
 *    (persistence/control.ts listWriteRequests) ran through executeRaw, so get_write_request and cancel_write_request
 *    of an unknown id and every list_write_requests call ended in engine_capability_missing, not the PGLite answer.
 *  - Why existing coverage misses it: writer-registration.test.ts stops at receiptAccess; nothing ran the receipt
 *    operations past it on the Rust arm, and the list statement's fences had no case on any arm.
 *  - Seam: GBRAIN_HOME through withEnv (the registration files live under it). Typed members only (no executeRaw: D18).
 *    Generated values (journal ids, sequences, incarnations) are left out of the returned values.
 */
import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { WriteRequestListFilter } from '../../src/core/engine-sql/persistence-journal.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { registerServeLocalWriters } from '../../src/core/persistence/provider.ts';
import { persistenceOperations } from '../../src/core/ops/persistence.ts';

const { parityTest } = parityArms(testBackends());

const PRINCIPAL = { kind: 'local_cli', id: 'parity-writer' };
const UNKNOWN = 'b0000000-0000-4000-8000-0000000000f1';

async function inFreshHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-receipts-'));
  try { return await withEnv({ GBRAIN_HOME: home }, fn); }
  finally { rmSync(home, { recursive: true, force: true }); }
}

function remote(engine: BrainEngine): OperationContext {
  return { engine, config: { engine: engine.kind }, remote: true, dryRun: false, sourceId: 'default',
    logger: { info() {}, warn() {}, error() {} } } as OperationContext;
}

/** The handler's answer, or the code it refused with. */
async function answer(engine: BrainEngine, name: string, params: Record<string, unknown>): Promise<unknown> {
  const op = persistenceOperations.find(o => o.name === name)!;
  try { return { ok: await op.handler(remote(engine), params) }; }
  catch (error) { return { code: (error as { code?: string }).code ?? String(error) }; }
}

/** Admits one queued request of `principalId` in `sourceId`; the slug, operation and authority vary per row. */
async function admit(engine: BrainEngine, sourceId: string, requestId: string, slug: string,
  opts: { principalId?: string; authority?: Record<string, unknown> } = {}): Promise<void> {
  const principalId = opts.principalId ?? PRINCIPAL.id;
  const source = await engine.readSourceMembership(sourceId);
  const keys = [`principal:local_cli:${principalId}`, 'brain'];
  await engine.lockPersistenceCounters(keys);
  await engine.insertWriteRequest({
    principalKind: PRINCIPAL.kind, principalId, requestId, operation: 'put_page', sourceId, sourceIncarnation: source!.incarnation,
    pageId: null, slug, worktreeId: null, topologyGeneration: null, digest: 'd'.repeat(64), intent: { kind: 'put_page', slug },
    authority: opts.authority ?? { scopes: ['write'] }, intentBytes: 100, terminalReservation: 4096, targetKind: 'page', protocolVersion: 1,
    admitterVersion: 'parity', admitterHostId: null, counterKeys: keys, clientRequestId: null, state: 'queued', deferredRefreshId: null,
  });
}

const NONE: WriteRequestListFilter = { before: null, limit: 10, slugPrefixes: null, operations: null, slugAllowList: null };

describe('engine parity: write-request receipt reads', () => {
  parityTest('a remote caller gets not_found for an unknown request id and an empty receipt list', {
    methods: ['readPersistenceBrainId', 'readLocalWriterRow', 'insertLocalWriterRow', 'readWriteRequest', 'readMemoryProposal', 'listWriteRequestRows'],
  }, (engine) => inFreshHome(async () => {
    await registerServeLocalWriters(engine);
    const result = {
      get: await answer(engine, 'get_write_request', { request_id: UNKNOWN }),
      cancel: await answer(engine, 'cancel_write_request', { request_id: UNKNOWN }),
      list: await answer(engine, 'list_write_requests', {}),
      listBefore: await answer(engine, 'list_write_requests', { before: '5', limit: 3 }),
    };
    expect(result.get).toEqual({ code: 'not_found' });
    expect(result.cancel).toEqual({ code: 'not_found' });
    expect(result.list).toEqual({ ok: { requests: [], next: null } });
    expect(result.listBefore).toEqual({ ok: { requests: [], next: null } });
    return result;
  }));

  parityTest('readMemoryProposal finds no proposal on a fresh brain', { methods: ['readMemoryProposal'] }, async (engine) => {
    const proposal = await engine.readMemoryProposal(PRINCIPAL.kind, PRINCIPAL.id, UNKNOWN);
    expect(proposal).toBeNull();
    return { proposal };
  });

  parityTest('listWriteRequestRows reads one principal\'s requests in one source, newest first, through the cursor and fences', {
    methods: ['listWriteRequestRows', 'insertWriteRequest', 'lockPersistenceCounters', 'readSourceMembership'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'ab');
    await admit(engine, 'default', 'b0000000-0000-4000-8000-0000000000a1', 'notes/a');
    await admit(engine, 'default', 'b0000000-0000-4000-8000-0000000000a2', 'Notes/B');
    await admit(engine, 'default', 'b0000000-0000-4000-8000-0000000000a3', 'wiki/agents/7/x', { authority: { scopes: ['write'], attestedOp: 'memory_write' } });
    await admit(engine, 'default', 'b0000000-0000-4000-8000-0000000000a4', 'wiki/agents/70/y');
    await admit(engine, 'default', 'b0000000-0000-4000-8000-0000000000a5', 'notesx');
    await admit(engine, 'ab', 'b0000000-0000-4000-8000-0000000000a6', 'notes/elsewhere');
    await admit(engine, 'default', 'b0000000-0000-4000-8000-0000000000a7', 'notes/other-writer', { principalId: 'other-writer' });
    const slugs = async (filter: Partial<WriteRequestListFilter>, sourceId = 'default') =>
      (await engine.listWriteRequestRows(PRINCIPAL.kind, PRINCIPAL.id, sourceId, { ...NONE, ...filter })).map(r => r.slug);
    const all = await engine.listWriteRequestRows(PRINCIPAL.kind, PRINCIPAL.id, 'default', NONE);
    const firstTwo = all.slice(0, 2);
    const result = {
      all: all.map(r => r.slug),
      fullRows: all.every(r => r.principal_id === PRINCIPAL.id && r.source_id === 'default' && r.state === 'queued' && typeof r.id === 'string'),
      limited: await slugs({ limit: 2 }),
      afterCursor: await slugs({ before: String(firstTwo[1]!.sequence) }),
      slashPrefix: await slugs({ slugPrefixes: ['notes/'] }),
      barePrefix: await slugs({ slugPrefixes: ['notes'] }),
      deepPrefix: await slugs({ slugPrefixes: ['wiki/agents/7'] }),
      emptyPrefix: await slugs({ slugPrefixes: [''] }),
      noPrefixes: await slugs({ slugPrefixes: [] }),
      attested: await slugs({ operations: ['memory_write'] }),
      plain: await slugs({ operations: ['put_page'] }),
      allowed: await slugs({ slugAllowList: ['wiki/agents/7/*', 'notes/a'] }),
      allowedCase: await slugs({ slugAllowList: ['notes/b'] }),
      noneAllowed: await slugs({ slugAllowList: [] }),
      otherSource: await slugs({}, 'ab'),
      unknownSource: await slugs({}, 'zz'),
    };
    expect(result.all).toEqual(['notesx', 'wiki/agents/70/y', 'wiki/agents/7/x', 'Notes/B', 'notes/a']);
    expect(result.fullRows).toBe(true);
    expect(result.limited).toEqual(['notesx', 'wiki/agents/70/y']);
    expect(result.afterCursor).toEqual(['wiki/agents/7/x', 'Notes/B', 'notes/a']);
    expect(result.slashPrefix).toEqual(['Notes/B', 'notes/a']);
    expect(result.barePrefix).toEqual(['Notes/B', 'notes/a']);
    expect(result.deepPrefix).toEqual(['wiki/agents/7/x']);
    expect(result.emptyPrefix).toEqual([]);
    expect(result.noPrefixes).toEqual([]);
    expect(result.attested).toEqual(['wiki/agents/7/x']);
    expect(result.plain).toEqual(['notesx', 'wiki/agents/70/y', 'Notes/B', 'notes/a']);
    expect(result.allowed).toEqual(['wiki/agents/7/x', 'notes/a']);
    expect(result.allowedCase).toEqual([]);
    expect(result.noneAllowed).toEqual([]);
    expect(result.otherSource).toEqual(['notes/elsewhere']);
    expect(result.unknownSource).toEqual([]);
    return result;
  });
});
