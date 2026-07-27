/**
 * Judge-errors tests — classification + denominator counting.
 *
 * The first-class judge_errors output is Codex's fix to the silent-skip
 * bias. These tests pin the contract: every error class falls into one
 * of the typed buckets, the total counts up correctly, and the human-
 * facing `note` field is present so consumers know nothing was hidden.
 */

import { describe, test, expect } from 'bun:test';
import {
  classifyError,
  JudgeErrorCollector,
} from '../src/core/eval-contradictions/judge-errors.ts';

describe('classifyError', () => {
  test('classifies JSON parse failures', () => {
    expect(classifyError(new Error('failed to parse JSON output'))).toBe('parse_fail');
    expect(classifyError(new Error('parseModelJSON: all strategies failed'))).toBe('parse_fail');
    expect(classifyError(new Error('json repair did not recover'))).toBe('parse_fail');
  });

  test('classifies model refusals', () => {
    expect(classifyError(new Error("I can't help with that"))).toBe('refusal');
    expect(classifyError(new Error('refused to answer'))).toBe('refusal');
  });

  test('classifies timeouts and aborts', () => {
    expect(classifyError(new Error('request timeout after 30s'))).toBe('timeout');
    expect(classifyError(new Error('the operation timed out'))).toBe('timeout');
    expect(classifyError(new Error('aborted by signal'))).toBe('timeout');
  });

  test('classifies HTTP 5xx and overload', () => {
    expect(classifyError(new Error('503 Service Unavailable'))).toBe('http_5xx');
    expect(classifyError(new Error('Anthropic overloaded'))).toBe('http_5xx');
    expect(classifyError(new Error('upstream 502'))).toBe('http_5xx');
  });

  test('falls back to unknown for unrecognized errors', () => {
    expect(classifyError(new Error('something weird happened'))).toBe('unknown');
    expect(classifyError(null)).toBe('unknown');
    expect(classifyError(undefined)).toBe('unknown');
    expect(classifyError(42)).toBe('unknown');
  });
});

describe('JudgeErrorCollector', () => {
  test('starts empty, finalize yields zero counts but a populated note', () => {
    const c = new JudgeErrorCollector();
    const counts = c.finalize();
    expect(counts.total).toBe(0);
    expect(counts.parse_fail).toBe(0);
    expect(counts.note.length).toBeGreaterThan(10);
  });

  test('tallies a mixed set of errors', () => {
    const c = new JudgeErrorCollector();
    c.record('pair-1', new Error('JSON parse failed'));
    c.record('pair-2', new Error('JSON parse failed'));
    c.record('pair-3', new Error('aborted'));
    c.record('pair-4', new Error('503 upstream'));
    c.record('pair-5', new Error('some weird thing'));
    const counts = c.finalize();
    expect(counts.parse_fail).toBe(2);
    expect(counts.timeout).toBe(1);
    expect(counts.http_5xx).toBe(1);
    expect(counts.unknown).toBe(1);
    expect(counts.refusal).toBe(0);
    expect(counts.total).toBe(5);
  });

  test('preserves row order and pair ids', () => {
    const c = new JudgeErrorCollector();
    c.record('a', new Error('parse'));
    c.record('b', new Error('timeout'));
    const rows = c.rowsOut();
    expect(rows[0].pair_id).toBe('a');
    expect(rows[1].pair_id).toBe('b');
    expect(rows[0].kind).toBe('parse_fail');
    expect(rows[1].kind).toBe('timeout');
  });

  test('note is stable across runs (no PII leak)', () => {
    const c1 = new JudgeErrorCollector();
    const c2 = new JudgeErrorCollector();
    expect(c1.finalize().note).toBe(c2.finalize().note);
  });
});
