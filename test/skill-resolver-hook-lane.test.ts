/**
 * GBRA-377 PR B: the skill-resolver hook lane (`GBRAIN_HOOK_LANE=skill-resolver`,
 * src/core/skills/resolver/hook-lane.ts) as the harness runs it: each test
 * wires the lane with `gbrain setup <claude-code|codex> --skill-loading
 * resolve` against a temp HOME, then runs the exact command setup wrote.
 *
 * Protects: the block names each skill with the harness's own load line
 * (Codex adds the SKILL.md path); dedupe and the compaction reset; the 50 ms
 * deadline, measured from outside the process, for a blocking, hung and late
 * worker (exit 0, no output, no dedupe commit); a brainless install stays
 * brainless; an unreadable config fails open with its code; a block over the
 * payload budget is dropped whole and counted; one owner per event; the
 * project catalog is built out of the turn and merged at rank time; with the
 * lane off it prints and writes nothing.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { LANE_DEADLINE_MS, projectCatalogPrefix } from '../src/core/skills/resolver/hook-lane.ts';

setDefaultTimeout(60_000);
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const CLAUDE_LOAD = 'To use one, load it with the Skill tool (by its id) before acting.';
const CODEX_LOAD = 'To use one, open the SKILL.md at its path and follow it.';
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

interface Box { root: string; home: string; project: string; bin: string; env: Record<string, string | undefined> }
function box(): Box {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-skill-lane-'));
  roots.push(root);
  const home = join(root, 'home'), project = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(join(root, 'bin'));
  const bin = join(root, 'bin', 'gbrain');
  writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${CLI}' "$@"\n`);
  chmodSync(bin, 0o755);
  return { root, home, project, bin, env: {
    HOME: home, GBRAIN_HOME: home, PATH: '/usr/bin:/bin', CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, XDG_CONFIG_HOME: undefined,
    CLAUDE_PROJECT_DIR: undefined, GBRAIN_HOOKS: undefined, GBRAIN_HOOK_LANE: undefined, GBRAIN_SKILLS_NO_AUTOREBUILD: undefined,
    GBRAIN_TEST_SKILL_LANE_STALL: undefined, GBRAIN_TEST_SKILL_LANE_DEADLINE_MS: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
  } };
}

function skill(dir: string, name: string, description: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nSteps for ${name}.\n`);
}
const claudeSkills = (b: Box) => join(b.home, '.claude', 'skills');
const codexSkills = (b: Box) => join(b.home, '.agents', 'skills');
function seedSkills(dir: string): void {
  skill(dir, 'deploy-widget', 'Deploy the widget service to staging or production.');
  skill(dir, 'write-changelog', 'Write a changelog entry for a release.');
  skill(dir, 'triage-bug', 'Triage a bug report: reproduce it and find the owner.');
}

async function setup(b: Box, harness: string, extra: string[] = []) {
  const r = await runCli(['setup', harness, '--instructions-only', '--skill-loading', 'resolve', '--gbrain-bin', b.bin, ...extra], { env: b.env, cwd: b.project });
  expect(r.exitCode, r.stderr + r.stdout).toBe(0);
  return r;
}
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
/** The lane command setup wrote for this harness and event. */
function wired(b: Box, harness: 'claude-code' | 'codex', event: 'UserPromptSubmit' | 'SessionStart' = 'UserPromptSubmit'): string {
  const doc = readJson(harness === 'codex' ? join(b.home, '.codex', 'hooks.json') : join(b.home, '.claude', 'settings.json'));
  const cmds = (doc.hooks?.[event] ?? []).flatMap((g: any) => g.hooks).map((h: any) => h.command as string).filter((c: string) => c.includes('GBRAIN_HOOK_LANE=skill-resolver'));
  expect(cmds).toHaveLength(1);
  return cmds[0];
}

interface Run { stdout: string; stderr: string; exitCode: number; wallMs: number }
/** Run a hook command the way the harness does: sh -c, the event JSON on stdin. Wall time is measured outside the process. */
async function hook(b: Box, command: string, payload: Record<string, unknown>, env: Record<string, string | undefined> = {}): Promise<Run> {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...b.env, GBRAIN_SKIP_STARTUP_HOOKS: '1', ...env })) if (v !== undefined) merged[k] = v;
  const t0 = performance.now();
  const proc = Bun.spawn(['sh', '-c', command], { env: merged, cwd: b.project, stdin: new TextEncoder().encode(JSON.stringify({ cwd: b.project, ...payload })), stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode, wallMs: performance.now() - t0 };
}
const WIDE = { GBRAIN_TEST_SKILL_LANE_DEADLINE_MS: '10000' };
const laneLog = (b: Box): any[] => {
  const p = join(b.home, '.gbrain', 'skill-index', 'logs', 'lane.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const sessions = (b: Box) => { const d = join(b.home, '.gbrain', 'skill-index', 'sessions'); return existsSync(d) ? readdirSync(d) : []; };
const contextOf = (r: Run) => JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;

describe('skill-resolver lane: delivery per harness', () => {
  test('claude-code: the wired command names each skill and gives the Skill tool load line; a repeat is deduped', async () => {
    const b = box();
    seedSkills(claudeSkills(b));
    await setup(b, 'claude-code');
    const cmd = wired(b, 'claude-code');
    const first = await hook(b, cmd, { prompt: 'please deploy the widget to staging', session_id: 'sess-a' }, WIDE);
    expect(first.exitCode).toBe(0);
    const block = contextOf(first);
    expect(JSON.parse(first.stdout).hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(block).toContain('<relevant_skills>');
    expect(block).toContain('id: "deploy-widget"');
    expect(block).toContain(CLAUDE_LOAD);
    expect(block).not.toContain('path: ');
    expect(sessions(b)).toHaveLength(1);
    const again = await hook(b, cmd, { prompt: 'please deploy the widget to staging', session_id: 'sess-a' }, WIDE);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toBe('');
    expect(laneLog(b).map((l) => l.outcome)).toEqual(['delivered', 'empty']);
  });

  test('codex: the wired command passes --harness codex; the block carries each SKILL.md path and the Codex load line', async () => {
    const b = box();
    seedSkills(codexSkills(b));
    await setup(b, 'codex');
    const cmd = wired(b, 'codex');
    expect(cmd).toContain('hook user-prompt --harness codex');
    const r = await hook(b, cmd, { prompt: 'write the changelog for this release', session_id: 'sess-c', hook_event_name: 'UserPromptSubmit' }, WIDE);
    expect(r.exitCode).toBe(0);
    const block = contextOf(r);
    expect(block).toContain('id: "write-changelog"');
    expect(block).toContain(`path: ${JSON.stringify(join(codexSkills(b), 'write-changelog', 'SKILL.md'))}`);
    expect(block).toContain(CODEX_LOAD);
    expect(block).not.toContain(CLAUDE_LOAD);
  });

  test('claude-code SessionStart after a compaction resets the session, so the skill is offered again', async () => {
    const b = box();
    seedSkills(claudeSkills(b));
    await setup(b, 'claude-code');
    const cmd = wired(b, 'claude-code');
    const turn = { prompt: 'triage this bug report', session_id: 'sess-r' };
    expect(contextOf(await hook(b, cmd, turn, WIDE))).toContain('triage-bug');
    expect((await hook(b, cmd, turn, WIDE)).stdout).toBe('');
    const start = await hook(b, wired(b, 'claude-code', 'SessionStart'), { source: 'startup', session_id: 'sess-r' }, WIDE);
    expect(start.stdout).toBe('');
    expect((await hook(b, cmd, turn, WIDE)).stdout).toBe('');
    const reset = await hook(b, wired(b, 'claude-code', 'SessionStart'), { source: 'compact', session_id: 'sess-r' }, WIDE);
    expect(reset.exitCode).toBe(0);
    expect(reset.stdout).toBe('');
    expect(contextOf(await hook(b, cmd, turn, WIDE))).toContain('triage-bug');
  });
});

describe('skill-resolver lane: deadline, measured outside the process', () => {
  for (const stall of ['block', 'hang', 'late'] as const) {
    test(`${stall}: exits 0 at the deadline with no output and no dedupe commit`, async () => {
      const b = box();
      seedSkills(claudeSkills(b));
      await setup(b, 'claude-code');
      const cmd = wired(b, 'claude-code');
      const baseline = await hook(b, cmd, { prompt: 'hello there', session_id: 'warm' }, WIDE);
      const r = await hook(b, cmd, { prompt: 'please deploy the widget to staging', session_id: 'sess-t' }, { GBRAIN_TEST_SKILL_LANE_STALL: stall });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
      expect(sessions(b).length).toBe(sessions(b).length);
      const last = laneLog(b).at(-1);
      expect(last).toMatchObject({ outcome: 'timeout', code: 'skill_resolve_timeout' });
      expect(last.ms).toBeGreaterThanOrEqual(LANE_DEADLINE_MS - 1);
      expect(last.ms).toBeLessThan(LANE_DEADLINE_MS + 250);
      // A blocking worker would hold the process 10 s and a hung one forever; the
      // process ends within the deadline plus the same startup cost as a normal turn.
      expect(r.wallMs).toBeLessThan(baseline.wallMs + 1500);
      expect(sessions(b).some((s) => readFileSync(join(b.home, '.gbrain', 'skill-index', 'sessions', s), 'utf8').includes('deploy-widget'))).toBe(false);
    });
  }
});

describe('skill-resolver lane: fail open', () => {
  test('lane off (no config): prints nothing and writes nothing', async () => {
    const b = box();
    const cmd = `env GBRAIN_HOOK_LANE=skill-resolver '${b.bin}' hook user-prompt`;
    const r = await hook(b, cmd, { prompt: 'deploy the widget', session_id: 's' });
    expect(r).toMatchObject({ exitCode: 0, stdout: '', stderr: '' });
    expect(existsSync(join(b.home, '.gbrain'))).toBe(false);
  });

  test('a brainless install stays brainless and the lane needs no brain or serve', async () => {
    const b = box();
    seedSkills(claudeSkills(b));
    await setup(b, 'claude-code');
    expect(Object.keys(readJson(join(b.home, '.gbrain', 'config.json')))).toEqual(['skills']);
    expect(readdirSync(join(b.home, '.gbrain')).filter((n) => /pglite|brain/.test(n))).toEqual([]);
    const r = await hook(b, wired(b, 'claude-code'), { prompt: 'deploy the widget', session_id: 's' }, WIDE);
    expect(contextOf(r)).toContain('deploy-widget');
    const status = await runCli(['doctor', '--json'], { env: b.env, cwd: b.project });
    expect(`${status.stdout}${status.stderr}`).not.toMatch(/database_url|ECONNREFUSED/);
  });

  test('an unreadable config prints nothing, exits 0 and logs skill_resolver_config_unreadable', async () => {
    const b = box();
    seedSkills(claudeSkills(b));
    await setup(b, 'claude-code');
    writeFileSync(join(b.home, '.gbrain', 'config.json'), '{ not json');
    const r = await hook(b, wired(b, 'claude-code'), { prompt: 'deploy the widget', session_id: 's' }, WIDE);
    expect(r).toMatchObject({ exitCode: 0, stdout: '' });
    expect(laneLog(b).at(-1)).toMatchObject({ outcome: 'error', code: 'skill_resolver_config_unreadable' });
  });

  test('a block over the payload budget is dropped whole and counted', async () => {
    const b = box();
    const long = (w: string) => `Deploy the widget ${w}: ${'deploy widget release steps and checks '.repeat(5)}`;
    for (const n of ['deploy-widget-a', 'deploy-widget-b', 'deploy-widget-c']) skill(claudeSkills(b), n, long(n));
    await setup(b, 'claude-code');
    const set = await runCli(['config', 'set', 'skills.resolver.lane_payload_chars', '500'], { env: b.env, cwd: b.project });
    expect(set.exitCode, set.stderr).toBe(0);
    const r = await hook(b, wired(b, 'claude-code'), { prompt: 'deploy the widget please', session_id: 's' }, WIDE);
    expect(r).toMatchObject({ exitCode: 0, stdout: '' });
    const last = laneLog(b).at(-1);
    expect(last.outcome).toBe('payload_dropped');
    expect(last.dropped_chars).toBeGreaterThan(500);
    expect(sessions(b)).toEqual([]);
  });

  test('one owner per event: a lane whose GBRAIN_HOME is not the first wiring yields', async () => {
    const b = box();
    seedSkills(claudeSkills(b));
    await setup(b, 'claude-code');
    const cmd = wired(b, 'claude-code');
    const other = join(b.root, 'other-home');
    mkdirSync(join(b.project, '.claude'), { recursive: true });
    writeFileSync(join(b.project, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: cmd.replace(`GBRAIN_HOME=${b.home}`, `GBRAIN_HOME=${other}`), _gbrain: 'skill-resolver-v1' }] }] } }));
    const r = await hook(b, cmd, { prompt: 'deploy the widget', session_id: 's' }, WIDE);
    expect(r).toMatchObject({ exitCode: 0, stdout: '' });
    expect(laneLog(b)).toEqual([]);
  });
});

describe('skill-resolver lane: project catalog', () => {
  test("claude-code: the project's .claude/skills is built out of the turn, keyed by the root, then merged by name", async () => {
    const b = box();
    seedSkills(claudeSkills(b));
    skill(join(b.project, '.claude', 'skills'), 'rotate-fixtures', 'Rotate the fixture files for the nightly widget run.');
    await setup(b, 'claude-code');
    const cmd = wired(b, 'claude-code');
    const turn = { prompt: 'rotate the fixture files', session_id: 'sess-p' };
    const first = await hook(b, cmd, turn, WIDE);
    expect(first.exitCode).toBe(0);
    const root = join(b.home, '.gbrain', 'skill-index');
    let built: string | undefined;
    for (let i = 0; i < 100 && !built; i++) {
      built = readdirSync(root).find((n) => n.startsWith(projectCatalogPrefix('claude-code')) && existsSync(join(root, n, 'receipt.json')));
      if (!built) await Bun.sleep(100);
    }
    expect(built).toMatch(/^claude-code-project-[0-9a-f]{16}$/);
    const r = await hook(b, cmd, { prompt: 'rotate the fixture files', session_id: 'sess-p2' }, WIDE);
    const block = contextOf(r);
    expect(block).toContain('- id: "rotate-fixtures" name: "rotate-fixtures"');
    expect(block).not.toContain('Rotate the fixture files for the nightly');
    expect(laneLog(b).at(-1).catalogs).toEqual(['claude-code-user', built]);
  });

  test('GBRAIN_SKILLS_NO_AUTOREBUILD=1 never starts a build', async () => {
    const b = box();
    seedSkills(claudeSkills(b));
    skill(join(b.project, '.claude', 'skills'), 'rotate-fixtures', 'Rotate the fixture files.');
    await setup(b, 'claude-code');
    await hook(b, wired(b, 'claude-code'), { prompt: 'rotate the fixture files', session_id: 's' }, { ...WIDE, GBRAIN_SKILLS_NO_AUTOREBUILD: '1' });
    await Bun.sleep(1500);
    expect(readdirSync(join(b.home, '.gbrain', 'skill-index')).filter((n) => n.startsWith('claude-code-project-'))).toEqual([]);
  });
});
