/**
 * v0.40.4.0 — `gbrain search stats` graph_signals section.
 *
 * Pins:
 *   - readGraphSignalsStats reads search.graph_signals config first
 *     (returns source='config'), falls back to mode default.
 *   - When config absent, balanced/tokenmax → enabled=true (mode_default)
 *     and conservative → enabled=false (mode_default).
 *   - failures_count reflects JSONL audit events in window.
 *   - failures_by_reason buckets by first word of error_summary.
 *
 * Hermetic via PGLite + withEnv for GBRAIN_AUDIT_DIR.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withEnv } from '../helpers/with-env.ts';

// Internal helpers — pull via dynamic import in the tests so the
// withEnv-wrapped GBRAIN_AUDIT_DIR is honored by the audit writer's
// lazy `resolveAuditDir()` calls.

let engine: PGLiteEngine;
const tmpDirs: string[] = [];

function mkTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-graph-stats-test-'));
  tmpDirs.push(d);
  return d;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
});

afterAll(async () => {
  if (engine) await engine.disconnect();
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

beforeEach(async () => {
  // Reset config between tests.
  await engine.executeRaw(`DELETE FROM config WHERE key IN ('search.graph_signals', 'search.mode')`);
});

describe('search-stats graph_signals section — config resolution', () => {
  test('search.graph_signals=true → enabled true, source config', async () => {
    await engine.setConfig('search.graph_signals', 'true');
    const dir = mkTmp();
    await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
      const mod = await import(`../../src/commands/search.ts?stats-test=${Date.now()}`);
      // private function isn't exported — drive it via the public stats
      // surface and parse JSON output.
      const cmd = await import('../../src/commands/search.ts');
      const captured: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => { captured.push(args.join(' ')); };
      try {
        // runStatsSubcommand is unexported; call runSearch with 'stats --json'.
        await cmd.runSearch(engine as any, ['stats', '--json']);
      } finally {
        console.log = origLog;
      }
      const json = JSON.parse(captured.join('\n'));
      expect(json.graph_signals.enabled).toBe(true);
      expect(json.graph_signals.source).toBe('config');
      expect(json.graph_signals.failures_count).toBe(0);
    });
  });

  test('config absent + mode=conservative → enabled false, source mode_default', async () => {
    await engine.setConfig('search.mode', 'conservative');
    const dir = mkTmp();
    await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
      const cmd = await import('../../src/commands/search.ts');
      const captured: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => { captured.push(args.join(' ')); };
      try {
        await cmd.runSearch(engine as any, ['stats', '--json']);
      } finally {
        console.log = origLog;
      }
      const json = JSON.parse(captured.join('\n'));
      expect(json.graph_signals.enabled).toBe(false);
      expect(json.graph_signals.source).toBe('mode_default');
    });
  });

  test('config absent + no mode (default balanced) → enabled true, source mode_default', async () => {
    const dir = mkTmp();
    await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
      const cmd = await import('../../src/commands/search.ts');
      const captured: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => { captured.push(args.join(' ')); };
      try {
        await cmd.runSearch(engine as any, ['stats', '--json']);
      } finally {
        console.log = origLog;
      }
      const json = JSON.parse(captured.join('\n'));
      expect(json.graph_signals.enabled).toBe(true);
      expect(json.graph_signals.source).toBe('mode_default');
    });
  });
});

describe('search-stats graph_signals section — failure rollup', () => {
  test('JSONL audit failures surfaced in failures_count + failures_by_reason', async () => {
    const dir = mkTmp();
    await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
      // Seed audit events using the audit-writer primitive directly so
      // we get realistic file shape.
      const { createAuditWriter } = await import('../../src/core/audit/audit-writer.ts');
      const writer = createAuditWriter<any>({ featureName: 'graph-signals-failures' });
      writer.log({ error_summary: 'ECONNREFUSED: bad gateway', top_k_size: 20 });
      writer.log({ error_summary: 'ECONNREFUSED: server gone', top_k_size: 15 });
      writer.log({ error_summary: 'timeout exceeded waiting for query', top_k_size: 20 });

      const cmd = await import('../../src/commands/search.ts');
      const captured: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => { captured.push(args.join(' ')); };
      try {
        await cmd.runSearch(engine as any, ['stats', '--json']);
      } finally {
        console.log = origLog;
      }
      const json = JSON.parse(captured.join('\n'));
      expect(json.graph_signals.failures_count).toBe(3);
      expect(json.graph_signals.failures_by_reason.ECONNREFUSED).toBe(2);
      expect(json.graph_signals.failures_by_reason.timeout).toBe(1);
    });
  });

  test('no failures → failures_count 0, empty failures_by_reason', async () => {
    const dir = mkTmp();
    await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
      const cmd = await import('../../src/commands/search.ts');
      const captured: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => { captured.push(args.join(' ')); };
      try {
        await cmd.runSearch(engine as any, ['stats', '--json']);
      } finally {
        console.log = origLog;
      }
      const json = JSON.parse(captured.join('\n'));
      expect(json.graph_signals.failures_count).toBe(0);
      expect(Object.keys(json.graph_signals.failures_by_reason)).toHaveLength(0);
    });
  });
});

describe('search-stats graph_signals section — human output', () => {
  test('human output includes "Graph signals:" header + enabled line', async () => {
    const dir = mkTmp();
    await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
      const cmd = await import('../../src/commands/search.ts');
      const captured: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => { captured.push(args.join(' ')); };
      try {
        await cmd.runSearch(engine as any, ['stats']);
      } finally {
        console.log = origLog;
      }
      const out = captured.join('\n');
      expect(out).toContain('Graph signals:');
      expect(out).toContain('enabled:');
      expect(out).toMatch(/failures:\s+0/);
    });
  });
});
