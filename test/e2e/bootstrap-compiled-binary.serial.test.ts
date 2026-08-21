/**
 * Compiled-binary render e2e [ENG-6]: `bin/gbrain` ships via `bun build
 * --compile`, where filesystem-relative template resolution breaks — the
 * bootstrap templates + question bank are STATICALLY IMPORTED (bundled).
 * This test proves it: a compiled binary run in an EMPTY temp cwd with NO
 * repo checkout present must still render the templates.
 *
 *   - build the binary ONCE at module scope (slow — this file carries the
 *     cost alone; generous timeouts; skipped with a reason when
 *     `bun build --compile` is unavailable/failing in this environment);
 *   - `<tmp>/gbrain-test bootstrap render --minimal` in the empty cwd →
 *     rendered files appear with template content (AGENTS.md contains
 *     'Per-message gates'), manifest is the placeholder template;
 *   - `<tmp>/gbrain-test bootstrap status --json` parses with the full
 *     phase list.
 *
 * Serial: subprocess spawns + a one-off multi-minute compile.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { BOOTSTRAP_PHASE_IDS } from '../../src/core/bootstrap/status.ts';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');

// ── One-off compile at module scope (so test.skipIf sees the verdict) ───────

const buildDir = mkdtempSync(join(tmpdir(), 'gb-bin-'));
const binPath = join(buildDir, 'gbrain-test');

let built = false;
let buildFailReason = '';
{
  const res = spawnSync('bun', ['build', '--compile', '--outfile', binPath, 'src/cli.ts'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 240_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    buildFailReason = `bun build --compile unavailable: ${res.error.message}`;
  } else if (res.status !== 0) {
    buildFailReason = `bun build --compile exited ${res.status}: ${(res.stderr ?? '').slice(-2000)}`;
  } else if (!existsSync(binPath)) {
    buildFailReason = 'bun build --compile exited 0 but produced no binary';
  } else {
    built = true;
  }
  if (!built) {
    // On CI (or wherever GBRAIN_REQUIRE_COMPILE=1 is set) a failed compile
    // must be a loud red — skipIf(!built) would otherwise become a PERMANENT
    // silent skip the moment `bun build --compile` breaks. Dev boxes keep
    // the graceful skip.
    if (process.env.GITHUB_ACTIONS || process.env.GBRAIN_REQUIRE_COMPILE === '1') {
      throw new Error(`[bootstrap-compiled-binary] compile is required in this environment but failed: ${buildFailReason}`);
    }
    console.error(`[bootstrap-compiled-binary] SKIPPING: ${buildFailReason}`);
  }
}

// Empty cwd with NO repo checkout, sandboxed GBRAIN_HOME. A minimal env
// (no inherited GBRAIN_*/provider state) mirrors the GUI-host reality the
// compiled binary must survive.
const emptyWs = mkdtempSync(join(tmpdir(), 'gb-bin-ws-'));
const homeParent = mkdtempSync(join(tmpdir(), 'gb-bin-home-'));
const childEnv: Record<string, string> = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: homeParent,
  GBRAIN_HOME: homeParent,
  GBRAIN_SKIP_STARTUP_HOOKS: '1',
};

afterAll(() => {
  for (const dir of [buildDir, emptyWs, homeParent]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe('bootstrap compiled-binary render [ENG-6] (serial e2e)', () => {
  test.skipIf(!built)('compiled `bootstrap render --minimal` in an empty cwd renders bundled templates', () => {
    const res = spawnSync(binPath, ['bootstrap', 'render', '--minimal'], {
      cwd: emptyWs,
      env: childEnv,
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(res.error).toBeUndefined();
    if (res.status !== 0) {
      throw new Error(`render --minimal exited ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
    }

    // Rendered files exist WITH template content — the [ENG-6] proof that
    // the templates rode the binary, not the (absent) repo checkout.
    const agents = join(emptyWs, 'AGENTS.md');
    expect(existsSync(agents)).toBe(true);
    expect(readFileSync(agents, 'utf8')).toContain('Per-message gates');

    // Minimal mode: required keys stay as literal fill-me placeholders.
    const soul = readFileSync(join(emptyWs, 'SOUL.md'), 'utf8');
    expect(soul).toContain('{{AGENT_NAME}}');

    // Manifest is the canonical placeholder template (initialized: false).
    const manifest = JSON.parse(readFileSync(join(emptyWs, 'agent.json'), 'utf8')) as {
      initialized: boolean;
      format_version: number;
    };
    expect(manifest.initialized).toBe(false);
    expect(manifest.format_version).toBe(1);

    // Scaffold pieces made it too (the gitignore template is bundled).
    expect(existsSync(join(emptyWs, '.gitignore'))).toBe(true);
    expect(existsSync(join(emptyWs, 'memory', 'README.md'))).toBe(true);
  }, 180_000);

  test.skipIf(!built)('compiled `bootstrap status --json` parses with the full phase list', () => {
    const res = spawnSync(binPath, ['bootstrap', 'status', '--json'], {
      cwd: emptyWs,
      env: childEnv,
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(res.error).toBeUndefined();
    if (res.status !== 0) {
      throw new Error(`status --json exited ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
    }
    const parsed = JSON.parse(res.stdout) as {
      phases: Array<{ id: string; state: string }>;
      support: { binary_version: string };
    };
    expect(parsed.phases.map((p) => p.id)).toEqual([...BOOTSTRAP_PHASE_IDS]);
    expect(parsed.support.binary_version.length).toBeGreaterThan(0);
    // The minimal render above left a TEMPLATE manifest — status must read
    // it as a partial render (the template→initialized discriminator), not
    // as done and not as a crash.
    const render = parsed.phases.find((p) => p.id === 'render')!;
    expect(render.state).toBe('partial');
  }, 180_000);

  // #4266: bundled schema packs must ride the compiled binary the same way
  // the bootstrap templates do. Pre-fix, the import.meta-relative pack paths
  // pointed at directories absent from /$bunfs, so EVERY bundled pack lookup
  // failed: `schema active` printed `unknown schema pack: gbrain-base` and
  // `schema show <bundled>` printed `Unknown pack`.
  test.skipIf(!built)('compiled `schema active` + `schema show` resolve bundled packs (#4266)', () => {
    // Exercises load-active.ts:defaultPackLocator (default pack gbrain-base).
    const active = spawnSync(binPath, ['schema', 'active'], {
      cwd: emptyWs,
      env: childEnv,
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(active.error).toBeUndefined();
    if (active.status !== 0) {
      throw new Error(`schema active exited ${active.status}\nstdout: ${active.stdout}\nstderr: ${active.stderr}`);
    }
    expect(active.stdout).toContain('Active pack: gbrain-base');

    // Exercises schema.ts:packPathByName (explicit bundled-pack lookup).
    const show = spawnSync(binPath, ['schema', 'show', 'gbrain-base-v2', '--json'], {
      cwd: emptyWs,
      env: childEnv,
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(show.error).toBeUndefined();
    if (show.status !== 0) {
      throw new Error(`schema show exited ${show.status}\nstdout: ${show.stdout}\nstderr: ${show.stderr}`);
    }
    const manifest = JSON.parse(show.stdout) as { name: string; page_types: unknown[] };
    expect(manifest.name).toBe('gbrain-base-v2');
    expect(manifest.page_types.length).toBeGreaterThan(0);
  }, 180_000);

  test.skipIf(built)('SKIPPED: bun build --compile unavailable in this environment', () => {
    // Placeholder that documents WHY the two tests above were skipped —
    // visible in the run output instead of a silent skip.
    expect(buildFailReason.length).toBeGreaterThan(0);
  });
});
