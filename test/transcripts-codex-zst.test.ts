/**
 * Codex compresses an idle rollout in place (feature
 * `local_thread_store_compression`): rollout-*.jsonl becomes
 * rollout-*.jsonl.zst and the plain file is deleted. The importer must keep
 * seeing those sessions, as the SAME sessions:
 *   - discovery (codex root) and explicit directory paths pick up .jsonl.zst;
 *   - when X.jsonl and X.jsonl.zst both exist only X.jsonl is used;
 *   - a compressed rollout parses to the same session id, slug and pages as
 *     its plain twin, so re-importing after compression changes no page;
 *   - --max-bytes applies to the decompressed size (same head + tail degrade
 *     as a plain file), and a decompression bomb is refused before it is
 *     decompressed;
 *   - a corrupt or truncated .zst fails that file only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runTranscriptsIngest } from '../src/core/transcripts/ingest.ts';
import { codexAdapter } from '../src/core/transcripts/codex.ts';
import { detectAdapter } from '../src/core/transcripts/detect.ts';
import { discoverTranscriptFiles, indexTranscriptPages, resolveTranscriptPageSlugs } from '../src/core/transcripts/discover.ts';
import { expandPaths } from '../src/commands/transcripts.ts';
import { buildTranscriptSlug, type FileDiagnostics, type ParsedSession } from '../src/core/transcripts/types.ts';
import { readZstdBounded, scanZstdFrames, ZSTD_DECOMPRESSED_CEILING_BYTES } from '../src/core/transcripts/zstd.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'transcripts');
const NO_PATTERNS = { userPatternsPath: '/nonexistent-patterns.txt' };

let engine: PGLiteEngine;
let tmp: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  tmp = mkdtempSync(join(tmpdir(), 'gb-codex-zst-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function compress(path: string): string {
  const out = `${path}.zst`;
  writeFileSync(out, Bun.zstdCompressSync(readFileSync(path)));
  return out;
}

async function parseAll(path: string, maxBytes?: number): Promise<{ sessions: ParsedSession[]; diag: FileDiagnostics }> {
  const gen = codexAdapter.parse(path, maxBytes === undefined ? {} : { maxBytes });
  const sessions: ParsedSession[] = [];
  let step = await gen.next();
  while (!step.done) {
    sessions.push(step.value);
    step = await gen.next();
  }
  return { sessions, diag: step.value };
}

/** A synthetic rollout whose session_meta carries NO id (forces the filename fallback). */
function writeIdlessRollout(dir: string, name: string, turns = 3, padChars = 0): string {
  const t0 = Date.parse('2026-10-01T10:00:00.000Z');
  const lines = [
    JSON.stringify({ timestamp: new Date(t0).toISOString(), type: 'session_meta', payload: { cwd: '/tmp/zst-test' } }),
  ];
  for (let i = 0; i < turns; i++) {
    const ts = new Date(t0 + (i + 1) * 1000).toISOString();
    lines.push(JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'user_message', message: `question ${i} ${'q'.repeat(padChars)}` } }));
    lines.push(
      JSON.stringify({
        timestamp: ts,
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', id: `ri-${i}`, content: [{ type: 'output_text', text: `answer ${i} ${'a'.repeat(padChars)}` }] },
      }),
    );
  }
  const p = join(dir, `${name}.jsonl`);
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

describe('discovery and path expansion', () => {
  test('the codex root discovers rollout-*.jsonl.zst; other harness roots do not', () => {
    const codexRoot = join(tmp, 'codex', '2026', '10', '01');
    const claudeRoot = join(tmp, 'claude', 'proj');
    mkdirSync(codexRoot, { recursive: true });
    mkdirSync(claudeRoot, { recursive: true });
    const plain = writeIdlessRollout(codexRoot, 'rollout-plain');
    const zst = compress(writeIdlessRollout(codexRoot, 'rollout-squeezed'));
    unlinkSync(zst.slice(0, -4));
    writeFileSync(join(claudeRoot, 'abc.jsonl.zst'), Bun.zstdCompressSync(Buffer.from('{}\n')));

    const found = discoverTranscriptFiles([
      { format: 'codex', root: join(tmp, 'codex'), extension: '.jsonl' },
      { format: 'claude-code', root: join(tmp, 'claude'), extension: '.jsonl' },
    ]);
    expect(found.map((f) => f.path).sort()).toEqual([plain, zst].sort());
    expect(found.every((f) => f.format === 'codex')).toBe(true);
  });

  test('X.jsonl wins over its twin X.jsonl.zst in discovery and in a --path directory', async () => {
    const day = join(tmp, 'codex', '2026', '10', '02');
    mkdirSync(day, { recursive: true });
    const plain = writeIdlessRollout(day, 'rollout-twin');
    const twin = compress(plain);
    const lone = compress(writeIdlessRollout(day, 'rollout-lone'));
    unlinkSync(lone.slice(0, -4));

    const found = discoverTranscriptFiles([{ format: 'codex', root: join(tmp, 'codex'), extension: '.jsonl' }]);
    expect(found.map((f) => f.path).sort()).toEqual([plain, lone].sort());
    expect(found.some((f) => f.path === twin)).toBe(false);

    const expanded = await expandPaths([join(tmp, 'codex')]);
    expect(expanded.sort()).toEqual([plain, lone].sort());

    // An explicit compressed file on its own is still accepted.
    expect(await expandPaths([lone])).toEqual([lone]);
  });
});

describe('same session for plain and compressed', () => {
  test('detection recognises a compressed rollout as codex', () => {
    const plain = join(tmp, 'rollout-detect.jsonl');
    writeFileSync(plain, readFileSync(join(FIXTURES, 'codex-rollout.jsonl')));
    const zst = compress(plain);
    const d = detectAdapter(zst);
    expect(d.ok && d.adapter.format).toBe('codex');
    // Without the zstd magic a .jsonl.zst is not a codex rollout.
    const fake = join(tmp, 'rollout-fake.jsonl.zst');
    writeFileSync(fake, readFileSync(plain));
    expect(codexAdapter.detect(fake, readFileSync(fake))).toBe(false);
  });

  test('every codex fixture parses identically from .jsonl and .jsonl.zst', async () => {
    for (const name of ['codex-rollout', 'codex-rollout-0154']) {
      const plain = join(tmp, `${name}.jsonl`);
      writeFileSync(plain, readFileSync(join(FIXTURES, `${name}.jsonl`)));
      const zst = compress(plain);
      const a = await parseAll(plain);
      const b = await parseAll(zst);
      expect(b.sessions.length).toBe(a.sessions.length);
      expect(a.sessions.length).toBeGreaterThan(0);
      for (let i = 0; i < a.sessions.length; i++) {
        expect(b.sessions[i]!.meta.sessionId).toBe(a.sessions[i]!.meta.sessionId);
        expect(b.sessions[i]!.messages).toEqual(a.sessions[i]!.messages);
        const { source_path: _sp, ...restB } = (b.sessions[i]!.meta.raw ?? {}) as Record<string, unknown>;
        const { source_path: _sa, ...restA } = (a.sessions[i]!.meta.raw ?? {}) as Record<string, unknown>;
        expect(restB).toEqual(restA);
      }
      expect({ ...b.diag }).toEqual({ ...a.diag });
    }
  });

  test('compression retains upstream subagent diagnostics', async () => {
    const plain = writeIdlessRollout(tmp, 'rollout-subagent');
    const lines = readFileSync(plain, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    lines[0].payload.source = { subagent: 'reviewer' };
    writeFileSync(plain, lines.filter(line => line.type !== 'event_msg').map(line => JSON.stringify(line)).join('\n'));
    const a = await parseAll(plain);
    const b = await parseAll(compress(plain));
    expect(b.sessions[0].messages).toEqual(a.sessions[0].messages);
    expect(b.diag).toEqual(a.diag);
    expect(b.diag.subagentRollout).toBe(true);
    expect(b.diag.userTurnsMissing).toBeUndefined();
  });

  test('the filename fallback session id strips .jsonl.zst like .jsonl', async () => {
    const plain = writeIdlessRollout(tmp, 'rollout-2026-10-01T10-00-00-fallback');
    const zst = compress(plain);
    const a = await parseAll(plain);
    const b = await parseAll(zst);
    expect(a.sessions[0]!.meta.sessionId).toBe('rollout-2026-10-01T10-00-00-fallback');
    expect(b.sessions[0]!.meta.sessionId).toBe('rollout-2026-10-01T10-00-00-fallback');
  });

  test('a session compressed after import keeps its slug and is not re-imported', async () => {
    const plain = writeIdlessRollout(tmp, 'rollout-2026-10-01T10-00-00-lifecycle');
    const first = await runTranscriptsIngest(engine, { paths: [plain], sourceId: 'default', ...NO_PATTERNS });
    expect(first.sessionsImported).toBe(1);
    expect(first.pages.imported).toBe(1);
    const slug = buildTranscriptSlug('codex', '2026-10-01T10:00:00.000Z', {
      sessionId: 'rollout-2026-10-01T10-00-00-lifecycle',
    });
    expect(first.slugsTouched).toEqual([slug]);

    // Codex compresses it in place.
    const zst = compress(plain);
    unlinkSync(plain);
    const second = await runTranscriptsIngest(engine, { paths: [zst], sourceId: 'default', ...NO_PATTERNS });
    expect(second.erroredFiles).toBe(0);
    expect(second.files[0]!.format).toBe('codex');
    expect(second.pages.imported).toBe(0);
    expect(second.pages.skipped).toBe(1);
    expect(second.slugsTouched).toEqual([slug]);
    expect(second.cleanScan).toBe(true);
    const index = await indexTranscriptPages(engine, 'default');
    expect(resolveTranscriptPageSlugs(zst, index)).toEqual([slug]);

    const pages = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE type = 'conversation' AND deleted_at IS NULL`,
      [],
    );
    expect(pages.map((r) => r.slug)).toEqual([slug]);
  });
});

describe('size caps on the decompressed bytes', () => {
  test('--max-bytes degrades a compressed rollout exactly like its plain twin', async () => {
    const plain = writeIdlessRollout(tmp, 'rollout-big', 40, 400);
    const zst = compress(plain);
    const plainBytes = readFileSync(plain).length;
    expect(readFileSync(zst).length).toBeLessThan(8 * 1024); // compressed is far under the cap ...
    const cap = 8 * 1024; // ... but the decompressed content is not
    expect(plainBytes).toBeGreaterThan(cap);

    const a = await parseAll(plain, cap);
    const b = await parseAll(zst, cap);
    expect(a.diag.truncated).toBe(true);
    expect(b.diag.truncated).toBe(true);
    expect(b.diag.bytesRead).toBe(a.diag.bytesRead);
    expect(b.diag.bytesRead).toBeLessThanOrEqual(cap);
    expect(b.diag.skippedLines).toBe(a.diag.skippedLines);
    expect(b.sessions.map((s) => s.messages)).toEqual(a.sessions.map((s) => s.messages));

    const r = await readZstdBounded(zst, cap, 2048);
    expect(r.truncated).toBe(true);
    expect(r.decompressedBytes).toBe(plainBytes);
    expect(r.bytesRead).toBe(cap);
  });

  test('a decompression bomb is refused from its headers before decompressing', async () => {
    // One frame, no declared size, ~4GiB+ of RLE blocks (4 bytes per 128KiB).
    const blocks = Math.floor(ZSTD_DECOMPRESSED_CEILING_BYTES / (128 * 1024)) + 2;
    const buf = Buffer.alloc(4 + 2 + blocks * 4);
    buf.writeUInt32LE(0xfd2fb528, 0);
    buf[4] = 0x00; // no content size, not single segment, no checksum, no dict
    buf[5] = (7 << 3); // window 2^17 = 128KiB
    let pos = 6;
    for (let i = 0; i < blocks; i++) {
      const last = i === blocks - 1 ? 1 : 0;
      const v = last | (1 << 1) | ((128 * 1024) << 3); // RLE block of 128KiB
      buf[pos] = v & 0xff;
      buf[pos + 1] = (v >> 8) & 0xff;
      buf[pos + 2] = (v >> 16) & 0xff;
      buf[pos + 3] = 0x61;
      pos += 4;
    }
    const bomb = join(tmp, 'rollout-bomb.jsonl.zst');
    writeFileSync(bomb, buf);
    expect(scanZstdFrames(bomb).maxBytes).toBeGreaterThan(ZSTD_DECOMPRESSED_CEILING_BYTES);
    const started = Date.now();
    await expect(readZstdBounded(bomb, 50 * 1024 * 1024, 256 * 1024)).rejects.toThrow(/decompression-bomb guard/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test('a frame that decompresses past its declared size fails', async () => {
    const plain = writeIdlessRollout(tmp, 'rollout-liar', 5, 50);
    const zst = compress(plain);
    const buf = readFileSync(zst);
    const scan = scanZstdFrames(zst);
    expect(scan.declaredBytes).toBe(readFileSync(plain).length);
    // Rewrite the declared size downward: the frame now lies about its size.
    const fhd = buf[4]!;
    const fcsBytes = [fhd & 0x20 ? 1 : 0, 2, 4, 8][fhd >> 6]!;
    expect(fcsBytes).toBeGreaterThanOrEqual(2);
    const at = 5 + (fhd & 0x20 ? 0 : 1) + [0, 1, 2, 4][fhd & 3]!;
    if (fcsBytes === 2) buf.writeUInt16LE(0, at);
    else if (fcsBytes === 4) buf.writeUInt32LE(300, at);
    else buf.writeBigUInt64LE(300n, at);
    writeFileSync(zst, buf);
    await expect(readZstdBounded(zst, 50 * 1024 * 1024, 256 * 1024)).rejects.toThrow(/zstd/);
  });
});

describe('a broken .zst fails only that file', () => {
  test('corrupt and truncated compressed rollouts error per file; the run continues', async () => {
    const good = writeIdlessRollout(tmp, 'rollout-2026-10-01T10-00-00-good');
    const corrupt = join(tmp, 'rollout-corrupt.jsonl.zst');
    writeFileSync(corrupt, Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('not really zstd at all, just bytes')]));
    const whole = readFileSync(compress(writeIdlessRollout(tmp, 'rollout-cut', 30, 200)));
    unlinkSync(join(tmp, 'rollout-cut.jsonl'));
    const truncated = join(tmp, 'rollout-cut.jsonl.zst');
    writeFileSync(truncated, whole.subarray(0, Math.floor(whole.length / 2)));

    const r = await runTranscriptsIngest(engine, {
      paths: [corrupt, truncated, good],
      sourceId: 'default',
      ...NO_PATTERNS,
    });
    expect(r.erroredFiles).toBe(2);
    expect(r.files[0]!.error).toMatch(/zstd/);
    expect(r.files[1]!.error).toMatch(/zstd: truncated/);
    expect(r.files[2]!.error).toBeUndefined();
    expect(r.sessionsImported).toBe(1);
    expect(r.cleanScan).toBe(false);
  });
});
