/**
 * #5735 — OpenClaw compact() rung 3 (Postgres inline harvest) gates on the
 * extraction model GBrain will actually use, not the engine-blind
 * detectCapabilities() file/env probe.
 *
 * Fixture: a Postgres brain whose DB plane sets `facts.extraction_model` to a
 * local model while the file/env plane carries no provider key (the keyless
 * shape detectCapabilities() reports as unavailable). compact() must run the
 * inline harvest ('harvested', a hook:compact fact) instead of banking the
 * segment as 'keyless'. The chat transport is stubbed: no provider call.
 *
 * Run: DATABASE_URL=... bun test test/e2e/context-engine-rung3-extraction.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';
import { __setChatTransportForTests, type ChatResult } from '../../src/core/ai/gateway.ts';
import { RECIPES } from '../../src/core/ai/recipes/index.ts';
import { detectCapabilities } from '../../src/core/capability.ts';
import { createGBrainContextEngine, __resetSdkLoadStateForTests } from '../../src/core/context-engine.ts';
import { disposeReflex } from '../../src/core/context/reflex.ts';
import { withEnv } from '../helpers/with-env.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;
if (skip) console.log('Skipping E2E context-engine rung-3 extraction test (DATABASE_URL not set)');

const noProviderKeys = Object.fromEntries(
  Array.from(new Set(Array.from(RECIPES.values()).flatMap((r) => r.auth_env?.required ?? [])), (k) => [k, undefined]),
);

describeE2E('context engine compact() rung 3 — DB-plane extraction model (#5735)', () => {
  const dirs: string[] = [];

  beforeAll(async () => {
    await setupDB();
  }, 60_000);

  afterAll(async () => {
    __setChatTransportForTests(null);
    await disposeReflex();
    await getEngine().unsetConfig('facts.extraction_model');
    await teardownDB();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test('a DB-plane local model harvests inline on a keyless file/env plane', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gb-ce-rung3-'));
    const workspace = mkdtempSync(join(tmpdir(), 'gb-ce-rung3-ws-'));
    dirs.push(home, workspace);
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(
      join(home, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'postgres', database_url: process.env.DATABASE_URL }),
    );
    mkdirSync(join(workspace, 'memory'), { recursive: true });
    writeFileSync(join(workspace, 'memory', 'heartbeat-state.json'), '{}');
    const sessionFile = join(home, 'oc-session.jsonl');
    const line = (o: unknown) => JSON.stringify(o);
    writeFileSync(sessionFile, [
      line({ type: 'session', id: 'oc-rung3', cwd: '/w', timestamp: '2026-08-01T10:00:00Z' }),
      line({ type: 'compaction', timestamp: '2026-08-01T10:00:01Z' }),
      line({ type: 'message', timestamp: '2026-08-01T10:00:02Z', message: { role: 'user', content: [{ type: 'text', text: 'We chose a local extraction model for the synthetic project.' }] } }),
    ].join('\n') + '\n');

    await getEngine().setConfig('facts.extraction_model', 'ollama:qwen2.5-coder:14b');
    __setChatTransportForTests(async (): Promise<ChatResult> => ({
      text: JSON.stringify({ facts: [{ fact: 'Chose a local extraction model for the synthetic project.', kind: 'decision', entity: null, confidence: 1, notability: 'high' }] }),
      blocks: [],
      stopReason: 'end',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'ollama:qwen2.5-coder:14b',
      providerId: 'ollama',
    }));

    await withEnv({ ...noProviderKeys, GBRAIN_HOME: home }, async () => {
      expect(detectCapabilities().extraction.available).toBe(false);
      __resetSdkLoadStateForTests();
      const ce = createGBrainContextEngine({ workspaceDir: workspace });
      const result = await ce.compact({ sessionId: 'oc-rung3', sessionFile });
      const bag = (result.result ?? {}) as { gbrain_checkpoint?: { status: string; reason?: string } };
      expect(bag.gbrain_checkpoint).toMatchObject({ status: 'harvested' });
    });
    const rows = await getEngine().executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM facts WHERE source = 'hook:compact' AND source_session = 'oc-rung3'`,
    );
    expect(rows[0]?.n).toBeGreaterThan(0);
  }, 60_000);
});
