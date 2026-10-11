import { prepareLinkReconciliation } from '../core/link-reconciliation.ts';
import { runMentionPass, type MentionPassResult } from '../core/mentions/pass.ts';
import { previewMentionPass } from '../core/mentions/stale.ts';
/**
 * `pmbrain extract --stale` — incremental link + timeline extraction
 * over pages whose links_extracted_at watermark is stale.
 *
 * Ported from GBrain v0.42.7. Does not enable global-basename wikilink
 * resolution; Source-local then default fallback stays as PMBrain policy.
 */

import type { BrainEngine, TimelineBatchInput } from '../core/engine.ts';

import {
  parseTimelineEntries,
  LINK_EXTRACTOR_VERSION_TS,
} from '../core/link-extraction.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import {
  GinIndexUnusableError,
  isGinCorruptionError,
  repairPgliteGinIndexes,
} from '../core/pglite-gin-repair.ts';

const BATCH_SIZE = 100;
const STALE_BATCH_SIZE = Math.max(1, Number(process.env.PMBRAIN_EXTRACT_STALE_BATCH || process.env.GBRAIN_EXTRACT_STALE_BATCH) || 25);

export interface ExtractStaleBatchTiming {
  range: string;
  pages: number;
  readMs: number;
  parseMs: number;
  resolveMs: number;
  writeLinksMs: number;
  writeTimelineMs: number;
  markExtractedMs: number;
  totalMs: number;
  links: number;
  timeline: number;
  unresolved: number;
  engine: string;
  pagesProcessed: number;
}
export const STALE_TIME_BUDGET_MS = Math.max(
  1000,
  Number(process.env.PMBRAIN_EXTRACT_TIME_BUDGET_MS || process.env.GBRAIN_EXTRACT_TIME_BUDGET_MS) || 30 * 60 * 1000,
);

export async function extractStaleFromDB(
  engine: BrainEngine,
  opts: {
    dryRun: boolean;
    jsonMode: boolean;
    includeFrontmatter?: boolean;
    sourceIdFilter?: string;
    catchUp: boolean;
    /** Suppress progress and summaries for Quick Maintenance/library callers. */
    quiet?: boolean;
    /** Optional deterministic page cap for advanced/library callers. */
    maxPages?: number;
    timeBudgetMs?: number;
    catalogAware?: boolean;
    signal?: AbortSignal;
    yieldDuringPhase?: () => Promise<void>;
  },
): Promise<{
  linksCreated: number;
  timelineCreated: number;
  pagesProcessed: number;
  staleRemaining: number;
  skippedMissingTarget: number;
  skippedCrossSource: number;
  unresolvedReferences: number;
  batchTimings: ExtractStaleBatchTiming[];
  processedSlugs: Array<{slug:string;sourceId:string}>;
  mentions?: MentionPassResult;
}> {
  const { dryRun, jsonMode, includeFrontmatter, sourceIdFilter, catchUp } = opts;
  const quiet = opts.quiet ?? false;
  opts.signal?.throwIfAborted();
  // A catalog change must not move versionTs. Ordinary edits stay on the
  // page watermark. A new entity or alias only reopens historical pages
  // whose text can mention that new name.
  const versionTs = LINK_EXTRACTOR_VERSION_TS;
  const deadline=catchUp?Infinity:Date.now()+(opts.timeBudgetMs??STALE_TIME_BUDGET_MS);
  let mention:MentionPassResult|null=null;
  const mentionCreated=()=>mention?.created??0;
  const mentionRemaining=()=>mention?.remaining??0;
  const processedSlugs: Array<{slug:string;sourceId:string}>=[];
  const finishMentions=async()=>{
    if(opts.catalogAware===false||dryRun)return;
    mention=await runMentionPass(engine,{sourceId:sourceIdFilter,deadline,signal:opts.signal,maxPages:opts.maxPages,yieldDuringPhase:opts.yieldDuringPhase});
    if(mention.state==='failed')throw new Error(mention.error);
    for(const ref of mention.processedSlugs)if(!processedSlugs.some(p=>p.slug===ref.slug&&p.sourceId===ref.sourceId))processedSlugs.push(ref);
  };
  const queuedFreshPages=dryRun && opts.catalogAware !== false ? (await previewMentionPass(engine,sourceIdFilter)).due : 0;
  const totalStale = await engine.countStalePagesForExtraction({ sourceId: sourceIdFilter, versionTs })
    + (dryRun ? queuedFreshPages : 0);
  if (dryRun) {
    if (quiet) {
      // Library callers consume the return value.
    } else if (jsonMode) {
      process.stdout.write(JSON.stringify({ action: 'extract_stale_dry_run', stale_pages: totalStale }) + '\n');
    } else {
      console.log(`(dry run) ${totalStale} 个知识页需要补抽关系和时间线。去掉 --dry-run 才会真正抽取。`);
    }
    return {
      linksCreated: 0, timelineCreated: 0, pagesProcessed: 0, staleRemaining: totalStale,
      skippedMissingTarget: 0, skippedCrossSource: 0, unresolvedReferences: 0,
      batchTimings: [], processedSlugs,
    };
  }
  if (totalStale === 0) {
    await finishMentions();
    if (!quiet && !jsonMode) console.log('没有过期页面，关系抽取是最新的。');
    return {
      linksCreated: mentionCreated(), timelineCreated: 0, pagesProcessed: processedSlugs.length, staleRemaining: mentionRemaining(),
      skippedMissingTarget: 0, skippedCrossSource: 0, unresolvedReferences: 0,
      batchTimings: [], processedSlugs, mentions:mention??undefined,
    };
  }

  const reconcile=await prepareLinkReconciliation(engine);
  const batchTimings: ExtractStaleBatchTiming[]=[];
  let resolveMs=0;
  const progress = quiet
    ? { start(_label?: string, _total?: number) {}, tick(_count?: number) {}, finish() {} }
    : createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('extract.stale', totalStale);

  let ginRepaired = false;
  let afterPageId = 0;
  let linksCreated = 0;
  let timelineCreated = 0;
  let pagesProcessed = 0;
  let budgetHit = false;
  let skippedMissingTarget = 0;
  let skippedCrossSource = 0;
  let unresolvedReferences = 0;
  const maxPages = typeof opts.maxPages === 'number' && Number.isFinite(opts.maxPages)
    ? Math.max(0, Math.floor(opts.maxPages))
    : null;

  for (;;) {
    opts.signal?.throwIfAborted();
    if (maxPages !== null && pagesProcessed >= maxPages) break;
    const batchSize = maxPages === null
      ? STALE_BATCH_SIZE
      : Math.min(STALE_BATCH_SIZE, maxPages - pagesProcessed);
    if (batchSize <= 0) break;
    const batchStarted = performance.now();
    const readStarted = performance.now();
    const rows = await engine.listStalePagesForExtraction({
      batchSize,
      afterPageId,
      sourceId: sourceIdFilter,
      versionTs,
    });
    const readMs = performance.now() - readStarted;
    if (rows.length === 0) break;

    let parseMs=0;
    let batchUnresolved=0;
    const resolveBefore=resolveMs;
    const revisions:Array<{slug:string;sourceId:string;revision:string}>=[];
    const timelineRows:TimelineBatchInput[]=[];
    const processedRefs:Array<{slug:string;source_id:string;extractedAt:string}>=[];
    let reconciledLinks=0;
    let writeLinksMs = 0;
    for(const page of rows){
      opts.signal?.throwIfAborted();
      const extracted=await reconcile(page.slug,page.source_id,{includeFrontmatter});
      resolveMs+=extracted.timings.resolveMs;
      writeLinksMs+=extracted.timings.writeMs;
      reconciledLinks+=extracted.created;
      batchUnresolved+=extracted.unresolved.length;
      unresolvedReferences+=extracted.unresolved.length;
      skippedMissingTarget+=extracted.skippedMissingTarget;
      revisions.push({slug:page.slug,sourceId:page.source_id,revision:extracted.revision});
      processedSlugs.push({slug:page.slug,sourceId:page.source_id});
      for(const entry of parseTimelineEntries(extracted.page.compiled_truth+'\n'+extracted.page.timeline))timelineRows.push({slug:page.slug,date:entry.date,summary:entry.summary,detail:entry.detail||'',source:entry.source||'',source_id:page.source_id});
      processedRefs.push({slug:page.slug,source_id:page.source_id,extractedAt:page.updated_at.getTime()>=Date.parse(versionTs)?page.updated_at_iso:versionTs});
    }

    let writeTimelineMs = 0;
    let markExtractedMs = 0;
    const persistBatch = async (): Promise<{ links: number; timeline: number }> => {
      opts.signal?.throwIfAborted();
      return engine.transaction(async tx=>{
        for(const ref of revisions){
          const [current]=await tx.executeRaw<{revision:string}>('SELECT knowledge_revision::text AS revision FROM pages WHERE slug=$1 AND source_id=$2 AND deleted_at IS NULL FOR SHARE',[ref.slug,ref.sourceId]);
          if(current?.revision!==ref.revision){const error=new Error('Page changed during relation extraction');Object.assign(error,{code:'revision_conflict'});throw error;}
        }
        let timeline=0;
        const timelineStarted=performance.now();
        for(let i=0;i<timelineRows.length;i+=BATCH_SIZE)timeline+=await tx.addTimelineEntriesBatch(timelineRows.slice(i,i+BATCH_SIZE),{auditSite:'extract.stale'});
        writeTimelineMs+=performance.now()-timelineStarted;
        const markStarted=performance.now();
        await tx.markPagesExtractedBatch(processedRefs,new Date().toISOString());
        markExtractedMs+=performance.now()-markStarted;
        return {links:reconciledLinks,timeline};
      });
    };
    let persisted: { links: number; timeline: number };
    try {
      persisted = await persistBatch();
    } catch (error) {
      if (engine.kind !== 'pglite' || !isGinCorruptionError(error)) throw error;
      if (ginRepaired) {
        throw error instanceof GinIndexUnusableError
          ? error
          : new GinIndexUnusableError(error instanceof Error ? error.message : String(error), { cause: error });
      }
      const result = await repairPgliteGinIndexes(engine);
      if (result.status !== 'repaired') {
        throw new GinIndexUnusableError(result.message, { status: result.status, cause: error });
      }
      ginRepaired = true;
      persisted = await persistBatch();
    }
    linksCreated += persisted.links;
    timelineCreated += persisted.timeline;

    pagesProcessed += rows.length;
    const timing: ExtractStaleBatchTiming = {
      range: `${pagesProcessed - rows.length + 1}-${pagesProcessed}`,
      pages: rows.length,
      readMs,
      parseMs,
      resolveMs: resolveMs - resolveBefore,
      writeLinksMs,
      writeTimelineMs,
      markExtractedMs,
      totalMs: performance.now() - batchStarted,
      links: persisted.links,
      timeline: persisted.timeline,
      unresolved: batchUnresolved,
      engine: engine.kind,
      pagesProcessed,
    };
    batchTimings.push(timing);
    const roundMs = (value: number) => Math.round(value);
    console.error(
      `[extract-stale] ${timing.range} engine=${timing.engine} read=${roundMs(timing.readMs)}ms parse=${roundMs(timing.parseMs)}ms resolve=${roundMs(timing.resolveMs)}ms write_links=${roundMs(timing.writeLinksMs)}ms write_timeline=${roundMs(timing.writeTimelineMs)}ms mark_extracted=${roundMs(timing.markExtractedMs)}ms total=${roundMs(timing.totalMs)}ms links=${timing.links} timeline=${timing.timeline} unresolved=${timing.unresolved} cumulative=${timing.pagesProcessed}`,
    );
    progress.tick(rows.length);
    afterPageId = rows[rows.length - 1]!.id;
    await opts.yieldDuringPhase?.();

    if (!catchUp && Date.now() > deadline) {
      budgetHit = true;
      break;
    }
  }

  progress.finish();
  await finishMentions();
  linksCreated+=mentionCreated();
  const staleRemaining = await engine.countStalePagesForExtraction({ sourceId: sourceIdFilter, versionTs });

  if (!quiet && !jsonMode) {
    console.log(`Extract --stale: 从 ${pagesProcessed} 个页面写入 ${linksCreated} 条关系、${timelineCreated} 条时间线。`);
    if (skippedMissingTarget > 0) {
      console.log(`跳过 ${skippedMissingTarget} 个目标页不存在的候选引用。`);
    }
    if (skippedCrossSource > 0) {
      console.log(`跳过 ${skippedCrossSource} 个只存在于其他 Source 的候选引用；PMBrain 不自动串联不同 Source。`);
    }
    if (unresolvedReferences > 0) {
      console.log(`还有 ${unresolvedReferences} 个 WikiLink/frontmatter 引用无法解析。`);
    }
    if (budgetHit && staleRemaining > 0) {
      console.log(`时间预算已到，还有 ${staleRemaining} 个页面过期。再跑一次 pmbrain extract --stale，或加上 --catch-up。`);
    }
  } else if (!quiet) {
    process.stdout.write(JSON.stringify({
      action: 'extract_stale_done',
      links_created: linksCreated,
      timeline_created: timelineCreated,
      pages_processed: pagesProcessed,
      stale_remaining: staleRemaining,
      budget_hit: budgetHit,
      skipped_missing_target: skippedMissingTarget,
      skipped_cross_source: skippedCrossSource,
      unresolved_references: unresolvedReferences,
    }) + '\n');
  }
  return {
    linksCreated,
    timelineCreated,
    pagesProcessed:processedSlugs.length,
    staleRemaining:Math.max(staleRemaining,mentionRemaining()),
    skippedMissingTarget,
    skippedCrossSource,
    unresolvedReferences,
    batchTimings,
    processedSlugs,
    mentions:mention??undefined,
  };
}

const MIN_NAME_LENGTH = 4;
const MIN_CJK_NAME_LENGTH = 2;
const CJK_RE = /\p{Script=Han}/gu;

function cjkCharCount(text: string): number {
  CJK_RE.lastIndex = 0;
  return Array.from(text.matchAll(CJK_RE)).length;
}

function isSearchNeedle(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  const cjk = cjkCharCount(trimmed);
  if (cjk === 0) return trimmed.length >= MIN_NAME_LENGTH;
  return cjk >= MIN_CJK_NAME_LENGTH;
}

export async function findPagesContainingNeedles(
  engine: BrainEngine,
  needles: Array<{ sourceId: string; needle: string }>,
  sourceIdFilter?: string,
): Promise<string[]> {
  const usable = needles.filter(item => isSearchNeedle(item.needle));
  if (usable.length === 0) return [];
  const params: unknown[] = [usable.map(item => item.needle), usable.map(item => item.sourceId)];
  let sourceSql = '';
  if (sourceIdFilter) {
    params.push(sourceIdFilter);
    sourceSql = `AND p.source_id = $${params.length}`;
  }
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT DISTINCT p.slug
       FROM pages p
      WHERE p.deleted_at IS NULL
        ${sourceSql}
        AND EXISTS (
          SELECT 1 FROM unnest($1::text[], $2::text[]) AS n(needle, source_id)
           WHERE (n.source_id = 'default' OR p.source_id = n.source_id)
             AND (
               strpos(lower(normalize(COALESCE(p.compiled_truth, ''), NFKC)), lower(n.needle)) > 0
               OR strpos(lower(normalize(COALESCE(p.timeline, ''), NFKC)), lower(n.needle)) > 0
             )
        )`,
    params,
  );
  return rows.map(row => row.slug).filter(slug => slug.length > 0);
}

export async function stampExtractedPages(
  engine: BrainEngine,
  refs: Array<{ slug: string; source_id: string }>,
): Promise<void> {
  if (refs.length === 0) return;
  await engine.markPagesExtractedBatch(refs, new Date().toISOString());
}
