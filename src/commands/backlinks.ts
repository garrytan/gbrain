/**
 * gbrain check-backlinks — Check and fix missing back-links across brain pages.
 *
 * Deterministic: zero LLM calls. Scans pages for entity mentions,
 * checks if back-links exist, and optionally creates them.
 *
 * Usage:
 *   gbrain check-backlinks check [--dir <brain-dir>]     # report missing back-links
 *   gbrain check-backlinks fix [--dir <brain-dir>]        # create missing back-links
 *   gbrain check-backlinks fix --dry-run                  # preview fixes
 */

import { readFileSync, writeFileSync, readdirSync, statSync, lstatSync, existsSync } from 'fs';
import { join, relative, basename } from 'path';
import { readFile } from 'node:fs/promises';
import { extractEntityRefs as canonicalExtractEntityRefs } from '../core/link-extraction.ts';
import { createProgress, startHeartbeat } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import { findTimelineSplitIndex } from '../core/markdown.ts';

interface BacklinkGap {
  /** The page that mentions the entity */
  sourcePage: string;
  /** The entity page that's missing the back-link */
  targetPage: string;
  /** The entity name mentioned */
  entityName: string;
  /** The source page title */
  sourceTitle: string;
}

/**
 * Extract entity references from markdown content for the filesystem-based
 * back-link walker. Filters to people/companies only (this command historically
 * targets just those two dirs). Slug is returned WITHOUT the dir prefix to
 * preserve the legacy shape used by findBacklinkGaps and fixBacklinkGaps below.
 *
 * The canonical extractor (link-extraction.ts) returns dir-prefixed slugs
 * (e.g. "people/alice"); this wrapper strips the prefix back off so existing
 * filesystem-walker code that does `${dir}/${slug}` keeps working.
 */
export function extractEntityRefs(content: string, _pagePath: string): { name: string; slug: string; dir: string }[] {
  const refs = canonicalExtractEntityRefs(content);
  return refs
    .filter(r => r.dir === 'people' || r.dir === 'companies')
    .map(r => ({
      name: r.name,
      slug: r.slug.startsWith(`${r.dir}/`) ? r.slug.slice(r.dir.length + 1) : r.slug,
      dir: r.dir,
    }));
}

/** Extract title from page (first H1 or frontmatter title) */
export function extractPageTitle(content: string): string {
  const fmMatch = content.match(/^title:\s*"?(.+?)"?\s*$/m);
  if (fmMatch) return fmMatch[1];
  const h1Match = content.match(/^#\s+(.+)$/m);
  if (h1Match) return h1Match[1].trim();
  return 'Untitled';
}

/** Check if a page already contains a back-link to a given source file */
export function hasBacklink(targetContent: string, sourceFilename: string): boolean {
  return targetContent.includes(sourceFilename);
}

/** Build an undated back-link entry without inventing event chronology. */
export function buildBacklinkEntry(sourceTitle: string, sourcePath: string): string {
  const bare = sourcePath.replace(/^(?:\.\.\/)+/, '');
  const linkPath = bare.includes('/') ? sourcePath.replace(/\.md$/, '') : sourcePath;
  return `- Referenced in [${sourceTitle}](${linkPath})`;
}

function frontmatterBodyOffset(content: string): number {
  if (!content.startsWith('---')) return 0;
  const match = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  return match?.[0].length ?? 0;
}

/** Insert an undated backlink above Timeline/History in a dedicated section. */
export function insertBacklinkEntry(content: string, bodyStart: number, entry: string): string {
  const bodySlice = content.slice(bodyStart);
  const lines = bodySlice.split('\n');
  const splitIndex = findTimelineSplitIndex(lines);
  let timelineStart = content.length;
  if (splitIndex >= 0) {
    timelineStart = bodyStart;
    for (let i = 0; i < splitIndex; i++) timelineStart += lines[i].length + 1;
  } else {
    const bareTimeline = /^## (?:Timeline|History)[ \t]*\r?$/im.exec(bodySlice);
    if (bareTimeline) timelineStart = bodyStart + bareTimeline.index;
  }

  const beforeTimeline = content.slice(bodyStart, timelineStart);
  const headingMatch = /^## Referenced by[ \t]*\r?$/im.exec(beforeTimeline);
  const eol = bodySlice.includes('\r\n') ? '\r\n' : '\n';
  if (headingMatch) {
    const headingAbs = bodyStart + headingMatch.index;
    const headingLineEnd = content.indexOf('\n', headingAbs);
    const sectionStart = headingLineEnd === -1 ? content.length : headingLineEnd + 1;
    const nextHeading = /^##\s+\S/m.exec(content.slice(sectionStart, timelineStart));
    const sectionEnd = nextHeading ? sectionStart + nextHeading.index : timelineStart;
    const suffix = content.slice(sectionEnd);
    const updated = content.slice(0, sectionEnd).trimEnd() + eol + entry + eol;
    return suffix ? updated + eol + suffix : updated;
  }

  const prefix = content.slice(0, timelineStart).trimEnd();
  const suffix = content.slice(timelineStart);
  const section = `${prefix}${prefix ? eol + eol : ''}## Referenced by${eol}${eol}${entry}${eol}`;
  return suffix ? section + eol + suffix : section;
}

/** Backward-compatible name for callers that imported the old helper. */
export const insertTimelineEntry = insertBacklinkEntry;

/** Scan a brain directory for back-link gaps */
function collectBacklinkPages(brainDir:string):{path:string;relPath:string}[]{
  const allPages: { path: string; relPath: string }[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (lstatSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.md') && !entry.startsWith('_')) {
        const relPath = relative(brainDir, full).replace(/\\/g, '/');
        allPages.push({ path: full, relPath });
      }
    }
  }
  walk(brainDir);
  return allPages;
}

class BacklinkBodyCache {
  private entries=new Map<string,{text:string;bytes:number}>();
  bytes=0;
  constructor(private budget:number){}
  get(path:string):string|undefined{
    const entry=this.entries.get(path);
    if(entry){this.entries.delete(path);this.entries.set(path,entry);}
    return entry?.text;
  }
  put(path:string,text:string):void{
    const bytes=Buffer.byteLength(text)+text.length*2;
    if(bytes>this.budget)return;
    while(this.bytes+bytes>this.budget&&this.entries.size){
      const key=this.entries.keys().next().value!;
      this.bytes-=this.entries.get(key)!.bytes;this.entries.delete(key);
    }
    this.entries.set(path,{text,bytes});this.bytes+=bytes;
  }
}

function* backlinkCandidates(content:string,relPath:string,paths:Map<string,string>){
  const seen=new Set<string>();
  for(const ref of extractEntityRefs(content,relPath)){
    const slug=`${ref.dir}/${ref.slug}`;
    if(seen.has(slug))continue;
    seen.add(slug);
    const path=paths.get(slug);
    if(path)yield {path,gap:{sourcePage:relPath,targetPage:slug+'.md',entityName:ref.name,sourceTitle:extractPageTitle(content)}};
  }
}

export function findBacklinkGaps(brainDir: string): BacklinkGap[] {
  const pages=collectBacklinkPages(brainDir);
  const paths=new Map(pages.map(page=>[page.relPath.replace('.md',''),page.path]));
  const cache=new BacklinkBodyCache(8*1024**2);
  const gaps:BacklinkGap[]=[];
  for(const page of pages){
    let content:string;
    try{content=readFileSync(page.path,'utf8');}catch{continue;}
    for(const {path,gap} of backlinkCandidates(content,page.relPath,paths)){
      let target=cache.get(path);
      if(target===undefined){try{target=readFileSync(path,'utf8');cache.put(path,target);}catch{continue;}}
      if(!hasBacklink(target,basename(page.relPath)))gaps.push(gap);
    }
  }
  return gaps;
}

export interface BacklinkScanOptions {
  signal?:AbortSignal;
  cacheBytes?:number;
  onProgress?:(row:{processed:number;total:number;cachedBytes:number})=>void;
}

export async function findBacklinkGapsBounded(brainDir:string,options:BacklinkScanOptions={}):Promise<BacklinkGap[]>{
  options.signal?.throwIfAborted();
  const pages=collectBacklinkPages(brainDir);
  const paths=new Map(pages.map(page=>[page.relPath.replace('.md',''),page.path]));
  const cache=new BacklinkBodyCache(Math.max(0,options.cacheBytes??8*1024**2));
  const gaps:BacklinkGap[]=[];
  let processed=0;
  for(const page of pages){
    options.signal?.throwIfAborted();
    let content:string;
    try{content=await readFile(page.path,'utf8');}catch{processed++;continue;}
    options.signal?.throwIfAborted();
    for(const {path,gap} of backlinkCandidates(content,page.relPath,paths)){
      options.signal?.throwIfAborted();
      let target=cache.get(path);
      if(target===undefined){try{target=await readFile(path,'utf8');cache.put(path,target);}catch{continue;}}
      if(!hasBacklink(target,basename(page.relPath)))gaps.push(gap);
    }
    options.onProgress?.({processed:++processed,total:pages.length,cachedBytes:cache.bytes});
  }
  options.signal?.throwIfAborted();
  return gaps;
}

/** Fix back-link gaps by adding undated entries outside the event timeline. */
export function fixBacklinkGaps(brainDir: string, gaps: BacklinkGap[], dryRun: boolean = false): number {
  let fixed = 0;

  // Group gaps by target page to batch writes
  const byTarget = new Map<string, BacklinkGap[]>();
  for (const gap of gaps) {
    const existing = byTarget.get(gap.targetPage) || [];
    existing.push(gap);
    byTarget.set(gap.targetPage, existing);
  }

  for (const [targetPage, targetGaps] of byTarget) {
    const targetPath = join(brainDir, targetPage);
    if (!existsSync(targetPath)) continue;

    let content = readFileSync(targetPath, 'utf-8');

    for (const gap of targetGaps) {
      // Compute relative path from target to source
      const targetDir = targetPage.split('/').slice(0, -1);
      const sourceDir = gap.sourcePage.split('/');
      const depth = targetDir.length;
      const relPrefix = '../'.repeat(depth);
      const relPath = relPrefix + gap.sourcePage;

      const entry = buildBacklinkEntry(gap.sourceTitle, relPath);
      content = insertBacklinkEntry(content, frontmatterBodyOffset(content), entry);
      fixed++;
    }

    if (!dryRun) {
      writeFileSync(targetPath, content);
    }
  }

  return fixed;
}

export interface BacklinksOpts {
  signal?:AbortSignal;
  action: 'check' | 'fix';
  dir: string;
  dryRun?: boolean;
}

export interface BacklinksResult {
  action: 'check' | 'fix';
  gaps_found: number;
  fixed: number;
  pages_affected: number;
  dryRun: boolean;
}

/**
 * Library-level backlinks check/fix. Throws on validation errors; returns a
 * structured result so Minions handlers + autopilot-cycle can surface counts.
 * Safe to call from the worker — no process.exit.
 */
export async function runBacklinksCore(opts: BacklinksOpts): Promise<BacklinksResult> {
  if (!['check', 'fix'].includes(opts.action)) {
    throw new Error(`Invalid backlinks action "${opts.action}". Allowed: check, fix.`);
  }
  if (!existsSync(opts.dir)) {
    throw new Error(`Directory not found: ${opts.dir}`);
  }

  // findBacklinkGaps is a sync double-walk of the brain dir. On 50K-page
  // brains that can take seconds — heartbeat so agents see we're working.
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('backlinks.scan');
  const stopHb = startHeartbeat(progress, 'walking pages for missing back-links…');
  let gaps: BacklinkGap[];
  try {
    gaps = await findBacklinkGapsBounded(opts.dir,{signal:opts.signal});
  } finally {
    stopHb();
    progress.finish();
  }
  const pagesAffected = new Set(gaps.map(g => g.targetPage)).size;

  if (opts.action === 'fix' && gaps.length > 0) {
    const fixed = fixBacklinkGaps(opts.dir, gaps, !!opts.dryRun);
    return { action: 'fix', gaps_found: gaps.length, fixed, pages_affected: pagesAffected, dryRun: !!opts.dryRun };
  }
  return { action: opts.action, gaps_found: gaps.length, fixed: 0, pages_affected: pagesAffected, dryRun: !!opts.dryRun };
}

export async function runBacklinks(args: string[]) {
  const subcommand = args[0];
  const dirIdx = args.indexOf('--dir');
  const brainDir = dirIdx >= 0 ? args[dirIdx + 1] : '.';
  const dryRun = args.includes('--dry-run');

  if (!subcommand || !['check', 'fix'].includes(subcommand)) {
    console.error('Usage: gbrain check-backlinks <check|fix> [--dir <brain-dir>] [--dry-run]');
    console.error('  check    Report missing back-links');
    console.error('  fix      Create missing back-links (appends to Timeline)');
    console.error('  --dir    Brain directory (default: current directory)');
    console.error('  --dry-run  Preview fixes without writing');
    process.exit(1);
  }

  let result: BacklinksResult;
  try {
    result = await runBacklinksCore({
      action: subcommand as 'check' | 'fix',
      dir: brainDir,
      dryRun,
    });
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  if (result.gaps_found === 0) {
    console.log('No missing back-links found.');
    return;
  }
  if (result.action === 'check') {
    // Re-walk for user-facing output (core returns counts, CLI shows detail).
    const gaps = findBacklinkGaps(brainDir);
    console.log(`Found ${gaps.length} missing back-link(s):\n`);
    for (const gap of gaps) {
      console.log(`  ${gap.targetPage} <- ${gap.sourcePage}`);
      console.log(`    "${gap.entityName}" mentioned in "${gap.sourceTitle}"`);
    }
    console.log(`\nRun 'gbrain check-backlinks fix --dir ${brainDir}' to create them.`);
  } else {
    const label = result.dryRun ? '(dry run) ' : '';
    console.log(`${label}Fixed ${result.fixed} missing back-link(s) across ${result.pages_affected} page(s).`);
    if (result.dryRun) {
      console.log('\nRe-run without --dry-run to apply.');
    }
  }
}
