import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type Anthropic from '@anthropic-ai/sdk';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { runCycle, mergeCaptureSlugs, ALL_PHASES } from '../src/core/cycle.ts';
import {
  ENTITY_CAPTURE_SLUG_PREFIXES,
  ENTITY_CAPTURE_TOOLS,
  ENTITY_CAPTURE_PAGE_BUDGET,
  ENTITY_CAPTURE_CHUNK_CHARS,
  ENTITY_CAPTURE_CHUNK_OVERLAP,
  buildEntityCapturePrompt,
  locateSignalDetectorSkillsDir,
  runPhaseCaptureEntities,
  splitEntityCaptureCandidate,
  selectEntityCaptureCandidates,
} from '../src/core/cycle/capture-entities.ts';
import { makeSubagentHandler, type MessagesClient } from '../src/core/minions/handlers/subagent.ts';
import { resolveDreamPresetPhases } from '../src/commands/dream.ts';
import { runByMentionCore } from '../src/commands/extract.ts';
import { TaskProgressAdapter } from '../src/product/tasks/progress-adapter.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';

process.env.PMBRAIN_HOME = mkdtempSync(join(tmpdir(), 'pmbrain-capture-skill-home-'));

const databaseUrl = process.env.PMBRAIN_RELATION_TEST_DATABASE_URL;
let engine: BrainEngine;

beforeAll(async () => {
  if (databaseUrl) assertSafeE2eDatabaseUrl(databaseUrl);
  engine = databaseUrl ? new PostgresEngine() : new PGLiteEngine();
  await engine.connect(databaseUrl ? { database_url: databaseUrl } : {});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine?.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine as PGLiteEngine);
});

type FakeResponse = Partial<Anthropic.Message> & { content: Anthropic.Message['content'] };

class FakeMessagesClient implements MessagesClient {
  calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  constructor(private responses: FakeResponse[]) {}
  async create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
    this.calls.push(params);
    const next = this.responses.shift();
    if (!next) throw new Error('脚本里的模型回复已经用完');
    return {
      id: `msg_${this.calls.length}`,
      type: 'message',
      role: 'assistant',
      model: params.model,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      ...next,
    } as Anthropic.Message;
  }
}

function tool(id: string, name: string, input: Record<string, unknown>): FakeResponse {
  return {
    content: [{ type: 'tool_use', id, name, input } as Anthropic.ToolUseBlock],
    stop_reason: 'tool_use',
  };
}

function text(value: string): FakeResponse {
  return { content: [{ type: 'text', text: value } as Anthropic.TextBlock], stop_reason: 'end_turn' };
}

async function useVault(): Promise<void> {
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('vault', 'Vault') ON CONFLICT (id) DO NOTHING`);
  await engine.setConfig('version', '130');
  await engine.setConfig('models.dream.synthesize', 'anthropic:claude-sonnet-4-6');
}

async function article(body: string): Promise<void> {
  await engine.putPage('notes/work', {
    type: 'note',
    title: '工作记录',
    compiled_truth: body,
    timeline: '',
    frontmatter: {},
  }, { sourceId: 'vault' });
}

async function pageCount(): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages`);
  return Number(rows[0]?.n ?? 0);
}

test('识别实体的提示、工具和可写范围按完整 ingest 契约收口', () => {
  const prompt = buildEntityCapturePrompt({
    slug: 'notes/work',
    sourceId: 'vault',
    title: '工作记录',
    body: '张三在 OpenAI 工作。',
  });
  expect(prompt).toContain('完整 ingest 契约');
  expect(prompt).toContain('people/');
  expect(prompt).toContain('companies/');
  expect(prompt).toContain('concepts/');
  expect(prompt).toContain('projects/');
  expect(prompt).toContain('add_link');
  expect(prompt).toContain('已有实体复用准确身份，只提交新事实');
  expect(prompt).toContain('另建原始资料页');
  expect(prompt).toContain('未知类型不建页');
  const withCandidates = buildEntityCapturePrompt({
    slug: 'notes/work',
    sourceId: 'vault',
    title: '工作记录',
    body: '张三在 OpenAI 工作。',
  }, [{ slug: 'people/zhang-san', sourceId: 'vault', type: 'person', title: '张三', aliases: ['张老师'] }]);
  expect(withCandidates).toContain('people/zhang-san');
  expect(withCandidates).toContain('person');
  expect(withCandidates).toContain('张三');
  expect(withCandidates).toContain('张老师');
  expect(withCandidates).toContain('add_link');
  expect([...ENTITY_CAPTURE_TOOLS]).toEqual([
    'search','get_page','put_page','add_timeline_entry','add_link',
  ]);
  expect(ENTITY_CAPTURE_TOOLS).toContain('add_link');
  expect([...ENTITY_CAPTURE_SLUG_PREFIXES]).toEqual(['people/*', 'companies/*', 'concepts/*', 'projects/*']);
  const skillsDir = locateSignalDetectorSkillsDir();
  expect(skillsDir).toBeTruthy();
  expect(mergeCaptureSlugs(undefined, [])).toBeUndefined();
  expect(mergeCaptureSlugs(undefined, ['people/张三', 'notes/work'])).toEqual(['people/张三', 'notes/work']);
  const full = resolveDreamPresetPhases('full');
  expect(full.indexOf('capture_entities')).toBeLessThan(full.indexOf('patterns'));
  expect(full.indexOf('capture_entities')).toBeLessThan(full.indexOf('enrich_thin'));
  expect(resolveDreamPresetPhases('quick')).not.toContain('capture_entities');
  expect(resolveDreamPresetPhases('meeting')).not.toContain('capture_entities');
  expect(ALL_PHASES).toContain('capture_entities');
  const adapter = new TaskProgressAdapter('dream_full');
  adapter.plan(['capture_entities']);
  expect(adapter.view.steps[0]?.label).toBe('识别实体');
});

test('子代理只能写实体前缀，未发布技能时仍能读 signal-detector', async () => {
  const skillsDir = locateSignalDetectorSkillsDir();
  if (!skillsDir) throw new Error('找不到 signal-detector');
  const putPage = operations.find(op => op.name === 'put_page');
  const timeline = operations.find(op => op.name === 'add_timeline_entry');
  const getSkill = operations.find(op => op.name === 'get_skill');
  if (!putPage || !timeline || !getSkill) throw new Error('缺少实体写入或技能工具');
  const ctx: OperationContext = {
    engine,
    config: { engine: databaseUrl ? 'postgres' : 'pglite' },
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: true,
    sourceId: 'vault',
    viaSubagent: true,
    subagentId: 7,
    allowedSlugPrefixes: [...ENTITY_CAPTURE_SLUG_PREFIXES],
    skillsDir,
  };
  await expect(putPage.handler(ctx, {
    slug: 'wiki/meetings/secret',
    content: '---\ntitle: secret\n---\nbody',
  })).rejects.toThrow(/put_page slug 'wiki\/meetings\/secret' is not within the trusted-workspace allow-list/);
  await expect(timeline.handler(ctx, {
    slug: 'wiki/meetings/secret',
    date: '2026-10-06',
    summary: '不应写入',
  })).rejects.toThrow(/add_timeline_entry slug 'wiki\/meetings\/secret' is not within the trusted-workspace allow-list/);
  await engine.setConfig('mcp.publish_skills', 'false');
  const detail = await getSkill.handler(ctx, { name: 'signal-detector' }) as { name: string; body: string };
  expect(detail.name).toBe('signal-detector');
  expect(detail.body).toContain('Entity Detection');
  await expect(getSkill.handler({ ...ctx, viaSubagent: false, skillsDir: undefined }, { name: 'signal-detector' }))
    .rejects.toThrow(/disabled/i);
});

test('资料选择跳过实体页、过短正文和已经由整理生成的页面', async () => {
  await useVault();
  await article('张三在 OpenAI 工作，并提出了新的研究方向。');
  await engine.putPage('people/已有', {
    type: 'person', title: '已有', compiled_truth: '这是一个已经存在的人物页面。', timeline: '', frontmatter: {},
  }, { sourceId: 'vault' });
  await engine.putPage('notes/short', {
    type: 'note', title: '短', compiled_truth: '太短', timeline: '', frontmatter: {},
  }, { sourceId: 'vault' });
  await engine.putPage('notes/dream', {
    type: 'note', title: '整理产物', compiled_truth: '这是深度整理已经生成的页面，不应再次识别。', timeline: '',
    frontmatter: { dream_generated: true },
  }, { sourceId: 'vault' });
  const candidates = await selectEntityCaptureCandidates(engine, 'vault');
  expect(candidates.map(item => item.slug)).toEqual(['notes/work']);
});

test('默认每轮处理 100 份资料，长文按重叠分块覆盖全文', () => {
  expect(ENTITY_CAPTURE_PAGE_BUDGET).toBe(100);
  expect(ENTITY_CAPTURE_CHUNK_CHARS).toBe(8000);
  expect(ENTITY_CAPTURE_CHUNK_OVERLAP).toBe(500);

  const prefix = 'A'.repeat(7900);
  const middle = 'B'.repeat(200);
  const tailMarker = '尾部实体李四只出现在长文最后';
  const body = prefix + middle + 'C'.repeat(9000) + tailMarker;
  const chunks = splitEntityCaptureCandidate({
    slug: 'notes/long',
    sourceId: 'vault',
    title: '长文',
    body,
  });

  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks[0]?.chunkIndex).toBe(0);
  expect(chunks.at(-1)?.chunkIndex).toBe(chunks.length - 1);
  expect(chunks.at(-1)?.chunkBody).toContain(tailMarker);
  expect(chunks.every(chunk => chunk.chunkBody.length <= ENTITY_CAPTURE_CHUNK_CHARS)).toBe(true);

  const first = chunks[0]?.chunkBody ?? '';
  const second = chunks[1]?.chunkBody ?? '';
  expect(first.slice(-ENTITY_CAPTURE_CHUNK_OVERLAP)).toBe(second.slice(0, ENTITY_CAPTURE_CHUNK_OVERLAP));

  const prompt = buildEntityCapturePrompt(chunks.at(-1)!);
  expect(prompt).toContain(`第 ${chunks.length}/${chunks.length} 段`);
  expect(prompt).toContain(tailMarker);
  expect(prompt).not.toContain('资料在此处截断');
});

test('100 篇只是内部分批，超过 100 篇会自动继续，长文分块不另占篇数', async () => {
  await useVault();
  for (let i = 0; i < 101; i++) {
    const slug = `notes/batch-${String(i).padStart(3, '0')}`;
    const longBody = i === 0
      ? '长文'.repeat(5000) + '尾部实体'
      : `第 ${i} 篇资料包含足够正文用于实体识别。`;
    await engine.putPage(slug, {
      type: 'note',
      title: `批量资料 ${i}`,
      compiled_truth: longBody,
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'vault' });
  }

  await engine.executeRaw(
    `UPDATE pages SET updated_at = now() + interval '1 day' WHERE source_id = 'vault' AND slug = 'notes/batch-000'`,
  );
  let calls = 0;
  const result = await runPhaseCaptureEntities(engine, {
    sourceId: 'vault',
    handler: async () => {
      calls += 1;
      return { ingest_verified: true };
    },
  });

  expect(result.status,result.summary).toBe('ok');
  expect(result.details.pages_submitted).toBe(101);
  expect(result.details.pages_remaining).toBe(0);
  expect(result.details.stop_reason).toBe('completed');
  expect(Number(result.details.chunks_submitted)).toBeGreaterThan(101);
  expect(calls).toBe(Number(result.details.chunks_submitted));
}, 180_000);

test('预演不创建实体页', async () => {
  await useVault();
  await article('张三在 OpenAI 工作，并提出了新的研究方向。');
  const before = await pageCount();
  const result = await runPhaseCaptureEntities(engine, { sourceId: 'vault', dryRun: true });
  expect(result.status).toBe('ok');
  expect(result.details.dry_run).toBe(true);
  expect(result.details.pages_submitted).toBe(0);
  expect(await pageCount()).toBe(before);
  const jobs = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM minion_jobs`);
  expect(Number(jobs[0]?.n ?? 0)).toBe(0);
});

test('脚本按技能搜索并创建人物和公司，正文关联随后连上文章', async () => {
  await useVault();
  await article('张三在 OpenAI 工作，并提出了新的研究方向。');
  const person = [
    '---',
    'title: 张三',
    'type: person',
    '---',
    '',
    '张三在 OpenAI 工作。[Source: notes/work] [[vault:notes/work]]',
  ].join('\n');
  const company = [
    '---',
    'title: OpenAI',
    'type: company',
    '---',
    '',
    'OpenAI 的人员变动。[Source: notes/work] [[vault:notes/work]]',
  ].join('\n');
  const client = new FakeMessagesClient([
    {content:[...tool('search-person', 'brain_search', { query: '张三' }).content,
      ...tool('search-company', 'brain_search', { query: 'OpenAI' }).content],stop_reason:'tool_use'},
    {content:[...tool('write-person', 'brain_put_page', { slug: 'people/张三', content: person }).content,
      ...tool('write-company', 'brain_put_page', { slug: 'companies/openai', content: company }).content],stop_reason:'tool_use'},
    text(JSON.stringify({entities:['people/张三','companies/openai'],relations:[{from:'people/张三',to:'companies/openai',link_type:'works_at',evidence:'张三在 OpenAI 工作'}]})),
  ]);
  const progress:Array<{done:number;total:number;remaining:number;active:number;stage?:string}>=[];
  const result = await runPhaseCaptureEntities(engine, {
    sourceId: 'vault',
    handler: makeSubagentHandler({ engine, client }),
    onProgress:value=>{progress.push(value);},
  });
  expect(result.status,result.summary).toBe('ok');
  expect(client.calls).toHaveLength(3);
  expect(progress.some(value=>value.active===1&&value.total===1&&value.remaining===1)).toBe(true);
  expect(progress.some(value=>value.done===1&&value.remaining===0&&value.stage==='核对知识关联')).toBe(true);
  expect(result.details.written_slugs).toEqual(['vault:companies/openai', 'vault:people/张三']);
  const toolNames = client.calls.flatMap(call => (call.tools ?? []).map(item => item.name));
  expect(toolNames).toContain('brain_search');
  expect(toolNames).toContain('brain_put_page');
  expect(toolNames).toContain('brain_add_link');
  const pages = await engine.executeRaw<{ slug: string; title: string; type: string }>(
    `SELECT slug, title, type FROM pages WHERE slug IN ('people/张三', 'companies/openai') ORDER BY slug`,
  );
  expect(pages).toEqual([
    { slug: 'companies/openai', title: 'OpenAI', type: 'company' },
    { slug: 'people/张三', title: '张三', type: 'person' },
  ]);
  await runByMentionCore(engine, { sourceIdFilter: 'vault', quiet: true });
  const links = await engine.executeRaw<{ from_slug: string; to_slug: string; link_source: string }>(
    `SELECT f.slug AS from_slug, t.slug AS to_slug, l.link_source
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id
      WHERE f.slug = 'notes/work' AND f.source_id = 'vault'`,
  );
  expect(links).toContainEqual({ from_slug: 'notes/work', to_slug: 'people/张三', link_source: 'manual' });
  expect(links).toContainEqual({ from_slug: 'notes/work', to_slug: 'companies/openai', link_source: 'manual' });
}, 60_000);

test('已有充实页面时，按指令不覆盖', async () => {
  await useVault();
  const rich = '张三长期负责 OpenAI 的研究合作。这段内容已经包含人物、机构和事实，后续整理应保留，不应整页覆盖。';
  await engine.putPage('people/张三', {
    type: 'person', title: '张三', compiled_truth: rich, timeline: '', frontmatter: {},
  }, { sourceId: 'vault' });
  await article('张三在 OpenAI 工作，并提出了新的研究方向。');
  const client = new FakeMessagesClient([
    tool('search-person', 'brain_search', { query: '张三' }),
    tool('read-person', 'brain_get_page', { slug: 'people/张三' }),
    text(JSON.stringify({entities:['people/张三'],relations:[]})),
  ]);
  const result = await runPhaseCaptureEntities(engine, {
    sourceId: 'vault',
    handler: makeSubagentHandler({ engine, client }),
  });
  expect(result.status).toBe('ok');
  expect(result.details.written_slugs).toEqual([]);
  const saved = await engine.executeRaw<{ compiled_truth: string }>(
    `SELECT compiled_truth FROM pages WHERE slug = 'people/张三' AND source_id = 'vault'`,
  );
  expect(saved[0]?.compiled_truth).toBe(rich);
}, 60_000);

test('同一份资料成功识别后，下一次不重复交给代理', async () => {
  await useVault();
  await article('张三在 OpenAI 工作，并提出了新的研究方向。');
  let calls = 0;
  const handler = async () => {
    calls += 1;
    return { ingest_verified: true };
  };
  const first = await runPhaseCaptureEntities(engine, { sourceId: 'vault', handler });
  expect(first.status).toBe('ok');
  expect(first.details.pages_submitted).toBe(1);
  expect(calls).toBe(1);
  const second = await runPhaseCaptureEntities(engine, { sourceId: 'vault', handler });
  expect(second.status).toBe('ok');
  expect(second.details.pages_submitted).toBe(0);
  expect(calls).toBe(1);
}, 60_000);

test('完整整理先识别实体，再把新实体补进正文关联', async () => {
  await useVault();
  await article('张三在 OpenAI 工作，并提出了新的研究方向。');
  const report = await runCycle(engine, {
    brainDir: null,
    sourceId: 'vault',
    phases: ['extract', 'capture_entities'],
    includeByMention: true,
    refreshRelationsAfterGeneration: true,
    captureEntitiesHandler: async () => {
      await engine.putPage('people/张三', {
        type: 'person', title: '张三', compiled_truth: '张三在 OpenAI 工作。', timeline: '', frontmatter: {},
      }, { sourceId: 'vault' });
      return { ingest_verified:true,created: 'people/张三' };
    },
  });
  expect(report.phases.map(phase => phase.phase)).toEqual(['extract', 'capture_entities']);
  const capture = report.phases.find(phase => phase.phase === 'capture_entities');
  expect(capture?.status).toBe('ok');
  expect(capture?.details.source_slugs).toEqual(['notes/work']);
  expect(report.phases.find(phase => phase.phase === 'extract')?.details.postGenerationRelations).toBe(true);
  const links = await engine.executeRaw<{ to_slug: string; link_source: string }>(
    `SELECT t.slug AS to_slug, l.link_source
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id
      WHERE f.slug = 'notes/work' AND f.source_id = 'vault' AND t.slug = 'people/张三'`,
  );
  expect(links).toContainEqual({ to_slug: 'people/张三', link_source: 'mentions' });
}, 60_000);

test('项目页保留，但普通正文提及不会自动连向项目', async () => {
  await useVault();
  await engine.putPage('projects/deep-blue', {
    type: 'project', title: '深蓝计划', compiled_truth: '深蓝计划是一个独立项目。', timeline: '', frontmatter: {},
  }, { sourceId: 'vault' });
  await engine.putPage('notes/project', {
    type: 'note', title: '项目记录', compiled_truth: '本次讨论了深蓝计划的范围。', timeline: '', frontmatter: {},
  }, { sourceId: 'vault' });
  await runByMentionCore(engine, { sourceIdFilter: 'vault', quiet: true });
  const links = await engine.executeRaw<{ to_slug: string }>(
    `SELECT t.slug AS to_slug
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id
      WHERE f.slug = 'notes/project' AND l.link_source = 'mentions'`,
  );
  expect(links.map(row => row.to_slug)).not.toContain('projects/deep-blue');
  expect((await engine.getPage('projects/deep-blue',{sourceId:'vault'}))?.type).toBe('project');
});

test('实体回执后中断不冒报完成，恢复只补关系并且不重算模型 Token',async()=>{
  await useVault();await article('张三在 OpenAI 工作，并负责研究合作。');
  const invalid=new FakeMessagesClient([text('已完成')]);
  const failed=await runPhaseCaptureEntities(engine,{sourceId:'vault',handler:makeSubagentHandler({engine,client:invalid})});
  expect(failed.details.pages_processed).toBe(0);
  const client=new FakeMessagesClient([
    tool('write-person','brain_put_page',{slug:'people/张三',content:'---\ntitle: 张三\ntype: person\n---\n张三在 OpenAI 工作。[Source: notes/work] [[vault:notes/work]]'}),
    text(JSON.stringify({entities:['people/张三'],relations:[]})),
  ]);
  const controller=new AbortController();
  const interrupted=await runPhaseCaptureEntities(engine,{sourceId:'vault',signal:controller.signal,handler:makeSubagentHandler({engine,client}),yieldDuringPhase:async()=>{
    const pending=await engine.executeRaw("SELECT id FROM minion_jobs WHERE status='completed' AND result->>'ingest_verified'='true' AND result->>'graph_reconciled'='false'");
    if(pending.length)controller.abort(new Error('验收中断'));
  }});
  expect(controller.signal.aborted).toBe(true);
  expect(interrupted.status).toBe('warn');
  expect(interrupted.details.stop_reason).toBe('aborted');
  expect(interrupted.summary).toContain('验收中断');
  expect(interrupted.details.pages_processed).toBe(0);
  expect(interrupted.details.pages_remaining).toBe(1);
  expect(interrupted.details.input_tokens).toBe(20);
  expect(interrupted.details.output_tokens).toBe(10);
  const [checkpoint]=await engine.executeRaw<{status:string;graph:string}>("SELECT status,result->>'graph_reconciled' graph FROM minion_jobs WHERE result->>'ingest_verified'='true'");
  expect(checkpoint).toEqual({status:'completed',graph:'false'});
  expect(client.calls).toHaveLength(2);
  const recoveryClient=new FakeMessagesClient([]);
  const recovered=await runPhaseCaptureEntities(engine,{sourceId:'vault',handler:makeSubagentHandler({engine,client:recoveryClient})});
  expect(recovered.status).toBe('ok');
  expect(recovered.details.pages_processed).toBe(1);expect(recovered.details.input_tokens).toBe(0);expect(recovered.details.output_tokens).toBe(0);expect(recovered.details.entities_written).toBe(0);
  expect(recoveryClient.calls).toHaveLength(0);
  const [job]=await engine.executeRaw<{graph:string}>("SELECT result->>'graph_reconciled' graph FROM minion_jobs WHERE result->>'ingest_verified'='true'");
  expect(job?.graph).toBe('true');
  const again=await runPhaseCaptureEntities(engine,{sourceId:'vault',handler:makeSubagentHandler({engine,client:recoveryClient})});
  expect(again.details.chunks_submitted).toBe(0);
},60_000);
