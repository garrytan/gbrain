/**
 * Ambient-writeback wiring pins:
 *   - dispatch stamps `remember_status` (inserted|duplicate) onto the verb
 *     usage sidecar (the [c11] fire-and-forget lane) and the memory_writeback
 *     doctor check aggregates it into `remember_over_mcp_7d` with the honest
 *     all-MCP-callers label (OV-A11);
 *   - the writeback-consent advisor collector is REGISTERED in COLLECTORS
 *     (the per-collector registration-pin convention, see
 *     advisor-mcp-client-fit.test.ts).
 *
 * Hermetic PGLite + the usage-log path seam (doctor-memory-verbs-check.test.ts
 * pattern); GBRAIN_HOME scoped per assertion via withEnv.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __setUsageLogPathForTests, readVerbUsage, type VerbUsageEvent } from '../src/core/verbs/usage-log.ts';
import { buildMemoryWritebackCheck } from '../src/commands/doctor/checks/memory-writeback.ts';
import { COLLECTORS } from '../src/core/advisor/run.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const tmpDirs: string[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

afterEach(async () => {
  __setUsageLogPathForTests(null);
  await engine.unsetConfig('memory.auto_writeback');
});

async function callRemember(fact: string) {
  const res = await dispatchToolCall(engine, 'remember', {
    fact,
    kind: 'preference',
    entity: 'people/alice-example',
    provenance: 'test session pins-1, 2026-09-01',
    visibility: 'world',
  }, {
    remote: true,
    takesHoldersAllowList: ['world'],
    sourceId: 'default',
  });
  return JSON.parse(res.content[0].text) as { status?: string };
}

/** logVerbUsage is fire-and-forget — poll the sidecar briefly. */
async function waitForRememberEvents(n: number): Promise<VerbUsageEvent[]> {
  for (let i = 0; i < 60; i++) {
    const ev = (await readVerbUsage()).filter((e) => e.verb === 'remember');
    if (ev.length >= n) return ev;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('remember usage events never landed');
}

/** Seed a sidecar line the dispatch layer would have written (the
 * doctor-memory-verbs-check direct-JSONL pattern) — for the aggregation arms
 * a hermetic keyless dispatch can't produce (duplicate/superseded need
 * embeddings; failed needs a validation error we don't want to depend on). */
function seedLine(path: string, extra: { ok: boolean; remember_status?: string }): void {
  appendFileSync(path, JSON.stringify({
    ts: new Date().toISOString(),
    verb: 'remember',
    surface: 'full',
    remote: true,
    latency_ms: 5,
    brain_id: '/tmp/test-brain',
    source_id: 'default',
    ...extra,
  }) + '\n');
}

describe('dispatch remember_status → usage sidecar → doctor counters (OV-A11)', () => {
  test('a real remember stamps remember_status; memory_writeback aggregates all four arms with the honest label', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-wbpins-'));
    tmpDirs.push(dir);
    const sidecar = join(dir, 'usage.jsonl');
    __setUsageLogPathForTests(sidecar);

    // Real dispatch path: the [c11] fire-and-forget lane stamps the frozen
    // status enum from the verb result.
    const first = await callRemember('prefers dark mode in every editor');
    expect(first.status).toBe('inserted');
    const events = await waitForRememberEvents(1);
    expect((events[0] as { remember_status?: string }).remember_status).toBe('inserted');

    // Aggregation arms the keyless path can't mint (duplicate/superseded
    // require embedding dedup; failed requires a validation error).
    seedLine(sidecar, { ok: true, remember_status: 'duplicate' });
    seedLine(sidecar, { ok: true, remember_status: 'superseded' });
    seedLine(sidecar, { ok: false });

    // The doctor check reads the SAME sidecar (counters only when enabled).
    await engine.setConfig('memory.auto_writeback', 'salient');
    await withEnv({ GBRAIN_HOME: dir }, async () => {
      const c = await buildMemoryWritebackCheck(engine);
      const counters = c.details?.remember_over_mcp_7d as {
        inserted: number; duplicate: number; superseded: number; failed: number; note: string;
      };
      expect(counters).toBeDefined();
      expect(counters.inserted).toBe(1);
      expect(counters.duplicate).toBe(1);
      expect(counters.superseded).toBe(1);
      expect(counters.failed).toBe(1);
      // Honest label: the wire cannot distinguish ambient from explicit.
      expect(counters.note).toContain('ambient and explicit');
    });
  });
});

describe('advisor registration', () => {
  test('writeback-consent collector is registered in COLLECTORS', () => {
    expect(COLLECTORS.some((c) => c.id === 'writeback-consent')).toBe(true);
  });
});
