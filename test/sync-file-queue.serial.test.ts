import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { ProductTaskRuntime } from '../src/product/tasks/runtime.ts';
import { configPath } from '../src/core/config.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { SYNC_FILE_QUEUE, SYNC_FILE_TASK } from '../src/product/tasks/sync-file-queue.ts';
import { execFileSync } from 'node:child_process';
import type { SyncFileInput } from '../src/product/tasks/types.ts';
import { WorkerPgliteEngine } from '../src/product/database/worker-engine.ts';
import { TaskEngineHost } from '../src/product/tasks/engine-host.ts';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { PRODUCT_TASK_QUEUE } from '../src/product/tasks/runtime.ts';
import { taskModelFingerprint } from '../src/product/tasks/checkpoint.ts';
import { importFile } from '../src/core/import-file.ts';

const keys = ['GBRAIN_HOME', 'PMBRAIN_HOME', 'DATABASE_URL', 'GBRAIN_DATABASE_URL', 'PMBRAIN_DATABASE_URL'];
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const database = process.env.PMBRAIN_TASK_TEST_DATABASE_URL;
let root: string;
let engine: BrainEngine;
let runtime: ProductTaskRuntime;

async function finish(id: string) {
  const deadline=Date.now()+(process.env.PMBRAIN_TASK_TEST_WORKER==='1'?300_000:180_000);
  while(Date.now()<deadline) {
    const run = await runtime.getRun(id);
    if (run && !['queued', 'running'].includes(run.status)) return run;
    await Bun.sleep(50);
  }
  throw new Error(`任务未结束：${id} ${JSON.stringify(await runtime.getRun(id))}`);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pmbrain-sync-queue-test-'));
  for (const key of keys) delete process.env[key];
  process.env.GBRAIN_HOME = root;
  process.env.PMBRAIN_HOME = root;
  mkdirSync(join(root, '.pmbrain'));
  writeFileSync(configPath(), JSON.stringify({ engine: database ? 'postgres' : 'pglite', model_usage: { embedding_enabled: false, generative_enabled: false } }));
  if (database) assertSafeE2eDatabaseUrl(database);
  engine = database ? new PostgresEngine() : process.env.PMBRAIN_TASK_TEST_WORKER === '1' ? new WorkerPgliteEngine() as unknown as BrainEngine : new PGLiteEngine();
  await engine.connect(database ? { database_url: database } : process.env.PMBRAIN_TASK_TEST_WORKER==='1'?{database_path:join(root,'brain.pglite')}:{});
  await engine.initSchema();
  runtime = new ProductTaskRuntime(engine);
  await runtime.start();
}, 60000);

afterAll(async () => {
  await runtime?.close();
  await engine?.disconnect();
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  if (root) rmSync(root, { recursive: true, force: true });
}, 60000);

describe('快速维护文件任务与恢复', () => {
  test.skipIf(!database && process.env.PMBRAIN_TASK_TEST_WORKER!=='1')('1MB 与 3MB 正文批次进度真实可见，写入阻塞可停止，未提交正文回滚后继续',async()=>{
    const dir=join(root,'large-progress');mkdirSync(dir);
    const content=(sections:number)=>'# 大文件处理验收\n\n'+Array.from({length:sections},(_,i)=>`## 第 ${i} 节\n\n`+'正文保持有意义的中文段落以测试可信结构切分和逐批写入。'.repeat(120)+'\n\n').join('');
    writeFileSync(join(dir,'large-one.md'),content(140));
    writeFileSync(join(dir,'large-three.md'),content(420));
    expect(statSync(join(dir,'large-one.md')).size).toBeGreaterThan(1_000_000);
    expect(statSync(join(dir,'large-three.md')).size).toBeGreaterThan(3_000_000);
    await engine.executeRaw("INSERT INTO sources (id,name,local_path,config) VALUES ($1,$2,$3,$4::jsonb)",['large-progress','大文件验收',dir,{syncEnabled:true}]);
    await engine.executeRaw(`CREATE FUNCTION pmbrain_large_blocked() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.chunk_index>=100 AND EXISTS(SELECT 1 FROM pages WHERE id=NEW.page_id AND source_id='large-progress' AND slug='large-three') THEN ${database?'PERFORM pg_sleep(60);':'LOOP PERFORM 1; END LOOP;'} END IF; RETURN NEW; END $$`);
    await engine.executeRaw('CREATE TRIGGER pmbrain_large_blocked BEFORE INSERT OR UPDATE ON content_chunks FOR EACH ROW EXECUTE FUNCTION pmbrain_large_blocked()');
    const run=await runtime.submitDream({preset:'quick',sourceId:'large-progress'});
    let activity;
    for(let i=0;i<1600;i++){
      activity=(await runtime.files(run.id))?.rows.find(row=>row.path==='large-three.md')?.activity;
      if(activity?.bodyWritten===100&&activity.operation==='upsertChunks')break;
      await Bun.sleep(25);
    }
    expect(activity?.bodyWritten).toBe(100);expect(activity?.bodyCommitted).toBe(false);
    expect(activity?.bytes).toBe(statSync(join(dir,'large-three.md')).size);
    if(!database)expect((await runtime.files(run.id))?.rows.filter(row=>row.status==='running')).toHaveLength(1);
    expect(runtime.cachedRuns().find(row=>row.id===run.id)?.product?.activeFiles?.some(file=>file.bodyWritten===100)).toBe(true);
    await runtime.cancel(run.id);
    expect(await engine.getPage('large-three',{sourceId:'large-progress'})).not.toBeNull();
    expect(await engine.getChunks('large-three',{sourceId:'large-progress'})).toHaveLength(100);
    expect((await engine.executeRaw<{chunker_version:number}>("SELECT chunker_version FROM pages WHERE slug='large-three' AND source_id='large-progress'"))[0].chunker_version).toBeLessThan(0);
    await engine.executeRaw('DROP TRIGGER pmbrain_large_blocked ON content_chunks');await engine.executeRaw('DROP FUNCTION pmbrain_large_blocked()');
    await runtime.retry(run.id);expect((await finish(run.id)).status).toBe('completed');
    for(const slug of ['large-one','large-three']){
      expect((await engine.getChunks(slug,{sourceId:'large-progress'})).length).toBeGreaterThan(100);
      expect((await importFile(engine,join(dir,slug+'.md'),slug+'.md',{sourceId:'large-progress',noEmbed:true,checkOnly:true})).error).toBeUndefined();
    }
  },180000);
  test.skipIf(!database && process.env.PMBRAIN_TASK_TEST_WORKER!=='1')('真实 SQL 阻塞时文件明细快速返回，停止完成，重开不重跑且旧数据保留',async()=>{
    const dir=join(root,'blocked');mkdirSync(dir);
    writeFileSync(join(dir,'blocked.md'),'# 卡住的合成资料\n\n事务未提交前必须能停止。');
    await engine.executeRaw("INSERT INTO sources (id,name,local_path,config) VALUES ($1,$2,$3,$4::jsonb)",['blocked-source','停止测试',dir,{syncEnabled:true}]);
    await engine.putPage('retained',{type:'note',title:'保留',compiled_truth:'以前已提交的内容'},{sourceId:'blocked-source'});
    await engine.executeRaw(`CREATE FUNCTION pmbrain_test_blocked() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.source_id='blocked-source' AND NEW.slug='blocked' THEN ${database?'PERFORM pg_sleep(60);':'LOOP PERFORM 1; END LOOP;'} END IF; RETURN NEW; END $$`);
    await engine.executeRaw('CREATE TRIGGER pmbrain_test_blocked BEFORE INSERT OR UPDATE ON pages FOR EACH ROW EXECUTE FUNCTION pmbrain_test_blocked()');
    const run=await runtime.submitDream({preset:'quick',sourceId:'blocked-source'});
    let running=false;
    for(let i=0;i<1200;i++){
      const files=await runtime.files(run.id);
      if(files?.rows.some(row=>row.status==='running'&&row.activity?.operation==='putPage')){running=true;break;}
      await Bun.sleep(20);
    }
    expect(running).toBe(true);
    const readStart=performance.now();
    const details=await runtime.files(run.id);
    expect(performance.now()-readStart).toBeLessThan(1000);
    expect(details?.rows[0].path).toBe('blocked.md');
    const stopStart=performance.now();await runtime.cancel(run.id);
    expect(performance.now()-stopStart).toBeLessThan(20000);
    expect((await runtime.getRun(run.id))?.status).toBe('cancelled');
    expect(await engine.getPage('blocked',{sourceId:'blocked-source'})).toBeNull();
    expect((await engine.getPage('retained',{sourceId:'blocked-source'}))?.compiled_truth).toContain('以前已提交');
    await engine.executeRaw('DROP TRIGGER pmbrain_test_blocked ON pages');await engine.executeRaw('DROP FUNCTION pmbrain_test_blocked()');
    await runtime.close();runtime=new ProductTaskRuntime(engine);await runtime.start();
    expect((await runtime.getRun(run.id))?.status).toBe('cancelled');
    expect(await engine.getPage('blocked',{sourceId:'blocked-source'})).toBeNull();
    await runtime.retry(run.id);expect((await finish(run.id)).status).toBe('completed');
    expect(await engine.getPage('blocked',{sourceId:'blocked-source'})).not.toBeNull();
  },120000);
  test('旧版已有页面但没有文件任务回执，未变化资料在入队前跳过，变化与跨 Source 文件仍处理', async () => {
    const dir = join(root, 'legacy'); mkdirSync(dir);
    const other = join(root, 'legacy-other'); mkdirSync(other);
    for (let i = 0; i < 12; i++) writeFileSync(join(dir, `legacy-${i}.md`), `# 旧版资料 ${i}\n\n升级前已经导入的合成资料。`);
    await engine.executeRaw("INSERT INTO sources (id,name,local_path,config) VALUES ($1,$2,$3,$4::jsonb)", ['legacy-source', '旧版升级', dir, {syncEnabled:true}]);
    await engine.executeRaw("INSERT INTO sources (id,name,local_path,config) VALUES ($1,$2,$3,$4::jsonb)", ['legacy-other', '另一个知识源', other, {syncEnabled:true}]);
    for (let i = 0; i < 12; i++) await importFile(engine, join(dir, `legacy-${i}.md`), `legacy-${i}.md`, {noEmbed:true,sourceId:'legacy-source'});
    await engine.executeRaw("UPDATE pages SET chunker_version=0 WHERE source_id='legacy-source' AND slug='legacy-2'");
    await engine.executeRaw("DELETE FROM content_chunks WHERE page_id=(SELECT id FROM pages WHERE source_id='legacy-source' AND slug='legacy-3')");
    writeFileSync(join(dir, 'legacy-0.md'), '# 旧版资料 0\n\n升级后修改了这一份。');
    writeFileSync(join(other, 'legacy-1.md'), readFileSync(join(dir, 'legacy-1.md')));
    const before = await engine.executeRaw<{count:string}>("SELECT count(*)::text AS count FROM minion_jobs WHERE queue=$1 AND data->'task'->'input'->'options'->>'sourceId'=$2",[SYNC_FILE_QUEUE,'legacy-source']);
    expect(Number(before[0].count)).toBe(0);
    const done = await finish((await runtime.submitDream({preset:'quick',sourceId:'legacy-source'})).id);
    expect(done.product?.syncScan).toMatchObject({scanned:12,unchanged:10});
    expect(done.product?.processed).toBe(2);
    expect((await runtime.files(done.id))?.rows).toHaveLength(2);
    expect((await engine.getChunks('legacy-3',{sourceId:'legacy-source'})).length).toBeGreaterThan(0);
    expect((await engine.executeRaw<{chunker_version:number}>("SELECT chunker_version FROM pages WHERE source_id='legacy-source' AND slug='legacy-2'"))[0].chunker_version).toBe(0);
    expect((await engine.getPage('legacy-0',{sourceId:'legacy-source'}))?.compiled_truth).toContain('修改');
    const otherDone = await finish((await runtime.submitDream({preset:'quick',sourceId:'legacy-other'})).id);
    expect((await runtime.files(otherDone.id))?.rows).toHaveLength(1);
    expect(await engine.getPage('legacy-1',{sourceId:'legacy-other'})).not.toBeNull();
  }, 120000);
  test('快速维护默认同步未提交变化并本地提交，重复和重命名保留 Source 隔离', async () => {
    const dir = join(root, 'git-source'); mkdirSync(dir);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git('init'); git('config', 'user.email', 'synthetic@example.invalid'); git('config', 'user.name', 'Synthetic test');
    writeFileSync(join(dir, 'same.md'), '# Same\n\n已提交的隔离资料。');
    git('add', '.'); git('commit', '-m', 'synthetic baseline');
    await engine.executeRaw("INSERT INTO sources (id, name, local_path, config) VALUES ($1, $2, $3, $4::jsonb)", ['git-queue', 'Git 测试', dir, { syncEnabled: true }]);
    await finish((await runtime.submitDream({ preset: 'quick', sourceId: 'git-queue' })).id);
    writeFileSync(join(dir, 'same.md'), '# Same\n\n未提交的新内容。');
    const previousCommit=git('rev-parse','HEAD').toString().trim();
    await finish((await runtime.submitDream({ preset: 'quick', sourceId: 'git-queue' })).id);
    expect((await engine.getPage('same', { sourceId: 'git-queue' }))?.compiled_truth).toContain('未提交');
    expect(git('status','--porcelain').toString().trim()).toBe('');
    const syncedCommit=git('rev-parse','HEAD').toString().trim();
    expect(syncedCommit).not.toBe(previousCommit);
    await finish((await runtime.submitDream({ preset: 'quick', sourceId: 'git-queue' })).id);
    expect((await engine.getPage('same', { sourceId: 'git-queue' }))?.compiled_truth).toContain('未提交');
    expect(git('rev-parse','HEAD').toString().trim()).toBe(syncedCommit);
    git('mv', 'same.md', 'renamed.md'); git('commit', '-m', 'synthetic rename');
    await finish((await runtime.submitDream({ preset: 'quick', sourceId: 'git-queue' })).id);
    expect(await engine.getPage('same', { sourceId: 'git-queue' })).toBeNull();
    expect((await engine.getPage('renamed', { sourceId: 'git-queue' }))?.compiled_truth).toContain('未提交');
    const other = join(root, 'other-source'); mkdirSync(other);
    writeFileSync(join(other, 'renamed.md'), '# Renamed\n\n另一个 Source 的独立内容。');
    await engine.executeRaw("INSERT INTO sources (id, name, local_path, config) VALUES ($1, $2, $3, $4::jsonb)", ['other-queue', '另一个源', other, { syncEnabled: true }]);
    await finish((await runtime.submitDream({ preset: 'quick', sourceId: 'other-queue' })).id);
    expect((await engine.getPage('renamed', { sourceId: 'other-queue' }))?.compiled_truth).toContain('独立内容');
    expect((await engine.getPage('renamed', { sourceId: 'git-queue' }))?.compiled_truth).toContain('未提交');
  }, 180000);

  test('单个坏文件独立失败，正常文件完成；不变资料不生成新的处理任务', async () => {
    const dir = join(root, 'materials');
    mkdirSync(dir);
    for (let i = 0; i < 24; i++) writeFileSync(join(dir, `file-${i}.md`), `# 文件 ${i}\n\n隔离合成资料 ${i}。`);
    writeFileSync(join(dir, 'bad.md'), '# Bad\n\n' + 'x'.repeat(5_000_001));
    await engine.executeRaw("INSERT INTO sources (id, name, local_path, config) VALUES ($1, $2, $3, $4::jsonb)", ['queue-source', '队列测试', dir, { syncEnabled: true }]);
    const first = await finish((await runtime.submitDream({ preset: 'quick', sourceId: 'queue-source' })).id);
    expect((first.result as Record<string, unknown>)?.status).toBe('partial');
    const queue = new MinionQueue(engine);
    const sourceFiles = async () => (await queue.getJobs({ queue: SYNC_FILE_QUEUE, limit: 100 })).filter(row => (row.data.task as { input: SyncFileInput }).input.options.sourceId === 'queue-source');
    const children = await sourceFiles();
    expect(children.length).toBe(25);
    expect(children.filter(row => row.result?.status === 'failed')).toHaveLength(1);
    const details = await runtime.files(first.id);
    expect(details?.rows).toHaveLength(25);
    expect(details?.rows.filter(row => row.status === 'failed')).toHaveLength(1);
    expect(details?.rows.every(row => !row.path.includes(root))).toBe(true);
    expect(await runtime.files('task-9999999')).toBeNull();
    for (let i = 0; i < 24; i++) expect(await engine.getPage(`file-${i}`, { sourceId: 'queue-source' })).not.toBeNull();
    const second = await finish((await runtime.submitDream({ preset: 'quick', sourceId: 'queue-source' })).id);
    expect((second.result as Record<string, unknown>)?.status).toBe('partial');
    const after = await sourceFiles();
    expect(after.filter(row => row.result?.status === 'imported')).toHaveLength(24);
    expect(after).toHaveLength(26);
    writeFileSync(join(dir, 'file-0.md'), '# 文件 0\n\n只修改这一份资料。');
    await finish((await runtime.submitDream({ preset: 'quick', sourceId: 'queue-source' })).id);
    expect((await engine.getPage('file-0', { sourceId: 'queue-source' }))?.compiled_truth).toContain('只修改');
    expect(readFileSync(join(dir, 'file-1.md'), 'utf8')).toContain('隔离合成资料 1');
  }, 180000);

  test('停止保留完成文件和未处理状态，继续及重启恢复只补剩余文件', async () => {
    const dir = join(root, 'resume'); mkdirSync(dir);
    for (let i = 0; i < 120; i++) writeFileSync(join(dir, `resume-${i}.md`), `# Resume ${i}\n\n合成资料用于测试文件队列停止和恢复。`);
    await engine.executeRaw("INSERT INTO sources (id, name, local_path, config) VALUES ($1, $2, $3, $4::jsonb)", ['resume-source', '续跑测试', dir, { syncEnabled: true }]);
    const accepted = await runtime.submitDream({ preset: 'quick', sourceId: 'resume-source' });
    let observed = false;
    const observeDeadline=Date.now()+90_000;
    while(Date.now()<observeDeadline) {
      const run = await runtime.getRun(accepted.id);
      if ((run?.product?.processed ?? 0) > 0 && (run?.product?.processed ?? 0) < 120) { observed = true; break; }
      await Bun.sleep(20);
    }
    expect(observed,JSON.stringify({run:await runtime.getRun(accepted.id),files:await runtime.files(accepted.id)})).toBe(true);
    expect((await runtime.submitDream({ preset: 'quick', sourceId: 'resume-source' })).id).toBe(accepted.id);
    const firstPage = await runtime.files(accepted.id);
    expect(firstPage?.rows).toHaveLength(50);
    expect(firstPage?.next).not.toBeNull();
    const nextPage = await runtime.files(accepted.id, firstPage!.next!);
    expect(nextPage?.rows).toHaveLength(50);
    expect(nextPage?.rows.some(row => firstPage?.rows.some(previous => previous.id === row.id))).toBe(false);
    await runtime.cancel(accepted.id);
    const stopped = await finish(accepted.id);
    expect(stopped.status).toBe('cancelled');
    const files = await new MinionQueue(engine).getJobs({ queue: SYNC_FILE_QUEUE, limit: 200 });
    const own = files.filter(row => row.data.sessionId === Number(accepted.id.slice(5)));
    expect(own.some(row => row.status === 'paused')).toBe(true);
    expect(own.some(row => row.result?.status === 'failed')).toBe(false);
    await runtime.close();
    runtime = new ProductTaskRuntime(engine); await runtime.start();
    expect((await runtime.getRun(accepted.id))?.status).toBe('cancelled');
    const resumed = await runtime.retry(accepted.id);
    expect(resumed?.id).toBe(accepted.id);
    expect((await finish(accepted.id)).status).toBe('completed');
    for (let i = 0; i < 120; i++) expect(await engine.getPage(`resume-${i}`, { sourceId: 'resume-source' })).not.toBeNull();
    const done = (await new MinionQueue(engine).getJobs({ queue: SYNC_FILE_QUEUE, limit: 200 })).filter(row => row.data.sessionId === Number(accepted.id.slice(5)));
    expect(done).toHaveLength(120);
    expect(done.every(row => row.status === 'completed')).toBe(true);
  }, process.env.PMBRAIN_TASK_TEST_WORKER==='1'?360000:180000);

  test('软件退出后自动继续同步文件，已提交而未确认的文件不重复创建版本', async () => {
    const dir = join(root, 'auto-resume'); mkdirSync(dir);
    for (let i = 0; i < 36; i++) writeFileSync(join(dir, `auto-${i}.md`), `# Auto ${i}\n\n隔离自动恢复资料 ${i}。`);
    await engine.executeRaw("INSERT INTO sources (id, name, local_path, config) VALUES ($1, $2, $3, $4::jsonb)", ['auto-resume-source', '自动恢复', dir, { syncEnabled: true }]);
    const accepted = await runtime.submitDream({ preset: 'quick', sourceId: 'auto-resume-source' });
    for (let i = 0; i < 1000; i++) {
      if ((await runtime.getRun(accepted.id))?.product?.processed) break;
      await Bun.sleep(20);
    }
    await runtime.close();
    runtime = new ProductTaskRuntime(engine); await runtime.start();
    expect((await finish(accepted.id)).status).toBe('completed');
    expect((await new MinionQueue(engine).getJobs({ queue: SYNC_FILE_QUEUE, limit: 300 })).filter(row => row.data.sessionId === Number(accepted.id.slice(5)))).toHaveLength(36);
    const versions = await engine.executeRaw<{ count: string }>(`SELECT count(*)::text AS count FROM page_versions v JOIN pages p ON p.id = v.page_id WHERE p.source_id = $1`, ['auto-resume-source']);
    expect(Number(versions[0].count)).toBe(0);
  }, 180000);

  test('正文事务中的完成回执阻止崩溃窗口重复解析和重复版本', async () => {
    const dir = join(root, 'receipt'); mkdirSync(dir);
    writeFileSync(join(dir, 'receipt.md'), '# Receipt\n\n正文与任务回执一起提交的隔离资料。');
    await engine.executeRaw("INSERT INTO sources (id, name, local_path, config) VALUES ($1, $2, $3, $4::jsonb)", ['receipt-source', '原子回执', dir, { syncEnabled: true }]);
    const accepted = await runtime.submitDream({ preset: 'quick', sourceId: 'receipt-source' });
    await finish(accepted.id);
    await runtime.close();
    const parentId = Number(accepted.id.slice(5));
    await engine.executeRaw(`UPDATE minion_jobs SET status = 'active', lock_token = 'synthetic-expired', lock_until = now() - interval '1 minute',
      data = jsonb_set(jsonb_set(data, '{task,input,modelMayRun}', 'true'::jsonb), '{task,input,options,documentOcr}', 'true'::jsonb)
      WHERE queue = $1 AND (data->>'sessionId')::bigint = $2`, [SYNC_FILE_QUEUE, parentId]);
    const parent = await new MinionQueue(engine).getJob(parentId);
    const task = parent!.data.task as { type: string; input: { checkpoint?: { phases: Record<string, unknown[]>; reports: Record<string, unknown> } } };
    task.input.checkpoint = { phases: {}, reports: {} };
    await engine.executeRaw(`UPDATE minion_jobs SET status = 'waiting-children', data = $2::jsonb WHERE id = $1`, [parentId, { ...parent!.data, task }]);
    runtime = new ProductTaskRuntime(engine); await runtime.start();
    expect((await finish(accepted.id)).status).toBe('completed');
    const rows = await engine.executeRaw<{ attempts_started: number; status: string }>(`SELECT attempts_started, status FROM minion_jobs WHERE queue = $1 AND (data->>'sessionId')::bigint = $2`, [SYNC_FILE_QUEUE, parentId]);
    expect(rows[0].status).toBe('completed');
    expect(rows[0].attempts_started).toBe(1);
  }, 90000);

  test('文件在事务中改变时整页回滚，原有知识与分块保持可读', async () => {
    const dir = join(root, 'guard'); mkdirSync(dir);
    const original = join(dir, 'guard.md');
    const snapshot = join(root, 'guard-copy.md');
    const content = '# Guard\n\n隔离原始内容';
    writeFileSync(original, content); writeFileSync(snapshot, content);
    const info = statSync(original);
    await engine.executeRaw("INSERT INTO sources (id, name, local_path, config) VALUES ($1, $2, $3, $4::jsonb)", ['guard-source', '提交校验', dir, { syncEnabled: true }]);
    await engine.putPage('guard', { type: 'note', title: 'Guard', compiled_truth: '原有知识', frontmatter: {} }, { sourceId: 'guard-source' });
    const queue = new MinionQueue(engine);
    await queue.add('fixture-sync-guard', {}, { queue: 'fixture-sync-guard' });
    const job = (await queue.claim('guard-token', 30000, 'fixture-sync-guard', ['fixture-sync-guard']))!;
    const input = { path: snapshot, relativePath: 'guard.md', originalPath: original, originalSize: info.size, originalMtime: info.mtimeMs,
      hash: createHash('sha256').update(content).digest('hex'), fingerprint: 'guard', modelFingerprint: 'guard', sourceRoot: dir, options: { sourceId: 'guard-source', noEmbed: true } };
    const host = new TaskEngineHost(engine, job.id, 'guard-token', async () => {}, true, input);
    const scope = await host.dispatch({ type: 'rpc', id: 1, method: 'transaction.open', args: [] }) as number;
    await host.dispatch({ type: 'rpc', id: 2, method: 'putPage', args: ['guard', { type: 'note', title: 'Guard', compiled_truth: '尚未发布的新内容', frontmatter: {} }, { sourceId: 'guard-source' }], scope });
    writeFileSync(original, '# Guard\n\n处理中发生变化的真实原始内容');
    await expect(host.dispatch({ type: 'rpc', id: 3, method: 'scope.close', args: [true], scope })).rejects.toThrow('原始文件在处理期间已改变');
    await host.close();
    expect((await engine.getPage('guard', { sourceId: 'guard-source' }))?.compiled_truth).toBe('原有知识');
    expect(readFileSync(original, 'utf8')).toContain('处理中发生变化');
    await queue.cancelJob(job.id);
  }, 60000);

  test('整轮已失败时遗留文件不会自行开始，原失败原因保留', async () => {
    const dir = join(root, 'orphan'); mkdirSync(dir);
    const path = join(dir, 'orphan.md'); const content = '# Orphan\n\n此文件不应自动写入知识库。'; writeFileSync(path, content);
    await engine.executeRaw("INSERT INTO sources (id, name, local_path, config) VALUES ($1, $2, $3, $4::jsonb)", ['orphan-source', '遗留任务校验', dir, { syncEnabled: true }]);
    const queue = new MinionQueue(engine);
    const parent = await queue.add('pmbrain-product-task', { kind: 'dream_quick', task: { type: 'dream', input: { preset: 'quick', sourceId: 'orphan-source' } } }, { queue: PRODUCT_TASK_QUEUE, delay: 86400000 });
    await engine.executeRaw(`UPDATE minion_jobs SET status = 'dead', error_text = '隔离整轮失败原因' WHERE id = $1`, [parent.id]);
    const child = await queue.add(SYNC_FILE_TASK, { sessionId: parent.id, kind: 'sync_file', task: { type: 'sync-file', input: {
      path, relativePath: 'orphan.md', sourceRoot: dir, hash: createHash('sha256').update(content).digest('hex'), fingerprint: 'orphan', modelFingerprint: taskModelFingerprint(), options: { sourceId: 'orphan-source', noEmbed: true },
    } } }, { queue: SYNC_FILE_QUEUE });
    for (let i = 0; i < 200; i++) {
      if ((await queue.getJob(child.id))?.status === 'paused') break;
      await Bun.sleep(50);
    }
    expect((await queue.getJob(child.id))?.status).toBe('paused');
    expect(await engine.getPage('orphan', { sourceId: 'orphan-source' })).toBeNull();
    expect((await queue.getJob(parent.id))?.error_text).toBe('隔离整轮失败原因');
  }, 30000);

  test('没有提交回执的模型任务重启后暂停，避免自动重复付费请求', async () => {
    await runtime.close();
    const queue = new MinionQueue(engine);
    const parent = await queue.add('pmbrain-product-task', { kind: 'dream_quick', task: { type: 'dream', input: { preset: 'quick', sourceId: 'uncertain-source' } } }, { queue: PRODUCT_TASK_QUEUE, delay: 86400000 });
    const child = await queue.add(SYNC_FILE_TASK, { sessionId: parent.id, kind: 'sync_file', task: { type: 'sync-file', input: {
      relativePath: 'uncertain.pdf', modelMayRun: true, options: { sourceId: 'uncertain-source', documentOcr: true },
    } } }, { queue: SYNC_FILE_QUEUE, delay: 86400000 });
    await engine.executeRaw(`UPDATE minion_jobs SET status = 'waiting-children', lock_until = NULL WHERE id = $1`, [parent.id]);
    await engine.executeRaw(`UPDATE minion_jobs SET status = 'active', attempts_started = 1, lock_until = now() - interval '1 minute' WHERE id = $1`, [child.id]);
    runtime = new ProductTaskRuntime(engine); await runtime.start();
    expect((await runtime.getRun(`task-${parent.id}`))?.error).toContain('模型处理曾中断');
    expect((await queue.getJob(child.id))?.status).toBe('paused');
    expect((await queue.getJob(parent.id))?.data.resumeOnRestart).toBe(false);
  }, 30000);

  test('真实大文件与超过旧 25 秒的事务仍完成，查看文件任务不会被取消', async () => {
    await runtime.close();
    let delayed = false;
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const guarded = new Proxy(engine, {
      get(target, property) {
        if (property === 'transaction') return (fn: (tx: BrainEngine) => Promise<unknown>) => target.transaction(tx => fn(new Proxy(tx, {
          get(connection, key) {
            if (key === 'putPage') return async (...args: Parameters<BrainEngine['putPage']>) => {
              const page = await connection.putPage(...args);
              if (args[0] === 'large' && !delayed) { delayed = true; started(); await Bun.sleep(27000); }
              return page;
            };
            const value = Reflect.get(connection, key);
            return typeof value === 'function' ? value.bind(connection) : value;
          },
        })));
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    runtime = new ProductTaskRuntime(guarded); await runtime.start();
    const dir = join(root, 'large'); mkdirSync(dir);
    const content = '# Large\n\n' + Array.from({ length: 1800 }, (_, i) => `## 测试段落 ${i}\n\n这是隔离的大文件验收，验证分块写入、正文原子性与完成回执。段落 ${i} 包含不同信息，所有资料都应保持完整。\n\n`).join('');
    writeFileSync(join(dir, 'large.md'), content);
    await engine.executeRaw("INSERT INTO sources (id, name, local_path, config) VALUES ($1, $2, $3, $4::jsonb)", ['large-source', '大文件测试', dir, { syncEnabled: true }]);
    const accepted = await runtime.submitDream({ preset: 'quick', sourceId: 'large-source' });
    await Promise.race([waiting, Bun.sleep(30000).then(() => { throw new Error('未进入大文件写入'); })]);
    await Bun.sleep(25500);
    const before = performance.now();
    expect((await runtime.getRun(accepted.id))?.status).toBe('running');
    expect(performance.now() - before).toBeLessThan(1000);
    const completed = await finish(accepted.id);
    if (completed.status !== 'completed') console.error('大文件失败证据', JSON.stringify(completed));
    expect(completed.status).toBe('completed');
    const page = await engine.getPage('large', { sourceId: 'large-source' });
    expect(page?.compiled_truth).toContain('段落 1799');
    expect((await engine.getChunks('large', { sourceId: 'large-source' })).length).toBeGreaterThan(32);
    await runtime.close(); runtime = new ProductTaskRuntime(engine); await runtime.start();
  }, 180000);

  test('一千份资料完成并可检索，第二轮不创建新的文件处理任务', async () => {
    const dir = join(root, 'scale'); mkdirSync(dir);
    const total = 1000;
    for (let i = 0; i < total; i++) writeFileSync(join(dir, `scale-${i}.md`), `# 批量资料 ${i}\n\n千文件验收的隔离内容 ${i}。`);
    await engine.executeRaw("INSERT INTO sources (id, name, local_path, config) VALUES ($1, $2, $3, $4::jsonb)", ['scale-source', '千文件测试', dir, { syncEnabled: true }]);
    const accepted = await runtime.submitDream({ preset: 'quick', sourceId: 'scale-source' });
    const started = performance.now();
    let reported = started;
    let final;
    for (let i = 0; i < 18000; i++) {
      final = await runtime.getRun(accepted.id);
      if (performance.now() - reported > 15000) {
        console.log('千文件验收进度', JSON.stringify({ seconds: Math.round((performance.now() - started) / 1000), stage: final?.product?.stage, scan: final?.product?.syncScan, files: final?.product?.syncFiles }));
        reported = performance.now();
      }
      if (final && !['running','queued'].includes(final.status)) break;
      await Bun.sleep(50);
    }
    expect(final?.status).toBe('completed');
    expect(final?.product?.syncFiles?.completed).toBe(total);
    const pages = await engine.executeRaw<{ count: string }>(`SELECT count(*)::text AS count FROM pages WHERE source_id = $1 AND deleted_at IS NULL`, ['scale-source']);
    expect(Number(pages[0].count)).toBe(total);
    expect((await engine.searchKeyword('千文件验收', { sourceId: 'scale-source', limit: 5 })).length).toBeGreaterThan(0);
    const next = await runtime.submitDream({ preset: 'quick', sourceId: 'scale-source' });
    const repeated = await finish(next.id);
    expect(repeated.product?.syncScan?.unchanged).toBe(total);
    const children = await engine.executeRaw<{ count: string }>(`SELECT count(*)::text AS count FROM minion_jobs WHERE queue = $1 AND (data->>'sessionId')::bigint = $2`, [SYNC_FILE_QUEUE, Number(next.id.slice(5))]);
    expect(Number(children[0].count)).toBe(0);
  }, 950000);
});
