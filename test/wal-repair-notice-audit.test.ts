import { describe, expect, test } from 'bun:test';
import { buildWalRepairNotice } from '../src/core/pglite-engine.ts';
import type { WalRepairReceipt } from '../src/core/pglite-repair.ts';

// #4616 — the auto-repair notice must not imply the brain is whole again:
// pg_resetwal leaves indexes unrebuilt, so a page written just before the
// crash can be missing from vector search while `get` / keyword still find
// it. Pin the caveat and the recovery recipe.
describe('buildWalRepairNotice (#4616 index caveat)', () => {
  test('names the unrebuilt-index caveat and the search-diagnose / re-embed recipe', () => {
    const receipt: WalRepairReceipt = {
      dataDir: '/tmp/brain-example/pglite',
      backupPath: '/tmp/brain-example/pglite.wal-repair-backup-1',
      backedUpFiles: ['pg_wal/', 'global/pg_control'],
      reusedEpisodeBackup: false,
      resetSegment: '000000010000000000000003',
      timelineId: 1,
      walSegSize: 16 * 1024 * 1024,
      repairedAt: '2026-09-15T00:00:00.000Z',
    };
    const notice = buildWalRepairNotice(receipt);
    expect(notice).toContain('Indexes were NOT');
    expect(notice).toContain('missing from vector');
    expect(notice).toContain('gbrain search diagnose');
    expect(notice).toContain('gbrain embed <slug>');
    expect(notice).toContain(receipt.backupPath);
    expect(notice).toContain('GBRAIN_PGLITE_WAL_REPAIR=off');
    // The old, over-reassuring line is gone.
    expect(notice).not.toContain('Recommended: run `gbrain doctor` to verify brain integrity.');
  });
});
