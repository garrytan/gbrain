/**
 * BrainEngine parity — `gbrain export` (src/commands/export.ts) writes the same Markdown tree, byte for byte, on every
 * engine arm.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: pages imported from Markdown (one with rich frontmatter: a YAML date, nested maps and lists, quoted
 *    strings, numbers and booleans; one long inline page; one page written just before the export) export to the same
 *    files with the same bytes on PGLite, Postgres and the Rust engine.
 *  - Regression: on a Rust brain the export wrote a frontmatter date as `date: {}`. The Rust putPage member sent the
 *    frontmatter object to the addon as is, and the addon reads a nested `Date` as an empty object; Postgres and
 *    PGLite store the frontmatter's JSON text, where the date is its ISO string. A keyless benchmark dry run found
 *    6 of 200 exported pages different on Rust, frontmatter among them.
 *  - Tags are all lower case: export orders them by the database collation, so Postgres on en_US and PGLite order
 *    mixed-case tags differently (export-reads.ts `ORDER BY t.tag`).
 *  - Why existing coverage misses it: test/engine-parity/cli-reads-export.test.ts compares each export member's rows
 *    one at a time, with frontmatter written as plain JSON values; no case compared the files export writes, or
 *    frontmatter parsed from YAML.
 *  - The git-gap census and the git conversion read pages through export-snapshot.ts (readExportWithdrawals,
 *    readExportPages); the second case runs that path with withdrawn fact rows, so the overlay's fence normalization
 *    (normalizeFenceLines) runs too.
 *  - Seam: none; every page is written through importFromContent and putPage, and the export runs end to end. A
 *    segmented page (a body over 1 MiB) is not here: its import on Rust refuses page body staging
 *    (page-body/limits.ts stageBatchBytes), which the page body lane serves.
 */
import { describe, expect } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'fs';
import { join, relative } from 'path';
import { tmpdir } from 'os';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { runExport } from '../../src/commands/export.ts';
import { inlineExportMarkdown, readExportPages, readExportWithdrawals } from '../../src/core/export-snapshot.ts';
import { parseFactsFence, renderFactsTable } from '../../src/core/facts-fence.ts';

const { parityTest } = parityArms(testBackends());

/** Every file under `dir`, by path relative to it, with its bytes as text. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

const FRONTMATTER_PAGE = `---
title: "Front: matter's page"
type: person
tags: [beta, alpha, "gamma delta"]
date: 2024-03-05
seen: [2023-01-02, 2023-02-03]
aliases:
  - Front Page
  - "front: page"
custom:
  nested: { a: 1, b: [x, y] }
  empty: ""
  when: 2022-12-31
rating: 4.50
flag: yes
---

# Front matter page

Body with [[people/other-example]] link.

---

timeline line one
`;

const section = (i: number) => `## Section ${i}\n\n${'A long paragraph about lynx and otters. '.repeat(40)}\n\n`;
const LONG_PAGE = `---\ntitle: Long page\ntype: note\n---\n\n${Array.from({ length: 200 }, (_, i) => section(i)).join('')}`;

describe('engine parity: the export tree', () => {
  parityTest('export writes the same files with the same bytes', { methods: ['putPage', 'listExportPageKeys', 'readExportPageRows'] },
    async (engine) => {
      // Export refuses a destination under a symlink, and macOS tmpdir() sits behind the /var -> /private/var symlink.
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'export-parity-')));
      try {
        await importFromContent(engine, 'people/front', FRONTMATTER_PAGE, { sourceId: 'default' });
        await importFromContent(engine, 'notes/long', LONG_PAGE, { sourceId: 'default' });
        await engine.putPage('notes/new', { type: 'note', title: 'New page', compiled_truth: 'Fresh body.', timeline: '' }, { sourceId: 'default' });
        await runExport(engine, ['--dir', dir]);
        const files = tree(dir);
        expect(Object.keys(files)).toEqual(expect.arrayContaining(['people/front.md', 'notes/long.md', 'notes/new.md']));
        expect(files['people/front.md']).toContain("date: '2024-03-05T00:00:00.000Z'");
        return files;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

  parityTest('the export snapshot reads pages with their withdrawn fact rows marked', {
    methods: ['insertFactWithdrawal', 'readExportWithdrawalLedgerBytes', 'listExportWithdrawals', 'readExportPageRows', 'normalizeFenceLines',
      'putPage', 'getPage'],
  }, async (engine) => {
    const fence = (...claims: string[]) => renderFactsTable(claims.map((claim, i) => ({ rowNum: i + 1, claim, kind: 'fact', confidence: 1,
      visibility: 'world', notability: 'medium', active: true, context: '' })));
    await engine.insertFactWithdrawal('default', 'world', 'Withdrawn everywhere claim', '*', '2026-01-03T00:00:00.000Z');
    await engine.insertFactWithdrawal('default', 'world', 'Withdrawn here claim', 'snap/subject', '2026-01-04T00:00:00.000Z');
    const pages: Array<[string, string, string]> = [
      ['snap/star', 'Lead.\n\n' + fence('Withdrawn everywhere claim', 'A kept claim'), ''],
      ['snap/subject', fence('WITHDRAWN   here claim'), fence('Withdrawn everywhere claim')],
      ['snap/other', fence('Withdrawn here claim'), ''],
      ['snap/plain', 'A plain body.', '- 2026-01-01: An event.'],
    ];
    for (const [slug, compiled_truth, timeline] of pages) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth, timeline, frontmatter: { when: new Date('2024-03-05T00:00:00.000Z') } });
    }
    const keys = await Promise.all(pages.map(async ([slug]) => {
      const page = (await engine.getPage(slug))!;
      return { id: String(page.id), source_id: page.source_id, slug };
    }));
    const withdrawals = await readExportWithdrawals(engine, 'default');
    const snapshots = await readExportPages(engine, keys, withdrawals);
    const inactive = snapshots.map(({ page }) => [page.compiled_truth, page.timeline].map(text => parseFactsFence(text).facts.filter(fact => fact.active === false).length));
    // The overlay ran: the star claim everywhere, the subject's claim on its own page only.
    expect(inactive).toEqual([[1, 0], [1, 1], [0, 0], [0, 0]]);
    return snapshots.map(snapshot => ({ slug: snapshot.page.slug, tags: snapshot.tags, markdown: inlineExportMarkdown(snapshot) }));
  });
});
