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

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { __testing } from '../src/core/cycle/synthesize.ts';
import type { PageInput } from '../src/core/types.ts';

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
