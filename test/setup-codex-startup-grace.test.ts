/**
 * GST-3901: Codex (0.147+) gives MCP servers not marked `required` one shared 1 s window to start when it builds a
 * turn's tool list, and leaves out every server still starting for the whole of a `codex exec`. `gbrain serve` answers
 * initialize and tools/list in about 0.8 s on a fast machine, so on a slower one a Codex session ran without any gbrain
 * tool (the install canary's codex recall: NO_GBRAIN_TOOL). `mcp_optional_startup_grace_ms = 0` makes Codex wait for
 * each server up to its startup_timeout_sec.
 *
 * 1. Protects: `gbrain setup codex` sets the key to 0 at the top level of config.toml and records that it did; a re-run
 *    of an install from before the key adds it; a value the user set is kept and never removed; `--remove` deletes only
 *    setup's own 0 and leaves every other setting as it was.
 * 2. Fails when: setup leaves the key unset, overwrites or removes a user's value, or --remove leaves its own key behind.
 * 3. Real seams: the CLI (`bun src/cli.ts setup codex`) against a temp HOME, its config.toml and receipt; the TOML
 *    helpers against real files.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli, type CliResult } from './helpers/cli-spawn.ts';
import { prependCodexTomlTopLevelInt, removeCodexTomlTopLevelInt } from '../src/core/bootstrap/codex-toml.ts';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli.ts');
const KEY = 'mcp_optional_startup_grace_ms';
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

interface Box { root: string; home: string; bin: string }
function box(): Box {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-setup-grace-'));
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
async function setup(b: Box, args: string[]): Promise<CliResult & { doc: any }> {
  const r = await runCli(['setup', 'codex', ...args, '--json', '--gbrain-bin', b.bin], { env: { ...CLEAN, HOME: b.home, GBRAIN_HOME: b.home } });
  let doc: any = null;
  try { doc = JSON.parse(r.stdout); } catch { doc = null; }
  return { ...r, doc };
}
const tomlPath = (b: Box) => join(b.home, '.codex', 'config.toml');
const toml = (b: Box): any => Bun.TOML.parse(readFileSync(tomlPath(b), 'utf8'));
const receiptPath = (b: Box) => join(b.home, '.codex', '.gbrain-connection-codex-gbrain.json');
const receipt = (b: Box): any => JSON.parse(readFileSync(receiptPath(b), 'utf8'));

describe('gbrain setup codex: Codex waits for gbrain to start (GST-3901)', () => {
  test('a new install sets mcp_optional_startup_grace_ms = 0 at the top level and records it; --remove deletes it', async () => {
    const b = box();
    mkdirSync(join(b.home, '.codex'), { recursive: true });
    writeFileSync(tomlPath(b), 'model = "gpt-example"\n\n[mcp_servers.other]\ncommand = "other"\n');
    const r = await setup(b, []);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(toml(b)[KEY]).toBe(0);
    expect(toml(b).mcp_servers.gbrain).toBeDefined();
    expect(receipt(b).startup_grace).toBe('written');
    expect(r.doc.steps).toContainEqual(expect.objectContaining({ step: 'mcp', action: 'write', detail: expect.stringContaining(KEY) }));
    const again = await setup(b, []);
    expect(again.exitCode, again.stderr).toBe(0);
    expect(again.doc.steps.map((s: any) => [s.step, s.action])).toEqual([['receipt', 'keep'], ['mcp', 'keep'], ['hooks', 'keep'], ['trust', 'keep']]);
    const removed = await setup(b, ['--remove']);
    expect(removed.exitCode, removed.stderr).toBe(0);
    expect(toml(b)).toEqual({ model: 'gpt-example', mcp_servers: { other: { command: 'other' } } });
  }, 240_000);

  test('a re-run of an install made before the key adds it', async () => {
    const b = box();
    expect((await setup(b, [])).exitCode).toBe(0);
    expect(removeCodexTomlTopLevelInt(tomlPath(b), KEY, 0)).toBe('removed');
    const r = receipt(b); delete r.startup_grace; writeFileSync(receiptPath(b), JSON.stringify(r, null, 2));
    const again = await setup(b, []);
    expect(again.exitCode, again.stderr).toBe(0);
    expect(toml(b)[KEY]).toBe(0);
    expect(receipt(b).startup_grace).toBe('written');
  }, 240_000);

  test('a value the user set is kept, named, and never removed', async () => {
    const b = box();
    mkdirSync(join(b.home, '.codex'), { recursive: true });
    writeFileSync(tomlPath(b), `${KEY} = 2500\n`);
    const r = await setup(b, []);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(toml(b)[KEY]).toBe(2500);
    expect(receipt(b).startup_grace).toBeUndefined();
    expect(r.doc.steps).toContainEqual(expect.objectContaining({ step: 'mcp', action: 'preserve', detail: expect.stringContaining(`${KEY} = 2500`) }));
    expect((await setup(b, ['--remove'])).exitCode).toBe(0);
    expect(toml(b)[KEY]).toBe(2500);
  }, 240_000);

  test('a 0 the user set before setup is never recorded as setup\'s or removed', async () => {
    const b = box();
    mkdirSync(join(b.home, '.codex'), { recursive: true });
    writeFileSync(tomlPath(b), `${KEY} = 0\n`);
    expect((await setup(b, [])).exitCode).toBe(0);
    expect(receipt(b).startup_grace).toBeUndefined();
    expect((await setup(b, ['--remove'])).exitCode).toBe(0);
    expect(toml(b)[KEY]).toBe(0);
  }, 240_000);

  test('--dry-run lists the write, and removing one named install keeps the key while another still uses it', async () => {
    const b = box();
    const dry = await setup(b, ['--dry-run']);
    expect(dry.exitCode, dry.stderr).toBe(0);
    expect(dry.doc.steps).toContainEqual(expect.objectContaining({ step: 'mcp', action: 'write', detail: expect.stringContaining(KEY) }));
    expect((await setup(b, [])).exitCode).toBe(0);
    const second = await setup(b, ['--name', 'gbrain-2', '--no-hooks']);
    expect(second.exitCode, second.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(b.home, '.codex', '.gbrain-connection-codex-gbrain-2.json'), 'utf8')).startup_grace).toBe('written');
    const first = await setup(b, ['--remove']);
    expect(first.exitCode, first.stderr).toBe(0);
    expect(toml(b)[KEY]).toBe(0);
    expect((await setup(b, ['--remove', '--name', 'gbrain-2'])).exitCode).toBe(0);
    expect(toml(b)[KEY]).toBeUndefined();
  }, 300_000);
});

describe('top-level TOML key helpers', () => {
  const file = (text: string) => { const d = mkdtempSync(join(tmpdir(), 'gbrain-toml-top-')); roots.push(d); const p = join(d, 'config.toml'); writeFileSync(p, text); return p; };
  test('prepend lands above every table and a multi-line string, and removal restores the file exactly', () => {
    const text = 'notes = """\n[not.a.table]\n"""\n\n[mcp_servers.a]\ncommand = "a"\n';
    const p = file(text);
    prependCodexTomlTopLevelInt(p, KEY, 0, 'gbrain setup (gbrain): test');
    expect(Bun.TOML.parse(readFileSync(p, 'utf8'))).toEqual({ [KEY]: 0, notes: '[not.a.table]\n', mcp_servers: { a: { command: 'a' } } });
    expect(() => prependCodexTomlTopLevelInt(p, KEY, 0)).toThrow('already sets');
    expect(removeCodexTomlTopLevelInt(p, KEY, 0)).toBe('removed');
    expect(readFileSync(p, 'utf8')).toBe(text);
  });
  test('a config that starts with a byte-order mark keeps it at the front, through prepend and removal', () => {
    const text = '\uFEFFmodel = "x"\n';
    const p = file(text);
    prependCodexTomlTopLevelInt(p, KEY, 0, 'gbrain setup (gbrain): test');
    expect(readFileSync(p, 'utf8').startsWith('\uFEFF# gbrain setup')).toBe(true);
    expect(Bun.TOML.parse(readFileSync(p, 'utf8'))).toEqual({ [KEY]: 0, model: 'x' });
    expect(removeCodexTomlTopLevelInt(p, KEY, 0)).toBe('removed');
    expect(readFileSync(p, 'utf8')).toBe(text);
  });
  test('removal refuses a key set inside a table or with another value', () => {
    expect(removeCodexTomlTopLevelInt(file(`${KEY} = 5\n`), KEY, 0)).toBe('unlocatable');
    expect(removeCodexTomlTopLevelInt(file(`[t]\n${KEY} = 0\n`), KEY, 0)).toBe('absent');
  });
});
