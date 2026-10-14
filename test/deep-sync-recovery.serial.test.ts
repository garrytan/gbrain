import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import type { BrainEngine } from '../src/core/engine.ts';
import { WorkerPgliteEngine } from '../src/product/database/worker-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { ProductTaskRuntime, PRODUCT_TASK_QUEUE } from '../src/product/tasks/runtime.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { TaskProgressAdapter } from '../src/product/tasks/progress-adapter.ts';
import { SYNC_FILE_QUEUE } from '../src/product/tasks/sync-file-queue.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';

const database = process.env.PMBRAIN_TASK_TEST_DATABASE_URL;
const keys = ['PMBRAIN_HOME', 'GBRAIN_HOME', 'DATABASE_URL', 'PMBRAIN_DATABASE_URL', 'GBRAIN_DATABASE_URL'];
const saved = keys.map(key => process.env[key]);
let home: string, engine: BrainEngine;
let modelServer: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'pmbrain-deep-sync-'));
  keys.forEach(key => delete process.env[key]);
  process.env.PMBRAIN_HOME = home; process.env.GBRAIN_HOME = home;
  mkdirSync(join(home, '.pmbrain'));
  modelServer = Bun.serve({ port: 0, fetch: () => Response.json({ id: 'isolated-deep', object: 'chat.completion', model: 'isolated-capture', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ entities: [], relations: [], no_entities: true }) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) });
  writeFileSync(join(home, '.pmbrain', 'config.json'), JSON.stringify({ engine: database ? 'postgres' : 'pglite', custom_openai_api_key: 'isolated-only', provider_base_urls: { 'custom-openai': modelServer.url.origin + '/v1' }, models: { default: 'custom-openai:isolated-capture' }, model_usage: { embedding_enabled: false, generative_enabled: true } }));
  if (database) assertSafeE2eDatabaseUrl(database);
  engine = database ? new PostgresEngine() : new WorkerPgliteEngine() as unknown as BrainEngine;
  await engine.connect(database ? { database_url: database } : {}); await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine?.disconnect();
  modelServer?.stop(true);
  keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
  if (home) {
    if (!resolve(home).startsWith(resolve(tmpdir()) + sep + 'pmbrain-deep-sync-')) throw new Error('测试目录范围不正确');
    rmSync(home, { recursive: true, force: true });
  }
}, 60000);

async function ended(runtime: ProductTaskRuntime, id: string) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const run = await runtime.getRun(id);
    if (run && !['running', 'queued'].includes(run.status)) return run;
    await Bun.sleep(30);
  }
  throw new Error(JSON.stringify(await runtime.getRun(id)));
}

test('深度整理的同步超过快照窗口后在同一任务分批完成，只导入 Git 已提交内容', async () => {
  const repo = join(home, 'git-source'); mkdirSync(repo);
  const content = '# 提交资料\n\n分批同步保留原始资料与已提交范围。\n';
  for (const name of ['one.md', 'two.md', 'three.md']) writeFileSync(join(repo, name), content + name);
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
  writeFileSync(join(repo, 'one.md'), '# 未提交修改\n\n这份修改不应自动进入深度整理。');
  writeFileSync(join(repo, 'untracked.md'), '# 未提交新资料');
  const original = readFileSync(join(repo, 'one.md'));
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES ('deep-git','深度同步验收',$1,'{}'::jsonb)", [repo]);
  const runtime = new ProductTaskRuntime(engine, { snapshotQuotaBytes: Buffer.byteLength(content + 'three.md') * 2 });
  await runtime.start();
  try {
    const run = await runtime.submitDream({ preset: 'full', sourceId: 'deep-git', maxPages: 1 });
    const done = await ended(runtime, run.id);
    expect(done.status, JSON.stringify(done)).toBe('completed');
    const files = await runtime.files(run.id);
    expect(files?.rows).toHaveLength(3);
    expect(files?.rows.every(file => file.status === 'completed')).toBe(true);
    expect((await engine.getPage('one', { sourceId: 'deep-git' }))?.compiled_truth).toContain('分批同步');
    expect(await engine.getPage('untracked', { sourceId: 'deep-git' })).toBeNull();
    expect(readFileSync(join(repo, 'one.md'))).toEqual(original);
    const snapshots = await engine.executeRaw<{ path: string }>("SELECT data->'task'->'input'->>'path' AS path FROM minion_jobs WHERE queue=$1 AND parent_job_id=$2", [SYNC_FILE_QUEUE, Number(run.id.slice(5))]);
    expect(snapshots.every(file => !existsSync(file.path))).toBe(true);
    expect((await runtime.listRuns()).filter(item => item.kind === 'dream_full')).toHaveLength(1);
    expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE queue=$1 AND data->>'kind'='dream_capture_entities' AND data->'task'->'input'->>'sourceId'='deep-git'", [PRODUCT_TASK_QUEUE])).toHaveLength(0);
  } finally { await runtime.close(); }
}, 90000);

test('深度整理同步中断后继续原任务，已完成同步阶段之后的模型工作不自动重跑', async () => {
  const repo = join(home, 'resume-source'); mkdirSync(repo); writeFileSync(join(repo, 'resume.md'), '# 继续资料\n\n保持同一个任务。');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES ('deep-resume','深度续跑验收',$1,'{}'::jsonb)", [repo]);
  const queue = new MinionQueue(engine);
  const paused = await queue.add('pmbrain-product-task', { kind: 'dream_sync', fileSession: true, task: { type: 'dream', input: { phase: 'sync', sourceId: 'deep-resume', checkpoint: { phases: {}, reports: {} } } } }, { queue: PRODUCT_TASK_QUEUE, delay: 86400000 });
  await engine.executeRaw("UPDATE minion_jobs SET status='paused',attempts_started=1 WHERE id=$1", [paused.id]);
  const uncertain = await queue.add('pmbrain-product-task', { kind: 'dream_full', fileSession: true, task: { type: 'dream', input: { preset: 'full', sourceId: 'deep-resume', checkpoint: { phases: { 'deep-resume': [{ phase: 'sync', status: 'ok', summary: '完成同步', duration_ms: 1, details: {} }] }, reports: {} } } } }, { queue: PRODUCT_TASK_QUEUE, delay: 86400000 });
  await engine.executeRaw("UPDATE minion_jobs SET status='active',lock_token='old-service',lock_until=now()-interval '1 minute' WHERE id=$1", [uncertain.id]);
  const runtime = new ProductTaskRuntime(engine); await runtime.start();
  try {
    expect((await queue.getJob(uncertain.id))?.status).toBe('paused');
    const retried = await runtime.retry(`task-${paused.id}`);
    expect(retried?.id).toBe(`task-${paused.id}`);
    expect((await ended(runtime, retried!.id)).status).toBe('completed');
    expect((await queue.getJob(uncertain.id))?.status).toBe('paused');
  } finally { await runtime.close(); }
}, 90000);

test('深度整理同步文件进度持续可见，不只显示完成了一个步骤', () => {
  const adapter = new TaskProgressAdapter('dream_full');
  adapter.plan(['lint', 'sync', 'synthesize']);
  adapter.event({ phase: 'cycle.sync', event: 'start' });
  adapter.event({ phase: 'import.files', event: 'tick', done: 12, total: 529 });
  expect(adapter.view.processed).toBe(12);
  expect(adapter.view.total).toBe(529);
  expect(adapter.view.phasePercent).toBeGreaterThan(0);
});

test('深度整理大文档分批写库时显示文件与提交进度，完成后内容和分块完整保留', async () => {
  const repo = join(home, 'large-source'); mkdirSync(repo);
  const zip = new JSZip();
  const paragraphs = Array.from({ length: 160 }, (_, index) => `<w:p><w:r><w:t>章节 ${index}：${'资料正文与验收说明。'.repeat(150)}</w:t></w:r></w:p>`).join('');
  zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`);
  const path = join(repo, 'large.docx'); writeFileSync(path, await zip.generateAsync({ type: 'uint8array' }));
  const original = readFileSync(path);
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES ('deep-large','大文档同步验收',$1,'{}'::jsonb)", [repo]);
  const wrap = (owner: BrainEngine): BrainEngine => new Proxy(owner, { get(target, property) {
    if (property === 'transaction') return (fn: (tx: BrainEngine) => Promise<unknown>) => target.transaction(tx => fn(wrap(tx)));
    if (property === 'upsertChunks') return async (...args: Parameters<BrainEngine['upsertChunks']>) => { await Bun.sleep(150); return target.upsertChunks(...args); };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const runtime = new ProductTaskRuntime(wrap(engine)); await runtime.start();
  try {
    const run = await runtime.submitDream({ preset: 'full', sourceId: 'deep-large', maxPages: 1 });
    let writing = false;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const current = await runtime.getRun(run.id);
      writing ||= !!current?.product?.activeFiles?.some(file => file.path === 'large.docx' && (file.bodyWritten ?? 0) > 0 && (file.chunksTotal ?? 0) > 100);
      if (current && !['running', 'queued'].includes(current.status)) break;
      await Bun.sleep(50);
    }
    const done = await ended(runtime, run.id);
    expect(done.status, JSON.stringify(done)).toBe('completed');
    expect(writing, JSON.stringify(done.product)).toBe(true);
    const [file] = await engine.executeRaw<{ slug: string }>("SELECT result->>'slug' AS slug FROM minion_jobs WHERE queue=$1 AND parent_job_id=$2", [SYNC_FILE_QUEUE, Number(run.id.slice(5))]);
    expect((await engine.getChunks(file.slug, { sourceId: 'deep-large' })).length).toBeGreaterThan(100);
    expect((await engine.getPage(file.slug, { sourceId: 'deep-large' }))?.compiled_truth).toContain('章节 159');
    expect(readFileSync(path)).toEqual(original);
  } finally { await runtime.close(); }
}, 90000);

test('深度整理停止及服务重启后仍保持停止，确认继续时复用已完成文件与原任务', async () => {
  const repo = join(home, 'stop-source'); mkdirSync(repo);
  for (let index = 0; index < 12; index++) writeFileSync(join(repo, `file-${index}.md`), `# 停止续跑 ${index}\n\n原任务中的资料 ${index}。`);
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES ('deep-stop','停止续跑验收',$1,'{}'::jsonb)", [repo]);
  const wrap = (owner: BrainEngine): BrainEngine => new Proxy(owner, { get(target, property) {
    if (property === 'transaction') return (fn: (tx: BrainEngine) => Promise<unknown>) => target.transaction(tx => fn(wrap(tx)));
    if (property === 'upsertChunks') return async (...args: Parameters<BrainEngine['upsertChunks']>) => { await Bun.sleep(200); return target.upsertChunks(...args); };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  let runtime = new ProductTaskRuntime(wrap(engine)); await runtime.start();
  let id = '';
  try {
    id = (await runtime.submitDream({ preset: 'full', sourceId: 'deep-stop', maxPages: 1 })).id;
    const scanDeadline = Date.now() + 40000;
    while (Date.now() < scanDeadline) {
      if ((await runtime.getRun(id))?.product?.syncScan?.active) break;
      await Bun.sleep(50);
    }
    expect((await runtime.getRun(id))?.product?.syncScan?.active).toBe(true);
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      if ((await runtime.getRun(id))?.product?.syncFiles?.completed) break;
      await Bun.sleep(30);
    }
    expect((await runtime.cancel(id))?.status).toBe('cancelled');
    const [before] = await engine.executeRaw<{ count: number }>("SELECT count(*)::int AS count FROM minion_jobs WHERE queue=$1 AND parent_job_id=$2 AND status='completed'", [SYNC_FILE_QUEUE, Number(id.slice(5))]);
    expect(before.count).toBeGreaterThan(0); expect(before.count).toBeLessThan(12);
    await runtime.close(); runtime = new ProductTaskRuntime(engine); await runtime.start();
    expect((await runtime.getRun(id))?.status).toBe('cancelled');
    expect((await runtime.retry(id))?.id).toBe(id);
    expect((await ended(runtime, id)).status).toBe('completed');
    const files = await runtime.files(id);
    expect(files?.rows).toHaveLength(12); expect(files?.rows.every(file => file.status === 'completed')).toBe(true);
  } finally { await runtime.close(); }
}, 90000);
