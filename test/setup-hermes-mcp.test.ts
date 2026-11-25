/**
 * `gbrain setup hermes` registers gbrain's MCP server through Hermes's own CLI
 * (`hermes mcp add`), so no agent has to edit Hermes's protected config.yaml.
 * A fake hermes stands in for the CLI: it answers `mcp add/test/remove` the
 * way Hermes v2026.9.24 does, including rewriting config.yaml as plain YAML
 * (comments dropped), and logs every call with its stdin. FAKE_HERMES_MODE makes
 * it fail the way Hermes can: save-nothing (add exits 0 and writes nothing),
 * test-fails (the handshake fails), hooks (the rewrite adds its own hooks: key).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { dump, load } from 'js-yaml';
import { runCli } from './helpers/cli-spawn.ts';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli.ts');
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const FAKE_HERMES = `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dump, load } from 'JS_YAML';
const argv = process.argv.slice(2);
const home = process.env.HERMES_HOME || join(process.env.HOME, '.hermes');
const path = join(home, 'config.yaml');
const stdin = argv[1] === 'test' ? '' : readFileSync(0, 'utf8');
appendFileSync(process.env.FAKE_HERMES_LOG, JSON.stringify({ argv, stdin }) + '\\n');
const doc = existsSync(path) ? (load(readFileSync(path, 'utf8')) || {}) : {};
const servers = doc.mcp_servers || {};
const answers = stdin.split('\\n');
const name = argv[2];
const mode = process.env.FAKE_HERMES_MODE || '';
if (argv[0] === 'config' && argv[1] === 'set') {
  servers[argv[2].replace(/^mcp_servers\./, '')] = JSON.parse(argv[3]);
  writeFileSync(path, dump({ ...doc, mcp_servers: servers }));
} else if (argv[1] === 'add') {
  if (servers[name] && answers.shift() !== 'y') process.exit(0);
  const env = {}; let i = 3; const entry = {};
  for (; i < argv.length; i++) {
    if (argv[i] === '--env') { while (argv[i + 1] && !argv[i + 1].startsWith('--')) { const [k, ...v] = argv[++i].split('='); env[k] = v.join('='); } }
    else if (argv[i] === '--connect-timeout') entry.connect_timeout = Number(argv[++i]);
    else if (argv[i] === '--command') entry.command = argv[++i];
    else if (argv[i] === '--args') { entry.args = argv.slice(i + 1); break; }
  }
  if (answers.shift() !== 'y') { console.log('Cancelled.'); process.exit(0); }
  if (mode === 'save-nothing') process.exit(0);
  servers[name] = { command: entry.command, args: entry.args, env, connect_timeout: entry.connect_timeout, enabled: true };
  writeFileSync(path, dump({ ...doc, ...(mode === 'hooks' ? { hooks: {} } : {}), mcp_servers: servers }));
} else if (argv[1] === 'remove') {
  delete servers[name];
  const next = { ...doc, mcp_servers: servers };
  if (!Object.keys(servers).length) delete next.mcp_servers;
  writeFileSync(path, dump(next));
} else if (argv[1] === 'test') {
  process.exit(servers[name]?.enabled && mode !== 'test-fails' ? 0 : 1);
}
`;

interface Box { root: string; home: string; bin: string; log: string; env: Record<string, string | undefined> }

function box(opts: { hermes: boolean }): Box {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-hermes-mcp-'));
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(join(home, '.hermes'), { recursive: true });
  writeFileSync(join(home, '.hermes', 'SOUL.md'), 'You are Hermes.\n');
  writeFileSync(join(home, '.hermes', 'config.yaml'), 'model:\n  default: x\n');
  mkdirSync(join(root, 'bin'));
  const bin = join(root, 'bin', 'gbrain');
  writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${CLI}' "$@"\n`);
  chmodSync(bin, 0o755);
  const log = join(root, 'hermes.log');
  if (opts.hermes) {
    // Where Hermes's installer links it, and not on PATH: setup must still find it.
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(join(root, 'fake-hermes.mjs'), FAKE_HERMES.replace('JS_YAML', require.resolve('js-yaml')));
    const hermes = join(home, '.local', 'bin', 'hermes');
    writeFileSync(hermes, `#!/bin/sh\nexec '${process.execPath}' '${join(root, 'fake-hermes.mjs')}' "$@"\n`);
    chmodSync(hermes, 0o755);
  }
  return { root, home, bin, log, env: {
    HOME: home, GBRAIN_HOME: home, HERMES_HOME: undefined, FAKE_HERMES_LOG: log, FAKE_HERMES_MODE: undefined,
    // No host hermes: only the fake under HOME, which setup must find off PATH.
    PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
    GBRAIN_AGENT_INSTRUCTIONS: undefined, GBRAIN_SURFACE: undefined, GBRAIN_SOURCE: undefined, GBRAIN_HOOKS: '0',
  } };
}

async function setup(b: Box, args: string[], gbrainBin = b.bin) {
  const r = await runCli(['setup', 'hermes', '--gbrain-bin', gbrainBin, ...args, '--json'], { env: b.env, cwd: b.root });
  let doc: any = null;
  try { doc = JSON.parse(r.stdout); } catch { doc = null; }
  return { ...r, doc };
}

const config = (b: Box) => readFileSync(join(b.home, '.hermes', 'config.yaml'), 'utf8');
const calls = (b: Box) => (existsSync(b.log) ? readFileSync(b.log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const launcher = (b: Box) => join(b.home, '.gbrain', 'hook-launcher', 'gbrain-hook');

describe('gbrain setup hermes registers MCP through hermes mcp add', () => {
  test('registers gbrain with Hermes\'s CLI, keeps the turn-hook markers, and a re-run changes nothing', async () => {
    const b = box({ hermes: true });
    const first = await setup(b, []);
    expect(first.exitCode).toBe(0);
    expect(first.doc.mcp).toMatchObject({ setup: 'write', docs: 'docs/mcp/HERMES.md' });
    const add = calls(b).find((c) => c.argv[1] === 'add');
    expect(add.argv).toEqual(['mcp', 'add', 'gbrain', '--env', `GBRAIN_HOME=${b.home}`, '--connect-timeout', '60', '--command', launcher(b),
      '--args', b.bin, 'serve', '--surface', 'starter', '--advertise', 'verbs']);
    expect(add.stdin).toBe('y\ny\n');
    const entry = (load(config(b)) as any).mcp_servers.gbrain;
    expect(entry).toMatchObject({ command: launcher(b), enabled: true, env: { GBRAIN_HOME: b.home } });
    expect(config(b)).toContain('# gbrain:turn-rule:begin');
    const before = config(b);
    const again = await setup(b, []);
    expect(again.doc.mcp.setup).toBe('keep');
    expect(config(b)).toBe(before);
    expect(calls(b).filter((c) => c.argv[1] === 'add')).toHaveLength(1);
  });

  test('an update goes through hermes mcp add again and the marked hook block survives Hermes\'s rewrite', async () => {
    const b = box({ hermes: true });
    await setup(b, []);
    const changed = await setup(b, ['--surface', 'full']);
    expect(changed.doc.mcp.setup).toBe('write');
    const doc = load(config(b)) as any;
    expect(doc.mcp_servers.gbrain.args).toEqual([b.bin, 'serve', '--surface', 'full']);
    expect(config(b).split('\n').filter((l) => l === '# gbrain:turn-rule:begin')).toHaveLength(1);
    expect(doc.hooks.pre_llm_call).toHaveLength(1);
  });

  test('a bare re-run keeps the surface an earlier --surface chose', async () => {
    const b = box({ hermes: true });
    await setup(b, ['--surface', 'full']);
    const again = await setup(b, []);
    expect(again.doc.mcp.setup).toBe('keep');
    expect((load(config(b)) as any).mcp_servers.gbrain.args).toEqual([b.bin, 'serve', '--surface', 'full']);
    expect(calls(b).filter((c) => c.argv[1] === 'add')).toHaveLength(1);
  });

  test('a bare re-run writes the turn rule for the full surface the entry keeps', async () => {
    const b = box({ hermes: true });
    await setup(b, ['--surface', 'full']);
    await setup(b, []);
    expect(config(b)).toContain('mcp__gbrain__get_page');
  });

  test('a bare re-run writes the brain-first block and turn rule for the verbs surface the entry keeps', async () => {
    const v = box({ hermes: true });
    await setup(v, ['--surface', 'verbs']);
    const again = await setup(v, []);
    expect(again.doc.mcp.setup).toBe('keep');
    expect(readFileSync(join(v.home, '.hermes', 'SOUL.md'), 'utf8')).toContain('`recall` for what was said or decided');
    expect(config(v)).toContain('mcp__gbrain__remember');
  });

  test('a malformed config.yaml is an MCP error on a bare run, and the rest of setup still runs', async () => {
    const b = box({ hermes: true });
    writeFileSync(join(b.home, '.hermes', 'config.yaml'), 'mcp_servers: {gbrain: [a b\n');
    const r = await setup(b, []);
    expect(r.doc, r.stderr).not.toBeNull();
    expect(r.doc.mcp.setup).toBe('error');
    expect(r.doc.instructions).toBeDefined();
  });

  test('without a hermes command, setup prints the one command to run and writes no MCP entry', async () => {
    const b = box({ hermes: false });
    const r = await setup(b, []);
    expect(r.exitCode).toBe(0);
    expect(r.doc.mcp.setup).toBe('print');
    expect(r.doc.mcp.command).toContain("printf 'y\\ny\\n' | hermes mcp add gbrain");
    expect((load(config(b)) as any).mcp_servers).toBeUndefined();
  });

  test('an mcp_servers.gbrain entry gbrain did not write is left alone', async () => {
    const b = box({ hermes: true });
    writeFileSync(join(b.home, '.hermes', 'config.yaml'), 'mcp_servers:\n  gbrain:\n    url: https://brain.example/mcp\n');
    const r = await setup(b, []);
    expect(r.doc.mcp.setup).toBe('skip');
    expect(calls(b).some((c) => c.argv[1] === 'add')).toBe(false);
    expect((load(config(b)) as any).mcp_servers.gbrain).toEqual({ url: 'https://brain.example/mcp' });
  });

  test('--remove takes the entry out with hermes mcp remove', async () => {
    const b = box({ hermes: true });
    await setup(b, []);
    const r = await setup(b, ['--remove']);
    expect(r.doc.mcp.setup).toBe('remove');
    expect(calls(b).some((c) => c.argv[1] === 'remove')).toBe(true);
    expect((load(config(b)) as any)?.mcp_servers).toBeUndefined();
  });
  test('an add that saves nothing fails setup with exit 1', async () => {
    const b = box({ hermes: true });
    b.env.FAKE_HERMES_MODE = 'save-nothing';
    const r = await setup(b, []);
    expect(r.exitCode).toBe(1);
    expect(r.doc.mcp.setup).toBe('error');
    expect(r.doc.mcp.detail).toContain('did not save the requested gbrain entry');
    expect((load(config(b)) as any).mcp_servers).toBeUndefined();
  });

  test('an update whose handshake fails puts the working entry back and exits 1', async () => {
    const b = box({ hermes: true });
    await setup(b, []);
    const before = (load(config(b)) as any).mcp_servers.gbrain;
    b.env.FAKE_HERMES_MODE = 'test-fails';
    const r = await setup(b, ['--surface', 'full']);
    expect(r.exitCode).toBe(1);
    expect(r.doc.mcp.setup).toBe('error');
    expect(r.doc.mcp.detail).toContain('the previous entry was put back');
    expect(calls(b).some((c) => c.argv[0] === 'config' && c.argv[1] === 'set')).toBe(true);
    expect((load(config(b)) as any).mcp_servers.gbrain).toEqual(before);
    expect(config(b).split('\n').filter((l) => l === '# gbrain:turn-rule:begin')).toHaveLength(1);
  });

  test('a run without GBRAIN_HOME keeps the brain the entry already points at', async () => {
    const b = box({ hermes: true });
    await setup(b, []);
    const doc = load(config(b)) as any;
    doc.mcp_servers.gbrain.env.GBRAIN_HOME = '/srv/brain-example';
    writeFileSync(join(b.home, '.hermes', 'config.yaml'), dump(doc));
    b.env.GBRAIN_HOME = undefined;
    const r = await setup(b, []);
    expect(r.doc.mcp.setup).toBe('keep');
    expect(calls(b).filter((c) => c.argv[1] === 'add')).toHaveLength(1);
    expect((load(config(b)) as any).mcp_servers.gbrain.env.GBRAIN_HOME).toBe('/srv/brain-example');
  });

  test('when Hermes writes its own hooks: key, the hook block stays out instead of becoming a duplicate key', async () => {
    const b = box({ hermes: true });
    await setup(b, []);
    b.env.FAKE_HERMES_MODE = 'hooks';
    const r = await setup(b, ['--surface', 'full']);
    expect(r.doc.mcp.setup).toBe('write');
    expect(config(b).split('\n').filter((l) => /^hooks\s*:/.test(l))).toHaveLength(1);
    expect(() => load(config(b))).not.toThrow();
  });

  test('--dry-run names the command and calls nothing', async () => {
    const b = box({ hermes: true });
    const r = await setup(b, ['--dry-run']);
    expect(r.doc.mcp.setup).toBe('write');
    expect(r.doc.mcp.detail).toContain('would register MCP server gbrain');
    expect(calls(b)).toHaveLength(0);
    expect((load(config(b)) as any).mcp_servers).toBeUndefined();
  });

  test('a relative --gbrain-bin is never registered', async () => {
    const b = box({ hermes: true });
    const r = await setup(b, [], 'gbrain');
    expect(r.doc.mcp.setup).toBe('print');
    expect(calls(b)).toHaveLength(0);
  });

  test('--instructions-only leaves Hermes\'s MCP config alone', async () => {
    const b = box({ hermes: true });
    const r = await setup(b, ['--instructions-only']);
    expect(r.doc.mcp.setup).toBe('unchanged');
    expect(calls(b)).toHaveLength(0);
    expect((load(config(b)) as any).mcp_servers).toBeUndefined();
  });
  test('an update keeps the member binding and connect timeout', async () => {
    const b = box({ hermes: true });
    await setup(b, []);
    const doc = load(config(b)) as any;
    doc.mcp_servers.gbrain.args.push('--stdio-member', 'alice-example');
    doc.mcp_servers.gbrain.connect_timeout = 120;
    writeFileSync(join(b.home, '.hermes', 'config.yaml'), dump(doc));
    const r = await setup(b, ['--surface', 'full']);
    expect(r.doc.mcp.setup).toBe('write');
    const entry = (load(config(b)) as any).mcp_servers.gbrain;
    expect(entry.args).toEqual([b.bin, 'serve', '--surface', 'full', '--stdio-member', 'alice-example']);
    expect(entry.connect_timeout).toBe(120);
  });

  test('an entry with environment beyond GBRAIN_HOME is left alone, so no value travels on a command line', async () => {
    const b = box({ hermes: true });
    await setup(b, []);
    const doc = load(config(b)) as any;
    doc.mcp_servers.gbrain.env.GBRAIN_DATABASE_URL = 'postgresql://brain.example/db';
    writeFileSync(join(b.home, '.hermes', 'config.yaml'), dump(doc));
    const r = await setup(b, ['--surface', 'full']);
    expect(r.doc.mcp.setup).toBe('skip');
    expect(r.doc.mcp.detail).toContain('env GBRAIN_DATABASE_URL');
    expect(calls(b).filter((c) => c.argv[1] === 'add')).toHaveLength(1);
    expect(calls(b).some((c) => c.argv.some((a: string) => a.includes('brain.example')))).toBe(false);
    expect((load(config(b)) as any).mcp_servers.gbrain.env.GBRAIN_DATABASE_URL).toBe('postgresql://brain.example/db');
  });

  test('an entry with settings hermes mcp add would drop is left alone', async () => {
    const b = box({ hermes: true });
    await setup(b, []);
    const doc = load(config(b)) as any;
    doc.mcp_servers.gbrain.tools = { include: ['recall'] };
    writeFileSync(join(b.home, '.hermes', 'config.yaml'), dump(doc));
    const r = await setup(b, ['--surface', 'full']);
    expect(r.doc.mcp.setup).toBe('skip');
    expect(r.doc.mcp.detail).toContain('tools');
    expect(calls(b).filter((c) => c.argv[1] === 'add')).toHaveLength(1);
    expect((load(config(b)) as any).mcp_servers.gbrain.tools).toEqual({ include: ['recall'] });
  });

  test('an update that Hermes does not save is an error, not a success', async () => {
    const b = box({ hermes: true });
    await setup(b, []);
    b.env.FAKE_HERMES_MODE = 'save-nothing';
    const r = await setup(b, ['--surface', 'full']);
    expect(r.exitCode).toBe(1);
    expect(r.doc.mcp.setup).toBe('error');
    expect((load(config(b)) as any).mcp_servers.gbrain.args).toEqual([b.bin, 'serve', '--surface', 'starter', '--advertise', 'verbs']);
  });
});
