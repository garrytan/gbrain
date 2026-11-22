import { describe, expect, test } from 'bun:test';
import { removalPendingChanged, removalPendingField } from '../src/core/persistence/sync-removal-pending.ts';

// LC-1: a committed-mode stamp records each path settled `deleted_same` on an uncommitted removal with its disk stat, and the
// idle check re-stats it. A restore that lands after the dirtiness probe saw the file gone, but before the stamp read the stat,
// must not be recorded as the stable stat: the next sync has to read the path again and hold the restored file.
const deletedSame = (path: string, dirty: string) => ({ path, state: { removedFile: true as const, dirty }, result: { cls: 'deleted_same' } });

describe('removal-pending stat taken around the dirtiness probe', () => {
  test('a restore between the probe and the stamp is never stamped idle', () => {
    const restored = () => '120:1700000000000';
    const observed = new Map([['notes/a.md', 'absent']]);
    const { removalPending } = removalPendingField('committed', [deletedSame('notes/a.md', 'deleted')], restored, observed);
    expect(removalPending).toEqual([{ path: 'notes/a.md', stat: 'raced' }]);
    expect(removalPendingChanged(removalPending, restored)).toBe(true);
  });

  test('an edited file rewritten during the pass is never stamped idle', () => {
    const rewritten = () => '120:1700000000999';
    const observed = new Map([['notes/a.md', '98:1700000000000']]);
    const { removalPending } = removalPendingField('committed', [deletedSame('notes/a.md', 'modified')], rewritten, observed);
    expect(removalPendingChanged(removalPending, rewritten)).toBe(true);
  });

  test('a path whose stat did not move keeps its stat, so an unchanged tree stays idle', () => {
    const gone = () => 'absent';
    const observed = new Map([['notes/a.md', 'absent']]);
    const { removalPending } = removalPendingField('committed', [deletedSame('notes/a.md', 'deleted')], gone, observed);
    expect(removalPending).toEqual([{ path: 'notes/a.md', stat: 'absent' }]);
    expect(removalPendingChanged(removalPending, gone)).toBe(false);
    expect(removalPendingChanged(removalPending, () => '120:1700000000000')).toBe(true);
  });

  test('a staged removal still records staged whatever the stats say', () => {
    const observed = new Map([['notes/a.md', 'absent']]);
    const { removalPending } = removalPendingField('committed', [deletedSame('notes/a.md', 'staged')], () => '120:1', observed);
    expect(removalPending).toEqual([{ path: 'notes/a.md', stat: 'staged' }]);
  });

  test('an unreadable stat is never stable evidence: the next sync reads the path again', () => {
    const unreadable = () => 'unreadable';
    const { removalPending } = removalPendingField('committed', [deletedSame('notes/a.md', 'deleted')], unreadable, new Map([['notes/a.md', 'unreadable']]));
    expect(removalPendingChanged(removalPending, unreadable)).toBe(true);
  });
});
