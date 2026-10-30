/**
 * GBRA-194: the spring-loaded skills index on the installer lanes beside
 * setup: `gbrain connect --harness … --install` (native config files and the
 * thin-client GBRAIN-INSTRUCTIONS.md), `gbrain bootstrap harness`, the
 * shared installer decision, and doctor's informational report.
 *
 * Protects: every lane writes the index right after the brain-first block
 * only when spring is selected, a hosted or thin connection lists only the
 * skills that are not host-only, opt-outs and removal take the index out,
 * and doctor names a stale index's refresh command without changing status.
 * Fails when: a lane writes an index by default, indexes host-only skills
 * for a remote connection, leaves an index after --remove or
 * --no-instructions, or doctor warns on (or hides) a stale index.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { BRAIN_FIRST_END, brainFirstTargetAt } from '../src/core/setup/brain-first.ts';
import { describeSkillsBlockOutcome, installerSkillsBlock, loaderAllowRule, readSkillLoadingLedger, refreshSkillsIndexes, skillsIndexViews, skillsOutcomeFailed, SKILLS_BLOCK_BEGIN, SKILLS_BLOCK_END, type SkillsBlockOutcome } from '../src/core/setup/skills-block.ts';
import { removeHarnessBrainFirst, writeHarnessBrainFirst } from '../src/core/bootstrap/harness-brain-first.ts';
import { installHarnessConnection } from '../src/core/harness/install.ts';
import { removeHarnessSkillsIndex, writeHarnessSkillsIndex } from '../src/core/bootstrap/harness-skills-index.ts';
import { withSkillsIndex } from '../src/commands/doctor/checks/harness-wiring.ts';
import { bundledSkills } from '../src/core/skills/bundled.ts';
import type { HarnessCredentials } from '../src/core/harness/credentials.ts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const BIN_DIR = mkdtempSync(join(tmpdir(), 'gbrain-skill-bin-'));
const LAUNCHER = join(BIN_DIR, 'gbrain');
writeFileSync(LAUNCHER, '#!/bin/sh\nexec \'' + process.execPath + '\' --no-env-file \'' + CLI + '\' "$@"\n');
chmodSync(LAUNCHER, 0o755);
const roots: string[] = [];
/** chmod-based failure probes cannot fail for root (the ci:local container). */
const asRoot = process.getuid?.() === 0;
afterAll(() => { for (const r of [...roots, BIN_DIR]) rmSync(r, { recursive: true, force: true }); });
function box() {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-skill-lanes-'));
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  return { root, home, env: {
    HOME: home, GBRAIN_HOME: home, CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, XDG_CONFIG_HOME: undefined,
    OPENCLAW_STATE_DIR: undefined, OPENCLAW_WORKSPACE_DIR: undefined, OPENCLAW_PROFILE: undefined, HERMES_HOME: undefined,
    GBRAIN_AGENT_INSTRUCTIONS: undefined, GBRAIN_SKILL_LOADING: undefined, GBRAIN_SURFACE: undefined,
  } };
}
const read = (p: string) => readFileSync(p, 'utf8');
const lines = (t: string) => t.split('\n');
const hostOnly = bundledSkills('owner').filter(s => s.audience === 'owner').map(s => s.name);
const indexed = (t: string) => lines(t.slice(t.indexOf(SKILLS_BLOCK_BEGIN), t.indexOf(SKILLS_BLOCK_END))).filter(l => l.startsWith('- ')).map(l => l.slice(2).split(':')[0]);
const credentials: HarnessCredentials = { version: 1, mcp_url: 'https://brain.example.com/mcp', issuer_url: 'https://brain.example.com', client_id: 'gbrain_cl_fixture', client_secret: 'fixture-secret-not-real', access_token: 'fixture-token-not-real' };

describe('connect --harness --install', () => {
  for (const [harness, config, instructions] of [
    ['claude-code', '.claude.json', join('.claude', 'CLAUDE.md')],
    ['codex', join('.codex', 'config.toml'), join('.codex', 'AGENTS.md')],
    ['opencode', join('.config', 'opencode', 'opencode.jsonc'), join('.config', 'opencode', 'AGENTS.md')],
  ] as const) {
    test(`${harness}: off by default; spring indexes the non-host skills after brain-first; opt-out and --remove take it out`, async () => {
      const b = box();
      await withEnv(b.env, async () => {
        const configPath = join(b.home, config);
        const file = join(b.home, instructions);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, 'house rules\n');
        const plain = await installHarnessConnection(credentials, { harness, configPath });
        expect((plain as any).skills.decision).toEqual({ value: 'off', source: 'default' });
        expect(read(file)).not.toContain(SKILLS_BLOCK_BEGIN);

        const spring = await installHarnessConnection(credentials, { harness, configPath, skillLoading: 'spring', gbrainBin: LAUNCHER });
        expect((spring as any).skills.action).toBe('write');
        const text = read(file);
        expect(lines(text).indexOf(SKILLS_BLOCK_BEGIN)).toBe(lines(text).indexOf(BRAIN_FIRST_END) + 1);
        expect(indexed(text)).toEqual(bundledSkills('downstream').map(s => s.name));
        expect(indexed(text).filter(n => hostOnly.includes(n))).toEqual([]);

        expect(((await installHarnessConnection(credentials, { harness, configPath, gbrainBin: LAUNCHER })) as any).skills).toMatchObject({ action: 'keep', decision: { source: 'prior' } });
        const optedOut = await installHarnessConnection(credentials, { harness, configPath, instructions: false });
        expect((optedOut as any).skills).toMatchObject({ action: 'remove', decision: { source: 'instructions_off' } });
        expect(read(file)).toBe('house rules\n');

        await installHarnessConnection(credentials, { harness, configPath, instructions: true, skillLoading: 'spring', gbrainBin: LAUNCHER });
        expect(read(file)).toContain(SKILLS_BLOCK_BEGIN);
        const removed = await installHarnessConnection(credentials, { harness, configPath, remove: true });
        expect((removed as any).skills.action).toBe('remove');
        expect(read(file)).toBe('house rules\n');
      });
    });
  }

  test('removing one connection leaves the skills index beside another connection\'s brain-first block', async () => {
    const b = box();
    await withEnv(b.env, async () => {
      const configPath = join(b.home, '.claude.json');
      const file = join(b.home, '.claude', 'CLAUDE.md');
      await installHarnessConnection(credentials, { harness: 'claude-code', configPath, name: 'conn-a', skillLoading: 'spring', gbrainBin: LAUNCHER });
      await installHarnessConnection(credentials, { harness: 'claude-code', configPath, name: 'conn-b', gbrainBin: LAUNCHER });
      const removed = await installHarnessConnection(credentials, { harness: 'claude-code', configPath, name: 'conn-a', remove: true }) as any;
      expect(removed.skills.action).toBe('skip');
      expect(read(file)).toContain(SKILLS_BLOCK_BEGIN);
      expect(readSkillLoadingLedger()).toHaveLength(1);
    });
  });

  test('a requested index that is not written is flagged in the result and its next_action', async () => {
    const b = box();
    await withEnv(b.env, async () => {
      const configPath = join(b.home, '.codex', 'config.toml');
      const r = await installHarnessConnection(credentials, { harness: 'codex', configPath, skillLoading: 'spring', gbrainBin: join(b.root, 'missing', 'gbrain') }) as any;
      expect(r.skills).toMatchObject({ action: 'preserve', reason: 'launcher_unusable' });
      expect(r.skills_failed).toBe(true);
      expect(r.next_action).not.toContain('skills');
    });
  });

  test('thin client: GBRAIN-INSTRUCTIONS.md carries the index after brain-first with the root launcher; the choice is kept', async () => {
    const b = box();
    const root = join(b.root, 'thin');
    await withEnv(b.env, async () => {
      const off = await installHarnessConnection(credentials, { harness: 'openclaw', root });
      expect((off as any).skill_loading).toBe('off');
      expect(read(join(root, 'GBRAIN-INSTRUCTIONS.md'))).not.toContain(SKILLS_BLOCK_BEGIN);
      const on = await installHarnessConnection(credentials, { harness: 'openclaw', root, skillLoading: 'spring' });
      expect((on as any).skill_loading).toBe('spring');
      const text = read(join(root, 'GBRAIN-INSTRUCTIONS.md'));
      expect(lines(text).indexOf(SKILLS_BLOCK_BEGIN)).toBe(lines(text).indexOf(BRAIN_FIRST_END) + 1);
      expect(text).toContain('\`' + join(root, 'bin', 'gbrain') + ' bundled-skill <name>\`');
      expect(indexed(text)).toEqual(bundledSkills('downstream').map(s => s.name));
      await installHarnessConnection(credentials, { harness: 'openclaw', root });
      expect(read(join(root, 'GBRAIN-INSTRUCTIONS.md'))).toBe(text);
      await withEnv({ GBRAIN_HOME: root }, async () => {
        expect(skillsIndexViews()).toMatchObject([{ harness: 'openclaw', path: join(root, 'GBRAIN-INSTRUCTIONS.md'), state: 'current' }]);
        expect(skillsIndexViews()[0].refresh).toContain('gbrain connect');
      });
      await installHarnessConnection(credentials, { harness: 'openclaw', root, instructions: false });
      expect(read(join(root, 'GBRAIN-INSTRUCTIONS.md'))).not.toContain(SKILLS_BLOCK_BEGIN);
    });
  });
});

describe('bootstrap harness', () => {
  test('spring writes a host index (every bundled skill) beside each confirmed host; removal strips only this lane\'s (deleting a file only the index was in)', async () => {
    const b = box();
    await withEnv(b.env, async () => {
      const paths = { claudeMemoryPath: join(b.home, '.claude', 'CLAUDE.md'), codexAgentsPath: join(b.home, '.codex', 'AGENTS.md'),
        codexAgentsOverride: join(b.home, '.codex', 'AGENTS.override.md'), opencodeAgentsPath: join(b.home, '.config', 'opencode', 'AGENTS.md') };
      const log: string[] = [];
      const settingsPath = join(b.home, '.claude', 'settings.json');
      const off = writeHarnessSkillsIndex({ hosts: ['claude-code'], launcher: LAUNCHER, optOut: false, paths, settingsPath, log: (l) => log.push(l) });
      expect(off[0].action).toBe('skip');
      expect(log).toEqual([]);
      const on = writeHarnessSkillsIndex({ hosts: ['claude-code', 'codex'], launcher: LAUNCHER, optOut: false, skillLoading: 'spring', paths, settingsPath, log: (l) => log.push(l) });
      expect(on.map(o => o.action)).toEqual(['write', 'write']);
      expect(indexed(read(paths.claudeMemoryPath))).toEqual(bundledSkills('owner').map(s => s.name));
      expect(read(paths.codexAgentsPath)).toContain('\`' + LAUNCHER + ' bundled-skill <name>\`');

      const other = join(b.home, 'other', 'AGENTS.md');
      installerSkillsBlock({ target: brainFirstTargetAt('opencode', other), launcher: LAUNCHER, writer: 'gbrain setup opencode', brainFirstDeclined: false, skillLoading: 'spring' });
      removeHarnessSkillsIndex('gbrain', () => {});
      expect(existsSync(paths.claudeMemoryPath)).toBe(false);
      expect(read(other)).toContain(SKILLS_BLOCK_BEGIN);
      expect(readSkillLoadingLedger().map(e => e.writer)).toEqual(['gbrain setup opencode']);
    });
  });

  test('removing one connection leaves the index in a file whose brain-first block belongs to another connection', async () => {
    const b = box();
    await withEnv(b.env, async () => {
      const paths = { claudeMemoryPath: join(b.home, '.claude', 'CLAUDE.md'), codexAgentsPath: join(b.home, '.codex', 'AGENTS.md'),
        codexAgentsOverride: join(b.home, '.codex', 'AGENTS.override.md'), opencodeAgentsPath: join(b.home, '.config', 'opencode', 'AGENTS.md') };
      const settingsPath = join(b.home, '.claude', 'settings.json');
      const quiet = () => {};
      writeHarnessBrainFirst({ hosts: ['codex'], server: 'conn-b', optOut: false, paths, log: quiet });
      writeHarnessSkillsIndex({ hosts: ['codex'], launcher: LAUNCHER, optOut: false, skillLoading: 'spring', paths, settingsPath, log: quiet });
      removeHarnessBrainFirst('conn-a', quiet);
      removeHarnessSkillsIndex('conn-a', quiet);
      expect(read(paths.codexAgentsPath)).toContain(SKILLS_BLOCK_BEGIN);
      expect(readSkillLoadingLedger()).toHaveLength(1);
      removeHarnessBrainFirst('conn-b', quiet);
      removeHarnessSkillsIndex('conn-b', quiet);
      expect(existsSync(paths.codexAgentsPath) ? read(paths.codexAgentsPath) : '').not.toContain(SKILLS_BLOCK_BEGIN);
      expect(readSkillLoadingLedger()).toEqual([]);
    });
  });
});

describe('installer decision', () => {
  test('flag, then GBRAIN_SKILL_LOADING, then the recorded choice; a declined brain-first block forces off', async () => {
    const b = box();
    const target = brainFirstTargetAt('opencode', join(b.home, 'agents', 'AGENTS.md'));
    const base = { target, launcher: LAUNCHER, writer: 'test' };
    await withEnv({ ...b.env, GBRAIN_SKILL_LOADING: 'spring' }, async () => {
      expect(installerSkillsBlock({ ...base, brainFirstDeclined: false }).decision).toEqual({ value: 'spring', source: 'env' });
      expect(installerSkillsBlock({ ...base, brainFirstDeclined: false, skillLoading: 'off' }).decision).toEqual({ value: 'off', source: 'flag' });
      expect(installerSkillsBlock({ ...base, brainFirstDeclined: true, skillLoading: 'spring' }).decision).toEqual({ value: 'off', source: 'instructions_off' });
    });
    await withEnv(b.env, async () => {
      installerSkillsBlock({ ...base, brainFirstDeclined: false, skillLoading: 'spring' });
      expect(installerSkillsBlock({ ...base, brainFirstDeclined: false }).decision).toEqual({ value: 'spring', source: 'prior' });
    });
  });
});

describe('doctor: skills index', () => {
  const check = { name: 'harness_wiring', status: 'ok' as const, message: 'Claude Code is wired.' };
  test('a stale or missing index is named with its refresh command and never changes the status', () => {
    const out = withSkillsIndex(check, [
      { harness: 'claude-code', path: '/home/alice-example/.claude/CLAUDE.md', state: 'stale', refresh: 'gbrain setup claude-code --skills-index-only' },
      { harness: 'codex', path: '/home/alice-example/.codex/AGENTS.md', state: 'current', refresh: 'gbrain setup codex --skills-index-only' },
    ]);
    expect(out.status).toBe('ok');
    expect(out.message).toContain('claude-code skills index');
    expect(out.message).toContain('`gbrain setup claude-code --skills-index-only`');
    expect(out.message).not.toContain('codex skills index');
    expect((out.details as any).skills_index).toHaveLength(2);
    const warn = withSkillsIndex({ ...check, status: 'warn' as any }, [{ harness: 'cursor', path: '/p/.cursor/rules/x.mdc', state: 'absent', refresh: 'gbrain setup cursor --instructions-only' }]);
    expect(warn.status).toBe('warn');
  });
  test('an index whose recorded gbrain is gone reports launcher_missing with a --gbrain-bin refresh', async () => {
    const b = box();
    const moved = join(b.root, 'old-install', 'gbrain');
    mkdirSync(dirname(moved), { recursive: true });
    copyFileSync(LAUNCHER, moved);
    chmodSync(moved, 0o755);
    await withEnv(b.env, async () => {
      installerSkillsBlock({ target: brainFirstTargetAt('opencode', join(b.home, 'agents', 'AGENTS.md')), launcher: moved, writer: 'test', brainFirstDeclined: false, skillLoading: 'spring' });
      expect(skillsIndexViews().map(v => v.state)).toEqual(['current']);
      rmSync(moved);
      const views = skillsIndexViews();
      expect(views).toMatchObject([{ state: 'launcher_missing' }]);
      expect(views[0].refresh).toContain('--gbrain-bin');
      const out = withSkillsIndex(check, views);
      expect(out.status).toBe('warn');
      expect(out.message).toContain('no longer there');
      expect((out as any).fix.user_message).toContain('--gbrain-bin');
    });
  });
  test('an unreadable ledger warns with a fix that says to restore it, not to start over', async () => {
    const b = box();
    await withEnv(b.env, async () => {
      mkdirSync(join(b.home, '.gbrain'), { recursive: true });
      writeFileSync(join(b.home, '.gbrain', 'skill-loading.json'), '{not json');
      const views = skillsIndexViews();
      expect(views).toMatchObject([{ state: 'ledger_unreadable' }]);
      const out = withSkillsIndex(check, views);
      expect(out.status).toBe('warn');
      expect((out as any).fix.user_message).toContain('Restore a valid copy');
    });
  });
  test('no index on: the check is returned unchanged; all current: only details are added', () => {
    expect(withSkillsIndex(check, [])).toBe(check);
    const cur = withSkillsIndex(check, [{ harness: 'codex', path: '/x', state: 'current', refresh: 'r' }]);
    expect(cur.message).toBe(check.message);
  });
});

describe('Claude Code loader rule', () => {
  const allowList = (settings: string): string[] => (existsSync(settings) ? JSON.parse(read(settings)).permissions?.allow ?? [] : []);
  const setup = (b: ReturnType<typeof box>) => {
    const settings = join(b.home, '.claude', 'settings.json');
    const user = brainFirstTargetAt('claude-code', join(b.home, '.claude', 'CLAUDE.md'));
    const project = brainFirstTargetAt('claude-code', join(b.root, 'repo', 'CLAUDE.md'));
    mkdirSync(dirname(project.path), { recursive: true });
    const spring = (target: typeof user, extra: Record<string, unknown> = { skillLoading: 'spring' }) =>
      installerSkillsBlock({ target, launcher: LAUNCHER, writer: 'test', brainFirstDeclined: false, ...extra });
    const remove = (target: typeof user) => spring(target, { remove: true });
    return { settings, user, project, spring, remove, rule: loaderAllowRule(LAUNCHER) };
  };

  for (const order of ['user first', 'project first'] as const) {
    test(`two indexes sharing one rule: it stays until the last is removed (${order}), and only the real removal reports it`, async () => {
      const b = box();
      await withEnv(b.env, async () => {
        const s = setup(b);
        expect(s.spring(s.user).permission).toMatchObject({ change: 'added', rule: s.rule });
        expect(s.spring(s.project).permission).toBeUndefined();
        const [first, second] = order === 'user first' ? [s.user, s.project] : [s.project, s.user];
        const r1 = s.remove(first);
        expect(r1.action).toBe('remove');
        expect(r1.permission).toBeUndefined();
        expect(allowList(s.settings)).toContain(s.rule);
        const r2 = s.remove(second);
        expect(r2.permission).toMatchObject({ change: 'removed', rule: s.rule, settings: s.settings });
        expect(allowList(s.settings)).not.toContain(s.rule);
        expect(readSkillLoadingLedger()).toEqual([]);
      });
    });
  }

  test('a rule the user had before gbrain is never taken out', async () => {
    const b = box();
    await withEnv(b.env, async () => {
      const s = setup(b);
      mkdirSync(dirname(s.settings), { recursive: true });
      writeFileSync(s.settings, JSON.stringify({ permissions: { allow: [s.rule] } }));
      expect(s.spring(s.user).permission).toBeUndefined();
      expect(readSkillLoadingLedger()[0]).toMatchObject({ allow_rule: s.rule, allow_owned: false });
      expect(s.remove(s.user).permission).toBeUndefined();
      expect(allowList(s.settings)).toEqual([s.rule]);
    });
  });

  test('a rule the user had before gbrain and then deleted is not added back by a remembered choice', async () => {
    const b = box();
    await withEnv(b.env, async () => {
      const s = setup(b);
      mkdirSync(dirname(s.settings), { recursive: true });
      writeFileSync(s.settings, JSON.stringify({ permissions: { allow: [s.rule] } }));
      s.spring(s.user);
      writeFileSync(s.settings, JSON.stringify({ permissions: { allow: [] } }));
      expect(s.spring(s.user, {}).detail).toContain('--skill-loading spring');
      expect(allowList(s.settings)).toEqual([]);
      expect(readSkillLoadingLedger()[0]).toMatchObject({ allow_owned: false, allow_declined: true });
    });
  });

  test('a rule the user removed is not added back by a remembered choice, only by an explicit --skill-loading spring', async () => {
    const b = box();
    await withEnv(b.env, async () => {
      const s = setup(b);
      s.spring(s.user);
      writeFileSync(s.settings, JSON.stringify({ permissions: { allow: [] } }));
      const again = s.spring(s.user, {});
      expect(again).toMatchObject({ action: 'keep', decision: { source: 'prior' } });
      expect(again.detail).toContain('--skill-loading spring');
      expect(allowList(s.settings)).toEqual([]);
      expect(readSkillLoadingLedger()[0]).toMatchObject({ allow_owned: false, allow_declined: true });
      expect(s.spring(s.user, {}).permission).toBeUndefined();
      expect(allowList(s.settings)).toEqual([]);
      expect(s.spring(s.user).permission).toMatchObject({ change: 'added', rule: s.rule });
      expect(allowList(s.settings)).toEqual([s.rule]);
      expect(readSkillLoadingLedger()[0]).toMatchObject({ allow_owned: true });
      expect(readSkillLoadingLedger()[0].allow_declined).toBeUndefined();
    });
  });

  test('a failed grant keeps the recorded ownership, so the rule still comes out after the settings are repaired', async () => {
    const b = box();
    await withEnv(b.env, async () => {
      const s = setup(b);
      s.spring(s.user);
      const good = read(s.settings);
      writeFileSync(s.settings, '{broken');
      const failed = s.spring(s.user);
      expect(failed).toMatchObject({ action: 'preserve', reason: 'permission_update_failed' });
      expect(readSkillLoadingLedger()[0]).toMatchObject({ allow_rule: s.rule, allow_owned: true });
      writeFileSync(s.settings, good);
      expect(s.spring(s.user).action).toBe('keep');
      expect(readSkillLoadingLedger()[0]).toMatchObject({ allow_owned: true });
      expect(s.spring(s.user, { skillLoading: 'off' }).permission).toMatchObject({ change: 'removed', rule: s.rule });
      expect(allowList(s.settings)).not.toContain(s.rule);
    });
  });

  for (const how of ['off', 'remove'] as const) {
    test.skipIf(asRoot)(`a settings write that fails during ${how} is a typed refusal that keeps the index and the record`, async () => {
      const b = box();
      await withEnv(b.env, async () => {
        const s = setup(b);
        s.spring(s.user);
        const dir = dirname(s.settings);
        chmodSync(dir, 0o500);
        try {
          const o = how === 'off' ? s.spring(s.user, { skillLoading: 'off' }) : s.remove(s.user);
          expect(o).toMatchObject({ action: 'preserve', reason: 'permission_update_failed' });
          expect(o.detail).toContain(s.rule);
        } finally {
          chmodSync(dir, 0o755);
        }
        expect(read(s.user.path)).toContain(SKILLS_BLOCK_BEGIN);
        expect(readSkillLoadingLedger()[0]).toMatchObject({ mode: 'spring', allow_owned: true });
        expect(allowList(s.settings)).toContain(s.rule);
      });
    });
  }
});

describe('Claude Code loader rule: refresh, dry-run, ledger failures', () => {
  const allowList = (settings: string): string[] => (existsSync(settings) ? JSON.parse(read(settings)).permissions?.allow ?? [] : []);
  const ctx = (b: ReturnType<typeof box>) => {
    const settings = join(b.home, '.claude', 'settings.json');
    const target = brainFirstTargetAt('claude-code', join(b.home, '.claude', 'CLAUDE.md'));
    const run = (extra: Record<string, unknown> = { skillLoading: 'spring' }) => installerSkillsBlock({ target, launcher: LAUNCHER, writer: 'test', brainFirstDeclined: false, ...extra });
    return { settings, target, run, rule: loaderAllowRule(LAUNCHER) };
  };

  test('--skills-index-only respects a deleted rule; with an explicit --skill-loading spring it adds it back', async () => {
    const b = box();
    await withEnv(b.env, async () => {
      const c = ctx(b);
      c.run();
      writeFileSync(c.settings, JSON.stringify({ permissions: { allow: [] } }));
      expect(refreshSkillsIndexes('claude-code', { dryRun: false })[0].permission).toBeUndefined();
      expect(allowList(c.settings)).toEqual([]);
      const explicit = refreshSkillsIndexes('claude-code', { mode: 'spring', dryRun: false })[0];
      expect(explicit).toMatchObject({ decision: { source: 'flag' }, permission: { change: 'added', rule: c.rule } });
      expect(allowList(c.settings)).toEqual([c.rule]);
    });
  });

  test('--dry-run reports the rule a real run would add or remove, and nothing for a rule another index still uses', async () => {
    const b = box();
    await withEnv(b.env, async () => {
      const c = ctx(b);
      expect(c.run({ skillLoading: 'spring', dryRun: true }).permission).toMatchObject({ change: 'would_add', rule: c.rule, settings: c.settings });
      expect(allowList(c.settings)).toEqual([]);
      c.run();
      expect(c.run({ skillLoading: 'off', dryRun: true }).permission).toMatchObject({ change: 'would_remove', rule: c.rule });
      expect(c.run({ remove: true, dryRun: true }).permission).toMatchObject({ change: 'would_remove', rule: c.rule });
      const project = brainFirstTargetAt('claude-code', join(b.root, 'repo', 'CLAUDE.md'));
      mkdirSync(dirname(project.path), { recursive: true });
      installerSkillsBlock({ target: project, launcher: LAUNCHER, writer: 'test', brainFirstDeclined: false, skillLoading: 'spring' });
      expect(c.run({ skillLoading: 'off', dryRun: true }).permission).toBeUndefined();
      expect(allowList(c.settings)).toEqual([c.rule]);
    });
  });

  test('a ledger row with an invalid field refuses every change instead of being dropped', async () => {
    const b = box();
    await withEnv(b.env, async () => {
      const c = ctx(b);
      c.run();
      const ledger = join(b.home, '.gbrain', 'skill-loading.json');
      const bytes = read(ledger).replace('"mode": "spring"', '"mode": "sprng"');
      writeFileSync(ledger, bytes);
      const off = c.run({ skillLoading: 'off' });
      expect(off).toMatchObject({ action: 'preserve', reason: 'ledger_unreadable' });
      expect(off.detail).toContain('entry 0 has an invalid mode');
      expect(off.detail).toContain(c.rule);
      expect(read(ledger)).toBe(bytes);
      expect(allowList(c.settings)).toEqual([c.rule]);
      expect(read(c.target.path)).toContain(SKILLS_BLOCK_BEGIN);
    });
  });

  test('a ledger written by a newer gbrain says to upgrade', async () => {
    const b = box();
    await withEnv(b.env, async () => {
      mkdirSync(join(b.home, '.gbrain'), { recursive: true });
      writeFileSync(join(b.home, '.gbrain', 'skill-loading.json'), JSON.stringify({ version: 2, entries: [] }));
      expect(ctx(b).run().detail).toContain('newer gbrain');
    });
  });

  test.skipIf(asRoot)('a ledger write that fails undoes the block and the rule, so a retry and opt-out leave nothing behind', async () => {
    const b = box();
    await withEnv(b.env, async () => {
      const c = ctx(b);
      const dir = join(b.home, '.gbrain');
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o500);
      let failed: SkillsBlockOutcome;
      try {
        failed = c.run();
      } finally {
        chmodSync(dir, 0o755);
      }
      expect(failed).toMatchObject({ action: 'preserve', reason: 'write_failed' });
      expect(failed.detail).toContain('undone');
      expect(existsSync(c.target.path)).toBe(false);
      expect(allowList(c.settings)).toEqual([]);
      expect(c.run().permission).toMatchObject({ change: 'added' });
      expect(readSkillLoadingLedger()[0]).toMatchObject({ allow_owned: true, created_file: true });
      expect(c.run({ skillLoading: 'off' }).permission).toMatchObject({ change: 'removed' });
      expect(existsSync(c.target.path)).toBe(false);
      expect(allowList(c.settings)).toEqual([]);
    });
  });

  for (const order of ['owner first', 'declined first'] as const) {
    test(`decline on both indexes, explicit re-grant on one: the rule still comes out with the last removal (${order})`, async () => {
      const b = box();
      await withEnv(b.env, async () => {
        const c = ctx(b);
        const project = brainFirstTargetAt('claude-code', join(b.root, 'repo', 'CLAUDE.md'));
        mkdirSync(dirname(project.path), { recursive: true });
        const runProject = (extra: Record<string, unknown>) => installerSkillsBlock({ target: project, launcher: LAUNCHER, writer: 'test', brainFirstDeclined: false, ...extra });
        c.run();
        runProject({ skillLoading: 'spring' });
        writeFileSync(c.settings, JSON.stringify({ permissions: { allow: [] } }));
        c.run({});
        runProject({});
        expect(readSkillLoadingLedger().every(e => e.allow_declined === true)).toBe(true);
        expect(c.run().permission).toMatchObject({ change: 'added' });
        if (order === 'owner first') { c.run({ remove: true }); runProject({ remove: true }); } else { runProject({ remove: true }); c.run({ remove: true }); }
        expect(readSkillLoadingLedger()).toEqual([]);
        expect(allowList(c.settings)).toEqual([]);
      });
    });
  }

  test.skipIf(asRoot)('a ledger write that fails during a launcher change puts the old rule back, so a plain retry keeps it', async () => {
    const b = box();
    const other = join(b.root, 'other-install', 'gbrain');
    mkdirSync(dirname(other), { recursive: true });
    copyFileSync(LAUNCHER, other);
    chmodSync(other, 0o755);
    await withEnv(b.env, async () => {
      const c = ctx(b);
      c.run();
      const dir = join(b.home, '.gbrain');
      chmodSync(dir, 0o500);
      let failed: SkillsBlockOutcome;
      try {
        failed = installerSkillsBlock({ target: c.target, launcher: other, writer: 'test', brainFirstDeclined: false, skillLoading: 'spring' });
      } finally {
        chmodSync(dir, 0o755);
      }
      expect(failed).toMatchObject({ action: 'preserve', reason: 'write_failed' });
      expect(allowList(c.settings)).toEqual([c.rule]);
      const retry = c.run({});
      expect(retry.action).toBe('keep');
      expect(readSkillLoadingLedger()[0]).toMatchObject({ allow_owned: true });
      expect(readSkillLoadingLedger()[0].allow_declined).toBeUndefined();
    });
  });

  test('a ledger row that claims ownership without its rule is refused', async () => {
    const b = box();
    await withEnv(b.env, async () => {
      const c = ctx(b);
      c.run();
      const ledger = join(b.home, '.gbrain', 'skill-loading.json');
      const doc = JSON.parse(read(ledger));
      delete doc.entries[0].allow_rule;
      writeFileSync(ledger, JSON.stringify(doc));
      expect(c.run({ skillLoading: 'off' })).toMatchObject({ action: 'preserve', reason: 'ledger_unreadable' });
      expect(allowList(c.settings)).toEqual([c.rule]);
    });
  });

  test('dry-run previews are complete: human lines name the rule, a batch opt-out removes a shared rule once, a launcher change shows both rules', async () => {
    const b = box();
    const other = join(b.root, 'other-install', 'gbrain');
    mkdirSync(dirname(other), { recursive: true });
    copyFileSync(LAUNCHER, other);
    chmodSync(other, 0o755);
    await withEnv(b.env, async () => {
      const c = ctx(b);
      const preview = c.run({ skillLoading: 'spring', dryRun: true });
      expect(describeSkillsBlockOutcome(preview, true)).toContain(`would add Claude Code permission ${c.rule} in ${c.settings}`);
      c.run();
      const project = brainFirstTargetAt('claude-code', join(b.root, 'repo', 'CLAUDE.md'));
      mkdirSync(dirname(project.path), { recursive: true });
      installerSkillsBlock({ target: project, launcher: LAUNCHER, writer: 'test', brainFirstDeclined: false, skillLoading: 'spring' });
      const batch = refreshSkillsIndexes('claude-code', { mode: 'off', dryRun: true });
      expect(batch.filter(o => o.permission?.change === 'would_remove')).toHaveLength(1);
      expect(allowList(c.settings)).toEqual([c.rule]);
      const swap = refreshSkillsIndexes('claude-code', { launcher: other, dryRun: true });
      expect(swap.some(o => o.permission?.change === 'would_add' && o.permission.rule === loaderAllowRule(other))).toBe(true);
      expect(swap.filter(o => o.replaced_permission?.change === 'would_remove')).toHaveLength(1);
    });
  });

  test('another gbrain home\'s index is left alone by a default run here', async () => {
    const b = box();
    await withEnv(b.env, async () => {
      const c = ctx(b);
      c.run();
      const written = read(c.target.path);
      await withEnv({ GBRAIN_HOME: join(b.root, 'second-home') }, async () => {
        expect(c.run({})).toMatchObject({ action: 'skip', decision: { source: 'default' } });
      });
      expect(read(c.target.path)).toBe(written);
      expect(allowList(c.settings)).toEqual([c.rule]);
    });
  });

  test('a rule the user adds back by hand clears the decline; a missing settings file is not a decline', async () => {
    const b = box();
    await withEnv(b.env, async () => {
      const c = ctx(b);
      c.run();
      writeFileSync(c.settings, JSON.stringify({ permissions: { allow: [] } }));
      c.run({});
      expect(readSkillLoadingLedger()[0].allow_declined).toBe(true);
      writeFileSync(c.settings, JSON.stringify({ permissions: { allow: [c.rule] } }));
      expect(c.run({}).detail).not.toContain('will ask');
      expect(readSkillLoadingLedger()[0].allow_declined).toBeUndefined();
      rmSync(c.settings);
      expect(c.run({}).detail).not.toContain('will ask');
      expect(readSkillLoadingLedger()[0].allow_declined).toBeUndefined();
    });
  });

  test('an instruction path gbrain cannot read is a refusal, never a throw', async () => {
    const b = box();
    await withEnv(b.env, async () => {
      const dir = join(b.home, 'agents', 'AGENTS.md');
      mkdirSync(dir, { recursive: true });
      const o = installerSkillsBlock({ target: brainFirstTargetAt('opencode', dir), launcher: LAUNCHER, writer: 'test', brainFirstDeclined: false, skillLoading: 'spring' });
      expect(o.action).toBe('preserve');
    });
  });

  test('an explicit spring skipped for a reason the user must fix counts as failed; a remembered one does not', () => {
    const base = { harness: 'hermes', path: '/home/alice-example/.hermes/SOUL.md', action: 'skip', state_before: 'no_file', detail: 'x', reason: 'hermes_soul_missing' } as const;
    expect(skillsOutcomeFailed({ ...base, decision: { value: 'spring', source: 'flag' } })).toBe(true);
    expect(skillsOutcomeFailed({ ...base, decision: { value: 'spring', source: 'env' } })).toBe(true);
    expect(skillsOutcomeFailed({ ...base, decision: { value: 'spring', source: 'prior' } })).toBe(false);
    expect(skillsOutcomeFailed({ ...base, reason: undefined, decision: { value: 'off', source: 'default' } })).toBe(false);
  });
});

describe('refusals keep everything as it was', () => {
  test('an invalid GBRAIN_SKILL_LOADING is refused with the allowed values, before any write', async () => {
    const b = box();
    const target = brainFirstTargetAt('opencode', join(b.home, 'agents', 'AGENTS.md'));
    await withEnv({ ...b.env, GBRAIN_SKILL_LOADING: 'lazy' }, async () => {
      const o = installerSkillsBlock({ target, launcher: LAUNCHER, writer: 'test', brainFirstDeclined: false });
      expect(o).toMatchObject({ action: 'preserve', reason: 'invalid_env' });
      expect(o.detail).toContain('off or spring');
      expect(existsSync(target.path)).toBe(false);
    });
  });

  test('an unreadable ledger is never treated as no record', async () => {
    const b = box();
    const file = join(b.home, 'agents', 'AGENTS.md');
    const target = brainFirstTargetAt('opencode', file);
    await withEnv(b.env, async () => {
      installerSkillsBlock({ target, launcher: LAUNCHER, writer: 'test', brainFirstDeclined: false, skillLoading: 'spring' });
      const written = read(file);
      writeFileSync(join(b.home, '.gbrain', 'skill-loading.json'), '{not json');
      const off = installerSkillsBlock({ target, launcher: LAUNCHER, writer: 'test', brainFirstDeclined: false, skillLoading: 'off' });
      expect(off).toMatchObject({ action: 'preserve', reason: 'ledger_unreadable' });
      expect(read(file)).toBe(written);
      expect(read(join(b.home, '.gbrain', 'skill-loading.json'))).toBe('{not json');
    });
  });

  test('Claude Code: a permission rule gbrain added but cannot remove fails the opt-out and keeps the record', async () => {
    const b = box();
    const file = join(b.home, '.claude', 'CLAUDE.md');
    const settings = join(b.home, '.claude', 'settings.json');
    const target = brainFirstTargetAt('claude-code', file);
    await withEnv(b.env, async () => {
      const on = installerSkillsBlock({ target, launcher: LAUNCHER, writer: 'test', brainFirstDeclined: false, skillLoading: 'spring' });
      expect(on.permission).toMatchObject({ change: 'added', rule: loaderAllowRule(LAUNCHER) });
      writeFileSync(settings, '{broken');
      const off = installerSkillsBlock({ target, launcher: LAUNCHER, writer: 'test', brainFirstDeclined: false, skillLoading: 'off' });
      expect(off).toMatchObject({ action: 'preserve', reason: 'permission_update_failed' });
      expect(off.detail).toContain(loaderAllowRule(LAUNCHER));
      expect(read(file)).toContain(SKILLS_BLOCK_BEGIN);
      expect(readSkillLoadingLedger()[0]).toMatchObject({ mode: 'spring', allow_owned: true });
    });
  });
});
