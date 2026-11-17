/**
 * GBRA-585 item 12: a member key that setup minted (member-keys/<member>.key, a plain bearer token) reaches a harness.
 *
 * 1. Protects: `connect --credentials-file` given a plain bearer key file says it is a plain key, not a handoff, and
 *    prints the --agent form that installs it; `connect --token` with `--harness` names the --agent form instead of
 *    "Unknown setup argument"; the paste block calls the token a long-lived secret without claiming it is full-access.
 * 2. Fails when: those refusals go back to "Invalid credential handoff" or "Unknown setup argument", the key value is
 *    echoed into the output, or the block labels a read/write member key full-access.
 * 3. Real seams: the connect command's harness lane (runConnect) with a real 0600 key file; no network call is made.
 */
import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConnect, buildConnectBlock } from '../src/commands/connect.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';

const dir = mkdtempSync(join(tmpdir(), 'gbrain-member-key-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const KEY = 'gbrain_' + 'a1b2c3d4'.repeat(8);
const keyFile = join(dir, 'alice-example.key');
writeFileSync(keyFile, KEY + '\n', { mode: 0o600 });

async function connect(args: string[]): Promise<Record<string, any>> {
  const lines: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  const err = spyOn(console, 'error').mockImplementation(() => {});
  const priorExitCode = process.exitCode;
  let exit: number;
  try { await runConnect(args); } finally {
    exit = currentExitCode();
    _resetCliExitVerdictForTests();
    process.exitCode = priorExitCode ?? 0;
    log.mockRestore(); err.mockRestore();
  }
  expect(exit).toBe(1);
  const text = lines.join('\n');
  expect(text).not.toContain(KEY);
  return JSON.parse(text);
}

describe('a setup-minted member key into a harness (GBRA-585)', () => {
  test('--credentials-file with a plain bearer key says so and prints the --agent form', async () => {
    const out = await connect(['http://127.0.0.1:3131/mcp', '--harness', 'claude-code', '--credentials-file', keyFile, '--install']);
    expect(out.status).toBe('error');
    expect(out.message).not.toContain('Invalid credential handoff');
    expect(out.message).toContain('plain bearer key');
    expect(out.message).toContain(`GBRAIN_REMOTE_TOKEN="$(cat ${keyFile})" gbrain connect http://127.0.0.1:3131/mcp --agent claude-code --install`);
  });

  test('--token with --harness names the --agent form instead of an unknown argument', async () => {
    const out = await connect(['http://127.0.0.1:3131/mcp', '--token', KEY, '--harness', 'codex', '--install']);
    expect(out.status).toBe('error');
    expect(out.message).not.toContain('Unknown setup argument');
    expect(out.message).toContain('gbrain connect http://127.0.0.1:3131/mcp --agent codex --token <key> --install');
  });

  test('the paste block calls the bearer token a long-lived secret, not full-access', () => {
    for (const agent of ['claude-code', 'codex', 'opencode'] as const) {
      const block = buildConnectBlock({ agent, name: 'gbrain', url: 'https://brain.example.com/mcp', token: 'TOK' });
      expect(block).not.toContain('full-access');
      expect(block).toContain('long-lived secret');
    }
  });
});
