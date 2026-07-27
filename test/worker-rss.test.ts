/**
 * Tests for the per-process RSS reader used by the worker's leak watchdog.
 *
 * `process.memoryUsage().rss` returns VmRSS which counts file-backed mmap
 * pages (e.g. git packfiles). On a 96K-page brain repo, git operations
 * inflate VmRSS to 7GB+ while heap is ~100MB — the kernel will reclaim
 * those pages under pressure so they should not count toward the watchdog
 * threshold. The fix reads `/proc/self/status` for RssAnon + RssShmem
 * (the non-file-backed pages) on Linux and falls back to VmRSS elsewhere.
 *
 * These tests pin the parser shape against the M1 regression Codex
 * surfaced during eng review: the prior `if (anonKb > 0)` form conflated
 * "field missing" with "field present but zero", which broke the
 * shmem-only worker case.
 */

import { describe, it, expect } from 'bun:test';
import { getAccurateRss, parseRssFromProcStatus } from '../src/core/minions/worker.ts';

describe('parseRssFromProcStatus', () => {
  it('parses normal RssAnon + RssShmem to bytes', () => {
    const status = [
      'Name:\tworker',
      'VmRSS:\t1024 kB',
      'RssAnon:\t1024 kB',
      'RssShmem:\t0 kB',
      'VmSize:\t8192 kB',
    ].join('\n');
    expect(parseRssFromProcStatus(status)).toBe(1024 * 1024);
  });

  it('M1 regression: RssAnon:0 + RssShmem>0 returns shmem-only bytes (not null)', () => {
    // The pre-fix code did `if (anonKb > 0) return ...` which would treat
    // this case as "field missing" and fall through to VmRSS. The fix uses
    // field-presence checks so anon=0 + shmem=512 yields 512 KiB → 524_288.
    const status = [
      'RssAnon:\t0 kB',
      'RssShmem:\t512 kB',
    ].join('\n');
    expect(parseRssFromProcStatus(status)).toBe(512 * 1024);
  });

  it('returns null when neither RssAnon nor RssShmem is present (old kernel)', () => {
    // Linux kernels older than 4.5 don't expose these fields. Returning
    // null signals "fall back to VmRSS" to the caller.
    const status = [
      'Name:\tworker',
      'VmRSS:\t1024 kB',
      'VmSize:\t8192 kB',
    ].join('\n');
    expect(parseRssFromProcStatus(status)).toBeNull();
  });

  it('treats non-numeric fields as absent (regex matches digits only)', () => {
    // The `\d+` regex won't match "notanumber", so RssAnon is treated as
    // absent and the result reflects only the well-formed RssShmem field.
    // This is the right behavior: a corrupt RssAnon line shouldn't
    // poison an otherwise valid RssShmem reading.
    const status = [
      'RssAnon:\tnotanumber kB',
      'RssShmem:\t0 kB',
    ].join('\n');
    expect(parseRssFromProcStatus(status)).toBe(0);
  });

  it('returns null when ALL fields are non-numeric', () => {
    const status = [
      'RssAnon:\tnotanumber kB',
      'RssShmem:\talsobad kB',
    ].join('\n');
    expect(parseRssFromProcStatus(status)).toBeNull();
  });

  it('returns sum when only RssShmem is present (anon missing)', () => {
    // Symmetric to the regression: if only RssShmem is exposed for some
    // reason, we should still use it. Treats anonKb default as 0.
    const status = [
      'RssShmem:\t256 kB',
      'VmRSS:\t9999 kB',
    ].join('\n');
    expect(parseRssFromProcStatus(status)).toBe(256 * 1024);
  });

  it('M1 regression: explicit RssAnon:0 + RssShmem:0 returns 0 (not null)', () => {
    // Both fields present, both zero is a valid reading for a near-empty
    // worker process. Should be treated as 0 bytes, NOT a missing reading.
    const status = [
      'RssAnon:\t0 kB',
      'RssShmem:\t0 kB',
    ].join('\n');
    expect(parseRssFromProcStatus(status)).toBe(0);
  });
});

describe('getAccurateRss', () => {
  it('uses the parsed value when readStatus returns a valid /proc/self/status', () => {
    const fakeStatus = 'RssAnon:\t2048 kB\nRssShmem:\t0 kB\n';
    expect(getAccurateRss(() => fakeStatus)).toBe(2048 * 1024);
  });

  it('falls back to process.memoryUsage().rss when readStatus throws (non-Linux)', () => {
    const result = getAccurateRss(() => {
      throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    });
    // We can't assert the exact RSS value cross-platform, but it MUST be
    // a positive integer (process.memoryUsage().rss is always set).
    expect(result).toBeGreaterThan(0);
    expect(Number.isInteger(result)).toBe(true);
  });

  it('falls back when status text has no RssAnon/RssShmem fields (old kernel)', () => {
    const status = 'VmRSS:\t1024 kB\nVmSize:\t8192 kB\n';
    const result = getAccurateRss(() => status);
    // Falls back to process.memoryUsage().rss — a positive integer.
    expect(result).toBeGreaterThan(0);
    expect(Number.isInteger(result)).toBe(true);
  });

  it('falls back on malformed values rather than returning NaN', () => {
    const status = 'RssAnon:\tNaN kB\n';
    const result = getAccurateRss(() => status);
    expect(Number.isNaN(result)).toBe(false);
    expect(result).toBeGreaterThan(0);
  });
});
