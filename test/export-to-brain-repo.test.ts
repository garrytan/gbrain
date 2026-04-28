/**
 * Block 7-2 — DB → markdown reconciliation for remote MCP writes.
 *
 * Pins the safety + idempotency contract of exportToBrainRepo:
 *   - opt-in via GBRAIN_BRAIN_ROOT env var
 *   - refuses to clobber sync-managed files (<!-- sync:end -->)
 *   - refuses to clobber raw-import-prefix slugs (daily/email/, etc.)
 *   - skips when serialized content is byte-identical (no spurious diffs)
 *   - writes new files atomically (temp + rename), creating parent dirs
 *   - blocks path-traversal attempts (resolve outside root)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { exportToBrainRepo } from '../src/core/operations.ts';

let root: string;
let originalRoot: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-export-test-'));
  originalRoot = process.env.GBRAIN_BRAIN_ROOT;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (originalRoot === undefined) delete process.env.GBRAIN_BRAIN_ROOT;
  else process.env.GBRAIN_BRAIN_ROOT = originalRoot;
});

const samplePage = {
  type: 'concept' as const,
  title: 'Sample Concept',
  compiled_truth: 'Body text here.',
  timeline: '',
  frontmatter: {},
  tags: ['x'],
};

describe('exportToBrainRepo (Block 7-2)', () => {
  test('skips when GBRAIN_BRAIN_ROOT is unset', () => {
    delete process.env.GBRAIN_BRAIN_ROOT;
    const r = exportToBrainRepo('concepts/foo', samplePage);
    expect(r).toEqual({ skipped: 'no_brain_root' });
  });

  test('skips when GBRAIN_BRAIN_ROOT is relative (must be absolute)', () => {
    process.env.GBRAIN_BRAIN_ROOT = './relative/path';
    const r = exportToBrainRepo('concepts/foo', samplePage);
    expect(r).toEqual({ skipped: 'brain_root_not_absolute' });
  });

  test('writes a new file atomically and creates parent dirs', () => {
    process.env.GBRAIN_BRAIN_ROOT = root;
    const r = exportToBrainRepo('concepts/foo', samplePage);
    expect(r).toMatchObject({ exported: true });
    const target = join(root, 'concepts/foo.md');
    expect(existsSync(target)).toBe(true);
    const written = readFileSync(target, 'utf-8');
    expect(written).toContain('title: Sample Concept');
    expect(written).toContain('Body text here.');
    // No leftover temp files.
    const conceptsDir = join(root, 'concepts');
    expect(readdirSync(conceptsDir)).toEqual(['foo.md']);
  });

  test('skips when content is byte-identical to existing file (no spurious diffs)', () => {
    process.env.GBRAIN_BRAIN_ROOT = root;
    // First write
    exportToBrainRepo('concepts/foo', samplePage);
    // Second write with identical content
    const r = exportToBrainRepo('concepts/foo', samplePage);
    expect(r).toEqual({ skipped: 'unchanged' });
  });

  test('overwrites when content differs (atomic temp+rename)', () => {
    process.env.GBRAIN_BRAIN_ROOT = root;
    exportToBrainRepo('concepts/foo', samplePage);
    const r = exportToBrainRepo('concepts/foo', { ...samplePage, compiled_truth: 'Different body.' });
    expect(r).toMatchObject({ exported: true });
    const written = readFileSync(join(root, 'concepts/foo.md'), 'utf-8');
    expect(written).toContain('Different body.');
  });

  test('refuses to clobber sync-managed files (<!-- sync:end -->)', () => {
    process.env.GBRAIN_BRAIN_ROOT = root;
    const target = join(root, 'meetings/2026-04-26-test.md');
    mkdirSync(join(root, 'meetings'), { recursive: true });
    writeFileSync(target, `---\ntitle: Meeting\n---\n\n<!-- sync:end -->\n\nManual notes here.`, 'utf-8');
    const r = exportToBrainRepo('meetings/2026-04-26-test', { ...samplePage, type: 'meeting' as const, title: 'Meeting' });
    expect(r).toEqual({ skipped: 'sync_managed' });
    // File untouched.
    expect(readFileSync(target, 'utf-8')).toContain('Manual notes here.');
  });

  test.each([
    ['daily/email/foo', 'daily/email/'],
    ['daily/calendar/personal/2026/04/26/x', 'daily/calendar/'],
    ['sources/contacts/raymond', 'sources/contacts/'],
    ['sources/meetings/2026-04-26-test', 'sources/meetings/'],
  ])('refuses raw-import prefix slug %s', (slug) => {
    process.env.GBRAIN_BRAIN_ROOT = root;
    const r = exportToBrainRepo(slug, samplePage);
    expect(r).toEqual({ skipped: 'raw_import_path' });
  });

  test('blocks path-traversal in slug (e.g. ../../etc/passwd)', () => {
    process.env.GBRAIN_BRAIN_ROOT = root;
    const r = exportToBrainRepo('../../etc/passwd', samplePage);
    expect(r).toEqual({ skipped: 'path_traversal_blocked' });
  });
});
