/**
 * Case-insensitive-filesystem collision guard for the shared write-through
 * helper (src/core/write-through.ts, #2831).
 *
 * On Windows and default-configuration macOS (case-insensitive APFS), a file
 * whose name differs from the target only in case collapses to the SAME
 * inode as the target — the atomic write in `writePageThrough` would
 * silently destroy whatever content already lived at the differently-cased
 * path. This suite constructs the collision condition explicitly (via
 * `fs.writeFileSync` at a differently-cased sibling path) rather than
 * relying on the test-runner's actual filesystem being case-insensitive,
 * since CI typically runs on case-sensitive Linux where the collision would
 * never occur naturally.
 *
 * Covers exactly the three cases from the issue's "Verification" section:
 *   (a) differently-cased collision → detected and refused
 *   (b) exact-case match → not flagged, write proceeds normally (in-place update)
 *   (c) brand-new file → not flagged, write proceeds normally
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { writePageThrough } from '../src/core/write-through.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { resolvePageFilePath } from '../src/core/markdown.ts';

let engine: PGLiteEngine;
let tmpRoot: string;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  resetGateway();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-wt-case-'));
  brainDir = path.join(tmpRoot, 'brain');
  fs.mkdirSync(brainDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function seedPage(slug: string): Promise<void> {
  await importFromContent(engine, slug, `---\ntitle: T\ntype: note\n---\n\n# Body ${slug}\n`, {
    noEmbed: true,
    sourceId: 'default',
    sourcePath: `${slug}.md`,
  });
}

describe('writePageThrough — case-insensitive collision guard (#2831)', () => {
  test('(a) differently-cased existing file → detected and refused, original untouched', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'docs/ops/existing-doc';
    await seedPage(slug);

    const expectedPath = resolvePageFilePath(brainDir, slug, 'default');
    const collidingPath = path.join(path.dirname(expectedPath), 'EXISTING-DOC.md');
    fs.mkdirSync(path.dirname(collidingPath), { recursive: true });
    const originalContent = '# A human-authored bug report, not written by gbrain\n';
    fs.writeFileSync(collidingPath, originalContent, 'utf8');

    const res = await writePageThrough(engine, slug, { sourceId: 'default' });

    expect(res).toEqual({ written: false, skipped: 'case_insensitive_collision' });
    // The pre-existing, differently-cased file is completely untouched — the
    // whole point of the guard. (We deliberately don't assert
    // `existsSync(expectedPath)` here: on a case-insensitive filesystem like
    // macOS's default APFS — the exact environment this bug targets —
    // `expectedPath` and `collidingPath` resolve to the SAME inode, so
    // `existsSync(expectedPath)` legitimately returns true without gbrain
    // having written anything. The content check below is what matters.)
    expect(fs.readFileSync(collidingPath, 'utf8')).toBe(originalContent);
    // No stray temp sibling leaked.
    expect(
      fs.readdirSync(path.dirname(expectedPath)).some((f) => f.includes('.tmp.')),
    ).toBe(false);
  });

  test('(b) exact-case match (in-place update) → not flagged, write proceeds normally', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'docs/ops/repeat-update';
    await seedPage(slug);

    const expectedPath = resolvePageFilePath(brainDir, slug, 'default');

    // First write creates the file.
    const first = await writePageThrough(engine, slug, { sourceId: 'default' });
    expect(first.written).toBe(true);
    expect(first.path).toBe(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);

    // Second write to the SAME exact-case path is a normal in-place update,
    // not a collision — must not be flagged.
    const second = await writePageThrough(engine, slug, { sourceId: 'default' });
    expect(second.written).toBe(true);
    expect(second.skipped).toBeUndefined();
    expect(second.path).toBe(expectedPath);
  });

  test('(c) brand-new file, no sibling at all → not flagged, write proceeds normally', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'docs/ops/brand-new-note';
    await seedPage(slug);

    const expectedPath = resolvePageFilePath(brainDir, slug, 'default');
    expect(fs.existsSync(path.dirname(expectedPath))).toBe(false);

    const res = await writePageThrough(engine, slug, { sourceId: 'default' });

    expect(res.written).toBe(true);
    expect(res.skipped).toBeUndefined();
    expect(res.path).toBe(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);
  });

  test('(d) differently-cased PARENT DIRECTORY (not just basename) → detected and refused', async () => {
    // Regression case for a narrower version of this guard that only checked
    // the final basename within readdirSync(dirname(filePath)): if an
    // existing tree has `Docs/ops/existing-parent-case.md` and the target is
    // `docs/ops/existing-parent-case.md`, the basename ("existing-parent-case.md")
    // matches EXACTLY — the case mismatch is one level up, in the directory
    // name. A basename-only check never sees this, because on a
    // case-insensitive filesystem `existsSync('.../docs/ops')` already
    // resolves to the SAME physical directory as `.../Docs/ops` before
    // readdirSync ever runs, so readdirSync(targetDir) returns the real,
    // exactly-matching basename. The guard must walk every path component
    // from the write root down, not just check the final directory's listing.
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'docs/ops/existing-parent-case';
    await seedPage(slug);

    const expectedPath = resolvePageFilePath(brainDir, slug, 'default');
    // Existing tree uses `Docs/ops/...` (capital D) — the exact basename, but
    // a differently-cased grandparent directory.
    const collidingDir = path.join(brainDir, 'Docs', 'ops');
    fs.mkdirSync(collidingDir, { recursive: true });
    const collidingPath = path.join(collidingDir, path.basename(expectedPath));
    const originalContent = '# Pre-existing file under a differently-cased directory\n';
    fs.writeFileSync(collidingPath, originalContent, 'utf8');

    const res = await writePageThrough(engine, slug, { sourceId: 'default' });

    expect(res).toEqual({ written: false, skipped: 'case_insensitive_collision' });
    expect(fs.readFileSync(collidingPath, 'utf8')).toBe(originalContent);
  });

  test('unrelated sibling files in the same directory do not trigger a false positive', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'docs/ops/target-note';
    await seedPage(slug);

    const expectedPath = resolvePageFilePath(brainDir, slug, 'default');
    fs.mkdirSync(path.dirname(expectedPath), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(expectedPath), 'unrelated-file.md'), 'unrelated', 'utf8');

    const res = await writePageThrough(engine, slug, { sourceId: 'default' });

    expect(res.written).toBe(true);
    expect(res.skipped).toBeUndefined();
    expect(fs.existsSync(expectedPath)).toBe(true);
  });
});
