import { describe, it, expect, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { SQLiteEngine } from '../../src/core/sqlite-engine.ts';

setDefaultTimeout(Number(process.env.TEST_TIMEOUT_MS ?? 20_000));

describe('auto_promote_verdicts cache', () => {
  const key = { candidate_id: 'c1', content_hash: 'h1', runner_kind: 'claude_code', prompt_version: 'auto-promote-v1' };

  it('PGLite: returns null on miss, the row on hit, and upserts on conflict (escalate-once)', async () => {
    const engine = new PGLiteEngine();
    try {
      await engine.connect({ engine: 'pglite' });
      await engine.initSchema();
      expect(await engine.getAutoPromoteVerdict(key)).toBeNull();
      await engine.putAutoPromoteVerdict({ ...key, decision: 'promote', confidence: 0.9, reasoning: 'ok', judged_at: '2026-06-01T00:00:00Z' });
      const hit = await engine.getAutoPromoteVerdict(key);
      expect(hit?.decision).toBe('promote');
      expect(hit?.confidence).toBeCloseTo(0.9, 5);
      // upsert: same PK, new decision
      await engine.putAutoPromoteVerdict({ ...key, decision: 'reject', confidence: 0.1, reasoning: 'changed', judged_at: '2026-06-02T00:00:00Z' });
      const hit2 = await engine.getAutoPromoteVerdict(key);
      expect(hit2?.decision).toBe('reject');
    } finally {
      await engine.disconnect();
    }
  });

  it('SQLite: returns null on miss, the row on hit, and upserts on conflict (escalate-once)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-apv-'));
    const engine = new SQLiteEngine();
    try {
      await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
      await engine.initSchema();
      expect(await engine.getAutoPromoteVerdict(key)).toBeNull();
      await engine.putAutoPromoteVerdict({ ...key, decision: 'promote', confidence: 0.9, reasoning: 'ok', judged_at: '2026-06-01T00:00:00Z' });
      const hit = await engine.getAutoPromoteVerdict(key);
      expect(hit?.decision).toBe('promote');
      expect(hit?.confidence).toBeCloseTo(0.9, 5);
      // upsert: same PK, new decision
      await engine.putAutoPromoteVerdict({ ...key, decision: 'reject', confidence: 0.1, reasoning: 'changed', judged_at: '2026-06-02T00:00:00Z' });
      const hit2 = await engine.getAutoPromoteVerdict(key);
      expect(hit2?.decision).toBe('reject');
    } finally {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
