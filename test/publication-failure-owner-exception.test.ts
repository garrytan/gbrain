/**
 * #5929: an unexpected exception inside the owner's preparation or publication
 * keeps a bounded identity (class, errno, repo-relative top gbrain frame, never
 * its message), so the attempt is stamped with the owner's build; remote
 * receipts expose only the allow-listed public keys; `gbrain write-request`
 * names an owner/CLI build mismatch with a restart fix.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { receiptFor } from '../src/core/persistence/journal.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { publicFailureDetail, OWNER_EXCEPTION_MESSAGE } from '../src/core/persistence/publication-failure.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { readWriterDiagnostics } from '../src/core/persistence/diagnostics.ts';
import { DATABASE_REFUSAL_HINT, DATABASE_TRIGGER_HINT } from '../src/core/persistence/connector-errors.ts';
import { readTerminalFailureSummary } from '../src/core/persistence/terminal-failures.ts';
import { VERSION } from '../src/version.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-exception-'));
const sourceId = `owner-exc-${randomUUID().slice(0, 8)}`;
const logger = { info() {}, warn() {}, error() {} };
const ctx = () => ({ engine, sourceId, remote: false, config: { engine: 'pglite', embedding_disabled: true }, dryRun: false, logger }) as never;

beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  const root = join(dir, 'brain'); mkdirSync(root);
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  await withEnv({ GBRAIN_HOME: join(dir, 'home') }, () => claimWorktree(engine, sourceId, root));
}, 60_000);
afterAll(async () => { installFaultHook(undefined); await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(dir, { recursive: true, force: true }); });

async function failingWrite(error: Error): Promise<{ thrown: OperationError; row: WriteRequest }> {
  const slug = `notes/${randomUUID().slice(0, 8)}`;
  const requestId = randomUUID();
  installFaultHook(async point => { if (point === 'consumer:prepared') throw error; });
  let thrown: unknown;
  try {
    await withEnv({ GBRAIN_HOME: join(dir, 'home') }, () => submitPageMutation(ctx(), { operation: 'put_page',
      params: { slug, content: '---\ntype: note\ntitle: Example\n---\nBody.\n', request_id: requestId } }));
  } catch (e) { thrown = e; } finally { installFaultHook(undefined); }
  const [row] = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
  return { thrown: thrown as OperationError, row };
}

/**
 * The row as JSON with its generated identities, counters and clock values replaced: UUIDs, the random slug and source
 * id, hashes, owner pids and timestamps are hex or digits drawn at random, so a short digit needle such as a fragment of
 * a redacted number would match them by chance (about one run in forty). Every field a statement's text can reach keeps
 * its value.
 */
const GENERATED_KEYS = new Set(['id', 'principal_id', 'request_id', 'source_id', 'sourceId', 'source_incarnation', 'sourceIncarnation', 'slug',
  'worktree_id', 'digest', 'execution_token', 'token', 'admitter_host_id', 'consumer_host_id', 'nonce', 'start', 'pid', 'pid_ns', 'boot_id',
  'sequence', 'intent_bytes', 'terminal_reservation', 'recovery_bytes', 'topology_generation', 'protocol_version', 'created_at', 'updated_at',
  'completed_at', 'published_at', 'claim_expires_at', 'next_attempt_at', 'since', 'claimed_at', 'step_since']);
function withoutGeneratedIdentities(row: WriteRequest): string {
  return JSON.stringify(row, (key, value) => GENERATED_KEYS.has(key) && value !== null ? '<generated>' : value);
}

describe('#5929 owner exceptions keep a bounded identity', () => {
  test('a TypeError is stored with its class and repo-relative frame, the attempt is stamped, and its message never leaves the owner', async () => {
    // As thrown inside gbrain: a dependency frame first, then gbrain's own source under an absolute checkout path.
    const error = Object.assign(new TypeError('cannot read secret-value of undefined'), { stack: [
      'TypeError: cannot read secret-value of undefined',
      '    at parse (/home/alice-example/.bun/install/global/node_modules/yaml/dist/index.js:10:3)',
      '    at preparePageMutation (/home/alice-example/gbrain/src/core/persistence/page-prepare.ts:120:15)',
      '    at run (/home/alice-example/gbrain/src/core/persistence/consumer.ts:540:9)'].join('\n') });
    const { thrown, row } = await failingWrite(error);
    expect(thrown).toBeInstanceOf(OperationError);
    expect(thrown.code).toBe('storage_error');
    expect(row.error_code).toBe('storage_error');
    expect(row.error_message).toBe(OWNER_EXCEPTION_MESSAGE);
    expect(row.error_message).not.toContain('TypeError');
    expect(row.error_message).not.toContain(VERSION);
    const detail = row.error_detail as Record<string, any>;
    expect(detail).toMatchObject({ origin: 'owner_exception', error_class: 'TypeError', stage: 'publication', attempt: { consumer_version: VERSION } });
    expect(detail.frame).toBe('src/core/persistence/page-prepare.ts:120');
    expect(JSON.stringify(row)).not.toContain('secret-value');
    expect(JSON.stringify(row)).not.toContain('alice-example');
  });

  test('an errno-bearing error keeps the errno', async () => {
    const { row } = await failingWrite(Object.assign(new Error('no space left on /home/alice-example/brain'), { code: 'ENOSPC' }));
    expect(row.error_detail).toMatchObject({ origin: 'owner_exception', error_class: 'Error', errno: 'ENOSPC' });
    expect(row.error_message).toBe(OWNER_EXCEPTION_MESSAGE);
    expect(row.error_message).not.toContain('ENOSPC');
    expect(JSON.stringify(row)).not.toContain('alice-example');
  });

  test('the receipt any caller reads carries none of the owner-only fields', async () => {
    const { row } = await failingWrite(new RangeError('bad offset'));
    const receipt = receiptFor(row) as Record<string, any>;
    expect(receipt.write_error_detail).toEqual({ origin: 'owner_exception', stage: 'publication' });
  });

  test('the public view of today\'s detail shapes is unchanged', () => {
    const guard = { origin: 'database_guard', sqlstate: 'P0001', raiser: 'gbrain_require_managed_writer', table: 'tags', branch: 'source_scope', op: 'INSERT',
      relationship: 'different_source', sources: { target: 'a', old: null, allowed: ['b'] }, stage: 'publication', attempt: { consumer_version: '0.60.1.0', consumer_host_id: 'h' } };
    expect(JSON.stringify(publicFailureDetail(guard))).toBe(JSON.stringify({ origin: 'database_guard', sqlstate: 'P0001', raiser: 'gbrain_require_managed_writer',
      table: 'tags', branch: 'source_scope', op: 'INSERT', relationship: 'different_source', stage: 'publication' }));
    const fence = { origin: 'fence', fence: { version: 1, fence: 'facts', section: 'body', reason: 'malformed_row', rows: [3], issues: [{ row: 3, column: 'kind', problem: 'invalid_enum' }] },
      stage: 'preparation', attempt: { consumer_version: '0.60.1.0', consumer_host_id: 'h' } };
    expect(JSON.stringify(publicFailureDetail(fence))).toBe(JSON.stringify({ origin: 'fence', fence: { version: 1, fence: 'facts', section: 'body', reason: 'malformed_row',
      issues: [{ column: 'kind', problem: 'invalid_enum' }] }, stage: 'preparation' }));
    expect(publicFailureDetail({ origin: 'database', sqlstate: 'P0001', surprise: 'leak' })).toEqual({ origin: 'database', sqlstate: 'P0001' });
  });

  test('write-request names an owner build that differs from this CLI, with a restart fix', async () => {
    const { row } = await failingWrite(new TypeError('stale owner'));
    await engine.executeRaw(`UPDATE persistence_requests SET error_detail=jsonb_set(error_detail,'{attempt,consumer_version}','"0.60.1.0"') WHERE id=$1::uuid`, [row.id]);
    const receipt = await withEnv({ GBRAIN_HOME: join(dir, 'home') }, () =>
      operationsByName.get_write_request.handler(ctx(), { request_id: row.request_id })) as Record<string, any>;
    expect(receipt.owner_build).toMatchObject({ owner: '0.60.1.0', cli: VERSION });
    expect(receipt.owner_build.why).toContain('gbrain serve');
    expect(receipt.owner_build.fix).toMatchObject({ actor: 'user', verify: { argv: ['gbrain', 'doctor', '--only', 'writer_version', '--json'] } });
  });
});

describe('#6719 owner_exception diagnostics', () => {
  test('writer status recent_failures gives an owner exception its own next_action, never the database-trigger hint', async () => {
    // GST-2314: the stale-plan 0A000 ("cached plan must not change result type") is a transient retry, so any other 0A000 stands in.
    const { row } = await failingWrite(Object.assign(new Error('FOR SHARE is not allowed with aggregate functions'), { code: '0A000' }));
    expect(row.error_detail).toMatchObject({ origin: 'owner_exception', errno: '0A000' });
    const status = await withEnv({ GBRAIN_HOME: join(dir, 'home') }, () => readWriterDiagnostics(engine));
    const failure = status.recent_failures.find(f => f.request_id === row.request_id)!;
    expect(failure.next_action).not.toContain('database trigger');
    expect(failure.next_action).toContain('owner exception');
    expect(failure.next_action).toContain(`gbrain write-request ${row.request_id} --json`);
  });

  test('an origin that names no database refusal stays unknown instead of guessing a trigger; trigger and guard origins keep their hints', async () => {
    const { row } = await failingWrite(new RangeError('bad offset'));
    const failureFor = async (origin: string) => {
      await engine.executeRaw(`UPDATE persistence_requests SET error_detail=jsonb_set(error_detail,'{origin}',to_jsonb($2::text)) WHERE id=$1::uuid`, [row.id, origin]);
      const status = await withEnv({ GBRAIN_HOME: join(dir, 'home') }, () => readWriterDiagnostics(engine));
      return status.recent_failures.find(f => f.request_id === row.request_id)!.next_action;
    };
    const unknown = await failureFor('pending_import');
    expect(unknown).not.toContain('database trigger');
    expect(unknown).toContain('not established');
    expect(unknown).toContain(`gbrain write-request ${row.request_id} --json`);
    expect(await failureFor('database_trigger')).toBe(DATABASE_TRIGGER_HINT);
    expect(await failureFor('database_guard')).toBe(DATABASE_REFUSAL_HINT);
  });

  test('a failed checkpoint receipt is historical once a later checkpoint of the source commits (already on master via #6834)', async () => {
    const receipt = async (state: 'failed' | 'committed') => {
      await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,intent_bytes,terminal_reservation,
          state,error_code,error_message,error_detail,intent,completed_at,updated_at,admitter_version)
        VALUES('local_cli','fixture',$1::uuid,'submit_job',$2,(SELECT incarnation FROM sources WHERE id=$2),'__managed_sync_checkpoint__',$3,'{}'::jsonb,0,0,
          $4,$5,$6,$7::text::jsonb,'{"kind":"managed_sync_checkpoint"}'::jsonb,now(),now(),$8)`,
      [randomUUID(), sourceId, randomUUID(), state, state === 'failed' ? 'storage_error' : null, state === 'failed' ? OWNER_EXCEPTION_MESSAGE : null,
        state === 'failed' ? JSON.stringify({ origin: 'owner_exception', error_class: 'PostgresError', errno: '0A000' }) : null, VERSION]);
    };
    const checkpointRows = async () => {
      const summary = await readTerminalFailureSummary(engine, { sourceIds: [sourceId] });
      if (summary.status !== 'ok') throw new Error('summary unknown');
      return summary.sources[0]!.categories.find(c => c.category === 'owner_exception' && c.code === 'storage_error')!;
    };
    await receipt('failed');
    const before = await checkpointRows();
    expect(before.unresolved).toBeGreaterThanOrEqual(1);
    await receipt('committed');
    const after = await checkpointRows();
    expect(after.unresolved).toBe(before.unresolved - 1);
    expect(after.historical).toBe(before.historical + 1);
  });
});

describe('#7112 a database error keeps its redacted server text and statement, owner-only', () => {
  const serverError = async (sql: string, params: unknown[] = []): Promise<Error> => {
    try { await engine.executeRaw(sql, params); } catch (error) { return error as Error; }
    throw new Error('expected the statement to fail');
  };

  test('a syntax error names the token, the statement with literals replaced and the position; parameters never appear', async () => {
    const error = await serverError("SELECT id FROM sources\n WHERE name = $1 AND config->>'k' = 'secret-literal' AND (config #>> '{}') IS JSONX", ['secret-param']);
    const { row } = await failingWrite(error);
    expect(row.error_message).toBe(OWNER_EXCEPTION_MESSAGE);
    const detail = row.error_detail as Record<string, any>;
    expect(detail).toMatchObject({ origin: 'owner_exception', errno: '42601', error_text: 'syntax error at or near "JSONX"',
      statement: "SELECT id FROM sources WHERE name = $1 AND config->>'…' = '…' AND (config #>> '…') IS JSONX" });
    expect(detail.position).toBeGreaterThan(0);
    expect(JSON.stringify(row)).not.toContain('secret-literal');
    expect(JSON.stringify(row)).not.toContain('secret-param');
    expect((receiptFor(row) as Record<string, any>).write_error_detail).toEqual({ origin: 'owner_exception', stage: 'publication' });
    const receipt = await withEnv({ GBRAIN_HOME: join(dir, 'home') }, () =>
      operationsByName.get_write_request.handler(ctx(), { request_id: row.request_id })) as Record<string, any>;
    expect(receipt.error_detail).toMatchObject({ errno: '42601', error_text: detail.error_text, statement: detail.statement, position: detail.position });
  });

  test('a value the server quotes into its message is replaced, an object it names is kept', async () => {
    const { row } = await failingWrite(await serverError("SELECT $1::uuid AS id WHERE 'alice-example' <> ''", ['alice-example-secret']));
    expect(row.error_detail).toMatchObject({ errno: '22P02', error_text: 'invalid input syntax for type uuid: "…"', statement: "SELECT $1::uuid AS id WHERE '…' <> '…'" });
    expect(JSON.stringify(row)).not.toContain('alice-example');
    const notNull = await failingWrite(await serverError("INSERT INTO sources(id, name) VALUES (NULL, 'alice-example')"));
    expect(notNull.row.error_detail).toMatchObject({ errno: '23502', error_text: 'null value in column "id" of relation "sources" violates not-null constraint' });
  });

  test('a bound value with its own quotes is replaced whole: Postgres does not escape them', async () => {
    const { row } = await failingWrite(await serverError('SELECT $1::uuid', ['prefix"PRIVATE_SECRET"suffix']));
    expect(row.error_detail).toMatchObject({ errno: '22P02', error_text: 'invalid input syntax for type uuid: "…"', statement: 'SELECT $1::uuid' });
    expect(JSON.stringify(row)).not.toContain('PRIVATE_SECRET');
  });

  test('a bound value the server reports as an object name is replaced: the statement does not name it', async () => {
    const value = await failingWrite(await serverError('SELECT $1::regtype', ['PRIVATE_SECRET']));
    expect(value.row.error_detail).toMatchObject({ error_text: 'type "…" does not exist', statement: 'SELECT $1::regtype' });
    expect(JSON.stringify(value.row).toLowerCase()).not.toContain('private_secret');
  });

  test('escape strings, Unicode dollar tags, numbers and comments never reach the statement', async () => {
    const statements = [
      "SELECT E'prefix\\'PRIVATE_SECRET'::uuid",
      'SELECT $é$PRIVATE-SECRET$é$::uuid',
      'SELECT 4111111111111111 AS PRIVATE_x, $1::uuid -- PRIVATE_SECRET',
      "SELECT /* PRIVATE_SECRET /* nested */ still */ $1::uuid, U&'PRIVATE_SECRET'",
    ];
    const shapes = [];
    for (const sql of statements) {
      const { row } = await failingWrite(await serverError(sql, sql.includes('$1') ? ['x'] : []));
      expect(JSON.stringify(row)).not.toContain('PRIVATE_SECRET');
      expect(JSON.stringify(row)).not.toContain('PRIVATE-SECRET');
      expect(withoutGeneratedIdentities(row)).not.toContain('4111');
      shapes.push((row.error_detail as Record<string, unknown>).statement);
    }
    expect(shapes).toEqual(["SELECT E'…'::uuid", 'SELECT $…$::uuid', 'SELECT ? AS PRIVATE_x, $1::uuid', "SELECT $1::uuid, U&'…'"]);
  });

  test('a PL/pgSQL ASSERT keeps no text: its message is the caller\'s', async () => {
    const { row } = await failingWrite(await serverError("DO $$ BEGIN ASSERT false, 'PRIVATE_SECRET'; END $$"));
    expect(row.error_detail).toMatchObject({ origin: 'owner_exception', errno: 'P0004' });
    expect((row.error_detail as Record<string, unknown>).error_text).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain('PRIVATE_SECRET');
  });

  test('a PL/pgSQL RAISE keeps no text: it carries caller values', async () => {
    const { row } = await failingWrite(await serverError("DO $$ BEGIN RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'secret-title of a page'; END $$"));
    const detail = row.error_detail as Record<string, any>;
    expect(detail).toMatchObject({ origin: 'owner_exception', errno: '22023' });
    expect(detail.error_text).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain('secret-title');
  });
});
