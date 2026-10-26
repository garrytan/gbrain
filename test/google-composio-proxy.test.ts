import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createComposioCalendarFetch, createComposioGmailFetch } from '../src/core/google/composio-proxy.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function registry(email = 'reader@example.com'): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-composio-'));
  dirs.push(dir);
  const secret = join(dir, 'secret.json');
  writeFileSync(secret, JSON.stringify({ project_id: 'project-1', project_api_key: 'private-key' }), { mode: 0o600 });
  const path = join(dir, 'accounts.json');
  writeFileSync(path, JSON.stringify({ accounts: [{
    id: 'reader', projectId: 'project-1', userId: 'user-1', projectApiKeySecretPath: secret,
    toolkits: {
      gmail: { connectedAccountId: 'connected-1', profile: { email } },
      googlecalendar: { connectedAccountId: 'calendar-1', profile: { email } },
    },
  }] }));
  return path;
}

describe('Composio Gmail transport', () => {
  test('pins account identity, allows Gmail GET only, and maps proxy status', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const transport = async (url: string, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url, body });
      if (url.endsWith('/session')) return Response.json({ id: 'session-1' });
      return Response.json({ status: 404, data: { error: { message: 'thread gone' } } });
    };
    const fetcher = createComposioGmailFetch('reader@example.com', 'reader', { registryPath: registry(), transport });
    const result = await fetcher('https://gmail.googleapis.com/gmail/v1/users/me/threads/missing');
    expect(result.status).toBe(404);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body.connectedAccounts).toEqual({ gmail: ['connected-1'] });
    expect(calls[1]?.body).toEqual({
      toolkit_slug: 'gmail', endpoint: 'https://gmail.googleapis.com/gmail/v1/users/me/threads/missing', method: 'GET',
    });
    expect(JSON.stringify(calls)).not.toContain('private-key');
    await expect(fetcher('https://evil.example/v1/users/me/profile')).rejects.toThrow('read-only Gmail');
    await expect(fetcher('https://gmail.googleapis.com/gmail/v1/users/me/messages', { method: 'POST' })).rejects.toThrow('read-only Gmail');
    expect(calls).toHaveLength(2);
  });

  test('refuses a registry alias pointing to another Gmail account', () => {
    expect(() => createComposioGmailFetch('owner@example.com', 'reader', { registryPath: registry() }))
      .toThrow('identity does not match');
  });
});

test('Composio Calendar transport pins the account and allows Calendar GET only', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const transport = async (_url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push(body);
    return calls.length === 1 ? Response.json({ id: 'session-1' })
      : Response.json({ result: { status: 200, data: { id: 'reader@example.com' } } });
  };
  const fetcher = createComposioCalendarFetch('reader@example.com', 'reader', { registryPath: registry(), transport });
  const result = await fetcher('https://www.googleapis.com/calendar/v3/calendars/primary');
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ id: 'reader@example.com' });
  expect(calls[0]?.connectedAccounts).toEqual({ googlecalendar: ['calendar-1'] });
  expect(calls[1]).toEqual({ toolkit_slug: 'googlecalendar', endpoint: 'https://www.googleapis.com/calendar/v3/calendars/primary', method: 'GET' });
  await expect(fetcher('https://gmail.googleapis.com/gmail/v1/users/me/profile')).rejects.toThrow('read-only Calendar');
  await expect(fetcher('https://www.googleapis.com/calendar/v3/calendars/primary', { method: 'POST' })).rejects.toThrow('read-only Calendar');
  expect(() => createComposioCalendarFetch('other@example.com', 'reader', { registryPath: registry() }))
    .toThrow('identity does not match');
});

test('Calendar rejects normalized service escapes before any proxy session is opened', async () => {
  let calls = 0;
  const transport = async () => { calls++; return Response.json({ id: 'fixture', status: 200, data: {} }); };
  const fetcher = createComposioCalendarFetch('reader@example.com', 'reader', { registryPath: registry(), transport });
  for (const url of [
    'https://www.googleapis.com/calendar/v3/../../../gmail/v1/users/me/profile',
    'https://www.googleapis.com/calendar/v3/%2e%2e/%2e%2e/%2e%2e/gmail/v1/users/me/profile',
    'https://www.googleapis.com/calendar/v3/..%2fgmail/v1/users/me/profile',
  ]) await expect(fetcher(url)).rejects.toThrow('read-only Calendar');
  await expect(fetcher('https://www.googleapis.com/calendar/v3/calendars/primary', { body: '' })).rejects.toThrow('read-only Calendar');
  expect(calls).toBe(0);
});

test('proxy requests use the validated normalized URL', async () => {
  const endpoints: unknown[] = [];
  const transport = async (url: string, init?: RequestInit) => {
    if (url.endsWith('/session')) return Response.json({ id: 'fixture' });
    endpoints.push(JSON.parse(String(init?.body)).endpoint);
    return Response.json({ status: 200, data: {} });
  };
  const fetcher = createComposioCalendarFetch('reader@example.com', 'reader', { registryPath: registry(), transport });
  await fetcher('https://www.googleapis.com/calendar/v3/calendars/primary/events/../events');
  expect(endpoints).toEqual(['https://www.googleapis.com/calendar/v3/calendars/primary/events']);
});

test('two missing proxy sessions cause no unused third session request', async () => {
  let sessions = 0;
  let proxies = 0;
  const transport = async (url: string) => {
    if (url.endsWith('/session')) return Response.json({ id: `fixture-${++sessions}` });
    proxies++;
    return new Response('', { status: 404 });
  };
  const fetcher = createComposioGmailFetch('reader@example.com', 'reader', { registryPath: registry(), transport });
  expect((await fetcher('https://gmail.googleapis.com/gmail/v1/users/me/profile')).status).toBe(502);
  expect(proxies).toBe(2);
  expect(sessions).toBe(2);
});
