// v0.41.19.0 — T5 of ops-fix-wave.
//
// Pins mentionsFingerprint determinism + sensitivity. Codex flagged that
// the prior plan's fingerprint omitted gazetteer hash, so resuming a
// paused by-mention run after adding new entity pages would silently
// skip them. The gazetteer field below is the regression guard.

import { describe, test, expect } from 'bun:test';
import { mentionsFingerprint } from '../src/core/op-checkpoint.ts';

describe('mentionsFingerprint (T5 codex fix #3)', () => {
  test('same inputs → same fingerprint', () => {
    const a = mentionsFingerprint({
      source: 'default',
      type: 'meeting',
      since: '2026-01-01',
      gazetteerHash: 'abc12345',
    });
    const b = mentionsFingerprint({
      source: 'default',
      type: 'meeting',
      since: '2026-01-01',
      gazetteerHash: 'abc12345',
    });
    expect(a).toBe(b);
  });

  test('different source → different fingerprint', () => {
    const a = mentionsFingerprint({ source: 'source-a', gazetteerHash: 'abc12345' });
    const b = mentionsFingerprint({ source: 'source-b', gazetteerHash: 'abc12345' });
    expect(a).not.toBe(b);
  });

  test('different type → different fingerprint', () => {
    const a = mentionsFingerprint({ type: 'meeting', gazetteerHash: 'abc12345' });
    const b = mentionsFingerprint({ type: 'article', gazetteerHash: 'abc12345' });
    expect(a).not.toBe(b);
  });

  test('different since → different fingerprint', () => {
    const a = mentionsFingerprint({ since: '2026-01-01', gazetteerHash: 'abc12345' });
    const b = mentionsFingerprint({ since: '2026-02-01', gazetteerHash: 'abc12345' });
    expect(a).not.toBe(b);
  });

  test('different gazetteer hash → different fingerprint (codex fix #3 regression guard)', () => {
    // The load-bearing assertion: if entity pages change mid-pause, the
    // gazetteer hash shifts and the checkpoint invalidates cleanly.
    // Without this, resumed runs would skip pages against a new gazetteer
    // and never re-scan them.
    const a = mentionsFingerprint({ source: 'default', gazetteerHash: 'aaaaaaaa' });
    const b = mentionsFingerprint({ source: 'default', gazetteerHash: 'bbbbbbbb' });
    expect(a).not.toBe(b);
  });

  test('optional fields default symmetrically', () => {
    // source omitted should equal source: 'default' explicit.
    const explicit = mentionsFingerprint({ source: 'default', gazetteerHash: 'abc12345' });
    const omitted = mentionsFingerprint({ gazetteerHash: 'abc12345' });
    expect(explicit).toBe(omitted);
  });

  test('returns stable 8-char hex slice', () => {
    const fp = mentionsFingerprint({ source: 'default', gazetteerHash: 'abc12345' });
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
  });
});
