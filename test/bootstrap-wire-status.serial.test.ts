import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBootstrap } from '../src/commands/bootstrap.ts';
import { writeReceipt, type InstallReceipt } from '../src/core/bootstrap/format.ts';
import { statusReport } from '../src/core/bootstrap/status.ts';
import { uninstallWorkspace } from '../src/core/bootstrap/uninstall.ts';
import {
  adoptedConnectionsPath,
  fingerprintCodexEffectiveConfig,
  probeCodexProjectMcp,
  readCodexProjectConfig,
  readAdoptedConnectionsState,
  writeAdoptedConnection,
} from '../src/core/bootstrap/wire.ts';
import type { ExecRunner } from '../src/core/bootstrap/repo.ts';

const roots: string[] = [];
const savedHome = process.env.GBRAIN_HOME;
const savedPath = process.env.PATH;

function fixture(): { root: string; ws: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'gb-wire-'));
  roots.push(root);
  const ws = join(root, 'workspace');
  const home = join(root, '.gbrain');
  mkdirSync(join(ws, '.codex'), { recursive: true });
  mkdirSync(join(home, 'bootstrap'), { recursive: true });
  process.env.GBRAIN_HOME = root;
  return { root, ws, home };
}

function configure(ws: string, name = 'example.project.oauth'): void {
  writeFileSync(
    join(ws, '.codex', 'config.toml'),
    `[mcp_servers."${name}"]\nurl = "https://service.invalid/mcp"\n`,
  );
}

function result(value: unknown): Awaited<ReturnType<ExecRunner>> {
  return { code: 0, stdout: JSON.stringify(value), stderr: '' };
}

afterEach(() => {
  if (savedHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = savedHome;
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('project-scoped Codex wire adoption', () => {
  test('absent project table is not configured and never invokes Codex', async () => {
    const { ws } = fixture();
    let calls = 0;
    const probe = await probeCodexProjectMcp(ws, 'example.project.oauth', async () => {
      calls += 1;
      return result({});
    });
    expect(probe).toEqual({ configured: false, cli_readable: false });
    expect(calls).toBe(0);
  });

  test('effective-config probe uses the exact workspace-scoped Codex argv', async () => {
    const { ws } = fixture();
    configure(ws);
    const calls: string[][] = [];
    const probe = await probeCodexProjectMcp(ws, 'example.project.oauth', async (argv) => {
      calls.push(argv);
      return result({ enabled: true, url: 'https://service.invalid/mcp' });
    });
    expect(probe.cli_readable).toBe(true);
    expect(calls).toEqual([['codex', '-C', ws, 'mcp', 'get', 'example.project.oauth', '--json']]);
  });

  test('default Codex probe terminates and reaps a child that ignores SIGTERM', async () => {
    const { root, ws } = fixture();
    configure(ws);
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const pidFile = join(root, 'codex.pid');
    const shim = join(bin, 'codex');
    writeFileSync(
      shim,
      `#!${process.execPath}\n` +
        `import { writeFileSync } from 'node:fs';\n` +
        `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        `process.on('SIGTERM', () => {});\n` +
        `setInterval(() => {}, 1000);\n`,
    );
    chmodSync(shim, 0o755);
    process.env.PATH = `${bin}:${savedPath ?? ''}`;
    const probe = await probeCodexProjectMcp(ws, 'example.project.oauth', undefined, { timeoutMs: 500 });
    expect(probe.cli_readable).toBe(false);
    expect(probe.detail).toContain('timed out');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test('effective-config fingerprint excludes secret values and is stable across semantic ordering', () => {
    const firstUserInfo = ['alice', 'first'].join(':');
    const secondUserInfo = ['bob', 'second'].join(':');
    const left = {
      enabled: true,
      transport: {
        url: `https://${firstUserInfo}@service.invalid:8443/mcp?token=first#fragment-one`,
        type: 'http',
        bearer_token_env_var: 'FIRST_TOKEN',
        http_headers: { Authorization: 'Bearer first', 'X-Api-Key': 'first' },
        env_http_headers: { 'X-Tenant': 'FIRST_TENANT' },
      },
      startup_timeout_sec: 10,
      tool_timeout_sec: 20,
      enabled_tools: ['write', 'read'],
      disabled_tools: ['admin'],
      unknown_secret: 'first',
    };
    const right = {
      unknown_secret: 'second',
      disabled_tools: ['admin'],
      enabled_tools: ['read', 'write'],
      tool_timeout_sec: 20,
      startup_timeout_sec: 10,
      transport: {
        env_http_headers: { 'x-tenant': 'SECOND_TENANT' },
        http_headers: { 'x-api-key': 'second', authorization: 'Bearer second' },
        bearer_token_env_var: 'SECOND_TOKEN',
        type: 'streamable_http',
        url: `https://${secondUserInfo}@service.invalid:8443/mcp?token=second#fragment-two`,
      },
      enabled: true,
    };
    expect(fingerprintCodexEffectiveConfig(left)).toBe(fingerprintCodexEffectiveConfig(right));
  });

  test('effective-config fingerprint changes for allowlisted structural drift', () => {
    const baseline = {
      enabled: true,
      transport: { type: 'streamable_http', url: 'https://service.invalid:8443/mcp' },
      tool_timeout_sec: 20,
      enabled_tools: ['read'],
    };
    expect(fingerprintCodexEffectiveConfig(baseline)).not.toBe(fingerprintCodexEffectiveConfig({
      ...baseline,
      transport: { ...baseline.transport, url: 'https://service.invalid:8443/mcp-v2' },
    }));
    expect(fingerprintCodexEffectiveConfig(baseline)).not.toBe(fingerprintCodexEffectiveConfig({
      ...baseline,
      enabled_tools: ['read', 'write'],
    }));
  });

  test('project config scanner distinguishes absent, readable, and unsupported', () => {
    const { ws } = fixture();
    rmSync(join(ws, '.codex', 'config.toml'), { force: true });
    expect(readCodexProjectConfig(ws)).toEqual({ state: 'absent' });
    configure(ws);
    expect(readCodexProjectConfig(ws)).toEqual({ state: 'readable', names: ['example.project.oauth'] });
    writeFileSync(join(ws, '.codex', 'config.toml'), '[mcp_servers.{unsupported}]\n');
    expect(readCodexProjectConfig(ws).state).toBe('unreadable');
  });

  test('runWire refuses absent config and unreadable or invalid effective Codex output without writing evidence', async () => {
    const { ws, home } = fixture();
    const args = [
      'wire', '--workspace', ws, '--adopt', '--harness', 'codex', '--scope', 'project',
      '--name', 'example.project.oauth', '--attest-runtime-call',
    ];
    let calls = 0;
    expect(await runBootstrap(args, { runner: async () => {
      calls += 1;
      return result({ enabled: true, url: 'https://service.invalid/mcp' });
    } })).toBe(1);
    expect(calls).toBe(0);
    expect(existsSync(adoptedConnectionsPath(home))).toBe(false);

    configure(ws);
    expect(await runBootstrap(args, { runner: async () => ({ code: 1, stdout: '', stderr: 'failed' }) })).toBe(1);
    expect(existsSync(adoptedConnectionsPath(home))).toBe(false);
    expect(await runBootstrap(args, { runner: async () => ({ code: 0, stdout: '{invalid', stderr: '' }) })).toBe(1);
    expect(existsSync(adoptedConnectionsPath(home))).toBe(false);
  });

  test('adoption requires explicit attestation and writes non-secret, non-receipt evidence', async () => {
    const { ws, home } = fixture();
    configure(ws);
    const receipt: InstallReceipt = {
      receipt_version: 1,
      workspace_dir: ws,
      source_id: 'workspace',
      agent_name: 'Example',
      created_at: '2026-01-01T00:00:00.000Z',
      created_by: 'test',
      brain_created_by_bootstrap: false,
      created_paths: [],
      registrations: [],
    };
    writeReceipt(home, receipt);
    const receiptBefore = readFileSync(join(home, 'bootstrap', 'receipt.json'), 'utf8');
    const effective = {
      name: 'example.project.oauth',
      enabled: true,
      transport: { type: 'streamable_http', url: 'https://secret.invalid/mcp?token=do-not-store' },
      bearer_token_env_var: 'PRIVATE_TOKEN',
      http_headers: { Authorization: 'Bearer do-not-store' },
    };
    const runner: ExecRunner = async () => result(effective);

    expect(await runBootstrap([
      'wire', '--workspace', ws, '--adopt', '--harness', 'codex', '--scope', 'project',
      '--name', 'example.project.oauth',
    ], { runner })).toBe(2);
    expect(existsSync(adoptedConnectionsPath(home))).toBe(false);

    expect(await runBootstrap([
      'wire', '--workspace', ws, '--adopt', '--harness', 'codex', '--scope', 'project',
      '--name', 'example.project.oauth', '--attest-runtime-call',
    ], { runner })).toBe(0);

    const raw = readFileSync(adoptedConnectionsPath(home), 'utf8');
    expect(raw).not.toContain('secret.invalid');
    expect(raw).not.toContain('do-not-store');
    expect(raw).not.toContain('PRIVATE_TOKEN');
    expect(raw).toContain('operator_attested_runtime_call');
    expect(raw).toContain('"auth": "not_proven"');
    expect(raw).toContain('"transport": "streamable_http"');
    expect(readFileSync(join(home, 'bootstrap', 'receipt.json'), 'utf8')).toBe(receiptBefore);
  });

  test('disabled or non-HTTP effective entries are refused', async () => {
    const { ws } = fixture();
    configure(ws);
    const base = ['wire', '--workspace', ws, '--adopt', '--harness', 'codex', '--scope', 'project', '--name', 'example.project.oauth', '--attest-runtime-call'];
    expect(await runBootstrap(base, { runner: async () => result({ enabled: false, url: 'https://service.invalid/mcp' }) })).toBe(1);
    expect(await runBootstrap(base, { runner: async () => result({ enabled: true, command: '/bin/example', args: [] }) })).toBe(1);
  });

  test('safe server-name grammar accepts dots and rejects TOML/control input before subprocess', async () => {
    const { ws } = fixture();
    let calls = 0;
    const runner: ExecRunner = async () => { calls += 1; return result({ enabled: true, url: 'https://service.invalid/mcp' }); };
    const args = ['wire', '--workspace', ws, '--adopt', '--harness', 'codex', '--scope', 'project', '--attest-runtime-call'];
    expect(await runBootstrap([...args, '--name', 'bad"name'], { runner })).toBe(2);
    expect(await runBootstrap([...args, '--name', 'bad\nname'], { runner })).toBe(2);
    expect(calls).toBe(0);
  });
});

describe('adoption evidence compatibility and lifecycle', () => {
  test('newer schema refuses overwrite; invalid evidence is backed up loudly', async () => {
    const { ws, home } = fixture();
    const path = adoptedConnectionsPath(home);
    writeFileSync(path, '{"schema_version":2,"connections":[]}\n');
    const connection = {
      workspace: ws,
      harness: 'codex' as const,
      scope: 'project' as const,
      server_name: 'example.project.oauth',
      transport: 'streamable_http' as const,
      auth: 'not_proven' as const,
      effective_config_fingerprint: fingerprintCodexEffectiveConfig({ enabled: true, url: 'https://service.invalid/mcp' }),
      verification_class: 'operator_attested_runtime_call' as const,
      verified_at: '2026-01-01T00:00:00.000Z',
    };
    await expect(writeAdoptedConnection(home, connection)).rejects.toThrow(/newer gbrain/);
    expect(readAdoptedConnectionsState(home)).toEqual({ state: 'newer', schema_version: 2 });

    writeFileSync(path, '{broken');
    await writeAdoptedConnection(home, connection);
    expect(readAdoptedConnectionsState(home).state).toBe('ok');
    expect(readdirSync(join(home, 'bootstrap')).some((name) => name.startsWith('adopted-connections.json.broken-'))).toBe(true);
  });

  test('plain uninstall consumes owned receipt but leaves non-owning project config and evidence', async () => {
    const { ws, home } = fixture();
    configure(ws);
    writeReceipt(home, {
      receipt_version: 1,
      workspace_dir: ws,
      source_id: 'workspace',
      agent_name: 'Example',
      created_at: '2026-01-01T00:00:00.000Z',
      created_by: 'test',
      brain_created_by_bootstrap: false,
      created_paths: [],
      registrations: [],
    });
    await writeAdoptedConnection(home, {
      workspace: ws,
      harness: 'codex',
      scope: 'project',
      server_name: 'example.project.oauth',
      transport: 'streamable_http',
      auth: 'not_proven',
      effective_config_fingerprint: fingerprintCodexEffectiveConfig({ enabled: true, url: 'https://service.invalid/mcp' }),
      verification_class: 'operator_attested_runtime_call',
      verified_at: '2026-01-01T00:00:00.000Z',
    });
    delete process.env.GBRAIN_HOME;
    const result = await uninstallWorkspace(ws, { gbrainHomeDir: home });
    expect(result.receipt_removed).toBe(true);
    expect(existsSync(join(ws, '.codex', 'config.toml'))).toBe(true);
    expect(existsSync(adoptedConnectionsPath(home))).toBe(true);
  });

  test('concurrent writes for two workspaces sharing one home preserve both records', async () => {
    const { root, home } = fixture();
    const make = (workspace: string, server: string) => ({
      workspace,
      harness: 'codex' as const,
      scope: 'project' as const,
      server_name: server,
      transport: 'streamable_http' as const,
      auth: 'not_proven' as const,
      effective_config_fingerprint: fingerprintCodexEffectiveConfig({ enabled: true, url: `https://${server}.invalid/mcp` }),
      verification_class: 'operator_attested_runtime_call' as const,
      verified_at: '2026-01-01T00:00:00.000Z',
    });
    await Promise.all([
      writeAdoptedConnection(home, make(join(root, 'workspace-a'), 'server-a')),
      writeAdoptedConnection(home, make(join(root, 'workspace-b'), 'server-b')),
    ]);
    const state = readAdoptedConnectionsState(home);
    expect(state.state).toBe('ok');
    if (state.state !== 'ok') throw new Error('expected readable adoption evidence');
    expect(state.connections.map((entry) => entry.server_name).sort()).toEqual(['server-a', 'server-b']);
  });

  test('re-adopting the same workspace and server replaces rather than duplicates evidence', async () => {
    const { ws, home } = fixture();
    configure(ws);
    const args = [
      'wire', '--workspace', ws, '--adopt', '--harness', 'codex', '--scope', 'project',
      '--name', 'example.project.oauth', '--attest-runtime-call',
    ];
    const first = { enabled: true, transport: { type: 'streamable_http', url: 'https://service.invalid/mcp' } };
    const second = { enabled: true, transport: { type: 'streamable_http', url: 'https://service.invalid/mcp-v2' } };
    expect(await runBootstrap(args, { runner: async () => result(first) })).toBe(0);
    expect(await runBootstrap(args, { runner: async () => result(second) })).toBe(0);

    const state = readAdoptedConnectionsState(home);
    expect(state.state).toBe('ok');
    if (state.state !== 'ok') throw new Error('expected readable adoption evidence');
    expect(state.connections).toHaveLength(1);
    expect(state.connections[0]?.effective_config_fingerprint).toBe(fingerprintCodexEffectiveConfig(second));
    expect(state.connections[0]?.effective_config_fingerprint).not.toBe(fingerprintCodexEffectiveConfig(first));
  });
});

describe('bootstrap status classification', () => {
  function installCodexShim(root: string, effective: unknown, exitCode = 0): void {
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const payload = join(root, 'effective.json');
    writeFileSync(payload, JSON.stringify(effective));
    const shim = join(bin, 'codex');
    writeFileSync(shim, exitCode === 0 ? `#!/bin/sh\ncat '${payload}'\n` : `#!/bin/sh\nexit ${exitCode}\n`);
    chmodSync(shim, 0o755);
    process.env.PATH = `${bin}:${savedPath ?? ''}`;
  }

  test('configured is partial, matching adoption is done, fingerprint drift returns partial', async () => {
    const { root, ws, home } = fixture();
    configure(ws);
    const effective = { name: 'example.project.oauth', enabled: true, transport: { type: 'streamable_http', url: 'https://service.invalid/mcp' } };
    installCodexShim(root, effective);

    let report = await statusReport(ws, { gbrainHomeDir: home });
    expect(report.phases.find((p) => p.id === 'wire')?.state).toBe('partial');
    expect(report.phases.find((p) => p.id === 'wire')?.detail).toContain('configured but not adopted');

    await writeAdoptedConnection(home, {
      workspace: ws,
      harness: 'codex',
      scope: 'project',
      server_name: 'example.project.oauth',
      transport: 'streamable_http',
      auth: 'not_proven',
      effective_config_fingerprint: fingerprintCodexEffectiveConfig(effective),
      verification_class: 'operator_attested_runtime_call',
      verified_at: '2026-01-01T00:00:00.000Z',
    });
    report = await statusReport(ws, { gbrainHomeDir: home });
    expect(report.phases.find((p) => p.id === 'wire')?.state).toBe('done');
    expect(report.support.adopted_harness_connections).toEqual([
      { harness: 'codex', scope: 'project', state: 'adopted', count: 1 },
    ]);

    installCodexShim(root, {
      ...effective,
      transport: { ...effective.transport, url: 'https://changed.invalid/mcp' },
    });
    report = await statusReport(ws, { gbrainHomeDir: home });
    expect(report.phases.find((p) => p.id === 'wire')?.state).toBe('partial');
    expect(report.phases.find((p) => p.id === 'wire')?.detail).toContain('changed since attestation');
  });

  test('CLI-unreadable, disabled, and unsupported effective Codex entries remain partial with precise status', async () => {
    const { root, ws, home } = fixture();
    configure(ws);

    installCodexShim(root, {}, 1);
    let report = await statusReport(ws, { gbrainHomeDir: home });
    expect(report.phases.find((p) => p.id === 'wire')?.state).toBe('partial');
    expect(report.phases.find((p) => p.id === 'wire')?.detail).toContain('could not be read through the Codex CLI');

    installCodexShim(root, { enabled: false, url: 'https://service.invalid/mcp' });
    report = await statusReport(ws, { gbrainHomeDir: home });
    expect(report.phases.find((p) => p.id === 'wire')?.state).toBe('partial');
    expect(report.phases.find((p) => p.id === 'wire')?.detail).toContain('disabled in effective config');

    installCodexShim(root, { enabled: true, command: '/bin/example', args: [] });
    report = await statusReport(ws, { gbrainHomeDir: home });
    expect(report.phases.find((p) => p.id === 'wire')?.state).toBe('partial');
    expect(report.phases.find((p) => p.id === 'wire')?.detail).toContain('unsupported transport');
  });

  test('adopted connection removed from project config is partial drift', async () => {
    const { ws, home } = fixture();
    await writeAdoptedConnection(home, {
      workspace: ws,
      harness: 'codex',
      scope: 'project',
      server_name: 'example.project.oauth',
      transport: 'streamable_http',
      auth: 'not_proven',
      effective_config_fingerprint: fingerprintCodexEffectiveConfig({ enabled: true, url: 'https://service.invalid/mcp' }),
      verification_class: 'operator_attested_runtime_call',
      verified_at: '2026-01-01T00:00:00.000Z',
    });
    const report = await statusReport(ws, { gbrainHomeDir: home });
    expect(report.phases.find((p) => p.id === 'wire')?.state).toBe('partial');
    expect(report.phases.find((p) => p.id === 'wire')?.detail).toContain('no longer exists in project config');
    expect(report.support.adopted_harness_connections).toEqual([
      { harness: 'codex', scope: 'project', state: 'drifted', count: 1 },
    ]);
  });

  test('owned receipt registration keeps precedence and avoids Codex probe', async () => {
    const { ws, home } = fixture();
    configure(ws);
    writeReceipt(home, {
      receipt_version: 1,
      workspace_dir: ws,
      source_id: 'workspace',
      agent_name: 'Example',
      created_at: '2026-01-01T00:00:00.000Z',
      created_by: 'test',
      brain_created_by_bootstrap: false,
      created_paths: [],
      registrations: [{ host: 'codex', scope: 'user', detail: 'mcp' }],
    });
    process.env.PATH = '';
    const report = await statusReport(ws, { gbrainHomeDir: home });
    expect(report.phases.find((p) => p.id === 'wire')?.state).toBe('done');
    expect(report.phases.find((p) => p.id === 'wire')?.detail).toContain('codex (user)');
  });

  test('receipt registration for a foreign workspace does not satisfy wire', async () => {
    const { root, ws, home } = fixture();
    writeReceipt(home, {
      receipt_version: 1,
      workspace_dir: join(root, 'foreign-workspace'),
      source_id: 'workspace',
      agent_name: 'Example',
      created_at: '2026-01-01T00:00:00.000Z',
      created_by: 'test',
      brain_created_by_bootstrap: false,
      created_paths: [],
      registrations: [{ host: 'codex', scope: 'user', detail: 'mcp' }],
    });
    const report = await statusReport(ws, { gbrainHomeDir: home });
    expect(report.phases.find((p) => p.id === 'wire')?.state).toBe('pending');
    expect(report.support.harness_registrations).toEqual([]);
  });

  test('one valid adopted server satisfies wire despite unrelated configured-only entries', async () => {
    const { root, ws, home } = fixture();
    writeFileSync(
      join(ws, '.codex', 'config.toml'),
      '[mcp_servers."example.project.oauth"]\nurl="https://service.invalid/mcp"\n' +
        '[mcp_servers.unrelated]\nurl="https://other.invalid/mcp"\n',
    );
    const effective = { enabled: true, transport: { type: 'streamable_http', url: 'https://service.invalid/mcp' } };
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const shim = join(bin, 'codex');
    writeFileSync(shim, `#!/bin/sh\nif [ "$5" = "unrelated" ]; then echo '{"enabled":true,"url":"https://other.invalid/mcp"}'; else echo '${JSON.stringify(effective)}'; fi\n`);
    chmodSync(shim, 0o755);
    process.env.PATH = `${bin}:${savedPath ?? ''}`;
    await writeAdoptedConnection(home, {
      workspace: ws,
      harness: 'codex',
      scope: 'project',
      server_name: 'example.project.oauth',
      transport: 'streamable_http',
      auth: 'not_proven',
      effective_config_fingerprint: fingerprintCodexEffectiveConfig(effective),
      verification_class: 'operator_attested_runtime_call',
      verified_at: '2026-01-01T00:00:00.000Z',
    });
    const report = await statusReport(ws, { gbrainHomeDir: home });
    expect(report.phases.find((p) => p.id === 'wire')?.state).toBe('done');
  });

  test('same server adopted for another workspace does not satisfy this workspace', async () => {
    const { root, ws, home } = fixture();
    configure(ws);
    const effective = { enabled: true, url: 'https://service.invalid/mcp' };
    installCodexShim(root, effective);
    await writeAdoptedConnection(home, {
      workspace: join(root, 'different-workspace'),
      harness: 'codex',
      scope: 'project',
      server_name: 'example.project.oauth',
      transport: 'streamable_http',
      auth: 'not_proven',
      effective_config_fingerprint: fingerprintCodexEffectiveConfig(effective),
      verification_class: 'operator_attested_runtime_call',
      verified_at: '2026-01-01T00:00:00.000Z',
    });
    const report = await statusReport(ws, { gbrainHomeDir: home });
    expect(report.phases.find((p) => p.id === 'wire')?.state).toBe('partial');
    expect(report.phases.find((p) => p.id === 'wire')?.detail).toContain('configured but not adopted');
  });

  test('invalid and newer evidence are precise partial states, never absent', async () => {
    const { ws, home } = fixture();
    configure(ws);
    const path = adoptedConnectionsPath(home);
    writeFileSync(path, '{broken');
    let report = await statusReport(ws, { gbrainHomeDir: home });
    expect(report.phases.find((p) => p.id === 'wire')?.state).toBe('partial');
    expect(report.phases.find((p) => p.id === 'wire')?.detail).toContain('evidence is invalid');

    writeFileSync(path, '{"schema_version":2,"connections":[]}');
    report = await statusReport(ws, { gbrainHomeDir: home });
    expect(report.phases.find((p) => p.id === 'wire')?.state).toBe('partial');
    expect(report.phases.find((p) => p.id === 'wire')?.detail).toContain('newer schema_version 2');
  });

  test('unreadable or unsupported project config is partial, not missing-config drift', async () => {
    const { ws, home } = fixture();
    await writeAdoptedConnection(home, {
      workspace: ws,
      harness: 'codex',
      scope: 'project',
      server_name: 'example.project.oauth',
      transport: 'streamable_http',
      auth: 'not_proven',
      effective_config_fingerprint: fingerprintCodexEffectiveConfig({ enabled: true, url: 'https://service.invalid/mcp' }),
      verification_class: 'operator_attested_runtime_call',
      verified_at: '2026-01-01T00:00:00.000Z',
    });
    writeFileSync(join(ws, '.codex', 'config.toml'), '[mcp_servers.{unsupported}]\n');
    const report = await statusReport(ws, { gbrainHomeDir: home });
    expect(report.phases.find((p) => p.id === 'wire')?.state).toBe('partial');
    expect(report.phases.find((p) => p.id === 'wire')?.detail).toContain('project Codex config is unreadable');
    expect(report.phases.find((p) => p.id === 'wire')?.detail).not.toContain('no longer exists');
  });
});
