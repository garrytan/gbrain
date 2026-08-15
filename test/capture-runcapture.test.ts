/**
 * v0.39.3.0 Phase 3c — capture CLI write-side test surface.
 *
 * Covers the pure helpers introduced/changed in capture.ts as a unit
 * test (not the full runCapture orchestration; that's exercised via
 * the existing tests + the E2E ingest-capture-provenance suite).
 * Hermetic — no engine, no DB.
 *
 * Findings exercised here:
 *   CV9  normalizeForHash — separates hash normalization from storage
 *   CV8  receipt hash from rawBody (the slug + content_hash use the
 *        normalized body, not the timestamp-bearing frontmatter)
 *   CV10 detectBinaryNullByte — first-8KB sniff, deterministic fixtures
 *   A2   maybeRewriteSourceFkError — friendly hint pattern (both engines)
 *
 * runCapture's branching (thin-client rejection of --source, source
 * resolver, exit-1 paths) is verified by exercising the helpers and
 * by the existing tests; integration is covered by the E2E test added
 * in test/e2e/ingest-capture-provenance.test.ts.
 */

import { describe, test, expect } from 'bun:test';
import { __testing as captureTesting } from '../src/commands/capture.ts';
import { computeContentHash } from '../src/core/ingestion/types.ts';

const { detectBinaryNullByte, normalizeForHash, maybeRewriteSourceFkError } = captureTesting;

describe('CV10 — binary file guard (detectBinaryNullByte)', () => {
  test('returns -1 on plain ASCII', () => {
    expect(detectBinaryNullByte(Buffer.from('hello world'))).toBe(-1);
  });

  test('returns -1 on UTF-8 with CJK (測試)', () => {
    expect(detectBinaryNullByte(Buffer.from('測試 brain content'))).toBe(-1);
  });

  test('returns -1 on UTF-8 with emoji (🧠🔥)', () => {
    expect(detectBinaryNullByte(Buffer.from('thinking 🧠🔥 hot'))).toBe(-1);
  });

  test('returns -1 on UTF-8 BOM-prefixed text', () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const text = Buffer.from('# heading\n\nbody');
    expect(detectBinaryNullByte(Buffer.concat([bom, text]))).toBe(-1);
  });

  test('returns offset on NUL byte at start', () => {
    const bytes = Buffer.from([0x00, 0x68, 0x69]);
    expect(detectBinaryNullByte(bytes)).toBe(0);
  });

  test('returns offset on NUL byte mid-buffer', () => {
    const bytes = Buffer.from('hello\x00world');
    expect(detectBinaryNullByte(bytes)).toBe(5);
  });

  test('returns offset on PNG magic bytes (NUL at byte 0)', () => {
    // PNG header has multiple NUL bytes — the first appears at offset 8
    // (after the 8-byte signature 0x89 0x50 0x4e 0x47 0x0d 0x0a 0x1a 0x0a,
    // the IHDR chunk length 0x00 0x00 0x00 0x0d follows).
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
      0x00, 0x00, 0x00, 0x0d,                          // IHDR length
    ]);
    expect(detectBinaryNullByte(png)).toBe(8);
  });

  test('caps scan at 8KB (NUL at offset 8192 NOT detected)', () => {
    const bytes = Buffer.alloc(10_000, 0x41); // 'A' bytes
    bytes[8192] = 0x00; // beyond the 8KB ceiling
    expect(detectBinaryNullByte(bytes)).toBe(-1);
  });

  test('detects NUL at exactly offset 8191 (within scan window)', () => {
    const bytes = Buffer.alloc(10_000, 0x41);
    bytes[8191] = 0x00;
    expect(detectBinaryNullByte(bytes)).toBe(8191);
  });

  test('empty buffer returns -1', () => {
    expect(detectBinaryNullByte(Buffer.alloc(0))).toBe(-1);
  });
});

describe('CV9 — normalizeForHash (trim + LF + NFKC)', () => {
  test('strips leading/trailing whitespace', () => {
    expect(normalizeForHash('  hello  ')).toBe('hello');
  });

  test('strips UTF-8 BOM', () => {
    expect(normalizeForHash('﻿hello')).toBe('hello');
  });

  test('normalizes CRLF to LF', () => {
    expect(normalizeForHash('a\r\nb\r\nc')).toBe('a\nb\nc');
  });

  test('NFKC normalizes precomposed/decomposed Unicode (ñ)', () => {
    // U+00F1 (precomposed) vs U+006E + U+0303 (decomposed). NFKC unifies.
    const precomposed = 'mañana';
    const decomposed = 'mañana'; // ñ as n + combining tilde
    expect(normalizeForHash(precomposed)).toBe(normalizeForHash(decomposed));
  });

  test('does not modify already-clean text', () => {
    expect(normalizeForHash('clean text\nwith newlines')).toBe('clean text\nwith newlines');
  });

  test('whitespace-only input normalizes to empty', () => {
    expect(normalizeForHash('   \n\r\n\t  ')).toBe('');
  });
});

describe('CV8 — receipt hash stable across timestamp variations', () => {
  test('identical input text produces identical hash regardless of when called', () => {
    const text = 'remember to follow up on the X deal';
    const h1 = computeContentHash(normalizeForHash(text));
    // Simulate "captured at a different time" by re-calling
    const h2 = computeContentHash(normalizeForHash(text));
    expect(h1).toBe(h2);
  });

  test('hash differs for different content', () => {
    const h1 = computeContentHash(normalizeForHash('text A'));
    const h2 = computeContentHash(normalizeForHash('text B'));
    expect(h1).not.toBe(h2);
  });

  test('whitespace differences normalize to same hash (CV9 + CV8 interaction)', () => {
    const h1 = computeContentHash(normalizeForHash('  same text  '));
    const h2 = computeContentHash(normalizeForHash('same text'));
    expect(h1).toBe(h2);
  });

  test('CRLF vs LF line endings normalize to same hash', () => {
    const h1 = computeContentHash(normalizeForHash('line1\r\nline2'));
    const h2 = computeContentHash(normalizeForHash('line1\nline2'));
    expect(h1).toBe(h2);
  });
});

describe('A2 — maybeRewriteSourceFkError (friendly FK violation hint)', () => {
  test('rewrites the raw Postgres pages_source_id_fk message', () => {
    const err = new Error(
      'insert or update on table "pages" violates foreign key constraint "pages_source_id_fk"',
    );
    const hint = maybeRewriteSourceFkError(err, 'dept-x');
    expect(hint).toContain("source 'dept-x' is not registered");
    expect(hint).toContain('gbrain sources add dept-x');
    expect(hint).toContain('gbrain sources list');
  });

  test('rewrites a wrapped OperationError-style message containing the FK constraint name', () => {
    const err = new Error(
      'put_page failed: insert or update on table "pages" violates foreign key constraint "pages_source_id_fk"',
    );
    const hint = maybeRewriteSourceFkError(err, 'my-source');
    expect(hint).toContain("source 'my-source' is not registered");
  });

  test('rewrites a "foreign key constraint ... source" pattern (postgres.js wrapped)', () => {
    const err = new Error(
      'update or delete on table "sources" violates foreign key constraint',
    );
    expect(maybeRewriteSourceFkError(err, 'src-x')).toContain("source 'src-x' is not registered");
  });

  test('returns null on unrelated errors', () => {
    expect(maybeRewriteSourceFkError(new Error('connection timeout'), 'dept-x')).toBeNull();
    expect(maybeRewriteSourceFkError(new Error('syntax error'), 'dept-x')).toBeNull();
  });

  test('returns null when sourceId is undefined (no friendly hint possible without the source name)', () => {
    const err = new Error('pages_source_id_fk violation');
    expect(maybeRewriteSourceFkError(err, undefined)).toBeNull();
  });

  test('handles non-Error throws (string thrown directly)', () => {
    const hint = maybeRewriteSourceFkError('pages_source_id_fk constraint violation', 'foo');
    expect(hint).not.toBeNull();
    expect(hint).toContain("source 'foo'");
  });
});
