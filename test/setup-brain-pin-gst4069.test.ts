/**
 * GST-4069: the Claude Code and Codex registrations pin the brain setup labelled the people on.
 *
 * 1. Protects: a `gbrain setup claude-code|codex --serves several` run from a directory inside a mount labels that mount,
 *    and its registration carries GBRAIN_BRAIN_ID, so a session started from any other directory opens the same brain;
 *    a later run from another directory keeps the pin and labels the same brain; a registration that labels nobody
 *    and names no brain stays unpinned; `--brain <mount> setup --shape household --status` reads that mount, and a
 *    household receipt written on a mount is not the host's.
 * 2. Fails when: the registration leaves the brain to the session's directory after labelling people, a re-run from
 *    another directory labels or pins another brain, or an unlabelled registration gains a pin.
 * 3. Existing coverage: setup-serves-gst4043.test.ts (which brain the labelling children open).
 * 4. Real seams: `bun src/cli.ts setup` spawned against a temp HOME / GBRAIN_HOME with PGLite brains, and the registered
 *    stdio entry started from another directory over the MCP SDK's stdio client.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createEngine } from '../src/core/engine-factory.ts';
import { readCodexTomlTable } from '../src/core/bootstrap/codex-toml.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { box, CLEAN, gbrain, removeTempDirs, ROSTER, type Box } from './helpers/setup-serves-box.ts';

afterAll(removeTempDirs);

const CANARY = 'notes/mount-canary';

/** A box with a host brain, a mount `example-mount` holding CANARY, a project directory whose .gbrain-mount names it, and a directory with none. */
async function mountBox(): Promise<{ b: Box; env: Record<string, string | undefined>; project: string; elsewhere: string; mountDb: string }> {
  const b = box();
  expect((await gbrain(b, ['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
  const mountDb = join(b.root, 'mount.pglite');
  const mount = await createEngine({ engine: 'pglite', database_path: mountDb });
  await mount.connect({ engine: 'pglite', database_path: mountDb });
  await mount.initSchema();
  await mount.disconnect();
  const mountsPath = join(b.home, '.gbrain', 'mounts.json');
  writeFileSync(mountsPath, JSON.stringify({ version: 1, mounts: [{ id: 'example-mount', path: join(b.root, 'mount-clone'), engine: 'pglite', database_path: mountDb, enabled: true }] }), { mode: 0o600 });
  const env = { ...CLEAN, HOME: b.home, GBRAIN_HOME: b.home, GBRAIN_MOUNTS_PATH: mountsPath, CODEX_HOME: join(b.home, '.codex'), OPENCLAW_STATE_DIR: join(b.root, 'openclaw-state'), OPENCLAW_PROFILE: undefined, HERMES_HOME: join(b.root, 'hermes-home') };
  const put = await runCli(['--brain', 'example-mount', 'put', CANARY, '--content', '---\ntitle: mount canary\n---\n# mount canary\n\nOnly the mount holds this page.\n'], { env, timeoutMs: 120_000 });
  expect(put.exitCode, put.stdout + put.stderr).toBe(0);
  const project = join(b.root, 'project');
  const elsewhere = join(b.root, 'elsewhere');
  mkdirSync(project, { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(project, '.gbrain-mount'), 'example-mount\n');
  chmodSync(join(project, '.gbrain-mount'), 0o644);
  return { b, env, project, elsewhere, mountDb };
}

const setupIn = (env: Record<string, string | undefined>, cwd: string, b: Box, args: string[]) =>
  runCli(['setup', ...args, '--json', '--gbrain-bin', b.bin], { env, cwd, timeoutMs: 240_000 });

async function mountMembers(mountDb: string): Promise<string[]> {
  const m = await createEngine({ engine: 'pglite', database_path: mountDb });
  await m.connect({ engine: 'pglite', database_path: mountDb });
  try { return (await m.executeRaw<{ id: string }>('SELECT id FROM access_members ORDER BY id')).map(r => r.id); } finally { await m.disconnect(); }
}

/** Start a registered stdio entry the way the harness does, from `cwd`, and read CANARY through it. */
async function sessionReadsCanary(entry: { command: string; args: string[]; env?: Record<string, string> }, env: Record<string, string | undefined>, cwd: string): Promise<boolean> {
  const base = Object.fromEntries(Object.entries({ ...process.env, ...env }).filter((kv): kv is [string, string] => kv[1] !== undefined));
  const transport = new StdioClientTransport({ command: entry.command, args: entry.args, env: { ...base, ...(entry.env ?? {}) }, cwd, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  const client = new Client({ name: 'gst4069', version: '1' }, { capabilities: {} });
  try {
    await client.connect(transport);
    const r = await client.callTool({ name: 'get_page', arguments: { slug: CANARY } });
    const text = (r.content as Array<{ text: string }>)[0]?.text ?? '';
    return r.isError !== true && text.includes('Only the mount holds this page');
  } catch (e) {
    throw new Error(`${(e as Error).message}\nserve stderr: ${stderr}`);
  } finally {
    await client.close().catch(() => {});
  }
}

const claudeEntry = (b: Box) => JSON.parse(readFileSync(join(b.home, '.claude.json'), 'utf8')).mcpServers.gbrain as { command: string; args: string[]; env: Record<string, string> };
const claudeReceipt = (b: Box) => JSON.parse(readFileSync(join(b.home, '.gbrain-connection-claude-code-gbrain.json'), 'utf8'));

describe('gbrain setup pins the labelled brain in the registration (GST-4069)', () => {
  test('claude-code: set up from a mount directory, a session started elsewhere reaches the labelled mount; a re-run elsewhere keeps it', async () => {
    const { b, env, project, elsewhere, mountDb } = await mountBox();
    const first = await setupIn(env, project, b, ['claude-code', '--serves', 'several', '--members', ROSTER.join(','), '--open-history']);
    expect(first.exitCode, first.stdout + first.stderr).toBe(0);
    expect(await mountMembers(mountDb)).toEqual(expect.arrayContaining(ROSTER));
    expect(claudeEntry(b).env.GBRAIN_BRAIN_ID).toBe('example-mount');
    expect(claudeReceipt(b).brain_id).toBe('example-mount');
    expect(await sessionReadsCanary(claudeEntry(b), env, elsewhere)).toBe(true);

    const again = await setupIn(env, elsewhere, b, ['claude-code', '--serves', 'several', '--members', ROSTER.join(','), '--open-history']);
    expect(again.exitCode, again.stdout + again.stderr).toBe(0);
    expect(JSON.parse(again.stdout).target.brain.id).toBe('example-mount');
    expect(claudeEntry(b).env.GBRAIN_BRAIN_ID).toBe('example-mount');
    const host = await gbrain(b, ['access', 'serves', '--json']);
    expect(JSON.parse(host.stdout).enabled_members, host.stdout + host.stderr).toEqual([]);
  }, 600_000);

  test('codex: set up from a mount directory, a session started elsewhere reaches the labelled mount', async () => {
    const { b, env, project, elsewhere, mountDb } = await mountBox();
    const r = await setupIn(env, project, b, ['codex', '--serves', 'several', '--members', ROSTER.join(','), '--open-history']);
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    expect(await mountMembers(mountDb)).toEqual(expect.arrayContaining(ROSTER));
    const table = readCodexTomlTable(join(b.home, '.codex', 'config.toml'), ['mcp_servers', 'gbrain']) as { command: string; args: string[]; env: Record<string, string> };
    expect(table.env.GBRAIN_BRAIN_ID).toBe('example-mount');
    expect(await sessionReadsCanary(table, env, elsewhere)).toBe(true);
  }, 600_000);

  test('RT1: --brain <mount> household --status reads the mount, and a status on the host never reads the mount receipt', async () => {
    const { b, env, elsewhere } = await mountBox();
    const onMount = (args: string[]) => runCli(['--brain', 'example-mount', 'setup', 'claude-code', '--shape', 'household', ...args, '--json', '--gbrain-bin', b.bin], { env, cwd: elsewhere, timeoutMs: 240_000 });
    const applied = await onMount(['--owner', 'alice-example', '--yes']);
    expect(applied.exitCode, applied.stdout + applied.stderr).toBe(0);
    const status = await onMount(['--status']);
    expect(status.exitCode, status.stdout + status.stderr).toBe(0);
    expect(JSON.parse(status.stdout).complete).toBe(true);
    const host = await setupIn(env, elsewhere, b, ['claude-code', '--shape', 'household', '--status']);
    expect(host.exitCode).not.toBe(0);
    expect(host.stdout + host.stderr).toContain('setup_receipt_not_found');
  }, 600_000);

  test('a registration that labels nobody and names no brain stays unpinned', async () => {
    const { b, env, project } = await mountBox();
    const r = await setupIn(env, project, b, ['claude-code']);
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    expect(claudeEntry(b).env.GBRAIN_BRAIN_ID).toBeUndefined();
    expect(claudeReceipt(b).brain_id).toBeUndefined();
  }, 600_000);
});
