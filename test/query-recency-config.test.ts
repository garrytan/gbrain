import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadQueryRecencyDecayConfig } from '../src/core/operations.ts';

describe('loadQueryRecencyDecayConfig', () => {
  test('loads source gbrain.yml recency config for scalar source-scoped queries', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-recency-source-'));
    try {
      writeFileSync(
        join(repo, 'gbrain.yml'),
        [
          'recency:',
          '  bma/issue164/current-owner-truth/:',
          '    halflifeDays: 7',
          '    coefficient: 2',
          '',
        ].join('\n'),
      );

      const ctx = {
        engine: {
          executeRaw: async () => [{
            id: 'issue164-research',
            name: 'Issue 164 Research',
            local_path: repo,
            last_commit: null,
            last_sync_at: null,
            config: {},
            created_at: new Date(),
            archived: false,
            newest_content_at: null,
          }],
        },
        config: {},
        logger: console,
        dryRun: false,
        sourceId: 'issue164-research',
      } as never;

      const out = await loadQueryRecencyDecayConfig(ctx, { sourceId: 'issue164-research' });

      expect(out.recencyDecay?.['bma/issue164/current-owner-truth/']).toEqual({
        halflifeDays: 7,
        coefficient: 2,
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('does not read source rows for all-source queries', async () => {
    const ctx = {
      engine: {
        executeRaw: async () => {
          throw new Error('source lookup should not run for all-source query');
        },
      },
      config: {},
      logger: console,
      dryRun: false,
      sourceId: 'default',
    } as never;

    const out = await loadQueryRecencyDecayConfig(ctx, { sourceId: '__all__' });

    expect(out.recencyDecay?.['daily/']).toBeDefined();
    expect(out.recencyDecay?.['bma/issue164/current-owner-truth/']).toBeUndefined();
  });
});
