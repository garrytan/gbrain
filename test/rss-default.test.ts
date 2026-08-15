/**
 * issue #1678 — cgroup-aware auto-sized RSS watchdog default.
 *
 * The load-bearing case (Codex #5): a tiny cgroup limit on a huge host must
 * win, so the watchdog cap sits BELOW the real ceiling and the graceful drain
 * beats the kernel OOM-killer. Plain os.totalmem() would pick a 16GB cap on a
 * 4GB-limited container and re-break into a silent SIGKILL.
 */

import { describe, it, expect } from 'bun:test';
import {
  resolveDefaultMaxRssMb,
  describeDefaultMaxRss,
  readCgroupMemLimitBytes,
  RSS_DEFAULT_FLOOR_MB,
  RSS_DEFAULT_CEIL_MB,
} from '../src/core/minions/rss-default.ts';

const GB = 1024 * 1024 * 1024;

describe('resolveDefaultMaxRssMb — clamp', () => {
  it('8GB host (no cgroup) → floor 4096', () => {
    expect(resolveDefaultMaxRssMb({ totalMemBytes: 8 * GB, cgroupLimitBytes: null })).toBe(4096);
  });

  it('16GB host → 8192 (0.5x, inside the band)', () => {
    expect(resolveDefaultMaxRssMb({ totalMemBytes: 16 * GB, cgroupLimitBytes: null })).toBe(8192);
  });

  it('32GB host → ceil 16384', () => {
    expect(resolveDefaultMaxRssMb({ totalMemBytes: 32 * GB, cgroupLimitBytes: null })).toBe(16384);
  });

  it('126GB host → ceil 16384 (the incident box)', () => {
    expect(resolveDefaultMaxRssMb({ totalMemBytes: 126 * GB, cgroupLimitBytes: null })).toBe(16384);
  });

  it('result always within [floor, ceil] for huge hosts', () => {
    const mb = resolveDefaultMaxRssMb({ totalMemBytes: 1024 * GB, cgroupLimitBytes: null });
    expect(mb).toBeGreaterThanOrEqual(RSS_DEFAULT_FLOOR_MB);
    expect(mb).toBeLessThanOrEqual(RSS_DEFAULT_CEIL_MB);
  });
});

describe('resolveDefaultMaxRssMb — cgroup limit wins (Codex #5)', () => {
  it('4GB cgroup on a 126GB host → cap stays BELOW the 4GB ceiling', () => {
    const d = describeDefaultMaxRss({ totalMemBytes: 126 * GB, cgroupLimitBytes: 4 * GB });
    expect(d.source).toBe('cgroup-limited');
    expect(d.basisMb).toBe(4096);
    // 0.5x4096 = 2048, below the 4096 floor but the floor must NOT push the cap
    // up to/above the real 4GB ceiling — that would defeat drain-before-OOM.
    expect(d.mb).toBeLessThan(4096);
    expect(d.mb).toBe(2048);
  });

  it('8GB cgroup on a big host → 4096 (0.5x), source cgroup-limited', () => {
    const d = describeDefaultMaxRss({ totalMemBytes: 64 * GB, cgroupLimitBytes: 8 * GB });
    expect(d.mb).toBe(4096);
    expect(d.source).toBe('cgroup-limited');
  });

  it('cgroup limit >= host RAM reads as host (unlimited sentinel collapses via min)', () => {
    const d = describeDefaultMaxRss({ totalMemBytes: 16 * GB, cgroupLimitBytes: 9_223_372_036_854_771_712 });
    expect(d.source).toBe('host');
    expect(d.mb).toBe(8192);
  });
});

describe('readCgroupMemLimitBytes', () => {
  it('cgroup v2 "max" → null (no enforced limit)', () => {
    const read = (p: string) => {
      if (p === '/sys/fs/cgroup/memory.max') return 'max\n';
      throw new Error('ENOENT');
    };
    expect(readCgroupMemLimitBytes(read)).toBeNull();
  });

  it('cgroup v2 numeric → that value', () => {
    const read = (p: string) => {
      if (p === '/sys/fs/cgroup/memory.max') return String(4 * GB) + '\n';
      throw new Error('ENOENT');
    };
    expect(readCgroupMemLimitBytes(read)).toBe(4 * GB);
  });

  it('falls back to cgroup v1 when v2 unreadable', () => {
    const read = (p: string) => {
      if (p === '/sys/fs/cgroup/memory/memory.limit_in_bytes') return String(2 * GB);
      throw new Error('ENOENT');
    };
    expect(readCgroupMemLimitBytes(read)).toBe(2 * GB);
  });

  it('neither file present → null', () => {
    const read = () => { throw new Error('ENOENT'); };
    expect(readCgroupMemLimitBytes(read)).toBeNull();
  });
});
