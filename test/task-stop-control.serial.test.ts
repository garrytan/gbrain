import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProductTaskRuntime } from '../src/product/tasks/runtime';
import { taskArtifactPath } from '../src/product/tasks/checkpoint';
import { configPath } from '../src/core/config';
import type { BrainEngine } from '../src/core/engine';
import { WorkerPgliteEngine } from '../src/product/database/worker-engine';
import { MinionQueue } from '../src/core/minions/queue';
import { configureGateway, resetGateway } from '../src/core/ai/gateway';

const keys = ['PMBRAIN_HOME', 'GBRAIN_HOME', 'DATABASE_URL', 'PMBRAIN_DATABASE_URL', 'GBRAIN_DATABASE_URL'];
const saved = keys.map(key => process.env[key]);
let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'pmbrain-stop-control-'));
  for (const key of keys) delete process.env[key];
  process.env.PMBRAIN_HOME = home;
  process.env.GBRAIN_HOME = home;
  mkdirSync(join(home, '.pmbrain'));
  writeFileSync(configPath(), JSON.stringify({ engine: 'pglite', database_path: join(home, 'test.pglite') }));
});
afterAll(() => {
  for (const [index, key] of keys.entries()) {
    if (saved[index] === undefined) delete process.env[key];
    else process.env[key] = saved[index];
  }
  rmSync(home, { recursive: true, force: true });
});

for (const [index, kind] of ['dream_full', 'dream_capture_entities', 'import_path'].entries()) {
  test(`${kind} 数据库读取阻塞时先取消执行并保存停止意图，重复点击不重复停止`, async () => {
    const id = index + 1;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    let cancels = 0;
    const run = { id: `task-${id}`, kind, status: 'running', startedAt: new Date().toISOString(), error: null };
    const runtime = new ProductTaskRuntime({ kind: 'pglite', executeRaw: async () => { await gate; return []; } } as unknown as BrainEngine) as any;
    runtime.queue = {
      getJob: async () => { reads++; await gate; return null; },
      cancelJob: async () => { await gate; return null; },
      reconcilePrivateQueue: async () => [],
    };
    runtime.fileQueue = { pause: async () => {}, cleanupStoppedSnapshots: async () => {} };
    runtime.hydrateFiles = async () => {};
    runtime.fileProjection.flush = async () => {};
    runtime.executions.set(id, { cancel: () => { cancels++; }, done: gate, run: () => run });
    try {
      const start = performance.now();
      const stopping = await runtime.requestCancel(run.id);
      expect(performance.now() - start).toBeLessThan(1000);
      expect(stopping.error).toContain('正在停止');
      expect(cancels).toBe(1);
      expect(reads).toBe(0);
      expect(runtime.stopIntents.has(id)).toBe(true);
      expect(existsSync(taskArtifactPath(id, 'stop.json'))).toBe(true);
      expect(JSON.parse(readFileSync(taskArtifactPath(id, 'stop.json'), 'utf8')).id).toBe(id);
      await runtime.requestCancel(run.id);
      expect(cancels).toBe(1);
    } finally {
      release();
      await runtime.stoppingSessions.get(id);
    }
  });
}

test('启动恢复读取所有任务类型的停止命令，不让主动停止的实体任务复活', async () => {
  const seen: unknown[][] = [];
  const runtime = new ProductTaskRuntime({ kind: 'pglite', executeRaw: async (...args: unknown[]) => { seen.push(args); return []; } } as unknown as BrainEngine) as any;
  runtime.fileQueue = { pause: async () => {} };
  await runtime.loadStopIntents();
  expect([...runtime.stopIntents].sort()).toEqual([1, 2, 3]);
  expect(seen).toHaveLength(3);
  expect(seen.every(([sql]) => String(sql).includes('resumeOnRestart'))).toBe(true);
});

test('独立实体任务的同步 SQL 卡死后可停止恢复，提交保留并连续三十次原任务继续', async () => {
  configureGateway({ env: {} });
  const owner = new WorkerPgliteEngine();
  const engine = owner as unknown as BrainEngine;
  const runtime = new ProductTaskRuntime(engine) as any;
  let sql: Promise<unknown> | undefined;
  try {
    await engine.connect({ database_path: join(home, 'stop-recovery.pglite') });
    await engine.initSchema();
    await engine.putPage('committed', { type: 'note', title: '保留', compiled_truth: '停止前已经提交的资料' });
    const queue = new MinionQueue(engine);
    const job = await queue.add('pmbrain-product-task', { kind: 'dream_capture_entities', task: { type: 'dream', input: { phase: 'capture_entities' } } }, { queue: 'pmbrain-product' });
    await engine.executeRaw("UPDATE minion_jobs SET status='active',lock_token='stop-test',lock_until=now()+interval '1 hour' WHERE id=$1", [job.id]);
    const run = (await runtime.getRun(`task-${job.id}`))!;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    sql = engine.transaction(async tx => {
      await tx.putPage('uncommitted', { type: 'note', title: '回滚', compiled_truth: '停止时必须回滚的资料' });
      entered();
      await tx.executeRaw('DO $$ BEGIN LOOP PERFORM 1; END LOOP; END $$');
    });
    const settled = sql.then(() => undefined, () => undefined);
    runtime.executions.set(job.id, { cancel: () => {}, done: settled, run: () => run });
    await started;
    await Bun.sleep(80);
    const begin = performance.now();
    expect((await runtime.requestCancel(run.id)).error).toContain('正在停止');
    expect(performance.now() - begin).toBeLessThan(1000);
    expect((await runtime.cancel(run.id)).status).toBe('cancelled');
    expect(performance.now() - begin).toBeLessThan(15000);
    runtime.executions.delete(job.id);
    expect((await engine.getPage('committed'))?.compiled_truth).toContain('已经提交');
    expect(await engine.getPage('uncommitted')).toBeNull();
    for (let index = 0; index < 30; index++) {
      const resumed = await runtime.retry(run.id);
      expect(resumed.id).toBe(run.id);
      expect(resumed.status).toBe('queued');
      expect(existsSync(taskArtifactPath(job.id, 'stop.json'))).toBe(false);
      expect((await runtime.cancel(run.id)).status).toBe('cancelled');
    }
    expect((await queue.getJobs({ queue: 'pmbrain-product', limit: 100 })).filter(row => row.data.kind === 'dream_capture_entities')).toHaveLength(1);
  } finally {
    await owner.disconnect();
    await sql?.catch(() => {});
    resetGateway();
  }
}, 60000);
