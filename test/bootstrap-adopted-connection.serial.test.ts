/**
 * #4082 — bootstrap status must tell an operator-managed Codex PROJECT
 * connection (`<ws>/.codex/config.toml`, streamable HTTP + `codex mcp login`)
 * apart from "nothing wired": detected is PARTIAL, adopted after a passing
 * verify is DONE, a drifted fingerprint is PARTIAL again. The evidence lives in
 * a versioned sidecar beside the receipt and never carries header values.
 *
 * Serial: the dispatcher resolves the gbrain home from GBRAIN_HOME.
 */
import { describe, test, expect, beforeEach, afterAll, beforeAll } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBootstrap } from '../src/commands/bootstrap.ts';
import { writeManifest } from '../src/core/bootstrap/format.ts';
import { statusReport } from '../src/core/bootstrap/status.ts';
import {
  ADOPTED_CONNECTIONS_VERSION,
  adoptedConnectionState,
  adoptedConnectionsPath,
  detectCodexProjectServer,
  readAdoptedConnections,
} from '../src/core/bootstrap/adopted-connections.ts';
import { adoptConnection } from '../src/core/bootstrap/adopt-connection.ts';

let tmpParent: string;
let home: string;
let ws: string;
let prevHome: string | undefined;

const HTTP_SERVER = (url: string, token: string) =>
  `[mcp_servers.gbrain]\nurl = "${url}"\nhttp_headers = { Authorization = "Bearer ${token}" }\n`;

function writeProjectConfig(text: string, mtime?: Date): void {
  mkdirSync(join(ws, '.codex'), { recursive: true });
  const path = join(ws, '.codex', 'config.toml');
  writeFileSync(path, text);
  if (mtime) utimesSync(path, mtime, mtime);
}

function writeVerifyRun(ts: string, ok: boolean): void {
  mkdirSync(join(home, 'bootstrap'), { recursive: true });
  writeFileSync(
    join(home, 'bootstrap', `verify-${ts.replace(/[:.]/g, '-')}.json`),
    JSON.stringify({ ts, ok, checks: ok ? [] : [{ id: 'roundtrip', ok: false, detail: 'x' }] }),
  );
}

async function wirePhase() {
  const report = await statusReport(ws, { gbrainHomeDir: home });
  return report.phases.find((p) => p.id === 'wire')!;
}

async function capture<T>(fn: () => Promise<T>): Promise<{ result: T; out: string; err: string }> {
  const origLog = console.log;
  const origErr = console.error;
  let out = '';
  let err = '';
  console.log = (...args: unknown[]) => { out += args.map(String).join(' ') + '\n'; };
  console.error = (...args: unknown[]) => { err += args.map(String).join(' ') + '\n'; };
  try {
    return { result: await fn(), out, err };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

beforeAll(() => {
  prevHome = process.env.GBRAIN_HOME;
});

beforeEach(() => {
  tmpParent = mkdtempSync(join(tmpdir(), 'gb-adopt-'));
  home = join(tmpParent, '.gbrain');
  mkdirSync(home, { recursive: true });
  ws = mkdtempSync(join(tmpdir(), 'gb-adopt-ws-'));
  process.env.GBRAIN_HOME = tmpParent;
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prevHome;
  rmSync(tmpParent, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

describe('bootstrap status wire phase with a Codex project config (#4082)', () => {
  test('a project-local streamable-HTTP server is DETECTED (partial), not pending, and the hint adopts instead of re-registering', async () => {
    writeProjectConfig(HTTP_SERVER('https://brain.example.test/mcp', 'secret-token-value'));
    const wire = await wirePhase();
    expect(wire.state).toBe('partial');
    expect(wire.detail).toContain('.codex/config.toml defines mcp_servers.gbrain (streamable_http)');
    expect(wire.detail).toContain('gbrain bootstrap hooks --adopt --harness codex');
    expect(wire.detail).toContain('no user-global `codex mcp add` needed');
    expect(wire.detail).not.toContain('secret-token-value');
    expect(wire.resume_hint).toContain('project-scoped .codex/config.toml server');
  });

  test('no project config → still pending (the receipt/hook detectors are untouched)', async () => {
    expect((await wirePhase()).state).toBe('pending');
  });
});

describe('detectCodexProjectServer + fingerprint', () => {
  test('fingerprint covers transport, URL and header NAMES; a rotated token leaves it unchanged, a new URL changes it', () => {
    writeProjectConfig(HTTP_SERVER('https://brain.example.test/mcp', 'token-a'));
    const a = detectCodexProjectServer(ws)!;
    writeProjectConfig(HTTP_SERVER('https://brain.example.test/mcp', 'token-b'));
    const b = detectCodexProjectServer(ws)!;
    writeProjectConfig(HTTP_SERVER('https://other.example.test/mcp', 'token-a'));
    const c = detectCodexProjectServer(ws)!;
    expect(a).toEqual({
      harness: 'codex', scope: 'project', name: 'gbrain', transport: 'streamable_http',
      target: 'https://brain.example.test/mcp', header_names: ['Authorization'], fingerprint: a.fingerprint,
    });
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(c.fingerprint).not.toBe(a.fingerprint);
    expect(JSON.stringify(a)).not.toContain('token-a');
  });

  test('stdio tables, another table name, a missing file and a broken file', () => {
    expect(detectCodexProjectServer(ws)).toBeNull();
    writeProjectConfig('[mcp_servers.other]\ncommand = "gbrain"\nargs = ["serve", "--source", "ws"]\n');
    expect(detectCodexProjectServer(ws)).toBeNull();
    expect(detectCodexProjectServer(ws, 'other')).toMatchObject({ transport: 'stdio', target: 'gbrain serve --source ws', header_names: [] });
    writeProjectConfig('[mcp_servers.gbrain\nurl = "https://x"\n');
    expect(() => detectCodexProjectServer(ws)).toThrow();
    expect(adoptedConnectionState(ws, home)).toEqual({ state: 'none' });
  });
});

describe('adoptConnection evidence gate', () => {
  const URL = 'https://brain.example.test/mcp';

  test('refuses without a passing verify, and when the config changed after the verify', () => {
    writeProjectConfig(HTTP_SERVER(URL, 't'), new Date('2026-01-02T00:00:00Z'));
    const none = adoptConnection(ws, home, 'codex');
    expect(none.code).toBe(1);
    expect(none.lines[0]).toContain('no `gbrain bootstrap verify` run on record');

    writeVerifyRun('2026-01-03T00:00:00.000Z', false);
    const failed = adoptConnection(ws, home, 'codex');
    expect(failed.code).toBe(1);
    expect(failed.lines[0]).toContain('failed: roundtrip');

    writeVerifyRun('2026-01-04T00:00:00.000Z', true);
    writeProjectConfig(HTTP_SERVER(URL, 't'), new Date('2026-01-05T00:00:00Z'));
    const stale = adoptConnection(ws, home, 'codex');
    expect(stale.code).toBe(1);
    expect(stale.lines[0]).toContain('after the newest passing verify');
    expect(readAdoptedConnections(home).connections).toEqual([]);
  });

  test('refuses a non-Codex harness and a missing table', () => {
    writeVerifyRun('2026-01-04T00:00:00.000Z', true);
    expect(adoptConnection(ws, home, 'claude-code').code).toBe(2);
    const missing = adoptConnection(ws, home, 'codex');
    expect(missing.code).toBe(1);
    expect(missing.lines[0]).toContain('nothing to adopt');
  });

  test('adopts after a passing verify → wire done; a URL change drifts → partial; the sidecar is versioned and token-free', async () => {
    writeProjectConfig(HTTP_SERVER(URL, 'secret-token-value'), new Date('2026-01-02T00:00:00Z'));
    writeVerifyRun('2026-01-04T00:00:00.000Z', true);
    const adopted = adoptConnection(ws, home, 'codex');
    expect(adopted.code).toBe(0);
    expect(adopted.lines.join('\n')).toContain('no tokens stored');

    const raw = readFileSync(adoptedConnectionsPath(home), 'utf8');
    expect(raw).not.toContain('secret-token-value');
    const file = JSON.parse(raw);
    expect(file.version).toBe(ADOPTED_CONNECTIONS_VERSION);
    expect(file.connections).toHaveLength(1);
    expect(file.connections[0]).toMatchObject({ harness: 'codex', scope: 'project', workspace: ws, name: 'gbrain', transport: 'streamable_http', target: URL, evidence: { verify_ts: '2026-01-04T00:00:00.000Z' } });

    const done = await wirePhase();
    expect(done.state).toBe('done');
    expect(done.detail).toContain('codex (project, adopted');

    writeProjectConfig(HTTP_SERVER('https://moved.example.test/mcp', 'secret-token-value'), new Date('2026-01-02T00:00:00Z'));
    const drifted = await wirePhase();
    expect(drifted.state).toBe('partial');
    expect(drifted.detail).toContain('adopted connection drifted');
    expect(drifted.detail).toContain('https://moved.example.test/mcp');

    // A token rotation alone is not drift.
    writeProjectConfig(HTTP_SERVER(URL, 'rotated-token'), new Date('2026-01-02T00:00:00Z'));
    expect((await wirePhase()).state).toBe('done');

    // Re-adopting the moved config replaces the row instead of appending.
    writeProjectConfig(HTTP_SERVER('https://moved.example.test/mcp', 't'), new Date('2026-01-02T00:00:00Z'));
    expect(adoptConnection(ws, home, 'codex').code).toBe(0);
    expect(readAdoptedConnections(home).connections).toHaveLength(1);
    expect(readAdoptedConnections(home).connections[0].target).toBe('https://moved.example.test/mcp');

    rmSync(join(ws, '.codex'), { recursive: true });
    const gone = await wirePhase();
    expect(gone.state).toBe('partial');
    expect(gone.detail).toContain('no longer defines mcp_servers.gbrain');
  });
});

describe('gbrain bootstrap hooks --adopt (dispatcher)', () => {
  test('records the project connection without touching .codex/config.toml; refuses non-Codex', async () => {
    writeManifest(ws, { format_version: 1, initialized: true, agent_name: 'Testy', created_by: 'test', created_at: new Date().toISOString(), source_id: 'workspace' });
    const toml = HTTP_SERVER('https://brain.example.test/mcp', 'tok');
    writeProjectConfig(toml, new Date('2026-01-02T00:00:00Z'));
    writeVerifyRun('2026-01-04T00:00:00.000Z', true);

    const wrong = await capture(() => runBootstrap(['hooks', '--workspace', ws, '--harness', 'claude-code', '--adopt']));
    expect(wrong.result).toBe(2);
    expect(wrong.err).toContain('--adopt applies to a Codex project config');

    const ok = await capture(() => runBootstrap(['hooks', '--workspace', ws, '--harness', 'codex', '--adopt']));
    expect(ok.result).toBe(0);
    expect(ok.out).toContain('adopted codex project connection mcp_servers.gbrain');
    expect(readFileSync(join(ws, '.codex', 'config.toml'), 'utf8')).toBe(toml);
    expect(readAdoptedConnections(home).connections).toHaveLength(1);
    expect((await wirePhase()).state).toBe('done');
  });
});
