/**
 * Wave B upload sessions, client side (spec 6.2 part sizing): the part cutter
 * measures the whole upload_page_part request frame, escapes included, and
 * never splits a surrogate pair; the upload driver resumes from
 * get_page_upload after a dropped reply and reassembles the body exactly.
 * Pure: no engine, no network.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cutUploadPart, stringUploadBody, toolCallFrameBytes, uploadPageBody, type UploadToolCall } from '../src/core/mcp-client.ts';
import { RemoteMcpError } from '../src/core/remote-mcp-error.ts';
import { opError } from '../src/core/ops/contract.ts';

const FRAME = { upload_id: '0f8fad5b-d9cb-469f-a165-70867728950e', part: 7 };
const SHA_STAND_IN = 'f'.repeat(64);
const frameOf = (text: string) => toolCallFrameBytes('upload_page_part', { ...FRAME, text, part_sha256: SHA_STAND_IN });
const isHigh = (u: number) => u >= 0xd800 && u <= 0xdbff;
const isLow = (u: number) => u >= 0xdc00 && u <= 0xdfff;
const splitsPair = (text: string, i: number) => i > 0 && i < text.length && isHigh(text.charCodeAt(i - 1)) && isLow(text.charCodeAt(i));
const nextBoundary = (text: string, i: number) => (isHigh(text.charCodeAt(i)) && isLow(text.charCodeAt(i + 1)) ? i + 2 : i + 1);

/** Quotes, backslashes, control characters (6-byte escapes), multi-byte BMP text, emoji and other astral characters. */
const ESCAPE_HEAVY = [
  '"quoted" \\back\\slashes\\ ', '\u0000\u0001\u0007\u001f', '\n\r\t\b\f', 'plain ascii text ', 'é ü ß 中文 ',
  '😀', '🧠👩‍💻', '\u{1F600}\u{10FFFF}\u{1D11E}', '\u2028\u2029', '</script>',
].join('');

function escapeHeavy(units: number): string {
  let out = '';
  for (let i = 0; out.length < units; i++) out += ESCAPE_HEAVY + String(i);
  return out;
}

describe('cutUploadPart', () => {
  test('measures the full request frame: escapes cost 6 or 2 bytes, astral characters 4', () => {
    const base = frameOf('');
    expect(frameOf('a') - base).toBe(1);
    expect(frameOf('"') - base).toBe(2);
    expect(frameOf('\\') - base).toBe(2);
    expect(frameOf('\n') - base).toBe(2);
    expect(frameOf('\u0001') - base).toBe(6);
    expect(frameOf('😀') - base).toBe(4);
  });

  test('the cut is the longest code-point prefix that fits, for every cap across escape-heavy text', () => {
    const text = escapeHeavy(4000);
    const base = frameOf('');
    for (let max = base + 6; max < base + 3000; max += 7) {
      const end = cutUploadPart(text, FRAME, max);
      expect(end).toBeGreaterThan(0);
      expect(splitsPair(text, end)).toBe(false);
      expect(frameOf(text.slice(0, end))).toBeLessThanOrEqual(max);
      if (end < text.length) expect(frameOf(text.slice(0, nextBoundary(text, end)))).toBeGreaterThan(max);
    }
  });

  test('a cap that lands inside an astral character cuts before it, never between its surrogates', () => {
    const text = 'x'.repeat(10) + '😀' + 'y';
    const base = frameOf('');
    for (const extra of [11, 12, 13]) expect(cutUploadPart(text, FRAME, base + extra)).toBe(10);
    expect(cutUploadPart(text, FRAME, base + 14)).toBe(12);
    const pairs = '😀'.repeat(50);
    for (let max = base + 4; max < base + 200; max++) expect(cutUploadPart(pairs, FRAME, max) % 2).toBe(0);
  });

  test('successive cuts reassemble the exact text and bytes, every part within the frame', () => {
    const text = escapeHeavy(50_000);
    const max = frameOf('') + 4096;
    const parts: string[] = [];
    for (let rest = text; rest.length > 0;) {
      const end = cutUploadPart(rest, FRAME, max);
      expect(frameOf(rest.slice(0, end))).toBeLessThanOrEqual(max);
      parts.push(rest.slice(0, end));
      rest = rest.slice(end);
    }
    expect(parts.length).toBeGreaterThan(10);
    expect(parts.join('')).toBe(text);
    expect(Buffer.concat(parts.map(p => Buffer.from(p, 'utf8'))).equals(Buffer.from(text, 'utf8'))).toBe(true);
  });

  test('the whole text when it fits; a refusal naming the cap when not one character fits', () => {
    expect(cutUploadPart('short', FRAME, 1024 * 1024)).toBe(5);
    expect(() => cutUploadPart('😀', FRAME, frameOf('') + 3)).toThrow(/cannot carry even one character/);
    let refusal: unknown;
    try { cutUploadPart('abc', FRAME, 10); } catch (error) { refusal = error; }
    expect(refusal).toBeDefined();
    expect((refusal as { code?: string }).code).toBe('payload_too_large');
  });
});

/**
 * A fake brain that stores parts the way spec 6.2 says: contiguous, replay-idempotent, sha-checked, frame-capped.
 * Every call reaches it as the serialized JSON-RPC request a transport would send (a real, growing id), and it
 * checks that request's own UTF-8 byte length against the cap, independent of the client's frame measure.
 */
function fakeUploadServer(opts: { maxFrame: number; dropReplyAfterStoring?: number[]; dropBeforeStoring?: number[]; refusePart?: number }) {
  const parts: string[] = [];
  const calls: string[] = [];
  const partFrames: number[] = [];
  let nextId = 1000;
  let state: 'open' | 'committed' | 'aborted' = 'open';
  let declared = { bytes: 0, sha256: '' };
  const drop = () => new RemoteMcpError('network', 'connection reset', { kind: 'unreachable' });
  const received = () => Buffer.byteLength(parts.join(''), 'utf8');
  const call: UploadToolCall = async (tool, sent) => {
    const raw = JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: tool, arguments: sent } });
    const request = JSON.parse(raw) as { params: { arguments: Record<string, unknown> } };
    const args = request.params.arguments;
    calls.push(tool);
    if (tool === 'begin_page_upload') {
      declared = { bytes: Number(args.total_bytes), sha256: String(args.sha256) };
      return { upload_id: FRAME.upload_id, part_max_frame_bytes: opts.maxFrame, next_part: 1, received_bytes: 0 };
    }
    if (tool === 'upload_page_part') {
      const part = Number(args.part);
      const text = String(args.text);
      partFrames.push(Buffer.byteLength(raw, 'utf8'));
      expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(opts.maxFrame);
      expect(createHash('sha256').update(text, 'utf8').digest('hex')).toBe(String(args.part_sha256));
      if (part === opts.refusePart) throw opError('payload_too_large', 'part refused', 'smaller part');
      if (opts.dropBeforeStoring?.includes(part)) { opts.dropBeforeStoring.splice(opts.dropBeforeStoring.indexOf(part), 1); throw drop(); }
      expect(part).toBe(parts.length + 1);
      parts.push(text);
      if (opts.dropReplyAfterStoring?.includes(part)) { opts.dropReplyAfterStoring.splice(opts.dropReplyAfterStoring.indexOf(part), 1); throw drop(); }
      return { received_bytes: received(), next_part: parts.length + 1 };
    }
    if (tool === 'get_page_upload') return { state, next_part: parts.length + 1, received_bytes: received() };
    if (tool === 'abort_page_upload') { state = 'aborted'; return { state }; }
    if (tool === 'commit_page_upload') {
      const body = parts.join('');
      expect(Buffer.byteLength(body, 'utf8')).toBe(declared.bytes);
      expect(createHash('sha256').update(body, 'utf8').digest('hex')).toBe(declared.sha256);
      state = 'committed';
      return { slug: 'notes/upload', revision: 'r1', body_bytes: declared.bytes };
    }
    throw new Error(`unexpected tool ${tool}`);
  };
  return { call, parts, calls, partFrames, state: () => state };
}

const transient = (error: unknown) => error instanceof RemoteMcpError && error.reason === 'network';

describe('uploadPageBody', () => {
  const text = escapeHeavy(20_000);

  test('parts fit the advertised frame and the committed body is byte-identical', async () => {
    const server = fakeUploadServer({ maxFrame: 8192 });
    const result = await uploadPageBody(server.call, { slug: 'notes/upload', mode: 'create', request_id: FRAME.upload_id }, stringUploadBody(text), { transient });
    expect(result.revision).toBe('r1');
    expect(server.parts.join('')).toBe(text);
    expect(server.parts.length).toBeGreaterThan(3);
    expect(server.state()).toBe('committed');
    expect(Math.max(...server.partFrames)).toBeLessThanOrEqual(8192);
    expect(Math.max(...server.partFrames)).toBeGreaterThan(8192 - 1024 - 64);
  });

  test('a reply lost after the part landed resumes at get_page_upload next_part, without resending it', async () => {
    const server = fakeUploadServer({ maxFrame: 8192, dropReplyAfterStoring: [2, 4] });
    await uploadPageBody(server.call, { slug: 'notes/upload', mode: 'create', request_id: FRAME.upload_id }, stringUploadBody(text), { transient });
    expect(server.parts.join('')).toBe(text);
    expect(server.calls.filter(c => c === 'get_page_upload').length).toBe(2);
  });

  test('a part dropped before it landed is sent again', async () => {
    const server = fakeUploadServer({ maxFrame: 8192, dropBeforeStoring: [3] });
    await uploadPageBody(server.call, { slug: 'notes/upload', mode: 'create', request_id: FRAME.upload_id }, stringUploadBody(text), { transient });
    expect(server.parts.join('')).toBe(text);
  });

  test('a refused part aborts the session and rethrows; nothing is committed', async () => {
    const server = fakeUploadServer({ maxFrame: 8192, refusePart: 2 });
    await expect(uploadPageBody(server.call, { slug: 'notes/upload', mode: 'create', request_id: FRAME.upload_id }, stringUploadBody(text), { transient }))
      .rejects.toMatchObject({ code: 'payload_too_large' });
    expect(server.state()).toBe('aborted');
    expect(server.calls).not.toContain('commit_page_upload');
  });

  test('a resumed session skips the bytes the brain already holds', async () => {
    const server = fakeUploadServer({ maxFrame: 8192 });
    const body = stringUploadBody(text);
    const first = cutUploadPart(text, { upload_id: FRAME.upload_id, part: 1 }, 8192);
    server.parts.push(text.slice(0, first));
    const resuming: UploadToolCall = async (tool, args) => tool === 'begin_page_upload'
      ? { ...(await server.call(tool, args)), next_part: 2, received_bytes: Buffer.byteLength(text.slice(0, first), 'utf8') }
      : server.call(tool, args);
    await uploadPageBody(resuming, { slug: 'notes/upload', mode: 'create', request_id: FRAME.upload_id }, body, { transient });
    expect(server.parts.join('')).toBe(text);
  });
});
