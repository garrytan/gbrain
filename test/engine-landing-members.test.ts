/**
 * The BrainEngine members that land ahead of their callers (engine-sql/trust-proposals.ts, trust-write-gate.ts,
 * page-embedding-budget.ts, cycle-locks.ts, persistence-*.ts, remote-links.ts, facts-purge*.ts, calibration-profiles.ts,
 * sources.ts, oauth-clients.ts, access-*.ts, belief-*.ts and others), run on PGLite. Each test calls the members of one
 * area and checks a real result: a returned value, a row written and read back through another member or a plain
 * SELECT, a setting read back, or a lock held for the rest of a transaction.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { derivationNeedles } from '../src/core/page-body/segment-derive.ts';
import { WRITER_ADMIN_LOCK_KEY } from '../src/core/persistence/admin-contract.ts';
import { publishSegmentedPage, segmentText } from './helpers/page-body-fixtures.ts';

let engine: PGLiteEngine;
let incarnation: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('other', 'other') ON CONFLICT DO NOTHING");
  incarnation = (await engine.readSourceMembership('default'))!.incarnation;
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

const page = (slug: string, text = `Body of ${slug}.`) =>
  engine.putPage(slug, { type: 'note', title: slug, compiled_truth: text });

const raw = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => engine.executeRaw<T>(sql, params);

/** Admits one queued write request under its own counter keys and claims it; returns its journal id and request id. */
async function admit(tag: string, opts: { claim?: boolean; slug?: string } = {}): Promise<{ id: string; requestId: string; keys: string[] }> {
  const keys = [`principal:local_cli:${tag}`, `brain:${tag}`];
  const requestId = randomUUID();
  await engine.lockPersistenceCounters(keys);
  const { id } = await engine.insertWriteRequest({
    principalKind: 'local_cli', principalId: tag, requestId, operation: 'remember', sourceId: 'default',
    sourceIncarnation: incarnation, pageId: null, slug: opts.slug ?? `notes/${tag}`, worktreeId: null,
    topologyGeneration: null, digest: 'd'.repeat(64), intent: { kind: 'remember', text: 'hello' }, authority: { scopes: ['write'] },
    intentBytes: 100, terminalReservation: 8192, targetKind: 'page', protocolVersion: 1, admitterVersion: 'landing',
    admitterHostId: null, counterKeys: keys, clientRequestId: null, state: 'queued', deferredRefreshId: null,
  });
  return { id, requestId, keys };
}

describe('trust proposals', () => {
  test('insert files one pending proposal per target, get reads it back, list filters by status, source and action', async () => {
    const first = await engine.insertTrustProposal({
      action: 'supersede_fact', sourceId: 'default', target: { table: 'facts', id: 11 }, related: { table: 'facts', id: 12 },
      before: { fact: 'old' }, after: { fact: 'new' }, proposer: 'remember.replaces',
    });
    expect(first.created).toBe(true);
    const again = await engine.insertTrustProposal({
      action: 'supersede_fact', sourceId: 'default', target: { table: 'facts', id: 11 }, related: { table: 'facts', id: 12 },
      before: { fact: 'other' }, proposer: 'remember.replaces',
    });
    expect(again).toEqual({ id: first.id, created: false });

    const row = await engine.getTrustProposal(first.id);
    expect(row).toMatchObject({
      id: first.id, action: 'supersede_fact', source_id: 'default', target_table: 'facts', target_id: 11, related_table: 'facts', related_id: 12,
      before_state: { fact: 'old' }, after_state: { fact: 'new' }, proposer: 'remember.replaces', status: 'pending',
      proposer_principal_kind: null, proposer_principal_id: null, write_request_id: null, decided_at: null,
    });
    expect(await engine.getTrustProposal(first.id + 1000)).toBeNull();

    const forget = await engine.insertTrustProposal({
      action: 'forget', sourceId: 'other', target: { table: 'pages', id: 5 }, before: { slug: 'notes/x' }, proposer: 'remote_forget',
    });
    expect(forget.created).toBe(true);
    await raw("UPDATE trust_proposals SET status = 'rejected' WHERE id = $1", [forget.id]);

    expect((await engine.listTrustProposals()).map((p) => p.id)).toEqual([first.id]);
    expect((await engine.listTrustProposals({ status: 'all' })).map((p) => p.id)).toEqual([first.id, forget.id]);
    expect((await engine.listTrustProposals({ status: 'rejected' })).map((p) => p.id)).toEqual([forget.id]);
    expect((await engine.listTrustProposals({ status: 'all', sourceId: 'other' })).map((p) => p.id)).toEqual([forget.id]);
    expect((await engine.listTrustProposals({ status: 'all', action: 'supersede_fact' })).map((p) => p.id)).toEqual([first.id]);
    expect(await engine.listTrustProposals({ status: 'all', since: new Date(Date.now() + 60_000) })).toEqual([]);
    expect(await engine.listTrustProposals({ status: 'all', limit: 1 })).toHaveLength(1);
  });

  test('a proposal inserted in a transaction carries its attribution settings, and a locking read sees it', async () => {
    const requestId = randomUUID();
    const seen = await engine.transaction(async (tx) => {
      await tx.executeRaw(
        `SELECT set_config('gbrain.write_principal_kind', 'oauth_client', true), set_config('gbrain.write_principal_id', 'client-a', true),
                set_config('gbrain.write_request', $1, true)`, [requestId]);
      const { id } = await tx.insertTrustProposal({
        action: 'lower_page', sourceId: 'default', target: { table: 'pages', id: 77 }, before: { tier: 'user_confirmed' }, proposer: 'agent_page_edit',
      });
      return tx.getTrustProposal(id, true);
    });
    expect(seen).toMatchObject({
      action: 'lower_page', target_id: 77, proposer_principal_kind: 'oauth_client', proposer_principal_id: 'client-a', write_request_id: requestId,
    });
  });
});

describe('write gate holds and receipts', () => {
  test('a repeated hold bumps its count, get and list read it back, and the list filters by status, kind and source', async () => {
    const input = {
      kind: 'fact' as const, source_id: 'default', slug: 'people/gate', fingerprint: 'fp-1', detector_version: 3, tier: 'agent_written',
      reason_families: ['injection'], reasons: ['ignore previous instructions'], detector_error: false,
      payload: { fact: 'held text' }, write_origin: { tool: 'remember' }, request_id: 'req-1',
    };
    const id = await engine.upsertWriteGateHold(input);
    expect(await engine.upsertWriteGateHold({ ...input, reasons: ['updated reason'], request_id: null })).toBe(id);

    const hold = await engine.getWriteGateHoldRow(id);
    expect(hold).toMatchObject({
      id, kind: 'fact', source_id: 'default', slug: 'people/gate', tier: 'agent_written', detector_version: 3, detector_error: false,
      reason_families: ['injection'], reasons: ['updated reason'], payload: { fact: 'held text' }, write_origin: { tool: 'remember' },
      request_id: 'req-1', status: 'held', seen_count: 2, decided_at: null, decided_by: null, page_id: null, page_candidates: null,
    });
    expect(await engine.getWriteGateHoldRow(id + 1000)).toBeNull();

    const takeId = await engine.upsertWriteGateHold({ ...input, kind: 'take', source_id: 'other', fingerprint: 'fp-2', write_origin: null });
    await raw("UPDATE write_gate_holds SET status = 'released', decided_at = now(), decided_by = 'owner' WHERE id = $1", [takeId]);

    expect((await engine.listWriteGateHoldRows({ status: 'all', limit: 10 })).map((h) => h.id)).toEqual([takeId, id]);
    expect((await engine.listWriteGateHoldRows({ status: 'held', limit: 10 })).map((h) => h.id)).toEqual([id]);
    expect((await engine.listWriteGateHoldRows({ status: 'released', limit: 10 }))[0]).toMatchObject({ id: takeId, decided_by: 'owner', write_origin: null });
    expect((await engine.listWriteGateHoldRows({ status: 'all', kind: 'take', limit: 10 })).map((h) => h.id)).toEqual([takeId]);
    expect((await engine.listWriteGateHoldRows({ status: 'all', sourceId: 'default', limit: 10 })).map((h) => h.id)).toEqual([id]);
    expect((await engine.listWriteGateHoldRows({ status: 'all', sourceIds: ['other', 'default'], sourceId: 'nope', limit: 10 })).map((h) => h.id)).toEqual([takeId, id]);
    expect((await engine.listWriteGateHoldRows({ status: 'all', beforeId: takeId, limit: 10 })).map((h) => h.id)).toEqual([id]);
    expect(await engine.listWriteGateHoldRows({ status: 'all', limit: 1 })).toHaveLength(1);
  });

  test('a hold on an existing page is bound to its permanent id, so a rename does not make a second hold', async () => {
    const created = await page('gate/bound-hold');
    const input = {
      kind: 'fact' as const, source_id: 'default', slug: 'gate/bound-hold', fingerprint: 'fp-bound', detector_version: 3, tier: 'agent_written',
      reason_families: ['injection'], reasons: ['r'], detector_error: false, payload: { fact: 'held' }, write_origin: null, request_id: null,
    };
    const id = await engine.upsertWriteGateHold(input);
    expect(await engine.getWriteGateHoldRow(id)).toMatchObject({ page_id: created.id, page_candidates: null, slug: 'gate/bound-hold' });
    await raw("UPDATE pages SET slug = 'gate/bound-hold-renamed' WHERE id = $1", [created.id]);
    expect(await engine.upsertWriteGateHold({ ...input, slug: 'gate/bound-hold-renamed', page_id: created.id })).toBe(id);
    expect(await engine.getWriteGateHoldRow(id)).toMatchObject({ page_id: created.id, slug: 'gate/bound-hold-renamed', seen_count: 2 });
  });

  for (const kind of ['fact', 'take'] as const) {
    for (const status of ['released', 'dropped'] as const) {
      test(`a ${kind} hold that was ${status} opens again on the same row when the same content is held once more`, async () => {
        const input = {
          kind, source_id: 'default', slug: `people/reopen-${kind}-${status}`, fingerprint: `fp-reopen-${kind}-${status}`, detector_version: 3,
          tier: 'agent_written', reason_families: ['injection'], reasons: ['first reason'], detector_error: false,
          payload: { text: 'first' }, write_origin: { tool: 'remember' }, request_id: 'req-reopen-1',
        };
        const id = await engine.upsertWriteGateHold(input);
        await raw('UPDATE write_gate_holds SET status = $2, decided_at = now(), decided_by = $3 WHERE id = $1', [id, status, 'owner']);
        expect(await engine.getWriteGateHoldRow(id)).toMatchObject({ status, decided_by: 'owner' });

        expect(await engine.upsertWriteGateHold({ ...input, reasons: ['second reason'], payload: { text: 'second' }, request_id: 'req-reopen-2' })).toBe(id);
        expect(await engine.getWriteGateHoldRow(id)).toMatchObject({
          id, kind, status: 'held', decided_at: null, decided_by: null, seen_count: 2, reasons: ['second reason'], payload: { text: 'second' },
        });
      });
    }
  }

  test('listing receipts of a target returns its receipts newest first, within the limit', async () => {
    await raw(
      `INSERT INTO write_gate_receipts (target_table, target_id, source_id, content_hash, tier, detector_version, verdict, reason_families, last_seen_at) VALUES
         ('facts', '42', 'default', 'h-old', 'agent_written', 1, 'flag', '{injection}', now() - interval '2 hours'),
         ('facts', '42', 'default', 'h-new', 'agent_written', 2, 'quarantine', '{secret,injection}', now() - interval '1 hour'),
         ('facts', '43', 'default', 'h-other', 'agent_written', 2, 'flag', '{}', now())`);
    const receipts = await engine.listWriteGateReceiptsFor('facts', '42', 10);
    expect(receipts.map((r) => [r.verdict, r.detector_version, r.tier, r.reason_families])).toEqual([
      ['quarantine', 2, 'agent_written', ['secret', 'injection']], ['flag', 1, 'agent_written', ['injection']],
    ]);
    expect(receipts[0]!.last_seen_at.getTime()).toBeGreaterThan(receipts[1]!.last_seen_at.getTime());
    expect(await engine.listWriteGateReceiptsFor('facts', '42', 1)).toHaveLength(1);
    expect(await engine.listWriteGateReceiptsFor('facts', 'none', 10)).toEqual([]);
  });
});

describe('page embedding budget', () => {
  test('a held page refuses a grant until its hold opens, then grants the newest chunks that fit the cap and settles the spend', async () => {
    const { id } = await page('budget/held-page');
    expect(await engine.readPageEmbeddingBudget(id)).toEqual({
      marker: null, state: null, reason: null, embedding_signature: null, spent_usd: null, reserved_usd: null, cap_usd: null,
      unpriced_calls: null, reservation_window: null,
    });
    expect(await engine.readPageEmbeddingBudget(id + 100_000)).toMatchObject({ state: null, spent_usd: null });

    await engine.recordPageEmbeddingHold(id, 'awaiting_approval');
    await engine.recordPageEmbeddingHold(id, 'other_reason');
    expect(await engine.readPageEmbeddingBudget(id)).toMatchObject({ state: 'held', reason: 'awaiting_approval', spent_usd: 0, reserved_usd: 0 });

    const chunks = [0, 1, 2, 3, 4].map((chunkIndex) => ({ chunkIndex, costUsd: 0.25 }));
    const ask = { approved: false, approvedCapUsd: null, configuredCapUsd: 1, signature: 'sig-a', chunks, junk: null };
    expect(await engine.reservePageEmbedding(id, ask)).toEqual({ kind: 'held', reason: 'awaiting_approval' });

    await engine.openPageEmbeddingHold(id);
    expect(await engine.readPageEmbeddingBudget(id)).toMatchObject({ state: 'open', reason: null });
    expect(await engine.reservePageEmbedding(id, ask)).toEqual({ kind: 'needs_junk' });

    const grant = await engine.reservePageEmbedding(id, { ...ask, junk: { reason: null } });
    expect(grant).toMatchObject({ kind: 'grant', chunkIndexes: [4, 3, 2, 1], reservedUsd: 1, deferred: 1, capUsd: 1 });
    const window = (grant as { window: string | null }).window;
    expect(window).toMatch(/^\d+$/);
    expect(await engine.readPageEmbeddingBudget(id)).toMatchObject({
      state: 'capped', reason: 'cap_reached', embedding_signature: 'sig-a', spent_usd: 0, reserved_usd: 1, cap_usd: null, unpriced_calls: 0, reservation_window: window,
    });

    await engine.settlePageEmbeddingReservation(id, { window: 'not-the-window', reservedUsd: 1, bookedUsd: 0.5, unpricedCalls: 1 });
    expect(await engine.readPageEmbeddingBudget(id)).toMatchObject({ spent_usd: 0, reserved_usd: 1, unpriced_calls: 0 });
    await engine.settlePageEmbeddingReservation(id, { window, reservedUsd: 1, bookedUsd: 0.75, unpricedCalls: 2 });
    expect(await engine.readPageEmbeddingBudget(id)).toMatchObject({ spent_usd: 0.75, reserved_usd: 0, unpriced_calls: 2, reservation_window: null });
  });

  test('a junk verdict holds an open page, and an approved grant raises the cap by the approved amount', async () => {
    const { id } = await page('budget/junk-page');
    const chunks = [{ chunkIndex: 0, costUsd: 0.5 }, { chunkIndex: 1, costUsd: 0.5 }];
    const base = { approved: false, approvedCapUsd: null, configuredCapUsd: 0.5, signature: null, chunks, junk: null };
    expect(await engine.reservePageEmbedding(id, { ...base, junk: { reason: 'binary_blob' } })).toEqual({ kind: 'held', reason: 'binary_blob' });
    expect(await engine.readPageEmbeddingBudget(id)).toMatchObject({ state: 'held', reason: 'binary_blob' });

    const approved = await engine.reservePageEmbedding(id, { ...base, approved: true, approvedCapUsd: 1 });
    expect(approved).toMatchObject({ kind: 'grant', chunkIndexes: [1, 0], reservedUsd: 1, deferred: 0, capUsd: 1 });
    expect(await engine.readPageEmbeddingBudget(id)).toMatchObject({ state: 'open', reason: null, reserved_usd: 1, cap_usd: 1 });
  });

  test('a lease is taken once, renewed and released only by its token, and an expired one is taken over', async () => {
    const leaseId = 'embed-page:991';
    const [a, b] = [randomUUID(), randomUUID()];
    const holder = (token: string) => ({ holderPid: 4242, holderHost: 'host-a', acquisitionToken: token, ttlMinutes: 10 });
    const lease = async () => (await raw<{ acquisition_token: string; ttl_expires_at: Date }>(
      'SELECT acquisition_token, ttl_expires_at FROM gbrain_cycle_locks WHERE id = $1', [leaseId]))[0];

    expect(await engine.takePageEmbeddingLease(leaseId, holder(a))).toBe(true);
    expect(await engine.takePageEmbeddingLease(leaseId, holder(b))).toBe(false);
    const first = await lease();
    expect(first!.acquisition_token).toBe(a);

    expect(await engine.renewPageEmbeddingLease(leaseId, { acquisitionToken: b, ttlMinutes: 60 })).toBe(false);
    expect(await engine.renewPageEmbeddingLease(leaseId, { acquisitionToken: a, ttlMinutes: 60 })).toBe(true);
    expect(new Date((await lease())!.ttl_expires_at).getTime()).toBeGreaterThan(new Date(first!.ttl_expires_at).getTime() + 30 * 60_000);

    await engine.releasePageEmbeddingLease(leaseId, { acquisitionToken: b });
    expect((await lease())!.acquisition_token).toBe(a);

    await raw("UPDATE gbrain_cycle_locks SET ttl_expires_at = now() - interval '1 minute' WHERE id = $1", [leaseId]);
    expect(await engine.takePageEmbeddingLease(leaseId, holder(b))).toBe(true);
    expect((await lease())!.acquisition_token).toBe(b);

    await raw(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at, acquisition_token)
       VALUES ('embed-page:992', 1, 'gone', now(), now() - interval '1 hour', now(), $1)`, [randomUUID()]);
    await engine.releasePageEmbeddingLease(leaseId, { acquisitionToken: b });
    expect(await raw("SELECT id FROM gbrain_cycle_locks WHERE id LIKE 'embed-page:%'")).toEqual([]);
    expect(await engine.takePageEmbeddingLease(leaseId, holder(a))).toBe(true);
    await engine.releasePageEmbeddingLease(leaseId, { acquisitionToken: a });
  });
});

describe('write requests', () => {
  test('lockWriteRequest and lockWriteRequestsById return the rows they lock and nothing for an unknown id', async () => {
    const one = await admit('lock-one');
    const two = await admit('lock-two');
    const missing = randomUUID();
    const xmaxLocked = async (tx: BrainEngine, id: string) =>
      (await tx.executeRaw<{ locked: boolean }>('SELECT xmax::text <> \'0\' AS locked FROM persistence_requests WHERE id = $1::uuid', [id]))[0]!.locked;

    await engine.transaction(async (tx) => {
      expect(await xmaxLocked(tx, one.id)).toBe(false);
      const row = await tx.lockWriteRequest(one.id);
      expect(row).toMatchObject({ id: one.id, request_id: one.requestId, state: 'queued', operation: 'remember', slug: 'notes/lock-one' });
      expect(await xmaxLocked(tx, one.id)).toBe(true);
      expect(await tx.lockWriteRequest(missing)).toBeNull();

      expect(await xmaxLocked(tx, two.id)).toBe(false);
      const rows = await tx.lockWriteRequestsById([two.id, one.id, missing]);
      expect(rows.map((r) => r.id)).toEqual([one.id, two.id].sort());
      expect(await xmaxLocked(tx, two.id)).toBe(true);
      expect(await tx.lockWriteRequestsById([missing])).toEqual([]);
    });
  });

  test('renewWriteClaim extends a claim held under its token and records the phase, and refuses another token', async () => {
    const { id } = await admit('renew-claim');
    const token = randomUUID();
    const claimed = await engine.stampWriteClaim(id, token, 1_000, JSON.stringify({ phase: 'claimed' }));
    expect(claimed).toMatchObject({ id, state: 'running', execution_token: token });
    const lease = async () => (await raw<{ claim_expires_at: Date; claim_phase: unknown }>(
      'SELECT claim_expires_at, claim_phase FROM persistence_requests WHERE id = $1::uuid', [id]))[0]!;
    const before = await lease();

    expect(await engine.renewWriteClaim({ id, token: randomUUID(), leaseMs: 600_000, phaseJson: null })).toBe(false);
    expect(await engine.renewWriteClaim({ id, token, leaseMs: 600_000, phaseJson: JSON.stringify({ phase: 'renewed' }) })).toBe(true);
    const after = await lease();
    expect(new Date(after.claim_expires_at).getTime()).toBeGreaterThan(new Date(before.claim_expires_at).getTime() + 300_000);
    expect(after.claim_phase).toEqual({ phase: 'renewed' });

    expect(await engine.renewWriteClaim({ id, token, leaseMs: 600_000, phaseJson: null })).toBe(true);
    expect((await lease()).claim_phase).toEqual({ phase: 'renewed' });
    expect(await engine.renewWriteClaim({ id: randomUUID(), token, leaseMs: 1_000, phaseJson: null }, { signal: new AbortController().signal })).toBe(false);
  });

  test('compactTerminalIntent drops the intent, shrinks the reservation and releases the counters, and answers null for an unknown id', async () => {
    const { id, keys } = await admit('compact');
    const counters = async () => Object.fromEntries((await engine.readCounterRows([...keys, 'no-such-counter'])).map((c) => [c.key, Number(c.terminal_bytes)]));
    expect(await counters()).toEqual({ [keys[0]!]: 8192, [keys[1]!]: 8192 });

    const compacted = await engine.compactTerminalIntent({ id, left: 300, reservation: 8192, counterKeys: keys });
    expect(compacted).toMatchObject({ id, intent: null, compacted: true });
    expect(Number(compacted!.terminal_reservation)).toBe(300);
    expect(await counters()).toEqual({ [keys[0]!]: 300, [keys[1]!]: 300 });
    expect(await engine.compactTerminalIntent({ id: randomUUID(), left: 1, reservation: 1, counterKeys: keys })).toBeNull();
  });

  test('readCounterRows reads the existing counters of the keys in byte order and leaves out a missing key', async () => {
    const tag = 'counters';
    const keys = [`principal:local_cli:${tag}`, `brain:${tag}`];
    await engine.lockPersistenceCounters(keys);
    expect(await engine.readCounterRows(['zz-missing', ...keys])).toEqual([
      expect.objectContaining({ key: keys[1], outstanding_count: expect.anything() }),
      expect.objectContaining({ key: keys[0] }),
    ]);
    expect(await engine.readCounterRows([])).toEqual([]);
  });
});

describe('write credentials', () => {
  test('the grant of an OAuth client is read with its columns, null for an unknown client, and held FOR SHARE on request', async () => {
    await raw(
      `INSERT INTO oauth_clients (client_id, client_name, scope, bound_slug_prefixes, delegated_slug_prefixes, allowed_operations, source_id)
       VALUES ('grant-client', 'Grant client', 'read write', '{notes/}', '{people/}', '{put_page}', 'other')`);
    const grant = await engine.readOAuthClientWriteGrant('grant-client');
    expect(grant).toMatchObject({
      deleted_at: null, scope: 'read write', source_id: 'other', bound_slug_prefixes: ['notes/'], delegated_slug_prefixes: ['people/'],
      allowed_operations: ['put_page'], delegated_namespace: 'prefixes',
    });
    expect(await engine.readOAuthClientWriteGrant('no-such-client')).toBeNull();

    await engine.transaction(async (tx) => {
      expect(await tx.readOAuthClientWriteGrant('grant-client', { lock: true })).toMatchObject({ scope: 'read write' });
      expect(await tx.readOAuthClientWriteGrant('no-such-client', { lock: true })).toBeNull();
    });
    await raw("UPDATE oauth_clients SET deleted_at = now() WHERE client_id = 'grant-client'");
    expect((await engine.readOAuthClientWriteGrant('grant-client'))!.deleted_at).not.toBeNull();
  });

  test('the grant of a legacy token is read with its grant columns and its revocation, null for an unknown token', async () => {
    const [{ id }] = await raw<{ id: string }>(
      `INSERT INTO access_tokens (name, token_hash, scopes, source_id) VALUES ('grant-token', 'hash-grant-token', '{read,write}', 'other') RETURNING id::text AS id`);
    const grant = await engine.readAccessTokenWriteGrant(id);
    expect(grant).toMatchObject({ id, scopes: ['read', 'write'], revoked_at: null, private_pages: 'none' });
    expect(await engine.readAccessTokenWriteGrant(randomUUID())).toBeNull();
    await engine.transaction(async (tx) => {
      expect(await tx.readAccessTokenWriteGrant(id, { lock: true })).toMatchObject({ id, revoked_at: null });
    });
    await raw('UPDATE access_tokens SET revoked_at = now() WHERE id = $1::uuid', [id]);
    expect((await engine.readAccessTokenWriteGrant(id))!.revoked_at).not.toBeNull();
  });

  test('shareLockWriteCredential holds the OAuth client row and the token row for the rest of the transaction', async () => {
    await raw("INSERT INTO oauth_clients (client_id, client_name) VALUES ('share-client', 'Share client')");
    const [{ id }] = await raw<{ id: string }>(
      `INSERT INTO access_tokens (name, token_hash) VALUES ('share-token', 'hash-share-token') RETURNING id::text AS id`);
    const held = async (tx: BrainEngine, table: string, key: string, value: string) =>
      (await tx.executeRaw<{ locked: boolean }>(`SELECT xmax::text <> '0' AS locked FROM ${table} WHERE ${key} = $1`, [value]))[0]!.locked;

    await engine.transaction(async (tx) => {
      expect(await held(tx, 'oauth_clients', 'client_id', 'share-client')).toBe(false);
      await tx.shareLockWriteCredential('oauth_client', 'share-client');
      expect(await held(tx, 'oauth_clients', 'client_id', 'share-client')).toBe(true);

      expect(await held(tx, 'access_tokens', 'id::text', id)).toBe(false);
      await tx.shareLockWriteCredential('legacy_token', id);
      expect(await held(tx, 'access_tokens', 'id::text', id)).toBe(true);

      await tx.shareLockWriteCredential('oauth_client', 'no-such-client');
    });
  });
});

describe('publication effects', () => {
  const effectsOf = (journalId: string) =>
    raw<{ id: string; kind: string; state: string; error_code: string | null; outcome: unknown; execution_token: string | null }>(
      'SELECT id::text AS id, kind, state, error_code, outcome, execution_token FROM persistence_effects WHERE request_id = $1::uuid ORDER BY kind COLLATE "C"', [journalId]);

  test('insertPublicationEffects queues the effects in order, skips one already queued and a gated one while auto-linking is off', async () => {
    const { id } = await admit('effects-insert');
    const spec = {
      requestId: id, revision: randomUUID(), sourceId: 'default', sourceIncarnation: incarnation, worktreeId: null,
      effects: [{ kind: 'links', data: { slugs: ['a'] }, gated: true }, { kind: 'git', data: {} }, { kind: 'embedding', data: { pages: 1 } }],
    };
    expect(await engine.insertPublicationEffects(spec)).toEqual(['links', 'git', 'embedding']);
    expect(await engine.insertPublicationEffects(spec)).toEqual([]);
    expect((await engine.readRequestEffects(id)).map((e) => [e.kind, e.state, e.recovering])).toEqual([
      ['embedding', 'queued', false], ['git', 'queued', false], ['links', 'queued', false],
    ]);

    const off = await admit('effects-gated');
    await raw("INSERT INTO config (key, value) VALUES ('mcp.remote_auto_links', ' False ') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
    try {
      expect(await engine.insertPublicationEffects({ ...spec, requestId: off.id })).toEqual(['git', 'embedding']);
    } finally {
      await raw("DELETE FROM config WHERE key = 'mcp.remote_auto_links'");
    }
    expect((await effectsOf(off.id)).map((e) => e.kind)).toEqual(['embedding', 'git']);
  });

  test('completeEffectRow and failEffectRow finish a claimed effect, readRequestEffects reports each, and a wrong token changes nothing', async () => {
    const { id } = await admit('effects-finish');
    await engine.insertPublicationEffects({
      requestId: id, revision: null, sourceId: 'default', sourceIncarnation: incarnation, worktreeId: null,
      effects: [{ kind: 'git', data: {} }, { kind: 'links', data: { parked: ['people/a'] } }, { kind: 'embedding', data: {} }, { kind: 'mirror', data: {} }],
    });
    const token = randomUUID();
    await raw("UPDATE persistence_effects SET state = 'running', execution_token = $2::uuid WHERE request_id = $1::uuid", [id, token]);
    const rows = await effectsOf(id);
    const idOf = (kind: string) => rows.find((r) => r.kind === kind)!.id;

    await engine.completeEffectRow({ id: idOf('git'), token: randomUUID(), outcomeJson: '{"sha":"nope"}' });
    expect((await effectsOf(id)).find((r) => r.kind === 'git')).toMatchObject({ state: 'running', outcome: null });

    await engine.completeEffectRow({ id: idOf('git'), token, outcomeJson: '{"sha":"abc123"}' });
    await engine.completeEffectRow({ id: idOf('links'), token, outcomeJson: '{"linked":0}' });
    await engine.failEffectRow({ id: idOf('embedding'), token, reason: 'provider_down' });
    await engine.failEffectRow({ id: idOf('mirror'), token: randomUUID(), reason: 'ignored' });

    expect((await effectsOf(id)).map((r) => [r.kind, r.state, r.error_code, r.outcome, r.execution_token])).toEqual([
      ['embedding', 'failed', 'provider_down', null, null],
      ['git', 'committed', null, { sha: 'abc123' }, null],
      ['links', 'failed', 'targets_parked', { linked: 0 }, null],
      ['mirror', 'running', null, null, token],
    ]);
    expect(await engine.readRequestEffects(id, 'git')).toEqual([{ kind: 'git', state: 'committed', error_code: null, outcome: { sha: 'abc123' }, recovering: false }]);
    expect(await engine.readRequestEffects(randomUUID())).toEqual([]);
    await expect(engine.readRequestEffects('not-a-uuid')).rejects.toThrow();
  });

  test('lockEffectGuard share-locks the brain row and answers the owner and state of the effect worktree', async () => {
    const host = randomUUID();
    const [{ id: worktreeId }] = await raw<{ id: string }>('INSERT INTO persistence_worktrees (owner_host_id) VALUES ($1::uuid) RETURNING id::text AS id', [host]);
    await raw('INSERT INTO persistence_brain (singleton) VALUES (1) ON CONFLICT DO NOTHING');
    await engine.transaction(async (tx) => {
      const worktreeHeld = async () => (await tx.executeRaw<{ locked: boolean }>('SELECT xmax::text <> \'0\' AS locked FROM persistence_worktrees WHERE id = $1::uuid', [worktreeId]))[0]!.locked;
      expect(await tx.lockEffectGuard(null)).toBeNull();
      expect(await worktreeHeld()).toBe(false);
      expect(await tx.lockEffectGuard(worktreeId)).toEqual({ owner_host_id: host, state: 'active' });
      expect(await worktreeHeld()).toBe(true);
      expect(await tx.lockEffectGuard(randomUUID())).toBeNull();
    });
  });
});

describe('transaction settings', () => {
  test('beginSnapshotRead starts a repeatable-read transaction, read-only on request', async () => {
    const level = (tx: BrainEngine) => tx.executeRaw<{ iso: string; ro: string }>("SELECT current_setting('transaction_isolation') AS iso, current_setting('transaction_read_only') AS ro");
    const plain = await engine.transaction(async (tx) => { await tx.beginSnapshotRead(); return (await level(tx))[0]; });
    expect(plain).toEqual({ iso: 'repeatable read', ro: 'off' });
    const readOnly = await engine.transaction(async (tx) => { await tx.beginSnapshotRead({ readOnly: true }); return (await level(tx))[0]; });
    expect(readOnly).toEqual({ iso: 'repeatable read', ro: 'on' });
    expect((await level(engine))[0]).toEqual({ iso: 'read committed', ro: 'off' });
  });

  test('requireSynchronousCommit turns synchronous commit on and setEffectTransactionLimits sets the lock and statement limits, for the transaction only', async () => {
    const settings = (tx: BrainEngine) => tx.executeRaw<{ sc: string; lock: string; stmt: string }>(
      "SELECT current_setting('synchronous_commit') AS sc, current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS stmt");
    const [outside] = await settings(engine);
    const inside = await engine.transaction(async (tx) => {
      await tx.executeRaw("SELECT set_config('synchronous_commit', 'off', true)");
      expect((await settings(tx))[0]!.sc).toBe('off');
      await tx.requireSynchronousCommit();
      const afterSync = (await settings(tx))[0]!;
      await tx.setEffectTransactionLimits();
      return { afterSync, afterLimits: (await settings(tx))[0]! };
    });
    expect(inside.afterSync.sc).toBe('on');
    expect(inside.afterLimits).toEqual({ sc: 'on', lock: '1s', stmt: '5s' });
    expect(await settings(engine).then((rows) => rows[0])).toEqual(outside);
  });
});

describe('owned links', () => {
  test('readOwnedLinks lists the edges a producer owns from a page and deleteOwnedLinks removes only the named ones of that producer', async () => {
    const origin = await page('links/origin');
    const targets = await Promise.all(['links/t1', 'links/t2', 'links/t3'].map((slug) => page(slug)));
    for (const slug of ['links/t1', 'links/t2', 'links/t3']) {
      await engine.addLink('links/origin', slug, 'owned edge', 'mentions', 'frontmatter', 'links/origin', 'related');
    }
    await engine.addLink('links/origin', 'links/t1', 'other producer', 'cites', 'manual');

    const owned = await engine.readOwnedLinks('frontmatter', origin.id);
    expect(owned.map((l) => l.slug).sort()).toEqual(['links/t1', 'links/t2', 'links/t3']);
    expect(await engine.readOwnedLinks('frontmatter', targets[0]!.id)).toEqual([]);
    expect(await engine.readOwnedLinks('nobody', origin.id)).toEqual([]);

    const idOf = (slug: string) => owned.find((l) => l.slug === slug)!.id;
    expect(await engine.deleteOwnedLinks(origin.id, 'frontmatter', [])).toBe(0);
    expect(await engine.deleteOwnedLinks(origin.id, 'nobody', [idOf('links/t1')])).toBe(0);
    expect(await engine.deleteOwnedLinks(targets[0]!.id, 'frontmatter', [idOf('links/t1')])).toBe(0);
    expect(await engine.deleteOwnedLinks(origin.id, 'frontmatter', [idOf('links/t1'), String(idOf('links/t2'))])).toBe(2);
    expect((await engine.readOwnedLinks('frontmatter', origin.id)).map((l) => l.slug)).toEqual(['links/t3']);
    const kept = await raw<{ link_source: string }>('SELECT link_source FROM links WHERE from_page_id = $1 AND link_source = \'manual\'', [origin.id]);
    expect(kept).toHaveLength(1);
  });

  test('readLinkTargetPages answers the live pages among the slugs, readable for a trusted writer, and a page that names readers readable only to them', async () => {
    await page('targets/open');
    await page('targets/gone');
    await raw("UPDATE pages SET deleted_at = now() WHERE slug = 'targets/gone'");
    const slugs = ['targets/open', 'targets/gone', 'targets/missing'];
    expect(await engine.readLinkTargetPages('default', slugs, null)).toEqual([{ slug: 'targets/open', readable: true, visible: true }]);
    expect(await engine.readLinkTargetPages('default', [], null)).toEqual([]);
    expect(await engine.readLinkTargetPages('other', slugs, null)).toEqual([]);
    const owner = { identities: [['member:owner']], satisfiedRuleIds: [], folderCoverage: [], owner: true, labelledOnly: false };
    expect(await engine.readLinkTargetPages('default', ['targets/open'], owner)).toEqual([{ slug: 'targets/open', readable: true, visible: true }]);

    await engine.putPage('targets/closed', { type: 'note', title: 'closed', compiled_truth: 'Closed.', frontmatter: { readable_by: ['member:m1'] } });
    const held = (identity: string) => ({ identities: [[identity]], satisfiedRuleIds: [], folderCoverage: [], owner: false, labelledOnly: false });
    const reader = await engine.readLinkTargetPages('default', ['targets/open', 'targets/closed'], held('member:m1'));
    expect(Object.fromEntries(reader.map((p) => [p.slug, p.readable]))).toEqual({ 'targets/open': true, 'targets/closed': true });
    const stranger = await engine.readLinkTargetPages('default', ['targets/open', 'targets/closed'], held('member:m2'));
    expect(Object.fromEntries(stranger.map((p) => [p.slug, p.readable]))).toEqual({ 'targets/open': true, 'targets/closed': false });
  });
});

describe('calibration profiles', () => {
  const profile = (over: Record<string, unknown> = {}) => ({
    sourceId: 'default', holder: 'garry', totalResolved: 10, brier: 0.2, accuracy: 0.7, partialRate: 0.1, gradeCompletion: 1,
    domainScorecards: { macro: { n: 4 } }, patternStatements: ['overconfident on timing'], voiceGatePassed: true, voiceGateAttempts: 1,
    activeBiasTags: ['overconfident-date'], modelId: 'model-a', ...over,
  });

  test('insertCalibrationProfile stores a row and getLatestCalibrationProfile answers the newest one the filter allows', async () => {
    expect(await engine.getLatestCalibrationProfile({ holder: 'garry' })).toBeNull();
    await engine.insertCalibrationProfile(profile({ generatedAt: new Date('2026-01-01T00:00:00Z'), totalResolved: 10 }));
    await engine.insertCalibrationProfile(profile({ generatedAt: new Date('2026-02-01T00:00:00Z'), totalResolved: 20, published: true, waveVersion: 'v9', modelId: 'model-b' }));
    await engine.insertCalibrationProfile(profile({ sourceId: 'other', holder: 'brain', generatedAt: new Date('2026-03-01T00:00:00Z'), totalResolved: 30, brier: null, accuracy: null }));

    const latest = await engine.getLatestCalibrationProfile({ holder: 'garry' });
    expect(latest).toMatchObject({
      source_id: 'default', holder: 'garry', total_resolved: 20, published: true, wave_version: 'v9', model_id: 'model-b',
      pattern_statements: ['overconfident on timing'], active_bias_tags: ['overconfident-date'], voice_gate_passed: true, voice_gate_attempts: 1,
      grade_completion: 1,
    });
    expect(latest!.generated_at.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(typeof latest!.id).toBe('string');
    expect(latest!.brier).toBeCloseTo(0.2, 5);

    expect((await engine.getLatestCalibrationProfile({}))!.total_resolved).toBe(30);
    expect((await engine.getLatestCalibrationProfile({ sourceId: 'default' }))!.total_resolved).toBe(20);
    expect((await engine.getLatestCalibrationProfile({ sourceIds: ['other', 'default'], sourceId: 'default' }))!.total_resolved).toBe(30);
    expect(await engine.getLatestCalibrationProfile({ sourceIds: [] })).toBeNull();
    expect(await engine.getLatestCalibrationProfile({ holder: 'nobody' })).toBeNull();
    const stored = await raw<{ wave_version: string; published: boolean; cost_usd: unknown }>(
      "SELECT wave_version, published, cost_usd FROM calibration_profiles WHERE total_resolved = 10");
    expect(stored).toEqual([{ wave_version: 'v0.36.1.0', published: false, cost_usd: null }]);
  });
});

describe('facts and purges', () => {
  const fingerprint = async (claim: string) => (await raw<{ h: string }>('SELECT gbrain_fact_fingerprint($1) AS h', [claim]))[0]!.h;

  test('insertFactPurge stores one tombstone per source, visibility, subject and claim, and isFactPurged finds it', async () => {
    const claim = 'Acme raised a Series A';
    const purge = { sourceId: 'default', visibility: 'world', subject: '*', factHash: await fingerprint(claim), requestId: null, actor: 'owner', reason: 'wrong' };
    expect(await engine.insertFactPurge(purge)).toBe(true);
    expect(await engine.insertFactPurge(purge)).toBe(false);
    expect(await raw('SELECT actor, reason FROM fact_purges WHERE fact_hash = $1', [purge.factHash])).toEqual([{ actor: 'owner', reason: 'wrong' }]);

    expect(await engine.isFactPurged('default', 'world', claim, 'companies/acme')).toBe(true);
    expect(await engine.isFactPurged('default', 'world', claim, null)).toBe(true);
    expect(await engine.isFactPurged('default', 'private', claim, null)).toBe(false);
    expect(await engine.isFactPurged('other', 'world', claim, null)).toBe(false);
    expect(await engine.isFactPurged('default', 'world', 'Acme raised a Series B', null)).toBe(false);

    const scoped = { ...purge, subject: 'people/bob', factHash: await fingerprint('Bob left Acme') };
    expect(await engine.insertFactPurge({ ...scoped, requestId: randomUUID(), actor: null, reason: null })).toBe(true);
    expect(await engine.isFactPurged('default', 'world', 'Bob left Acme', 'people/bob')).toBe(true);
    expect(await engine.isFactPurged('default', 'world', 'Bob left Acme', 'people/alice')).toBe(false);
    expect(await engine.isFactPurged('default', 'world', 'Bob left Acme', null)).toBe(false);
  });

  test('upsertPagePurges tombstones each content hash and a hash purged again takes the new slug', async () => {
    await engine.upsertPagePurges({ sourceId: 'default', contentHashes: ['hash-1', 'hash-2'], slug: 'notes/first', requestId: null });
    const rows = () => raw<{ content_hash: string; slug: string }>("SELECT content_hash, slug FROM page_purges WHERE source_id = 'default' ORDER BY content_hash");
    expect(await rows()).toEqual([{ content_hash: 'hash-1', slug: 'notes/first' }, { content_hash: 'hash-2', slug: 'notes/first' }]);
    const requestId = randomUUID();
    await engine.upsertPagePurges({ sourceId: 'default', contentHashes: ['hash-2', 'hash-3'], slug: 'notes/second', requestId });
    expect(await rows()).toEqual([
      { content_hash: 'hash-1', slug: 'notes/first' }, { content_hash: 'hash-2', slug: 'notes/second' }, { content_hash: 'hash-3', slug: 'notes/second' },
    ]);
    expect(await raw("SELECT request_id::text AS r FROM page_purges WHERE content_hash = 'hash-2'")).toEqual([{ r: requestId }]);
  });

  test('countPurgeProbe counts the rows a probe finds up to the bound and listPurgeProbeItems names them', async () => {
    await page('probe/from');
    await page('probe/to');
    await engine.addLink('probe/from', 'probe/to', 'met the Zebra-Needle founder', 'mentions', 'manual');
    await engine.addLink('probe/to', 'probe/from', 'zebra-needle again', 'mentions', 'manual');
    const named = (needles: string[], sourceId = 'default') => ({ kind: 'named' as const, table: 'links' as const, sourceId, needles });

    expect(await engine.countPurgeProbe(named(['ZEBRA-needle']), 10)).toBe(2);
    expect(await engine.countPurgeProbe(named(['ZEBRA-needle']), 1)).toBe(2);
    expect(await engine.countPurgeProbe(named(['ZEBRA-needle']), 0)).toBe(1);
    expect(await engine.countPurgeProbe(named(['no such text']), 10)).toBe(0);
    expect(await engine.countPurgeProbe(named([]), 10)).toBe(0);
    expect(await engine.countPurgeProbe(named(['zebra-needle'], 'other'), 10)).toBe(0);

    const items = await engine.listPurgeProbeItems(named(['zebra-needle']));
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.replace(/^link:\d+ /, '')).sort()).toEqual(['probe/from -> probe/to', 'probe/to -> probe/from']);
    expect(await engine.listPurgeProbeItems(named(['no such text']))).toEqual([]);
    expect(await engine.listPurgeProbeItems(named([]))).toEqual([]);

    await engine.insertFact({ fact: 'The zebra-needle table probe fact', entity_slug: 'probe/from', source: 'test:probe' }, { source_id: 'default' });
    expect(await engine.countPurgeProbe({ kind: 'table', table: 'facts', sourceId: 'default', needles: ['zebra-needle table'] }, 5)).toBe(1);
    expect(await engine.countPurgeProbe({ kind: 'table', table: 'facts', sourceId: 'other', needles: ['zebra-needle table'] }, 5)).toBe(0);
  });

  test('listFactProvenance reads the stored source of the named facts of one source', async () => {
    const a = await engine.insertFact({ fact: 'Provenance fact one', entity_slug: 'people/prov', source: 'mcp:remember' }, { source_id: 'default' });
    const b = await engine.insertFact({ fact: 'Provenance fact two', entity_slug: 'people/prov', source: 'cli:import' }, { source_id: 'default' });
    const c = await engine.insertFact({ fact: 'Provenance fact elsewhere', entity_slug: 'people/prov', source: 'mcp:remember' }, { source_id: 'other' });
    const rows = await engine.listFactProvenance('default', [a.id, b.id, c.id, 987654321]);
    expect(rows.map((r) => [Number(r.id), r.source]).sort()).toEqual([[a.id, 'mcp:remember'], [b.id, 'cli:import']].sort());
    expect(await engine.listFactProvenance('default', [])).toEqual([]);
    expect((await engine.listFactProvenance('other', [c.id])).map((r) => Number(r.id))).toEqual([c.id]);
  });

  test('listSlotRows answers the active conversation facts of the named slots in valid-from order under the pool scope', async () => {
    const source = 'cli:extract-conversation-facts:test';
    const make = async (fact: string, over: { source?: string; dimension: string; value: string; validFrom: string; visibility?: 'world' | 'private'; entity?: string }) => {
      const { id } = await engine.insertFact({
        fact, entity_slug: over.entity ?? 'people/slot', source: over.source ?? source, visibility: over.visibility ?? 'world', valid_from: new Date(over.validFrom),
      }, { source_id: 'default' });
      await raw('UPDATE facts SET dimension = $2, value = $3, value_hash = $4 WHERE id = $1', [id, over.dimension, over.value, `vh-${over.value}`]);
      return id;
    };
    const later = await make('Slot employer later', { dimension: 'employer', value: 'Globex', validFrom: '2026-02-01T00:00:00Z' });
    const earlier = await make('Slot employer earlier', { dimension: 'employer', value: 'Acme', validFrom: '2026-01-01T00:00:00Z' });
    await make('Slot city', { dimension: 'city', value: 'Oslo', validFrom: '2026-01-15T00:00:00Z' });
    await make('Slot other source', { dimension: 'employer', value: 'Initech', validFrom: '2026-01-20T00:00:00Z', source: 'mcp:remember' });
    const hidden = await make('Slot private', { dimension: 'employer', value: 'Hooli', validFrom: '2026-01-25T00:00:00Z', visibility: 'private' });

    const slots = [{ source_id: 'default', entity_slug: 'people/slot', dimension: 'employer' }];
    const open = await engine.listSlotRows({ sourceId: 'default', worldOnly: false, excludePrivate: false }, slots);
    expect(open.map((r) => Number(r.id))).toEqual([earlier, hidden, later]);
    expect(open.map((r) => r.fact)).toEqual(['Slot employer earlier', 'Slot private', 'Slot employer later']);
    const world = await engine.listSlotRows({ sourceId: 'default', worldOnly: true, excludePrivate: false }, slots);
    expect(world.map((r) => r.fact)).toEqual(['Slot employer earlier', 'Slot employer later']);
    expect(await engine.listSlotRows({ sourceId: 'other', worldOnly: false, excludePrivate: false }, slots)).toEqual([]);
    expect(await engine.listSlotRows({ sourceId: 'default', worldOnly: false, excludePrivate: false }, [{ ...slots[0]!, dimension: 'nothing' }])).toEqual([]);
  });
});

describe('takes and page lookups', () => {
  test('findTakeId answers the id of a page take by row number and readLivePageIdBySlug the id of a live page', async () => {
    const withTakes = await page('lookups/with-takes');
    await engine.addTakesBatch([
      { page_id: withTakes.id, row_num: 1, claim: 'First take', kind: 'take', holder: 'brain' },
      { page_id: withTakes.id, row_num: 3, claim: 'Third take', kind: 'take', holder: 'brain' },
    ]);
    const stored = await raw<{ id: string; row_num: number }>('SELECT id::text AS id, row_num FROM takes WHERE page_id = $1 ORDER BY row_num', [withTakes.id]);
    expect(await engine.findTakeId(withTakes.id, 1)).toBe(Number(stored[0]!.id));
    expect(await engine.findTakeId(withTakes.id, 3)).toBe(Number(stored[1]!.id));
    expect(await engine.findTakeId(withTakes.id, 2)).toBeNull();
    expect(await engine.findTakeId(withTakes.id + 100_000, 1)).toBeNull();

    expect(await engine.readLivePageIdBySlug('lookups/with-takes', 'default')).toBe(withTakes.id);
    expect(await engine.readLivePageIdBySlug('lookups/with-takes', 'other')).toBeNull();
    expect(await engine.readLivePageIdBySlug('lookups/missing', 'default')).toBeNull();
    await raw('UPDATE pages SET deleted_at = now() WHERE id = $1', [withTakes.id]);
    expect(await engine.readLivePageIdBySlug('lookups/with-takes', 'default')).toBeNull();
  });
});

describe('op checkpoints', () => {
  test('deleteOpCheckpoint removes one checkpoint and its paths and leaves the others, and a missing one is a no-op', async () => {
    await raw(`INSERT INTO op_checkpoints (op, fingerprint, completed_keys) VALUES ('embed', 'fp-1', '["a","b"]'), ('embed', 'fp-2', '["c"]'), ('reindex', 'fp-1', '[]')`);
    await raw(`INSERT INTO op_checkpoint_paths (op, fingerprint, path) VALUES ('embed', 'fp-1', 'notes/a'), ('embed', 'fp-2', 'notes/c')`);
    await engine.deleteOpCheckpoint('embed', 'fp-1');
    expect(await raw("SELECT op, fingerprint FROM op_checkpoints WHERE op IN ('embed', 'reindex') ORDER BY op, fingerprint")).toEqual([
      { op: 'embed', fingerprint: 'fp-2' }, { op: 'reindex', fingerprint: 'fp-1' },
    ]);
    expect(await raw('SELECT path FROM op_checkpoint_paths')).toEqual([{ path: 'notes/c' }]);
    await engine.deleteOpCheckpoint('embed', 'no-such-fingerprint');
    expect(await raw("SELECT count(*)::int AS n FROM op_checkpoints WHERE op IN ('embed', 'reindex')")).toEqual([{ n: 2 }]);
  });
});

describe('belief ledger', () => {
  test('markBeliefCommits marks each publication with a committed event once, and never replaces a mark', async () => {
    const [committed, second, unknown] = [randomUUID(), randomUUID(), randomUUID()];
    for (const [n, publication] of [committed, second].entries()) {
      await raw(
        `INSERT INTO belief_events (event_key, source_id, source_incarnation, slug, subject_kind, subject_key, event_type, trust_tier, visibility,
                                    publication_id, ord, state_hash, cause)
         VALUES (decode($1, 'hex'), 'default', $2::uuid, 'notes/belief', 'page', 'notes/belief', 'created', 'unknown', 'private', $3::uuid, 0, 'state', '{}')`,
        [`0${n}`.padEnd(8, 'a'), incarnation, publication]);
    }
    expect(await raw('SELECT publication_id FROM belief_commit_marks')).toEqual([]);

    await engine.markBeliefCommits([committed, unknown]);
    const marks = () => raw<{ publication_id: string; observed_at: Date; recorded_at: Date }>(
      `SELECT m.publication_id::text AS publication_id, m.observed_at, (SELECT max(recorded_at) FROM belief_events e WHERE e.publication_id = m.publication_id) AS recorded_at
         FROM belief_commit_marks m ORDER BY m.publication_id`);
    const first = await marks();
    expect(first.map((m) => m.publication_id)).toEqual([committed]);
    expect(new Date(first[0]!.observed_at).getTime()).toBeGreaterThanOrEqual(new Date(first[0]!.recorded_at).getTime());

    await engine.markBeliefCommits([committed, second]);
    const both = await marks();
    expect(both.map((m) => m.publication_id).sort()).toEqual([committed, second].sort());
    expect(new Date(both.find((m) => m.publication_id === committed)!.observed_at).getTime()).toBe(new Date(first[0]!.observed_at).getTime());
    await engine.markBeliefCommits([]);
    expect(await marks()).toHaveLength(2);
  });

  test('readBeliefStateRows reads the stream pages with their takes, and the writer trust tier set in the transaction', async () => {
    const stream = await page('belief/stream');
    await engine.addTakesBatch([{ page_id: stream.id, row_num: 1, claim: 'Stream take', kind: 'take', holder: 'brain' }]);
    const input = {
      sourceId: 'default', slugs: ['belief/stream', 'belief/none'], pageIds: [], knownFp: {}, knownCounts: null, knownPages: [],
      knownEntitySlugs: [], suppressed: false, planModePrev: null,
    };
    const rows = await engine.readBeliefStateRows(input);
    expect(rows.pages).toHaveLength(1);
    expect(rows.pages[0]).toMatchObject({ id: stream.id, slug: 'belief/stream', deleted: false, visible: true, large: false, incarnation });
    expect(rows.takes).toMatchObject([{ page_id: stream.id, row_num: 1, claim: 'Stream take', kind: 'take', holder: 'brain', active: true }]);
    expect(rows.facts).toEqual([]);
    expect(rows.links).toEqual([]);
    expect(rows.transitions).toEqual([]);
    expect(rows.endpoints).toEqual([]);
    expect(rows.writer_tier).toBeNull();
    expect(rows.counts).toHaveLength(4);

    const inTx = await engine.transaction(async (tx) => {
      await tx.executeRaw("SELECT set_config('gbrain.write_trust_tier', 'agent_written', true)");
      return tx.readBeliefStateRows({ ...input, slugs: ['belief/none'], pageIds: [stream.id] });
    });
    expect(inTx.writer_tier).toBe('agent_written');
    expect(inTx.pages.map((p) => p.slug)).toEqual(['belief/stream']);
  });
});

describe('segmented pages', () => {
  test('readSegmentedEmbedPage answers a live sealed segmented page by id or by source and slug, and nothing for an unsealed, inline or missing page', async () => {
    const published = await publishSegmentedPage(engine, 'segmented/embed-probe', [segmentText('# Segmented\nfirst segment\n'), segmentText('second segment\n')]);
    expect(await engine.readSegmentedEmbedPage({ id: published.pageId })).toBeNull();
    await raw('UPDATE pages SET text_projection_revision = knowledge_revision WHERE id = $1', [published.pageId]);
    const byId = await engine.readSegmentedEmbedPage({ id: published.pageId });
    expect(byId).toMatchObject({ id: published.pageId, slug: 'segmented/embed-probe', source_id: 'default', body_storage: 'segmented', contextual_retrieval_mode: null });
    expect(byId!.body_bytes).toBeGreaterThan(0);
    expect(await engine.readSegmentedEmbedPage({ sourceId: 'default', slug: 'segmented/embed-probe' })).toEqual(byId);
    expect(await engine.readSegmentedEmbedPage({ sourceId: 'other', slug: 'segmented/embed-probe' })).toBeNull();

    const inline = await page('segmented/inline-probe');
    expect(await engine.readSegmentedEmbedPage({ id: inline.id })).toBeNull();
    expect(await engine.readSegmentedEmbedPage({ id: published.pageId + 100_000 })).toBeNull();
    await raw('UPDATE pages SET deleted_at = now() WHERE id = $1', [published.pageId]);
    expect(await engine.readSegmentedEmbedPage({ id: published.pageId })).toBeNull();
  });
});

describe('sources', () => {
  test('readSourceRow and lockSourceRow answer the source row and null for an unknown source, and the lock holds the row', async () => {
    await raw("INSERT INTO sources (id, name, local_path, config) VALUES ('checked', 'checked', '/tmp/checked-brain', '{\"role\":\"notes\"}')");
    expect(await engine.readSourceRow('checked')).toEqual({ id: 'checked', local_path: '/tmp/checked-brain', config: { role: 'notes' }, archived: false });
    expect(await engine.readSourceRow('default')).toMatchObject({ id: 'default', archived: false });
    expect(await engine.readSourceRow('no-such-source')).toBeNull();

    await engine.transaction(async (tx) => {
      const held = async () => (await tx.executeRaw<{ locked: boolean }>("SELECT xmax::text <> '0' AS locked FROM sources WHERE id = 'checked'"))[0]!.locked;
      expect(await held()).toBe(false);
      expect(await tx.lockSourceRow('checked')).toEqual({ id: 'checked', local_path: '/tmp/checked-brain', config: { role: 'notes' }, archived: false });
      expect(await held()).toBe(true);
      expect(await tx.lockSourceRow('no-such-source')).toBeNull();
    });
  });

  test('readScopeSourceConfigs reads the configs of the named sources, with or without a row lock, and leaves out a missing source', async () => {
    await raw("INSERT INTO sources (id, name, config) VALUES ('scoped-a', 'a', '{\"tag\":\"a\"}'), ('scoped-b', 'b', '{\"tag\":\"b\"}')");
    const byId = (rows: Array<{ id: string; config: unknown }>) => Object.fromEntries(rows.map((r) => [r.id, r.config]));
    const plain = await engine.readScopeSourceConfigs(['scoped-b', 'scoped-a', 'scoped-a', 'scoped-missing']);
    expect(byId(plain)).toEqual({ 'scoped-a': { tag: 'a' }, 'scoped-b': { tag: 'b' } });
    await engine.transaction(async (tx) => {
      expect(byId(await tx.readScopeSourceConfigs(['scoped-a'], 'share'))).toEqual({ 'scoped-a': { tag: 'a' } });
      expect(byId(await tx.readScopeSourceConfigs(['scoped-a', 'scoped-b'], 'update'))).toEqual({ 'scoped-a': { tag: 'a' }, 'scoped-b': { tag: 'b' } });
      const held = await tx.executeRaw<{ id: string; locked: boolean }>("SELECT id, xmax::text <> '0' AS locked FROM sources WHERE id LIKE 'scoped-%' ORDER BY id");
      expect(held).toEqual([{ id: 'scoped-a', locked: true }, { id: 'scoped-b', locked: true }]);
    });
    expect(await engine.readScopeSourceConfigs([])).toEqual([]);
  });

  test('readOwnerOnlySourcesPresent turns true once a source is marked owner-only, and readOwnerOnlySourceConfig reads one source config', async () => {
    expect(await engine.readOwnerOnlySourcesPresent()).toBe(false);
    await raw(`INSERT INTO sources (id, name, config) VALUES ('private-notes', 'private notes', '{"owner_only": true}')`);
    expect(await engine.readOwnerOnlySourcesPresent()).toBe(true);
    expect(await engine.readOwnerOnlySourceConfig('private-notes')).toEqual({ config: { owner_only: true } });
    expect(await engine.readOwnerOnlySourceConfig('checked')).toEqual({ config: { role: 'notes' } });
    expect(await engine.readOwnerOnlySourceConfig('no-such-source')).toBeNull();
  });

  test('listGuestSourceIds answers the guest sources among the ids, by config flag or by a guest_sources row', async () => {
    await raw(`INSERT INTO sources (id, name, config) VALUES ('guest-config', 'guest config', '{"guest": true}'), ('guest-table', 'guest table', '{}')`);
    await raw(`INSERT INTO guest_sources (source_id) VALUES ('guest-table')`);
    const guests = await engine.listGuestSourceIds(['guest-config', 'guest-table', 'guest-table', 'default', 'other', 'no-such-source']);
    expect(guests.sort()).toEqual(['guest-config', 'guest-table']);
    expect(await engine.listGuestSourceIds(['default', 'other'])).toEqual([]);
    expect(await engine.listGuestSourceIds([])).toEqual([]);
  });
});

describe('access reads', () => {
  test('readOauthClient reads the whole client row and answers null for an unknown client', async () => {
    await raw(
      `INSERT INTO oauth_clients (client_id, client_name, scope, grant_types, client_id_issued_at, source_id, may_act_for, bound_slug_prefixes)
       VALUES ('whole-client', 'Whole client', 'read', '{client_credentials}', 1234, 'other', '{member-a}', '{notes/}')`);
    const row = await engine.readOauthClient('whole-client');
    expect(row).toMatchObject({
      client_id: 'whole-client', client_name: 'Whole client', scope: 'read', grant_types: ['client_credentials'], client_id_issued_at: 1234,
      source_id: 'other', may_act_for: ['member-a'], bound_slug_prefixes: ['notes/'], deleted_at: null, grant_revision: 0, private_pages: 'none',
      delegated_namespace: 'prefixes',
    });
    expect(row!.created_at).toBeInstanceOf(Date);
    expect(await engine.readOauthClient('no-such-client')).toBeNull();
  });

  test('readWriterSlugFence reads the slug prefixes of an OAuth client, its delegated ones, or a local writer, and null where none is stored', async () => {
    await raw(`INSERT INTO oauth_clients (client_id, client_name, bound_slug_prefixes, delegated_slug_prefixes) VALUES ('fenced-client', 'Fenced', '{notes/,people/}', '{inbox/}')`);
    await raw(`INSERT INTO oauth_clients (client_id, client_name) VALUES ('open-client', 'Open')`);
    const [{ id: cliWriter }] = await raw<{ id: string }>(
      `INSERT INTO persistence_local_writers (lane, credential_hash, grant_ceiling) VALUES ('cli', 'cred-fence-cli', '{"slugPrefixes": ["work/"]}') RETURNING id::text AS id`);

    expect(await engine.readWriterSlugFence({ kind: 'oauth_client', id: 'fenced-client' })).toEqual(['notes/', 'people/']);
    expect(await engine.readWriterSlugFence({ kind: 'oauth_client', id: 'fenced-client' }, { delegated: true })).toEqual(['inbox/']);
    expect(await engine.readWriterSlugFence({ kind: 'oauth_client', id: 'open-client' })).toBeNull();
    expect(await engine.readWriterSlugFence({ kind: 'oauth_client', id: 'no-such-client' })).toBeNull();
    expect(await engine.readWriterSlugFence({ kind: 'local_cli', id: cliWriter })).toEqual(['work/']);
    expect(await engine.readWriterSlugFence({ kind: 'local_stdio', id: randomUUID() })).toBeNull();
    expect(await engine.readWriterSlugFence({ kind: 'legacy_token', id: 'anything' })).toBeNull();
  });

  test('readMayActFor reads the list of a live token or client and the stdio config text, and null once revoked or deleted', async () => {
    await raw("INSERT INTO oauth_clients (client_id, client_name, may_act_for) VALUES ('acting-client', 'Acting', '{member-a,member-b}')");
    const [{ id: tokenId }] = await raw<{ id: string }>(
      `INSERT INTO access_tokens (name, token_hash, may_act_for) VALUES ('acting-token', 'hash-acting-token', '{member-c}') RETURNING id::text AS id`);
    await raw("INSERT INTO config (key, value) VALUES ('mcp.stdio_may_act_for', '[\"member-d\"]') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");

    expect(await engine.readMayActFor('oauth_client', 'acting-client')).toEqual(['member-a', 'member-b']);
    expect(await engine.readMayActFor('legacy_token', tokenId)).toEqual(['member-c']);
    expect(await engine.readMayActFor('stdio_config', 'mcp.stdio_may_act_for')).toBe('["member-d"]');
    expect(await engine.readMayActFor('stdio_config', 'mcp.unset_key')).toBeNull();
    expect(await engine.readMayActFor('oauth_client', 'no-such-client')).toBeNull();

    await raw("UPDATE oauth_clients SET deleted_at = now() WHERE client_id = 'acting-client'");
    await raw('UPDATE access_tokens SET revoked_at = now() WHERE id = $1::uuid', [tokenId]);
    expect(await engine.readMayActFor('oauth_client', 'acting-client')).toBeNull();
    expect(await engine.readMayActFor('legacy_token', tokenId)).toBeNull();
  });

  test('readAudiencePrincipals answers the enabled members with their groups and the existing groups among the asserted ids', async () => {
    await raw(`INSERT INTO access_members (id) VALUES ('aud-live'), ('aud-lone')`);
    await raw(`INSERT INTO access_members (id, disabled_at) VALUES ('aud-disabled', now())`);
    await raw(`INSERT INTO access_members (id, tombstoned_at) VALUES ('aud-tombstoned', now())`);
    await raw(`INSERT INTO access_groups (id) VALUES ('aud-team'), ('aud-board')`);
    await raw(`INSERT INTO access_group_members (group_id, member_id) VALUES ('aud-team', 'aud-live'), ('aud-board', 'aud-live')`);

    const rows = await engine.readAudiencePrincipals(['aud-live', 'aud-lone', 'aud-disabled', 'aud-tombstoned', 'aud-missing'], ['aud-team', 'aud-missing-group']);
    expect(rows.members.sort((a, b) => a.id.localeCompare(b.id))).toEqual([{ id: 'aud-live', groups: ['aud-board', 'aud-team'] }, { id: 'aud-lone', groups: [] }]);
    expect(rows.groups).toEqual(['aud-team']);
    expect(await engine.readAudiencePrincipals([], [])).toEqual({ members: [], groups: [] });
    expect(await engine.readAudiencePrincipals(['aud-missing'], [])).toEqual({ members: [], groups: [] });
  });
});

describe('write request completion and reads', () => {
  test('readWriteRequest and readWriteRequestById read an admitted request and answer null for an unknown one', async () => {
    const { id, requestId } = await admit('read-request');
    const byKey = await engine.readWriteRequest('local_cli', 'read-request', requestId);
    expect(byKey).toMatchObject({ id, request_id: requestId, principal_kind: 'local_cli', principal_id: 'read-request', state: 'queued', operation: 'remember' });
    expect(await engine.readWriteRequestById(id)).toEqual(byKey);
    expect(await engine.readWriteRequestById(id, { signal: new AbortController().signal })).toEqual(byKey);
    expect(await engine.readWriteRequest('local_cli', 'someone-else', requestId)).toBeNull();
    expect(await engine.readWriteRequest('local_cli', 'read-request', randomUUID())).toBeNull();
    expect(await engine.readWriteRequestById(randomUUID())).toBeNull();
  });

  test('completeWriteRow records the terminal state, releases the counters, reports purge tombstones on request, and refuses a result over the reservation', async () => {
    const done = await admit('complete-row');
    const completion = (over: Record<string, unknown> = {}) => ({
      id: done.id, state: 'committed' as const, outcome: { status: 'committed' }, errorCode: null, errorMessage: null, consumerVersion: 'landing',
      consumerHostId: null, errorDetail: null, resultBytes: 1200, counterKeys: done.keys, intentBytes: 100, retainedBytes: 1500,
      terminalReservation: 8192, probePurges: false, ...over,
    });
    const tooBig = await engine.completeWriteRow(completion({ resultBytes: 20_000 }));
    expect(tooBig).toBeNull();
    expect(await engine.readWriteRequestById(done.id)).toMatchObject({ state: 'queued', completed_at: null });

    await engine.insertFactPurge({ sourceId: 'default', visibility: 'world', subject: '*', factHash: 'completion-probe-hash', requestId: null, actor: null, reason: null });
    const row = await engine.completeWriteRow(completion({ probePurges: true }));
    expect(row).toMatchObject({ id: done.id, state: 'committed', outcome: { status: 'committed' }, consumer_version: 'landing', purge_has_facts: true });
    expect(row!.completed_at).not.toBeNull();
    const [pagePurges] = await raw<{ present: boolean }>("SELECT EXISTS (SELECT 1 FROM page_purges WHERE source_id = 'default') AS present");
    expect(row!.purge_has_pages).toBe(pagePurges!.present);
    expect(await engine.readWriteRequestById(done.id)).toMatchObject({ state: 'committed', terminal_reservation: expect.anything() });
    const counters = await engine.readCounterRows(done.keys);
    expect(counters.map((c) => [Number(c.outstanding_count), Number(c.intent_bytes), Number(c.terminal_bytes)])).toEqual([[0, 0, 1500], [0, 0, 1500]]);

    const failed = await admit('complete-failed');
    const failure = await engine.completeWriteRow(completion({
      id: failed.id, state: 'failed', outcome: null, errorCode: 'publish_failed', errorMessage: 'boom', errorDetail: { at: 'publish' }, counterKeys: failed.keys,
    }));
    expect(failure).toMatchObject({ state: 'failed', error_code: 'publish_failed', error_message: 'boom', error_detail: { at: 'publish' } });
    expect(failure).not.toHaveProperty('purge_has_facts');
  });
});

describe('write gate receipts', () => {
  test('upsertWriteGateReceipt records a receipt once per target, hash and detector version, and a repeat refreshes it and keeps the request id', async () => {
    const receipt = {
      target_table: 'pages' as const, target_id: 'gate-page-1', source_id: 'default', content_hash: 'hash-a', tier: 'agent_written', detector_version: 4,
      verdict: 'flag' as const, reason_families: ['injection'], reasons: ['first reason'], detector_error: false, request_id: 'req-first',
    };
    const id = await engine.upsertWriteGateReceipt(receipt);
    expect(id).toBeGreaterThan(0);
    expect(await engine.upsertWriteGateReceipt({ ...receipt, verdict: 'quarantine', reasons: ['second reason'], request_id: null })).toBe(id);
    const other = await engine.upsertWriteGateReceipt({ ...receipt, content_hash: 'hash-b' });
    expect(other).not.toBe(id);
    expect(await engine.upsertWriteGateReceipt({ ...receipt, detector_version: 5 })).not.toBe(id);

    expect(await raw('SELECT verdict, reasons, request_id, source_id FROM write_gate_receipts WHERE id = $1', [id])).toEqual([
      { verdict: 'quarantine', reasons: ['second reason'], request_id: 'req-first', source_id: 'default' },
    ]);
    const listed = await engine.listWriteGateReceiptsFor('pages', 'gate-page-1', 10);
    expect(listed).toHaveLength(3);
    expect(listed.find((r) => r.id === id)).toMatchObject({ verdict: 'quarantine', detector_version: 4, tier: 'agent_written' });
  });
});

describe('purge statements', () => {
  test('loadPurgeTarget reads a live fact of the source with its fingerprint and nothing for another source or an unknown id', async () => {
    const claim = 'Purge target claim for Acme';
    const { id } = await engine.insertFact({ fact: claim, entity_slug: 'companies/acme', source: 'test:purge', visibility: 'world' }, { source_id: 'default' });
    const target = await engine.loadPurgeTarget(id, 'default');
    const [{ h }] = await raw<{ h: string }>('SELECT gbrain_fact_fingerprint($1) AS h', [claim]);
    expect(target).toMatchObject({
      id, source_id: 'default', visibility: 'world', fact: claim, entity_slug: 'companies/acme', source_markdown_slug: null, fact_hash: h, embedding: null,
    });
    expect(await engine.loadPurgeTarget(id, 'other')).toBeNull();
    expect(await engine.loadPurgeTarget(id + 100_000, 'default')).toBeNull();
  });

  test('insertTakePurge stores a tombstone by claim hash or one per take claim of a page, and says whether it stored anything', async () => {
    const byHash = { sourceId: 'default', subject: '*', requestId: null, claimHash: 'take-claim-hash' };
    expect(await engine.insertTakePurge(byHash)).toBe(true);
    expect(await engine.insertTakePurge(byHash)).toBe(false);

    const withTakes = await page('purges/page-with-takes');
    await engine.addTakesBatch([
      { page_id: withTakes.id, row_num: 1, claim: 'Alpha take claim', kind: 'take', holder: 'brain' },
      { page_id: withTakes.id, row_num: 2, claim: 'Beta take claim', kind: 'take', holder: 'brain' },
    ]);
    const requestId = randomUUID();
    expect(await engine.insertTakePurge({ sourceId: 'default', subject: 'purges/page-with-takes', requestId, pageId: withTakes.id })).toBe(true);
    const stored = await raw<{ claim_hash: string; request_id: string }>(
      "SELECT claim_hash, request_id::text AS request_id FROM take_purges WHERE subject = 'purges/page-with-takes' ORDER BY claim_hash");
    const expected = await raw<{ h: string }>("SELECT gbrain_fact_fingerprint(c) AS h FROM unnest(ARRAY['Alpha take claim', 'Beta take claim']) c ORDER BY 1");
    expect(stored).toEqual(expected.map((e) => ({ claim_hash: e.h, request_id: requestId })));
    expect(await engine.insertTakePurge({ sourceId: 'default', subject: 'purges/page-with-takes', requestId, pageId: withTakes.id })).toBe(false);
    const bare = await page('purges/page-without-takes');
    expect(await engine.insertTakePurge({ sourceId: 'default', subject: 'x', requestId: null, pageId: bare.id })).toBe(false);
  });

  test('countPagePurgeTombstones counts the tombstones of one slug in one source', async () => {
    expect(await engine.countPagePurgeTombstones('default', 'purges/tombstoned')).toBe(0);
    await engine.upsertPagePurges({ sourceId: 'default', contentHashes: ['tomb-1', 'tomb-2', 'tomb-3'], slug: 'purges/tombstoned', requestId: null });
    await engine.upsertPagePurges({ sourceId: 'default', contentHashes: ['tomb-4'], slug: 'purges/elsewhere', requestId: null });
    expect(await engine.countPagePurgeTombstones('default', 'purges/tombstoned')).toBe(3);
    expect(await engine.countPagePurgeTombstones('other', 'purges/tombstoned')).toBe(0);
  });

  test('listPurgeEffects lists the effects of a request in kind order and flags the ones that parked targets', async () => {
    const { id } = await admit('purge-effects');
    await engine.insertPublicationEffects({
      requestId: id, revision: null, sourceId: 'default', sourceIncarnation: incarnation, worktreeId: null,
      effects: [{ kind: 'links', data: { parked: ['people/a'] } }, { kind: 'embedding', data: {} }, { kind: 'git', data: { parked: [] } }],
    });
    await raw("UPDATE persistence_effects SET state = 'failed', error_code = 'targets_parked' WHERE request_id = $1::uuid AND kind = 'links'", [id]);
    expect(await engine.listPurgeEffects(id)).toEqual([
      { kind: 'embedding', state: 'queued', error_code: null, parked: false },
      { kind: 'git', state: 'queued', error_code: null, parked: false },
      { kind: 'links', state: 'failed', error_code: 'targets_parked', parked: true },
    ]);
    expect(await engine.listPurgeEffects(randomUUID())).toEqual([]);
  });

  test('the review queue, review proposal and decide proposal deletes remove only the rows that name the facts, and say how many', async () => {
    await raw(
      `INSERT INTO decide_review_queue (kind, source_id, a_ref, b_ref) VALUES
         ('dedup', 'default', '101', '102'), ('dedup', 'default', '103', '101'), ('dedup', 'default', '104', '105'), ('dedup', 'other', '101', '102')`);
    await raw(
      `INSERT INTO decide_review_proposals (kind, source_id, sweep_id, a_ref, b_ref, p_action) VALUES
         ('dedup', 'default', 's1', '101', '102', 0.9), ('dedup', 'default', 's1', '104', '105', 0.9), ('dedup', 'other', 's1', '101', '102', 0.9)`);
    await raw(
      `INSERT INTO decide_proposals (source_id, sweep_id, pair_index, new_fact_id, old_fact_id, p_supersede, proposal_floor) VALUES
         ('default', 'd1', 0, 101, 201, 0.9, 0.5), ('default', 'd1', 1, 202, 101, 0.9, 0.5), ('default', 'd1', 2, 203, 204, 0.9, 0.5), ('other', 'd2', 0, 101, 201, 0.9, 0.5)`);

    expect(await engine.deletePurgeReviewQueue('default', ['101'])).toBe(2);
    expect(await raw("SELECT a_ref FROM decide_review_queue WHERE source_id = 'default'")).toEqual([{ a_ref: '104' }]);
    expect(await raw("SELECT count(*)::int AS n FROM decide_review_queue WHERE source_id = 'other'")).toEqual([{ n: 1 }]);
    expect(await engine.deletePurgeReviewQueue('default', ['101'])).toBe(0);

    expect(await engine.deletePurgeReviewProposals('default', ['102'])).toBe(1);
    expect(await raw("SELECT a_ref FROM decide_review_proposals WHERE source_id = 'default'")).toEqual([{ a_ref: '104' }]);
    expect(await engine.deletePurgeReviewProposals('default', [])).toBe(0);

    expect(await engine.deletePurgeDecideProposals('default', [101])).toBe(2);
    expect(await raw("SELECT new_fact_id::text AS n FROM decide_proposals WHERE source_id = 'default'")).toEqual([{ n: '203' }]);
    expect(await raw("SELECT count(*)::int AS n FROM decide_proposals WHERE source_id = 'other'")).toEqual([{ n: 1 }]);
  });

  test('setPurgeProbeTimeout bounds the statements of its transaction only', async () => {
    const timeout = (tx: BrainEngine) => tx.executeRaw<{ t: string }>("SELECT current_setting('statement_timeout') AS t").then((rows) => rows[0]!.t);
    const before = await timeout(engine);
    const inside = await engine.transaction(async (tx) => {
      await tx.setPurgeProbeTimeout(250);
      return timeout(tx);
    });
    expect(inside).toBe('250ms');
    expect(await timeout(engine)).toBe(before);
  });

  test('probePurgeDerivations counts the derivation rows after the cursor that hold a claim', async () => {
    const owner = await page('purges/derivations');
    const row = (pipeline: string, occurrence: number, output: unknown) => raw(
      `INSERT INTO page_segment_derivations (page_id, pipeline, occurrence_id, pipeline_version, segment_sha256, context_hash, state, output)
       VALUES ($1, $2, $3, 1, decode(repeat('ab', 32), 'hex'), decode(repeat('cd', 32), 'hex'), 'done', $4::text::jsonb)`,
      [owner.id, pipeline, occurrence, JSON.stringify(output)]);
    await row('links', 1, { excerpt: 'Everyone knows Acme raised a Series A last week' });
    await row('mentions', 2, { excerpt: 'Something unrelated entirely' });
    await row('timeline', 3, { note: 'acme RAISED a series a.' });
    const { needles, patterns } = await derivationNeedles(engine, ['Acme raised a Series A']);

    const all = await engine.probePurgeDerivations('default', needles, [], patterns, null, 100);
    expect(all).toEqual({ scanned: 3, normalized: 2, swept: 2, kept: 0, last_page: owner.id, last_pipeline: 'timeline', last_occurrence: '3' });
    const after = await engine.probePurgeDerivations('default', needles, [], patterns, [owner.id, 'links', '1'], 100);
    expect(after).toMatchObject({ scanned: 2, normalized: 1, swept: 1, kept: 0, last_pipeline: 'timeline' });
    const first = await engine.probePurgeDerivations('default', needles, [], patterns, null, 1);
    expect(first).toEqual({ scanned: 1, normalized: 1, swept: 1, kept: 0, last_page: owner.id, last_pipeline: 'links', last_occurrence: '1' });
    expect(await engine.probePurgeDerivations('other', needles, [], patterns, null, 100)).toMatchObject({ scanned: 0, normalized: 0, swept: 0, kept: 0, last_page: null });
  });
});

describe('embedding install', () => {
  let dimensions = 0;
  beforeAll(async () => {
    const [stored] = await raw<{ dims: number }>(
      "SELECT atttypmod AS dims FROM pg_attribute WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding'");
    dimensions = Number(stored!.dims);
  });
  const column = () => ({ name: 'embedding', type: 'vector' as const, dimensions, embeddingModel: 'test:model' });
  const vector = (hot: number) => `[${Array.from({ length: dimensions }, (_, i) => (i === hot ? 1 : 0)).join(',')}]`;

  test('installChunkEmbeddings writes the vectors of the batch onto the chunks that still hold its text, and readEmbeddingCompletion reports each chunk', async () => {
    const owner = await page('embeddings/install');
    await engine.upsertChunks('embeddings/install', [
      { chunk_index: 0, chunk_text: 'first chunk text', chunk_source: 'compiled_truth' },
      { chunk_index: 1, chunk_text: 'second chunk text', chunk_source: 'compiled_truth' },
      { chunk_index: 2, chunk_text: 'third chunk text', chunk_source: 'compiled_truth' },
    ]);
    const chunks = await raw<{ id: number; chunk_text: string }>('SELECT id, chunk_text FROM content_chunks WHERE page_id = $1 ORDER BY chunk_index', [owner.id]);
    const opts = { signature: 'sig-1', model: 'test:model', column: column(), manifest: false };

    const before = await engine.readEmbeddingCompletion(owner.id, opts);
    expect(before.map((c) => [c.chunk_text, c.embedded, c.stamped]).sort()).toEqual([
      ['first chunk text', false, null], ['second chunk text', false, null], ['third chunk text', false, null],
    ]);

    const batch = JSON.stringify([
      { id: chunks[0]!.id, chunk_text: 'first chunk text', embedding: vector(0), image: null, model: 'test:model', input_hash: 'hash-first' },
      { id: chunks[1]!.id, chunk_text: 'stale text', embedding: vector(1), image: null, model: 'test:model', input_hash: 'hash-stale' },
      { id: chunks[2]!.id, chunk_text: 'third chunk text', embedding: vector(2), image: null, model: 'other:model', input_hash: 'hash-third' },
    ]);
    await engine.installChunkEmbeddings(owner.id, column(), batch);

    const stored = await raw<{ chunk_index: number; has_vector: boolean; embedding_input_hash: string | null; model: string | null; first: number | null }>(
      `SELECT chunk_index, embedding IS NOT NULL AS has_vector, embedding_input_hash, model, (embedding::real[])[1] AS first
         FROM content_chunks WHERE page_id = $1 ORDER BY chunk_index`, [owner.id]);
    expect(stored.map((c) => [c.has_vector, c.embedding_input_hash])).toEqual([[true, 'hash-first'], [false, null], [true, 'hash-third']]);
    expect([stored[0]!.model, stored[2]!.model]).toEqual(['test:model', 'other:model']);
    expect(stored[0]!.first).toBe(1);

    await raw("UPDATE pages SET embedding_signature = 'sig-1' WHERE id = $1", [owner.id]);
    const after = await engine.readEmbeddingCompletion(owner.id, opts);
    expect(after.map((c) => [c.chunk_text, c.embedded, c.stamped, c.embedding_input_hash]).sort()).toEqual([
      ['first chunk text', true, true, 'hash-first'], ['second chunk text', false, true, null], ['third chunk text', false, true, 'hash-third'],
    ]);
    expect((await engine.readEmbeddingCompletion(owner.id, { ...opts, signature: 'sig-2' })).every((c) => c.stamped === false)).toBe(true);
    expect(await engine.readEmbeddingCompletion(owner.id + 100_000, opts)).toEqual([]);
  });

  test('lockEffectClaimRow answers the state and token of an effect and holds its row, and null for an unknown effect', async () => {
    const { id } = await admit('claim-row');
    await engine.insertPublicationEffects({ requestId: id, revision: null, sourceId: 'default', sourceIncarnation: incarnation, worktreeId: null, effects: [{ kind: 'git', data: {} }] });
    const token = randomUUID();
    const [{ effectId }] = await raw<{ effectId: string }>(
      "UPDATE persistence_effects SET state = 'running', execution_token = $2::uuid WHERE request_id = $1::uuid RETURNING id::text AS \"effectId\"", [id, token]);
    await engine.transaction(async (tx) => {
      const holder = async () => (await tx.executeRaw<{ x: string }>('SELECT xmax::text AS x FROM persistence_effects WHERE id = $1', [effectId]))[0]!.x;
      const before = await holder();
      expect(await tx.lockEffectClaimRow(effectId)).toEqual({ state: 'running', execution_token: token });
      expect(await holder()).not.toBe(before);
      expect(await tx.lockEffectClaimRow(999_999_999)).toBeNull();
    });
  });

  test('lockEmbeddingSwitch share-locks the embedding_disabled config row for the rest of the transaction', async () => {
    await raw("INSERT INTO config (key, value) VALUES ('embedding_disabled', 'false') ON CONFLICT (key) DO NOTHING");
    try {
      await engine.transaction(async (tx) => {
        const held = async () => (await tx.executeRaw<{ locked: boolean }>("SELECT xmax::text <> '0' AS locked FROM config WHERE key = 'embedding_disabled'"))[0]!.locked;
        expect(await held()).toBe(false);
        await tx.lockEmbeddingSwitch();
        expect(await held()).toBe(true);
      });
    } finally {
      await raw("DELETE FROM config WHERE key = 'embedding_disabled'");
    }
  });
});

describe('identity and page reads', () => {
  test('listSlugAliases answers the aliases of one source with their canonical slugs', async () => {
    await raw(`INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES
      ('default', 'people/bob-old', 'people/bob'), ('default', 'people/robert', 'people/bob'), ('other', 'people/rob', 'people/bob-other')`);
    const rows = await engine.listSlugAliases('default');
    expect(rows.map((r) => [r.alias_slug, r.canonical_slug]).sort()).toEqual([['people/bob-old', 'people/bob'], ['people/robert', 'people/bob']]);
    expect(await engine.listSlugAliases('other')).toEqual([{ alias_slug: 'people/rob', canonical_slug: 'people/bob-other' }]);
    expect(await engine.listSlugAliases('no-such-source')).toEqual([]);
  });

  test('readFolderAccess answers the folder rules the readers meet and every prefix that reads as nobody', async () => {
    await raw("INSERT INTO access_policy_state (source_id) VALUES ('default'), ('other') ON CONFLICT DO NOTHING");
    await raw(`INSERT INTO access_rules (source_id, rule_id, prefix, readable_by, revision) VALUES
      ('default', 'team-a', 'team-a/', '{member:alice,group:eng}', 1), ('default', 'team-b', 'team-b/', '{member:bob}', 1)`);
    await raw("INSERT INTO access_pending_coverage (source_id, prefix, reason) VALUES ('default', 'team-a/', 'pending'), ('other', 'x/', 'invalid')");
    try {
      const rows = await engine.readFolderAccess(['member:alice']);
      expect(rows.rules).toEqual([{ source_id: 'default', rule_id: 'team-a', readable_by: ['member:alice', 'group:eng'] }]);
      expect(rows.coverage).toEqual([{ source_id: 'default', prefix: 'team-a/' }, { source_id: 'other', prefix: 'x/' }]);
      expect((await engine.readFolderAccess(['member:bob', 'group:eng'])).rules.map((r) => r.rule_id).sort()).toEqual(['team-a', 'team-b']);
      const none = await engine.readFolderAccess([]);
      expect(none.rules).toEqual([]);
      expect(none.coverage).toHaveLength(2);
    } finally {
      await raw("DELETE FROM access_pending_coverage WHERE prefix IN ('team-a/', 'x/')");
      await raw("DELETE FROM access_rules WHERE rule_id IN ('team-a', 'team-b')");
    }
  });

  test('readLiveMember answers a live member with its groups through each binding and null for a disabled, unbound or unknown one', async () => {
    await raw(`INSERT INTO access_members (id) VALUES ('live-member')`);
    await raw(`INSERT INTO access_members (id, disabled_at) VALUES ('off-member', now())`);
    await raw(`INSERT INTO access_groups (id) VALUES ('live-g2'), ('live-g1')`);
    await raw(`INSERT INTO access_group_members (group_id, member_id) VALUES ('live-g2', 'live-member'), ('live-g1', 'live-member')`);
    const [{ id: tokenId }] = await raw<{ id: string }>(
      `INSERT INTO access_tokens (name, token_hash, member_id) VALUES ('live-token', 'hash-live-token', 'live-member') RETURNING id::text AS id`);
    const [{ id: unboundId }] = await raw<{ id: string }>(`INSERT INTO access_tokens (name, token_hash) VALUES ('unbound-token', 'hash-unbound-token') RETURNING id::text AS id`);
    await raw(`INSERT INTO oauth_clients (client_id, client_name, member_id) VALUES ('live-oauth', 'Live', 'live-member'), ('off-oauth', 'Off', 'off-member')`);
    await raw(`INSERT INTO config (key, value) VALUES ('mcp.live_stdio_member', '  live-member ') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    const live = { id: 'live-member', groups: ['live-g1', 'live-g2'] };

    expect(await engine.readLiveMember('member', 'live-member')).toEqual(live);
    expect(await engine.readLiveMember('legacy_token', tokenId)).toEqual(live);
    expect(await engine.readLiveMember('oauth_client', 'live-oauth')).toEqual(live);
    expect(await engine.readLiveMember('stdio_config', 'mcp.live_stdio_member')).toEqual(live);
    expect(await engine.readLiveMember('member', 'off-member')).toBeNull();
    expect(await engine.readLiveMember('oauth_client', 'off-oauth')).toBeNull();
    expect(await engine.readLiveMember('legacy_token', unboundId)).toBeNull();
    expect(await engine.readLiveMember('member', 'no-such-member')).toBeNull();
    await raw('UPDATE access_tokens SET revoked_at = now() WHERE id = $1::uuid', [tokenId]);
    expect(await engine.readLiveMember('legacy_token', tokenId)).toBeNull();
  });

  test('readPageTrustRows reads the trust fields of pages by id and by source and slug, and leaves out a deleted page unless asked', async () => {
    await raw(`INSERT INTO sources (id, name, config) VALUES ('trust-guest', 'trust guest', '{"guest": true}') ON CONFLICT DO NOTHING`);
    const plain = await page('trust/plain');
    const guest = await engine.putPage('trust/guest', { type: 'note', title: 'guest', compiled_truth: 'Guest page.' }, { sourceId: 'trust-guest' });
    const gone = await page('trust/gone');
    await raw("UPDATE pages SET deleted_at = now() WHERE id = $1", [gone.id]);
    await raw("UPDATE pages SET trust_tier = 'external_untrusted' WHERE id = $1", [plain.id]);

    const byId = await engine.readPageTrustRows({ ids: [plain.id, guest.id, gone.id] });
    expect(byId.map((r) => [r.slug, r.source_id, r.trust_tier, r.guest, r.flagged, r.byId]).sort()).toEqual([
      ['trust/gone', 'default', 'unknown', false, false, true], ['trust/guest', 'trust-guest', 'unknown', true, false, true],
      ['trust/plain', 'default', 'external_untrusted', false, false, true],
    ].sort());
    const keys = [{ source_id: 'default', slug: 'trust/plain' }, { source_id: 'trust-guest', slug: 'trust/guest' }, { source_id: 'default', slug: 'trust/gone' }];
    const byKey = await engine.readPageTrustRows({ keys });
    expect(byKey.map((r) => [r.slug, r.byId]).sort()).toEqual([['trust/guest', false], ['trust/plain', false]]);
    expect((await engine.readPageTrustRows({ keys, includeDeleted: true })).map((r) => r.slug).sort()).toEqual(['trust/gone', 'trust/guest', 'trust/plain']);
    const both = await engine.readPageTrustRows({ ids: [plain.id], keys: [{ source_id: 'default', slug: 'trust/plain' }] });
    expect(both.map((r) => r.byId)).toEqual([true, false]);
    expect(await engine.readPageTrustRows({})).toEqual([]);
  });

  test('readReflexLiveKeys and readReflexPages answer the live pages of the scope that the slugs, titles or names pick out', async () => {
    await engine.putPage('reflex/ada-lovelace', { type: 'person', title: 'Ada Lovelace', compiled_truth: 'Ada wrote the first program.' });
    await engine.putPage('reflex/charles', { type: 'person', title: 'Charles Babbage', compiled_truth: 'Charles built engines.' });
    await engine.putPage('reflex/other-source', { type: 'note', title: 'Ada Lovelace', compiled_truth: 'Elsewhere.' }, { sourceId: 'other' });
    await page('reflex/removed');
    await raw("UPDATE pages SET deleted_at = now() WHERE slug = 'reflex/removed'");
    const scope = { sourceIds: ['default'], privacy: 'none' as const };

    expect((await engine.readReflexLiveKeys(scope, ['reflex/ada-lovelace', 'reflex/removed', 'reflex/missing'])).map((k) => [k.slug, k.source_id])).toEqual([['reflex/ada-lovelace', 'default']]);
    expect(await engine.readReflexLiveKeys({ sourceIds: [], privacy: 'none' }, ['reflex/ada-lovelace'])).toEqual([]);
    expect((await engine.readReflexLiveKeys({ sourceIds: ['default', 'other'], privacy: 'none' }, ['reflex/other-source'])).map((k) => k.source_id)).toEqual(['other']);

    const names = await engine.readReflexPages(scope, { kind: 'names', titlesLc: ['ada lovelace'], exactSlugs: ['reflex/charles'], slugSuffixes: ['%/nothing'] });
    expect(names.map((p) => [p.slug, p.source_id, p.title, p.type, p.compiled_truth])).toEqual([
      ['reflex/ada-lovelace', 'default', 'Ada Lovelace', 'person', 'Ada wrote the first program.'], ['reflex/charles', 'default', 'Charles Babbage', 'person', 'Charles built engines.'],
    ]);
    const surname = await engine.readReflexPages(scope, { kind: 'names', titlesLc: [], exactSlugs: [], slugSuffixes: [], surnamePatterns: ['% babbage'] });
    expect(surname.map((p) => p.slug)).toEqual(['reflex/charles']);
    expect((await engine.readReflexPages(scope, { kind: 'slugs', slugs: ['reflex/charles', 'reflex/removed'] })).map((p) => p.slug)).toEqual(['reflex/charles']);
    expect((await engine.readReflexPages(scope, { kind: 'titles', titlesLc: ['charles babbage'] })).map((p) => p.slug)).toEqual(['reflex/charles']);
    expect((await engine.readReflexPages(scope, { kind: 'cjkExact', norms: ['ada lovelace', 'reflex/charles'] })).map((p) => p.slug).sort()).toEqual(['reflex/ada-lovelace', 'reflex/charles']);
    expect((await engine.readReflexPages({ sourceIds: ['other'], privacy: 'none' }, { kind: 'titles', titlesLc: ['ada lovelace'] })).map((p) => p.source_id)).toEqual(['other']);
  });

  test('readWriteVisibilityProbe reports whether a hidden page names readers, whether any member is labelled-only, and whether the source is owner-only', async () => {
    await page('probe-vis/open');
    await engine.putPage('probe-vis/closed', { type: 'note', title: 'closed', compiled_truth: 'Closed.', frontmatter: { readable_by: ['member:someone'] } });
    await raw(`INSERT INTO sources (id, name, config) VALUES ('probe-owner-only', 'probe owner only', '{"owner_only": true}') ON CONFLICT DO NOTHING`);

    // An owner-only source exists in this brain, so the empty-identity policy hides every page: the open page names no readers (false), the closed one does (true).
    expect(await engine.readWriteVisibilityProbe('default', 'probe-vis/open')).toEqual({ any_labelled: false, identity_may_open: false, owner_only_source: false, owner_only_any: true });
    expect(await engine.readWriteVisibilityProbe('default', 'probe-vis/closed')).toMatchObject({ identity_may_open: true, owner_only_source: false });
    expect((await engine.readWriteVisibilityProbe('default', 'probe-vis/missing'))!.identity_may_open).toBeNull();
    expect(await engine.readWriteVisibilityProbe('probe-owner-only', 'probe-vis/open')).toMatchObject({ owner_only_source: true, owner_only_any: true });

    await raw("INSERT INTO access_members (id, labelled_only) VALUES ('labelled-member', true)");
    expect((await engine.readWriteVisibilityProbe('default', 'probe-vis/open'))!.any_labelled).toBe(true);
  });
});

describe('writer administration', () => {
  test('readWriterAdminState reads the topology as one document and takes the table locks on request inside a transaction', async () => {
    const state = JSON.parse(await engine.readWriterAdminState());
    const [{ brain_id }] = await raw<{ brain_id: string }>('SELECT brain_id::text AS brain_id FROM persistence_brain WHERE singleton = 1');
    expect(state.brain).toMatchObject({ id: brain_id, enabled: false, writer_protocol_floor: 1 });
    expect(state.sources.map((row: unknown[]) => row[0])).toContain('default');
    expect(state.sources.map((row: unknown[]) => row[0])).toEqual([...state.sources.map((row: unknown[]) => row[0])].sort((a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)));

    const worktreeId = randomUUID();
    await raw('INSERT INTO persistence_worktrees (id) VALUES ($1::uuid)', [worktreeId]);
    await raw("INSERT INTO config (key, value) VALUES ('sync.repo_path', '/tmp/fallback-repo') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
    const changed = JSON.parse(await engine.readWriterAdminState());
    expect(changed.fallback).toBe('/tmp/fallback-repo');
    expect(changed.worktrees.map((row: unknown[]) => row[0])).toContain(worktreeId);

    const locked = await engine.transaction(async (tx) => {
      const text = await tx.readWriterAdminState({ lock: true });
      const [row] = await tx.executeRaw<{ locked: boolean }>("SELECT xmax::text <> '0' AS locked FROM persistence_brain WHERE singleton = 1");
      return { text, brainLocked: row!.locked };
    });
    expect(JSON.parse(locked.text)).toEqual(changed);
    expect(locked.brainLocked).toBe(true);
    await raw("DELETE FROM config WHERE key = 'sync.repo_path'");
  });

  test('writerAdminStore reads and records the operator lock and a worktree transfer inside the transaction it is taken in', async () => {
    const host = randomUUID();
    const successor = randomUUID();
    const worktreeId = randomUUID();
    await raw('INSERT INTO persistence_worktrees (id, owner_host_id) VALUES ($1::uuid, $2::uuid)', [worktreeId, host]);
    const [{ brain_id }] = await raw<{ brain_id: string }>('SELECT brain_id::text AS brain_id FROM persistence_brain WHERE singleton = 1');

    await engine.transaction(async (tx) => {
      const store = await tx.writerAdminStore();
      await store.lockBrain();
      expect(await store.brainId()).toBe(brain_id);
      expect(await store.now()).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      await store.assertAdminUnlocked();
      await store.assertAdminState(undefined);

      expect(await store.adminLockValue()).toBeNull();
      await store.setAdminLockValue('locked-by-test');
      expect(await store.adminLockValue()).toBe('locked-by-test');

      expect(await store.lockWorktree(worktreeId)).toEqual({ owner_host_id: host, owner_epoch: '0', state: 'active', manifest: null });
      expect(await store.lockWorktree(randomUUID())).toBeNull();
      expect(await store.publicationPending(worktreeId)).toBe(false);
      expect(await store.preparedTransferWorktree()).toBeNull();
      await store.markWorktreeDraining(worktreeId, { to: successor });
      expect(await store.preparedTransferWorktree()).toBe(worktreeId);
      expect(await store.lockWorktree(worktreeId)).toMatchObject({ state: 'draining', manifest: { to: successor, prepared_at: expect.any(String) } });
      await store.reactivateWorktree(worktreeId);
      expect(await store.preparedTransferWorktree()).toBeNull();

      await store.upsertHostBinding({ worktreeId, hostId: successor, localPath: '/srv/new', coordinationPath: '/srv/new/.coord' });
      await store.upsertHostBinding({ worktreeId, hostId: successor, localPath: '/srv/newer', coordinationPath: '/srv/newer/.coord' });
      await store.acceptWorktreeOwner(worktreeId, successor);
      expect(await store.lockWorktree(worktreeId)).toMatchObject({ owner_host_id: successor, owner_epoch: '1', state: 'active' });
      expect(await tx.executeRaw('SELECT local_path FROM persistence_host_bindings WHERE worktree_id = $1::uuid', [worktreeId])).toEqual([{ local_path: '/srv/newer' }]);
    });
    expect(await raw('SELECT value FROM config WHERE key = $1', [WRITER_ADMIN_LOCK_KEY])).toEqual([{ value: 'locked-by-test' }]);
    await raw('DELETE FROM config WHERE key = $1', [WRITER_ADMIN_LOCK_KEY]);
  });

  test('writerAdminStore refuses while the operator lock is set, and a rolled-back transaction leaves no lock behind', async () => {
    await engine.transaction(async (tx) => {
      const store = await tx.writerAdminStore();
      await store.setAdminLockValue('locked-for-refusal');
      await expect(store.assertAdminUnlocked()).rejects.toThrow();
    });
    await raw('DELETE FROM config WHERE key = $1', [WRITER_ADMIN_LOCK_KEY]);
    await expect(engine.transaction(async (tx) => {
      await (await tx.writerAdminStore()).setAdminLockValue('rolled-back');
      throw new Error('abandon');
    })).rejects.toThrow('abandon');
    expect(await raw('SELECT value FROM config WHERE key = $1', [WRITER_ADMIN_LOCK_KEY])).toEqual([]);
  });

  test('worktreeClaimStore records a worktree, its host binding and its source binding, and reads them back inside the claim transaction', async () => {
    const host = randomUUID();
    const worktreeId = randomUUID();
    await raw("INSERT INTO sources (id, name) VALUES ('claim-source', 'claim source') ON CONFLICT DO NOTHING");
    const sourceInc = (await engine.readSourceMembership('claim-source'))!.incarnation;
    const [{ brain_id }] = await raw<{ brain_id: string }>('SELECT brain_id::text AS brain_id FROM persistence_brain WHERE singleton = 1');

    await engine.transaction(async (tx) => {
      const store = await tx.worktreeClaimStore();
      const brainLocked = (await tx.executeRaw<{ locked: boolean }>("SELECT xmax::text <> '0' AS locked FROM persistence_brain WHERE singleton = 1"))[0]!.locked;
      expect(brainLocked).toBe(true);
      await store.assertAdminUnlocked();
      await store.assertAdminState(undefined);
      expect(await store.brainId()).toBe(brain_id);
      expect(await store.lockSource('claim-source')).toEqual({ incarnation: sourceInc, archived: false });
      expect(await store.lockSource('no-such-source')).toBeNull();

      expect(await store.worktree(worktreeId)).toBeNull();
      await store.insertWorktree({ id: worktreeId, ownerHostId: host });
      expect(await store.worktree(worktreeId)).toEqual({ owner_host_id: host, state: 'active' });
      expect(await store.hostBinding(worktreeId, host)).toBeNull();
      await store.insertHostBinding({ worktreeId, hostId: host, localPath: '/srv/claim', coordinationPath: '/srv/claim/.coord', gitDurability: 'enabled' });
      expect(await store.hostBinding(worktreeId, host)).toEqual({ local_path: '/srv/claim', coordination_path: '/srv/claim/.coord' });
      expect(await store.hostWorktrees(host)).toEqual([expect.objectContaining({ worktree_id: worktreeId, local_path: '/srv/claim', owner_host_id: host })]);
      expect(await store.hostWorktrees(randomUUID())).toEqual([]);

      expect(await store.binding('claim-source', host)).toBeNull();
      await store.insertSourceBinding({ sourceId: 'claim-source', incarnation: sourceInc, worktreeId, relativePath: 'notes' });
      expect(await store.binding('claim-source', host)).toMatchObject({ worktree_id: worktreeId, relative_path: 'notes' });
    });
    expect(await raw('SELECT git_durability FROM persistence_host_bindings WHERE worktree_id = $1::uuid', [worktreeId])).toEqual([{ git_durability: 'enabled' }]);
    expect(await raw('SELECT topology_generation::int AS g FROM persistence_source_bindings WHERE worktree_id = $1::uuid', [worktreeId])).toEqual([{ g: 1 }]);
  });
});
