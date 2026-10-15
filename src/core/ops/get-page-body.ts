/**
 * Large pages (Wave A read contract): get_page body modes.
 *
 *   body: 'full'    the page as today (compiled_truth, timeline, and `content`
 *                   with include_content); refused with
 *                   page_too_large_for_inline when the complete result does not
 *                   fit the connection's egress cap. Trusted local reads are
 *                   never refused.
 *   body: 'auto'    (default) 'full' up to mcp.inline_body_bytes (256 KB of
 *                   body), else the outline plus the first window.
 *   body: 'none'    metadata, revision, size and chunk/embedding counts, no text:
 *                   the cheap read before edit_page / put_page.
 *   body: 'outline' metadata, size and a paged outline.
 *   body: 'window'  metadata, size and one window chosen by ONE selector:
 *                   lines {from, count}, bytes {offset, length}, around_chunk_id
 *                   (+ context_lines) or cursor; none = from the start.
 *
 * A partial shape NEVER carries compiled_truth, timeline or content, so no
 * caller can mistake a window for the page and write it back whole. Windows
 * and outlines slice the read projection (page-window/document.ts), the same
 * text for every caller; view 'markdown' slices the canonical round-trip
 * markdown `content` instead (thin-client complete downloads), with its
 * sha256 for verification.
 *
 * Precedence: an explicit `body` wins; without it include_content or
 * content_only mean 'full' (content_only keeps the round-trip shape), a
 * selector means 'window', gbrain's thin client means 'full' (an older thin
 * client renders compiled_truth as the whole page), a trusted local read means
 * 'full', anything else 'auto'.
 */
import type { Page } from '../types.ts';
import type { OperationContext, ParamDef } from './contract.ts';
import { opError, OperationError } from './contract.ts';
import { invalidParam, readFix } from './op-fix.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { deepResearchPageUrl, encodeDeepResearchId } from '../deep-research-id.ts';
import { encodedFrameBytes, EGRESS_CAP_CONFIG_KEYS, egressTransport, FRAME_RESERVE_BYTES, resultByteCap } from '../egress-budget.ts';
import { DEFAULT_INLINE_BODY_BYTES, chunkDocumentSpan, readPageDocument, spanHoldsChunk, type PageDocument } from '../page-window/document.ts';
import {
  DEFAULT_CONTEXT_LINES, DEFAULT_OUTLINE_LIMIT, DEFAULT_WINDOW_BYTES, MAX_CONTEXT_LINES, MAX_OUTLINE_LIMIT, MAX_WINDOW_BYTES,
  decodeCursor, encodeCursor, pageOutline, sha256Hex, totalLines, windowAround, windowForBytes, windowForLines, windowFrom,
  type WindowSlice, type WindowView,
} from '../page-window/window.ts';
import { renderTrustedText, type TrustFields } from '../eligibility/labels.ts';
import type { QuarantinedView } from './get-page-projection.ts';
import { currentTextProjectionFilter, safeChunksFilter } from '../search/safe-chunks.ts';

export const BODY_MODES = ['auto', 'full', 'none', 'outline', 'window'] as const;
export type BodyMode = typeof BODY_MODES[number];
export const INLINE_BODY_BYTES_KEY = 'mcp.inline_body_bytes';
/** `auto` returns the whole body up to this many bytes of compiled truth plus timeline. */
export { DEFAULT_INLINE_BODY_BYTES };
/** Room a partial response keeps for its metadata, notices and escaping inside the egress cap. */
const ENVELOPE_RESERVE_BYTES = 64 * 1024;
/** The first window `auto` returns next to the outline. */
const AUTO_WINDOW_BYTES = 16_000;

/** Advertised in get_brain_identity.capabilities: this host speaks the windowed get_page contract (body modes, cursors, view markdown + sha256). */
export const LARGE_PAGES_CAPABILITY = 'large_pages_v1';

export const GET_PAGE_BODY_PARAMS: Record<string, ParamDef> = {
  body: { type: 'string', enum: [...BODY_MODES], description: 'auto: whole up to 256 KB, else outline + window. none: revision + size.', fullSurfaceOnly: true },
  lines: { type: 'object', description: 'Window: 1-based lines.', properties: { from: { type: 'number', required: true }, count: { type: 'number', required: true } }, fullSurfaceOnly: true },
  bytes: { type: 'object', description: 'Window: UTF-8 bytes (snapped to a line start).', properties: { offset: { type: 'number', required: true }, length: { type: 'number', required: true } }, fullSurfaceOnly: true },
  around_chunk_id: { type: 'number', description: 'Window around a search hit chunk_id.', fullSurfaceOnly: true },
  context_lines: { type: 'number', description: 'Lines around around_chunk_id (20).', fullSurfaceOnly: true },
  cursor: { type: 'string', description: 'next_cursor: read on.', fullSurfaceOnly: true },
  max_bytes: { type: 'number', description: 'Window bytes (40000).', fullSurfaceOnly: true },
  view: { type: 'string', enum: ['read', 'markdown'], description: 'markdown: page the round-trip content.', fullSurfaceOnly: true },
  outline_from: { type: 'number', description: 'Outline next_from_index.', fullSurfaceOnly: true },
};

type Selector =
  | { kind: 'lines'; from: number; count: number }
  | { kind: 'bytes'; offset: number; length: number }
  | { kind: 'around'; chunkId: number }
  | { kind: 'cursor'; raw: string };

export interface BodyRequest {
  mode: BodyMode;
  selector?: Selector;
  view: WindowView;
  maxBytes?: number;
  contextLines: number;
  outlineFrom: number;
  /** The caller named no mode and is gbrain's thin client (full or refused, never a window). */
  legacyThin: boolean;
}

const SELECTOR_EXAMPLE = { slug: 'notes/acme-example-log', body: 'window', lines: { from: 1, count: 200 } };

function int(v: unknown): v is number { return typeof v === 'number' && Number.isSafeInteger(v); }

/** Validate and resolve the body-mode params; throws invalid_params naming the conflict. */
export function parseBodyRequest(ctx: Pick<OperationContext, 'remote' | 'transport' | 'thinClient'>, p: Record<string, unknown>): BodyRequest {
  const bad = (param: string, message: string, example: unknown = SELECTOR_EXAMPLE) => invalidParam(ctx, 'get_page', param, message, { example });
  const body = p.body;
  if (body !== undefined && (typeof body !== 'string' || !(BODY_MODES as readonly string[]).includes(body))) {
    throw invalidParam(ctx, 'get_page', 'body', `get_page: body must be one of ${BODY_MODES.join(', ')}.`, { choices: BODY_MODES, example: 'none' });
  }
  const selectors: Selector[] = [];
  if (p.lines !== undefined) {
    const l = p.lines as Record<string, unknown> | null;
    if (!l || typeof l !== 'object' || !int(l.from) || !int(l.count) || l.from < 1 || l.count < 1) {
      throw bad('lines', 'get_page: lines must be { from: <1-based line>, count: <lines> } with positive integers.', { from: 1, count: 200 });
    }
    selectors.push({ kind: 'lines', from: l.from, count: l.count });
  }
  if (p.bytes !== undefined) {
    const b = p.bytes as Record<string, unknown> | null;
    if (!b || typeof b !== 'object' || !int(b.offset) || !int(b.length) || b.offset < 0 || b.length < 1) {
      throw bad('bytes', 'get_page: bytes must be { offset: <byte offset >= 0>, length: <bytes >= 1> }.', { offset: 0, length: DEFAULT_WINDOW_BYTES });
    }
    selectors.push({ kind: 'bytes', offset: b.offset, length: b.length });
  }
  if (p.around_chunk_id !== undefined) {
    if (!int(p.around_chunk_id) || p.around_chunk_id < 1) throw bad('around_chunk_id', 'get_page: around_chunk_id must be a positive chunk_id from a search result.', 8812);
    selectors.push({ kind: 'around', chunkId: p.around_chunk_id });
  }
  if (p.cursor !== undefined) {
    if (typeof p.cursor !== 'string' || !p.cursor) throw bad('cursor', 'get_page: cursor must be the next_cursor string from the previous window.', 'gpw1.…');
    selectors.push({ kind: 'cursor', raw: p.cursor });
  }
  if (selectors.length > 1) {
    throw bad(selectors[1].kind === 'around' ? 'around_chunk_id' : selectors[1].kind, `get_page: pass one window selector, not ${selectors.length} (got ${selectors.map(s => s.kind === 'around' ? 'around_chunk_id' : s.kind).join(' and ')}).`);
  }
  const includeContent = p.include_content === true;
  const contentOnly = p.content_only === true;
  let mode: BodyMode;
  if (typeof body === 'string') {
    mode = body as BodyMode;
    if ((includeContent || contentOnly) && mode !== 'full') {
      throw bad('body', `get_page: include_content and content_only return the whole page; they cannot be combined with body: '${mode}'.`, { slug: 'notes/acme-example-log', body: 'full', include_content: true });
    }
    if (selectors.length && mode !== 'window' && mode !== 'auto') {
      throw bad('body', `get_page: a window selector needs body: 'window' (got body: '${mode}').`);
    }
    if (mode === 'auto' && selectors.length) mode = 'window';
  } else if (includeContent || contentOnly) {
    if (selectors.length) throw bad('include_content', 'get_page: include_content returns the whole page; drop it to read a window.');
    mode = 'full';
  } else if (selectors.length) mode = 'window';
  else if (ctx.thinClient === true || ctx.remote === false) mode = 'full';
  else mode = 'auto';
  const view = p.view === undefined ? 'read' : p.view;
  if (view !== 'read' && view !== 'markdown') throw invalidParam(ctx, 'get_page', 'view', "get_page: view must be 'read' or 'markdown'.", { choices: ['read', 'markdown'], example: 'markdown' });
  if (view === 'markdown' && (mode !== 'window' || selectors[0]?.kind === 'around')) {
    throw bad('view', "get_page: view: 'markdown' pages the round-trip markdown with body: 'window' and a lines, bytes or cursor selector.", { slug: 'notes/acme-example-log', body: 'window', view: 'markdown', bytes: { offset: 0, length: 1_000_000 } });
  }
  let maxBytes: number | undefined;
  if (p.max_bytes !== undefined) {
    if (!int(p.max_bytes) || p.max_bytes < 1) throw bad('max_bytes', 'get_page: max_bytes must be a positive integer.', DEFAULT_WINDOW_BYTES);
    maxBytes = p.max_bytes;
  }
  let contextLines = DEFAULT_CONTEXT_LINES;
  if (p.context_lines !== undefined) {
    if (!int(p.context_lines) || p.context_lines < 0) throw bad('context_lines', 'get_page: context_lines must be a non-negative integer.', DEFAULT_CONTEXT_LINES);
    contextLines = Math.min(MAX_CONTEXT_LINES, p.context_lines);
  }
  let outlineFrom = 0;
  if (p.outline_from !== undefined) {
    if (!int(p.outline_from) || p.outline_from < 0) throw bad('outline_from', 'get_page: outline_from must be a non-negative integer (the previous next_from_index).', 100);
    outlineFrom = p.outline_from;
  }
  return { mode, ...(selectors[0] ? { selector: selectors[0] } : {}), view, ...(maxBytes !== undefined ? { maxBytes } : {}), contextLines, outlineFrom,
    legacyThin: typeof body !== 'string' && ctx.thinClient === true && !includeContent && !contentOnly && !selectors.length };
}

export async function inlineBodyBytes(ctx: Pick<OperationContext, 'engine' | 'config'>): Promise<number> {
  try {
    const n = Number(await ctx.engine.getConfig(INLINE_BODY_BYTES_KEY));
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  } catch { /* config unreadable: the file plane, then the default */ }
  const file = Number((ctx.config?.mcp as Record<string, unknown> | undefined)?.inline_body_bytes);
  return Number.isFinite(file) && file > 0 ? Math.floor(file) : DEFAULT_INLINE_BODY_BYTES;
}

/** Bytes of the body a full read returns (compiled truth plus timeline). */
export function bodyBytes(page: Pick<Page, 'compiled_truth' | 'timeline'>): number {
  return Buffer.byteLength(page.compiled_truth ?? '', 'utf8') + Buffer.byteLength(page.timeline ?? '', 'utf8');
}

function sizeFix(slug: string, sourceId: string, why: string) {
  return readFix(why, { argv: ['gbrain', 'get', '--source', sourceId, '--', slug], mcp: { tool: 'get_page', arguments: { slug, source_id: sourceId, body: 'outline' } } });
}

/**
 * A full read must fit the connection: measured as the complete encoded frame
 * of the result (content[0] holds the JSON text, which the JSON-RPC frame
 * escapes again). Trusted local reads have no cap.
 */
export async function assertFullReadFits(ctx: OperationContext, page: Pick<Page, 'slug' | 'source_id' | 'compiled_truth' | 'timeline'>, result: unknown, req: BodyRequest): Promise<void> {
  const cap = await resultByteCap({ remote: ctx.remote, transport: ctx.transport, engine: ctx.engine, config: ctx.config });
  if (!Number.isFinite(cap)) return;
  const raw = bodyBytes(page);
  // Escaping grows text at most ~12x through two JSON levels; well under the cap needs no measurement.
  if (raw * 12 + ENVELOPE_RESERVE_BYTES < cap) return;
  const frame = encodedFrameBytes({ content: [{ type: 'text', text: JSON.stringify(result) }] }) + ENVELOPE_RESERVE_BYTES - FRAME_RESERVE_BYTES;
  if (frame <= cap) return;
  const transport = egressTransport(ctx)!;
  throw opError('page_too_large_for_inline',
    `Page ${page.slug} is too large to return whole on this connection (about ${frame} bytes encoded; the cap is ${cap}).`,
    req.legacyThin
      ? 'This gbrain CLI is older than the host and reads pages whole. Upgrade it (gbrain upgrade) to page through large pages, or read windows over MCP with get_page body: \'window\'.'
      : "Read it in windows: get_page body: 'outline' lists the sections, then body: 'window' with lines, bytes, around_chunk_id or next_cursor. Edit with edit_page (revision from body: 'none').",
    { legacy_error: 'invalid_params', detail: JSON.stringify({ total_bytes: raw, result_bytes: frame, max_result_bytes: cap, transport, config_key: EGRESS_CAP_CONFIG_KEYS[transport] }),
      fix: sizeFix(page.slug, page.source_id, "Returns the page's size, revision and outline; each entry names the lines to read with body: 'window'.") });
}

/** The largest window this caller may receive: the request, the per-window ceiling and the egress cap minus metadata room. */
async function windowBudget(ctx: OperationContext, requested: number | undefined, fallback: number): Promise<number> {
  const cap = await resultByteCap({ remote: ctx.remote, transport: ctx.transport, engine: ctx.engine, config: ctx.config });
  // A window's text can grow ~2x through the two JSON levels of a frame (newlines, quotes).
  const egressRoom = Number.isFinite(cap) ? Math.max(4096, Math.floor((cap - ENVELOPE_RESERVE_BYTES) / 2)) : Number.POSITIVE_INFINITY;
  const ceiling = ctx.remote === false ? Number.POSITIVE_INFINITY : MAX_WINDOW_BYTES;
  return Math.max(1, Math.min(requested ?? fallback, ceiling, egressRoom));
}

export interface PartialReadInput {
  page: Page;
  /** The body this caller may see (privacy fences already stripped for untrusted readers): the source of view 'markdown'. */
  visibleBody: Page;
  revision: string;
  tags: string[];
  quarantined: QuarantinedView | null;
  trust?: TrustFields;
  extras: Record<string, unknown>;
}

function envelopeText(text: string, quarantined: QuarantinedView | null, trust?: TrustFields): string {
  return quarantined?.body_enveloped && text ? renderTrustedText(text, { trust_tier: 'external_untrusted', origin: trust?.origin ?? 'quarantined' }) : text;
}

/** Resolve only current safe chunks; chunk-only fallback still requires a match in the read projection. */
async function aroundChunk(ctx: OperationContext, page: Page, doc: PageDocument, chunkId: number, contextLines: number, maxBytes: number, revision: string):
  Promise<{ window: WindowSlice | null; chunkText: string; anchor: 'stored_span' | 'located' | 'chunk_only'; span?: { byte_start: number; byte_end: number } }> {
  const rows = await ctx.engine.executeRaw<{ chunk_text: string; chunk_source: string; projected_byte_start: unknown; projected_byte_end: unknown }>(
    `SELECT cc.chunk_text, cc.chunk_source, cc.projected_byte_start, cc.projected_byte_end FROM content_chunks cc
      JOIN pages p ON p.id = cc.page_id
      WHERE cc.id = $1 AND cc.page_id = $2 AND COALESCE(cc.modality, 'text') = 'text'
        AND p.knowledge_revision = $3::uuid
        AND ${currentTextProjectionFilter('p')}${ctx.remote !== false ? ` AND ${safeChunksFilter('p')}` : ''}`, [chunkId, page.id, page.knowledge_revision ?? null]);
  const row = rows[0];
  if (!row) {
    throw opError('revision_changed', `Chunk ${chunkId} is not part of page ${page.slug} at its current revision.`,
      "The page was re-chunked or edited since that search. Search again for a current chunk_id, or read the page's outline.",
      { legacy_error: 'invalid_params', detail: JSON.stringify({ revision, chunk_id: chunkId }),
        fix: sizeFix(page.slug, page.source_id, "Returns the current revision and outline; search again for a current chunk_id.") });
  }
  const chunk = { chunk_source: row.chunk_source,
    projected_byte_start: row.projected_byte_start == null ? null : Number(row.projected_byte_start),
    projected_byte_end: row.projected_byte_end == null ? null : Number(row.projected_byte_end) };
  const stored = chunkDocumentSpan(doc, chunk);
  if (stored && spanHoldsChunk(doc, stored, row.chunk_text)) {
    return { window: windowAround(doc.bytes, stored, contextLines, maxBytes), chunkText: row.chunk_text, anchor: 'stored_span', span: { byte_start: stored.start, byte_end: stored.end } };
  }
  // No stored span (a chunk written before spans were recorded) or a stale one: accept a text match only when it is unique.
  const needle = Buffer.from(row.chunk_text.trim(), 'utf8');
  if (needle.length >= 16) {
    const at = doc.bytes.indexOf(needle);
    if (at !== -1 && doc.bytes.indexOf(needle, at + 1) === -1) {
      const span = { start: at, end: at + needle.length };
      return { window: windowAround(doc.bytes, span, contextLines, maxBytes), chunkText: row.chunk_text, anchor: 'located', span: { byte_start: span.start, byte_end: span.end } };
    }
  }
  const normalized = row.chunk_text.replace(/\s+/g, '');
  if (!normalized || !doc.bytes.toString('utf8').replace(/\s+/g, '').includes(normalized)) {
    throw opError('revision_changed', `Chunk ${chunkId} does not match the current readable page.`,
      'Search again for a current safe chunk, or read the page outline.',
      { legacy_error: 'invalid_params', fix: sizeFix(page.slug, page.source_id, 'Read the current revision and outline.') });
  }
  return { window: null, chunkText: row.chunk_text, anchor: 'chunk_only' };
}

/** next_cursor plus `next`, the exact call that reads on (the starter surface does not advertise `cursor`; dispatch accepts it). */
function setNext(out: Record<string, unknown>, page: Page, cursor: string, markdown: boolean): void {
  out.next_cursor = cursor;
  out.next = { tool: 'get_page', arguments: { slug: page.slug, source_id: page.source_id, cursor, ...(markdown ? { view: 'markdown' } : {}) } };
}

/**
 * The partial (none / outline / window / auto-above-threshold) response. Never
 * carries compiled_truth, timeline or content.
 */
export async function readPartialBody(ctx: OperationContext, input: PartialReadInput, req: BodyRequest): Promise<Record<string, unknown>> {
  const { page, revision, tags, quarantined, trust, extras } = input;
  const base: Record<string, unknown> = {
    slug: page.slug, source_id: page.source_id, type: page.type, title: page.title, revision, tags,
    frontmatter: page.frontmatter ?? {}, ...(page.deleted_at ? { deleted_at: page.deleted_at } : {}),
    ...(trust ?? {}), ...extras,
  };
  const omitted = quarantined?.body_omitted === true;
  const mode = req.mode === 'auto' ? 'outline' : req.mode;
  if (omitted) return { ...base, body: mode, truncated: true, body_omitted: true };

  const markdown = req.view === 'markdown';
  const doc: PageDocument = markdown
    ? { bytes: Buffer.from(serializePageToMarkdown(input.visibleBody, tags), 'utf8'), timelineByte: -1 }
    : await readPageDocument(ctx.engine, page);
  const size: Record<string, unknown> = {
    total_bytes: doc.bytes.length, total_lines: totalLines(doc.bytes),
    ...(doc.timelineByte >= 0 ? { timeline_byte_start: doc.timelineByte } : {}),
    ...(markdown ? { sha256: sha256Hex(doc.bytes) } : {}),
  };
  const out: Record<string, unknown> = { ...base, body: mode, view: req.view, size };

  if (mode === 'none') {
    const [counts] = await ctx.engine.executeRaw<{ total: unknown; embedded: unknown }>(
      `SELECT count(*) AS total, count(*) FILTER (WHERE embedded_at IS NOT NULL) AS embedded FROM content_chunks WHERE page_id = $1`, [page.id]);
    const fm = (page.frontmatter ?? {}) as Record<string, unknown>;
    return { ...out, chunks: { total: Number(counts?.total ?? 0), embedded: Number(counts?.embedded ?? 0) },
      ...(fm.embed_skip ? { embed_skip: true } : {}), truncated: doc.bytes.length > 0 };
  }

  if (mode === 'outline') {
    const limit = Math.min(MAX_OUTLINE_LIMIT, DEFAULT_OUTLINE_LIMIT);
    out.outline = pageOutline(doc.bytes, req.outlineFrom, limit);
    if (req.mode === 'auto') {
      const first = windowFrom(doc.bytes, 0, await windowBudget(ctx, req.maxBytes, AUTO_WINDOW_BYTES));
      out.window = { ...first, text: envelopeText(first.text, quarantined, trust) };
      out.truncated = true;
      if (first.byte_end < doc.bytes.length) setNext(out, page, encodeCursor({ page_id: page.id, revision, view: 'read', offset: first.byte_end, max_bytes: req.maxBytes ?? DEFAULT_WINDOW_BYTES }), false);
      out.auto_reason = 'over_inline_bytes';
      return out;
    }
    return { ...out, truncated: true };
  }

  // window: chosen, then measured as the final encoded frame; text that escapes heavily shrinks the window until it fits.
  const sel = req.selector;
  let cursorMax = req.maxBytes ?? DEFAULT_WINDOW_BYTES;
  const select = async (maxBytes: number): Promise<WindowSlice | null> => {
    if (!sel) return windowFrom(doc.bytes, 0, maxBytes);
    if (sel.kind === 'lines') return windowForLines(doc.bytes, sel.from, sel.count, maxBytes);
    if (sel.kind === 'bytes') return windowForBytes(doc.bytes, sel.offset, Math.min(sel.length, maxBytes));
    if (sel.kind === 'cursor') {
      const c = decodeCursor(sel.raw);
      if (!c || c.page_id !== page.id) {
        throw invalidParam(ctx, 'get_page', 'cursor', `get_page: cursor is not a window cursor for page ${page.slug}.`, { example: 'gpw1.…' });
      }
      if (c.view !== req.view) {
        throw invalidParam(ctx, 'get_page', 'view', `get_page: this cursor pages view '${c.view}'; pass view: '${c.view}' with it.`, { choices: ['read', 'markdown'], example: c.view });
      }
      if (c.revision !== revision) {
        const position = Math.min(c.offset, doc.bytes.length);
        throw opError('revision_changed', `Page ${page.slug} changed since this cursor was issued (revision ${c.revision}, now ${revision}).`,
          `Continue from the same byte offset at the current revision (bytes: { offset: ${position}, length: ${c.max_bytes} }), or start over from the outline.`,
          { legacy_error: 'invalid_params', detail: JSON.stringify({ revision, cursor_revision: c.revision, offset: position }),
            fix: readFix('Reads on from the same byte offset at the current revision.', { argv: ['gbrain', 'get', '--source', page.source_id, '--', page.slug],
              mcp: { tool: 'get_page', arguments: { slug: page.slug, source_id: page.source_id, body: 'window', ...(markdown ? { view: 'markdown' } : {}), bytes: { offset: position, length: c.max_bytes } } } }) });
      }
      cursorMax = c.max_bytes;
      return windowFrom(doc.bytes, c.offset, Math.min(c.max_bytes, maxBytes));
    }
    const around = await aroundChunk(ctx, page, doc, sel.chunkId, req.contextLines, maxBytes, revision);
    out.anchor = around.anchor;
    if (around.span) out.chunk_span = around.span;
    // T46: no exact position for the chunk, so no estimated neighborhood either: the chunk itself, without coordinates.
    if (!around.window) out.window = { text: envelopeText(around.chunkText, quarantined, trust) };
    return around.window;
  };
  const cap = await resultByteCap({ remote: ctx.remote, transport: ctx.transport, engine: ctx.engine, config: ctx.config });
  let maxBytes = await windowBudget(ctx, req.maxBytes ?? (sel?.kind === 'cursor' ? decodeCursor(sel.raw)?.max_bytes : undefined), DEFAULT_WINDOW_BYTES);
  for (let attempt = 0; ; attempt++) {
    const win = await select(maxBytes);
    if (!win) return { ...out, truncated: true };
    out.window = { ...win, text: envelopeText(win.text, quarantined, trust) };
    out.truncated = win.byte_start > 0 || win.byte_end < doc.bytes.length;
    if (win.byte_end < doc.bytes.length) setNext(out, page, encodeCursor({ page_id: page.id, revision, view: req.view, offset: win.byte_end, max_bytes: cursorMax }), markdown);
    else { delete out.next_cursor; delete out.next; }
    if (!Number.isFinite(cap) || attempt >= 6) return out;
    const frame = encodedFrameBytes({ content: [{ type: 'text', text: JSON.stringify(out) }] }) + ENVELOPE_RESERVE_BYTES - FRAME_RESERVE_BYTES;
    if (frame <= cap || win.byte_end - win.byte_start <= 1) return out;
    maxBytes = Math.max(1, Math.floor((win.byte_end - win.byte_start) * (cap / frame) * 0.9));
  }
}


/**
 * Large pages (T24): fetch's window for a page over the inline read size, on
 * the search/fetch-only surface. A chunk anchor (from the search result id)
 * centers the window on that hit; a cursor anchor reads on. A chunk that is no
 * longer on the page falls back to the first window, and a cursor from an
 * older revision reads on from the same byte offset, so a fetch-only client
 * can always finish the page.
 */
export async function readFetchWindow(ctx: OperationContext, input: PartialReadInput, anchor: { chunkId?: number; cursor?: string } | null):
  Promise<{ partial: Record<string, any>; anchorStatus: 'chunk' | 'cursor' | 'start' | 'chunk_not_current' | 'cursor_rebased' }> {
  const req = (selector?: Selector): BodyRequest => ({ mode: 'window', view: 'read', contextLines: DEFAULT_CONTEXT_LINES, outlineFrom: 0, legacyThin: false, ...(selector ? { selector } : {}) });
  const stale = (e: unknown) => e instanceof OperationError && (e.canonical ?? e.code) === 'revision_changed';
  if (anchor?.chunkId !== undefined) {
    try { return { partial: await readPartialBody(ctx, input, req({ kind: 'around', chunkId: anchor.chunkId })), anchorStatus: 'chunk' }; }
    catch (e) { if (!stale(e)) throw e; return { partial: await readPartialBody(ctx, input, req()), anchorStatus: 'chunk_not_current' }; }
  }
  if (anchor?.cursor !== undefined) {
    try { return { partial: await readPartialBody(ctx, input, req({ kind: 'cursor', raw: anchor.cursor })), anchorStatus: 'cursor' }; }
    catch (e) {
      const c = decodeCursor(anchor.cursor);
      if (!stale(e) || !c) throw e;
      return { partial: await readPartialBody(ctx, input, req({ kind: 'bytes', offset: c.offset, length: c.max_bytes })), anchorStatus: 'cursor_rebased' };
    }
  }
  return { partial: await readPartialBody(ctx, input, req()), anchorStatus: 'start' };
}

/** fetch's response for a windowed page: the window as `text`, its position and the continuation id in metadata. */
export async function fetchWindowResult(ctx: OperationContext, input: PartialReadInput, id: string, anchor: { chunkId?: number; cursor?: string } | null): Promise<Record<string, unknown>> {
  const { page, revision, tags, quarantined, trust } = input;
  const { partial, anchorStatus } = await readFetchWindow(ctx, input, anchor);
  const w = partial.window ?? { text: '' };
  return {
    id,
    title: page.title,
    text: w.text,
    url: deepResearchPageUrl(page.source_id, page.slug),
    metadata: {
      revision, type: page.type, source_id: page.source_id, updated_at: page.updated_at, tags, ...(quarantined ? { quarantined } : {}), ...(trust ?? {}),
      truncated: true, total_bytes: partial.size?.total_bytes, anchor: anchorStatus,
      ...(typeof w.byte_start === 'number' ? { window: { byte_start: w.byte_start, byte_end: w.byte_end, line_start: w.line_start, line_end: w.line_end } } : {}),
      ...(partial.next_cursor ? { next_id: encodeDeepResearchId(page.source_id, page.slug, { cursor: partial.next_cursor }) } : {}),
    },
  };
}
