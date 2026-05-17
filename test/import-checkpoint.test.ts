import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadCheckpoint,
  saveCheckpoint,
  resumeFilter,
  clearCheckpoint,
  type ImportCheckpoint,
} from '../src/core/import-checkpoint.ts';

let workDir: string;
let cpPath: string;
let stderrCaptured = '';
let originalConsoleError: typeof console.error;

function captureStderr() {
  stderrCaptured = '';
  originalConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    stderrCaptured += args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n';
  };
}

function restoreStderr() {
  if (originalConsoleError) {
    console.error = originalConsoleError;
    originalConsoleError = undefined as unknown as typeof console.error;
  }
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'gbrain-checkpoint-'));
  cpPath = join(workDir, 'import-checkpoint.json');
});

afterEach(() => {
  restoreStderr();
  rmSync(workDir, { recursive: true, force: true });
});

describe('loadCheckpoint', () => {
  test('returns null when file is missing', () => {
    expect(loadCheckpoint(cpPath, '/some/dir')).toBeNull();
  });

  test('returns null when JSON is malformed', () => {
    writeFileSync(cpPath, 'not json at all');
    expect(loadCheckpoint(cpPath, '/some/dir')).toBeNull();
  });

  test('returns null when dir mismatches the current run', () => {
    const cp: ImportCheckpoint = {
      dir: '/other/brain',
      completedPaths: ['a.md'],
      timestamp: '2026-05-14T00:00:00Z',
    };
    writeFileSync(cpPath, JSON.stringify(cp));
    expect(loadCheckpoint(cpPath, '/different/brain')).toBeNull();
  });

  test('returns null and logs to stderr for old positional format', () => {
    captureStderr();
    writeFileSync(cpPath, JSON.stringify({
      dir: '/tmp/example-brain',
      totalFiles: 13768,
      processedIndex: 5000,
      timestamp: '2026-01-01T00:00:00Z',
    }));
    const result = loadCheckpoint(cpPath, '/tmp/example-brain');
    expect(result).toBeNull();
    expect(stderrCaptured).toContain('Older checkpoint format detected');
  });

  test('returns null silently for missing completedPaths without processedIndex', () => {
    // Not the v0.33.2 schema and not the old positional schema either —
    // probably a manually-edited file or third-party tooling. Discard
    // without the migration log line.
    captureStderr();
    writeFileSync(cpPath, JSON.stringify({
      dir: '/tmp/example-brain',
      timestamp: '2026-01-01T00:00:00Z',
    }));
    expect(loadCheckpoint(cpPath, '/tmp/example-brain')).toBeNull();
    expect(stderrCaptured).not.toContain('Older checkpoint format');
  });

  test('returns null when completedPaths contains non-strings', () => {
    writeFileSync(cpPath, JSON.stringify({
      dir: '/tmp/example-brain',
      completedPaths: ['a.md', 42, 'b.md'],
      timestamp: '2026-01-01T00:00:00Z',
    }));
    expect(loadCheckpoint(cpPath, '/tmp/example-brain')).toBeNull();
  });

  test('returns the checkpoint for valid v0.33.2 payload', () => {
    const cp: ImportCheckpoint = {
      dir: '/tmp/example-brain',
      completedPaths: ['meetings/2026-05-13.md', 'concepts/foo.md'],
      timestamp: '2026-05-14T12:34:56Z',
    };
    writeFileSync(cpPath, JSON.stringify(cp));
    const loaded = loadCheckpoint(cpPath, '/tmp/example-brain');
    expect(loaded).not.toBeNull();
    expect(loaded?.dir).toBe('/tmp/example-brain');
    expect(loaded?.completedPaths).toEqual(['meetings/2026-05-13.md', 'concepts/foo.md']);
    expect(loaded?.timestamp).toBe('2026-05-14T12:34:56Z');
  });
});

describe('saveCheckpoint', () => {
  test('round-trips through loadCheckpoint', () => {
    const cp: ImportCheckpoint = {
      dir: '/tmp/example-brain',
      completedPaths: ['a.md', 'b.md', 'c.md'],
      timestamp: '2026-05-14T00:00:00Z',
    };
    saveCheckpoint(cpPath, cp);
    const loaded = loadCheckpoint(cpPath, '/tmp/example-brain');
    expect(loaded?.completedPaths).toEqual(['a.md', 'b.md', 'c.md']);
    expect(loaded?.dir).toBe('/tmp/example-brain');
  });

  test('serializes completedPaths sorted (deterministic output)', () => {
    saveCheckpoint(cpPath, {
      dir: '/tmp/example-brain',
      completedPaths: ['z.md', 'a.md', 'm.md'],
      timestamp: '2026-05-14T00:00:00Z',
    });
    const onDisk = JSON.parse(readFileSync(cpPath, 'utf-8'));
    expect(onDisk.completedPaths).toEqual(['a.md', 'm.md', 'z.md']);
  });

  test('atomic-ish write — no stray .tmp file after success', () => {
    saveCheckpoint(cpPath, {
      dir: '/tmp/example-brain',
      completedPaths: ['a.md'],
      timestamp: '2026-05-14T00:00:00Z',
    });
    expect(existsSync(cpPath)).toBe(true);
    expect(existsSync(`${cpPath}.tmp`)).toBe(false);
  });

  test('non-fatal on write failure (path under non-existent dir)', () => {
    // Should NOT throw, just silently skip the write.
    const badPath = join(workDir, 'does-not-exist', 'cp.json');
    expect(() =>
      saveCheckpoint(badPath, {
        dir: '/tmp/example-brain',
        completedPaths: ['a.md'],
        timestamp: '2026-05-14T00:00:00Z',
      }),
    ).not.toThrow();
    expect(existsSync(badPath)).toBe(false);
  });
});

describe('resumeFilter', () => {
  test('empty completed set returns all files unchanged', () => {
    const all = ['a.md', 'b.md', 'c.md'];
    expect(resumeFilter(all, '/tmp/example-brain', new Set())).toEqual(all);
  });

  test('completed set filters matching paths out', () => {
    const all = ['a.md', 'b.md', 'c.md'];
    const completed = new Set(['b.md']);
    expect(resumeFilter(all, '/tmp/example-brain', completed)).toEqual(['a.md', 'c.md']);
  });

  test('absolute paths get normalized to relative for lookup', () => {
    const all = [
      '/tmp/example-brain/meetings/2026-05-13.md',
      '/tmp/example-brain/concepts/a.md',
    ];
    const completed = new Set(['meetings/2026-05-13.md']);
    expect(resumeFilter(all, '/tmp/example-brain', completed)).toEqual([
      '/tmp/example-brain/concepts/a.md',
    ]);
  });

  test('mixed absolute and relative inputs both work', () => {
    const all = [
      '/tmp/example-brain/a.md',
      'b.md',
      '/tmp/example-brain/c.md',
    ];
    const completed = new Set(['a.md', 'c.md']);
    expect(resumeFilter(all, '/tmp/example-brain', completed)).toEqual(['b.md']);
  });

  test('full match returns empty array', () => {
    const all = ['a.md', 'b.md'];
    const completed = new Set(['a.md', 'b.md']);
    expect(resumeFilter(all, '/tmp/example-brain', completed)).toEqual([]);
  });
});

describe('clearCheckpoint', () => {
  test('removes the checkpoint file when present', () => {
    writeFileSync(cpPath, '{}');
    expect(existsSync(cpPath)).toBe(true);
    clearCheckpoint(cpPath);
    expect(existsSync(cpPath)).toBe(false);
  });

  test('is a no-op when the checkpoint file is missing', () => {
    expect(existsSync(cpPath)).toBe(false);
    expect(() => clearCheckpoint(cpPath)).not.toThrow();
  });
});
