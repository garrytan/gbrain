/**
 * #7422: `harness_wiring` warned "Claude Code is installed but has no gbrain
 * MCP registration … has not been verified from this process" on a host whose
 * registration `gbrain bootstrap` recorded: the check never read the
 * project-scope `.mcp.json` bootstrap writes, and a registration in a config
 * this process cannot see (a service under another HOME) read as missing.
 *
 * - A project-scope registration in the receipt workspace's `.mcp.json` is
 *   read like any other registration.
 * - A recorded registration whose config this process cannot read reports ok
 *   (info) and says how to verify it, instead of a false warn.
 * - No registration anywhere, a hooks-only record, or a recorded registration
 *   that its readable config no longer holds still warns.
 *
 * Hermetic temp HOME, GBRAIN_HOME, CODEX_HOME, CLAUDE_CONFIG_DIR and
 * XDG_CONFIG_HOME; no serve is spawned (registration read only, smoke off).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harnessWiringCheck } from '../src/commands/doctor/checks/harness-wiring.ts';
import { renderBrainFirstSnippet } from '../src/core/setup/brain-first.ts';
import { withEnv } from './helpers/with-env.ts';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

interface Box { root: string; home: string; ws: string; gbrainHome: string; env: Record<string, string | undefined> }

/** A machine whose active agent is Claude Code (its process marker is set) and nothing is configured yet. */
function box(): Box {
  const root = mkdtempSync(join(tmpdir(), 'gb-hw-7422-'));
  roots.push(root);
  const home = join(root, 'home');
  const ws = join(root, 'workspace');
  mkdirSync(home, { recursive: true });
  mkdirSync(ws, { recursive: true });
  return {
    root, home, ws, gbrainHome: join(root, 'gbrain-home', '.gbrain'),
    env: {
      HOME: home, GBRAIN_HOME: join(root, 'gbrain-home'), CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'), XDG_CONFIG_HOME: join(root, 'xdg'),
      DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
      CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: undefined, CODEX_SANDBOX: undefined, CODEX_CI: undefined, OPENCODE: undefined, OPENCODE_PID: undefined,
    },
  };
}

function receipt(b: Box, registrations: Array<{ host: string; scope: string; detail?: string }>): void {
  mkdirSync(join(b.gbrainHome, 'bootstrap'), { recursive: true });
  writeFileSync(join(b.gbrainHome, 'bootstrap', 'receipt.json'), JSON.stringify({
    receipt_version: 1, workspace_dir: b.ws, source_id: 'source-a', agent_name: 'agent', created_at: new Date().toISOString(),
    created_by: 'test', brain_created_by_bootstrap: false, created_paths: [], registrations,
  }));
}

const STDIO = { type: 'stdio', command: '/opt/example/bin/gbrain', args: ['serve', '--surface', 'full'], env: { GBRAIN_SOURCE: 'source-a' } };
const check = (b: Box) => withEnv(b.env, () => harnessWiringCheck({ smoke: false }));

describe('#7422 harness_wiring consults the bootstrap registration record', () => {
  test('a project-scope registration in the receipt workspace .mcp.json is read', async () => {
    const b = box();
    receipt(b, [{ host: 'claude-code', scope: 'project', detail: 'mcp+hooks' }]);
    writeFileSync(join(b.ws, '.mcp.json'), JSON.stringify({ mcpServers: { gbrain: STDIO } }));
    // A complete wiring also carries the brain-first block, or harness_wiring warns on it.
    mkdirSync(b.env.CLAUDE_CONFIG_DIR!, { recursive: true });
    writeFileSync(join(b.env.CLAUDE_CONFIG_DIR!, 'CLAUDE.md'), renderBrainFirstSnippet('claude-code', { kind: 'mcp', server: 'gbrain' }));
    const c = await check(b);
    expect(c.status).toBe('ok');
    expect(c.details).toMatchObject({ reason: 'registration_unverified', harnesses: ['claude-code'] });
    expect(c.message).toContain('Registered: Claude Code → /opt/example/bin/gbrain serve --surface full');
  });

  test('a recorded user-scope registration this process cannot read → ok info, not a false warn', async () => {
    const b = box();
    receipt(b, [{ host: 'claude-code', scope: 'user', detail: 'mcp+hooks' }]);
    const c = await check(b);
    expect(c.status).toBe('ok');
    expect(c.severity).toBe('info');
    expect(c.details).toMatchObject({ reason: 'registration_recorded', harnesses: ['claude-code'] });
    expect(c.message).toContain('gbrain bootstrap');
    expect(c.message).toContain('gbrain doctor --only harness_wiring');
    expect(c.message).not.toContain('has no gbrain MCP registration');
  });

  test('a recorded project-scope registration whose workspace config this process cannot read → ok info', async () => {
    const b = box();
    receipt(b, [{ host: 'claude-code', scope: 'project', detail: 'mcp' }]);
    rmSync(b.ws, { recursive: true, force: true });
    const c = await check(b);
    expect(c.status).toBe('ok');
    expect(c.details).toMatchObject({ reason: 'registration_recorded' });
  });

  test('no registration anywhere still warns', async () => {
    const b = box();
    const c = await check(b);
    expect(c.status).toBe('warn');
    expect(c.message).toMatch(/^Claude Code is installed but has no gbrain MCP registration/);
  });

  test('a hooks-only record is not an MCP registration → warn', async () => {
    const b = box();
    receipt(b, [{ host: 'claude-code', scope: 'user', detail: 'hooks' }]);
    expect((await check(b)).status).toBe('warn');
  });

  test('a record for another harness does not cover Claude Code → warn', async () => {
    const b = box();
    receipt(b, [{ host: 'codex', scope: 'user', detail: 'mcp' }]);
    expect((await check(b)).status).toBe('warn');
  });

  test('a recorded registration its readable config no longer holds → warn', async () => {
    const b = box();
    receipt(b, [{ host: 'claude-code', scope: 'user', detail: 'mcp' }]);
    writeFileSync(join(b.home, '.claude.json'), JSON.stringify({ mcpServers: { other: STDIO } }));
    expect((await check(b)).status).toBe('warn');
    const p = box();
    receipt(p, [{ host: 'claude-code', scope: 'project', detail: 'mcp' }]);
    writeFileSync(join(p.ws, '.mcp.json'), JSON.stringify({ mcpServers: {} }));
    expect((await check(p)).status).toBe('warn');
  });
});
