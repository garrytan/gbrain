/**
 * GST-2731 (GBRA-529 PR 3): `gbrain import <dir> --calls [--prefix <slug prefix>] [--source <id>] [--json]`.
 *
 * An opt-in text mode of the importer for exported call and meeting transcripts (saved as .txt or .md). Each file
 * becomes one page, <prefix>/<date>-<title slug> (prefix `calls` unless given):
 *
 *   - the date is the file name's leading YYYY-MM-DD, else the first date on the first line, else the file's
 *     modified day; the title is the rest of a dated file name, else the first line, else the file name;
 *   - the words are kept: the text is stored as written, after the same credential redaction the conversation
 *     archive uses (redactSession over the file as one message, with the user's redaction patterns), and a line that
 *     would read as page structure (a timeline split, a gbrain marker) gets a leading backslash (neutralizeOutsideText);
 *   - the page is written through put_page, the one writer door (a working tree gets the file and a queued commit,
 *     a repo-less brain gets the database row), with no readable_by of its own, so it has exactly the readers of
 *     the source it lands in. It is keyword-only (no embedding at write time) and opts out of the facts backstop
 *     (facts_backstop: false), so nothing paid runs;
 *   - the file path is redacted like the title (call_import.file), and the page waits for the owner's approval before
 *     anything embeds it (call_import.embedding_hold, the conversation archive's any-size hold);
 *   - each file imports once: a rerun finds the page its file made by its folder and path under the prefix (call_import.root
 *     and path, a digest of the folder and the unredacted relative path, so two names a redaction pattern makes alike stay
 *     apart; a page stored before path existed is found by its file), not by the computed slug, which a new modified day
 *     can move, and reports it unchanged, or kept when the file changed since, and never writes it again. The prefix is slugified per segment, as stored slugs are. Two files that map to one slug get a short hash
 *     of their path on the second.
 *
 * These are not agent sessions: nothing here touches conversations/ or the conversation archive switch.
 */
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import type { RunImportResult } from './import.ts';
import { setCliExitVerdict, writeJsonDocument } from '../core/cli-force-exit.ts';
import { loadConfig } from '../core/config.ts';
import { getCliOptions } from '../core/cli-options.ts';
import { slugifySegment } from '../core/sync.ts';
import { neutralizeOutsideText } from '../core/outside-content.ts';
import { loadImportRedactionPatterns, redactSession, type ImportRedactionPattern } from '../core/transcripts/render.ts';
import { acceptPendingCovers, acceptPendingRequested, CLI_WRITE_WAIT_MS, pendingReceiptOf, pollCommand } from '../core/persistence/write-wait.ts';
import { PENDING_WRITE_EXIT_CODE } from '../core/exit-codes.ts';
import { cliRenderContext } from '../core/agent-output.ts';

export const CALL_FILE_RE = /\.(txt|md)$/i;
export const DEFAULT_CALL_PREFIX = 'calls';
const LEADING_DATE_RE = /^(\d{4}-\d{2}-\d{2})(?:[\s_.-]+|$)(.*)$/;
const ANY_DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/;

export interface CallPage {
  rel: string;
  /** The relative path as stored and printed: redacted like the title and body. */
  file: string;
  /** call_import.path: a digest of the folder and the unredacted relative path, the file's identity across reruns. */
  path?: string;
  slug: string;
  title: string;
  date: string;
  date_from: 'file_name' | 'first_line' | 'modified';
  content: string;
  redactions: number;
  hash: string;
}

export interface CallFileResult {
  file: string;
  slug: string;
  status: 'imported' | 'unchanged' | 'kept' | 'pending' | 'error';
  date_from?: CallPage['date_from'];
  redactions?: number;
  git_state?: string;
  error?: string;
  /** A pending write: its request and the command that reads its receipt. */
  request_id?: string;
  poll?: string;
}

/** .txt and .md files under `dir`, sorted; dot entries and symlinks are skipped. */
export function listCallFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let names: string[];
    try { names = readdirSync(d).sort(); } catch { return; }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const p = join(d, name);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && CALL_FILE_RE.test(name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

const validDay = (day: string | undefined): string | null => {
  if (!day) return null;
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== day ? null : day;
};

const localDay = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** The first non-empty line of the text, past a leading frontmatter block, without heading marks. */
function firstLine(text: string): string {
  let lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (end > 0) lines = lines.slice(end + 1);
  }
  return (lines.find(l => l.trim()) ?? '').trim().replace(/^#+\s*/, '');
}

/** The page one call file becomes: slug, title, date, and the redacted, structure-neutral content. */
export function callPageFor(rel: string, text: string, mtimeMs: number, prefix: string, patterns: ImportRedactionPattern[], root?: string, pathId?: string): CallPage {
  const redact = (s: string): string => redactCallPath(s, patterns).file;
  const name = redact(basename(rel).replace(CALL_FILE_RE, ''));
  const lead = LEADING_DATE_RE.exec(name);
  const line = redact(firstLine(text));
  const fromName = validDay(lead?.[1]);
  const fromLine = fromName ? null : validDay(ANY_DATE_RE.exec(line)?.[1]);
  const date = fromName ?? fromLine ?? localDay(mtimeMs);
  const nameTitle = (fromName ? lead![2]! : name).split(/(<REDACTED:[^>]*>)/).map((part, i) => i % 2 ? part : part.replace(/[_-]+/g, ' ')).join('').trim();
  const lineTitle = line.replace(ANY_DATE_RE, '').replace(/^[\s:|,.-]+|[\s:|,.-]+$/g, '').trim();
  const rawTitle = ((fromName ? nameTitle || lineTitle : lineTitle || nameTitle) || 'call').slice(0, 120);
  const path = redactCallPath(rel, patterns);
  const redacted = redactSession({ meta: { harness: 'claude-export', sessionId: path.file, title: rawTitle }, messages: [{ role: 'user', timestamp: '', text }] }, { patterns });
  const title = redacted.session.meta.title ?? rawTitle;
  const body = neutralizeOutsideText(redacted.session.messages[0]!.text).replace(/\s+$/, '');
  const slugTitle = slugifySegment(title).slice(0, 80).replace(/-+$/, '') || 'call';
  const hash = createHash('sha256').update(`${title}\u0000${body}`).digest('hex').slice(0, 16);
  const frontmatter = [
    '---',
    `title: ${JSON.stringify(title)}`,
    'type: meeting',
    `date: ${date}`,
    'facts_backstop: false',
    'call_import:',
    `  file: ${JSON.stringify(path.file)}`,
    ...(root ? [`  root: ${JSON.stringify(root)}`] : []),
    ...(pathId ? [`  path: ${JSON.stringify(pathId)}`] : []),
    `  hash: ${JSON.stringify(hash)}`,
    `  redactions: ${redacted.redactionCount + path.redactions}`,
    '  embedding_hold: call_import',
    '---',
  ].join('\n');
  return { rel, file: path.file, ...(pathId ? { path: pathId } : {}), slug: `${prefix}/${date}-${slugTitle}`, title, date, date_from: fromName ? 'file_name' : fromLine ? 'first_line' : 'modified', content: `${frontmatter}\n${body}\n`, redactions: redacted.redactionCount + path.redactions, hash };
}

const callImportOf = (frontmatter: unknown): { file?: unknown; root?: unknown; path?: unknown; hash?: unknown } | null => {
  const ci = (frontmatter as { call_import?: unknown } | null)?.call_import;
  return ci && typeof ci === 'object' ? ci as { file?: unknown; root?: unknown; path?: unknown; hash?: unknown } : null;
};

/** A file path with the same credential redaction as the call's title, so a secret in a file name is never stored or printed. */
export function redactCallPath(rel: string, patterns: ImportRedactionPattern[]): { file: string; redactions: number } {
  const r = redactSession({ meta: { harness: 'claude-export', sessionId: '', title: rel }, messages: [] }, { patterns });
  return { file: r.session.meta.title ?? rel, redactions: r.redactionCount };
}

/** The import folder's identity in a page: a short hash of its real path, so two folders holding the same file name stay apart. */
export const callRootId = (dir: string): string => createHash('sha256').update(dir).digest('hex').slice(0, 12);

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Import every call file under `dir` (or the one call file `dir` names, as its folder would) once, into `sourceId` (default when unset). */
export async function runCallImport(engine: BrainEngine, dir: string, args: string[], opts: { sourceId?: string; json: boolean }): Promise<RunImportResult> {
  const prefix = (flagValue(args, '--prefix') ?? DEFAULT_CALL_PREFIX).split('/').map(slugifySegment).filter(Boolean).join('/') || DEFAULT_CALL_PREFIX;
  const sourceId = opts.sourceId ?? 'default';
  const patterns = loadImportRedactionPatterns();
  const { operations } = await import('../core/operations.ts');
  const putPage = operations.find(op => op.name === 'put_page')!;
  const ctx = { engine, config: loadConfig() ?? { engine: engine.kind }, logger: { info() {}, warn: (m: string) => process.stderr.write(`${m}\n`), error: (m: string) => process.stderr.write(`${m}\n`) },
    dryRun: false, remote: false, cliOpts: getCliOptions(), sourceId, writeWaitMs: CLI_WRITE_WAIT_MS } as Parameters<typeof putPage.handler>[0];
  const single = lstatSync(dir).isFile();
  const folder = single ? dirname(dir) : dir;
  const files = single ? [dir] : listCallFiles(dir);
  const root = callRootId(folder);
  const prior = await engine.executeRaw<{ slug: string; file: string; path: string | null }>(
    `SELECT slug, frontmatter->'call_import'->>'file' AS file, frontmatter->'call_import'->>'path' AS path FROM pages
      WHERE source_id = $1 AND deleted_at IS NULL AND starts_with(slug, $2) AND frontmatter->'call_import'->>'root' = $3
        AND frontmatter->'call_import'->>'file' IS NOT NULL`,
    [sourceId, `${prefix}/`, root]);
  const byPath = new Map(prior.filter(r => r.path).map(r => [r.path, r.slug]));
  const byFile = new Map(prior.filter(r => !r.path).map(r => [r.file, r.slug]));
  const sameImport = (frontmatter: unknown, page: CallPage): boolean => {
    const ci = callImportOf(frontmatter);
    return ci?.root === root && (typeof ci.path === 'string' ? ci.path === page.path : ci.file === page.file);
  };
  const results: CallFileResult[] = [];
  const used = new Set<string>();
  let uncovered = 0;
  for (const path of files) {
    const rel = relative(folder, path);
    let page: CallPage;
    if (!CALL_FILE_RE.test(path)) {
      results.push({ file: redactCallPath(rel, patterns).file, slug: '', status: 'error', error: 'not a .txt or .md call transcript; pass one, or the folder that holds them' });
      continue;
    }
    try {
      page = callPageFor(rel, readFileSync(path, 'utf8'), lstatSync(path).mtimeMs, prefix, patterns, root, createHash('sha256').update(`${folder}\u0000${rel}`).digest('hex').slice(0, 16));
    } catch (e) {
      results.push({ file: redactCallPath(rel, patterns).file, slug: '', status: 'error', error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const suffixed = `${page.slug}-${createHash('sha256').update(`${root}/${rel}`).digest('hex').slice(0, 6)}`;
    const legacy = byFile.get(page.file);
    const priorSlug = byPath.get(page.path!) ?? (legacy && !used.has(legacy) ? legacy : undefined);
    let slug = priorSlug ?? (used.has(page.slug) ? suffixed : page.slug);
    let existing = await engine.readPageSnapshot(slug, { sourceId });
    if (!priorSlug && existing && !sameImport(existing.page.frontmatter, page) && slug !== suffixed) {
      slug = suffixed;
      existing = await engine.readPageSnapshot(slug, { sourceId });
    }
    used.add(slug);
    const base = { file: page.file, slug, date_from: page.date_from, redactions: page.redactions };
    if (existing) {
      if (!sameImport(existing.page.frontmatter, page)) results.push({ ...base, status: 'error', error: `${slug} already holds another page; rename the file to import it` });
      else results.push({ ...base, status: callImportOf(existing.page.frontmatter)?.hash === page.hash ? 'unchanged' : 'kept' });
      continue;
    }
    try {
      const receipt = await putPage.handler(ctx, { slug, content: page.content, request_id: randomUUID() }) as { persistence?: { git_state?: string } } | null;
      results.push({ ...base, status: 'imported', ...(receipt?.persistence?.git_state ? { git_state: receipt.persistence.git_state } : {}) });
    } catch (e) {
      const receipt = pendingReceiptOf(e);
      if (receipt && !acceptPendingCovers(receipt)) uncovered++;
      if (receipt) results.push({ ...base, status: 'pending', request_id: receipt.request_id, poll: pollCommand(receipt.request_id, (e as { fix?: { argv?: readonly string[] } }).fix, cliRenderContext().routing) });
      else results.push({ ...base, status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }
  const count = (s: CallFileResult['status']) => results.filter(r => r.status === s).length;
  const imported = count('imported');
  const errors = count('error');
  const pending = count('pending');
  const redactions = results.filter(r => r.status === 'imported').reduce((n, r) => n + (r.redactions ?? 0), 0);
  const failures = results.filter(r => r.status === 'error').map(r => ({ path: r.file, error: r.error ?? 'unknown error' }));
  if (opts.json) {
    await writeJsonDocument(JSON.stringify({
      status: errors > 0 ? 'partial' : pending > 0 ? 'pending' : 'success', mode: 'calls', source_id: sourceId, prefix, total_files: files.length,
      imported, unchanged: count('unchanged'), kept: count('kept'), pending, errors, redactions, pages: results, failures,
    }));
  } else {
    console.log(`Call import into source ${sourceId} under ${prefix}/: ${imported} imported, ${count('unchanged')} unchanged, ${count('kept')} kept (changed since import, not overwritten), ${pending} pending (accepted, still being written), ${errors} error(s); ${redactions} credential(s) redacted.`);
    for (const r of results) console.log(`  ${r.status.padEnd(9)} ${r.slug || '-'}  <- ${r.file}${r.error ? ` (${r.error})` : ''}${r.poll ? ` (still being written; check with ${r.poll} before importing again)` : ''}`);
  }
  if (!errors && pending && (!acceptPendingRequested(getCliOptions().acceptPending) || uncovered > 0)) setCliExitVerdict(PENDING_WRITE_EXIT_CODE);
  return { imported, skipped: results.length - imported, errors, chunksCreated: 0, failures };
}
