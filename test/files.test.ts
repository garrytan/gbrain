import { describe, test, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import { writeFileSync, readFileSync, mkdirSync, rmSync, symlinkSync, mkdtempSync } from 'fs';
import { join, basename } from 'path';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { collectFiles, formatFileSizeKb, getMimeType, noStorageBackendMessage } from '../src/commands/files.ts';
import { operationsByName } from '../src/core/operations.ts';
import * as db from '../src/core/db.ts';

const TMP = join(import.meta.dir, '.tmp-files-test');

// fileHash is not exported from files.ts (it takes a path there, not a
// buffer), so it stays reimplemented below. getMimeType is imported.

function fileHash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
  mkdirSync(join(TMP, 'subdir'), { recursive: true });
  mkdirSync(join(TMP, '.hidden'), { recursive: true });
  writeFileSync(join(TMP, 'photo.jpg'), 'fake-jpg');
  writeFileSync(join(TMP, 'doc.pdf'), 'fake-pdf');
  writeFileSync(join(TMP, 'notes.md'), '# Markdown');
  writeFileSync(join(TMP, 'data.csv'), 'a,b,c');
  writeFileSync(join(TMP, 'subdir', 'nested.png'), 'fake-png');
  writeFileSync(join(TMP, '.hidden', 'secret.txt'), 'hidden');
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('formatFileSizeKb', () => {
  test('formats number, bigint, and string database values', () => {
    expect(formatFileSizeKb(35 * 1024)).toBe('35KB');
    expect(formatFileSizeKb(35n * 1024n)).toBe('35KB');
    expect(formatFileSizeKb('35840')).toBe('35KB');
  });

  test('preserves zero-byte files instead of reporting an unknown size', () => {
    expect(formatFileSizeKb(0)).toBe('0KB');
    expect(formatFileSizeKb(0n)).toBe('0KB');
  });

  test('reports missing or invalid sizes as unknown', () => {
    expect(formatFileSizeKb(null)).toBe('?');
    expect(formatFileSizeKb('not-a-number')).toBe('?');
    expect(formatFileSizeKb(-1)).toBe('?');
  });
});

describe('getMimeType', () => {
  test('returns correct MIME for .jpg', () => {
    expect(getMimeType('photo.jpg')).toBe('image/jpeg');
  });

  test('returns correct MIME for .jpeg', () => {
    expect(getMimeType('photo.jpeg')).toBe('image/jpeg');
  });

  test('returns correct MIME for .png', () => {
    expect(getMimeType('image.png')).toBe('image/png');
  });

  test('returns correct MIME for .pdf', () => {
    expect(getMimeType('doc.pdf')).toBe('application/pdf');
  });

  test('returns correct MIME for .mp4', () => {
    expect(getMimeType('video.mp4')).toBe('video/mp4');
  });

  test('returns correct MIME for .svg', () => {
    expect(getMimeType('icon.svg')).toBe('image/svg+xml');
  });

  test('handles uppercase extensions via toLowerCase', () => {
    expect(getMimeType('PHOTO.JPG')).toBe('image/jpeg');
    expect(getMimeType('doc.PDF')).toBe('application/pdf');
  });

  test('returns null for unknown extensions', () => {
    expect(getMimeType('data.csv')).toBeNull();
    expect(getMimeType('script.ts')).toBeNull();
    expect(getMimeType('readme.md')).toBeNull();
  });

  test('returns null for files without extension', () => {
    expect(getMimeType('Makefile')).toBeNull();
  });

  test('handles .docx and .xlsx', () => {
    expect(getMimeType('report.docx')).toContain('wordprocessingml');
    expect(getMimeType('sheet.xlsx')).toContain('spreadsheetml');
  });

  test('handles .heic (iPhone photos)', () => {
    expect(getMimeType('IMG_0001.heic')).toBe('image/heic');
  });

  test('handles .dng (raw photos)', () => {
    expect(getMimeType('RAW_001.dng')).toBe('image/x-adobe-dng');
  });

  test('handles the audio containers transcription accepts', () => {
    expect(getMimeType('memo.ogg')).toBe('audio/ogg');
    expect(getMimeType('memo.flac')).toBe('audio/flac');
    expect(getMimeType('memo.mpga')).toBe('audio/mpeg');
    expect(getMimeType('clip.webm')).toBe('video/webm');
    expect(getMimeType('clip.mpeg')).toBe('video/mpeg');
  });

  // upload-raw routes on `mimeType?.startsWith('audio/'|'video/'|'image/')`.
  // A null MIME is falsy, so any transcribable format missing from MIME_TYPES
  // is silently classified as small text and copied into the brain git repo.
  test('every extension transcription.ts accepts routes as media', () => {
    const transcribable = ['.mp3', '.mp4', '.mpeg', '.mpga', '.m4a', '.wav', '.webm', '.ogg', '.flac'];
    const notMedia = transcribable.filter(ext => {
      const mime = getMimeType(`voice-memo${ext}`);
      return !mime || !/^(audio|video)\//.test(mime);
    });
    expect(notMedia).toEqual([]);
  });
});

describe('fileHash', () => {
  test('produces consistent SHA-256 hash', () => {
    const content = Buffer.from('hello world');
    const hash1 = fileHash(content);
    const hash2 = fileHash(content);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex = 64 chars
  });

  test('different content produces different hash', () => {
    const hash1 = fileHash(Buffer.from('hello'));
    const hash2 = fileHash(Buffer.from('world'));
    expect(hash1).not.toBe(hash2);
  });

  test('empty content produces valid hash', () => {
    const hash = fileHash(Buffer.from(''));
    expect(hash).toHaveLength(64);
  });
});

describe('collectFiles (production import)', () => {
  test('finds non-markdown files', () => {
    const files = collectFiles(TMP);
    const basenames = files.map(f => basename(f));
    expect(basenames).toContain('photo.jpg');
    expect(basenames).toContain('doc.pdf');
    expect(basenames).toContain('data.csv');
  });

  test('skips .md files', () => {
    const files = collectFiles(TMP);
    const mdFiles = files.filter(f => f.endsWith('.md'));
    expect(mdFiles).toHaveLength(0);
  });

  test('skips hidden directories', () => {
    const files = collectFiles(TMP);
    const hiddenFiles = files.filter(f => f.includes('.hidden'));
    expect(hiddenFiles).toHaveLength(0);
  });

  test('recurses into subdirectories', () => {
    const files = collectFiles(TMP);
    const nested = files.filter(f => f.includes('subdir'));
    expect(nested.length).toBeGreaterThan(0);
  });

  test('returns sorted paths', () => {
    const files = collectFiles(TMP);
    const sorted = [...files].sort();
    expect(files).toEqual(sorted);
  });

  test('collectFiles skips symlinks', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-symlink-'));
    try {
      writeFileSync(join(tmpDir, 'real.txt'), 'content');
      symlinkSync('/etc/passwd', join(tmpDir, 'evil.txt'));
      const files = collectFiles(tmpDir);
      expect(files.map(f => basename(f))).toContain('real.txt');
      expect(files.map(f => basename(f))).not.toContain('evil.txt');
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  test('collectFiles skips broken symlinks', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-broken-'));
    try {
      writeFileSync(join(tmpDir, 'real.txt'), 'content');
      symlinkSync('/nonexistent/path', join(tmpDir, 'broken.txt'));
      const files = collectFiles(tmpDir);
      expect(files.map(f => basename(f))).toContain('real.txt');
      expect(files.map(f => basename(f))).not.toContain('broken.txt');
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  test('file_list normalizes BigInt size_bytes for JSON serialization', async () => {
    // Postgres BIGINT(size_bytes) returns native BigInt under postgres.js's
    // {bigint: postgres.BigInt} type map. Both JSON.stringify (MCP) and the
    // CLI's `size_bytes / 1024` divide trip on it. Regression for the bug
    // openclaw's agent surfaced in v0.22.4.
    const fakeRows = [
      { id: 1, page_slug: 'a', filename: 'f1', storage_path: 'a/f1',
        mime_type: 'text/plain', size_bytes: 4096n, content_hash: 'h1',
        created_at: '2026-04-27' },
      { id: 2, page_slug: 'a', filename: 'f2', storage_path: 'a/f2',
        mime_type: null, size_bytes: null, content_hash: 'h2',
        created_at: '2026-04-27' },
    ];
    // file_list now routes through the connected OperationContext engine
    // (sqlQueryForEngine) instead of the module-global db connection; pin the
    // same BigInt invariant against the new seam.
    const fakeEngine: any = { executeRaw: async () => fakeRows };

    const op = operationsByName['file_list'];
    const ctx: any = { engine: fakeEngine, config: {}, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: true };
    const result = await op.handler(ctx, {}) as Array<Record<string, unknown>>;

    expect(result.length).toBe(2);
    expect(typeof result[0].size_bytes).toBe('number');
    expect(result[0].size_bytes).toBe(4096);
    expect(result[1].size_bytes).toBeNull();
    // The exact failure mode openclaw reported.
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  test('collectFiles skips node_modules', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-nodemod-'));
    try {
      mkdirSync(join(tmpDir, 'node_modules'));
      writeFileSync(join(tmpDir, 'node_modules', 'pkg.js'), 'x');
      writeFileSync(join(tmpDir, 'real.txt'), 'content');
      const files = collectFiles(tmpDir);
      expect(files.map(f => basename(f))).toContain('real.txt');
      expect(files.map(f => basename(f))).not.toContain('pkg.js');
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });
});

// ---- #2297: upload-raw !needsCloud (git storage) must actually bank the file ----
// Before the fix, the small-text branch printed {success:true, storage:'git',
// path:<input>} and returned — no repo copy, no files row. These tests pin the
// real behavior: sidecar copy under <pageDir>/.raw/<page-name>/, a files row
// with a repo-relative storage_path + {storage:'git'} metadata, and a hard
// exit 1 when no brain repo is resolvable.
import { readFileSync as readFileSync2297, existsSync as existsSync2297 } from 'fs';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runFiles } from '../src/commands/files.ts';

describe('files upload-raw git-storage branch (#2297)', () => {
  let engine: PGLiteEngine;
  let repo: string;
  let srcDir: string;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    repo = mkdtempSync(join(tmpdir(), 'gbrain-2297-repo-'));
    srcDir = mkdtempSync(join(tmpdir(), 'gbrain-2297-src-'));
    await engine.putPage('notes/small-doc', {
      title: 'Small Doc', type: 'concept', frontmatter: {},
      compiled_truth: 'body', timeline: '',
    });
  });

  afterAll(async () => {
    if (engine) await engine.disconnect();
    if (repo) rmSync(repo, { recursive: true, force: true });
    if (srcDir) rmSync(srcDir, { recursive: true, force: true });
  });

  function captureLogs() {
    const logs: string[] = [];
    const errs: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    const errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.join(' ')); });
    return { logs, errs, restore: () => { logSpy.mockRestore(); errSpy.mockRestore(); } };
  }

  test('small text file: sidecar copy + files row + dest path in JSON', async () => {
    await engine.setConfig('sync.repo_path', repo);
    const src = join(srcDir, 'report.txt');
    writeFileSync(src, 'quarterly numbers');
    const cap = captureLogs();
    try {
      await runFiles(engine, ['upload-raw', src, '--page', 'notes/small-doc', '--type', 'report']);
    } finally {
      cap.restore();
    }
    const out = JSON.parse(cap.logs.find((l) => l.trim().startsWith('{'))!);
    expect(out.success).toBe(true);
    expect(out.storage).toBe('git');
    // Dest is INSIDE the brain repo (not the input path).
    const expectedDest = join(repo, 'notes', '.raw', 'small-doc', 'report.txt');
    expect(out.path).toBe(expectedDest);
    expect(existsSync2297(expectedDest)).toBe(true);
    expect(readFileSync2297(expectedDest, 'utf8')).toBe('quarterly numbers');
    // files row exists, storage_path repo-relative, metadata {storage:'git'}.
    const rows = await engine.executeRaw<{ storage_path: string; page_slug: string; metadata: Record<string, unknown> }>(
      `SELECT storage_path, page_slug, metadata FROM files WHERE filename = 'report.txt'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].storage_path).toBe(join('notes', '.raw', 'small-doc', 'report.txt'));
    expect(rows[0].page_slug).toBe('notes/small-doc');
    const meta = typeof rows[0].metadata === 'string' ? JSON.parse(rows[0].metadata as unknown as string) : rows[0].metadata;
    expect(meta.storage).toBe('git');
    expect(meta.type).toBe('report');
  });

  test('no repo configured: exits 1 instead of lying success', async () => {
    await engine.executeRaw(`DELETE FROM config WHERE key = 'sync.repo_path'`);
    const src = join(srcDir, 'orphan.txt');
    writeFileSync(src, 'nowhere to go');
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);
    const cap = captureLogs();
    try {
      await runFiles(engine, ['upload-raw', src, '--page', 'notes/small-doc']);
      throw new Error('expected exit 1');
    } catch (e) {
      expect((e as Error).message).toBe('EXIT:1');
    } finally {
      cap.restore();
      exitSpy.mockRestore();
    }
    expect(cap.errs.join('\n')).toContain('cannot resolve a brain-repo destination');
    // No success JSON was printed.
    expect(cap.logs.find((l) => l.includes('"success":true'))).toBeUndefined();
  });

  test('missing --page for a git-storage file: exits 1', async () => {
    await engine.setConfig('sync.repo_path', repo);
    const src = join(srcDir, 'pageless.txt');
    writeFileSync(src, 'no page');
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);
    const cap = captureLogs();
    try {
      await runFiles(engine, ['upload-raw', src]);
      throw new Error('expected exit 1');
    } catch (e) {
      expect((e as Error).message).toBe('EXIT:1');
    } finally {
      cap.restore();
      exitSpy.mockRestore();
    }
    expect(cap.errs.join('\n')).toContain('--page');
  });
});

// ---- verify git lane resolves each row via its OWNING source's local_path ----
// upload-raw (#2297) banks storage_path relative to target.writeRoot — the
// source's OWN local_path for sources with a separate working tree. verify
// used to join every git row against sync.repo_path only, so those rows
// falsely reported MISSING (or hash-checked the wrong file).
describe('files verify git lane (per-source root resolution)', () => {
  let engine: PGLiteEngine;
  let repo: string;    // sync.repo_path — the brain-global repo
  let vault: string;   // the 'vault' source's separate working tree

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    repo = mkdtempSync(join(tmpdir(), 'gbrain-verify-repo-'));
    vault = mkdtempSync(join(tmpdir(), 'gbrain-verify-vault-'));
    await engine.setConfig('sync.repo_path', repo);
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, created_at)
       VALUES ('vault', 'vault', $1, '{}'::jsonb, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [vault],
    );
    await engine.putPage('notes/vault-doc', {
      title: 'Vault Doc', type: 'concept', frontmatter: {},
      compiled_truth: 'body', timeline: '',
    }, { sourceId: 'vault' });
    await engine.putPage('notes/default-doc', {
      title: 'Default Doc', type: 'concept', frontmatter: {},
      compiled_truth: 'body', timeline: '',
    });
  });

  afterAll(async () => {
    if (engine) await engine.disconnect();
    if (repo) rmSync(repo, { recursive: true, force: true });
    if (vault) rmSync(vault, { recursive: true, force: true });
  });

  function captureLogs() {
    const logs: string[] = [];
    const errs: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    const errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.join(' ')); });
    return { logs, errs, restore: () => { logSpy.mockRestore(); errSpy.mockRestore(); } };
  }

  test('rows banked under a source-owned working tree verify against that tree, not sync.repo_path', async () => {
    const srcDir = mkdtempSync(join(tmpdir(), 'gbrain-verify-src-'));
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);
    const cap = captureLogs();
    try {
      // One git row in the vault source (separate working tree), one in the
      // default source (sync.repo_path fallback).
      const vaultFile = join(srcDir, 'vault-report.txt');
      writeFileSync(vaultFile, 'vault numbers');
      await runFiles(engine, ['upload-raw', vaultFile, '--page', 'notes/vault-doc', '--source', 'vault']);
      const defaultFile = join(srcDir, 'default-report.txt');
      writeFileSync(defaultFile, 'default numbers');
      await runFiles(engine, ['upload-raw', defaultFile, '--page', 'notes/default-doc', '--source', 'default']);

      // Sanity: the vault row's storage_path is relative to the VAULT tree —
      // it does not exist under sync.repo_path.
      const rows = await engine.executeRaw<{ storage_path: string; source_id: string }>(
        `SELECT storage_path, source_id FROM files WHERE filename = 'vault-report.txt'`,
      );
      expect(rows.length).toBe(1);
      expect(rows[0].source_id).toBe('vault');
      expect(existsSync2297(join(vault, rows[0].storage_path))).toBe(true);
      expect(existsSync2297(join(repo, rows[0].storage_path))).toBe(false);

      await runFiles(engine, ['verify']);
      const all = [...cap.logs, ...cap.errs].join('\n');
      expect(all).not.toContain('MISSING');
      expect(all).not.toContain('MISMATCH');
      expect(all).toContain('2 files verified, 0 mismatches, 0 missing');
    } finally {
      cap.restore();
      exitSpy.mockRestore();
      rmSync(srcDir, { recursive: true, force: true });
    }
  });
});

describe('storage precondition — the silent-no-op class (#4022)', () => {
  test('refusal message names the subcommand and why it refuses', () => {
    const msg = noStorageBackendMessage('upload');
    expect(msg).toContain('gbrain files upload');
    // The two facts a user needs: nothing was stored, and metadata-only is why.
    expect(msg).toContain('refusing to continue');
    expect(msg).toMatch(/metadata only|no blob column/);
    expect(noStorageBackendMessage('redirect')).toContain('gbrain files redirect');
  });

  /**
   * The guard rung: a bug is a sample, not the population. `upload`, `sync`,
   * and `redirect` each tested storage permissively (`if (config?.storage)`)
   * and continued when the answer was "no" — inserting rows, printing
   * "uploaded", and in `redirect` unlinking local originals whose bytes had
   * never left the machine. This scan fails if anyone reintroduces the
   * permissive form, so the whole class stays dead rather than just the three
   * instances.
   */
  test('[GUARD] no storage-dependent path uses the permissive `if (config?.storage)` form', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'files.ts'), 'utf8');
    // Strip comments so prose describing the old bug doesn't trip the scan.
    const code = src
      .split('\n')
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
      })
      .join('\n');

    expect(code).not.toMatch(/if\s*\(\s*config\?\.storage\s*\)/);
    // And the storage-dependent commands must route through the shared guard.
    for (const op of ['upload', 'sync', 'mirror', 'redirect']) {
      expect(code).toContain(`requireStorageBackend('${op}')`);
    }
  });

  test('[GUARD] verify never hardcodes its mismatch/missing counts', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'files.ts'), 'utf8');
    // The original printed `${verified} files verified, 0 mismatches, 0 missing`
    // with both counts literal, so phantom rows reported as verified.
    expect(src).not.toMatch(/files verified, 0 mismatches, 0 missing/);
    expect(src).toContain('${verified} files verified, ${mismatches} mismatches, ${missing} missing');
  });
});
