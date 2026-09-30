import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { prepareConnectorMutation, withConnectorSync } from '../src/core/persistence/connector-sync.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { persistenceFileHash, publishMutation } from '../src/core/persistence/coordinator.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { parseGoogleSourceConfig, runGoogleAttachmentBackfill } from '../src/core/google/google-source.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { submitForgetMutation } from '../src/core/persistence/memory-mutations.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { sanitizeRemoteBody } from '../src/core/remote-body.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { operationsByName } from '../src/core/operations.ts';
import { syncLockId } from '../src/core/db-lock.ts';
import { createConnectorFixture, options, json, sourceCheckpoint } from './helpers/connector-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

const { engines, env, source, boundSource, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);
const config = { kind: 'google', g_account: 'reader@example.com', g_services: 'gmail', g_access: 'env', g_token_env: 'CONNECTOR_TEST_TOKEN' };
const claim = 'syntheticwithdrawalsentinel prefers amber fixtures';
const ctx = (engine: BrainEngine, sourceId: string) => ({ engine, sourceId, config: { engine: engine.kind }, remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } });
const slug = (n: number) => `emails/2026/09/thread-${n}`;
const msg = (n: number) => `message${String(n).padStart(10, '0')}`;
const content = (n: number) => `---\ntype: email\ntitle: Synthetic historical thread\nthread_id: thread${n}\naccount: reader@example.com\nmessage_ids: [${msg(n)}]\nvisibility: private\ncustom: preserved\n---\n# Edited synthetic message\n\nKeep this exact user-edited prose.\n${renderFactsTable([{ rowNum: 1, claim, kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium', active: true }])}\n`;
const fetcher = async (url: string) => {
  if (url.includes('/profile')) return json({ emailAddress: config.g_account, historyId: '100' });
  const n = Number(url.match(/threads\/thread(\d+)/)?.[1]);
  if (!n) throw new Error('Unexpected metadata-only fixture endpoint');
  return json({ id: `thread${n}`, messages: [{ id: msg(n), payload: { mimeType: 'multipart/mixed', parts: [
    { mimeType: 'text/plain', body: { data: Buffer.from('STALE PROVIDER BODY MUST NEVER BE REPLAYED').toString('base64') } },
    { partId: '1', filename: 'fixture.pdf', mimeType: 'application/pdf', body: { attachmentId: 'opaque', size: 17 } },
  ] } }] });
};

async function seed(engine: BrainEngine, bound = false, count = 1) {
  const f = await (bound ? boundSource : source)(engine, config);
  const cfg = parseGoogleSourceConfig(config, f.dir);
  await withConnectorSync(engine, f.id, 'google', cfg, options, async managed => {
    for (let n = 1; n <= count; n++) await managed!.importMarkdown(`${slug(n)}.md`, content(n));
  });
  return { ...f, cfg };
}

test('historical repair preserves current body, facts, frontmatter and private receipt visibility across bounded resume', async () => withEnv(env, async () => {
  for (const engine of engines) for (const bound of [false, true]) {
    const f = await seed(engine, bound, 2);
    const before = (await engine.readPageSnapshot(slug(1), { sourceId: f.id }))!;
    const facts = await engine.executeRaw('SELECT * FROM facts WHERE source_id=$1 ORDER BY id', [f.id]);
    const first = await runGoogleAttachmentBackfill(engine, f.id, f.cfg, { limit: 1 }, fetcher);
    expect(first).toMatchObject({ status: 'paused', processed: 1, inspected: 1, complete: false });
    const after = (await engine.readPageSnapshot(slug(1), { sourceId: f.id }))!;
    expect(after.page.compiled_truth).toBe(before.page.compiled_truth);
    expect(after.page.timeline).toBe(before.page.timeline);
    const { gmail_attachment_receipts: receipts, ...rest } = after.page.frontmatter;
    expect(rest).toEqual(before.page.frontmatter);
    expect(receipts).toMatchObject({ version: 1, account: config.g_account, messages: [{ messageId: msg(1), inspection: { state: 'present' } }] });
    expect(after.tags).toEqual(before.tags);
    expect(await engine.executeRaw('SELECT * FROM facts WHERE source_id=$1 ORDER BY id', [f.id])).toEqual(facts);
    expect(await engine.getPage(slug(1), { sourceId: f.id, excludePrivate: true })).toBeNull();
    await expect(operationsByName.get_page.handler({ ...ctx(engine, f.id), remote: true }, { slug: slug(1) })).rejects.toMatchObject({ code: 'page_not_found' });
    expect(await operationsByName.get_page.handler(ctx(engine, f.id), { slug: slug(1) })).toMatchObject({ frontmatter: { gmail_attachment_receipts: receipts } });
    if (bound) {
      const file = readFileSync(join(f.dir, `${slug(1)}.md`), 'utf8');
      expect(file).toContain('fixture.pdf');
      expect(file).toContain('Keep this exact user-edited prose.');
      expect(file).not.toContain('STALE PROVIDER BODY');
    }
    await disposePersistenceConsumer(engine);
    expect(await runGoogleAttachmentBackfill(engine, f.id, f.cfg, { limit: 1 }, fetcher)).toMatchObject({ status: 'complete', processed: 1, inspected: 2 });
    const revision = (await engine.readPageSnapshot(slug(1), { sourceId: f.id }))!.revision;
    expect(await runGoogleAttachmentBackfill(engine, f.id, f.cfg, {}, fetcher)).toMatchObject({ status: 'complete', processed: 0 });
    expect((await engine.readPageSnapshot(slug(1), { sourceId: f.id }))!.revision).toBe(revision);
    expect(await engine.executeRaw("SELECT e.id FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE r.source_id=$1 AND r.intent->>'kind'='connector_v2_google_receipts' AND e.kind<>'git'", [f.id])).toHaveLength(0);
  }
}), 120_000);

test('repair uses current edits and withdrawals rather than the fetched historical body, in both completion orders', async () => withEnv(env, async () => {
  for (const engine of engines) for (const order of ['before', 'after'] as const) {
    const f = await seed(engine, true);
    const [fact] = await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id=$1 ORDER BY id LIMIT 1', [f.id]);
    const modify = async () => {
      const current = (await engine.readPageSnapshot(slug(1), { sourceId: f.id }))!;
      await submitPageMutation(ctx(engine, f.id), { operation: 'put_page', params: { slug: slug(1), expected_revision: current.revision,
        content: serializePageToMarkdown({ ...current.page, compiled_truth: current.page.compiled_truth + '\nAdditional local edit.\n' }, current.tags) } });
      await submitForgetMutation(ctx(engine, f.id), 'forget_fact', { id: Number(fact.id) });
      await disposePersistenceConsumer(engine);
      await runPersistenceEffects(engine, { engine: engine.kind }, { hostId: localHostId(), limit: 100 });
    };
    if (order === 'before') await modify();
    const before = (await engine.readPageSnapshot(slug(1), { sourceId: f.id }))!;
    const ledger = await engine.executeRaw('SELECT * FROM fact_withdrawals WHERE source_id=$1', [f.id]);
    expect((await runGoogleAttachmentBackfill(engine, f.id, f.cfg, {}, fetcher)).status).toBe('complete');
    expect((await engine.readPageSnapshot(slug(1), { sourceId: f.id }))!.page.compiled_truth).toBe(before.page.compiled_truth);
    expect(await engine.executeRaw('SELECT * FROM fact_withdrawals WHERE source_id=$1', [f.id])).toEqual(ledger);
    if (order === 'after') await modify();
    const final = (await engine.readPageSnapshot(slug(1), { sourceId: f.id }))!;
    expect(sanitizeRemoteBody(final.page.compiled_truth)).not.toContain(claim);
    expect(final.page.compiled_truth).toContain('Additional local edit.');
    expect((await runGoogleAttachmentBackfill(engine, f.id, f.cfg, {}, fetcher)).processed).toBe(0);
    expect(sanitizeRemoteBody((await engine.readPageSnapshot(slug(1), { sourceId: f.id }))!.page.compiled_truth)).not.toContain(claim);
  }
}), 120_000);

test('failure, cancellation, unknown ownership and lease loss never skip an uncommitted historical page', async () => withEnv(env, async () => {
  for (const engine of engines) for (const failure of ['fetch', 'cancel', 'ownership', 'lease'] as const) {
    const f = await seed(engine, true);
    const before = (await engine.readPageSnapshot(slug(1), { sourceId: f.id }))!;
    const abort = new AbortController();
    if (failure === 'ownership') await submitPageMutation(ctx(engine, f.id), { operation: 'put_page', params: { slug: slug(1), expected_revision: before.revision,
      content: serializePageToMarkdown({ ...before.page, frontmatter: { ...before.page.frontmatter, gmail_attachment_receipts: 'user-owned text' } }, before.tags) } });
    const run = () => runGoogleAttachmentBackfill(engine, f.id, f.cfg, { signal: abort.signal }, async url => {
      if (url.includes('/threads/')) {
        if (failure === 'fetch') throw new Error('synthetic interruption');
        if (failure === 'cancel') abort.abort();
        if (failure === 'lease') await engine.executeRaw('DELETE FROM gbrain_cycle_locks WHERE id=$1', [syncLockId(f.id)]);
      }
      return fetcher(url);
    });
    await expect(run()).rejects.toBeDefined();
    const checkpoint = JSON.stringify(await sourceCheckpoint(engine, f.id));
    expect(checkpoint).toContain('"afterPageId":0');
    expect((await engine.readPageSnapshot(slug(1), { sourceId: f.id }))!.page.compiled_truth).toBe(before.page.compiled_truth);
    if (failure !== 'ownership') expect((await runGoogleAttachmentBackfill(engine, f.id, f.cfg, {}, fetcher)).status).toBe('complete');
  }
}), 120_000);

test('an edit during Gmail fetch is preserved, while delete/recreate cannot retarget historical metadata', async () => withEnv(env, async () => {
  for (const engine of engines) for (const change of ['edit', 'delete-recreate'] as const) {
    const f = await seed(engine, true);
    const before = (await engine.readPageSnapshot(slug(1), { sourceId: f.id }))!;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const repair = runGoogleAttachmentBackfill(engine, f.id, f.cfg, {}, async url => {
      if (url.includes('/threads/')) { entered.resolve(); await release.promise; }
      return fetcher(url);
    });
    repair.catch(() => {});
    await entered.promise;
    try {
      if (change === 'delete-recreate') {
        await submitPageMutation(ctx(engine, f.id), { operation: 'delete_page', params: { slug: slug(1), purge: true, expected_revision: before.revision } });
        await submitPageMutation(ctx(engine, f.id), { operation: 'put_page', params: { slug: slug(1), content: content(1) } });
      } else {
        await submitPageMutation(ctx(engine, f.id), { operation: 'put_page', params: { slug: slug(1), expected_revision: before.revision,
          content: serializePageToMarkdown({ ...before.page, compiled_truth: before.page.compiled_truth + '\nConcurrent editor text.\n' }, before.tags) } });
      }
    } finally { release.resolve(); }
    if (change === 'edit') {
      expect((await repair).status).toBe('complete');
      const current = (await engine.readPageSnapshot(slug(1), { sourceId: f.id }))!;
      expect(current.page.compiled_truth).toContain('Concurrent editor text.');
      await expect(submitPageMutation(ctx(engine, f.id), { operation: 'put_page', params: { slug: slug(1), expected_revision: before.revision, content: content(1) } })).rejects.toMatchObject({ code: 'revision_conflict' });
      expect((await engine.readPageSnapshot(slug(1), { sourceId: f.id }))!.page.frontmatter.gmail_attachment_receipts).toEqual(current.page.frontmatter.gmail_attachment_receipts);
    } else {
      await expect(repair).rejects.toMatchObject({ code: 'page_identity_changed' });
      expect((await engine.readPageSnapshot(slug(1), { sourceId: f.id }))!.page.frontmatter.gmail_attachment_receipts).toBeUndefined();
      expect(JSON.stringify(await sourceCheckpoint(engine, f.id))).toContain('"afterPageId":0');
    }
  }
}), 120_000);

test('withdrawal wins after receipt preparation but before real canonical publication', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await seed(engine, true);
    await runGoogleAttachmentBackfill(engine, f.id, f.cfg, {}, fetcher);
    await disposePersistenceConsumer(engine);
    const [template] = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_google_receipts' LIMIT 1", [f.id]);
    const snapshot = (await engine.readPageSnapshot(slug(1), { sourceId: f.id }))!;
    const [checkpoint] = await engine.executeRaw<{ completed_keys: unknown[] }>("SELECT completed_keys FROM op_checkpoints WHERE op='managed-connector' AND fingerprint=$1", [template.intent!.checkpointKey]);
    const intent = structuredClone(template.intent!);
    intent.expected_revision = snapshot.revision;
    intent.checkpointBefore = checkpoint.completed_keys;
    intent.fileBeforeHash = persistenceFileHash(join(f.dir, `${slug(1)}.md`));
    (intent.googleReceipts as any).messages[0].inspection.attachments[0].filename = 'updated-fixture.pdf';
    const admitted = await admitWrite(engine, { principal: { kind: template.principal_kind, id: template.principal_id }, requestId: randomUUID(),
      operation: 'submit_job', sourceId: f.id, sourceIncarnation: snapshot.sourceIncarnation, slug: slug(1), pageId: snapshot.page.id,
      callerIntent: intent, intent, authority: template.authority, worktreeId: template.worktree_id!, topologyGeneration: template.topology_generation! });
    const claimed = (await claimNextWrite(engine, localHostId()))!;
    expect(claimed.id).toBe(admitted.id);
    const prepared = await prepareConnectorMutation(engine, claimed);
    const [fact] = await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id=$1 ORDER BY id LIMIT 1', [f.id]);
    await submitForgetMutation(ctx(engine, f.id), 'forget_fact', { id: Number(fact.id) });
    const result = await publishMutation(engine, claimed, prepared);
    expect(result.state).toBe('conflict');
    const current = (await engine.readPageSnapshot(slug(1), { sourceId: f.id }))!;
    expect(sanitizeRemoteBody(current.page.compiled_truth)).not.toContain(claim);
    expect(JSON.stringify(current.page.frontmatter.gmail_attachment_receipts)).not.toContain('updated-fixture.pdf');
    expect(await engine.executeRaw('SELECT fact_hash FROM fact_withdrawals WHERE source_id=$1', [f.id])).toHaveLength(1);
  }
}), 120_000);

test('incomplete inspection is durable but cannot advance progress, and a foreign account cannot start repair', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await seed(engine);
    const before = (await engine.readPageSnapshot(slug(1), { sourceId: f.id }))!;
    await expect(runGoogleAttachmentBackfill(engine, f.id, f.cfg, {}, async () => json({ emailAddress: 'other@example.com', historyId: '100' }))).rejects.toMatchObject({ code: 'source_changed' });
    expect(await sourceCheckpoint(engine, f.id)).toHaveLength(0);
    const incomplete = await runGoogleAttachmentBackfill(engine, f.id, f.cfg, {}, async url => url.includes('/profile') ? fetcher(url)
      : json({ id: 'thread1', messages: [{ id: msg(1) }] }));
    expect(incomplete).toMatchObject({ status: 'incomplete', complete: false, processed: 0, inspected: 0 });
    const after = (await engine.readPageSnapshot(slug(1), { sourceId: f.id }))!;
    expect(after.page.compiled_truth).toBe(before.page.compiled_truth);
    expect(after.page.frontmatter.gmail_attachment_receipts).toMatchObject({ messages: [{ inspection: { state: 'incomplete', reason: 'missing_payload' } }] });
    expect(JSON.stringify(await sourceCheckpoint(engine, f.id))).toContain('"afterPageId":0');
    expect((await runGoogleAttachmentBackfill(engine, f.id, f.cfg, {}, fetcher)).status).toBe('complete');
  }
}), 120_000);

test('malformed MIME leaves the historical cursor resumable instead of declaring completion', async () => withEnv(env, async () => {
  for (const engine of engines) for (const payload of [{ mimeType: 'multipart/mixed' }, { mimeType: 'multipart/mixed', parts: [] }, { body: {} }, { mimeType: '', body: {} }]) {
    const f = await seed(engine);
    const result = await runGoogleAttachmentBackfill(engine, f.id, f.cfg, {}, async url => url.includes('/profile') ? fetcher(url)
      : json({ id: 'thread1', messages: [{ id: msg(1), payload }] }));
    expect(result).toMatchObject({ status: 'incomplete', complete: false, processed: 0, inspected: 0 });
    expect(JSON.stringify(await sourceCheckpoint(engine, f.id))).toContain('"afterPageId":0');
    const current = (await engine.readPageSnapshot(slug(1), { sourceId: f.id }))!;
    expect(current.page.frontmatter.gmail_attachment_receipts).toMatchObject({ messages: [{ inspection: { state: 'incomplete', reason: 'malformed_part', attachments: [] } }] });
    expect((await runGoogleAttachmentBackfill(engine, f.id, f.cfg, {}, fetcher)).status).toBe('complete');
  }
}), 120_000);

test('confirmed upstream thread absence preserves history and prior receipts while later pages repair', async () => withEnv(env, async () => {
  for (const engine of engines) for (const bound of [false, true]) {
    const f = await seed(engine, bound, 2);
    const original = (await engine.readPageSnapshot(slug(1), { sourceId: f.id }))!;
    const prior = { version: 1, account: config.g_account, threadId: 'thread1', messages: [{ messageId: msg(1), inspection: {
      state: 'present', attachments: [{ id: 'retained-id', account: config.g_account, messageId: msg(1), partId: 'old', filename: 'retained.pdf',
        mimeType: 'application/pdf', size: 9, attachmentId: 'retained-opaque', kind: 'document', fetched: false, indexed: false }],
    } }] };
    await withConnectorSync(engine, f.id, 'google', f.cfg, options, async managed => {
      await managed!.importMarkdown(`${slug(1)}.md`, serializePageToMarkdown({ ...original.page,
        frontmatter: { ...original.page.frontmatter, gmail_attachment_receipts: prior } }, original.tags));
    });
    const before = (await engine.readPageSnapshot(slug(1), { sourceId: f.id }))!;
    const result = await runGoogleAttachmentBackfill(engine, f.id, f.cfg, {}, async url => url.includes('/threads/thread1?') ? json({}, 404) : fetcher(url));
    expect(result).toMatchObject({ status: 'complete', processed: 2, inspected: 1, unavailable: 1, unavailableMessages: 1, inspection_complete: false });
    const after = (await engine.readPageSnapshot(slug(1), { sourceId: f.id }))!;
    expect(after.page.compiled_truth).toBe(before.page.compiled_truth);
    expect(after.page.frontmatter).toEqual({ ...before.page.frontmatter, gmail_attachment_receipts: { ...prior, unavailable: 'thread_not_found',
      messages: [{ ...prior.messages[0], unavailable: 'thread_not_found' }] } });
    expect(await engine.getPage(slug(1), { sourceId: f.id, excludePrivate: true })).toBeNull();
    expect((await engine.readPageSnapshot(slug(2), { sourceId: f.id }))!.page.frontmatter.gmail_attachment_receipts).toMatchObject({ messages: [{ inspection: { state: 'present' } }] });
    await disposePersistenceConsumer(engine);
    expect(await runGoogleAttachmentBackfill(engine, f.id, f.cfg, {}, fetcher)).toMatchObject({ processed: 0, inspected: 1, unavailable: 1, unavailableMessages: 1 });
  }
}), 120_000);

test('disappeared historical message identities retain known receipts or explicit not-inspected diagnostics', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await seed(engine, true, 2);
    const original = (await engine.readPageSnapshot(slug(1), { sourceId: f.id }))!;
    const prior = { version: 1, account: config.g_account, threadId: 'thread1', messages: [{ messageId: msg(3), inspection: { state: 'none', attachments: [] } }] };
    await submitPageMutation(ctx(engine, f.id), { operation: 'put_page', params: { slug: slug(1), expected_revision: original.revision,
      content: serializePageToMarkdown({ ...original.page, frontmatter: { ...original.page.frontmatter, message_ids: [msg(1), msg(3), msg(4)], gmail_attachment_receipts: prior } }, original.tags) } });
    const before = (await engine.readPageSnapshot(slug(1), { sourceId: f.id }))!;
    expect(await runGoogleAttachmentBackfill(engine, f.id, f.cfg, {}, fetcher)).toMatchObject({ status: 'complete', processed: 2, inspected: 1, unavailable: 1, unavailableMessages: 2, inspection_complete: false });
    const after = (await engine.readPageSnapshot(slug(1), { sourceId: f.id }))!;
    expect(after.page.compiled_truth).toBe(before.page.compiled_truth);
    const { gmail_attachment_receipts: receipts, ...rest } = after.page.frontmatter;
    expect(rest).toEqual(Object.fromEntries(Object.entries(before.page.frontmatter).filter(([key]) => key !== 'gmail_attachment_receipts')));
    expect(receipts).toMatchObject({ messages: [
      { messageId: msg(1), inspection: { state: 'present' } },
      { ...prior.messages[0], unavailable: 'message_not_found' },
      { messageId: msg(4), inspection: { state: 'not_inspected', attachments: [] }, unavailable: 'message_not_found' },
    ] });
  }
}), 120_000);

test('authorization errors and malformed thread identities never become upstream absence', async () => withEnv(env, async () => {
  for (const engine of engines) for (const failure of ['forbidden', 'rate-limit', 'gone', 'missing-id', 'duplicate-id', 'empty', 'ownership', 'incomplete-other-message']) {
    const f = await seed(engine, true, 2);
    const before = (await engine.readPageSnapshot(slug(1), { sourceId: f.id }))!;
    if (failure === 'ownership') await submitPageMutation(ctx(engine, f.id), { operation: 'put_page', params: { slug: slug(1), expected_revision: before.revision,
      content: serializePageToMarkdown({ ...before.page, frontmatter: { ...before.page.frontmatter, gmail_attachment_receipts: 'not-owned' } }, before.tags) } });
    await expect(runGoogleAttachmentBackfill(engine, f.id, f.cfg, {}, async url => {
      if (!url.includes('/threads/thread1?')) return fetcher(url);
      if (failure === 'forbidden') return json({}, 403);
      if (failure === 'rate-limit') return json({}, 429, { 'retry-after': '0' });
      if (failure === 'gone') return json({}, 410);
      if (failure === 'ownership') return json({}, 404);
      if (failure === 'incomplete-other-message') return json({ id: 'thread1', messages: [{ id: msg(2) }] });
      return json({ id: 'thread1', messages: failure === 'empty' ? [] : failure === 'missing-id' ? [{ payload: { mimeType: 'text/plain' } }]
        : [{ id: msg(1) }, { id: msg(1) }] });
    })).rejects.toBeDefined();
    expect(JSON.stringify(await sourceCheckpoint(engine, f.id))).toContain('"afterPageId":0');
    expect((await engine.readPageSnapshot(slug(2), { sourceId: f.id }))!.page.frontmatter.gmail_attachment_receipts).toBeUndefined();
    expect((await engine.readPageSnapshot(slug(1), { sourceId: f.id }))!.page.compiled_truth).toBe(before.page.compiled_truth);
  }
}), 120_000);

test('malformed historical message identities do not become confirmed unavailable receipts', async () => withEnv(env, async () => {
  for (const engine of engines) for (const messageId of [' ', 'bad/id', 'a'.repeat(129)]) {
    const f = await seed(engine, true);
    const before = (await engine.readPageSnapshot(slug(1), { sourceId: f.id }))!;
    await submitPageMutation(ctx(engine, f.id), { operation: 'put_page', params: { slug: slug(1), expected_revision: before.revision,
      content: serializePageToMarkdown({ ...before.page, frontmatter: { ...before.page.frontmatter, message_ids: [messageId] } }, before.tags) } });
    const edited = (await engine.readPageSnapshot(slug(1), { sourceId: f.id }))!;
    await expect(runGoogleAttachmentBackfill(engine, f.id, f.cfg, {}, async url => url.includes('/threads/') ? json({}, 404) : fetcher(url)))
      .rejects.toMatchObject({ code: 'revision_conflict' });
    expect(JSON.stringify(await sourceCheckpoint(engine, f.id))).toContain('"afterPageId":0');
    expect(await engine.readPageSnapshot(slug(1), { sourceId: f.id })).toEqual(edited);
  }
}), 120_000);

test('historical metadata response overflow cannot advance a managed cursor or change historical content', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await seed(engine, false, 2);
    const before = (await engine.readPageSnapshot(slug(1), { sourceId: f.id }))!;
    await expect(runGoogleAttachmentBackfill(engine, f.id, f.cfg, {}, async url => {
      if (url.includes('/profile')) return fetcher(url);
      const request = new URL(url);
      expect(request.pathname).toBe('/gmail/v1/users/me/threads/thread1');
      const fields = request.searchParams.get('fields');
      expect(fields).toContain('body(attachmentId,size)');
      expect(fields).not.toMatch(/\b(data|raw|snippet)\b|\*/);
      return json({ id: 'thread1', messages: [{ id: msg(1), payload: { mimeType: 'application/pdf', filename: 'x'.repeat(2 * 1024 * 1024) } }] });
    })).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
    expect(JSON.stringify(await sourceCheckpoint(engine, f.id))).toContain('"afterPageId":0');
    const after = (await engine.readPageSnapshot(slug(1), { sourceId: f.id }))!;
    expect(after.page.compiled_truth).toBe(before.page.compiled_truth);
    expect(after.page.frontmatter).toEqual(before.page.frontmatter);
    expect((await engine.readPageSnapshot(slug(2), { sourceId: f.id }))!.page.frontmatter.gmail_attachment_receipts).toBeUndefined();
    expect(await runGoogleAttachmentBackfill(engine, f.id, f.cfg, {}, fetcher)).toMatchObject({ status: 'complete', inspected: 2 });
  }
}), 120_000);
