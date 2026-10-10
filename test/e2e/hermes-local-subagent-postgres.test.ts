/** Native PostgreSQL proof: cached admission, committed writes, receipt access and replay. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { prepareLocalSubagent } from '../../src/core/minions/submission-authority.ts';
import { localSubagentTools } from '../../src/core/minions/local-subagent.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../../src/core/persistence/identity.ts';
import { submitPageMutation, preparePageAdmission, withBatchAdmission } from '../../src/core/persistence/page-mutations.ts';
import { ownRequestAccessible, authorizeStoredRequest } from '../../src/core/persistence/authority.ts';
import { preadmitReads } from '../../src/core/persistence/preadmit-cache.ts';
import { resetWriteSwitches } from '../../src/core/persistence/switches.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';

const suite = hasDatabase() ? describe : describe.skip;
suite('native Postgres local-subagent authority', () => {
  let home: string;
  let queue: MinionQueue;
  let registration: Awaited<ReturnType<typeof registerLocalWriter>>;
  const oldHome = process.env.GBRAIN_HOME;
  const oldCeiling = process.env.GIT_CEILING_DIRECTORIES;
  const oldCache = process.env.GBRAIN_PREADMIT_CACHE;
  const sourceId = 'hermes-pg-child';
  const operations = ['get_page', 'put_page'];
  const prefixes = ['wiki/originals/*'];
  const context = (): OperationContext => ({ engine: getEngine(), config: { engine: 'postgres', embedding_disabled: true },
    remote: false, sourceId, dryRun: false, logger: { info() {}, warn() {}, error() {} } });

  beforeAll(async () => {
    home = mkdtempSync(join(process.env.TMPDIR!, 'hermes-local-pg-'));
    process.env.GBRAIN_HOME = home;
    process.env.GIT_CEILING_DIRECTORIES = dirname(realpathSync(home));
    expect(Bun.spawnSync(['git', '-C', home, 'rev-parse', '--show-toplevel'], { env: process.env }).exitCode).not.toBe(0);
    delete process.env.GBRAIN_PREADMIT_CACHE;
    resetWriteSwitches();
    await setupDB();
    expect(getEngine().kind).toBe('postgres');
    await getEngine().executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    registration = await registerLocalWriter(getEngine(), 'cli', { sourceIds: ['*'], scopes: ['read', 'write'], operations: null, slugPrefixes: null });
    await getEngine().setConfig('embedding_disabled', 'true');
    await getEngine().setConfig('facts.extraction_enabled', 'false');
    queue = new MinionQueue(getEngine());
  }, 120_000);
  afterAll(async () => {
    if (queue) {
      await disposePersistenceConsumer(getEngine());
      await teardownDB();
    }
    if (home) rmSync(home, { recursive: true, force: true });
    if (oldHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = oldHome;
    if (oldCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = oldCeiling;
    if (oldCache === undefined) delete process.env.GBRAIN_PREADMIT_CACHE; else process.env.GBRAIN_PREADMIT_CACHE = oldCache;
    resetWriteSwitches();
  });

  async function accepted() {
    const engine = getEngine();
    const data = { source_id: sourceId, prompt: 'Synthetic PG acceptance; no model invocation.',
      allowed_tools: operations, allowed_slug_prefixes: prefixes };
    const trusted = await withVerifiedLocalRegistration(engine, registration, () =>
      prepareLocalSubagent(context(), randomUUID(), 'subagent', data, operations, prefixes));
    const queueName = `hermes-pg-${randomUUID()}`;
    const job = await queue.add('subagent', data, { queue: queueName }, trusted);
    const owner = randomUUID();
    expect((await queue.claim(owner, 60_000, queueName, ['subagent']))?.id).toBe(job.id);
    const localSubagent = await localSubagentTools(engine, job.id, data);
    expect(localSubagent).toBeTruthy();
    const ctx: OperationContext = { ...context(), remote: true, viaSubagent: true, jobId: job.id, subagentId: job.id,
      allowedSlugPrefixes: prefixes, localSubagent };
    return { ctx, job, owner };
  }
  const put = (ctx: OperationContext, slug: string, requestId = randomUUID()) => submitPageMutation(ctx,
    { operation: 'put_page', params: { slug, request_id: requestId, content: '---\ntype: note\ntitle: Native PG proof\nvisibility: world\n---\n\nA synthetic committed page proves the native PostgreSQL path.' } });

  test('default cache is available, opaque-capability write commits, then receipt/replay preserve identity', async () => {
    const engine = getEngine();
    const a = await accepted();
    const view = await preadmitReads(engine);
    expect(view).not.toBeNull();
    expect(view).not.toBe(engine);
    const requestId = randomUUID();
    const slug = `wiki/originals/pg-${requestId.slice(0, 8)}`;
    await expect(preparePageAdmission({ ...a.ctx, engine: view! }, { operation: 'put_page', params: { slug, content: 'No proxy admission' } })).rejects.toThrow('binding');
    const result = await put(a.ctx, slug, requestId);
    expect(result.state).toBe('committed');
    expect((await engine.getPage(slug, { sourceId }))?.compiled_truth).toContain('native PostgreSQL path');
    const [row] = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
    expect(row.authority).toMatchObject({ remote: true, principal: { kind: 'local_cli', id: registration.id }, localSubagent: { acceptedJobId: a.job.id } });
    expect(await ownRequestAccessible(a.ctx, row)).toBe(true);
    expect((await put(a.ctx, slug, requestId)).state).toBe('committed');
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE request_id=$1::uuid', [requestId])).toHaveLength(1);
    await queue.completeJob(a.job.id, a.owner, { done: true });
    await engine.executeRaw('DELETE FROM minion_jobs WHERE id=$1', [a.job.id]);
    await authorizeStoredRequest(engine, row);
    const replay = await withVerifiedLocalRegistration(engine, registration, () => put(context(), slug, requestId));
    expect(replay.state).toBe('committed');
  }, 60_000);

  test('batch admission retains the capability engine without registering a different transport', async () => {
    const a = await accepted();
    await withBatchAdmission(a.ctx, async (own, shared) => {
      expect(own.engine).toBe(getEngine());
      expect(shared.engine).toBe(getEngine());
      const requestId = randomUUID();
      expect((await put(shared, `wiki/originals/batch-${requestId.slice(0, 8)}`, requestId)).state).toBe('committed');
    });
    const fake: OperationContext = { ...a.ctx, localSubagent: { kind: 'local_subagent_capability' } };
    await expect(withBatchAdmission(fake, (_own, shared) => put(shared, 'wiki/originals/forged-batch'))).rejects.toThrow('binding');
    expect(await getEngine().getPage('wiki/originals/forged-batch', { sourceId })).toBeNull();
    await queue.completeJob(a.job.id, a.owner, { done: true });
  }, 60_000);

  test('publication authorization holds the live CLI grant against concurrent revocation', async () => {
    const engine = getEngine();
    const a = await accepted();
    const requestId = randomUUID();
    const slug = `wiki/originals/lock-${requestId.slice(0, 8)}`;
    expect((await put(a.ctx, slug, requestId)).state).toBe('committed');
    const [row] = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
    let unlock!: () => void;
    let locked!: () => void;
    const release = new Promise<void>(resolve => { unlock = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const authorization = engine.transaction(async tx => {
      await authorizeStoredRequest(tx, row, true);
      locked();
      await release;
    });
    try {
      await Promise.race([acquired, authorization.then(() => { throw new Error('authorization exited before locking'); })]);
      await expect(engine.transaction(async tx => {
        await tx.executeRaw("SET LOCAL lock_timeout='100ms'");
        await tx.executeRaw('UPDATE persistence_local_writers SET revoked_at=now() WHERE id=$1::uuid', [registration.id]);
      })).rejects.toMatchObject({ code: '55P03' });
    } finally { unlock(); await authorization; }
    await engine.executeRaw('UPDATE persistence_local_writers SET revoked_at=now() WHERE id=$1::uuid', [registration.id]);
    await expect(authorizeStoredRequest(engine, row)).rejects.toMatchObject({ code: 'permission_denied' });
  }, 60_000);
});
