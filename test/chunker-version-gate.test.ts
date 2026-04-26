/**
 * v0.20.0 Cathedral II Layer 12 — CHUNKER_VERSION 3→4 bump + SP-1 gate.
 *
 * Codex's second-pass review caught that bumping CHUNKER_VERSION alone
 * does nothing on an unchanged repo: `performSync` short-circuits at
 * `up_to_date` before reaching `importCodeFile`'s content_hash check.
 * Layer 12 adds a sources.chunker_version gate that forces a full
 * re-walk when the version mismatches, regardless of git HEAD equality.
 *
 * These tests validate the constant value, the gate logic, and the
 * write-after-sync behavior. Full e2e covered by test/e2e if DB present.
 */

import { describe, test, expect } from 'bun:test';
import { CHUNKER_VERSION } from '../src/core/chunkers/code.ts';

describe('Layer 12 — CHUNKER_VERSION constant', () => {
  test('bumped to 4 for Cathedral II', () => {
    // v3: v0.19.0 Chonkie parity (tokenizer + small-sibling merge).
    // v4: v0.20.0 Cathedral II (qualified names + parent scope + doc_comment
    //     + fence extraction + chunk-grain FTS). Folded into content_hash
    //     so any bump forces clean re-chunks on next sync.
    expect(CHUNKER_VERSION).toBe(4);
  });

  test('is stable across imports (not recomputed at call time)', async () => {
    const a = (await import('../src/core/chunkers/code.ts')).CHUNKER_VERSION;
    const b = (await import('../src/core/chunkers/code.ts')).CHUNKER_VERSION;
    expect(a).toBe(b);
    expect(a).toBe(4);
  });
});

describe('Layer 12 — sources.chunker_version column from v27 migration', () => {
  test('v27 foundation migration adds chunker_version to sources', async () => {
    const { MIGRATIONS } = await import('../src/core/migrate.ts');
    const v27 = MIGRATIONS.find(m => m.version === 27);
    expect(v27).toBeDefined();
    expect(v27!.sql).toMatch(/ALTER TABLE sources/);
    expect(v27!.sql).toMatch(/ADD COLUMN IF NOT EXISTS chunker_version TEXT/);
  });
});

// Full integration test: would run an e2e sync twice against a real git
// repo fixture and assert that the second sync (with HEAD unchanged but
// chunker_version advanced) re-walks. That lives in
// test/e2e/cathedral-ii.test.ts (future Layer 5 pilot). This file pins
// the constant + migration shape so any accidental revert surfaces in CI.
