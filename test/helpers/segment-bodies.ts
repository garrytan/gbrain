/**
 * Page bodies and helpers for the segmented-storage tests (test/large-pages/):
 * seeded generators of marker / fence / key soup and of multi-MiB pages, a
 * whole-page segmentation call, and the per-segment projection joined back
 * into one text for parity with credentialSafeProjection(sanitizeRemoteBody()).
 */
import { renderFactsRegion } from '../../src/core/remote-body.ts';
import { initialEntryState, type EntryState } from '../../src/core/page-body/entry-state.ts';
import { Segmenter, segmentProjectionParts, type SegmentOptions, type SegmentOut } from '../../src/core/page-body/segmenter.ts';

export const FACTS_BLOCK = '<!--- gbrain:facts:begin -->\n'
  + '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n'
  + '|---|---|---|---|---|---|---|---|---|---|\n'
  + '| 1 | likes tea | preference | 0.9 | world | low | 2024-01-01 | | user | |\n'
  + '| 2 | private thing | fact | 0.9 | private | low | 2024-01-01 | | user | |\n'
  + '<!--- gbrain:facts:end -->\n';
const B64_SAMPLE = 'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu';
/** Synthetic key text; the fence lines are assembled at runtime so no source line reads as a private key to secret scanners. */
export const KEY_BODY = B64_SAMPLE;
const PRIVATE_KEY_TAIL = ['PRIVATE', 'KEY-----'].join(' ');
export const PEM_BEGIN_RSA = `-----BEGIN RSA ${PRIVATE_KEY_TAIL}`;
export const PEM_END_RSA = `-----END RSA ${PRIVATE_KEY_TAIL}`;
export const PEM_BEGIN_PKCS8 = `-----BEGIN ${PRIVATE_KEY_TAIL}`;
export const PEM_BLOCK = `${PEM_BEGIN_RSA}\n${KEY_BODY}\n${PEM_END_RSA}\n`;
export const MARKER_BULLET = '<!-- gbrain:materialized v1 0123456789ab -->\n- **2024-01-02** | src — did a thing\n  detail line\n';

export const SOUP_ATOMS = [
  '<!--- gbrain:facts:begin -->', '<!--- gbrain:facts:end -->', '<!--- gbrain:takes:begin -->', '<!--- gbrain:takes:end -->',
  '```', '~~~', '````', '```js', '`', '\n', '\n', '\n\n', '\r\n', '\r', ' ', 'text words here', 'é', '😀', '\u2028',
  '## Heading 2024-03-05\n', '# Top\n', '### deep\n', `${PEM_BEGIN_RSA}\n`, `${KEY_BODY}\n`,
  `${PEM_END_RSA}\n`, MARKER_BULLET, '- **2024-01-02** | src — entry\n', '  detail line\n', FACTS_BLOCK,
];

export function pick<T>(r: () => number, a: readonly T[]): T {
  return a[Math.floor(r() * a.length)]!;
}

/** A short body of random atoms (one segment). */
export function soup(r: () => number, atoms: readonly string[] = SOUP_ATOMS, max = 60): string {
  let body = '';
  const n = 1 + Math.floor(r() * max);
  for (let i = 0; i < n; i++) body += pick(r, atoms);
  return body;
}

const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'é', '😀', 'acme-example', 'notes', 'meeting', 'value', '2024-06-07'];

export function paragraph(r: () => number): string {
  let s = '';
  const n = 20 + Math.floor(r() * 300);
  for (let i = 0; i < n; i++) s += pick(r, WORDS) + (r() < 0.08 ? '\n' : ' ');
  return `${s}\n`;
}

/**
 * A page of about `target` chars: paragraphs, headings, day headers, small
 * fences, facts and takes blocks, keys, timeline entries and markers, all
 * closed, so structural cuts happen. `crlf` writes `\r\n` line ends.
 */
export function bigPage(r: () => number, target: number, opts: { crlf?: boolean; keys?: boolean; facts?: boolean } = {}): string {
  const parts: string[] = [];
  let len = 0;
  while (len < target) {
    const x = r();
    let p: string;
    if (x < 0.5) p = `${paragraph(r)}\n`;
    else if (x < 0.6) p = `${pick(r, ['# Top', '## Section', '### deep', '## 2024-05-06', '#### deeper'])}\n`;
    else if (x < 0.65) p = `\`\`\`ts\nconst a${Math.floor(r() * 1000)} = 1;\nfunction f() { return a; }\n\`\`\`\n`;
    else if (x < 0.68) p = opts.facts === false ? paragraph(r) : FACTS_BLOCK;
    else if (x < 0.7) p = `<!--- gbrain:takes:begin -->\n${paragraph(r)}<!--- gbrain:takes:end -->\n`;
    else if (x < 0.72) p = opts.keys === false ? paragraph(r) : PEM_BLOCK;
    else if (x < 0.75) p = MARKER_BULLET;
    else if (x < 0.8) p = '- **2024-02-03** | src — entry\n  more detail\n';
    else p = paragraph(r);
    if (opts.crlf) p = p.replace(/\n/g, '\r\n');
    parts.push(p);
    len += p.length;
  }
  return parts.join('');
}

export function segmentOptions(fenceTrust: 'trusted' | 'void', over: Partial<SegmentOptions> = {}): SegmentOptions {
  return { byteStart: 0, lineStart: 0, fenceTrust, end: 'eof', ...over };
}

/** Segment `body` fed in pieces of `piece()` chars (never splitting a surrogate pair). */
export function segmentPieces(body: string, opts: SegmentOptions, piece: () => number = () => body.length || 1,
  entry: EntryState = initialEntryState({ region: 'truth' })): SegmentOut[] {
  const seg = new Segmenter(entry, opts);
  const out: SegmentOut[] = [];
  for (let i = 0; i < body.length;) {
    let k = Math.max(1, piece());
    const c = body.charCodeAt(i + k - 1);
    if (c >= 0xd800 && c <= 0xdbff) k++;
    out.push(...seg.push(body.slice(i, i + k)));
    i += k;
  }
  out.push(...seg.finish());
  return out;
}

/** The segments' projections joined, each facts region rendered once in the segment where it starts. */
export function joinedProjection(body: Buffer, segs: readonly SegmentOut[], renderFacts = true): string {
  let out = '';
  for (const s of segs) {
    const raw = Buffer.from(s.bytes).toString('utf8');
    for (const p of segmentProjectionParts(raw, s.protectedRegions, s.byteStart)) {
      if (p.kind === 'text' || p.kind === 'pem') out += p.text;
      else if (p.kind === 'facts' && renderFacts) {
        const r = p.region!;
        const start = r.open_start ?? s.byteStart + r.start;
        const end = r.open_start !== undefined ? r.open_end : s.byteStart + r.end;
        if (start === s.byteStart + r.start && end !== undefined) out += renderFactsRegion(body.subarray(start, end).toString('utf8'));
      }
    }
  }
  return out;
}

/** Concatenated segment bytes equal the input, offsets chain, every segment is 1..max bytes of valid UTF-8. */
export function segmentShapeErrors(body: Buffer, segs: readonly SegmentOut[], max: number, byteStart = 0): string[] {
  const errors: string[] = [];
  if (!Buffer.concat(segs.map(s => s.bytes)).equals(body)) errors.push('concatenation differs from input');
  let at = byteStart;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const [i, s] of segs.entries()) {
    if (s.byteStart !== at) errors.push(`segment ${i} starts at ${s.byteStart}, expected ${at}`);
    if (s.bytes.length === 0 || s.bytes.length > max) errors.push(`segment ${i} has ${s.bytes.length} bytes`);
    try { decoder.decode(s.bytes); } catch { errors.push(`segment ${i} is not valid UTF-8`); }
    at += s.bytes.length;
  }
  return errors;
}
