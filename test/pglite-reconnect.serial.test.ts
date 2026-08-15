/**
 * #2034 — engine-parity reconnect().
 *
 * The autopilot health-probe recovery path used `disconnect()` + bare
 * `connect()`, which (a) threw `database_url undefined` forever on Postgres
 * because the config was lost, and (b) was a silent no-op on PGLite which had
 * no reconnect() at all. Both engines now expose `reconnect()`; this pins the
 * PGLite side: it restores connectivity against the config captured at the
 * last connect(), and is a safe no-op when never connected.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

describe('#2034 PGLiteEngine.reconnect', () => {
  test('restores connectivity and persisted state against the saved config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-reconnect-'));
    const engine = new PGLiteEngine();
    try {
      await engine.connect({ database_path: dir });
      await engine.initSchema();
      await engine.setConfig('reconnect.probe', 'pre');

      // Reconnect with no args — the #2034 contract: it must reuse the config
      // captured at connect(), not require it to be re-passed.
      await engine.reconnect();

      // Still queryable, and persisted state survived (same data dir).
      const rows = await engine.executeRaw<{ x: number }>('SELECT 1 AS x');
      expect(rows[0]?.x).toBe(1);
      expect(await engine.getConfig('reconnect.probe')).toBe('pre');
    } finally {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reconnect() before any connect() is a safe no-op', async () => {
    const engine = new PGLiteEngine();
    await expect(engine.reconnect()).resolves.toBeUndefined();
  });
});
