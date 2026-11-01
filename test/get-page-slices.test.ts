/**
 * #7180: get_page section and grep (gbrain get --section / --grep).
 *
 * 1. Protects: a section is the first heading whose text equals the request
 *    (case-insensitive) down to the next heading of the same or higher level,
 *    never a heading inside a code fence, never past the timeline separator,
 *    with its heading_path and line numbers that body: 'window' lines reads
 *    back; a miss names at most 20 headings. grep returns the paragraphs with
 *    a line containing the term (literal, case-insensitive) with N paragraphs
 *    of context, merges windows that overlap or touch, caps matches and
 *    characters and counts every match. Every response carries chars. Remote
 *    slices are cut from the read projection after authorization, so they
 *    show nothing a window could not. A segmented page answers the same
 *    slices as its inline twin by streaming segments.
 * 2. Fails when: a slice reads stored text, a heading match is substring or
 *    case-sensitive, a fenced line counts as a heading, a section runs into a
 *    sibling or the timeline, grep treats the term as a regex, a cap is not
 *    applied or not reported, chars is missing, or the default response gains
 *    slice fields.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { pageDocument } from '../src/core/page-window/document.ts';
import { segmentedReadWork } from '../src/core/page-window/segmented.ts';
import { GREP_MAX_MATCHES, MAX_GREP_CONTEXT, SLICE_MAX_CHARS } from '../src/core/ops/get-page-slice.ts';
import { formatGetPage } from '../src/cli/page-render.ts';
import { parseOpArgs } from '../src/cli/main.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { PRIVATE, importSegmented, privacyFacts, privacyTakes, privateTokensIn } from './helpers/segmented-privacy-fixture.ts';
import { asOwner } from './helpers/owner-tier.ts';

const getPage = operations.find(o => o.name === 'get_page')!;
let engine: BrainEngine;

const ctx = (remote: boolean): OperationContext => ({ engine, config: {} as GBrainConfig, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote,
  sourceId: 'default', ...(remote ? { transport: 'http', auth: { token: 'fixture', clientId: 'slice-client', principal: { kind: 'oauth_client', id: 'slice-client' },
    scopes: ['read'], sourceId: 'default', allowedSources: ['default'] } } : {}) } as unknown as OperationContext);
const get = async (params: Record<string, unknown>, remote = false) => await getPage.handler(ctx(remote), params) as Record<string, any>;

async function refusal(p: Promise<unknown>): Promise<OperationError> {
  try { await p; } catch (e) { if (e instanceof OperationError) return e; throw e; }
  throw new Error('expected a refusal');
}

async function put(slug: string, body: string, timeline = '', frontmatter: Record<string, unknown> = {}) {
  const r = await asOwner(engine, tx => importFromContent(tx, slug, serializeMarkdown(frontmatter, body, timeline, { type: 'note', title: slug, tags: [] }),
    { sourceId: 'default', noEmbed: true, forceRechunk: true }));
  expect(r.status).toBe('imported');
}

/** The read projection's lines, 1-based (index 0 unused). */
async function projectionLines(slug: string): Promise<string[]> {
  const snap = await engine.readPageSnapshot(slug, { sourceId: 'default' });
  return ['', ...pageDocument({ compiled_truth: snap!.page.compiled_truth, timeline: snap!.page.timeline }).bytes.toString('utf8').split('\n')];
}
const lineOf = (lines: string[], needle: string) => lines.findIndex(l => l.includes(needle));

/** What body: 'window' returns for lines [from, to]: the read-back check for a slice's line numbers. */
async function windowLines(slug: string, from: number, to: number, remote = false): Promise<string> {
  const r = await get({ slug, body: 'window', lines: { from, count: to - from + 1 }, max_bytes: 1_000_000 }, remote);
  return r.window.text.replace(/\n+$/, '');
}

const SECTIONS = [
  '# Project acme-example', '', 'Intro paragraph.', '',
  '## Goals', '', 'Ship the widget.', '',
  '### Stretch  Goals', '', 'Ship the gadget too.', '',
  '## Next Steps', '', '```md', '# not a heading', '## Goals', '```', '', 'Call alice-example.', '',
  '## Goals', '', 'A second goals section.', '',
  '# Appendix', '', 'Last words.',
].join('\n');

const PARAGRAPHS = [
  'Paragraph 1 intro.',
  'Paragraph 2 tock.',
  'Paragraph 3 has the NEEDLE.',
  'Paragraph 4 filler.',
  'Paragraph 5 needle again, tock.',
  'Paragraph 6 filler.',
  'Paragraph 7 filler.',
  'Paragraph 8 abc only.',
  'Paragraph 9 Needle at the end.',
  'Paragraph 10 literal a.c here.',
  'Paragraph 11 line one\nline two mentions zebra\nline three',
].join('\n\n');

/** A long day log: one paragraph per day under its own heading, a unique token on day 150. */
function dayLog(days: number): string {
  const day = (d: number) => [`## Day ${d}`, '', ...Array.from({ length: 120 }, (_, i) => `- ${d}.${i} alice-example asked acme-example about the widget plan${d === 150 && i === 7 ? ' zzuniquetoken' : ''}`), ''].join('\n');
  const truth = Array.from({ length: days }, (_, d) => day(d)).join('\n');
  const timeline = Array.from({ length: 1_000 }, (_, i) => `- 2024-01-${String(1 + (i % 28)).padStart(2, '0')}: entry ${i} with acme-example`).join('\n');
  return `---\ntitle: Widget log\ntype: note\ntags: [log]\n---\n${truth}\n\n<!-- timeline -->\n\n${timeline}\n`;
}

for (const kind of testBackends()) {
  describe(`get_page section and grep (${kind})`, () => {
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      await importSegmented(engine, 'logs/days-segmented', dayLog(240));
      await engine.setConfig('pages.segmented_storage', 'off');
      await asOwner(engine, tx => importFromContent(tx, 'logs/days-inline', dayLog(240), { sourceId: 'default', noEmbed: true }));
      await put('notes/sections', SECTIONS, '- 2024-01-02: timeline entry about the widget');
      await put('notes/paras', PARAGRAPHS);
      await put('notes/many-headings', Array.from({ length: 30 }, (_, i) => `## H${i + 1}\n\nbody ${i + 1}`).join('\n\n'));
      await put('notes/many-matches', Array.from({ length: 120 }, (_, i) => `item ${i} mentions target`).join('\n\n'));
      await put('notes/big-section', ['# Top', '', '## Big', '', ...Array.from({ length: 1_500 }, (_, i) => `line ${i} ${'x'.repeat(90)} target`), '', '## After', '', 'tail'].join('\n'));
      await put('notes/private-bits', ['## Public part', '', 'zzpublicprose is visible.', '', privacyTakes(), '', privacyFacts(), '', '## Closing', '', 'zzpublicprose again.'].join('\n'));
    }, 600_000);

    afterAll(async () => { await close(); });

    describe('section', () => {
      test('the first heading equal to the request, case-insensitive, with its heading path, down to the next same-level heading', async () => {
        const lines = await projectionLines('notes/sections');
        for (const remote of [false, true]) {
          const r = await get({ slug: 'notes/sections', section: 'goals' }, remote);
          expect(r.body).toBe('section');
          expect(r.compiled_truth).toBeUndefined();
          expect(r.timeline).toBeUndefined();
          expect(r.section.heading).toBe('Goals');
          expect(r.section.level).toBe(2);
          expect(r.section.heading_path).toEqual(['Project acme-example', 'Goals']);
          expect(r.section.text).toBe('## Goals\n\nShip the widget.\n\n### Stretch  Goals\n\nShip the gadget too.');
          expect(r.section.line_start).toBe(lineOf(lines, '## Goals'));
          expect(r.section.line_end).toBe(lineOf(lines, 'Ship the gadget too.'));
          expect(await windowLines('notes/sections', r.section.line_start, r.section.line_end, remote)).toBe(r.section.text);
          expect(r.chars).toBe(r.section.text.length);
          expect(r.truncated).toBe(false);
        }
      });

      test('a nested heading carries every ancestor; whitespace and a leading ## in the request fold away', async () => {
        const r = await get({ slug: 'notes/sections', section: '  STRETCH goals ' });
        expect(r.section.heading).toBe('Stretch  Goals');
        expect(r.section.heading_path).toEqual(['Project acme-example', 'Goals', 'Stretch  Goals']);
        expect(r.section.text).toBe('### Stretch  Goals\n\nShip the gadget too.');
        const hashed = await get({ slug: 'notes/sections', section: '## next steps' });
        expect(hashed.section.heading).toBe('Next Steps');
      });

      test('a fenced line is not a heading: the section keeps its code block and stops at the next real heading', async () => {
        const r = await get({ slug: 'notes/sections', section: 'Next Steps' });
        expect(r.section.text).toContain('# not a heading');
        expect(r.section.text).toContain('Call alice-example.');
        expect(r.section.text).not.toContain('A second goals section.');
        const miss = await refusal(get({ slug: 'notes/sections', section: 'not a heading' }));
        expect(miss.code).toBe('invalid_params');
      });

      test('a top-level section ends at the timeline separator', async () => {
        const r = await get({ slug: 'notes/sections', section: 'appendix' });
        expect(r.section.heading_path).toEqual(['Appendix']);
        expect(r.section.text).toBe('# Appendix\n\nLast words.');
        expect(JSON.stringify(r)).not.toContain('timeline entry');
      });

      test('a miss is invalid_params naming the headings, at most 20, with the total and an outline fix', async () => {
        const few = await refusal(get({ slug: 'notes/sections', section: 'Budget' }));
        expect(few.code).toBe('invalid_params');
        for (const h of ['Project acme-example', 'Goals', 'Stretch  Goals', 'Next Steps', 'Appendix']) expect(few.message).toContain(JSON.stringify(h));
        expect(JSON.parse(String(few.detail))).toEqual({ headings: ['Project acme-example', 'Goals', 'Stretch  Goals', 'Next Steps', 'Goals', 'Appendix'], total_headings: 6 });
        expect((few.fix as any).mcp.arguments.body).toBe('outline');
        const many = await refusal(get({ slug: 'notes/many-headings', section: 'H99' }, true));
        const detail = JSON.parse(String(many.detail));
        expect(detail.headings).toHaveLength(20);
        expect(detail.headings[0]).toBe('H1');
        expect(detail.total_headings).toBe(30);
        expect(many.message).toContain('first 20 of 30');
        expect(many.message).not.toContain('"H21"');
      });

      test('a section over the character budget is cut, says how much was omitted and where to read on', async () => {
        const r = await get({ slug: 'notes/big-section', section: 'big' });
        expect(r.truncated).toBe(true);
        expect(r.chars).toBeLessThanOrEqual(SLICE_MAX_CHARS);
        expect(r.chars).toBe(r.section.text.length);
        expect(r.omitted_chars).toBeGreaterThan(0);
        expect(r.section.text).not.toContain('## After');
        const lines = await projectionLines('notes/big-section');
        expect(r.section.line_end).toBe(lineOf(lines, 'line 1499 '));
        const from = r.next.arguments.lines.from;
        expect(from).toBeGreaterThan(r.section.line_start);
        expect(lines[from]).not.toBe('');
        expect(r.section.text.endsWith(lines[from - 1]!)).toBe(true);
        expect(r.next.arguments.lines.count).toBe(r.section.line_end - from + 1);
      });
    });

    describe('grep', () => {
      test('matching paragraphs with one paragraph of context, overlapping windows merged, line numbers from the read view', async () => {
        const lines = await projectionLines('notes/paras');
        const at = (n: number) => lineOf(lines, `Paragraph ${n} `);
        for (const remote of [false, true]) {
          const r = await get({ slug: 'notes/paras', grep: 'needle' }, remote);
          expect(r.body).toBe('grep');
          expect(r.compiled_truth).toBeUndefined();
          expect(r.grep).toMatchObject({ term: 'needle', context: 1, total_matches: 3, returned_matches: 3, omitted_matches: 0 });
          expect(r.truncated).toBe(false);
          expect(r.grep.blocks.map((b: any) => [b.line_start, b.line_end, b.match_starts])).toEqual([[at(2), at(6), [at(3), at(5)]], [at(8), at(10), [at(9)]]]);
          for (const b of r.grep.blocks) expect(await windowLines('notes/paras', b.line_start, b.line_end, remote)).toBe(b.text);
          expect(r.grep.blocks[0].text).not.toContain('Paragraph 7');
          expect(r.chars).toBe(r.grep.blocks.reduce((n: number, b: any) => n + b.text.length, 0));
        }
      });

      test('windows that touch merge; context 0 returns the matches alone; context is clamped to 5', async () => {
        const lines = await projectionLines('notes/paras');
        const at = (n: number) => lineOf(lines, `Paragraph ${n} `);
        const touch = await get({ slug: 'notes/paras', grep: 'tock' });
        expect(touch.grep.blocks.map((b: any) => [b.line_start, b.line_end, b.match_starts])).toEqual([[at(1), at(6), [at(2), at(5)]]]);
        const bare = await get({ slug: 'notes/paras', grep: 'needle', context: 0 });
        expect(bare.grep.blocks.map((b: any) => b.text)).toEqual(['Paragraph 3 has the NEEDLE.', 'Paragraph 5 needle again, tock.', 'Paragraph 9 Needle at the end.']);
        const wide = await get({ slug: 'notes/paras', grep: 'zebra', context: 99 });
        expect(wide.grep.context).toBe(MAX_GREP_CONTEXT);
        expect(wide.grep.blocks[0].line_start).toBe(at(6));
        const multi = await get({ slug: 'notes/paras', grep: 'ZEBRA', context: 0 });
        expect(multi.grep.blocks).toEqual([{ line_start: at(11), line_end: at(11) + 2, match_starts: [at(11)], text: 'Paragraph 11 line one\nline two mentions zebra\nline three' }]);
      });

      test('the term is a literal substring, never a regex', async () => {
        const r = await get({ slug: 'notes/paras', grep: 'a.c', context: 0 });
        expect(r.grep.total_matches).toBe(1);
        expect(r.grep.blocks[0].text).toBe('Paragraph 10 literal a.c here.');
        const none = await get({ slug: 'notes/paras', grep: '.*' });
        expect(none.grep).toMatchObject({ total_matches: 0, blocks: [] });
        expect(none.chars).toBe(0);
      });

      test('matches past the cap are counted, not returned', async () => {
        const r = await get({ slug: 'notes/many-matches', grep: 'TARGET', context: 0 }, true);
        expect(r.grep).toMatchObject({ total_matches: 120, returned_matches: GREP_MAX_MATCHES, omitted_matches: 120 - GREP_MAX_MATCHES });
        expect(r.truncated).toBe(true);
        const starts = r.grep.blocks.flatMap((b: any) => b.match_starts);
        expect(starts).toHaveLength(GREP_MAX_MATCHES);
        expect(r.grep.blocks.map((b: any) => b.text).join('\n')).not.toContain('item 50 ');
      });

      test('returned text stops at the character budget and says it was cut', async () => {
        const r = await get({ slug: 'notes/big-section', grep: 'target' });
        expect(r.grep.total_matches).toBe(1);
        expect(r.truncated).toBe(true);
        expect(r.chars).toBeLessThanOrEqual(SLICE_MAX_CHARS);
        expect(r.chars).toBeGreaterThan(SLICE_MAX_CHARS - 200);
      });
    });

    describe('chars and the default shape', () => {
      test('a whole-page read keeps its shape and carries chars', async () => {
        for (const remote of [false, true]) {
          const r = await get({ slug: 'notes/sections' }, remote);
          expect(typeof r.compiled_truth).toBe('string');
          for (const k of ['body', 'section', 'grep', 'window']) expect(r[k]).toBeUndefined();
          expect(r.chars).toBe(r.compiled_truth.length + r.timeline.length);
          const c = await get({ slug: 'notes/sections', include_content: true }, remote);
          expect(c.chars).toBe(c.compiled_truth.length + c.timeline.length + c.content.length);
          const lean = await get({ slug: 'notes/sections', include_content: true, content_only: true }, remote);
          expect(lean.chars).toBe(lean.content.length);
        }
      });

      test('windows carry the window text length; body none carries 0', async () => {
        const w = await get({ slug: 'notes/paras', body: 'window', lines: { from: 1, count: 3 } }, true);
        expect(w.chars).toBe(w.window.text.length);
        const none = await get({ slug: 'notes/paras', body: 'none' }, true);
        expect(none.chars).toBe(0);
      });
    });

    describe('parameters', () => {
      test('conflicts and malformed values are invalid_params naming the param', async () => {
        const cases: Array<Record<string, unknown>> = [
          { section: 'Goals', grep: 'x' }, { context: 2 }, { section: 'Goals', context: 2 }, { section: '  ' }, { grep: '' },
          { grep: 'x', context: -1 }, { grep: 'x', context: 1.5 }, { grep: 'x', context: '2' }, { section: 'Goals', include_content: true },
          { section: 'Goals', content_only: true }, { grep: 'x', lines: { from: 1, count: 2 } }, { grep: 'x', cursor: 'gpw1.x' },
          { section: 'Goals', body: 'none' }, { section: 'Goals', body: 'full' }, { grep: 'x', view: 'markdown' }, { section: 'x'.repeat(501) },
        ];
        for (const extra of cases) {
          const e = await refusal(get({ slug: 'notes/sections', ...extra }, true));
          expect({ extra, code: e.code }).toEqual({ extra, code: 'invalid_params' });
        }
        const historical = await refusal(get({ slug: 'notes/sections', section: 'Goals', known_as_of: '2026-01-01T00:00:00Z' }));
        expect(historical.message).toContain('section');
      });

      test('body auto or window with a slice still slices', async () => {
        expect((await get({ slug: 'notes/sections', section: 'Goals', body: 'window' }, true)).section.heading).toBe('Goals');
        expect((await get({ slug: 'notes/sections', grep: 'widget', body: 'auto' }, true)).grep.total_matches).toBe(2);
      });
    });

    describe('trust boundary', () => {
      test('a remote slice is cut from the read projection: private fences stay hidden, public text shows', async () => {
        const g = await get({ slug: 'notes/private-bits', grep: 'zz', context: 5 }, true);
        expect(privateTokensIn(JSON.stringify(g), { ledger: false })).toEqual([]);
        expect(JSON.stringify(g)).toContain('zzpublicprose');
        expect((await get({ slug: 'notes/private-bits', grep: PRIVATE.takes }, true)).grep.total_matches).toBe(0);
        const miss = await refusal(get({ slug: 'notes/private-bits', section: `${PRIVATE.takesHeading} takes` }, true));
        expect(JSON.parse(String(miss.detail)).headings).toEqual(['Public part', 'Closing']);
        expect(privateTokensIn(miss.message.replace(`"${PRIVATE.takesHeading} takes"`, '') + String(miss.detail), { ledger: false })).toEqual([]);
        const s = await get({ slug: 'notes/private-bits', section: 'Public part' }, true);
        expect(privateTokensIn(JSON.stringify(s), { ledger: false })).toEqual([]);
        expect(s.section.text).toContain('zzpublicprose is visible.');
      });

      test('a slice carries the same metadata as a window read; a private page stays missing', async () => {
        const w = await get({ slug: 'notes/private-bits', body: 'window' }, true);
        const s = await get({ slug: 'notes/private-bits', section: 'Closing' }, true);
        for (const k of ['slug', 'source_id', 'type', 'title', 'revision', 'tags', 'frontmatter', 'size', 'trust_tier', 'origin']) expect({ k, v: s[k] }).toEqual({ k, v: w[k] });
        await put('notes/hidden-example', '## Secret plan\n\nzzhiddenbody', '', { visibility: 'private' });
        const full = await refusal(get({ slug: 'notes/hidden-example' }, true));
        const sliced = await refusal(get({ slug: 'notes/hidden-example', section: 'Secret plan' }, true));
        expect(sliced.code).toBe(full.code);
        expect(sliced.message).toBe(full.message);
        expect(JSON.stringify(sliced.toJSON?.() ?? sliced)).not.toContain('zzhiddenbody');
      });
    });

    describe('segmented page', () => {
      test('section and grep stream the segments and match the inline twin, locally and remotely', async () => {
        const [seg] = await engine.executeRaw<{ body_storage: string }>('SELECT body_storage FROM pages WHERE slug=$1', ['logs/days-segmented']);
        expect(seg?.body_storage).toBe('segmented');
        const strip = (r: Record<string, any>) => ({ section: r.section, grep: r.grep, chars: r.chars, truncated: r.truncated, omitted_chars: r.omitted_chars, lines: r.next?.arguments?.lines });
        const cases: Array<Record<string, unknown>> = [{ section: 'Day 150' }, { section: 'day 3' }, { grep: 'zzuniquetoken', context: 1 }, { grep: 'acme-example', context: 0 }];
        for (const remote of [false, true]) {
          for (const c of cases) {
            const a = await get({ slug: 'logs/days-segmented', ...c }, remote);
            const b = await get({ slug: 'logs/days-inline', ...c }, remote);
            expect(a.body_storage).toBe('segmented');
            expect({ c, remote, r: strip(a) }).toEqual({ c, remote, r: strip(b) });
          }
        }
        const unique = await get({ slug: 'logs/days-segmented', grep: 'zzuniquetoken', context: 0 }, true);
        expect(unique.grep.total_matches).toBe(1);
        expect(unique.grep.blocks[0].text).toContain('- 150.7 alice-example');
        expect(await windowLines('logs/days-segmented', unique.grep.blocks[0].line_start, unique.grep.blocks[0].line_end, true)).toBe(unique.grep.blocks[0].text);
        const capped = await get({ slug: 'logs/days-segmented', grep: 'acme-example', context: 0 }, true);
        expect(capped.truncated).toBe(true);
        expect(capped.grep.total_matches).toBeGreaterThan(240);
      });

      test('an early section stops reading once it ends', async () => {
        const none = await get({ slug: 'logs/days-segmented', body: 'none' });
        segmentedReadWork.bytes = 0;
        const r = await get({ slug: 'logs/days-segmented', section: 'Day 2' });
        expect(r.section.heading_path).toEqual(['Day 2']);
        expect(segmentedReadWork.bytes).toBeLessThan(Number(none.size.total_bytes) / 4);
      });
    });
  });
}

describe('gbrain get --section / --grep', () => {
  test('the flags parse to get_page params', () => {
    expect(parseOpArgs(getPage, ['notes/a', '--section', 'Next Steps'])).toEqual({ slug: 'notes/a', section: 'Next Steps' });
    expect(parseOpArgs(getPage, ['notes/a', '--grep', 'widget', '--context', '2'])).toEqual({ slug: 'notes/a', grep: 'widget', context: 2 });
  });

  test('a section prints its text; grep prints each block under its line range', () => {
    const section = { slug: 'notes/a', body: 'section', chars: 12, truncated: false, section: { heading: 'Goals', heading_path: ['Top', 'Goals'], line_start: 5, line_end: 7, text: '## Goals\n\nok' } };
    expect(formatGetPage(section)).toBe('## Goals\n\nok\n');
    const grep = { slug: 'notes/a', body: 'grep', chars: 4, truncated: false,
      grep: { term: 'x', context: 1, total_matches: 2, returned_matches: 2, omitted_matches: 0, blocks: [{ line_start: 3, line_end: 3, match_starts: [3], text: 'a x' }, { line_start: 9, line_end: 11, match_starts: [11], text: 'b\n\nx' }] } };
    expect(formatGetPage(grep)).toBe('-- lines 3-3 (match at 3)\na x\n-- lines 9-11 (match at 11)\nb\n\nx\n');
  });
});
