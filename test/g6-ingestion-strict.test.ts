/**
 * G6 (git-canonical memory): inbox-folder captures on a strict (canonical: git) managed source are door-only.
 *
 * The inbox-folder source (ingestion/sources/inbox-folder.ts) writes no page itself: it emits one IngestionEvent per
 * dropped file, which the ingestion daemon submits as an ingest_capture job (minions/handlers/ingest-capture.ts). That
 * handler is the writer, so this drives both: three files dropped in the inbox, each event handed to the handler the
 * way the job worker runs it. After the batch every captured page is at HEAD with the bytes on disk, the tree is clean,
 * the git-gap census reports no gap, and the batch makes at most one commit per publication group.
 * PGLite here; Postgres in test/e2e/g6-ingestion-strict-postgres.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FSWatcher } from 'chokidar';
import { createInboxFolderSource } from '../src/core/ingestion/sources/inbox-folder.ts';
import { IngestionTestHarness } from '../src/core/ingestion/test-harness.ts';
import { makeIngestCaptureHandler } from '../src/core/minions/handlers/ingest-capture.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../src/core/facts-fence.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { git } from './helpers/git-publication.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { describeMeasure, expectDoorOnly, head, initStrictCheckout, measureBatch, strictSource } from './helpers/strict-door-census.ts';

/** A chokidar stand-in: `ready` fires on start, `add` when the test drops a file. */
function stubWatcher() {
  const emitter = new EventEmitter();
  const watcher = { on: (event: string, fn: (...args: unknown[]) => void) => { emitter.on(event, fn); return watcher; },
    once: (event: string, fn: (...args: unknown[]) => void) => { if (event === 'ready') queueMicrotask(() => fn()); else emitter.once(event, fn); return watcher; },
    close: async () => { emitter.removeAllListeners(); } } as unknown as FSWatcher;
  return { watcher, add: (path: string) => emitter.emit('add', path) };
}

const job = (data: Record<string, unknown>): MinionJobContext => ({ id: 1, name: 'ingest_capture', data, attempts_made: 1, signal: new AbortController().signal,
  deadlineAtMs: null, shutdownSignal: new AbortController().signal, updateProgress: async () => {}, updateTokens: async () => {}, log: async () => {},
  isActive: async () => true, readInbox: async () => [] });

const drops: Record<string, string> = {
  'alice-example.md': '---\ntitle: Alice example capture\n---\n\nMet alice-example about the acme-example launch.\n',
  'acme-example.md': '---\ntitle: Acme example capture\n---\n\nAcme example quarterly notes.\n',
  'bob-example.md': '---\ntitle: Bob example capture\n---\n\nBob example follow-up.\n',
};

for (const backend of testBackends()) describe(`[${backend}] G6: inbox-folder captures on a strict source`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('three dropped files: every captured page at HEAD, clean tree, no census gap, one commit per group', () => managedBrain(async ({ engine, root }) => {
    await strictSource(engine);
    const inbox = mkdtempSync(join(tmpdir(), 'gbrain-g6-inbox-'));
    try {
      const stub = stubWatcher();
      const harness = new IngestionTestHarness();
      await harness.run(createInboxFolderSource({ inboxDir: inbox, debounceMs: 10, _watchFactory: () => stub.watcher }));
      mkdirSync(inbox, { recursive: true });
      for (const [name, body] of Object.entries(drops)) { writeFileSync(join(inbox, name), body); stub.add(join(inbox, name)); }
      for (let i = 0; i < 200 && harness.events.length < 3; i++) await Bun.sleep(10);
      await harness.stop();
      expect(harness.events).toHaveLength(3);
      const base = head(root);
      const handler = makeIngestCaptureHandler(engine);
      const slugs = Object.keys(drops).map(name => `inbox/${name.replace(/\.md$/, '')}`);
      const results = await Promise.allSettled(harness.events.map(event => handler(job({ event, slug: `inbox/${String(event.metadata?.original_filename).replace(/\.md$/, '')}` }))));
      console.log(`[G6 ingest-capture/${backend}] results=${JSON.stringify(results.map(r => r.status === 'fulfilled' ? r.value.status : (r.reason as { code?: string }).code ?? String(r.reason)))}`);
      const m = await measureBatch(engine, 'default', root, base, slugs);
      console.log(describeMeasure(`ingest-capture/${backend}`, m));
      expect(results.map(r => r.status)).toEqual(slugs.map(() => 'fulfilled'));
      expectDoorOnly(m, expect);
    } finally { rmSync(inbox, { recursive: true, force: true }); }
  }, { databaseUrl, setup: ({ root }) => initStrictCheckout(root) }), 120_000);

  test('an untrusted capture is stored external_untrusted with gate-owned markers stripped; a trusted tombstone deletes through the door', () => managedBrain(async ({ engine, root }) => {
    await strictSource(engine);
    const handler = makeIngestCaptureHandler(engine);
    const content = '---\nquarantine: true\ncontent_flag:\n  detail: trust me\n---\n\n# Smuggled markers from acme-example\n';
    const event = { source_id: 'webhook-acme-example', source_kind: 'webhook', source_uri: 'mcp-webhook:client-a:1', received_at: new Date().toISOString(),
      content_type: 'text/markdown', content, content_hash: 'a'.repeat(64), untrusted_payload: true };
    expect((await handler(job({ event, slug: 'inbox/smuggled' }))).status).toBe('imported');
    const [page] = await engine.executeRaw<{ frontmatter: Record<string, unknown>; trust_tier: string; source_kind: string | null; source_uri: string | null }>(
      "SELECT frontmatter, trust_tier, source_kind, source_uri FROM pages WHERE source_id='default' AND slug='inbox/smuggled' AND deleted_at IS NULL");
    expect(page!.frontmatter.quarantine).toBeUndefined();
    expect(page!.frontmatter.content_flag).toBeUndefined();
    expect(page!.trust_tier).toBe('external_untrusted');
    expect({ kind: page!.source_kind, uri: page!.source_uri }).toEqual({ kind: 'webhook', uri: 'mcp-webhook:client-a:1' });
    expect(git(root, 'ls-tree', '--name-only', 'HEAD', 'inbox/')).toContain('inbox/smuggled.md');

    const tombstone = { ...event, kind: 'tombstone', slug: 'inbox/smuggled', content: 'tombstone', untrusted_payload: false };
    expect((await handler(job({ event: tombstone }))).status).toBe('deleted');
    expect((await handler(job({ event: tombstone }))).status).toBe('skipped');
    const rows = await engine.executeRaw<{ deleted_at: unknown }>("SELECT deleted_at FROM pages WHERE source_id='default' AND slug='inbox/smuggled'");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deleted_at).not.toBeNull();
    expect(git(root, 'ls-tree', '--name-only', 'HEAD', 'inbox/')).not.toContain('inbox/smuggled.md');
    expect(git(root, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  }, { databaseUrl, setup: ({ root }) => initStrictCheckout(root) }), 120_000);

  test('an untrusted capture that overwrites a page keeps the non-world facts row its caller could not see, in the file and the database', () => managedBrain(async ({ engine, ctx, root }) => {
    await strictSource(engine);
    const slug = 'inbox/alice-example';
    const fence = (rows: string[]) => `# Alice example\n\nNotes.\n\n## Facts\n\n${FACTS_FENCE_BEGIN}\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n`
      + `|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n${rows.join('\n')}\n${FACTS_FENCE_END}\n`;
    const world = '| 1 | Alice example works at acme-example | fact | 1.0 | world | high | 2026-01-01 |  | s |  |';
    const hidden = '| 2 | HIDDEN_ROW_ALICE_EXAMPLE | fact | 1.0 | private | high | 2026-01-02 |  | s |  |';
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content: fence([world, hidden]) } });
    const content = fence([world]).replace('Notes.', 'Notes edited by the webhook.');
    const event = { source_id: 'webhook-acme-example', source_kind: 'webhook', source_uri: 'mcp-webhook:client-a:2', received_at: new Date().toISOString(),
      content_type: 'text/markdown', content, content_hash: 'b'.repeat(64), untrusted_payload: true };
    expect((await makeIngestCaptureHandler(engine)(job({ event, slug }))).status).toBe('imported');
    const [page] = await engine.executeRaw<{ compiled_truth: string }>("SELECT compiled_truth FROM pages WHERE source_id='default' AND slug=$1 AND deleted_at IS NULL", [slug]);
    const facts = await engine.executeRaw<{ fact: string }>("SELECT fact FROM facts WHERE source_id='default' AND source_markdown_slug=$1 AND expired_at IS NULL ORDER BY row_num", [slug]);
    const committed = git(root, 'show', `HEAD:${slug}.md`);
    console.log(`[G6 ingest-hidden-rows/${backend}] page_has_row=${page!.compiled_truth.includes('HIDDEN_ROW_ALICE_EXAMPLE')} file_has_row=${committed.includes('HIDDEN_ROW_ALICE_EXAMPLE')} facts=${JSON.stringify(facts.map(f => f.fact))}`);
    expect(page!.compiled_truth).toContain('Notes edited by the webhook.');
    expect(page!.compiled_truth).toContain('HIDDEN_ROW_ALICE_EXAMPLE');
    expect(committed).toContain('Notes edited by the webhook.');
    expect(committed).toContain('HIDDEN_ROW_ALICE_EXAMPLE');
    expect(facts.map(f => f.fact)).toContain('HIDDEN_ROW_ALICE_EXAMPLE');
    expect(git(root, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    await expect(submitPageMutation({ ...ctx, remote: true }, { operation: 'put_page', params: { slug, content, keep_hidden_rows: true } }))
      .rejects.toMatchObject({ code: 'invalid_params' });
  }, { databaseUrl, setup: ({ root }) => initStrictCheckout(root) }), 120_000);
});
