/**
 * memory_verbs_usage doctor check
 * (buildMemoryVerbsCheck in src/commands/doctor/checks/verbs-reflex.ts).
 *
 * Uses the usage-log path seam (__setUsageLogPathForTests in
 * src/core/verbs/usage-log.ts) — no env mutation, so this file stays
 * non-serial per the plan's preference.
 *
 * Pins:
 *   - no usage sidecar -> ok "no verb calls recorded yet";
 *   - a two-verb JSONL mix -> ok reporting per-verb counts + the last event;
 *   - malformed JSONL lines -> SKIPPED, check stays ok and never throws.
 *
 * Reality note vs the plan: the plan expected a malformed line to warn
 * "observability degraded". In the real implementation readVerbUsage()
 * tolerates torn lines by design (skips them; documented "torn line — skip")
 * and swallows read errors (returns []), so the check's warn branch
 * ("verb usage sidecar unreadable (...) — observability degraded; verbs
 * unaffected") is unreachable via file contents — it only fires if the
 * usage-log module itself fails to import/execute. This file therefore pins
 * the STRONGER fail-open truth: garbage in the sidecar (including a sidecar
 * that is a directory) never degrades the check below ok and never throws.
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMemoryVerbsCheck } from '../src/commands/doctor/checks/verbs-reflex.ts';
import { __setUsageLogPathForTests } from '../src/core/verbs/usage-log.ts';

const cleanups: string[] = [];

afterEach(() => {
  __setUsageLogPathForTests(null); // always restore the seam
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempSidecarPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-verbs-usage-'));
  cleanups.push(dir);
  return join(dir, 'usage.jsonl');
}

function eventLine(verb: string, ts: string): string {
  return JSON.stringify({
    ts,
    verb,
    surface: 'verbs',
    remote: false,
    ok: true,
    latency_ms: 12,
    brain_id: '/tmp/test-brain',
    source_id: 'default',
  });
}

/** An ISO timestamp `minutesAgo` minutes in the past (inside the 30d window). */
function recentTs(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

describe('memory_verbs_usage', () => {
  test('no usage sidecar -> ok, fresh-install message', async () => {
    __setUsageLogPathForTests(tempSidecarPath()); // path never written
    const check = await buildMemoryVerbsCheck();
    expect(check.name).toBe('memory_verbs_usage');
    expect(check.status).toBe('ok');
    expect(check.message).toContain('no verb calls recorded yet');
    expect(check.message).toContain('sidecar appears on first remember/recall');
  });

  test('two-verb mix -> ok reporting counts and the last event', async () => {
    const path = tempSidecarPath();
    const lastTs = recentTs(1);
    writeFileSync(
      path,
      [eventLine('recall', recentTs(30)), eventLine('recall', recentTs(10)), eventLine('remember', lastTs)].join(
        '\n',
      ) + '\n',
    );
    __setUsageLogPathForTests(path);
    const check = await buildMemoryVerbsCheck();
    expect(check.status).toBe('ok');
    expect(check.message).toContain('3 verb calls in 30d');
    expect(check.message).toContain('recall:2');
    expect(check.message).toContain('remember:1');
    expect(check.message).toContain(`last remember at ${lastTs}`);
    expect(check.message).toContain('local JSONL only, never uploaded');
  });

  test('malformed line among valid ones -> skipped, check stays ok (reality: no warn)', async () => {
    const path = tempSidecarPath();
    writeFileSync(
      path,
      [eventLine('recall', recentTs(5)), '{"torn write, not json', eventLine('forget', recentTs(2))].join('\n') +
        '\n',
    );
    __setUsageLogPathForTests(path);
    const check = await buildMemoryVerbsCheck(); // must resolve, never throw
    expect(check.status).toBe('ok');
    // Only the two valid lines are counted; the torn line is silently skipped.
    expect(check.message).toContain('2 verb calls in 30d');
    expect(check.message).toContain('recall:1');
    expect(check.message).toContain('forget:1');
    expect(check.message).not.toContain('observability degraded');
  });

  test('sidecar of ONLY malformed lines -> ok, treated as no recent events', async () => {
    const path = tempSidecarPath();
    writeFileSync(path, 'not json at all\n{"also: broken\n');
    __setUsageLogPathForTests(path);
    const check = await buildMemoryVerbsCheck();
    expect(check.status).toBe('ok');
    expect(check.message).toBe('sidecar present; no verb calls in the last 30 days');
  });

  test('events older than the 30-day window are excluded', async () => {
    const path = tempSidecarPath();
    const oldTs = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(path, eventLine('recall', oldTs) + '\n');
    __setUsageLogPathForTests(path);
    const check = await buildMemoryVerbsCheck();
    expect(check.status).toBe('ok');
    expect(check.message).toBe('sidecar present; no verb calls in the last 30 days');
  });

  test('sidecar path exists but is unreadable as a file (a directory) -> ok, never throws', async () => {
    const path = tempSidecarPath();
    mkdirSync(path, { recursive: true }); // existsSync true; readFile -> EISDIR, swallowed
    __setUsageLogPathForTests(path);
    const check = await buildMemoryVerbsCheck();
    expect(check.status).toBe('ok');
    expect(check.message).toBe('sidecar present; no verb calls in the last 30 days');
  });
});
