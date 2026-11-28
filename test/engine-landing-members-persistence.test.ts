/**
 * The persistence journal, projection rebuild, chunk-vector and worktree BrainEngine members that land ahead of their
 * callers (engine-sql/persistence-*.ts, projection-rebuild.ts, writer-release.ts, writer-admin.ts, publication-journal.ts,
 * cli-reads-import.ts, notifier.ts, trust-scan.ts, contradictions-cycle.ts, facts-purge.ts and config.ts), run on PGLite.
 * Each test calls the members of one area and checks a real result: a returned value, a row written and read back
 * through another member or a plain SELECT, a count that changes, or a claim that is held and released.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { RecoveryRecord } from '../src/core/persistence/model.ts';

let engine: PGLiteEngine;
let incarnation: string;
let dims: number;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('other', 'other') ON CONFLICT DO NOTHING");
  incarnation = (await engine.readSourceMembership('default'))!.incarnation;
  const [typmod] = await engine.executeRaw<{ dims: number }>(
    "SELECT atttypmod::int AS dims FROM pg_attribute WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding'");
  dims = typmod!.dims;
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

const page = (slug: string, text = `Body of ${slug}.`) =>
  engine.putPage(slug, { type: 'note', title: slug, compiled_truth: text });

const raw = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => engine.executeRaw<T>(sql, params);

/** Admits one queued write request under its own counter keys; returns its journal id, request id and counter keys. */
async function admit(tag: string, opts: { operation?: string; slug?: string; intent?: unknown; worktreeId?: string | null; requestId?: string } = {}):
  Promise<{ id: string; requestId: string; keys: string[] }> {
  const keys = [`principal:local_cli:${tag}`, `brain:${tag}`];
  const requestId = opts.requestId ?? randomUUID();
  await engine.lockPersistenceCounters(keys);
  const { id } = await engine.insertWriteRequest({
    principalKind: 'local_cli', principalId: tag, requestId, operation: opts.operation ?? 'remember', sourceId: 'default',
    sourceIncarnation: incarnation, pageId: null, slug: opts.slug ?? `notes/${tag}`, worktreeId: opts.worktreeId ?? null,
    topologyGeneration: null, digest: 'd'.repeat(64), intent: opts.intent ?? { kind: 'remember', text: 'hello' }, authority: { scopes: ['write'] },
    intentBytes: 100, terminalReservation: 8192, targetKind: 'page', protocolVersion: 1, admitterVersion: 'landing',
    admitterHostId: null, counterKeys: keys, clientRequestId: null, state: 'queued', deferredRefreshId: null,
  });
  return { id, requestId, keys };
}

/** A vector of the embedding column's width, as a pgvector literal. */
const vector = (fill: number) => `[${Array.from({ length: dims }, () => fill).join(',')}]`;

const column = () => ({ name: 'embedding', dimensions: dims });

/** A page with `texts` as its chunks, each embedded from its own text under `model`; returns the page id and its chunk ids in order. */
async function embeddedPage(slug: string, texts: string[], model: string): Promise<{ pageId: number; chunkIds: number[] }> {
  const { id: pageId } = await page(slug, texts.join(' '));
  await engine.upsertChunks(slug, texts.map((chunk_text, chunk_index) => ({ chunk_index, chunk_text, chunk_source: 'compiled_truth' as const })), { sourceId: 'default' });
  await raw(`UPDATE content_chunks SET embedding = $2::vector, model = $3, embedded_text_hash = md5(chunk_text), embedded_at = now(), embedding_pending_since = NULL WHERE page_id = $1`,
    [pageId, vector(0.5), model]);
  const rows = await raw<{ id: number }>('SELECT id FROM content_chunks WHERE page_id = $1 ORDER BY chunk_index', [pageId]);
  return { pageId, chunkIds: rows.map((r) => Number(r.id)) };
}

const chunkState = async (pageId: number) => raw<{ id: number; has_vector: boolean; hash: string | null; pending: boolean }>(
  `SELECT id, embedding IS NOT NULL AS has_vector, embedded_text_hash AS hash, embedding_pending_since IS NOT NULL AS pending
     FROM content_chunks WHERE page_id = $1 ORDER BY chunk_index`, [pageId]);

describe('persistence counters and journal reads', () => {
  test('addPersistenceCounters adds each column to one counter row, a negative amount subtracts, and a charge below zero is refused', async () => {
    const keys = ['principal:local_cli:add-counters', 'brain:add-counters'];
    await engine.lockPersistenceCounters(keys);
    const read = async (key: string) => {
      const [row] = await engine.readCounterRows([key]);
      return [row!.lifetime_ids, row!.terminal_bytes, row!.outstanding_count, row!.intent_bytes, row!.recovery_bytes].map(Number);
    };
    expect(await read(keys[0]!)).toEqual([0, 0, 0, 0, 0]);

    await engine.addPersistenceCounters(keys[0]!, { lifetime_ids: 3, terminal_bytes: 100, outstanding_count: 2, intent_bytes: 50, recovery_bytes: 7 });
    expect(await read(keys[0]!)).toEqual([3, 100, 2, 50, 7]);
    expect(await read(keys[1]!)).toEqual([0, 0, 0, 0, 0]);

    await engine.addPersistenceCounters(keys[0]!, { terminal_bytes: -40, outstanding_count: -1 });
    expect(await read(keys[0]!)).toEqual([3, 60, 1, 50, 7]);
    await engine.addPersistenceCounters(keys[0]!, {});
    expect(await read(keys[0]!)).toEqual([3, 60, 1, 50, 7]);

    await expect(engine.addPersistenceCounters(keys[0]!, { recovery_bytes: -8 })).rejects.toThrow();
    expect(await read(keys[0]!)).toEqual([3, 60, 1, 50, 7]);
    await engine.addPersistenceCounters('no-such-counter', { lifetime_ids: 5 });
    expect(await engine.readCounterRows(['no-such-counter'])).toEqual([]);
  });

  test('readWriteRequestsByRequestIds returns the requests of one principal under the given request ids and no others', async () => {
    const first = await admit('by-ids');
    const second = await admit('by-ids', { slug: 'notes/by-ids-second' });
    const third = await admit('by-ids', { slug: 'notes/by-ids-third' });
    const stranger = await admit('by-ids-stranger');

    const rows = await engine.readWriteRequestsByRequestIds('local_cli', 'by-ids', [first.requestId, third.requestId, stranger.requestId, randomUUID()]);
    expect(rows.map((r) => r.id).sort()).toEqual([first.id, third.id].sort());
    expect(rows.find((r) => r.id === third.id)).toMatchObject({
      principal_kind: 'local_cli', principal_id: 'by-ids', request_id: third.requestId, slug: 'notes/by-ids-third', state: 'queued', operation: 'remember',
    });
    expect(rows.some((r) => r.id === second.id)).toBe(false);
    expect((await engine.readWriteRequestsByRequestIds('local_cli', 'by-ids-stranger', [stranger.requestId])).map((r) => r.id)).toEqual([stranger.id]);
    expect(await engine.readWriteRequestsByRequestIds('oauth_client', 'by-ids', [first.requestId])).toEqual([]);
    expect(await engine.readWriteRequestsByRequestIds('local_cli', 'by-ids', [])).toEqual([]);
  });

  test('readDeletePageRequest reads the newest delete_page request of a source by request id, and no other operation', async () => {
    const del = await admit('delete-req', { operation: 'delete_page', slug: 'notes/gone', intent: { kind: 'delete_page' } });
    const other = await admit('delete-req-other');
    expect(await engine.readDeletePageRequest('default', randomUUID())).toBeNull();
    expect(await engine.readDeletePageRequest('default', other.requestId)).toBeNull();
    expect(await engine.readDeletePageRequest('other', del.requestId)).toBeNull();
    expect(await engine.readDeletePageRequest('default', del.requestId)).toEqual({
      id: del.id, request_id: del.requestId, state: 'queued', source_id: 'default', outcome: null,
    });

    await raw(`UPDATE persistence_requests SET state = 'committed', outcome = '{"deleted":true}'::jsonb WHERE id = $1::uuid`, [del.id]);
    expect(await engine.readDeletePageRequest('default', del.requestId)).toMatchObject({ id: del.id, state: 'committed', outcome: { deleted: true } });
  });

  test('listRequestsRecordingReasons lists the requests of one page that recorded a reason in their intent or outcome', async () => {
    const slug = 'notes/reasons';
    const inIntent = await admit('reasons-a', { slug, intent: { kind: 'remember', reason: 'because of a typo' } });
    const inOutcome = await admit('reasons-b', { slug });
    await raw(`UPDATE persistence_requests SET outcome = '{"reason_recorded":true}'::jsonb WHERE id = $1::uuid`, [inOutcome.id]);
    await admit('reasons-c', { slug });
    await admit('reasons-d', { slug: 'notes/reasons-elsewhere', intent: { kind: 'remember', reason: 'other page' } });

    const targets = await engine.listRequestsRecordingReasons('default', slug);
    expect(targets.sort((a, b) => a.principal_id.localeCompare(b.principal_id))).toEqual([
      { id: inIntent.id, principal_kind: 'local_cli', principal_id: 'reasons-a' },
      { id: inOutcome.id, principal_kind: 'local_cli', principal_id: 'reasons-b' },
    ]);
    expect(await engine.listRequestsRecordingReasons('other', slug)).toEqual([]);
    expect(await engine.listRequestsRecordingReasons('default', 'notes/no-such-page')).toEqual([]);
  });

  test('findTopologyChanges answers the first request id a local writer already used for a topology change, and nothing for another writer', async () => {
    const principal = randomUUID();
    const used = randomUUID();
    await raw(
      `INSERT INTO persistence_topology_changes (principal_id, request_id, digest, operation, source_id, state)
       VALUES ($1::uuid, $2::uuid, $3, 'remove_source', 'default', 'committed')`, [principal, used, 'e'.repeat(64)]);
    expect(await engine.findTopologyChanges(principal, [randomUUID(), used, randomUUID()])).toEqual([{ request_id: used }]);
    expect(await engine.findTopologyChanges(principal, [randomUUID()])).toEqual([]);
    expect(await engine.findTopologyChanges(randomUUID(), [used])).toEqual([]);
    expect(await engine.findTopologyChanges(principal, [])).toEqual([]);
  });

  test('releaseUnpublishedClaim returns a running claim to queued with its reason, charges an attempt on request, and leaves a claim held under another token', async () => {
    const { id } = await admit('release-claim');
    const token = randomUUID();
    await engine.stampWriteClaim(id, token, 60_000, JSON.stringify({ phase: 'claimed' }));
    const row = async () => (await raw<{ state: string; execution_token: string | null; claim_expires_at: Date | null; blocked_reason: string | null; preparation_attempts: number }>(
      'SELECT state, execution_token, claim_expires_at, blocked_reason, preparation_attempts FROM persistence_requests WHERE id = $1::uuid', [id]))[0]!;
    expect(await row()).toMatchObject({ state: 'running', execution_token: token, blocked_reason: null, preparation_attempts: 0 });

    await engine.releaseUnpublishedClaim({ id, token: randomUUID(), reason: 'wrong_token', charge: true });
    expect(await row()).toMatchObject({ state: 'running', execution_token: token, preparation_attempts: 0 });

    await engine.releaseUnpublishedClaim({ id, token, reason: 'preparing_failed', charge: true });
    expect(await row()).toEqual({ state: 'queued', execution_token: null, claim_expires_at: null, blocked_reason: 'preparing_failed', preparation_attempts: 1 });
    expect(await engine.renewWriteClaim({ id, token, leaseMs: 1_000, phaseJson: null })).toBe(false);

    const again = randomUUID();
    await engine.stampWriteClaim(id, again, 60_000, JSON.stringify({ phase: 'claimed' }));
    await engine.releaseUnpublishedClaim({ id, token: again, reason: 'lease_handed_back', charge: false });
    expect(await row()).toMatchObject({ state: 'queued', execution_token: null, blocked_reason: 'lease_handed_back', preparation_attempts: 1 });
  });
});

describe('worktree and host bindings', () => {
  test('readWorktreeManifest, readOwnerHostBinding and listManagedRootBindings read a worktree, its owner host path and its managed roots back', async () => {
    const host = randomUUID();
    const otherHost = randomUUID();
    const worktreeId = randomUUID();
    const bareWorktreeId = randomUUID();
    await raw(`INSERT INTO sources (id, name) VALUES ('bound-source', 'bound source') ON CONFLICT DO NOTHING`);
    await raw(`UPDATE sources SET local_path = '/srv/legacy-root' WHERE id = 'bound-source'`);
    const sourceInc = (await engine.readSourceMembership('bound-source'))!.incarnation;
    await raw('INSERT INTO persistence_worktrees (id, owner_host_id) VALUES ($1::uuid, $2::uuid), ($3::uuid, NULL)', [worktreeId, host, bareWorktreeId]);

    expect(await engine.readWorktreeManifest(worktreeId)).toBeNull();
    expect(await engine.readWorktreeManifest(randomUUID())).toBeNull();
    await raw(`UPDATE persistence_worktrees SET manifest = '{"digest":"abc","file_count":4,"scope":"git"}'::jsonb WHERE id = $1::uuid`, [worktreeId]);
    expect(await engine.readWorktreeManifest(worktreeId)).toEqual({ digest: 'abc', file_count: 4, scope: 'git' });

    expect(await engine.readOwnerHostBinding(worktreeId)).toBeNull();
    await raw(`INSERT INTO persistence_host_bindings (worktree_id, host_id, local_path, coordination_path) VALUES
      ($1::uuid, $2::uuid, '/srv/owner-root', '/srv/owner-root/.coord'), ($1::uuid, $3::uuid, '/srv/other-root', '/srv/other-root/.coord')`, [worktreeId, host, otherHost]);
    expect(await engine.readOwnerHostBinding(worktreeId)).toBe('/srv/owner-root');
    expect(await engine.readOwnerHostBinding(bareWorktreeId)).toBeNull();
    expect(await engine.readOwnerHostBinding(randomUUID())).toBeNull();

    expect((await engine.listManagedRootBindings(host)).filter((r) => r.source_id === 'bound-source')).toEqual([
      { local_path: '/srv/legacy-root', source_id: 'bound-source', source_incarnation: sourceInc, worktree_id: null, topology_generation: null },
    ]);
    await raw(`INSERT INTO persistence_source_bindings (source_id, source_incarnation, worktree_id, relative_path, topology_generation)
      VALUES ('bound-source', $1::uuid, $2::uuid, 'notes', 4)`, [sourceInc, worktreeId]);
    const bindings = await engine.listManagedRootBindings(host);
    expect(bindings).toContainEqual({ local_path: '/srv/owner-root', source_id: 'bound-source', source_incarnation: sourceInc, worktree_id: worktreeId, topology_generation: 4 });
    expect(bindings).toContainEqual({ local_path: '/srv/legacy-root', source_id: 'bound-source', source_incarnation: sourceInc, worktree_id: null, topology_generation: null });
    const others = await engine.listManagedRootBindings(otherHost);
    expect(others).toContainEqual({ local_path: '/srv/other-root', source_id: 'bound-source', source_incarnation: sourceInc, worktree_id: worktreeId, topology_generation: 4 });
    expect(others.some((r) => r.local_path === '/srv/owner-root')).toBe(false);
    expect((await engine.listManagedRootBindings(randomUUID(), { signal: new AbortController().signal })).every((r) => r.worktree_id === null)).toBe(true);
  });

  test('publicationJournalStore answers the owner path, the worktree owner and the recovery blocker, and records the publication start and a recovery inside the transaction', async () => {
    const host = randomUUID();
    const worktreeId = randomUUID();
    await raw('INSERT INTO persistence_worktrees (id, owner_host_id) VALUES ($1::uuid, $2::uuid)', [worktreeId, host]);
    await raw(`INSERT INTO persistence_host_bindings (worktree_id, host_id, local_path, coordination_path) VALUES ($1::uuid, $2::uuid, '/srv/journal-root', '/srv/journal-root/.coord')`, [worktreeId, host]);
    const first = await admit('journal-store-a', { worktreeId });
    const second = await admit('journal-store-b', { worktreeId });
    const token = randomUUID();
    await engine.stampWriteClaim(first.id, token, 60_000, JSON.stringify({ phase: 'claimed' }));

    const seen = await engine.transaction(async (tx) => {
      const store = await tx.publicationJournalStore();
      const out: Record<string, unknown> = {};
      out.ownerPath = await store.ownerPath(worktreeId);
      out.noOwnerPath = await store.ownerPath(randomUUID());
      out.owner = await store.shareWorktreeOwner(worktreeId);
      out.noOwner = await store.shareWorktreeOwner(randomUUID());
      out.heldBehind = await store.heldBehindImport('default', 'notes/journal-store-b', 1_000_000);
      out.blockerBefore = await store.recoveryBlocker(worktreeId, second.id);
      out.recorded = await store.recordRecovery({ id: first.id, executionToken: token, recovery: { step: 'git' } as unknown as RecoveryRecord, bytes: 64, keys: first.keys }, true);
      out.recordedAgain = await store.recordRecovery({ id: first.id, executionToken: token, recovery: { step: 'git' } as unknown as RecoveryRecord, bytes: 64, keys: first.keys }, true);
      out.blockerAfter = await store.recoveryBlocker(worktreeId, second.id);
      out.blockerExcludingOwn = await store.recoveryBlocker(worktreeId, first.id);
      out.staging = await store.recoveryStaging('persistence_requests', first.id);
      await store.growRecoveryStaging('persistence_requests', first.id, { step: 'git', more: true }, 16);
      out.grown = await store.recoveryStaging('persistence_requests', first.id);
      out.started = (await store.markPublicationStarted(second.id))?.publication_started;
      await store.markRecovering(first.id, token, 'writer_pool_capacity');
      await store.clearRecovery(first.id, first.keys, 64);
      return out;
    });
    expect(seen).toMatchObject({
      ownerPath: '/srv/journal-root', noOwnerPath: null, owner: { owner_host_id: host, owner_epoch: 0, state: 'active' }, noOwner: null,
      heldBehind: null, blockerBefore: false, recorded: true, recordedAgain: false, blockerAfter: true, blockerExcludingOwn: false,
      staging: { recovery: { step: 'git' }, recovery_bytes: 64, source_id: 'default' },
      grown: { recovery: { step: 'git', more: true }, recovery_bytes: 80, source_id: 'default' }, started: true,
    });

    const [after] = await raw<{ state: string; recovery: unknown; recovery_bytes: string; blocked_reason: string | null }>(
      'SELECT state, recovery, recovery_bytes::text, blocked_reason FROM persistence_requests WHERE id = $1::uuid', [first.id]);
    expect(after).toEqual({ state: 'recovering', recovery: null, recovery_bytes: '0', blocked_reason: null });
    expect(await raw('SELECT publication_started FROM persistence_requests WHERE id = $1::uuid', [second.id])).toEqual([{ publication_started: true }]);
    expect((await engine.readCounterRows(first.keys)).map((c) => Number(c.recovery_bytes))).toEqual([0, 0]);
  });
});

describe('source and config reads', () => {
  test('readSourceIncarnation reads a source\'s config and incarnation, and null for an unknown source', async () => {
    await raw(`INSERT INTO sources (id, name, config) VALUES ('incarnation-src', 'incarnation src', '{"kind":"note-vault","depth":2}'::jsonb) ON CONFLICT DO NOTHING`);
    const membership = await engine.readSourceMembership('incarnation-src');
    expect(await engine.readSourceIncarnation('incarnation-src')).toEqual({ config: { kind: 'note-vault', depth: 2 }, incarnation: membership!.incarnation });
    expect(await engine.readSourceIncarnation('default')).toMatchObject({ incarnation });
    expect(await engine.readSourceIncarnation('no-such-source')).toBeNull();
  });

  test('hasCompanyBrainReceipt turns true for the source holding a company-brain ingestion receipt of its current incarnation, and only that source', async () => {
    await raw(`INSERT INTO sources (id, name) VALUES ('receipt-src', 'receipt src'), ('receipt-other', 'receipt other') ON CONFLICT DO NOTHING`);
    const receiptInc = (await engine.readSourceMembership('receipt-src'))!.incarnation;
    expect(await engine.hasCompanyBrainReceipt('receipt-src')).toBe(false);

    await raw(`INSERT INTO source_ingestion_receipts (id, source_id, source_incarnation, approved_revision, profile, schema_fingerprint, extractor_version)
      VALUES ($1::uuid, 'receipt-other', $2::uuid, $3, 'plain-notes', $4, 'v1')`,
      [randomUUID(), (await engine.readSourceMembership('receipt-other'))!.incarnation, 'a'.repeat(40), 'b'.repeat(64)]);
    expect(await engine.hasCompanyBrainReceipt('receipt-other')).toBe(false);

    await raw(`INSERT INTO source_ingestion_receipts (id, source_id, source_incarnation, approved_revision, profile, schema_fingerprint, extractor_version)
      VALUES ($1::uuid, 'receipt-src', $2::uuid, $3, 'company-brain', $4, 'v1')`, [randomUUID(), receiptInc, 'a'.repeat(40), 'b'.repeat(64)]);
    expect(await engine.hasCompanyBrainReceipt('receipt-src')).toBe(true);
    expect(await engine.hasCompanyBrainReceipt('receipt-other')).toBe(false);
    expect(await engine.hasCompanyBrainReceipt('no-such-source')).toBe(false);
  });

  test('readStoredConfigValue reads a stored value, the updated value, and null for a missing key, inside a transaction as well', async () => {
    const key = 'landing.persistence.config-value';
    expect(await engine.readStoredConfigValue(key)).toBeNull();
    await raw('INSERT INTO config (key, value) VALUES ($1, $2)', [key, 'first']);
    expect(await engine.readStoredConfigValue(key)).toBe('first');
    await raw('UPDATE config SET value = $2 WHERE key = $1', [key, 'second']);
    expect(await engine.readStoredConfigValue(key)).toBe('second');
    const inTx = await engine.transaction(async (tx) => {
      await tx.executeRaw('UPDATE config SET value = $2 WHERE key = $1', [key, 'third']);
      return tx.readStoredConfigValue(key);
    });
    expect(inTx).toBe('third');
    expect(await engine.readStoredConfigValue(key)).toBe('third');
    await raw('DELETE FROM config WHERE key = $1', [key]);
    expect(await engine.readStoredConfigValue(key)).toBeNull();
  });

  test('readNotifierStatusRows reads each live source with its notifier state, lease and due markers, and the id filter narrows it', async () => {
    await raw(`INSERT INTO sources (id, name) VALUES ('notify-a', 'notify a'), ('notify-b', 'notify b'), ('notify-gone', 'notify gone') ON CONFLICT DO NOTHING`);
    await raw(`UPDATE sources SET archived = true WHERE id = 'notify-gone'`);
    await raw(`UPDATE sources SET last_commit = 'c0ffee' WHERE id = 'notify-a'`);
    await raw(`INSERT INTO sync_notifier_leases (host_id, owner_id, resident_kind, pid, expires_at) VALUES ('notify-host', 'owner-1', 'serve', 4242, now() + interval '1 hour')`);
    await raw(`INSERT INTO sync_notifier_sources (source_id, state, reason, attempts, observed_head, detection_mode, owner_host_id, owner_kind, owner_pid, last_error_code, last_error)
      VALUES ('notify-a', 'retry', 'head_moved', 3, 'c0ffee', 'poll', 'notify-host', 'serve', 4242, 'sync_failed', 'boom')`);
    await raw(`INSERT INTO sync_wanted_markers (source_id, intent, wanted_head, requested_by) VALUES
      ('notify-a', 'freshness', 'c0ffee', 'test'), ('notify-a', 'pull', NULL, 'test')`);

    const rows = await engine.readNotifierStatusRows(['notify-a', 'notify-b', 'notify-gone']);
    expect(rows.map((r) => r.id)).toEqual(['notify-a', 'notify-b']);
    expect(rows[0]).toMatchObject({
      id: 'notify-a', last_commit: 'c0ffee', state: 'retry', reason: 'head_moved', attempts: 3, observed_head: 'c0ffee', detection_mode: 'poll',
      owner_host_id: 'notify-host', owner_kind: 'serve', owner_pid: 4242, last_error_code: 'sync_failed', last_error: 'boom',
      lease_live: true, due_markers: 1,
    });
    expect(rows[0]!.lease_expires_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(rows[1]).toMatchObject({
      id: 'notify-b', last_commit: null, state: null, reason: null, attempts: null, observed_head: null, detection_mode: null, owner_host_id: null,
      lease_live: false, lease_expires_at: null, due_markers: 0,
    });

    expect((await engine.readNotifierStatusRows(['notify-b'])).map((r) => r.id)).toEqual(['notify-b']);
    expect(await engine.readNotifierStatusRows([])).toEqual([]);
    const all = (await engine.readNotifierStatusRows(null)).map((r) => r.id);
    expect(all).toEqual(expect.arrayContaining(['default', 'notify-a', 'notify-b']));
    expect(all).not.toContain('notify-gone');
    await raw(`UPDATE sync_notifier_leases SET expires_at = now() - interval '1 minute' WHERE host_id = 'notify-host'`);
    expect((await engine.readNotifierStatusRows(['notify-a']))[0]).toMatchObject({ lease_live: false });
  });

  test('listClaimPendingSourceIds lists the claimed sources whose lift has not finished, in byte order, and drops one once it is lifted', async () => {
    await raw(`INSERT INTO sources (id, name, config) VALUES
      ('claim-pending-b', 'b', '{"trust_claimed_at":"2026-01-01T00:00:00Z","trust_tier":"operator_curated"}'::jsonb),
      ('claim-pending-a', 'a', '{"trust_claimed_at":"2026-01-01T00:00:00Z","trust_tier":"operator_curated"}'::jsonb),
      ('claim-lifted', 'lifted', '{"trust_claimed_at":"2026-01-01T00:00:00Z","trust_tier":"operator_curated","trust_claim_lifted_at":"2026-01-02T00:00:00Z"}'::jsonb),
      ('claim-unclaimed', 'unclaimed', '{"trust_tier":"operator_curated"}'::jsonb)
      ON CONFLICT DO NOTHING`);
    expect(await engine.listClaimPendingSourceIds()).toEqual(['claim-pending-a', 'claim-pending-b']);
    await raw(`UPDATE sources SET config = config || '{"trust_claim_lifted_at":"2026-01-03T00:00:00Z"}'::jsonb WHERE id = 'claim-pending-a'`);
    expect(await engine.listClaimPendingSourceIds()).toEqual(['claim-pending-b']);
    expect(await engine.transaction((tx) => tx.listClaimPendingSourceIds())).toEqual(['claim-pending-b']);
    await raw(`UPDATE sources SET config = config || '{"trust_claim_lifted_at":"2026-01-03T00:00:00Z"}'::jsonb WHERE id = 'claim-pending-b'`);
    expect(await engine.listClaimPendingSourceIds()).toEqual([]);
  });

  test('listLiveChunksByIds reads the live chunks of the given ids that the read policy admits, and none of an unsealed page, a deleted page or another source', async () => {
    const { pageId, chunkIds } = await embeddedPage('live/chunks-page', ['First live chunk.', 'Second live chunk.'], 'live-model');
    const { pageId: goneId, chunkIds: goneChunkIds } = await embeddedPage('live/chunks-gone', ['Chunk of a page about to go.'], 'live-model');

    expect(await engine.listLiveChunksByIds([...chunkIds, ...goneChunkIds], {}, undefined)).toEqual([]);
    await raw('UPDATE pages SET text_projection_revision = knowledge_revision WHERE id = ANY($1::int[])', [[pageId, goneId]]);

    const rows = await engine.listLiveChunksByIds([...chunkIds, ...goneChunkIds], {}, undefined);
    expect(rows.map((r) => [Number(r.id), Number(r.page_id), r.chunk_text, r.slug, r.source_id]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([
      [chunkIds[0], pageId, 'First live chunk.', 'live/chunks-page', 'default'],
      [chunkIds[1], pageId, 'Second live chunk.', 'live/chunks-page', 'default'],
      [goneChunkIds[0], goneId, 'Chunk of a page about to go.', 'live/chunks-gone', 'default'],
    ]);
    expect((await engine.listLiveChunksByIds([chunkIds[1]!], { sourceId: 'default' }, undefined)).map((r) => r.chunk_text)).toEqual(['Second live chunk.']);
    expect(await engine.listLiveChunksByIds(chunkIds, { sourceId: 'other' }, undefined)).toEqual([]);
    expect(await engine.listLiveChunksByIds([], {}, undefined)).toEqual([]);

    await raw('UPDATE pages SET deleted_at = now() WHERE id = $1', [goneId]);
    expect((await engine.listLiveChunksByIds([...chunkIds, ...goneChunkIds], {}, undefined)).map((r) => Number(r.id)).sort((a, b) => a - b)).toEqual(chunkIds);
  });
});

describe('projection queue and deferred chunk replacement', () => {
  const jobs = (slug: string) => raw<{ source_incarnation: string; slug: string; revision: string; reason: string }>(
    'SELECT source_incarnation::text, slug, revision::text, reason FROM page_projection_jobs WHERE slug = $1', [slug]);

  test('readProjectionHead reads a live page\'s id and revision, whether it is sealed, and null for a missing or deleted page', async () => {
    const { id } = await page('projection/head');
    const head = await engine.readProjectionHead('default', 'projection/head');
    const [stored] = await raw<{ revision: string; sealed: boolean }>(
      'SELECT knowledge_revision::text AS revision, text_projection_revision IS NOT DISTINCT FROM knowledge_revision AS sealed FROM pages WHERE id = $1', [id]);
    expect(head).toEqual({ id, revision: stored!.revision, sealed: stored!.sealed });
    expect(head!.revision).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);

    await raw('UPDATE pages SET text_projection_revision = knowledge_revision WHERE id = $1', [id]);
    expect(await engine.readProjectionHead('default', 'projection/head')).toEqual({ id, revision: head!.revision, sealed: true });
    await raw('UPDATE pages SET text_projection_revision = NULL WHERE id = $1', [id]);
    expect((await engine.readProjectionHead('default', 'projection/head'))!.sealed).toBe(false);

    expect(await engine.readProjectionHead('default', 'projection/missing')).toBeNull();
    expect(await engine.readProjectionHead('other', 'projection/head')).toBeNull();
    await raw('UPDATE pages SET deleted_at = now() WHERE id = $1', [id]);
    expect(await engine.readProjectionHead('default', 'projection/head')).toBeNull();
  });

  test('queuePageProjectionJob queues a live page at its revision, moves a queued row to a new reason, and hasDrainableProjectionJob and deleteProjectionJob follow the queue', async () => {
    await raw('DELETE FROM page_projection_jobs');
    expect(await engine.hasDrainableProjectionJob()).toBe(false);
    const { id } = await page('projection/queued');
    await raw('DELETE FROM page_projection_jobs');
    const head = (await engine.readProjectionHead('default', 'projection/queued'))!;

    await engine.queuePageProjectionJob('default', 'projection/queued', 'first_reason');
    expect(await jobs('projection/queued')).toEqual([{ source_incarnation: incarnation, slug: 'projection/queued', revision: head.revision, reason: 'first_reason' }]);
    await engine.queuePageProjectionJob('default', 'projection/queued', 'second_reason');
    expect(await jobs('projection/queued')).toEqual([{ source_incarnation: incarnation, slug: 'projection/queued', revision: head.revision, reason: 'second_reason' }]);

    await engine.queuePageProjectionJob('default', 'projection/never-written', 'no_page');
    expect(await jobs('projection/never-written')).toEqual([]);
    expect(await engine.hasDrainableProjectionJob()).toBe(true);
    expect(await engine.hasDrainableProjectionJob({ media: true })).toBe(true);

    await engine.deleteProjectionJob({ sourceIncarnation: incarnation, slug: 'projection/queued', revision: randomUUID() });
    expect(await jobs('projection/queued')).toHaveLength(1);
    await raw(`UPDATE page_projection_jobs SET reason = 'rebuild_failed' WHERE slug = 'projection/queued'`);
    expect(await engine.hasDrainableProjectionJob()).toBe(false);
    await raw(`UPDATE page_projection_jobs SET reason = 'second_reason' WHERE slug = 'projection/queued'`);
    expect(await engine.hasDrainableProjectionJob()).toBe(true);

    await engine.deleteProjectionJob({ sourceIncarnation: incarnation, slug: 'projection/queued', revision: head.revision });
    expect(await jobs('projection/queued')).toEqual([]);
    expect(await engine.hasDrainableProjectionJob()).toBe(false);
    expect(id).toBeGreaterThan(0);
  });

  test('setProjectionChunkerVersion stamps the chunker version on one page and no other', async () => {
    await page('projection/chunker-a');
    await page('projection/chunker-b');
    const version = async (slug: string) => (await raw<{ v: number }>('SELECT chunker_version AS v FROM pages WHERE slug = $1 AND source_id = $2', [slug, 'default']))[0]!.v;
    const before = await version('projection/chunker-b');
    expect(await version('projection/chunker-a')).toBe(before);

    await engine.setProjectionChunkerVersion('default', 'projection/chunker-a', 7);
    expect(await version('projection/chunker-a')).toBe(7);
    expect(await version('projection/chunker-b')).toBe(before);
    await engine.setProjectionChunkerVersion('other', 'projection/chunker-a', 9);
    expect(await version('projection/chunker-a')).toBe(7);
  });

  test('a continuation renews its claim on a deferred replacement, another continuation sees it held, and releasing it hands the job back', async () => {
    const slug = 'projection/deferred';
    await page(slug);
    await engine.queuePageProjectionJob('default', slug, 'chunk_replacement_deferred');
    const head = (await engine.readProjectionHead('default', slug))!;
    const job = { sourceIncarnation: incarnation, slug, revision: head.revision };
    const reason = async () => (await jobs(slug))[0]!.reason;
    const mine = 'chunk_replacement_continuing:token-mine';
    const theirs = 'chunk_replacement_continuing:token-theirs';

    expect(await engine.isDeferredReplacementHeld('default', slug, head.revision, mine)).toBe(false);
    await engine.renewDeferredReplacementClaim(job, mine);
    expect(await reason()).toBe(mine);
    expect(await engine.isDeferredReplacementHeld('default', slug, head.revision, theirs)).toBe(true);
    expect(await engine.isDeferredReplacementHeld('default', slug, head.revision, mine)).toBe(false);
    expect(await engine.isDeferredReplacementHeld('default', slug, randomUUID(), theirs)).toBe(false);
    expect(await engine.isDeferredReplacementHeld('other', slug, head.revision, theirs)).toBe(false);

    await raw(`UPDATE page_projection_jobs SET updated_at = now() - interval '2 minutes' WHERE slug = $1`, [slug]);
    expect(await engine.isDeferredReplacementHeld('default', slug, head.revision, theirs)).toBe(false);
    await engine.renewDeferredReplacementClaim(job, mine);
    expect(await engine.isDeferredReplacementHeld('default', slug, head.revision, theirs)).toBe(true);

    await engine.renewDeferredReplacementClaim({ ...job, revision: randomUUID() }, theirs);
    expect(await reason()).toBe(mine);
    await engine.releaseDeferredReplacementClaim(slug, theirs);
    expect(await reason()).toBe(mine);
    await engine.releaseDeferredReplacementClaim(slug, mine);
    expect(await reason()).toBe('chunk_replacement_deferred');
    expect(await engine.isDeferredReplacementHeld('default', slug, head.revision, theirs)).toBe(false);
  });
});

describe('chunk vectors and the keep plan', () => {
  test('readChunkKeepState marks a chunk movable only while its vector is present, embedded from its current text, and labelled with the model', async () => {
    const { pageId, chunkIds } = await embeddedPage('chunks/keep-state', ['Keep one.', 'Keep two.', 'Keep three.', 'Keep four.'], 'keep-model');
    await raw(`UPDATE content_chunks SET chunk_text = 'Keep two, edited.' WHERE id = $1`, [chunkIds[1]]);
    await raw(`UPDATE content_chunks SET model = 'other-model' WHERE id = $1`, [chunkIds[2]]);
    await raw(`UPDATE content_chunks SET embedding = NULL WHERE id = $1`, [chunkIds[3]]);
    await raw(`UPDATE content_chunks SET embedding_input_hash = 'input-hash' WHERE id = $1`, [chunkIds[0]]);

    const state = await engine.readChunkKeepState(pageId, 'keep-model', column());
    expect(state.map((s) => [Number(s.id), s.embedding_input_hash, s.movable]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([
      [chunkIds[0], 'input-hash', true], [chunkIds[1], null, false], [chunkIds[2], null, false], [chunkIds[3], null, false],
    ].sort((a, b) => Number(a[0]) - Number(b[0])));
    expect((await engine.readChunkKeepState(pageId, 'other-model', column())).filter((s) => s.movable).map((s) => Number(s.id))).toEqual([chunkIds[2]]);
    expect(await engine.readChunkKeepState(pageId + 100_000, 'keep-model', column())).toEqual([]);
  });

  test('listStaleChunkVectors names the vectors the page no longer accepts, in chunk order, and clearChunkVectors clears exactly the ids it is given and marks them pending', async () => {
    const { pageId, chunkIds } = await embeddedPage('chunks/stale', ['Stale one.', 'Stale two.', 'Stale three.'], 'stale-model');
    expect(await engine.listStaleChunkVectors(pageId, 'stale-model', column(), chunkIds)).toEqual([]);

    await raw(`UPDATE content_chunks SET chunk_text = 'Stale two, edited.' WHERE id = $1`, [chunkIds[1]]);
    expect(await engine.listStaleChunkVectors(pageId, 'stale-model', column(), chunkIds)).toEqual([chunkIds[1]]);
    expect(await engine.listStaleChunkVectors(pageId, 'stale-model', column(), [chunkIds[1]!, chunkIds[2]!])).toEqual([chunkIds[0], chunkIds[1]]);
    expect(await engine.listStaleChunkVectors(pageId, 'a-different-model', column(), chunkIds)).toEqual(chunkIds);
    await raw('UPDATE content_chunks SET embedding = NULL WHERE id = $1', [chunkIds[0]]);
    expect(await engine.listStaleChunkVectors(pageId, 'stale-model', column(), [chunkIds[1]!, chunkIds[2]!])).toEqual([chunkIds[1]]);

    expect((await chunkState(pageId)).map((s) => [s.has_vector, s.pending])).toEqual([[false, false], [true, false], [true, false]]);
    await engine.clearChunkVectors(pageId, column(), [chunkIds[1]!]);
    expect((await chunkState(pageId)).map((s) => [s.has_vector, s.hash === null, s.pending])).toEqual([[false, false, false], [false, true, true], [true, false, false]]);
    await engine.clearChunkVectors(pageId, column(), []);
    expect((await chunkState(pageId)).filter((s) => s.has_vector)).toHaveLength(1);
    expect(await engine.listStaleChunkVectors(pageId, 'stale-model', column(), chunkIds)).toEqual([]);
  });

  test('clearUnkeptChunkVectors clears the vectors that are mislabelled, embedded from other text or not current, and keeps the others', async () => {
    const { pageId, chunkIds } = await embeddedPage('chunks/unkept', ['Unkept one.', 'Unkept two.', 'Unkept three.', 'Unkept four.'], 'unkept-model');
    await raw(`UPDATE content_chunks SET model = 'old-model' WHERE id = $1`, [chunkIds[0]]);
    await raw(`UPDATE content_chunks SET chunk_text = 'Unkept two, edited.' WHERE id = $1`, [chunkIds[1]]);

    await engine.clearUnkeptChunkVectors(pageId, 'unkept-model', column(), [chunkIds[0]!, chunkIds[1]!, chunkIds[2]!]);
    expect((await chunkState(pageId)).map((s) => [Number(s.id), s.has_vector, s.pending])).toEqual([
      [chunkIds[0], false, true], [chunkIds[1], false, true], [chunkIds[2], true, false], [chunkIds[3], false, true],
    ]);
    expect(await raw('SELECT count(*)::int AS n FROM content_chunks WHERE page_id = $1 AND embedded_text_hash IS NULL AND embedded_at IS NULL', [pageId])).toEqual([{ n: 3 }]);

    await engine.clearUnkeptChunkVectors(pageId, 'unkept-model', column(), chunkIds);
    expect((await chunkState(pageId)).filter((s) => s.has_vector).map((s) => Number(s.id))).toEqual([chunkIds[2]]);
  });

  test('countPendingTextChunks counts the text chunks that have no vector and their characters, and follows a clear', async () => {
    const { pageId, chunkIds } = await embeddedPage('chunks/pending', ['abc', 'defgh', 'ij'], 'pending-model');
    expect(await engine.countPendingTextChunks(pageId, column())).toEqual({ chunks: 0, chars: 0 });
    await engine.clearChunkVectors(pageId, column(), [chunkIds[1]!, chunkIds[2]!]);
    expect(await engine.countPendingTextChunks(pageId, column())).toEqual({ chunks: 2, chars: 7 });
    await raw(`UPDATE content_chunks SET modality = 'image' WHERE id = $1`, [chunkIds[2]]);
    expect(await engine.countPendingTextChunks(pageId, column())).toEqual({ chunks: 1, chars: 5 });
    expect(await engine.countPendingTextChunks(pageId + 100_000, column())).toEqual({ chunks: 0, chars: 0 });
  });

  test('readChunkRowsFingerprint is stable for the same chunk rows and changes when a row is deleted, and deleteUnkeptChunks deletes every chunk it is not told to keep', async () => {
    const { pageId, chunkIds } = await embeddedPage('chunks/fingerprint', ['Print one.', 'Print two.', 'Print three.'], 'print-model');
    const other = await embeddedPage('chunks/fingerprint-other', ['Other page chunk.'], 'print-model');
    const full = await engine.readChunkRowsFingerprint(pageId);
    expect(full).toMatch(/^3:-?\d+$/);
    expect(await engine.readChunkRowsFingerprint(pageId)).toBe(full);
    expect(await engine.readChunkRowsFingerprint(pageId + 100_000)).toBe('0:0');

    await engine.deleteUnkeptChunks(pageId, [chunkIds[0]!, chunkIds[2]!]);
    expect((await chunkState(pageId)).map((s) => Number(s.id))).toEqual([chunkIds[0], chunkIds[2]]);
    const reduced = await engine.readChunkRowsFingerprint(pageId);
    expect(reduced).toMatch(/^2:-?\d+$/);
    expect(reduced).not.toBe(full);
    expect((await chunkState(other.pageId)).map((s) => Number(s.id))).toEqual(other.chunkIds);

    await engine.deleteUnkeptChunks(pageId, [chunkIds[0]!, chunkIds[2]!, 999_999]);
    expect(await engine.readChunkRowsFingerprint(pageId)).toBe(reduced);
    await engine.deleteUnkeptChunks(pageId, []);
    expect(await chunkState(pageId)).toEqual([]);
    expect(await engine.readChunkRowsFingerprint(pageId)).toBe('0:0');
  });
});

describe('transaction engine', () => {
  test('the members run through a transaction engine as well as the engine itself', async () => {
    const { pageId, chunkIds } = await embeddedPage('chunks/in-transaction', ['Tx one.', 'Tx two.'], 'tx-model');
    const result = await engine.transaction(async (tx: BrainEngine) => {
      await tx.clearChunkVectors(pageId, column(), [chunkIds[0]!]);
      return { pending: await tx.countPendingTextChunks(pageId, column()), head: await tx.readProjectionHead('default', 'chunks/in-transaction') };
    });
    expect(result.pending).toEqual({ chunks: 1, chars: 7 });
    expect(result.head).toMatchObject({ id: pageId });
    expect(await engine.countPendingTextChunks(pageId, column())).toEqual({ chunks: 1, chars: 7 });
  });
});
