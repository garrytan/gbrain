/**
 * context-pack IPC handler — ambient-writeback LANE DERIVATION (WP4). The
 * handler tags `.wb-<hash>.txt` basenames with `lane: 'writeback'` so the
 * serve-side harvest applies the auto_writeback gate + wb heartbeat event
 * instead of the compact lane's receipt/manifest path. A regression here
 * silently routes wb turns down the compact lane, so the pin is the LANE
 * EVIDENCE itself: the drained job heartbeats under `event: 'writeback'`
 * (never 'checkpoint-harvest') and no facts land (the wb lane's own
 * keyless/gate-off guards fire first; chat transport throws to prove zero
 * LLM either way).
 *
 * Serial: real PGLite + module-global harvest queue + GBRAIN_HOME env
 * (checkpoint-harvest.serial.test.ts harness).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __setChatTransportForTests, resetGateway } from '../src/core/ai/gateway.ts';
import { __resetFactsQueueForTests } from '../src/core/facts/queue.ts';
import {
  __drainCheckpointHarvestForTests,
  __resetCheckpointHarvestForTests,
} from '../src/core/context/checkpoint-harvest.ts';
import { bankWritebackTurn } from '../src/core/context/corpus-segments.ts';
import { gateWritebackTurn } from '../src/core/facts/writeback-gate.ts';
import { makeContextPackIpcHandler } from '../src/mcp/context-pack-handler.ts';
import { readHeartbeatTail } from '../src/core/context/hook-heartbeat.ts';

let engine: PGLiteEngine;
let corpusDir: string;
let homeDir: string;
let savedHome: string | undefined;
const tmpDirs: string[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

beforeEach(async () => {
  __resetCheckpointHarvestForTests();
  corpusDir = mkdtempSync(join(tmpdir(), 'gb-wblane-corpus-'));
  homeDir = mkdtempSync(join(tmpdir(), 'gb-wblane-home-'));
  tmpDirs.push(corpusDir, homeDir);
  savedHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = homeDir;
  await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
  await engine.unsetConfig('memory.auto_writeback');
  await engine.executeRaw('DELETE FROM facts').catch(() => {});
});

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
  __resetFactsQueueForTests();
  if (savedHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = savedHome;
});

describe('context_pack handler — wb basename → writeback lane', () => {
  test('a .wb- flushCorpusFile schedules under the writeback lane: wb heartbeat event, no compact receipt path, zero facts', async () => {
    __setChatTransportForTests(async () => {
      throw new Error('must not be called — the wb lane guards fire before extraction');
    });
    const gated = gateWritebackTurn('I prefer dark mode in every editor, please set it up.');
    if (!gated.ok) throw new Error('fixture gated');
    const banked = await bankWritebackTurn(corpusDir, 'sess-lane', gated.normalized, gated.hash24);
    expect(banked.status).toBe('wb_banked');
    const wbFile = banked.flushCorpusFile!;
    expect(wbFile).toMatch(/^sess-lane\.wb-[0-9a-f]{24}\.txt$/);

    const handler = makeContextPackIpcHandler(engine, 'default');
    const res = await handler({
      kind: 'context_pack' as const,
      protocol: 2 as const,
      secret: 's',
      sessionId: 'sess-lane',
      bankOnly: true,
      window: [{ role: 'user' as const, text: 'I prefer dark mode in every editor, please set it up.' }],
      flushCorpusFile: wbFile,
    });
    expect(res?.checkpointFlush?.status).toBe('scheduled');
    await __drainCheckpointHarvestForTests();

    const tail = await readHeartbeatTail(10);
    const wb = tail.filter((e) => e.event === 'writeback');
    const compact = tail.filter((e) => e.event === 'checkpoint-harvest');
    // Lane proof (OV-A11): the wb event fires, the compact event does not.
    expect(wb.length).toBe(1);
    expect(compact.length).toBe(0);
    // Whichever guard fired (keyless env or the authoritative gate being
    // off), the outcome is a typed wb-lane reason and zero extraction.
    expect(['keyless', 'writeback_off']).toContain(wb[0].reason as string);
    const rows = await engine.executeRaw<{ id: number }>(`SELECT id FROM facts WHERE source = 'hook:writeback'`);
    expect(rows.length).toBe(0);
  });
});
