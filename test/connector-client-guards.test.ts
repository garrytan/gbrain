/**
 * ConnectorClient guards the API-token sources (meetings, slack) rely on: a body past maxResponseBytes fails
 * connector_response_too_large instead of being buffered, a stalled request fails as a network TIMEOUT, and a
 * caller's abort surfaces as its own reason rather than a network error. Injected fetch only; no network.
 */
import { describe, expect, test } from 'bun:test';
import { ConnectorClient, ConnectorNetworkError, ConnectorResponseTooLargeError, type ConnectorFetch } from '../src/core/connectors/client.ts';

const client = (fetchImpl: ConnectorFetch, extra: { maxResponseBytes?: number; requestTimeoutMs?: number } = {}) =>
  new ConnectorClient({ baseUrl: 'https://api.example.invalid', headers: async () => ({}), minDelayMs: 0, fetchImpl, ...extra });
const stalled: ConnectorFetch = (_url, init) => new Promise((_resolve, reject) => {
  if (init?.signal?.aborted) reject(init.signal.reason);
  init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
});

describe('ConnectorClient guards', () => {
  test('a body over maxResponseBytes fails and is not read whole', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { pulled++; controller.enqueue(new Uint8Array(64)); } });
    const c = client(async () => new Response(body, { status: 200 }), { maxResponseBytes: 100 });
    await expect(c.fetchJSON('/x')).rejects.toBeInstanceOf(ConnectorResponseTooLargeError);
    expect(pulled).toBeLessThan(5);
    const small = client(async () => new Response('{"ok":true}', { status: 200 }), { maxResponseBytes: 100 });
    expect(await small.postJSON<{ ok: boolean }>('/x', { a: 1 })).toEqual({ ok: true });
  });

  test('a stalled request fails as a network timeout', async () => {
    const error = await client(stalled, { requestTimeoutMs: 20 }).fetchJSON('/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectorNetworkError);
    expect(String((error as Error).message)).toContain('TIMEOUT');
  });

  test("a caller's abort surfaces as its reason, not a network error", async () => {
    const controller = new AbortController();
    const reason = new Error('stopped by the caller');
    const pending = client(stalled, { requestTimeoutMs: 60_000 }).fetchJSON('/x', { signal: controller.signal });
    controller.abort(reason);
    expect(await pending.catch(e => e)).toBe(reason);
  });
});
