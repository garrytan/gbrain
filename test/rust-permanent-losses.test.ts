/**
 * The named permanent losses of the Rust engine (docs/designs/RUST_ENGINE.md, "Named permanent losses") name real
 * parity cases, and each listed case points back to its row.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every row of the table names a parity file under test/engine-parity/ and a case that file defines, and
 *    every listed case carries the section reference in its body, so a reader of the stop finds why it stays stopped.
 *    Files another branch still edits (PENDING) are exempt until that branch lands.
 *  - Regression: a stopped case that is SQL-only by design had no written reason, so each owner scan had to read the case
 *    again to tell a by-design stop from a gap; a renamed or deleted case would leave a stale row.
 *  - Why existing coverage misses it: rust-tally.tsv pins only the stop counts per file, not why a case stops.
 *  - Seam: none (pure; reads the design doc and the parity files).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const REF = 'RUST_ENGINE.md#named-permanent-losses';
/** Files another head still edits (batch 16, 1707738cb1 splits these cases and gives them these names); their checks and
 * references land with that head, so the rows are checked by hand until then. */
const PENDING = new Set(['fact-purge-sites.test.ts']);

function rows(): Array<{ file: string; name: string }> {
  // test-reads-source-ok[structural]: the loss table is the documented contract, so the test reads it as written.
  const doc = readFileSync(join(ROOT, 'docs/designs/RUST_ENGINE.md'), 'utf8');
  const section = doc.slice(doc.indexOf('### Named permanent losses'), doc.indexOf('### Error contract for the Rust engine'));
  return section.split('\n').filter(line => /^\| `[a-z0-9-]+\.test\.ts` \|/.test(line))
    .map(line => { const cells = line.split(' | '); return { file: cells[0]!.replace(/^\| `|`$/g, ''), name: cells[1]!.trim() }; });
}

/** The body of the parity case `name` in `file`, from its `parityTest(` to the next one. */
function caseBody(file: string, name: string): string | null {
  // test-reads-source-ok[structural]: the reference must sit in the case's source text, where a reader of the stop looks.
  const src = readFileSync(join(ROOT, 'test/engine-parity', file), 'utf8');
  const quoted = `'${name.replace(/'/g, "\\'")}'`;
  const at = src.indexOf(quoted);
  if (at < 0 || !/parityTest\(\s*$/.test(src.slice(Math.max(0, at - 40), at))) return null;
  const next = src.indexOf('parityTest(', at);
  return src.slice(at, next < 0 ? undefined : next);
}

describe('Rust named permanent losses', () => {
  const listed = rows();

  test('the table lists at least the five SQL-only cases', () => {
    expect(listed.length).toBeGreaterThanOrEqual(5);
  });

  test('every row names a parity case that exists', () => {
    const missing = listed.filter(r => !PENDING.has(r.file) && caseBody(r.file, r.name) === null).map(r => `${r.file}: ${r.name}`);
    expect(missing).toEqual([]);
  });

  test('every listed case points back to its row', () => {
    const unreferenced = listed.filter(r => !PENDING.has(r.file))
      .filter(r => !(caseBody(r.file, r.name) ?? '').includes(REF)).map(r => `${r.file}: ${r.name}`);
    expect(unreferenced).toEqual([]);
  });
});
