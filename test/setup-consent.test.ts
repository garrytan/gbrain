import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { dirname, join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { claudeJson, createSetupFixture, entries, readJson, settings, setup } from './helpers/setup-fixture.ts';

const { box, cleanup } = createSetupFixture();
afterAll(cleanup);

describe('gbrain setup: consent and refusals', () => {
  test('provider keys present + capture declined + an existing opt-out: no capture hooks, no provider traffic, keyless brain', async () => {
    const seen: string[] = [];
    const recorder: Server = createServer((sock) => {
      sock.once('data', (d) => { seen.push(d.toString('utf8').split('\r\n')[0] ?? ''); sock.destroy(); });
    });
    await new Promise<void>((ok) => recorder.listen(0, '127.0.0.1', ok));
    const port = (recorder.address() as { port: number }).port;
    const providerEnv = {
      OPENAI_API_KEY: 'sk-test-setup', ANTHROPIC_API_KEY: 'sk-ant-test-setup', VOYAGE_API_KEY: 'pa-test-setup', GEMINI_API_KEY: 'gm-test-setup',
      HTTPS_PROXY: `http://127.0.0.1:${port}`, HTTP_PROXY: `http://127.0.0.1:${port}`, https_proxy: `http://127.0.0.1:${port}`, http_proxy: `http://127.0.0.1:${port}`,
      OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    };
    try {
      const fresh = box();
      const r = await setup(fresh, ['claude-code', '--no-capture', '--json'], providerEnv);
      expect(r.exitCode).toBe(0);
      expect(r.doc.consent.capture).toMatchObject({ value: 'declined', source: 'flag' });
      expect(readJson(join(fresh.gbrainHome, '.gbrain', 'config.json')).embedding_disabled).toBe(true);
      expect(entries(fresh, 'Stop')).toEqual([]);
      expect(entries(fresh, 'SessionEnd')).toEqual([]);

      const optedOut = box();
      expect((await runCli(['init', '--pglite', '--no-embedding'], { home: optedOut.home })).exitCode).toBe(0);
      const cfgPath = join(optedOut.gbrainHome, '.gbrain', 'config.json');
      writeFileSync(cfgPath, JSON.stringify({ ...readJson(cfgPath), memory: { auto_writeback: 'off' } }));
      const o = await setup(optedOut, ['claude-code', '--capture', '--json'], providerEnv);
      expect(o.exitCode).toBe(0);
      expect(o.doc.consent.capture).toMatchObject({ value: 'declined', source: 'opt_out' });
      expect(o.doc.notes.join(' ')).toContain('--capture ignored');
      expect(Object.keys(readJson(settings(optedOut)).hooks).sort()).toEqual(['SessionStart', 'UserPromptSubmit']);
      expect(seen.filter((l) => /openai|anthropic|voyage|googleapis|\/v1\//i.test(l))).toEqual([]);
    } finally {
      recorder.close();
    }
  });

  test('--capture, accepted and not opted out, adds Stop and SessionEnd; --no-hooks then removes every owned hook', async () => {
    const b = box();
    const r = await setup(b, ['claude-code', '--capture', '--json']);
    expect(r.exitCode).toBe(0);
    expect(Object.keys(readJson(settings(b)).hooks).sort()).toEqual(['SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    const off = await setup(b, ['claude-code', '--no-hooks', '--json']);
    expect(off.exitCode).toBe(0);
    expect(readJson(settings(b)).hooks ?? {}).toEqual({});
    expect(readJson(claudeJson(b)).mcpServers.gbrain).toBeDefined();
  });

  for (const [harness, guide] of [['openclaw', 'docs/mcp/OPENCLAW.md'], ['hermes', 'docs/mcp/HERMES.md']] as const) {
    test(`${harness}: setup writes the brain-first block and names its guide for the MCP step`, async () => {
      const b = box();
      if (harness === 'hermes') {
        // Hermes seeds SOUL.md on first run; setup never creates one (it would replace the default identity).
        mkdirSync(join(b.home, '.hermes'), { recursive: true });
        writeFileSync(join(b.home, '.hermes', 'SOUL.md'), 'You are Hermes.\n');
      }
      const r = await setup(b, [harness, '--json'], { OPENCLAW_STATE_DIR: undefined, OPENCLAW_WORKSPACE_DIR: undefined, OPENCLAW_PROFILE: undefined, HERMES_HOME: undefined,
        // No host hermes on PATH, so the MCP step's outcome does not depend on the machine.
        PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(':') });
      expect(r.exitCode).toBe(0);
      // Hermes's MCP step runs through its own CLI (test/setup-hermes-mcp.test.ts); with no hermes here it prints the command.
      expect(r.doc).toMatchObject({ harness, instructions_only: true, mcp: { setup: harness === 'hermes' ? 'print' : 'manual', docs: guide }, instructions: { action: 'write' } });
      expect(r.doc.instructions.path).toBe(harness === 'openclaw' ? join(b.home, '.openclaw', 'workspace', 'AGENTS.md') : join(b.home, '.hermes', 'SOUL.md'));
      expect(existsSync(claudeJson(b))).toBe(false);
    });
  }
});
