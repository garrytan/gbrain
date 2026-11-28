import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { removeCodexHooks, writeCodexHooks } from '../src/core/bootstrap/codex-hooks.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { codexDir, codexReceipt, codexToml, createSetupFixture, groups, hooksJson, readJson, setup, toml, trustKey, trustKeys } from './helpers/setup-fixture.ts';

const { box, cleanup } = createSetupFixture();
afterAll(cleanup);

describe('gbrain setup codex: consent and flags', () => {
  test('provider keys present + capture declined + existing opt-outs: no capture hook, no provider traffic, keyless brain', async () => {
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
      const r = await setup(fresh, ['codex', '--no-capture', '--json'], providerEnv);
      expect(r.exitCode).toBe(0);
      expect(r.doc.consent.capture).toMatchObject({ value: 'declined', source: 'flag' });
      expect(r.doc.consent.providers).toMatchObject({ value: 'declined', source: 'default' });
      expect(readJson(join(fresh.gbrainHome, '.gbrain', 'config.json')).embedding_disabled).toBe(true);
      expect(groups(fresh, 'SessionEnd')).toEqual([]);
      expect(trustKeys(fresh).some((k) => k.includes(':session_end:'))).toBe(false);

      const optedOut = box();
      expect((await runCli(['init', '--pglite', '--no-embedding'], { home: optedOut.home })).exitCode).toBe(0);
      const cfgPath = join(optedOut.gbrainHome, '.gbrain', 'config.json');
      writeFileSync(cfgPath, JSON.stringify({ ...readJson(cfgPath), memory: { auto_writeback: 'off' } }));
      const o = await setup(optedOut, ['codex', '--capture', '--json'], providerEnv);
      expect(o.exitCode).toBe(0);
      expect(o.doc.consent.capture).toMatchObject({ value: 'declined', source: 'opt_out' });
      expect(o.doc.notes.join(' ')).toContain('--capture ignored');
      expect(Object.keys(readJson(hooksJson(optedOut)).hooks).sort()).toEqual(['SessionStart', 'UserPromptSubmit']);

      const hooksOff = box();
      const k = await setup(hooksOff, ['codex', '--capture', '--json'], { ...providerEnv, GBRAIN_HOOKS: '0' });
      expect(k.exitCode).toBe(0);
      expect(k.doc.consent.wiring_scope).toMatchObject({ value: { hooks: 'none' }, source: 'opt_out' });
      expect(existsSync(hooksJson(hooksOff))).toBe(false);
      expect(trustKeys(hooksOff)).toEqual([]);
      expect(k.doc.states).toEqual(['configured', 'connection-verified', 'native-pending']);

      expect(seen.filter((l) => /openai|anthropic|voyage|googleapis|\/v1\//i.test(l))).toEqual([]);
      for (const b of [fresh, optedOut, hooksOff]) expect(existsSync(join(b.gbrainHome, '.gbrain', 'corpus'))).toBe(false);
    } finally {
      recorder.close();
    }
  });

  test('--capture adds the SessionEnd capture group and its trust; --no-hooks then removes every owned hook and trust entry', async () => {
    const b = box();
    const r = await setup(b, ['codex', '--capture', '--json']);
    expect(r.exitCode).toBe(0);
    expect(Object.keys(readJson(hooksJson(b)).hooks).sort()).toEqual(['SessionEnd', 'SessionStart', 'UserPromptSubmit']);
    const end = groups(b, 'SessionEnd')[0].hooks[0];
    expect(end.timeout).toBe(3);
    expect(end.command).toMatch(/^env GBRAIN_HOOK_LANE=setup GBRAIN_HOME=\S+ sh -c '.*hook session-end --harness codex/);
    expect(trustKeys(b)).toContain(trustKey(b, 'session_end', 0));
    const off = await setup(b, ['codex', '--no-hooks', '--json']);
    expect(off.exitCode).toBe(0);
    expect(readJson(hooksJson(b)).hooks).toEqual({});
    expect(trustKeys(b)).toEqual([]);
    expect(toml(b).mcp_servers.gbrain).toBeDefined();
  });

  test('--dry-run writes nothing and honours GBRAIN_SURFACE; --scope project is refused for codex', async () => {
    const b = box();
    const r = await setup(b, ['codex', '--dry-run', '--json'], { GBRAIN_SURFACE: 'starter' });
    expect(r.exitCode).toBe(0);
    expect(r.doc.target).toMatchObject({ transport: 'local-stdio', surface: 'starter', registration_owner: 'none', scope: 'user' });
    expect(r.doc.steps.map((s: any) => s.step)).toEqual(['receipt', 'brain', 'mcp', 'hooks', 'trust']);
    expect(existsSync(codexDir(b))).toBe(false);
    expect(existsSync(join(b.gbrainHome, '.gbrain'))).toBe(false);
    const p = await setup(b, ['codex', '--scope', 'project']);
    expect(p.exitCode).toBe(2);
    expect(p.stderr).toContain('user scope only');
  });

  test('the bootstrap Codex SessionEnd lane is an owner conflict for --capture, and bootstrap never claims setup\'s groups', async () => {
    const b = box();
    mkdirSync(codexDir(b), { recursive: true });
    expect(writeCodexHooks({ gbrainBin: b.bin, hooksPath: hooksJson(b), configPath: codexToml(b) }).ok).toBe(true);
    const refused = await setup(b, ['codex', '--capture', '--json']);
    expect(refused.exitCode).toBe(1);
    expect(refused.doc).toMatchObject({ code: 'setup_owner_conflict', reason: 'harness_lane' });
    expect(existsSync(codexReceipt(b))).toBe(false);

    const c = box();
    expect((await setup(c, ['codex', '--capture'])).exitCode).toBe(0);
    const before = readFileSync(hooksJson(c), 'utf8');
    removeCodexHooks({ hooksPath: hooksJson(c), configPath: codexToml(c) });
    expect(readFileSync(hooksJson(c), 'utf8')).toBe(before);
  });
});
