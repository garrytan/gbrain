import { describe, expect, test } from 'bun:test';
import { nextDesktopVersionHistory } from '../src/main/version-history.js';

describe('desktop version history', () => {
  test('keeps one previous version across launches and advances after an upgrade', () => {
    const first = nextDesktopVersionHistory(null, '1.0.55', '1.0.54');
    expect(first).toEqual({ current: '1.0.55', previous: '1.0.54' });
    expect(nextDesktopVersionHistory(first, '1.0.55', '1.0.55')).toEqual(first);
    expect(nextDesktopVersionHistory(first, '1.0.56')).toEqual({ current: '1.0.56', previous: '1.0.55' });
  });

  test('ignores malformed fallback versions', () => {
    expect(nextDesktopVersionHistory(null, '1.0.55', '../unsafe')).toEqual({ current: '1.0.55' });
  });
});
