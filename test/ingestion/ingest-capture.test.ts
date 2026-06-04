/**
 * ingest_capture Minion handler tests. Exercises the slug-resolution
 * fallback chain, content-type gating (binary rejection), validation,
 * and the importFromContent integration against an in-memory PGLite.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import {
  defaultSlugForEvent,
  makeIngestCaptureHandler,
} from '../../src/core/minions/handlers/ingest-capture.ts';
import {
  computeContentHash,
  type IngestionEvent,
} from '../../src/core/ingestion/types.ts';
import type { MinionJobContext } from '../../src/core/minions/types.ts';

let engine: PGLiteEngine;

// 30s hook timeout — when this file runs deep in a shard process that's
// already created ~20 PGLite engines, the WASM cold-start + 95 migrations
// on a fresh DB legitimately exceeds bun's 5s hook default. CI shard 4
// hit this on v0.41.17.0 (95 migrations × 21 files × 1 bun process).
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30_000);

afterAll(async () => {
  await engine.disconnect();
}, 30_000);

beforeEach(async () => {
  await resetPgliteState(engine);
});

function makeEvent(overrides: Partial<IngestionEvent> = {}): IngestionEvent {
  const content = overrides.content ?? '# captured thought';
  return {
    source_id: 'webhook-test',
    source_kind: 'webhook',
    source_uri: 'mcp-webhook:client-x:1234',
    received_at: new Date('2026-05-20T12:00:00Z').toISOString(),
    content_type: 'text/markdown',
    content,
    content_hash: overrides.content_hash ?? computeContentHash(content),
    ...overrides,
  };
}

function makeJob(data: Record<string, unknown>): MinionJobContext {
  return {
    id: 1,
    name: 'ingest_capture',
    data,
    attempts_made: 1,
    signal: new AbortController().signal,
    shutdownSignal: new AbortController().signal,
    updateProgress: async () => {},
    updateTokens: async () => {},
    log: async () => {},
    isActive: async () => true,
    readInbox: async () => [],
  };
}

describe('defaultSlugForEvent', () => {
  test('builds inbox/YYYY-MM-DD-<hash6> slug', () => {
    const ev = makeEvent({ content_hash: 'abcdef1234567890'.padEnd(64, '0') });
    const slug = defaultSlugForEvent(ev, new Date('2026-05-20T00:00:00Z'));
    expect(slug).toBe('inbox/2026-05-20-abcdef');
  });

  test('stable for same content (deterministic hash)', () => {
    const ev = makeEvent({ content: 'same thought' });
    const date = new Date('2026-05-20T00:00:00Z');
    expect(defaultSlugForEvent(ev, date)).toBe(defaultSlugForEvent(ev, date));
  });

  test('UTC date math (no tz drift)', () => {
    const ev = makeEvent();
    const slug = defaultSlugForEvent(ev, new Date('2026-01-05T23:59:59Z'));
    expect(slug).toMatch(/^inbox\/2026-01-05-/);
  });
});

describe('ingest_capture handler — slug resolution', () => {
  test('uses caller-provided job.data.slug when present', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: 'with explicit slug' });
    const result = await handler(makeJob({ event: ev, slug: 'wiki/specific/page' }));
    expect(result.slug).toBe('wiki/specific/page');
    expect(result.status).toBe('imported');
  });

  test('uses event.metadata.slug when set', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: 'metadata slug', metadata: { slug: 'inbox/custom-from-meta' } });
    const result = await handler(makeJob({ event: ev }));
    expect(result.slug).toBe('inbox/custom-from-meta');
  });

  test('falls back to inbox/YYYY-MM-DD-<hash6> when no slug provided', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: 'fallback slug' });
    const result = await handler(makeJob({ event: ev }));
    expect(result.slug).toMatch(/^inbox\/\d{4}-\d{2}-\d{2}-[a-f0-9]{6}$/);
  });
});

describe('ingest_capture handler — validation + routing', () => {
  test('throws when event missing', async () => {
    const handler = makeIngestCaptureHandler(engine);
    await expect(handler(makeJob({}))).rejects.toThrow(/job.data.event is required/);
  });

  test('throws on invalid event payload (caught at the handler boundary)', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = { ...makeEvent(), content_hash: 'short' };
    await expect(handler(makeJob({ event: ev }))).rejects.toThrow(/invalid event payload/);
  });

  test('rejects binary content_type with helpful message', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content_type: 'image/*',
      content: '/path/to/screenshot.png',
      content_hash: computeContentHash('/path/to/screenshot.png'),
    });
    await expect(handler(makeJob({ event: ev }))).rejects.toThrow(
      /content_type 'image\/\*' requires a content-type processor/,
    );
  });

  test('untrusted_payload flag round-trips to the result', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: 'untrusted', untrusted_payload: true });
    const result = await handler(makeJob({ event: ev }));
    expect(result.untrusted_payload).toBe(true);
  });

  test('trusted (default) payload round-trips as false', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: 'trusted' });
    const result = await handler(makeJob({ event: ev }));
    expect(result.untrusted_payload).toBe(false);
  });

  test('source provenance round-trips into the result', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content: 'with provenance',
      source_kind: 'inbox-folder',
      source_uri: '/Users/test/.gbrain/inbox/note.md',
    });
    const result = await handler(makeJob({ event: ev }));
    expect(result.source_kind).toBe('inbox-folder');
    expect(result.source_uri).toBe('/Users/test/.gbrain/inbox/note.md');
  });
});

describe('ingest_capture handler — integration with importFromContent', () => {
  test('imported event lands as a page in the DB', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content: '---\ntitle: Test Page\n---\n\n# E2E import\n\nbody content',
    });
    const result = await handler(makeJob({ event: ev, slug: 'wiki/e2e-test' }));
    expect(result.status).toBe('imported');

    const page = await engine.getPage('wiki/e2e-test');
    expect(page).not.toBeNull();
    expect(page?.compiled_truth).toContain('E2E import');
  });

  test('repeat ingest of same content returns skipped status (content_hash dedup at importFromContent level)', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: '# stable content' });
    const result1 = await handler(makeJob({ event: ev, slug: 'wiki/stable' }));
    expect(result1.status).toBe('imported');

    const result2 = await handler(makeJob({ event: ev, slug: 'wiki/stable' }));
    expect(result2.status).toBe('skipped');
  });

  test('chunks count is reported on imported events', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const longContent = '---\ntitle: long\n---\n\n' + 'Paragraph.\n\n'.repeat(50);
    const ev = makeEvent({ content: longContent });
    const result = await handler(makeJob({ event: ev, slug: 'wiki/long' }));
    expect(result.chunks).toBeGreaterThan(0);
  });
});
