/**
 * BrainEngine parity — the reads of `get_write_attribution` and attributed `get_versions` (engine-sql/write-attribution.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: readWriteAttributionNames names the asked requests, OAuth clients, legacy tokens and local writers (a
 *    revoked token or writer included) and no other row; readPageRevisionAttribution, readVersionAttributions and
 *    readOldestVersionAttribution read the receipts the attribution triggers stamp on a page and its versions;
 *    readRowAttribution reads one fact, take or timeline entry, inside its page, source, slug, visibility, privacy and
 *    holder filters, or null; under excludePrivate a caller who is not the owner gets no take or timeline entry while a
 *    source is owner-only (closed form). A take and a timeline entry answer the trust_tier and write_origin their write
 *    stamped, not the column defaults. On every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm
 *    with GBRAIN_TEST_RUST_ARM=1). The get_write_attribution handler gives the same answer end to end.
 *  - Regression: an engine that names a request it was not asked for, drops a revoked writer's name, or serves a row
 *    outside the caller's source, world-only or holder filter tells an admin the wrong writer or leaks a hidden row.
 *  - Why existing coverage misses it: ops/attribution.ts ran these statements through `executeRaw`, which the Rust
 *    engine refuses, and test/write-attribution-read.test.ts runs on PGLite and Postgres only.
 *  - Seam: rows are written through typed members inside transactions whose write settings name the request and
 *    principal, as the persistence scope sets them. Ids and times differ between arms, so rows are compared by label
 *    and times by presence. OAuth client and legacy token names are seeded through insertOauthClient and
 *    insertAccessToken; the token names are compared by label in id order, as the SQL reads them in no order.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ParityBackend } from './harness.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { operations } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import type { RowAttributionRow, RowAttributionTarget, WriteAttributionNameIds } from '../../src/core/engine-sql/write-attribution.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { withEngineScope } from '../../src/core/engine-scope.ts';
import { noteSchemaVersion } from '../../src/core/migrate-pending.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';

const { parityTest } = parityArms(testBackends());

const REQ_A = 'a0000000-0000-4000-8000-0000000000a1';
const REQ_B = 'a0000000-0000-4000-8000-0000000000b2';
const REQ_UNKNOWN = 'a0000000-0000-4000-8000-0000000000c3';
const WRITER = 'd0000000-0000-4000-8000-0000000000d1';
const REVOKED = 'd0000000-0000-4000-8000-0000000000d2';
const UNREGISTERED = 'd0000000-0000-4000-8000-0000000000d3';
const OTHER = 'parity-other';
const SLUG = 'people/alice-example';
const HASH = 'f'.repeat(64);
const GRANT = { scopes: ['read', 'write'], sources: ['*'], writeSources: ['*'] };

const SETTINGS = ['gbrain.write_request', 'gbrain.write_principal_kind', 'gbrain.write_principal_id'];

/** Runs `fn` in a transaction whose write settings name `request` and the principal `kind:id`. */
function as<T>(engine: BrainEngine, request: string, kind: string, id: string, fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
  return engine.transaction(async (tx) => {
    await tx.applyTransactionSettings(SETTINGS, [request, kind, id]);
    return fn(tx);
  });
}

/** Admits one queued request of the principal `local_cli:principalId`, outside a transaction; returns its journal id. */
async function admit(engine: BrainEngine, requestId: string, principalId: string, operation: string): Promise<string> {
  const source = await engine.readSourceMembership('default');
  const keys = [`principal:local_cli:${principalId}`, 'brain'];
  await engine.lockPersistenceCounters(keys);
  const row = await engine.insertWriteRequest({
    principalKind: 'local_cli', principalId, requestId, operation, sourceId: 'default', sourceIncarnation: source!.incarnation,
    pageId: null, slug: SLUG, worktreeId: null, topologyGeneration: null, digest: 'd'.repeat(64), intent: { kind: operation, slug: SLUG },
    authority: { scopes: ['write'], agentLabel: `agent-${operation}` }, intentBytes: 100, terminalReservation: 4096, targetKind: 'page',
    protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: keys, clientRequestId: null, state: 'queued',
    deferredRefreshId: null,
  });
  return row.id;
}

/** Fixture: revoke a local writer (the revoke runs raw SQL in persistence/identity.ts; the Rust store has its own call). */
async function revokeWriter(engine: BrainEngine, backend: ParityBackend, id: string): Promise<void> {
  if (backend === 'rust') {
    await (engine as unknown as { openStore(m: string): { brain: { revokeLocalWriter(id: string): Promise<boolean> } } })
      .openStore('revokeLocalWriter').brain.revokeLocalWriter(id);
    return;
  }
  await engine.executeRaw('UPDATE persistence_local_writers SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1::uuid', [id]);
}

/** Row labels keyed by `<table>:<id>`: ids are per-table sequences and differ between arms. */
type Labels = Map<string, string>;

/** A row receipt with its id named by its label, its times by presence and its request ids by their role. */
function rowView(row: RowAttributionRow | null, table: string, s: Seed) {
  if (!row) return null;
  const { id, created_at, last_written_at, w_req, l_req, ...rest } = row;
  return { row: s.labels.get(`${table}:${Number(id)}`) ?? `unlabelled:${typeof id}`, created: created_at != null,
    lastWritten: last_written_at != null, w_req: s.request(w_req), l_req: s.request(l_req), ...rest };
}

/**
 * Writes the attributed fixture: `people/alice-example` created under REQ_A by WRITER and rewritten under REQ_B by
 * OTHER (a version in between), facts on it in two sources (world and private), takes by two holders, a timeline
 * entry on it and one on another page. Returns the labels of every row id and the page ids.
 */
async function seed(engine: BrainEngine, backend: ParityBackend) {
  await createSource(engine, backend, 'alt');
  const reqA = await admit(engine, REQ_A, WRITER, 'put_page');
  const reqB = await admit(engine, REQ_B, OTHER, 'add_link');
  const labels: Labels = new Map();
  const page = await as(engine, reqA, 'local_cli', WRITER, (tx) =>
    tx.putPage(SLUG, { type: 'person', title: 'Alice', compiled_truth: 'Alice v1', timeline: '' }));
  await engine.putPage('notes/secret', { type: 'note', title: 'Secret', compiled_truth: 'secret', timeline: '', frontmatter: { visibility: 'private' } });
  const plain = await engine.putPage('notes/plain', { type: 'note', title: 'Plain', compiled_truth: 'plain', timeline: '' });
  await as(engine, reqA, 'local_cli', WRITER, async (tx) => {
    const fact = (text: string, visibility: 'world' | 'private', source_id = 'default') =>
      tx.insertFact({ fact: text, entity_slug: SLUG, source: 'mcp:remember', visibility }, { source_id });
    labels.set(`facts:${(await fact('alice ships', 'world')).id}`, 'fact:world');
    labels.set(`facts:${(await fact('alice private', 'private')).id}`, 'fact:private');
    labels.set(`facts:${(await fact('alice alt', 'world', 'alt')).id}`, 'fact:alt');
    // A world fact whose provenance page is private: only the reader's private-page filter hides it.
    const fenced = await tx.insertFacts([{ fact: 'alice fenced', entity_slug: SLUG, source: 'mcp:remember', visibility: 'world', row_num: 1, source_markdown_slug: 'notes/secret' }], { source_id: 'default' });
    labels.set(`facts:${fenced.ids[0]}`, 'fact:fenced');
    await tx.addTakesBatch([
      { page_id: Number(page.id), row_num: 1, claim: 'garry take', kind: 'take', holder: 'garry' },
      { page_id: Number(page.id), row_num: 2, claim: 'alice take', kind: 'take', holder: 'alice' },
    ]);
    await tx.addTimelineEntry(SLUG, { date: '2026-01-02', source: 'cal', summary: 'Joined', detail: 'day one' });
  });
  await engine.addTimelineEntry('notes/plain', { date: '2026-01-03', source: 'cal', summary: 'Plain event', detail: '' });
  const version = await as(engine, reqB, 'local_cli', OTHER, (tx) => tx.createVersion(SLUG, { sourceId: 'default' }));
  labels.set(`page_versions:${Number(version.id)}`, 'version:1');
  await as(engine, reqB, 'local_cli', OTHER, async (tx) => {
    await tx.putPage(SLUG, { type: 'person', title: 'Alice', compiled_truth: 'Alice v2', timeline: '' });
    await tx.addTakesBatch([{ page_id: Number(page.id), row_num: 1, claim: 'garry take, revised', kind: 'take', holder: 'garry' }]);
  });
  for (const t of [...await engine.listTakes({ page_id: Number(page.id), active: true })]) labels.set(`takes:${Number(t.id)}`, `take:${t.holder}`);
  for (const e of await engine.getTimeline(SLUG)) labels.set(`timeline_entries:${Number(e.id)}`, 'timeline:alice');
  for (const e of await engine.getTimeline('notes/plain')) labels.set(`timeline_entries:${Number(e.id)}`, 'timeline:plain');
  const id = (label: string) => Number([...labels].find(([, l]) => l === label)![0].split(':')[1]);
  const request = (value: string | null) => value === reqA ? 'reqA' : value === reqB ? 'reqB' : value;
  return { labels, id, request, reqA, reqB, pageId: Number(page.id), plainId: Number(plain.id), versionId: Number(version.id) };
}
type Seed = Awaited<ReturnType<typeof seed>>;

describe('engine parity: write attribution', () => {
  parityTest('readWriteAttributionNames names the asked requests and local writers, a revoked writer too, and nothing else', {
    methods: ['readWriteAttributionNames', 'insertWriteRequest', 'insertLocalWriterRow'],
  }, async (engine, backend) => {
    const reqA = await admit(engine, REQ_A, WRITER, 'put_page');
    const reqB = await admit(engine, REQ_B, OTHER, 'add_link');
    const role = (id: string) => id === reqA ? 'reqA' : id === reqB ? 'reqB' : id;
    expect(await engine.insertLocalWriterRow({ id: WRITER, lane: 'cli', credentialHash: HASH, grant: GRANT as never })).toBe(true);
    expect(await engine.insertLocalWriterRow({ id: REVOKED, lane: 'stdio', credentialHash: 'e'.repeat(64), grant: GRANT as never })).toBe(true);
    await revokeWriter(engine, backend, REVOKED);
    const none: WriteAttributionNameIds = { requestIds: [], oauthClientIds: [], legacyTokenIds: [], localWriterIds: [] };
    const read = async (ids: Partial<typeof none>) => {
      const names = await engine.readWriteAttributionNames({ ...none, ...ids });
      return {
        requests: names.requests.map(r => ({ ...r, id: role(r.id) })).sort((a, b) => a.id.localeCompare(b.id)),
        clients: names.clients, tokens: names.tokens, writers: [...names.writers].sort((a, b) => a.id.localeCompare(b.id)),
      };
    };
    const empty = await read({});
    // Asked for reqA only: the other principal's admitted reqB is not named; an unknown id names nothing.
    const own = await read({ requestIds: [reqA, reqA, REQ_UNKNOWN], localWriterIds: [WRITER, WRITER] });
    expect(own.requests).toEqual([{ id: 'reqA', operation: 'put_page', completed_at: null, agent_label: 'agent-put_page' }]);
    expect(own.writers).toEqual([{ id: WRITER, lane: 'cli' }]);
    const other = await read({ requestIds: [reqB] });
    expect(other.requests.map(r => r.id)).toEqual(['reqB']);
    // The revoked writer still names its lane (PG reads no revoked_at); an id in another case or unregistered names nothing.
    const writers = await read({ localWriterIds: [REVOKED, UNREGISTERED, WRITER.toUpperCase()] });
    expect(writers.writers).toEqual([{ id: REVOKED, lane: 'stdio' }]);
    return { empty, own, other, writers };
  });

  parityTest('readWriteAttributionNames names an OAuth client by its client name; an unknown client names nothing', {
    methods: ['readWriteAttributionNames', 'insertOauthClient'],
  }, async (engine) => {
    await engine.insertOauthClient({ client_id: 'client-example', client_name: 'Example client' });
    await engine.insertOauthClient({ client_id: 'client-other', client_name: 'Other client' });
    const names = await engine.readWriteAttributionNames({
      requestIds: [], oauthClientIds: ['client-example', 'client-example', 'client-unknown', 'CLIENT-EXAMPLE'], legacyTokenIds: [], localWriterIds: [],
    });
    expect(names.clients).toEqual([{ id: 'client-example', name: 'Example client' }]);
    return names;
  });

  parityTest('readWriteAttributionNames names a legacy token, a revoked one included; an unknown token names nothing', {
    methods: ['readWriteAttributionNames', 'insertAccessToken'],
  }, async (engine) => {
    const token = (name: string, extra: Record<string, unknown> = {}) => engine.insertAccessToken({
      name, token_hash: name.repeat(8).slice(0, 64).padEnd(64, '0'), scopes: ['read'], permissions: {},
      source_grant: 'default', source_id: null, federated_read: null, allowed_operations: null, takes_holders: null, ...extra,
    });
    const live = await token('live-token');
    const revoked = await token('revoked-token', { revoked_at: new Date('2026-01-02T03:04:05Z') });
    await token('unasked-token');
    const labels = new Map([[live.id, 'live'], [revoked.id, 'revoked']]);
    const names = await engine.readWriteAttributionNames({
      requestIds: [], oauthClientIds: [], legacyTokenIds: [live.id, revoked.id, live.id, REQ_UNKNOWN, 'not-a-uuid'], localWriterIds: [],
    });
    // The SQL reads the rows in no order; a caller keys them by id.
    const tokens = names.tokens.map(t => ({ id: labels.get(t.id) ?? t.id, name: t.name })).sort((a, b) => a.id.localeCompare(b.id));
    expect(tokens).toEqual([{ id: 'live', name: 'live-token' }, { id: 'revoked', name: 'revoked-token' }]);
    return { ...names, tokens };
  });

  parityTest('readPageRevisionAttribution, readVersionAttributions and readOldestVersionAttribution read the stamped page and version receipts', {
    methods: ['readPageRevisionAttribution', 'readVersionAttributions', 'readOldestVersionAttribution', 'createVersion', 'applyTransactionSettings'],
  }, async (engine, backend) => {
    const s = await seed(engine, backend);
    const revision = (row: Awaited<ReturnType<BrainEngine['readPageRevisionAttribution']>>) =>
      row && { ...row, req: s.request(row.req), revision: typeof row.revision };
    const live = revision(await engine.readPageRevisionAttribution(s.pageId));
    expect(live).toMatchObject({ req: 'reqB', kind: 'local_cli', pid: OTHER });
    const plain = revision(await engine.readPageRevisionAttribution(s.plainId));
    const missing = await engine.readPageRevisionAttribution(s.plainId + 1000);
    const versions = (await engine.readVersionAttributions([{ id: s.versionId, page_id: s.pageId }, { id: s.versionId + 1000, page_id: s.pageId }]))
      .map(({ id, w_req, a_req, ...rest }) => ({ version: s.labels.get(`page_versions:${Number(id)}`), w_req: s.request(w_req), a_req: s.request(a_req), ...rest }));
    // Version 1 snapshots the page reqA wrote; reqB archived it.
    expect(versions).toEqual([expect.objectContaining({ version: 'version:1', w_req: 'reqA', w_id: WRITER, a_req: 'reqB', a_id: OTHER })]);
    const noVersions = await engine.readVersionAttributions([]);
    const oldestRow = await engine.readOldestVersionAttribution(s.pageId);
    const oldest = oldestRow && { ...oldestRow, req: s.request(oldestRow.req) };
    expect(oldest).toEqual({ req: 'reqA', kind: 'local_cli', pid: WRITER });
    const noOldest = await engine.readOldestVersionAttribution(s.plainId);
    return { live, plain, missing, versions, noVersions, oldest, noOldest };
  });

  parityTest('readRowAttribution reads a fact, take or timeline entry only inside its page, source, slug, visibility, privacy and holder filters', {
    methods: ['readRowAttribution', 'insertFact', 'addTakesBatch', 'addTimelineEntry'],
  }, async (engine, backend) => {
    const s = await seed(engine, backend);
    const fact = (label: string, over: Partial<Extract<RowAttributionTarget, { kind: 'fact' }>> = {}): RowAttributionTarget =>
      ({ kind: 'fact', id: s.id(label), sourceId: 'default', slug: SLUG, worldOnly: false, excludePrivate: false, ...over });
    const table = { fact: 'facts', take: 'takes', timeline: 'timeline_entries' } as const;
    const read = async (target: RowAttributionTarget) => rowView(await engine.readRowAttribution(target), table[target.kind], s);
    const out = {
      world: await read(fact('fact:world')),
      worldRemote: await read(fact('fact:world', { worldOnly: true, excludePrivate: true })),
      // Leak decoys: each names a real row the filter must hide.
      privateWorldOnly: await read(fact('fact:private', { worldOnly: true })),
      privateExcluded: await read(fact('fact:private', { excludePrivate: true })),
      privateLocal: await read(fact('fact:private')),
      fencedExcluded: await read(fact('fact:fenced', { excludePrivate: true })),
      fencedLocal: await read(fact('fact:fenced')),
      otherSource: await read(fact('fact:alt')),
      altInItsSource: await read(fact('fact:alt', { sourceId: 'alt' })),
      wrongSlug: await read(fact('fact:world', { slug: 'notes/plain' })),
      take: await read({ kind: 'take', pageId: s.pageId, rowNum: 1 }),
      takeOwnHolder: await read({ kind: 'take', pageId: s.pageId, rowNum: 1, holders: ['garry'] }),
      takeOtherHolder: await read({ kind: 'take', pageId: s.pageId, rowNum: 1, holders: ['alice'] }),
      takeNoHolders: await read({ kind: 'take', pageId: s.pageId, rowNum: 2, holders: [] }),
      takeOtherPage: await read({ kind: 'take', pageId: s.plainId, rowNum: 1 }),
      timeline: await read({ kind: 'timeline', id: s.id('timeline:alice'), pageId: s.pageId }),
      timelineOtherPage: await read({ kind: 'timeline', id: s.id('timeline:plain'), pageId: s.pageId }),
      timelineUnattributed: await read({ kind: 'timeline', id: s.id('timeline:plain'), pageId: s.plainId }),
    };
    expect(out.world).toMatchObject({ row: 'fact:world', w_req: 'reqA', w_id: WRITER, l_req: 'reqA' });
    expect(out.privateLocal).toMatchObject({ row: 'fact:private' });
    // excludePrivate filters by provenance page, not by the fact's own visibility.
    expect(out.privateExcluded).toMatchObject({ row: 'fact:private' });
    expect(out.fencedLocal).toMatchObject({ row: 'fact:fenced' });
    expect(out.altInItsSource).toMatchObject({ row: 'fact:alt' });
    // Take row 1 was created under reqA and rewritten under reqB.
    expect(out.take).toMatchObject({ row: 'take:garry', w_req: 'reqA', w_id: WRITER, l_req: 'reqB', l_id: OTHER });
    expect(out.takeOwnHolder).toEqual(out.take);
    expect(out.timeline).toMatchObject({ row: 'timeline:alice', w_req: 'reqA' });
    expect(out.timelineUnattributed).toMatchObject({ row: 'timeline:plain', w_req: null, l_req: null });
    for (const hidden of ['privateWorldOnly', 'fencedExcluded', 'otherSource', 'wrongSlug', 'takeOtherHolder', 'takeNoHolders', 'takeOtherPage', 'timelineOtherPage'] as const) {
      expect({ hidden, row: out[hidden] }).toEqual({ hidden, row: null });
    }
    return out;
  });

  parityTest('readRowAttribution under excludePrivate hides a take and a timeline entry from a caller who is not the owner while a source is owner-only (closed form), and keeps them at the latest schema (no lineage) and for the owner', {
    methods: ['readRowAttribution', 'addTakesBatch', 'addTimelineEntry'],
  }, async (engine, backend) => {
    const s = await seed(engine, backend);
    const take: RowAttributionTarget = { kind: 'take', pageId: s.pageId, rowNum: 1, excludePrivate: true };
    const timeline: RowAttributionTarget = { kind: 'timeline', id: s.id('timeline:alice'), pageId: s.pageId, excludePrivate: true };
    const rows = async () => ({
      take: (await engine.readRowAttribution(take)) !== null,
      timeline: (await engine.readRowAttribution(timeline)) !== null,
    });
    const asOwner = () => withCallerAccess({ owner: true }, rows);
    // The fn form: a read in an engine scope that records the latest schema version.
    const latest = async () => {
      noteSchemaVersion(engine, LATEST_SCHEMA_VERSION);
      try { return await withEngineScope(engine, rows); } finally { noteSchemaVersion(engine, Number.NaN); }
    };
    const both = { take: true, timeline: true };
    // Before an owner-only source exists the closed form reads both rows: the hidden case is not vacuous.
    const before = await rows();
    expect(before).toEqual(both);
    await createSource(engine, backend, 'chat', { kind: 'imessage' });
    const closed = await rows();
    expect(closed).toEqual({ take: false, timeline: false });
    const owner = await asOwner();
    expect(owner).toEqual(both);
    const fn = await latest();
    expect(fn).toEqual(both);
    return { before, closed, owner, fn };
  });

  parityTest('readRowAttribution and get_write_attribution answer the trust tier and write origin a take and a timeline entry were written with', {
    methods: ['readRowAttribution', 'addTakesBatch', 'addTimelineEntry', 'applyTransactionSettings'],
  }, async (engine) => {
    const reqA = await admit(engine, REQ_A, WRITER, 'put_page');
    const page = await as(engine, reqA, 'local_cli', WRITER, (tx) =>
      tx.putPage(SLUG, { type: 'person', title: 'Alice', compiled_truth: 'Alice v1', timeline: '' }));
    const origin = { channel: 'mcp', tool: 'parity-take' };
    // One write whose trust context declares a tier and an origin, as an agent's MCP write does.
    await engine.transaction(async (tx) => {
      await tx.applyTransactionSettings([...SETTINGS, 'gbrain.write_trust_tier', 'gbrain.write_origin'],
        [reqA, 'local_cli', WRITER, 'agent_written', JSON.stringify(origin)]);
      await tx.addTakesBatch([{ page_id: Number(page.id), row_num: 1, claim: 'a stamped take', kind: 'take', holder: 'garry' }]);
      await tx.addTimelineEntry(SLUG, { date: '2026-01-02', source: 'cal', summary: 'Joined', detail: 'day one' });
    });
    const [entry] = await engine.getTimeline(SLUG);
    const trust = (row: RowAttributionRow | null) => row && { trust_tier: row.trust_tier, write_origin: row.write_origin };
    const take = trust(await engine.readRowAttribution({ kind: 'take', pageId: Number(page.id), rowNum: 1 }));
    const timeline = trust(await engine.readRowAttribution({ kind: 'timeline', id: Number(entry!.id), pageId: Number(page.id) }));
    const op = operations.find((o) => o.name === 'get_write_attribution')!;
    const ctx = { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: 'default',
      logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
    const handled = await op.handler(ctx, { slug: SLUG, take: 1 }) as { trust_tier: unknown; write_origin: unknown };
    const handler = { trust_tier: handled.trust_tier, write_origin: handled.write_origin };
    // The stored tier and origin, not the column default `unknown` and NULL.
    expect(take).toEqual({ trust_tier: 'agent_written', write_origin: expect.objectContaining(origin) });
    expect(take).toEqual(timeline);
    expect(handler).toEqual({ trust_tier: 'agent_written', write_origin: expect.objectContaining(origin) });
    return { take, timeline, handler };
  });

  parityTest('get_write_attribution answers the page, a fact, a take, a timeline entry and the versions end to end', {
    methods: ['readWriteAttributionNames', 'readPageRevisionAttribution', 'readOldestVersionAttribution', 'readRowAttribution', 'readVersionAttributions'],
  }, async (engine, backend) => {
    const s = await seed(engine, backend);
    expect(await engine.insertLocalWriterRow({ id: WRITER, lane: 'cli', credentialHash: HASH, grant: GRANT as never })).toBe(true);
    expect(await engine.insertLocalWriterRow({ id: REVOKED, lane: 'stdio', credentialHash: 'e'.repeat(64), grant: GRANT as never })).toBe(true);
    await revokeWriter(engine, backend, REVOKED);
    const op = operations.find((o) => o.name === 'get_write_attribution')!;
    const ctx = { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: 'default',
      logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
    // Ids, journal request ids and times differ by arm: replace them with roles and presence.
    const scrub = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, v) => {
      if (typeof v === 'string' && (v === s.reqA || v === s.reqB)) return s.request(v);
      if (/(^|_)at$/.test(key)) return v == null ? v : 'time';
      if (/(^|_)id$/.test(key) && typeof v === 'number') return 'id';
      if (key === 'knowledge_revision' && v != null) return 'revision';
      return v;
    }));
    const call = async (p: Record<string, unknown>) => scrub(await op.handler(ctx, { slug: SLUG, ...p }));
    return {
      page: await call({ versions: true }),
      fact: await call({ fact: s.id('fact:world') }),
      take: await call({ take: 1 }),
      timeline: await call({ timeline: s.id('timeline:alice') }),
    };
  });

  parityTest('readWriteAttributionNames for an OAuth client: no name on SQL engines; the Rust store has no client table', {
    methods: ['readWriteAttributionNames'],
  }, async (engine) => engine.readWriteAttributionNames({ requestIds: [], oauthClientIds: ['client-example'], legacyTokenIds: [], localWriterIds: [] }));

  parityTest('readWriteAttributionNames for a legacy token: no name on SQL engines; the Rust store has no token table', {
    methods: ['readWriteAttributionNames'],
  }, async (engine) => engine.readWriteAttributionNames({ requestIds: [], oauthClientIds: [], legacyTokenIds: [REQ_UNKNOWN], localWriterIds: [] }));

  parityTest('readPageRevisionAttribution, readVersionAttributions and readOldestVersionAttribution read the stamped page and version receipts', {
    methods: ['readPageRevisionAttribution', 'readVersionAttributions', 'readOldestVersionAttribution', 'createVersion', 'applyTransactionSettings'],
  }, async (engine, backend) => {
    const s = await seed(engine, backend);
    const revision = (row: Awaited<ReturnType<BrainEngine['readPageRevisionAttribution']>>) =>
      row && { ...row, req: s.request(row.req), revision: typeof row.revision };
    const live = revision(await engine.readPageRevisionAttribution(s.pageId));
    expect(live).toMatchObject({ req: 'reqB', kind: 'local_cli', pid: OTHER });
    const plain = revision(await engine.readPageRevisionAttribution(s.plainId));
    const missing = await engine.readPageRevisionAttribution(s.plainId + 1000);
    const versions = (await engine.readVersionAttributions([{ id: s.versionId, page_id: s.pageId }, { id: s.versionId + 1000, page_id: s.pageId }]))
      .map(({ id, w_req, a_req, ...rest }) => ({ version: s.labels.get(`page_versions:${Number(id)}`), w_req: s.request(w_req), a_req: s.request(a_req), ...rest }));
    // Version 1 snapshots the page reqA wrote; reqB archived it.
    expect(versions).toEqual([expect.objectContaining({ version: 'version:1', w_req: 'reqA', w_id: WRITER, a_req: 'reqB', a_id: OTHER })]);
    const noVersions = await engine.readVersionAttributions([]);
    const oldestRow = await engine.readOldestVersionAttribution(s.pageId);
    const oldest = oldestRow && { ...oldestRow, req: s.request(oldestRow.req) };
    expect(oldest).toEqual({ req: 'reqA', kind: 'local_cli', pid: WRITER });
    const noOldest = await engine.readOldestVersionAttribution(s.plainId);
    return { live, plain, missing, versions, noVersions, oldest, noOldest };
  });
});
