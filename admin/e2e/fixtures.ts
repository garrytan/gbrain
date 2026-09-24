import { test as base, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

interface BrainFixture { url: string; ownerToken: string; loginLink: (oauthRequest?: string) => Promise<string> }
export const test = base.extend<{}, { brain: BrainFixture }>({
  brain: [async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'gbrain-admin-browser-'));
    const listener = createServer();
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = (listener.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    const url = `http://127.0.0.1:${port}`;
    const ownerToken = `browser-fixture-${randomBytes(24).toString('hex')}`;
    // Deliberate small environment: no provider keys, operator config, DB URL,
    // source routing, or file-backed production brain can enter this process.
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP']) if (process.env[key]) env[key] = process.env[key]!;
    Object.assign(env, { HOME: directory, GBRAIN_HOME: directory, GBRAIN_ADMIN_BOOTSTRAP_TOKEN: ownerToken,
      GBRAIN_TEST_HTTP_PORT: String(port), GBRAIN_TEST_HTTP_PUBLIC_URL: url, GBRAIN_SKIP_STARTUP_HOOKS: '1' });
    const child = spawn('bun', ['--no-env-file', fileURLToPath(new URL('./server.ts', import.meta.url))], {
      cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output = (output + String(chunk)).slice(-8000); });
    child.stderr.on('data', chunk => { output = (output + String(chunk)).slice(-8000); });
    let spawnError: Error | undefined;
    child.on('error', error => { spawnError = error; });
    const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
    try {
      let ready = false;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null) throw new Error(`Browser server exited: ${output}`);
        try { if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch { /* waiting for startup */ }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!ready) throw new Error(`Browser server readiness timed out: ${output}`);
      await use({ url, ownerToken, loginLink: async oauthRequest => {
        const response = await fetch(`${url}/admin/api/issue-magic-link`, { method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
          body: JSON.stringify(oauthRequest ? { oauth_request: oauthRequest } : {}) });
        if (!response.ok) throw new Error(`Fixture owner login-link failed: HTTP ${response.status}`);
        return (await response.json() as { url: string }).url;
      } });
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(timer);
      await rm(directory, { recursive: true, force: true });
    }
  }, { scope: 'worker', timeout: 90_000 }],
});
export { expect };

export async function openOwnerClients(page: Page, brain: BrainFixture): Promise<void> {
  await page.goto(await brain.loginLink());
  await page.goto(`${brain.url}/admin/#agents`);
  await expect(page.getByRole('button', { name: '+ OAuth Client', exact: true })).toBeEnabled();
}

export async function downloadJson(page: Page, label: string): Promise<Record<string, any>> {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: label, exact: true }).click();
  const stream = await (await download).createReadStream();
  if (!stream) throw new Error('Private download stream unavailable');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
