/**
 * Unit tests for src/commands/dream.ts — CLI alias over runCycle.
 *
 * dream is intentionally thin. These tests exercise the CLI surface
 * (argv parsing, brainDir resolution, output format, exit codes)
 * against a REAL runCycle + real library calls, backed by an
 * in-memory PGLite engine.
 *
 * Why no mocks: `mock.module` in bun is process-global and leaks
 * across test files (a stub of ../src/commands/orphans.ts breaks
 * every test that imports shouldExclude/deriveDomain/formatOrphansText).
 * Testing against real calls is honest and mock-leak-free.
 *
 * What this test file does NOT cover: the exhaustive dryRun-×-phases-×-
 * lock matrix, which test/core/cycle.test.ts handles (in isolation).
 * Here we only verify that dream.ts routes args correctly.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runDream } from '../src/commands/dream.ts';

// ─── Helpers ───────────────────────────────────────────────────────

/** Make an empty, engine-backed PGLite brain. */
async function makePGLite() {
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  return engine;
}

/** Make an empty git repo. Lint/backlinks have nothing to scan → status=clean. */
function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-dream-repo-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email t@t.co', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name t', { cwd: dir, stdio: 'pipe' });
  // Commit an empty .gitkeep so rev-parse HEAD succeeds.
  require('fs').writeFileSync(join(dir, '.gitkeep'), '');
  execSync('git add -A && git commit -m init', { cwd: dir, stdio: 'pipe' });
  return dir;
}

// ─── brainDir resolution ───────────────────────────────────────────

describe('runDream — brainDir resolution', () => {
  let repo: string;
  let engine: InstanceType<typeof PGLiteEngine>;

  beforeEach(async () => {
    repo = makeGitRepo();
    engine = await makePGLite();
  }, 60_000); // OAuth v25 + git init; needs breathing room under full-suite load

  afterEach(async () => {
    if (engine) await engine.disconnect();
    rmSync(repo, { recursive: true, force: true });
  }, 60_000);

  test('explicit --dir takes precedence over engine config', async () => {
    await engine.setConfig('sync.repo_path', '/configured/dir');
    const report = await runDream(engine, ['--dir', repo, '--json']);
    expect(report).toBeTruthy();
    if (report) expect(report.brain_dir).toBe(repo);
  });

  test('no --dir + engine-configured: uses engine.getConfig("sync.repo_path")', async () => {
    await engine.setConfig('sync.repo_path', repo);
    const report = await runDream(engine, ['--json']);
    expect(report).toBeTruthy();
    if (report) expect(report.brain_dir).toBe(repo);
  });

  test('no --dir + engine=null exits 1', async () => {
    const spy = spyOn(process, 'exit').mockImplementation(() => { throw new Error('EXIT'); });
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runDream(null, []);
    } catch (e: any) {
      expect(e.message).toBe('EXIT');
    }
    expect(spy).toHaveBeenCalledWith(1);
    spy.mockRestore();
    errSpy.mockRestore();
  });

  test('--dir pointing at nonexistent path exits 1', async () => {
    const spy = spyOn(process, 'exit').mockImplementation(() => { throw new Error('EXIT'); });
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runDream(null, ['--dir', '/does/not/exist/hopefully']);
    } catch (e: any) {
      expect(e.message).toBe('EXIT');
    }
    expect(spy).toHaveBeenCalledWith(1);
    spy.mockRestore();
    errSpy.mockRestore();
  });
});

// ─── Phase selection (single-phase runs stay fast) ─────────────────

describe('runDream — --phase <name> restricts the cycle', () => {
  let repo: string;
  let engine: InstanceType<typeof PGLiteEngine>;

  beforeEach(async () => {
    repo = makeGitRepo();
    engine = await makePGLite();
  }, 60_000); // OAuth v25 + git init; needs breathing room under full-suite load

  afterEach(async () => {
    if (engine) await engine.disconnect();
    rmSync(repo, { recursive: true, force: true });
  }, 60_000);

  test('--phase lint produces a report with exactly one phase = lint', async () => {
    const report = await runDream(engine, ['--dir', repo, '--phase', 'lint', '--json']);
    expect(report).toBeTruthy();
    if (report) {
      expect(report.phases.length).toBe(1);
      expect(report.phases[0].phase).toBe('lint');
    }
  });

  test('--phase orphans produces a report with exactly one phase = orphans', async () => {
    const report = await runDream(engine, ['--dir', repo, '--phase', 'orphans', '--json']);
    expect(report).toBeTruthy();
    if (report) {
      expect(report.phases.length).toBe(1);
      expect(report.phases[0].phase).toBe('orphans');
    }
  });

  test('--phase garbage exits 1 with an error message', async () => {
    const spy = spyOn(process, 'exit').mockImplementation(() => { throw new Error('EXIT'); });
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runDream(null, ['--dir', repo, '--phase', 'garbage']);
    } catch (e: any) {
      expect(e.message).toBe('EXIT');
    }
    expect(errSpy).toHaveBeenCalled();
    spy.mockRestore();
    errSpy.mockRestore();
  });
});

// ─── Output format ─────────────────────────────────────────────────

describe('runDream — output format', () => {
  let repo: string;
  let engine: InstanceType<typeof PGLiteEngine>;

  beforeEach(async () => {
    repo = makeGitRepo();
    engine = await makePGLite();
  }, 60_000); // OAuth v25 + git init; needs breathing room under full-suite load

  afterEach(async () => {
    if (engine) await engine.disconnect();
    rmSync(repo, { recursive: true, force: true });
  }, 60_000);

  test('--json emits parsable CycleReport JSON with schema_version', async () => {
    const lines: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((msg: string) => { lines.push(String(msg)); });
    await runDream(engine, ['--dir', repo, '--phase', 'lint', '--json']);
    logSpy.mockRestore();
    const parsed = JSON.parse(lines.join('\n'));
    expect(parsed.schema_version).toBe('1');
    expect(parsed).toHaveProperty('status');
    expect(parsed).toHaveProperty('phases');
    expect(parsed).toHaveProperty('totals');
  });

  test('human output for clean status mentions "Brain is healthy"', async () => {
    const lines: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((msg: string) => { lines.push(String(msg)); });
    // Single-phase lint run on a clean repo → status=clean.
    await runDream(engine, ['--dir', repo, '--phase', 'lint']);
    logSpy.mockRestore();
    expect(lines.join('\n')).toContain('Brain is healthy');
  });
});

// ─── Dry-run propagation ───────────────────────────────────────────

describe('runDream — dry-run propagates through to runCycle', () => {
  let repo: string;
  let engine: InstanceType<typeof PGLiteEngine>;

  beforeEach(async () => {
    repo = makeGitRepo();
    engine = await makePGLite();
  }, 60_000); // OAuth v25 + git init; needs breathing room under full-suite load

  afterEach(async () => {
    if (engine) await engine.disconnect();
    rmSync(repo, { recursive: true, force: true });
  }, 60_000);

  test('--dry-run produces a report where no DB-mutating work happened', async () => {
    // Before: empty pages table.
    const { rows: before } = await (engine as any).db.query('SELECT COUNT(*)::int AS n FROM pages');
    expect(before[0].n).toBe(0);

    await runDream(engine, ['--dir', repo, '--dry-run', '--json']);

    // After dry-run: still 0 pages. The cycle ran but wrote nothing.
    const { rows: after } = await (engine as any).db.query('SELECT COUNT(*)::int AS n FROM pages');
    expect(after[0].n).toBe(0);
  });
});

// ─── Exit-code semantics ───────────────────────────────────────────

describe('runDream — exit-code semantics', () => {
  let repo: string;
  let engine: InstanceType<typeof PGLiteEngine>;

  beforeEach(async () => {
    repo = makeGitRepo();
    engine = await makePGLite();
  }, 60_000); // OAuth v25 + git init; needs breathing room under full-suite load

  afterEach(async () => {
    if (engine) await engine.disconnect();
    rmSync(repo, { recursive: true, force: true });
  }, 60_000);

  test('clean/ok/partial statuses do not call process.exit', async () => {
    const spy = spyOn(process, 'exit').mockImplementation(() => { throw new Error('UNEXPECTED_EXIT'); });
    await runDream(engine, ['--dir', repo, '--phase', 'lint', '--json']);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ─── v0.41.13: --source / --source-id wiring (supersedes PR #1559) ────
//
// Covers:
//   - argv repetition + conflict rules (parseArgs path)
//   - engine-null guard (D1 from eng review)
//   - assertSourceExists propagation (resolveSourceId path)
//   - archived-source guard (D2)
//   - --source-id alias equivalence (D3)
//   - --help short-circuit ordering (C-8)
//   - typed-error propagation (T3: TypeError must NOT be swallowed)
//   - end-to-end dream→doctor (D5): writeback flips cycle_freshness
//   - back-compat regression: bare `gbrain dream` writes no per-source stamp

describe('runDream — --source / --source-id (v0.41.13)', () => {
  let repo: string;
  let engine: InstanceType<typeof PGLiteEngine>;

  async function seedSource(id: string, archived: boolean = false): Promise<void> {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, archived, created_at)
       VALUES ($1, $2, $3, '{}'::jsonb, $4, NOW())
       ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path, archived = EXCLUDED.archived`,
      [id, id, repo, archived],
    );
  }

  async function readLastFullCycleAt(sourceId: string): Promise<string | null> {
    const sources = await engine.listAllSources();
    const s = sources.find(x => x.id === sourceId);
    if (!s) return null;
    const raw = (s.config as any)?.last_full_cycle_at;
    return typeof raw === 'string' ? raw : null;
  }

  beforeEach(async () => {
    repo = makeGitRepo();
    engine = await makePGLite();
  }, 60_000);

  afterEach(async () => {
    if (engine) await engine.disconnect();
    rmSync(repo, { recursive: true, force: true });
  }, 60_000);

  // ─── parseArgs: --source missing / conflict / repetition ────────────

  test('--source with no value exits 2 with usage hint', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => { throw new Error('EXIT'); });
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runDream(engine, ['--source']);
    } catch (e: any) {
      expect(e.message).toBe('EXIT');
    }
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/--source.*missing value/);
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  test('--source-id with no value exits 2 with usage hint', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => { throw new Error('EXIT'); });
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runDream(engine, ['--source-id']);
    } catch (e: any) {
      expect(e.message).toBe('EXIT');
    }
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/--source-id.*missing value/);
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  test('--source X --source Y (repeated, different values) exits 2', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => { throw new Error('EXIT'); });
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runDream(engine, ['--source', 'foo', '--source', 'bar']);
    } catch (e: any) {
      expect(e.message).toBe('EXIT');
    }
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/specify --source once/);
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  test('--source X --source X (repeated, same value) is accepted', async () => {
    await seedSource('alpha');
    const report = await runDream(engine, ['--dir', repo, '--phase', 'lint', '--source', 'alpha', '--source', 'alpha', '--json']);
    expect(report).toBeTruthy();
    if (report) expect(['ok', 'clean']).toContain(report.status);
  }, 60_000);

  test('--source X --source-id Y (conflict) exits 2', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => { throw new Error('EXIT'); });
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runDream(engine, ['--source', 'foo', '--source-id', 'bar']);
    } catch (e: any) {
      expect(e.message).toBe('EXIT');
    }
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/use --source OR --source-id, not both/);
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  // ─── Help short-circuit ordering (C-8 IRON RULE) ────────────────────

  test('--help --source whatever prints help and exits 0 (no engine-null error)', async () => {
    // engine null + --source set would normally exit 1, but --help short-circuits first.
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => { throw new Error('EXIT'); });
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await runDream(null, ['--help', '--source', 'anything']);
      expect(result).toBeUndefined();
    } catch (e: any) {
      throw new Error('--help with --source should NOT exit; got: ' + e.message);
    }
    expect(exitSpy).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join(' ')).toMatch(/Usage: gbrain dream/);
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  // ─── Engine-null guard (D1) ─────────────────────────────────────────

  test('engine=null + --source set exits 1 with "requires a connected brain"', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => { throw new Error('EXIT'); });
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runDream(null, ['--source', 'whatever']);
    } catch (e: any) {
      expect(e.message).toBe('EXIT');
    }
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/requires a connected brain/);
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  // ─── Unknown source (resolveSourceId throw) ─────────────────────────

  test('--source <unknown> exits 1 with assertSourceExists hint', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => { throw new Error('EXIT'); });
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runDream(engine, ['--source', 'no-such-source']);
    } catch (e: any) {
      expect(e.message).toBe('EXIT');
    }
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOut = errSpy.mock.calls.flat().join(' ');
    expect(errOut).toMatch(/Source "no-such-source" not found/);
    expect(errOut).toMatch(/gbrain sources list/);
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  // ─── Archived source guard (D2) ─────────────────────────────────────

  test('--source <archived> exits 1 and leaves last_full_cycle_at untouched', async () => {
    await seedSource('archived-thing', /* archived = */ true);
    const before = await readLastFullCycleAt('archived-thing');
    expect(before).toBeNull();

    const exitSpy = spyOn(process, 'exit').mockImplementation(() => { throw new Error('EXIT'); });
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runDream(engine, ['--source', 'archived-thing']);
    } catch (e: any) {
      expect(e.message).toBe('EXIT');
    }
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOut = errSpy.mock.calls.flat().join(' ');
    expect(errOut).toMatch(/source archived-thing is archived/);
    expect(errOut).toMatch(/gbrain sources restore archived-thing/);

    const after = await readLastFullCycleAt('archived-thing');
    expect(after).toBeNull(); // archived guard prevents writeback
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  // ─── Happy path: --source writes last_full_cycle_at (the bug fix) ───

  test('--source <existing> writes last_full_cycle_at on success (PR #1559 regression)', async () => {
    await seedSource('media-corpus');
    const before = await readLastFullCycleAt('media-corpus');
    expect(before).toBeNull();

    const t0 = Date.now();
    const report = await runDream(engine, ['--dir', repo, '--source', 'media-corpus', '--phase', 'lint', '--json']);
    expect(report).toBeTruthy();
    if (report) expect(['ok', 'clean']).toContain(report.status);

    const after = await readLastFullCycleAt('media-corpus');
    expect(after).not.toBeNull();
    const writtenMs = new Date(after!).getTime();
    expect(writtenMs).toBeGreaterThanOrEqual(t0);
    expect(writtenMs).toBeLessThanOrEqual(Date.now() + 1000);
  }, 60_000);

  // ─── Back-compat: bare `gbrain dream` does NOT write per-source stamp ─

  test('gbrain dream (no --source) leaves all sources untouched (back-compat regression)', async () => {
    await seedSource('alpha');
    await seedSource('beta');
    const report = await runDream(engine, ['--dir', repo, '--phase', 'lint', '--json']);
    expect(report).toBeTruthy();
    expect(await readLastFullCycleAt('alpha')).toBeNull();
    expect(await readLastFullCycleAt('beta')).toBeNull();
  }, 60_000);

  // ─── --source-id alias equivalence (D3) ─────────────────────────────

  test('--source-id <existing> is equivalent to --source (writes timestamp)', async () => {
    await seedSource('beta');
    const before = await readLastFullCycleAt('beta');
    expect(before).toBeNull();

    const report = await runDream(engine, ['--dir', repo, '--source-id', 'beta', '--phase', 'lint', '--json']);
    expect(report).toBeTruthy();
    if (report) expect(['ok', 'clean']).toContain(report.status);

    const after = await readLastFullCycleAt('beta');
    expect(after).not.toBeNull();
  }, 60_000);

  // ─── T3: TypeError MUST propagate (not swallowed by predicate-gated catch) ─

  test('non-resolver-user errors propagate uncaught (T3)', async () => {
    // Monkey-patch executeRaw to throw a synthetic TypeError on the
    // assertSourceExists SELECT. The typed-error catch in runDream only
    // matches resolver-user-error message shapes; a TypeError thrown
    // from any source-resolution path must bubble up with its original
    // stack trace (proving real programmer bugs are NOT hidden behind
    // operator-error UX).
    await seedSource('gamma');
    const original = (engine as any).executeRaw.bind(engine);
    let restored = false;
    try {
      // Throw a TypeError on the source-lookup SELECT that assertSourceExists runs.
      // Other executeRaw calls (used by engine internals during cycle) keep
      // working so the test exercises ONLY the resolution-path failure.
      (engine as any).executeRaw = async (sql: string, params?: unknown[]) => {
        if (typeof sql === 'string' && /FROM\s+sources\s+WHERE\s+id\s*=/i.test(sql)) {
          throw new TypeError('synthetic-test-bug');
        }
        return original(sql, params);
      };
      await expect(
        runDream(engine, ['--dir', repo, '--source', 'gamma', '--phase', 'lint', '--json'])
      ).rejects.toThrow(/synthetic-test-bug/);
    } finally {
      (engine as any).executeRaw = original;
      restored = true;
    }
    expect(restored).toBe(true);
  });
});

// ─── v0.41.13 D5: end-to-end dream → checkCycleFreshness parity ───────
//
// Closes the column-rename drift class: if a future PR renames
// last_full_cycle_at on one side but not the other, both isolated
// tests stay green but production breaks. This exercises the FULL
// chain through the exact seam both sides consume.

describe('runDream → checkCycleFreshness end-to-end (D5)', () => {
  let repo: string;
  let engine: InstanceType<typeof PGLiteEngine>;

  beforeEach(async () => {
    repo = makeGitRepo();
    engine = await makePGLite();
  }, 60_000);

  afterEach(async () => {
    if (engine) await engine.disconnect();
    rmSync(repo, { recursive: true, force: true });
  }, 60_000);

  test('stale source becomes fresh after dream --source (column-name drift guard)', async () => {
    // Seed source with last_full_cycle_at backdated 25h (above warn floor).
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, archived, created_at)
       VALUES ('gamma', 'gamma', $1, jsonb_build_object('last_full_cycle_at', $2::text), false, NOW())`,
      [repo, stale],
    );

    // Doctor sees stale (warn or fail; we only care that it's NOT ok)
    const { checkCycleFreshness } = await import('../src/commands/doctor.ts');
    const beforeCheck = await checkCycleFreshness(engine);
    expect(beforeCheck.status).not.toBe('ok');

    // Run dream against the stale source.
    const report = await runDream(engine, ['--dir', repo, '--source', 'gamma', '--phase', 'lint', '--json']);
    expect(report).toBeTruthy();
    if (report) expect(['ok', 'clean']).toContain(report.status);

    // Doctor now sees fresh.
    const afterCheck = await checkCycleFreshness(engine);
    expect(afterCheck.status).toBe('ok');
  }, 60_000);
});
