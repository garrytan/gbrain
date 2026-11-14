/**
 * GBRA-377 PR B: `gbrain setup <claude-code|codex> --skill-loading resolve`
 * (src/core/setup/skill-resolver-setup.ts) and the skills.resolver.* config
 * keys (src/core/setup/skill-resolver-config.ts).
 *
 * Protects: setup builds the user catalog and writes the keys and the hook
 * only after a build with at least one skill (else
 * skill_resolver_setup_incomplete and nothing written); it is idempotent;
 * --dry-run lists every write and writes nothing; --skill-loading off and
 * setup --remove undo every write; nothing new lands in the hook-launcher
 * directory; a plain setup writes no catalog and no key; an unreadable config
 * refuses with skill_resolver_config_unreadable; a brainless install stays
 * brainless (no engine inferred from the file) and a later init, a thin client
 * and removal keep the keys' engine boundary; doctor stays silent until the
 * resolver is configured, and warns on an install that predates the
 * SessionStart compaction entry; a hand-edited per_harness entry that is not
 * an object reads as unset and is replaced on set or unset.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv } from './helpers/with-env.ts';
import { loadConfig } from '../src/core/config.ts';
import { SKILL_RESOLVER_MARKER } from '../src/core/setup/skill-resolver-lane.ts';
import { laneTurnSettings } from '../src/core/skills/resolver/config.ts';

setDefaultTimeout(60_000);
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

interface Box { root: string; home: string; project: string; bin: string; env: Record<string, string | undefined> }
function box(): Box {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-skill-resolver-setup-'));
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
    GBRAIN_SKILL_LOADING: undefined, GBRAIN_HOOK_LANE: undefined, GBRAIN_AGENT_INSTRUCTIONS: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
  } };
}
function skill(dir: string, name: string, description: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nSteps.\n`);
}
const HARNESS = {
  'claude-code': { skills: (b: Box) => join(b.home, '.claude', 'skills'), hookFile: (b: Box) => join(b.home, '.claude', 'settings.json') },
  'codex': { skills: (b: Box) => join(b.home, '.agents', 'skills'), hookFile: (b: Box) => join(b.home, '.codex', 'hooks.json') },
} as const;
type H = keyof typeof HARNESS;

async function setup(b: Box, harness: string, extra: string[]) {
  const r = await runCli(['setup', harness, '--instructions-only', '--gbrain-bin', b.bin, ...extra], { env: b.env, cwd: b.project });
  let doc: any = null;
  try { doc = JSON.parse(r.stdout); } catch { doc = null; }
  return { ...r, doc };
}
const gb = (b: Box) => join(b.home, '.gbrain');
const configPath = (b: Box) => join(gb(b), 'config.json');
const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const catalogs = (b: Box) => (existsSync(join(gb(b), 'skill-index')) ? readdirSync(join(gb(b), 'skill-index')).filter((n) => !n.startsWith('.') && n !== 'logs' && n !== 'sessions') : []);
/** Every file under the box (relative path -> content), for before/after comparisons. */
function tree(dir: string, base = dir, out: Record<string, string> = {}): Record<string, string> {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) tree(p, base, out); else out[p.slice(base.length + 1)] = readFileSync(p, 'utf8');
  }
  return out;
}

for (const harness of ['claude-code', 'codex'] as H[]) {
  describe(`setup ${harness} --skill-loading resolve`, () => {
    test('no skill directory: refuses with skill_resolver_setup_incomplete, names the scanned dirs, writes nothing of the resolver', async () => {
      const b = box();
      const r = await setup(b, harness, ['--skill-loading', 'resolve', '--json']);
      expect(r.exitCode).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toContain('skill_resolver_setup_incomplete');
      expect(`${r.stdout}${r.stderr}`).toContain(HARNESS[harness].skills(b));
      expect(read(configPath(b))).toBeNull();
      expect(catalogs(b)).toEqual([]);
      expect(read(HARNESS[harness].hookFile(b)) ?? '').not.toContain('GBRAIN_HOOK_LANE=skill-resolver');
    });

    test('an empty skill directory: refuses and leaves no catalog behind', async () => {
      const b = box();
      mkdirSync(HARNESS[harness].skills(b), { recursive: true });
      const r = await setup(b, harness, ['--skill-loading', 'resolve', '--json']);
      expect(`${r.stdout}${r.stderr}`).toContain('skill_resolver_setup_incomplete');
      expect(read(configPath(b))).toBeNull();
      expect(catalogs(b)).toEqual([]);
    });

    test('on, idempotent, dry-run lists every write, then off and --remove undo all of it', async () => {
      const b = box();
      skill(HARNESS[harness].skills(b), 'deploy-widget', 'Deploy the widget service.');
      const plain = await setup(b, harness, []);
      expect(plain.exitCode).toBe(0);
      const before = { ...tree(b.home) };
      expect(catalogs(b)).toEqual([]);
      expect(read(configPath(b))).toBeNull();

      const dry = await setup(b, harness, ['--skill-loading', 'resolve', '--dry-run']);
      expect(dry.exitCode).toBe(0);
      for (const step of ['resolver catalog:', 'resolver config:', 'resolver hook:']) expect(dry.stdout).toContain(`would write resolver ${step.split(' ')[1]}`);
      expect(tree(b.home)).toEqual(before);

      const on = await setup(b, harness, ['--skill-loading', 'resolve']);
      expect(on.exitCode, on.stderr).toBe(0);
      expect(on.stdout).toContain('<relevant_skills>');
      expect(on.stdout).toMatch(/skill resolver: on; 1 skills; fresh/);
      expect(JSON.parse(read(configPath(b))!)).toEqual({ skills: { resolver: { enabled: true, harnesses: [harness] } } });
      expect(catalogs(b)).toEqual([`${harness}-user`]);
      const hooks = read(HARNESS[harness].hookFile(b))!;
      expect(hooks.split('GBRAIN_HOOK_LANE=skill-resolver').length - 1).toBe(2);
      if (harness === 'claude-code') expect(hooks).toContain(SKILL_RESOLVER_MARKER);
      else expect(read(join(b.home, '.codex', 'config.toml'))).toContain('skill-resolver');
      const launcherDir = join(gb(b), 'hook-launcher');
      const launcherFiles = readdirSync(launcherDir).sort();

      const resolverFiles = () => Object.fromEntries([configPath(b), HARNESS[harness].hookFile(b), join(b.home, '.codex', 'config.toml'), join(gb(b), 'skill-index', `${harness}-user`, 'receipt.json')].map((p) => [p, read(p)]));
      const onFiles = resolverFiles();
      const again = await setup(b, harness, ['--skill-loading', 'resolve', '--json']);
      expect(again.exitCode).toBe(0);
      expect(again.doc.skill_resolver.steps.map((s: any) => s.action)).toEqual(['keep', 'keep', 'keep']);
      const refresh = await setup(b, harness, ['--json']);
      expect(refresh.exitCode).toBe(0);
      expect(refresh.doc.skill_resolver.steps.every((s: any) => s.action === 'keep')).toBe(true);
      expect(resolverFiles()).toEqual(onFiles);
      expect(readdirSync(launcherDir).sort()).toEqual(launcherFiles);

      const off = await setup(b, harness, ['--skill-loading', 'off']);
      expect(off.exitCode).toBe(0);
      expect(read(configPath(b))).toBeNull();
      expect(catalogs(b)).toEqual([]);
      const rel = (p: string) => p.slice(b.home.length + 1);
      expect(read(HARNESS[harness].hookFile(b))).toBe(before[rel(HARNESS[harness].hookFile(b))]!);
      if (harness === 'codex') expect(read(join(b.home, '.codex', 'config.toml'))).toBe(before[rel(join(b.home, '.codex', 'config.toml'))]!);
      expect(existsSync(join(gb(b), 'skill-index', 'sessions'))).toBe(false);

      expect((await setup(b, harness, ['--skill-loading', 'resolve'])).exitCode).toBe(0);
      const removed = await runCli(['setup', harness, '--remove', '--gbrain-bin', b.bin], { env: b.env, cwd: b.project });
      expect(removed.exitCode, removed.stderr).toBe(0);
      expect(read(configPath(b))).toBeNull();
      expect(catalogs(b)).toEqual([]);
      expect(read(HARNESS[harness].hookFile(b))).toBe(before[rel(HARNESS[harness].hookFile(b))]!);
    });
  });
}

describe('setup --skill-loading resolve: refusals and other keys', () => {
  test('another harness refuses resolve', async () => {
    const b = box();
    const r = await setup(b, 'opencode', ['--skill-loading', 'resolve']);
    expect(r.exitCode).not.toBe(0);
    expect(read(configPath(b))).toBeNull();
  });

  test('an unreadable config: refuses with skill_resolver_config_unreadable and leaves the file as it was', async () => {
    const b = box();
    skill(HARNESS['claude-code'].skills(b), 'deploy-widget', 'Deploy the widget service.');
    mkdirSync(gb(b), { recursive: true });
    writeFileSync(configPath(b), '{ broken');
    const r = await setup(b, 'claude-code', ['--skill-loading', 'resolve', '--json']);
    expect(r.exitCode).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('skill_resolver_config_unreadable');
    expect(read(configPath(b))).toBe('{ broken');
    expect(catalogs(b)).toEqual([]);
  });

  test('other config keys survive on and off', async () => {
    const b = box();
    skill(HARNESS['claude-code'].skills(b), 'deploy-widget', 'Deploy the widget service.');
    mkdirSync(gb(b), { recursive: true });
    writeFileSync(configPath(b), JSON.stringify({ self_upgrade: { channel: 'alpha' } }));
    expect((await setup(b, 'claude-code', ['--skill-loading', 'resolve'])).exitCode).toBe(0);
    expect(JSON.parse(read(configPath(b))!)).toEqual({ self_upgrade: { channel: 'alpha' }, skills: { resolver: { enabled: true, harnesses: ['claude-code'] } } });
    expect((await setup(b, 'claude-code', ['--skill-loading', 'off'])).exitCode).toBe(0);
    expect(JSON.parse(read(configPath(b))!)).toEqual({ self_upgrade: { channel: 'alpha' } });
  });

  test('config set|get|unset skills.resolver.* run without a brain; harnesses belongs to setup', async () => {
    const b = box();
    const run = (...args: string[]) => runCli(['config', ...args], { env: b.env, cwd: b.project });
    expect((await run('set', 'skills.resolver.lane_payload_chars', '600')).exitCode).toBe(0);
    expect((await run('get', 'skills.resolver.lane_payload_chars')).stdout.trim()).toBe('600');
    expect((await run('set', 'skills.resolver.lane_payload_chars', '20')).exitCode).not.toBe(0);
    expect((await run('set', 'skills.resolver.harnesses', 'codex')).exitCode).not.toBe(0);
    expect((await run('unset', 'skills.resolver.lane_payload_chars')).exitCode).toBe(0);
    expect(read(configPath(b))).toBeNull();
  });
});

describe('the engine boundary with resolver-only settings', () => {
  test('resolver keys alone configure no brain; an engine, a database or a remote endpoint does', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-resolver-boundary-'));
    roots.push(dir);
    const write = (doc: unknown) => { mkdirSync(join(dir, '.gbrain'), { recursive: true }); writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify(doc)); };
    const load = () => withEnv({ GBRAIN_HOME: dir, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, () => loadConfig());
    write({ skills: { resolver: { enabled: true, harnesses: ['claude-code'] } } });
    expect(await load()).toBeNull();
    write({ autopilot: { incremental_extract_include_frontmatter: true }, skills: { resolver: { enabled: true } } });
    expect((await load())?.autopilot?.incremental_extract_include_frontmatter).toBe(true);
    write({ engine: 'pglite', database_path: join(dir, '.gbrain', 'brain.pglite'), skills: { resolver: { enabled: true, harnesses: ['claude-code'] } } });
    expect((await load())?.engine).toBe('pglite');
    write({ remote_mcp: { issuer_url: 'https://brain.example.invalid', mcp_url: 'https://brain.example.invalid/mcp', oauth_client_id: 'client-a' }, skills: { resolver: { enabled: true } } });
    expect((await load())?.remote_mcp).toBeTruthy();
  });

  test('after a brainless resolver setup, init creates the brain and keeps the keys; removal leaves the brain', async () => {
    const b = box();
    skill(HARNESS['claude-code'].skills(b), 'deploy-widget', 'Deploy the widget service.');
    expect((await setup(b, 'claude-code', ['--skill-loading', 'resolve'])).exitCode).toBe(0);
    const init = await runCli(['init', '--pglite', '--no-embedding', '--json'], { env: b.env, cwd: b.project, timeoutMs: 120_000 });
    expect(init.exitCode, init.stderr).toBe(0);
    const cfg = JSON.parse(read(configPath(b))!);
    expect(cfg.engine).toBe('pglite');
    expect(cfg.skills).toEqual({ resolver: { enabled: true, harnesses: ['claude-code'] } });
    const stats = await runCli(['stats', '--json'], { env: b.env, cwd: b.project, timeoutMs: 120_000 });
    expect(stats.exitCode, stats.stderr).toBe(0);
    expect((await setup(b, 'claude-code', ['--skill-loading', 'off'])).exitCode).toBe(0);
    const left = JSON.parse(read(configPath(b))!);
    expect(left.engine).toBe('pglite');
    expect(left.skills).toBeUndefined();
  }, 240_000);
});

describe('doctor', () => {
  test('silent when the resolver is not configured; reports the lane once it is on', async () => {
    const b = box();
    const doctor = async (only = ['--only', 'skill_resolver']) => JSON.parse((await runCli(['doctor', ...only, '--json'], { env: b.env, cwd: b.project })).stdout);
    const unconfigured = await doctor(['--only', 'harness_wiring']);
    expect(unconfigured.checks.some((c: any) => c.name === 'harness_wiring')).toBe(true);
    expect(unconfigured.checks.find((c: any) => c.name === 'skill_resolver')).toBeUndefined();
    expect(JSON.stringify(unconfigured.checks.find((c: any) => c.name === 'harness_wiring'))).not.toContain('skill_resolver');
    skill(HARNESS['claude-code'].skills(b), 'deploy-widget', 'Deploy the widget service.');
    expect((await setup(b, 'claude-code', ['--skill-loading', 'resolve'])).exitCode).toBe(0);
    const on = (await doctor()).checks.find((c: any) => c.name === 'skill_resolver');
    expect(on).toMatchObject({ status: 'ok', details: { config: 'ok', harnesses: [{ harness: 'claude-code', on: true, hook: 'wired', catalogs: [{ name: 'claude-code-user', fresh: true, skills: 1 }] }] } });
    skill(HARNESS['claude-code'].skills(b), 'write-changelog', 'Write a changelog entry.');
    const stale = (await doctor()).checks.find((c: any) => c.name === 'skill_resolver');
    expect(stale.details.harnesses[0].catalogs[0]).toMatchObject({ fresh: false, stale_reason: 'source_changed' });
    const settings = JSON.parse(read(HARNESS['claude-code'].hookFile(b))!);
    for (const ev of Object.keys(settings.hooks)) settings.hooks[ev] = settings.hooks[ev].filter((g: any) => !JSON.stringify(g).includes('skill-resolver'));
    writeFileSync(HARNESS['claude-code'].hookFile(b), JSON.stringify(settings));
    const broken = (await doctor()).checks.find((c: any) => c.name === 'skill_resolver');
    expect(broken.status).toBe('warn');
    expect(broken.fix.argv).toEqual(['gbrain', 'setup', 'claude-code', '--skill-loading', 'resolve']);
    writeFileSync(configPath(b), '{ broken');
    const unreadable = (await doctor()).checks.find((c: any) => c.name === 'skill_resolver');
    expect(unreadable).toMatchObject({ status: 'warn', details: { code: 'skill_resolver_config_unreadable' } });
  });
});

describe('doctor: an install from before the SessionStart entry', () => {
  for (const harness of ['claude-code', 'codex'] as H[]) {
    test(`${harness}: only the UserPromptSubmit hook warns as outdated with the setup fix, and setup repairs it`, async () => {
      const b = box();
      skill(HARNESS[harness].skills(b), 'deploy-widget', 'Deploy the widget service.');
      expect((await setup(b, harness, ['--skill-loading', 'resolve'])).exitCode).toBe(0);
      const doctor = async () => JSON.parse((await runCli(['doctor', '--only', 'skill_resolver', '--json'], { env: b.env, cwd: b.project })).stdout).checks.find((c: any) => c.name === 'skill_resolver');
      expect((await doctor()).status).toBe('ok');
      const file = HARNESS[harness].hookFile(b);
      const doc = JSON.parse(read(file)!);
      doc.hooks.SessionStart = doc.hooks.SessionStart.filter((g: any) => !JSON.stringify(g).includes('skill-resolver'));
      if (doc.hooks.SessionStart.length === 0) delete doc.hooks.SessionStart;
      writeFileSync(file, JSON.stringify(doc));
      const outdated = await doctor();
      expect(outdated.status).toBe('warn');
      expect(outdated.details.harnesses[0]).toMatchObject({ harness, hook: 'outdated' });
      expect(outdated.message).toContain('SessionStart');
      expect(outdated.message).toContain(`gbrain setup ${harness} --skill-loading resolve`);
      expect(outdated.fix.argv).toEqual(['gbrain', 'setup', harness, '--skill-loading', 'resolve']);
      const repair = await setup(b, harness, ['--skill-loading', 'resolve', '--json']);
      expect(repair.exitCode, repair.stderr).toBe(0);
      expect(repair.doc.skill_resolver.steps.find((s: any) => s.step === 'hook').action).toBe('write');
      expect(await doctor()).toMatchObject({ status: 'ok', details: { harnesses: [{ harness, hook: 'wired' }] } });
    });
  }
});

describe('per_harness.<harness>.dirs: extra skill directories setup keeps', () => {
  const run = (b: Box, ...args: string[]) => runCli(['config', ...args], { env: b.env, cwd: b.project });
  const receipt = (b: Box) => JSON.parse(readFileSync(join(gb(b), 'skill-index', 'claude-code-user', 'receipt.json'), 'utf8'));
  test('setup builds the user catalog from the default dir plus the configured ones; a re-run keeps them; unset drops them', async () => {
    const b = box();
    skill(HARNESS['claude-code'].skills(b), 'deploy-widget', 'Deploy the widget service.');
    const extra = join(b.root, 'shared-skills');
    skill(extra, 'citation-fixer', 'Fix broken citations across brain pages.');
    const set = await run(b, 'set', 'skills.resolver.per_harness.claude-code.dirs', `${extra},${join(b.root, 'not-there')}`);
    expect(set.exitCode, set.stderr).toBe(0);
    expect((await setup(b, 'claude-code', ['--skill-loading', 'resolve'])).exitCode).toBe(0);
    expect(receipt(b).catalog.source.dirs).toEqual([HARNESS['claude-code'].skills(b), extra]);
    expect(receipt(b).catalog.skill_count).toBe(2);
    expect(receipt(b).build.rebuild_argv).toContain(extra);
    const again = await setup(b, 'claude-code', ['--skill-loading', 'resolve']);
    expect(again.stdout).toMatch(/keep\s+resolver catalog: 2 skills/);
    const hit = await runCli(['skills', 'resolve', '--catalog', 'claude-code-user', '--text', 'fix the broken citations', '--json'], { env: b.env, cwd: b.project });
    expect(JSON.parse(hit.stdout).suggestions[0].id).toBe('citation-fixer');
    expect((await run(b, 'unset', 'skills.resolver.per_harness.claude-code.dirs')).exitCode).toBe(0);
    expect((await setup(b, 'claude-code', ['--skill-loading', 'resolve'])).exitCode).toBe(0);
    expect(receipt(b).catalog.source.dirs).toEqual([HARNESS['claude-code'].skills(b)]);
  });

  test('unsetting the last configured dir when the default dir is missing drops the user catalog; the plugin catalog keeps working', async () => {
    const b = box();
    const claude = join(b.home, '.claude');
    const p = join(claude, 'plugins', 'cache', 'market-a', 'acme', '1.0.0');
    mkdirSync(join(p, '.claude-plugin'), { recursive: true });
    writeFileSync(join(p, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'acme-tools' }));
    skill(join(p, 'skills'), 'deploy', 'Deploy a service with the acme rollout.');
    writeFileSync(join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'acme@market-a': [{ scope: 'user', installPath: p }] } }));
    writeFileSync(join(claude, 'settings.json'), JSON.stringify({ enabledPlugins: { 'acme@market-a': true } }));
    const extra = join(b.root, 'shared-skills');
    skill(extra, 'citation-fixer', 'Fix broken citations across brain pages.');
    expect((await run(b, 'set', 'skills.resolver.per_harness.claude-code.dirs', extra)).exitCode).toBe(0);
    expect((await setup(b, 'claude-code', ['--skill-loading', 'resolve'])).exitCode).toBe(0);
    expect(catalogs(b).sort()).toEqual(['claude-code-plugins', 'claude-code-user']);
    expect((await run(b, 'unset', 'skills.resolver.per_harness.claude-code.dirs')).exitCode).toBe(0);
    const off = await setup(b, 'claude-code', ['--skill-loading', 'resolve']);
    expect(off.exitCode, off.stderr).toBe(0);
    expect(off.stdout).toMatch(/remove\s+resolver catalog/);
    expect(catalogs(b)).toEqual(['claude-code-plugins']);
    const hit = await runCli(['skills', 'resolve', '--text', 'fix the broken citations', '--json'], { env: b.env, cwd: b.project });
    expect(JSON.parse(hit.stdout).suggestions.map((s: { id: string }) => s.id)).not.toContain('citation-fixer');
  });

  test('a hand-edited dir with a trailing or doubled slash is the same directory: one source dir, and a re-run keeps the catalog', async () => {
    const b = box();
    skill(HARNESS['claude-code'].skills(b), 'deploy-widget', 'Deploy the widget service.');
    const extra = join(b.root, 'shared-skills');
    skill(extra, 'citation-fixer', 'Fix broken citations across brain pages.');
    mkdirSync(gb(b), { recursive: true });
    writeFileSync(configPath(b), JSON.stringify({ skills: { resolver: { per_harness: { 'claude-code': { dirs: [`${extra}/`, extra.replace('/shared-skills', '//shared-skills')] } } } } }));
    expect((await setup(b, 'claude-code', ['--skill-loading', 'resolve'])).exitCode).toBe(0);
    expect(receipt(b).catalog.source.dirs).toEqual([HARNESS['claude-code'].skills(b), extra]);
    const again = await setup(b, 'claude-code', ['--skill-loading', 'resolve']);
    expect(again.stdout).toMatch(/keep\s+resolver catalog: 2 skills/);
  });

  test('refused: a relative or .. path, more than 32 dirs, and a harness setup does not build a catalog for', async () => {
    const b = box();
    for (const [key, value, needle] of [
      ['skills.resolver.per_harness.codex.dirs', 'skills/mine', 'absolute directory paths'],
      ['skills.resolver.per_harness.codex.dirs', '/a/../b', 'absolute directory paths'],
      ['skills.resolver.per_harness.codex.dirs', Array.from({ length: 33 }, (_, i) => `/d${i}`).join(','), 'at most 32'],
      ['skills.resolver.per_harness.pi.dirs', '/opt/skills', 'applies only to claude-code and codex'],
    ]) {
      const r = await run(b, 'set', key!, value!);
      expect({ key, code: r.exitCode === 0, has: r.stderr.includes(needle!) }).toEqual({ key, code: false, has: true });
    }
    expect(read(configPath(b))).toBeNull();
  });

  test('a hand-edited bad dirs value stops setup before it writes anything of the resolver', async () => {
    const b = box();
    skill(HARNESS.codex.skills(b), 'deploy-widget', 'Deploy the widget service.');
    mkdirSync(gb(b), { recursive: true });
    writeFileSync(configPath(b), JSON.stringify({ skills: { resolver: { per_harness: { codex: { dirs: 'not-a-list' } } } } }));
    const r = await setup(b, 'codex', ['--skill-loading', 'resolve', '--json']);
    expect(r.exitCode).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('skills.resolver.per_harness.codex.dirs must be a list');
    expect(catalogs(b)).toEqual([]);
  });
});

describe('per_harness entries that are not objects', () => {
  for (const bad of [null, [1], 'fast', 3]) {
    test(`config get, set and unset treat per_harness.codex = ${JSON.stringify(bad)} as unset and replace it`, async () => {
      const b = box();
      const run = (...args: string[]) => runCli(['config', ...args], { env: b.env, cwd: b.project });
      const seed = () => { mkdirSync(gb(b), { recursive: true }); writeFileSync(configPath(b), JSON.stringify({ skills: { resolver: { top_k: 3, per_harness: { codex: bad } } } })); };
      seed();
      const get = await run('get', 'skills.resolver.per_harness.codex.top_k');
      expect(get.exitCode).not.toBe(0);
      expect(get.stderr).toContain('Config key not found');
      expect(get.stderr).not.toContain('TypeError');
      const set = await run('set', 'skills.resolver.per_harness.codex.top_k', '2');
      expect(set.exitCode, set.stderr).toBe(0);
      expect(JSON.parse(read(configPath(b))!).skills.resolver.per_harness).toEqual({ codex: { top_k: 2 } });
      seed();
      const unset = await run('unset', 'skills.resolver.per_harness.codex.top_k');
      expect(unset.exitCode, unset.stderr).toBe(0);
      expect(JSON.parse(read(configPath(b))!).skills.resolver).toEqual({ top_k: 3 });
      const inherited = await run('set', 'skills.resolver.per_harness.constructor.top_k', '2');
      expect(inherited.exitCode).not.toBe(0);
      expect(inherited.stderr).toContain('names no harness');
    });

    test(`laneTurnSettings falls back to the global keys for per_harness.codex = ${JSON.stringify(bad)}`, () => {
      const section = { top_k: 3, min_match: 'description', per_harness: { codex: bad, 'claude-code': { top_k: 1 } } };
      expect(laneTurnSettings(section, 'codex')).toEqual({ top_k: 3, min_match_strength: 'description' });
      expect(laneTurnSettings(section, 'claude-code')).toEqual({ top_k: 1, min_match_strength: 'description' });
    });
  }
});
