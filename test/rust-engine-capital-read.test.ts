/**
 * A Rust page read of a slug with capitals looks up that one key and nothing else.
 *
 * Authoring gate (docs/TESTING.md): protects the memory and speed of a mixed-case page read on a large Rust brain. A
 * regression is a read that lists pages (the store's listPages decodes every page record of every source before it
 * filters by prefix and limit) to learn whether the capital spelling is stored, or a batch fallback that reads the
 * lowercased key and answers a different page. The engine-parity slug-normalize case proves the answers on three engines;
 * this file pins the store calls, which no answer shows. No production seam: the real store members over a recording
 * stub of the store handle.
 */
import { describe, expect, test } from 'bun:test';
import { getPage, readPageSnapshot } from '../src/core/rust-engine/store-members/pages.ts';
import { readPageSnapshotsBatch } from '../src/core/rust-engine/store-members/page-ops.ts';

function recordingBrain(held: Record<string, unknown> | null) {
  const calls: Array<{ method: string; slug?: string; opts?: Record<string, unknown> }> = [];
  const brain = {
    async readPageSnapshot(slug: string, opts: Record<string, unknown>) { calls.push({ method: 'readPageSnapshot', slug, opts }); return held; },
    async listPages(opts: Record<string, unknown>) { calls.push({ method: 'listPages', opts }); return []; },
    async readPageSnapshotsBatch() { calls.push({ method: 'readPageSnapshotsBatch' }); return { covered: 1, snapshots: [null] }; },
  };
  return { brain: brain as never, calls };
}

describe('a Rust read of a slug with capitals', () => {
  test('getPage and readPageSnapshot look up the exact key in the scope and never list pages', async () => {
    for (const member of [getPage, readPageSnapshot]) {
      const { brain, calls } = recordingBrain(null);
      expect(await member(brain, 'Notes/Report', { sourceId: 'default' } as never)).toBeNull();
      expect(calls).toEqual([{ method: 'readPageSnapshot', slug: 'Notes/Report', opts: { sourceId: 'default', includeDeleted: true, exactSlug: true } }]);
    }
  });

  test('a page held under that exact key is refused, not read as another page', async () => {
    const { brain } = recordingBrain({ page: { slug: 'Notes/Report' } });
    await expect(getPage(brain, 'Notes/Report', { sourceId: 'default' } as never)).rejects.toMatchObject({ code: 'engine_capability_missing' });
  });

  test('the batch reads an absent ref again by its exact key', async () => {
    const { brain, calls } = recordingBrain(null);
    const batch = await readPageSnapshotsBatch(brain, [{ slug: 'Notes/Only-Lower', sourceId: 'default' }]);
    expect(batch.snapshots.size).toBe(0);
    expect(calls[1]).toEqual({ method: 'readPageSnapshot', slug: 'Notes/Only-Lower', opts: { sourceId: 'default', exactSlug: true } });
  });
});
