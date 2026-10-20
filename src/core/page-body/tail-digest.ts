/**
 * The append precondition's tail digest (Wave B, spec 6.1): sha256 of a region's last min(4096, region bytes) raw
 * stored bytes. get_page body:'none' returns it (tail_sha256) and append_page's expected_tail_sha256 compares against
 * it. A remote caller is never given, and cannot test, a tail holding protected or facts text: a hash of hidden text
 * is a guessing oracle. Segmented pages: page-window/segmented.ts tailDigest; inline pages: here.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { PROTECTED_PAIRS } from '../remote-body.ts';
import { protectedRegions } from '../fence-scan.ts';

export const APPEND_TAIL_BYTES = 4096;

export interface RegionTail {
  region: 'truth' | 'timeline';
  /** The region's last min(APPEND_TAIL_BYTES, region bytes) raw bytes. */
  bytes: Uint8Array;
  /** Those bytes hold protected or facts text: withheld from (and not testable by) a remote caller. */
  guarded: boolean;
}

export const tailSha256 = (tail: RegionTail) => createHash('sha256').update(tail.bytes).digest('hex');

/** The tail of an inline region's raw text, guarded when a facts or takes fence (or an unclosed opener) reaches it. */
export function inlineRegionTail(text: string, region: 'truth' | 'timeline'): RegionTail {
  const raw = Buffer.from(text, 'utf8');
  const from = Math.max(0, raw.length - APPEND_TAIL_BYTES);
  const { regions, truncatedAt } = protectedRegions(text, PROTECTED_PAIRS);
  const at = (index: number) => Buffer.byteLength(text.slice(0, index), 'utf8');
  return { region, bytes: raw.subarray(from), guarded: (truncatedAt !== -1 && at(truncatedAt) < raw.length) || regions.some(r => at(r.end) > from) };
}

/** An inline page's stored regions, read raw (no withdrawal overlay), as the append path compares them. */
export async function inlineRegions(engine: Pick<BrainEngine, 'executeRaw'>, pageId: number): Promise<{ truth: string; timeline: string }> {
  const [row] = await engine.executeRaw<{ compiled_truth: string | null; timeline: string | null }>('SELECT compiled_truth, timeline FROM pages WHERE id=$1', [pageId]);
  return { truth: row?.compiled_truth ?? '', timeline: row?.timeline ?? '' };
}

/** get_page body:'none' for an inline page: the digest of its last non-empty region's tail, as tailDigest reports a segmented page's. */
export async function inlineTailDigest(engine: Pick<BrainEngine, 'executeRaw'>, pageId: number, remote: boolean): Promise<{ tail_sha256: string; tail_region: string } | Record<string, never>> {
  const { truth, timeline } = await inlineRegions(engine, pageId);
  const tail = timeline ? inlineRegionTail(timeline, 'timeline') : inlineRegionTail(truth, 'truth');
  return remote && tail.guarded ? {} : { tail_sha256: tailSha256(tail), tail_region: tail.region };
}
