/**
 * GST-2260: a prepared `SELECT *` or `RETURNING *` goes stale when another process adds, renames or drops a column on
 * its table, and Postgres answers its next execute with SQLSTATE 0A000 "cached plan must not change result type"
 * (routine RevalidateCachedQuery). The vendored driver re-prepares and retries such a statement, which heals it outside
 * a transaction; inside one the 0A000 has already aborted the transaction, so the caller saw it, once per statement shape
 * per pooled connection (a `gbrain serve` refusing writes after `apply-migrations` ran in another process).
 * 1. Protects: the first such error heals every pooled connection of the process, and the write paths that re-run an
 *    aborted transaction (retryWriteAdmission, the coordinator's transient classifier) re-run it, so a put_page after
 *    the migration succeeds with no caller-visible error.
 * 2. Fails when: the error is not retried by the admission loop, or another pooled connection still holds its stale
 *    statement after the first one healed.
 * 3. Existing coverage: none; test/access-ungranted-member-writes.test.ts flaked on it (a RENAME COLUMN and back).
 *    The two pure-database transactions outside those loops that a long-running process meets first (an OAuth token
 *    grant, a minion job's completion) run once more instead of failing a token request or a job that already ran.
 * 4. Real seams: real Postgres, DDL from a second client, the engine's transaction and executeRaw, MCP dispatch, the
 *    OAuth provider and the minion queue.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import postgres from '#postgres';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { retryWriteAdmission } from '../src/core/persistence/admission-retry.ts';
import { transientDatabaseFailure } from '../src/core/persistence/coordinator.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { hashToken } from '../src/core/utils.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const url = process.env.DATABASE_URL;
const caught = (p: Promise<unknown>) => p.then(() => null, (e: { code?: string; routine?: string }) => e);
const outcomes = (settled: PromiseSettledResult<unknown>[]) => settled.map(s => s.status === 'fulfilled' ? 'ok' : (s.reason as { code?: string }).code);

/** Each change alters the result type of `SELECT *` on the table; `step` counts the changes already made to it. */
const CHANGES = [
  ['ADD COLUMN', (t: string) => `ALTER TABLE ${t} ADD COLUMN added_${randomUUID().slice(0, 8)} text`],
  ['RENAME COLUMN', (t: string, step: number) => step % 2 ? `ALTER TABLE ${t} RENAME COLUMN note_alt TO note` : `ALTER TABLE ${t} RENAME COLUMN note TO note_alt`],
  ['DROP COLUMN', (t: string, step: number) => `ALTER TABLE ${t} DROP COLUMN ${step ? 'note' : 'spare'}`],
] as const;

describe('write admission and a stale plan that keeps coming back (GST-2260)', () => {
  test('another 0A000 is not a stale plan and is not retried', async () => {
    const unsupported = Object.assign(new Error('FOR SHARE is not allowed with aggregate functions'), { code: '0A000', routine: 'CheckSelectLocking' });
    let attempts = 0;
    expect(await caught(retryWriteAdmission(randomUUID(), async () => { attempts++; throw unsupported; }, 5000))).toBe(unsupported);
    expect(attempts).toBe(1);
  });
});

describe('every vendored driver copy carries the plan-generation heal (GST-2260)', () => {
  for (const path of ['vendor/postgres/src/connection.js', 'vendor/postgres/cjs/src/connection.js', 'vendor/postgres/cf/src/connection.js']) {
    test(`${path} starts a new plan generation on a stale cached plan`, () => {
      const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
      expect(source).toContain('let planGeneration = 0');
      expect(source).toContain("errorResponse.routine === 'RevalidateCachedQuery' && planGeneration++");
    });
  }
});

describe.skipIf(!url)('a prepared SELECT * after another connection changes its table (GST-2260)', () => {
  let admin: ReturnType<typeof postgres>;
  const engines: PostgresEngine[] = [];
  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(url!);
    admin = postgres(url!, { max: 1, prepare: false, onnotice: () => {} });
  });
  afterAll(async () => {
    for (const engine of engines) await engine.disconnect().catch(() => {});
    await admin.end({ timeout: 1 });
  });

  async function setup(poolSize: number, change: (t: string, step: number) => string) {
    const table = 'stale_plan_' + randomUUID().replace(/-/g, '').slice(0, 12);
    await admin.unsafe(`CREATE TABLE ${table} (id int PRIMARY KEY, scopes text[], note text, spare text); INSERT INTO ${table} VALUES (1, '{read}', 'n', 's')`);
    const engine = new PostgresEngine();
    engines.push(engine);
    await engine.connect({ database_url: url!, poolSize });
    const select = `SELECT * FROM ${table} WHERE id=$1 FOR SHARE`;
    let step = 0;
    return {
      engine, select,
      inTx: () => engine.transaction(tx => tx.executeRaw<{ id: number }>(select, [1])),
      alter: () => admin.unsafe(change(table, step++)),
    };
  }

  /** Prepares the statement on every pooled connection: `n` transactions hold their connections at once. */
  async function primeEvery(engine: PostgresEngine, select: string, n: number) {
    let arrived = 0;
    let open!: () => void;
    const barrier = new Promise<void>(resolve => { open = resolve; });
    await Promise.all(Array.from({ length: n }, () => engine.transaction(async tx => {
      await tx.executeRaw(select, [1]);
      if (++arrived === n) open();
      await barrier;
    })));
  }

  test('a prepare: false pool (what a transaction-mode pooler URL gets) sends unnamed statements and is unchanged', async () => {
    const { select, alter, inTx: preparedInTx } = await setup(1, CHANGES[0][1]);
    const unnamed = postgres(url!, { max: 1, prepare: false, onnotice: () => {} });
    try {
      const inTx = () => unnamed.begin(tx => tx.unsafe(select, [1]));
      expect((await preparedInTx())[0]!.id).toBe(1);
      for (let i = 0; i < 2; i++) {
        expect(Array.from(await inTx() as Iterable<{ id: number }>)[0]!.id).toBe(1);
        await alter();
      }
      expect(await caught(preparedInTx())).toMatchObject({ code: '0A000' });
      expect(Array.from(await inTx() as Iterable<{ id: number }>)[0]!.id).toBe(1);
    } finally { await unnamed.end({ timeout: 1 }); }
  });

  /** A TCP relay to the database that can hold the server's answers back, to deliver one connection's reply late. */
  async function relay() {
    const target = new URL(url!);
    let held: Array<string | Buffer> | null = null;
    let client: net.Socket | null = null;
    const sockets: net.Socket[] = [];
    const server = net.createServer(c => {
      client = c;
      const s = net.connect(Number(target.port || 5432), target.hostname);
      sockets.push(c, s);
      c.on('data', d => s.write(d));
      s.on('data', d => { if (held) held.push(d); else c.write(d); });
      c.on('close', () => s.destroy()); s.on('close', () => c.destroy());
      c.on('error', () => {}); s.on('error', () => {});
    });
    const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
    const relayed = new URL(url!); relayed.hostname = '127.0.0.1'; relayed.port = String(port);
    return {
      url: relayed.toString(),
      hold() { held = []; },
      release() { const out = held ?? []; held = null; for (const d of out) client!.write(d); },
      close() { for (const s of sockets) s.destroy(); server.close(); },
    };
  }

  test('a statement described before the change but answered after the pool healed is not kept as prepared', async () => {
    const { select, alter } = await setup(1, CHANGES[0][1]);
    const types = new Map();
    const late = await relay();
    const a = postgres(url!, { max: 1, shared_types: types, onnotice: () => {} });
    const b = postgres(late.url, { max: 1, shared_types: types, onnotice: () => {} });
    try {
      expect(Array.from(await a.unsafe(select, [1], { prepare: true }) as Iterable<{ id: number }>)[0]!.id).toBe(1);
      await b.unsafe('SELECT 1');
      late.hold();
      const described = b.unsafe(select, [1], { prepare: true }).execute();
      await new Promise(resolve => setTimeout(resolve, 300));
      await alter();
      expect(Array.from(await a.unsafe(select, [1], { prepare: true }) as Iterable<{ id: number }>)[0]!.id).toBe(1);
      const unrelated = b.unsafe('SELECT 2 AS n').execute();
      late.release();
      await described;
      await unrelated;
      const inTx = await caught(b.begin(tx => tx.unsafe(select, [1], { prepare: true })));
      expect(inTx).toBeNull();
    } finally {
      await a.end({ timeout: 1 });
      await b.end({ timeout: 1 });
      late.close();
    }
  });

  for (const [name, change] of CHANGES) {
    test(`${name}: the in-transaction stale-plan error is retryable and the admission loop re-runs it with no caller-visible error`, async () => {
      const { inTx, alter } = await setup(1, change);
      expect((await inTx())[0]!.id).toBe(1);
      await alter();
      expect((await retryWriteAdmission(randomUUID(), () => inTx(), 5000))[0]!.id).toBe(1);
      await alter();
      const error = await caught(inTx());
      expect(error).toMatchObject({ code: '0A000', routine: 'RevalidateCachedQuery' });
      expect(transientDatabaseFailure(error)).toBe(true);
      expect((await inTx())[0]!.id).toBe(1);
    });

    test(`${name}: after one pooled connection healed, the other pooled connections do not fail`, async () => {
      const { engine, select, inTx, alter } = await setup(3, change);
      await primeEvery(engine, select, 3);
      await alter();
      expect((await engine.executeRaw<{ id: number }>(select, [1]))[0]!.id).toBe(1);
      expect(outcomes(await Promise.allSettled([inTx(), inTx(), inTx()]))).toEqual(['ok', 'ok', 'ok']);
      await primeEvery(engine, select, 3);
      await alter();
      expect(await caught(inTx())).toMatchObject({ code: '0A000', routine: 'RevalidateCachedQuery' });
      expect(outcomes(await Promise.allSettled([inTx(), inTx(), inTx()]))).toEqual(['ok', 'ok', 'ok']);
    });
  }
});

describe.skipIf(!url)('put_page after another connection adds a column to access_tokens (GST-2260)', () => {
  let engine: PostgresEngine;
  let close: () => Promise<void>;
  let databaseUrl: string;
  let token: string;
  beforeAll(async () => {
    ({ engine, close, databaseUrl } = await isolatedPersistencePostgres(url!));
    token = (await mintLegacyToken(engine, { name: 'writer-example', scopes: ['read', 'write'], takesHolders: ['world'] })).token;
  }, 240_000);
  afterAll(async () => { if (engine) await disposePersistenceConsumer(engine); await close?.(); }, 60_000);

  async function verify() {
    const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    return await provider.verifyAccessToken(token) as unknown as AuthInfo;
  }
  async function put(slug: string, auth: AuthInfo) {
    const out = await dispatchToolCall(engine, 'put_page', { slug, content: ['---', 'type: note', 'title: Stale plan', '---', '# Stale plan', '', 'Body ' + slug + '.'].join('\n'), request_id: randomUUID() },
      { remote: true, transport: 'http', auth, sourceId: auth.sourceId ?? 'default', takesHoldersAllowList: ['world'] });
    return { isError: out.isError === true, text: out.content.map(c => c.text).join('\n') };
  }

  /**
   * Several writes in a row, so the token read is prepared on most of the pool's connections before the column changes.
   * The token is verified once, before the change, so the first statement that meets the stale plan is the write's own
   * token read inside its admission transaction (a verify outside a transaction would heal the pool first).
   */
  test('a column added between writes leaves every later write with no error', async () => {
    const auth = await verify();
    for (let i = 0; i < 4; i++) expect(await put('notes/stale-plan-before-' + i, auth)).toMatchObject({ isError: false });
    const other = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} });
    try { await other.unsafe(`ALTER TABLE access_tokens ADD COLUMN stale_plan_probe_${randomUUID().slice(0, 8)} text`); }
    finally { await other.end({ timeout: 1 }); }
    const after: Array<{ isError: boolean; text: string }> = [];
    for (let i = 0; i < 4; i++) after.push(await put('notes/stale-plan-after-' + i, auth));
    expect(after.filter(out => out.isError).map(out => out.text)).toEqual([]);
    const [row] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE slug LIKE 'notes/stale-plan-%' AND deleted_at IS NULL");
    expect(row!.n).toBe(8);
  }, 240_000);
});

describe.skipIf(!url)('pure-database transactions outside the write paths after another connection adds a column (GST-2260)', () => {
  let engine: PostgresEngine;
  let close: () => Promise<void>;
  let databaseUrl: string;
  beforeAll(async () => { ({ engine, close, databaseUrl } = await isolatedPersistencePostgres(url!, 'instance', 1)); }, 240_000);
  afterAll(async () => { await close?.(); }, 60_000);
  async function addColumn(table: string) {
    const other = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} });
    try { await other.unsafe(`ALTER TABLE ${table} ADD COLUMN stale_plan_probe_${randomUUID().slice(0, 8)} text`); }
    finally { await other.end({ timeout: 1 }); }
  }

  test('an OAuth client-credentials grant whose locked client read meets the stale plan still issues a token', async () => {
    const secret = 'stale-plan-secret-' + randomUUID();
    await engine.executeRaw(`INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, grant_types, scope, token_endpoint_auth_method,
      client_id_issued_at) VALUES ('stale-plan-client', $1, 'stale-plan-client', '{}', '{client_credentials}', 'read write', 'client_secret_post', 0)`, [hashToken(secret)]);
    const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    expect((await provider.exchangeClientCredentials('stale-plan-client', secret, 'read')).access_token).toStartWith('gbrain_at_');
    await addColumn('oauth_clients');
    expect((await provider.exchangeClientCredentials('stale-plan-client', secret, 'read')).access_token).toStartWith('gbrain_at_');
  }, 60_000);

  test('a minion job whose completion meets the stale plan is completed, not failed after it ran', async () => {
    const queue = new MinionQueue(engine);
    const run = async (token: string, before?: () => Promise<void>) => {
      await queue.add('sync', { probe: token });
      const claimed = await queue.claim(token, 30_000, 'default', ['sync']);
      expect(claimed).not.toBeNull();
      await before?.();
      return queue.completeJob(claimed!.id, token, { done: token });
    };
    expect((await run('stale-plan-first'))?.status).toBe('completed');
    expect((await run('stale-plan-second', () => addColumn('minion_jobs')))?.status).toBe('completed');
  }, 60_000);
});
