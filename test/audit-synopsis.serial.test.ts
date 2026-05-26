/**
 * Tests for src/core/audit-synopsis.ts — failure-only synopsis audit
 * JSONL writer + summary aggregator.
 *
 * Uses GBRAIN_AUDIT_DIR to isolate writes into a temp dir per test.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  logSynopsisFailure,
  readRecentSynopsisFailures,
  summarizeSynopsisFailures,
  computeSynopsisAuditFilename,
} from '../src/core/audit-synopsis.ts';

let tmpDir: string;
const originalEnv = process.env.GBRAIN_AUDIT_DIR;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-synopsis-audit-test-'));
  process.env.GBRAIN_AUDIT_DIR = tmpDir;
});

afterAll(() => {
  if (originalEnv === undefined) delete process.env.GBRAIN_AUDIT_DIR;
  else process.env.GBRAIN_AUDIT_DIR = originalEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Wipe previous test's audit files to keep readback deterministic.
  for (const f of fs.readdirSync(tmpDir)) {
    fs.unlinkSync(path.join(tmpDir, f));
  }
});

describe('computeSynopsisAuditFilename', () => {
  test('ISO-week filename shape', () => {
    const filename = computeSynopsisAuditFilename(new Date('2026-05-22T12:00:00Z'));
    expect(filename).toMatch(/^synopsis-failures-\d{4}-W\d{2}\.jsonl$/);
  });

  test('stable for same week, different days', () => {
    const monday = computeSynopsisAuditFilename(new Date('2026-05-18T08:00:00Z'));
    const friday = computeSynopsisAuditFilename(new Date('2026-05-22T18:00:00Z'));
    expect(monday).toBe(friday);
  });
});

describe('logSynopsisFailure + readRecentSynopsisFailures', () => {
  test('round-trip a single refusal event', () => {
    logSynopsisFailure({
      pageSlug: 'wiki/concepts/test-page',
      sourceId: 'default',
      chunkIndex: 3,
      kind: 'refusal',
      detail: 'stop_reason=content_filter',
      pageLevelFallback: true,
    });
    const events = readRecentSynopsisFailures(7);
    expect(events.length).toBe(1);
    const ev = events[0];
    expect(ev.page_slug).toBe('wiki/concepts/test-page');
    expect(ev.source_id).toBe('default');
    expect(ev.chunk_index).toBe(3);
    expect(ev.kind).toBe('refusal');
    expect(ev.detail).toBe('stop_reason=content_filter');
    expect(ev.page_level_fallback).toBe(true);
    expect(ev.severity).toBe('warn');
  });

  test('multiple events accumulate in correct order', () => {
    logSynopsisFailure({ pageSlug: 'a', sourceId: 'default', chunkIndex: 0, kind: 'refusal', pageLevelFallback: true });
    logSynopsisFailure({ pageSlug: 'b', sourceId: 'default', chunkIndex: 1, kind: 'empty', pageLevelFallback: true });
    logSynopsisFailure({ pageSlug: 'c', sourceId: 'team', chunkIndex: 0, kind: 'rate_limit', pageLevelFallback: false });
    const events = readRecentSynopsisFailures(7);
    expect(events.length).toBe(3);
    expect(events.map((e) => e.page_slug)).toEqual(['a', 'b', 'c']);
  });

  test('detail caps at 200 chars (audit-file pollution defense)', () => {
    const longDetail = 'x'.repeat(500);
    logSynopsisFailure({
      pageSlug: 'a', sourceId: 'default', chunkIndex: 0, kind: 'malformed',
      detail: longDetail, pageLevelFallback: true,
    });
    const events = readRecentSynopsisFailures(7);
    expect(events[0].detail!.length).toBe(200);
  });

  test('missing audit file returns empty array (silent)', () => {
    expect(readRecentSynopsisFailures(7).length).toBe(0);
  });
});

describe('summarizeSynopsisFailures', () => {
  test('null on empty input', () => {
    expect(summarizeSynopsisFailures([])).toBeNull();
  });

  test('aggregates by kind + computes fall-back rate', () => {
    logSynopsisFailure({ pageSlug: 'a', sourceId: 'default', chunkIndex: 0, kind: 'refusal', pageLevelFallback: true });
    logSynopsisFailure({ pageSlug: 'b', sourceId: 'default', chunkIndex: 0, kind: 'refusal', pageLevelFallback: true });
    logSynopsisFailure({ pageSlug: 'c', sourceId: 'default', chunkIndex: 0, kind: 'empty', pageLevelFallback: true });
    logSynopsisFailure({ pageSlug: 'd', sourceId: 'default', chunkIndex: 0, kind: 'rate_limit', pageLevelFallback: false });
    const events = readRecentSynopsisFailures(7);
    const summary = summarizeSynopsisFailures(events);
    expect(summary).not.toBeNull();
    expect(summary!.total).toBe(4);
    expect(summary!.by_kind.refusal).toBe(2);
    expect(summary!.by_kind.empty).toBe(1);
    expect(summary!.by_kind.rate_limit).toBe(1);
    expect(summary!.by_kind.timeout).toBe(0);
    expect(summary!.page_level_fallback_count).toBe(3);
    expect(summary!.page_level_fallback_rate).toBeCloseTo(0.75, 2);
  });
});
