import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { WorkerPgliteEngine } from '../src/product/database/worker-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { ProductTaskRuntime, PRODUCT_TASK_QUEUE } from '../src/product/tasks/runtime.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { enqueueImportedEntityCapture } from '../src/core/pmbrain-adapters/imported-entity-capture.ts';
import { requestImportedEntityCapture } from '../src/core/pmbrain-adapters/entity-capture-request.ts';
import { configPath } from '../src/core/config.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import { taskRoundCompleted, taskStatus } from '../admin/src/product/task-presentation.ts';
import type { ConsoleRun } from '../shared/contracts/common.ts';

let engine: BrainEngine, runtime: ProductTaskRuntime, root: string, server: ReturnType<typeof Bun.serve>;
let calls = 0, hold = false, invalid = false, usageInput = 20;
const releases = new Set<() => void>();
const keys = ['PMBRAIN_HOME', 'GBRAIN_HOME', 'DATABASE_URL', 'PMBRAIN_DATABASE_URL', 'GBRAIN_DATABASE_URL'];
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const databaseUrl = process.env.PMBRAIN_TASK_TEST_DATABASE_URL;
const dimensions = databaseUrl ? 1536 : 1024;

async function until(check: () => Promise<boolean>, timeout = 40_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await Bun.sleep(40); }
  throw new Error(JSON.stringify({ runs: (await runtime.listRuns()).map(run => ({ id: run.id, status: run.status, stage: run.product?.stage, error: run.error })), jobs: await engine.executeRaw('SELECT id,status,queue,error_text,private_queue_owner_job_id FROM minion_jobs ORDER BY id') }));
}

async function finished(id: string) {
  await until(async () => !['queued', 'running'].includes((await runtime.getRun(id))?.status ?? 'running'));
  return (await runtime.getRun(id))!;
}

function release() { hold = false; for (const finish of releases) finish(); releases.clear(); }

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pmbrain-orchestration-'));
  for (const key of keys) delete process.env[key];
  process.env.PMBRAIN_HOME = root; process.env.GBRAIN_HOME = root; mkdirSync(join(root, '.pmbrain'));
  if (databaseUrl) assertSafeE2eDatabaseUrl(databaseUrl);
  server = Bun.serve({ port: 0, async fetch(req) {
    const body = await req.json() as { input?: string | string[] };
    if (new URL(req.url).pathname.endsWith('/embeddings')) return Response.json({ object: 'list', data: (Array.isArray(body.input) ? body.input : [body.input]).map((_, index) => ({ object: 'embedding', index, embedding: Array.from({ length: dimensions }, (_, i) => i === 0 ? 1 : 0) })), model: 'isolated-embedding', usage: { prompt_tokens: 2, total_tokens: 2 } });
    calls++;
    if (hold) await new Promise<void>(finish => releases.add(finish));
    return Response.json({ id: `chat-${calls}`, object: 'chat.completion', created: 1, model: 'isolated-capture', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(invalid ? { entities: [], relations: [] } : { entities: [], relations: [], no_entities: true }) } }], usage: { prompt_tokens: usageInput, completion_tokens: 10, total_tokens: usageInput + 10 } });
  } });
  writeFileSync(configPath(), JSON.stringify({ engine: databaseUrl ? 'postgres' : 'pglite', custom_openai_api_key: 'isolated-only', embedding_model: 'custom-openai:isolated-embedding', embedding_dimensions: dimensions, provider_base_urls: { 'custom-openai': server.url.origin + '/v1' }, models: { default: 'custom-openai:isolated-capture' }, model_usage: { generative_enabled: true, embedding_enabled: true }, desktop: { knowledge_directory: root } }));
  engine = databaseUrl ? new PostgresEngine() : new WorkerPgliteEngine() as unknown as BrainEngine;
  await engine.connect(databaseUrl ? { database_url: databaseUrl } : {}); await engine.initSchema();
}, 60_000);

beforeEach(async () => {
  calls = 0; invalid = false; usageInput = 20; release();
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw("DELETE FROM config WHERE key LIKE 'dream.entity_capture.pending.%'");
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw('DELETE FROM gbrain_cycle_locks');
  await engine.executeRaw("UPDATE sources SET local_path=NULL WHERE id='default'");
  await engine.executeRaw("DELETE FROM sources WHERE id<>'default'");
  await engine.setConfig('dream.entity_capture.max_input_tokens', '1000000');
  runtime = new ProductTaskRuntime(engine); await runtime.start();
}, 30_000);

afterEach(async () => { release(); await runtime?.close(); }, 30_000);
afterAll(async () => {
  release(); await runtime?.close(); await engine?.disconnect(); server?.stop(true);
  for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
  if (root && resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('pmbrain-orchestration-')) rmSync(root, { recursive: true, force: true });
}, 60_000);

test('同步多份资料只有一个主任务，深度整理等待它完成，重复维护不再识别未变化资料', async () => {
  const repo = join(root, 'batch'); mkdirSync(repo);
  for (let i = 0; i < 5; i++) writeFileSync(join(repo, `input-${i}.md`), `---\ntitle: 批次资料${i}\ntype: note\n---\n这是用于保存原文及断点检查的测试资料，第${i}份。`);
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [repo]);
  hold = true;
  const quick = await runtime.submitDream({ preset: 'quick', sourceId: 'default' });
  const deep = await runtime.submitDream({ phase: 'backlinks', sourceId: 'default' });
  await until(async () => calls > 0);
  const jobs = await engine.executeRaw<{ kind: string }>("SELECT data->>'kind' AS kind FROM minion_jobs WHERE queue=$1", [PRODUCT_TASK_QUEUE]);
  expect(jobs.filter(job => job.kind === 'dream_capture_entities')).toHaveLength(0);
  expect(jobs.filter(job => job.kind === 'dream_quick')).toHaveLength(1);
  expect((await runtime.getRun(deep.id))?.status).toBe('queued');
  release();
  const done = await finished(quick.id);
  expect(done.status, JSON.stringify(done.result)).toBe('completed');
  const phases = (done.result as { phases: Array<{ phase: string; status: string; details: Record<string, any> }> }).phases;
  expect(phases.find(phase => phase.phase === 'capture_entities')?.details.pages_processed).toBe(5);
  expect(phases.find(phase => phase.phase === 'capture_entities')?.status).toBe('ok');
  const deepDone = await finished(deep.id);
  expect(deepDone.status).toBe('completed');
  expect((deepDone.result as { phases: Array<{ phase: string }> }).phases.some(phase => phase.phase === 'backlinks')).toBe(true);
  expect((deepDone.result as { reason?: string }).reason).not.toBe('cycle_already_running');
  const count = calls;
  const next = await runtime.submitDream({ preset: 'quick', sourceId: 'default' });
  expect((await finished(next.id)).status).toBe('completed');
  expect(calls).toBe(count);
  for (let i = 0; i < 5; i++) expect((await engine.getPage(`input-${i}`, { sourceId: 'default' }))?.compiled_truth).toContain(`第${i}份`);
}, 90_000);

test('一个维护的多个Source共用Token预算，继续原任务也不会重置预算', async () => {
  const first=join(root,'budget-first'),second=join(root,'budget-second');mkdirSync(first);mkdirSync(second);
  writeFileSync(join(first,'first.md'),'# 第一个资料\n\n这是第一个知识源的独立原文。');
  writeFileSync(join(second,'second.md'),'# 第二个资料\n\n这是第二个知识源的独立原文。');
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'",[first]);
  await engine.executeRaw("INSERT INTO sources(id,name,local_path) VALUES('budget-other','第二个源',$1)",[second]);
  usageInput = 60000;
  await engine.setConfig('dream.entity_capture.max_input_tokens','60000');
  const quick=await runtime.submitDream({preset:'quick',allSources:true});
  const done=await finished(quick.id);
  expect(done.status,JSON.stringify(done.result)).toBe('completed');
  expect(calls).toBe(1);
  expect(done.product?.metrics).toContainEqual({label:'剩余页面',value:1});
  const resumed=await runtime.retry(quick.id);expect(resumed?.id).toBe(quick.id);
  expect((await finished(quick.id)).status).toBe('completed');expect(calls).toBe(1);
  await engine.setConfig('dream.entity_capture.max_input_tokens','120000');
  await runtime.retry(quick.id);expect((await finished(quick.id)).status).toBe('completed');expect(calls).toBe(2);
  expect((await engine.getPage('first',{sourceId:'default'}))?.compiled_truth).toContain('第一个知识源');
  expect((await engine.getPage('second',{sourceId:'budget-other'}))?.compiled_truth).toContain('第二个知识源');
  expect(await engine.getPage('second',{sourceId:'default'})).toBeNull();
  await engine.setConfig('dream.entity_capture.max_input_tokens','1000000');
},90_000);

test('停止并重启后，待识别资料仍属于原维护，不能重新派生自动整理',async()=>{
  const repo=join(root,'stopped');mkdirSync(repo);
  for(let i=0;i<3;i++)writeFileSync(join(repo,`stop-${i}.md`),`# 停止资料${i}\n\n这些原文在停止及继续后都应完整保留。`);
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'",[repo]);
  hold=true;
  const quick=await runtime.submitDream({preset:'quick',sourceId:'default'});
  await until(async()=>calls>0);
  await runtime.cancel(quick.id);release();await runtime.close();
  expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE private_queue_owner_job_id=$1 AND status IN ('waiting','active','delayed')", [Number(quick.id.slice(5))])).toHaveLength(0);
  runtime=new ProductTaskRuntime(engine);await runtime.start();await Bun.sleep(250);
  expect((await runtime.listRuns()).filter(run=>run.kind==='dream_capture_entities')).toHaveLength(0);
  const resumed=await runtime.retry(quick.id);expect(resumed?.id).toBe(quick.id);
  expect((await finished(quick.id)).status).toBe('completed');
  for(let i=0;i<3;i++)expect((await engine.getPage(`stop-${i}`,{sourceId:'default'}))?.compiled_truth).toContain('完整保留');
},90_000);

test('同步父任务等待文件时不另建实体任务，其他Source独立导入仍可入队', async () => {
  await runtime.close();
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('other','另一个源')");
  await engine.setConfig('dream.entity_capture.pending.default', JSON.stringify({ nonce: 'one', slugs: ['notes/one'] }));
  await engine.setConfig('dream.entity_capture.pending.other', JSON.stringify({ nonce: 'two', slugs: ['notes/two'] }));
  const queue = new MinionQueue(engine);
  const parent = await queue.add('pmbrain-product-task', { kind: 'dream_quick', task: { type: 'dream', input: { preset: 'quick', sourceId: 'default' } } }, { queue: PRODUCT_TASK_QUEUE });
  await engine.executeRaw("UPDATE minion_jobs SET status='waiting-children' WHERE id=$1", [parent.id]);
  await requestImportedEntityCapture(engine,'default',{slug:'notes/three',type:'note',compiled_truth:'等待文件同步完成的完整原文资料。',frontmatter:{}});
  expect(JSON.parse((await engine.getConfig('dream.entity_capture.pending.default'))!).ownerJobId).toBe(parent.id);
  const submitted = await enqueueImportedEntityCapture(engine, async () => true);
  expect(submitted).toHaveLength(1);
  const job = await queue.getJob(submitted[0]!);
  expect((job?.data.task as { input: { sourceId: string } }).input.sourceId).toBe('other');
  expect(await engine.getConfig('dream.entity_capture.pending.default')).not.toBeNull();
  expect(await engine.getConfig('dream.entity_capture.pending.other')).toBeNull();
  await engine.executeRaw("UPDATE minion_jobs SET status='cancelled' WHERE id=$1",[parent.id]);
  expect(await enqueueImportedEntityCapture(engine,async()=>true)).toEqual([]);
});

test('历史跳过记录读成未执行失败，不能绿色完成，也不改写历史记录', async () => {
  await runtime.close();
  const queue = new MinionQueue(engine);
  const job = await queue.add('pmbrain-product-task', { kind: 'dream_full', task: { type: 'dream', input: { preset: 'full' } } }, { queue: 'held-history' });
  const result = { status: 'skipped', reason: 'cycle_already_running', phases: [], totals: {} };
  await engine.executeRaw("UPDATE minion_jobs SET queue=$2,status='completed',result=$3::jsonb,finished_at=now() WHERE id=$1", [job.id, PRODUCT_TASK_QUEUE, result]);
  const run = (await runtime.getRun(`task-${job.id}`))!;
  expect(run.status).toBe('failed'); expect(run.product?.errorReason).toContain('未执行');
  expect(taskRoundCompleted(run as ConsoleRun)).toBe(false); expect(taskStatus(run as ConsoleRun)).toBe('未执行');
  expect((await queue.getJob(job.id))?.status).toBe('completed');
  expect((await queue.getJob(job.id))?.result).toEqual(result);
});

test('外部周期锁占用时保留同一排队任务，释放后真正执行，排队时可以停止', async () => {
  const lock = (await tryAcquireDbLock(engine, 'gbrain-cycle:default'))!;
  expect(lock).not.toBeNull();
  try {
    const deep = await runtime.submitDream({ phase: 'backlinks', sourceId: 'default' });
    let waiting: ConsoleRun | undefined;
    await until(async () => { const run = await runtime.getRun(deep.id); if (run?.status === 'queued' && run.product?.stage === '等待前面的整理任务完成') waiting = run as ConsoleRun; return !!waiting; });
    expect(waiting?.status).toBe('queued');
    expect(taskRoundCompleted(waiting!)).toBe(false);
    await lock.release();
    const done = await finished(deep.id);
    expect(done.status).toBe('completed');
    expect((done.result as { phases: unknown[] }).phases).not.toHaveLength(0);
    const nextLock = (await tryAcquireDbLock(engine, 'gbrain-cycle:default'))!;
    try {
      const quick = await runtime.submitDream({ preset: 'quick', sourceId: 'default' });
      await until(async () => { const run = await runtime.getRun(quick.id); return run?.status === 'queued' && run.product?.stage === '等待前面的整理任务完成'; });
      expect((await runtime.submitDream({ preset: 'quick', sourceId: 'default' })).id).toBe(quick.id);
      expect((await runtime.cancel(quick.id))?.status).toBe('cancelled');
      expect((await runtime.listRuns()).map(run => run.id).sort()).toEqual([deep.id, quick.id].sort());
    } finally { await nextLock.release(); }
  } finally { await lock.release(); }
}, 60_000);

test('实体校验失败留在快速维护主任务，可在原任务继续，不自动开启另一轮', async () => {
  const repo = join(root, 'invalid'); mkdirSync(repo);
  writeFileSync(join(repo, 'input.md'), '# 校验资料\n\n这份资料用于确认无效回执不会被假装成功。');
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [repo]);
  invalid = true;
  const quick = await runtime.submitDream({ preset: 'quick', sourceId: 'default' });
  const done = await finished(quick.id);
  expect(done.status).toBe('failed'); expect(done.product?.errorReason).toContain('ingest');
  expect((await runtime.listRuns()).filter(run => run.kind === 'dream_capture_entities')).toHaveLength(0);
  const count = calls; await Bun.sleep(350); expect(calls).toBe(count);
  invalid = false;
  const resumed = await runtime.retry(quick.id);
  expect(resumed?.id).toBe(quick.id);
  expect((await finished(quick.id)).status).toBe('completed');
  expect(await engine.getPage('input', { sourceId: 'default' })).not.toBeNull();
}, 90_000);
