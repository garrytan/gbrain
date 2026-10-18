/**
 * workspace-push over a staged file larger than PUSH_MAX_SCAN_BYTES (25 MiB):
 * the pre-push secret gate streams the blob and scans it in bounded windows
 * (secret-scan-stream.ts) instead of refusing it as unscannable, against a
 * real local bare remote as in workspace-push.serial.test.ts.
 *
 * The file is 314,573 lines of 99 characters plus a newline (100 bytes a
 * line), so every window seam sits at a known line: window 0 ends at
 * character STREAM_SCAN_WINDOW_CHARS, and each next window starts at the line
 * start at or before its predecessor's end minus STREAM_SCAN_OVERLAP_CHARS.
 * Secrets fill whole 99-character lines (a private key's fences and
 * 99-character base64 body lines included), so placing one shifts nothing.
 * Every secret is assembled at runtime from split literals.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, truncateSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import { workspacePush, PUSH_MAX_SCAN_BYTES, PUSH_STREAM_SCAN_MAX_BYTES } from '../src/core/workspace-push.ts';
import { STREAM_SCAN_OVERLAP_CHARS, STREAM_SCAN_WINDOW_CHARS, streamScanWork } from '../src/core/secret-scan-stream.ts';

const T = 180_000; // explicit per-test timeout — bun ignores bunfig.toml's key
const LINE = 100;
const LINES = 314_573;
const SIZE = LINE * LINES;
const FILLER = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore'.padEnd(99, ' ').slice(0, 99);
const OPENAI = 'sk-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4P5q6R7s8';
const GITHUB = 'gh' + 'p_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2';
const BEGIN = ['-----BEGIN', ' RSA PRIVATE KEY', '-----'].join('');
const END = ['-----END', ' RSA PRIVATE KEY', '-----'].join('');

// #2943: env: process.env is REQUIRED, or spawned git misses the HOME swap.
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', env: process.env,
  }).trim();
}

let root: string;
let work: string;
let bare: string;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wsp-large-'));
  saved = {
    HOME: process.env.HOME,
    GBRAIN_HOME: process.env.GBRAIN_HOME,
    GBRAIN_GIT_ALLOW_FILE_TRANSPORT: process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT,
  };
  process.env.HOME = mkdtempSync(join(root, 'home-'));
  process.env.GBRAIN_HOME = process.env.HOME;
  process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = '1';
  bare = mkdtempSync(join(root, 'origin-')) + '.git';
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'ignore', env: process.env });
  work = mkdtempSync(join(root, 'work-'));
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, work], { stdio: 'ignore', env: process.env });
  git(work, 'config', 'user.email', 't@t.t');
  git(work, 'config', 'user.name', 'tester');
  writeFileSync(join(work, 'README.md'), 'init\n');
  git(work, 'add', 'README.md');
  git(work, 'commit', '-qm', 'init');
  git(work, 'push', '-q', 'origin', 'main');
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

function push() {
  for (const k of Object.keys(streamScanWork) as Array<keyof typeof streamScanWork>) streamScanWork[k] = 0;
  return workspacePush({ dir: work, branch: 'main', allowUnverifiedRemote: true });
}

/** The ~30 MiB file, with edits (0-based line index to a line of at most 99 chars) in place. */
function writeBig(edits: Map<number, string> = new Map()): void {
  const lines = new Array<string>(LINES).fill(FILLER);
  for (const [i, text] of edits) {
    expect(text.length).toBeLessThanOrEqual(99);
    lines[i] = text.padEnd(99, ' ');
  }
  writeFileSync(join(work, 'big.md'), lines.join('\n') + '\n');
}

/** A private key: header on line first, bodyLines base64 lines, footer after them. */
function placeKey(edits: Map<number, string>, first: number, bodyLines: number): void {
  edits.set(first, ' '.repeat(99 - BEGIN.length) + BEGIN);
  for (let i = 1; i <= bodyLines; i++) edits.set(first + i, randomBytes(75).toString('base64').slice(0, 99));
  edits.set(first + bodyLines + 1, END);
}

// Window 0 is [0, W); window k + 1 starts STEP after window k.
const W = STREAM_SCAN_WINDOW_CHARS;
const STEP = Math.floor((W - STREAM_SCAN_OVERLAP_CHARS) / LINE) * LINE;

describe('pre-push secret scan over the 25 MiB cap', () => {
  test('a clean ~30 MiB staged file is scanned in bounded windows and pushed', async () => {
    expect(SIZE).toBeGreaterThan(PUSH_MAX_SCAN_BYTES);
    writeBig();
    const r = await push();
    expect(r.status).toBe('pushed');
    expect(r.ok).toBe(true);
    expect(Number(git(bare, 'cat-file', '-s', 'refs/heads/main:big.md'))).toBe(SIZE);
    expect(streamScanWork.bytes).toBe(SIZE);
    expect(streamScanWork.chars).toBeGreaterThanOrEqual(SIZE);
    expect(streamScanWork.largestWindow).toBeLessThanOrEqual(STREAM_SCAN_WINDOW_CHARS);
    expect(streamScanWork.windows).toBe(Math.ceil((SIZE - W) / STEP) + 1);
  }, T);

  test('secrets across window seams and near the end block with their file and line, once each', async () => {
    const edits = new Map<number, string>();
    const acrossEnd = Math.floor(W / LINE); // the line window 0 cuts (at column W % 100)
    edits.set(acrossEnd, OPENAI + ' token');
    const keyAcrossStart = STEP / LINE - 10; // header before window 1's start, footer after it
    placeKey(edits, keyAcrossStart, 19);
    const keyAcrossEnd = Math.floor((STEP + W) / LINE) - 10; // straddles window 1's end
    placeKey(edits, keyAcrossEnd, 19);
    const nearEnd = LINES - 3;
    edits.set(nearEnd, 'deploy ' + GITHUB);
    expect(acrossEnd * LINE).toBeLessThan(W);
    expect(acrossEnd * LINE + OPENAI.length).toBeGreaterThan(W);
    writeBig(edits);
    const before = git(bare, 'rev-parse', 'refs/heads/main');
    const r = await push();
    expect(r.status).toBe('blocked_secrets');
    expect(r.ok).toBe(false);
    const got = (r.findings ?? []).map((f) => ({ file: f.file, line: f.line, pattern: f.pattern })).sort((a, b) => a.line - b.line);
    expect(got).toEqual([
      { file: 'big.md', line: keyAcrossStart + 1, pattern: 'private_key_pem' },
      { file: 'big.md', line: acrossEnd + 1, pattern: 'openai' },
      { file: 'big.md', line: keyAcrossEnd + 1, pattern: 'private_key_pem' },
      { file: 'big.md', line: nearEnd + 1, pattern: 'github_token' },
    ]);
    expect(JSON.stringify(r).includes(OPENAI)).toBe(false);
    expect(git(bare, 'rev-parse', 'refs/heads/main')).toBe(before); // nothing pushed
    expect(git(work, 'diff', '--cached', '--name-only')).toBe(''); // index restored
    expect(streamScanWork.largestWindow).toBeLessThanOrEqual(STREAM_SCAN_WINDOW_CHARS);
    expect(streamScanWork.bytes).toBe(SIZE);
  }, T);

  test('a newline-free stretch cut mid-line between an anchor and its value still blocks: Bearer and Basic at every seam', async () => {
    // One line: every window is cut mid-line at exactly the overlap before its end.
    const cut = (k: number): number => k * (W - STREAM_SCAN_OVERLAP_CHARS);
    const token = 'Q7' + randomBytes(30).toString('hex');
    const basic = Buffer.from('alice:' + randomBytes(9).toString('hex')).toString('base64');
    const placed: Array<{ at: number; text: string }> = [
      { at: cut(1) - ' Bearer '.length, text: ' Bearer ' + token + ' ' },
      { at: cut(2) - ' Bearer '.length + 4, text: ' Bearer ' + token.split('').reverse().join('') + ' ' },
      { at: cut(3) - ' Authorization: Basic '.length, text: ' Authorization: Basic ' + basic + ' ' },
    ];
    const size = 30 * 1024 ** 2;
    expect(cut(3) + STREAM_SCAN_OVERLAP_CHARS).toBeLessThan(size);
    const body = Buffer.alloc(size, 'a');
    for (const p of placed) body.write(p.text, p.at, 'latin1');
    writeFileSync(join(work, 'big.md'), body);
    const before = git(bare, 'rev-parse', 'refs/heads/main');
    const r = await push();
    expect(r.status).toBe('blocked_secrets');
    expect((r.findings ?? []).map((f) => `${f.file}:${f.line}:${f.pattern}`).sort()).toEqual(['big.md:1:basic_auth', 'big.md:1:bearer', 'big.md:1:bearer']);
    expect(JSON.stringify(r).includes(token)).toBe(false);
    expect(git(bare, 'rev-parse', 'refs/heads/main')).toBe(before);
    expect(streamScanWork.windows).toBe(4);
    expect(streamScanWork.largestWindow).toBeLessThanOrEqual(STREAM_SCAN_WINDOW_CHARS);
  }, T);

  test('a staged blob over the streamed-scan ceiling still blocks as unscannable', async () => {
    const huge = join(work, 'huge.bin');
    writeFileSync(huge, '');
    truncateSync(huge, PUSH_STREAM_SCAN_MAX_BYTES + 1); // sparse: no disk blocks, still that many bytes for git
    const before = git(bare, 'rev-parse', 'refs/heads/main');
    const r = await push();
    expect(r.status).toBe('blocked_unscannable');
    expect(r.unscannable?.some((u) => u.startsWith('huge.bin') && u.includes('scan ceiling'))).toBe(true);
    expect(r.reason).toContain('scan ceiling');
    expect(streamScanWork.bytes).toBe(0); // refused by its recorded size, never read
    expect(git(bare, 'rev-parse', 'refs/heads/main')).toBe(before);
    expect(git(work, 'diff', '--cached', '--name-only')).toBe('');
  }, T);
});
