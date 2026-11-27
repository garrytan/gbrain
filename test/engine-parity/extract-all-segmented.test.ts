/**
 * BrainEngine parity: `gbrain extract all` (the file walk) on a brain where one page is stored segmented (a body over
 * the 1 MiB single-string limit) beside ordinary pages.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm the file walk extracts the links and timeline entries of every page, the segmented
 *    one included, and gives the same JSON answer (`runExtractCore`, what `extract all --json` prints) and the same
 *    stored links and timeline rows. The segmented page's links are read from its file and its dated link evidence
 *    from its stored segments, block by block, as the database pass (`extract all --source db`) reads them.
 *  - Regression: the links step published each page's file links through `replaceDerivedLinks`, whose dated-evidence
 *    step read the page body as one string; a segmented page refuses that read (rowToPage.compiled_truth), so the
 *    links write failed and `extract all` exited 1 on every engine.
 *  - Why existing coverage misses it: test/extract-mentions-engines.serial.test.ts pinned the exit 1 as the current
 *    behavior; no in-process case ran the file walk over a segmented page.
 *  - Seam: none. Real engines; files on disk imported through `importFromFile` and the streamed segmented import.
 */
import { afterAll, describe, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromFile } from '../../src/core/import-file.ts';
import { importStreamedMarkdownFile } from '../../src/core/page-body/streamed-import.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { runExtractCore } from '../../src/commands/extract.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'notes';
const root = mkdtempSync(join(tmpdir(), 'gbrain-parity-extract-all-segmented-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const PAGES: Record<string, string> = {
  'people/alice-example.md': '---\ntype: person\ntitle: Alice Example\n---\n\nAlice Example works at [[companies/acme-example]].\n\n## Timeline\n\n- 2026-01-05: Joined [[companies/acme-example]].\n',
  'companies/acme-example.md': '---\ntype: company\ntitle: Acme Example\n---\n\nAcme Example builds widgets with [[companies/widget-co]].\n',
  'companies/widget-co.md': '---\ntype: company\ntitle: Widget Co\n---\n\nWidget Co makes parts.\n',
};

/** A note past the 1 MiB single-string limit, naming the other pages and carrying dated lines, so it imports segmented. */
function longNote(): string {
  const entries: string[] = [];
  let bytes = 0;
  for (let i = 1; bytes < 1_300_000; i++) {
    const entry = `## Entry ${i}\n\nThe team met with [[people/alice-example]] about [[companies/widget-co]] parts and the brain index. Item ${i}.\n${i % 500 === 0 ? `\n- 2026-02-${String((i / 500) % 28 + 1).padStart(2, '0')}: Reviewed [[companies/acme-example]] entry ${i}.\n` : ''}`;
    entries.push(entry);
    bytes += entry.length + 1;
  }
  return `---\ntype: note\ntitle: Long field log\n---\n\n# Long field log\n\n${entries.join('\n')}`;
}
const LONG = longNote();

/** The brain's folder for one arm, imported: the ordinary pages and the segmented note, all in source `notes`. */
async function seed(engine: BrainEngine, backend: string): Promise<string> {
  const dir = join(root, backend);
  for (const [rel, text] of Object.entries({ ...PAGES, 'notes/long-field-log.md': LONG })) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  await createSource(engine, backend as never, SRC, {}, dir);
  for (const rel of Object.keys(PAGES)) await importFromFile(engine, join(dir, rel), rel, { noEmbed: true, sourceId: SRC });
  const long = join(dir, 'notes/long-field-log.md');
  const imported = await importStreamedMarkdownFile(engine, long, 'notes/long-field-log.md', { noEmbed: true, sourceId: SRC },
    statSync(long), await readPageBodyPolicy(engine));
  expect(imported.status).toBe('imported');
  return dir;
}

const day = (d: unknown) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);

describe('engine parity: extract all over a segmented page', () => {
  parityTest('extract all (file walk) extracts every page, the segmented one included, and gives the same JSON', {
    methods: ['readPageSnapshot', 'replaceDerivedLinks', 'getLinks', 'getTimeline'],
  }, async (engine, backend) => {
    const dir = await seed(engine, backend);
    const segmented = await engine.getPage('notes/long-field-log', { sourceId: SRC });
    expect(segmented?.body_storage).toBe('segmented');
    let answer: unknown;
    try {
      answer = await runExtractCore(engine, { mode: 'all', dir, jsonMode: true, sourceId: SRC });
    } catch (error) {
      answer = { error: error instanceof Error ? error.message : String(error) };
    }
    const json = JSON.stringify(answer, null, 2);
    expect(json).not.toContain('"error"');
    const links = async (slug: string) => (await engine.getLinks(slug, { sourceId: SRC }))
      .map(l => `${l.from_slug} -> ${l.to_slug} (${l.link_type})`).sort();
    const timeline = async (slug: string) => (await engine.getTimeline(slug, { sourceId: SRC }))
      .map(r => `${day(r.date)} ${r.summary}`).sort();
    const out = {
      json,
      longLinks: await links('notes/long-field-log'),
      aliceLinks: await links('people/alice-example'),
      acmeLinks: await links('companies/acme-example'),
      aliceTimeline: await timeline('people/alice-example'),
      longTimeline: (await timeline('notes/long-field-log')).length,
    };
    expect(out.longLinks.length).toBeGreaterThan(0);
    expect(out.aliceLinks.length).toBeGreaterThan(0);
    return out;
  });
});
