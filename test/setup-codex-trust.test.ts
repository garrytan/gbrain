import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { codexHookTrustHash, codexTrustHash } from '../src/core/bootstrap/codex-hooks.ts';
import { appendCodexTomlTable, removeCodexTomlTable } from '../src/core/bootstrap/codex-toml.ts';
import { createSetupFixture } from './helpers/setup-fixture.ts';

const { tempDir, cleanup } = createSetupFixture();
afterAll(cleanup);

describe('codex trust hash and hash-owned TOML tables', () => {
  test('codexHookTrustHash reproduces trust entries a live codex-cli 0.162.1 accepted (the hooks ran)', () => {
    const base = '/home/user/.capy/work/d8/obs-2';
    const cmd = (sub: string) => `env GBRAIN_HOOK_LANE=setup GBRAIN_HOME=${base}/home ${base}/bin/gbrain hook ${sub} --harness codex`;
    expect(codexHookTrustHash('user_prompt_submit', cmd('user-prompt'), 15)).toBe('sha256:14aa503e53d2b5dd658bec9232f3021e8169c2799b6332dc4514dfdf71fb44ae');
    expect(codexHookTrustHash('session_start', cmd('session-start'), 15)).toBe('sha256:86d30bf0ab9b998a4121df4a83de0662ea94f69d94d4311c61589c26d5191737');
    expect(codexHookTrustHash('session_end', 'x', 3)).toBe(codexTrustHash('x'));
  });

  test('append then remove is byte-exact, keeps the next table\'s comment, and refuses a re-rendered table', () => {
    const dir = tempDir('gbrain-codex-toml-');
    const path = join(dir, 'config.toml');
    const original = 'model = "o5"\n\n[profiles.fast]\nmodel = "o5-mini"\n';
    writeFileSync(path, original);
    appendCodexTomlTable(path, ['mcp_servers', 'gbrain'], { command: '/bin/gbrain', args: ['serve'], env: { GBRAIN_HOME: '/h' } }, 'gbrain setup (gbrain): test');
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n# user note about the next table\n[profiles.slow]\nmodel = "o5"\n`);
    expect(() => appendCodexTomlTable(path, ['mcp_servers', 'gbrain'], { command: '/x' })).toThrow(/never defines a table twice/);
    expect(removeCodexTomlTable(path, ['mcp_servers', 'gbrain'])).toBe('removed');
    expect(readFileSync(path, 'utf8')).toBe(`${original}\n# user note about the next table\n[profiles.slow]\nmodel = "o5"\n`);
    expect(removeCodexTomlTable(path, ['mcp_servers', 'gbrain'])).toBe('absent');

    writeFileSync(path, '[mcp_servers.gbrain]\ncommand = "/bin/gbrain"\n\n[mcp_servers.gbrain.env]\nGBRAIN_HOME = "/h"\n');
    const split = readFileSync(path, 'utf8');
    expect(removeCodexTomlTable(path, ['mcp_servers', 'gbrain'])).toBe('unlocatable');
    expect(readFileSync(path, 'utf8')).toBe(split);
  });
});
