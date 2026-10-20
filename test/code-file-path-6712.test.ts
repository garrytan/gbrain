/**
 * #6712 PR 4b fix 3: `isCodeFilePath` looks up the suffix from the path's last dot instead of testing every extension
 * (a 308k-path level asks it once per path). Each extension is a dot and a dot-free suffix, so a path ends with one of
 * them exactly when that suffix is one.
 *
 * Protects: the lookup answers as the loop over `CODE_EXTENSIONS` with `endsWith` did, for every extension in any case,
 * after one or several dots, after a dotted directory, inside a longer suffix, without a dot, and for the empty path.
 */
import { expect, test } from 'bun:test';
import { CODE_EXTENSIONS, isCodeFilePath } from '../src/core/sync.ts';

const byLoop = (path: string) => [...CODE_EXTENSIONS].some(ext => path.toLowerCase().endsWith(ext));

test('every extension is a dot and a dot-free suffix', () => {
  expect([...CODE_EXTENSIONS].filter(ext => !/^\.[^./]+$/.test(ext))).toEqual([]);
});

test('the suffix lookup answers as the loop over every extension', () => {
  const paths = ['', '.', 'README', 'Makefile', 'a.', 'dir.ts/file', 'dir.ts/file.md', 'notes/a.md', 'img/x.png', 'x.d.ts', 'x.test.TSX', 'a.tfvars.bak', 'a.bak.tfvars',
    '.ts', '..ts', 'src/.eslintrc.json', 'x.mdx', 'x.json5', 'x.c.md', 'x.md.c', 'x.sql~', 'x.\u212At'];
  for (const ext of CODE_EXTENSIONS) for (const stem of ['a', 'dir/a', 'dir.v2/a.b', '']) for (const tail of ['', 'x', '.md', '/x'])
    paths.push(stem + ext + tail, stem + ext.toUpperCase() + tail, stem + ext.slice(0, -1) + tail);
  const differ = paths.filter(path => isCodeFilePath(path) !== byLoop(path));
  expect(differ).toEqual([]);
  expect(paths.filter(isCodeFilePath).length).toBeGreaterThan(CODE_EXTENSIONS.size * 4);
});
