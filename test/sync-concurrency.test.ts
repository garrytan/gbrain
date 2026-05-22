/**
 * Unit tests for the shared concurrency-policy helper. Covers:
 *
 *   - Q5: autoConcurrency() returns correct counts for PGLite, explicit
 *     override, auto path above/below threshold.
 *   - Q1: shouldRunParallel() respects explicit opt-in even on small diffs.
 *   - Q2/T3: parseWorkers() throws on bad CLI input (0, -3, "foo", "1.5").
 *
 * These exist because the prior policy was duplicated across three call sites
 * (performSync, performFullSync, jobs handler) with subtle differences.
 * Centralized helper + tests prevents the next drift.
 */
import { describe, expect, test } from 'bun:test';
import {
  autoConcurrency,
  shouldRunParallel,
  parseWorkers,
  AUTO_CONCURRENCY_FILE_THRESHOLD,
  PARALLEL_FILE_FLOOR,
  DEFAULT_PARALLEL_WORKERS,
} from '../src/core/sync-concurrency.ts';
import type { BrainEngine } from '../src/core/engine.ts';

// Minimal engine stub — autoConcurrency only reads .kind.
function engineOfKind(kind: 'postgres' | 'pglite'): BrainEngine {
  return { kind } as unknown as BrainEngine;
}

describe('autoConcurrency', () => {
  test('PGLite always serial (single connection)', () => {
    expect(autoConcurrency(engineOfKind('pglite'), 1000)).toBe(1);
    expect(autoConcurrency(engineOfKind('pglite'), 1000, 8)).toBe(1);
    expect(autoConcurrency(engineOfKind('pglite'), 0)).toBe(1);
  });

  test('Postgres + explicit override wins', () => {
    expect(autoConcurrency(engineOfKind('postgres'), 5, 4)).toBe(4);
    expect(autoConcurrency(engineOfKind('postgres'), 5, 1)).toBe(1);
    expect(autoConcurrency(engineOfKind('postgres'), 5, 16)).toBe(16);
  });

  test('Postgres explicit 0 clamped to 1 (paranoia — parseWorkers should reject first)', () => {
    expect(autoConcurrency(engineOfKind('postgres'), 100, 0)).toBe(1);
    expect(autoConcurrency(engineOfKind('postgres'), 100, -5)).toBe(1);
  });

  test('Postgres + auto path: under threshold serial', () => {
    expect(autoConcurrency(engineOfKind('postgres'), 50)).toBe(1);
    expect(autoConcurrency(engineOfKind('postgres'), AUTO_CONCURRENCY_FILE_THRESHOLD)).toBe(1);
  });

  test('Postgres + auto path: above threshold parallel', () => {
    expect(autoConcurrency(engineOfKind('postgres'), AUTO_CONCURRENCY_FILE_THRESHOLD + 1)).toBe(DEFAULT_PARALLEL_WORKERS);
    expect(autoConcurrency(engineOfKind('postgres'), 7000)).toBe(DEFAULT_PARALLEL_WORKERS);
  });

  test('full-sync large marker fires parallel for Postgres', () => {
    expect(autoConcurrency(engineOfKind('postgres'), Number.MAX_SAFE_INTEGER)).toBe(DEFAULT_PARALLEL_WORKERS);
  });
});

describe('shouldRunParallel', () => {
  test('serial when worker count <= 1', () => {
    expect(shouldRunParallel(1, 1000, false)).toBe(false);
    expect(shouldRunParallel(1, 1000, true)).toBe(false);
    expect(shouldRunParallel(0, 1000, true)).toBe(false);
  });

  test('Q1: explicit opt-in beats the file-count floor', () => {
    // User typed --workers 4 with 30 files. Prior behavior: silently serial.
    // New behavior: respect the user.
    expect(shouldRunParallel(4, 30, /*explicit*/ true)).toBe(true);
    expect(shouldRunParallel(2, 1, true)).toBe(true);
  });

  test('auto path honors PARALLEL_FILE_FLOOR', () => {
    // No explicit opt-in: use the floor as the gate.
    expect(shouldRunParallel(4, PARALLEL_FILE_FLOOR, false)).toBe(false);
    expect(shouldRunParallel(4, PARALLEL_FILE_FLOOR + 1, false)).toBe(true);
    expect(shouldRunParallel(4, 0, false)).toBe(false);
  });
});

describe('parseWorkers (Q2)', () => {
  test('undefined input → undefined output', () => {
    expect(parseWorkers(undefined)).toBeUndefined();
  });

  test('positive integer accepted', () => {
    expect(parseWorkers('1')).toBe(1);
    expect(parseWorkers('4')).toBe(4);
    expect(parseWorkers('128')).toBe(128);
  });

  test('zero rejected (the original silent footgun)', () => {
    expect(() => parseWorkers('0')).toThrow(/positive integer/);
  });

  test('negative rejected', () => {
    expect(() => parseWorkers('-3')).toThrow(/positive integer/);
    expect(() => parseWorkers('-1')).toThrow(/positive integer/);
  });

  test('non-numeric rejected', () => {
    expect(() => parseWorkers('foo')).toThrow(/positive integer/);
    expect(() => parseWorkers('')).toThrow(/positive integer/);
  });

  test('non-integer (decimal) rejected', () => {
    // parseInt("1.5") returns 1, but "1.5" !== "1" so we reject.
    expect(() => parseWorkers('1.5')).toThrow(/positive integer/);
  });

  test('integer with trailing chars rejected', () => {
    // parseInt("4abc") returns 4 silently; we want loud failure.
    expect(() => parseWorkers('4abc')).toThrow(/positive integer/);
  });

  test('whitespace tolerated (since CLI parsers may pass the literal)', () => {
    // " 4 " trims to "4" which equals String(4). Accepted.
    expect(parseWorkers(' 4 ')).toBe(4);
  });
});
