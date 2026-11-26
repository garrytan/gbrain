/**
 * O1 v1 (GST-3989) and HARN-1 (harness-evals#616): `gbrain setup <harness> --template team` sets up a brand-new brain
 * for a team and refuses any brain that holds notes before it writes anything (its MCP entry included); naming
 * --members turns per-member access on with no --serves several; a one-person setup stays keyless and unchanged.
 * Real CLI children on a keyless PGLite brain. Invented names only.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli, type CliResult } from './helpers/cli-spawn.ts';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli.ts');
const OWNER = 'olivia-example';
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

interface Box { root: string; home: string; bin: string }
function box(): Box {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-team-setup-'));
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(home, { recursive: true });
  const bin = join(root, 'bin', 'gbrain');
  writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${CLI}' "$@"\n`);
  chmodSync(bin, 0o755);
  return { root, home, bin };
}

const CLEAN = { DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_REMOTE_CLIENT_SECRET: undefined, GBRAIN_SKIP_STARTUP_HOOKS: '1', CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, GBRAIN_SOURCE: undefined, GBRAIN_SURFACE: undefined, GBRAIN_HOOKS: undefined, GBRAIN_SETUP_ABORT_AFTER: undefined, HERMES_HOME: undefined };
const envOf = (b: Box) => ({ ...CLEAN, HOME: b.home, GBRAIN_HOME: b.home });
const gbrain = (b: Box, args: string[]) => runCli(args, { env: envOf(b), timeoutMs: 120_000 });
async function setup(b: Box, args: string[]): Promise<CliResult & { doc: any }> {
  const r = await runCli(['setup', ...args, '--json', '--gbrain-bin', b.bin], { env: envOf(b), timeoutMs: 240_000 });
  let doc: any = null;
  try { doc = JSON.parse(r.stdout); } catch { doc = null; }
  return { ...r, doc };
}
const keyDir = (b: Box) => join(b.home, '.gbrain', 'member-keys');
const TEAM = ['claude-code', '--template', 'team', '--members', 'alice-example,bob-example', '--groups', 'eng:alice-example', '--owner', OWNER];

describe('setup --template team', () => {
  test('a brand-new brain: preview writes nothing; --yes sets up the team, ties the entry to the owner and prints no key', async () => {
    const b = box();
    const preview = await setup(b, TEAM);
    expect(preview.exitCode).toBe(0);
    expect(existsSync(join(b.home, '.claude.json'))).toBe(false);
    expect(existsSync(keyDir(b))).toBe(false);

    const r = await setup(b, [...TEAM, '--yes']);
    expect(r.exitCode).toBe(0);
    const team = r.doc.brain_layout.team.result;
    expect(team.applied).toBe(true);
    expect(team.error).toBeUndefined();
    expect(team.fresh.ok).toBe(true);
    expect(r.doc.history ?? null).toBeNull();
    expect(readFileSync(join(b.home, '.claude.json'), 'utf8')).toContain(`"--stdio-member",\n        "${OWNER}"`);
    expect(readdirSync(keyDir(b)).sort()).toEqual(['alice-example.key', 'bob-example.key']);
    for (const k of readdirSync(keyDir(b))) {
      const path = join(keyDir(b), k);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(r.stdout + r.stderr).not.toContain(readFileSync(path, 'utf8').trim());
    }
    const serves = JSON.parse((await gbrain(b, ['access', 'serves', '--json', '--no-open-pages'])).stdout);
    expect(serves.serves).toBe('several');
    expect(serves.owner).toBe(OWNER);
    expect(serves.enabled_members).toEqual(['alice-example', 'bob-example', OWNER]);
    const rules = JSON.parse((await gbrain(b, ['access', 'rule', 'list', '--json'])).stdout);
    expect(JSON.stringify(rules)).toContain('people/alice-example/');
    expect(JSON.stringify(rules)).toContain('groups/eng/');
  }, 400_000);

  test('an existing brain with notes is refused before anything is written, its MCP entry included', async () => {
    const b = box();
    expect((await gbrain(b, ['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
    const notes = join(b.root, 'notes');
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, 'journal.md'), '---\ntitle: Journal\n---\n# Journal\n\nA private line.\n');
    expect((await gbrain(b, ['import', notes, '--no-embed'])).exitCode).toBe(0);
    const r = await setup(b, [...TEAM, '--yes']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('team_template_not_fresh');
    expect(existsSync(join(b.home, '.claude.json'))).toBe(false);
    expect(existsSync(keyDir(b))).toBe(false);
    const serves = JSON.parse((await gbrain(b, ['access', 'serves', '--json', '--no-open-pages'])).stdout);
    expect(serves.serves).toBe('one');
    expect(serves.enabled_members).toEqual([]);
  }, 400_000);

  for (const flag of [['--guests', 'guest-example'], ['--transcripts', '/tmp'], ['--shape', 'both'], ['--history', 'latest'], ['--serves', 'several'], ['--open-history']]) test(`${flag[0]} is refused with nothing written`, async () => {
    const b = box();
    const r = await setup(b, [...TEAM, ...flag, '--yes']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout + r.stderr).toContain(`${flag[0]} is not part of --template team`);
    expect(existsSync(join(b.home, '.claude.json'))).toBe(false);
    expect(existsSync(join(b.home, '.gbrain'))).toBe(false);
  }, 120_000);

  test('--template team needs members, and only the team template exists', async () => {
    const b = box();
    const said = (r: CliResult) => r.stdout + r.stderr;
    expect(said(await setup(b, ['claude-code', '--template', 'team', '--yes']))).toContain('--template team needs --members');
    expect(said(await setup(b, ['claude-code', '--template', 'office']))).toContain("unknown --template 'office'");
    expect(existsSync(join(b.home, '.gbrain'))).toBe(false);
  }, 120_000);

  test('a roster that does not parse is refused before the brain or the entry is written', async () => {
    const b = box();
    const said = (r: CliResult) => r.stdout + r.stderr;
    expect(said(await setup(b, ['claude-code', '--template', 'team', '--members', ' , ,', '--owner', OWNER, '--yes']))).toContain('at least one person besides the owner');
    expect(said(await setup(b, ['claude-code', '--template', 'team', '--members', 'alice-example', '--groups', 'eng:carol-example', '--owner', OWNER, '--yes']))).toContain('carol-example is not in --members');
    expect(existsSync(join(b.home, '.gbrain'))).toBe(false);
    expect(existsSync(join(b.home, '.claude.json'))).toBe(false);
  }, 120_000);

  test('an enabled gbrain plugin, which binds no member, is refused before anything is written', async () => {
    const b = box();
    mkdirSync(join(b.home, '.claude'), { recursive: true });
    writeFileSync(join(b.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'gbrain@gbrain': true } }));
    const r = await setup(b, [...TEAM, '--yes']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('setup_team_unbound');
    expect(existsSync(join(b.home, '.gbrain'))).toBe(false);
  }, 120_000);
});

describe('per-member access by default for 2+ people (HARN-1)', () => {
  test('--members alone sets up per-member access, with no --serves several', async () => {
    const b = box();
    const r = await setup(b, ['claude-code', '--members', 'alice-example,bob-example', '--owner', OWNER, '--dry-run']);
    expect(r.exitCode).toBe(0);
    expect(r.doc.serves.mode).toBe('several');
    const refused = await setup(b, ['claude-code', '--serves', 'one', '--members', 'alice-example', '--dry-run']);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain('drop --serves one');
  }, 120_000);

  test('a one-person setup stays keyless and unchanged: no members, no rules, no keys', async () => {
    const b = box();
    const r = await setup(b, ['claude-code']);
    expect(r.exitCode).toBe(0);
    expect(r.doc.serves ?? null).toBeNull();
    expect(r.doc.brain_layout?.team).toBeUndefined();
    const serves = JSON.parse((await gbrain(b, ['access', 'serves', '--json', '--no-open-pages'])).stdout);
    expect(serves).toMatchObject({ serves: 'one', enabled_members: [], owner: null });
    expect(JSON.parse((await gbrain(b, ['access', 'rule', 'list', '--json'])).stdout).rules ?? []).toEqual([]);
    expect(existsSync(keyDir(b))).toBe(false);
    expect(readFileSync(join(b.home, '.claude.json'), 'utf8')).not.toContain('--stdio-member');
  }, 400_000);
});
