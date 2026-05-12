/**
 * v0.32.3 search-lite install-time mode picker tests.
 *
 * Pure-function coverage (recommendModeFor + parseModeInput) plus the
 * idempotent runModePicker behavior. The interactive TTY branch is
 * exercised indirectly via the non-TTY path here; full TTY simulation
 * lives in the e2e suite (test/e2e/...).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  recommendModeFor,
  parseModeInput,
  runModePicker,
} from '../src/commands/init-mode-picker.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM config WHERE key LIKE 'search.%' OR key LIKE 'models.%'`);
});

describe('recommendModeFor — auto-suggestion heuristic', () => {
  test('Opus default → tokenmax', () => {
    const r = recommendModeFor({ defaultModel: 'anthropic:claude-opus-4-7' });
    expect(r.mode).toBe('tokenmax');
    expect(r.reason).toMatch(/Opus/);
  });

  test('Opus subagent → tokenmax', () => {
    const r = recommendModeFor({ subagentModel: 'anthropic:claude-opus-4-7' });
    expect(r.mode).toBe('tokenmax');
  });

  test('Haiku subagent → conservative', () => {
    const r = recommendModeFor({ subagentModel: 'anthropic:claude-haiku-4-5' });
    expect(r.mode).toBe('conservative');
    expect(r.reason).toMatch(/Haiku/);
  });

  test('No OpenAI key → conservative (no LLM expansion possible)', () => {
    const r = recommendModeFor({ hasOpenAIKey: false });
    expect(r.mode).toBe('conservative');
    expect(r.reason).toMatch(/No OpenAI/);
  });

  test('Sonnet / unknown → balanced (safe default)', () => {
    const r = recommendModeFor({ subagentModel: 'anthropic:claude-sonnet-4-6', hasOpenAIKey: true });
    expect(r.mode).toBe('balanced');
    expect(r.reason).toMatch(/Sweet-spot/);
  });

  test('Empty inputs → balanced (default)', () => {
    const r = recommendModeFor({});
    expect(r.mode).toBe('balanced');
  });

  test('Opus beats Haiku when both are set (default trumps subagent)', () => {
    const r = recommendModeFor({
      defaultModel: 'anthropic:claude-opus-4-7',
      subagentModel: 'anthropic:claude-haiku-4-5',
    });
    expect(r.mode).toBe('tokenmax');
  });
});

describe('parseModeInput — menu choice mapper', () => {
  test('numeric 1/2/3 → conservative/balanced/tokenmax', () => {
    expect(parseModeInput('1')).toBe('conservative');
    expect(parseModeInput('2')).toBe('balanced');
    expect(parseModeInput('3')).toBe('tokenmax');
  });

  test('mode names (case-insensitive)', () => {
    expect(parseModeInput('conservative')).toBe('conservative');
    expect(parseModeInput('CONSERVATIVE')).toBe('conservative');
    expect(parseModeInput('TokenMax')).toBe('tokenmax');
    expect(parseModeInput(' balanced ')).toBe('balanced');
  });

  test('empty / unrecognized → null', () => {
    expect(parseModeInput('')).toBeNull();
    expect(parseModeInput('   ')).toBeNull();
    expect(parseModeInput('foo')).toBeNull();
    expect(parseModeInput('4')).toBeNull();
    expect(parseModeInput('0')).toBeNull();
  });
});

describe('runModePicker — non-TTY auto-select + idempotent', () => {
  test('non-TTY auto-selects + writes config + emits operator hint', async () => {
    // Bun test runs non-TTY by default.
    const picked = await runModePicker(engine);
    // Default model unset → balanced. Should write search.mode.
    const stored = await engine.getConfig('search.mode');
    expect(stored).toBe(picked);
    expect(['conservative', 'balanced', 'tokenmax']).toContain(picked);
  });

  test('idempotent: second call returns existing mode without overwrite', async () => {
    await engine.setConfig('search.mode', 'tokenmax');
    const picked = await runModePicker(engine);
    expect(picked).toBe('tokenmax');
    // No accidental overwrite.
    const stored = await engine.getConfig('search.mode');
    expect(stored).toBe('tokenmax');
  });

  test('--force re-prompts even if mode is already set', async () => {
    await engine.setConfig('search.mode', 'conservative');
    // Non-TTY + force → re-runs auto-suggest with current inputs.
    const picked = await runModePicker(engine, { force: true });
    // With no model hints + no API key state, default is balanced. The picker
    // will overwrite the existing mode.
    expect(['conservative', 'balanced', 'tokenmax']).toContain(picked);
    const stored = await engine.getConfig('search.mode');
    expect(stored).toBe(picked);
  });

  test('jsonOutput mode emits a structured event and writes config', async () => {
    // Capture console.log output.
    const originalLog = console.log;
    const captured: string[] = [];
    console.log = (msg: string) => { captured.push(msg); };
    try {
      const picked = await runModePicker(engine, { jsonOutput: true });
      const stored = await engine.getConfig('search.mode');
      expect(stored).toBe(picked);
      const jsonLine = captured.find(l => l.startsWith('{'));
      expect(jsonLine).toBeDefined();
      const obj = JSON.parse(jsonLine!);
      expect(obj.phase).toBe('search_mode_picker');
      expect(obj.auto).toBe(true);
      expect(['conservative', 'balanced', 'tokenmax']).toContain(obj.mode);
    } finally {
      console.log = originalLog;
    }
  });

  test('Opus default model → picker auto-recommends tokenmax', async () => {
    await engine.setConfig('models.default', 'anthropic:claude-opus-4-7');
    const picked = await runModePicker(engine);
    expect(picked).toBe('tokenmax');
  });

  test('Haiku subagent → picker auto-recommends conservative', async () => {
    await engine.setConfig('models.tier.subagent', 'anthropic:claude-haiku-4-5');
    const picked = await runModePicker(engine);
    expect(picked).toBe('conservative');
  });
});
