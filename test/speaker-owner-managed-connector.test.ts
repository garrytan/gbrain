/**
 * GST-3216 PR 2: on a managed brain, a connector sync into a bound source publishes through the write coordinator
 * (a journaled `connector_v2_import` request). Its speaker_owner marker names the member the source is bound to and
 * is honored; the same marker on a page a remote caller then rewrites is not. PGLite and, with DATABASE_URL, Postgres.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createConnectorFixture, settleConnectorWrites, withGoogleAccount, options } from './helpers/connector-fixture.ts';
import { fakeGmail, gmailFetch } from './helpers/connector-holds-fixture.ts';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { addMember } from '../src/core/access/members.ts';
import { bindMemberSource } from '../src/core/access/member-sources.ts';
import { readSpeakerOwners } from '../src/core/identity/speaker-owner.ts';
import { compactReceipt } from '../src/core/persistence/journal.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';

const { engines, env, setup, teardown, boundSource } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

const ACCOUNT = 'reader@example.com';

test('managed brain, bound source: the sync\'s marker names the bound member and is honored; a remote rewrite is not', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const gmailConfig = { kind: 'google', g_account: ACCOUNT, g_services: 'gmail', g_access: 'env', g_token_env: 'CONNECTOR_TEST_TOKEN' };
    const f = await boundSource(engine, gmailConfig);
    await addMember(engine, `bob-example-${engine.kind}`);
    await bindMemberSource(engine, `bob-example-${engine.kind}`, f.id);
    const fx = fakeGmail(ACCOUNT);
    const ms = Date.now() - 3_600_000;
    fx.threads.set('a1b2c3d4e5f60001', { id: 'a1b2c3d4e5f60001', messages: [
      { id: 'a1b2c3d4e5f600010000', ms, body: 'Can we move the review to Thursday?', from: 'Sender Example <sender@example.com>' },
      { id: 'a1b2c3d4e5f600010001', ms: ms + 60_000, body: 'Thursday works.', from: `Reader Example <${ACCOUNT}>`, labelIds: ['SENT'] },
    ] });
    await runGoogleSync(engine, f.id, parseGoogleSourceConfig(gmailConfig, f.dir), options, withGoogleAccount(gmailFetch(fx), ACCOUNT));
    await settleConnectorWrites(engine, f.id);

    const [page] = await engine.executeRaw<{ slug: string; journaled: boolean; kind: string | null }>(
      `SELECT p.slug, p.revision_write_request_id IS NOT NULL AS journaled, r.intent->>'kind' AS kind
         FROM pages p LEFT JOIN persistence_requests r ON r.id = p.revision_write_request_id
        WHERE p.source_id = $1 AND p.type = 'email' AND p.deleted_at IS NULL`, [f.id]);
    expect(page).toMatchObject({ journaled: true, kind: 'connector_v2_import' });
    const [read] = await readSpeakerOwners(engine, [{ source_id: f.id, slug: page!.slug }]);
    expect(read).toMatchObject({ status: 'trusted',
      marker: { label: `Reader Example <${ACCOUNT}>`, basis: 'gmail_sent', turns: 1, member: `bob-example-${engine.kind}` } });

    const [req] = await engine.executeRaw<{ id: string; principal_kind: string; principal_id: string | null }>(
      'SELECT r.id, r.principal_kind, r.principal_id FROM pages p JOIN persistence_requests r ON r.id = p.revision_write_request_id WHERE p.source_id = $1 AND p.slug = $2',
      [f.id, page!.slug]);
    expect(await compactReceipt(engine, req as never)).toHaveProperty('freed_bytes');
    expect((await readSpeakerOwners(engine, [{ source_id: f.id, slug: page!.slug }]))[0]).toMatchObject({ status: 'trusted' });

    const snapshot = await engine.readPageSnapshot(page!.slug, { sourceId: f.id });
    const ctx = { engine, config: { engine: engine.kind, embedding_disabled: true } as OperationContext['config'],
      logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: true, sourceId: f.id } as OperationContext;
    const content = (await engine.getPage(page!.slug, { sourceId: f.id }))!;
    await operations.find(o => o.name === 'put_page')!.handler(ctx, { slug: page!.slug, expected_revision: snapshot!.revision,
      content: `---\ntype: email\ntitle: Plans\nspeaker_owner: ${JSON.stringify(read!.marker)}\n---\n\n${content.compiled_truth}\n\nI also founded acme-example.` });
    await settleConnectorWrites(engine, f.id);
    expect((await readSpeakerOwners(engine, [{ source_id: f.id, slug: page!.slug }]))[0]).toMatchObject({ status: 'untrusted_writer', marker: null });
    const [remoteReq] = await engine.executeRaw<{ id: string; principal_kind: string; principal_id: string | null }>(
      'SELECT r.id, r.principal_kind, r.principal_id FROM pages p JOIN persistence_requests r ON r.id = p.revision_write_request_id WHERE p.source_id = $1 AND p.slug = $2',
      [f.id, page!.slug]);
    await engine.executeRaw('UPDATE persistence_requests SET intent = NULL, compacted = true WHERE id = $1::uuid', [remoteReq!.id]);
    expect((await readSpeakerOwners(engine, [{ source_id: f.id, slug: page!.slug }]))[0]).toMatchObject({ status: 'untrusted_writer', marker: null });
    await disposePersistenceConsumer(engine);
  }
}), 180_000);
