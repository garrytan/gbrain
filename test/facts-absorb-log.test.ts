/**
 * v0.31.2 — facts:absorb writer + reason-code classifier tests.
 *
 * Pins the contract that runFactsBackstop's queue-mode error path writes
 * stable, scoped, source-aware ingest_log rows that doctor + admin can
 * categorize in PR1 commit 12.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  writeFactsAbsorbLog,
  classifyFactsAbsorbError,
  FACTS_ABSORB_REASONS,
} from '../src/core/facts/absorb-log.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('classifyFactsAbsorbError — reason routing', () => {
  test('null/undefined → pipeline_error', () => {
    expect(classifyFactsAbsorbError(null)).toBe('pipeline_error');
    expect(classifyFactsAbsorbError(undefined)).toBe('pipeline_error');
  });

  test('timeout / 429 / 5xx → gateway_error', () => {
    expect(classifyFactsAbsorbError(new Error('Request timeout'))).toBe('gateway_error');
    expect(classifyFactsAbsorbError(new Error('ETIMEDOUT'))).toBe('gateway_error');
    expect(classifyFactsAbsorbError(new Error('429 too many requests'))).toBe('gateway_error');
    expect(classifyFactsAbsorbError(new Error('rate limit exceeded'))).toBe('gateway_error');
    expect(classifyFactsAbsorbError(new Error('502 bad gateway'))).toBe('gateway_error');
    expect(classifyFactsAbsorbError(new Error('503 service unavailable'))).toBe('gateway_error');
    expect(classifyFactsAbsorbError(new Error('500 internal server error'))).toBe('gateway_error');
  });

  test('network errors → gateway_error', () => {
    expect(classifyFactsAbsorbError(new Error('connect ECONNREFUSED 127.0.0.1:443'))).toBe('gateway_error');
    expect(classifyFactsAbsorbError(new Error('ECONNRESET'))).toBe('gateway_error');
    expect(classifyFactsAbsorbError(new Error('getaddrinfo EAI_AGAIN api.anthropic.com'))).toBe('gateway_error');
  });

  test('JSON parse failures → parse_failure', () => {
    expect(classifyFactsAbsorbError(new Error('JSON.parse: unexpected character'))).toBe('parse_failure');
    expect(classifyFactsAbsorbError(new Error('SyntaxError: Unexpected token } in JSON at position 47'))).toBe('parse_failure');
    expect(classifyFactsAbsorbError(new Error('not valid JSON'))).toBe('parse_failure');
  });

  test('queue overflow / shutdown → matching reason', () => {
    expect(classifyFactsAbsorbError(new Error('queue capacity hit; cap reached'))).toBe('queue_overflow');
    expect(classifyFactsAbsorbError(new Error('queue is shutting down'))).toBe('queue_shutdown');
  });

  test('embed-specific failure → embed_failure', () => {
    expect(classifyFactsAbsorbError(new Error('embedOne failed: dim mismatch'))).toBe('embed_failure');
  });

  test('unknown error → pipeline_error fallback', () => {
    expect(classifyFactsAbsorbError(new Error('some other thing'))).toBe('pipeline_error');
    expect(classifyFactsAbsorbError('string error')).toBe('pipeline_error');
  });
});

describe('writeFactsAbsorbLog — ingest_log row shape', () => {
  test('writes a row with stable shape', async () => {
    await writeFactsAbsorbLog(engine, 'meetings/test-1', 'gateway_error', 'Sonnet returned 429');

    const log = await engine.getIngestLog({ limit: 5 });
    const ours = log.find(r => r.source_ref === 'meetings/test-1' && r.source_type === 'facts:absorb');
    expect(ours).toBeDefined();
    expect(ours!.source_id).toBe('default');  // default fallback
    expect(ours!.summary).toBe('gateway_error: Sonnet returned 429');
    expect(ours!.pages_updated).toEqual([]);
  });

  test('respects custom sourceId', async () => {
    // Seed a non-default source so the FK on ingest_log.source_id resolves.
    // ingest_log doesn't FK source_id (the table predates the source axis;
    // v50 just adds the column with default 'default' — no FK constraint).
    await writeFactsAbsorbLog(engine, 'meetings/test-2', 'parse_failure', 'malformed JSON', 'team-source');
    const log = await engine.getIngestLog({ limit: 10 });
    const ours = log.find(r => r.source_ref === 'meetings/test-2');
    expect(ours).toBeDefined();
    expect(ours!.source_id).toBe('team-source');
  });

  test('truncates detail to 240 chars', async () => {
    const longDetail = 'x'.repeat(500);
    await writeFactsAbsorbLog(engine, 'meetings/test-3', 'pipeline_error', longDetail);
    const log = await engine.getIngestLog({ limit: 10 });
    const ours = log.find(r => r.source_ref === 'meetings/test-3');
    expect(ours).toBeDefined();
    // summary = `${reason}: ${truncated}` — reason is 14 chars + ': '. Total
    // <= 14 + 2 + 240 = 256. The contract: summary's variable part is bounded.
    const summaryDetail = ours!.summary.slice('pipeline_error: '.length);
    expect(summaryDetail.length).toBeLessThanOrEqual(240);
  });

  test('best-effort: a logging error does not throw', async () => {
    // Pass an undefined slug as ref — the helper still writes a row (we
    // coerce via toString slice). If the engine were down, the catch
    // block would absorb. Pin the no-throw contract.
    await expect(writeFactsAbsorbLog(engine, '', 'pipeline_error', '')).resolves.toBeUndefined();
  });

  test('FACTS_ABSORB_REASONS contains every documented reason', () => {
    expect(FACTS_ABSORB_REASONS).toContain('gateway_error');
    expect(FACTS_ABSORB_REASONS).toContain('parse_failure');
    expect(FACTS_ABSORB_REASONS).toContain('queue_overflow');
    expect(FACTS_ABSORB_REASONS).toContain('queue_shutdown');
    expect(FACTS_ABSORB_REASONS).toContain('embed_failure');
    expect(FACTS_ABSORB_REASONS).toContain('pipeline_error');
    expect(FACTS_ABSORB_REASONS.length).toBe(6);
  });
});

// v0.39.3.0 WARN-4 + CQ1 + CV13 — disconnected-engine suppression.
// Pre-fix: '[facts:absorb] failed to log gateway_error for inbox/...: No
// database connection' fired loudly after every gbrain capture. Per CQ1
// suppress via typed access (instanceof GBrainError && .problem) NOT
// string-match on .message. CV13 prints ONE first-occurrence stack
// trace so the next user report can diagnose the wiring bug in v0.38.4.
describe('writeFactsAbsorbLog — WARN-4 disconnected-engine suppression (CQ1 + CV13)', () => {
  // Mock engine that simulates a disconnected state on logIngest. Uses
  // the same GBrainError shape src/core/db.ts:151-158 throws.
  function makeDisconnectedEngine(): {
    engine: import('../src/core/engine.ts').BrainEngine;
    callCount: () => number;
  } {
    let calls = 0;
    return {
      engine: {
        logIngest: async () => {
          calls++;
          // Throw the EXACT shape src/core/db.ts:151-158 throws when
          // `sql` is null (engine not connected yet).
          const { GBrainError } = await import('../src/core/types.ts');
          throw new GBrainError(
            'No database connection',
            'connect() has not been called',
            'Run gbrain init --supabase or gbrain init --url <connection_string>',
          );
        },
      } as unknown as import('../src/core/engine.ts').BrainEngine,
      callCount: () => calls,
    };
  }

  function makeGenericFailureEngine(thrown: unknown): import('../src/core/engine.ts').BrainEngine {
    return {
      logIngest: async () => { throw thrown; },
    } as unknown as import('../src/core/engine.ts').BrainEngine;
  }

  test('GBrainError problem="No database connection" SUPPRESSED after first occurrence', async () => {
    const { _resetFactsAbsorbDisconnectedFlagForTests } = await import('../src/core/facts/absorb-log.ts');
    _resetFactsAbsorbDisconnectedFlagForTests();

    const warnSpy: string[] = [];
    const orig = console.warn;
    console.warn = (msg: unknown) => { warnSpy.push(String(msg)); };

    try {
      const { engine: e1 } = makeDisconnectedEngine();
      // First call → ONE warn with first-occurrence trace
      await writeFactsAbsorbLog(e1, 'inbox/p1', 'gateway_error', 'detail-1');
      expect(warnSpy.length).toBe(1);
      expect(warnSpy[0]).toContain('WARN-4');
      expect(warnSpy[0]).toContain('First-occurrence trace');

      // Second call → SILENT (no additional warn)
      const { engine: e2 } = makeDisconnectedEngine();
      await writeFactsAbsorbLog(e2, 'inbox/p2', 'gateway_error', 'detail-2');
      expect(warnSpy.length).toBe(1); // unchanged

      // Third + fourth → still silent
      const { engine: e3 } = makeDisconnectedEngine();
      const { engine: e4 } = makeDisconnectedEngine();
      await writeFactsAbsorbLog(e3, 'inbox/p3', 'parse_failure', 'detail-3');
      await writeFactsAbsorbLog(e4, 'inbox/p4', 'embed_failure', 'detail-4');
      expect(warnSpy.length).toBe(1);
    } finally {
      console.warn = orig;
    }
  });

  test('GBrainError with DIFFERENT problem still warns loudly (not the suppressed class)', async () => {
    const { _resetFactsAbsorbDisconnectedFlagForTests } = await import('../src/core/facts/absorb-log.ts');
    _resetFactsAbsorbDisconnectedFlagForTests();

    const warnSpy: string[] = [];
    const orig = console.warn;
    console.warn = (msg: unknown) => { warnSpy.push(String(msg)); };

    try {
      const { GBrainError } = await import('../src/core/types.ts');
      const otherError = new GBrainError(
        'Connection pool exhausted',
        'all connections in use',
        'Increase pool size or wait',
      );
      const engine = makeGenericFailureEngine(otherError);
      await writeFactsAbsorbLog(engine, 'inbox/p', 'gateway_error', 'd');
      // Loud warn fires (not the suppressed first-occurrence shape)
      expect(warnSpy.length).toBe(1);
      expect(warnSpy[0]).toContain('failed to log gateway_error');
      expect(warnSpy[0]).not.toContain('First-occurrence');
    } finally {
      console.warn = orig;
    }
  });

  test('non-GBrainError (plain Error) still warns loudly', async () => {
    const { _resetFactsAbsorbDisconnectedFlagForTests } = await import('../src/core/facts/absorb-log.ts');
    _resetFactsAbsorbDisconnectedFlagForTests();

    const warnSpy: string[] = [];
    const orig = console.warn;
    console.warn = (msg: unknown) => { warnSpy.push(String(msg)); };

    try {
      const engine = makeGenericFailureEngine(new Error('something else went wrong'));
      await writeFactsAbsorbLog(engine, 'inbox/p', 'pipeline_error', 'd');
      expect(warnSpy.length).toBe(1);
      expect(warnSpy[0]).toContain('something else went wrong');
    } finally {
      console.warn = orig;
    }
  });

  test('engine call STILL fires for the suppressed case (writeFactsAbsorbLog tried)', async () => {
    // The suppression is on the WARN, not on the attempt. logIngest is
    // still called — we just don't print the failure noise.
    const { _resetFactsAbsorbDisconnectedFlagForTests } = await import('../src/core/facts/absorb-log.ts');
    _resetFactsAbsorbDisconnectedFlagForTests();

    const orig = console.warn;
    console.warn = () => {}; // suppress all warns for this test

    try {
      const { engine, callCount } = makeDisconnectedEngine();
      await writeFactsAbsorbLog(engine, 'inbox/p', 'gateway_error', 'd');
      expect(callCount()).toBe(1);
    } finally {
      console.warn = orig;
    }
  });
});
