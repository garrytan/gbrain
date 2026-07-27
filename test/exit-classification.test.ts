import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyWorkerExit } from '../src/core/minions/exit-classification.ts';

describe('classifyWorkerExit', () => {
  it('code=0 → clean_exit', () => {
    expect(classifyWorkerExit({ code: 0 })).toBe('clean_exit');
  });

  it('code=1 (runtime error) → crash', () => {
    expect(classifyWorkerExit({ code: 1 })).toBe('crash');
  });

  it('code=137 (SIGKILL) → crash', () => {
    expect(classifyWorkerExit({ code: 137 })).toBe('crash');
  });

  it('code=null (signal-only exit, audit JSON shape) → crash', () => {
    expect(classifyWorkerExit({ code: null })).toBe('crash');
  });

  it('missing code (older audit shape with undefined key) → crash', () => {
    // JSON.stringify drops undefined keys; reader may see {} or {code: null}.
    // Both must classify as crash so a corrupted/legacy row doesn't get
    // silently demoted into the clean-restart bucket.
    expect(classifyWorkerExit({})).toBe('crash');
  });
});

describe('consumer wire-up — helper used by all 3 sites (no inline filters left)', () => {
  // The whole point of T7 (DRY) is replacing three inline filters with one
  // helper. These tests pin the wire-up so a future refactor that
  // accidentally inlines the rule again gets caught at test time, not at
  // production-divergence time.

  // v0.35.5.0: doctor.ts and jobs.ts moved from `classifyWorkerExit` (binary
  // code-based) to `summarizeCrashes` (per-cause via `likely_cause`). The
  // wire-up contract is "must use a shared helper, not an inline filter" —
  // the specific helper differs by site. The supervisor's internal restart
  // policy still uses `classifyWorkerExit` (binary is the right shape there).
  const SITES = [
    { label: 'doctor.ts', path: 'src/commands/doctor.ts', helper: 'summarizeCrashes' },
    { label: 'jobs.ts', path: 'src/commands/jobs.ts', helper: 'summarizeCrashes' },
    { label: 'child-worker-supervisor.ts', path: 'src/core/minions/child-worker-supervisor.ts', helper: 'classifyWorkerExit' },
  ];

  for (const site of SITES) {
    it(`${site.label} uses a shared classifier helper (${site.helper})`, () => {
      const source = readFileSync(join(import.meta.dir, '..', site.path), 'utf8');
      // Helper is either imported by name (top-level) or via dynamic import.
      const helperRe = new RegExp(`\\b${site.helper}\\b`);
      expect(source).toMatch(helperRe);
    });

    it(`${site.label} calls ${site.helper} at least once`, () => {
      const source = readFileSync(join(import.meta.dir, '..', site.path), 'utf8');
      const callRe = new RegExp(`\\b${site.helper}\\s*\\(`);
      expect(source).toMatch(callRe);
    });
  }

  it('doctor.ts no longer has the inline `code !== 0 && code !== undefined` filter', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src/commands/doctor.ts'), 'utf8');
    // The pre-T7 inline filter; if this regex matches, the refactor leaked back.
    expect(source).not.toMatch(/code !== 0\s*&&\s*\(?\s*\w+\s+as\s+any\s*\)?\.\s*code !== undefined/);
  });

  it('jobs.ts no longer has the inline filter', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src/commands/jobs.ts'), 'utf8');
    expect(source).not.toMatch(/code !== 0\s*&&\s*\(?\s*\w+\s+as\s+any\s*\)?\.\s*code !== undefined/);
  });

  it('child-worker-supervisor.ts uses helper to decide clean_exit vs crash branch', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src/core/minions/child-worker-supervisor.ts'), 'utf8');
    // The exit-handler branch should compare the helper result, not the raw code.
    expect(source).toMatch(/classifyWorkerExit\(\s*\{\s*code\s*\}\s*\)\s*===\s*['"]clean_exit['"]/);
  });
});

describe('audit-log shape integration — `code: 0` event is NOT counted as a crash', () => {
  // Sanity round-trip: simulate the exact event shape that supervisor-audit
  // writes (and that doctor + jobs read), classify it through the helper,
  // and confirm the result. This catches future changes to the audit event
  // shape (e.g. renaming `code` to `exit_code`) that would silently break
  // the consumers' crash counting.
  it('audit event { event: "worker_exited", code: 0, signal: null } → clean_exit', () => {
    const auditEvent = {
      event: 'worker_exited',
      ts: '2026-05-15T12:00:00Z',
      code: 0,
      signal: null,
      runDurationMs: 30000,
      likelyCause: 'clean_exit',
    };
    expect(classifyWorkerExit(auditEvent as { code?: number | null })).toBe('clean_exit');
  });

  it('audit event { event: "worker_exited", code: 1, signal: null } → crash', () => {
    const auditEvent = {
      event: 'worker_exited',
      ts: '2026-05-15T12:00:00Z',
      code: 1,
      signal: null,
      runDurationMs: 250,
      likelyCause: 'runtime_error',
    };
    expect(classifyWorkerExit(auditEvent as { code?: number | null })).toBe('crash');
  });

  it('audit event { event: "worker_exited", code: null, signal: "SIGKILL" } → crash', () => {
    const auditEvent = {
      event: 'worker_exited',
      ts: '2026-05-15T12:00:00Z',
      code: null,
      signal: 'SIGKILL',
      runDurationMs: 0,
      likelyCause: 'oom_or_external_kill',
    };
    expect(classifyWorkerExit(auditEvent as { code?: number | null })).toBe('crash');
  });
});
