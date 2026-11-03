/**
 * GBRA-194: `--skill-loading spring` writes the spring-loaded skill index
 * (src/core/setup/skills-block.ts) beside the brain-first block in each
 * writable harness's instruction file; `off` (the default) writes nothing.
 * Per harness this pins:
 *  - placement: the index lands right after the brain-first block, text
 *    outside both blocks is byte-identical;
 *  - default off: a plain install writes no index;
 *  - idempotence and remembered choice: a re-run without the flag keeps the
 *    recorded mode; `off` strips the index and is remembered;
 *  - --no-instructions strips both blocks; --remove strips both and deletes a
 *    file only gbrain created once nothing else is in it, in either order;
 *  - Hermes: SOUL.md is never created;
 *  - dry-run writes nothing; GBRAIN_SKILL_LOADING selects the mode; a bad
 *    value is refused.
 * Spawns `bun src/cli.ts setup` against a temp HOME / GBRAIN_HOME.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv } from './helpers/with-env.ts';
import { BRAIN_FIRST_BEGIN, BRAIN_FIRST_END } from '../src/core/setup/brain-first.ts';
import { inspectSkillsBlock, loaderAllowRule, renderSkillsBlock, SKILLS_BLOCK_BEGIN, SKILLS_BLOCK_END } from '../src/core/setup/skills-block.ts';
import { bundledCatalogId, bundledSkills } from '../src/core/skills/bundled.ts';

// Each test spawns setup several times, and each spawn asks the launcher for its catalog; 5 s is too tight on a loaded shard.
setDefaultTimeout(30_000);
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const BIN_DIR = mkdtempSync(join(tmpdir(), 'gbrain-skill-bin-'));
const LAUNCHER = join(BIN_DIR, 'gbrain');
writeFileSync(LAUNCHER, `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${CLI}' "$@"\n`);
chmodSync(LAUNCHER, 0o755);
/** A gbrain that serves another skill catalog (a different install on PATH, a stale --gbrain-bin). */
const OTHER = join(BIN_DIR, 'gbrain-other');
writeFileSync(OTHER, '#!/bin/sh\necho \'{"schema_version":1,"catalog":"000000000000","skills":[]}\'\n');
chmodSync(OTHER, 0o755);
const roots: string[] = [];
afterAll(() => { for (const r of [...roots, BIN_DIR]) rmSync(r, { recursive: true, force: true }); });

interface Box { home: string; project: string; env: Record<string, string | undefined> }
function box(): Box {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-skill-loading-'));
  roots.push(root);
  const home = join(root, 'home'), project = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  return { home, project, env: {
    HOME: home, GBRAIN_HOME: home, CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, XDG_CONFIG_HOME: undefined,
    OPENCLAW_STATE_DIR: undefined, OPENCLAW_WORKSPACE_DIR: undefined, OPENCLAW_PROFILE: undefined, HERMES_HOME: undefined,
    GBRAIN_AGENT_INSTRUCTIONS: undefined, GBRAIN_SURFACE: undefined, GBRAIN_SKILL_LOADING: undefined,
  } };
}
async function setup(b: Box, args: string[], env: Record<string, string | undefined> = {}) {
  const r = await runCli(['setup', ...args, '--json'], { env: { ...b.env, ...env }, cwd: b.project });
  let doc: any = null;
  try { doc = JSON.parse(r.stdout); } catch { doc = null; }
  return { ...r, doc };
}
const read = (p: string) => readFileSync(p, 'utf8');
const count = (text: string, line: string) => text.split('\n').filter((l) => l === line).length;
const outside = (text: string) => text
  .replace(new RegExp(`${BRAIN_FIRST_BEGIN}[\\s\\S]*?${BRAIN_FIRST_END}\\n`), '')
  .replace(new RegExp(`${SKILLS_BLOCK_BEGIN}[\\s\\S]*?${SKILLS_BLOCK_END}\\n`), '');

interface Lane { harness: string; file: (b: Box) => string; existing: string; refusesCreate?: boolean }
const LANES: Lane[] = [
  { harness: 'claude-code', file: (b) => join(b.home, '.claude', 'CLAUDE.md'), existing: '# My rules\n\nAlways answer in French.\n' },
  { harness: 'codex', file: (b) => join(b.home, '.codex', 'AGENTS.md'), existing: '# Codex house rules\n- run the tests\n' },
  { harness: 'opencode', file: (b) => join(b.home, '.config', 'opencode', 'AGENTS.md'), existing: 'Prefer small diffs.\n' },
  { harness: 'openclaw', file: (b) => join(b.home, '.openclaw', 'workspace', 'AGENTS.md'), existing: '# AGENTS.md\n\n## Tools\nUse the calendar skill.\n' },
  { harness: 'hermes', file: (b) => join(b.home, '.hermes', 'SOUL.md'), existing: 'You are Hermes, a careful assistant named alice-example.\n', refusesCreate: true },
  { harness: 'cursor', file: (b) => join(b.project, '.cursor', 'rules', 'gbrain-brain-first.mdc'), existing: '---\ndescription: team rule\nalwaysApply: true\n---\nUse tabs.\n' },
];

for (const lane of LANES) {
  describe(`skill loading: ${lane.harness}`, () => {
    const run = (b: Box, extra: string[] = [], env: Record<string, string | undefined> = {}) => setup(b, [lane.harness, '--instructions-only', '--gbrain-bin', LAUNCHER, ...extra], env);
    const seed = (b: Box) => { mkdirSync(dirname(lane.file(b)), { recursive: true }); writeFileSync(lane.file(b), lane.existing); };

    test('default off writes no index; spring places it right after brain-first and keeps outside text', async () => {
      const b = box(); seed(b);
      const plain = await run(b);
      expect(plain.exitCode).toBe(0);
      expect(read(lane.file(b))).not.toContain(SKILLS_BLOCK_BEGIN);
      expect(plain.doc.skills.decision).toEqual({ value: 'off', source: 'default' });
      expect(existsSync(join(b.home, '.gbrain', 'skill-loading.json'))).toBe(false);

      const r = await run(b, ['--skill-loading', 'spring']);
      expect(r.exitCode).toBe(0);
      expect(r.doc.skills.action).toBe('write');
      const text = read(lane.file(b));
      expect(count(text, SKILLS_BLOCK_BEGIN)).toBe(1);
      const lines = text.split('\n');
      expect(lines.indexOf(SKILLS_BLOCK_BEGIN)).toBe(lines.indexOf(BRAIN_FIRST_END) + 1);
      expect(text).toContain(renderSkillsBlock(lane.harness, LAUNCHER));
      expect(outside(text)).toBe(lane.existing);
    });

    test('the choice is remembered; off strips and is remembered; a re-run is byte-identical', async () => {
      const b = box(); seed(b);
      await run(b, ['--skill-loading', 'spring']);
      const once = read(lane.file(b));
      const again = await run(b);
      expect(again.doc.skills).toMatchObject({ action: 'keep', decision: { value: 'spring', source: 'prior' } });
      expect(read(lane.file(b))).toBe(once);
      const off = await run(b, ['--skill-loading', 'off']);
      expect(off.doc.skills.action).toBe('remove');
      expect(read(lane.file(b))).not.toContain(SKILLS_BLOCK_BEGIN);
      expect(read(lane.file(b))).toContain(BRAIN_FIRST_BEGIN);
      expect((await run(b)).doc.skills.decision).toEqual({ value: 'off', source: 'prior' });
      expect(read(lane.file(b))).not.toContain(SKILLS_BLOCK_BEGIN);
    });

    test('--no-instructions strips both blocks; --dry-run writes nothing', async () => {
      const b = box(); seed(b);
      const dry = await run(b, ['--skill-loading', 'spring', '--dry-run']);
      expect(dry.exitCode).toBe(0);
      expect(read(lane.file(b))).toBe(lane.existing);
      expect(existsSync(join(b.home, '.gbrain', 'skill-loading.json'))).toBe(false);
      await run(b, ['--skill-loading', 'spring']);
      const r = await run(b, ['--no-instructions']);
      expect(r.doc.skills).toMatchObject({ action: 'remove', decision: { value: 'off', source: 'instructions_off' } });
      expect(read(lane.file(b))).toBe(lane.existing);
    });

    test(lane.refusesCreate ? 'a missing SOUL.md is never created' : 'a file gbrain created goes away only when both blocks are removed, in either order', async () => {
      const b = box();
      const r = await run(b, ['--skill-loading', 'spring']);
      if (lane.refusesCreate) {
        expect(existsSync(lane.file(b))).toBe(false);
        expect(r.doc.skills.action).toBe('skip');
        return;
      }
      expect(read(lane.file(b))).toContain(SKILLS_BLOCK_BEGIN);
      await run(b, ['--skill-loading', 'off']);
      expect(existsSync(lane.file(b))).toBe(true);
      await run(b, ['--skill-loading', 'spring']);
      const removed = await run(b, ['--remove']);
      expect(removed.exitCode).toBe(0);
      expect(existsSync(lane.file(b))).toBe(false);

      const c = box();
      await run(c, ['--skill-loading', 'spring']);
      await run(c, ['--no-instructions']);
      expect(existsSync(lane.file(c))).toBe(false);
    });
  });
}

describe('skill loading: selection', () => {
  test('GBRAIN_SKILL_LOADING=spring selects it; the flag wins over the env', async () => {
    const b = box();
    const r = await setup(b, ['claude-code', '--instructions-only'], { GBRAIN_SKILL_LOADING: 'spring' });
    expect(r.doc.skills.decision).toEqual({ value: 'spring', source: 'env' });
    const off = await setup(b, ['claude-code', '--instructions-only', '--skill-loading', 'off'], { GBRAIN_SKILL_LOADING: 'spring' });
    expect(off.doc.skills.decision).toEqual({ value: 'off', source: 'flag' });
  });

  test('an unknown --skill-loading value is refused before anything is written', async () => {
    const b = box();
    const r = await setup(b, ['claude-code', '--instructions-only', '--skill-loading', 'lazy']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('--skill-loading');
    expect(existsSync(join(b.home, '.claude', 'CLAUDE.md'))).toBe(false);
  });

  test('the index names the absolute launcher the install recorded, whatever the MCP surface', async () => {
    const b = box();
    const r = await setup(b, ['claude-code', '--instructions-only', '--gbrain-bin', LAUNCHER, '--skill-loading', 'spring', '--surface', 'verbs']);
    expect(r.exitCode).toBe(0);
    const text = read(join(b.home, '.claude', 'CLAUDE.md'));
    expect(text).toContain('`' + LAUNCHER + ' bundled-skill <name>`');
    expect(text).not.toContain('get_skill');
    const ledger = JSON.parse(read(join(b.home, '.gbrain', 'skill-loading.json')));
    expect(ledger.entries[0]).toMatchObject({ harness: 'claude-code', mode: 'spring', launcher: LAUNCHER, audience: 'owner', catalog: bundledCatalogId() });
  });

  test('on a thin-client install the index lists only the skills the loader serves there', async () => {
    const b = box();
    mkdirSync(join(b.home, '.gbrain'), { recursive: true });
    writeFileSync(join(b.home, '.gbrain', 'config.json'), JSON.stringify({ remote_mcp: { mcp_url: 'https://brain.example.test/mcp' } }));
    const r = await setup(b, ['codex', '--instructions-only', '--gbrain-bin', LAUNCHER, '--skill-loading', 'spring']);
    expect(r.exitCode).toBe(0);
    const text = read(join(b.home, '.codex', 'AGENTS.md'));
    const hostOnly = bundledSkills('owner').filter((s) => s.audience === 'owner');
    expect(hostOnly.length).toBeGreaterThan(0);
    for (const s of hostOnly) expect(text).not.toContain('- ' + s.name + ':');
    for (const s of bundledSkills('downstream')) expect(text).toContain('- ' + s.name + ':');
    const ledger = JSON.parse(read(join(b.home, '.gbrain', 'skill-loading.json')));
    expect(ledger.entries[0]).toMatchObject({ harness: 'codex', mode: 'spring', audience: 'downstream' });
  });

  test('an index an upgrade left behind (older catalog) is reported stale and a bare re-run refreshes it', async () => {
    const b = box();
    const file = join(b.home, '.claude', 'CLAUDE.md');
    await setup(b, ['claude-code', '--instructions-only', '--gbrain-bin', LAUNCHER, '--skill-loading', 'spring']);
    const current = read(file);
    const older = current.replace('catalog ' + bundledCatalogId(), 'catalog 000000000000').replace(/^- brain-ops:.*$/m, '- brain-ops: an older trigger');
    expect(older).not.toBe(current);
    writeFileSync(file, older);
    expect(inspectSkillsBlock(file).state).toBe('stale');
    const r = await setup(b, ['claude-code', '--instructions-only', '--gbrain-bin', LAUNCHER]);
    expect(r.doc.skills).toMatchObject({ action: 'write', state_before: 'stale', decision: { value: 'spring', source: 'prior' } });
    expect(read(file)).toBe(current);
    expect(inspectSkillsBlock(file).state).toBe('current');
  });
});

describe('skill loading: launcher, permission and refresh', () => {
  test('an index is never written naming a gbrain that serves another catalog, or a bare name', async () => {
    const b = box();
    const other = await setup(b, ['claude-code', '--instructions-only', '--gbrain-bin', OTHER, '--skill-loading', 'spring']);
    expect(other.exitCode).toBe(1);
    expect(other.doc.skills.action).toBe('preserve');
    expect(other.doc.skills.detail).toContain('000000000000');
    expect(read(join(b.home, '.claude', 'CLAUDE.md'))).not.toContain(SKILLS_BLOCK_BEGIN);
    const bare = await setup(b, ['claude-code', '--instructions-only', '--gbrain-bin', 'gbrain', '--skill-loading', 'spring']);
    expect(bare.exitCode).toBe(1);
    expect(bare.doc.skills.detail).toContain('not an absolute path');
  });

  test('Claude Code: spring adds one narrow allow rule for the loader; off removes it; a rule the user had stays', async () => {
    const b = box();
    const settings = join(b.home, '.claude', 'settings.json');
    const rule = loaderAllowRule(LAUNCHER);
    await setup(b, ['claude-code', '--instructions-only', '--gbrain-bin', LAUNCHER, '--skill-loading', 'spring']);
    expect(JSON.parse(read(settings)).permissions.allow).toEqual([rule]);
    await setup(b, ['claude-code', '--instructions-only', '--gbrain-bin', LAUNCHER, '--skill-loading', 'off']);
    expect(JSON.parse(read(settings)).permissions?.allow ?? []).not.toContain(rule);

    const c = box();
    const cSettings = join(c.home, '.claude', 'settings.json');
    mkdirSync(dirname(cSettings), { recursive: true });
    writeFileSync(cSettings, JSON.stringify({ permissions: { allow: [rule, 'Read'] } }));
    await setup(c, ['claude-code', '--instructions-only', '--gbrain-bin', LAUNCHER, '--skill-loading', 'spring']);
    await setup(c, ['claude-code', '--instructions-only', '--gbrain-bin', LAUNCHER, '--remove']);
    expect(JSON.parse(read(cSettings)).permissions.allow).toEqual([rule, 'Read']);
  });

  test('an index is never written naming a gbrain that serves fewer skills than it lists (a thin-client launcher)', async () => {
    const b = box();
    const thin = join(BIN_DIR, 'gbrain-thin');
    writeFileSync(thin, `#!/bin/sh\necho '${JSON.stringify({ schema_version: 1, catalog: bundledCatalogId(), skills: bundledSkills('downstream').map((s) => ({ name: s.name })) })}'\n`);
    chmodSync(thin, 0o755);
    const r = await setup(b, ['claude-code', '--instructions-only', '--gbrain-bin', thin, '--skill-loading', 'spring']);
    expect(r.exitCode).toBe(1);
    expect(r.doc.skills).toMatchObject({ action: 'preserve', reason: 'launcher_catalog_mismatch' });
    expect(read(join(b.home, '.claude', 'CLAUDE.md'))).not.toContain(SKILLS_BLOCK_BEGIN);
  });

  test('--skills-index-only keeps the loader rule in the Claude profile the install recorded', async () => {
    const b = box();
    const profileA = join(b.home, 'profile-a'), profileB = join(b.home, 'profile-b');
    const rule = loaderAllowRule(LAUNCHER);
    await setup(b, ['claude-code', '--instructions-only', '--gbrain-bin', LAUNCHER, '--skill-loading', 'spring'], { CLAUDE_CONFIG_DIR: profileA });
    expect(JSON.parse(read(join(profileA, 'settings.json'))).permissions.allow).toEqual([rule]);
    const r = await setup(b, ['claude-code', '--skills-index-only'], { CLAUDE_CONFIG_DIR: profileB });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(read(join(profileA, 'settings.json'))).permissions.allow).toEqual([rule]);
    expect(existsSync(join(profileB, 'settings.json')) ? JSON.parse(read(join(profileB, 'settings.json'))).permissions?.allow ?? [] : []).not.toContain(rule);
  });

  test('codex gets no permission edit (its sandbox runs the read-only loader)', async () => {
    const b = box();
    await setup(b, ['codex', '--instructions-only', '--gbrain-bin', LAUNCHER, '--skill-loading', 'spring']);
    expect(existsSync(join(b.home, '.claude', 'settings.json'))).toBe(false);
  });

  test('--skills-index-only refreshes only the skills block, keeping the recorded file, launcher, audience and the brain-first block', async () => {
    const b = box();
    const file = join(b.home, '.codex', 'AGENTS.md');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '# house rules\n');
    const team = await withEnv(b.env, async () => {
      const { installerBrainFirst, brainFirstTargetAt } = await import('../src/core/setup/brain-first.ts');
      const { installerSkillsBlock } = await import('../src/core/setup/skills-block.ts');
      const target = brainFirstTargetAt('codex', file);
      installerBrainFirst({ target, access: { kind: 'mcp', server: 'team-a' }, writer: 'gbrain connect --agent codex --install' });
      return installerSkillsBlock({ target, launcher: LAUNCHER, writer: 'gbrain connect --agent codex --install', brainFirstDeclined: false, skillLoading: 'spring', audience: 'downstream' });
    });
    expect(team.action).toBe('write');
    const written = read(file);
    const stale = written.replace(/catalog [0-9a-f]{12}/, 'catalog 000000000000');
    writeFileSync(file, stale);
    const r = await setup(b, ['codex', '--skills-index-only']);
    expect(r.exitCode).toBe(0);
    expect(r.doc.skills).toHaveLength(1);
    expect(r.doc.skills[0]).toMatchObject({ action: 'write', state_before: 'stale' });
    expect(read(file)).toBe(written);
    expect(read(file)).toContain('team-a');
    const off = await setup(b, ['codex', '--skills-index-only', '--skill-loading', 'off']);
    expect(off.doc.skills[0].action).toBe('remove');
    expect(read(file)).not.toContain(SKILLS_BLOCK_BEGIN);
    expect(read(file)).toContain('team-a');
    const none = await setup(box(), ['codex', '--skills-index-only']);
    expect(none.exitCode).toBe(0);
    expect(none.doc.skills).toEqual([]);
  });
});

describe('skill loading: the Codex AGENTS.md / AGENTS.override.md pair (#8485)', () => {
  const codex = (b: Box, extra: string[], env: Record<string, string | undefined> = {}) => setup(b, ['codex', '--instructions-only', '--gbrain-bin', LAUNCHER, ...extra], env);
  const ledgerMode = (b: Box, path: string) => (JSON.parse(read(join(b.home, '.gbrain', 'skill-loading.json'))).entries as { path: string; mode: string }[]).find((e) => e.path === path)?.mode;

  test('an opt-out after AGENTS.override.md took over also strips the index from AGENTS.md, previewed in --dry-run; nothing else is touched', async () => {
    const b = box();
    const agents = join(b.home, '.codex', 'AGENTS.md');
    const override = join(b.home, '.codex', 'AGENTS.override.md');
    const otherHome = join(b.home, '.codex-b');
    expect((await codex(b, ['--skill-loading', 'spring'], { CODEX_HOME: otherHome })).doc.skills.action).toBe('write');
    expect((await codex(b, ['--skill-loading', 'spring'])).doc.skills.action).toBe('write');
    writeFileSync(override, '# Override rules\n');

    const plain = await codex(b, []);
    expect(plain.doc.skills.paired).toBeUndefined();
    expect(inspectSkillsBlock(agents).state).toBe('current');

    const before = read(agents);
    const dry = await codex(b, ['--skill-loading', 'off', '--dry-run']);
    expect(dry.doc.skills.path).toBe(override);
    expect(dry.doc.skills.paired).toMatchObject({ path: agents, action: 'remove' });
    expect(read(agents)).toBe(before);
    expect(ledgerMode(b, agents)).toBe('spring');

    const off = await codex(b, ['--skill-loading', 'off']);
    expect(off.exitCode).toBe(0);
    expect(off.doc.skills.paired).toMatchObject({ path: agents, action: 'remove' });
    expect(inspectSkillsBlock(agents).state).toBe('absent');
    expect(count(read(agents), BRAIN_FIRST_BEGIN)).toBe(1);
    expect(ledgerMode(b, agents)).toBe('off');

    rmSync(override);
    expect((await codex(b, [])).doc.skills.decision).toEqual({ value: 'off', source: 'prior' });
    expect(inspectSkillsBlock(agents).state).toBe('absent');
    expect(inspectSkillsBlock(join(otherHome, 'AGENTS.md')).state).toBe('current');
  });

  test('the plain-text setup output names the paired removal', async () => {
    const b = box();
    const agents = join(b.home, '.codex', 'AGENTS.md');
    await codex(b, ['--skill-loading', 'spring']);
    writeFileSync(join(b.home, '.codex', 'AGENTS.override.md'), '# Override rules\n');
    const r = await runCli(['setup', 'codex', '--instructions-only', '--gbrain-bin', LAUNCHER, '--skill-loading', 'off'], { env: b.env, cwd: b.project });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`skills index from ${agents}`);
  });

  test('--no-instructions after the override took over also strips the index from AGENTS.md', async () => {
    const b = box();
    const agents = join(b.home, '.codex', 'AGENTS.md');
    await codex(b, ['--skill-loading', 'spring']);
    writeFileSync(join(b.home, '.codex', 'AGENTS.override.md'), '# Override rules\n');
    const r = await codex(b, ['--no-instructions']);
    expect(r.doc.skills.paired).toMatchObject({ path: agents, action: 'remove', decision: { value: 'off', source: 'instructions_off' } });
    expect(existsSync(agents)).toBe(false);
  });
});
