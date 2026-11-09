/**
 * Facts and takes fences of a streamed import (streamed-import.ts), one fence region at a time (GBRA-95). A body over
 * the single-string ceiling is never one string, so the import cannot normalize its fences or check them against
 * withdrawals over the whole body as `importFromContent` does. Instead each stored region's byte stream passes through
 * `rewrite`: the protected-region scan the segmenter stores (`protectedRegionScan`, region-scan.ts: the same markers,
 * pairing, `read` rule and truncated tail as `protectedRegions`) finds each facts or takes region; the bytes between
 * regions pass through unchanged, and each region is held whole, up to FENCE_MAX_BYTES, and replaced by its rewrite:
 *
 * 1. Tier 1 (`settleFenceRegion`) on a reader-visible region: a body region alone, a timeline region with the body's
 *    reader-visible regions as its page's body, so a row number the two sections share is renumbered as
 *    `importFromContent` renumbers it;
 * 2. the purge and withdrawal overlay (`preserveWithdrawnFenceRows`: purged rows dropped, withdrawn rows struck), the
 *    transform forget and purge apply to a segmented page's stored regions (segment-rewrite.ts), under the page's slug
 *    and, for a rename, its old slug too (the publication moves that subject's rows to the new slug);
 * 3. the malformed-fence check (`assertFenceRegionWithdrawals`).
 *
 * Tier 1 rules that rewrite more than one region need the whole section, which a streamed import never holds, so the
 * import holds the file instead (`FenceNeedsWholeSection`): marker text between regions, a second reader-visible fence
 * of one kind in a section (`merge_fences`), and a timeline step that would rewrite the stored body regions. A region
 * over the bound, or an unclosed fence's tail over it, throws `FenceRegionTooLarge` once the bytes read past its start
 * exceed the bound; a coordinated import's residual fence throws `FenceRegionRefused`. The import turns each into its
 * result. A remote writer's takes region refuses `permission_denied` (`preserveProtectedTakes`'s rule; the stored page
 * holds no takes fence, `assertNoHiddenFenceRows`). Rewritten table rows start with `|`, so a rewrite never adds or
 * removes a code-fence line and the pass-1 fence trust stands (segment-rewrite.ts keeps the page's flags on the same
 * grounds).
 *
 * The overlay reads the withdrawal and purge ledgers while the body is staged; `revalidate` runs in the publication
 * transaction (the prepared import's `validate`, before a rename moves the ledger rows, and the direct import's
 * transaction) and refuses `revision_conflict`, as
 * `assertPreparedFactWithdrawals` does for an inline import, when the source's ledgers changed since the first region
 * was rewritten (a forget or purge that committed meanwhile could not see the bytes still in flight).
 *
 * Memory: one region at a time, plus the body's settled reader-visible regions (at most one facts and one takes fence)
 * while the timeline streams.
 */
import type { BrainEngine } from '../engine.ts';
import type { ContentRefusal } from '../import-screen.ts';
import type { FenceIssueWire } from '../fence-repair/tier1.ts';
import type { FenceCtx, FenceFix } from '../fence-repair/types.ts';
import { settleFenceRegion } from '../fence-repair/import-step.ts';
import { assertFenceRegionWithdrawals, preserveWithdrawnFenceRows } from '../facts/withdrawal.ts';
import { parseFactsFence } from '../facts-fence.ts';
import { TAKES_FENCE_BEGIN } from '../takes-fence.ts';
import { protectedRegions } from '../fence-scan.ts';
import { PROTECTED_PAIRS } from '../remote-body.ts';
import { takesFenceMutationError } from '../persistence/protected-takes.ts';
import { initialRegionScan, protectedRegionScan, utf8Len, type RegionScanState } from './region-scan.ts';
import { FENCE_MAX_BYTES } from './limits.ts';
import type { BodyRegion } from './types.ts';
import { readLiveSegmentedFences } from './segment-rewrite.ts';
import { inlineRegions } from './tail-digest.ts';
import { OperationError, opError } from '../ops/contract.ts';
import type { Page } from '../types.ts';
import { bodyUnread, fenceBody } from './page-shape.ts';
import { PAGE_MAX_BYTES } from '../page-size-policy.ts';

/** A fence region (or an unclosed fence's tail) longer than FENCE_MAX_BYTES: `bytes` is how much of it was read. */
export class FenceRegionTooLarge extends Error {
  constructor(readonly region: BodyRegion, readonly bytes: number) {
    super(`a fence in the ${region === 'truth' ? 'body' : 'timeline'} is at least ${bytes} bytes, over the ${FENCE_MAX_BYTES}-byte bound one fence is normalized and checked against withdrawals within`);
  }
}

/** A Tier 1 rule that rewrites more than one region of a section (`why`), so the import holds the file. */
export class FenceNeedsWholeSection extends Error {
  constructor(readonly region: BodyRegion, why: string) {
    super(`the ${region === 'truth' ? 'body' : 'timeline'} ${why}, which Tier 1 normalizes over the whole page`);
  }
}

/** A coordinated import's residual fence: the refusal `importFromContent` returns for the same fence. */
export class FenceRegionRefused extends Error {
  constructor(readonly refusal: ContentRefusal) { super(refusal.message); }
}

/** A closed facts region a remote read renders with rows left out: a non-world row, or a fence that does not parse (rendered empty). */
const hidesRows = (fence: string) => { const parsed = parseFactsFence(fence); return parsed.warnings.length > 0 || parsed.facts.some(fact => fact.visibility !== 'world'); };

/**
 * What remote reads hide in `text` (`sanitizeRemoteBody`'s regions, each judged on its own): a takes region, a facts
 * region that hides rows, or an unclosed fence's truncated tail.
 */
function hiddenIn(text: string): 'takes' | 'facts' | null {
  const { regions, truncatedAt } = protectedRegions(text, PROTECTED_PAIRS);
  if (regions.some(region => region.pair === 1)) return 'takes';
  return truncatedAt !== -1 || regions.some(region => region.pair === 0 && hidesRows(text.slice(region.start, region.end))) ? 'facts' : null;
}
const FOUND = Symbol('hidden fence row');

/**
 * What a remote read of the page's live body hides (remote-body.ts `sanitizeRemoteBody`), which a remote write must carry
 * over (`preserveProtectedTakes`, `mergeHiddenFactRowsIntoBody`): every takes region, every facts region with a
 * non-world row or that does not parse, and an unclosed fence's tail, in reader-visible and quoted regions alike. Null
 * when it hides nothing. A segmented body is read only where it holds a fence region (`readLiveSegmentedFences`).
 */
export async function hiddenFenceContent(engine: BrainEngine, pageId: number): Promise<'takes' | 'facts' | null> {
  const [page] = await engine.executeRaw<{ body_storage: string }>('SELECT body_storage FROM pages WHERE id=$1', [pageId]);
  if (!page) return null;
  if (page.body_storage !== 'segmented') {
    const found = Object.values(await inlineRegions(engine, pageId)).map(hiddenIn);
    return found.includes('takes') ? 'takes' : found.includes('facts') ? 'facts' : null;
  }
  const [found] = await engine.executeRaw<{ takes: boolean; tail: boolean }>(`SELECT
      bool_or(m.protected_regions @> '[{"kind":"takes"}]'::jsonb) AS takes, bool_or(m.protected_regions @> '[{"kind":"tail"}]'::jsonb) AS tail
    FROM page_body_manifest m JOIN pages p ON p.id = m.page_id
    WHERE m.page_id = $1 AND m.staging_id IS NULL AND m.gen_from <= p.body_generation AND (m.gen_to IS NULL OR m.gen_to > p.body_generation)`, [pageId]);
  if (found?.takes) return 'takes';
  if (found?.tail) return 'facts';
  try {
    // A visited unit joins regions whose bytes touch (two fences back to back, a fence across forced cuts), so each is rescanned.
    await readLiveSegmentedFences(engine, pageId, fence => { if (hiddenIn(fence)) throw FOUND; });
  } catch (error) {
    if (error === FOUND) return 'facts';
    throw error;
  }
  return null;
}

/**
 * A remote write that cannot carry over what remote reads hide on the stored page (`hiddenFenceContent`) refuses
 * `page_body_segmented`: a remote write over a segmented body over the single-string ceiling (`bodyUnread`, which
 * `fenceBody` reads as empty), and a remote managed sync of a file over it (streamed, so its body is never one string).
 */
export async function assertNoHiddenFenceRows(engine: BrainEngine, page: { id: number; slug: string; source_id: string }): Promise<void> {
  const hidden = await hiddenFenceContent(engine, page.id);
  if (!hidden) return;
  throw opError('page_body_segmented', `Page ${page.slug} (source ${page.source_id}) holds ${hidden === 'takes' ? 'a takes fence' : 'facts rows'} that remote reads hide, and a remote write cannot carry them over when the stored or the written body is over ${PAGE_MAX_BYTES} bytes, so nothing was written.`,
    'Ask the user to write this page locally on the brain host, where the hidden rows are kept.');
}

/** `fenceBody` of the stored page a remote write merges into, after `assertNoHiddenFenceRows` when its body was not read back. */
export async function remoteFenceBody(engine: BrainEngine, page: Page): Promise<{ compiled_truth: string; timeline: string }> {
  if (!page.deleted_at && bodyUnread(page)) await assertNoHiddenFenceRows(engine, { id: Number(page.id), slug: page.slug, source_id: page.source_id });
  return fenceBody(page);
}

/** The source's withdrawal and purge ledgers, as a value that changes whenever a row is added, moved or removed. */
async function ledgerGeneration(engine: BrainEngine, sourceId: string): Promise<string> {
  const [row] = await engine.executeRaw<{ generation: string }>(`SELECT concat_ws('/',
      (SELECT count(*) || ':' || COALESCE(sum(hashtext(w::text)), 0) FROM fact_withdrawals w WHERE w.source_id = $1),
      (SELECT count(*) || ':' || COALESCE(sum(hashtext(p::text)), 0) FROM fact_purges p WHERE p.source_id = $1),
      (SELECT count(*) || ':' || COALESCE(sum(hashtext(t::text)), 0) FROM take_purges t WHERE t.source_id = $1)) AS generation`, [sourceId]);
  return row!.generation;
}

/** @internal For the bound tests: the most bytes the queue held past a region's start, and the regions rewritten. */
export const streamedFenceWork = { held: 0, regions: 0 };

const NEWLINE = 0x0a;
const MARKER_TEXT = /gbrain:(facts|takes):/;
const MARKER_CARRY = 'gbrain:takes:'.length - 1;
const TAKES_PAIR = 1;

/** One stored region's bytes from `head` to `end`, taken in order. */
class ByteQueue {
  private parts: Uint8Array[] = [];
  head = 0;
  end = 0;

  push(bytes: Uint8Array): void {
    this.parts.push(bytes);
    this.end += bytes.length;
  }

  /** Bytes `[head, to)`, removed from the queue. */
  take(to: number): Uint8Array[] {
    const out: Uint8Array[] = [];
    while (this.head < to) {
      const part = this.parts[0]!;
      const n = Math.min(part.length, to - this.head);
      out.push(part.subarray(0, n));
      if (n === part.length) this.parts.shift(); else this.parts[0] = part.subarray(n);
      this.head += n;
    }
    return out;
  }
}

function newlines(parts: readonly Uint8Array[]): number {
  let n = 0;
  for (const part of parts) for (let at = part.indexOf(NEWLINE); at !== -1; at = part.indexOf(NEWLINE, at + 1)) n++;
  return n;
}

export interface StreamedFences {
  /** `stream` (one stored region, valid UTF-8) with each facts and takes region rewritten; the body before the timeline. */
  rewrite(stream: AsyncIterable<Uint8Array>, region: BodyRegion, trusted: boolean): AsyncIterable<Uint8Array>;
  /** The Tier 1 fixes and lenient warnings, for the import's result (`fences_normalized`, `fence_issues`). */
  fields(): { fences_normalized?: FenceFix[]; fence_issues?: FenceIssueWire[] };
  /** In the publication transaction: refuses `revision_conflict` when the source's withdrawal or purge ledgers moved since the first region was rewritten. */
  revalidate(tx: BrainEngine): Promise<void>;
}

export function streamedFences(engine: BrainEngine, input: { sourceId: string; slug: string; pageId: number | null; mode: 'coordinated' | 'lenient'; ctx: FenceCtx; remote: boolean;
  /** A managed sync rename: the old slug, whose subject-scoped withdrawals and purges the publication moves to `slug`. */
  renamedFrom?: string }): StreamedFences {
  const fixes: FenceFix[] = [];
  const warnings: FenceIssueWire[] = [];
  const visible = { truth: new Set<number>(), timeline: new Set<number>() };
  const body: string[] = [];
  let generation: Promise<string> | null = null;

  /** `at.pair` is the region's PROTECTED_PAIRS index, or -1 for an unclosed fence's tail (read from its begin marker). */
  async function transform(text: string, region: BodyRegion, at: { pair: number; read: boolean; lineOffset: number }): Promise<string> {
    const pair = at.pair !== -1 ? at.pair : text.startsWith(TAKES_FENCE_BEGIN) ? TAKES_PAIR : 0;
    if (input.remote && (pair === TAKES_PAIR || text.includes(TAKES_FENCE_BEGIN))) throw takesFenceMutationError();
    const section = region === 'truth' ? 'body' : 'timeline';
    streamedFenceWork.regions++;
    generation ??= ledgerGeneration(engine, input.sourceId);
    await generation;
    let fence = text;
    if (at.read) {
      if (visible[region].has(pair)) throw new FenceNeedsWholeSection(region, `holds more than one ${pair === TAKES_PAIR ? 'takes' : 'facts'} fence`);
      visible[region].add(pair);
      const settled = await settleFenceRegion(engine, { ...input, section, text, lineOffset: at.lineOffset, ...(region === 'timeline' ? { body: body.join('\n\n') } : {}) });
      if (settled.bodyChanged) throw new FenceNeedsWholeSection(region, 'shares fence row numbers with the body that only renumbering the body resolves');
      if (settled.refusal) throw new FenceRegionRefused(settled.refusal);
      fixes.push(...settled.fixes);
      warnings.push(...settled.warnings);
      fence = settled.text;
      if (region === 'truth') body.push(fence);
    }
    const subjects = input.renamedFrom ? [input.slug, input.renamedFrom] : [input.slug];
    for (const subject of subjects) fence = await preserveWithdrawnFenceRows(engine, input.sourceId, fence, subject);
    for (const subject of subjects) await assertFenceRegionWithdrawals(engine, input.sourceId, fence, section, subject);
    return fence;
  }

  async function* rewrite(stream: AsyncIterable<Uint8Array>, region: BodyRegion, trusted: boolean): AsyncIterable<Uint8Array> {
    const queue = new ByteQueue();
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let state: RegionScanState = initialRegionScan(trusted);
    let lines = 0;
    let carry = '';
    const pass = (to: number) => {
      const parts = queue.take(to);
      lines += newlines(parts);
      for (const part of parts) {
        const text = carry + Buffer.from(part).toString('latin1');
        if (MARKER_TEXT.test(text)) throw new FenceNeedsWholeSection(region, 'has facts or takes marker text outside a closed fence');
        carry = text.slice(-MARKER_CARRY);
      }
      return parts;
    };
    const bound = (start: number) => {
      streamedFenceWork.held = Math.max(streamedFenceWork.held, queue.end - start);
      if (queue.end - start > FENCE_MAX_BYTES) throw new FenceRegionTooLarge(region, queue.end - start);
    };
    async function* fence(start: number, end: number, pair: number, read: boolean): AsyncIterable<Uint8Array> {
      yield* pass(start);
      const parts = queue.take(end);
      carry = '';
      const lineOffset = lines;
      lines += newlines(parts);
      yield Buffer.from(await transform(Buffer.concat(parts).toString('utf8'), region, { pair, read, lineOffset }), 'utf8');
    }
    async function* scanned(chunk: string, final: boolean): AsyncIterable<Uint8Array> {
      const out = protectedRegionScan(state, chunk, final);
      state = out.state;
      for (const r of out.regions) {
        streamedFenceWork.held = Math.max(streamedFenceWork.held, r.end - r.start);
        if (r.end - r.start > FENCE_MAX_BYTES) throw new FenceRegionTooLarge(region, r.end - r.start);
        yield* fence(r.start, r.end, r.pair, r.read);
      }
      const open = state.track.open?.start ?? state.track.truncatedAt;
      if (open !== null) {
        bound(open);
        yield* pass(open);
        return;
      }
      yield* pass(state.split.pos - (state.track.long ? utf8Len(state.track.long.carry) : 0));
    }
    for await (const bytes of stream) {
      queue.push(bytes);
      yield* scanned(decoder.decode(bytes, { stream: true }), false);
    }
    yield* scanned(decoder.decode(), true);
    if (state.track.truncatedAt !== null) yield* fence(state.track.truncatedAt, queue.end, -1, true);
    yield* pass(queue.end);
  }

  return {
    rewrite,
    fields: () => ({ ...(fixes.length ? { fences_normalized: fixes } : {}), ...(warnings.length ? { fence_issues: warnings } : {}) }),
    async revalidate(tx) {
      if (!generation || await generation === await ledgerGeneration(tx, input.sourceId)) return;
      throw new OperationError('revision_conflict', 'A fact withdrawal changed during import preparation. Retry the import.',
        'Read the current page revision, then submit the updated import with a new request_id.');
    },
  };
}
