/**
 * Ambient-writeback wb-files through the SWEEP's corpus pass (OV2-11) — the
 * batch backstop when serve/IPC was away. Pins the two arms the hook tests
 * only promise ("the sweep picks it up later"):
 *   - gate OFF (DB authoritative): terminal `writeback_off` sidecar, zero
 *     LLM, zero facts — operator intent beats a leftover hook-side bank;
 *   - gate ON (salient): extraction with `hook:writeback` provenance, the
 *     session id parsed from the wb filename, and the salient-mode
 *     `medium-and-up` notability admission (medium kept, low dropped) —
 *     batch-extracted turns indistinguishable from prompt-harvested ones.
 *
 * Hermetic in-memory PGLite + chat-transport stub (sweep.test.ts harness).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runMaintenanceSweep, CORPUS_INGESTED_SUFFIX } from '../src/core/sweep.ts';
import { bankWritebackTurn } from '../src/core/context/corpus-segments.ts';
import { gateWritebackTurn } from '../src/core/facts/writeback-gate.ts';
import { __setChatTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import type { CapabilityReport } from '../src/core/capability.ts';

const KEYED: CapabilityReport = {
  embeddings: { available: false },
  extraction: { available: true, provider: 'anthropic' },
  search: 'keyword-only',
  mode: 'keyed',
};

let engine: PGLiteEngine;
let corpusDir: string;
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
  await engine.executeRaw('DELETE FROM facts').catch(() => {});
  await engine.unsetConfig('memory.auto_writeback');
  corpusDir = mkdtempSync(join(tmpdir(), 'gbrain-sweep-wb-'));
  tmpDirs.push(corpusDir);
  await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
});

afterEach(async () => {
  __setChatTransportForTests(null);
  await engine.unsetConfig('memory.auto_writeback');
});

async function bankWb(sessionId: string, turn: string): Promise<string> {
  const gated = gateWritebackTurn(turn);
  if (!gated.ok) throw new Error(`fixture turn gated: ${gated.reason}`);
  const banked = await bankWritebackTurn(corpusDir, sessionId, gated.normalized, gated.hash24);
  if (!banked.flushCorpusFile) throw new Error(`bank failed: ${banked.status}`);
  return banked.flushCorpusFile;
}

describe('runMaintenanceSweep — ambient-writeback turn files (OV2-11)', () => {
  test('gate OFF: terminal writeback_off sidecar, zero LLM, zero facts', async () => {
    let chatCalls = 0;
    __setChatTransportForTests(async (): Promise<ChatResult> => {
      chatCalls += 1;
      throw new Error('must not be called — the gate is off');
    });
    const file = await bankWb('sess-swpoff', 'I moved to Lisbon for the spring and summer season.');

    const r = await runMaintenanceSweep(engine, { sourceId: 'default', capabilities: KEYED });
    expect(r.corpusIngested).toBe(0);
    expect(r.skipped).toContainEqual({ reason: 'writeback_off', count: 1 });
    expect(chatCalls).toBe(0);
    const sidecar = JSON.parse(readFileSync(join(corpusDir, file + CORPUS_INGESTED_SUFFIX), 'utf8'));
    expect(sidecar.skipped).toBe('writeback_off');
    const rows = await engine.executeRaw<{ id: number }>(`SELECT id FROM facts WHERE source = 'hook:writeback'`);
    expect(rows.length).toBe(0);
  });

  test('gate ON salient: hook:writeback provenance + filename session id + medium-and-up admission (low dropped); second sweep already_ingested', async () => {
    await engine.setConfig('memory.auto_writeback', 'salient');
    let chatCalls = 0;
    __setChatTransportForTests(async (): Promise<ChatResult> => {
      chatCalls += 1;
      return {
        text: JSON.stringify({
          facts: [
            { fact: 'prefers dark mode in every editor', kind: 'preference', entity: null, confidence: 0.9, notability: 'medium' },
            { fact: 'the sky was cloudy this morning', kind: 'fact', entity: null, confidence: 0.9, notability: 'low' },
          ],
        }),
        blocks: [],
        stopReason: 'end',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:test-stub',
        providerId: 'anthropic',
      };
    });
    const file = await bankWb('sess-swpon', 'I prefer dark mode in every editor, and the sky was cloudy this morning.');

    const r1 = await runMaintenanceSweep(engine, { sourceId: 'default', capabilities: KEYED });
    expect(r1.corpusIngested).toBe(1);
    expect(chatCalls).toBe(1);
    expect(existsSync(join(corpusDir, file + CORPUS_INGESTED_SUFFIX))).toBe(true);

    const rows = await engine.executeRaw<{ fact: string; source: string; source_session: string }>(
      `SELECT fact, source, source_session FROM facts WHERE source = 'hook:writeback'`,
    );
    // medium-and-up admission: the medium fact lands, the low one is dropped.
    expect(rows.length).toBe(1);
    expect(rows[0].fact).toContain('dark mode');
    // Batch-extracted turns keep the SESSION identity from the wb filename,
    // not a sweep:corpus synthetic id.
    expect(rows[0].source_session).toBe('sess-swpon');
    const sweepTagged = await engine.executeRaw<{ id: number }>(`SELECT id FROM facts WHERE source = 'sweep:corpus'`);
    expect(sweepTagged.length).toBe(0);

    // Exactly-once: the sidecar makes the second sweep a no-op.
    const r2 = await runMaintenanceSweep(engine, { sourceId: 'default', capabilities: KEYED });
    expect(r2.corpusIngested).toBe(0);
    expect(chatCalls).toBe(1);
    expect(r2.skipped).toContainEqual({ reason: 'already_ingested', count: 1 });
  });

  test('gate OFF beats keyless: wb candidates are terminally retired even when the pass short-circuits (codex re-review)', async () => {
    // memory.auto_writeback stays unset (off) in the DB and the file mirror
    // is absent — genuinely off. A keyless pass must still write the
    // terminal writeback_off sidecar instead of leaving the file eligible
    // for a later re-enable.
    const keyless: CapabilityReport = {
      embeddings: { available: false },
      extraction: { available: false },
      search: 'keyword-only',
      mode: 'keyless',
    };
    const file = await bankWb('sess-swpoffkeyless', 'I moved the standing desk into the garden office yesterday.');
    const r = await runMaintenanceSweep(engine, { sourceId: 'default', capabilities: keyless });
    expect(r.skipped).toContainEqual({ reason: 'writeback_off', count: 1 });
    const sidecar = JSON.parse(readFileSync(join(corpusDir, file + CORPUS_INGESTED_SUFFIX), 'utf8'));
    expect(sidecar.skipped).toBe('writeback_off');
  });

  test('source fidelity: a wb file banked under GBRAIN_SOURCE=wiki extracts into wiki even when the sweep runs as default (adversarial review)', async () => {
    await engine.setConfig('memory.auto_writeback', 'salient');
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('wiki', 'wiki') ON CONFLICT (id) DO NOTHING`);
    __setChatTransportForTests(async (): Promise<ChatResult> => ({
      text: JSON.stringify({
        facts: [{ fact: 'runs the wiki working group on Tuesdays', kind: 'fact', entity: null, confidence: 0.9, notability: 'medium' }],
      }),
      blocks: [],
      stopReason: 'end',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:test-stub',
      providerId: 'anthropic',
    }));
    const gated = gateWritebackTurn('I run the wiki working group every Tuesday afternoon this quarter.');
    if (!gated.ok) throw new Error('fixture gated');
    const banked = await bankWritebackTurn(corpusDir, 'sess-src', gated.normalized, gated.hash24, 'wiki');
    expect(banked.flushCorpusFile).toMatch(/\.src-wiki\.txt$/);

    const r = await runMaintenanceSweep(engine, { sourceId: 'default', capabilities: KEYED });
    expect(r.corpusIngested).toBe(1);
    const rows = await engine.executeRaw<{ source_id: string; source_session: string }>(
      `SELECT source_id, source_session FROM facts WHERE source = 'hook:writeback'`,
    );
    expect(rows.length).toBe(1);
    // The pass ran as 'default' but the fact lands in the BANKED source —
    // the same source the prompt-time IPC lane would have used.
    expect(rows[0].source_id).toBe('wiki');
    expect(rows[0].source_session).toBe('sess-src');
  });

  test('plane drift (DB unset + file mirror enabled): NO terminal sidecar, file survives for the next sweep (adversarial review)', async () => {
    // memory.auto_writeback stays unset in the DB (beforeEach); the file
    // mirror claims enabled — a failed dual-write is NOT operator intent, so
    // the old behavior (terminal writeback_off sidecar) would permanently
    // destroy the banked turn.
    const { configDir } = await import('../src/core/config.ts');
    const { mkdirSync, writeFileSync, rmSync: rmFile } = await import('node:fs');
    const cfgDir = configDir();
    const cfgPath = join(cfgDir, 'config.json');
    const hadCfg = existsSync(cfgPath);
    const prior = hadCfg ? readFileSync(cfgPath, 'utf8') : null;
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(cfgPath, JSON.stringify({ engine: 'pglite', memory: { auto_writeback: 'salient' } }) + '\n');
    try {
      let chatCalls = 0;
      __setChatTransportForTests(async (): Promise<ChatResult> => {
        chatCalls += 1;
        throw new Error('must not be called — drift holds the file');
      });
      const file = await bankWb('sess-drift', 'I moved my standing desk to the garden office for the summer.');
      const r = await runMaintenanceSweep(engine, { sourceId: 'default', capabilities: KEYED });
      expect(r.corpusIngested).toBe(0);
      expect(r.skipped).toContainEqual({ reason: 'writeback_plane_drift', count: 1 });
      expect(chatCalls).toBe(0);
      expect(existsSync(join(corpusDir, file + CORPUS_INGESTED_SUFFIX))).toBe(false); // NOT terminal
      expect(existsSync(join(corpusDir, file))).toBe(true); // survives for re-sync
    } finally {
      if (prior !== null) writeFileSync(cfgPath, prior);
      else rmFile(cfgPath, { force: true });
    }
  });

  test('non-transport extraction skip is TERMINAL at the sweep but RECORDED in the sidecar (last attempt, honest zero)', async () => {
    await engine.setConfig('memory.auto_writeback', 'salient');
    __setChatTransportForTests(async (): Promise<ChatResult> => ({
      text: 'I cannot help with extracting facts from this text.',
      blocks: [],
      stopReason: 'end',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:test-stub',
      providerId: 'anthropic',
    }));
    const file = await bankWb('sess-skip', 'I switched my primary editor theme to solarized light last week.');
    const r = await runMaintenanceSweep(engine, { sourceId: 'default', capabilities: KEYED });
    expect(r.corpusIngested).toBe(1);
    const sidecar = JSON.parse(readFileSync(join(corpusDir, file + CORPUS_INGESTED_SUFFIX), 'utf8'));
    expect(sidecar.facts_inserted).toBe(0);
    expect(typeof sidecar.skipped).toBe('string'); // malformed_output/refusal class — recorded, never a silent zero
  });
});
