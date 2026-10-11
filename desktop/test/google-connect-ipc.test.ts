import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  googleConnectArgv,
  sanitizeGoogleConnectEnvelope,
} from '../../src/core/creds/oauth-envelope.ts';

const read = (path: string) => readFileSync(resolve(path), 'utf8');
const main = readdirSync(resolve('src/main'), { recursive: true })
  .filter((path): path is string => typeof path === 'string' && path.endsWith('.ts'))
  .map((path) => readFileSync(resolve('src/main', path), 'utf8'))
  .join('\n');
const renderer = read('src/renderer/src.ts');
const preload = read('src/preload/index.ts');
const html = read('src/renderer/settings-content.html');
const ipc = read('src/main/ipc-handlers.ts');
const product = read('src/main/product-surfaces.ts');

describe('Desktop Google connect IPC', () => {
  test('forwards connect to Sidecar CLI and never implements OAuth in Electron', () => {
    expect(ipc).toContain("registerTrustedHandler('desktop:google-connect'");
    expect(ipc).toContain("registerTrustedHandler('desktop:product-waiting'");
    expect(product).toContain('runCli(runtime, argv)');
    expect(product).toContain('googleConnectArgv');
    expect(product).toContain('sanitizeGoogleConnectEnvelope');
    expect(product).toContain("admin('/admin/api/waiting?limit=20')");
    expect(main).not.toContain('startLoopback');
    expect(main).not.toContain('exchangeCode');
    expect(googleConnectArgv()).toEqual(['google', 'connect', '--json']);
  });

  test('renderer never logs or receives OAuth codes from IPC', () => {
    expect(renderer).not.toContain('console.log');
    expect(renderer).not.toContain('startLoopback');
    expect(renderer).not.toContain('authorization_code');
    expect(renderer).not.toContain('client_secret');
    expect(renderer).not.toContain('refresh_token');
    expect(renderer).not.toContain('access_token');
    expect(preload).not.toContain('startLoopback');
    expect(html).toContain('<section class="panel" id="panel-connections" hidden>');
    expect(html).toContain('id="daily-google-redirect"');
    expect(html).toContain('改用粘贴网址');
    expect(renderer).toContain('googleConnect');
    expect(renderer).toContain("$<HTMLInputElement>('#daily-google-redirect').value = ''");
  });

  test('IPC return path strips leaked codes even if CLI stdout is dirty', () => {
    const envelope = sanitizeGoogleConnectEnvelope({
      ok: true,
      status: 'connected',
      refresh_token: 'should-not-leak',
      code: '4/secret',
      next_action: { user_message: 'http://127.0.0.1/?code=4/leak' },
    });
    expect(JSON.stringify(envelope)).not.toContain('should-not-leak');
    expect(JSON.stringify(envelope)).not.toContain('4/secret');
    expect(JSON.stringify(envelope)).not.toContain('4/leak');
    expect(product).toContain('sanitizeGoogleConnectEnvelope(parsed)');
  });
});
