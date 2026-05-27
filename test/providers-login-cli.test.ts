import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let gbrainHome: string;

async function runCli(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(['bun', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, GBRAIN_HOME: gbrainHome, TMPDIR: '/tmp', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('expected TCP server address'));
      else resolve(address.port);
    });
  });
}

async function waitForStderrLine(stream: ReadableStream<Uint8Array>, needle: string): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const line = buffer.split('\n').find(l => l.includes(needle));
    if (line) {
      reader.releaseLock();
      return line;
    }
  }
  reader.releaseLock();
  throw new Error(`did not see stderr line containing ${needle}; saw ${buffer}`);
}

describe('gbrain providers login openai-codex', () => {
  beforeEach(() => {
    gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-codex-login-cli-'));
  });

  afterEach(() => {
    rmSync(gbrainHome, { recursive: true, force: true });
  });

  test('dry-run json prints auth URL and does not require live browser or token mutation', async () => {
    const result = await runCli(['providers', 'login', 'openai-codex', '--dry-run', '--json']);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const json = JSON.parse(result.stdout);
    expect(json.provider).toBe('openai-codex');
    expect(json.mode).toBe('dry-run');
    expect(json.redirect_uri).toBe('http://localhost:1455/auth/callback');
    const authUrl = new URL(json.authorization_url);
    expect(authUrl.origin + authUrl.pathname).toBe('https://auth.openai.com/oauth/authorize');
    expect(authUrl.searchParams.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(authUrl.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    expect(authUrl.searchParams.get('scope')).toBe('openid profile email offline_access');
    expect(authUrl.searchParams.get('id_token_add_organizations')).toBe('true');
    expect(authUrl.searchParams.get('codex_cli_simplified_flow')).toBe('true');
    expect(authUrl.searchParams.get('originator')).toBe('codex_cli_rs');
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(json.token_written).toBe(false);
  });

  test('rejects providers other than openai-codex', async () => {
    const result = await runCli(['providers', 'login', 'openai', '--dry-run']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('providers login currently supports only openai-codex');
  });

  test('live no-open path waits for loopback callback, exchanges code, and writes fallback token', async () => {
    let tokenRequestBody = '';
    const tokenServer = createServer((req, res) => {
      if (req.url !== '/token' || req.method !== 'POST') {
        res.writeHead(404).end('not found');
        return;
      }
      req.setEncoding('utf8');
      req.on('data', chunk => { tokenRequestBody += chunk; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          access_token: 'access-token-secret-1234567890',
          refresh_token: 'refresh-token-secret-1234567890',
          expires_in: 3600,
          token_type: 'Bearer',
        }));
      });
    });
    const tokenPort = await listen(tokenServer);
    const callbackPort = tokenPort + 1;
    const proc = Bun.spawn([
      'bun', 'src/cli.ts', 'providers', 'login', 'openai-codex',
      '--no-open', '--json', '--port', String(callbackPort), '--token-store', 'file',
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GBRAIN_HOME: gbrainHome,
        TMPDIR: '/tmp',
        OPENAI_CODEX_AUTHORIZATION_ENDPOINT: `http://127.0.0.1:${tokenPort}/authorize`,
        OPENAI_CODEX_TOKEN_ENDPOINT: `http://127.0.0.1:${tokenPort}/token`,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    try {
      const authLine = await waitForStderrLine(proc.stderr, 'Open this URL:');
      const authUrl = new URL(authLine.slice(authLine.indexOf('http://')));
      const state = authUrl.searchParams.get('state');
      expect(state).toBeTruthy();
      expect(authUrl.searchParams.get('redirect_uri')).toBe(`http://localhost:${callbackPort}/auth/callback`);
      const callback = await fetch(`http://localhost:${callbackPort}/auth/callback?code=auth-code-secret-1234567890&state=${state}`);
      expect(callback.status).toBe(200);
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect(exitCode).toBe(0);
      const json = JSON.parse(stdout);
      expect(json.provider).toBe('openai-codex');
      expect(json.mode).toBe('login');
      expect(json.token_written).toBe(true);
      expect(json.redirect_uri).toBe(`http://localhost:${callbackPort}/auth/callback`);
      expect(JSON.stringify(json)).not.toContain('access-token-secret');
      expect(tokenRequestBody).toContain('grant_type=authorization_code');
      expect(tokenRequestBody).toContain('code=auth-code-secret-1234567890');
      const tokenPath = join(gbrainHome, '.gbrain', 'openai-codex-credentials.json');
      expect(existsSync(tokenPath)).toBe(true);
      const stored = JSON.parse(readFileSync(tokenPath, 'utf8'));
      expect(stored.access_token).toBe('access-token-secret-1234567890');
    } finally {
      proc.kill();
      tokenServer.close();
    }
  });
});
