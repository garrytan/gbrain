/**
 * GBRA-399 core PR 2: catalog sources beyond plain SKILL.md directories.
 *
 * 1. Protects: OpenClaw's `skills list --json` document builds as is (the
 *    name is the id; a skill OpenClaw hides from the model is skipped as
 *    ineligible); a JSON list with --dir folders takes each skill's body,
 *    path and triggers from the folder skill of the same name and adds no
 *    folder-only skill; an invalid entry names itself and the field; the
 *    enabled user-scope Claude Code plugins index as <plugin>:<skill>, and
 *    enabling or installing one makes the catalog stale; setup claude-code
 *    builds claude-code-plugins (also with no ~/.claude/skills) and off
 *    removes it.
 * 2. Fails when: the OpenClaw shape refuses again, hidden skills index,
 *    folder skills leak into a JSON catalog, a disabled, project-scope or
 *    missing plugin indexes, or setup leaves the plugin catalog behind.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { buildSkillIndex, catalogStatus, resolveSkills, RESOLVER_FEATURES, ResolverError } from '../src/core/skills/resolver/index.ts';

setDefaultTimeout(60_000);
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p = 'skres-cat-') => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
function skill(root: string, rel: string, name: string, description: string, body = 'Steps.'): string {
  const d = join(root, rel);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n${body}\n`);
  return join(d, 'SKILL.md');
}
async function codeAndMessage(p: Promise<unknown>): Promise<[string, string]> {
  try { await p; return ['resolved', '']; } catch (e) { return e instanceof ResolverError ? [e.code, e.message] : ['other', (e as Error).message]; }
}
const OPENCLAW = (skills: Record<string, unknown>[]) => JSON.stringify({ workspaceDir: '/work/acme-example', managedSkillsDir: '/work/acme-example/.openclaw/skills', skills });

describe('OpenClaw skills list --json', () => {
  test('builds as is: the name is the id, and a skill OpenClaw hides from the model is skipped as ineligible', async () => {
    const home = tmp();
    const rec = await buildSkillIndex({ catalog: 'oc', fromJson: OPENCLAW([
      { name: 'deploy-widget', description: 'Deploy the widget service', emoji: 'x', eligible: true, disabled: false, blockedByAllowlist: false, blockedByAgentFilter: false, modelVisible: true, source: 'managed', bundled: false },
      { name: 'off-eligible', description: 'a', eligible: false },
      { name: 'off-disabled', description: 'a', eligible: true, disabled: true },
      { name: 'off-allowlist', description: 'a', eligible: true, blockedByAllowlist: true },
      { name: 'off-agent', description: 'a', eligible: true, blockedByAgentFilter: true },
      { name: 'off-hidden', description: 'a', eligible: true, modelVisible: false },
    ]), fromJsonStdin: true }, { home });
    expect(rec.catalog.skill_count).toBe(1);
    expect(rec.catalog.skipped.map((s) => [s.id, s.reason]).sort()).toEqual([['off-agent', 'ineligible'], ['off-allowlist', 'ineligible'], ['off-disabled', 'ineligible'], ['off-eligible', 'ineligible'], ['off-hidden', 'ineligible']]);
    const t = await resolveSkills({ message: 'deploy the widget service', harness: 'openclaw' }, { home, catalogs: ['oc'] });
    expect(t.output.suggestions[0]?.id).toBe('deploy-widget');
    expect(RESOLVER_FEATURES).toContain('openclaw_skills_list');
  });

  test('with --dir folders: bodies, paths and triggers come from the folder skill of the same name; folder-only skills stay out', async () => {
    const home = tmp();
    const root = tmp('skres-oc-dir-');
    const path = skill(root, 'deploy-widget', 'deploy-widget', 'Deploy the widget service', 'Run the zebrafinch rollout.');
    skill(root, 'not-listed', 'not-listed', 'A skill OpenClaw did not list');
    const file = join(tmp(), 'skills.json');
    writeFileSync(file, OPENCLAW([{ name: 'deploy-widget', description: 'Deploy the widget service', eligible: true }, { name: 'no-folder', description: 'Listed without a folder', eligible: true }]));
    const rec = await buildSkillIndex({ catalog: 'oc', fromJson: file, dirs: [root], harness: 'openclaw' }, { home });
    expect(rec.catalog.skill_count).toBe(2);
    expect(rec.catalog.source).toMatchObject({ kind: 'json', dirs: [root] });
    expect(rec.build.rebuild_argv).toEqual(['gbrain', 'skills', 'index', 'build', '--catalog', 'oc', '--dir', root, '--from-json', file, '--harness', 'openclaw']);
    const t = await resolveSkills({ message: 'zebrafinch rollout' }, { home, catalogs: ['oc'] });
    expect(t.output.suggestions.map((s) => [s.id, s.path])).toEqual([['deploy-widget', path]]);
    expect((await resolveSkills({ message: 'not listed skill' }, { home, catalogs: ['oc'] })).output.suggestions.map((s) => s.id)).not.toContain('not-listed');
    expect((await catalogStatus('oc', { home })).fresh).toBe(true);
    expect(RESOLVER_FEATURES).toContain('from_json_with_dirs');
  });

  test('an invalid entry names itself and the field; an id-less plain list points at the OpenClaw shape', async () => {
    const home = tmp();
    const [code, msg] = await codeAndMessage(buildSkillIndex({ catalog: 'x', fromJson: JSON.stringify([{ id: 'a', name: 'alpha', triggers: 'deploy' }]), fromJsonStdin: true }, { home }));
    expect(code).toBe('skill_source_invalid');
    expect(msg).toContain('Entry 0 (alpha)');
    expect(msg).toContain('triggers (an array of strings)');
    const [code2, msg2] = await codeAndMessage(buildSkillIndex({ catalog: 'x', fromJson: JSON.stringify({ skills: [{ name: 'beta' }] }), fromJsonStdin: true }, { home }));
    expect(code2).toBe('skill_source_invalid');
    expect(msg2).toContain('id (a required string');
    expect(msg2).toContain('OpenClaw');
  });
});

/** A Claude config dir with plugins: acme (manifest name acme-tools, enabled), beta (no manifest, enabled), gamma (installed, disabled), delta (project scope). */
function claudeDir(): { dir: string; cache: string } {
  const dir = tmp('skres-claude-');
  const cache = join(dir, 'plugins', 'cache', 'market-a');
  const acme = join(cache, 'acme', '1.0.0');
  mkdirSync(join(acme, '.claude-plugin'), { recursive: true });
  writeFileSync(join(acme, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'acme-tools' }));
  skill(join(acme, 'skills'), 'deploy', 'deploy', 'Deploy a service with the acme rollout');
  skill(join(cache, 'beta', '2.0.0', 'skills'), 'notes', 'notes', 'Take meeting notes');
  skill(join(cache, 'gamma', '1.0.0', 'skills'), 'gamma-skill', 'gamma-skill', 'A disabled plugin skill');
  skill(join(cache, 'delta', '1.0.0', 'skills'), 'delta-skill', 'delta-skill', 'A project plugin skill');
  writeFileSync(join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
    'acme@market-a': [{ scope: 'user', installPath: acme, version: '1.0.0' }],
    'beta@market-a': [{ scope: 'user', installPath: join(cache, 'beta', '2.0.0'), version: '2.0.0' }],
    'gamma@market-a': [{ scope: 'user', installPath: join(cache, 'gamma', '1.0.0'), version: '1.0.0' }],
    'delta@market-a': [{ scope: 'project', installPath: join(cache, 'delta', '1.0.0'), version: '1.0.0', projectPath: '/work/acme-example' }],
    'gone@market-a': [{ scope: 'user', installPath: join(cache, 'gone', '1.0.0'), version: '1.0.0' }],
  } }));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'acme@market-a': true, 'beta@market-a': true, 'gamma@market-a': false, 'delta@market-a': true, 'gone@market-a': true } }));
  return { dir, cache };
}

describe('Claude Code plugin skills (--claude-plugins)', () => {
  test('enabled user-scope plugins index as <plugin>:<skill>; disabled, project-scope and missing installs do not', async () => {
    const home = tmp();
    const { dir } = claudeDir();
    const rec = await buildSkillIndex({ catalog: 'claude-code-plugins', claudePlugins: dir, harness: 'claude-code' }, { home });
    expect(rec.catalog.source).toEqual({ kind: 'claude_plugins', claude_dir: dir });
    expect(rec.build.rebuild_argv).toEqual(['gbrain', 'skills', 'index', 'build', '--catalog', 'claude-code-plugins', '--claude-plugins', dir, '--harness', 'claude-code']);
    const ids = (await resolveSkills({ message: 'deploy a service with the acme rollout, take meeting notes', top_k: 8 }, { home, catalogs: ['claude-code-plugins'] })).output.suggestions.map((s) => s.id).sort();
    expect(ids).toEqual(['acme-tools:deploy', 'beta:notes']);
    expect(rec.catalog.skill_count).toBe(2);
    expect((await catalogStatus('claude-code-plugins', { home })).fresh).toBe(true);
    expect(RESOLVER_FEATURES).toContain('claude_plugins');
  });

  test('enabling a plugin makes the catalog stale, and the recorded rebuild picks it up', async () => {
    const home = tmp();
    const { dir } = claudeDir();
    await buildSkillIndex({ catalog: 'claude-code-plugins', claudePlugins: dir }, { home });
    await new Promise((r) => setTimeout(r, 30));
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'acme@market-a': true, 'beta@market-a': true, 'gamma@market-a': true } }));
    const s = await catalogStatus('claude-code-plugins', { home });
    expect(s.fresh).toBe(false);
    expect((await resolveSkills({ message: 'disabled plugin skill' }, { home, catalogs: ['claude-code-plugins'] })).output.meta.index_stale).toBe(true);
    const again = await buildSkillIndex({ catalog: 'claude-code-plugins', claudePlugins: s.receipt!.source.claude_dir! }, { home });
    expect(again.catalog.skill_count).toBe(3);
  });

  test('no plugin records: an empty catalog, no error', async () => {
    const home = tmp();
    const rec = await buildSkillIndex({ catalog: 'p', claudePlugins: tmp('skres-claude-empty-') }, { home });
    expect(rec.catalog.skill_count).toBe(0);
  });
});

describe('setup claude-code --skill-loading resolve with plugins', () => {
  function box() {
    const root = tmp('gbrain-skres-plugins-setup-');
    const home = join(root, 'home'), project = join(root, 'project');
    mkdirSync(project, { recursive: true });
    mkdirSync(join(root, 'bin'), { recursive: true });
    const bin = join(root, 'bin', 'gbrain');
    writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${CLI}' "$@"\n`);
    chmodSync(bin, 0o755);
    const claude = join(home, '.claude');
    mkdirSync(claude, { recursive: true });
    const env = { HOME: home, GBRAIN_HOME: home, PATH: '/usr/bin:/bin', CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, XDG_CONFIG_HOME: undefined,
      GBRAIN_SKILL_LOADING: undefined, GBRAIN_HOOK_LANE: undefined, GBRAIN_AGENT_INSTRUCTIONS: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined };
    return { home, project, bin, claude, env };
  }
  const index = (home: string) => { const d = join(home, '.gbrain', 'skill-index'); return existsSync(d) ? readdirSync(d).filter((n) => !n.startsWith('.') && n !== 'logs' && n !== 'sessions').sort() : []; };
  function plugins(claude: string) {
    const p = join(claude, 'plugins', 'cache', 'market-a', 'acme', '1.0.0');
    mkdirSync(join(p, '.claude-plugin'), { recursive: true });
    writeFileSync(join(p, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'acme-tools' }));
    skill(join(p, 'skills'), 'deploy', 'deploy', 'Deploy a service with the acme rollout');
    writeFileSync(join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'acme@market-a': [{ scope: 'user', installPath: p }] } }));
    writeFileSync(join(claude, 'settings.json'), JSON.stringify({ enabledPlugins: { 'acme@market-a': true } }));
  }
  const run = (b: ReturnType<typeof box>, extra: string[]) => runCli(['setup', 'claude-code', '--instructions-only', '--gbrain-bin', b.bin, ...extra], { env: b.env, cwd: b.project });

  test('plugins only (no ~/.claude/skills): turns on with claude-code-plugins; off removes it', async () => {
    const b = box();
    plugins(b.claude);
    const on = await run(b, ['--skill-loading', 'resolve']);
    expect(on.exitCode, on.stderr).toBe(0);
    expect(index(b.home)).toEqual(['claude-code-plugins']);
    expect(on.stdout).toContain('skill resolver: on; 1 skills; fresh');
    const again = await run(b, ['--skill-loading', 'resolve']);
    expect(again.stdout).toContain('keep');
    const off = await run(b, ['--skill-loading', 'off']);
    expect(off.exitCode, off.stderr).toBe(0);
    expect(index(b.home)).toEqual([]);
  });

  test('user skills and plugins: both catalogs', async () => {
    const b = box();
    plugins(b.claude);
    skill(join(b.claude, 'skills'), 'notes', 'notes', 'Take meeting notes');
    const on = await run(b, ['--skill-loading', 'resolve']);
    expect(on.exitCode, on.stderr).toBe(0);
    expect(index(b.home)).toEqual(['claude-code-plugins', 'claude-code-user']);
    expect(on.stdout).toContain('skill resolver: on; 2 skills; fresh');
  });
});

describe('harness-owned entries in a skills root (HARN-52)', () => {
  const built = async (prefix: string) => {
    const home = tmp();
    const root = tmp(prefix);
    skill(root, 'deploy', 'deploy', 'Deploy a service to production');
    await buildSkillIndex({ catalog: 'h', dirs: [root], harness: 'codex' }, { home });
    return { home, root };
  };
  const stale = async (home: string) => (await resolveSkills({ message: 'deploy a service' }, { home, catalogs: ['h'] })).output.meta.index_stale;

  test('Codex creating .system/ with its own skills leaves the index fresh, and dot-directories are never indexed', async () => {
    const { home, root } = await built('skres-codex-root-');
    skill(join(root, '.system'), 'skill-creator', 'skill-creator', 'Create a new skill');
    expect(await stale(home)).toBe(false);
    expect((await catalogStatus('h', { home })).fresh).toBe(true);
    const ids = (await resolveSkills({ message: 'create a new skill' }, { home, catalogs: ['h'] })).output.suggestions.map((s) => s.id);
    expect(ids).not.toContain('skill-creator');
  });

  test('Hermes rewriting a dot-file in the root (write and rename) leaves the index fresh', async () => {
    const { home, root } = await built('skres-hermes-root-');
    writeFileSync(join(root, '.usage.json.tmp'), '{"deploy":1}');
    renameSync(join(root, '.usage.json.tmp'), join(root, '.usage.json'));
    writeFileSync(join(root, '.hub'), 'x');
    expect(await stale(home)).toBe(false);
    writeFileSync(join(root, '.usage.json.tmp'), '{"deploy":2}');
    renameSync(join(root, '.usage.json.tmp'), join(root, '.usage.json'));
    expect(await stale(home)).toBe(false);
    expect((await catalogStatus('h', { home })).fresh).toBe(true);
  });

  test('a new skill folder or an edited SKILL.md still makes the index stale', async () => {
    const a = await built('skres-new-skill-');
    skill(a.root, 'notes', 'notes', 'Take meeting notes');
    expect(await stale(a.home)).toBe(true);
    const b = await built('skres-edit-skill-');
    writeFileSync(join(b.root, 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Deploy a service to staging first\n---\nSteps.\n');
    expect(await stale(b.home)).toBe(true);
  });

  test('retargeting a SKILL.md symlink in place makes the index stale on the turn path', async () => {
    const home = tmp();
    const root = tmp('skres-symlink-');
    const d = join(root, 'tool');
    mkdirSync(d);
    writeFileSync(join(d, 'a.md'), '---\nname: old-deploy\ndescription: Deploy the widget service\n---\nSteps.\n');
    writeFileSync(join(d, 'b.md'), '---\nname: new-invoice\ndescription: Draft an invoice for a customer\n---\nSteps.\n');
    symlinkSync('a.md', join(d, 'SKILL.md'));
    await buildSkillIndex({ catalog: 'h', dirs: [root] }, { home });
    symlinkSync('b.md', join(d, 'SKILL.md.next'));
    renameSync(join(d, 'SKILL.md.next'), join(d, 'SKILL.md'));
    expect(await stale(home)).toBe(true);
  });
});

describe('a JSON list equal to a folder builds the same index (HARN-52)', () => {
  test('when_to_use and disable_model_invocation: one catalog built from folders and from JSON has equal catalog_hash and index_hash', async () => {
    const root = tmp('skres-parity-');
    const write = (dir: string, fm: string, body: string) => { mkdirSync(join(root, dir), { recursive: true }); writeFileSync(join(root, dir, 'SKILL.md'), `---\n${fm}\n---\n${body}\n`); return join(root, dir, 'SKILL.md'); };
    const deploy = write('deploy', 'name: deploy\ndescription: Ship a service\nwhen_to_use: when the user asks for a zebrafinch release', 'Run the tests, then deploy.');
    const notes = write('notes', 'name: notes\ndescription: Take meeting notes', 'Write the notes.');
    const hidden = write('hidden', 'name: hidden\ndescription: Internal helper\ndisable-model-invocation: true', 'Never offered.');
    const homeA = tmp();
    const a = await buildSkillIndex({ catalog: 'p', dirs: [root] }, { home: homeA });
    const list = [
      { id: 'deploy', name: 'deploy', description: 'Ship a service', when_to_use: 'when the user asks for a zebrafinch release', body: 'Run the tests, then deploy.\n', path: deploy },
      { id: 'hidden', name: 'hidden', description: 'Internal helper', disable_model_invocation: true, body: 'Never offered.\n', path: hidden },
      { id: 'notes', name: 'notes', description: 'Take meeting notes', body: 'Write the notes.\n', path: notes },
    ];
    const homeB = tmp();
    const b = await buildSkillIndex({ catalog: 'p', fromJson: JSON.stringify(list), fromJsonStdin: true }, { home: homeB });
    expect(b.catalog.skipped).toEqual(a.catalog.skipped);
    expect(b.catalog.skipped.map((s) => s.reason)).toEqual(['not_model_invocable']);
    expect([b.catalog.catalog_hash, b.index.index_hash]).toEqual([a.catalog.catalog_hash, a.index.index_hash]);
    const top = (await resolveSkills({ message: 'zebrafinch release' }, { home: homeB, catalogs: ['p'] })).output.suggestions.map((s) => s.id);
    expect(top).toEqual(['deploy']);
    expect(await codeAndMessage(buildSkillIndex({ catalog: 'q', fromJson: JSON.stringify([{ id: 'x', name: 'x', when_to_use: 3 }]), fromJsonStdin: true }, { home: homeB }))).toEqual(['skill_source_invalid', expect.stringContaining('when_to_use (a string)')]);
    expect(RESOLVER_FEATURES).toContain('from_json_when_to_use');
  });
});
