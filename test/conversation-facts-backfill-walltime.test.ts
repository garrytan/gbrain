import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(
  'src/core/cycle/conversation-facts-backfill.ts',
  'utf8',
);

describe('conversation facts backfill walltime wiring', () => {
  test('applies the configured per-source cap to the extraction call', () => {
    expect(SOURCE).toContain(
      'const maxPerSourceWalltimeMs = cfg.maxWalltimeMin * 60_000',
    );
    expect(SOURCE).toContain(
      'const perSourceWalltimeSignal = AbortSignal.timeout(maxPerSourceWalltimeMs)',
    );
    expect(SOURCE).toMatch(
      /runExtractConversationFactsCore\([\s\S]*?\}, boundedSourceSignal\)/,
    );
  });

  test('bounds each source by the total cap and preserves worker cancellation', () => {
    expect(SOURCE).toContain(
      'const totalWalltimeSignal = AbortSignal.timeout(maxTotalWalltimeMs)',
    );
    expect(SOURCE).toContain(
      'anySignal(totalWalltimeSignal, opts.signal)',
    );
    expect(SOURCE).toContain("if (opts.signal?.aborted) throw err");
  });
});
