/**
 * Regression (Codex C3): loadConfig() must NOT mutate process.env.
 *
 * The plan initially proposed "loadConfig() propagates config fields to env",
 * which is global-state leakage. Codex pushed back. loadConfig() now READS env
 * vars but never writes them — the gateway receives a config object directly.
 */

import { test, expect } from 'bun:test';
import { loadConfig } from '../../src/core/config.ts';

test('loadConfig does not mutate process.env', () => {
  const before = { ...process.env };
  try {
    loadConfig();
  } catch {
    // may return null if no config file / no DB URL — that's fine
  }
  const after = { ...process.env };
  // Every key present before must still be present and unchanged.
  for (const k of Object.keys(before)) {
    expect(after[k]).toBe(before[k]);
  }
  // No new keys added.
  const newKeys = Object.keys(after).filter(k => !(k in before));
  expect(newKeys).toEqual([]);
});
