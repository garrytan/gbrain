/**
 * `gbrain frontmatter validate` derives a page's expected slug from its path
 * under the brain root (src/commands/frontmatter.ts). A first folder named
 * `..drafts` is a legal folder, so its path must be used as written.
 *
 * Authoring gate:
 * 1. Protects: a page at `..drafts/note.md` whose `slug:` matches its path is
 *    reported clean, and a mismatching slug is still reported; a file that is
 *    not under a brain (a loose folder, or a sibling folder that shares the
 *    brain's name prefix) is still judged by its file name alone.
 * 2. Regression that fails it: the "outside the brain root" test matching any
 *    relative path that starts with the two characters `..` instead of only a
 *    `..` path component. That swaps the slug for the bare file name and
 *    reports a false SLUG_MISMATCH.
 * 3. Why existing coverage misses it: frontmatter-fix-slug-5053.test.ts and
 *    frontmatter-cli.test.ts only use ordinary folder names.
 *    Bulk scans skip dot-folders by design, so the page is reached by naming
 *    the file (or the folder) explicitly.
 * 4. Production seam: none. runFrontmatter is driven in-process on real temp
 *    dirs, the same way frontmatter-cli.test.ts does.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { runFrontmatter } from '../src/commands/frontmatter.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { withEnv } from './helpers/with-env.ts';

const page = (slug: string) => `---\ntype: note\ntitle: A note\nslug: ${slug}\n---\n\nbody\n`;

let scratch: string;
let brain: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'fm-dotdot-'));
  brain = join(scratch, 'brain');
  mkdirSync(join(brain, '.git'), { recursive: true });
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface FileResult { file: string; errors: Array<{ code: string; message: string }> }

/** Run `frontmatter validate <target> --json` in-process; return the per-file results. */
async function validate(target: string): Promise<FileResult[]> {
  const logOrig = console.log;
  const out: string[] = [];
  const prevExitCode = process.exitCode;
  _resetCliExitVerdictForTests();
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  try {
    await withEnv({ GBRAIN_HOME: join(scratch, 'home') }, () => runFrontmatter(['validate', target, '--json']));
  } finally {
    console.log = logOrig;
    _resetCliExitVerdictForTests();
    process.exitCode = prevExitCode ?? 0;
  }
  const doc = JSON.parse(out.join('\n')) as { results?: FileResult[]; files?: FileResult[] };
  return (doc.results ?? doc.files ?? []) as FileResult[];
}

const codes = (r: FileResult[]) => r.flatMap(f => f.errors.map(e => e.code));

describe('frontmatter validate with a first folder whose name starts with two dots', () => {
  test('a slug that matches the ..drafts path is clean', async () => {
    mkdirSync(join(brain, '..drafts'), { recursive: true });
    const file = join(brain, '..drafts', 'note.md');
    writeFileSync(file, page('..drafts/note'));
    const results = await validate(file);
    expect(results).toHaveLength(1);
    expect(codes(results)).toEqual([]);
  });

  test('a slug that does not match the ..drafts path is still reported', async () => {
    mkdirSync(join(brain, '..drafts'), { recursive: true });
    const file = join(brain, '..drafts', 'note.md');
    writeFileSync(file, page('other/thing'));
    expect(codes(await validate(file))).toEqual(['SLUG_MISMATCH']);
  });
});

describe('frontmatter validate still judges a file outside a brain by its file name', () => {
  test('a loose file keeps a slug that matches its file name', async () => {
    const loose = join(scratch, 'loose');
    mkdirSync(loose);
    const file = join(loose, 'note.md');
    writeFileSync(file, page('note'));
    expect(codes(await validate(file))).toEqual([]);
  });

  test('a file in a sibling folder that shares the brain name prefix is not read as part of the brain', async () => {
    const sibling = join(scratch, 'brain2');
    mkdirSync(sibling);
    const file = join(sibling, 'note.md');
    writeFileSync(file, page('note'));
    expect(codes(await validate(file))).toEqual([]);
  });

  test('a file in a ..loose folder with no brain above it keeps a slug that matches its file name', async () => {
    const loose = join(scratch, '..loose');
    mkdirSync(loose);
    const file = join(loose, 'note.md');
    writeFileSync(file, page('note'));
    expect(codes(await validate(file))).toEqual([]);
  });
});
