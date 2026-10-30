/**
 * #7483: a connector credential value never reaches probe detail, sync hints or logs.
 *
 * 1. Protects: a Cookie/Authorization value holding CR, LF, NUL or a non-ASCII character is refused before any
 *    request with the fixed code invalid_header_value, and a fetch layer whose error text echoes header values
 *    (Node's undici does: "Headers.append: \"<value>\" is an invalid header value.") never has that text copied out.
 * 2. Fails when: the client sends an unvalidated header value, or a provider probe / the sync orchestrator copies a
 *    raw fetch error message into ProbeResult.detail, ConnectorSyncResult.hint or the log.
 * 3. Dummy values only; no live provider is called.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { ConnectorClient, ConnectorCredentialFormatError, type ConnectorFetch } from '../src/core/connectors/client.ts';
import { chatgptProvider, CHATGPT_BASE_URL } from '../src/core/connectors/providers/chatgpt.ts';
import { claudeProvider, CLAUDE_BASE_URL } from '../src/core/connectors/providers/claude.ts';
import { runConnectorSync } from '../src/core/connectors/sync.ts';
import { saveCredential } from '../src/core/connectors/credentials.ts';
import { authErrorAtKey } from '../src/core/connectors/config-keys.ts';

const MARKER = 'dummy-marker-7483';
const MALFORMED: Record<string, string> = {
  lf: `sessionKey=${MARKER}\nX`,
  crlf: `sessionKey=${MARKER}\r\nX`,
  nul: `sessionKey=${MARKER}\u0000X`,
  non_ascii: `sessionKey=${MARKER}\u20acX`,
};

/** The undici shape: a header-validation TypeError whose message quotes the value. */
const echoingFetch = (calls: { n: number }): ConnectorFetch => async (_url, init) => {
  calls.n++;
  const value = Object.values(init.headers as Record<string, string>).find(v => v.includes(MARKER)) ?? '';
  throw new TypeError(`Headers.append: "${value}" is an invalid header value.`);
};

let engine: PGLiteEngine;
let home: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  if (home) rmSync(home, { recursive: true, force: true });
  home = mkdtempSync(join(tmpdir(), 'gbrain-connector-7483-'));
});

function env<T>(fn: () => Promise<T>): Promise<T> {
  return withEnv({
    GBRAIN_HOME: home,
    GBRAIN_CONNECTOR_CHATGPT_COOKIE: undefined, GBRAIN_CONNECTOR_CHATGPT_TOKEN: undefined,
    GBRAIN_CONNECTOR_CLAUDE_COOKIE: undefined, GBRAIN_CONNECTOR_CLAUDE_TOKEN: undefined,
  }, fn);
}

describe('#7483 malformed header values are refused before any request', () => {
  for (const [shape, cookie] of Object.entries(MALFORMED)) {
    for (const [provider, base] of [[chatgptProvider, CHATGPT_BASE_URL], [claudeProvider, CLAUDE_BASE_URL]] as const) {
      test(`${provider.name} probe, ${shape}: invalid_credential, value absent, no request`, async () => {
        const calls = { n: 0 };
        const client = new ConnectorClient({
          baseUrl: base,
          headers: () => provider.authHeaders({ provider: provider.name, strategy: 'browser-session', cookie, savedAt: new Date(0).toISOString() }),
          fetchImpl: echoingFetch(calls),
          sleep: () => Promise.resolve(),
        });
        const r = await provider.probe(client);
        expect(r).toMatchObject({ ok: false, kind: 'invalid_credential' });
        expect(JSON.stringify(r)).not.toContain(MARKER);
        expect(calls.n).toBe(0);
      });
    }
  }

  test('the real runtime fetch is never reached with the value (the client throws its own fixed error)', async () => {
    const client = new ConnectorClient({ baseUrl: 'http://127.0.0.1:9', headers: async () => ({ authorization: `Bearer ${MARKER}\nX` }), sleep: () => Promise.resolve() });
    const e = await client.fetchJSON('/x').then(() => null, (err: unknown) => err);
    expect(e).toBeInstanceOf(ConnectorCredentialFormatError);
    expect((e as ConnectorCredentialFormatError).code).toBe('invalid_header_value');
    expect((e as Error).message).toContain('authorization');
    expect((e as Error).message).not.toContain(MARKER);
  });

  test('sync with a stored malformed cookie: auth_required, auth_error_at stamped, hint and log free of the value', async () => {
    await env(async () => {
      saveCredential({ provider: 'chatgpt', strategy: 'browser-session', cookie: MALFORMED.crlf, savedAt: new Date(0).toISOString() });
      const calls = { n: 0 };
      const logs: string[] = [];
      const r = await runConnectorSync(engine, {
        provider: 'chatgpt',
        deps: { fetchImpl: echoingFetch(calls), sleep: () => Promise.resolve(), log: m => logs.push(m) },
      });
      expect(r.status).toBe('auth_required');
      expect(r.hint).toContain('cannot carry');
      expect(JSON.stringify(r)).not.toContain(MARKER);
      expect(logs.join('\n')).not.toContain(MARKER);
      expect(calls.n).toBe(0);
      expect(await engine.getConfig(authErrorAtKey('chatgpt'))).toBeTruthy();
    });
  });
});

describe('#7483 a fetch error that echoes a header value is never copied out', () => {
  test('probe detail carries the error code, not the runtime text', async () => {
    const calls = { n: 0 };
    const client = new ConnectorClient({
      baseUrl: CHATGPT_BASE_URL,
      headers: async () => ({ cookie: `sessionKey=${MARKER}` }),
      fetchImpl: echoingFetch(calls),
      sleep: () => Promise.resolve(),
    });
    const r = await chatgptProvider.probe(client);
    expect(r).toMatchObject({ ok: false, kind: 'network' });
    expect(JSON.stringify(r)).not.toContain(MARKER);
    expect(JSON.stringify(r)).toContain('TypeError');
    expect(calls.n).toBe(1);
  });

  test('sync: the probe hint (printed by --json, stored by a background job) is free of the value', async () => {
    await env(async () => {
      saveCredential({ provider: 'claude', strategy: 'browser-session', cookie: `sessionKey=${MARKER}`, savedAt: new Date(0).toISOString() });
      const logs: string[] = [];
      const r = await runConnectorSync(engine, {
        provider: 'claude',
        deps: { fetchImpl: echoingFetch({ n: 0 }), sleep: () => Promise.resolve(), log: m => logs.push(m) },
      });
      expect(r.status).toBe('partial');
      expect(r.hint).toContain('probe failed');
      expect(JSON.stringify(r)).not.toContain(MARKER);
      expect(logs.join('\n')).not.toContain(MARKER);
    });
  });
});
