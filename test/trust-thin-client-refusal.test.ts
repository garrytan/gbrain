/**
 * A thin-client install refuses `gbrain trust` (owner actions run on the brain
 * host) with a host-side fix that keeps the typed ref, so the user can run the
 * exact command there (#5575 DX-3/DX-7). Spawns the CLI against a seeded
 * thin-client home; no engine or network is reached.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';

let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-trust-thin-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', remote_mcp: {
    issuer_url: 'https://brain-host.example', mcp_url: 'https://brain-host.example/mcp', oauth_client_id: 'cid', oauth_client_secret: 'csecret' } }));
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('thin-client gbrain trust refusal', () => {
  test('the fix argv carries the subcommand and its typed ref; an unsafe ref is left out', async () => {
    const env = { GBRAIN_REMOTE_CLIENT_SECRET: undefined };
    const fixOf = async (args: string[]) => {
      const r = await runCli([...args, '--json'], { home, env });
      expect(r.exitCode).toBe(1);
      return (JSON.parse(r.stdout) as { code: string; fix: { argv: string[]; next: string } });
    };
    const confirm = await fixOf(['trust', 'confirm', 'f12']);
    expect(confirm.code).toBe('requires_local_engine');
    expect(confirm.fix).toMatchObject({ argv: ['gbrain', 'trust', 'confirm', 'f12'], next: 'tell_user_to_run' });
    expect((await fixOf(['trust', 'revert', 'p:default/notes/alice-example'])).fix.argv).toEqual(['gbrain', 'trust', 'revert', 'p:default/notes/alice-example']);
    expect((await fixOf(['trust', 'confirm', '$(rm -rf ~)'])).fix.argv).toEqual(['gbrain', 'trust', 'confirm']);
  }, 120_000);
});
