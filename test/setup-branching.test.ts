import { describe, test, expect } from 'bun:test';
import { extractProjectRef } from '../src/core/supabase-admin.ts';
import { cpus, totalmem } from 'os';

// IPv6 detection (mirrors logic in init.ts)
function isSupabaseDirectUrl(url: string): boolean {
  return /db\.[a-z]+\.supabase\.co/.test(url) || url.includes('.supabase.co:5432');
}

describe('IPv6 detection', () => {
  test('detects db.xxx.supabase.co as direct (IPv6)', () => {
    expect(isSupabaseDirectUrl('postgresql://postgres:pw@db.rqfedtbs.supabase.co:5432/postgres')).toBe(true);
  });

  test('detects .supabase.co:5432 as direct (IPv6)', () => {
    expect(isSupabaseDirectUrl('postgresql://postgres:pw@something.supabase.co:5432/postgres')).toBe(true);
  });

  test('does NOT flag pooler URL as direct', () => {
    expect(isSupabaseDirectUrl('postgresql://postgres.ref:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres')).toBe(false);
  });

  test('does NOT flag non-supabase URL', () => {
    expect(isSupabaseDirectUrl('postgresql://user:pw@localhost:5432/mydb')).toBe(false);
  });
});

describe('defaultWorkers auto-tuning', () => {
  // Mirrors logic from import.ts. Cgroup-aware variant: when running in a
  // memory-constrained container, byMem must be sized from the cgroup limit
  // (process.constrainedMemory()), not the host's total RAM (os.totalmem()).
  // Pre-fix bug: on a 32 GB container with a 322 GB host, byMem = 644 →
  // Math.min clamped to 8 workers which each buffered file contents and
  // OOM-killed the import. Post-fix: byMem is computed against the
  // constrained limit, which still clamps to 8 on real hosts but stays
  // bounded in containers.
  function defaultWorkers(cpuCount: number, hostMemGB: number, constrainedMemGB?: number): number {
    const effectiveMemGB = constrainedMemGB && constrainedMemGB > 0 ? constrainedMemGB : hostMemGB;
    const byPool = 8;
    const byCpu = Math.max(2, cpuCount);
    const byMem = Math.floor(effectiveMemGB * 2);
    return Math.min(byPool, byCpu, byMem);
  }

  test('returns 2 for 1-core 1GB machine (unconstrained)', () => {
    expect(defaultWorkers(1, 1)).toBe(2);
  });

  test('returns 4 for 4-core 4GB machine (unconstrained)', () => {
    expect(defaultWorkers(4, 4)).toBe(4);
  });

  test('returns 8 for 16-core 32GB machine (unconstrained)', () => {
    expect(defaultWorkers(16, 32)).toBe(8); // capped by pool
  });

  test('caps at 8 regardless of hardware (unconstrained)', () => {
    expect(defaultWorkers(64, 128)).toBe(8);
  });

  test('memory-limited: 0.5GB machine → 1 (floored from 0.5*2)', () => {
    expect(defaultWorkers(8, 0.5)).toBe(1);
  });

  test('returns at least 2 for any CPU count', () => {
    const result = defaultWorkers(1, 8);
    expect(result).toBeGreaterThanOrEqual(2);
  });

  test('cgroup-constrained: 16-core 322GB host capped at 32GB container → 8 (pool-bound, but byMem now sized off cgroup)', () => {
    // Repro of the Railway/Fly.io/Docker-with-limits scenario. Pre-fix this
    // returned 8 too, but byMem was 644 → 8 workers each free to buffer many
    // GB of file content and trigger OOM. Post-fix byMem is 64 (32 * 2),
    // still clamped by byPool but with a true sense of available memory if
    // a future caller widens byPool.
    expect(defaultWorkers(16, 322, 32)).toBe(8);
  });

  test('cgroup-constrained: 64-core 322GB host capped at 1GB container → 2 (memory-bound)', () => {
    // A tight container picks workers from byMem (1 * 2 = 2), not host RAM.
    expect(defaultWorkers(64, 322, 1)).toBe(2);
  });

  test('cgroup-constrained: undefined/0 constraint falls back to host memory', () => {
    expect(defaultWorkers(16, 32, undefined)).toBe(8);
    expect(defaultWorkers(16, 32, 0)).toBe(8);
  });
});

describe('smart URL parsing covers all Supabase formats', () => {
  test('dashboard URL with settings path', () => {
    expect(extractProjectRef('https://supabase.com/dashboard/project/abcdefghijklmnop/settings/database'))
      .toBe('abcdefghijklmnop');
  });

  test('dashboard URL with just project', () => {
    expect(extractProjectRef('https://supabase.com/dashboard/project/abcdefghijklmnop'))
      .toBe('abcdefghijklmnop');
  });

  test('pooler URL with region', () => {
    expect(extractProjectRef('postgresql://postgres.abcdefghijklmnop:mypassword@aws-1-us-east-1.pooler.supabase.com:6543/postgres'))
      .toBe('abcdefghijklmnop');
  });

  test('direct URL with port', () => {
    expect(extractProjectRef('postgresql://postgres:mypassword@db.abcdefghijklmnop.supabase.co:5432/postgres'))
      .toBe('abcdefghijklmnop');
  });

  test('project URL with path', () => {
    expect(extractProjectRef('https://abcdefghijklmnop.supabase.co/rest/v1/'))
      .toBe('abcdefghijklmnop');
  });

  test('non-supabase postgres URL returns null', () => {
    expect(extractProjectRef('postgresql://user:pass@my-rds-instance.amazonaws.com:5432/mydb')).toBeNull();
  });
});
