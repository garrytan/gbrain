/**
 * foresights nav — write the brain's navigation files at a source's root.
 *
 *   foresights nav [build] [--source <id>] [--out <dir>] [--dry-run] [--json]
 *
 * index.md   every page, grouped by folder, with a one-line summary
 * log.md     recent operations (the ingest log), newest first
 * hot.md     what changed in the last 7 days and recent activity, at most 500 words
 *
 * They go to the source's folder, where sync skips them at the root so they
 * never become pages. When that folder is a managed canonical worktree (only
 * the persistence coordinator writes files there, and it publishes pages, not
 * these), they go to ~/.gbrain/nav/<source>/ instead; --out picks any folder. Each is
 * editable: only the block between the gbrain:nav markers is rebuilt; a file
 * without the markers is left alone. Only pages git can see are named (or, in
 * a folder that is not a git repository, pages whose file exists and is not
 * `visibility: private`), so a private or git-ignored page's title never lands
 * in these files. Nothing is committed.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { collectGitVisibleFiles } from '../core/git-visible-files.ts';
import { assertManagedFilesystemWrite } from '../core/persistence/filesystem-guard.ts';
import { listInboxFiles } from '../core/ingestion/sources/inbox-folder.ts';
import { gbrainPath } from '../core/config.ts';
import { boundedBodyPrefixSql } from '../core/page-window/bounded-lead.ts';
import {
  mergeNavFile, renderHot, renderIndex, renderLog, type NavLogEntry, type NavMerge, type NavPage,
} from '../core/nav/nav-pages.ts';

const USAGE = `Usage: foresights nav [build] [--source <id>] [--out <dir>] [--dry-run] [--json]
  Writes index.md (every page by folder), log.md (recent operations) and hot.md (what is new)
  at the source's folder, or ~/.gbrain/nav/<source>/ when foresights manages that folder.
  Only the block between the gbrain:nav markers is rebuilt.
  --source <id>  the source (default: default)
  --out <dir>    the folder to write into
  --dry-run      say what would change; write nothing
  --json         machine-readable output`;

const FILES = {
  'index.md': { title: 'Index', intro: 'Every page in this brain, by folder. `foresights nav` rebuilds the marked block; your notes outside it stay.' },
  'log.md': { title: 'Log', intro: 'What happened in this brain, newest first. `foresights nav` rebuilds the marked block; your notes outside it stay.' },
  'hot.md': { title: 'Hot', intro: 'Read this first: what is new in this brain. `foresights nav` rebuilds the marked block; your notes outside it stay.' },
} as const;
type NavFile = keyof typeof FILES;

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined; // the CLI entry splits --flag=value (cli/flag-equals.ts)
}

async function sourceRoot(engine: BrainEngine, sourceId: string): Promise<string | null> {
  const [row] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id = $1', [sourceId]);
  if (row?.local_path) return row.local_path;
  return sourceId === 'default' ? (await engine.getConfig('sync.repo_path')) ?? null : null;
}

/** The pages these files may name: git-visible (or, outside git, present on disk and not private). */
async function listedPages(engine: BrainEngine, sourceId: string, root: string): Promise<NavPage[]> {
  // The summary is the body's first sentence, so a bounded prefix is enough (and works for a segmented page).
  const rows = await engine.executeRaw<{ slug: string; title: string | null; type: string | null; lead: string | null;
    updated_at: Date | string; source_path: string | null; visibility: string | null }>(
    `SELECT p.slug, p.title, p.type, ${boundedBodyPrefixSql('p')} AS lead, p.updated_at, p.source_path, p.frontmatter->>'visibility' AS visibility
       FROM pages p WHERE p.source_id = $1 AND p.deleted_at IS NULL AND p.source_path IS NOT NULL`, [sourceId]);
  const visible = collectGitVisibleFiles(root, rel => rel.endsWith('.md'));
  const gitSet = visible ? new Set(visible.map(f => f.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/'))) : null;
  const pages: NavPage[] = [];
  for (const r of rows) {
    const rel = r.source_path!.replace(/\\/g, '/').replace(/^\.\//, '');
    if (r.visibility === 'private') continue;
    if (rel.split('/').includes('..')) continue; // a recorded path never leaves the source's folder
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- root is the source's own folder from the sources row; rel is a recorded page path with no '..' segment (checked above); existence check only
    if (gitSet ? !gitSet.has(rel) : !existsSync(join(root, rel))) continue;
    if (/^(index|log|hot)\.md$/i.test(rel)) continue;
    pages.push({ slug: r.slug, title: r.title ?? r.slug, type: r.type, body: r.lead ?? '',
      updated_at: (r.updated_at instanceof Date ? r.updated_at : new Date(r.updated_at)).toISOString() });
  }
  return pages;
}

async function recentLog(engine: BrainEngine, sourceId: string, limit: number): Promise<NavLogEntry[]> {
  const rows = await engine.executeRaw<{ created_at: Date | string; source_type: string; source_ref: string; summary: string; pages_updated: unknown }>(
    'SELECT created_at, source_type, source_ref, summary, pages_updated FROM ingest_log WHERE source_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
    [sourceId, limit]);
  return rows.map(r => {
    const raw = typeof r.pages_updated === 'string' ? JSON.parse(r.pages_updated) : r.pages_updated;
    return { created_at: (r.created_at instanceof Date ? r.created_at : new Date(r.created_at)).toISOString(), source_type: r.source_type,
      source_ref: r.source_ref, summary: r.summary, pages_updated: Array.isArray(raw) ? raw.map(String) : [] };
  });
}

export interface NavResult {
  /** The source's folder the pages were checked against. */
  root: string;
  /** Where the files were written. */
  out: string;
  /** True when the source's folder is managed, so the files went to ~/.gbrain/nav/<source>/. */
  managed_root: boolean;
  files: Array<{ file: NavFile; action: NavMerge['action']; reason?: string }>;
}

/** Whether foresights's persistence coordinator owns this folder (a direct file write there is refused). */
function isManagedFolder(dir: string): boolean {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- dir is the source's own folder; the fixed name index.md is only probed, nothing is written
  try { assertManagedFilesystemWrite(join(dir, 'index.md')); return false; } catch { return true; }
}

/** Build the three files' blocks and merge them into whatever is on disk. Writes unless dryRun. */
export async function buildNav(engine: BrainEngine, opts: { sourceId?: string; out?: string; dryRun?: boolean; now?: Date }): Promise<NavResult> {
  const sourceId = opts.sourceId ?? 'default';
  const root = await sourceRoot(engine, sourceId);
  if (!root || !existsSync(root)) {
    throw new Error(`foresights nav: source "${sourceId}" has no folder on this machine${root ? ` (${root} is missing)` : ''}. Give the source a path with foresights sources set-path.`);
  }
  const managedRoot = !opts.out && isManagedFolder(root);
  const out = opts.out ?? (managedRoot ? gbrainPath('nav', sourceId) : root);
  if (!opts.dryRun) mkdirSync(out, { recursive: true });
  const now = opts.now ?? new Date();
  const pages = await listedPages(engine, sourceId, root);
  const listed = new Set(pages.map(p => p.slug));
  const log = await recentLog(engine, sourceId, 200);
  const weekAgo = now.getTime() - 7 * 24 * 3600 * 1000;
  const recent = pages.filter(p => Date.parse(p.updated_at) >= weekAgo).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 15);
  const inboxWaiting = sourceId === 'default' ? listInboxFiles(gbrainPath('inbox')).length : 0;
  const blocks: Record<NavFile, string> = {
    'index.md': renderIndex(pages),
    'log.md': renderLog(log, listed),
    'hot.md': renderHot(recent, log, listed, inboxWaiting, now),
  };
  const result: NavResult = { root, out, managed_root: managedRoot, files: [] };
  for (const file of Object.keys(FILES) as NavFile[]) {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- out is --out or the source's folder (or ~/.gbrain/nav/<source>); file is one of the three fixed names in FILES
    const path = join(out, file);
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
    const merged = mergeNavFile(existing, FILES[file].title, FILES[file].intro, blocks[file]);
    if ((merged.action === 'create' || merged.action === 'update') && !opts.dryRun) {
      assertManagedFilesystemWrite(path);
      writeFileSync(`${path}.tmp`, merged.content);
      renameSync(`${path}.tmp`, path);
    }
    result.files.push({ file, action: merged.action, ...(merged.action === 'refuse' ? { reason: merged.reason } : {}) });
  }
  return result;
}

export async function runNav(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return; }
  const sub = args[0] && !args[0].startsWith('--') ? args[0] : 'build';
  if (sub !== 'build') { console.error(USAGE); process.exitCode = 1; return; }
  const json = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  let result: NavResult;
  try {
    result = await buildNav(engine, { sourceId: flagValue(args, '--source'), out: flagValue(args, '--out'), dryRun });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  if (result.files.some(f => f.action === 'refuse')) process.exitCode = 1;
  if (json) { console.log(JSON.stringify({ ...result, dry_run: dryRun }, null, 2)); return; }
  const verb = (a: NavMerge['action']) => (dryRun ? { create: 'would create', update: 'would update', unchanged: 'unchanged', refuse: 'left alone' }
    : { create: 'created', update: 'updated', unchanged: 'unchanged', refuse: 'left alone' })[a];
  for (const f of result.files) console.log(`${f.file}: ${verb(f.action)}${f.reason ? `: ${f.reason}` : ''}`);
  console.log(`In ${result.out}${result.managed_root ? ` (foresights manages the source's folder ${result.root}, so the files are kept here)` : ''}. Nothing was committed.`);
}
