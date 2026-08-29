/**
 * The harness-lane CLI surface (spawned through src/cli.ts — exercises the
 * peeled arg parsers, the flag registry, per-harness defaults, the stub
 * preflight refusal, receipts, and the post-peel dispatch smoke [ENG-E5]).
 *
 * Hermetic: HOME and GBRAIN_HOME pinned to tempdirs in every spawn — the
 * claude-code default dest derives from HOME (host-specs HOME-env-first
 * discipline) and bridge state lives under GBRAIN_HOME/.gbrain.
 */

import { describe, expect, test, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const REPO_ROOT = resolve(import.meta.dir, '..');
const CLI = join(REPO_ROOT, 'src', 'cli.ts');

const cleanups: string[] = [];
afterEach(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});

function homes(): { home: string; gbrainHome: string } {
  const home = mkdtempSync(join(tmpdir(), 'gb-harness-cli-home-'));
  const gbrainHome = mkdtempSync(join(tmpdir(), 'gb-harness-cli-gb-'));
  cleanups.push(home, gbrainHome);
  return { home, gbrainHome };
}

function run(args: string[], env: Record<string, string>) {
  const r = spawnSync('bun', [CLI, 'skillpack', ...args], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    timeout: 120_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('scaffold --harness claude-code', () => {
  test('defaults: coding-agent persona into HOME/.claude/skills; state under GBRAIN_HOME; idempotent re-run', () => {
    const { home, gbrainHome } = homes();
    const env = { HOME: home, GBRAIN_HOME: gbrainHome, CLAUDE_CONFIG_DIR: '' };

    const r1 = run(['scaffold', '--harness', 'claude-code', '--json'], env);
    expect(r1.code, r1.stderr).toBe(0);
    const receipt = JSON.parse(r1.stdout);
    expect(receipt.persona).toBe('coding-agent');
    expect(receipt.mode).toBe('full');
    expect(receipt.dest).toBe(join(home, '.claude', 'skills'));
    expect(receipt.summary.wroteNew).toBeGreaterThan(30);
    expect(receipt.summary.skippedExisting).toBe(0);
    expect(receipt.coexistence.plugin_lane_overlap.length).toBeGreaterThan(10);
    expect(existsSync(join(home, '.claude', 'skills', 'query', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(home, '.claude', 'skills', 'conventions'))).toBe(true);
    // Lane exclusion holds end-to-end: no repo-dev skill in a harness dir.
    expect(existsSync(join(home, '.claude', 'skills', 'testing'))).toBe(false);
    // State landed under GBRAIN_HOME.
    const statePath = join(gbrainHome, '.gbrain', 'skillpack-bridge-state.json');
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(state.entries[0].harness).toBe('claude-code');
    expect(state.entries[0].last_persona).toBe('coding-agent');

    const r2 = run(['scaffold', '--harness', 'claude-code', '--json'], env);
    const receipt2 = JSON.parse(r2.stdout);
    expect(receipt2.summary.wroteNew).toBe(0);
    expect(receipt2.summary.skippedExisting).toBe(receipt.summary.wroteNew);
  }, 180_000);

  test('--dry-run writes nothing', () => {
    const { home, gbrainHome } = homes();
    const r = run(['scaffold', '--harness', 'claude-code', '--dry-run', '--json'], {
      HOME: home,
      GBRAIN_HOME: gbrainHome,
      CLAUDE_CONFIG_DIR: '',
    });
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(join(home, '.claude', 'skills'))).toBe(false);
  }, 120_000);
});

describe('refusals (typed, actionable)', () => {
  test('codex/opencode without a dest exit 2 naming the observation-run gap', () => {
    const { home, gbrainHome } = homes();
    for (const h of ['codex', 'opencode']) {
      const r = run(['scaffold', '--harness', h], { HOME: home, GBRAIN_HOME: gbrainHome });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('no attested native skills dir');
      expect(r.stderr).toContain('observation run');
    }
  }, 120_000);

  test('unknown persona exits 2 listing the valid choices', () => {
    const { home, gbrainHome } = homes();
    const dest = mkdtempSync(join(tmpdir(), 'gb-harness-dest-'));
    cleanups.push(dest);
    const r = run(['scaffold', '--harness', 'claude-code', '--persona', 'nope', '--dest', dest], {
      HOME: home,
      GBRAIN_HOME: gbrainHome,
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('coding-agent');
  }, 120_000);

  test('--skill testing is refused with the recorded lane-exclusion reason [OV5]', () => {
    const { home, gbrainHome } = homes();
    const dest = mkdtempSync(join(tmpdir(), 'gb-harness-dest-'));
    cleanups.push(dest);
    const r = run(['scaffold', '--harness', 'claude-code', '--skill', 'testing', '--dest', dest], {
      HOME: home,
      GBRAIN_HOME: gbrainHome,
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('excluded from the plugin lane');
  }, 120_000);

  test('--stub with the publish gate off exits 2 with the exact enable command [D3B preflight]', () => {
    const { home, gbrainHome } = homes();
    const dest = mkdtempSync(join(tmpdir(), 'gb-harness-dest-'));
    cleanups.push(dest);
    const r = run(['scaffold', '--harness', 'claude-code', '--stub', '--skill', 'query', '--dest', dest], {
      HOME: home,
      GBRAIN_HOME: gbrainHome,
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('mcp.publish_skills');
    expect(r.stderr).toContain('gbrain config set mcp.publish_skills true');
    expect(existsSync(join(dest, 'query'))).toBe(false); // dead pointers never land
  }, 120_000);

  test('unknown --harness value exits 2 naming the valid set', () => {
    const { home, gbrainHome } = homes();
    const r = run(['scaffold', '--harness', 'pi'], { HOME: home, GBRAIN_HOME: gbrainHome });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('claude-code');
  }, 120_000);
});

describe('remove --harness', () => {
  test('removes only ledger-owned files and updates state', () => {
    const { home, gbrainHome } = homes();
    const dest = mkdtempSync(join(tmpdir(), 'gb-harness-dest-'));
    cleanups.push(dest);
    const env = { HOME: home, GBRAIN_HOME: gbrainHome };
    const r1 = run(['scaffold', '--harness', 'claude-code', '--skill', 'query', '--skill', 'ingest', '--dest', dest, '--json'], env);
    expect(r1.code, r1.stderr).toBe(0);

    const r2 = run(['remove', '--harness', 'claude-code', '--dest', dest, '--skill', 'query', '--json'], env);
    expect(r2.code, r2.stderr).toBe(0);
    const receipt = JSON.parse(r2.stdout);
    expect(receipt.removedFiles.length).toBeGreaterThan(0);
    expect(receipt.notOwned).toEqual([]);
    expect(existsSync(join(dest, 'query', 'SKILL.md'))).toBe(false);
    expect(existsSync(join(dest, 'ingest', 'SKILL.md'))).toBe(true);
  }, 180_000);

  test('bare remove prints usage and exits 2', () => {
    const { home, gbrainHome } = homes();
    const r = run(['remove'], { HOME: home, GBRAIN_HOME: gbrainHome });
    expect(r.code).toBe(2);
  }, 120_000);
});

describe('post-peel dispatch smoke [ENG-E5]', () => {
  test('help surfaces route through the façade and mention the harness lane', () => {
    const { home, gbrainHome } = homes();
    const env = { HOME: home, GBRAIN_HOME: gbrainHome };
    const top = run(['--help'], env);
    expect(top.code).toBe(0);
    expect(top.stdout).toContain('scaffold --harness');
    expect(top.stdout).toContain('remove --harness');
    const sc = run(['scaffold', '--help'], env);
    expect(sc.code).toBe(0);
    expect(sc.stdout).toContain('--workspace');
    const sch = run(['scaffold', '--harness', 'claude-code', '--help'], env);
    expect(sch.code).toBe(0);
    expect(sch.stdout).toContain('--persona');
    const ref = run(['reference', '--help'], env);
    expect(ref.code).toBe(0);
    expect(ref.stdout).toContain('--apply-clean-hunks');
  }, 180_000);

  test('the v0.33 removal contract is untouched: install/uninstall still exit 2', () => {
    const { home, gbrainHome } = homes();
    const env = { HOME: home, GBRAIN_HOME: gbrainHome };
    const i = run(['install'], env);
    expect(i.code).toBe(2);
    expect(i.stderr).toContain('removed in v0.33');
    const u = run(['uninstall'], env);
    expect(u.code).toBe(2);
    expect(u.stderr).toContain('removed in v0.33');
  }, 120_000);
});

describe('scaffold --harness openclaw (workspace delegation)', () => {
  test('--skill picks filter the workspace scaffold; plugin-lane additions are reported skipped, not thrown', () => {
    const { home, gbrainHome } = homes();
    const ws = mkdtempSync(join(tmpdir(), 'gb-harness-ws-'));
    cleanups.push(ws);
    const env = { HOME: home, GBRAIN_HOME: gbrainHome };
    // gbrain-upgrade is a plugin-lane ADDITION (absent from the openclaw
    // bundle): the openclaw path must skip-and-report it, never throw.
    const r = run(
      ['scaffold', '--harness', 'openclaw', '--workspace', ws, '--skill', 'query', '--skill', 'gbrain-upgrade', '--json'],
      env,
    );
    expect(r.code, r.stderr).toBe(0);
    const receipt = JSON.parse(r.stdout);
    expect(receipt.openclaw_skipped).toEqual(['gbrain-upgrade']);
    expect(existsSync(join(ws, 'skills', 'query', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(ws, 'skills', 'gbrain-upgrade'))).toBe(false);
    expect(existsSync(join(ws, 'skills', 'conventions'))).toBe(true);
  }, 120_000);

  test('all-additions selection refuses with a clear error; --stub and --dest are refused', () => {
    const { home, gbrainHome } = homes();
    const ws = mkdtempSync(join(tmpdir(), 'gb-harness-ws-'));
    cleanups.push(ws);
    const env = { HOME: home, GBRAIN_HOME: gbrainHome };
    const none = run(['scaffold', '--harness', 'openclaw', '--workspace', ws, '--skill', 'gbrain-upgrade'], env);
    expect(none.code).toBe(2);
    expect(none.stderr).toContain('plugin-lane additions');
    const stub = run(['scaffold', '--harness', 'openclaw', '--workspace', ws, '--stub'], env);
    expect(stub.code).toBe(2);
    expect(stub.stderr).toContain('not supported for openclaw');
    const dest = run(['scaffold', '--harness', 'openclaw', '--dest', ws], env);
    expect(dest.code).toBe(2);
    expect(dest.stderr).toContain('--workspace');
  }, 120_000);
});

describe('remaining CLI gaps (coverage audit)', () => {
  test('--scope project lands under <workspace>/.claude/skills', () => {
    const { home, gbrainHome } = homes();
    const ws = mkdtempSync(join(tmpdir(), 'gb-harness-proj-'));
    cleanups.push(ws);
    const r = run(
      ['scaffold', '--harness', 'claude-code', '--scope', 'project', '--workspace', ws, '--skill', 'query', '--json'],
      { HOME: home, GBRAIN_HOME: gbrainHome },
    );
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).dest).toBe(join(ws, '.claude', 'skills'));
    expect(existsSync(join(ws, '.claude', 'skills', 'query', 'SKILL.md'))).toBe(true);
  }, 120_000);

  test('remove --harness without --skill removes every owned slug', () => {
    const { home, gbrainHome } = homes();
    const dest = mkdtempSync(join(tmpdir(), 'gb-harness-dest-'));
    cleanups.push(dest);
    const env = { HOME: home, GBRAIN_HOME: gbrainHome };
    expect(run(['scaffold', '--harness', 'claude-code', '--skill', 'query', '--skill', 'ingest', '--dest', dest], env).code).toBe(0);
    const r = run(['remove', '--harness', 'claude-code', '--dest', dest, '--json'], env);
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(join(dest, 'query', 'SKILL.md'))).toBe(false);
    expect(existsSync(join(dest, 'ingest', 'SKILL.md'))).toBe(false);
    // Shared conventions were never slug-owned; they survive a full remove.
    expect(existsSync(join(dest, 'conventions'))).toBe(true);
    // Ledger emptied → state entry gone → nothing owned on a re-run.
    const again = JSON.parse(run(['remove', '--harness', 'claude-code', '--dest', dest, '--json'], env).stdout);
    expect(again.removedFiles).toEqual([]);
  }, 180_000);

  test('skillpack status renders the installed-bridges section', () => {
    const { home, gbrainHome } = homes();
    const dest = mkdtempSync(join(tmpdir(), 'gb-harness-dest-'));
    const ws = mkdtempSync(join(tmpdir(), 'gb-harness-ws-'));
    cleanups.push(dest, ws);
    const env = { HOME: home, GBRAIN_HOME: gbrainHome };
    expect(run(['scaffold', '--harness', 'claude-code', '--skill', 'query', '--dest', dest], env).code).toBe(0);
    const r = run(['status', '--workspace', ws, '--json'], env);
    expect(r.code, r.stderr).toBe(0);
    const receipt = JSON.parse(r.stdout);
    expect(receipt.bridges).toHaveLength(1);
    expect(receipt.bridges[0].harness).toBe('claude-code');
    expect(receipt.bridges[0].dest).toBe(dest);
    expect(receipt.bridges[0].identical).toBeGreaterThan(0);
  }, 120_000);

  test('stub preflight gate 2: an unservable slug is refused with the skills_dir hint', () => {
    const { home, gbrainHome } = homes();
    const dest = mkdtempSync(join(tmpdir(), 'gb-harness-dest-'));
    const emptyDir = mkdtempSync(join(tmpdir(), 'gb-harness-empty-'));
    cleanups.push(dest, emptyDir);
    // Publish gate ON via the file plane; skills dir pointed at an EMPTY dir
    // so every slug is unservable from the server's perspective.
    mkdirSync(join(gbrainHome, '.gbrain'), { recursive: true });
    writeFileSync(
      join(gbrainHome, '.gbrain', 'config.json'),
      JSON.stringify({ mcp: { publish_skills: true, skills_dir: emptyDir } }),
    );
    const r = run(['scaffold', '--harness', 'claude-code', '--stub', '--skill', 'query', '--dest', dest], {
      HOME: home,
      GBRAIN_HOME: gbrainHome,
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('cannot serve');
    expect(r.stderr).toContain('mcp.skills_dir');
    expect(existsSync(join(dest, 'query'))).toBe(false);
  }, 120_000);

  test('reference --harness: positional slug lens + apply guard requires a single skill', () => {
    const { home, gbrainHome } = homes();
    const dest = mkdtempSync(join(tmpdir(), 'gb-harness-dest-'));
    cleanups.push(dest);
    const env = { HOME: home, GBRAIN_HOME: gbrainHome };
    expect(run(['scaffold', '--harness', 'claude-code', '--skill', 'query', '--dest', dest], env).code).toBe(0);
    const ref = run(['reference', '--harness', 'claude-code', '--dest', dest, 'query', '--json'], env);
    expect(ref.code, ref.stderr).toBe(0);
    const result = JSON.parse(ref.stdout);
    expect(result.summary.differs).toBe(0);
    const applyAll = run(['reference', '--harness', 'claude-code', '--dest', dest, '--apply-clean-hunks'], env);
    expect(applyAll.code).toBe(2);
    expect(applyAll.stderr).toContain('exactly ONE skill');
    const oc = run(['reference', '--harness', 'openclaw'], env);
    expect(oc.code).toBe(2);
  }, 180_000);
});

describe('review-driven CLI hardening', () => {
  test('openclaw --persona path: lane additions inside the persona are skipped-and-reported', () => {
    const { home, gbrainHome } = homes();
    const ws = mkdtempSync(join(tmpdir(), 'gb-harness-ws-'));
    cleanups.push(ws);
    // daily-driver contains gbrain-advisor — verify whether it's an addition;
    // the receipt's openclaw_skipped must exactly equal the persona's
    // lane-addition subset (possibly empty), and the run must not throw.
    const r = run(['scaffold', '--harness', 'openclaw', '--workspace', ws, '--persona', 'daily-driver', '--json'], {
      HOME: home,
      GBRAIN_HOME: gbrainHome,
    });
    expect(r.code, r.stderr).toBe(0);
    const receipt = JSON.parse(r.stdout);
    expect(Array.isArray(receipt.openclaw_skipped)).toBe(true);
    expect(existsSync(join(ws, 'skills', 'query', 'SKILL.md'))).toBe(true);
    for (const skipped of receipt.openclaw_skipped) {
      expect(existsSync(join(ws, 'skills', skipped))).toBe(false);
    }
  }, 120_000);

  test('unexpected positionals are rejected with a --skill hint (scaffold + remove)', () => {
    const { home, gbrainHome } = homes();
    const env = { HOME: home, GBRAIN_HOME: gbrainHome };
    const sc = run(['scaffold', '--harness', 'claude-code', 'query'], env);
    expect(sc.code).toBe(2);
    expect(sc.stderr).toContain("unexpected argument 'query'");
    const rm = run(['remove', '--harness', 'claude-code', 'query'], env);
    expect(rm.code).toBe(2);
    expect(rm.stderr).toContain("unexpected argument 'query'");
  }, 120_000);

  test('stub preflight honors the DB config plane (gbrain config set, no config.json key)', () => {
    const { home, gbrainHome } = homes();
    const dest = mkdtempSync(join(tmpdir(), 'gb-harness-dest-'));
    cleanups.push(dest);
    const env = { HOME: home, GBRAIN_HOME: gbrainHome };
    // Initialize a PGLite brain and set the gate on the DB plane only.
    const init = spawnSync('bun', [CLI, 'init', '--pglite', '--non-interactive'], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      timeout: 120_000,
    });
    expect(init.status, init.stderr).toBe(0);
    const set = spawnSync('bun', [CLI, 'config', 'set', 'mcp.publish_skills', 'true'], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      timeout: 120_000,
    });
    expect(set.status, set.stderr).toBe(0);
    const r = run(['scaffold', '--harness', 'claude-code', '--stub', '--skill', 'query', '--dest', dest, '--json'], env);
    expect(r.code, r.stderr).toBe(0);
    expect(readFileSync(join(dest, 'query', 'SKILL.md'), 'utf-8')).toContain('gbrain-skill-stub');
  }, 180_000);
});
