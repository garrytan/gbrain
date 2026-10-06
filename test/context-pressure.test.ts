import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decidePressure, readTranscriptPressure, resolveContextWindow, scanTranscriptPressure, shouldWarn, validatePressureConfigValue,
  type PressureGate,
} from '../src/core/context/pressure.ts';

const gate: PressureGate = { enabled: true, warn_ratio: 0.8, context_window: null, remember_callable: true };
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'gbrain-pressure-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const assistant = (used: number, model = 'claude-sonnet-5-5') => JSON.stringify({
  type: 'assistant', message: { role: 'assistant', model, usage: { input_tokens: used - 1000, cache_creation_input_tokens: 400, cache_read_input_tokens: 600, output_tokens: 50 } },
});
const boundary = (uuid: string) => JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid });

describe('transcript scan', () => {
  test('newest assistant usage sums input, cache creation and cache read', () => {
    const r = scanTranscriptPressure([assistant(10_000), assistant(170_000)].join('\n'));
    expect(r).toEqual({ usedTokens: 170_000, model: 'claude-sonnet-5-5', boundary: null });
  });
  test('the newest compact boundary keys the segment', () => {
    const r = scanTranscriptPressure([assistant(190_000), boundary('b-1'), assistant(30_000)].join('\n'));
    expect(r?.boundary).toBe('b-1');
    expect(r?.usedTokens).toBe(30_000);
  });
  test('nothing measured since the last compaction means no reading', () => {
    expect(scanTranscriptPressure([assistant(190_000), boundary('b-1')].join('\n'))).toBeNull();
  });
  test('reads only a bounded tail of a large file', () => {
    const dir = tmp();
    const path = join(dir, 't.jsonl');
    writeFileSync(path, `${'x'.repeat(600 * 1024)}\n${assistant(120_000)}\n`);
    expect(readTranscriptPressure(path)?.usedTokens).toBe(120_000);
  });
});

describe('window and decision', () => {
  test('window: config, then 1M marker, then observed fill, else 200k', () => {
    expect(resolveContextWindow({ configured: 32_000, model: null, maxSeen: 0 })).toBe(32_000);
    expect(resolveContextWindow({ configured: null, model: 'claude-sonnet-5-5[1m]', maxSeen: 0 })).toBe(1_000_000);
    expect(resolveContextWindow({ configured: null, model: null, maxSeen: 250_000 })).toBe(1_000_000);
    expect(resolveContextWindow({ configured: null, model: null, maxSeen: 50_000 })).toBe(200_000);
  });

  test('fires once per segment at the threshold, again after a new compaction', () => {
    const stateDir = tmp();
    const base = { gate, sessionKey: 's1', stateDir, model: null };
    expect(decidePressure({ ...base, usedTokens: 100_000, boundary: null }).notice).toBeNull();
    const first = decidePressure({ ...base, usedTokens: 165_000, boundary: null });
    expect(first.notice).toContain('remember');
    expect(first.notice).toContain('items');
    expect(first.percent).toBe(83);
    expect(decidePressure({ ...base, usedTokens: 175_000, boundary: null }).reason).toBe('already_warned');
    expect(decidePressure({ ...base, usedTokens: 20_000, boundary: 'b-2' }).notice).toBeNull();
    expect(decidePressure({ ...base, usedTokens: 170_000, boundary: 'b-2' }).notice).not.toBeNull();
  });

  test('a large observed fill keeps the 1M window for the session', () => {
    const stateDir = tmp();
    const base = { gate, sessionKey: 's2', stateDir, model: null, boundary: null };
    expect(decidePressure({ ...base, usedTokens: 260_000 }).window).toBe(1_000_000);
    expect(decidePressure({ ...base, usedTokens: 180_000 }).notice).toBeNull();
  });

  test('disabled, missing gate, or remember not callable never warn', () => {
    const stateDir = tmp();
    const base = { sessionKey: 's3', stateDir, model: null, boundary: null, usedTokens: 190_000 };
    expect(decidePressure({ ...base, gate: { ...gate, enabled: false } }).reason).toBe('disabled');
    expect(decidePressure({ ...base, gate: null }).reason).toBe('no_gate');
    expect(decidePressure({ ...base, gate: { ...gate, remember_callable: false } }).reason).toBe('remember_unavailable');
  });

  test('config validation bounds', () => {
    expect(validatePressureConfigValue('memory.pressure.warn_ratio', '0.8')).toBeNull();
    expect(validatePressureConfigValue('memory.pressure.warn_ratio', '1.2')).toContain('0.5 to 0.95');
    expect(validatePressureConfigValue('memory.pressure.context_window', '32000')).toBeNull();
    expect(validatePressureConfigValue('memory.pressure.context_window', 'big')).not.toBeNull();
    expect(validatePressureConfigValue('memory.pressure.enabled', 'maybe')).not.toBeNull();
  });
});

describe('growth-aware trigger', () => {
  test('warns before the ratio when two more turns of the last size would reach the compaction point', () => {
    const stateDir = tmp();
    const base = { gate, sessionKey: 'g1', stateDir, model: null, boundary: null };
    expect(decidePressure({ ...base, usedTokens: 100_000 }).notice).toBeNull();
    // +40k in one turn: 140k + 2 x 40k = 220k >= 0.92 x 200k, though 140k is only 70% full.
    const early = decidePressure({ ...base, usedTokens: 140_000 });
    expect(early.notice).not.toBeNull();
    expect(early.percent).toBe(70);
  });

  test('slow growth below the ratio stays quiet', () => {
    const stateDir = tmp();
    const base = { gate, sessionKey: 'g2', stateDir, model: null, boundary: null };
    decidePressure({ ...base, usedTokens: 100_000 });
    expect(decidePressure({ ...base, usedTokens: 105_000 }).notice).toBeNull();
  });

  test('shouldWarn bounds', () => {
    expect(shouldWarn({ used: 160, window: 200, warnRatio: 0.8, growth: 0 })).toBe(true);
    expect(shouldWarn({ used: 100, window: 200, warnRatio: 0.8, growth: 0 })).toBe(false);
    expect(shouldWarn({ used: 100, window: 200, warnRatio: 0.8, growth: 42 })).toBe(true);
    expect(shouldWarn({ used: 10, window: 0, warnRatio: 0.8, growth: 99 })).toBe(false);
  });
});
