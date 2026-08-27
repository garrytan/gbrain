/**
 * connectors-providers.test.ts — pure provider/client bits: timestamp
 * normalization + the client off-origin guard + 401→refresh→retry.
 */
import { describe, expect, test } from 'bun:test';
import { toIso } from '../src/core/connectors/providers/chatgpt.ts';
import { ConnectorClient, ConnectorForbiddenError } from '../src/core/connectors/client.ts';

describe('toIso normalization', () => {
  test('epoch seconds (float) → Z ISO', () => {
    expect(toIso(1_786_000_000)).toBe(new Date(1_786_000_000 * 1000).toISOString());
  });
  test('ISO string → normalized Z ISO', () => {
    expect(toIso('2026-08-07T12:00:00Z')).toBe('2026-08-07T12:00:00.000Z');
  });
  test('garbage → empty string', () => {
    expect(toIso(undefined)).toBe('');
    expect(toIso('not a date')).toBe('');
    expect(toIso(0)).toBe('');
  });
});

describe('ConnectorClient', () => {
  test('off-origin URL is refused (credential never leaves the origin)', async () => {
    const client = new ConnectorClient({
      baseUrl: 'https://chatgpt.com',
      headers: async () => ({ cookie: 'secret' }),
      fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    await expect(client.fetchJSON('https://evil.example.com/steal')).rejects.toBeInstanceOf(ConnectorForbiddenError);
  });

  test('401 → refresh() once → retry → success', async () => {
    let calls = 0;
    let refreshed = 0;
    const client = new ConnectorClient({
      baseUrl: 'https://chatgpt.com',
      headers: async () => ({}),
      refresh: async () => {
        refreshed++;
        return true;
      },
      sleep: () => Promise.resolve(),
      fetchImpl: async () => {
        calls++;
        if (calls === 1) return new Response('{"error":"expired"}', { status: 401, headers: { 'content-type': 'application/json' } });
        return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const r = await client.fetchJSON<{ ok: boolean }>('/x');
    expect(refreshed).toBe(1);
    expect(r.ok).toBe(true);
  });

  test('401 that persists after refresh → ConnectorAuthError', async () => {
    const { ConnectorAuthError } = await import('../src/core/connectors/client.ts');
    const client = new ConnectorClient({
      baseUrl: 'https://chatgpt.com',
      headers: async () => ({}),
      refresh: async () => true,
      sleep: () => Promise.resolve(),
      fetchImpl: async () => new Response('{"error":"expired"}', { status: 401, headers: { 'content-type': 'application/json' } }),
    });
    await expect(client.fetchJSON('/x')).rejects.toBeInstanceOf(ConnectorAuthError);
  });
});
