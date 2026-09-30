/**
 * #5666 follow-up: a conversation that downloads but fails to ingest is
 * attributed per conversation. Its batch siblings are recorded as synced,
 * and after QUARANTINE_ATTEMPTS failures at the same version it is
 * quarantined and stops holding the watermark back, exactly like a
 * conversation whose fetch keeps failing.
 *
 * Real ConnectorClient against the fixture backend, real ingest for every
 * conversation; the ingest seam only reports one conversation's session as
 * failed. No network, no provider spend.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { runConnectorSync } from '../../src/core/connectors/sync.ts';
import { saveCredential } from '../../src/core/connectors/credentials.ts';
import { CHATGPT_BASE_URL } from '../../src/core/connectors/providers/chatgpt.ts';
import { runTranscriptsIngest } from '../../src/core/transcripts/ingest.ts';
import { type FixtureConversation, type FixtureState, chatgptHandler, newFixtureState, startFixture } from '../fixtures/connectors/fixture-server.ts';

let engine: PGLiteEngine;
let tmp: string;
let prevHome: string | undefined;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => {
  await engine.disconnect();
  if (prevHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prevHome;
});
beforeEach(async () => {
  await resetPgliteState(engine);
  tmp = mkdtempSync(join(tmpdir(), 'gb-connectors-ingest-fail-'));
  prevHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = tmp;
  saveCredential({ provider: 'chatgpt', strategy: 'browser-session', cookie: 'sessionKey=fixture', savedAt: new Date(0).toISOString() });
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const T0 = 1_786_000_000;
const NOW_MS = (T0 + 100_000) * 1000;

function conv(id: string, updateTime: number): FixtureConversation {
  return { id, title: `Title ${id}`, createTime: updateTime - 100, updateTime,
    turns: [{ role: 'user', text: `question ${id}` }, { role: 'assistant', text: `answer ${id}` }] };
}

/** Real ingest; the session for `failingId` is reported as a failed import. */
function ingestFailing(failingId: string): typeof runTranscriptsIngest {
  return async (eng, opts) => {
    const r = await runTranscriptsIngest(eng, opts);
    for (const file of r.files) {
      for (const s of file.sessions) {
        if (s.sessionId !== failingId) continue;
        s.error = 'page import returned error status';
        r.sessionsErrored++;
        r.cleanScan = false;
      }
    }
    return r;
  };
}

async function run(state: FixtureState, runIngest: typeof runTranscriptsIngest) {
  const srv = startFixture(chatgptHandler(state));
  try {
    return await runConnectorSync(engine, {
      provider: 'chatgpt',
      sourceId: 'default',
      deps: {
        fetchImpl: (url, init) => fetch(url.replace(CHATGPT_BASE_URL, srv.baseUrl), init),
        now: () => NOW_MS,
        sleep: () => Promise.resolve(),
        runIngest,
      },
    });
  } finally {
    srv.stop();
  }
}

describe('connector ingest failures', () => {
  test('a conversation that fails to ingest is quarantined and stops holding the watermark', async () => {
    const state = newFixtureState([conv('c-1', T0 + 10), conv('c-2', T0 + 20), conv('c-3', T0 + 30)]);
    const runIngest = ingestFailing('c-1');
    const results = [];
    for (let k = 0; k < 4; k++) results.push(await run(state, runIngest));

    // Siblings in the failing batch are synced on the first run, not re-fetched.
    expect(state.hits['detail:c-2']).toBe(1);
    expect(state.hits['detail:c-3']).toBe(1);
    expect(state.hits['detail:c-1']).toBe(3);
    expect(results.slice(0, 2).map(r => r.watermarkAdvancedTo)).toEqual([undefined, undefined]);
    expect(results[2].quarantined).toEqual(['c-1']);
    expect(results[2].watermarkAdvancedTo).toBe(new Date((T0 + 30) * 1000).toISOString());
    expect(results[3].fetched).toBe(0);
    expect(results[3].status).toBe('nothing_new');
  });
});
