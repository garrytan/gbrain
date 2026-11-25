/**
 * Decision I1 (Garry, 2026-11-24): `gbrain setup codex` registers the full surface by default, because Codex does not
 * reload its tool list and so never calls a tool request_tools unlocks (harness-evals#609: 12/64 right calls on the
 * starter registration, 62/64 on full). Claude Code keeps starter.
 *
 * 1. Protects: a new Codex entry is `serve --surface full` with surface_origin default in the receipt; an explicit
 *    `--surface starter --advertise verbs` (or `--surface full`) pins the entry exactly, origin explicit, on a fresh
 *    install and through re-runs; a re-run moves only a default-origin entry to the current default, says so and prints
 *    the exact line that keeps the old one (with the entry's source); a receipt from before origins were recorded keeps
 *    its entry and prints the line that would move it; an unreadable receipt changes nothing; an entry setup adopted is
 *    kept; config mcp.default_surface_codex turns the default back (and on) without a release.
 * 2. Fails when: a re-run narrows or widens an explicit pin, moves a pre-origin or adopted entry, the escape hatch does
 *    not restore the old serve argv, or the knob is ignored.
 * 3. Real seams: the CLI (`bun src/cli.ts setup codex`) against a temp HOME, its config.toml, receipt and smoke.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli, type CliResult } from './helpers/cli-spawn.ts';
import { CODEX_FORWARDED_PROVIDER_ENV } from '../src/core/setup/codex.ts';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli.ts');
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

interface Box { root: string; home: string; bin: string }
function box(): Box {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-setup-i1-'));
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const bin = join(root, 'bin', 'gbrain');
  mkdirSync(join(root, 'bin'));
  writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${CLI}' "$@"\n`);
  chmodSync(bin, 0o755);
  return { root, home, bin };
}

const CLEAN = { CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, GBRAIN_SOURCE: undefined, GBRAIN_SURFACE: undefined, GBRAIN_HOOKS: undefined, GBRAIN_SETUP_ABORT_AFTER: undefined };
const env = (b: Box) => ({ ...CLEAN, HOME: b.home, GBRAIN_HOME: b.home });

async function setup(b: Box, args: string[]): Promise<CliResult & { doc: any }> {
  const r = await runCli(['setup', 'codex', ...args, '--json', '--gbrain-bin', b.bin], { env: env(b) });
  let doc: any = null;
  try { doc = JSON.parse(r.stdout); } catch { doc = null; }
  return { ...r, doc };
}

/** Run a printed `gbrain setup ...` line as the user would (the box's launcher stands in for `gbrain`). */
async function runLine(b: Box, line: string): Promise<CliResult & { doc: any }> {
  const argv = line.split(' ');
  expect(argv.slice(0, 3)).toEqual(['gbrain', 'setup', 'codex']);
  const rest = argv.slice(3).filter((a, i, all) => a !== '--gbrain-bin' && all[i - 1] !== '--gbrain-bin');
  return setup(b, rest);
}

const tomlPath = (b: Box) => join(b.home, '.codex', 'config.toml');
const toml = (b: Box): any => Bun.TOML.parse(readFileSync(tomlPath(b), 'utf8'));
const receiptPath = (b: Box) => join(b.home, '.codex', '.gbrain-connection-codex-gbrain.json');
const receipt = (b: Box): any => JSON.parse(readFileSync(receiptPath(b), 'utf8'));
const args = (b: Box): string[] => toml(b).mcp_servers.gbrain.args;
const setKnob = (b: Box, value: 'full' | 'starter' | null) => {
  const path = join(b.home, '.gbrain', 'config.json');
  const cfg = JSON.parse(readFileSync(path, 'utf8'));
  if (value === null) delete cfg.mcp?.default_surface_codex;
  else cfg.mcp = { ...(cfg.mcp ?? {}), default_surface_codex: value };
  writeFileSync(path, JSON.stringify(cfg, null, 2));
};
const note = (r: { doc: any }, phrase: string): string | undefined => (r.doc.notes as string[]).find((n) => n.includes(phrase));
const keepLine = (n: string) => n.slice(n.indexOf('gbrain setup codex'));

describe('gbrain setup codex: the full surface by default (I1)', () => {
  test('a new install registers serve --surface full, listed whole, and records surface_origin default', async () => {
    const b = box();
    const r = await setup(b, []);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.doc.target).toMatchObject({ surface: 'full', surface_origin: 'default' });
    expect(r.doc.target.advertise).toBeUndefined();
    expect(args(b)).toEqual([b.bin, 'serve', '--surface', 'full']);
    expect(toml(b).mcp_servers.gbrain.env_vars).toEqual([...CODEX_FORWARDED_PROVIDER_ENV]);
    expect(receipt(b)).toMatchObject({ surface: 'full', surface_origin: 'default' });
    expect(receipt(b).advertise).toBeUndefined();
    expect(r.doc.verify.reason).toBe('smoke_passed');
  }, 180_000);

  test('--surface starter --advertise verbs pins the old profile exactly, origin explicit, fresh and through re-runs', async () => {
    const b = box();
    const first = await setup(b, ['--surface', 'starter', '--advertise', 'verbs']);
    expect(first.exitCode, first.stderr).toBe(0);
    expect(args(b)).toEqual([b.bin, 'serve', '--surface', 'starter', '--advertise', 'verbs']);
    expect(receipt(b)).toMatchObject({ surface: 'starter', advertise: 'verbs', surface_origin: 'explicit' });
    const files = () => [tomlPath(b), receiptPath(b)].map((p) => readFileSync(p, 'utf8'));
    const before = files();
    const again = await setup(b, []);
    expect(again.exitCode, again.stderr).toBe(0);
    expect(again.doc.steps.map((s: any) => [s.step, s.action])).toEqual([['receipt', 'keep'], ['mcp', 'keep'], ['hooks', 'keep'], ['trust', 'keep']]);
    expect(files()).toEqual(before);
    expect(again.doc.notes.join('\n')).not.toContain('moves from');
    const pinnedAgain = await setup(b, ['--surface', 'starter', '--advertise', 'verbs']);
    expect(pinnedAgain.exitCode).toBe(0);
    expect(files()).toEqual(before);
  }, 240_000);

  test('--surface full pins full explicitly, so turning the Codex default back to starter leaves it alone', async () => {
    const b = box();
    expect((await setup(b, ['--surface', 'full'])).exitCode).toBe(0);
    expect(receipt(b)).toMatchObject({ surface: 'full', surface_origin: 'explicit' });
    setKnob(b, 'starter');
    const r = await setup(b, []);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(args(b)).toEqual([b.bin, 'serve', '--surface', 'full']);
    expect(receipt(b).surface_origin).toBe('explicit');
  }, 240_000);

  test('a re-run moves a default-origin starter entry to full, says so, and the printed line restores it exactly (with its source)', async () => {
    const b = box();
    expect((await setup(b, ['--source', 'default'])).exitCode).toBe(0);
    setKnob(b, 'starter');
    expect((await setup(b, ['--source', 'default'])).exitCode).toBe(0);
    expect(args(b)).toEqual([b.bin, 'serve', '--surface', 'starter', '--advertise', 'verbs']);
    expect(receipt(b)).toMatchObject({ surface: 'starter', advertise: 'verbs', surface_origin: 'default', source_id: 'default' });

    setKnob(b, null);
    const moved = await setup(b, []);
    expect(moved.exitCode, moved.stderr).toBe(0);
    expect(args(b)).toEqual([b.bin, 'serve', '--surface', 'full']);
    expect(toml(b).mcp_servers.gbrain.env).toMatchObject({ GBRAIN_SOURCE: 'default' });
    expect(receipt(b)).toMatchObject({ surface: 'full', surface_origin: 'default' });
    const n = note(moved, 'moves from serve --surface starter --advertise verbs to serve --surface full');
    expect(n).toBeDefined();
    const line = keepLine(n!);
    expect(line).toContain('--source default');
    expect(line).toMatch(/--surface starter --advertise verbs$/);

    const restored = await runLine(b, line);
    expect(restored.exitCode, restored.stderr).toBe(0);
    expect(args(b)).toEqual([b.bin, 'serve', '--surface', 'starter', '--advertise', 'verbs']);
    expect(toml(b).mcp_servers.gbrain.env).toMatchObject({ GBRAIN_SOURCE: 'default' });
    expect(receipt(b)).toMatchObject({ surface: 'starter', advertise: 'verbs', surface_origin: 'explicit', source_id: 'default' });
    const once = readFileSync(tomlPath(b), 'utf8');
    expect((await runLine(b, line)).exitCode).toBe(0);
    expect(readFileSync(tomlPath(b), 'utf8')).toBe(once);
  }, 300_000);

  test('the rollback knob moves default-origin entries back to starter on the next run, and unsetting it moves them to full', async () => {
    const b = box();
    expect((await setup(b, [])).exitCode).toBe(0);
    setKnob(b, 'starter');
    const back = await setup(b, []);
    expect(back.exitCode, back.stderr).toBe(0);
    expect(args(b)).toEqual([b.bin, 'serve', '--surface', 'starter', '--advertise', 'verbs']);
    expect(note(back, 'moves from serve --surface full to serve --surface starter --advertise verbs')).toBeDefined();
    setKnob(b, null);
    expect((await setup(b, [])).exitCode).toBe(0);
    expect(args(b)).toEqual([b.bin, 'serve', '--surface', 'full']);
  }, 300_000);

  test('mcp.allow_session_widen set off in the brain database moves a default-origin entry to starter, and a held brain is never widened', async () => {
    const b = box();
    expect((await setup(b, [])).exitCode).toBe(0);
    const set = await runCli(['config', 'set', 'mcp.allow_session_widen', 'false'], { env: env(b) });
    expect(set.exitCode, set.stderr).toBe(0);
    const moved = await setup(b, []);
    expect(moved.exitCode, moved.stderr).toBe(0);
    expect(args(b)).toEqual([b.bin, 'serve', '--surface', 'starter', '--advertise', 'verbs']);
    expect(note(moved, 'session widening is off on this brain')).toBeDefined();
    expect(note(moved, 'Codex does not reload')).toBeUndefined();
    const reset = await runCli(['config', 'set', 'mcp.allow_session_widen', 'true'], { env: env(b) });
    expect(reset.exitCode, reset.stderr).toBe(0);
    const { acquireLock, releaseLock } = await import('../src/core/pglite-lock.ts');
    const lock = await acquireLock(join(b.home, '.gbrain', 'brain.pglite'));
    try {
      const held = await setup(b, []);
      expect(held.stderr).toContain('note: setup could not read mcp.allow_session_widen from the brain database');
      expect(args(b)).toEqual([b.bin, 'serve', '--surface', 'starter', '--advertise', 'verbs']);
    } finally { await releaseLock(lock); }
  }, 120_000);

  test('a receipt from before surface_origin keeps its entry and prints the exact line that would move it', async () => {
    const b = box();
    expect((await setup(b, [])).exitCode).toBe(0);
    setKnob(b, 'starter');
    expect((await setup(b, [])).exitCode).toBe(0);
    setKnob(b, null);
    const legacy = receipt(b);
    delete legacy.surface_origin;
    writeFileSync(receiptPath(b), `${JSON.stringify(legacy, null, 2)}\n`);
    const tomlBefore = readFileSync(tomlPath(b), 'utf8');

    const kept = await setup(b, []);
    expect(kept.exitCode, kept.stderr).toBe(0);
    expect(readFileSync(tomlPath(b), 'utf8')).toBe(tomlBefore);
    expect(receipt(b).surface_origin).toBeUndefined();
    const n = note(kept, 'written before setup recorded whether its surface was chosen');
    expect(n).toBeDefined();
    const line = keepLine(n!);
    expect(line).toMatch(/--surface full$/);

    const moved = await runLine(b, line);
    expect(moved.exitCode, moved.stderr).toBe(0);
    expect(args(b)).toEqual([b.bin, 'serve', '--surface', 'full']);
    expect(receipt(b).surface_origin).toBe('explicit');
  }, 300_000);

  test('an unreadable receipt changes nothing: the entry is kept byte for byte and setup exits non-zero naming the receipt', async () => {
    const b = box();
    expect((await setup(b, ['--surface', 'starter', '--advertise', 'verbs'])).exitCode).toBe(0);
    writeFileSync(receiptPath(b), '{not json');
    const tomlBefore = readFileSync(tomlPath(b), 'utf8');
    const r = await setup(b, []);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr + r.stdout).toContain('is unreadable');
    expect(readFileSync(tomlPath(b), 'utf8')).toBe(tomlBefore);
    expect(readFileSync(receiptPath(b), 'utf8')).toBe('{not json');
  }, 240_000);

  test('an existing table identical to the old starter registration is adopted as explicit and kept through re-runs', async () => {
    const b = box();
    expect((await setup(b, ['--surface', 'starter', '--advertise', 'verbs', '--no-hooks'])).exitCode).toBe(0);
    rmSync(receiptPath(b));
    const adopted = await setup(b, ['--no-hooks']);
    expect(adopted.exitCode, adopted.stderr).toBe(0);
    expect(args(b)).toEqual([b.bin, 'serve', '--surface', 'starter', '--advertise', 'verbs']);
    expect(receipt(b)).toMatchObject({ mcp_adopted: true, surface_origin: 'explicit' });
    expect((await setup(b, ['--no-hooks'])).exitCode).toBe(0);
    expect(args(b)).toEqual([b.bin, 'serve', '--surface', 'starter', '--advertise', 'verbs']);
  }, 240_000);

  test('--advertise needs --surface and a listing no wider than it; nothing is written on a refusal', async () => {
    const b = box();
    const alone = await setup(b, ['--advertise', 'verbs']);
    expect(alone.exitCode).toBe(2);
    expect(alone.stderr + alone.stdout).toContain('--advertise narrows the listing of the surface --surface pins');
    const wider = await setup(b, ['--surface', 'starter', '--advertise', 'full']);
    expect(wider.exitCode).toBe(2);
    expect(wider.stderr + wider.stdout).toContain('lists more than --surface starter serves');
    expect(existsSync(join(b.home, '.codex'))).toBe(false);
  }, 120_000);

  test('gbrain config set mcp.default_surface_codex takes full or starter on the file plane and refuses anything else', async () => {
    const b = box();
    expect((await runCli(['init', '--pglite', '--no-embedding', '--json'], { env: env(b) })).exitCode).toBe(0);
    const set = await runCli(['config', 'set', 'mcp.default_surface_codex', 'starter'], { env: env(b) });
    expect(set.exitCode, set.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(b.home, '.gbrain', 'config.json'), 'utf8')).mcp.default_surface_codex).toBe('starter');
    const dry = await setup(b, ['--dry-run']);
    expect(dry.doc.target).toMatchObject({ surface: 'starter', advertise: 'verbs', surface_origin: 'default' });
    const bad = await runCli(['config', 'set', 'mcp.default_surface_codex', 'verbs'], { env: env(b) });
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toContain('must be full (serve --surface full) or starter');
    const unset = await runCli(['config', 'unset', 'mcp.default_surface_codex'], { env: env(b) });
    expect(unset.exitCode, unset.stderr).toBe(0);
    expect((await setup(b, ['--dry-run'])).doc.target).toMatchObject({ surface: 'full', surface_origin: 'default' });
  }, 180_000);
});

describe('gbrain setup claude-code keeps starter (I1)', () => {
  test('a new Claude Code entry is still serve --surface starter --advertise verbs; --advertise pins a listing there too', async () => {
    const b = box();
    const r = await runCli(['setup', 'claude-code', '--dry-run', '--json', '--gbrain-bin', b.bin], { env: env(b) });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).target).toMatchObject({ surface: 'starter', advertise: 'verbs' });
    const pinned = await runCli(['setup', 'claude-code', '--surface', 'full', '--advertise', 'starter', '--dry-run', '--json', '--gbrain-bin', b.bin], { env: env(b) });
    expect(JSON.parse(pinned.stdout).target).toMatchObject({ surface: 'full', advertise: 'starter' });
  }, 120_000);
});

describe('gbrain setup openclaw: names the line that moves a starter entry to full (I1)', () => {
  const OC_ENV = { OPENCLAW_STATE_DIR: undefined, OPENCLAW_WORKSPACE_DIR: undefined, OPENCLAW_PROFILE: undefined, OPENCLAW_CONFIG_PATH: undefined };
  async function setupOpenclaw(b: Box) {
    const r = await runCli(['setup', 'openclaw', '--json', '--gbrain-bin', b.bin], { env: { ...env(b), ...OC_ENV } });
    return { ...r, doc: JSON.parse(r.stdout) };
  }

  test('a starter stdio entry in openclaw.json gets the exact openclaw mcp set line for full, and setup leaves the file alone', async () => {
    const b = box();
    const dir = join(b.home, '.openclaw');
    mkdirSync(dir, { recursive: true });
    const entry = { command: b.bin, args: ['serve', '--surface', 'starter', '--advertise', 'verbs'], env: { GBRAIN_HOME: b.home } };
    const text = JSON.stringify({ mcp: { servers: { gbrain: entry } } }, null, 2);
    writeFileSync(join(dir, 'openclaw.json'), text);
    const r = await setupOpenclaw(b);
    expect(r.exitCode, r.stderr).toBe(0);
    const want = { command: b.bin, args: ['serve', '--surface', 'full'], env: { GBRAIN_HOME: b.home } };
    expect(r.doc.mcp.replace.command).toBe(`openclaw mcp set gbrain '${JSON.stringify(want)}'`);
    expect(readFileSync(join(dir, 'openclaw.json'), 'utf8')).toBe(text);
  }, 120_000);

  test('an entry holding other values gets only the flags to change and no runnable line, and none of its values is printed', async () => {
    for (const [extraArgs, env2] of [[[], { DATABASE_URL: 'postgresql://db.example.test/brain-secret-example' }], [[], { GBRAIN_DATABASE_URL: 'postgresql://db.example.test:5432/b-secret-example' }], [['--token', 'secret-example'], {}]] as const) {
      const b = box();
      const dir = join(b.home, '.openclaw');
      mkdirSync(dir, { recursive: true });
      const text = JSON.stringify({ mcp: { servers: { gbrain: { command: b.bin, args: ['serve', '--surface', 'starter', ...extraArgs], env: { GBRAIN_HOME: b.home, ...env2 } } } } }, null, 2);
      writeFileSync(join(dir, 'openclaw.json'), text);
      const r = await setupOpenclaw(b);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.doc.mcp.replace.command).toBeNull();
      expect(r.doc.mcp.replace).toMatchObject({ from: ['--surface', 'starter'], to: ['--surface', 'full'] });
      expect(r.stdout + r.stderr).not.toContain('secret-example');
      const t = await runCli(['setup', 'openclaw', '--gbrain-bin', b.bin], { env: { ...env(b), ...OC_ENV } });
      expect(t.stdout).toContain('change --surface starter in its args to --surface full');
      expect(t.stdout + t.stderr).not.toContain('secret-example');
      expect(t.stdout).not.toContain('openclaw mcp set gbrain');
      expect(readFileSync(join(dir, 'openclaw.json'), 'utf8')).toBe(text);
    }
  }, 240_000);

  test('an entry whose command is not gbrain, or with arguments before serve, gets only the flags to change', async () => {
    for (const make of [(b: Box) => ({ command: '/usr/bin/node', args: ['serve', '--surface', 'starter'] }), (b: Box) => ({ command: b.bin, args: ['secret-example', 'serve', '--surface', 'starter'] })]) {
      const b = box();
      mkdirSync(join(b.home, '.openclaw'), { recursive: true });
      writeFileSync(join(b.home, '.openclaw', 'openclaw.json'), JSON.stringify({ mcp: { servers: { gbrain: make(b) } } }));
      const r = await setupOpenclaw(b);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.doc.mcp.replace).toMatchObject({ command: null, from: ['--surface', 'starter'], to: ['--surface', 'full'] });
      expect(r.stdout).not.toContain('secret-example');
    }
  }, 120_000);

  test('a full, bare or missing entry gets no replacement line', async () => {
    for (const args of [['serve', '--surface', 'full'], ['serve'], null]) {
      const b = box();
      const dir = join(b.home, '.openclaw');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'openclaw.json'), JSON.stringify(args ? { mcp: { servers: { gbrain: { command: b.bin, args } } } } : {}));
      const r = await setupOpenclaw(b);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.doc.mcp.replace).toBeUndefined();
    }
  }, 180_000);
});
