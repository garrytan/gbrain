/**
 * GST-2768 PR 2: the "openclaw gateway call" child process. Arguments go as an array with no shell, the binary is a
 * fixed name, the method is fixed, and every Gateway-supplied value (a session key that looks like an option, shell
 * metacharacters) reaches the child only inside the JSON value of --params, so it can never become an option or change
 * what runs. The token and the Gateway URL go through the environment, never argv. A fake openclaw records its argv.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCwdDotenvProtectedKey, quarantineCwdDotenv } from '../src/core/env-trust.ts';
import { cliGatewayTransport, openclawGatewayReader } from '../src/core/transcripts/openclaw-gateway.ts';
import { withEnv } from './helpers/with-env.ts';

const dir = mkdtempSync(join(tmpdir(), 'openclaw-argv-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const log = join(dir, 'calls.jsonl');
const bin = join(dir, 'openclaw');
const HOSTILE = ['--url=ws://attacker.invalid', '-rf', '$(touch ' + join(dir, 'pwned') + ')', 'a;b|c`d`'];
writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, token: process.env.OPENCLAW_GATEWAY_TOKEN ?? null, url: process.env.OPENCLAW_GATEWAY_URL ?? null }) + '\\n');
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
    expect(convs.map(c => c.scopeKey)).toEqual(HOSTILE);
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { argv: string[]; token: string | null; url: string | null });
    expect(calls.length).toBe(1 + HOSTILE.length);
    for (const { argv, token, url } of calls) {
      expect(token).toBe('tok-synthetic-0001');
      expect(url).toBe('ws://127.0.0.1:18789');
      expect(argv.join(' ')).not.toContain('tok-synthetic-0001');
      expect(argv.length).toBe(8);
      expect(argv.slice(0, 2)).toEqual(['gateway', 'call']);
      expect(['sessions.list', 'chat.history']).toContain(argv[2]);
      expect(argv[3]).toBe('--json');
      expect(argv[4]).toBe('--params');
      expect(argv[5]!.startsWith('{')).toBe(true);
      expect(argv.slice(6)).toEqual(['--timeout', '5000']);
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

  test('the URL refusal names the variable that was read: OPENCLAW_GATEWAY_URL when gbrain\'s own is unset, else GBRAIN_OPENCLAW_GATEWAY_URL', async () => {
    const before = readFileSync(log, 'utf8');
    await withEnv({ OPENCLAW_GATEWAY_URL: '--config=/tmp/evil', GBRAIN_OPENCLAW_GATEWAY_URL: undefined }, async () => {
      const err = await cliGatewayTransport({ bin }).call('sessions.list', {}).then(() => null, (e: Error) => e);
      expect(err?.message).toContain('OPENCLAW_GATEWAY_URL must be');
      expect(err?.message).not.toContain('GBRAIN_OPENCLAW_GATEWAY_URL');
    });
    await withEnv({ GBRAIN_OPENCLAW_GATEWAY_URL: 'file:///tmp/evil', OPENCLAW_GATEWAY_URL: 'ws://127.0.0.1:18789' }, async () => {
      await expect(cliGatewayTransport({ bin }).call('sessions.list', {})).rejects.toThrow(/GBRAIN_OPENCLAW_GATEWAY_URL must be/);
    });
    expect(readFileSync(log, 'utf8')).toBe(before);
  });

  test('a child that hangs past the timeout is killed and reported as unreachable', async () => {
    const slow = join(dir, 'openclaw-slow');
    writeFileSync(slow, '#!/bin/sh\nsleep 30\n');
    chmodSync(slow, 0o755);
    const started = Date.now();
    await expect(cliGatewayTransport({ bin: slow, timeoutMs: 200 }).call('sessions.list', {})).rejects.toMatchObject({ code: 'archive_gateway_unreachable' });
    // gstack-timing-ok: the kill bound is the contract under test (timeoutMs + 10 s grace), with 10 s of slack
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  test('a child that writes more than the output bound is stopped and reported as archive_gateway_failed', async () => {
    const loud = join(dir, 'openclaw-loud');
    writeFileSync(loud, '#!/bin/sh\nhead -c 65536 /dev/zero | tr "\\\\0" a\nsleep 5\n');
    chmodSync(loud, 0o755);
    const err = await cliGatewayTransport({ bin: loud, timeoutMs: 20_000, maxOutputBytes: 1024 }).call('sessions.list', {}).then(() => null, e => e as { code?: string; message?: string });
    expect(err?.code).toBe('archive_gateway_failed');
    expect(err?.message).toContain('more than 1024 bytes');
  }, 30_000);

  test('with no override the child is the openclaw binary, launched with an argument array', async () => {
    const launched: Array<{ file: string; args: unknown }> = [];
    const spawn = (async (file: string, args: unknown) => {
      launched.push({ file, args });
      return { error: null, stdout: JSON.stringify({ sessions: [], hasMore: false }), stderr: '' };
    }) as unknown as NonNullable<Parameters<typeof cliGatewayTransport>[0]>['spawn'];
    await cliGatewayTransport({ spawn }).call('sessions.list', { limit: 1 });
    expect(launched).toHaveLength(1);
    expect(launched[0]!.file).toBe('openclaw');
    expect(Array.isArray(launched[0]!.args)).toBe(true);
    expect((launched[0]!.args as string[]).slice(0, 3)).toEqual(['gateway', 'call', 'sessions.list']);
  });
});

describe('openclaw gateway call child environment', () => {
  const envLog = join(dir, 'env.jsonl');
  const envBin = join(dir, 'openclaw-env');
  writeFileSync(envBin, '#!' + process.execPath + '\nrequire("node:fs").appendFileSync(' + JSON.stringify(envLog) + ', JSON.stringify(process.env) + "\\n");\nconsole.log(JSON.stringify({ sessions: [], hasMore: false }));\n');
  chmodSync(envBin, 0o755);
  const lastEnv = () => JSON.parse(readFileSync(envLog, 'utf8').trim().split('\n').pop()!) as Record<string, string>;

  const planted = (line: string) => {
    const project = mkdtempSync(join(dir, 'project-'));
    writeFileSync(join(project, '.env'), line + '\n');
    return () => quarantineCwdDotenv(process.env, project, { warn: () => {} });
  };

  test('a planted OPENCLAW_GATEWAY_URL in a working-folder .env never reaches the child', async () => {
    const quarantine = planted('OPENCLAW_GATEWAY_URL=wss://planted.invalid');
    await withEnv({ OPENCLAW_GATEWAY_URL: 'wss://planted.invalid', GBRAIN_OPENCLAW_GATEWAY_URL: undefined, GBRAIN_OPENCLAW_GATEWAY_TOKEN: 'tok-synthetic-0002' }, async () => {
      quarantine();
      await cliGatewayTransport({ bin: envBin }).call('sessions.list', {});
    });
    const env = lastEnv();
    expect(env.OPENCLAW_GATEWAY_URL).toBeUndefined();
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBe('tok-synthetic-0002');
  }, 30_000);

  test('a planted OPENCLAW_GATEWAY_TOKEN in a working-folder .env never reaches the child', async () => {
    const quarantine = planted('OPENCLAW_GATEWAY_TOKEN=tok-planted-0003');
    await withEnv({ OPENCLAW_GATEWAY_TOKEN: 'tok-planted-0003', GBRAIN_OPENCLAW_GATEWAY_TOKEN: undefined, GBRAIN_OPENCLAW_GATEWAY_URL: 'ws://127.0.0.1:18789' }, async () => {
      quarantine();
      await cliGatewayTransport({ bin: envBin }).call('sessions.list', {});
    });
    const env = lastEnv();
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
    expect(env.OPENCLAW_GATEWAY_URL).toBe('ws://127.0.0.1:18789');
  }, 30_000);

  test('a stock OpenClaw environment with no GBRAIN_ variables reaches the Gateway', async () => {
    await withEnv({ OPENCLAW_GATEWAY_URL: 'ws://127.0.0.1:18790', OPENCLAW_GATEWAY_TOKEN: 'tok-stock-0005', GBRAIN_OPENCLAW_GATEWAY_URL: undefined, GBRAIN_OPENCLAW_GATEWAY_TOKEN: undefined }, async () => {
      await cliGatewayTransport({ bin: envBin }).call('sessions.list', {});
    });
    const env = lastEnv();
    expect(env.OPENCLAW_GATEWAY_URL).toBe('ws://127.0.0.1:18790');
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBe('tok-stock-0005');
  }, 30_000);

  test('the child gets only PATH, HOME, locale and the resolved Gateway URL and token from the parent', async () => {
    await withEnv({ OPENCLAW_STATE_DIR: '/planted/state', OPENCLAW_CONFIG_PATH: '/planted/config.json', GBRAIN_SYNTHETIC_MARKER: 'x', LANG: 'C.UTF-8' }, async () => {
      await cliGatewayTransport({ bin: envBin, url: 'ws://127.0.0.1:18789', token: 'tok-synthetic-0004' }).call('sessions.list', {});
    });
    const env = lastEnv();
    for (const k of ['OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH', 'GBRAIN_SYNTHETIC_MARKER']) expect(env[k]).toBeUndefined();
    expect(env.LANG).toBe('C.UTF-8');
    expect(env.PATH).toBe(process.env.PATH!);
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBe('tok-synthetic-0004');
  }, 30_000);

  test('every OPENCLAW_* name and the gbrain Gateway names are protected from a working-folder .env', () => {
    for (const k of ['OPENCLAW_GATEWAY_URL', 'OPENCLAW_GATEWAY_TOKEN', 'OPENCLAW_GATEWAY_PASSWORD', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH', 'OPENCLAW_HOME', 'OPENCLAW_PROFILE', 'GBRAIN_OPENCLAW_GATEWAY_URL', 'GBRAIN_OPENCLAW_GATEWAY_TOKEN']) {
      expect([k, isCwdDotenvProtectedKey(k)]).toEqual([k, true]);
    }
  });

  test('a child that ignores SIGTERM, and its own child, are gone at the limit', async () => {
    const pids = join(dir, 'stubborn.pids');
    const stubborn = join(dir, 'openclaw-stubborn');
    writeFileSync(stubborn, "#!/bin/sh\ntrap '' TERM\nsleep 40 &\necho $$ $! > " + pids + "\nwait\nsleep 40\n");
    chmodSync(stubborn, 0o755);
    const started = Date.now();
    await expect(cliGatewayTransport({ bin: stubborn, timeoutMs: 200 }).call('sessions.list', {})).rejects.toMatchObject({ code: 'archive_gateway_unreachable' });
    // gstack-timing-ok: the kill bound is the contract under test (timeoutMs + 10 s, then the TERM grace), with slack
    expect(Date.now() - started).toBeLessThan(20_000);
    for (const pid of readFileSync(pids, 'utf8').trim().split(/\s+/).map(Number)) expect([pid, gone(pid)]).toEqual([pid, true]);
  }, 60_000);
});

function gone(pid: number): boolean {
  try {
    const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
  } catch {
    try { process.kill(pid, 0); return false; } catch { return true; }
  }
}
