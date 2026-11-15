/** #9398: a gbrain table in the bootstrap workspace's .codex/config.toml counts as a Codex registration. */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harnessWiringCheck } from '../src/commands/doctor/checks/harness-wiring.ts';
import { withEnv } from './helpers/with-env.ts';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function setup(toml: string) {
  const root = mkdtempSync(join(tmpdir(), 'gb-hw-9398-'));
  roots.push(root);
  const ws = join(root, 'workspace');
  const gbrainHome = join(root, 'gbrain-home');
  mkdirSync(join(ws, '.codex'), { recursive: true });
  mkdirSync(join(root, 'home'), { recursive: true });
  mkdirSync(join(root, 'codex'), { recursive: true });
  mkdirSync(join(gbrainHome, '.gbrain', 'bootstrap'), { recursive: true });
  writeFileSync(join(ws, '.codex', 'config.toml'), toml);
  writeFileSync(join(gbrainHome, '.gbrain', 'bootstrap', 'receipt.json'), JSON.stringify({
    receipt_version: 1, workspace_dir: ws, source_id: 'source-a', agent_name: 'agent', created_at: new Date().toISOString(),
    created_by: 'test', brain_created_by_bootstrap: false, created_paths: [], registrations: [],
  }));
  return {
    HOME: join(root, 'home'), GBRAIN_HOME: gbrainHome, CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'), XDG_CONFIG_HOME: join(root, 'xdg'),
    DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
    CODEX_CI: '1', CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined, CODEX_SANDBOX: undefined, OPENCODE: undefined, OPENCODE_PID: undefined,
  } as Record<string, string | undefined>;
}

const run = (env: Record<string, string | undefined>) => withEnv(env, () => harnessWiringCheck({ smoke: false }));

describe('#9398 harness_wiring reads the workspace .codex/config.toml', () => {
  test('a project-scoped gbrain table is a registration', async () => {
    const c = await run(setup('[mcp_servers.gbrain]\ncommand = "/opt/example/bin/gbrain"\nargs = ["serve"]\n'));
    expect(c.message).not.toContain('no gbrain MCP registration');
  });

  test('an unrelated server table still warns', async () => {
    const c = await run(setup('[mcp_servers.other]\ncommand = "/opt/example/bin/other"\n'));
    expect(c.status).toBe('warn');
    expect(c.message).toContain('no gbrain MCP registration');
  });
});
