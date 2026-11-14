/**
 * OpenClaw's route to gbrain (HARN-18). OpenClaw 2026.10.6 refuses a skill
 * document larger than one read ("Skill instructions cannot be partially
 * served") and serves nothing: the live tool-result cap is 64,000 characters
 * on a model with 200k+ context, 32,000 at 100k-200k, 16,000 below, and a
 * 32,768-byte read page when it does not know the context window
 * (dist/tool-result-limits-*.mjs, dist/agent-tools.read-*.mjs). Its system
 * prompt also says to call `skills_read`, a deferred tool a direct call
 * cannot reach, so nothing gbrain writes for OpenClaw names it. The per-turn
 * rule is the primary route; scaffolded skills are the fallback.
 */

import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { basename, join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { enumerateScaffoldEntries, loadBundleManifest } from '../src/core/skillpack/bundle.ts';
import { openclawTurnPluginFiles } from '../src/core/setup/openclaw-turn-plugin.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');
const OPENCLAW_SKILL_READ_CAP_BYTES = 32_000;

const cleanups: string[] = [];
afterEach(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});

const installed = enumerateScaffoldEntries({ gbrainRoot: REPO_ROOT, manifest: loadBundleManifest(REPO_ROOT) });

function cli(args: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'gb-openclaw-route-'));
  cleanups.push(home);
  mkdirSync(join(home, '.openclaw', 'workspace'), { recursive: true });
  const r = spawnSync('bun', [join(REPO_ROOT, 'src', 'cli.ts'), ...args.map((a) => a.replace('<home>', home))], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home, GBRAIN_HOME: home, OPENCLAW_STATE_DIR: '', OPENCLAW_CONFIG_PATH: '', OPENCLAW_WORKSPACE_DIR: '', PATH: `${join(home, 'bin')}:${process.env.PATH}` },
    timeout: 120_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('OpenClaw route', () => {
  test('every SKILL.md the OpenClaw scaffold installs (--all, so the core five too) fits one OpenClaw read', () => {
    const skills = installed.filter((e) => basename(e.relWorkspaceTarget) === 'SKILL.md');
    expect(skills.length).toBeGreaterThan(50);
    const over = skills
      .map((e) => ({ skill: e.relWorkspaceTarget, bytes: Buffer.byteLength(readFileSync(e.source, 'utf8')) }))
      .filter((s) => s.bytes > OPENCLAW_SKILL_READ_CAP_BYTES);
    expect(over).toEqual([]);
  });

  test('no gbrain text written for OpenClaw names skills_read', () => {
    const texts: Record<string, string> = {
      'docs/mcp/OPENCLAW.md': readFileSync(join(REPO_ROOT, 'docs', 'mcp', 'OPENCLAW.md'), 'utf8'),
      ...openclawTurnPluginFiles({ kind: 'mcp', server: 'gbrain' }),
      ...Object.fromEntries(installed.map((e) => [e.relWorkspaceTarget, readFileSync(e.source, 'utf8')])),
    };
    expect(Object.keys(texts).filter((k) => texts[k].includes('skills_read'))).toEqual([]);
  });

  test('setup openclaw names the per-turn rule as the primary route and skills as the fallback', () => {
    const r = cli(['setup', 'openclaw', '--dry-run']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("the per-turn rule is OpenClaw's primary route");
    expect(r.stdout).toContain('gbrain skillpack scaffold --harness openclaw');
  }, 120_000);

  test('scaffold --harness openclaw points at the per-turn rule as the primary route', () => {
    const r = cli(['skillpack', 'scaffold', '--harness', 'openclaw', '--workspace', '<home>/.openclaw/workspace']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('primary route');
    expect(r.stdout).toContain('gbrain setup openclaw');
  }, 120_000);
});
