/**
 * Resident memory as the RSS watchdogs count it: RssAnon + RssShmem from /proc/<pid>/status, the non-file-backed pages a
 * leak grows (file-backed mappings such as Git packfiles are cache the kernel reclaims). The worker reads its own; since
 * GBRA-133 the worker also reads each job child's process tree (child-job-runner.ts), so --max-rss bounds a run-child too.
 */
import { readFileSync } from 'node:fs';

/**
 * Pure parser for /proc/self/status RSS fields. Returns bytes of
 * RssAnon + RssShmem when either field is present, or null when the
 * status text is from a kernel that doesn't expose those fields
 * (kernels older than 4.5) or the values are malformed. Exported so
 * the test suite can unit-test the field-presence + malformed-value
 * edge cases without mocking the filesystem.
 *
 * M1 fix: field-presence check, not value-presence check. The earlier
 * `if (anonKb > 0)` form conflated "field exists with value 0" with
 * "field missing", which mis-routed to VmRSS fallback in the legitimate
 * shmem-only worker case (RssAnon: 0 + RssShmem: 512).
 */
export function parseRssFromProcStatus(status: string): number | null {
  const anonMatch = status.match(/^RssAnon:\s+(\d+)/m);
  const shmemMatch = status.match(/^RssShmem:\s+(\d+)/m);
  if (anonMatch === null && shmemMatch === null) {
    return null;
  }
  const anonKb = parseInt(anonMatch?.[1] ?? '0', 10);
  const shmemKb = parseInt(shmemMatch?.[1] ?? '0', 10);
  if (isNaN(anonKb) || isNaN(shmemKb)) {
    return null;
  }
  return (anonKb + shmemKb) * 1024; // bytes
}

/** RssAnon + RssShmem of one process in bytes, or null when it is gone or the kernel does not report the fields. */
export function readProcessRss(pid: number, readStatus: (pid: number) => string = p => readFileSync(`/proc/${p}/status`, 'utf8')): number | null {
  try { return parseRssFromProcStatus(readStatus(pid)); } catch { return null; }
}
