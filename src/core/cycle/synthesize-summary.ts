import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { parseMarkdown, serializeMarkdown } from '../markdown.ts';

const SUMMARY_LINK_SAMPLE_LIMIT = 20;

/**
 * Persist the source-scoped dream-cycle index without turning it into a graph
 * hub. Small cycles remain fully linked; large cycles expose a deterministic
 * sorted sample while immutable per-page provenance remains authoritative.
 */
export async function writeSummaryPage(
  engine: BrainEngine,
  brainDir: string,
  summarySlug: string,
  summaryDate: string,
  writtenSlugs: string[],
  childOutcomes: Array<{ jobId: number; status: string }>,
  sourceId = 'default',
): Promise<void> {
  const completed = childOutcomes.filter(c => c.status === 'completed').length;
  const failed = childOutcomes.length - completed;
  const lines: string[] = [
    `# Dream cycle ${summaryDate}`,
    '',
    `**Children:** ${completed} completed, ${failed} failed/timeout.`,
    `**Pages written:** ${writtenSlugs.length}.`,
    '',
  ];
  if (writtenSlugs.length > 0) {
    const sampledSlugs = [...writtenSlugs].sort().slice(0, SUMMARY_LINK_SAMPLE_LIMIT);
    lines.push(
      writtenSlugs.length > SUMMARY_LINK_SAMPLE_LIMIT
        ? `## Page sample (${sampledSlugs.length} of ${writtenSlugs.length})`
        : '## Pages',
      '',
      ...sampledSlugs.map(slug => `- [[${slug}]]`),
      '',
    );
    if (writtenSlugs.length > SUMMARY_LINK_SAMPLE_LIMIT) {
      lines.push(
        '## Full output provenance',
        '',
        `The complete ${writtenSlugs.length}-page set is recoverable in this source by querying page frontmatter for ` +
          `\`dream_generated: true\` and \`dream_cycle_date: ${summaryDate}\`, excluding \`${summarySlug}\`. ` +
          'Every child page carries those provenance fields; this summary intentionally links only the deterministic sample above.',
        '',
      );
    }
  }

  const fullMarkdown = serializeMarkdown(
    {
      dream_generated: true,
      created: summaryDate,
      dream_cycle_date: summaryDate,
      dream_created_cycle_date: summaryDate,
      // Deterministic index page: source traces live on its child pages.
      raw_trace_exempt: true,
      raw_trace_exempt_reason: 'deterministic dream-cycle index; raw traces live on listed pages',
    } as Record<string, unknown>,
    lines.join('\n'),
    '',
    { type: 'note' as string, title: `Dream cycle ${summaryDate}`, tags: ['dream-cycle'] },
  );
  const parsed = parseMarkdown(fullMarkdown);
  await engine.putPage(summarySlug, {
    type: parsed.type,
    title: parsed.title,
    compiled_truth: parsed.compiled_truth,
    timeline: parsed.timeline,
    frontmatter: parsed.frontmatter,
  }, { sourceId });

  try {
    const filePath = join(brainDir, `${summarySlug}.md`);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, fullMarkdown, 'utf8');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[dream] summary file-write failed: ${msg}\n`);
  }
}
