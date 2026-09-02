import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let root: string;
let brainDir: string;
let priorGbrainHome: string | undefined;

const putPage = operations.find((op) => op.name === 'put_page')!;
const appendEvent = operations.find((op) => op.name === 'append_page_event')!;

function localCtx(): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
  };
}

function oauthCtx(clientId = 'ray-personal'): OperationContext {
  return {
    ...localCtx(),
    remote: true,
    transport: 'http',
    auth: { token: 'test-token', clientId, scopes: ['write'], sourceId: 'default' },
  };
}

function person(title = 'Example Person'): string {
  return `---
type: person
title: ${title}
id: person-1
tags:
  - contact
last_contacted: 2026-08-30
last_interaction_channel: slack
---

## Context

Original context.

## Interactions

- 2026-08-30 · slack · Existing interaction
`;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  root = mkdtempSync(join(tmpdir(), 'append-page-event-c1-'));
  brainDir = join(root, 'brain');
  require('node:fs').mkdirSync(brainDir, { recursive: true });
  priorGbrainHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = join(root, 'gbrain-home');
  await engine.setConfig('sync.repo_path', brainDir);
  await engine.setConfig('sync.write_through', 'true');
  await putPage.handler(localCtx(), { slug: 'people/example-person', content: person() });
});

afterEach(() => {
  if (priorGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = priorGbrainHome;
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe('append_page_event C1 operation', () => {
  test('public schema excludes caller-controlled event identity', () => {
    expect(appendEvent.params.event_token).toBeUndefined();
  });

  test('is fail-closed while its feature flag is disabled', async () => {
    const file = join(brainDir, 'people/example-person.md');
    const before = readFileSync(file, 'utf8');
    await expect(appendEvent.handler(localCtx(), {
      slug: 'people/example-person',
      idempotency_key: 'gmail:m1:people/example-person',
      date: '2026-09-02',
      channel: 'email',
      note: 'Discussed renewal timing',
    })).rejects.toMatchObject({ code: 'unavailable' });
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  test('appends, projects, and returns a server-derived immutable receipt', async () => {
    await engine.setConfig('writer.append_page_event', 'true');
    const result = await appendEvent.handler(oauthCtx(), {
      slug: 'people/example-person',
      idempotency_key: '  gmail:m1:people/example-person  ',
      date: '2026-09-02',
      channel: 'email',
      note: 'Discussed renewal timing',
      event_token: 'caller-must-not-control-this',
    }) as { status: string; receipt: Record<string, unknown> };
    expect(result.status).toBe('appended');
    expect(result.receipt).toMatchObject({
      receipt_version: 2,
      principal_id: 'oauth:ray-personal',
      operation: 'append_page_event',
      source_id: 'default',
      slug: 'people/example-person',
      idempotency_key: 'gmail:m1:people/example-person',
    });
    const canonical = readFileSync(join(brainDir, 'people/example-person.md'), 'utf8');
    expect(canonical).toContain(`<!-- cosmic:event:v1 ${result.receipt.receipt_id} -->`);
    expect(canonical).not.toContain('caller-must-not-control-this');
    expect(canonical).toContain('- 2026-09-02 · email · Discussed renewal timing');
    expect((await engine.getPage('people/example-person', { sourceId: 'default' }))?.compiled_truth).toContain('Discussed renewal timing');
  });

  test('committed receipt replays after the projected page is later soft-deleted', async () => {
    await engine.setConfig('writer.append_page_event', 'true');
    const params = {
      slug: 'people/example-person',
      idempotency_key: 'gmail:deleted-replay:people/example-person',
      date: '2026-09-02',
      channel: 'email',
      note: 'Receipt survives later deletion',
    };
    const first = await appendEvent.handler(oauthCtx(), params) as { receipt: Record<string, unknown> };
    expect(await engine.softDeletePage('people/example-person', { sourceId: 'default' })).not.toBeNull();
    const replay = await appendEvent.handler(oauthCtx(), params) as { status: string; receipt: Record<string, unknown> };
    expect(replay.status).toBe('replayed');
    expect(replay.receipt).toEqual(first.receipt);
    expect((await engine.getPage('people/example-person', { sourceId: 'default' })) ?? null).toBeNull();
  });

  test('fresh key against a soft-deleted page leaves canonical and journal unchanged', async () => {
    await engine.setConfig('writer.append_page_event', 'true');
    const file = join(brainDir, 'people/example-person.md');
    const before = readFileSync(file, 'utf8');
    expect(await engine.softDeletePage('people/example-person', { sourceId: 'default' })).not.toBeNull();
    await expect(appendEvent.handler(oauthCtx(), {
      slug: 'people/example-person',
      idempotency_key: 'gmail:fresh-after-delete:people/example-person',
      date: '2026-09-02',
      channel: 'email',
      note: 'Must not append',
    })).rejects.toMatchObject({ code: 'page_not_found' });
    expect(readFileSync(file, 'utf8')).toBe(before);
    const journalRoot = join(root, 'gbrain-home', 'canonical-mutation-journal');
    expect(existsSync(journalRoot) ? readdirSync(journalRoot) : []).toEqual([]);
  });

  test('projects missing canonical tags without deleting DB-only enrichment tags', async () => {
    await engine.setConfig('writer.append_page_event', 'true');
    await engine.removeTag('people/example-person', 'contact', { sourceId: 'default' });
    await engine.addTag('people/example-person', 'enriched-by-agent', { sourceId: 'default' });
    await appendEvent.handler(oauthCtx(), {
      slug: 'people/example-person',
      idempotency_key: 'gmail:tag-reconcile:people/example-person',
      date: '2026-09-02',
      channel: 'email',
      note: 'Tag reconciliation probe',
    });
    expect((await engine.getTags('people/example-person', { sourceId: 'default' })).sort())
      .toEqual(['contact', 'enriched-by-agent']);
  });

  test('refreshes content chunks with the appended interaction before committing', async () => {
    await engine.setConfig('writer.append_page_event', 'true');
    const unique = 'CosmicChunkProjectionSentinel20260902';
    const result = await appendEvent.handler(oauthCtx(), {
      slug: 'people/example-person',
      idempotency_key: 'gmail:chunk-projection:people/example-person',
      date: '2026-09-02',
      channel: 'email',
      note: unique,
    });
    expect(result).toMatchObject({ status: 'appended', projection_state: 'current' });
    const chunks = await engine.getChunks('people/example-person', { sourceId: 'default' });
    expect(chunks.some((chunk) => chunk.chunk_text.includes(unique))).toBe(true);
  });

  test('authless local stdio has a stable principal and replays exactly once', async () => {
    await engine.setConfig('writer.append_page_event', 'true');
    const ctx = { ...localCtx(), remote: true, transport: 'stdio' as const };
    const params = {
      slug: 'people/example-person',
      idempotency_key: 'minutes:stdio-probe:people/example-person',
      date: '2026-09-02',
      channel: 'meeting',
      note: 'Local stdio probe',
    };
    const first = await appendEvent.handler(ctx, params) as { receipt: Record<string, unknown> };
    const replay = await appendEvent.handler(ctx, params) as { status: string; receipt: Record<string, unknown> };
    expect(first.receipt.principal_id).toBe('stdio-local');
    expect(replay.status).toBe('replayed');
    expect(replay.receipt).toEqual(first.receipt);
  });

  test('invalid slug, source, key, date, channel, and note fail before mutation', async () => {
    await engine.setConfig('writer.append_page_event', 'true');
    const valid = {
      slug: 'people/example-person',
      idempotency_key: 'gmail:invalid-table:people/example-person',
      date: '2026-09-02',
      channel: 'email',
      note: 'Valid note',
    };
    const invalid = [
      { ...valid, slug: '../escape' },
      { ...valid, source_id: '../other' },
      { ...valid, idempotency_key: '   ' },
      { ...valid, date: '2026-02-30' },
      { ...valid, channel: 'email\nforged' },
      { ...valid, note: 'line one\nline two' },
    ];
    const file = join(brainDir, 'people/example-person.md');
    const before = readFileSync(file, 'utf8');
    for (const params of invalid) await expect(appendEvent.handler(oauthCtx(), params)).rejects.toBeDefined();
    expect(readFileSync(file, 'utf8')).toBe(before);
    const journalRoot = join(root, 'gbrain-home', 'canonical-mutation-journal');
    expect(existsSync(journalRoot) ? readdirSync(journalRoot) : []).toEqual([]);
  });

  test('replay after a later event returns the original receipt without duplication', async () => {
    await engine.setConfig('writer.append_page_event', 'true');
    const firstParams = {
      slug: 'people/example-person',
      idempotency_key: 'gmail:m1:people/example-person',
      date: '2026-09-01',
      channel: 'email',
      note: 'First event',
    };
    const first = await appendEvent.handler(oauthCtx(), firstParams) as { receipt: Record<string, unknown> };
    await appendEvent.handler(oauthCtx(), {
      slug: 'people/example-person',
      idempotency_key: 'gmail:m2:people/example-person',
      date: '2026-09-02',
      channel: 'email',
      note: 'Later event',
    });
    const replay = await appendEvent.handler(oauthCtx(), firstParams) as { status: string; receipt: Record<string, unknown> };
    expect(replay.status).toBe('replayed');
    expect(replay.receipt).toEqual(first.receipt);
    const canonical = readFileSync(join(brainDir, 'people/example-person.md'), 'utf8');
    expect(canonical.match(/First event/g)?.length).toBe(1);
    expect(canonical.indexOf('Later event')).toBeLessThan(canonical.indexOf('First event'));
  });

  test('same key with changed semantics conflicts without mutation', async () => {
    await engine.setConfig('writer.append_page_event', 'true');
    const params = {
      slug: 'people/example-person',
      idempotency_key: 'gmail:m1:people/example-person',
      date: '2026-09-02',
      channel: 'email',
      note: 'Original event',
    };
    await appendEvent.handler(oauthCtx(), params);
    const file = join(brainDir, 'people/example-person.md');
    const before = readFileSync(file, 'utf8');
    await expect(appendEvent.handler(oauthCtx(), { ...params, note: 'Changed event' }))
      .rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  test('historical backfill is date-ordered and does not regress contact metadata', async () => {
    await engine.setConfig('writer.append_page_event', 'true');
    await appendEvent.handler(localCtx(), {
      slug: 'people/example-person',
      idempotency_key: 'granola:old-meeting:people/example-person',
      date: '2026-08-01',
      channel: 'meeting',
      note: 'Historical meeting',
    });
    const canonical = readFileSync(join(brainDir, 'people/example-person.md'), 'utf8');
    expect(canonical.indexOf('Existing interaction')).toBeLessThan(canonical.indexOf('Historical meeting'));
    expect(canonical).toContain('2026-08-30');
    expect(canonical).toContain('last_interaction_channel: slack');
    expect(canonical).toContain('Existing interaction\n<!-- cosmic:event:v1');
  });

  test('authless HTTP and missing pages fail before canonical or receipt creation', async () => {
    await engine.setConfig('writer.append_page_event', 'true');
    const authless = { ...localCtx(), remote: true, transport: 'http' as const };
    await expect(appendEvent.handler(authless, {
      slug: 'people/example-person',
      idempotency_key: 'gmail:m1:people/example-person',
      date: '2026-09-02',
      channel: 'email',
      note: 'Must fail',
    })).rejects.toMatchObject({ code: 'unknown_transport' });
    await expect(appendEvent.handler(localCtx(), {
      slug: 'people/missing',
      idempotency_key: 'gmail:m2:people/missing',
      date: '2026-09-02',
      channel: 'email',
      note: 'Must fail',
    })).rejects.toMatchObject({ code: 'page_not_found' });
    expect(existsSync(join(brainDir, 'people/missing.md'))).toBe(false);
    expect(existsSync(join(root, 'gbrain-home', 'canonical-mutation-journal'))).toBe(false);
  });

  test('source, slug, and subagent identity fences fail before mutation', async () => {
    await engine.setConfig('writer.append_page_event', 'true');
    const otherBrain = join(root, 'other-brain');
    mkdirSync(otherBrain, { recursive: true });
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2) ON CONFLICT (id) DO NOTHING`,
      ['other', otherBrain],
    );
    await putPage.handler({ ...localCtx(), sourceId: 'other' }, {
      slug: 'people/example-person',
      content: person('Other Source Person'),
    });
    const params = {
      slug: 'people/example-person',
      idempotency_key: 'gmail:m3:people/example-person',
      date: '2026-09-02',
      channel: 'email',
      note: 'Must remain fenced',
    };
    await expect(appendEvent.handler(oauthCtx(), { ...params, source_id: 'other' }))
      .rejects.toMatchObject({ code: 'permission_denied' });
    await expect(appendEvent.handler({
      ...oauthCtx(),
      auth: { ...oauthCtx().auth!, allowedSources: ['default', 'other'] },
    }, { ...params, source_id: 'other' })).rejects.toMatchObject({ code: 'permission_denied' });
    expect(readFileSync(join(otherBrain, 'people/example-person.md'), 'utf8')).not.toContain('Must remain fenced');
    await expect(appendEvent.handler({
      ...oauthCtx(),
      auth: { ...oauthCtx().auth!, boundSlugPrefixes: ['meetings/'] },
    }, params)).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(appendEvent.handler({
      ...localCtx(),
      remote: true,
      transport: 'stdio',
      viaSubagent: true,
      allowedSlugPrefixes: ['people/*'],
    }, params)).rejects.toMatchObject({ code: 'permission_denied' });
    const canonical = readFileSync(join(brainDir, 'people/example-person.md'), 'utf8');
    expect(canonical).not.toContain('Must remain fenced');
    expect(existsSync(join(root, 'gbrain-home', 'canonical-mutation-journal'))).toBe(false);
  });
});
