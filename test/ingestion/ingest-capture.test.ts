/**
 * ingest_capture Minion handler tests. Exercises the slug-resolution
 * fallback chain, content-type gating (binary rejection), validation,
 * and the importFromContent integration against an in-memory PGLite.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
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
    deadlineAtMs: null,
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

describe('ingest_capture handler — provenance write-through (#1522)', () => {
  async function pageRow(slug: string): Promise<{ source_id: string; source_kind: string | null; source_uri: string | null; ingested_via: string | null } | undefined> {
    const rows = await engine.executeRaw<{ source_id: string; source_kind: string | null; source_uri: string | null; ingested_via: string | null }>(
      `SELECT source_id, source_kind, source_uri, ingested_via FROM pages WHERE slug = $1`,
      [slug],
    );
    return rows[0];
  }

  test('trusted event with a registered source id routes the page write there and persists source_kind/source_uri', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('m365-example', 'm365-example') ON CONFLICT (id) DO NOTHING`,
    );
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content: '# calendar event',
      source_id: 'm365-example',
      source_kind: 'm365-calendar',
      source_uri: 'm365:event/abc-123',
    });
    const result = await handler(makeJob({ event: ev, slug: 'calendar/evt-1' }));
    expect(result.status).toBe('imported');

    const row = await pageRow('calendar/evt-1');
    expect(row?.source_id).toBe('m365-example');
    expect(row?.source_kind).toBe('m365-calendar');
    expect(row?.source_uri).toBe('m365:event/abc-123');
    expect(row?.ingested_via).toBe('ingest_capture');
  });

  test('unregistered emitter source_id (webhook-<clientId>) keeps default-source routing but still persists provenance', async () => {
    const handler = makeIngestCaptureHandler(engine);
    // makeEvent's source_id 'webhook-test' is NOT a registered source.
    const ev = makeEvent({ content: '# webhook capture' });
    const result = await handler(makeJob({ event: ev, slug: 'inbox/webhook-1' }));
    expect(result.status).toBe('imported');

    const row = await pageRow('inbox/webhook-1');
    expect(row?.source_id).toBe('default');
    expect(row?.source_kind).toBe('webhook');
    expect(row?.source_uri).toBe('mcp-webhook:client-x:1234');
    expect(row?.ingested_via).toBe('ingest_capture');
  });

  test('untrusted event cannot choose its write source even when the id is registered (fail-closed)', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('wiki', 'wiki') ON CONFLICT (id) DO NOTHING`,
    );
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content: '# untrusted payload',
      source_id: 'wiki',
      untrusted_payload: true,
    });
    const result = await handler(makeJob({ event: ev, slug: 'inbox/untrusted-1' }));
    expect(result.status).toBe('imported');

    const row = await pageRow('inbox/untrusted-1');
    expect(row?.source_id).toBe('default');
    // Provenance strings (no scoping power) still persist.
    expect(row?.source_kind).toBe('webhook');
  });
});

describe('ingest_capture handler — write-source attribution', () => {
  async function sourceForSlug(slug: string): Promise<string | undefined> {
    const rows = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM pages WHERE slug = $1`,
      [slug],
    );
    return rows[0]?.source_id;
  }

  async function provenanceForSlug(slug: string): Promise<{
    source_id: string;
    source_kind: string | null;
    source_uri: string | null;
    ingested_via: string | null;
  } | undefined> {
    const rows = await engine.executeRaw<{
      source_id: string;
      source_kind: string | null;
      source_uri: string | null;
      ingested_via: string | null;
    }>(
      `SELECT source_id, source_kind, source_uri, ingested_via FROM pages WHERE slug = $1`,
      [slug],
    );
    return rows[0];
  }

  /** Engine proxy that throws `err` from the first transaction, then delegates. */
  function engineThrowingOnce(err: unknown): BrainEngine {
    let attempts = 0;
    return new Proxy(engine as BrainEngine, {
      get(target, prop) {
        if (prop === 'transaction') {
          return async <T>(fn: (tx: BrainEngine) => Promise<T>): Promise<T> => {
            attempts++;
            if (attempts === 1) throw err;
            return target.transaction(fn);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  test('job.data.sourceId naming a live source routes the write there without fallback', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('oauth-source', 'oauth-source')`,
    );
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content: '# scoped webhook capture',
      source_id: 'webhook-client-x',
      untrusted_payload: true,
    });

    const result = await handler(makeJob({
      event: ev,
      slug: 'inbox/scoped-webhook',
      sourceId: 'oauth-source',
    }));

    expect(await sourceForSlug('inbox/scoped-webhook')).toBe('oauth-source');
    expect(result.source_fallback).toBeUndefined();
  });

  test('job.data.sourceId naming a missing source falls back to default', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content: '# missing scoped source',
      source_id: 'webhook-client-x',
      untrusted_payload: true,
    });

    const result = await handler(makeJob({
      event: ev,
      slug: 'inbox/missing-scoped-source',
      sourceId: 'missing-source',
    }));

    expect(await sourceForSlug('inbox/missing-scoped-source')).toBe('default');
    expect(result.source_fallback).toEqual({
      requested: 'missing-source',
      effective: 'default',
      reason: 'not_registered',
    });
  });

  test('job.data.sourceId naming an archived source falls back to default', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, archived) VALUES ('archived-source', 'archived-source', true)`,
    );
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content: '# archived scoped source',
      source_id: 'webhook-client-x',
      untrusted_payload: true,
    });

    const result = await handler(makeJob({
      event: ev,
      slug: 'inbox/archived-scoped-source',
      sourceId: 'archived-source',
    }));

    expect(await sourceForSlug('inbox/archived-scoped-source')).toBe('default');
    expect(result.source_fallback).toEqual({
      requested: 'archived-source',
      effective: 'default',
      reason: 'archived',
    });
  });

  test('foreign-key violation retries once under default', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('racing-source', 'racing-source')`,
    );
    let transactionAttempts = 0;
    const racingEngine = new Proxy(engine as BrainEngine, {
      get(target, prop) {
        if (prop === 'transaction') {
          return async <T>(fn: (tx: BrainEngine) => Promise<T>): Promise<T> => {
            transactionAttempts++;
            if (transactionAttempts === 1) {
              throw Object.assign(new Error('insert or update on table "pages" violates foreign key constraint "pages_source_id_fk"'), { code: '23503' });
            }
            return target.transaction(fn);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const handler = makeIngestCaptureHandler(racingEngine);
    const ev = makeEvent({
      content: '# source deleted during write',
      source_id: 'webhook-client-x',
      untrusted_payload: true,
    });

    const result = await handler(makeJob({
      event: ev,
      slug: 'inbox/source-fk-race',
      sourceId: 'racing-source',
    }));

    expect(transactionAttempts).toBe(2);
    expect(await sourceForSlug('inbox/source-fk-race')).toBe('default');
    expect(result.source_fallback).toEqual({
      requested: 'racing-source',
      effective: 'default',
      reason: 'fk_violation',
    });
  });

  test('untrusted event without job.data.sourceId stays under default', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('caller-source', 'caller-source')`,
    );
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content: '# caller-selected source',
      source_id: 'caller-source',
      untrusted_payload: true,
    });

    const result = await handler(makeJob({ event: ev, slug: 'inbox/untrusted-default' }));

    expect(await sourceForSlug('inbox/untrusted-default')).toBe('default');
    expect(result.source_fallback).toBeUndefined();
  });

  test('trusted event without job.data.sourceId uses its live event.source_id', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('daemon-source', 'daemon-source')`,
    );
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content: '# daemon-routed source',
      source_id: 'daemon-source',
      untrusted_payload: false,
    });

    const result = await handler(makeJob({ event: ev, slug: 'inbox/daemon-source' }));

    expect(await sourceForSlug('inbox/daemon-source')).toBe('daemon-source');
    expect(result.source_fallback).toBeUndefined();
  });

  test("job.data.sourceId === 'default' (the unscoped-client production shape) writes under default", async () => {
    // serve-http.ts sends `authInfo.sourceId ?? 'default'`, so an unscoped or
    // legacy OAuth client posts the literal string 'default' — a different
    // branch than omitting the key entirely. No fallback: default IS the
    // intended destination, not a miss.
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content: '# unscoped client capture',
      source_id: 'webhook-client-x',
      untrusted_payload: true,
    });

    const result = await handler(makeJob({
      event: ev,
      slug: 'inbox/unscoped-default',
      sourceId: 'default',
    }));

    expect(await sourceForSlug('inbox/unscoped-default')).toBe('default');
    expect(result.source_fallback).toBeUndefined();
  });

  test('provenance survives the FK-violation retry', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('racing-source-2', 'racing-source-2')`,
    );
    const handler = makeIngestCaptureHandler(
      engineThrowingOnce(Object.assign(new Error('insert or update on table "pages" violates foreign key constraint "pages_source_id_fk"'), { code: '23503' })),
    );
    const ev = makeEvent({
      content: '# provenance across retry',
      source_id: 'webhook-client-x',
      source_uri: 'https://example.com/retry-provenance',
      untrusted_payload: true,
    });

    const result = await handler(makeJob({
      event: ev,
      slug: 'inbox/retry-provenance',
      sourceId: 'racing-source-2',
    }));

    expect(result.source_fallback?.reason).toBe('fk_violation');
    // The retry rebuilds the importFromContent options; provenance must not be
    // dropped on that second path (acceptance criterion 6).
    const page = await provenanceForSlug('inbox/retry-provenance');
    expect(page?.source_id).toBe('default');
    expect(page?.source_kind).toBe(ev.source_kind);
    expect(page?.source_uri).toBe('https://example.com/retry-provenance');
    expect(page?.ingested_via).toBe('ingest_capture');
  });

  test('a non-FK error propagates instead of being retried as a source fallback', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('unrelated-failure-source', 'unrelated-failure-source')`,
    );
    const handler = makeIngestCaptureHandler(
      engineThrowingOnce(Object.assign(new Error('disk on fire'), { code: '53100' })),
    );
    const ev = makeEvent({
      content: '# unrelated failure',
      source_id: 'webhook-client-x',
      untrusted_payload: true,
    });

    // Must reject — silently rewriting this as "source unavailable, wrote under
    // default" would mask a real failure and report success for a lost capture.
    await expect(handler(makeJob({
      event: ev,
      slug: 'inbox/unrelated-failure',
      sourceId: 'unrelated-failure-source',
    }))).rejects.toThrow('disk on fire');
    expect(await sourceForSlug('inbox/unrelated-failure')).toBeUndefined();
  });

  test('a 23503 from an UNRELATED constraint propagates instead of falling back to default', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('unrelated-fk-source', 'unrelated-fk-source')`,
    );
    // SQLSTATE 23503 alone is too broad: an FK violation from chunks/tags/
    // versions must NOT be reinterpreted as "source unavailable" and silently
    // rewritten into the default partition — that would mask a real integrity
    // failure and report success for a page that landed in the wrong place.
    const handler = makeIngestCaptureHandler(
      engineThrowingOnce(Object.assign(
        new Error('insert or update on table "content_chunks" violates foreign key constraint "content_chunks_page_id_fkey"'),
        { code: '23503' },
      )),
    );
    const ev = makeEvent({
      content: '# unrelated fk constraint',
      source_id: 'webhook-client-x',
      untrusted_payload: true,
    });

    await expect(handler(makeJob({
      event: ev,
      slug: 'inbox/unrelated-fk-constraint',
      sourceId: 'unrelated-fk-source',
    }))).rejects.toThrow('content_chunks_page_id_fkey');
    expect(await sourceForSlug('inbox/unrelated-fk-constraint')).toBeUndefined();
  });

  test('an FK violation with no requested source propagates (nothing to fall back from)', async () => {
    const handler = makeIngestCaptureHandler(
      engineThrowingOnce(Object.assign(new Error('unrelated fk'), { code: '23503' })),
    );
    const ev = makeEvent({
      content: '# fk without requested source',
      source_id: 'webhook-client-x',
      untrusted_payload: true,
    });

    await expect(handler(makeJob({
      event: ev,
      slug: 'inbox/fk-no-source',
    }))).rejects.toThrow('unrelated fk');
  });

  test('trusted event with an UNREGISTERED source_id stays under default SILENTLY (no fallback report — #1522 daemon path unchanged)', async () => {
    // Daemon emitters (inbox-folder / file-watcher) send untrusted_payload:false
    // with source_id = their emitter id, which is often not a registered brain
    // source. That path must keep #1522's silent default fallback: no
    // source_fallback, no per-capture warning. The attribution reporting is
    // scoped to the trusted job.data.sourceId (webhook) path only.
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content: '# daemon unregistered emitter',
      source_id: 'daemon-emitter-unregistered',
      untrusted_payload: false,
    });

    const result = await handler(makeJob({ event: ev, slug: 'inbox/daemon-unregistered' }));

    expect(await sourceForSlug('inbox/daemon-unregistered')).toBe('default');
    expect(result.source_fallback).toBeUndefined();
  });

  test('a 23503 naming another table\'s FK to sources() propagates, not falls back', async () => {
    // Many tables reference sources(id) (files_source_id_fkey, facts_source_id_fkey,
    // code_edges, calibration_profiles, …). Matching any 23503 whose message merely
    // mentions "source" would rewrite a genuine integrity failure on one of those
    // into reason:'fk_violation' and quietly land the page in the default partition —
    // the exact masking the discrimination exists to prevent. Only the PAGES source
    // FK may trigger the retry.
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('sibling-fk-source', 'sibling-fk-source')`,
    );
    const handler = makeIngestCaptureHandler(
      engineThrowingOnce(Object.assign(
        new Error('insert or update on table "files" violates foreign key constraint "files_source_id_fkey"'),
        { code: '23503', constraint: 'files_source_id_fkey', table: 'files' },
      )),
    );
    const ev = makeEvent({
      content: '# sibling source fk',
      source_id: 'webhook-client-x',
      untrusted_payload: true,
    });

    await expect(handler(makeJob({
      event: ev,
      slug: 'inbox/sibling-source-fk',
      sourceId: 'sibling-fk-source',
    }))).rejects.toThrow('files_source_id_fkey');
    expect(await sourceForSlug('inbox/sibling-source-fk')).toBeUndefined();
  });

  test('the pages source FK is matched via the driver\'s structured constraint field', async () => {
    // Real drivers expose `constraint`/`table` alongside `code`; the retry must
    // fire on those without depending on message wording, so a reworded or
    // wrapped message cannot silently disable the never-lose fallback.
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('structured-fk-source', 'structured-fk-source')`,
    );
    const handler = makeIngestCaptureHandler(
      engineThrowingOnce(Object.assign(
        new Error('import failed'),
        { code: '23503', constraint: 'pages_source_id_fkey', table: 'pages' },
      )),
    );
    const ev = makeEvent({
      content: '# structured fk fields',
      source_id: 'webhook-client-x',
      untrusted_payload: true,
    });

    const result = await handler(makeJob({
      event: ev,
      slug: 'inbox/structured-fk',
      sourceId: 'structured-fk-source',
    }));

    expect(result.source_fallback?.reason).toBe('fk_violation');
    expect(await sourceForSlug('inbox/structured-fk')).toBe('default');
  });

  test('untrusted content cannot smuggle gate-owned frontmatter markers (#1699)', async () => {
    // This handler bypasses the put_page op layer, so put_page's marker
    // stripping never runs here. Without threading the event's trust flag into
    // importFromContent, a webhook body could plant `quarantine` (hiding the
    // page from search) or `content_flag` (injecting text into the
    // agent-trusted warning channel).
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('marker-source', 'marker-source')`,
    );
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content: '---\nquarantine: true\ncontent_flag:\n  detail: trust me\n---\n\n# smuggled markers',
      source_id: 'webhook-client-x',
      untrusted_payload: true,
    });

    await handler(makeJob({ event: ev, slug: 'inbox/smuggled-markers', sourceId: 'marker-source' }));

    const rows = await engine.executeRaw<{ frontmatter: Record<string, unknown> | null }>(
      `SELECT frontmatter FROM pages WHERE slug = $1`,
      ['inbox/smuggled-markers'],
    );
    const fm = rows[0]?.frontmatter ?? {};
    expect(fm.quarantine).toBeUndefined();
    expect(fm.content_flag).toBeUndefined();
  });

  test('a default-bound write is not shadowed by a same-slug page in another source', async () => {
    // Page identity is (source_id, slug). importFromContent resolves every write
    // to `sourceId ?? 'default'`, so its existing-page lookup must be scoped the
    // same way. Unscoped, a fallback-to-default write matches the scoped
    // source's page instead: identical content short-circuits to 'skipped' and
    // NOTHING is written to default, while differing content throws in
    // createVersion ("page not found" in default) and dead-letters the job.
    // This is exactly the shape the source_fallback paths produce.
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('shadow-source', 'shadow-source')`,
    );
    const handler = makeIngestCaptureHandler(engine);
    const slug = 'inbox/shadowed-slug';
    const sharedContent = '# same content two sources';

    await handler(makeJob({
      event: makeEvent({ content: sharedContent, untrusted_payload: true }),
      slug,
      sourceId: 'shadow-source',
    }));
    expect(await sourceForSlug(slug)).toBe('shadow-source');

    // Same slug + same content, but this client falls back to default.
    const result = await handler(makeJob({
      event: makeEvent({ content: sharedContent, untrusted_payload: true }),
      slug,
      sourceId: 'never-registered-source',
    }));
    expect(result.source_fallback?.reason).toBe('not_registered');

    const rows = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM pages WHERE slug = $1 ORDER BY source_id`,
      [slug],
    );
    expect(rows.map(r => r.source_id)).toEqual(['default', 'shadow-source']);

    // And the differing-content variant must not throw out of createVersion.
    const updated = await handler(makeJob({
      event: makeEvent({ content: '# different content entirely', untrusted_payload: true }),
      slug,
      sourceId: 'never-registered-source',
    }));
    expect(updated.status).not.toBe('error');
  });

  test('a trusted daemon event KEEPS gate-owned markers (stripping is untrusted-only)', async () => {
    // The mirror of the case above: local/trusted emitters own these markers
    // (the quarantine CLI and the sanity gate write them), so stripping must be
    // conditioned on the event's trust flag, not applied unconditionally.
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('trusted-marker-source', 'trusted-marker-source')`,
    );
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content: '---\nquarantine: true\n---\n\n# trusted markers',
      source_id: 'trusted-marker-source',
      untrusted_payload: false,
    });

    await handler(makeJob({ event: ev, slug: 'inbox/trusted-markers' }));

    const rows = await engine.executeRaw<{ frontmatter: Record<string, unknown> | null }>(
      `SELECT frontmatter FROM pages WHERE slug = $1`,
      ['inbox/trusted-markers'],
    );
    expect((rows[0]?.frontmatter ?? {}).quarantine).toBe(true);
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

// #3756 — tombstone events map to a reconciler-style soft-delete behind the
// trusted-source gate. Untrusted channels (webhook payloads) must never be
// able to delete pages.
describe('ingest_capture handler — tombstones (#3756)', () => {
  test('soft-deletes an existing page and reports status deleted', async () => {
    await engine.putPage('inbox/to-remove', {
      type: 'note',
      title: 'To Remove',
      compiled_truth: '# To Remove\n\nbody',
    } as any, { sourceId: 'default' });

    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ kind: 'tombstone', slug: 'inbox/to-remove', content: 'tombstone', untrusted_payload: false });
    const result = await handler(makeJob({ event: ev }));
    expect(result.status).toBe('deleted');
    expect(result.slug).toBe('inbox/to-remove');
    expect(result.chunks).toBe(0);

    // Soft delete: row survives with deleted_at stamped (restorable), not a hard DELETE.
    const rows = await engine.executeRaw<{ deleted_at: string | null }>(
      `SELECT deleted_at FROM pages WHERE slug = $1 AND source_id = 'default'`,
      ['inbox/to-remove'],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.deleted_at).not.toBeNull();
  });

  test('tombstone for a missing page reports skipped', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ kind: 'tombstone', slug: 'inbox/never-existed', content: 'tombstone', untrusted_payload: false });
    const result = await handler(makeJob({ event: ev }));
    expect(result.status).toBe('skipped');
  });

  test('untrusted payloads must not delete', async () => {
    await engine.putPage('inbox/protected', {
      type: 'note',
      title: 'Protected',
      compiled_truth: '# Protected\n\nbody',
    } as any, { sourceId: 'default' });

    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      kind: 'tombstone',
      slug: 'inbox/protected',
      content: 'tombstone',
      untrusted_payload: true,
    });
    await expect(handler(makeJob({ event: ev }))).rejects.toThrow(/untrusted/i);
    const page = await engine.getPage('inbox/protected', { sourceId: 'default' });
    expect(page).not.toBeNull();
  });

  test('tombstone with the flag OMITTED is rejected (fail-closed, explicit trusted marker required)', async () => {
    await engine.putPage('inbox/also-protected', {
      type: 'note',
      title: 'Also Protected',
      compiled_truth: '# Also Protected\n\nbody',
    } as any, { sourceId: 'default' });

    const handler = makeIngestCaptureHandler(engine);
    // No untrusted_payload at all — pre-fix this fell OPEN (treated as
    // trusted); the gate now requires the explicit `untrusted_payload: false`.
    const ev = makeEvent({ kind: 'tombstone', slug: 'inbox/also-protected', content: 'tombstone' });
    expect(ev.untrusted_payload).toBeUndefined();
    await expect(handler(makeJob({ event: ev }))).rejects.toThrow(/trusted/i);
    const page = await engine.getPage('inbox/also-protected', { sourceId: 'default' });
    expect(page).not.toBeNull();
  });

  test('tombstone delete is scoped to the resolved source', async () => {
    // Same slug in two sources; tombstone under default must not touch testsrc.
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('tombsrc', 'tombsrc') ON CONFLICT (id) DO NOTHING`,
      [],
    );
    await engine.putPage('inbox/dupe', {
      type: 'note', title: 'Dupe default', compiled_truth: '# d',
    } as any, { sourceId: 'default' });
    await engine.putPage('inbox/dupe', {
      type: 'note', title: 'Dupe tombsrc', compiled_truth: '# t',
    } as any, { sourceId: 'tombsrc' });

    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ kind: 'tombstone', slug: 'inbox/dupe', content: 'tombstone', untrusted_payload: false });
    const result = await handler(makeJob({ event: ev }));
    expect(result.status).toBe('deleted');

    const other = await engine.getPage('inbox/dupe', { sourceId: 'tombsrc' });
    expect(other).not.toBeNull();
  });

  test('event.slug wins over the generated default for upserts too', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: 'top-level slug', slug: 'inbox/from-event-slug' });
    const result = await handler(makeJob({ event: ev }));
    expect(result.slug).toBe('inbox/from-event-slug');
    expect(result.status).toBe('imported');
  });
});
