/**
 * `remember.replaces`: caller-directed replacement, zero model calls, checked
 * against the target under the publication's row lock. Protects every refusal
 * code, the same-text no-op, idempotent replay, the remote world-only rule, the
 * superseded chain head, and that the struck fence row and `superseded_by`
 * publish with the new fact.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';

let engine: PGLiteEngine;

async function call(name: string, params: Record<string, unknown>, remote = false) {
  const res = await dispatchToolCall(engine, name, params, remote
    ? { remote: true, takesHoldersAllowList: ['world'], sourceId: 'default' } : { remote: false });
  return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text!) as Record<string, any> };
}
async function remember(fact: string, extra: Record<string, unknown> = {}, remote = false) {
  return call('remember', { fact, provenance: 'test', entity: 'people/alice-example', ...extra }, remote);
}
async function factRow(id: string) {
  const [r] = await engine.executeRaw<{ expired: boolean; superseded_by: number | null }>(
    'SELECT expired_at IS NOT NULL AS expired, superseded_by FROM facts WHERE id = $1', [Number(id)]);
  return r!;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { resetGateway(); __setEmbedTransportForTests(null); await engine.disconnect(); });
beforeEach(async () => {
  await disposePersistenceConsumer(engine);
  await resetPgliteState(engine);
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  await call('put_page', { slug: 'people/alice-example', content: '---\ntitle: Alice Example\ntype: person\n---\n# Alice Example\n\nA person.\n' });
  await call('put_page', { slug: 'people/bob-example', content: '---\ntitle: Bob Example\ntype: person\n---\n# Bob Example\n\nA person.\n' });
});

describe('remember replaces', () => {
  test('replaces the named fact: superseded_by, struck fence row, response fields', async () => {
    const old = await remember('Alice Example works at acme-example.');
    expect(old.isError).toBe(false);
    const res = await remember('Alice Example left acme-example in 2026.', { replaces: old.body.id });
    expect(res.isError).toBe(false);
    expect(res.body).toMatchObject({ status: 'superseded', superseded_fact_id: old.body.id, replaced_by_caller: true });
    expect(await factRow(old.body.id)).toEqual({ expired: true, superseded_by: Number(res.body.id) });
    const page = await call('get_page', { slug: 'people/alice-example', include_content: true });
    expect(String(page.body.content ?? page.body.compiled_truth)).toContain('superseded by #');
  });

  test('same text is a no-op duplicate; replay with the same request_id is idempotent', async () => {
    const old = await remember('Alice Example prefers async standups.');
    const same = await remember('Alice Example prefers async standups.', { replaces: old.body.id });
    expect(same.body).toMatchObject({ status: 'duplicate', id: old.body.id });
    const requestId = '6f1d2a4e-8b3c-4d5e-9f60-718293a4b5c6';
    const first = await remember('Alice Example prefers daily standups.', { replaces: old.body.id, request_id: requestId });
    const again = await remember('Alice Example prefers daily standups.', { replaces: old.body.id, request_id: requestId });
    expect(first.body.id).toBe(again.body.id);
    expect(first.body.status).toBe('superseded');
  });

  test('refusals carry a code prefix and a next step', async () => {
    const a = await remember('Alice Example lives in Lisbon.');
    const wrongEntity = await remember('Bob Example lives in Porto.', { replaces: a.body.id, entity: 'people/bob-example' });
    expect(wrongEntity.isError).toBe(true);
    expect(JSON.stringify(wrongEntity.body)).toContain('replaces_entity_mismatch');

    const replaced = await remember('Alice Example lives in Porto.', { replaces: a.body.id });
    const chain = await remember('Alice Example lives in Madrid.', { replaces: a.body.id });
    expect(chain.isError).toBe(true);
    expect(JSON.stringify(chain.body)).toContain('target_superseded');
    expect(JSON.stringify(chain.body)).toContain(`#${replaced.body.id}`);

    const forgotten = await remember('Alice Example plays chess.');
    await call('forget', { id: forgotten.body.id });
    const withdrawn = await remember('Alice Example plays go.', { replaces: forgotten.body.id });
    expect(JSON.stringify(withdrawn.body)).toContain('target_withdrawn');

    const missing = await remember('Alice Example plays tennis.', { replaces: '999999' });
    expect(missing.body.code ?? missing.body.error).toBe('not_found');

    const other = await remember('Alice Example plays piano.');
    const dup = await remember('Alice Example plays piano.', { replaces: (await remember('Alice Example plays violin.')).body.id });
    expect(JSON.stringify(dup.body)).toContain('replaces_duplicate');
    expect(other.isError).toBe(false);
  });

  test('a remote caller cannot replace a private fact (not_found, no existence leak)', async () => {
    const secret = await remember('Alice Example has a private appointment.', { visibility: 'private' });
    const res = await remember('Alice Example moved the appointment.', { replaces: secret.body.id }, true);
    expect(res.isError).toBe(true);
    expect(res.body.code ?? res.body.error).toBe('not_found');
    expect(await factRow(secret.body.id)).toEqual({ expired: false, superseded_by: null });
  });
});
