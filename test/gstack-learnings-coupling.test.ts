/**
 * v0.36.0.0 (T11 / E4) — gstack-learnings coupling tests.
 *
 * Hermetic. Pure-function tests + writer-injection tests. No real gstack
 * binary, no shell-out.
 *
 * Tests cover:
 *  - config gate: enabled=false → skipped with reason='config_disabled'
 *  - quality gate: only 'incorrect' and 'partial' trigger
 *  - happy path: writer called with correct entry shape
 *  - entry shape: namespace prefix on key, files[] includes page slug,
 *    tag suffix when active bias tags present
 *  - graceful degrade: writer throw → reason='write_failed', no rethrow
 *  - binary-missing detection via error-message classification
 *  - long claim truncation
 *  - missing optional fields don't break entry construction
 */

import { describe, test, expect } from 'bun:test';
import {
  writeIncorrectResolution,
  buildLearningEntry,
  GSTACK_LEARNING_NAMESPACE,
  type IncorrectResolutionEvent,
  type GstackLearningEntry,
} from '../src/core/calibration/gstack-coupling.ts';
import { GBrainError } from '../src/core/types.ts';

function buildEvent(overrides: Partial<IncorrectResolutionEvent> = {}): IncorrectResolutionEvent {
  return {
    takeId: 42,
    pageSlug: 'wiki/companies/acme-example',
    rowNum: 3,
    holder: 'garry',
    claim: 'Cold-start liquidity always wins in marketplaces.',
    quality: 'incorrect',
    weight: 0.85,
    confidence: 0.95,
    reasoning: 'Two competing marketplaces both failed to bootstrap demand-side liquidity.',
    activeBiasTags: ['over-confident-market-timing'],
    ...overrides,
  };
}

// ─── buildLearningEntry ─────────────────────────────────────────────

describe('buildLearningEntry', () => {
  test('emits canonical entry shape', () => {
    const entry = buildLearningEntry(buildEvent());
    expect(entry.skill).toBe('gbrain-calibration');
    expect(entry.type).toBe('observation');
    expect(entry.source).toBe('observed');
    expect(entry.key).toContain(GSTACK_LEARNING_NAMESPACE);
    expect(entry.key).toContain('take-42');
    expect(entry.files).toEqual(['wiki/companies/acme-example']);
    expect(entry.insight).toContain('garry');
    expect(entry.insight).toContain('was wrong');
    expect(entry.insight).toContain('conviction 0.85');
  });

  test('uses "was partially wrong" wording on partial verdict', () => {
    const entry = buildLearningEntry(buildEvent({ quality: 'partial' }));
    expect(entry.insight).toContain('was partially wrong');
  });

  test('namespace tag suffix derived from first active bias tag', () => {
    const entry = buildLearningEntry(
      buildEvent({ activeBiasTags: ['over-confident-geography', 'late-on-macro'] }),
    );
    expect(entry.key).toContain('over-confident-geography');
    expect(entry.insight).toContain('Pattern: over-confident-geography, late-on-macro');
  });

  test('omits Pattern: line when activeBiasTags empty', () => {
    const entry = buildLearningEntry(buildEvent({ activeBiasTags: [] }));
    expect(entry.insight).not.toContain('Pattern:');
  });

  test('truncates long claim text at 200 chars + ellipsis', () => {
    const longClaim = 'x'.repeat(500);
    const entry = buildLearningEntry(buildEvent({ claim: longClaim }));
    // 200 chars + 1 ellipsis char = 201 visible chars in the quoted claim
    expect(entry.insight).toContain('x'.repeat(200) + '…');
  });

  test('default confidence 0.8 when omitted', () => {
    const ev = buildEvent();
    delete (ev as IncorrectResolutionEvent & { confidence?: number }).confidence;
    const entry = buildLearningEntry(ev);
    expect(entry.confidence).toBe(0.8);
  });

  test('omits reasoning suffix when reasoning is undefined', () => {
    const ev = buildEvent();
    delete (ev as IncorrectResolutionEvent & { reasoning?: string }).reasoning;
    const entry = buildLearningEntry(ev);
    expect(entry.insight).not.toContain('Reasoning:');
  });
});

// ─── writeIncorrectResolution ───────────────────────────────────────

describe('writeIncorrectResolution', () => {
  test('config gate: enabled=false → skipped, no writer call', async () => {
    let writerCalls = 0;
    const result = await writeIncorrectResolution({
      event: buildEvent(),
      enabled: false,
      writer: () => {
        writerCalls++;
      },
    });
    expect(result.written).toBe(false);
    expect(result.reason).toBe('config_disabled');
    expect(writerCalls).toBe(0);
  });

  test("quality gate: 'correct' or 'unresolvable' rejected (defensive)", async () => {
    let writerCalls = 0;
    const writer = () => {
      writerCalls++;
    };
    // TypeScript will catch most misuses, but the runtime guard exists
    // because the caller (grade-takes) determines quality from the verdict
    // path — defense in depth.
    const result = await writeIncorrectResolution({
      event: buildEvent({ quality: 'correct' as IncorrectResolutionEvent['quality'] }),
      enabled: true,
      writer,
    });
    expect(result.written).toBe(false);
    expect(result.reason).toBe('quality_not_eligible');
    expect(writerCalls).toBe(0);
  });

  test('happy path: writer called with built entry, returns written=true', async () => {
    let received: GstackLearningEntry | undefined;
    const result = await writeIncorrectResolution({
      event: buildEvent(),
      enabled: true,
      writer: (entry) => {
        received = entry;
      },
    });
    expect(result.written).toBe(true);
    expect(received).toBeDefined();
    expect(received!.skill).toBe('gbrain-calibration');
    expect(received!.key).toContain('take-42');
  });

  test('writer throws → reason="write_failed", no rethrow', async () => {
    const result = await writeIncorrectResolution({
      event: buildEvent(),
      enabled: true,
      writer: () => {
        throw new Error('connection refused');
      },
    });
    expect(result.written).toBe(false);
    expect(result.reason).toBe('write_failed');
    expect(result.error).toContain('connection refused');
  });

  test('writer throws GBrainError(GSTACK_BINARY_NOT_FOUND) → reason="binary_missing"', async () => {
    const result = await writeIncorrectResolution({
      event: buildEvent(),
      enabled: true,
      writer: () => {
        throw new GBrainError(
          'GSTACK_BINARY_NOT_FOUND',
          'gstack-learnings-log binary not on PATH',
          'install gstack',
        );
      },
    });
    expect(result.written).toBe(false);
    expect(result.reason).toBe('binary_missing');
  });

  test('writer that returns a Promise is awaited', async () => {
    let resolved = false;
    const writer = (_entry: GstackLearningEntry): Promise<void> =>
      new Promise(r => {
        setTimeout(() => {
          resolved = true;
          r();
        }, 10);
      });
    const result = await writeIncorrectResolution({
      event: buildEvent(),
      enabled: true,
      writer,
    });
    expect(result.written).toBe(true);
    expect(resolved).toBe(true);
  });

  test('partial quality writes (not just incorrect)', async () => {
    let writerCalls = 0;
    await writeIncorrectResolution({
      event: buildEvent({ quality: 'partial' }),
      enabled: true,
      writer: () => {
        writerCalls++;
      },
    });
    expect(writerCalls).toBe(1);
  });
});
