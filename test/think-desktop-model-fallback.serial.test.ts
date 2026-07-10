import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { saveConfig } from '../src/core/config.ts';
import { runThink } from '../src/core/think/index.ts';

let engine: PGLiteEngine;
let root: string;
const originalHome = process.env.PMBRAIN_HOME;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pmbrain-think-desktop-model-'));
  process.env.PMBRAIN_HOME = root;
  saveConfig({
    engine: 'pglite',
    database_path: join(root, 'brain.pglite'),
    chat_model: 'mimo:mimo-v2.5-pro',
  });
  engine = new PGLiteEngine();
  await engine.connect({ database_path: join(root, 'brain.pglite') });
  await engine.initSchema();
}, 30_000);

afterAll(async () => {
  await engine.disconnect();
  if (originalHome === undefined) delete process.env.PMBRAIN_HOME;
  else process.env.PMBRAIN_HOME = originalHome;
  rmSync(root, { recursive: true, force: true });
}, 30_000);

describe('think desktop ordinary-model fallback', () => {
  test('uses file chat_model when old desktop DB lacks models.default', async () => {
    const result = await runThink(engine, {
      question: 'Which model should synthesize this?',
      stubResponse: { answer: 'configured model', citations: [], gaps: [] },
    });
    expect(result.modelUsed).toBe('mimo:mimo-v2.5-pro');
  });
});
