/**
 * Large pages (Wave A): how `gbrain get` renders get_page, locally and over
 * the thin client.
 *
 * A whole page prints as its markdown, as it always has. A partial response
 * (body none / outline / window) prints only what it carries, and says on
 * stderr that it is partial and how to read on, so `gbrain get > file` never
 * writes part of a page as if it were all of it.
 *
 * The thin client asks for the whole page. A host that cannot send it in one
 * response refuses with page_too_large_for_inline; the client then pages the
 * round-trip markdown (view: 'markdown') to its end, checks the total size and
 * sha256 the host reported, and prints it window by window, or fails without
 * printing. The windows wait in a 0600 temp file until the copy verifies, so
 * a page of any size prints with one window in memory.
 *
 * A segmented page (Wave B) is never returned whole by get_page. Locally the
 * refusal is page_body_segmented and `gbrain get` streams the page instead:
 * the frontmatter head, the truth segments, TIMELINE_SEPARATOR and the
 * timeline segments, one segment at a time. `--json` puts the page in one
 * string, so above PAGE_MAX_BYTES it refuses, locally and over the thin
 * client, with a fix that drops `--json`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { open, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import { serializeMarkdown } from '../core/markdown.ts';
import { opError } from '../core/ops/contract.ts';
import { readFix } from '../core/ops/op-fix.ts';
import { PAGE_MAX_BYTES } from '../core/page-size-policy.ts';
import { isSegmentedPage } from '../core/page-body/page-shape.ts';
import { openSegmentedBody } from '../core/page-body/read-range.ts';
import { markdownHead, segmentedMarkdownDocument } from '../core/page-window/segmented.ts';

/** Window size the thin client asks for while paging a whole page. */
export const REMOTE_PAGE_WINDOW_BYTES = 512 * 1024;
const MAX_RESTARTS = 3;

type GetPageResult = Record<string, any>;

function partialNote(r: GetPageResult): string {
  const size = r.size ?? {};
  const total = typeof size.total_bytes === 'number' ? `${size.total_bytes} bytes` : 'unknown size';
  if (r.window && typeof r.window.byte_start === 'number') {
    const next = r.next_cursor ? ` Read on: gbrain get ${r.slug} --cursor ${r.next_cursor}` : '';
    return `[gbrain] partial page: bytes ${r.window.byte_start}-${r.window.byte_end} of ${total} (lines ${r.window.line_start}-${r.window.line_end}).${next}`;
  }
  return `[gbrain] partial page (${r.body}, ${total}): no page body was printed. Whole page: gbrain get ${r.slug} --body full`;
}

function renderOutline(r: GetPageResult): string {
  const o = r.outline;
  const lines = [`# ${r.title ?? r.slug} — ${r.size?.total_bytes ?? '?'} bytes, ${r.size?.total_lines ?? '?'} lines, revision ${r.revision}`];
  for (const e of o?.entries ?? []) {
    const label = e.heading !== undefined ? `${'#'.repeat(e.level ?? 1)} ${e.heading ?? '(before first heading)'}` : e.first_line ?? '';
    const dates = e.date_min ? ` [${e.date_min}${e.date_max && e.date_max !== e.date_min ? `..${e.date_max}` : ''}]` : '';
    lines.push(`L${e.line_start}-${e.line_end}\t${e.byte_end - e.byte_start}B\t${label}${dates}`);
  }
  if (o?.next_from_index !== undefined) lines.push(`… ${o.total_entries - o.next_from_index} more entries: --outline-from ${o.next_from_index}`);
  return lines.join('\n') + '\n';
}

/** stdout text for one get_page result; partial responses add a stderr note. */
export function formatGetPage(r: GetPageResult): string {
  if (r.error === 'ambiguous_slug') {
    return `Ambiguous slug. Did you mean:\n${r.candidates.map((c: string) => `  ${c}`).join('\n')}\n`;
  }
  if (typeof r.body !== 'string') {
    return serializeMarkdown(r.frontmatter || {}, r.compiled_truth || '', r.timeline || '', { type: r.type, title: r.title, tags: r.tags || [] });
  }
  process.stderr.write(partialNote(r) + '\n');
  if (r.window) return r.window.text;
  if (r.outline) return renderOutline(r);
  return `revision: ${r.revision}\nsize: ${r.size?.total_bytes ?? '?'} bytes, ${r.size?.total_lines ?? '?'} lines\n` +
    (r.chunks ? `chunks: ${r.chunks.total} (${r.chunks.embedded} embedded)\n` : '');
}

/** The canonical code of a tool error: a thin-client RemoteMcpError's detail, or an in-process OperationError (a legacy wire value moves the code to canonical). */
export function remoteErrorCode(e: unknown): string | undefined {
  const err = e as { detail?: { code?: string; canonical_code?: string }; canonical?: string; code?: unknown } | null;
  if (err?.detail && typeof err.detail === 'object') return err.detail.canonical_code ?? err.detail.code;
  return err?.canonical ?? (typeof err?.code === 'string' ? err.code : undefined);
}

/** True when a get_page call named no body mode, selector or round-trip flag: the caller wants the page as it is. */
export function wantsWholePage(params: Record<string, unknown>): boolean {
  return ['body', 'lines', 'bytes', 'around_chunk_id', 'cursor', 'include_content', 'content_only'].every(k => params[k] === undefined);
}

/**
 * @internal Work the thin client's paged read does, for the memory test: windows written to the spool (`spooled`)
 * and read back from it to print (`replayed`). Counts, not time.
 */
export const pagedReadWork = { spooled: 0, replayed: 0 };

type PagedCall = (params: Record<string, unknown>) => Promise<GetPageResult>;
interface SpooledPage { revision: string; windows: number; bytes: number; parts(): AsyncIterable<Buffer> }

/**
 * Page a whole page's round-trip markdown through windows into a 0600 temp file, then hand `use` the verified copy;
 * `parts()` reads it back window by window as the windows arrived. Restarts from the top when the page changes
 * mid-read; throws rather than hand over a short or unverified copy. The temp file is removed whatever happens.
 */
async function withSpooledPage<T>(call: PagedCall, params: Record<string, unknown>, use: (page: SpooledPage) => Promise<T>): Promise<T> {
  const path = join(tmpdir(), `gbrain-page-${process.pid}-${randomBytes(8).toString('hex')}.md`);
  const spool = await open(path, 'wx+', 0o600);
  try {
    const { lengths, revision } = await spoolWholePage(call, params, spool);
    const bytes = lengths.reduce((n, length) => n + length, 0);
    return await use({ revision, windows: lengths.length, bytes, async *parts() {
      for (let i = 0, at = 0; i < lengths.length; at += lengths[i]!, i++) {
        const part = Buffer.allocUnsafe(lengths[i]!);
        for (let filled = 0; filled < part.length;) {
          const { bytesRead } = await spool.read(part, filled, part.length - filled, at + filled);
          if (bytesRead === 0) throw new Error(`The spooled copy of ${String(params.slug)} was truncated; the rest of the page was not printed.`);
          filled += bytesRead;
        }
        pagedReadWork.replayed++;
        yield part;
      }
    } });
  } finally {
    await spool.close().catch(() => undefined);
    await rm(path, { force: true });
  }
}

/** The paging loop of withSpooledPage: the byte length of each window written to `spool`, once size and sha256 verify. */
async function spoolWholePage(call: PagedCall, params: Record<string, unknown>, spool: FileHandle): Promise<{ lengths: number[]; revision: string }> {
  const base = { slug: params.slug, ...(params.source_id !== undefined ? { source_id: params.source_id } : {}), body: 'window', view: 'markdown' };
  for (let attempt = 0; attempt <= MAX_RESTARTS; attempt++) {
    await spool.truncate(0);
    const lengths: number[] = [];
    const hash = createHash('sha256');
    let bytes = 0;
    let r = await call({ ...base, max_bytes: REMOTE_PAGE_WINDOW_BYTES });
    const { revision, size } = r;
    let changed = false;
    for (;;) {
      if (!r.window || typeof r.window.byte_start !== 'number' || !size || typeof size.sha256 !== 'string') {
        throw new Error(`get_page did not return a markdown window for ${String(params.slug)}; the page was not printed.`);
      }
      const part = Buffer.from(r.window.text, 'utf8');
      hash.update(part);
      for (let written = 0; written < part.length;) written += (await spool.write(part, written, part.length - written, bytes + written)).bytesWritten;
      lengths.push(part.length);
      pagedReadWork.spooled++;
      bytes += part.length;
      if (!r.next_cursor) break;
      try {
        r = await call({ ...base, cursor: r.next_cursor });
      } catch (e) {
        if (remoteErrorCode(e) !== 'revision_changed') throw e;
        changed = true;
        break;
      }
      if (r.revision !== revision) { changed = true; break; }
    }
    if (changed) continue;
    if (bytes !== size.total_bytes || hash.digest('hex') !== size.sha256) {
      throw new Error(`The paged copy of ${String(params.slug)} does not match the size and sha256 the host reported; the page was not printed.`);
    }
    return { lengths, revision };
  }
  throw new Error(`${String(params.slug)} kept changing while it was being read (${MAX_RESTARTS + 1} attempts); the page was not printed. Try again.`);
}

/** `--json` holds the whole page in one string: refused above PAGE_MAX_BYTES, with a fix that streams it instead. */
function jsonTooLargeError(slug: string, sourceId: string | undefined, bytes: number) {
  return opError('page_too_large_for_inline', `Page ${slug} is ${bytes} bytes, over the ${PAGE_MAX_BYTES}-byte limit of one --json document.`,
    'Run gbrain get without --json: it prints the page whole, window by window or segment by segment.',
    { fix: readFix('Prints the page whole without holding it as one string.', { argv: ['gbrain', 'get', ...(sourceId ? ['--source', sourceId] : []), '--', slug] }) });
}

/**
 * A whole page's round-trip markdown as one string, paged and verified as `printPagedPage` does it: for `--json`,
 * which refuses a page over PAGE_MAX_BYTES before this holds it.
 */
export async function readWholePageMarkdown(call: PagedCall, params: Record<string, unknown>): Promise<{ markdown: string; revision: string; windows: number }> {
  return withSpooledPage(call, params, async page => {
    const parts: Buffer[] = [];
    for await (const part of page.parts()) parts.push(part);
    return { markdown: Buffer.concat(parts, page.bytes).toString('utf8'), revision: page.revision, windows: page.windows };
  });
}

/** The thin client's whole-page read after a page_too_large_for_inline refusal: page, verify, then print each window (or one --json document). */
export async function printPagedPage(call: PagedCall, params: Record<string, unknown>, write: (text: string) => Promise<void>): Promise<void> {
  if (params.json === true) {
    const paged = await readWholePageMarkdown(async p => {
      const r = await call(p);
      if (r.size?.total_bytes > PAGE_MAX_BYTES) throw jsonTooLargeError(String(params.slug), params.source_id as string | undefined, r.size.total_bytes);
      return r;
    }, params);
    await write(JSON.stringify({ slug: params.slug, revision: paged.revision, content: paged.markdown, windows: paged.windows }) + '\n');
    return;
  }
  await withSpooledPage(call, params, async page => { for await (const part of page.parts()) await write(part.toString('utf8')); });
}

/** What the local get_page call returns when `streamSegmentedGet` printed the page itself. */
export const SEGMENTED_STREAMED = Symbol('segmented page streamed');

/**
 * Local `gbrain get` of a segmented page, after get_page refused it whole (page_body_segmented, whose fix names the
 * resolved slug and source): stream the trusted markdown view to `write`, one segment at a time, as the inline
 * page would print. False when `error` is not that refusal of a whole-page read.
 */
export async function streamSegmentedGet(engine: BrainEngine, params: Record<string, unknown>, error: unknown, write: (text: string) => Promise<void>): Promise<boolean> {
  const ref = (error as { fix?: { mcp?: { arguments?: Record<string, unknown> } } } | null)?.fix?.mcp?.arguments;
  if (remoteErrorCode(error) !== 'page_body_segmented' || !wantsWholePage(params) || typeof ref?.slug !== 'string' || typeof ref.source_id !== 'string') return false;
  const snapshot = await engine.readPageSnapshot(ref.slug, { sourceId: ref.source_id, includeDeleted: params.include_deleted === true });
  if (!snapshot || !isSegmentedPage(snapshot.page)) return false;
  const { page, tags } = snapshot;
  const json = params.json === true;
  if (json && Number(page.body_bytes) > PAGE_MAX_BYTES) throw jsonTooLargeError(page.slug, page.source_id, Number(page.body_bytes));
  const body = await openSegmentedBody(engine, { pageId: page.id, ledger: { withdrawals: snapshot.withdrawals, ...(snapshot.globalPurges ? { globalPurges: snapshot.globalPurges } : {}) },
    pin: { revision: snapshot.revision, generation: snapshot.bodyGeneration } });
  const doc = await segmentedMarkdownDocument(engine, body, markdownHead(page, tags), 'trusted');
  const parts: string[] = [];
  for await (const bytes of doc.stream()) {
    if (json) parts.push(bytes.toString('utf8'));
    else await write(bytes.toString('utf8'));
  }
  if (json) await write(JSON.stringify({ slug: page.slug, source_id: page.source_id, revision: snapshot.revision, content: parts.join('') }) + '\n');
  return true;
}
