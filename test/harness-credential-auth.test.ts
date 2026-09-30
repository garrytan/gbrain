import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { credentialAccessToken, readCredentials, validateCredentials, writeCredentials, type HarnessCredentials } from '../src/core/harness/credentials.ts';

const credential: HarnessCredentials = { version: 1, mcp_url: 'https://brain.example/mcp', issuer_url: 'https://brain.example',
  client_id: 'client:example+/%', client_secret: 'secret:example+/%' };

test('Basic machine authentication survives private handoff and uses form-encoded credentials only in its header', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-credential-method-'));
  try {
    const path = join(root, 'credentials.json');
    writeCredentials(path, { ...credential, token_endpoint_auth_method: 'client_secret_basic' });
    const loaded = readCredentials(path);
    expect(loaded.token_endpoint_auth_method).toBe('client_secret_basic');
    let called = false;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      called = true;
      expect(url).toBe('https://brain.example/token');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Basic ' + Buffer.from('client%3Aexample%2B%2F%25:secret%3Aexample%2B%2F%25').toString('base64'));
      expect(String(init?.body)).toBe('grant_type=client_credentials');
      expect(init?.redirect).toBe('error');
      return Response.json({ access_token: 'gbrain_at_synthetic-test-token' });
    }) as typeof fetch;
    expect(await credentialAccessToken(loaded, undefined, fetchImpl)).toBe('gbrain_at_synthetic-test-token');
    expect(called).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('old handoffs preserve POST authentication and never send mixed Basic and body credentials', async () => {
  const loaded = validateCredentials(credential);
  expect(loaded.token_endpoint_auth_method).toBeUndefined();
  let requests = 0;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    requests++;
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    const body = new URLSearchParams(String(init?.body));
    expect(body.get('client_id')).toBe(credential.client_id);
    expect(body.get('client_secret')).toBe(credential.client_secret!);
    expect(body.get('grant_type')).toBe('client_credentials');
    return Response.json({ access_token: 'gbrain_at_synthetic-post-token' });
  }) as typeof fetch;
  await credentialAccessToken(loaded, undefined, fetchImpl);
  await credentialAccessToken({ ...loaded, token_endpoint_auth_method: 'client_secret_post' }, undefined, fetchImpl);
  expect(requests).toBe(2);
  for (const invalid of ['none', 'client_secret_jwt', null, 42]) {
    expect(() => validateCredentials({ ...credential, token_endpoint_auth_method: invalid })).toThrow('Machine credential authentication');
  }
});
