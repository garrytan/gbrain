/**
 * `content_hash` as a resumable stream (Wave B, spec 1.4). `contentHash`
 * (utils.ts) is sha256 over
 *
 *   JSON.stringify({title, type, compiled_truth, timeline || '', frontmatter*, tags*})
 *
 * This module feeds the same bytes piece by piece:
 *
 *   '{"title":' J(title) ',"type":' J(type) ',"compiled_truth":"' E(truth 1) E(truth 2) ...
 *   '","timeline":"' E(timeline 1) ... '","frontmatter":' J(frontmatter*) ',"tags":' J(tags*) '}'
 *
 * with J = JSON.stringify and E(s) = JSON.stringify(s).slice(1, -1). E is exact
 * for any split on a code-point boundary (segments always end on one), so the
 * digest depends only on the logical page, never on where segments were cut.
 *
 * A manifest row stores `exportState()` after its own E(...) bytes
 * (`hash_state`). Resume rules:
 * - append to the last region: resume from the last row's state, push the appended text;
 * - append to the truth while the timeline is non-empty: resume from the last truth row,
 *   push the appended truth, then re-push every timeline row;
 * - frontmatter or tags change: resume from the last row and `finish` with the new values;
 * - title or type change: the prefix changed, start over with `begin`.
 */
import type { PageInput } from '../types.ts';
import { contentHashFrontmatterAndTags } from '../utils.ts';
import { ResumableSha256 } from './sha256-resumable.ts';

type Phase = 'truth' | 'timeline';
const PHASE_BYTE: Record<Phase, number> = { truth: 0, timeline: 1 };

/** Largest `ContentHashStream.exportState()` result in bytes (phase byte plus SHA-256 midstate). */
export const CONTENT_HASH_STATE_MAX_BYTES = 104;

/** Envelope member text: `"name":` + J(value), or '' when JSON.stringify omits the member. */
function member(name: string, value: unknown): string {
  const json = JSON.stringify(value);
  return json === undefined ? '' : `"${name}":${json}`;
}

export class ContentHashStream {
  private constructor(private readonly sha: ResumableSha256, private phase: Phase) {}

  /** Start a page: feeds the envelope through the opening quote of `compiled_truth`. */
  static begin(page: { title: unknown; type: unknown }): ContentHashStream {
    const stream = new ContentHashStream(new ResumableSha256(), 'truth');
    const head = [member('title', page.title), member('type', page.type)].filter(Boolean);
    head.push('"compiled_truth":"');
    stream.feed(`{${head.join(',')}`);
    return stream;
  }

  static fromState(state: Uint8Array): ContentHashStream {
    const phase = state[0] === PHASE_BYTE.timeline ? 'timeline' : state[0] === PHASE_BYTE.truth ? 'truth' : null;
    if (!phase) throw new Error(`content hash state has an unknown phase byte ${state[0]}`);
    return new ContentHashStream(ResumableSha256.fromState(state.subarray(1)), phase);
  }

  /** Append compiled_truth text (a whole number of code points). */
  pushTruth(text: string): this {
    if (this.phase !== 'truth') throw new Error('content hash stream: truth text after the timeline began');
    this.feed(JSON.stringify(text).slice(1, -1));
    return this;
  }

  /** Close compiled_truth and open the timeline string. Idempotent. */
  beginTimeline(): this {
    if (this.phase === 'truth') {
      this.feed('","timeline":"');
      this.phase = 'timeline';
    }
    return this;
  }

  /** Append timeline text (a whole number of code points); opens the timeline first if needed. */
  pushTimeline(text: string): this {
    this.beginTimeline();
    this.feed(JSON.stringify(text).slice(1, -1));
    return this;
  }

  /** The midstate after everything pushed so far (at most CONTENT_HASH_STATE_MAX_BYTES). */
  exportState(): Uint8Array {
    const sha = this.sha.exportState();
    const out = new Uint8Array(1 + sha.length);
    out[0] = PHASE_BYTE[this.phase];
    out.set(sha, 1);
    return out;
  }

  /** Hex content_hash with this frontmatter and tags. The stream itself is left unchanged. */
  finish(meta: Pick<PageInput, 'frontmatter' | 'tags'>): string {
    const tail = ContentHashStream.fromState(this.exportState()).beginTimeline();
    const { frontmatter, tags } = contentHashFrontmatterAndTags(meta);
    tail.feed(`",${member('frontmatter', frontmatter)},${member('tags', tags)}}`);
    return tail.sha.digest();
  }

  private feed(text: string): void {
    this.sha.update(Buffer.from(text, 'utf8'));
  }
}

/** `contentHash(page)` computed through the stream, one push per region (tests and small callers). */
export function streamingContentHash(page: PageInput): string {
  return ContentHashStream.begin(page).pushTruth(page.compiled_truth).pushTimeline(page.timeline || '').finish(page);
}
