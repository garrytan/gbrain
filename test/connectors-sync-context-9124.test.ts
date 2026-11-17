/**
 * #9124: `connectors sync` hands the CLI's write context to the transcripts ingest.
 * Without it a writer-claimed brain refuses the direct import, so chat history never lands there.
 * Seams: the ChatGPT fixture handler in process (no network), PGLite, the real ingest behind a recording wrapper.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runConnectorSync } from '../src/core/connectors/sync.ts';
import { saveCredential } from '../src/core/connectors/credentials.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { runTranscriptsIngest } from '../src/core/transcripts/ingest.ts';
import { chatgptHandler, newFixtureState } from './fixtures/connectors/fixture-server.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

const T0 = 1_786_000_000;

test('runConnectorSync passes its context to every ingest batch, and the import still lands', async () => {
  const handler = chatgptHandler(newFixtureState([{
    id: 'c-9124', title: 'Synthetic topic', createTime: T0 - 100, updateTime: T0,
    turns: [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }],
  }]));
  const home = mkdtempSync(join(tmpdir(), 'gbrain-connectors-9124-'));
  const context = { remote: false, sourceId: 'default' } as unknown as OperationContext;
  const seen: Array<OperationContext | undefined> = [];
  try {
    const result = await withEnv({ GBRAIN_HOME: home }, async () => {
      saveCredential({ provider: 'chatgpt', strategy: 'browser-session', cookie: 'sessionKey=fixture', savedAt: new Date(0).toISOString() });
      return runConnectorSync(engine, {
        provider: 'chatgpt',
        sourceId: 'default',
        context,
        deps: {
          fetchImpl: async (url, init) => handler(new Request(url, init as RequestInit)),
          now: () => (T0 + 100_000) * 1000,
          sleep: () => Promise.resolve(),
          runIngest: (e, o) => { seen.push(o.context); return runTranscriptsIngest(e, o); },
        },
      });
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const c of seen) expect(c).toBe(context);
    expect(result.ingest?.imported).toBe(1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);
