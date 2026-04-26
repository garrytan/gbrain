import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  autoFixFrontmatter,
  writeBrainPage,
  scanBrainSources,
  BrainWriterError,
} from '../src/core/brain-writer.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const fence = '---';

describe('autoFixFrontmatter', () => {
  test('strips null bytes', () => {
    const input = `${fence}\ntitle: ok\n${fence}\n\nbody\x00drop\x00here`;
    const { content, fixes } = autoFixFrontmatter(input);
    expect(content.includes('\x00')).toBe(false);
    expect(fixes.some(f => f.code === 'NULL_BYTES')).toBe(true);
  });

  test('inserts closing --- before heading when MISSING_CLOSE', () => {
    const input = `${fence}\ntype: concept\ntitle: ok\n# A heading\n\nbody`;
    const { content, fixes } = autoFixFrontmatter(input);
    expect(fixes.some(f => f.code === 'MISSING_CLOSE')).toBe(true);
    // After fix, parsing should find a closing --- before the heading.
    const idxClose = content.indexOf('---', 3);
    const idxHeading = content.indexOf('# A heading');
    expect(idxClose).toBeGreaterThan(0);
    expect(idxClose).toBeLessThan(idxHeading);
  });

  test('rewrites nested-quote title to single-quoted', () => {
    const input = `${fence}\ntype: concept\ntitle: "Phil "Nick" Last"\n${fence}\n\nbody`;
    const { content, fixes } = autoFixFrontmatter(input);
    expect(fixes.some(f => f.code === 'NESTED_QUOTES')).toBe(true);
    // Outer wrapper is now single quotes.
    expect(content).toMatch(/^title: '.*'\s*$/m);
  });

  test('removes mismatched slug field', () => {
    const input = `${fence}\ntype: concept\ntitle: hi\nslug: wrong-slug\n${fence}\n\nbody`;
    const { content, fixes } = autoFixFrontmatter(input, { filePath: 'people/jane-doe.md' });
    expect(fixes.some(f => f.code === 'SLUG_MISMATCH')).toBe(true);
    expect(content).not.toMatch(/^slug:/m);
  });

  test('idempotent: running twice produces no diff and no fixes on second pass', () => {
    const input = `${fence}\ntype: concept\ntitle: "Phil "Nick" Last"\n${fence}\n\nbody\x00`;
    const first = autoFixFrontmatter(input);
    const second = autoFixFrontmatter(first.content);
    expect(second.content).toBe(first.content);
    expect(second.fixes).toEqual([]);
  });

  test('clean input: no fixes, content unchanged', () => {
    const input = `${fence}\ntype: concept\ntitle: ok\n${fence}\n\nbody`;
    const { content, fixes } = autoFixFrontmatter(input);
    expect(content).toBe(input);
    expect(fixes).toEqual([]);
  });
});

describe('writeBrainPage', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'brain-writer-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('happy path: writes file inside source', () => {
    const file = join(tmp, 'people', 'jane.md');
    const content = `${fence}\ntype: person\ntitle: Jane\n${fence}\n\nhello`;
    writeBrainPage(file, content, { sourcePath: tmp });
    expect(readFileSync(file, 'utf8')).toBe(content);
  });

  test('throws BrainWriterError when path is outside sourcePath', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'brain-writer-other-'));
    try {
      const offending = join(elsewhere, 'evil.md');
      expect(() =>
        writeBrainPage(offending, 'content', { sourcePath: tmp }),
      ).toThrow(BrainWriterError);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test('writes .bak before mutating an existing file', () => {
    const file = join(tmp, 'people', 'jane.md');
    mkdirSync(join(tmp, 'people'), { recursive: true });
    const original = `${fence}\ntype: person\ntitle: Old\n${fence}\n\nold`;
    writeFileSync(file, original);
    writeBrainPage(file, `${fence}\ntype: person\ntitle: New\n${fence}\n\nnew`, { sourcePath: tmp });
    expect(existsSync(file + '.bak')).toBe(true);
    expect(readFileSync(file + '.bak', 'utf8')).toBe(original);
  });

  test('autoFix: true repairs nested quotes before writing', () => {
    const file = join(tmp, 'people', 'jane.md');
    const broken = `${fence}\ntype: person\ntitle: "Phil "Nick" Last"\n${fence}\n\nbody`;
    const { fixes } = writeBrainPage(file, broken, { sourcePath: tmp, autoFix: true });
    expect(fixes.some(f => f.code === 'NESTED_QUOTES')).toBe(true);
    expect(readFileSync(file, 'utf8')).toMatch(/^title: '.*'\s*$/m);
  });
});

describe('scanBrainSources (PGLite)', () => {
  let tmp: string;
  let engine: PGLiteEngine;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'brain-writer-scan-'));
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterEach(async () => {
    await engine.disconnect();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function registerSource(id: string, path: string) {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2)
         ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
      [id, path],
    );
  }

  test('returns ok=true for empty source', async () => {
    await registerSource('empty', tmp);
    const report = await scanBrainSources(engine);
    expect(report.ok).toBe(true);
    expect(report.total).toBe(0);
    const empty = report.per_source.find(s => s.source_id === 'empty');
    expect(empty).toBeDefined();
    expect(empty!.total).toBe(0);
  });

  test('detects errors across multiple sources', async () => {
    const srcA = join(tmp, 'a');
    const srcB = join(tmp, 'b');
    mkdirSync(srcA, { recursive: true });
    mkdirSync(srcB, { recursive: true });
    writeFileSync(join(srcA, 'p1.md'), `${fence}\ntype: x\ntitle: ok\n${fence}\n\nbody\x00`);
    writeFileSync(join(srcB, 'p2.md'), `${fence}\ntype: x\ntitle: "P "I" L"\n${fence}\n\nbody`);
    await registerSource('alpha', srcA);
    await registerSource('beta', srcB);

    const report = await scanBrainSources(engine);
    expect(report.ok).toBe(false);
    expect(report.total).toBeGreaterThan(0);
    const alpha = report.per_source.find(s => s.source_id === 'alpha')!;
    const beta = report.per_source.find(s => s.source_id === 'beta')!;
    expect(alpha.errors_by_code.NULL_BYTES).toBeGreaterThanOrEqual(1);
    expect(beta.errors_by_code.NESTED_QUOTES).toBeGreaterThanOrEqual(1);
  });

  test('respects sourceId filter', async () => {
    const srcA = join(tmp, 'a');
    const srcB = join(tmp, 'b');
    mkdirSync(srcA, { recursive: true });
    mkdirSync(srcB, { recursive: true });
    writeFileSync(join(srcA, 'bad.md'), `${fence}\ntype: x\ntitle: ok\n${fence}\n\nbody\x00`);
    writeFileSync(join(srcB, 'bad.md'), `${fence}\ntype: x\ntitle: ok\n${fence}\n\nbody\x00`);
    await registerSource('alpha', srcA);
    await registerSource('beta', srcB);

    const onlyA = await scanBrainSources(engine, { sourceId: 'alpha' });
    expect(onlyA.per_source.length).toBe(1);
    expect(onlyA.per_source[0]!.source_id).toBe('alpha');
  });

  test('skips registered source with missing path', async () => {
    await registerSource('ghost', join(tmp, 'does-not-exist'));
    const report = await scanBrainSources(engine);
    const ghost = report.per_source.find(s => s.source_id === 'ghost')!;
    expect(ghost.total).toBe(0);
  });

  test('skips symlinks (matches sync no-symlink policy)', async () => {
    mkdirSync(join(tmp, 'real'), { recursive: true });
    writeFileSync(join(tmp, 'real', 'good.md'), `${fence}\ntype: x\ntitle: ok\n${fence}\n\nbody`);
    // Create a symlink loop: tmp/real/loop -> tmp/real
    try {
      symlinkSync(join(tmp, 'real'), join(tmp, 'real', 'loop'));
    } catch {
      // Some CI environments forbid symlink creation; skip the assertion.
      return;
    }
    await registerSource('with-symlink', tmp);
    const report = await scanBrainSources(engine);
    // The walk should complete without infinite-looping; at most one .md
    // entry visited (via the real path, not the symlink).
    expect(report.per_source[0]!.total).toBe(0);
  });

  test('AbortSignal mid-scan stops walking', async () => {
    const src = join(tmp, 'big');
    mkdirSync(src, { recursive: true });
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(src, `p${i}.md`), `${fence}\ntype: x\ntitle: t${i}\n${fence}\n\nbody`);
    }
    await registerSource('big', src);
    const ctrl = new AbortController();
    ctrl.abort();
    const report = await scanBrainSources(engine, { signal: ctrl.signal });
    // Aborted before any source ran; per_source array stays empty (or has zero reports).
    expect(report.per_source.length).toBe(0);
  });
});
