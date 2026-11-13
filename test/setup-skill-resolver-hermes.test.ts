/**
 * GST-1850 PR 2: `gbrain setup hermes --skill-loading resolve`. The lane's
 * `pre_llm_call` entry shares gbrain's one marked `hooks:` block in
 * $HERMES_HOME/config.yaml with the brain-first turn rule, each entry with its
 * own approval in shell-hooks-allowlist.json.
 *
 * Protects: the four combinations of turn rule and resolver (neither, turn
 * rule only, resolver only, both) in either install order, and that declining
 * the brain-first rule keeps the resolver (and the reverse); the catalog is
 * built from $HERMES_HOME/skills, nested category folders included; a Hermes
 * with no SOUL.md still gets the resolver and SOUL.md is never created; the
 * operator's pins land in a marked SOUL.md block and leave with the lane; a
 * config.yaml with the user's own hooks: section gets the entry printed, and
 * the entry pasted from it is then approved and kept; a brainless install
 * stays brainless; doctor reports the Hermes hook; config set takes
 * per_harness.hermes.owner_sender_ids; the command splits the way
 * Hermes splits it (shlex, no shell) with /usr/bin/env first.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { runCli } from './helpers/cli-spawn.ts';
import { hermesTurnHookCommand, inspectHermesResolverHook, inspectHermesTurnHook, removeHermesHook, removeHermesTurnHook, syncHermesHook, syncHermesTurnHook } from '../src/core/setup/hermes-turn-hook.ts';
import { hermesResolverCommand } from '../src/core/setup/skill-resolver-hook.ts';
import type { BrainFirstAccess } from '../src/core/setup/brain-first.ts';

setDefaultTimeout(60_000);
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); roots.push(d); return d; };
const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const approvals = (hermes: string) => (JSON.parse(read(join(hermes, 'shell-hooks-allowlist.json')) ?? '{"approvals":[]}').approvals as Array<{ event: string; command: string }>).map((a) => a.command);
const entries = (hermes: string) => ((load(read(join(hermes, 'config.yaml')) ?? '') as { hooks?: { pre_llm_call?: Array<{ command: string; timeout: number }> } } | undefined)?.hooks?.pre_llm_call ?? []);

describe('one hooks: block, two lanes (hermes-turn-hook.ts)', () => {
  const access: BrainFirstAccess = { kind: 'mcp', server: 'gbrain' };
  const rule = hermesTurnHookCommand(access);
  const resolver = hermesResolverCommand('/opt/gbrain/bin/gbrain', undefined, '/opt/gbrain/hook-launcher/gbrain-hook');
  const mine = '# my config\nmodel:\n  default: alice-example-model\n';
  function hermes(config = mine): string {
    const d = tmp('gbrain-hermes-two-lanes-');
    writeFileSync(join(d, 'config.yaml'), config);
    return d;
  }

  test('neither: removing either lane from a config with no block changes nothing', () => {
    const d = hermes();
    expect(removeHermesTurnHook({ hermesHome: d, dryRun: false }).action).toBe('skip');
    expect(removeHermesHook({ hermesHome: d, lane: 'skill-resolver', dryRun: false }).action).toBe('skip');
    expect(read(join(d, 'config.yaml'))).toBe(mine);
    expect(inspectHermesTurnHook(d).state).toBe('absent');
    expect(inspectHermesResolverHook(d).state).toBe('absent');
  });

  test('resolver only: its own entry, its own approval, and the turn rule reads absent', () => {
    const d = hermes();
    expect(syncHermesHook({ hermesHome: d, lane: 'skill-resolver', command: resolver, dryRun: false }).action).toBe('write');
    expect(entries(d)).toEqual([{ command: resolver, timeout: 15 }]);
    expect(approvals(d)).toEqual([resolver]);
    expect(inspectHermesTurnHook(d).state).toBe('absent');
    expect(inspectHermesResolverHook(d)).toMatchObject({ state: 'approved', command: resolver });
    expect(removeHermesTurnHook({ hermesHome: d, dryRun: false }).action).toBe('skip');
    expect(entries(d)).toEqual([{ command: resolver, timeout: 15 }]);
  });

  test('both, in either order: the same bytes, the turn rule first, each approved; each lane leaves alone and the block goes with the last', () => {
    const a = hermes();
    syncHermesTurnHook({ hermesHome: a, access, dryRun: false });
    expect(syncHermesHook({ hermesHome: a, lane: 'skill-resolver', command: resolver, dryRun: false }).action).toBe('write');
    const b = hermes();
    syncHermesHook({ hermesHome: b, lane: 'skill-resolver', command: resolver, dryRun: false });
    expect(syncHermesTurnHook({ hermesHome: b, access, dryRun: false }).action).toBe('write');
    expect(read(join(a, 'config.yaml'))).toBe(read(join(b, 'config.yaml')));
    expect(entries(a)).toEqual([{ command: rule, timeout: 10 }, { command: resolver, timeout: 15 }]);
    expect(approvals(a).sort()).toEqual([resolver, rule].sort());
    expect(syncHermesTurnHook({ hermesHome: a, access, dryRun: false }).action).toBe('keep');
    expect(syncHermesHook({ hermesHome: a, lane: 'skill-resolver', command: resolver, dryRun: false }).action).toBe('keep');
    expect(inspectHermesTurnHook(a)).toMatchObject({ state: 'approved', command: rule });

    expect(removeHermesTurnHook({ hermesHome: a, dryRun: false }).action).toBe('remove');
    expect(entries(a)).toEqual([{ command: resolver, timeout: 15 }]);
    expect(approvals(a)).toEqual([resolver]);
    expect(removeHermesHook({ hermesHome: a, lane: 'skill-resolver', dryRun: false }).action).toBe('remove');
    expect(read(join(a, 'config.yaml'))).toBe(mine);
    expect(approvals(a)).toEqual([]);

    expect(removeHermesHook({ hermesHome: b, lane: 'skill-resolver', dryRun: false }).action).toBe('remove');
    expect(entries(b)).toEqual([{ command: rule, timeout: 10 }]);
    expect(approvals(b)).toEqual([rule]);
  });

  test('turn rule only: an install from before the resolver keeps its exact bytes', () => {
    const before = `${mine}# gbrain:turn-rule:begin\nhooks:\n  pre_llm_call:\n    - command: ${JSON.stringify(rule)}\n      timeout: 10\n# gbrain:turn-rule:end\n`;
    const d = hermes(before);
    expect(syncHermesTurnHook({ hermesHome: d, access, dryRun: false }).action).toBe('keep');
    expect(read(join(d, 'config.yaml'))).toBe(before);
  });

  test('a new resolver command replaces only its own entry and moves only its own approval', () => {
    const d = hermes();
    syncHermesTurnHook({ hermesHome: d, access, dryRun: false });
    syncHermesHook({ hermesHome: d, lane: 'skill-resolver', command: resolver, dryRun: false });
    const moved = hermesResolverCommand('/usr/local/bin/gbrain', '/srv/alice-example', '/srv/alice-example/.gbrain/hook-launcher/gbrain-hook');
    expect(syncHermesHook({ hermesHome: d, lane: 'skill-resolver', command: moved, dryRun: false }).action).toBe('write');
    expect(entries(d)).toEqual([{ command: rule, timeout: 10 }, { command: moved, timeout: 15 }]);
    expect(approvals(d).sort()).toEqual([moved, rule].sort());
  });

  test('the user\'s own hooks: section: the resolver entry is printed; pasted as printed, it is approved and kept', () => {
    const theirs = 'hooks:\n  pre_tool_call:\n    - command: /usr/bin/true\n';
    const d = hermes(theirs);
    const o = syncHermesHook({ hermesHome: d, lane: 'skill-resolver', command: resolver, dryRun: false });
    expect(o.action).toBe('print');
    expect(o.snippet).toBe(`hooks:\n  pre_llm_call:\n    - command: ${JSON.stringify(resolver)}\n      timeout: 15\n`);
    expect(read(join(d, 'config.yaml'))).toBe(theirs);
    const pasted = `${theirs}  pre_llm_call:\n    - command: ${JSON.stringify(resolver)}\n      timeout: 15\n`;
    writeFileSync(join(d, 'config.yaml'), pasted);
    expect(inspectHermesResolverHook(d).state).toBe('unapproved');
    expect(syncHermesHook({ hermesHome: d, lane: 'skill-resolver', command: resolver, dryRun: false }).action).toBe('keep');
    expect(read(join(d, 'config.yaml'))).toBe(pasted);
    expect(inspectHermesResolverHook(d)).toMatchObject({ state: 'approved', command: resolver });
    const off = removeHermesHook({ hermesHome: d, lane: 'skill-resolver', dryRun: false });
    expect(off.action).toBe('skip');
    expect(off.detail).toContain('delete it there');
    expect(read(join(d, 'config.yaml'))).toBe(pasted);
    expect(approvals(d)).not.toContain(resolver);
    expect(inspectHermesResolverHook(d).state).toBe('unapproved');
  });

  test.skipIf(!Bun.which('python3'))('the command splits the way Hermes splits it (shlex, no shell), /usr/bin/env first', () => {
    const odd = hermesResolverCommand("/opt/it's here/gbrain", '/home/alice example', '/home/alice example/.gbrain/hook-launcher/gbrain-hook');
    const split = Bun.spawnSync(['python3', '-c', 'import json, shlex, sys; print(json.dumps(shlex.split(sys.argv[1])))', odd]);
    expect(JSON.parse(split.stdout.toString())).toEqual(['/usr/bin/env', 'GBRAIN_HOOK_LANE=skill-resolver', 'GBRAIN_HOME=/home/alice example',
      '/home/alice example/.gbrain/hook-launcher/gbrain-hook', "/opt/it's here/gbrain", 'hook', 'user-prompt', '--harness', 'hermes']);
    expect(resolver).toBe('/usr/bin/env GBRAIN_HOOK_LANE=skill-resolver /opt/gbrain/hook-launcher/gbrain-hook /opt/gbrain/bin/gbrain hook user-prompt --harness hermes');
  });
});

interface Box { home: string; hermes: string; project: string; bin: string; env: Record<string, string | undefined> }
function box(opts: { soul?: boolean } = {}): Box {
  const root = tmp('gbrain-setup-hermes-resolver-');
  const home = join(root, 'home'), hermes = join(home, '.hermes'), project = join(root, 'project');
  for (const d of [home, hermes, project, join(root, 'bin')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(hermes, 'config.yaml'), 'model: alice-example-model\n');
  if (opts.soul !== false) writeFileSync(join(hermes, 'SOUL.md'), 'You are a helpful agent.\n');
  const bin = join(root, 'bin', 'gbrain');
  writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${CLI}' "$@"\n`);
  chmodSync(bin, 0o755);
  return { home, hermes, project, bin, env: {
    HOME: home, GBRAIN_HOME: home, HERMES_HOME: hermes, PATH: '/usr/bin:/bin', CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, XDG_CONFIG_HOME: undefined,
    GBRAIN_SKILL_LOADING: undefined, GBRAIN_HOOK_LANE: undefined, GBRAIN_AGENT_INSTRUCTIONS: undefined, GBRAIN_HOOKS: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
  } };
}
function skill(dir: string, name: string, description: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nSteps.\n`);
}
async function setup(b: Box, extra: string[]) {
  const r = await runCli(['setup', 'hermes', '--gbrain-bin', b.bin, ...extra], { env: b.env, cwd: b.project });
  let doc: any = null;
  try { doc = JSON.parse(r.stdout); } catch { doc = null; }
  return { ...r, doc };
}
const configPath = (b: Box) => join(b.home, '.gbrain', 'config.json');
const isResolver = (c: string) => c.includes('GBRAIN_HOOK_LANE=skill-resolver');
const isRule = (c: string) => c.startsWith('/bin/echo ');

describe('setup hermes --skill-loading resolve', () => {
  test('on beside the turn rule, nested skill folders indexed; declining the rule keeps the resolver; off restores config.yaml', async () => {
    const b = box();
    skill(join(b.hermes, 'skills', 'devops'), 'deploy-widget', 'Deploy the widget service.');
    const on = await setup(b, ['--skill-loading', 'resolve']);
    expect(on.exitCode, on.stderr + on.stdout).toBe(0);
    expect(on.stdout).toMatch(/skill resolver: on; 1 skills; fresh/);
    expect(JSON.parse(read(configPath(b))!)).toEqual({ skills: { resolver: { enabled: true, harnesses: ['hermes'] } } });
    expect(existsSync(join(b.home, '.gbrain', 'skill-index', 'hermes-user', 'receipt.json'))).toBe(true);
    const both = entries(b.hermes).map((e) => e.command);
    expect(both.length).toBe(2);
    expect(isRule(both[0]!) && isResolver(both[1]!)).toBe(true);
    expect(both[1]).toContain(`${b.bin} hook user-prompt --harness hermes`);
    expect(approvals(b.hermes).sort()).toEqual([...both].sort());

    const again = await setup(b, ['--skill-loading', 'resolve', '--json']);
    expect(again.exitCode).toBe(0);
    expect(again.doc.skill_resolver.steps.map((s: any) => s.action)).toEqual(['keep', 'keep', 'keep']);

    const declined = await setup(b, ['--no-instructions']);
    expect(declined.exitCode, declined.stderr).toBe(0);
    expect(entries(b.hermes).map((e) => e.command)).toEqual([both[1]]);
    expect(approvals(b.hermes)).toEqual([both[1]]);

    const off = await setup(b, ['--skill-loading', 'off']);
    expect(off.exitCode, off.stderr).toBe(0);
    expect(read(join(b.hermes, 'config.yaml'))).toBe('model: alice-example-model\n');
    expect(approvals(b.hermes)).toEqual([]);
    expect(read(configPath(b))).toBeNull();
  });

  test('a brainless, keyless install stays brainless: the config file holds only the resolver keys', async () => {
    const b = box();
    skill(join(b.hermes, 'skills'), 'deploy-widget', 'Deploy the widget service.');
    expect((await setup(b, ['--no-instructions', '--skill-loading', 'resolve'])).exitCode).toBe(0);
    expect(JSON.parse(read(configPath(b))!)).toEqual({ skills: { resolver: { enabled: true, harnesses: ['hermes'] } } });
    expect(entries(b.hermes).map((e) => isResolver(e.command))).toEqual([true]);
    expect(existsSync(join(b.home, '.gbrain', 'brain.pglite'))).toBe(false);
  });

  test('no SOUL.md: the resolver is still installed and SOUL.md is never created', async () => {
    const b = box({ soul: false });
    skill(join(b.hermes, 'skills'), 'deploy-widget', 'Deploy the widget service.');
    const on = await setup(b, ['--skill-loading', 'resolve']);
    expect(on.exitCode, on.stderr + on.stdout).toBe(0);
    expect(entries(b.hermes).map((e) => isResolver(e.command))).toEqual([true]);
    expect(existsSync(join(b.hermes, 'SOUL.md'))).toBe(false);
  });

  test('pins: none writes no block; a pin lands in a marked SOUL.md block; removing it, or the lane, strips the block', async () => {
    const b = box();
    skill(join(b.hermes, 'skills'), 'deploy-widget', 'Deploy the widget service.');
    expect((await setup(b, ['--no-instructions', '--skill-loading', 'resolve'])).exitCode).toBe(0);
    expect(read(join(b.hermes, 'SOUL.md'))).toBe('You are a helpful agent.\n');
    const add = await runCli(['skills', 'pin', 'add', 'deploy-widget', '--catalog', 'hermes-user', '--line', 'when shipping the widget'], { env: b.env, cwd: b.project });
    expect(add.exitCode, add.stderr).toBe(0);
    const soul = read(join(b.hermes, 'SOUL.md'))!;
    expect(soul.startsWith('You are a helpful agent.\n<!-- gbrain:skill-pins:begin -->\n<pinned_skills>')).toBe(true);
    expect(soul).toContain('- id: "deploy-widget" when: "when shipping the widget"');
    expect((await setup(b, ['--json'])).doc.skill_resolver.steps.find((s: any) => s.step === 'pins')).toMatchObject({ action: 'keep' });
    expect((await runCli(['skills', 'pin', 'remove', 'deploy-widget', '--catalog', 'hermes-user'], { env: b.env, cwd: b.project })).exitCode).toBe(0);
    expect(read(join(b.hermes, 'SOUL.md'))).toBe('You are a helpful agent.\n');
    expect((await runCli(['skills', 'pin', 'add', 'deploy-widget', '--catalog', 'hermes-user'], { env: b.env, cwd: b.project })).exitCode).toBe(0);
    expect(read(join(b.hermes, 'SOUL.md'))).toContain('gbrain:skill-pins:begin');
    expect((await setup(b, ['--skill-loading', 'off'])).exitCode).toBe(0);
    expect(read(join(b.hermes, 'SOUL.md'))).toBe('You are a helpful agent.\n');
  });

  test('the user\'s own hooks: section: refuses with the entry to paste and writes nothing to config.yaml', async () => {
    const b = box();
    const theirs = 'hooks:\n  pre_tool_call:\n    - command: /usr/bin/true\n';
    writeFileSync(join(b.hermes, 'config.yaml'), theirs);
    skill(join(b.hermes, 'skills'), 'deploy-widget', 'Deploy the widget service.');
    const r = await setup(b, ['--no-instructions', '--skill-loading', 'resolve']);
    expect(r.exitCode).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('skill_resolver_setup_incomplete');
    expect(`${r.stdout}${r.stderr}`).toContain('pre_llm_call');
    expect(read(join(b.hermes, 'config.yaml'))).toBe(theirs);
  });

  test('config set takes per_harness.hermes.owner_sender_ids as a list, without a brain, and refuses it for another harness', async () => {
    const b = box();
    const run = (...args: string[]) => runCli(['config', ...args], { env: b.env, cwd: b.project });
    expect((await run('set', 'skills.resolver.per_harness.hermes.owner_sender_ids', 'alice-example, bob-example')).exitCode).toBe(0);
    expect(JSON.parse(read(configPath(b))!)).toEqual({ skills: { resolver: { per_harness: { hermes: { owner_sender_ids: ['alice-example', 'bob-example'] } } } } });
    expect((await run('set', 'skills.resolver.per_harness.codex.owner_sender_ids', 'alice-example')).exitCode).not.toBe(0);
    expect((await run('unset', 'skills.resolver.per_harness.hermes.owner_sender_ids')).exitCode).toBe(0);
    expect(read(configPath(b))).toBeNull();
  });

  test('doctor reports the Hermes hook, and warns when its approval is gone', async () => {
    const b = box();
    skill(join(b.hermes, 'skills'), 'deploy-widget', 'Deploy the widget service.');
    expect((await setup(b, ['--no-instructions', '--skill-loading', 'resolve'])).exitCode).toBe(0);
    const doctor = async () => JSON.parse((await runCli(['doctor', '--only', 'skill_resolver', '--json'], { env: b.env, cwd: b.project })).stdout).checks.find((c: any) => c.name === 'skill_resolver');
    expect(await doctor()).toMatchObject({ status: 'ok', details: { harnesses: [{ harness: 'hermes', on: true, hook: 'wired', catalogs: [{ name: 'hermes-user', fresh: true, skills: 1 }] }] } });
    writeFileSync(join(b.hermes, 'shell-hooks-allowlist.json'), JSON.stringify({ approvals: [] }));
    const warn = await doctor();
    expect(warn.status).toBe('warn');
    expect(warn.message).toContain('not approved');
    expect(warn.fix.argv).toEqual(['gbrain', 'setup', 'hermes', '--skill-loading', 'resolve']);
  });
});
