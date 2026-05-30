/**
 * Shared write-through helper tests (src/core/write-through.ts).
 *
 * Covers the skip/error branches and the atomic-write guarantee. The helper is
 * the canonical disk sink shared by `put_page` and `gbrain brainstorm/lsd
 * --save`, extracted from the v0.38 put_page write-through and upgraded to write
 * atomically (.tmp + rename).
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
import { serializePageToMarkdown, resolvePageFilePath } from '../src/core/markdown.ts';

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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-wt-helper-'));
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

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

describe('writePageThrough', () => {
  test('writes the file rendered from the saved row; no .tmp leftover', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'wiki/ideas/2026-01-01-lsd-foo-abc123';
    await seedPage(slug);

    const res = await writePageThrough(engine, slug, {
      sourceId: 'default',
      frontmatterOverrides: { source_kind: 'lsd' },
    });

    expect(res.written).toBe(true);
    const expectedPath = resolvePageFilePath(brainDir, slug, 'default');
    expect(res.path).toBe(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);

    // Content is the canonical serialization of the saved row (the file is
    // rendered FROM the row, so the sinks can't diverge).
    const page = await engine.getPage(slug, { sourceId: 'default' });
    const tags = await engine.getTags(slug, { sourceId: 'default' });
    const expected = serializePageToMarkdown(page!, tags, {
      frontmatterOverrides: { source_kind: 'lsd' },
    });
    expect(fs.readFileSync(expectedPath, 'utf8')).toBe(expected);

    // Atomic write left no temp sibling.
    const dir = path.dirname(expectedPath);
    expect(fs.readdirSync(dir).some((f) => f.includes('.tmp.'))).toBe(false);
  });

  test('no sync.repo_path → skipped no_repo_configured', async () => {
    await engine.setConfig('sync.repo_path', '');
    const slug = 'wiki/ideas/x-1';
    await seedPage(slug);
    const res = await writePageThrough(engine, slug);
    expect(res).toEqual({ written: false, skipped: 'no_repo_configured' });
  });

  test('sync.repo_path is a file, not a directory → skipped repo_not_found', async () => {
    const fileAsRepo = path.join(tmpRoot, 'not-a-dir');
    fs.writeFileSync(fileAsRepo, 'x');
    await engine.setConfig('sync.repo_path', fileAsRepo);
    const slug = 'wiki/ideas/x-2';
    await seedPage(slug);
    const res = await writePageThrough(engine, slug);
    expect(res).toEqual({ written: false, skipped: 'repo_not_found' });
  });

  test('row missing → skipped page_not_found_after_write', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const res = await writePageThrough(engine, 'wiki/ideas/does-not-exist');
    expect(res).toEqual({ written: false, skipped: 'page_not_found_after_write' });
  });

  test('[REGRESSION] mkdir ENOTDIR (parent is a file) → error, no partial .md, no .tmp', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    // Block the `wiki/` directory by putting a FILE named "wiki" under the repo,
    // so `mkdir -p <repo>/wiki/ideas` throws ENOTDIR deterministically.
    fs.writeFileSync(path.join(brainDir, 'wiki'), 'blocker');
    const slug = 'wiki/ideas/blocked-1';
    await seedPage(slug);

    const res = await writePageThrough(engine, slug, { sourceId: 'default' });

    expect(res.written).toBe(false);
    expect(typeof res.error).toBe('string');
    const files = walkFiles(brainDir);
    expect(files.some((f) => f.endsWith('.md'))).toBe(false);
    expect(files.some((f) => f.includes('.tmp.'))).toBe(false);
  });
});
