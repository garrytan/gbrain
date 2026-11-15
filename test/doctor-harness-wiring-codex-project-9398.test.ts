/**
 * #9398: `harness_wiring` warned "Codex is installed but has no gbrain MCP
 * registration" when the only gbrain server was the project-scoped table in the
 * bootstrap workspace's `.codex/config.toml` (the config `gbrain bootstrap hooks
 * --adopt --harness codex` records), and pointed at a user-scope duplicate.
 * The check reads that project config after the user-scope one, the way the
 * Claude Code lane reads the workspace `.mcp.json` (#7422).
 *
 * Hermetic temp HOME, GBRAIN_HOME, CODEX_HOME, CLAUDE_CONFIG_DIR and
 * XDG_CONFIG_HOME; no serve is spawned (registration read only, smoke off).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harnessWiringCheck } from '../src/commands/doctor/checks/harness-wiring.ts';
import { withEnv } from './helpers/with-env.ts';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

/** A machine whose active agent is Codex, with a bootstrap receipt naming a workspace and an empty user Codex config. */
function box(registrations: Array<{ host: string; scope: string; detail?: string }> = []) {
  const root = mkdtempSync(join(tmpdir(), 'gb-hw-9398-'));
  roots.push(root);
  const home = join(root, 'home'), ws = join(root, 'workspace'), codexHome = join(root, 'codex'), gbrainHome = join(root, 'gbrain-home');
  for (const dir of [home, join(ws, '.codex'), codexHome, join(gbrainHome, '.gbrain', 'bootstrap')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(codexHome, 'config.toml'), 'model = "example"\n');
  writeFileSync(join(gbrainHome, '.gbrain', 'bootstrap', 'receipt.json'), JSON.stringify({
    receipt_version: 1, workspace_dir: ws, source_id: 'source-a', agent_name: 'agent', created_at: new Date().toISOString(),
    created_by: 'test', brain_created_by_bootstrap: false, created_paths: [], registrations,
  }));
  const env = {
    HOME: home, GBRAIN_HOME: gbrainHome, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: join(root, 'claude'), XDG_CONFIG_HOME: join(root, 'xdg'),
    DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
    CODEX_SANDBOX: 'seatbelt', CODEX_CI: undefined, CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined, OPENCODE: undefined, OPENCODE_PID: undefined,
  };
  return { ws, codexHome, check: () => withEnv(env, () => harnessWiringCheck({ smoke: false })) };
}

const PROJECT_TABLE = '[mcp_servers.gbrain]\ncommand = "/opt/example/bin/gbrain"\nargs = ["serve"]\n';

describe('#9398 harness_wiring reads the workspace Codex project config', () => {
  test('a gbrain table only in the workspace .codex/config.toml counts as registered', async () => {
    const b = box();
    writeFileSync(join(b.ws, '.codex', 'config.toml'), PROJECT_TABLE);
    const c = await b.check();
    expect(c.message).not.toContain('has no gbrain MCP registration');
    expect(c.message).toContain('Codex → /opt/example/bin/gbrain serve');
  });

  test('a recorded project-scope Codex registration resolves to the workspace config, not the user config', async () => {
    const b = box([{ host: 'codex', scope: 'project', detail: 'mcp' }]);
    rmSync(b.ws, { recursive: true, force: true });
    const c = await b.check();
    expect(c.status).toBe('ok');
    expect(c.details).toMatchObject({ reason: 'registration_recorded', harnesses: ['codex'] });
    expect(c.message).not.toContain('has no gbrain MCP registration');
  });

  test('negative control: only an unrelated server in the project config still warns', async () => {
    const b = box();
    writeFileSync(join(b.ws, '.codex', 'config.toml'), '[mcp_servers.other]\ncommand = "/opt/example/bin/other"\n');
    const c = await b.check();
    expect(c.status).toBe('warn');
    expect(c.message).toContain('has no gbrain MCP registration');
  });
});
