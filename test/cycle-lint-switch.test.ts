import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { runPhaseLint } from '../src/core/cycle.ts';

const engineWith = (value: string | null) =>
  ({ getConfig: async (key: string) => (key === 'cycle.lint.enabled' ? value : null) }) as unknown as BrainEngine;

describe('cycle.lint.enabled off switch', () => {
  for (const off of ['false', '0', 'off']) {
    test(`'${off}' skips the lint phase without scanning`, async () => {
      const result = await runPhaseLint('/nonexistent-brain-dir', false, engineWith(off));
      expect(result.status).toBe('skipped');
      expect(result.summary).toContain('cycle.lint.enabled=false');
      expect(result.details).toMatchObject({ reason: 'disabled' });
    });
  }
});
