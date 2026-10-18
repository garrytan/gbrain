/**
 * #6906: a lazy load on the OpenClaw assemble() path that fails (OpenClaw runs
 * the engine under Node, which rejects Bun-only imports) must leave one warning
 * line naming the module and error code, not silence. The forced failure here
 * is the direct-Postgres rung's engine factory, loaded by both the checkpoint
 * poll and the Retrieval Reflex. SERIAL: mock.module (R2) and GBRAIN_HOME (R1).
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOAD_ERROR = Object.assign(new Error('Unknown file extension ".yaml"'), { code: 'ERR_UNKNOWN_FILE_EXTENSION' });
mock.module('../src/core/engine-factory.ts', () => {
  throw LOAD_ERROR;
});

const { createGBrainContextEngine, __resetSdkLoadStateForTests } = await import('../src/core/context-engine.ts');
const { disposeReflex } = await import('../src/core/context/reflex.ts');

const EXPECTED = '[gbrain] context engine: failed to load src/core/engine-factory.ts (ERR_UNKNOWN_FILE_EXTENSION); brain context is degraded';

describe('assemble() path lazy-load failures are visible (#6906)', () => {
  let home: string;
  let workspace: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ['GBRAIN_HOME', 'DATABASE_URL', 'GBRAIN_DATABASE_URL']) saved[k] = process.env[k];
    delete process.env.DATABASE_URL;
    delete process.env.GBRAIN_DATABASE_URL;
    home = mkdtempSync(join(tmpdir(), 'gb-assemble-load-'));
    process.env.GBRAIN_HOME = home;
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: 'postgresql://alice-example@127.0.0.1:1/acme_example' }));
    workspace = mkdtempSync(join(tmpdir(), 'gb-assemble-load-ws-'));
    __resetSdkLoadStateForTests();
  });

  afterEach(async () => {
    await disposeReflex();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  test('one warning line names the module and code; assemble still fails open', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const engine = createGBrainContextEngine({ workspaceDir: workspace });
      for (let turn = 0; turn < 2; turn++) {
        await disposeReflex();
        const result = await engine.assemble({ sessionId: 'oc-sess', messages: [{ role: 'user', content: 'what did alice-example say about acme-example?' }] });
        expect(result.messages).toHaveLength(1);
        expect(typeof result.systemPromptAddition).toBe('string');
      }
      const lines = warn.mock.calls.map((args) => String(args[0])).filter((line) => line.includes('failed to load'));
      expect(lines).toEqual([EXPECTED]);
    } finally {
      warn.mockRestore();
    }
  });
});
