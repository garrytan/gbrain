import { describe, test, expect } from 'bun:test';
import { collectUsageShape } from '../src/core/advisor/collect-usage-shape.ts';
import { renderAdvisorReport } from '../src/core/advisor/render.ts';
import type { AdvisorContext } from '../src/core/advisor/types.ts';

// The health API counts unembedded content chunks, not pages. In particular,
// one page may contain several missing chunks. No real engine or provider runs.
function context(missing: number, disabled = false): AdvisorContext {
  return {
    engine: {
      getStats: async () => ({ page_count: 1 }),
      getHealth: async () => ({ embed_coverage: missing ? 0.25 : 1,
        missing_embeddings: missing, orphan_pages: 0, dead_links: 0 }),
    },
    config: { embedding_disabled: disabled },
  } as unknown as AdvisorContext;
}

describe('usage-shape embedding backlog units', () => {
  for (const [missing, expected] of [
    [3, '3 content chunks are missing embeddings. Backfill to restore full recall.'],
    [1, '1 content chunk is missing embeddings. Backfill to restore full recall.'],
  ] as const) {
    test(`reports ${missing} missing chunks independently of page count`, async () => {
      const findings = await collectUsageShape.collect(context(missing));
      const finding = findings.find(f => f.id === 'low_embed_coverage');
      expect(finding?.detail).toBe(expected);
      expect(finding?.fix?.command_argv).toEqual(['gbrain', 'embed', '--all']);
      expect(finding?.ask_user).toBe(true);
      expect(renderAdvisorReport({ version: 'test', generated_at: 'test',
        findings, worst: 'warn' }).replace(/\s+/g, ' ')).toContain(expected);
    });
  }
  test('does not request backfill when complete or disabled', async () => {
    for (const ctx of [context(0), context(3, true)]) {
      expect((await collectUsageShape.collect(ctx)).some(f => f.id === 'low_embed_coverage')).toBe(false);
    }
  });
});
