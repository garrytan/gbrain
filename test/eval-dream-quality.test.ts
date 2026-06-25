import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildDreamQualityReceipt,
  extractDreamSummarySlugs,
  scoreDreamPage,
} from '../src/core/dream-quality.ts';
import { getPageOrLocalMarkdown, parseArgs } from '../src/commands/eval-dream-quality.ts';
import type { Page } from '../src/core/types.ts';

function page(overrides: Partial<Page> = {}): Page {
  return {
    id: 1,
    slug: 'wiki/personal/reflections/2026-06-23-cost-cap-as-forcing-function-671c5e',
    type: 'concept',
    title: 'Cost Cap as Forcing Function',
    compiled_truth: `# Cost Cap as Forcing Function

Session: 019example
Date: 2026-06-23
Repo: sawyer-hub

## What Happened

This Dream page captures a real decision and a proof receipt. It links to
[[wiki/originals/ideas/2026-06-23-the-enforcement-surface-is-the-decision-surface-671c5e]]
and names the source session, the receipt, and the decision. The content is
long enough to avoid a fluffy one-line summary and includes concrete traceable
details about Seascape Hub, Sawyer Hub, strategy canon, and why the update should
be reviewed before any owning repository is changed. It repeats enough grounded
detail to cross the deterministic substantial-content threshold for the quality
receipt. Related pages and proof markers make it useful for future retrieval.
`.repeat(3),
    timeline: '',
    frontmatter: { dream_generated: true, dream_cycle_date: '2026-06-23' },
    created_at: new Date('2026-06-23T20:00:00Z'),
    updated_at: new Date('2026-06-23T20:00:00Z'),
    source_id: 'default',
    ...overrides,
  };
}

describe('dream quality receipt', () => {
  test('extracts slugs from a dream summary', () => {
    expect(extractDreamSummarySlugs('- [[wiki/a]]\n- [[wiki/b|B]]\n- [[wiki/a]]')).toEqual(['wiki/a', 'wiki/b']);
  });

  test('scores useful dream pages and flags promotion review without writing repos', () => {
    const scored = scoreDreamPage(page());
    expect(scored.passed).toBe(true);
    expect(scored.needs_promotion_review).toBe(true);
    expect(scored.promotion_owner).toBe('seascape-hub');
  });

  test('receipt summarizes pass/fail and promotion queue', () => {
    const receipt = buildDreamQualityReceipt({
      pages: [page()],
      summarySlug: 'dream-cycle-summaries/2026-06-23',
      source: 'summary',
      now: new Date('2026-06-24T00:00:00Z'),
    });
    expect(receipt.verdict).toBe('pass');
    expect(receipt.pages_scored).toBe(1);
    expect(receipt.promotion_candidates).toBe(1);
    expect(receipt.promotion_queue[0].next_step).toContain('Verify');
    expect(receipt.receipt_sha8).toHaveLength(8);
  });

  test('traceability counts frontmatter provenance fields', () => {
    const scored = scoreDreamPage(page({
      compiled_truth: '# Cost Cap as Forcing Function\n\n## What Happened\n\n' + 'Grounded detail '.repeat(90),
      frontmatter: {
        dream_generated: true,
        session_id: '019example',
        started_at: '2026-06-23T20:00:00Z',
      },
    }));
    expect(scored.checks.hasTraceability).toBe(true);
  });

  test('parseArgs supports summary file, output, json, and positional slugs', () => {
    const args = parseArgs(['--summary-file', 's.md', '--output', 'out.json', '--json', 'wiki/x']);
    expect(args.summaryFile).toBe('s.md');
    expect(args.output).toBe('out.json');
    expect(args.json).toBe(true);
    expect(args.slugs).toEqual(['wiki/x']);
  });

  test('summary file path can be used by callers without touching global state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dream-quality-test-'));
    try {
      const path = join(dir, 'summary.md');
      writeFileSync(path, '- [[wiki/a]]\n');
      expect(extractDreamSummarySlugs(readFileSync(path, 'utf8'))).toEqual(['wiki/a']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('local markdown stamps override DB page shape for dream-quality scoring', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dream-quality-local-'));
    try {
      const slug = 'wiki/originals/ideas/example-dream-page';
      const filePath = join(dir, `${slug}.md`);
      mkdirSync(join(dir, 'wiki', 'originals', 'ideas'), { recursive: true });
      writeFileSync(
        filePath,
        `---
type: original
title: Example Dream Page
session_id: 019local
started_at: '2026-06-23T20:00:00Z'
dream_generated: true
---

# Example Dream Page

## What Happened

${'Grounded detail with links to [[wiki/originals/ideas/source]] and a real receipt. '.repeat(20)}
`,
      );

      const merged = await getPageOrLocalMarkdown({
        getPage: async () => page({
          slug,
          type: 'original',
          title: 'Example Dream Page',
          compiled_truth: '# Example Dream Page\n\n## What Happened\n\n' + 'Grounded detail '.repeat(20),
          frontmatter: {},
        }),
      } as any, slug, dir);

      expect(merged).not.toBeNull();
      expect(merged?.frontmatter?.dream_generated).toBe(true);

      const scored = scoreDreamPage(merged!);
      expect(scored.checks.dreamGenerated).toBe(true);
      expect(scored.checks.hasTraceability).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
