/**
 * Windowed secret scan of a byte stream too large to hold as one string: the
 * pre-push gate's staged blobs over PUSH_MAX_SCAN_BYTES (workspace-push.ts).
 *
 * The bytes are decoded with a streaming UTF-8 decoder (a character split
 * across chunks is joined, an invalid sequence becomes U+FFFD as
 * `Buffer.toString('utf-8')` makes it, a BOM is kept) and scanned by
 * `scanTextSpans` in windows of at most STREAM_SCAN_WINDOW_CHARS UTF-16
 * units. Each next window starts at a line start at least
 * STREAM_SCAN_OVERLAP_CHARS before the previous window's end; a line too long
 * for that is split mid-line at exactly the overlap (never inside a surrogate
 * pair). The overlap is longer than any claim of the push gate's patterns: a
 * private key (PEM_BODY_MAX_CHARS 16384 of body plus fences, RFC 1421 header
 * lines and indentation, under 18 Ki) and the bounded line values (jwt
 * 3 x 4096 + 2, basic_auth 2048, URL userinfo 384, assignment values 4096).
 *
 * OWNERSHIP. A claim belongs to the window holding the start of the match that
 * made it, anchor included (`from`: the `Bearer ` or `Authorization: Basic `
 * keyword, an assignment key, or the boundary character before a value), not
 * to the window holding the value's first character: a mid-line cut between
 * an anchor and its value leaves the next window a value with no anchor, which
 * no pattern claims. A window keeps a claim whose match starts before the next
 * window's start (the whole match lies inside this window, since it is shorter
 * than the overlap); the next window sees every match that starts at or after
 * its start. The last window keeps everything. A match longer than the overlap
 * (an anchor whose whitespace run before the token is that long) is the
 * accepted miss. A claim lying wholly inside a span kept by
 * an earlier window is the seam's partial view of it (the body of a key cut at
 * the window start, a suffix of a split line) and is dropped, which also drops
 * an exact duplicate (same offset and pattern). Line numbers are 1-based over
 * the whole stream. What a seam can add is a finding the whole-text scan would
 * not make (a cut read as a boundary): that blocks the push, never leaks.
 * An unbounded vendor value longer than the overlap is still reported, cut
 * at the window end.
 */
import { scanTextSpans, type ScanOpts, type SecretFinding } from './secret-scan.ts';

/** Largest text window one scan holds (UTF-16 units). */
export const STREAM_SCAN_WINDOW_CHARS = 8 * 1024 ** 2;

/** Text every window repeats from the end of the one before it (see the header). */
export const STREAM_SCAN_OVERLAP_CHARS = 64 * 1024;

/**
 * @internal Work counters (test/helpers/work-counts.ts): windows scanned,
 * bytes read from the stream, text units scanned (overlap included) and the
 * largest window, so a test pins boundedness without timing.
 */
export const streamScanWork = { windows: 0, bytes: 0, chars: 0, largestWindow: 0 };

/**
 * Scan `chunks` as one UTF-8 text; the findings `scanText` would report on
 * the whole text, plus any a seam adds (header). `windowChars` is a test
 * seam; it must be at least twice the overlap.
 */
export async function scanTextStream(
  chunks: AsyncIterable<Uint8Array>, opts: ScanOpts = {}, windowChars = STREAM_SCAN_WINDOW_CHARS,
): Promise<SecretFinding[]> {
  if (windowChars < 2 * STREAM_SCAN_OVERLAP_CHARS) throw new RangeError(`a scan window must be at least ${2 * STREAM_SCAN_OVERLAP_CHARS} chars`);
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const findings: SecretFinding[] = [];
  let carried: Array<{ start: number; end: number }> = [];
  let pending = '';
  let base = 0;
  let baseLine = 1;
  const drain = (final: boolean): void => {
    while (pending.length >= windowChars || (final && pending.length > 0)) {
      const last = final && pending.length <= windowChars;
      const text = last ? pending : pending.slice(0, windowChars);
      let next = text.length;
      if (!last) {
        const preferred = text.length - STREAM_SCAN_OVERLAP_CHARS;
        const lineStart = text.lastIndexOf('\n', preferred - 1) + 1;
        next = lineStart > preferred / 2 ? lineStart : preferred - ((text.charCodeAt(preferred) & 0xfc00) === 0xdc00 ? 1 : 0);
      }
      streamScanWork.windows++;
      streamScanWork.chars += text.length;
      if (text.length > streamScanWork.largestWindow) streamScanWork.largestWindow = text.length;
      const kept: Array<{ start: number; end: number }> = [];
      for (const claim of scanTextSpans(text, opts)) {
        if (claim.from >= next) continue;
        const start = base + claim.start;
        const end = base + claim.end;
        if (carried.some((c) => c.start <= start && end <= c.end)) continue;
        kept.push({ start, end });
        if (claim.finding) findings.push({ ...claim.finding, line: baseLine + claim.finding.line - 1 });
      }
      if (last) {
        pending = '';
        return;
      }
      for (let i = text.indexOf('\n'); i !== -1 && i < next; i = text.indexOf('\n', i + 1)) baseLine++;
      base += next;
      carried = [...carried, ...kept].filter((c) => c.end > base);
      pending = pending.slice(next);
    }
  };
  for await (const chunk of chunks) {
    streamScanWork.bytes += chunk.length;
    pending += decoder.decode(chunk, { stream: true });
    drain(false);
  }
  pending += decoder.decode();
  drain(true);
  return findings;
}
