/**
 * `gbrain setup hermes` registers gbrain's MCP server through Hermes's own CLI
 * (`hermes mcp add`), so no agent has to edit Hermes's protected config.yaml.
 * A fake hermes stands in for the CLI: it answers `mcp add/test/remove` the
 * way Hermes v2026.9.24 does, including rewriting config.yaml as plain YAML
 * (comments dropped), and logs every call with its stdin.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
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
if (argv[1] === 'add') {
  if (servers[name] && answers.shift() !== 'y') process.exit(0);
  const env = {}; let i = 3; const entry = {};
  for (; i < argv.length; i++) {
    if (argv[i] === '--env') { const [k, ...v] = argv[++i].split('='); env[k] = v.join('='); }
    else if (argv[i] === '--connect-timeout') entry.connect_timeout = Number(argv[++i]);
    else if (argv[i] === '--command') entry.command = argv[++i];
    else if (argv[i] === '--args') { entry.args = argv.slice(i + 1); break; }
  }
  if (answers.shift() !== 'y') { console.log('Cancelled.'); process.exit(0); }
  servers[name] = { command: entry.command, args: entry.args, env, connect_timeout: entry.connect_timeout, enabled: true };
  writeFileSync(path, dump({ ...doc, mcp_servers: servers }));
} else if (argv[1] === 'remove') {
  delete servers[name];
  const next = { ...doc, mcp_servers: servers };
  if (!Object.keys(servers).length) delete next.mcp_servers;
  writeFileSync(path, dump(next));
} else if (argv[1] === 'test') {
  process.exit(servers[name]?.enabled ? 0 : 1);
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
    HOME: home, GBRAIN_HOME: home, HERMES_HOME: undefined, FAKE_HERMES_LOG: log,
    GBRAIN_AGENT_INSTRUCTIONS: undefined, GBRAIN_SURFACE: undefined, GBRAIN_SOURCE: undefined, GBRAIN_HOOKS: '0',
  } };
}

async function setup(b: Box, args: string[]) {
  const r = await runCli(['setup', 'hermes', '--gbrain-bin', b.bin, ...args, '--json'], { env: b.env, cwd: b.root });
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
});
