/** Real journal admission/claims: source puts pass bulk, with ordering and fairness controls. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { freshBrainFactory, requestFixture, editRequest } from './helpers/persistence-request-fixture.ts';
import { admitWrite, claimNextWrite, releaseUnpublishedClaim } from '../src/core/persistence/journal.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { bulkPublication } from '../src/core/persistence/interactive-priority.ts';

let factory: Awaited<ReturnType<typeof freshBrainFactory>>;
beforeAll(async () => { factory = await freshBrainFactory('pglite'); }, 120_000);
afterAll(async () => { await factory?.dispose(); });
async function setup() {
  const engine = await factory.fresh();
  const f = await requestFixture(engine, 'priority-example');
  const bulk = async (slug: string, kind: string | null = 'managed_facts_entity', origin?: Record<string, unknown>) => {
    const operation = kind?.startsWith('managed_atom_') ? 'submit_job' : 'extract_facts';
    const authority = await submissionAuthority(f.ctx, operation, f.sourceId, f.incarnation, slug);
    const intent = { ...(kind === 'missing' ? {} : { kind }), ...(origin ? { origin } : {}) };
    return admitWrite(engine, { principal: authority.principal, authority, operation, sourceId: f.sourceId,
      sourceIncarnation: f.incarnation, slug, requestId: randomUUID(), callerIntent: intent, intent });
  };
  return { engine, f, bulk, claim: (fifo: string[] = []) => claimNextWrite(engine, localHostId(), 30_000, [], fifo) };
}

test('a source put passes six queued fact writes, and its claim prevents a bulk claim racing publication', async () => {
  const { engine, f, bulk, claim } = await setup();
  for (let i = 0; i < 6; i++) await bulk(`entities/older-${i}`);
  const page = await f.admit('calendar/new');
  const first = await claim();
  expect(first?.id).toBe(page.id);
  expect(first?.passed_sync).toBe(true);
  expect(await claim()).toBeNull();
  await releaseUnpublishedClaim(engine, first!, 'writer_pool_capacity');
  expect((await claim())?.id).toBe(page.id);
}, 60_000);

test('the owed FIFO turn claims one bulk head before another source put, then priority can resume', async () => {
  const { engine, f, bulk, claim } = await setup();
  const old = await bulk('entities/old');
  const next = await bulk('entities/next');
  const page = await f.admit('mail/new');
  const root = `db:${f.incarnation}`;
  expect((await claim([root]))?.id).toBe(old.id);
  await editRequest(engine, old.id, "state='committed',completed_at=now(),execution_token=NULL,claim_expires_at=NULL");
  expect((await claim())?.id).toBe(page.id);
  expect(next.state).toBe('queued');
}, 60_000);

for (const kind of ['managed_facts_entity', 'managed_facts_complete', 'managed_atom_page', 'managed_atom_delete', 'managed_atom_complete']) {
  test(`puts pass retained ${kind} on another page`, async () => {
    const { f, bulk, claim } = await setup();
    await bulk('bulk/other', kind, { slug: 'original/other', locator: 'original/other' });
    const page = await f.admit('calendar/new');
    expect((await claim())?.id).toBe(page.id);
  }, 60_000);
}

for (const collision of ['target', 'facts origin', 'atom origin']) {
  test(`keeps FIFO for a ${collision} collision`, async () => {
    const { f, bulk, claim } = await setup();
    const old = await bulk(collision === 'target' ? 'mail/new' : 'entities/other',
      collision === 'atom origin' ? 'managed_atom_page' : 'managed_facts_entity',
      collision === 'facts origin' ? { slug: 'mail/new' } : collision === 'atom origin' ? { locator: 'mail/new' } : undefined);
    await f.admit('mail/new');
    expect((await claim())?.id).toBe(old.id);
  }, 60_000);
}

test('a running bulk head and an unknown bulk intent remain barriers', async () => {
  const { f, bulk, claim } = await setup();
  const old = await bulk('entities/old');
  expect((await claim())?.id).toBe(old.id);
  await f.admit('mail/new');
  expect(await claim()).toBeNull();
  expect(bulkPublication({ operation: 'extract_facts', intent: { kind: 'unknown' } })).toBe(false);
}, 60_000);

test('disabled foreground switch retains FIFO', async () => {
  const { engine, f, bulk, claim } = await setup();
  await engine.setConfig('sync.foreground_priority', 'false');
  const old = await bulk('entities/old');
  await f.admit('mail/new');
  expect((await claim())?.id).toBe(old.id);
}, 60_000);

test('a bulk recovery record remains a barrier', async () => {
  const { engine, f, bulk, claim } = await setup();
  const old = await bulk('entities/old');
  await editRequest(engine, old.id, "state='recovering',recovery='{\"version\":1}'::jsonb");
  await f.admit('mail/new');
  expect(await claim()).toBeNull();
}, 60_000);

test('an earlier ordinary put retains its place before bulk and a later put', async () => {
  const { f, bulk, claim } = await setup();
  const older = await f.admit('mail/older');
  await bulk('entities/old');
  await f.admit('mail/new');
  expect((await claim())?.id).toBe(older.id);
}, 60_000);

for (const kind of [null, 'missing']) {
  test(`a fact request with ${kind === null ? 'null' : 'missing'} intent kind keeps its FIFO barrier`, async () => {
    const { f, bulk, claim } = await setup();
    const older = await bulk('entities/older', kind);
    await f.admit('mail/new');
    expect((await claim())?.id).toBe(older.id);
  }, 60_000);
}
