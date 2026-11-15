/**
 * GST-2768 PR 2: the "openclaw gateway call" child process. Arguments go as an array with no shell, the binary is a
 * fixed name, the method is fixed, and every Gateway-supplied value (a session key that looks like an option, shell
 * metacharacters) reaches the child only inside the JSON value of --params, so it can never become an option or change
 * what runs. The token goes through the environment, never argv. A fake openclaw records its argv.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliGatewayTransport, openclawGatewayReader } from '../src/core/transcripts/openclaw-gateway.ts';

const dir = mkdtempSync(join(tmpdir(), 'openclaw-argv-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const log = join(dir, 'calls.jsonl');
const bin = join(dir, 'openclaw');
const HOSTILE = ['--url=ws://attacker.invalid', '-rf', '$(touch ' + join(dir, 'pwned') + ')', 'a;b|c`d`'];
writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, token: process.env.OPENCLAW_GATEWAY_TOKEN ?? null }) + '\\n');
const method = argv[2];
const params = JSON.parse(argv[argv.indexOf('--params') + 1]);
if (method === 'sessions.list') {
  console.log(JSON.stringify({ sessions: ${JSON.stringify(HOSTILE)}.map((key, i) => ({ key, sessionId: 's' + i, chatType: 'direct', updatedAt: 1794700000000 })), hasMore: false }));
} else {
  console.log(JSON.stringify({ sessionKey: params.sessionKey, messages: [{ role: 'user', content: 'hello', timestamp: 1794700000000, __openclaw: { id: params.sessionKey } }], hasMore: false }));
}
`);
chmodSync(bin, 0o755);

describe('openclaw gateway call child process', () => {
  test('hostile session keys stay inside --params; argv has a fixed shape; the token is in env only', async () => {
    const reader = openclawGatewayReader({ transport: cliGatewayTransport({ bin, url: 'ws://127.0.0.1:18789', token: 'tok-synthetic-0001', timeoutMs: 5_000 }) });
    const convs = await reader.list();
    expect(convs.map(c => c.conversationKey)).toEqual(HOSTILE);
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { argv: string[]; token: string | null });
    expect(calls.length).toBe(1 + HOSTILE.length);
    for (const { argv, token } of calls) {
      expect(token).toBe('tok-synthetic-0001');
      expect(argv.join(' ')).not.toContain('tok-synthetic-0001');
      expect(argv.length).toBe(10);
      expect(argv.slice(0, 2)).toEqual(['gateway', 'call']);
      expect(['sessions.list', 'chat.history']).toContain(argv[2]);
      expect(argv[3]).toBe('--json');
      expect(argv[4]).toBe('--params');
      expect(argv[5]!.startsWith('{')).toBe(true);
      expect(argv.slice(6)).toEqual(['--timeout', '5000', '--url', 'ws://127.0.0.1:18789']);
    }
    const historyKeys = calls.filter(c => c.argv[2] === 'chat.history').map(c => (JSON.parse(c.argv[5]!) as { sessionKey: string }).sessionKey);
    expect(historyKeys).toEqual(HOSTILE);
    expect(() => readFileSync(join(dir, 'pwned'))).toThrow();
  }, 30_000);

  test('a Gateway URL that is not a ws, wss, http or https URL is refused before anything runs', async () => {
    const before = readFileSync(log, 'utf8');
    await expect(cliGatewayTransport({ bin, url: '--config=/tmp/evil' }).call('sessions.list', {})).rejects.toThrow(/GBRAIN_OPENCLAW_GATEWAY_URL/);
    expect(readFileSync(log, 'utf8')).toBe(before);
  });

  test('a child that hangs past the timeout is killed and reported as unreachable', async () => {
    const slow = join(dir, 'openclaw-slow');
    writeFileSync(slow, '#!/bin/sh\nsleep 30\n');
    chmodSync(slow, 0o755);
    const started = Date.now();
    await expect(cliGatewayTransport({ bin: slow, timeoutMs: 200 }).call('sessions.list', {})).rejects.toMatchObject({ code: 'archive_gateway_unreachable' });
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);
});
