import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listRecentTranscripts } from '../src/core/transcripts.ts';

/**
 * v0.29 — listRecentTranscripts unit coverage.
 *
 * Uses a hermetic temp dir as the corpus dir. Engine calls are mocked
 * minimally — we only use engine.getConfig to resolve corpus paths.
 */

let tmpRoot: string;
let corpusDir: string;
const configMap = new Map<string, string | null>();

const fakeEngine = {
  async getConfig(key: string): Promise<string | null> {
    return configMap.get(key) ?? null;
  },
} as unknown as Parameters<typeof listRecentTranscripts>[0];

function setMtime(path: string, mtimeMs: number) {
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'gbrain-transcripts-test-'));
  corpusDir = join(tmpRoot, 'sessions');
  mkdirSync(corpusDir, { recursive: true });
});

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  configMap.clear();
  configMap.set('dream.synthesize.session_corpus_dir', corpusDir);
});

describe('listRecentTranscripts', () => {
  test('returns [] when no corpus dir is configured', async () => {
    configMap.clear();
    const result = await listRecentTranscripts(fakeEngine);
    expect(result).toEqual([]);
  });

  test('returns [] when the corpus dir is empty', async () => {
    // Empty dir, no files yet.
    const subdir = join(tmpRoot, 'empty-dir');
    mkdirSync(subdir, { recursive: true });
    configMap.set('dream.synthesize.session_corpus_dir', subdir);
    const result = await listRecentTranscripts(fakeEngine);
    expect(result).toEqual([]);
  });

  test('returns transcripts within mtime window, newest first', async () => {
    const a = join(corpusDir, '2026-04-25-session-a.txt');
    const b = join(corpusDir, '2026-04-26-session-b.txt');
    writeFileSync(a, 'A content first line\nmore content here.\n');
    writeFileSync(b, 'B content first line\nmore content there.\n');
    // Set b newer than a.
    setMtime(a, Date.now() - 86400000); // 1 day ago
    setMtime(b, Date.now() - 3600000);  // 1 hour ago

    const result = await listRecentTranscripts(fakeEngine, { days: 7 });
    expect(result.length).toBe(2);
    expect(result[0].path).toBe('2026-04-26-session-b.txt');
    expect(result[1].path).toBe('2026-04-25-session-a.txt');
  });

  test('mtime window excludes older files', async () => {
    const old = join(corpusDir, '2020-01-01-old.txt');
    writeFileSync(old, 'old content\n');
    setMtime(old, Date.now() - 365 * 86400000); // 1 year ago

    const result = await listRecentTranscripts(fakeEngine, { days: 7 });
    expect(result.find(r => r.path === '2020-01-01-old.txt')).toBeUndefined();
  });

  test('skips dream-generated outputs', async () => {
    const dream = join(corpusDir, '2026-04-26-dream-out.txt');
    // Identity marker: ---\n + frontmatter with dream_generated: true.
    writeFileSync(dream, '---\ntitle: A reflection\ndream_generated: true\n---\n\nbody\n');
    setMtime(dream, Date.now() - 60_000);

    const result = await listRecentTranscripts(fakeEngine, { days: 7 });
    expect(result.find(r => r.path === '2026-04-26-dream-out.txt')).toBeUndefined();
  });

  test('summary=true returns first non-empty line + ~250 trailing chars', async () => {
    const file = join(corpusDir, '2026-04-26-summary.txt');
    const body = 'First line of the transcript\n' + 'x'.repeat(500);
    writeFileSync(file, body);
    setMtime(file, Date.now());

    const result = await listRecentTranscripts(fakeEngine, { days: 7, summary: true });
    const row = result.find(r => r.path === '2026-04-26-summary.txt');
    expect(row).toBeDefined();
    expect(row!.summary.startsWith('First line of the transcript')).toBe(true);
    // The summary should be much shorter than the full body.
    expect(row!.summary.length).toBeLessThan(body.length);
    expect(row!.summary.length).toBeLessThan(400);
  });

  test('summary=false returns full content capped at 100 KB', async () => {
    const file = join(corpusDir, '2026-04-26-full.txt');
    const body = 'big body\n' + 'y'.repeat(200_000);
    writeFileSync(file, body);
    setMtime(file, Date.now());

    const result = await listRecentTranscripts(fakeEngine, { days: 7, summary: false });
    const row = result.find(r => r.path === '2026-04-26-full.txt');
    expect(row).toBeDefined();
    expect(row!.summary.length).toBeLessThanOrEqual(100 * 1024);
    expect(row!.length).toBe(body.length); // length always = full file size
  });

  test('extracts date from YYYY-MM-DD prefix when present', async () => {
    const file = join(corpusDir, '2026-05-01-dated.txt');
    writeFileSync(file, 'content\n');
    setMtime(file, Date.now());

    const result = await listRecentTranscripts(fakeEngine, { days: 7 });
    const row = result.find(r => r.path === '2026-05-01-dated.txt');
    expect(row).toBeDefined();
    expect(row!.date).toBe('2026-05-01');
  });

  test('returns null date when filename has no date prefix', async () => {
    const file = join(corpusDir, 'random-name.txt');
    writeFileSync(file, 'content\n');
    setMtime(file, Date.now());

    const result = await listRecentTranscripts(fakeEngine, { days: 7 });
    const row = result.find(r => r.path === 'random-name.txt');
    expect(row).toBeDefined();
    expect(row!.date).toBeNull();
  });

  test('limit caps the number of returned transcripts', async () => {
    // Add 5 files.
    for (let i = 0; i < 5; i++) {
      const file = join(corpusDir, `multi-${i}.txt`);
      writeFileSync(file, `content ${i}\n`);
      setMtime(file, Date.now());
    }
    const result = await listRecentTranscripts(fakeEngine, { days: 7, limit: 2 });
    expect(result.length).toBe(2);
  });

  test('non-existent corpus dir is skipped silently', async () => {
    configMap.set('dream.synthesize.session_corpus_dir', '/nope/does/not/exist');
    const result = await listRecentTranscripts(fakeEngine);
    expect(result).toEqual([]);
  });
});
