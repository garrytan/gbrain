import { ENTITY_CAPTURE_MIN_BODY_CHARS } from '../pmbrain-adapters/entity-capture-request.ts';
import {defaultMaxOutputTokens,isThinkingModel} from '../ai/model-compatibility.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import { DEFAULT_PRIVATE_QUEUE_LEASE_MS, MinionQueue } from '../minions/queue.ts';
import { waitForCompletion, TimeoutError } from '../minions/wait-for-completion.ts';
import type { MinionHandler, SubagentHandlerData } from '../minions/types.ts';
import { resolveSubagentExecutionMode } from './model-routing.ts';
import { runSubagentsInline } from './inline-drain.ts';
import { throwIfAborted } from '../abort-check.ts';
import { loadConfig } from '../config.ts';
const CAPTURE_ENTITY_TYPES=['person','company','organization','entity','concept','project'] as const;
import { splitProviderModelId } from '../model-id.ts';
import { readModelConfigValue, resolveAlias } from '../model-config.ts';
import { normalizeAliasList } from '../search/alias-normalize.ts';
import { alignCapturedEntityGraph } from './entity-graph-align.ts';
import { lineGrammarOptions } from '../line-grammar.ts';
import { locateIngestSkillsDir, readIngestContract, pruneEntityIngestLinks,ingestAbortKind } from '../pmbrain-adapters/entity-ingest-workflow.ts';
import {
  DEFAULT_ENTITY_CAPTURE_MAX_INPUT_TOKENS,
  DEFAULT_ENTITY_CAPTURE_MAX_OUTPUT_TOKENS,
  ENTITY_CAPTURE_CANDIDATE_LIMIT,
  type CaptureEntityBrief,
  type CaptureModelChoice,
  type CaptureServiceRecord,
  type CaptureStopReason,
  captureBudgetStop,
  captureChunkCostCny,
  captureReportLine,
  deltaCaptureNeedles,
  isOllamaModel,
  rankCaptureCandidates,
  readEntityCaptureCostCap,
  readModelCnyPrices,
  readTokenCap,
  selectReadyCaptureModel,
  usageFromJobResult,
} from './entity-capture-budget.ts';

export const ENTITY_CAPTURE_PAGE_BUDGET = 100;
export const ENTITY_CAPTURE_CHUNK_CHARS = 8000;
export const ENTITY_CAPTURE_CHUNK_OVERLAP = 500;
export const ENTITY_CAPTURE_TOOLS = [
  'search',
  'get_page',
  'put_page',
  'add_timeline_entry',
  'add_link',
] as const;
export const ENTITY_CAPTURE_SLUG_PREFIXES = [
  'people/*',
  'companies/*',
  'concepts/*',
  'projects/*',
] as const;

const MIN_BODY_CHARS = ENTITY_CAPTURE_MIN_BODY_CHARS;

export interface EntityCaptureCandidate {
  pageId?: number | string;
  sourceIncarnation?: string;
  slug: string;
  sourceId: string;
  title: string;
  body: string;
}

export interface EntityCaptureChunk extends EntityCaptureCandidate {
  chunkIndex: number;
  chunkCount: number;
  chunkBody: string;
}

export interface CaptureEntitiesOpts {
  sourceId?: string;
  dryRun?: boolean;
  signal?: AbortSignal;
  yieldDuringPhase?: () => Promise<void>;
  deadlineAtMs?: number | null;
  privateQueueOwnerJobId?: number | null;
  maxPages?: number;
  slugs?: string[];
  batchSize?: number;
  model?: string;
  modelServices?: CaptureServiceRecord[];
  handler?: MinionHandler;
  budget?: {
    maxPages?: number;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    costCapCny?: number | null;
    inputPriceCnyPerMillion?: number | null;
    outputPriceCnyPerMillion?: number | null;
    ollama?: boolean;
  };
}

export function locateSignalDetectorSkillsDir(): string | null {
  return locateIngestSkillsDir();
}

export function splitEntityCaptureCandidate(page: EntityCaptureCandidate): EntityCaptureChunk[] {
  if (page.body.length <= ENTITY_CAPTURE_CHUNK_CHARS) {
    return [{ ...page, chunkIndex: 0, chunkCount: 1, chunkBody: page.body }];
  }
  const step = Math.max(1, ENTITY_CAPTURE_CHUNK_CHARS - ENTITY_CAPTURE_CHUNK_OVERLAP);
  const parts: string[] = [];
  for (let start = 0; start < page.body.length; start += step) {
    const end = Math.min(page.body.length, start + ENTITY_CAPTURE_CHUNK_CHARS);
    parts.push(page.body.slice(start, end));
    if (end >= page.body.length) break;
  }
  return parts.map((chunkBody, chunkIndex) => ({
    ...page,
    chunkIndex,
    chunkCount: parts.length,
    chunkBody,
  }));
}

export function buildEntityCapturePrompt(
  page: EntityCaptureCandidate | EntityCaptureChunk,
  candidates: CaptureEntityBrief[] = [],
  acknowledged:CaptureEntityBrief[] = [],
): string {
  const isChunk = 'chunkBody' in page;
  const body = isChunk ? page.chunkBody : page.body;
  const chunkIndex = isChunk ? page.chunkIndex : 0;
  const chunkCount = isChunk ? page.chunkCount : 1;
  const candidateBlock = candidates.length === 0
    ? '这一段没有检索到相关的已有实体。创建前仍必须 search。'
    : candidates.map(candidate => {
      const aliases = candidate.aliases.length > 0 ? candidate.aliases.join('、') : '无';
      return `- ${candidate.sourceId}:${candidate.slug} | ${candidate.type} | ${candidate.title} | aliases: ${aliases}`;
    }).join('\n');
  return `本次是用户授权的资料整理，原始资料已入库。执行系统提供的完整 ingest 契约，按其中的 Parse、实体复用与写入、关系、回链、时间线传播和读回验证顺序完成这一段；不做付费外部补充、观点采集或另建原始资料页。

资料 slug: ${page.slug}
Source: ${page.sourceId}
标题: ${page.title}
分块: 第 ${chunkIndex + 1}/${chunkCount} 段
已有相关实体（Source 优先当前，再 default；不得重复建页）：
${candidateBlock}
已写入同一份未变化原文并通过证据检查的实体（中断前已持久化；不要再次 search、get_page 或 put_page；全部列入最终 entities）：
${acknowledged.length?acknowledged.map(entity=>`${entity.sourceId}:${entity.slug} | ${entity.title}`).join('\n'):'无'}

读取现有实体后保留已有事实，当前状态只保留一节。put_page 的 content 必须以完整 YAML frontmatter 开头，包含 title 和 type；Markdown 的 # 标题不能设置页面身份。title 使用本段原文名称，复用现有准确 slug，禁止将拼音 slug 当标题。类型是 person、company、organization、project、concept；未知类型不建页。项目和概念只有原文明确信息才建，不作普通关键词互连。
人物 people/、单位 companies/、项目 projects/、概念 concepts/。已有实体标题不在本段逐字出现时，在 YAML aliases 中记录本段明确使用的名称并保留原身份，禁止臆测别名。原始资料本身就是可用的 brain context，包含明确职责、项目或事件时可满足有意义内容要求；不需外部补充。正文每条事实带 [Source: ${page.slug}]。使用 [[${page.sourceId}:${page.slug}]] 回链资料，禁止猜测或缩写路径。同一明确日期事件传播到每个实际参与实体；add_timeline_entry 的 source 必须包含 ${page.slug}，date 必须为原文明确给出的 YYYY-MM-DD；只有月份或阶段范围的事实留在正文，不得编造某月 1 日。
第一轮只调用一次 search，query 用逗号分隔本段所有候选名称，一次查重。没有同名实体时第二轮批量写入，禁止反复搜索、resolve_slugs 或整库 list_pages。新实体内容来自本段资料，不要求额外读取其他原始文档；实体已经存在时批量 get_page 读取并复用。只有增加明确新事实才 put_page。add_link 的 from/to 使用准确 slug，context 必须逐字引用本段同时包含两端名称的原文；不得凭共现编造任职、拥有或投资关系，普通引用使用 mentions。
优先完成资料的主题项目、牵头单位和明确职责关系，再处理有明确身份、职责或事件的人物；只有姓名的名单不单独建实体。一次批量完成查重，不要逐个姓名分轮搜索。最多允许六轮，包括最后的验收回执。
写入完成后返回唯一 JSON 验收清单（不写额外总结）。页面和关系由程序统一读回验收，不再要求模型反复查询图谱：
{"entities":["people/姓名","companies/单位","projects/项目"],"relations":[{"from":"companies/单位","to":"projects/项目","link_type":"mentions","evidence":"本段逐字原文，包含两端名称"}]}
entities 列出本段识别且存在的所有值得记录实体，包括复用的旧页。没有实体时返回 {"entities":[],"relations":[],"no_entities":true}。尚未存在的目标不得填入已完成清单。程序将验证所有目标、原文证据、来源回链和关系，未通过不会标记完成。

资料正文
---
${body}
---`;
}

export function entityCaptureIdempotencyKey(
  page: EntityCaptureCandidate,
  chunkIndex = 0,
  chunkBody = page.body,
): string {
  const fullDigest = createHash('sha256')
    .update(`${page.sourceId}\0${page.slug}\0${page.body}\0${page.pageId??''}\0${page.sourceIncarnation??''}`)
    .digest('hex')
    .slice(0, 32);
  const digest = createHash('sha256')
    .update(`${fullDigest}\0chunk:${chunkIndex}\0${chunkBody}`)
    .digest('hex').slice(0,32);
  return `dream:entity-ingest:v3:${digest}`;

}

async function hasCompletedCaptureJob(engine: BrainEngine, baseKey: string): Promise<boolean> {
  const rows = await engine.executeRaw<{ done: number }>(
    `SELECT 1::int AS done
       FROM minion_jobs
      WHERE status = 'completed' AND result->>'ingest_verified'='true' AND COALESCE(result->>'graph_reconciled','true')='true'
        AND (idempotency_key = $1 OR idempotency_key LIKE $2)
      LIMIT 1`,
    [baseKey, `${baseKey}:retry:%`],
  );
  return rows.length > 0;
}

async function acknowledgedIngestEntities(engine:BrainEngine,page:EntityCaptureChunk,index:CaptureEntityBrief[]):Promise<CaptureEntityBrief[]>{
  if(page.pageId==null)return [];
  const rows=await engine.executeRaw<{slug:string;source_id:string;compiled_truth:string;timeline:string;frontmatter:Record<string,unknown>}>(`SELECT p.slug,p.source_id,p.compiled_truth,p.timeline,p.frontmatter FROM pages p WHERE p.deleted_at IS NULL AND p.source_id=ANY($1::text[]) AND EXISTS
    (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.frontmatter->'pmbrain_ingest_provenance')='array' THEN p.frontmatter->'pmbrain_ingest_provenance' ELSE '[]'::jsonb END) v
     WHERE v->>'sourceId'=$2 AND v->>'slug'=$3 AND v->>'pageId'=$4 AND v->>'bodyHash'=$5 AND(v->>'chunkHash'=$6 OR($7::boolean AND v->>'chunkHash' IS NULL)))`,
    [[page.sourceId,'default'],page.sourceId,page.slug,String(page.pageId),createHash('sha256').update(page.body).digest('hex'),createHash('sha256').update(page.chunkBody).digest('hex'),page.chunkCount===1]);
  const bodyHash=createHash('sha256').update(page.body).digest('hex'),chunkHash=createHash('sha256').update(page.chunkBody).digest('hex');
  const keys=new Set(rows.filter(row=>{
    const lines=new Set(`${row.compiled_truth}\n${row.timeline}`.split('\n').map(line=>createHash('sha256').update(line).digest('hex')));
    return (row.frontmatter.pmbrain_ingest_provenance as Array<Record<string,unknown>>).some(record=>record.sourceId===page.sourceId&&record.slug===page.slug&&record.pageId===String(page.pageId)&&record.bodyHash===bodyHash&&(record.chunkHash===chunkHash||page.chunkCount===1&&record.chunkHash==null)&&lines.has(String(record.line)));
  }).map(row=>`${row.source_id}:${row.slug}`));const normalize=(value:string)=>value.replace(/[\s"'“”‘’]/gu,'');
  return index.filter(entity=>keys.has(`${entity.sourceId}:${entity.slug}`)&&[entity.title,...entity.aliases].some(name=>name.trim().length>=2&&normalize(page.chunkBody).includes(normalize(name))));
}

export async function selectEntityCaptureCandidates(
  engine: BrainEngine,
  sourceId?: string,
): Promise<EntityCaptureCandidate[]> {
  const rows = await engine.executeRaw<{
    slug: string;
    source_id: string | null;
    title: string | null;
    compiled_truth: string | null;
    page_id: number;
  }>(
    `SELECT slug, source_id, title, compiled_truth,pages.id AS page_id
       FROM pages
      WHERE deleted_at IS NULL
        AND COALESCE(pages.chunker_version,0)>=0
        AND ($1::text IS NULL OR source_id = $1)
        AND COALESCE(type, '') NOT IN ('person', 'company', 'organization', 'entity', 'concept', 'project')
        AND slug NOT LIKE 'people/%'
        AND slug NOT LIKE 'companies/%'
        AND slug NOT LIKE 'concepts/%'
        AND slug NOT LIKE 'projects/%'
        AND slug NOT LIKE 'wiki/agents/%'
        AND COALESCE(frontmatter->>'dream_generated', '') <> 'true'
        AND char_length(trim(COALESCE(compiled_truth, ''))) >= $2
      ORDER BY pages.updated_at DESC, source_id, slug`,
    [sourceId ?? null, MIN_BODY_CHARS],
  );
  let sourceRows:Array<{id:string;incarnation:string}>=[];
  try{sourceRows=await engine.executeRaw('SELECT id,incarnation::text AS incarnation FROM sources');}
  catch(error){if((error as {code?:string}).code!=='42P01')throw error;}
  const incarnations=new Map(sourceRows.map(row=>[row.id,row.incarnation]));
  return rows.map(row => ({
    pageId:row.page_id,sourceIncarnation:incarnations.get(row.source_id??'default'),
    slug: row.slug,
    sourceId: row.source_id ?? 'default',
    title: row.title?.trim() || row.slug,
    body: row.compiled_truth ?? '',
  }));
}

export async function loadCaptureEntityIndex(
  engine: BrainEngine,
  sourceId?: string,
): Promise<CaptureEntityBrief[]> {
  const rows = await engine.executeRaw<{
    slug: string;
    source_id: string | null;
    type: string;
    title: string | null;
    frontmatter: unknown;
  }>(
    `SELECT slug, source_id, type, title, frontmatter
       FROM pages
      WHERE deleted_at IS NULL
        AND type = ANY($1::text[])
        AND ($2::text IS NULL OR source_id = $2 OR source_id = 'default')
      ORDER BY source_id, slug`,
    [[...CAPTURE_ENTITY_TYPES], sourceId ?? null],
  );
  return rows.map(row => {
    const frontmatter = row.frontmatter && typeof row.frontmatter === 'object'
      ? row.frontmatter as Record<string, unknown>
      : null;
    return {
      slug: row.slug,
      sourceId: row.source_id ?? 'default',
      type: row.type,
      title: row.title?.trim() || row.slug,
      aliases: normalizeAliasList(frontmatter?.aliases),
    };
  });
}

export function configuredCnyPrices(model: string, providerId: string | null): { input: number | null; output: number | null } {
  try {
    const config = loadConfig() as { desktop?: { model_services?: unknown } } | null;
    const services = config?.desktop?.model_services;
    if (!Array.isArray(services)) return { input: null, output: null };
    return readModelCnyPrices(services, model, providerId);
  } catch {
    return { input: null, output: null };
  }
}

export function storedPrice(raw: string | null | undefined): number | null | undefined {
  if (raw == null || raw.trim() === '') return undefined;
  const amount = Number(raw);
  return Number.isFinite(amount) && amount >= 0 ? amount : undefined;
}

async function retryableKey(engine: BrainEngine, baseKey: string, nonce: number): Promise<string> {
  const completed=await engine.executeRaw<{idempotency_key:string}>(`SELECT idempotency_key FROM minion_jobs WHERE status='completed' AND result->>'ingest_verified'='true' AND (idempotency_key=$1 OR idempotency_key LIKE $2) ORDER BY id DESC LIMIT 1`,[baseKey,`${baseKey}:retry:%`]);
  if(completed[0])return completed[0].idempotency_key;
  const rows = await engine.executeRaw<{ status: string; verified:string|null }>(
    `SELECT status,result->>'ingest_verified' verified FROM minion_jobs WHERE idempotency_key = $1 LIMIT 1`,
    [baseKey],
  );
  const status = rows[0]?.status;
  if (status === 'failed' || status === 'dead' || status === 'cancelled' || status==='completed'&&rows[0]?.verified!=='true') {
    return `${baseKey}:retry:${nonce}`;
  }
  return baseKey;
}

function phaseResult(
  status: PhaseResult['status'],
  summary: string,
  details: Record<string, unknown>,
  error?: PhaseResult['error'],
): PhaseResult {
  return { phase: 'capture_entities', status, duration_ms: 0, summary, details, ...(error ? { error } : {}) };
}

const CAPTURE_MODEL_KEYS = [
  ['models.default', 'config: models.default'],
  ['chat_model', 'config: chat_model'],
  ['models.propose_takes', 'config: models.propose_takes'],
  ['models.tier.subagent', 'config: models.tier.subagent'],
  ['models.tier.reasoning', 'config: models.tier.reasoning'],
  ['models.dream.synthesize', 'config: models.dream.synthesize'],
] as const;

function readDesktopModelServices(): CaptureServiceRecord[] {
  try {
    const config = loadConfig() as { desktop?: { model_services?: unknown } } | null;
    const services = config?.desktop?.model_services;
    return Array.isArray(services) ? services as CaptureServiceRecord[] : [];
  } catch {
    return [];
  }
}

export async function chooseCaptureModel(engine: BrainEngine, opts: CaptureEntitiesOpts): Promise<CaptureModelChoice> {
  const services = opts.modelServices !== undefined
    ? opts.modelServices
    : opts.handler ? [] : readDesktopModelServices();
  const explicitRaw = opts.model?.trim()
    || (await readModelConfigValue(engine, 'models.dream.capture_entities'))?.trim()
    || '';
  const explicit = explicitRaw
    ? {
      model: await resolveAlias(engine, explicitRaw),
      source: opts.model?.trim() ? 'option' : 'config: models.dream.capture_entities',
    }
    : null;
  const candidates = [];
  if (!explicit) {
    for (const [key, source] of CAPTURE_MODEL_KEYS) {
      const raw = (await readModelConfigValue(engine, key))?.trim();
      if (!raw) continue;
      candidates.push({ model: await resolveAlias(engine, raw), source });
    }
  }
  return selectReadyCaptureModel({ explicit, candidates, services });
}

async function linkNewCaptureEntities(
  engine: BrainEngine,
  opts: CaptureEntitiesOpts,
  writtenSlugs: string[],
): Promise<{ mention: number; ner: number; extracted: number; slugs: string[] }> {
  const { runMentionPass } = await import('../mentions/pass.ts');
  const mention=await runMentionPass(engine,{sourceId:opts.sourceId,signal:opts.signal,yieldDuringPhase:opts.yieldDuringPhase});
  if(mention.state==='failed')throw new Error(mention.error);
  const written=writtenSlugs.length ? await engine.executeRaw<{slug:string;sourceId:string}>(`SELECT slug,source_id AS "sourceId" FROM pages WHERE slug=ANY($1::text[]) AND ($2::text IS NULL OR source_id=$2) AND deleted_at IS NULL`,[writtenSlugs,opts.sourceId ?? null]) : [];
  const repaired=await repairCaptureRelations(engine,opts,[...mention.processedSlugs,...written]);
  return {mention:mention.created,...repaired};
}

async function repairCaptureRelations(engine:BrainEngine,opts:CaptureEntitiesOpts,refs:Array<{slug:string;sourceId:string}>):Promise<{ner:number;extracted:number;slugs:string[]}>{
  const groups=new Map<string,Set<string>>();
  for(const ref of refs){const slugs=groups.get(ref.sourceId)??new Set<string>();slugs.add(ref.slug);groups.set(ref.sourceId,slugs);}
  const { extractNerLinks } = await import('../extract-ner.ts');
  let ner=0,extracted=0;
  for(const [sourceId,set] of groups){
    const slugs=[...set];
    try{
      ner+=(await extractNerLinks(engine,{sourceIdFilter:sourceId,slugs,signal:opts.signal,yieldDuringPhase:opts.yieldDuringPhase})).created;
      extracted+=await materializeExtractedLinks(engine,{...opts,sourceId},slugs);
      const { runMentionPass }=await import('../mentions/pass.ts');
      const settled=await runMentionPass(engine,{sourceId,slugs,signal:opts.signal});
      if(settled.state==='failed')throw new Error(settled.error);
    }catch(error){
      await engine.executeRaw('UPDATE page_mention_state SET mention_revision=NULL WHERE page_id IN (SELECT id FROM pages WHERE source_id=$1 AND slug=ANY($2::text[]))',[sourceId,slugs]);
      throw error;
    }
  }
  return {ner,extracted,slugs:[...new Set(refs.map(ref=>ref.slug))]};
}

async function materializeExtractedLinks(engine:BrainEngine,opts:CaptureEntitiesOpts,slugs:string[]):Promise<number>{
  const { prepareLinkReconciliation } = await import('../link-reconciliation.ts');
  const reconcile=await prepareLinkReconciliation(engine);
  let created=0;
  const { parseTimelineEntries }=await import('../link-extraction.ts');
  for(const slug of slugs){
    opts.signal?.throwIfAborted();
    const result=await reconcile(slug,opts.sourceId ?? 'default');
    created+=result.created;
    const timeline=parseTimelineEntries(result.page.compiled_truth+'\n'+result.page.timeline).map(entry=>({slug,source_id:result.page.source_id,...entry,detail:entry.detail||'',source:entry.source||''}));
    if(timeline.length)await engine.transaction(async tx=>{
      const [current]=await tx.executeRaw<{revision:string}>('SELECT knowledge_revision::text AS revision FROM pages WHERE id=$1 FOR SHARE',[result.page.id]);
      if(current?.revision!==result.revision)throw new Error('Page changed during timeline extraction');
      await tx.addTimelineEntriesBatch(timeline);
    });
    await opts.yieldDuringPhase?.();
  }
  return created;
}

async function countCaptureLinkGaps(
  engine: BrainEngine,
  entities:Array<{slug:string;sourceId:string}>,
  sources:Array<{slug:string;sourceId:string;body:string}>,
): Promise<{ isolated: number; unlinkedMentions: number;linked:number }> {
  if (!entities.length) return { isolated: 0, unlinkedMentions: 0,linked:0 };
  const isolatedRows = await engine.executeRaw<{ n: number }>(
    `SELECT count(DISTINCT p.slug)::int AS n
       FROM pages p
      WHERE p.deleted_at IS NULL
        AND p.source_id||':'||p.slug = ANY($1::text[])
        AND NOT EXISTS (
          SELECT 1 FROM links l
           JOIN pages f ON f.id=l.from_page_id AND f.deleted_at IS NULL
           WHERE l.to_page_id = p.id
        )`,
    [entities.map(entity=>`${entity.sourceId}:${entity.slug}`)],
  );
  let unlinkedMentions=0;const linked=new Set<string>();
  const normalize=(value:string)=>value.replace(/[\s"'“”‘’]/gu,'');
  for(const entity of entities){
    const page=await engine.getPage(entity.slug,{sourceId:entity.sourceId});if(!page)continue;
    const names=[page.title,...(Array.isArray(page.frontmatter.aliases)?page.frontmatter.aliases.filter((x):x is string=>typeof x==='string'):[])];
    for(const source of sources){
      if(entity.sourceId!==source.sourceId&&entity.sourceId!=='default')continue;
      if(!names.some(name=>name.trim().length>=2&&normalize(source.body).includes(normalize(name))))continue;
      const rows=await engine.executeRaw(`SELECT 1 FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
        WHERE f.deleted_at IS NULL AND t.deleted_at IS NULL AND ((f.slug=$1 AND f.source_id=$2 AND t.slug=$3 AND t.source_id=$4)
          OR(f.slug=$3 AND f.source_id=$4 AND t.slug=$1 AND t.source_id=$2)) LIMIT 1`,[source.slug,source.sourceId,entity.slug,entity.sourceId]);
      if(rows.length)linked.add(`${entity.sourceId}:${entity.slug}`);else unlinkedMentions++;
    }
  }
  return {
    isolated: Number(isolatedRows[0]?.n ?? 0),
    unlinkedMentions,linked:linked.size,
  };
}

export async function runPhaseCaptureEntities(
  engine: BrainEngine,
  opts: CaptureEntitiesOpts = {},
): Promise<PhaseResult> {
  throwIfAborted(opts.signal, '[dream] capture entities');
  const selected = await selectEntityCaptureCandidates(engine, opts.sourceId);
  const candidates = opts.slugs ? selected.filter(page=>opts.slugs!.includes(page.slug)) : selected;
  if (candidates.length === 0) {
    return phaseResult('ok', '没有需要识别实体的资料', {
      pages_seen: 0,
      pages_submitted: 0,
      pages_remaining: 0,
      pages_failed: 0,
      entities_written: 0,
      written_slugs: [],
      source_slugs: [],
      skill: 'ingest',
    });
  }
  if (opts.dryRun) {
    return phaseResult('ok', `将按 ingest 检查 ${candidates.length} 份资料`, {
      pages_seen: candidates.length,
      pages_submitted: 0,
      pages_remaining: candidates.length,
      pages_failed: 0,
      entities_written: 0,
      written_slugs: [],
      source_slugs: [],
      skill: 'ingest',
      dry_run: true,
    });
  }

  const skillsDir = locateSignalDetectorSkillsDir();
  if (!skillsDir) {
    const summary = '找不到 ingest Skill，深度整理无法识别实体';
    return phaseResult('fail', summary, {
      pages_seen: candidates.length,
      pages_submitted: 0,
      pages_processed: 0,
      pages_remaining: candidates.length,
      reason: 'skill_not_found',
      stop_reason: 'failure',
      skill: 'ingest',
    }, { class: 'FilesystemError', code: 'skill_not_found', message: summary });
  }

  const chosen = await chooseCaptureModel(engine, opts);
  if (!chosen.ok) {
    const summary = captureReportLine({
      model: chosen.model,
      pagesProcessed: 0,
      pagesRemaining: candidates.length,
      entitiesCreated: 0,
      relationsCreated: 0,
      costCny: null,
      costCapCny: null,
      ollama: false,
      stopReason: 'model_unavailable',
    });
    return phaseResult('fail', summary, {
      model_id: chosen.model,
      model_source: chosen.source,
      pages_seen: candidates.length,
      pages_submitted: 0,
      pages_processed: 0,
      chunks_submitted: 0,
      chunks_processed: 0,
      pages_remaining: candidates.length,
      pages_failed: 0,
      entities_written: 0,
      relations_created: 0,
      written_slugs: [],
      source_slugs: [],
      reason: 'model_unavailable',
      stop_reason: 'model_unavailable',
      unavailable_reason: chosen.reason,
      report_line: summary,
      skill: 'ingest',
    }, { class: 'ModelUnavailable', code: 'model_unavailable', message: '实体识别模型不可用' });
  }
  const providerId = splitProviderModelId(chosen.model).provider;
  const executionMode = await resolveSubagentExecutionMode(engine, chosen.model);
  const modelDetails = {
    model_id: chosen.model,
    model_tier: 'subagent',
    model_source: chosen.source,
    provider_id: providerId,
    execution_mode: executionMode,
    fallback_used: false,
  };
  const prunedCounts={created:0};
  const relationsRemoved=await pruneEntityIngestLinks(engine,opts.sourceId,prunedCounts);
  const { runMentionPass } = await import('../mentions/pass.ts');
  const initialMentions=await runMentionPass(engine,{sourceId:opts.sourceId,signal:opts.signal,yieldDuringPhase:opts.yieldDuringPhase});
  if(initialMentions.state==='failed')throw new Error(initialMentions.error);
  const initialRepair=await repairCaptureRelations(engine,opts,initialMentions.processedSlugs);
  const budgetOpt = opts.budget;
  const batchSize = Math.max(1, opts.batchSize ?? ENTITY_CAPTURE_PAGE_BUDGET);
  const maxInputTokens = budgetOpt?.maxInputTokens
    ?? readTokenCap(await engine.getConfig('dream.entity_capture.max_input_tokens'), DEFAULT_ENTITY_CAPTURE_MAX_INPUT_TOKENS);
  const maxOutputTokens = budgetOpt?.maxOutputTokens
    ?? readTokenCap(await engine.getConfig('dream.entity_capture.max_output_tokens'), DEFAULT_ENTITY_CAPTURE_MAX_OUTPUT_TOKENS);
  const costCapCny = budgetOpt && 'costCapCny' in budgetOpt
    ? budgetOpt.costCapCny ?? null
    : readEntityCaptureCostCap(await engine.getConfig('dream.entity_capture.cost_cap_cny'));
  const cardPrices = configuredCnyPrices(chosen.model, providerId);
  const storedInput = storedPrice(await engine.getConfig('dream.entity_capture.price.input_cny_per_million'));
  const storedOutput = storedPrice(await engine.getConfig('dream.entity_capture.price.output_cny_per_million'));
  const inputPrice = budgetOpt && 'inputPriceCnyPerMillion' in budgetOpt
    ? budgetOpt.inputPriceCnyPerMillion ?? null
    : storedInput ?? cardPrices.input;
  const outputPrice = budgetOpt && 'outputPriceCnyPerMillion' in budgetOpt
    ? budgetOpt.outputPriceCnyPerMillion ?? null
    : storedOutput ?? cardPrices.output;
  const ollama = budgetOpt?.ollama ?? isOllamaModel(chosen.model, providerId);
  const maxDocumentInput=readTokenCap(await engine.getConfig('dream.entity_capture.document_max_input_tokens'),120_000);
  const maxDocumentOutput=readTokenCap(await engine.getConfig('dream.entity_capture.document_max_output_tokens'),isThinkingModel(chosen.model)?defaultMaxOutputTokens(chosen.model)*4:20_000);
  const maxDocumentTurns=Math.min(12,readTokenCap(await engine.getConfig('dream.entity_capture.document_max_turns'),6));
  const turnTimeoutMs=readTokenCap(await engine.getConfig('dream.entity_capture.turn_timeout_ms'),300_000);
  const configuredJobTimeout=readTokenCap(await engine.getConfig('dream.entity_capture.job_timeout_ms'),maxDocumentTurns*(turnTimeoutMs*2+30_000));
  const declaredOutputLimit=await engine.getConfig('dream.entity_capture.model_max_output_tokens');
  const modelOutputLimit=declaredOutputLimit?readTokenCap(declaredOutputLimit,defaultMaxOutputTokens(chosen.model)):undefined;
  const nonce = Date.now();
  const pendingPages: Array<{ page: EntityCaptureCandidate; chunks: EntityCaptureChunk[] }> = [];
  for (const page of candidates) {
    const pendingChunks: EntityCaptureChunk[] = [];
    for (const chunk of splitEntityCaptureCandidate(page)) {
      const key = entityCaptureIdempotencyKey(page, chunk.chunkIndex, chunk.chunkBody);
      if (await hasCompletedCaptureJob(engine, key)) continue;
      pendingChunks.push(chunk);
    }
    if (pendingChunks.length > 0) pendingPages.push({ page, chunks: pendingChunks });
  }
  if (pendingPages.length === 0) {
    return phaseResult('ok', '这些资料已经按 ingest 识别过实体', {
      ...modelDetails,
      pages_seen: candidates.length,
      pages_submitted: 0,
      pages_processed: 0,
      chunks_submitted: 0,
      chunks_processed: 0,
      pages_remaining: 0,
      pages_failed: 0,
      input_tokens: 0,
      output_tokens: 0,
      cost_cny: ollama ? 0 : null,
      cost_cap_cny: costCapCny,
      entities_written: 0,
      written_slugs: [],
      source_slugs: [],
      skill: 'ingest',
      skills_dir: skillsDir,
      ollama,
    });
  }

  const queue = new MinionQueue(engine);
  const childQueueName = `dream-inline-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const ownerToken = randomUUID();
  const childIds: number[] = [];
  const executedChildIds:number[]=[];
  const sourceSlugs = new Set<string>();
  const createdEntitySlugs = new Set<string>();
  const createdEntityRefs=new Map<string,{slug:string;sourceId:string}>();
  const sourceRefs=new Map<string,{slug:string;sourceId:string;body:string}>();
  const relationSlugs = new Set<string>(initialRepair.slugs);
  let pagesSubmitted = 0;
  let pagesProcessed = 0;
  let chunksSubmitted = 0;
  let chunksProcessed = 0;
  let directLinks = 0;
  const recognizedEntities=new Map<string,{slug:string;sourceId:string}>();
  const unresolvedReferences:unknown[]=[];
  let inputTokens = 0;
  let outputTokens = 0;
  let usageKnown = false;
  let usageMissing = false;
  let knownCost = ollama ? 0 : 0;
  let sawPricedUsage = ollama;
  let failedChunks = 0;
  let mentionLinks = initialMentions.created+prunedCounts.created;
  let extractLinks = initialRepair.extracted;
  let nerLinks = initialRepair.ner;
  let relationsRefreshed = false;
  let relationError = '';
  let modelError = '';
  let failureStop = false;
  let fatalFailure=false;
  const pageFailures:Array<{slug:string;sourceId:string;reason:string;stage:string;kind:CaptureStopReason;input_tokens:number;output_tokens:number;input_limit:number;output_limit:number;model_output_limit:number|null;turn_timeout_ms:number;job_timeout_ms:number}>=[];
  let failureReason: CaptureStopReason = 'failure';
  let budgetStop: 'tokens' | 'cost' | null = null;
  const failedPageSlugs = new Set<string>();
  const verifiedChildIds:number[]=[];
  const rememberRelationError = (error: unknown) => {
    if (opts.signal?.aborted) throw error;
    failureStop = true;
    fatalFailure=true;
    const message = error instanceof Error ? error.message : String(error);
    relationError = relationError ? `${relationError}；${message}` : message;
  };
  const alignWrittenGraph = async (extra: string[]) => {
    const refs=new Map([...createdEntityRefs,...recognizedEntities]);
    for(const reference of extra){const colon=reference.indexOf(':'),sourceId=colon<0?opts.sourceId??'default':reference.slice(0,colon),slug=colon<0?reference:reference.slice(colon+1);refs.set(`${sourceId}:${slug}`,{slug,sourceId});}
    if (refs.size === 0 || opts.signal?.aborted) return;
    try {
      const groups=new Map<string,string[]>();
      for(const ref of refs.values())groups.set(ref.sourceId,[...(groups.get(ref.sourceId)??[]),ref.slug]);
      for(const [sourceId,entitySlugs] of groups)await alignCapturedEntityGraph(engine,{sourceId,entitySlugs,sources:[...sourceRefs.values()].filter(source=>source.sourceId===sourceId||sourceId==='default').map(source=>({slug:`${source.sourceId}:${source.slug}`,body:source.body}))});
    } catch (error) {
      rememberRelationError(error);
    }
  };
  const stopState = () => captureBudgetStop({
    inputTokens,
    outputTokens,
    maxInputTokens,
    maxOutputTokens,
    usageKnown,
    costCny: ollama ? 0 : (sawPricedUsage ? knownCost : null),
    costCapCny: ollama ? null : costCapCny,
  });
  try {
    let cursor = 0;
    while (cursor < pendingPages.length) {
      throwIfAborted(opts.signal, '[dream] capture entities');
      const beforeIndex = await loadCaptureEntityIndex(engine, opts.sourceId);
      const batchEnd = Math.min(pendingPages.length, cursor + batchSize);
      while (cursor < batchEnd) {
        throwIfAborted(opts.signal, '[dream] capture entities');
        const pageStop = stopState();
        if (pageStop) {
          budgetStop = pageStop;
          break;
        }
        const item = pendingPages[cursor]!;
        cursor += 1;
        sourceRefs.set(`${item.page.sourceId}:${item.page.slug}`,item.page);
        let documentInput=0,documentOutput=0,documentTurns=0;
        let submittedForPage = 0;
        let completedForPage = 0;
        const entityIndex = await loadCaptureEntityIndex(engine, opts.sourceId);
        for (const chunk of item.chunks) {
          throwIfAborted(opts.signal, '[dream] capture entities');
          const chunkStop = stopState();
          if (chunkStop) {
            budgetStop = chunkStop;
            break;
          }
          const related = rankCaptureCandidates(chunk.chunkBody, entityIndex.filter(entity =>
            entity.sourceId === chunk.sourceId || entity.sourceId === 'default',
          ), { limit: ENTITY_CAPTURE_CANDIDATE_LIMIT, sourceId: chunk.sourceId });
          const baseKey = entityCaptureIdempotencyKey(chunk, chunk.chunkIndex, chunk.chunkBody);
          if(documentTurns>=maxDocumentTurns){budgetStop='tokens';modelError='本资料达到模型轮数上限，未完成分块可续跑';break;}
          const idempotencyKey = await retryableKey(engine, baseKey, nonce);
          const acknowledged=await acknowledgedIngestEntities(engine,chunk,entityIndex);
          const data: SubagentHandlerData = {
            prompt: buildEntityCapturePrompt(chunk, related,acknowledged),
            model: chosen.model,
            max_turns: maxDocumentTurns-documentTurns,
            turn_timeout_ms:turnTimeoutMs,
            model_output_limit:modelOutputLimit,
            no_self_fix: true,
            system: readIngestContract(skillsDir),
            ingest_context: {slug:chunk.slug,sourceId:chunk.sourceId,body:chunk.body,chunkBody:chunk.chunkBody,acknowledged:acknowledged.map(entity=>`${entity.sourceId}:${entity.slug}`)},
            usage_limits: {
              input: Math.max(0,Math.min(maxInputTokens-inputTokens,maxDocumentInput-documentInput)),
              output: Math.max(0,Math.min(maxOutputTokens-outputTokens,maxDocumentOutput-documentOutput)),
              cost_cny: ollama || costCapCny==null ? null : Math.max(0,costCapCny-knownCost),
              input_price: inputPrice,output_price:outputPrice,
            },
            allowed_tools: [...ENTITY_CAPTURE_TOOLS],
            allowed_slug_prefixes: [...ENTITY_CAPTURE_SLUG_PREFIXES],
            source_id: chunk.sourceId,
            skills_dir: skillsDir,
            discovery_profile: 'entity_capture',
          };
          const child = await queue.add(
            'subagent',
            data as unknown as Record<string, unknown>,
            {
              max_stalled: 0,
              idempotency_key: idempotencyKey,
              timeout_ms: Math.max(1,Math.min(configuredJobTimeout,opts.deadlineAtMs==null?Infinity:opts.deadlineAtMs-Date.now())),
              queue: childQueueName,
              private_queue_owner_job_id: opts.privateQueueOwnerJobId ?? null,
              private_queue_owner_token: ownerToken,
              private_queue_lease_ms: DEFAULT_PRIVATE_QUEUE_LEASE_MS,
            },
            { allowProtectedSubmit: true },
          );
          sourceSlugs.add(chunk.slug);
          submittedForPage += 1;
          chunksSubmitted += 1;
          childIds.push(child.id);
          const reused=child.status==='completed';
          if(!reused)executedChildIds.push(child.id);
           if(child.status!=='completed')try{await runSubagentsInline(
            engine,
            queue,
            childQueueName,
            opts.yieldDuringPhase,
            opts.handler,
            undefined,
            opts.signal,
           );}catch(error){if(!opts.signal?.aborted)throw error;}
           if(!opts.signal?.aborted)await opts.yieldDuringPhase?.();
          let job;
          try {
             job = opts.signal?.aborted?await queue.getJob(child.id):await waitForCompletion(queue, child.id, {
              timeoutMs: child.timeout_ms??configuredJobTimeout,
              pollMs: 200,
              signal: opts.signal,
              onPoll: opts.yieldDuringPhase,
            });
          } catch (error) {
            if (error instanceof TimeoutError) {
               modelError=`ingest_provider_timeout: ${error.message}`;
               job=await queue.getJob(child.id);
               if(job)job={...job,status:'dead',error_text:modelError};
             }else if(opts.signal?.aborted){
               job=await queue.getJob(child.id);
             }else{
               throw error;
             }
           }
           if(!job)throw new Error(`实体识别子任务 ${child.id} 不存在`);
           if(opts.signal?.aborted)job={...job,status:'dead',error_text:`ingest_provider_${ingestAbortKind(opts.signal)}: ${opts.signal.reason instanceof Error?opts.signal.reason.message:String(opts.signal.reason)}`};
          const reportedUsage = reused?{present:true,input:0,output:0}:usageFromJobResult(job.result);
          const usage = reportedUsage.present ? reportedUsage : {
            present: job.tokens_input > 0 || job.tokens_output > 0,
            input: job.tokens_input,
            output: job.tokens_output,
          };
          const chunkCost = captureChunkCostCny({
            usage,
            inputPriceCnyPerMillion: inputPrice,
            outputPriceCnyPerMillion: outputPrice,
            ollama,
          });
          if (!usage.present) usageMissing = true;
          else {
            usageKnown = true;
            inputTokens += usage.input;
            outputTokens += usage.output;
            documentInput+=usage.input;documentOutput+=usage.output;
          }
          if (ollama) {
            knownCost = 0;
            sawPricedUsage = true;
          } else if (chunkCost != null) {
            knownCost += chunkCost;
            sawPricedUsage = true;
          }
          const result=job.result as any;
          documentTurns+=reused?0:Number(result?.turns_count??0);
          directLinks+=reused?0:Number(result?.ingest_links_created??0);
          for(const ref of result?.ingest_entities??[])recognizedEntities.set(JSON.stringify([ref.sourceId,ref.slug]),ref);
          unresolvedReferences.push(...(result?.ingest_unresolved??[]));
          if (job.status !== 'completed' || result?.ingest_verified!==true || (result?.stop_reason && result.stop_reason!=='end_turn')) {
            failedChunks += 1;
            failedPageSlugs.add(chunk.slug);
            failureStop = true;
            fatalFailure=true;
            if(job.error_text?.includes('ingest_budget_tokens')){budgetStop='tokens';failureStop=pageFailures.length>0;}
            if(job.error_text?.includes('ingest_budget_cost')){budgetStop='cost';failureStop=pageFailures.length>0;}
            modelError = job.error_text ?? `实体识别子任务 ${job.id} 未通过 ingest 读回验收（${result?.stop_reason??job.status}）`;
            if (/\bingest[ _]/i.test(modelError) || job.status === 'completed') failureReason = 'ingest_validation';
            if(/ingest_output_truncated/.test(modelError)){failureReason='truncated';fatalFailure=false;}
            else if(/ingest receipt (?:missing|requires)|ingest invalid JSON|ingest_provider_parse/.test(modelError)){failureReason='parse';fatalFailure=false;}
            else if(/ingest_provider_(timeout|network|rate_limit|provider_5xx|user_stop|service_shutdown|aborted)/.test(modelError))failureReason=modelError.match(/ingest_provider_(timeout|network|rate_limit|provider_5xx|user_stop|service_shutdown|aborted)/)![1] as CaptureStopReason;
            else if(/ingest_provider_(auth|billing|model_not_found)/.test(modelError))failureReason='model_unavailable';
            else if(!budgetStop&&/\bingest /.test(modelError))fatalFailure=false;
            pageFailures.push({slug:chunk.slug,sourceId:chunk.sourceId,reason:modelError,stage:failureReason==='ingest_validation'?'entity_verification':'entity_ingest',kind:budgetStop??failureReason,input_tokens:usage.input,output_tokens:usage.output,input_limit:data.usage_limits!.input,output_limit:data.usage_limits!.output,model_output_limit:modelOutputLimit??null,turn_timeout_ms:turnTimeoutMs,job_timeout_ms:child.timeout_ms??configuredJobTimeout});
            break;
          }
          completedForPage += 1;
          verifiedChildIds.push(child.id);
          chunksProcessed += 1;
        }
        if (submittedForPage > 0) pagesSubmitted += 1;
        if (!budgetStop && completedForPage === item.chunks.length) pagesProcessed += 1;
        if (budgetStop || fatalFailure) break;
      }
      const afterIndex = await loadCaptureEntityIndex(engine, opts.sourceId);
      const known = new Set(beforeIndex.map(entity => `${entity.sourceId}\0${entity.slug}`));
      for (const entity of afterIndex) {
        if (!known.has(`${entity.sourceId}\0${entity.slug}`)){createdEntitySlugs.add(entity.slug);createdEntityRefs.set(`${entity.sourceId}:${entity.slug}`,entity);}
      }
      const needles = deltaCaptureNeedles(beforeIndex, afterIndex);
      if (needles.length > 0 && !opts.signal?.aborted) {
        try {
          const linked = await linkNewCaptureEntities(engine, opts, [...createdEntitySlugs]);
          mentionLinks += linked.mention;
          nerLinks += linked.ner;
          extractLinks += linked.extracted;
          for (const slug of linked.slugs) relationSlugs.add(slug);
          relationsRefreshed = true;
        } catch (error) {
          rememberRelationError(error);
        }
      }
      await alignWrittenGraph([]);
       if(!opts.signal?.aborted)await opts.yieldDuringPhase?.();
       if(opts.signal?.aborted){failureStop=true;fatalFailure=true;failureReason=ingestAbortKind(opts.signal);}
      if (budgetStop || fatalFailure) break;
    }

    const written = executedChildIds.length === 0
      ? []
      : await engine.executeRaw<{ slug: string }>(
        `SELECT DISTINCT COALESCE(output->>'slug',(output #>> '{}')::jsonb->>'slug',input->>'slug', (input #>> '{}')::jsonb->>'slug') AS slug
           FROM subagent_tool_executions
          WHERE job_id = ANY($1::int[])
            AND tool_name = 'brain_put_page'
            AND status = 'complete' AND COALESCE(output->>'status',(output #>> '{}')::jsonb->>'status','') NOT IN ('merge_required','unchanged')`,
        [executedChildIds],
      );
    const writtenSlugs = written.map(row => row.slug).filter(slug => typeof slug === 'string' && slug.length > 0).sort();
    await alignWrittenGraph(writtenSlugs);
    if(verifiedChildIds.length&&!opts.signal?.aborted){
      try{
        const repaired=await repairCaptureRelations(engine,opts,[...recognizedEntities.values()]);
        nerLinks+=repaired.ner;extractLinks+=repaired.extracted;
        for(const slug of repaired.slugs)relationSlugs.add(slug);
      }catch(error){rememberRelationError(error);}
    }
    await engine.executeRaw("UPDATE minion_jobs SET result=jsonb_set(result,'{graph_reconciled}',$2::jsonb) WHERE id=ANY($1::int[])",[verifiedChildIds,JSON.stringify(!relationError)]);
    if(relationError)pagesProcessed=0;
    const failedPages = failedPageSlugs.size;
    const pagesRemaining = pendingPages.length - pagesProcessed;
    const entitiesCreated = createdEntityRefs.size;
    const [toolLinks]=executedChildIds.length ? await engine.executeRaw<{n:number}>(`SELECT COALESCE(sum((o->>'ingest_links_created')::int),0)::int n FROM
      (SELECT CASE WHEN jsonb_typeof(output)='string' THEN (output #>> '{}')::jsonb ELSE output END o FROM subagent_tool_executions WHERE job_id=ANY($1::int[]) AND status='complete'
        AND tool_name IN ('brain_put_page','brain_add_timeline_entry','brain_add_link')) x WHERE o ? 'ingest_links_created'`,[executedChildIds]) : [{n:0}];
    const relationsCreated = mentionLinks + nerLinks + extractLinks + directLinks + (toolLinks?.n??0);
    const recognized = [...new Map([...createdEntityRefs,...recognizedEntities].map(([,value])=>[`${value.sourceId}:${value.slug}`,value])).values()];
    const gaps = opts.dryRun
      ? { isolated: 0, unlinkedMentions: 0,linked:0 }
      : await countCaptureLinkGaps(engine, recognized,[...sourceRefs.values()]);
    const linkedEntities = gaps.linked;
    const costCny = ollama ? 0 : (sawPricedUsage ? Number(knownCost.toFixed(6)) : null);
    const stopReason: CaptureStopReason = relationError?'relation_failure':budgetStop === 'tokens'
        ? 'tokens'
        : budgetStop === 'cost'
          ? 'cost'
          : failureStop?failureReason:'completed';
    const cleanStatus: PhaseResult['status'] = failureStop
      ? (writtenSlugs.length > 0 || pagesProcessed > 0 ? 'warn' : 'fail')
      : pagesRemaining>0 ? 'warn' : 'ok';
    const status: PhaseResult['status'] = cleanStatus === 'ok' && (gaps.isolated > 0 || gaps.unlinkedMentions > 0 || unresolvedReferences.length>0)
      ? 'warn'
      : cleanStatus;
    const reportLine = captureReportLine({
      model: chosen.model,
      pagesProcessed,
      pagesRemaining,
      entitiesCreated,
      relationsCreated,
      costCny,
      costCapCny,
      ollama,
      stopReason,
      integrity: {
        recognized: recognized.length,
        linked: linkedEntities,
        isolated: gaps.isolated,
        unlinkedMentions: gaps.unlinkedMentions,
      },
    });
    const lastFailure=pageFailures.at(-1);
    const failureLine=lastFailure?`失败页：${lastFailure.sourceId}:${lastFailure.slug}；阶段：${lastFailure.stage==='entity_verification'?'落库验收':'实体识别'}；输入 Token ${lastFailure.input_tokens}/${lastFailure.input_limit}，输出 Token ${lastFailure.output_tokens}/${lastFailure.output_limit}；模型最大输出 ${lastFailure.model_output_limit??'未知'}；单次超时 ${turnTimeoutMs/1000} 秒。`:'';
    const summary = `${reportLine}${failureLine}${modelError ? `具体错误：${modelError}` : ''}${relationError ? `关系补写失败：${relationError}` : ''}`;
    return phaseResult(status, summary, {
      ...modelDetails,
      pages_seen: candidates.length,
      pages_submitted: pagesSubmitted,
      pages_processed: pagesProcessed,
      chunks_submitted: chunksSubmitted,
      chunks_processed: chunksProcessed,
      pages_remaining: pagesRemaining,
      pages_failed: failedPages,
      page_failures:pageFailures,
      chunks_failed: failedChunks,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      usage_missing: usageMissing,
      cost_cny: costCny,
      cost_cap_cny: costCapCny,
      budget_stop: budgetStop,
      stop_reason: stopReason,
      report_line: reportLine,
      ollama,
      entities_written: entitiesCreated,
      relations_created: relationsCreated,
      relations_removed: relationsRemoved,
      direct_links_created: directLinks+(toolLinks?.n??0),
      unresolved_references: unresolvedReferences,
      document_max_turns:maxDocumentTurns,
      document_max_input_tokens:maxDocumentInput,
      document_max_output_tokens:maxDocumentOutput,
      max_input_tokens:maxInputTokens,
      max_output_tokens:maxOutputTokens,
      model_output_limit:modelOutputLimit??null,
      turn_timeout_ms:turnTimeoutMs,
      job_timeout_ms:configuredJobTimeout,
      cost_cap_enforced:ollama||inputPrice!=null&&outputPrice!=null,
      mention_links_created: mentionLinks,
      ner_links_created: nerLinks,
      extract_links_created: extractLinks,
      entities_recognized: recognized.length,
      entities_linked: linkedEntities,
      entities_isolated: gaps.isolated,
      unlinked_mentions: gaps.unlinkedMentions,
      relation_pages: relationSlugs.size,
      relation_slugs: [...relationSlugs].sort(),
      relations_refreshed: relationsRefreshed,
      written_slugs: writtenSlugs,
      source_slugs: [...sourceSlugs].sort(),
      skill: 'ingest',
      skills_dir: skillsDir,
    }, failureStop
      ? { class: stopReason === 'ingest_validation' ? 'IngestValidation' : stopReason === 'relation_failure' ? 'RelationReconciliation' : 'LLMError', code: stopReason, message: summary }
      : undefined);
  } finally {
    try {
      await queue.reconcilePrivateQueue(childQueueName, 'capture entities phase ended');
    } catch (error) {
      process.stderr.write(
        `[dream] capture entities private-queue cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
}
