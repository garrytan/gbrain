import { expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { fileDriftRepair } from '../src/core/repair/file-drift.ts';

test('held selectors without a preference are refused rather than surveyed', async () => {
  const scope = { brain_id: 'b', source_ids: ['default'] } as never;
  for (const selection of [
    { held: true, side: 'deleted' as const },
    { held: true },
    { side: 'deleted' as const },
    { state: 'file_gone' as const },
    { cursor: 'next' },
    { provenance: 'never_committed' as const },
  ]) {
    await expect(fileDriftRepair.plan({} as BrainEngine, scope, null, { apply: false, remote: false, ...selection }))
      .rejects.toThrow('needs --prefer file or --prefer database');
  }
});
