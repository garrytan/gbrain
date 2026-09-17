import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import { prepareBookMirrorPublication } from '../src/commands/book-mirror.ts';
import { retainToolWriteRequestId } from '../src/core/minions/tool-write-identity.ts';
import { verifyWorkspace } from '../src/core/bootstrap/verify.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); }, 60_000);

test('book publication preserves a page changed while chapter providers run', async () => {
  const slug = 'media/books/concurrent-example-personalized';
  await engine.putPage(slug, { type: 'note', title: 'Initial', compiled_truth: 'original body' });
  const publish = await prepareBookMirrorPublication(engine, slug);
  await engine.putPage(slug, { type: 'note', title: 'Concurrent', compiled_truth: 'concurrent body' });
  await expect(publish('# Stale analysis\n\nprovider output')).rejects.toMatchObject({
    code: 'revision_conflict', writeRequest: { state: 'conflict' },
  });
  expect((await engine.getPage(slug))?.compiled_truth).toBe('concurrent body');
});

test('book publication keeps one receipt when acknowledgement is retried', async () => {
  const slug = 'media/books/replay-example-personalized';
  const publish = await prepareBookMirrorPublication(engine, slug);
  const first = await publish('# Complete analysis\n\nchapter output');
  const replay = await publish('# Complete analysis\n\nchapter output');
  expect(replay.request_id).toBe(first.request_id);
  expect(replay.revision).toBe(first.revision);
  expect((await engine.executeRaw('SELECT id FROM persistence_requests WHERE slug=$1', [slug])).length).toBe(1);
});

test('replayed persisted tool execution returns its original canonical receipt', async () => {
  const input = { slug: 'wiki/tool-replay-example', content: '# Replay fixture\n\ncanonical body' };
  const replayInput = { ...input };
  retainToolWriteRequestId(input, 42, 3, 0, 'provider-reused-id', 'brain_put_page');
  const context = { engine, config: { engine: 'pglite' as const }, logger: console, dryRun: false, remote: false, sourceId: 'default' };
  const first = await operationsByName['put_page']!.handler(context, input) as Record<string, unknown>;
  // This reconstruction models a lost dispatch result followed by a fresh
  // process loading the persisted assistant/tool execution coordinates.
  retainToolWriteRequestId(replayInput, 42, 3, 0, 'provider-reused-id', 'brain_put_page');
  const replay = await operationsByName['put_page']!.handler(context, replayInput) as Record<string, unknown>;
  expect(first.state).toBe('committed'); expect(replay.state).toBe('committed');
  expect(replay.request_id).toBe(first.request_id); expect(replay.revision).toBe(first.revision);
  expect((await engine.executeRaw('SELECT id FROM persistence_requests WHERE slug=$1', [input.slug])).length).toBe(1);
  const later: Record<string, unknown> = { slug: input.slug, content: input.content };
  retainToolWriteRequestId(later, 42, 5, 0, 'provider-reused-id', 'brain_put_page');
  expect(later.request_id).not.toBe(first.request_id);
});

test('unsupported bootstrap maintenance stops before providers or filesystem probes', async () => {
  let queries = 0;
  const guarded = { executeRaw: async () => { queries++; return [{ enabled: true }]; } } as unknown as BrainEngine;
  await expect(verifyWorkspace(guarded, '/nonexistent-synthetic-fixture')).rejects.toMatchObject({ code: 'writer_coordinator_required' });
  expect(queries).toBe(1);
});
