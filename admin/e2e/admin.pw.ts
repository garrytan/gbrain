import type { Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { test, expect, openOwnerClients, downloadJson } from './fixtures';

async function register(page: Page, kind: 'machine' | 'public-pkce' | 'confidential-pkce', redirects = 'https://client.example.com/callback', profile = 'memory-reader') {
  const name = `browser-${kind}-${randomBytes(4).toString('hex')}`;
  await page.getByRole('button', { name: '+ OAuth Client', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Register OAuth client', exact: true });
  await dialog.getByLabel('Client name', { exact: true }).fill(name);
  await dialog.getByLabel('Connection type', { exact: true }).selectOption(kind);
  if (kind !== 'machine') await dialog.getByLabel('Exact redirect URIs (one per line)', { exact: true }).fill(redirects);
  if (kind === 'confidential-pkce') await dialog.getByLabel('Client secret authentication', { exact: true }).selectOption('client_secret_basic');
  await dialog.getByLabel('Permission profile', { exact: true }).selectOption(profile);
  await dialog.getByRole('button', { name: 'Preview permissions', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Review connection', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Register with reviewed permissions', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Client registered', exact: true })).toBeVisible();
  const artifact = await downloadJson(page, kind === 'machine' ? 'Download credentials' : 'Download OAuth setup');
  expect(artifact).toBeTruthy();
  return { name, artifact, id: artifact.client_id ?? artifact.client.client_id };
}

for (const kind of ['machine', 'public-pkce', 'confidential-pkce'] as const) {
  test(`real registration controls produce the correct ${kind} setup`, async ({ page, brain }) => {
    await openOwnerClients(page, brain);
    const safeResponses: Record<string, unknown>[] = [];
    page.on('response', async response => {
      if (response.url().includes('/setup?') && response.ok()) safeResponses.push(await response.json());
    });
    const { artifact, name } = await register(page, kind, 'https://client.example.com/callback\nhttps://client.example.com/alternate');
    const registered = page.getByRole('dialog', { name: 'Client registered', exact: true });
    await expect(registered.getByRole('status').first()).toContainText('has not been verified');
    if (kind === 'machine') {
      expect(artifact.version).toBe(1);
      expect(artifact.client_secret).toBeTruthy();
      await expect(registered).not.toContainText(artifact.client_secret);
    } else {
      expect(artifact.kind).toBe('oauth-client-setup');
      expect(artifact.client.grant_types).toEqual(['authorization_code', 'refresh_token']);
      expect(artifact.client.redirect_uris).toEqual(['https://client.example.com/callback', 'https://client.example.com/alternate']);
      expect(artifact.client.token_endpoint_auth_method).toBe(kind === 'public-pkce' ? 'none' : 'client_secret_basic');
      if (kind === 'public-pkce') expect(artifact.client).not.toHaveProperty('client_secret');
      else {
        expect(artifact.client.client_secret).toBeTruthy();
        await expect(registered).not.toContainText(artifact.client.client_secret);
      }
    }
    expect(safeResponses.length).toBeGreaterThan(0);
    for (const response of safeResponses) {
      expect(JSON.stringify(response)).not.toContain('client_secret_hash');
      expect(JSON.stringify(response)).not.toMatch(/gbrain_(?:cs|at|rt)_/);
    }
    await registered.getByRole('button', { name: 'Close Client registered', exact: true }).click();
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
    // The same explicit recovery path works after closing the first delivery.
    await page.getByRole('button', { name, exact: true }).click();
    const recovered = await downloadJson(page, kind === 'machine' ? 'Download credentials' : 'Download OAuth setup');
    expect(recovered.client_secret ?? recovered.client?.client_secret).toBe(artifact.client_secret ?? artifact.client?.client_secret);
  });
}

for (const kind of ['public-pkce', 'confidential-pkce'] as const) {
  test(`${kind} authorization survives a fresh owner browser and completes PKCE`, async ({ page, brain, browser }) => {
    await openOwnerClients(page, brain);
    const callback = `${brain.url}/browser-test-callback`;
    const { artifact, id, name } = await register(page, kind, callback);
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(12).toString('hex');
    const authorization = new URLSearchParams({ client_id: id, redirect_uri: callback, response_type: 'code',
      scope: 'read', code_challenge: challenge, code_challenge_method: 'S256', state, resource: `${brain.url}/mcp` });
    const response = await fetch(`${brain.url}/authorize?${authorization}`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    const pending = new URL(response.headers.get('location')!, brain.url).searchParams.get('oauth_request')!;
    const freshContext = await browser.newContext();
    try {
      const owner = await freshContext.newPage();
      await owner.goto(await brain.loginLink(pending));
      await expect(owner.getByRole('heading', { name: 'Approve client access', exact: true })).toBeVisible();
      await expect(owner.getByRole('button', { name: 'Approve access', exact: true })).toBeEnabled();
      await expect(owner.getByText(name, { exact: true })).toBeVisible();
      await owner.getByRole('button', { name: 'Approve access', exact: true }).click();
      await owner.waitForURL(url => url.pathname === '/browser-test-callback' && url.searchParams.has('code'));
      const returned = new URL(owner.url());
      expect(returned.searchParams.get('state')).toBe(state);
      const data = new URLSearchParams({ grant_type: 'authorization_code', code: returned.searchParams.get('code')!, redirect_uri: callback,
        code_verifier: verifier, resource: `${brain.url}/mcp` });
      const headers: Record<string, string> = {};
      if (kind === 'confidential-pkce') headers.Authorization = `Basic ${Buffer.from(`${id}:${artifact.client.client_secret}`).toString('base64')}`;
      else data.set('client_id', id);
      const token = await fetch(`${brain.url}/token`, { method: 'POST', body: data, headers });
      expect(token.status).toBe(200);
      const credentials = await token.json() as { access_token: string; refresh_token: string };
      expect(credentials.access_token).toBeTruthy();
      expect(credentials.refresh_token).toBeTruthy();
      // Owner administration still rejects the OAuth token, even after approval.
      const admin = await fetch(`${brain.url}/admin/api/clients`, { headers: { Authorization: `Bearer ${credentials.access_token}` } });
      expect(admin.status).toBe(401);
      const refresh = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: credentials.refresh_token });
      if (kind === 'public-pkce') refresh.set('client_id', id);
      expect((await fetch(`${brain.url}/token`, { method: 'POST', headers, body: refresh })).status).toBe(200);
    } finally { await freshContext.close(); }
  });
}

test('owner can edit access, invalidate tokens, revoke and delete through reviewed controls', async ({ page, brain }) => {
  await openOwnerClients(page, brain);
  const { artifact, name, id } = await register(page, 'machine', undefined, 'memory-writer');
  await page.getByRole('button', { name: 'Close Client registered', exact: true }).click();
  await page.getByRole('button', { name, exact: true }).click();
  const setup = page.getByRole('region', { name: 'Set up this client', exact: true });
  await expect(setup.locator('dd').filter({ hasText: /^read write$/ })).toHaveCount(1);
  await page.getByText('Edit access levels', { exact: true }).click();
  await page.getByLabel('Permission profile', { exact: true }).selectOption('memory-reader');
  await page.getByRole('button', { name: 'Preview changes', exact: true }).click();
  await page.getByRole('button', { name: 'Apply reviewed changes', exact: true }).click();
  await expect(page.getByText('Permissions saved. Credentials are unchanged.', { exact: true })).toBeVisible();
  await expect(setup.locator('dd').filter({ hasText: /^read$/ })).toHaveCount(1);
  await expect(setup.locator('dd').filter({ hasText: /^read write$/ })).toHaveCount(0);
  const detail = await page.request.get(`${brain.url}/admin/api/clients/${id}`);
  expect((await detail.json()).grant.scopes).toEqual(['read']);
  const issue = async () => fetch(`${brain.url}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: artifact.client_secret }) });
  const token = await (await issue()).json() as { access_token: string };
  expect(token.access_token).toBeTruthy();
  await page.getByRole('button', { name: 'Invalidate tokens', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Confirm invalidate tokens', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Confirm invalidate tokens', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const revokedToken = await fetch(`${brain.url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  expect(revokedToken.status).toBe(401);
  expect((await issue()).status).toBe(200); // Token invalidation preserves the retained secret.
  await page.getByRole('button', { name, exact: true }).click();
  await page.getByRole('button', { name: 'Revoke client', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm revoke client', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('row').filter({ has: page.getByRole('button', { name, exact: true }) })).toContainText('revoked');
  expect((await issue()).status).not.toBe(200);
  await page.getByRole('button', { name, exact: true }).click();
  await page.getByRole('button', { name: 'Delete client', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm delete client', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
});

test('unavailable clients and sources are visible and registration stays disabled', async ({ page, brain }) => {
  await page.goto(await brain.loginLink());
  await page.route('**/admin/api/agents', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'service_unavailable' }) }));
  await page.route('**/admin/api/sources', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'service_unavailable' }) }));
  await page.goto(`${brain.url}/admin/#agents`);
  await expect(page.getByRole('alert').filter({ hasText: 'Could not load clients' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Could not load current sources' })).toBeVisible();
  await expect(page.getByRole('button', { name: '+ OAuth Client', exact: true })).toBeDisabled();
  await page.unroute('**/admin/api/agents');
  await page.unroute('**/admin/api/sources');
  await page.getByRole('button', { name: 'Retry clients', exact: true }).click();
  await page.getByRole('button', { name: 'Retry sources', exact: true }).click();
  await expect(page.getByRole('button', { name: '+ OAuth Client', exact: true })).toBeEnabled();
});

test('a lost registration response recovers the committed client without registering twice', async ({ page, brain }) => {
  await openOwnerClients(page, brain);
  let mutations = 0;
  await page.route('**/admin/api/register-client', async route => {
    if (route.request().postDataJSON().dryRun) return route.continue();
    mutations++;
    const committed = await route.fetch();
    expect(committed.status()).toBe(200);
    await route.abort('failed');
  });
  const name = `browser-lost-registration-${randomBytes(4).toString('hex')}`;
  await page.getByRole('button', { name: '+ OAuth Client', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Register OAuth client', exact: true });
  await dialog.getByLabel('Client name', { exact: true }).fill(name);
  await dialog.getByLabel('Connection type', { exact: true }).selectOption('public-pkce');
  await dialog.getByLabel('Exact redirect URIs (one per line)', { exact: true }).fill('https://client.example.com/callback');
  await dialog.getByRole('button', { name: 'Preview permissions', exact: true }).click();
  await dialog.getByRole('button', { name: 'Register with reviewed permissions', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Preview permissions', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Open existing client setup', exact: true }).click();
  const artifact = await downloadJson(page, 'Download OAuth setup');
  expect(artifact.client.client_name).toBe(name);
  expect(artifact.client).not.toHaveProperty('client_secret');
  const clients = await (await page.request.get(`${brain.url}/admin/api/clients`)).json();
  expect(clients.clients.filter((client: { client_name: string }) => client.client_name === name)).toHaveLength(1);
  expect(mutations).toBe(1);
});

test('a lost permission-change response requires inspection and refreshes the setup scopes', async ({ page, brain }) => {
  await openOwnerClients(page, brain);
  const { name, id } = await register(page, 'public-pkce', undefined, 'memory-writer');
  await page.getByRole('button', { name: 'Close Client registered', exact: true }).click();
  await page.getByRole('button', { name, exact: true }).click();
  const before = await (await page.request.get(`${brain.url}/admin/api/clients/${id}`)).json();
  let mutations = 0;
  await page.route('**/admin/api/rescope-client', async route => {
    if (route.request().postDataJSON().dryRun) return route.continue();
    mutations++;
    const committed = await route.fetch();
    expect(committed.status()).toBe(200);
    await route.abort('failed');
  });
  await page.getByText('Edit access levels', { exact: true }).click();
  await page.getByLabel('Permission profile', { exact: true }).selectOption('memory-reader');
  await page.getByRole('button', { name: 'Preview changes', exact: true }).click();
  await page.getByRole('button', { name: 'Apply reviewed changes', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'The change may have completed' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preview changes', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Permission profile', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Reload current grant', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Preview changes', exact: true })).toBeEnabled();
  await expect(page.getByRole('region', { name: 'Set up this client', exact: true }).locator('dd').filter({ hasText: /^read$/ })).toHaveCount(1);
  const after = await (await page.request.get(`${brain.url}/admin/api/clients/${id}`)).json();
  expect(after.grant.scopes).toEqual(['read']);
  expect(after.grant.revision).toBe(before.grant.revision + 1);
  expect(mutations).toBe(1);
});

test('registration keeps keyboard focus inside the dialog and restores it when dismissed', async ({ page, brain }) => {
  await openOwnerClients(page, brain);
  const opener = page.getByRole('button', { name: '+ OAuth Client', exact: true });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Register OAuth client', exact: true });
  const close = dialog.getByRole('button', { name: 'Close Register OAuth client', exact: true });
  const preview = dialog.getByRole('button', { name: 'Preview permissions', exact: true });
  await expect(preview).toBeEnabled();
  await expect(dialog.getByLabel('Client name', { exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(preview).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('a refresh failure preserves loaded clients until a successful retry', async ({ page, brain }) => {
  await openOwnerClients(page, brain);
  const { name } = await register(page, 'public-pkce');
  await page.getByRole('button', { name: 'Close Client registered', exact: true }).click();
  const row = page.getByRole('row').filter({ has: page.getByRole('button', { name, exact: true }) });
  await expect(row).toContainText('active');
  await page.route('**/admin/api/agents', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'service_unavailable' }) }));
  await page.getByRole('button', { name: 'Refresh clients', exact: true }).click();
  const error = page.getByRole('alert').filter({ hasText: 'Showing previously loaded clients.' });
  await expect(error).toBeVisible();
  await expect(row).toContainText('active');
  await expect(page.getByText('No clients registered. Register a client to grant access to a harness.', { exact: true })).toHaveCount(0);
  await page.unroute('**/admin/api/agents');
  await page.getByRole('button', { name: 'Retry clients', exact: true }).click();
  await expect(error).toHaveCount(0);
  await expect(row).toContainText('active');
});

test('a lost lifecycle response requires inspection before another action', async ({ page, brain }) => {
  await openOwnerClients(page, brain);
  const { name, id } = await register(page, 'public-pkce');
  await page.getByRole('button', { name: 'Close Client registered', exact: true }).click();
  await page.getByRole('button', { name, exact: true }).click();
  const before = await (await page.request.get(`${brain.url}/admin/api/clients/${id}`)).json();
  let mutations = 0;
  await page.route(`**/admin/api/clients/${id}/lifecycle`, async route => {
    if (route.request().postDataJSON().dryRun) return route.continue();
    mutations++;
    const committed = await route.fetch();
    expect(committed.status()).toBe(200);
    await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Revoke client', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm revoke client', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'The action may have completed' })).toBeVisible();
  for (const action of ['Invalidate tokens', 'Revoke client', 'Delete client']) {
    await expect(page.getByRole('button', { name: action, exact: true })).toBeDisabled();
  }
  await page.getByRole('button', { name: 'Reload client list', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('row').filter({ has: page.getByRole('button', { name, exact: true }) })).toContainText('revoked');
  await page.getByRole('button', { name, exact: true }).click();
  await expect(page.getByText('This client is revoked. Register a new client to connect another harness.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Revoke client', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete client', exact: true })).toBeEnabled();
  const after = await (await page.request.get(`${brain.url}/admin/api/clients/${id}`)).json();
  expect(after.grant.revoked).toBe(true);
  expect(after.grant.revision).toBe(before.grant.revision + 1);
  expect(mutations).toBe(1);
});
