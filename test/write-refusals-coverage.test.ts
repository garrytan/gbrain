/**
 * Fix wave 4: every write error code a receipt can report has a row in
 * docs/guides/write-refusals.md (in its Reason or Error code cell), so a new
 * code cannot ship without its meaning and recovery.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WRITE_ERROR_CODES } from '../src/core/persistence/types.ts';

const doc = readFileSync(join(import.meta.dir, '..', 'docs', 'guides', 'write-refusals.md'), 'utf8');
const codeCells = doc.split('\n')
  .filter(line => line.startsWith('| ') && !line.startsWith('| ---') && !line.startsWith('| Reason |'))
  .map(line => line.split(' | ').slice(0, 2).join(' | '));

test('every WRITE_ERROR_CODES member has a write-refusals row', () => {
  expect(WRITE_ERROR_CODES.filter(code => !codeCells.some(cells => cells.includes(`\`${code}\``)))).toEqual([]);
});

test('the fix wave 4 refusal codes carry anchors their hints link to', () => {
  for (const anchor of ['checkpoint-validation-timeout', 'invalid-connector-text', 'connector-holds-exhausted', 'connector-fence-below-timeline', 'migrations_running', 'writer_deactivate']) {
    expect(doc).toContain(`<a id="${anchor}"></a>`);
  }
});

test('every write-refusals anchor that source code links to exists', () => {
  const glob = new Bun.Glob('src/**/*.ts');
  const anchors = new Set<string>();
  for (const path of glob.scanSync({ cwd: join(import.meta.dir, '..') })) {
    const text = readFileSync(join(import.meta.dir, '..', path), 'utf8');
    for (const m of text.matchAll(/write-refusals\.md#([A-Za-z0-9_-]+)/g)) anchors.add(m[1]);
    for (const m of text.matchAll(/docsAnchor\('([a-z_]+)'\)/g)) anchors.add(m[1].replaceAll('_', '-'));
  }
  const headings = new Set(doc.split('\n').filter(line => /^#+ /.test(line))
    .map(line => line.replace(/^#+ /, '').toLowerCase().replace(/[^a-z0-9 _-]/g, '').replaceAll(' ', '-')));
  expect([...anchors].filter(anchor => !doc.includes(`<a id="${anchor}"></a>`) && !headings.has(anchor)).sort()).toEqual([]);
});
