/**
 * v146 `extract_atoms_transcript_state` plumbing — error surfacing (wave review).
 *
 * Two silent spots in the transcript failure-count / tombstone path:
 *   - recordItemFailureCount's transcript branch swallowed EVERY write error
 *     with `catch { return null; }`, so a transcript whose strike never landed
 *     (connection blip, RLS, a typo'd column) silently never tombstoned and
 *     re-spent budget forever — the exact class #4916 exists to close.
 *   - tombstonedTranscriptsForHashes logged a full error line on EVERY cycle
 *     of an un-migrated brain (the table simply isn't there yet).
 *
 * Now: a real write error is reported on stderr; a missing table is a
 * once-per-process warning (isUndefinedTableError), not a per-cycle error.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { runPhaseExtractAtoms, tombstonedTranscriptsForHashes } from '../src/core/cycle/extract-atoms.ts';
import { _resetWarnOnceForTests } from '../src/core/utils.ts';
import type { ChatResult, ChatOpts } from '../src/core/ai/gateway.ts';

function capture(): { errors: string[]; warns: string[]; restore: () => void } {
  const errors: string[] = [];
  const warns: string[] = [];
  const savedError = console.error;
  const savedWarn = console.warn;
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')); };
  console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')); };
  return { errors, warns, restore: () => { console.error = savedError; console.warn = savedWarn; } };
}

function throwingEngine(err: Error): BrainEngine {
  return { executeRaw: async () => { throw err; } } as unknown as BrainEngine;
}

describe('tombstonedTranscriptsForHashes — un-migrated brain vs real failure', () => {
  afterEach(() => _resetWarnOnceForTests());

  test('a missing table warns ONCE per process and never reaches console.error', async () => {
    const c = capture();
    try {
      const engine = throwingEngine(Object.assign(
        new Error('relation "extract_atoms_transcript_state" does not exist'), { code: '42P01' }));
      expect(await tombstonedTranscriptsForHashes(engine, 'default', ['a'.repeat(16)])).toEqual(new Set());
      expect(await tombstonedTranscriptsForHashes(engine, 'default', ['b'.repeat(16)])).toEqual(new Set());
    } finally {
      c.restore();
    }
    expect(c.errors).toEqual([]);
    expect(c.warns).toHaveLength(1);
    expect(c.warns[0]).toContain('extract_atoms_transcript_state');
  });

  test('any other error is still reported on stderr every time (assuming none tombstoned)', async () => {
    const c = capture();
    try {
      const engine = throwingEngine(new Error('connection reset by peer'));
      expect(await tombstonedTranscriptsForHashes(engine, 'default', ['a'.repeat(16)])).toEqual(new Set());
    } finally {
      c.restore();
    }
    expect(c.warns).toEqual([]);
    expect(c.errors).toHaveLength(1);
    expect(c.errors[0]).toContain('connection reset by peer');
  });
});

describe('recordItemFailureCount — transcript strike write failures are surfaced', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 120_000);

  afterAll(async () => {
    await engine.disconnect();
  });

  const prose = async (_o: ChatOpts): Promise<ChatResult> => ({
    text: 'I could not find anything to extract.',
    blocks: [{ type: 'text', text: '' }],
    stopReason: 'end',
    usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5',
    providerId: 'anthropic',
  });

  /** Same engine, but the transcript-state strike INSERT fails like a flaky connection would. */
  function withFailingStrike(target: PGLiteEngine, err: Error): BrainEngine {
    return new Proxy(target, {
      get(t, prop, recv) {
        if (prop === 'executeRaw') {
          return async (sql: string, params?: unknown[]) => {
            if (sql.includes('INSERT INTO extract_atoms_transcript_state')) throw err;
            return t.executeRaw(sql, params);
          };
        }
        return Reflect.get(t, prop, recv);
      },
    }) as unknown as BrainEngine;
  }

  test('a real write error is reported on stderr (not swallowed)', async () => {
    const c = capture();
    try {
      await runPhaseExtractAtoms(withFailingStrike(engine, new Error('connection reset by peer')), {
        sourceId: 'default',
        _transcripts: [{ filePath: '/fake/meeting-x.txt', content: 'transcript content x', contentHash: 'd1b2c3d4e5f60718' }],
        _pages: [],
        _chat: prose,
      });
    } finally {
      c.restore();
    }
    const strikeErrors = c.errors.filter((l) => l.includes('failure-count') || l.includes('failure count'));
    expect(strikeErrors).toHaveLength(1);
    expect(strikeErrors[0]).toContain('connection reset by peer');
    expect(strikeErrors[0]).toContain('/fake/meeting-x.txt');
  }, 60_000);

  test('a missing table is NOT reported by the strike path (the tombstone check already warned once)', async () => {
    _resetWarnOnceForTests();
    const c = capture();
    try {
      await runPhaseExtractAtoms(withFailingStrike(engine, Object.assign(
        new Error('relation "extract_atoms_transcript_state" does not exist'), { code: '42P01' })), {
        sourceId: 'default',
        _transcripts: [{ filePath: '/fake/meeting-y.txt', content: 'transcript content y', contentHash: 'e1b2c3d4e5f60718' }],
        _pages: [],
        _chat: prose,
      });
    } finally {
      c.restore();
    }
    expect(c.errors.filter((l) => l.includes('failure-count') || l.includes('failure count'))).toEqual([]);
  }, 60_000);
});
