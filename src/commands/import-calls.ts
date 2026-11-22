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
 *     apart; a page stored before path existed is found by its file), whichever folder above the file an import started
 *     from, not by the computed slug, which a new modified day can move, and reports it unchanged, or kept when the file
 *     changed since, and never writes it again. A write of the file still pending is reported pending, not written again. The prefix is slugified per segment, as stored slugs are. Two files that map to one slug get a short hash
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
import { TERMINAL_STATES } from '../core/persistence/model.ts';
import type { WriteReceipt } from '../core/persistence/types.ts';
import { callReadersFor, parseCallAttendees, type CallAttendee } from '../core/meetings/attendees.ts';
import { callScopeGate, type CallScopeGate, type CallsNotScopedReason, type UnboundStdio } from '../core/access/call-scope.ts';
import { claudeUserMcpConfigPath, codexConfigPath } from '../core/bootstrap/host-specs.ts';
import { readCodexTomlTable } from '../core/bootstrap/codex-toml.ts';
import { localSetupRecords } from '../core/setup/local-receipts.ts';
import { sharedStdioHarness } from './setup-serves.ts';
import { registeredStdioMember } from '../core/stdio-member-flag.ts';
import { normalizeReaders } from '../core/access/principals.ts';
import { raisePageLabelGuard } from '../core/trust/page-write.ts';
import { maintenanceTransaction } from '../core/persistence/attribution.ts';
import { noticeBlock, renderNotice } from '../core/agent-output.ts';
import { opError } from '../core/ops/contract.ts';

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
  /** GST-2904: the attendees the call's header names (redacted), or null. */
  attendees: CallAttendee[] | null;
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
  /** GST-2904, on a brain that serves two or more people: whether the call is kept to the owner and its attendees. */
  scoped?: boolean;
  /** Why it is not: --readers source, or the calls_not_scoped reason. */
  reason?: CallsNotScopedReason | 'readers_source';
  /** Who reads the call by its page (member ids), or null when its source's readers do. */
  readers?: string[] | null;
  /** computed by this import, stored on the page already, or pending in a write still being made. */
  readers_from?: 'computed' | 'stored' | 'pending';
  matched_by?: Record<string, 'email' | 'id' | 'name'>;
  unmatched?: string[];
}

/**
 * The local stdio connections on this machine bound to nobody: each claude-code or codex entry `gbrain setup` installed
 * for this brain home without --stdio-member (a plugin-served entry counts as unbound), and a harness several people talk
 * to (OpenClaw, Hermes), which no --stdio-member can bind. An entry that cannot be read counts as unbound.
 */
export function callScopeStdio(): UnboundStdio[] {
  const out: UnboundStdio[] = [];
  for (const record of localSetupRecords().filter(r => r.status === 'installed')) {
    let entry: unknown;
    try {
      if (record.harness === 'claude-code') {
        const cfg = JSON.parse(readFileSync(claudeUserMcpConfigPath(), 'utf8')) as { mcpServers?: Record<string, unknown>; projects?: Record<string, { mcpServers?: Record<string, unknown> }> };
        entry = (record.scope === 'project' && record.projectDir ? cfg.projects?.[record.projectDir]?.mcpServers : cfg.mcpServers)?.[record.name];
      } else if (record.harness === 'codex') entry = readCodexTomlTable(codexConfigPath(), ['mcp_servers', record.name]);
      else continue;
    } catch { entry = undefined; }
    if (registeredStdioMember(entry) !== undefined) continue;
    out.push({ harness: record.harness, name: record.name,
      argv: ['gbrain', 'setup', record.harness, ...(record.name === 'gbrain' ? [] : ['--name', record.name]), ...(record.scope === 'project' ? ['--scope', 'project'] : [])] });
  }
  const shared = sharedStdioHarness();
  if (shared) out.push({ harness: shared, argv: null });
  return out;
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
  return { rel, file: path.file, ...(pathId ? { path: pathId } : {}), slug: `${prefix}/${date}-${slugTitle}`, title, date, date_from: fromName ? 'file_name' : fromLine ? 'first_line' : 'modified', content: `${frontmatter}\n${body}\n`, redactions: redacted.redactionCount + path.redactions, hash,
    attendees: callAttendees(text, redacted.session.messages[0]!.text) };
}

/**
 * GST-2904: the header's attendees, printed as redacted (a redaction pattern may cover an address) but matched by the
 * address the file gives, which is compared and never stored. A header the redaction reshaped is read redacted only.
 */
function callAttendees(raw: string, redacted: string): CallAttendee[] | null {
  const shown = parseCallAttendees(redacted);
  const given = parseCallAttendees(raw);
  if (!shown || !given || shown.length !== given.length) return shown;
  return shown.map((a, i) => (given[i]!.email ? { entry: a.entry, email: given[i]!.email } : a));
}

/** GST-2904: the call page kept to `readers` (member ids, the owner first): its readable_by line rides the one put_page write. */
export function withCallReaders(content: string, readers: readonly string[]): string {
  return content.replace('\nfacts_backstop: false\n', `\nreadable_by: ${JSON.stringify(readers)}\nfacts_backstop: false\n`);
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

/** call_import.path: the file's identity, a digest of the import folder and the unredacted path under it. */
const callPathId = (folder: string, rel: string): string => createHash('sha256').update(`${folder}\u0000${rel}`).digest('hex').slice(0, 16);

/** Every call_import.path the file `abs` has had: one per folder above it that an import could have started from. */
function callPathIds(abs: string): Set<string> {
  const ids = new Set<string>();
  for (let dir = dirname(abs); ; dir = dirname(dir)) {
    ids.add(callPathId(dir, relative(dir, abs)));
    if (dirname(dir) === dir) return ids;
  }
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Import every call file under `dir` (or the one call file `dir` names, as its folder would) once, into `sourceId` (default when unset). */
export async function runCallImport(engine: BrainEngine, dir: string, args: string[], opts: { sourceId?: string; json: boolean; unboundStdio?: () => UnboundStdio[] }): Promise<RunImportResult> {
  const prefix = (flagValue(args, '--prefix') ?? DEFAULT_CALL_PREFIX).split('/').map(slugifySegment).filter(Boolean).join('/') || DEFAULT_CALL_PREFIX;
  const sourceId = opts.sourceId ?? 'default';
  const readersFlag = flagValue(args, '--readers') ?? 'attendees';
  if (readersFlag !== 'attendees' && readersFlag !== 'source') {
    throw opError('invalid_params', `--readers must be attendees or source, not "${readersFlag}"; nothing was imported.`,
      'Use --readers attendees (the default: on a brain that serves several people each call is kept to the owner and its attendees) or --readers source (each call is readable by everyone who reads its source).');
  }
  const patterns = loadImportRedactionPatterns();
  const { operations } = await import('../core/operations.ts');
  const putPage = operations.find(op => op.name === 'put_page')!;
  const getWriteRequest = operations.find(op => op.name === 'get_write_request')!;
  const ctx = { engine, config: loadConfig() ?? { engine: engine.kind }, logger: { info() {}, warn: (m: string) => process.stderr.write(`${m}\n`), error: (m: string) => process.stderr.write(`${m}\n`) },
    dryRun: false, remote: false, cliOpts: getCliOptions(), sourceId, writeWaitMs: CLI_WRITE_WAIT_MS } as Parameters<typeof putPage.handler>[0];
  const single = lstatSync(dir).isFile();
  const folder = single ? dirname(dir) : dir;
  const files = single ? [dir] : listCallFiles(dir);
  const root = callRootId(folder);
  const gate: CallScopeGate = await callScopeGate(engine, opts.unboundStdio ?? callScopeStdio);
  const scope = gate.applies ? (readersFlag === 'source' ? { scoped: false as const, reason: 'readers_source' as const } : gate.scoped ? { scoped: true as const } : { scoped: false as const, reason: gate.reason }) : null;
  const scopeOf = (readers: string[] | null, from: 'computed' | 'stored' | 'pending', extra: Partial<CallFileResult> = {}): Partial<CallFileResult> =>
    scope ? { ...scope, readers, readers_from: from, ...extra } : {};
  const memberIds = (frontmatter: unknown): string[] | null => {
    const normalized = normalizeReaders(frontmatter);
    if (!normalized) return null;
    const raw = (frontmatter as { readable_by?: unknown }).readable_by;
    const listed = Array.isArray(raw) ? raw.map(String) : [String(raw)];
    const ids = listed.map(r => r.trim().replace(/^member:/i, ''));
    return JSON.stringify([...new Set(ids.map(r => normalizeReaders({ readable_by: r })?.[0]))].sort()) === JSON.stringify(normalized) ? ids : normalized;
  };
  /** A scoped call's readers are guarded as soon as its page row lands (its git commit may still be queued), so a later write below the operator's tier cannot drop them. */
  const guard = async (slug: string, readers: string[] | null): Promise<void> => {
    if (!scope?.scoped || !readers) return;
    await maintenanceTransaction(engine, async tx => {
      await tx.lockPageKeys([{ sourceId, slug }]);
      const [page] = await tx.executeRaw<{ id: number; frontmatter: Record<string, unknown> | null; guarded: boolean }>(
        'SELECT p.id, p.frontmatter, EXISTS (SELECT 1 FROM page_label_guards g WHERE g.page_id = p.id) AS guarded FROM pages p WHERE p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL FOR UPDATE', [sourceId, slug]);
      if (!page || page.guarded === true || JSON.stringify(normalizeReaders(page.frontmatter)) !== JSON.stringify(normalizeReaders({ readable_by: readers }))) return;
      await raisePageLabelGuard(tx, sourceId, slug);
    });
  };
  const prior = await engine.executeRaw<{ slug: string; root: string | null; file: string; path: string | null }>(
    `SELECT slug, frontmatter->'call_import'->>'root' AS root, frontmatter->'call_import'->>'file' AS file, frontmatter->'call_import'->>'path' AS path FROM pages
      WHERE source_id = $1 AND deleted_at IS NULL AND starts_with(slug, $2) AND frontmatter->'call_import'->>'file' IS NOT NULL`,
    [sourceId, `${prefix}/`]);
  const byPath = new Map(prior.filter(r => r.path).map(r => [r.path, r.slug]));
  const byFile = new Map(prior.filter(r => !r.path && r.root === root).map(r => [r.file, r.slug]));
  const pendingByPath = new Map<string, { slug: string; request_id: string; readers: string[] | null }>();
  for (const row of await engine.executeRaw<{ slug: string; request_id: string; content: string | null }>(
    `SELECT slug, request_id::text AS request_id, intent->>'content' AS content FROM persistence_requests
      WHERE source_id = $1 AND operation = 'put_page' AND starts_with(slug, $2) AND NOT (state = ANY($3::text[])) ORDER BY sequence`,
    [sourceId, `${prefix}/`, [...TERMINAL_STATES]])) {
    const id = /^ {2}path: "([0-9a-f]{16})"$/m.exec(row.content ?? '')?.[1];
    const readersLine = /^readable_by: (\[.*\])$/m.exec(row.content ?? '')?.[1];
    let readers: string[] | null = null;
    try { readers = readersLine ? JSON.parse(readersLine) as string[] : null; } catch { readers = null; }
    if (id && !pendingByPath.has(id)) pendingByPath.set(id, { slug: row.slug, request_id: row.request_id, readers });
  }
  const sameImport = (frontmatter: unknown, page: CallPage, ids: Set<string>): boolean => {
    const ci = callImportOf(frontmatter);
    return typeof ci?.path === 'string' ? ids.has(ci.path) : ci?.root === root && ci.file === page.file;
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
      page = callPageFor(rel, readFileSync(path, 'utf8'), lstatSync(path).mtimeMs, prefix, patterns, root, callPathId(folder, rel));
    } catch (e) {
      results.push({ file: redactCallPath(rel, patterns).file, slug: '', status: 'error', error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const suffixed = `${page.slug}-${createHash('sha256').update(`${root}/${rel}`).digest('hex').slice(0, 6)}`;
    const ids = callPathIds(path);
    const legacy = byFile.get(page.file);
    const priorSlug = [...ids].map(id => byPath.get(id)).find(Boolean) ?? (legacy && !used.has(legacy) ? legacy : undefined);
    const held = priorSlug ? undefined : [...ids].map(id => pendingByPath.get(id)).find(Boolean);
    if (held) {
      used.add(held.slug);
      const receipt = await getWriteRequest.handler(ctx, { request_id: held.request_id }).catch(() => null) as WriteReceipt | null;
      if (!receipt || !acceptPendingCovers(receipt)) uncovered++;
      results.push({ file: page.file, slug: held.slug, date_from: page.date_from, redactions: page.redactions, status: 'pending', request_id: held.request_id,
        poll: pollCommand(held.request_id, undefined, cliRenderContext().routing), ...scopeOf(held.readers, 'pending') });
      continue;
    }
    let slug = priorSlug ?? (used.has(page.slug) ? suffixed : page.slug);
    let existing = await engine.readPageSnapshot(slug, { sourceId });
    if (!priorSlug && existing && !sameImport(existing.page.frontmatter, page, ids) && slug !== suffixed) {
      slug = suffixed;
      existing = await engine.readPageSnapshot(slug, { sourceId });
    }
    used.add(slug);
    const base = { file: page.file, slug, date_from: page.date_from, redactions: page.redactions };
    if (existing) {
      if (!sameImport(existing.page.frontmatter, page, ids)) results.push({ ...base, status: 'error', error: `${slug} already holds another page; rename the file to import it` });
      else {
        const stored = memberIds(existing.page.frontmatter);
        await guard(slug, stored);
        results.push({ ...base, status: callImportOf(existing.page.frontmatter)?.hash === page.hash ? 'unchanged' : 'kept', ...scopeOf(stored, 'stored') });
      }
      continue;
    }
    const kept = scope?.scoped && gate.applies && gate.scoped ? callReadersFor(page.attendees, gate.owner, gate.members) : null;
    const fields = kept ? scopeOf(kept.readers, 'computed', { matched_by: kept.matched_by, unmatched: kept.unmatched }) : scopeOf(null, 'computed');
    try {
      const receipt = await putPage.handler(ctx, { slug, content: kept ? withCallReaders(page.content, kept.readers) : page.content, request_id: randomUUID() }) as { persistence?: { git_state?: string } } | null;
      const gitState = receipt?.persistence?.git_state;
      if (kept) await guard(slug, kept.readers);
      results.push({ ...base, status: 'imported', ...(gitState ? { git_state: gitState } : {}), ...fields });
    } catch (e) {
      const receipt = pendingReceiptOf(e);
      if (receipt && !acceptPendingCovers(receipt)) uncovered++;
      if (receipt) results.push({ ...base, status: 'pending', request_id: receipt.request_id, poll: pollCommand(receipt.request_id, (e as { fix?: { argv?: readonly string[] } }).fix, cliRenderContext().routing), ...(kept ? scopeOf(kept.readers, 'pending', { matched_by: kept.matched_by, unmatched: kept.unmatched }) : fields) });
      else results.push({ ...base, status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }
  const count = (s: CallFileResult['status']) => results.filter(r => r.status === s).length;
  const imported = count('imported');
  const errors = count('error');
  const pending = count('pending');
  const redactions = results.filter(r => r.status === 'imported').reduce((n, r) => n + (r.redactions ?? 0), 0);
  const failures = results.filter(r => r.status === 'error').map(r => ({ path: r.file, error: r.error ?? 'unknown error' }));
  const notice = gate.applies && !gate.scoped && readersFlag === 'attendees' ? gate.notice : null;
  const placed = results.filter(r => r.status !== 'error');
  const scopedSummary = scope ? {
    scoped: placed.filter(r => r.scoped && (r.readers?.length ?? 0) > 1).length,
    owner_only: placed.filter(r => r.scoped && r.readers?.length === 1).length,
    not_scoped: placed.filter(r => !r.scoped).length,
  } : null;
  if (opts.json) {
    await writeJsonDocument(JSON.stringify({
      status: errors > 0 ? 'partial' : pending > 0 ? 'pending' : 'success', mode: 'calls', source_id: sourceId, prefix, total_files: files.length,
      imported, unchanged: count('unchanged'), kept: count('kept'), pending, errors, redactions, ...(scopedSummary ? { readers: scopedSummary } : {}), pages: results, failures,
      ...(notice ? { notices: [renderNotice(notice, cliRenderContext())] } : {}),
    }));
  } else {
    console.log(`Call import into source ${sourceId} under ${prefix}/: ${imported} imported, ${count('unchanged')} unchanged, ${count('kept')} kept (changed since import, not overwritten), ${pending} pending (accepted, still being written), ${errors} error(s); ${redactions} credential(s) redacted.`);
    if (scopedSummary) console.log(`  readers  ${scopedSummary.scoped} kept to the owner and their attendees, ${scopedSummary.owner_only} kept to the owner only, ${scopedSummary.not_scoped} readable by everyone who reads source ${sourceId}.`);
    for (const r of results) {
      const who = r.readers ? ` [readers: ${r.readers.join(', ')}${r.unmatched?.length ? `; not matched: ${r.unmatched.map(u => JSON.stringify(u)).join(', ')}` : ''}]` : '';
      console.log(`  ${r.status.padEnd(9)} ${r.slug || '-'}  <- ${r.file}${who}${r.error ? ` (${r.error})` : ''}${r.poll ? ` (still being written; check with ${r.poll} before importing again)` : ''}`);
    }
    if (notice) process.stderr.write(noticeBlock(renderNotice(notice, cliRenderContext())) + '\n');
  }
  if (!errors && pending && (!acceptPendingRequested(getCliOptions().acceptPending) || uncovered > 0)) setCliExitVerdict(PENDING_WRITE_EXIT_CODE);
  return { imported, skipped: results.length - imported, errors, chunksCreated: 0, failures };
}
