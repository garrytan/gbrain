/**
 * Protects Graph mail pagination, replay and checkpoint ordering at the HTTP
 * boundary. A missing delta drain or premature cursor advancement loses mail.
 * Existing chat-provider tests do not exercise Graph continuation links.
 * Uses the existing injectable HTTP transport; no live account is required.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectorClient } from '../src/core/connectors/client.ts';

const base = 'https://graph.microsoft.com';
const path = '/v1.0/users/mailbox-id/mailFolders/inbox/messages/delta';
const start = base + path;
const page2 = start + '?$skiptoken=opaque';
const cursor = start + '?$deltatoken=opaque';

function fixture(responses: unknown[]) {
  const requests: string[] = [];
  const client = new ConnectorClient({
    baseUrl: base,
    headers: async () => ({ authorization: 'Bearer synthetic' }),
    minDelayMs: 0,
    fetchImpl: async (url, init) => {
      requests.push(url);
      assert.equal(init.redirect, 'manual');
      assert.equal((init.headers as Record<string, string>).authorization, 'Bearer synthetic');
      assert.ok(responses.length, 'unexpected request');
      return Response.json(responses.shift());
    },
  });
  return { client, requests };
}

test('Graph delta drains pages, suppresses repeats and preserves changes and deletions', async () => {
  const message = { id: 'one', subject: 'First' };
  const changed = { id: 'one', subject: 'Updated' };
  const removed = { id: 'one', '@removed': { reason: 'deleted' } };
  const { client, requests } = fixture([
    { value: [message], '@odata.nextLink': page2 },
    { value: [message, changed, removed], '@odata.deltaLink': cursor },
    { value: [], '@odata.deltaLink': cursor },
  ]);
  const applied: unknown[] = [];
  const saved = await client.drainMailDelta('mailbox-id', 'inbox', async m => { applied.push(m); });
  assert.deepEqual(applied, [message, changed, removed]);
  assert.equal(saved, cursor);
  assert.equal(await client.drainMailDelta('mailbox-id', 'inbox', async () => {
    assert.fail('empty delta must not apply a message');
  }, { cursor: saved }), cursor);
  assert.deepEqual(requests, [start, page2, cursor]);
});

test('an apply failure preserves the old checkpoint and replay delivers the message again', async () => {
  const response = { value: [{ id: 'one' }], '@odata.deltaLink': cursor };
  const { client, requests } = fixture([response, response]);
  let saved = start;
  await assert.rejects(async () => {
    saved = await client.drainMailDelta('mailbox-id', 'inbox', async () => {
      throw new Error('durable write refused');
    }, { cursor: saved });
  }, /durable write refused/);
  assert.equal(saved, start);
  const applied: unknown[] = [];
  saved = await client.drainMailDelta('mailbox-id', 'inbox', async m => { applied.push(m); }, { cursor: saved });
  assert.equal(saved, cursor);
  assert.deepEqual(applied, [{ id: 'one' }]);
  assert.deepEqual(requests, [start, start]);
});

test('invalid cursors, malformed pages and pagination cycles never produce a checkpoint', async () => {
  for (const bad of [start.replace('/users/mailbox-id/', '/users/other/'), start.replace('/v1.0/', '/beta/')]) {
    const { client, requests } = fixture([]);
    await assert.rejects(() => client.drainMailDelta('mailbox-id', 'inbox', async () => {}, { cursor: bad }));
    assert.deepEqual(requests, []);
  }
  for (const response of [
    { '@odata.deltaLink': cursor },
    { value: [{}], '@odata.deltaLink': cursor },
    { value: [], '@odata.deltaLink': cursor, '@odata.nextLink': page2 },
    { value: [], '@odata.nextLink': start },
    { value: [], '@odata.nextLink': start.replace('/users/mailbox-id/', '/users/other/') },
  ]) {
    const { client, requests } = fixture([response]);
    await assert.rejects(() => client.drainMailDelta('mailbox-id', 'inbox', async () => {}));
    assert.deepEqual(requests, [start]);
  }
});
