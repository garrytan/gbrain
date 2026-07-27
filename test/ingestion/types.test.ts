/**
 * Tests for the IngestionEvent + IngestionSource contract types.
 *
 * Pinned at the contract level: changing these tests is a public-API change.
 * Treat them like test/public-exports.test.ts — they're a regression guard
 * for skillpack publishers depending on the surface.
 */

import { describe, expect, test } from 'bun:test';
import {
  INGESTION_CONTENT_TYPES,
  INGESTION_SOURCE_API_VERSION,
  IngestionEventError,
  computeContentHash,
  validateIngestionEvent,
  type IngestionEvent,
} from '../../src/core/ingestion/types.ts';

const VALID_HASH = 'a'.repeat(64);

function makeEvent(overrides: Partial<IngestionEvent> = {}): IngestionEvent {
  return {
    source_id: 'test-source-1',
    source_kind: 'file-watcher',
    source_uri: '/tmp/test.md',
    received_at: new Date('2026-05-20T12:00:00Z').toISOString(),
    content_type: 'text/markdown',
    content: '# test content',
    content_hash: VALID_HASH,
    ...overrides,
  };
}

describe('IngestionSource contract constants', () => {
  test('INGESTION_SOURCE_API_VERSION is the v1 string', () => {
    expect(INGESTION_SOURCE_API_VERSION).toBe('gbrain-ingestion-source-v1');
  });

  test('INGESTION_CONTENT_TYPES covers the documented taxonomy', () => {
    expect(INGESTION_CONTENT_TYPES).toContain('text/markdown');
    expect(INGESTION_CONTENT_TYPES).toContain('text/plain');
    expect(INGESTION_CONTENT_TYPES).toContain('text/html');
    expect(INGESTION_CONTENT_TYPES).toContain('application/pdf');
    expect(INGESTION_CONTENT_TYPES).toContain('application/json');
    expect(INGESTION_CONTENT_TYPES).toContain('image/*');
    expect(INGESTION_CONTENT_TYPES).toContain('audio/*');
    expect(INGESTION_CONTENT_TYPES).toContain('video/*');
    expect(INGESTION_CONTENT_TYPES).toContain('unknown');
  });
});

describe('computeContentHash', () => {
  test('produces a 64-char lowercase hex string', () => {
    const h = computeContentHash('hello world');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test('deterministic for the same input', () => {
    expect(computeContentHash('foo')).toBe(computeContentHash('foo'));
  });

  test('different inputs produce different hashes', () => {
    expect(computeContentHash('foo')).not.toBe(computeContentHash('bar'));
  });

  test('empty string is allowed and stable', () => {
    const h = computeContentHash('');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(computeContentHash('')).toBe(h);
  });
});

describe('validateIngestionEvent — happy path', () => {
  test('accepts a well-formed event', () => {
    expect(validateIngestionEvent(makeEvent())).toBeNull();
  });

  test('accepts events with optional metadata', () => {
    const ev = makeEvent({ metadata: { format: 'png', width: 1024 } });
    expect(validateIngestionEvent(ev)).toBeNull();
  });

  test('accepts events with untrusted_payload true', () => {
    expect(validateIngestionEvent(makeEvent({ untrusted_payload: true }))).toBeNull();
  });

  test('accepts events with untrusted_payload false', () => {
    expect(validateIngestionEvent(makeEvent({ untrusted_payload: false }))).toBeNull();
  });

  test('accepts every content_type in the taxonomy', () => {
    for (const ct of INGESTION_CONTENT_TYPES) {
      const ev = makeEvent({ content_type: ct });
      expect(validateIngestionEvent(ev)).toBeNull();
    }
  });
});

describe('validateIngestionEvent — rejection cases', () => {
  test('rejects null', () => {
    const err = validateIngestionEvent(null);
    expect(err).toBeInstanceOf(IngestionEventError);
    expect(err?.field).toBe('root');
  });

  test('rejects non-object', () => {
    const err = validateIngestionEvent('not an event');
    expect(err).toBeInstanceOf(IngestionEventError);
  });

  test.each([
    'source_id',
    'source_kind',
    'source_uri',
    'received_at',
    'content',
    'content_hash',
  ] as const)('rejects missing required field: %s', (field) => {
    const ev = makeEvent();
    delete (ev as unknown as Record<string, unknown>)[field];
    const err = validateIngestionEvent(ev);
    expect(err?.field).toBe(field);
  });

  test.each([
    'source_id',
    'source_kind',
    'source_uri',
    'received_at',
    'content',
    'content_hash',
  ] as const)('rejects empty string for required field: %s', (field) => {
    const ev = { ...makeEvent(), [field]: '' };
    const err = validateIngestionEvent(ev);
    expect(err?.field).toBe(field);
  });

  test('rejects unknown content_type', () => {
    const ev = makeEvent({ content_type: 'application/x-malware' as never });
    const err = validateIngestionEvent(ev);
    expect(err?.field).toBe('content_type');
  });

  test('rejects malformed received_at (not parseable)', () => {
    const ev = makeEvent({ received_at: 'not a date' });
    const err = validateIngestionEvent(ev);
    expect(err?.field).toBe('received_at');
  });

  test('rejects malformed content_hash (too short)', () => {
    const ev = makeEvent({ content_hash: 'abc123' });
    const err = validateIngestionEvent(ev);
    expect(err?.field).toBe('content_hash');
  });

  test('rejects malformed content_hash (non-hex characters)', () => {
    const ev = makeEvent({ content_hash: 'Z'.repeat(64) });
    const err = validateIngestionEvent(ev);
    expect(err?.field).toBe('content_hash');
  });

  test('rejects non-boolean untrusted_payload', () => {
    const ev = { ...makeEvent(), untrusted_payload: 'yes' };
    const err = validateIngestionEvent(ev);
    expect(err?.field).toBe('untrusted_payload');
  });

  test('rejects null metadata', () => {
    const ev = { ...makeEvent(), metadata: null };
    const err = validateIngestionEvent(ev);
    expect(err?.field).toBe('metadata');
  });

  test('rejects array metadata', () => {
    const ev = { ...makeEvent(), metadata: [1, 2, 3] };
    const err = validateIngestionEvent(ev);
    expect(err?.field).toBe('metadata');
  });
});

describe('IngestionEventError', () => {
  test('carries field, reason, and event payload', () => {
    const err = new IngestionEventError('content_hash', 'too short', { source_id: 'x' });
    expect(err.field).toBe('content_hash');
    expect(err.reason).toBe('too short');
    expect(err.event).toEqual({ source_id: 'x' });
    expect(err.message).toContain('content_hash');
    expect(err.name).toBe('IngestionEventError');
  });

  test('is an instance of Error', () => {
    const err = new IngestionEventError('source_id', 'missing', {});
    expect(err).toBeInstanceOf(Error);
  });
});
