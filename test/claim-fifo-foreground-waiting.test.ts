/**
 * The FIFO claim gives a foreground write that may go first the guard the lane-head claim has (`FOREGROUND_WAITING`,
 * journal.ts): no sync head of its worktree is claimed while the write is queued, locked by its own process's claim
 * transaction (skipped by SKIP LOCKED, so ordering alone cannot put it first) or claimed by another process that has not
 * begun to publish. Before the guard, an idle drain's FIFO claim started a sync group there and the write waited behind it.
 * Each foreground commit since this process's last sync head earns the sync side one head, so a stream of writes claimed
 * by other processes cannot starve it.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { activatePersistence } from '../src/core/persistence/activation.ts';
import { setClaimOwnerForTest } from '../src/core/persistence/claim-phase.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { editRequest } from './helpers/persistence-request-fixture.ts';

const engines: BrainEngine[] = [];
const sourceId = 'fifo-foreground-waiting-example';
let databaseUrl = '';
let closePostgres: (() => Promise<void>) | undefined;
const foreign = { kind: 'mcp', pid: 1, version: 'test', nonce: 'another-process' };

beforeAll(async () => {
  const lite = new PGLiteEngine();
  await lite.connect({}); await lite.initSchema();
  engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close; databaseUrl = pg.databaseUrl;
  }
  for (const engine of engines) {
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    await registerLocalWriter(engine, 'cli');
    expect((await activatePersistence(engine, { confirmQuiesced: true })).enabled).toBe(true);
  }
}, 120_000);
afterAll(async () => {
  setClaimOwnerForTest(undefined);
  await engines[0]?.disconnect(); await closePostgres?.();
});

/** A worktree on its own host, so each scene's claims see only its own rows. */
async function scene(engine: BrainEngine) {
  const host = randomUUID(), worktree = randomUUID();
  await engine.executeRaw('INSERT INTO persistence_worktrees(id,owner_host_id) VALUES($1::uuid,$2::uuid)', [worktree, host]);
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
  const context: OperationContext = { engine, sourceId, remote: false, dryRun: false, config: { engine: engine.kind }, logger: { info() {}, warn() {}, error() {} } };
  const add = async (slug: string, kind?: string) => {
    const authority = await submissionAuthority(context, 'put_page', sourceId, source!.incarnation, slug);
    const content = '---\ntitle: Example\ntype: note\n---\nA synthetic note.\n';
    const row = await admitWrite(engine, { principal: authority.principal, operation: 'put_page', sourceId, sourceIncarnation: source!.incarnation,
      slug, pageId: null, requestId: randomUUID(), callerIntent: { slug, content }, intent: { slug, content }, authority });
    await editRequest(engine, row.id, `worktree_id=$2::uuid${kind ? `,intent=jsonb_set(intent,'{kind}',to_jsonb($3::text))` : ''}`, kind ? [worktree, kind] : [worktree]);
    return row.id;
  };
  const sync = (slug: string) => add(slug, 'managed_sync_import');
  /** This process's next claim on the scene's host, as the drain's consumer makes it, with its sync-head cursor. */
  const seen: Record<string, string> = {};
  const claim = async () => {
    const row = await claimNextWrite(engine, host, 30_000, [], [], [], seen);
    if (row?.seen_sequence) seen[worktree] = row.seen_sequence;
    return row?.id ?? null;
  };
  const claimAsAnotherProcess = async () => {
    setClaimOwnerForTest(foreign);
    try { return (await claimNextWrite(engine, host))?.id ?? null; } finally { setClaimOwnerForTest(undefined); }
  };
  const commit = (id: string) => editRequest(engine, id, `state='committed',execution_token=NULL,claim_expires_at=NULL,completed_at=now()`);
  const maxSequence = async () => (await engine.executeRaw<{ s: string }>('SELECT max(sequence)::text AS s FROM persistence_requests'))[0]!.s;
  return { worktree, seen, add, sync, claim, claimAsAnotherProcess, commit, maxSequence };
}

/** Postgres: another connection holds a write's row as its own process's claim transaction does, until released. */
async function lockAsItsOwnProcess(id: string) {
  const { default: postgres } = await import('#postgres');
  const other = postgres(databaseUrl, { max: 1, prepare: false });
  const locked = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const holder = other.begin(async tx => { await tx`SELECT id FROM persistence_requests WHERE id=${id}::uuid FOR UPDATE`; locked.resolve(); await release.promise; });
  await locked.promise;
  return async () => { release.resolve(); await holder; await other.end(); };
}

test('Postgres: a write its own process is claiming (row locked) is not overtaken by a sync head; once claimable it goes first', async () => {
  const engine = engines.find(e => e.kind === 'postgres');
  if (!engine) return;
  const s = await scene(engine);
  await s.sync('notes/synced-a');
  s.seen[s.worktree] = await s.maxSequence();
  const write = await s.add('notes/foreground-a');
  const unlock = await lockAsItsOwnProcess(write);
  try { expect(await s.claim()).toBeNull(); } finally { await unlock(); }
  expect(await s.claim()).toBe(write);
}, 60_000);

test('Postgres: a steady stream of writes, each mid-claim in its own process, still lets the sync side claim a head after every second write', async () => {
  const engine = engines.find(e => e.kind === 'postgres');
  if (!engine) return;
  const s = await scene(engine);
  const heads: string[] = [];
  for (let i = 0; i < 5; i++) heads.push(await s.sync(`notes/synced-c${i}`));
  s.seen[s.worktree] = await s.maxSequence();
  let write = await s.add('notes/foreground-c0');
  let unlock = await lockAsItsOwnProcess(write);
  const claimed: Array<string | null> = [];
  try {
    expect(await s.claim()).toBeNull();
    for (let round = 1; round <= 10; round++) {
      // The write its process was claiming publishes; the next is admitted and is at once mid-claim in its own process.
      await unlock(); await s.commit(write);
      write = await s.add(`notes/foreground-c${round}`);
      unlock = await lockAsItsOwnProcess(write);
      // A commit of a write admitted after this process's last sync head earns one head (the next write, admitted before
      // that head, earns none), so a head comes every second round; it publishes before the next round.
      const head = await s.claim();
      claimed.push(head);
      if (head) { await s.commit(head); expect(await s.claim()).toBeNull(); }
    }
  } finally { await unlock(); }
  expect(claimed).toEqual(heads.flatMap(head => [head, null]));
}, 120_000);

test('a write another process claimed and has not begun to publish holds back the sync head of its worktree until it commits', async () => {
  for (const engine of engines) {
    const s = await scene(engine);
    const head = await s.sync('notes/synced-b');
    s.seen[s.worktree] = await s.maxSequence();
    const write = await s.add('notes/foreground-b');
    expect(await s.claimAsAnotherProcess()).toBe(write);
    expect(await s.claim()).toBeNull();
    await s.commit(write);
    expect(await s.claim()).toBe(head);
  }
}, 60_000);
