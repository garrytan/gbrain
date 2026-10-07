/**
 * R1 (Cat 40 Hard): `remember` after `forget` of the same claim. In the held-out
 * run agents saved facts without an entity, forgot them "to re-save with an
 * entity", then remembered the same text with the entity. A claim forgotten
 * without an entity is withdrawn for every entity, so each re-save was admitted
 * and then failed with an opaque "The write did not commit" message that
 * get_write_request did not explain either.
 *
 * Pins: the refusal names `fact_withdrawn` and the write that works, before
 * admission and (when a withdrawal races admission) on the failed receipt,
 * the batch item error and get_write_request; and the supported link path,
 * `replaces` from a fact saved without an entity, supersedes it without
 * withdrawing the claim.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { writeFailureDiagnostic } from '../src/core/persistence/verb-errors.ts';
import { FACT_WITHDRAWN_MESSAGE, FACT_WITHDRAWN_SUGGESTION } from '../src/core/facts/withdrawal.ts';
import { NO_ENTITY_HINT } from '../src/core/persistence/memory-prepare.ts';

let engine: PGLiteEngine;
const CLAIM = 'Alice Example is the procurement lead at Acme Example.';

async function call(name: string, params: Record<string, unknown>) {
  const res = await dispatchToolCall(engine, name, params, { remote: true, takesHoldersAllowList: ['world'], sourceId: 'default' });
  return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text!) as Record<string, any> };
}
async function requestCount(): Promise<number> {
  const [row] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE operation='remember'");
  return Number(row!.n);
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
  await dispatchToolCall(engine, 'put_page', { slug: 'crm/acme-example',
    content: '---\ntitle: Acme Example\ntype: company\n---\n# Acme Example\n\nA company.\n' }, { remote: false });
});

describe('remember after forget of the same claim', () => {
  test('held-out shape: forget an unlinked fact, re-save it with an entity -> fact_withdrawn with the working write, nothing admitted', async () => {
    const saved = await call('remember', { items: [{ fact: CLAIM, provenance: 'team update' }], infer_entity: false });
    expect(saved.body.items[0]).toMatchObject({ status: 'inserted', entity_slug: null });
    expect(saved.body.hints).toEqual([NO_ENTITY_HINT]);
    expect(NO_ENTITY_HINT).toContain('replaces');
    const forgot = await call('forget', { id: saved.body.items[0].id, reason: 're-saving with entity' });
    expect(forgot.body.expired).toBe(true);

    const before = await requestCount();
    const resave = await call('remember', { fact: CLAIM, entity: 'crm/acme-example', provenance: 'team update' });
    expect(resave.isError).toBe(true);
    expect(resave.body.code).toBe('invalid_params');
    expect(resave.body.message).toBe(FACT_WITHDRAWN_MESSAGE);
    expect(resave.body.message).not.toContain('did not commit');
    expect(resave.body.suggestion).toBe(FACT_WITHDRAWN_SUGGESTION);
    expect(await requestCount()).toBe(before);

    const batch = await call('remember', { items: [{ fact: CLAIM, entity: 'crm/acme-example', provenance: 'team update' }] });
    expect(batch.body.failed).toBe(1);
    expect(batch.body.items[0].error).toMatchObject({ code: 'invalid_params', message: FACT_WITHDRAWN_MESSAGE, suggestion: FACT_WITHDRAWN_SUGGESTION });
  });

  test('a withdrawal that lands after admission fails the receipt with fact_withdrawn, readable through get_write_request', async () => {
    // The trigger withdraws the claim inside the admission transaction, after the admission check passed.
    await engine.executeRaw(`CREATE OR REPLACE FUNCTION r1_withdraw_on_admit() RETURNS trigger AS $$
      BEGIN
        INSERT INTO fact_withdrawals(source_id,visibility,subject,fact_hash)
          VALUES (NEW.source_id,'world','*',gbrain_fact_fingerprint(NEW.intent->>'fact')) ON CONFLICT DO NOTHING;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await engine.executeRaw(`CREATE TRIGGER r1_withdraw_on_admit AFTER INSERT ON persistence_requests
      FOR EACH ROW WHEN (NEW.operation = 'remember') EXECUTE FUNCTION r1_withdraw_on_admit()`);
    try {
      const requestId = '0b6f3c2a-4d5e-4f60-8a71-92b3c4d5e6f7';
      const res = await call('remember', { fact: CLAIM, entity: 'crm/acme-example', provenance: 'team update', request_id: requestId });
      expect(res.isError).toBe(true);
      expect(res.body).toMatchObject({ code: 'invalid_params', write_error: 'invalid_params', message: FACT_WITHDRAWN_MESSAGE });
      expect(res.body.write_request).toMatchObject({ request_id: requestId, state: 'failed' });
      expect(res.body.suggestion).toContain(FACT_WITHDRAWN_SUGGESTION);
      const receipt = await call('get_write_request', { request_id: requestId });
      expect(receipt.isError).toBe(false);
      expect(receipt.body).toMatchObject({ request_id: requestId, state: 'failed', write_error: 'invalid_params', write_error_message: FACT_WITHDRAWN_MESSAGE });
    } finally {
      await engine.executeRaw('DROP TRIGGER IF EXISTS r1_withdraw_on_admit ON persistence_requests');
      await engine.executeRaw('DROP FUNCTION IF EXISTS r1_withdraw_on_admit()');
    }
  });

  test('replaces links a fact saved without an entity: superseded, not withdrawn', async () => {
    const unlinked = await call('remember', { fact: CLAIM, provenance: 'team update', infer_entity: false });
    expect(unlinked.body).toMatchObject({ status: 'inserted', entity_slug: null });
    const linked = await call('remember', { fact: CLAIM, entity: 'crm/acme-example', provenance: 'team update', replaces: unlinked.body.id });
    expect(linked.isError).toBe(false);
    expect(linked.body).toMatchObject({ status: 'superseded', entity_slug: 'crm/acme-example', superseded_fact_id: unlinked.body.id, replaced_by_caller: true });
    const rows = await engine.executeRaw<{ id: number; entity_slug: string | null; expired: boolean; superseded_by: number | null }>(
      'SELECT id,entity_slug,expired_at IS NOT NULL AS expired,superseded_by FROM facts ORDER BY id');
    expect(rows.map(r => ({ ...r, id: Number(r.id), superseded_by: r.superseded_by == null ? null : Number(r.superseded_by) }))).toEqual([
      { id: Number(unlinked.body.id), entity_slug: null, expired: true, superseded_by: Number(linked.body.id) },
      { id: Number(linked.body.id), entity_slug: 'crm/acme-example', expired: false, superseded_by: null },
    ]);
    const [withdrawals] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM fact_withdrawals');
    expect(Number(withdrawals!.n)).toBe(0);
    const recall = await call('recall', { entity: 'crm/acme-example' });
    expect(JSON.stringify(recall.body.facts)).toContain(CLAIM);
  });

  test('replacing a fact about one entity with another entity is still refused', async () => {
    await dispatchToolCall(engine, 'put_page', { slug: 'crm/widget-co',
      content: '---\ntitle: Widget Co\ntype: company\n---\n# Widget Co\n\nA company.\n' }, { remote: false });
    const a = await call('remember', { fact: CLAIM, entity: 'crm/acme-example', provenance: 'team update' });
    const moved = await call('remember', { fact: CLAIM, entity: 'crm/widget-co', provenance: 'team update', replaces: a.body.id });
    expect(moved.isError).toBe(true);
    expect(moved.body.message).toContain('replaces_entity_mismatch');
  });
});

describe('writeFailureDiagnostic', () => {
  test('fact_withdrawn keeps its message and next step; unknown causes name the code without raw text', () => {
    expect(writeFailureDiagnostic('invalid_params', FACT_WITHDRAWN_MESSAGE)).toEqual({ reason: 'invalid_params',
      message: FACT_WITHDRAWN_MESSAGE, suggestion: FACT_WITHDRAWN_SUGGESTION });
    const generic = writeFailureDiagnostic('invalid_params', 'Refused /home/alice-example/private/notes.md');
    expect(generic.message).toBe('The write did not commit: it ended with invalid_params, and nothing was saved.');
    expect(generic.message).not.toContain('Inspect its durable request');
    expect(writeFailureDiagnostic('not_a_code', 'x').message).toBe('The write did not commit: it ended with storage_error, and nothing was saved.');
  });
});
