import { afterAll, beforeAll, expect, test } from 'bun:test';
import { WorkerPgliteEngine } from '../src/product/database/worker-engine';
import type { BrainEngine } from '../src/core/engine';
import { configureGateway, resetGateway } from '../src/core/ai/gateway';
import { withDatabasePriority } from '../src/product/database/priority';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseAlreadyOwnedError } from '../src/core/pglite-errors';
import {tryAcquireDbLock} from '../src/core/db-lock';
import {TaskEngineHost} from '../src/product/tasks/engine-host';

let engine: BrainEngine;
const originalHome = [process.env.PMBRAIN_HOME, process.env.GBRAIN_HOME];
let home: string;
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'pmbrain-database-worker-'));
  process.env.PMBRAIN_HOME = home;
  process.env.GBRAIN_HOME = home;
  configureGateway({ env: {} });
  engine = new WorkerPgliteEngine() as unknown as BrainEngine;
  await engine.connect({database_path:join(home,'brain.pglite')});
  await engine.initSchema();
}, 60000);
afterAll(async () => {
  await engine?.disconnect(); resetGateway();
  for (const [index, key] of ['PMBRAIN_HOME', 'GBRAIN_HOME'].entries()) {
    if (originalHome[index] === undefined) delete process.env[key]; else process.env[key] = originalHome[index];
  }
  if (home) rmSync(home, { recursive: true, force: true });
}, 60000);

test('重数据库计算期间服务线程仍能响应不读数据库的请求', async () => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ models: ['test-model'] }) });
  try {
    let finished = false;
    const query = engine.executeRaw('SELECT sum(sqrt(i)) FROM generate_series(1, 6000000) i').finally(() => { finished = true; });
    await Bun.sleep(60);
    const started = performance.now();
    expect((await (await fetch(server.url)).json() as any).models).toEqual(['test-model']);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(finished).toBe(false);
    await query;
  } finally { server.stop(true); }
}, 30000);

test('数据库同步 SQL 不返回时可结束唯一执行进程，原生重开保留提交并回滚未提交内容', async () => {
  const owner = engine as unknown as WorkerPgliteEngine;
  await engine.putPage('recovery/committed', {type:'note',title:'已提交',compiled_truth:'停止不能丢失这份资料'});
  let entered!: () => void;
  const started = new Promise<void>(resolve => {entered=resolve;});
  const active = engine.transaction(async tx => {
    await tx.putPage('recovery/pending',{type:'note',title:'未提交',compiled_truth:'这个事务必须回滚'});
    entered();
    await tx.executeRaw('DO $$ BEGIN LOOP PERFORM 1; END LOOP; END $$');
  });
  void active.catch(()=>{});
  await started; await Bun.sleep(100);
  const start = performance.now();
  await owner.interruptAndRecover();
  expect(performance.now()-start).toBeLessThan(15000);
  await expect(active).rejects.toThrow();
  expect((await engine.getPage('recovery/committed'))?.compiled_truth).toContain('不能丢失');
  expect(await engine.getPage('recovery/pending')).toBeNull();
}, 30000);

test('同一所有者的事务回滚，嵌套写入使用保存点，时间与 Map 保留类型', async () => {
  await expect(engine.transaction(async tx => {
    await tx.setConfig('worker.rollback', 'bad');
    await tx.transaction(async nested => { await nested.setConfig('worker.nested', 'bad'); });
    throw new Error('rollback requested');
  })).rejects.toThrow('rollback requested');
  expect(await engine.getConfig('worker.rollback')).toBeNull();
  expect(await engine.getConfig('worker.nested')).toBeNull();
  await engine.transaction(async tx => {
    await tx.setConfig('worker.commit', 'kept');
    await tx.transaction(async nested => { await nested.setConfig('worker.nested', 'discarded'); throw new Error('nested rollback'); }).catch(() => {});
  });
  expect(await engine.getConfig('worker.commit')).toBe('kept');
  expect(await engine.getConfig('worker.nested')).toBeNull();
  const page = await engine.putPage('worker-types', { type: 'note', title: '合成资料', compiled_truth: '保持类型' }, { sourceId: 'default' });
  expect(page.updated_at instanceof Date).toBe(true);
  expect(await engine.resolveSlugsByPaths(['missing.md'], { sourceId: 'default' }) instanceof Map).toBe(true);
});

test('任务已有事务内事实写入不再依赖不存在的嵌套 db.transaction', async () => {
  await engine.transaction(async tx => {
    const fact = await tx.insertFact({ fact: '数据库 Worker 的隔离事实', kind: 'fact', source: 'test' }, { source_id: 'default' });
    expect(fact.id).toBeGreaterThan(0);
  });
});

test('当前事务不被打断，提交后用户、MCP、导入、后台按优先级和同级顺序执行', async () => {
  let ready!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  const active = withDatabasePriority(3, () => engine.transaction(async tx => {
    await tx.setConfig('priority', 'uncommitted');
    ready();
    await gate;
    await tx.setConfig('priority', 'committed');
    order.push('transaction');
  }));
  await started;
  const enqueue = (priority: 0 | 1 | 2 | 3, label: string) => withDatabasePriority(priority,
    () => engine.getConfig('priority').then(value => { expect(value).toBe('committed'); order.push(label); }));
  const waiting = [enqueue(3, 'background-1'), enqueue(2, 'import'), enqueue(1, 'mcp'), enqueue(0, 'user'), enqueue(3, 'background-2')];
  await Bun.sleep(60);
  expect(order).toEqual([]);
  release();
  await Promise.all([active, ...waiting]);
  expect(order).toEqual(['transaction', 'user', 'mcp', 'import', 'background-1', 'background-2']);
});

test('同一数据目录只允许一个 Worker 所有者，关闭重开保留内容', async () => {
  const previous = process.env.PMBRAIN_PGLITE_LOCK_FAIL_FAST;
  process.env.PMBRAIN_PGLITE_LOCK_FAIL_FAST = '1';
  const config = { database_path: join(home, 'reopen-db') };
  const first = new WorkerPgliteEngine() as unknown as BrainEngine;
  const second = new WorkerPgliteEngine() as unknown as BrainEngine;
  try {
    await first.connect(config);
    await first.initSchema();
    await first.setConfig('reopen.kept', 'kept');
    const rejected = await second.connect(config).catch(error => error);
    expect(rejected instanceof DatabaseAlreadyOwnedError).toBe(true);
    await second.disconnect();
    await first.disconnect();
    await second.connect(config);
    expect(await second.getConfig('reopen.kept')).toBe('kept');
  } finally {
    await first.disconnect();
    await second.disconnect();
    if (previous === undefined) delete process.env.PMBRAIN_PGLITE_LOCK_FAIL_FAST;
    else process.env.PMBRAIN_PGLITE_LOCK_FAIL_FAST = previous;
  }
}, 30000);

const RENEW_LOCK_SQL = `UPDATE minion_jobs SET lock_until = now() + ($1::double precision * interval '1 millisecond'), updated_at = now()
       WHERE id = $2 AND lock_token = $3 AND status = 'active'
       RETURNING id`;

for(const rollback of [false,true])test(`同步锁在长写事务内能及时续期，${rollback?'回滚':'提交'}后续期仍有效`,async()=>{
  const handles=await Promise.all(['sync-a','sync-b'].map(id=>tryAcquireDbLock(engine,`gbrain-sync:${id}`,0.05)));
  let ready!:()=>void,release!:()=>void;
  const opened=new Promise<void>(resolve=>{ready=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const active=engine.transaction(async tx=>{await tx.setConfig('cycle-renewal-test','pending');ready();await gate;if(rollback)throw new Error('requested rollback');});
  const settled=active.then(()=>null,error=>error);
  try{
    await opened;
    const refreshing=Promise.all(handles.map(handle=>handle!.refresh()));
    const winner=await Promise.race([refreshing.then(values=>({values})),Bun.sleep(1500).then(()=>({values:null}))]);
    expect(winner.values).toEqual([true,true]);
    release();await settled;
    const rows=await engine.executeRaw<{id:string;refreshed:boolean}>("SELECT id,last_refreshed_at>acquired_at AS refreshed FROM gbrain_cycle_locks WHERE id=ANY($1::text[]) ORDER BY id",[handles.map(handle=>handle!.id)]);
    expect(rows).toHaveLength(2);expect(rows.every(row=>row.refreshed)).toBe(true);
  }finally{release();await settled;for(const handle of handles)await handle?.release();}
},30_000);

test('真实后台任务 Host 的同步锁续期不再新开一个等待自身结束的事务',async()=>{
  const token='cycle-host-token',id=await insertActiveJob(token);
  const host=new TaskEngineHost(engine,id,token,async()=>{});
  let scope:number|undefined;
  const call=(method:string,args:unknown[],scope?:number)=>host.dispatch({type:'rpc',id:1,method,args,scope});
  try{
    await call('executeRaw',[`INSERT INTO gbrain_cycle_locks(id,holder_pid,holder_host,acquired_at,ttl_expires_at,last_refreshed_at)
      VALUES($1,$2,'test',now(),now()+interval '3 seconds',now()) RETURNING id`,['gbrain-sync:host',process.pid]]);
    scope=await call('transaction.open',[]) as number;
    await call('setConfig',['cycle-host-pending','uncommitted'],scope);
    const renew=call('executeRaw',[`UPDATE gbrain_cycle_locks SET ttl_expires_at=now()+$3::interval,last_refreshed_at=now()
      WHERE id=$1 AND holder_pid=$2 RETURNING id`,['gbrain-sync:host',process.pid,'30 minutes']]);
    expect(await Promise.race([renew,Bun.sleep(1500).then(()=>null)])).toEqual([{id:'gbrain-sync:host'}]);
    const rolledBack=await call('scope.close',[false],scope).catch(error=>error);scope=undefined;
    expect(String(rolledBack)).toContain('任务事务已回滚');
    expect(await engine.getConfig('cycle-host-pending')).toBeNull();
    const [lock]=await engine.executeRaw<{remaining:number;holder_pid:number}>("SELECT EXTRACT(EPOCH FROM(ttl_expires_at-now()))::int remaining,holder_pid FROM gbrain_cycle_locks WHERE id=$1",['gbrain-sync:host']);
    expect(lock!.remaining).toBeGreaterThan(1700);expect(lock!.holder_pid).toBe(process.pid);
  }finally{if(scope!==undefined)await call('scope.close',[false],scope).catch(()=>{});await host.close();await engine.executeRaw('DELETE FROM minion_jobs WHERE id=$1',[id]);}
},30_000);

async function insertActiveJob(token: string): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs (name, queue, status, lock_token, lock_until, data)
     VALUES ('pmbrain-product-task', 'pmbrain-product', 'active', $1, now() + interval '1 second', '{}'::jsonb)
     RETURNING id`,
    [token],
  );
  return Number(rows[0].id);
}

async function remainingLockMs(id: number): Promise<number> {
  const rows = await engine.executeRaw<{ remaining_ms: string | number }>(
    `SELECT EXTRACT(EPOCH FROM (lock_until - now())) * 1000 AS remaining_ms FROM minion_jobs WHERE id = $1`,
    [id],
  );
  return Number(rows[0]?.remaining_ms ?? 0);
}

function startRenewal(id: number, token: string): { renewed: Promise<{ id: number }[]>; finished: Promise<void> } {
  const renewed = engine.executeRaw<{ id: number }>(RENEW_LOCK_SQL, [30_000, id, token]);
  const finished = Promise.race([
    renewed.then(rows => rows.length > 0 ? 'renewed' : 'missed'),
    Bun.sleep(2000).then(() => 'timeout'),
  ]).then(winner => { expect(winner).toBe('renewed'); });
  return { renewed, finished };
}

test('同步占着事务时，任务锁续期不用等这批提交，普通读取仍然要等', async () => {
  const token = 'renew-while-open';
  const id = await insertActiveJob(token);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const active = engine.transaction(async tx => {
    await tx.executeRaw('SELECT 1');
    ready();
    await gate;
    await tx.executeRaw('SELECT 1');
  });
  try {
    await started;
    let readDone = false;
    const read = engine.getConfig('lock-renewal-wait').finally(() => { readDone = true; });
    const renewal = startRenewal(id, token);
    try {
      await renewal.finished;
      expect(readDone).toBe(false);
      release();
      await active;
      await read;
      expect(await remainingLockMs(id)).toBeGreaterThan(20_000);
    } finally {
      release();
      await renewal.renewed.catch(() => {});
    }
  } finally {
    release();
    await active.catch(() => {});
    await engine.executeRaw('DELETE FROM minion_jobs WHERE id = $1', [id]);
  }
}, 30000);

test('同步事务回滚后，已经续上的任务锁仍然保留', async () => {
  const token = 'renew-after-rollback';
  const id = await insertActiveJob(token);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const active = engine.transaction(async tx => {
    await tx.executeRaw('SELECT 1');
    ready();
    await gate;
    throw new Error('rollback requested');
  });
  const rollback = active.then(() => null, error => error);
  try {
    await started;
    const renewal = startRenewal(id, token);
    try {
      await renewal.finished;
      release();
      expect((await rollback)?.message).toBe('rollback requested');
      expect(await remainingLockMs(id)).toBeGreaterThan(20_000);
    } finally {
      release();
      await renewal.renewed.catch(() => {});
    }
  } finally {
    release();
    await active.catch(() => {});
    await engine.executeRaw('DELETE FROM minion_jobs WHERE id = $1', [id]);
  }
}, 30000);

test('内层保存点回滚不会丢掉刚刚续上的任务锁', async () => {
  const token = 'renew-after-savepoint';
  const id = await insertActiveJob(token);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const active = engine.transaction(async tx => {
    await tx.transaction(async () => {
      ready();
      await gate;
      throw new Error('savepoint rollback');
    }).catch(error => {
      if (!(error instanceof Error) || error.message !== 'savepoint rollback') throw error;
    });
    const rows = await tx.executeRaw<{ remaining_ms: string | number }>(
      `SELECT EXTRACT(EPOCH FROM (lock_until - now())) * 1000 AS remaining_ms FROM minion_jobs WHERE id = $1`,
      [id],
    );
    expect(Number(rows[0]?.remaining_ms ?? 0)).toBeGreaterThan(20_000);
  });
  try {
    await started;
    const renewal = startRenewal(id, token);
    try {
      await renewal.finished;
      release();
      await active;
      expect(await remainingLockMs(id)).toBeGreaterThan(20_000);
    } finally {
      release();
      await renewal.renewed.catch(() => {});
    }
  } finally {
    release();
    await active.catch(() => {});
    await engine.executeRaw('DELETE FROM minion_jobs WHERE id = $1', [id]);
  }
}, 30000);
