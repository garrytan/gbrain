/**
 * HARN-1 (harness-evals#616): naming the people with --members turns per-member access on, with no --serves several;
 * --serves one with --members is refused; a one-person setup stays keyless and unchanged. Real CLI children on a
 * keyless PGLite brain. Invented names only.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli.ts');
const OWNER = 'olivia-example';
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

interface Box { root: string; home: string; bin: string }
function box(): Box {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-members-default-'));
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
async function setup(b: Box, args: string[]) {
  const r = await runCli(['setup', ...args, '--json', '--gbrain-bin', b.bin], { env: envOf(b), timeoutMs: 240_000 });
  let doc: any = null;
  try { doc = JSON.parse(r.stdout); } catch { doc = null; }
  return { ...r, doc };
}

describe('per-member access by default when setup names the people (HARN-1)', () => {
  test('--members alone sets up per-member access, with no --serves several', async () => {
    const b = box();
    const r = await setup(b, ['claude-code', '--members', 'alice-example,bob-example', '--owner', OWNER, '--dry-run']);
    expect(r.exitCode).toBe(0);
    expect(r.doc.serves.mode).toBe('several');
    const file = join(b.root, 'people.txt');
    writeFileSync(file, 'alice-example\nbob-example\n');
    expect((await setup(b, ['claude-code', '--members-file', file, '--owner', OWNER, '--dry-run'])).doc.serves.mode).toBe('several');
  }, 240_000);

  test('--serves one with --members is refused, and nothing is written', async () => {
    const b = box();
    const refused = await setup(b, ['claude-code', '--serves', 'one', '--members', 'alice-example', '--yes']);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain('drop --serves one');
    expect(existsSync(join(b.home, '.gbrain'))).toBe(false);
    expect(existsSync(join(b.home, '.claude.json'))).toBe(false);
  }, 120_000);

  test('--members alone applies: each person is an enabled member with a folder rule and a bound key', async () => {
    const b = box();
    const r = await setup(b, ['claude-code', '--members', 'alice-example,bob-example', '--owner', OWNER, '--yes']);
    expect(r.exitCode).toBe(0);
    const serves = JSON.parse((await gbrain(b, ['access', 'serves', '--json', '--no-open-pages'])).stdout);
    expect(serves.serves).toBe('several');
    expect(serves.enabled_members).toEqual(expect.arrayContaining(['alice-example', 'bob-example']));
    const prefixes = (JSON.parse((await gbrain(b, ['access', 'rule', 'list', '--json'])).stdout).rules ?? []).map((x: { prefix: string }) => x.prefix);
    expect(prefixes).toEqual(expect.arrayContaining(['people/alice-example/', 'people/bob-example/']));
    expect(existsSync(join(b.home, '.gbrain', 'member-keys', 'alice-example.key'))).toBe(true);
  }, 400_000);

  test('a run that cannot set up members refuses --members instead of ignoring it, and so do the history flags', async () => {
    const b = box();
    const said = async (args: string[]) => { const r = await setup(b, args); expect(r.exitCode).toBe(2); return r.stdout + r.stderr; };
    expect(await said(['claude-code', '--instructions-only', '--members', 'alice-example,bob-example'])).toContain('--members sets up per-member access only');
    expect(await said(['claude-code', '--members', 'alice-example,bob-example', '--history', '7'])).toContain('--serves several or --members');
    expect(existsSync(join(b.home, '.gbrain'))).toBe(false);
  }, 120_000);

  test('a one-person setup stays keyless and unchanged: no members, no rules, no keys', async () => {
    const b = box();
    const r = await setup(b, ['claude-code']);
    expect(r.exitCode).toBe(0);
    expect(r.doc.serves ?? null).toBeNull();
    const serves = JSON.parse((await gbrain(b, ['access', 'serves', '--json', '--no-open-pages'])).stdout);
    expect(serves).toMatchObject({ serves: 'one', enabled_members: [], owner: null });
    expect(JSON.parse((await gbrain(b, ['access', 'rule', 'list', '--json'])).stdout).rules ?? []).toEqual([]);
    expect(existsSync(join(b.home, '.gbrain', 'member-keys'))).toBe(false);
    expect(readFileSync(join(b.home, '.claude.json'), 'utf8')).not.toContain('--stdio-member');
  }, 400_000);
});
