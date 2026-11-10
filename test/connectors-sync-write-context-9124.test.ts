/**
 * #9124: runConnectorSync hands its write context to the transcripts ingest.
 * Fails when the context is dropped: a managed brain then refuses the direct import.
 * Hermetic: PGLite, fixture server, injected fetch and ingest; no network.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { runConnectorSync } from '../src/core/connectors/sync.ts';
import { saveCredential } from '../src/core/connectors/credentials.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { chatgptHandler, newFixtureState } from './fixtures/connectors/fixture-server.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });

test('runConnectorSync passes opts.context to the ingest call', async () => {
  const T0 = 1_786_000_000;
  const state = newFixtureState([{
    id: 'c-0', title: 'Topic', createTime: T0 - 100, updateTime: T0,
    turns: [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }],
  }]);
  const handler = chatgptHandler(state);
  const home = mkdtempSync(join(tmpdir(), 'gbrain-connector-9124-'));
  const context = { marker: 'write-context' } as unknown as OperationContext;
  const seen: Array<OperationContext | undefined> = [];
  try {
    await withEnv({
      GBRAIN_HOME: home,
      GBRAIN_CONNECTOR_CHATGPT_COOKIE: undefined, GBRAIN_CONNECTOR_CHATGPT_TOKEN: undefined,
    }, async () => {
      saveCredential({ provider: 'chatgpt', strategy: 'browser-session', cookie: 'sessionKey=dummy-9124', savedAt: new Date(0).toISOString() });
      await runConnectorSync(engine, {
        provider: 'chatgpt', sourceId: 'default', context,
        deps: {
          fetchImpl: async (url, init) => handler(new Request(url, init as RequestInit)),
          now: () => (T0 + 100_000) * 1000,
          sleep: () => Promise.resolve(),
          runIngest: (async (_e: unknown, o: { context?: OperationContext }) => {
            seen.push(o.context);
            throw new Error('stop after capture');
          }) as never,
        },
      }).catch(() => undefined);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  expect(seen.length).toBeGreaterThan(0);
  expect(seen[0]).toBe(context);
});
