/**
 * #6712 PR 4b fix 3: a level asks for the parser a page at each path records (sync-holds.ts `syncImportParsers`), and
 * looks a file name's suffix up once per level instead of testing every image and code extension per path.
 *
 * Protects: the per-level lookup returns, for every path, the parser `syncImportParserFor` returns, and one object per
 * kind: for every image and code extension in either case, Markdown, no dot, a dot in a directory name, several dots,
 * a dotted directory followed by an extension, and with or without a schema pack; a suffix seen first under one path
 * answers alike for every later path that shares it.
 */
import { expect, test } from 'bun:test';
import { syncImportParserFor, syncImportParsers } from '../src/core/persistence/sync-holds.ts';
import { CODE_EXTENSIONS } from '../src/core/sync.ts';

const IMAGES = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.heif', '.avif'];

test('the per-level lookup returns the parser syncImportParserFor returns, one object per kind', () => {
  const paths = ['', '.', 'README', 'a.', 'notes/a.md', 'notes/a.MD', 'dir.ts/file', 'dir.png/file.md', 'dir.md/file.ts', 'x.d.ts', 'a.tar.gz', '.ts', 'v1.2/notes', 'x.\u212At'];
  for (const ext of [...CODE_EXTENSIONS, ...IMAGES, '.md', '.mdx']) for (const stem of ['a', 'dir/a', 'dir.v2/a.b'])
    paths.push(stem + ext, stem + ext.toUpperCase(), `${stem}${ext}/inner`, stem + ext.slice(0, -1));
  for (const pack of [null, 'pack-a']) {
    const lookup = syncImportParsers(pack), seen = new Map<string, ReturnType<typeof syncImportParserFor>>();
    for (const order of [paths, [...paths].reverse()]) for (const path of order) {
      const got = lookup(path), want = syncImportParserFor(path, pack);
      expect({ path, got }).toEqual({ path, got: want });
      const key = JSON.stringify(want);
      if (!seen.has(key)) seen.set(key, got);
      expect(got).toBe(seen.get(key)!);
    }
    expect(seen.size).toBe(3);
  }
});
