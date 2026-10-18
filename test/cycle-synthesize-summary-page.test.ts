/**
 * #4337 — dream-cycle summary graph bounds.
 *
 * `writeSummaryPage` used to emit one wikilink per generated page, so a
 * large cycle turned the summary into a thousands-edge graph hub and an
 * oversized file even though every child already carries queryable
 * provenance frontmatter. The summary now lists a deterministic,
 * lexicographically sorted sample of at most 20 links, keeps exact totals,
 * and names the provenance query that recovers the complete child set.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { __testing } from '../src/core/cycle/synthesize.ts';
import type { PageInput } from '../src/core/types.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { lintContent } from '../src/commands/lint.ts';
import { parseMarkdown } from '../src/core/markdown.ts';

type SummaryWriter = (
  engine: BrainEngine,
  brainDir: string,
  summarySlug: string,
  summaryDate: string,
  writtenSlugs: string[],
  childOutcomes: Array<{ jobId: number; status: string }>,
  sourceId?: string,
) => Promise<void>;

const writeSummaryPage = (
  __testing as unknown as { writeSummaryPage: SummaryWriter }
).writeSummaryPage;

async function renderSummary(writtenSlugs: string[]): Promise<{ body: string; markdown: string }> {
  const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-dream-summary-'));
  let stored: PageInput | undefined;
  const engine = {
    putPage: async (_slug: string, page: PageInput) => {
      stored = page;
      return {};
    },
    // #4506 dual-write suppressor reads this knob; default-on path.
    getConfig: async (_key: string) => null,
    // The summary write runs in a maintenance transaction; the stub is its own transaction engine.
    executeRaw: async () => [],
    transaction: async <T>(fn: (tx: BrainEngine) => Promise<T>) => fn(engine),
  } as unknown as BrainEngine;
  try {
    await writeSummaryPage(
      engine,
      brainDir,
      'dream-cycle-summaries/2026-08-20',
      '2026-08-20',
      writtenSlugs,
      [
        { jobId: 1, status: 'completed' },
        { jobId: 2, status: 'completed' },
        { jobId: 3, status: 'failed' },
      ],
    );
    if (!stored) throw new Error('summary page was not persisted');
    return {
      body: stored.compiled_truth,
      markdown: readFileSync(
        join(brainDir, 'dream-cycle-summaries/2026-08-20.md'),
        'utf8',
      ),
    };
  } finally {
    rmSync(brainDir, { recursive: true, force: true });
  }
}

describe('dream-cycle summary temporal frontmatter (#6773)', () => {
  // Contributed by @lubosxyz (#6773): dream provenance keys are not temporal keys, so the summary failed missing-created.
  test('the summary records created as its own cycle date and passes lint', async () => {
    const { markdown } = await renderSummary(['wiki/originals/ideas/example-output']);
    expect(parseMarkdown(markdown).frontmatter.created).toBe('2026-08-20');
    expect(lintContent(markdown, 'dream-cycle-summaries/2026-08-20.md')).toEqual([]);
  });
});

describe('dream-cycle summary graph bounds (#4337)', () => {
  test('more than 2,000 outputs produce one deterministic bounded sample with recoverable provenance', async () => {
    const slugs = Array.from(
      { length: 2_105 },
      (_, index) => {
        const prefix = `wiki/originals/ideas/output-${String(index).padStart(4, '0')}-`;
        return prefix + 'x'.repeat(255 - prefix.length);
      },
    );
    const forward = await renderSummary(slugs);
    const reverse = await renderSummary([...slugs].reverse());

    // Deterministic: input order does not change the output.
    expect(forward.body).toBe(reverse.body);
    expect(forward.markdown).toBe(reverse.markdown);
    // Exact totals survive the cap.
    expect(forward.body).toContain('**Children:** 2 completed, 1 failed/timeout.');
    expect(forward.body).toContain('**Pages written:** 2105.');
    // Bounded, lexicographically sorted sample.
    expect(forward.body.match(/\[\[/g)).toHaveLength(20);
    expect(slugs.every(slug => slug.length === 255)).toBe(true);
    expect(forward.body).toContain(`[[${slugs[0]}]]`);
    expect(forward.body).toContain(`[[${slugs[19]}]]`);
    expect(forward.body).not.toContain(`[[${slugs[20]}]]`);
    // Identity markers survive (frontmatter in the serialized file; the body's
    // provenance pointer also names the query keys).
    expect(forward.body).toContain('dream_generated: true');
    expect(forward.body).toContain('dream_cycle_date: 2026-08-20');
    expect(forward.markdown).toMatch(/dream_created_cycle_date:\s*['"]?2026-08-20/);
    // The provenance pointer names the recovery query and excludes itself.
    expect(forward.body).toContain('## Full output provenance');
    expect(forward.body).toContain('excluding `dream-cycle-summaries/2026-08-20`');
    // Bounded file size even at 2,105 max-length slugs.
    expect(Buffer.byteLength(forward.markdown, 'utf8')).toBeLessThan(8_192);
  });

  test('exactly 20 slugs render inline as a complete list; 21 flips to the bounded sample + provenance pointer', async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `wiki/originals/ideas/output-${String(i).padStart(2, '0')}`);
    const atCap = await renderSummary(twenty);
    expect(atCap.body).toContain('**Pages written:** 20.');
    expect(atCap.body).toContain('## Pages');
    expect(atCap.body).not.toContain('## Page sample');
    expect(atCap.body).not.toContain('## Full output provenance');
    expect(atCap.body.match(/\[\[/g)).toHaveLength(20);
    for (const slug of twenty) expect(atCap.body).toContain(`[[${slug}]]`);

    const twentyOne = [...twenty, 'wiki/originals/ideas/output-20'];
    const overCap = await renderSummary(twentyOne);
    expect(overCap.body).toContain('**Pages written:** 21.');
    expect(overCap.body).toContain('## Page sample (20 of 21)');
    expect(overCap.body).not.toContain('## Pages\n');
    expect(overCap.body).toContain('## Full output provenance');
    expect(overCap.body).toContain('records the first cycle that wrote a page');
    expect(overCap.body.match(/\[\[/g)).toHaveLength(20);
    // Lexicographic sample: output-00..output-19 stay, output-20 is the one dropped.
    expect(overCap.body).not.toContain('[[wiki/originals/ideas/output-20]]');
    expect(overCap.body).toContain('[[wiki/originals/ideas/output-19]]');
  });

  test('small runs retain a complete page list', async () => {
    const slugs = [
      'wiki/originals/ideas/output-charlie',
      'wiki/originals/ideas/output-alpha',
      'wiki/originals/ideas/output-bravo',
    ];
    const { body } = await renderSummary(slugs);

    expect(body).toContain('**Pages written:** 3.');
    expect(body).toContain('## Pages');
    expect(body).not.toContain('## Page sample');
    expect(body).not.toContain('## Full output provenance');
    expect(body.match(/\[\[/g)).toHaveLength(3);
    for (const slug of slugs) expect(body).toContain(`[[${slug}]]`);
  });
});

// #6642: `dream_cycle_date` is first-write provenance (stampDreamProvenance keeps
// the first cycle), so the summary's recovery query misses pages an earlier cycle
// wrote first. The summary states first-write semantics, reports the count that
// query returns, and counts the rewritten pages separately.
describe('dream-cycle summary provenance counts (#6642)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => {
    await engine.disconnect();
  });
  beforeEach(async () => {
    await resetPgliteState(engine);
  });

  test('a >20-output summary reports the recovery query count and the pages rewritten from earlier cycles', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-dream-summary-6642-'));
    try {
      const date = '2026-10-13';
      const slugs = Array.from({ length: 24 }, (_, i) => `wiki/personal/reflections/output-${String(i).padStart(2, '0')}`);
      for (const [i, slug] of slugs.entries()) {
        await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'body', frontmatter: { dream_generated: true } });
        await __testing.stampDreamProvenance(engine, [{ slug, source_id: 'default' }], i < 3 ? '2026-10-10' : date);
      }
      // The rewrite in this cycle keeps each page's first-write stamp.
      await __testing.stampDreamProvenance(engine, slugs.map(slug => ({ slug, source_id: 'default' })), date);
      const stamps = await engine.executeRaw<{ d: string; n: number }>(
        `SELECT frontmatter->>'dream_cycle_date' AS d, count(*)::int AS n FROM pages WHERE slug = ANY($1::text[]) GROUP BY 1 ORDER BY 1`, [slugs]);
      expect(stamps).toEqual([{ d: '2026-10-10', n: 3 }, { d: date, n: 21 }]);

      const summarySlug = `dream-cycle-summaries/${date}`;
      await (__testing as unknown as { writeSummaryPage: SummaryWriter }).writeSummaryPage(engine, brainDir, summarySlug, date, slugs, [{ jobId: 1, status: 'completed' }]);
      const body = (await engine.getPage(summarySlug))!.compiled_truth;
      const [query] = await engine.executeRaw<{ n: number }>(
        `SELECT count(*)::int AS n FROM pages WHERE source_id = 'default' AND deleted_at IS NULL
           AND frontmatter->>'dream_generated' = 'true' AND frontmatter->>'dream_cycle_date' = $1 AND slug <> $2`, [date, summarySlug]);
      expect(query.n).toBe(21);
      expect(body).toContain('**Pages written:** 24.');
      expect(body).toContain('`dream_cycle_date` records the first cycle that wrote a page');
      expect(body).toContain(`returns ${query.n} page(s)`);
      expect(body).toContain('3 of the 24 pages written this cycle were first written by an earlier cycle');
      expect(body).not.toContain('The complete 24-page set');
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
    }
  });
});
