/**
 * GBRA-435 PR 3: gbrain setup cursor --skill-loading resolve|off, Cursor's
 * pinned skills only (src/core/setup/cursor-skill-pins.ts), plus its half
 * of doctor's skill_resolver check.
 *
 * Protects: setup run in a project builds that project's catalog from the
 * skill directories Cursor loads and records the project; with no pins there
 * is no rule file; gbrain skills pin add writes a separate always-applied
 * rule (.cursor/rules/gbrain-pinned-skills.mdc) that names each pinned
 * skill's SKILL.md and leaves out a pin the catalog does not hold; inside git
 * the rule's path goes in info/exclude (from a subdirectory too), so it is
 * never committed; a rule file gbrain did not write is never touched; off
 * removes the rule, the exclude line and the record, keeping the pins, the
 * user's exclude lines and the brain-first rule; doctor reports Cursor as
 * partial (pinned only, no per-turn hook, unverified); a brainless home
 * stays brainless and a plain gbrain setup cursor writes no pins.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { cursorSkillView, describeCursorSkillView } from '../src/commands/doctor/checks/skill-resolver-cursor.ts';

setDefaultTimeout(120_000);
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const RULE = join('.cursor', 'rules', 'gbrain-pinned-skills.mdc');
const BRAIN_FIRST = join('.cursor', 'rules', 'gbrain-brain-first.mdc');

interface Box { root: string; home: string; repo: string; project: string; env: Record<string, string | undefined> }

function skill(dir: string, name: string, description: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), '---\nname: ' + name + '\ndescription: ' + description + '\n---\nSteps.\n');
}

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  return r.stdout.toString();
}

function box(opts: { git?: boolean; sub?: string; skills?: boolean } = {}): Box {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-cursor-pins-')));
  roots.push(root);
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  const project = opts.sub ? join(repo, opts.sub) : repo;
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  if (opts.git !== false) git(repo, 'init', '-q');
  if (opts.skills !== false) {
    skill(join(project, '.cursor', 'skills'), 'deploy-service', 'Use when you deploy a service to production');
    skill(join(project, '.agents', 'skills'), 'email-triage', 'Use when you triage the email inbox');
  }
  return { root, home, repo, project, env: { HOME: home, GBRAIN_HOME: home, GBRAIN_SKILL_LOADING: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } };
}

async function cli(b: Box, args: string[]) {
  const r = await runCli([...args, '--json'], { env: b.env, cwd: b.project, timeoutMs: 110_000 });
  let doc: any = null;
  try { doc = JSON.parse(r.stdout); } catch { doc = null; }
  return { ...r, doc };
}
const setup = (b: Box, extra: string[]) => cli(b, ['setup', 'cursor', ...extra]);
const gbrainHome = (b: Box) => join(b.home, '.gbrain');
const statePath = (b: Box) => join(gbrainHome(b), 'cursor-skill-pins.json');
const rulePath = (b: Box) => join(b.project, RULE);
const exclude = (b: Box) => { try { return readFileSync(join(b.repo, '.git', 'info', 'exclude'), 'utf8'); } catch { return ''; } };

describe('gbrain setup cursor --skill-loading resolve (pinned skills only)', () => {
  test('resolve records the project catalog and writes no rule while there are no pins; a brainless home stays brainless', async () => {
    const b = box();
    const r = await setup(b, ['--skill-loading', 'resolve']);
    expect(r.exitCode).toBe(0);
    const p = r.doc.skill_pins;
    expect(p.error).toBeUndefined();
    expect(p).toMatchObject({ mode: 'pinned', project: b.project, skills: 2, pins: 0 });
    expect(p.catalog).toMatch(/^cursor-project-[0-9a-f]{16}$/);
    expect(p.steps.find((s: any) => s.step === 'rule')).toMatchObject({ action: 'skip' });
    expect(p.notes.join('\n')).toContain('no per-turn suggestions');
    expect(existsSync(rulePath(b))).toBe(false);
    expect(existsSync(join(b.project, BRAIN_FIRST))).toBe(true);
    const st = JSON.parse(readFileSync(statePath(b), 'utf8'));
    expect(st.projects[b.project]).toMatchObject({ catalog: p.catalog, pinned_ids: [] });
    expect(st.projects[b.project].skill_dirs).toEqual([join(b.project, '.agents', 'skills'), join(b.project, '.cursor', 'skills')]);
    const cfg = existsSync(join(gbrainHome(b), 'config.json')) ? JSON.parse(readFileSync(join(gbrainHome(b), 'config.json'), 'utf8')) : {};
    expect(cfg.engine).toBeUndefined();
    expect(cfg.database_url).toBeUndefined();
  });

  test('skills pin add writes an always-applied rule with each SKILL.md path, excluded from git; setup again keeps the same bytes', async () => {
    const b = box();
    const catalog = (await setup(b, ['--skill-loading', 'resolve'])).doc.skill_pins.catalog;
    const add = await cli(b, ['skills', 'pin', 'add', 'deploy-service', '--catalog', catalog, '--line', 'deploys and rollbacks']);
    expect(add.exitCode).toBe(0);
    expect(add.doc.cursor_rule.steps.find((s: any) => s.step === 'rule')).toMatchObject({ action: 'write' });
    const rule = readFileSync(rulePath(b), 'utf8');
    expect(rule.startsWith('---\ndescription: Pinned skills, managed by gbrain')).toBe(true);
    expect(rule).toContain('alwaysApply: true\n---\n<pinned_skills>\n');
    expect(rule).toContain('- id: "deploy-service" when: "deploys and rollbacks" path: "' + join(b.project, '.cursor', 'skills', 'deploy-service', 'SKILL.md') + '"');
    expect(rule).toContain('read the SKILL.md at its path');
    expect(exclude(b).split('\n')).toContain('/' + RULE);
    writeFileSync(join(b.project, '.cursor', 'rules', 'team.mdc'), 'a rule the user commits\n');
    const status = git(b.repo, 'status', '--porcelain', '--untracked-files=all');
    expect(status).not.toContain('gbrain-pinned-skills.mdc');
    expect(status).toContain('.cursor/rules/team.mdc');
    const again = await setup(b, []);
    expect(again.exitCode).toBe(0);
    expect(again.doc.skill_pins.steps.filter((s: any) => s.step !== 'catalog').map((s: any) => [s.step, s.action])).toEqual([['rule', 'keep'], ['exclude', 'keep'], ['state', 'keep']]);
    expect(readFileSync(rulePath(b), 'utf8')).toBe(rule);
    expect(exclude(b).split('\n').filter((l) => l === '/' + RULE)).toHaveLength(1);
    const remove = await cli(b, ['skills', 'pin', 'remove', 'deploy-service', '--catalog', catalog]);
    expect(remove.exitCode).toBe(0);
    expect(existsSync(rulePath(b))).toBe(false);
    expect(exclude(b).split('\n')).not.toContain('/' + RULE);
  });

  test('a pin the project catalog does not hold is left out and reported', async () => {
    const b = box();
    const catalog = (await setup(b, ['--skill-loading', 'resolve'])).doc.skill_pins.catalog;
    await cli(b, ['skills', 'pin', 'add', 'email-triage', '--catalog', catalog]);
    const cfgPath = join(gbrainHome(b), 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.skills.resolver.pins[catalog].push({ name: 'gone-skill' });
    writeFileSync(cfgPath, JSON.stringify(cfg));
    const r = await setup(b, ['--skill-loading', 'resolve']);
    expect(r.exitCode).toBe(0);
    expect(r.doc.skill_pins.pins).toBe(1);
    expect(r.doc.skill_pins.notes.join('\n')).toContain('gone-skill (skill_resolver_pin_unknown)');
    const rule = readFileSync(rulePath(b), 'utf8');
    expect(rule).toContain('"email-triage"');
    expect(rule).not.toContain('gone-skill');
  });

  test('from a subdirectory of the repository the exclude line names the rule under it', async () => {
    const b = box({ sub: 'apps/web' });
    const catalog = (await setup(b, ['--skill-loading', 'resolve'])).doc.skill_pins.catalog;
    await cli(b, ['skills', 'pin', 'add', 'deploy-service', '--catalog', catalog]);
    expect(exclude(b).split('\n')).toContain('/apps/web/' + RULE);
    expect(git(b.repo, 'status', '--porcelain', '--untracked-files=all')).not.toContain('gbrain-pinned-skills.mdc');
  });

  test('outside git the rule is written and setup says nothing was excluded', async () => {
    const b = box({ git: false });
    const catalog = (await setup(b, ['--skill-loading', 'resolve'])).doc.skill_pins.catalog;
    await cli(b, ['skills', 'pin', 'add', 'deploy-service', '--catalog', catalog]);
    const r = await setup(b, []);
    expect(r.exitCode).toBe(0);
    expect(existsSync(rulePath(b))).toBe(true);
    expect(r.doc.skill_pins.steps.some((s: any) => s.step === 'exclude')).toBe(false);
    expect(r.doc.skill_pins.notes.join('\n')).toContain('not in a git repository');
  });

  test('pin add for a recorded project that no longer exists saves the pin and recreates nothing', async () => {
    const b = box();
    const catalog = (await setup(b, ['--skill-loading', 'resolve'])).doc.skill_pins.catalog;
    rmSync(b.repo, { recursive: true, force: true });
    const r = await runCli(['skills', 'pin', 'add', 'deploy-service', '--catalog', catalog, '--json'], { env: b.env, cwd: b.home, timeoutMs: 110_000 });
    expect(JSON.parse(r.stdout).cursor_rule.error).toMatchObject({ code: 'skill_resolver_setup_incomplete' });
    expect(existsSync(b.project)).toBe(false);
    expect(JSON.parse(readFileSync(join(gbrainHome(b), 'config.json'), 'utf8')).skills.resolver.pins[catalog]).toEqual([{ name: 'deploy-service' }]);
  });

  test('a rule file gbrain did not write is left as it is and setup exits non-zero', async () => {
    const b = box();
    mkdirSync(join(b.project, '.cursor', 'rules'), { recursive: true });
    writeFileSync(rulePath(b), '---\nalwaysApply: true\n---\nMy own rule.\n');
    const r = await setup(b, ['--skill-loading', 'resolve']);
    expect(r.exitCode).not.toBe(0);
    expect(readFileSync(rulePath(b), 'utf8')).toBe('---\nalwaysApply: true\n---\nMy own rule.\n');
    const off = await setup(b, ['--skill-loading', 'off']);
    expect(off.exitCode).toBe(0);
    expect(readFileSync(rulePath(b), 'utf8')).toBe('---\nalwaysApply: true\n---\nMy own rule.\n');
  });

  test('off removes the rule, the exclude line and the record, and keeps the pins, the user\'s exclude lines and the brain-first rule', async () => {
    const b = box();
    const catalog = (await setup(b, ['--skill-loading', 'resolve'])).doc.skill_pins.catalog;
    writeFileSync(join(b.repo, '.git', 'info', 'exclude'), exclude(b) + 'my-scratch/\n');
    await cli(b, ['skills', 'pin', 'add', 'deploy-service', '--catalog', catalog]);
    expect(existsSync(rulePath(b))).toBe(true);
    const off = await setup(b, ['--skill-loading', 'off']);
    expect(off.exitCode).toBe(0);
    expect(off.doc.skill_pins.steps.map((s: any) => [s.step, s.action])).toEqual([['rule', 'remove'], ['exclude', 'remove'], ['state', 'remove']]);
    expect(existsSync(rulePath(b))).toBe(false);
    expect(existsSync(statePath(b))).toBe(false);
    expect(exclude(b).split('\n')).toContain('my-scratch/');
    expect(exclude(b).split('\n')).not.toContain('/' + RULE);
    expect(existsSync(join(b.project, BRAIN_FIRST))).toBe(true);
    const cfg = JSON.parse(readFileSync(join(gbrainHome(b), 'config.json'), 'utf8'));
    expect(cfg.skills.resolver.pins[catalog]).toEqual([{ name: 'deploy-service' }]);
    expect((await setup(b, ['--skill-loading', 'off'])).doc.skill_pins).toBeUndefined();
  });

  test('resolve leaves the spring skills index in the brain-first rule, and spring leaves the pins rule', async () => {
    const b = box();
    const launcher = join(b.root, 'gbrain');
    writeFileSync(launcher, `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${join(import.meta.dir, '..', 'src', 'cli.ts')}' "$@"\n`, { mode: 0o755 });
    const spring = await setup(b, ['--skill-loading', 'spring', '--gbrain-bin', launcher]);
    expect(spring.exitCode).toBe(0);
    expect(spring.doc.skills).toMatchObject({ action: 'write', decision: { value: 'spring' } });
    const index = readFileSync(join(b.project, BRAIN_FIRST), 'utf8');
    const r = await setup(b, ['--skill-loading', 'resolve', '--gbrain-bin', launcher]);
    expect(r.exitCode).toBe(0);
    expect(r.doc.skills?.action).not.toBe('remove');
    expect(readFileSync(join(b.project, BRAIN_FIRST), 'utf8')).toBe(index);
    await cli(b, ['skills', 'pin', 'add', 'deploy-service', '--catalog', r.doc.skill_pins.catalog]);
    const rule = readFileSync(rulePath(b), 'utf8');
    const again = await setup(b, ['--skill-loading', 'spring', '--gbrain-bin', launcher]);
    expect(again.exitCode).toBe(0);
    expect(readFileSync(rulePath(b), 'utf8')).toBe(rule);
    expect(readFileSync(join(b.project, BRAIN_FIRST), 'utf8')).toBe(index);
    const declined = await setup(b, ['--skill-loading', 'resolve', '--no-instructions', '--gbrain-bin', launcher]);
    expect(declined.exitCode).toBe(0);
    expect(declined.doc.skills).toMatchObject({ action: 'remove' });
    expect(existsSync(join(b.project, BRAIN_FIRST)) ? readFileSync(join(b.project, BRAIN_FIRST), 'utf8') : '').not.toContain('gbrain:skills');
  });

  test('a plain gbrain setup cursor writes no pins, and a project with no skill directory refuses resolve', async () => {
    const b = box({ skills: false });
    const plain = await setup(b, []);
    expect(plain.exitCode).toBe(0);
    expect(plain.doc.skill_pins).toBeUndefined();
    expect(existsSync(statePath(b))).toBe(false);
    const r = await setup(b, ['--skill-loading', 'resolve']);
    expect(r.exitCode).not.toBe(0);
    expect(existsSync(statePath(b))).toBe(false);
    expect(existsSync(rulePath(b))).toBe(false);
  });

  test('doctor reports Cursor as partial (pinned only, no per-turn hook, unverified) and flags a missing rule', async () => {
    const b = box();
    const catalog = (await setup(b, ['--skill-loading', 'resolve'])).doc.skill_pins.catalog;
    await cli(b, ['skills', 'pin', 'add', 'deploy-service', '--catalog', catalog]);
    const v = await cursorSkillView(gbrainHome(b));
    expect(v).toMatchObject({ coverage: 'partial', coverage_note: 'pinned only, no per-turn hook, unverified' });
    expect(v!.projects).toEqual([{ project: b.project, catalog, rule: 'present', fresh: true, stale_reason: null, skills: 2, pins: 1 }]);
    const ok = describeCursorSkillView(v!);
    expect(ok.problem).toBeNull();
    expect(ok.line).toContain('(partial: pinned only, no per-turn hook, unverified)');
    unlinkSync(rulePath(b));
    const gone = describeCursorSkillView((await cursorSkillView(gbrainHome(b)))!);
    expect(gone.problem).toMatchObject({ code: 'skill_resolver_plugin_not_installed', project: b.project });
  });
});
