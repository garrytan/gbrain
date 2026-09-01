/**
 * Ship-review fix pins (ambient-writeback wave): the strict extraction-gate
 * semantics (LKG never enables extraction), brain.audience dual-plane
 * routing + the interview declaration path, the visibility_posture file
 * stamp, the wb-lane degraded arms (no terminal sidecar), and the
 * private-visibility remote-recall boundary round-trip (test bullet 9,
 * end-to-end).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { CapabilityReport } from '../src/core/capability.ts';
import { resolveWritebackConfig } from '../src/core/facts/writeback-config.ts';
import { runConfig } from '../src/commands/config.ts';
import { applyDeclaredAudienceFromInterview } from '../src/commands/bootstrap.ts';
import { initState, setAnswer } from '../src/core/bootstrap/interview.ts';
import {
  __drainCheckpointHarvestForTests,
  __resetCheckpointHarvestForTests,
  scheduleCheckpointHarvest,
} from '../src/core/context/checkpoint-harvest.ts';
import { bankWritebackTurn } from '../src/core/context/corpus-segments.ts';
import { gateWritebackTurn } from '../src/core/facts/writeback-gate.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { CORPUS_INGESTED_SUFFIX } from '../src/core/sweep.ts';
import { withEnv } from './helpers/with-env.ts';

const KEYLESS: CapabilityReport = {
  embeddings: { available: false },
  extraction: { available: false },
  search: 'keyword-only',
  mode: 'keyless',
};

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  __resetCheckpointHarvestForTests();
  await engine.unsetConfig('memory.auto_writeback');
  await engine.unsetConfig('facts.default_visibility');
  await engine.executeRaw('DELETE FROM facts').catch(() => {});
});

async function captureLog(fn: () => Promise<void>): Promise<string> {
  const orig = console.log; const origErr = console.error;
  let out = '';
  console.log = (...a: unknown[]) => { out += a.map(String).join(' ') + '\n'; };
  console.error = (...a: unknown[]) => { out += a.map(String).join(' ') + '\n'; };
  try { await fn(); } finally { console.log = orig; console.error = origErr; }
  return out;
}

describe('strict gate semantics ({gate:true}) — an LKG bundle never enables extraction', () => {
  test('instructions lane serves LKG on a blip; the gate lane refuses it (read_error, OFF)', async () => {
    let healthy = true;
    const flappy = {
      getConfig: async (k: string) => {
        if (!healthy) throw new Error('db blip');
        return k === 'memory.auto_writeback' ? 'salient' : null;
      },
    } as unknown as BrainEngine;
    const warm = await resolveWritebackConfig(flappy);
    expect(warm.enabled).toBe(true);
    healthy = false;
    // Instructions lane: last-known-good keeps the section alive.
    const instr = await resolveWritebackConfig(flappy);
    expect(instr.enabled).toBe(true);
    // Extraction gate: NEVER extract on a cached bundle — off + read_error.
    const gate = await resolveWritebackConfig(flappy, undefined, { gate: true });
    expect(gate.enabled).toBe(false);
    expect(gate.read_error).toBe(true);
  });

  test('harvest wb lane on gate read failure: degraded, NO terminal sidecar, file remains for retry', async () => {
    const corpusDir = mkdtempSync(join(tmpdir(), 'gb-wbfix-'));
    const home = mkdtempSync(join(tmpdir(), 'gb-wbfix-home-'));
    try {
      const g = gateWritebackTurn('I prefer window seats on every long-haul flight I book.');
      if (!g.ok) throw new Error('fixture gated');
      const banked = await bankWritebackTurn(corpusDir, 's-gate', g.normalized, g.hash24);
      const file = banked.flushCorpusFile!;
      const broken = new Proxy(engine, {
        get(target, prop, receiver) {
          if (prop === 'getConfig') return async () => { throw new Error('db down'); };
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as BrainEngine;
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const ack = scheduleCheckpointHarvest({
          engine: broken, sourceId: 'default', sessionId: 's-gate', corpusDir, file,
          capabilities: { ...KEYLESS, extraction: { available: true, provider: 'anthropic' }, mode: 'keyed' } as CapabilityReport,
          lane: 'writeback',
        });
        expect(ack.status).toBe('scheduled');
        await __drainCheckpointHarvestForTests();
      });
      expect(existsSync(join(corpusDir, file))).toBe(true); // still there
      expect(existsSync(join(corpusDir, file + CORPUS_INGESTED_SUFFIX))).toBe(false); // NOT terminal
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('wb-lane keyless / extraction_disabled arms: degraded skips, no sidecar, file remains (OV2-10)', async () => {
    const corpusDir = mkdtempSync(join(tmpdir(), 'gb-wbfix2-'));
    const home = mkdtempSync(join(tmpdir(), 'gb-wbfix2-home-'));
    try {
      await engine.setConfig('memory.auto_writeback', 'salient');
      const g = gateWritebackTurn('I decided to move our retro to the first Friday of the month.');
      if (!g.ok) throw new Error('fixture gated');

      await withEnv({ GBRAIN_HOME: home }, async () => {
        // keyless
        const b1 = await bankWritebackTurn(corpusDir, 's-kl', g.normalized, g.hash24);
        scheduleCheckpointHarvest({
          engine, sourceId: 'default', sessionId: 's-kl', corpusDir, file: b1.flushCorpusFile!,
          capabilities: KEYLESS, lane: 'writeback',
        });
        await __drainCheckpointHarvestForTests();
        expect(existsSync(join(corpusDir, b1.flushCorpusFile! + CORPUS_INGESTED_SUFFIX))).toBe(false);

        // extraction_disabled (keyed caps, brain-wide kill switch off)
        await engine.setConfig('facts.extraction_enabled', 'false');
        try {
          scheduleCheckpointHarvest({
            engine, sourceId: 'default', sessionId: 's-kl', corpusDir, file: b1.flushCorpusFile!,
            capabilities: { ...KEYLESS, extraction: { available: true, provider: 'anthropic' }, mode: 'keyed' } as CapabilityReport,
            lane: 'writeback',
          });
          await __drainCheckpointHarvestForTests();
          expect(existsSync(join(corpusDir, b1.flushCorpusFile! + CORPUS_INGESTED_SUFFIX))).toBe(false);
        } finally {
          await engine.unsetConfig('facts.extraction_enabled');
        }
      });
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('brain.audience dual-plane + interview declaration (#31/#32)', () => {
  test('config set brain.audience dual-writes; garbage rejected; unset clears both planes', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gb-aud-'));
    const db = new Map<string, string>();
    const fake = {
      getConfig: async (k: string) => db.get(k) ?? null,
      setConfig: async (k: string, v: string) => { db.set(k, v); },
      unsetConfig: async (k: string) => (db.delete(k) ? 1 : 0),
    } as unknown as BrainEngine;
    await withEnv({ GBRAIN_HOME: parent }, async () => {
      const out = await captureLog(() => runConfig(fake, ['set', 'brain.audience', 'shared']));
      expect(out).toContain('Set brain.audience = shared (file + db planes)');
      const cfg = JSON.parse(readFileSync(join(parent, '.gbrain', 'config.json'), 'utf8')) as { brain?: { audience?: string } };
      expect(cfg.brain?.audience).toBe('shared');
      expect(db.get('brain.audience')).toBe('shared');

      const out2 = await captureLog(() => runConfig(fake, ['unset', 'brain.audience']));
      expect(out2).toContain('Unset brain.audience (file plane + db plane)');
      expect(db.has('brain.audience')).toBe(false);
    });
  });

  test('interview SURFACE_MULTIUSER=shared → file-plane declaration; set-if-unset; single-principal declares nothing', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gb-aud2-'));
    const ws = join(parent, 'ws');
    mkdirSync(join(ws, 'state'), { recursive: true });
    await withEnv({ GBRAIN_HOME: parent }, async () => {
      initState(ws);
      // default (single-principal) → nothing declared
      applyDeclaredAudienceFromInterview(ws);
      expect(existsSync(join(parent, '.gbrain', 'config.json'))).toBe(false);

      setAnswer(ws, 'SURFACE_MULTIUSER', 'shared');
      await captureLog(async () => applyDeclaredAudienceFromInterview(ws));
      const cfg = JSON.parse(readFileSync(join(parent, '.gbrain', 'config.json'), 'utf8')) as { brain?: { audience?: string } };
      expect(cfg.brain?.audience).toBe('shared');

      // set-if-unset: an existing explicit declaration is never overwritten
      cfg.brain!.audience = 'personal';
      writeFileSync(join(parent, '.gbrain', 'config.json'), JSON.stringify(cfg));
      applyDeclaredAudienceFromInterview(ws);
      const cfg2 = JSON.parse(readFileSync(join(parent, '.gbrain', 'config.json'), 'utf8')) as { brain?: { audience?: string } };
      expect(cfg2.brain?.audience).toBe('personal');
    });
  });

  test('config set memory.auto_writeback stamps the resolved visibility_posture into the file mirror (T5)', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gb-post-'));
    const db = new Map<string, string>([['facts.default_visibility', 'private']]);
    const fake = {
      getConfig: async (k: string) => db.get(k) ?? null,
      setConfig: async (k: string, v: string) => { db.set(k, v); },
      unsetConfig: async () => 0,
    } as unknown as BrainEngine;
    await withEnv({ GBRAIN_HOME: parent }, async () => {
      await captureLog(() => runConfig(fake, ['set', 'memory.auto_writeback', 'salient']));
      const cfg = JSON.parse(readFileSync(join(parent, '.gbrain', 'config.json'), 'utf8')) as { memory?: { visibility_posture?: string } };
      expect(cfg.memory?.visibility_posture).toBe('private');
    });
  });
});

describe('visibility boundary round-trip (test bullet 9, end-to-end)', () => {
  test('a private fact written by the trusted lane is invisible to remote recall; world fact visible', async () => {
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`).catch(() => {});
    // Trusted-local writes (remote:false): one private, one world.
    const w1 = await dispatchToolCall(engine, 'remember', {
      fact: 'keeps a private planning note about acme-example',
      entity: 'people/alice-example', provenance: 'test', visibility: 'private',
    }, { remote: false });
    const w2 = await dispatchToolCall(engine, 'remember', {
      fact: 'prefers dark mode in every editor',
      entity: 'people/alice-example', provenance: 'test', visibility: 'world',
    }, { remote: false });
    expect(JSON.parse(w1.content[0].text as string).status).toBe('inserted');
    expect(JSON.parse(w2.content[0].text as string).status).toBe('inserted');

    // Remote recall (MCP default): world-only. sourceId threaded explicitly
    // — remote dispatch fail-closes without a resolved source scope.
    const remote = await dispatchToolCall(engine, 'recall', { entity: 'people/alice-example' }, { remote: true, sourceId: 'default' });
    const remoteFacts = (JSON.parse(remote.content[0].text as string) as { facts: Array<{ fact: string }> }).facts.map((f) => f.fact);
    expect(remoteFacts.some((f) => f.includes('dark mode'))).toBe(true);
    expect(remoteFacts.some((f) => f.includes('private planning note'))).toBe(false);

    // Trusted-local recall sees both.
    const local = await dispatchToolCall(engine, 'recall', { entity: 'people/alice-example' }, { remote: false });
    const localFacts = (JSON.parse(local.content[0].text as string) as { facts: Array<{ fact: string }> }).facts.map((f) => f.fact);
    expect(localFacts.some((f) => f.includes('private planning note'))).toBe(true);
  });
});
