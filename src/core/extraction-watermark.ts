/**
 * Large pages A7: no silent head-only extraction.
 *
 * Page extractors read a bounded slice of the body (facts: 8,000 chars,
 * atoms: `cycle.extract_atoms.max_input_chars`). Reading the head every time
 * means the text appended to a long conversation page is never extracted.
 * A per-page watermark per pipeline fixes that: the UTF-8 byte offset of the
 * body the last successful extraction covered, the sha256 of the body up to
 * that offset, and the pipeline version. When the current body still starts
 * with exactly that prefix, the next extraction reads only the appended tail
 * (its newest `cap` characters when the tail itself is longer). Otherwise it
 * reads the head as before and records the durable receipt `input_truncated`
 * in `page_extraction_state`, which doctor's `extraction_input_truncated`
 * check reports. A full read clears the receipt; a tail read keeps it, since
 * the text skipped earlier is still unread.
 *
 * A segmented page's compiled truth is planned the same way without holding it
 * (planSegmentedExtraction): one pass over its segments (readBodyRange) hashes
 * the body and the watermark prefix and keeps only the head and the newest
 * window of the appended tail.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from './engine.ts';
import { truncateUtf8 } from './text-safe.ts';
import { openSegmentedBody, readBodyRange } from './page-body/read-range.ts';
import { readGarbageCollector, segmentedPassWork } from './page-body/segment-blocks.ts';

export type ExtractionPipeline = 'facts_backstop' | 'extract_atoms' | 'conversation_facts';

/** Bump a pipeline's version when its extracted body changes shape: every stored watermark then falls back to the head once. */
export const EXTRACTION_PIPELINE_VERSION: Readonly<Record<ExtractionPipeline, number>> = {
  facts_backstop: 1, extract_atoms: 1, conversation_facts: 1,
};

export type HeadFallbackReason = 'no_watermark' | 'prefix_changed' | 'version_changed' | 'no_new_text';

/** The durable receipt of an extraction that did not read all of its input. */
export interface InputTruncated {
  kind: 'head' | 'tail_window' | 'skipped_too_large';
  pipeline: ExtractionPipeline;
  /** Characters the extractor read (0 for a skipped page). */
  processed_chars: number;
  /** Characters of the input the cap applied to: the body for `head`, the appended tail for `tail_window`; absent for an unread input. */
  total_chars?: number;
  reason?: HeadFallbackReason;
  /** `skipped_too_large`: the input's UTF-8 size, the cap it exceeded and where the input came from. */
  total_bytes?: number;
  cap_bytes?: number;
  origin?: 'page' | 'sidecar';
  /**
   * conversation_facts on a page over the window cap: `no_prior_facts` (the newest window was extracted; the page had
   * no conversation facts a clear could lose) or `prior_facts_kept` (skipped: the page's `prior_facts` conversation
   * facts may lie outside the window, so nothing was cleared).
   */
  window_rule?: 'no_prior_facts' | 'prior_facts_kept';
  prior_facts?: number;
}

export interface StoredWatermark { pipelineVersion: number; bytes: number; sha256: string }

export interface ExtractionPlan {
  pipeline: ExtractionPipeline;
  /** full: the body fits the cap; tail: past the watermark; head: no usable watermark. */
  mode: 'full' | 'tail' | 'head';
  /** Exactly what the extractor reads, at most `cap` characters. Empty only for a tail with nothing appended. */
  text: string;
  truncated: InputTruncated | null;
  /** The watermark to store once the extraction succeeded: the whole current body. */
  next: { bytes: number; sha256: string };
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** The newest `cap` characters of `text`, never starting inside a surrogate pair, at a line start when one is near. */
function newestWindow(text: string, cap: number): string {
  let start = text.length - cap;
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start++;
  const newline = text.indexOf('\n', start);
  if (newline >= 0 && newline - start < Math.floor(cap / 10)) start = newline + 1;
  return text.slice(start);
}

/**
 * Decide what one extraction reads. `emptyTail` says what a matching
 * watermark with nothing appended means: `skip` (nothing new to extract) or
 * `head` (the caller re-reads on purpose, e.g. after the cap rose).
 */
export function planExtraction(body: string, stored: StoredWatermark | null,
  opts: { cap: number; pipeline: ExtractionPipeline; emptyTail: 'skip' | 'head' }): ExtractionPlan {
  const { cap, pipeline } = opts;
  const buf = Buffer.from(body, 'utf8');
  const next = { bytes: buf.length, sha256: sha256(buf) };
  if (body.length <= cap) return { pipeline, mode: 'full', text: body, truncated: null, next };
  const head = (reason: HeadFallbackReason): ExtractionPlan => ({ pipeline, mode: 'head', text: truncateUtf8(body, cap), next,
    truncated: { kind: 'head', pipeline, processed_chars: Math.min(cap, body.length), total_chars: body.length, reason } });
  if (!stored) return head('no_watermark');
  if (stored.pipelineVersion !== EXTRACTION_PIPELINE_VERSION[pipeline]) return head('version_changed');
  const offset = stored.bytes;
  const onBoundary = offset === buf.length || (offset < buf.length && (buf[offset]! & 0xc0) !== 0x80);
  if (offset > buf.length || !onBoundary || sha256(buf.subarray(0, offset)) !== stored.sha256) return head('prefix_changed');
  const tail = buf.subarray(offset).toString('utf8');
  if (!tail.trim()) return opts.emptyTail === 'skip' ? { pipeline, mode: 'tail', text: '', truncated: null, next } : head('no_new_text');
  if (tail.length <= cap) return { pipeline, mode: 'tail', text: tail, truncated: null, next };
  const window = newestWindow(tail, cap);
  return { pipeline, mode: 'tail', text: window, next,
    truncated: { kind: 'tail_window', pipeline, processed_chars: window.length, total_chars: tail.length } };
}

/**
 * planExtraction over a segmented page's compiled truth (the trusted stored text readPageSnapshot gives an inline
 * page), read segment by segment: the same plan, holding at most the head, the newest 2 x `cap` characters of the
 * tail and one segment. O(page) work, O(segment) memory.
 */
export async function planSegmentedExtraction(engine: BrainEngine, pageId: number, stored: StoredWatermark | null,
  opts: { cap: number; pipeline: ExtractionPipeline; emptyTail: 'skip' | 'head' }): Promise<ExtractionPlan> {
  const { cap, pipeline } = opts;
  const body = await openSegmentedBody(engine, { pageId });
  const offset = stored && stored.pipelineVersion === EXTRACTION_PIPELINE_VERSION[pipeline] ? stored.bytes : null;
  const whole = createHash('sha256');
  const prefix = createHash('sha256');
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const tailDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
  let bytes = 0, chars = 0, tailChars = 0, head = '', tail = '', tailText = false;
  let boundary: number | undefined;
  const collect = readGarbageCollector();
  for await (const piece of readBodyRange(engine, { pageId, space: 'stored', start: 0, end: Infinity, audience: 'trusted', region: 'truth', body })) {
    const buf = piece.bytes;
    collect(buf.length);
    segmentedPassWork.bytes += buf.length;
    whole.update(buf);
    const text = decoder.decode(buf, { stream: true });
    chars += text.length;
    if (head.length <= cap) head += text.slice(0, cap + 1 - head.length);
    if (offset !== null) {
      const split = Math.max(0, Math.min(buf.length, offset - bytes));
      if (split > 0) prefix.update(buf.subarray(0, split));
      if (offset >= bytes && offset < bytes + buf.length) boundary = buf[offset - bytes];
      const after = tailDecoder.decode(buf.subarray(split), { stream: true });
      tailChars += after.length;
      tailText ||= after.trim().length > 0;
      segmentedPassWork.carry += tail.length + after.length;
      tail = (tail + after).slice(-2 * cap);
    }
    bytes += buf.length;
  }
  const next = { bytes, sha256: whole.digest('hex') };
  if (chars <= cap) return { pipeline, mode: 'full', text: head, truncated: null, next };
  const headPlan = (reason: HeadFallbackReason): ExtractionPlan => ({ pipeline, mode: 'head', text: truncateUtf8(head, cap), next,
    truncated: { kind: 'head', pipeline, processed_chars: cap, total_chars: chars, reason } });
  if (!stored) return headPlan('no_watermark');
  if (offset === null) return headPlan('version_changed');
  const onBoundary = offset === bytes || (offset < bytes && boundary !== undefined && (boundary & 0xc0) !== 0x80);
  if (offset > bytes || !onBoundary || prefix.digest('hex') !== stored.sha256) return headPlan('prefix_changed');
  if (!tailText) return opts.emptyTail === 'skip' ? { pipeline, mode: 'tail', text: '', truncated: null, next } : headPlan('no_new_text');
  if (tailChars <= cap) return { pipeline, mode: 'tail', text: tail, truncated: null, next };
  const window = newestWindow(tail, cap);
  return { pipeline, mode: 'tail', text: window, next, truncated: { kind: 'tail_window', pipeline, processed_chars: window.length, total_chars: tailChars } };
}

let warnedStorage = false;
function warnStorageOnce(action: string, error: unknown): void {
  if (warnedStorage) return;
  warnedStorage = true;
  console.error(`[extraction-watermark] could not ${action} (${error instanceof Error ? error.message : String(error)}); `
    + 'large pages fall back to head-only extraction until gbrain apply-migrations brings the schema to head.');
}

/** The page's id and stored watermark for `pipeline`; `pageId` is null when no live page has that slug. Fail-soft to no watermark. */
export async function readPageWatermark(engine: BrainEngine, sourceId: string, slug: string,
  pipeline: ExtractionPipeline): Promise<{ pageId: number | null; stored: StoredWatermark | null }> {
  try {
    const [row] = await engine.executeRaw<{ id: number; pipeline_version: number | null; watermark_bytes: string | number | null; watermark_sha256: string | null }>(
      `SELECT p.id, s.pipeline_version, s.watermark_bytes, s.watermark_sha256
         FROM pages p LEFT JOIN page_extraction_state s ON s.page_id = p.id AND s.pipeline = $3
        WHERE p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL`, [sourceId, slug, pipeline]);
    if (!row) return { pageId: null, stored: null };
    const stored = row.pipeline_version !== null && row.watermark_bytes !== null && row.watermark_sha256
      ? { pipelineVersion: Number(row.pipeline_version), bytes: Number(row.watermark_bytes), sha256: row.watermark_sha256 } : null;
    return { pageId: Number(row.id), stored };
  } catch (error) {
    warnStorageOnce('read the extraction watermark', error);
    return { pageId: null, stored: null };
  }
}

/**
 * Store a successful extraction: the watermark moves to the end of the body
 * it planned against. A full read clears the receipt, a truncated read
 * replaces it, and a complete tail read keeps whatever gap an earlier read left.
 */
export async function commitExtractionPlan(engine: BrainEngine, pageId: number, plan: ExtractionPlan): Promise<void> {
  const receipt = plan.truncated ? JSON.stringify(plan.truncated) : null;
  try {
    await engine.executeRaw(
      `INSERT INTO page_extraction_state (page_id, pipeline, pipeline_version, watermark_bytes, watermark_sha256, input_truncated, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::text::jsonb, now())
       ON CONFLICT (page_id, pipeline) DO UPDATE SET pipeline_version = EXCLUDED.pipeline_version,
         watermark_bytes = EXCLUDED.watermark_bytes, watermark_sha256 = EXCLUDED.watermark_sha256,
         input_truncated = CASE WHEN $7 THEN page_extraction_state.input_truncated ELSE EXCLUDED.input_truncated END,
         updated_at = now()`,
      [pageId, plan.pipeline, EXTRACTION_PIPELINE_VERSION[plan.pipeline], plan.next.bytes, plan.next.sha256, receipt,
        plan.mode === 'tail' && !plan.truncated]);
  } catch (error) {
    warnStorageOnce('store the extraction watermark', error);
  }
}

/** Record (receipt) or clear (null) the partial-input receipt of a pipeline that keeps no watermark: the conversation-facts size skip. */
export async function setExtractionReceipt(engine: BrainEngine, pageId: number, pipeline: ExtractionPipeline,
  receipt: InputTruncated | null): Promise<void> {
  try {
    if (!receipt) {
      await engine.executeRaw('DELETE FROM page_extraction_state WHERE page_id = $1 AND pipeline = $2', [pageId, pipeline]);
      return;
    }
    await engine.executeRaw(
      `INSERT INTO page_extraction_state (page_id, pipeline, pipeline_version, input_truncated, updated_at)
       VALUES ($1, $2, $3, $4::text::jsonb, now())
       ON CONFLICT (page_id, pipeline) DO UPDATE SET input_truncated = EXCLUDED.input_truncated, updated_at = now()`,
      [pageId, pipeline, EXTRACTION_PIPELINE_VERSION[pipeline], JSON.stringify(receipt)]);
  } catch (error) {
    warnStorageOnce('store the extraction receipt', error);
  }
}
