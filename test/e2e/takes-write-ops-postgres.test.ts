/**
 * Real PostgreSQL take mutations through the operation and MCP boundaries.
 * Durable local principals, a claimed canonical root, and the native owner lock
 * exercise journal serialization, pending receipts, and same-ID replay. Files,
 * coherent snapshots, and structured take rows must agree after publication.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { hasDatabase } from './helpers.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { operations, OperationError, type OperationContext } from '../../src/core/operations.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { parseMarkdown, serializePageToMarkdown } from '../../src/core/markdown.ts';
import { parseTakesFence, TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../../src/core/takes-fence.ts';
import { registerLocalWriter, withVerifiedLocalRegistration, type LocalRegistration } from '../../src/core/persistence/identity.ts';
import { claimWorktree, getWorktreeBinding } from '../../src/core/persistence/ownership.ts';
import { acquireNativeLock } from '../../src/core/persistence/native-lock.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import type { WriteReceipt } from '../../src/core/persistence/types.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;
const FILE_SOURCE = 'takes-owner-example';
const DB_SOURCE = 'takes-db-only-example';
const UNCLAIMED_SOURCE = 'takes-unclaimed-example';
const OWNER = 'people/owner-example';
const SLUG = {
  add: 'people/takes-add-example', concurrent: 'people/takes-concurrent-example',
  held: 'people/takes-lock-example', resolved: 'companies/takes-resolved-example',
  update: 'companies/takes-update-example', immutable: 'companies/takes-immutable-example',
  supersede: 'companies/takes-supersede-example', database: 'people/takes-database-example',
  unclaimed: 'people/takes-unclaimed-example',
};
const config = { engine: 'postgres' as const, embedding_disabled: true };
let engine: PostgresEngine;
let close: () => Promise<void>;
let home: string;
let repoDir: string;
let cli: LocalRegistration;
let stdio: LocalRegistration;
type MutationResult = WriteReceipt & Record<string, unknown> & { write_request: WriteReceipt };

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine, config, logger: { info() {}, warn() {}, error() {} },
    dryRun: false, remote: false, sourceId: FILE_SOURCE, ...overrides,
  };
}

async function inBrain<T>(run: () => Promise<T>): Promise<T> {
  return withEnv({ GBRAIN_HOME: home }, async () => {
    try { return await run(); }
    finally { await disposePersistenceConsumer(engine); }
  });
}

function call(operation: string, params: Record<string, unknown>, ctx = ctxOf()) {
  const op = operations.find(o => o.name === operation)!;
  return withVerifiedLocalRegistration(engine, ctx.remote ? stdio : cli,
    () => op.handler(ctx, params));
}

/** A lost/pending acknowledgment retries only the original, caller-owned ID. */
async function committed(operation: string, params: Record<string, unknown> & { request_id: string }, ctx = ctxOf()): Promise<MutationResult> {
  expect(params.request_id).toBeString();
  const deadline = Date.now() + 25_000;
  while (true) {
    try {
      const result = await call(operation, params, ctx) as MutationResult;
      expect(result.state).toBe('committed');
      expect(result.write_request.request_id).toBe(params.request_id);
      return result;
    } catch (error) {
      if (!(error instanceof OperationError) || error.code !== 'write_pending' || Date.now() >= deadline) throw error;
      expect(error.writeRequest?.request_id).toBe(params.request_id);
    }
  }
}

async function expectOpError(pending: Promise<unknown>): Promise<OperationError> {
  try { await pending; }
  catch (error) { expect(error).toBeInstanceOf(OperationError); return error as OperationError; }
  throw new Error('Expected an OperationError.');
}

function pageFile(slug: string) { return join(repoDir, `${slug}.md`); }
async function snapshot(slug: string, sourceId = FILE_SOURCE) {
  const value = await engine.readPageSnapshot(slug, { sourceId });
  expect(value).not.toBeNull();
  return value!;
}
async function canonical(slug: string) {
  const state = await snapshot(slug);
  const bytes = readFileSync(pageFile(slug), 'utf8');
  // Compare all canonical fields without depending on PostgreSQL JSONB key order.
  expect(parseMarkdown(bytes, slug)).toEqual(parseMarkdown(serializePageToMarkdown(state.page, state.tags), slug));
  expect(parseTakesFence(bytes)).toEqual(parseTakesFence(state.page.compiled_truth));
  return { state, bytes };
}
async function rows(slug: string, sourceId = FILE_SOURCE) {
  const page_id = (await snapshot(slug, sourceId)).page.id;
  const [active, inactive] = await Promise.all([
    engine.listTakes({ page_id, sourceId, active: true }),
    engine.listTakes({ page_id, sourceId, active: false }),
  ]);
  return [...active, ...inactive].sort((a, b) => a.row_num - b.row_num);
}
async function journalRows(requestId: string, registration: LocalRegistration) {
  return engine.executeRaw(`SELECT request_id,state FROM persistence_requests
    WHERE principal_kind=$1 AND principal_id=$2 AND request_id=$3::uuid`,
  [registration.lane === 'cli' ? 'local_cli' : 'local_stdio', registration.id, requestId]);
}
async function mcp(operation: string, params: Record<string, unknown>, sourceId = FILE_SOURCE) {
  return withVerifiedLocalRegistration(engine, stdio, () => dispatchToolCall(engine, operation, params,
    { remote: true, transport: 'stdio', sourceId, config, takesHoldersAllowList: ['world'] }));
}

beforeAll(async () => {
  if (!RUN) return;
  home = mkdtempSync(join(tmpdir(), 'gbrain-takes-postgres-'));
  repoDir = join(home, 'canonical');
  mkdirSync(repoDir);
  await withEnv({ GBRAIN_HOME: home }, async () => {
    ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    for (const [source, root] of [[FILE_SOURCE, repoDir], [DB_SOURCE, null],
      [UNCLAIMED_SOURCE, join(home, 'missing')]] as const) {
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [source, root]);
    }
    cli = await registerLocalWriter(engine, 'cli');
    stdio = await registerLocalWriter(engine, 'stdio', {
      sourceIds: [FILE_SOURCE, DB_SOURCE, UNCLAIMED_SOURCE],
      operations: ['takes_add', 'takes_update', 'takes_resolve', 'takes_supersede'],
      scopes: ['read', 'write'], slugPrefixes: null,
    });
    // Seed coherent canonical fixtures before claiming ownership. A database-only
    // fixture in an owned filesystem source would correctly refuse publication.
    for (const slug of Object.values(SLUG)) {
      const sourceId = slug === SLUG.database ? DB_SOURCE : slug === SLUG.unclaimed ? UNCLAIMED_SOURCE : FILE_SOURCE;
      const type = slug.startsWith('companies/') ? 'company' : 'person';
      const parsed = parseMarkdown(`---\ntitle: ${slug}\ntype: ${type}\n---\n\n## Takes\n`, slug);
      await engine.putPage(slug, parsed, { sourceId });
      if (sourceId === FILE_SOURCE) {
        const state = await snapshot(slug);
        mkdirSync(dirname(pageFile(slug)), { recursive: true });
        writeFileSync(pageFile(slug), serializePageToMarkdown(state.page, state.tags));
      }
    }
    await claimWorktree(engine, FILE_SOURCE, repoDir);
  });
}, 60_000);

afterAll(async () => {
  if (!RUN) return;
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      if (engine) await disposePersistenceConsumer(engine);
      if (close) await close();
    });
  } finally { if (home) rmSync(home, { recursive: true, force: true }); }
});

d('take persistence routing', () => {
  test('an intentional database-only source commits canonical content, rows, and a replayable receipt', () => inBrain(async () => {
    const params = { request_id: randomUUID(), slug: SLUG.database, claim: 'Durable without a repository', kind: 'take', holder: OWNER };
    const ctx = ctxOf({ sourceId: DB_SOURCE });
    const result = await committed('takes_add', params, ctx);
    const state = await snapshot(SLUG.database, DB_SOURCE);
    expect(result.persistence?.mode).toBe('database');
    expect(result.mirror_written).toBe(false);
    expect(result.revision).toBe(state.revision);
    expect(parseTakesFence(state.page.compiled_truth).takes[0].claim).toBe(params.claim);
    expect((await rows(SLUG.database, DB_SOURCE))[0]).toMatchObject({ row_num: 1, claim: params.claim, holder: OWNER, active: true });
    expect(existsSync(pageFile(SLUG.database))).toBe(false);
    const replay = await committed('takes_add', params, ctx);
    expect(replay.revision).toBe(state.revision);
    expect(replay.created_at).toBe(result.created_at);
    expect(await rows(SLUG.database, DB_SOURCE)).toHaveLength(1);
    expect(await journalRows(params.request_id, cli)).toHaveLength(1);
  }));

  test('an unclaimed configured root refuses before admission in the handler and MCP envelope', () => inBrain(async () => {
    const before = await snapshot(SLUG.unclaimed, UNCLAIMED_SOURCE);
    const params = { request_id: randomUUID(), slug: SLUG.unclaimed, claim: 'Must not land', kind: 'take', holder: 'world' };
    const error = await expectOpError(call('takes_add', params, ctxOf({ sourceId: UNCLAIMED_SOURCE })));
    expect(error.code).toBe('owner_unavailable');
    expect(error.writeRequest).toBeUndefined();
    const response = await mcp('takes_add', params, UNCLAIMED_SOURCE);
    expect(response.isError).toBe(true);
    const envelope = JSON.parse(response.content[0].text);
    expect(envelope.error).toBe('owner_unavailable');
    expect(envelope.write_request).toBeUndefined();
    expect(await snapshot(SLUG.unclaimed, UNCLAIMED_SOURCE)).toEqual(before);
    expect(await rows(SLUG.unclaimed, UNCLAIMED_SOURCE)).toHaveLength(0);
    expect(await journalRows(params.request_id, cli)).toHaveLength(0);
    expect(await journalRows(params.request_id, stdio)).toHaveLength(0);
    expect(existsSync(join(home, 'missing'))).toBe(false);
  }));
});

d('canonical take publication and native owner serialization', () => {
  test('add publishes the full fence and structured row together; replay preserves exact bytes and revision', () => inBrain(async () => {
    const params = { request_id: randomUUID(), slug: SLUG.add, claim: 'Ships weekly at demo day', kind: 'take',
      holder: OWNER, weight: 0.8, source: 'office-hours-notes', since: '2026-08' };
    const result = await committed('takes_add', params);
    expect(result).toMatchObject({ slug: SLUG.add, row_num: 1, holder: OWNER, mirror_written: true });
    expect(result.persistence).toMatchObject({ mode: 'filesystem', file_written: true });
    expect(result.mirror_warning).toBeUndefined();
    const before = await canonical(SLUG.add);
    expect(result.revision).toBe(before.state.revision);
    expect(before.bytes).toContain(TAKES_FENCE_BEGIN);
    expect(before.bytes).toContain(TAKES_FENCE_END);
    expect(before.bytes).toContain(`| 1 | Ships weekly at demo day | take | ${OWNER} | 0.8 | 2026-08 | office-hours-notes |`);
    const takes = await rows(SLUG.add);
    expect(takes).toHaveLength(1);
    expect(takes[0]).toMatchObject({ row_num: 1, claim: params.claim, kind: 'take', holder: OWNER, source: params.source, active: true });
    expect(takes[0].weight).toBeCloseTo(0.8, 5);
    const replay = await committed('takes_add', params);
    expect(replay.revision).toBe(result.revision);
    expect(await canonical(SLUG.add)).toEqual(before);
    expect(await rows(SLUG.add)).toEqual(takes);
  }));

  test('two concurrent requests serialize to distinct dense row numbers and replay without duplication', () => inBrain(async () => {
    const params = ['alpha', 'beta'].map(label => ({ request_id: randomUUID(), slug: SLUG.concurrent,
      claim: `Concurrent claim ${label}`, kind: 'take', holder: OWNER }));
    const results = await Promise.all(params.map(p => committed('takes_add', p)));
    expect(results.map(r => r.row_num).sort()).toEqual([1, 2]);
    for (const result of results) expect(result.mirror_written).toBe(true);
    const before = await canonical(SLUG.concurrent);
    const takes = await rows(SLUG.concurrent);
    expect(takes).toHaveLength(2);
    expect(new Set(takes.map(t => t.claim))).toEqual(new Set(params.map(p => p.claim)));
    expect(before.bytes.split(TAKES_FENCE_BEGIN).length - 1).toBe(1);
    await Promise.all(params.map(p => committed('takes_add', p)));
    expect(await canonical(SLUG.concurrent)).toEqual(before);
    expect(await rows(SLUG.concurrent)).toEqual(takes);
  }), 30_000);

  test('holding the actual owner lock returns the same pending receipt over both transports, then commits once', () => inBrain(async () => {
    const binding = (await getWorktreeBinding(engine, FILE_SOURCE))!;
    const held = await acquireNativeLock(binding.coordination_path!, { timeoutMs: 0 });
    expect(held).not.toBeNull();
    const before = await canonical(SLUG.held);
    const params = { request_id: randomUUID(), slug: SLUG.held, claim: 'Waits for the owner lock', kind: 'take', holder: 'world' };
    const ctx = ctxOf({ remote: true, transport: 'stdio', takesHoldersAllowList: ['world'] });
    let acceptedAt: string | undefined;
    try {
      const error = await expectOpError(call('takes_add', params, ctx));
      expect(error.code).toBe('write_pending');
      expect(error.writeRequest?.request_id).toBe(params.request_id);
      expect(['queued', 'running']).toContain(error.writeRequest!.state);
      acceptedAt = error.writeRequest?.created_at;
      expect(acceptedAt).toBeString();
      const response = await mcp('takes_add', params);
      expect(response.isError).toBe(true);
      const envelope = JSON.parse(response.content[0].text);
      expect(envelope.error).toBe('write_pending');
      expect(envelope.write_request.request_id).toBe(params.request_id);
      expect(envelope.write_request.created_at).toBe(acceptedAt);
      expect(await journalRows(params.request_id, stdio)).toHaveLength(1);
      expect(await canonical(SLUG.held)).toEqual(before);
      expect(await rows(SLUG.held)).toHaveLength(0);
    } finally { await held!.release(); }
    const result = await committed('takes_add', params, ctx);
    expect(result.created_at).toEqual(acceptedAt);
    expect(result.revision).not.toBe(before.state.revision);
    const after = await canonical(SLUG.held);
    expect(result.revision).toBe(after.state.revision);
    expect(await rows(SLUG.held)).toHaveLength(1);
    await committed('takes_add', params, ctx);
    expect(await canonical(SLUG.held)).toEqual(after);
    expect(await rows(SLUG.held)).toHaveLength(1);
  }), 30_000);
});

async function resolvedFixture(slug: string) {
  await committed('takes_add', { request_id: randomUUID(), slug, claim: 'Will close the round by Q4', kind: 'bet', holder: OWNER, weight: 0.6 });
  const params = { request_id: randomUUID(), slug, row_num: 1, quality: 'correct',
    evidence: 'Round closed', value: 25, unit: 'usd', resolved_by: OWNER };
  return { params, result: await committed('takes_resolve', params) };
}

d('resolved takes remain immutable', () => {
  test('resolve preserves the full resolution tuple and local resolver on canonical replay', () => inBrain(async () => {
    const { params, result } = await resolvedFixture(SLUG.resolved);
    expect(result).toMatchObject({ row_num: 1, quality: 'correct', resolved_by: OWNER });
    expect(result.mirror_warning).toBeUndefined();
    const before = await canonical(SLUG.resolved);
    expect(before.bytes).toContain('| correct |');
    expect(before.bytes).toContain('Round closed');
    const takes = await rows(SLUG.resolved);
    expect(takes).toHaveLength(1);
    expect(takes[0]).toMatchObject({ row_num: 1, resolved_quality: 'correct', resolved_outcome: true,
      resolved_by: OWNER, resolved_value: 25, resolved_unit: 'usd', resolved_source: 'Round closed' });
    expect(takes[0].resolved_at).not.toBeNull();
    await committed('takes_resolve', params);
    expect(await canonical(SLUG.resolved)).toEqual(before);
    expect(await rows(SLUG.resolved)).toEqual(takes);
  }));

  for (const [operation, slug, change] of [
    ['takes_update', SLUG.update, { weight: 0.9 }],
    ['takes_supersede', SLUG.immutable, { claim: 'Refused replacement' }],
  ] as const) {
    test(`${operation} returns a terminal invalid_params receipt and preserves the resolved row on replay`, () => inBrain(async () => {
      await resolvedFixture(slug);
      const before = await canonical(slug);
      const takes = await rows(slug);
      const params = { request_id: randomUUID(), slug, row_num: 1, ...change };
      for (let attempt = 0; attempt < 2; attempt++) {
        const error = await expectOpError(call(operation, params));
        expect(error.code).toBe('invalid_params');
        expect(error.message.toLowerCase()).toContain('resolved');
        expect(error.writeRequest).toMatchObject({ request_id: params.request_id, state: 'failed' });
      }
      expect(await canonical(slug)).toEqual(before);
      expect(await rows(slug)).toEqual(takes);
      expect(takes).toHaveLength(1);
      expect(takes[0].weight).toBeCloseTo(0.6, 5);
      expect(await journalRows(params.request_id, cli)).toHaveLength(1);
    }));
  }
});

d('supersede publication', () => {
  test('closes and links the old row, inherits metadata, and appends the replacement exactly once', () => inBrain(async () => {
    await committed('takes_add', { request_id: randomUUID(), slug: SLUG.supersede,
      claim: 'Will hit 10M ARR by Q4', kind: 'bet', holder: OWNER, weight: 0.6 });
    const params = { request_id: randomUUID(), slug: SLUG.supersede, row_num: 1, claim: 'Will hit 8M ARR by Q4 (revised)' };
    const result = await committed('takes_supersede', params);
    expect(result).toMatchObject({ old_row: 1, new_row: 2 });
    expect(result.mirror_warning).toBeUndefined();
    const takes = await rows(SLUG.supersede);
    expect(takes).toHaveLength(2);
    const old = takes.find(t => t.row_num === 1)!;
    const replacement = takes.find(t => t.row_num === 2)!;
    expect(old).toMatchObject({ active: false, superseded_by: 2, claim: 'Will hit 10M ARR by Q4' });
    expect(replacement).toMatchObject({ active: true, superseded_by: null, claim: params.claim, kind: 'bet', holder: OWNER });
    expect(replacement.weight).toBeCloseTo(0.5, 2);
    const before = await canonical(SLUG.supersede);
    expect(before.bytes).toContain('~~Will hit 10M ARR by Q4~~');
    expect(before.bytes).toContain('| 2 | Will hit 8M ARR by Q4 (revised) |');
    await committed('takes_supersede', params);
    expect(await canonical(SLUG.supersede)).toEqual(before);
    expect(await rows(SLUG.supersede)).toEqual(takes);
  }));
});
