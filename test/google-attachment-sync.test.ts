import { afterAll, beforeAll, expect, test } from 'bun:test';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { createConnectorFixture, json, options, sourceCheckpoint } from './helpers/connector-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

const { engines, env, source, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);
const config = { kind: 'google', g_account: 'reader@example.com', g_services: 'gmail', g_access: 'env', g_token_env: 'CONNECTOR_TEST_TOKEN' };
const messageTime = Date.now() - 1000;

function gmailFetch(url: string): Promise<Response> {
  if (url.includes('/settings/sendAs')) return Promise.resolve(json({ sendAs: [] }));
  if (url.includes('/profile')) return Promise.resolve(json({ historyId: '100', emailAddress: config.g_account }));
  if (url.includes('/history?')) return Promise.resolve(json({ historyId: '101', history: [] }));
  if (url.includes('/messages?')) {
    const before = Number(new URL(url).searchParams.get('q')?.match(/before:(\d+)/)?.[1]);
    return Promise.resolve(json({ messages: before * 1000 > messageTime + 1000 ? [{ id: '123abcdef4567890', threadId: 'abc123' }] : [] }));
  }
  if (url.includes('/threads/abc123?')) return Promise.resolve(json({ id: 'abc123', messages: [{ id: '123abcdef4567890', internalDate: String(messageTime), payload: {
    mimeType: 'multipart/mixed', headers: [{ name: 'From', value: 'sender@example.com' }, { name: 'Subject', value: 'Synthetic report' }], parts: [
      { mimeType: 'text/plain', body: { data: Buffer.from('Synthetic body.').toString('base64') } },
      { partId: '1', mimeType: 'application/pdf', filename: 'synthetic-report.pdf', body: { attachmentId: 'opaque', size: 84 } },
    ],
  } }] }));
  throw new Error('Unexpected synthetic Gmail route');
}

test('normal managed Gmail sync persists attachment receipts without marking historical inspection complete', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    const result = await runGoogleSync(engine, f.id, cfg, options, gmailFetch);
    expect(result.added).toBe(1);
    const [page] = await engine.executeRaw<{ frontmatter: Record<string, any>; compiled_truth: string }>('SELECT frontmatter,compiled_truth FROM pages WHERE source_id=$1', [f.id]);
    expect(page.frontmatter.gmail_attachment_receipts.messages[0].inspection).toMatchObject({ state: 'present', attachments: [{ filename: 'synthetic-report.pdf', fetched: false, indexed: false }] });
    expect(page.compiled_truth).toContain('not downloaded; not indexed');
    expect(JSON.stringify(await sourceCheckpoint(engine, f.id))).not.toContain('gmail_attachment_backfill');
    await disposePersistenceConsumer(engine);
    expect((await runGoogleSync(engine, f.id, cfg, options, gmailFetch)).added).toBe(0);
    expect(await engine.executeRaw('SELECT id FROM pages WHERE source_id=$1', [f.id])).toHaveLength(1);
  }
}), 120_000);
