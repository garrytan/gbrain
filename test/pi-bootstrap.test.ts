/**
 * `gbrain bootstrap <hooks|status|verify|uninstall> --harness pi`: the pi
 * mcp.json entry writer (stdio + HTTP `!command` auth, foreign-entry and
 * unparseable-file refusal, unrelated servers byte-preserved), the lane's
 * install / status / verify / uninstall round trip through the path seams,
 * flag validation, and the real dispatcher routing `--harness pi` ahead of
 * workspace resolution against a temp HOME + PI_CODING_AGENT_DIR.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPiMcpEntry,
  PI_MCP_DESCRIPTION,
  readPiMcpStatus,
  removePiMcpEntry,
  writePiMcpEntry,
} from '../src/core/bootstrap/pi-mcp.ts';
import { runPiBootstrap } from '../src/core/bootstrap/pi-bootstrap.ts';
import { runBootstrap } from '../src/commands/bootstrap.ts';
import { readPiHooksStatus } from '../src/core/bootstrap/pi-hooks.ts';
import { withEnv } from './helpers/with-env.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gb-pi-boot-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// The live-box shape: a hand-made HTTP entry with a Keychain `!command` bearer.
const HAND_MADE = {
  mcpServers: {
    gbrain: {
      url: 'http://127.0.0.1:3131/mcp',
      headers: { Authorization: '!echo Bearer $(security find-generic-password -s example -w)' },
      description: 'gbrain personal knowledge brain',
    },
    exa: { url: 'https://mcp.example.com/mcp' },
  },
};

describe('pi mcp.json writer', () => {
  test('stdio entry: absolute bin, starter surface, optional source; http entry: !command auth', () => {
    expect(buildPiMcpEntry({ kind: 'stdio', gbrainBin: '/opt/gbrain', sourceId: 'wiki' })).toEqual({
      command: '/opt/gbrain', args: ['serve', '--surface', 'starter'], env: { GBRAIN_SOURCE: 'wiki' }, description: PI_MCP_DESCRIPTION,
    });
    expect(buildPiMcpEntry({ kind: 'http', url: 'http://127.0.0.1:3131/mcp', authCommand: 'echo Bearer $(cat ~/.tok)' })).toEqual({
      url: 'http://127.0.0.1:3131/mcp', headers: { Authorization: '!echo Bearer $(cat ~/.tok)' }, description: PI_MCP_DESCRIPTION,
    });
    expect(() => buildPiMcpEntry({ kind: 'stdio', gbrainBin: 'gbrain' })).toThrow();
    expect(() => buildPiMcpEntry({ kind: 'http', url: 'file:///x' })).toThrow();
  });

  test('fresh file → written 0600; re-run unchanged; remove drops only ours and keeps other servers', () => {
    const path = join(dir, 'mcp.json');
    writeFileSync(path, JSON.stringify({ mcpServers: { exa: { url: 'https://mcp.example.com/mcp' } }, extra: 1 }, null, 2));
    const w = writePiMcpEntry({ spec: { kind: 'stdio', gbrainBin: '/opt/gbrain' }, path });
    expect(w).toMatchObject({ ok: true, changed: true, replacedPrior: false });
    const cfg = JSON.parse(readFileSync(path, 'utf8'));
    expect(cfg.extra).toBe(1);
    expect(cfg.mcpServers.exa).toEqual({ url: 'https://mcp.example.com/mcp' });
    expect(cfg.mcpServers.gbrain.description).toBe(PI_MCP_DESCRIPTION);
    expect(writePiMcpEntry({ spec: { kind: 'stdio', gbrainBin: '/opt/gbrain' }, path })).toMatchObject({ ok: true, changed: false });
    expect(readPiMcpStatus({ path })).toMatchObject({ present: true, owned: true, kind: 'stdio', command: '/opt/gbrain' });
    expect(removePiMcpEntry({ path }).removed).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ mcpServers: { exa: { url: 'https://mcp.example.com/mcp' } }, extra: 1 });
  });

  test('a hand-made gbrain entry is never replaced or removed', () => {
    const path = join(dir, 'mcp.json');
    const before = JSON.stringify(HAND_MADE, null, 2);
    writeFileSync(path, before);
    const w = writePiMcpEntry({ spec: { kind: 'stdio', gbrainBin: '/opt/gbrain' }, path });
    expect(w.ok).toBe(false);
    expect(!w.ok && w.reason).toBe('foreign_entry');
    expect(removePiMcpEntry({ path }).removed).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(readPiMcpStatus({ path })).toMatchObject({ present: true, owned: false, kind: 'http', url: 'http://127.0.0.1:3131/mcp' });
  });

  test('an unparseable file is never rewritten', () => {
    const path = join(dir, 'mcp.json');
    writeFileSync(path, '{ not json');
    const w = writePiMcpEntry({ spec: { kind: 'stdio', gbrainBin: '/opt/gbrain' }, path });
    expect(!w.ok && w.reason).toBe('unparseable');
    expect(readFileSync(path, 'utf8')).toBe('{ not json');
  });
});

function fakeBin(): string {
  const p = join(dir, 'bin', 'gbrain');
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(p, '#!/bin/sh\nexit 0\n');
  chmodSync(p, 0o755);
  return p;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { log: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
}

describe('runPiBootstrap (path seams)', () => {
  test('hooks → status/verify healthy → uninstall → verify fails', async () => {
    const bin = fakeBin();
    const seams = { extensionPath: join(dir, 'agent', 'extensions', 'gbrain-hooks.ts'), mcpPath: join(dir, 'agent', 'mcp.json') };
    const c = capture();
    expect(await runPiBootstrap('hooks', ['--harness', 'pi', '--gbrain-bin', bin, '--source', 'wiki', '--seat', 'laptop'], { ...c.deps, ...seams })).toBe(0);
    expect(readPiHooksStatus({ path: seams.extensionPath })).toMatchObject({
      owned: true, gbrainBin: bin, env: { GBRAIN_HOOK_LANE: 'pi', GBRAIN_SOURCE: 'wiki', GBRAIN_SEAT: 'laptop' },
    });
    expect(readPiMcpStatus({ path: seams.mcpPath })).toMatchObject({ owned: true, kind: 'stdio', command: bin });

    const s = capture();
    expect(await runPiBootstrap('verify', ['--json'], { ...s.deps, ...seams })).toBe(0);
    const report = JSON.parse(s.out.join('\n'));
    expect(report.healthy).toBe(true);
    expect(report.hooks.binExecutable).toBe(true);

    const u = capture();
    expect(await runPiBootstrap('uninstall', [], { ...u.deps, ...seams })).toBe(0);
    expect(existsSync(seams.extensionPath)).toBe(false);
    expect(readPiMcpStatus({ path: seams.mcpPath }).present).toBe(false);
    const v = capture();
    expect(await runPiBootstrap('verify', [], { ...v.deps, ...seams })).toBe(1);
    expect(await runPiBootstrap('status', [], { ...capture().deps, ...seams })).toBe(0);
  });

  test('a hand-made gbrain MCP entry: hooks still install, the entry is kept, exit 0, verify healthy', async () => {
    const bin = fakeBin();
    const seams = { extensionPath: join(dir, 'ext', 'gbrain-hooks.ts'), mcpPath: join(dir, 'mcp.json') };
    writeFileSync(seams.mcpPath, JSON.stringify(HAND_MADE, null, 2));
    const c = capture();
    expect(await runPiBootstrap('hooks', ['--gbrain-bin', bin], { ...c.deps, ...seams })).toBe(0);
    expect(c.err.join('\n')).toContain('did not write');
    expect(JSON.parse(readFileSync(seams.mcpPath, 'utf8'))).toEqual(HAND_MADE);
    expect(await runPiBootstrap('verify', [], { ...capture().deps, ...seams })).toBe(0);
    // Uninstall removes the extension, leaves the hand-made entry.
    await runPiBootstrap('uninstall', [], { ...capture().deps, ...seams });
    expect(JSON.parse(readFileSync(seams.mcpPath, 'utf8'))).toEqual(HAND_MADE);
  });

  test('a foreign extension file is a failure (exit 1) and stays untouched; --url writes the http form', async () => {
    const bin = fakeBin();
    const seams = { extensionPath: join(dir, 'gbrain-hooks.ts'), mcpPath: join(dir, 'mcp.json') };
    writeFileSync(seams.extensionPath, '// interim bridge\n');
    const c = capture();
    expect(await runPiBootstrap('hooks', ['--gbrain-bin', bin, '--url', 'http://127.0.0.1:3131/mcp', '--mcp-auth-command', 'echo Bearer x'], { ...c.deps, ...seams })).toBe(1);
    expect(readFileSync(seams.extensionPath, 'utf8')).toBe('// interim bridge\n');
    expect(readPiMcpStatus({ path: seams.mcpPath })).toMatchObject({ owned: true, kind: 'http', url: 'http://127.0.0.1:3131/mcp' });
  });

  test('flag validation', async () => {
    const bin = fakeBin();
    const seams = { extensionPath: join(dir, 'e.ts'), mcpPath: join(dir, 'm.json') };
    for (const bad of [['--source', 'Bad Source'], ['--seat', '!!'], ['--surface', 'huge'], ['--mcp-auth-command', 'x'], ['--gbrain-bin', 'relative/gbrain']]) {
      expect(await runPiBootstrap('hooks', bad[0] === '--gbrain-bin' ? bad : ['--gbrain-bin', bin, ...bad], { ...capture().deps, ...seams })).toBe(2);
    }
    expect(existsSync(seams.extensionPath)).toBe(false);
    expect(await runPiBootstrap('hooks', ['--no-hooks', '--no-mcp', '--gbrain-bin', bin], { ...capture().deps, ...seams })).toBe(0);
    expect(existsSync(seams.extensionPath) || existsSync(seams.mcpPath)).toBe(false);
  });
});

describe('runBootstrap dispatch', () => {
  test('`bootstrap hooks --harness pi` writes under PI_CODING_AGENT_DIR from $HOME (no workspace needed)', async () => {
    const bin = fakeBin();
    const agentDir = join(dir, 'pi-agent');
    await withEnv({ HOME: dir, PI_CODING_AGENT_DIR: agentDir, GBRAIN_HOME: join(dir, 'gbrain-home') }, async () => {
      // Routed before workspace resolution: the cwd (here the repo) is never read.
      expect(await runBootstrap(['hooks', '--harness', 'pi', '--gbrain-bin', bin])).toBe(0);
      expect(readPiHooksStatus({ path: join(agentDir, 'extensions', 'gbrain-hooks.ts') }).owned).toBe(true);
      expect(readPiMcpStatus({ path: join(agentDir, 'mcp.json') }).owned).toBe(true);
      expect(await runBootstrap(['verify', '--harness', 'pi'])).toBe(0);
      expect(await runBootstrap(['uninstall', '--harness', 'pi'])).toBe(0);
      expect(existsSync(join(agentDir, 'extensions', 'gbrain-hooks.ts'))).toBe(false);
    });
  });
});

describe('gbrain connect --harness pi --install (pi-json adapter)', () => {
  test('writes an HTTP mcpServers entry into the pi config, keeps other servers, removes only its own', async () => {
    const { installHarnessConnection } = await import('../src/core/harness/install.ts');
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'gb-pi-connect-'));
    try {
      const configPath = join(root, 'mcp.json');
      writeFileSync(configPath, JSON.stringify({ mcpServers: { exa: { url: 'https://mcp.example.com/mcp' } } }, null, 2));
      const creds = { version: 1 as const, mcp_url: 'https://brain.example.com/mcp', issuer_url: 'https://brain.example.com', client_id: 'gbrain_cl_pi_fixture', client_secret: 'fixture-secret-not-real', access_token: 'fixture-token-not-real', profile: 'memory-writer' };
      const res = await installHarnessConnection(creds, { harness: 'pi', configPath });
      expect(res.status).toBe('installed');
      const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(cfg.mcpServers.exa).toEqual({ url: 'https://mcp.example.com/mcp' });
      expect(cfg.mcpServers.gbrain).toEqual({ type: 'http', url: 'https://brain.example.com/mcp', headers: { Authorization: 'Bearer fixture-token-not-real' } });
      await installHarnessConnection(creds, { harness: 'pi', configPath, remove: true });
      expect(JSON.parse(readFileSync(configPath, 'utf8')).mcpServers).toEqual({ exa: { url: 'https://mcp.example.com/mcp' } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('routesToPiBootstrap', () => {
  test('--harness pi routes every pi subcommand; bare `hooks` inside pi routes only when no other agent is detected', async () => {
    const { routesToPiBootstrap } = await import('../src/core/bootstrap/pi-bootstrap.ts');
    const inPi = { PI_CODING_AGENT: 'true' };
    for (const sub of ['hooks', 'status', 'verify', 'uninstall']) expect(routesToPiBootstrap(sub, 'pi', false, {})).toBe(true);
    expect(routesToPiBootstrap('render', 'pi', false, inPi)).toBe(false);
    expect(routesToPiBootstrap('hooks', undefined, false, inPi)).toBe(true);
    expect(routesToPiBootstrap('hooks', undefined, true, inPi)).toBe(false); // Claude Code/Codex/opencode marker wins
    expect(routesToPiBootstrap('hooks', 'codex', false, inPi)).toBe(false);
    expect(routesToPiBootstrap('status', undefined, false, inPi)).toBe(false); // workspace status stays the default
    expect(routesToPiBootstrap('hooks', undefined, false, {})).toBe(false);
  });
});
