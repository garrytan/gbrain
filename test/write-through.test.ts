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

  test('[REGRESSION twin] honors the recorded source_path instead of minting a slug-named twin', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    // A human-authored vault file whose on-disk name is NOT its slug — the
    // normal case for Obsidian (Title Case, spaces) once slugified.
    const slug = 'library/people/steve-jobs';
    const authored = 'Library/People/Steve Jobs.md';
    await importFromContent(engine, slug, `---\ntitle: Steve Jobs\ntype: person\n---\n\n# Body\n`, {
      noEmbed: true,
      sourceId: 'default',
      sourcePath: authored,
    });
    fs.mkdirSync(path.join(brainDir, 'Library', 'People'), { recursive: true });
    fs.writeFileSync(path.join(brainDir, authored), 'stale\n');

    const res = await writePageThrough(engine, slug, { sourceId: 'default' });

    expect(res.written).toBe(true);
    expect(res.path).toBe(path.join(brainDir, authored));
    // The authored file was UPDATED in place...
    expect(fs.readFileSync(path.join(brainDir, authored), 'utf8')).not.toBe('stale\n');
    // ...and no slug-derived twin appeared anywhere in the tree.
    const twin = resolvePageFilePath(brainDir, slug, 'default');
    expect(fs.existsSync(twin)).toBe(false);
    expect(walkFiles(brainDir).sort()).toEqual([path.join(brainDir, authored)]);
  });

  test('[REGRESSION twin] null source_path still falls back to the slug-derived path', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'inbox/2026-01-01-abc123';
    // Born via put/capture: no file of record, so source_path stays NULL.
    await importFromContent(engine, slug, `---\ntitle: T\ntype: note\n---\n\n# Body\n`, {
      noEmbed: true,
      sourceId: 'default',
    });

    const res = await writePageThrough(engine, slug, { sourceId: 'default' });

    expect(res.written).toBe(true);
    expect(res.path).toBe(resolvePageFilePath(brainDir, slug, 'default'));
  });

  test('[REGRESSION twin] falls back to a contained file:// source_uri when source_path is null (capture --file of a vault file)', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'library/companies/postiz';
    const authored = 'Library/Companies/Postiz.md';
    // `capture --file` records the absolute path as source_uri and leaves
    // source_path NULL — the exact shape that used to mint a twin.
    await importFromContent(engine, slug, `---\ntitle: Postiz\ntype: company\n---\n\n# Body\n`, {
      noEmbed: true,
      sourceId: 'default',
    });
    await engine.executeRaw(`UPDATE pages SET source_uri = $1 WHERE slug = $2`, [
      `file://${path.join(brainDir, authored)}`,
      slug,
    ]);
    fs.mkdirSync(path.join(brainDir, 'Library', 'Companies'), { recursive: true });
    fs.writeFileSync(path.join(brainDir, authored), 'stale\n');

    const res = await writePageThrough(engine, slug, { sourceId: 'default' });

    expect(res.written).toBe(true);
    expect(res.path).toBe(path.join(brainDir, authored));
    // NB: no `existsSync(slug path)` assertion here — this slug differs from the
    // authored name only by CASE, so a case-insensitive FS (macOS/Windows) folds
    // the two and existsSync would report a twin that isn't there. walkFiles
    // enumerates real directory entries, so it is case-truthful on every FS.
    expect(walkFiles(brainDir).sort()).toEqual([path.join(brainDir, authored)]);
  });

  test('[REGRESSION twin] a file:// source_uri OUTSIDE the repo is ignored', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'inbox/from-elsewhere';
    await importFromContent(engine, slug, `---\ntitle: T\ntype: note\n---\n\n# Body\n`, {
      noEmbed: true,
      sourceId: 'default',
    });
    // A file captured from outside the brain repo has no file of record inside it.
    await engine.executeRaw(`UPDATE pages SET source_uri = $1 WHERE slug = $2`, [
      `file://${path.join(tmpRoot, 'outside', 'Notes.md')}`,
      slug,
    ]);

    const res = await writePageThrough(engine, slug, { sourceId: 'default' });

    expect(res.written).toBe(true);
    expect(res.path).toBe(resolvePageFilePath(brainDir, slug, 'default'));
    expect(fs.existsSync(path.join(tmpRoot, 'outside', 'Notes.md'))).toBe(false);
  });

  test('[REGRESSION twin] a traversing source_path is ignored, not joined', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'wiki/ideas/hostile-1';
    await importFromContent(engine, slug, `---\ntitle: T\ntype: note\n---\n\n# Body\n`, {
      noEmbed: true,
      sourceId: 'default',
      sourcePath: `${slug}.md`,
    });
    // Simulate a hostile / corrupted row after the fact.
    await engine.executeRaw(`UPDATE pages SET source_path = $1 WHERE slug = $2`, [
      '../../escaped.md',
      slug,
    ]);

    const res = await writePageThrough(engine, slug, { sourceId: 'default' });

    // Falls back to the slug path rather than escaping the write root.
    expect(res.written).toBe(true);
    expect(res.path).toBe(resolvePageFilePath(brainDir, slug, 'default'));
    expect(fs.existsSync(path.join(tmpRoot, '..', 'escaped.md'))).toBe(false);
  });

  test('[REGRESSION #2018] default page (null local_path) in a multi-source brain → skipped, no leak into a sibling source repo', async () => {
    // A sibling federated source with its OWN working tree.
    const siblingDir = path.join(tmpRoot, 'housefax');
    fs.mkdirSync(siblingDir, { recursive: true });
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config) VALUES ('housefax', 'Housefax', $1, '{}'::jsonb)`,
      [siblingDir],
    );
    // The leak trigger: global sync.repo_path points at the sibling's tree
    // while the default source (re-seeded by resetPgliteState) has no
    // local_path of its own.
    await engine.setConfig('sync.repo_path', siblingDir);

    const slug = 'internal/cross-cutting-note';
    await seedPage(slug); // sourceId 'default'

    const res = await writePageThrough(engine, slug, { sourceId: 'default' });

    expect(res).toEqual({ written: false, skipped: 'source_repo_belongs_to_other_source' });
    // The sibling source's repo stays clean — the whole point of #2018.
    expect(walkFiles(siblingDir).some((f) => f.endsWith('.md'))).toBe(false);
  });

  test('[#2018] page assigned to a source with its own local_path writes to that tree root, not the global path', async () => {
    const alphaDir = path.join(tmpRoot, 'alpha-repo');
    fs.mkdirSync(alphaDir, { recursive: true });
    const globalDir = path.join(tmpRoot, 'global-repo');
    fs.mkdirSync(globalDir, { recursive: true });
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config) VALUES ('alpha', 'Alpha', $1, '{}'::jsonb)`,
      [alphaDir],
    );
    // Must NOT be used — the assigned source has its own tree.
    await engine.setConfig('sync.repo_path', globalDir);

    const slug = 'notes/alpha-thing';
    await importFromContent(engine, slug, `---\ntitle: T\ntype: note\n---\n\n# Body\n`, {
      noEmbed: true,
      sourceId: 'alpha',
      sourcePath: `${slug}.md`,
    });

    const res = await writePageThrough(engine, slug, { sourceId: 'alpha' });

    expect(res.written).toBe(true);
    // File at the source's tree ROOT, never nested under `.sources/<id>/`.
    expect(res.path).toBe(path.join(alphaDir, `${slug}.md`));
    expect(fs.existsSync(path.join(alphaDir, `${slug}.md`))).toBe(true);
    // The global repo path is untouched.
    expect(walkFiles(globalDir).some((f) => f.endsWith('.md'))).toBe(false);
  });

  test('[REGRESSION #2831] differently-cased entry occupying the target → skipped case_insensitive_collision, existing file untouched', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'wiki/ideas/note';
    await seedPage(slug);

    // A differently-cased file already occupies the target path's fold slot
    // (e.g. an uncontrolled repo file, or another slug's normalization
    // variant). On macOS/Windows the FS resolves `note.md` to it.
    const dir = path.join(brainDir, 'wiki', 'ideas');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'NOTE.md'), 'precious existing content');

    // Detect whether THIS filesystem folds case (macOS/Windows: yes; Linux
    // CI: no — there the two names are distinct files and no guard fires).
    const caseInsensitiveFs = fs.existsSync(path.join(dir, 'note.md'));

    const res = await writePageThrough(engine, slug, { sourceId: 'default' });

    if (caseInsensitiveFs) {
      expect(res).toEqual({ written: false, skipped: 'case_insensitive_collision' });
      // The pre-existing file was NOT clobbered — the whole point of #2831.
      expect(fs.readFileSync(path.join(dir, 'NOTE.md'), 'utf8')).toBe('precious existing content');
    } else {
      expect(res.written).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'NOTE.md'), 'utf8')).toBe('precious existing content');
      expect(fs.existsSync(path.join(dir, 'note.md'))).toBe(true);
    }
  });

  test('[#2831] exact-case rewrite of the same slug still updates (guard falls through)', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'wiki/ideas/rewrite-me';
    await seedPage(slug);

    const first = await writePageThrough(engine, slug, { sourceId: 'default' });
    expect(first.written).toBe(true);
    const second = await writePageThrough(engine, slug, { sourceId: 'default' });
    expect(second.written).toBe(true);
    expect(second.path).toBe(first.path);
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
