import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runConnectorSync } from '../../src/core/connectors/sync.ts';
import { saveCredential } from '../../src/core/connectors/credentials.ts';
import { CHATGPT_BASE_URL } from '../../src/core/connectors/providers/chatgpt.ts';
import { CLAUDE_BASE_URL } from '../../src/core/connectors/providers/claude.ts';
import { runTranscriptsIngest } from '../../src/core/transcripts/ingest.ts';
import { watermarkKey } from '../../src/core/connectors/config-keys.ts';
import { chatgptHandler, claudeHandler, newFixtureState, startFixture } from '../fixtures/connectors/fixture-server.ts';

for (const provider of ['chatgpt', 'claude'] as const) test(`${provider}: Review gate precedes every native record and uncertainty never advances watermark`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'b336-native-gate-')); const previous = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = root;
  const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  const script = join(root, 'review.mjs');
  writeFileSync(script, `import {createHash} from 'node:crypto';let raw='';for await(const chunk of process.stdin)raw+=chunk;const p=JSON.parse(raw);console.log(JSON.stringify({schema:'gbrain-connector-review-output/v1',input_sha256:createHash('sha256').update(raw).digest('hex'),verdict:p.session_id}));`);
  const state = newFixtureState(['keep', 'noise', 'unsure'].map((id, n) => ({id, title: id, createTime: 1786000000 + n,
    updateTime: 1786000010 + n, turns: [{role: 'user' as const, text: 'The full ' + id + ' text'}]})));
  const srv = startFixture(provider === 'chatgpt' ? chatgptHandler(state) : claudeHandler(state));
  try {
    saveCredential({provider, strategy: 'browser-session', cookie: 'sessionKey=fixture', savedAt: new Date(0).toISOString()});
    let ingestCalls = 0;
    const r = await runConnectorSync(engine, {provider, sourceId: 'default', reviewArgv: [process.execPath, script],
      deps: {fetchImpl: (url, init) => fetch(url.replace(provider === 'chatgpt' ? CHATGPT_BASE_URL : CLAUDE_BASE_URL, srv.baseUrl), init),
        sleep: async () => {}, now: () => 1786100000000,
        runIngest: async (eng, opts) => {
          const text = await Bun.file(opts.paths![0]).text();
          expect(text).toContain('The full keep text'); expect(text).not.toContain('The full noise text');
          expect(text).not.toContain('The full unsure text'); ingestCalls++;
          return runTranscriptsIngest(eng, opts);
        }}});
    expect(ingestCalls).toBe(1); expect(r.ingest?.imported).toBe(1);
    expect(r.reviewNoise).toBe(1); expect(r.reviewKept).toBe(1); expect(r.reviewHeld).toEqual(['unsure']);
    expect(r.status).toBe('partial'); expect(r.quarantined).toEqual([]);
    expect(await engine.getConfig(watermarkKey(provider, 'default'))).toBeNull();
    const rows = await engine.executeRaw<{n:number}>('SELECT count(*)::int AS n FROM pages'); expect(rows[0].n).toBe(1);
  } finally {
    srv.stop(); await engine.disconnect();
    if (previous === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = previous;
    const trash = join(homedir(), '.Trash'); mkdirSync(trash, {recursive:true}); renameSync(root, join(trash, root.split('/').pop()!));
  }
}, 60000);
