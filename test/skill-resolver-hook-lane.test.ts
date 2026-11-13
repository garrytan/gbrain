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
 * project catalog (Claude Code's .claude/skills, Codex's .agents/skills from the
 * project root down to cwd) is built out of the turn and merged at rank time;
 * a built claude-code-plugins catalog is searched; no built catalog ends the
 * turn as no_catalog; Hermes reads extra.user_message from a stream of any size
 * and answers {"context"}, starts a session fresh on its first turn or when
 * its history shrinks (in-place compaction), and honours
 * per_harness.hermes.owner_sender_ids; with the lane off it prints and writes
 * nothing.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { runCli } from './helpers/cli-spawn.ts';
import { CLAUDE_PLUGINS_CATALOG, LANE_DEADLINE_MS, projectCatalogPrefix, WORKER_SRC_PATH } from '../src/core/skills/resolver/hook-lane.ts';
import { HOOK_FIELD_CAP, readHookFields, readJsonFields } from '../src/core/skills/resolver/hook-input.ts';
import { historyShrank, sessionKey } from '../src/core/skills/resolver/session.ts';
import { MESSAGE_CAP_BYTES } from '../src/core/skills/resolver/resolve.ts';
import { dailyLogFile, LANE_LOG } from '../src/core/skills/resolver/daily-log.ts';

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
async function hook(b: Box, command: string, payload: Record<string, unknown> | string, env: Record<string, string | undefined> = {}, cwd = b.project): Promise<Run> {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...b.env, GBRAIN_SKIP_STARTUP_HOOKS: '1', ...env })) if (v !== undefined) merged[k] = v;
  const t0 = performance.now();
  const stdin = new TextEncoder().encode(typeof payload === 'string' ? payload : JSON.stringify({ cwd, ...payload }));
  const proc = Bun.spawn(['sh', '-c', command], { env: merged, cwd, stdin, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode, wallMs: performance.now() - t0 };
}
const WIDE = { GBRAIN_TEST_SKILL_LANE_DEADLINE_MS: '10000' };
const laneLog = (b: Box): any[] => [Date.now() - 86_400_000, Date.now()].flatMap((ms) => {
  const p = join(b.home, '.gbrain', 'skill-index', 'logs', dailyLogFile(LANE_LOG, ms));
  return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
});
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

  test('codex SessionStart after a compaction (Codex 0.165 sends source "compact") resets the session, so the skill is offered again', async () => {
    const b = box();
    seedSkills(codexSkills(b));
    await setup(b, 'codex');
    const cmd = wired(b, 'codex');
    const start = wired(b, 'codex', 'SessionStart');
    expect(start).toContain('hook session-start --harness codex');
    const toml = readFileSync(join(b.home, '.codex', 'config.toml'), 'utf8');
    expect(toml).toContain(':session_start:');
    expect(toml).toContain(':user_prompt_submit:');
    const turn = { prompt: 'triage this bug report', session_id: 'sess-cx', hook_event_name: 'UserPromptSubmit' };
    expect(contextOf(await hook(b, cmd, turn, WIDE))).toContain('triage-bug');
    expect((await hook(b, cmd, turn, WIDE)).stdout).toBe('');
    expect((await hook(b, start, { source: 'resume', session_id: 'sess-cx', hook_event_name: 'SessionStart' }, WIDE)).stdout).toBe('');
    expect((await hook(b, cmd, turn, WIDE)).stdout).toBe('');
    const reset = await hook(b, start, { source: 'compact', session_id: 'sess-cx', hook_event_name: 'SessionStart' }, WIDE);
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

  for (const stall of ['load-error', 'exit'] as const) {
    test(`${stall}: a worker that fails before answering is logged as skill_resolver_internal, not as a timeout`, async () => {
      const b = box();
      seedSkills(claudeSkills(b));
      await setup(b, 'claude-code');
      const cmd = wired(b, 'claude-code');
      const r = await hook(b, cmd, { prompt: 'please deploy the widget to staging', session_id: 'sess-l' }, { ...WIDE, GBRAIN_TEST_SKILL_LANE_STALL: stall });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
      expect(laneLog(b).at(-1)).toMatchObject({ outcome: 'error', code: 'skill_resolver_internal' });
    });
  }
});

describe('skill-resolver lane: turn settings from config', () => {
  const config = async (b: Box, ...args: string[]) => {
    const r = await runCli(['config', ...args], { env: b.env, cwd: b.project });
    return r;
  };
  test('top_k, min_match and pinned apply; per_harness overrides one harness; Claude Code and Codex default to 5 with no floor', async () => {
    const b = box();
    for (const dir of [claudeSkills(b), codexSkills(b)]) {
      seedSkills(dir);
      skill(dir, 'deploy-docs', 'Deploy the docs site.');
      skill(dir, 'deploy-api', 'Deploy the api service.');
    }
    await setup(b, 'claude-code');
    await setup(b, 'codex');
    const claude = wired(b, 'claude-code'), codex = wired(b, 'codex');
    const ids = (r: Run) => [...contextOf(r).matchAll(/id: "([^"]+)"/g)].map((m) => m[1]);
    const ask = (cmd: string, s: string) => hook(b, cmd, { prompt: 'deploy the widget service', session_id: s, hook_event_name: 'UserPromptSubmit' }, WIDE);
    expect(ids(await ask(claude, 'd1')).length).toBeGreaterThanOrEqual(3);
    for (const [k, v] of [['skills.resolver.top_k', '1'], ['skills.resolver.per_harness.codex.top_k', '2'], ['skills.resolver.pinned', 'deploy-widget']]) {
      const r = await config(b, 'set', k, v);
      expect(r.exitCode, r.stderr).toBe(0);
    }
    const c = ids(await ask(claude, 'd2'));
    expect(c).toHaveLength(1);
    expect(c).not.toContain('deploy-widget');
    const x = ids(await ask(codex, 'd3'));
    expect(x).toHaveLength(2);
    expect(x).not.toContain('deploy-widget');
    expect((await config(b, 'set', 'skills.resolver.min_match', 'named')).exitCode).toBe(0);
    expect((await ask(claude, 'd4')).stdout).toBe('');
    const bad = await config(b, 'set', 'skills.resolver.per_harness.vim.top_k', '2');
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toContain('names no harness');
    const inherited = await config(b, 'set', 'skills.resolver.per_harness.constructor.top_k', '2');
    expect(inherited.exitCode).not.toBe(0);
    expect(inherited.stderr).toContain('names no harness');
    expect((await config(b, 'set', 'skills.resolver.top_k', '9')).exitCode).not.toBe(0);
    const cfg = JSON.parse(readFileSync(join(b.home, '.gbrain', 'config.json'), 'utf8')).skills.resolver;
    expect([cfg.top_k, cfg.min_match, cfg.pinned, cfg.per_harness]).toEqual([1, 'named', ['deploy-widget'], { codex: { top_k: 2 } }]);
    cfg.top_k = 99;
    writeFileSync(join(b.home, '.gbrain', 'config.json'), JSON.stringify({ skills: { resolver: cfg } }));
    const invalid = await ask(claude, 'd5');
    expect([invalid.exitCode, invalid.stdout]).toEqual([0, '']);
    expect(laneLog(b).at(-1)).toMatchObject({ outcome: 'error', code: 'skill_resolver_config_invalid' });
  });
});

describe('skill-resolver lane: top_gate from config', () => {
  test('a gate above every score empties the block; per_harness 0 turns it off for one harness; a bad value is refused', async () => {
    const b = box();
    seedSkills(claudeSkills(b));
    await setup(b, 'claude-code');
    const cmd = wired(b, 'claude-code');
    const config = (...args: string[]) => runCli(['config', ...args], { env: b.env, cwd: b.project });
    const ask = (s: string) => hook(b, cmd, { prompt: 'please deploy the widget to staging', session_id: s }, WIDE);
    expect((await config('set', 'skills.resolver.top_gate', '100')).exitCode).toBe(0);
    const gated = await ask('tg1');
    expect([gated.exitCode, gated.stdout]).toEqual([0, '']);
    expect(laneLog(b).at(-1)).toMatchObject({ outcome: 'empty' });
    expect((await config('set', 'skills.resolver.per_harness.claude-code.top_gate', '0')).exitCode).toBe(0);
    expect(contextOf(await ask('tg2'))).toContain('deploy-widget');
    for (const bad of ['high', '101']) {
      const r = await config('set', 'skills.resolver.top_gate', bad);
      expect(r.exitCode, bad).not.toBe(0);
      expect(r.stderr).toContain('must be a number from 0 to 100');
    }
    expect((await config('set', 'skills.resolver.top_gate', '-1')).exitCode).not.toBe(0);
    expect(JSON.parse(readFileSync(join(b.home, '.gbrain', 'config.json'), 'utf8')).skills.resolver).toMatchObject({ top_gate: 100, per_harness: { 'claude-code': { top_gate: 0 } } });
  });
});

describe('skill-resolver lane: session GC before the process exits', () => {
  test('a delivered turn deletes idle session files and stamps the pass; a turn within the interval leaves new ones', async () => {
    const b = box();
    seedSkills(claudeSkills(b));
    await setup(b, 'claude-code');
    const cmd = wired(b, 'claude-code');
    const dir = join(b.home, '.gbrain', 'skill-index', 'sessions');
    mkdirSync(dir, { recursive: true });
    const old = (Date.now() - 8 * 86_400_000) / 1000;
    const plant = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => { const p = join(dir, `${prefix}${String(i).padStart(63, '0')}.json`); writeFileSync(p, '{}'); utimesSync(p, old, old); return p; });
    const idle = plant('a', 40);
    const r = await hook(b, cmd, { prompt: 'please deploy the widget to staging', session_id: 'gc-a' }, WIDE);
    expect(contextOf(r)).toContain('deploy-widget');
    expect(idle.filter((p) => existsSync(p))).toEqual([]);
    expect(existsSync(join(b.home, '.gbrain', 'skill-index', 'logs', 'session-gc.stamp'))).toBe(true);
    const later = plant('b', 3);
    await hook(b, cmd, { prompt: 'write a changelog entry for the release', session_id: 'gc-b' }, WIDE);
    expect(later.filter((p) => existsSync(p))).toHaveLength(3);
  });
});

describe('skill-resolver lane: a deadline during the session GC pass', () => {
  test('the delivered turn is logged as delivered, the process still exits at the deadline, and the commit landed', async () => {
    const b = box();
    seedSkills(claudeSkills(b));
    await setup(b, 'claude-code');
    const cmd = wired(b, 'claude-code');
    const r = await hook(b, cmd, { prompt: 'please deploy the widget to staging', session_id: 'sess-gc-stall' }, { GBRAIN_TEST_SKILL_LANE_STALL: 'gc', GBRAIN_TEST_SKILL_LANE_DEADLINE_MS: '3000' });
    expect(r.exitCode).toBe(0);
    expect(contextOf(r)).toContain('id: "deploy-widget"');
    expect(laneLog(b).at(-1)).toMatchObject({ outcome: 'delivered' });
    expect(sessions(b).filter((s) => s.endsWith('.json'))).toHaveLength(1);
  });
});

describe('skill-resolver lane: a deadline during the dedupe commit', () => {
  for (const stall of ['commit-held', 'commit-written'] as const) {
    test(`${stall}: the exit releases the session lease and removes the temp file, so the next turn commits`, async () => {
      const b = box();
      seedSkills(claudeSkills(b));
      await setup(b, 'claude-code');
      const cmd = wired(b, 'claude-code');
      const turn = { prompt: 'please deploy the widget to staging', session_id: 'sess-l' };
      const r = await hook(b, cmd, turn, { GBRAIN_TEST_SKILL_LANE_STALL: stall, GBRAIN_TEST_SKILL_LANE_DEADLINE_MS: '3000' });
      expect(r.exitCode).toBe(0);
      expect(contextOf(r)).toContain('id: "deploy-widget"');
      expect(laneLog(b).at(-1)).toMatchObject({ outcome: 'timeout', code: 'skill_resolve_timeout' });
      expect(sessions(b)).toEqual([]);
      const again = await hook(b, cmd, turn, WIDE);
      expect(contextOf(again)).toContain('id: "deploy-widget"');
      expect(sessions(b).filter((s) => !s.startsWith('.')).map((s) => s.endsWith('.json'))).toEqual([true]);
      expect((await hook(b, cmd, turn, WIDE)).stdout).toBe('');
    });
  }
});

describe('skill-resolver lane: the CLI fast path keeps the hook contract', () => {
  test('GBRAIN_HOOKS=0 silences the lane, whether exported or set in the env file the CLI preflight loads', async () => {
    const b = box();
    seedSkills(claudeSkills(b));
    await setup(b, 'claude-code');
    const cmd = wired(b, 'claude-code');
    const turn = { prompt: 'please deploy the widget to staging', session_id: 'sess-off' };
    const exported = await hook(b, cmd, turn, { ...WIDE, GBRAIN_HOOKS: '0' });
    expect(exported.exitCode).toBe(0);
    expect(exported.stdout).toBe('');
    writeFileSync(join(b.home, '.gbrain', '.env'), 'GBRAIN_HOOKS=0\n');
    const fromFile = await hook(b, cmd, turn, WIDE);
    expect(fromFile.exitCode).toBe(0);
    expect(fromFile.stdout).toBe('');
    expect(laneLog(b)).toEqual([]);
    expect(sessions(b)).toEqual([]);
    rmSync(join(b.home, '.gbrain', '.env'));
    const on = await hook(b, cmd, turn, WIDE);
    expect(contextOf(on)).toContain('id: "deploy-widget"');
  });
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
  test('one owner per event: user scope, workspace and plugin wired at once give exactly one block and one dedupe commit', async () => {
    const b = box();
    seedSkills(claudeSkills(b));
    await setup(b, 'claude-code');
    const user = wired(b, 'claude-code');
    // A second home with the lane on, wired in the workspace's settings.local.json (earlier in carrier order).
    const other = join(b.root, 'other-home');
    mkdirSync(join(other, '.gbrain'), { recursive: true });
    writeFileSync(join(other, '.gbrain', 'config.json'), JSON.stringify({ skills: { resolver: { enabled: true, harnesses: ['claude-code'] } } }));
    const build = await runCli(['skills', 'index', 'build', '--catalog', 'claude-code-user', '--dir', claudeSkills(b), '--harness', 'claude-code'], { env: { ...b.env, GBRAIN_HOME: other }, cwd: b.project });
    expect(build.exitCode, build.stderr).toBe(0);
    const workspace = user.replace(`GBRAIN_HOME=${b.home}`, `GBRAIN_HOME=${other}`);
    expect(workspace).not.toBe(user);
    mkdirSync(join(b.project, '.claude'), { recursive: true });
    writeFileSync(join(b.project, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: workspace, _gbrain: 'skill-resolver-v1' }] }] } }));
    const plugin = `env GBRAIN_HOOK_LANE=plugin GBRAIN_HOME=${b.home} '${b.bin}' hook user-prompt`;
    const turn = { prompt: 'please deploy the widget to staging', session_id: 'sess-o' };
    const runs = await Promise.all([user, workspace, plugin].map((c) => hook(b, c, turn, WIDE)));
    expect(runs.map((r) => r.exitCode)).toEqual([0, 0, 0]);
    expect(runs.filter((r) => r.stdout.includes('<relevant_skills>')).length).toBe(1);
    expect(runs[1]!.stdout).toContain('<relevant_skills>');
    const commits = [b.home, other].flatMap((h) => { const d = join(h, '.gbrain', 'skill-index', 'sessions'); return existsSync(d) ? readdirSync(d) : []; });
    expect(commits).toHaveLength(1);
    expect(laneLog(b)).toEqual([]);
  });

  test('a wiring whose home has the lane off owns nothing', async () => {
    const b = box();
    seedSkills(claudeSkills(b));
    await setup(b, 'claude-code');
    const cmd = wired(b, 'claude-code');
    mkdirSync(join(b.project, '.claude'), { recursive: true });
    writeFileSync(join(b.project, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: cmd.replace(`GBRAIN_HOME=${b.home}`, `GBRAIN_HOME=${join(b.root, 'off-home')}`), _gbrain: 'skill-resolver-v1' }] }] } }));
    expect(contextOf(await hook(b, cmd, { prompt: 'deploy the widget', session_id: 's' }, WIDE))).toContain('deploy-widget');
  });
});

describe('skill-resolver lane: compiled binaries', () => {
  // A compiled binary bundles src/ into one entry; a worker it starts must be a second
  // entrypoint (bun build --compile src/cli.ts <worker>), found at its src-relative path.
  test('every shipped binary build carries the worker entry at the path the lane starts', () => {
    const root = join(import.meta.dir, '..');
    expect(existsSync(join(root, 'src', WORKER_SRC_PATH))).toBe(true);
    const pkg = readJson(join(root, 'package.json')) as { scripts: Record<string, string> };
    const release = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8');
    const builds = [pkg.scripts.build!, ...pkg.scripts['build:all']!.split('&&'), ...release.split('\n').filter((l) => l.includes('bun build --compile'))];
    expect(builds.length).toBe(4);
    for (const b of builds) expect(b).toContain(`src/cli.ts src/${WORKER_SRC_PATH}`);
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

const catalogRoot = (b: Box) => join(b.home, '.gbrain', 'skill-index');
async function waitForCatalog(b: Box, prefix: string): Promise<string | undefined> {
  for (let i = 0; i < 100; i++) {
    const built = readdirSync(catalogRoot(b)).find((n) => n.startsWith(prefix) && existsSync(join(catalogRoot(b), n, 'receipt.json')));
    if (built) return built;
    await Bun.sleep(100);
  }
  return undefined;
}
const spawnStamps = (b: Box) => { const d = join(catalogRoot(b), 'logs'); return existsSync(d) ? readdirSync(d).filter((n) => n.startsWith('spawn-')) : []; };
async function buildCatalog(b: Box, catalog: string, dir: string, harness: string) {
  const r = await runCli(['skills', 'index', 'build', '--catalog', catalog, '--dir', dir, '--harness', harness], { env: b.env, cwd: b.project });
  expect(r.exitCode, r.stderr).toBe(0);
}

describe('skill-resolver lane: codex project catalog', () => {
  test("a repo's .agents/skills at the root and in a subdir get one catalog over both, root first, keyed by the dir list", async () => {
    const b = box();
    seedSkills(codexSkills(b));
    mkdirSync(join(b.project, '.git'));
    const sub = join(b.project, 'packages', 'widget');
    skill(join(b.project, '.agents', 'skills'), 'rotate-fixtures', 'Rotate the fixture files for the nightly widget run.');
    skill(join(sub, '.agents', 'skills'), 'bump-widget-schema', 'Bump the widget schema version.');
    await setup(b, 'codex');
    const cmd = wired(b, 'codex');
    const turn = { prompt: 'rotate the fixture files and bump the widget schema', hook_event_name: 'UserPromptSubmit' };
    expect((await hook(b, cmd, { ...turn, session_id: 'cp1' }, WIDE, sub)).exitCode).toBe(0);
    const built = await waitForCatalog(b, projectCatalogPrefix('codex'));
    expect(built).toMatch(/^codex-project-[0-9a-f]{16}$/);
    const receipt = readJson(join(catalogRoot(b), built!, 'receipt.json'));
    expect(receipt.catalog).toMatchObject({ source: { dirs: [join(b.project, '.agents', 'skills'), join(sub, '.agents', 'skills')] }, scope: 'project', harness: 'codex' });
    const block = contextOf(await hook(b, cmd, { ...turn, session_id: 'cp2' }, WIDE, sub));
    expect(block).toContain('id: "rotate-fixtures"');
    expect(block).toContain('id: "bump-widget-schema"');
    expect(block).toContain(CODEX_LOAD);
    expect(laneLog(b).at(-1).catalogs).toEqual(['codex-user', built]);
  });

  test('no .agents/skills below the project root, or only the home directory\'s own, means no project catalog', async () => {
    const b = box();
    seedSkills(codexSkills(b));
    mkdirSync(join(b.project, '.git'));
    await setup(b, 'codex');
    const cmd = wired(b, 'codex');
    const turn = { prompt: 'write the changelog for this release', hook_event_name: 'UserPromptSubmit' };
    expect(contextOf(await hook(b, cmd, { ...turn, session_id: 'cn1' }, WIDE))).toContain('write-changelog');
    mkdirSync(join(b.home, '.git'));
    const fromHome = await hook(b, cmd, { ...turn, session_id: 'cn2' }, WIDE, b.home);
    expect(contextOf(fromHome)).toContain('write-changelog');
    expect(laneLog(b).map((l) => l.catalogs)).toEqual([['codex-user'], ['codex-user']]);
    expect(spawnStamps(b)).toEqual([]);
  });
});

describe('skill-resolver lane: built catalogs only', () => {
  test('claude-code: a built claude-code-plugins catalog is searched, between the user and the project catalog', async () => {
    const b = box();
    seedSkills(claudeSkills(b));
    await setup(b, 'claude-code');
    expect(CLAUDE_PLUGINS_CATALOG).toBe('claude-code-plugins');
    const plugins = join(b.root, 'plugin-fixtures');
    skill(plugins, 'audit-widget-licenses', 'Audit the widget dependency licenses.');
    await buildCatalog(b, CLAUDE_PLUGINS_CATALOG, plugins, 'claude-code');
    const r = await hook(b, wired(b, 'claude-code'), { prompt: 'audit the widget licenses', session_id: 'pl1' }, WIDE);
    expect(contextOf(r)).toContain('id: "audit-widget-licenses"');
    expect(laneLog(b).at(-1).catalogs).toEqual(['claude-code-user', CLAUDE_PLUGINS_CATALOG]);
  });

  test('claude-code with only plugin skills: the plugins catalog alone delivers', async () => {
    const b = box();
    seedSkills(claudeSkills(b));
    await setup(b, 'claude-code');
    rmSync(join(catalogRoot(b), 'claude-code-user'), { recursive: true });
    const plugins = join(b.root, 'plugin-fixtures');
    skill(plugins, 'audit-widget-licenses', 'Audit the widget dependency licenses.');
    await buildCatalog(b, CLAUDE_PLUGINS_CATALOG, plugins, 'claude-code');
    const r = await hook(b, wired(b, 'claude-code'), { prompt: 'audit the widget licenses', session_id: 'pl2' }, WIDE);
    expect(contextOf(r)).toContain('id: "audit-widget-licenses"');
    expect(laneLog(b).at(-1)).toMatchObject({ outcome: 'delivered', catalogs: [CLAUDE_PLUGINS_CATALOG] });
  });

  for (const harness of ['claude-code', 'codex'] as const) {
    test(`${harness}: no built catalog ends the turn with no output and outcome no_catalog, never skill_index_missing`, async () => {
      const b = box();
      seedSkills(harness === 'codex' ? codexSkills(b) : claudeSkills(b));
      await setup(b, harness);
      rmSync(join(catalogRoot(b), `${harness}-user`), { recursive: true });
      const r = await hook(b, wired(b, harness), { prompt: 'please deploy the widget to staging', session_id: 'nc', hook_event_name: 'UserPromptSubmit' }, WIDE);
      expect(r).toMatchObject({ exitCode: 0, stdout: '' });
      const last = laneLog(b).at(-1);
      expect(last.outcome).toBe('no_catalog');
      expect(last.code).toBeUndefined();
    });
  }
});

describe('skill-resolver lane: hermes', () => {
  const HERMES_LOAD = 'To use one, load it with skill_view(name) using its id before acting.';
  const hermesCmd = (b: Box) => `env GBRAIN_HOOK_LANE=skill-resolver GBRAIN_HOME='${b.home}' '${b.bin}' hook user-prompt --harness hermes`;
  async function hermesBox(extra: Record<string, unknown> = {}): Promise<Box> {
    const b = box();
    const dir = join(b.home, '.hermes', 'skills');
    seedSkills(dir);
    await buildCatalog(b, 'hermes-user', dir, 'hermes');
    writeFileSync(join(b.home, '.gbrain', 'config.json'), JSON.stringify({ skills: { resolver: { enabled: true, harnesses: ['hermes'], ...extra } } }));
    return b;
  }
  const history = (bytes: number) => {
    const turns: unknown[] = [];
    const item = { role: 'user', content: 'An earlier turn with "quotes", a \\ backslash, \u00e9t\u00e9 and \ud83d\ude80, plus a decoy.', user_message: 'decoy: rotate the fixtures' };
    const size = JSON.stringify(item).length + 1;
    for (let n = 0; n * size < bytes; n++) turns.push(item);
    return turns;
  };

  test('without --harness the turn is never routed to hermes, even with a stray hermes argument', async () => {
    const b = await hermesBox();
    const cmd = `env GBRAIN_HOOK_LANE=skill-resolver GBRAIN_HOME='${b.home}' '${b.bin}' hook user-prompt hermes`;
    const r = await hook(b, cmd, { session_id: 'h0', extra: { user_message: 'please deploy the widget to staging' } }, WIDE);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
    expect(laneLog(b).filter((l) => l.harness === 'hermes')).toEqual([]);
    expect(sessions(b)).toEqual([]);
  });

  test('a pre_llm_call turn reads extra.user_message and answers {"context": block}; a repeat in the session is deduped', async () => {
    const b = await hermesBox();
    const turn = { session_id: 'h1', extra: { user_message: 'please deploy the widget to staging', conversation_history: [] } };
    const r = await hook(b, hermesCmd(b), turn, WIDE);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(Object.keys(out)).toEqual(['context']);
    expect(out.context).toContain('id: "deploy-widget"');
    expect(out.context).toContain(HERMES_LOAD);
    expect((await hook(b, hermesCmd(b), turn, WIDE)).stdout).toBe('');
    expect(laneLog(b).map((l) => [l.harness, l.outcome])).toEqual([['hermes', 'delivered'], ['hermes', 'empty']]);
  });

  test('a 5 MB conversation_history before and after user_message is read, never refused, and still delivers within a turn budget', async () => {
    const b = await hermesBox();
    const small = await hook(b, hermesCmd(b), { session_id: 'h2a', extra: { user_message: 'please deploy the widget to staging' } }, WIDE);
    expect(JSON.parse(small.stdout).context).toContain('id: "deploy-widget"');
    const turn = { session_id: 'h2', extra: { conversation_history: history(2.5e6), user_message: 'please deploy the widget to staging', later_history: history(2.5e6) } };
    expect(JSON.stringify(turn).length).toBeGreaterThan(5e6);
    const r = await hook(b, hermesCmd(b), turn, WIDE);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).context).toContain('id: "deploy-widget"');
    const [base, big] = laneLog(b).slice(-2);
    expect(big).toMatchObject({ outcome: 'delivered' });
    // Reading 5 MB adds less than one lane deadline to a small turn; a buffering or quadratic reader would not.
    expect(big.ms - base.ms).toBeLessThan(LANE_DEADLINE_MS);
  });

  test('malformed Hermes JSON fails open: exit 0, no stdout, skill_resolve_no_input', async () => {
    const b = await hermesBox();
    for (const raw of ['{"session_id": "h3", "extra": {"user_message": "deploy the widget"', '{"extra": {"user_message": "deploy the widget"}} trailing', '[1, 2]', '']) {
      const r = await hook(b, hermesCmd(b), raw, WIDE);
      expect(r).toMatchObject({ exitCode: 0, stdout: '' });
      expect(laneLog(b).at(-1)).toMatchObject({ outcome: 'error', code: 'skill_resolve_no_input' });
    }
  });

  test('in-place compaction: a history shorter than the last turn saw offers a deduped skill again; a longer or unknown one does not', async () => {
    const b = await hermesBox();
    const ask = (n: number | null) => hook(b, hermesCmd(b), { session_id: 'h5', extra: { user_message: 'please deploy the widget to staging', ...(n === null ? {} : { conversation_history: history(n * 200).slice(0, n) }) } }, WIDE);
    expect(JSON.parse((await ask(4)).stdout).context).toContain('id: "deploy-widget"');
    expect((await ask(6)).stdout).toBe('');
    expect((await ask(null)).stdout).toBe('');
    expect(JSON.parse((await ask(2)).stdout).context).toContain('id: "deploy-widget"');
    expect((await ask(3)).stdout).toBe('');
  });

  test('is_first_turn starts the session fresh even when the history did not shrink', async () => {
    const b = await hermesBox();
    const turn = (first: boolean) => ({ session_id: 'h6', extra: { user_message: 'please deploy the widget to staging', conversation_history: [], is_first_turn: first } });
    expect(JSON.parse((await hook(b, hermesCmd(b), turn(true), WIDE)).stdout).context).toContain('id: "deploy-widget"');
    expect((await hook(b, hermesCmd(b), turn(false), WIDE)).stdout).toBe('');
    expect(JSON.parse((await hook(b, hermesCmd(b), turn(true), WIDE)).stdout).context).toContain('id: "deploy-widget"');
  });

  test('owner_sender_ids: a listed sender gets the block; an unlisted, empty or missing sender gets none, as in the OpenClaw plugin', async () => {
    const b = await hermesBox({ per_harness: { hermes: { owner_sender_ids: ['alice-example'] } } });
    const ask = (id: string, sender?: string) => hook(b, hermesCmd(b), { session_id: id, extra: { user_message: 'please deploy the widget to staging', ...(sender === undefined ? {} : { sender_id: sender }) } }, WIDE);
    expect((await ask('h7a', '')).stdout).toBe('');
    expect((await ask('h7b')).stdout).toBe('');
    expect((await ask('h7c', 'bob-example')).stdout).toBe('');
    expect(laneLog(b).map((l) => l.outcome)).toEqual(['skipped_sender', 'skipped_sender', 'skipped_sender']);
    expect(sessions(b)).toEqual([]);
    expect(JSON.parse((await ask('h7d', 'alice-example')).stdout).context).toContain('id: "deploy-widget"');
    const open = await hermesBox({ per_harness: { hermes: { owner_sender_ids: [] } } });
    expect(JSON.parse((await hook(open, hermesCmd(open), { session_id: 'h7e', extra: { user_message: 'please deploy the widget to staging', sender_id: '' } }, WIDE)).stdout).context).toContain('id: "deploy-widget"');
  });

  test('a stored session from before the history field, or a turn with no history, never resets', async () => {
    const b = await hermesBox();
    const home = join(b.home, '.gbrain');
    const key = sessionKey('on', 'hermes', 'h8');
    mkdirSync(join(b.home, '.gbrain', 'skill-index', 'sessions'), { recursive: true });
    writeFileSync(join(b.home, '.gbrain', 'skill-index', 'sessions', key + '.json'), JSON.stringify({ v: 1, turn: 3, spent: 10, last: { 'deploy-widget': 3 }, again: {} }));
    expect(await historyShrank(home, key, 0)).toBe(false);
    expect(await historyShrank(home, key, undefined)).toBe(false);
    expect(await historyShrank(home, sessionKey('on', 'hermes', 'none-yet'), 0)).toBe(false);
    writeFileSync(join(b.home, '.gbrain', 'skill-index', 'sessions', key + '.json'), JSON.stringify({ v: 1, turn: 3, spent: 10, last: {}, again: {}, history: 5 }));
    expect(await historyShrank(home, key, 4)).toBe(true);
    expect(await historyShrank(home, key, 5)).toBe(false);
  });

  test('skills.resolver.lane_payload_chars caps the Hermes JSON too', async () => {
    const b = await hermesBox({ lane_payload_chars: 500 });
    const r = await hook(b, hermesCmd(b), { session_id: 'h4', extra: { user_message: 'deploy the widget, write the changelog and triage the bug' } }, WIDE);
    expect(r).toMatchObject({ exitCode: 0, stdout: '' });
    expect(laneLog(b).at(-1).outcome).toBe('payload_dropped');
  });
});

describe('readJsonFields: the bounded streaming hook reader', () => {
  const chunks = (text: string, size: number) => { const bytes = Buffer.from(text); return Readable.from(Array.from({ length: Math.ceil(bytes.length / size) }, (_, i) => bytes.subarray(i * size, (i + 1) * size))); };
  const PATHS = ['session_id', 'cwd', 'extra.user_message'];

  test('keeps only the string values at the paths, decoding escapes across any chunk boundary; nested decoys do not match', async () => {
    const doc = { cwd: '/w/acme-example', extra: { conversation_history: [{ user_message: 'decoy', extra: { user_message: 'decoy' } }], user_message: 'say "hi" \\ \u00e9 \ud83d\ude80\n', n: -1.5e3, ok: [true, false, null] }, session_id: 's-1', user_message: 'top-level decoy' };
    const text = JSON.stringify(doc);
    for (const size of [1, 3, 7, 64 * 1024]) {
      expect(await readJsonFields(chunks(text, size), PATHS, HOOK_FIELD_CAP)).toEqual({ cwd: '/w/acme-example', 'extra.user_message': doc.extra.user_message, session_id: 's-1' });
    }
  });

  test('caps each kept value and refuses no payload size', async () => {
    expect(HOOK_FIELD_CAP).toBe(MESSAGE_CAP_BYTES);
    const text = JSON.stringify({ extra: { conversation_history: 'x'.repeat(6e6), user_message: 'y'.repeat(20_000) } });
    const got = await readJsonFields(chunks(text, 64 * 1024), PATHS, 100);
    expect(got).toEqual({ 'extra.user_message': 'y'.repeat(100) });
    const escaped = `{"session_id":"a${'\\u00e9'.repeat(200)}"}`;
    expect(await readJsonFields(chunks(escaped, 5), PATHS, 100)).toEqual({ session_id: `a${'\u00e9'.repeat(99)}` });
  });

  test('null for malformed JSON (a kept string fully checked, discarded ones for nesting and ends), a non-object document; a non-string value is skipped', async () => {
    for (const bad of ['', '{', '{"a":}', '{"a":1,}', '{"session_id":"\\x"}', '{"cwd":"\\u12"}', '{"extra":{"user_message":"line\nbreak"}}', '{"a":01}', '{"a":tru}', '{} {}', '"x"', '[]', '{"a":[{"b":"x"]}', '{"a":"open}']) {
      expect(await readJsonFields(chunks(bad, 2), PATHS, 100)).toBeNull();
    }
    expect(await readJsonFields(chunks('{"session_id": 7, "extra": {"user_message": ["x"]}}', 4), PATHS, 100)).toEqual({});
  });
});

describe('readHookFields: counts and flags in the same streaming pass', () => {
  const chunks = (text: string, size: number) => { const bytes = Buffer.from(text); return Readable.from(Array.from({ length: Math.ceil(bytes.length / size) }, (_, i) => bytes.subarray(i * size, (i + 1) * size))); };
  const SPEC = { strings: ['extra.user_message'], counts: ['extra.conversation_history'], flags: ['extra.is_first_turn'] };

  test('counts top-level items only (nested arrays and commas inside strings do not count) across any chunk boundary, and reads booleans', async () => {
    const history = [{ role: 'user', content: 'a, b, [c], {d}' }, [1, [2, 3]], 'x,y', 4, null, { content: '\\",' }];
    const text = JSON.stringify({ extra: { conversation_history: history, is_first_turn: false, user_message: 'hi' } });
    for (const size of [1, 2, 5, 64 * 1024]) {
      expect(await readHookFields(chunks(text, size), SPEC, 100)).toEqual({ strings: { 'extra.user_message': 'hi' }, counts: { 'extra.conversation_history': history.length }, flags: { 'extra.is_first_turn': false } });
    }
    for (const [doc, n] of [['[]', 0], ['[ ]', 0], [' [5]', 1], ['[{}]', 1], ['["",""]', 2]] as const) {
      expect((await readHookFields(chunks('{"extra":{"conversation_history":' + doc + '}}', 1), SPEC, 100))?.counts).toEqual({ 'extra.conversation_history': n });
    }
  });

  test('a 5 MB history is counted; a stream cut off inside it yields null; a non-array or non-boolean value is left out', async () => {
    const item = { role: 'user', content: 'An earlier turn, with "quotes" and a , comma.' };
    const big = Array.from({ length: Math.ceil(5e6 / JSON.stringify(item).length) }, () => item);
    const text = JSON.stringify({ extra: { conversation_history: big, user_message: 'deploy', is_first_turn: true } });
    expect(text.length).toBeGreaterThan(5e6);
    expect(await readHookFields(chunks(text, 64 * 1024), SPEC, 100)).toEqual({ strings: { 'extra.user_message': 'deploy' }, counts: { 'extra.conversation_history': big.length }, flags: { 'extra.is_first_turn': true } });
    expect(await readHookFields(chunks(text.slice(0, 3e6), 64 * 1024), SPEC, 100)).toBeNull();
    expect(await readHookFields(chunks('{"extra":{"conversation_history":"many","is_first_turn":1}}', 3), SPEC, 100)).toEqual({ strings: {}, counts: {}, flags: {} });
  });
});
