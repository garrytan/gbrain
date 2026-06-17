/**
 * triple-hr validator — compiled_truth / timeline split hygiene.
 *
 * The engine stores compiled_truth and timeline as two separate columns,
 * but authored markdown combines them with a triple-HR separator:
 *
 *     ## Compiled truth above the bar
 *     ...content...
 *
 *     ---
 *
 *     ---
 *
 *     ---
 *
 *     ## Timeline
 *     - **YYYY-MM-DD** | ...
 *
 * parseMarkdown() splits at the FIRST standalone `---` in the body, so if
 * authored content accidentally puts `---` inside compiled_truth (e.g.
 * someone writes "---" as a separator for a bullet list), the split happens
 * in the wrong place and half the page lands in the wrong column.
 *
 * This validator catches two cases on the in-memory state (post-split):
 *   1. compiled_truth contains a bare `---` line → would have re-split if
 *      round-tripped through parseMarkdown(). Warning only; lint-mode.
 *   2. timeline has content that looks like a header section (# / ##) →
 *      likely an authoring mistake that put compiled-truth bullets below
 *      the bar.
 *
 * Strict-mode severity is warning rather than error because some legacy
 * pages deliberately use thematic-break `---` mid-paragraph. Flipping to
 * error would break them without their opt-out.
 */

import type { PageValidator, PageValidationContext, ValidationFinding } from '../writer.ts';

export const tripleHrValidator: PageValidator = {
  id: 'triple-hr',

  async validate(ctx: PageValidationContext): Promise<ValidationFinding[]> {
    const findings: ValidationFinding[] = [];

    // Case 1: standalone --- inside compiled_truth
    const compiledLines = ctx.compiledTruth.split('\n');
    let insideFence = false;
    let fenceMarker = '';
    for (let i = 0; i < compiledLines.length; i++) {
      const line = compiledLines[i];
      if (insideFence) {
        if (line.startsWith(fenceMarker)) insideFence = false;
        continue;
      }
      if (line.startsWith('```') || line.startsWith('~~~')) {
        insideFence = true;
        fenceMarker = line.startsWith('```') ? '```' : '~~~';
        continue;
      }
      if (/^-{3,}\s*$/.test(line)) {
        findings.push({
          slug: ctx.slug,
          validator: 'triple-hr',
          severity: 'warning',
          line: i + 1,
          message: `Bare "---" line in compiled_truth would re-split on round-trip. Use spaced em-dash or thematic-break inside a list context.`,
        });
        break; // one finding per page is enough
      }
    }

    // Case 2: timeline has a heading (###) that looks like compiled-truth content
    // spilled below the bar. Timeline should be bullet-only lines or empty.
    const timelineLines = ctx.timeline.split('\n');
    for (let i = 0; i < timelineLines.length; i++) {
      const line = timelineLines[i].trim();
      if (line.length === 0) continue;
      // Skip the top-level "## Timeline" header if the engine kept it
      if (/^##\s+Timeline\s*$/i.test(line)) continue;
      if (/^#{1,6}\s/.test(line)) {
        findings.push({
          slug: ctx.slug,
          validator: 'triple-hr',
          severity: 'warning',
          line: i + 1,
          message: `Heading in timeline section: "${truncate(line, 60)}". Timeline entries should be append-only bullet lines.`,
        });
        break;
      }
    }

    return findings;
  },
};

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 3) + '...';
}
