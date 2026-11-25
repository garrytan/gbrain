/**
 * Engine-parametrized scenarios for the `withdrawn` object on `fact_withdrawn`
 * refusals (test/withdrawn-detail.test.ts on PGLite,
 * test/e2e/withdrawn-detail-postgres.test.ts on Postgres). Each scenario
 * expects a fresh brain. Zero model calls.
 */
import { expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { FACT_WITHDRAWN_MESSAGE, FACT_WITHDRAWN_SUGGESTION } from '../../src/core/facts/withdrawal.ts';
import { writeSingleFact } from '../../src/core/facts/write-single.ts';
import { OperationError } from '../../src/core/ops/contract.ts';

const CLAIM = 'Acme Example renewed for three years at 40 seats.';

type Caller = 'remote' | 'http' | 'local';
async function call(engine: BrainEngine, name: string, params: Record<string, unknown>, caller: Caller = 'remote') {
  const ctx = caller === 'local' ? { remote: false }
    : { remote: true, transport: caller === 'http' ? 'http' : 'stdio', takesHoldersAllowList: ['world'], sourceId: 'default' };
  const res = await dispatchToolCall(engine as never, name, params, ctx as never);
  return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text!) as Record<string, any> };
}

async function seedPages(engine: BrainEngine): Promise<void> {
  for (const [slug, title, extra] of [['crm/acme-example', 'Acme Example', ''], ['crm/hidden-co', 'Hidden Co', 'visibility: private\n']]) {
    await dispatchToolCall(engine as never, 'put_page', { slug, content: `---\ntitle: ${title}\ntype: company\n${extra}---\n# ${title}\n\nA company.\n` }, { remote: false });
  }
}
const ledger = async (engine: BrainEngine, subject: string) => {
  const [row] = await engine.executeRaw<{ at: string }>('SELECT withdrawn_at::text AS at FROM fact_withdrawals WHERE subject=$1', [subject]);
  return new Date(row!.at).toISOString();
};
const remember = (engine: BrainEngine, caller: Caller = 'remote', extra: Record<string, unknown> = {}) =>
  call(engine, 'remember', { fact: CLAIM, entity: 'crm/acme-example', provenance: 'call notes', ...extra }, caller);

/**
 * A local caller gets the `withdrawn` object; a remote caller (stdio or HTTP, the batch included) gets the same frozen
 * code, message and suggestion with no object, so the refusal carries nothing read from the forgotten rows.
 */
export async function detailOnEverySurface(engine: BrainEngine): Promise<void> {
  await seedPages(engine);
  const saved = await call(engine, 'remember', { fact: CLAIM, provenance: 'call notes', infer_entity: false });
  expect((await call(engine, 'forget', { id: String(saved.body.id) })).body.expired).toBe(true);
  const withdrawn = { at: await ledger(engine, '*'), subject: 'all_entities', visibility: 'world' };
  for (const caller of ['remote', 'http', 'local'] as const) {
    const r = await remember(engine, caller);
    expect(r.isError).toBe(true);
    expect(r.body).toMatchObject({ code: 'invalid_params', message: FACT_WITHDRAWN_MESSAGE, suggestion: FACT_WITHDRAWN_SUGGESTION });
    expect(r.body.withdrawn).toEqual(caller === 'local' ? withdrawn : undefined);
  }
  const batch = await call(engine, 'remember', { items: [{ fact: CLAIM, entity: 'crm/acme-example', provenance: 'call notes' }] });
  // #8621: a batch whose only item is refused is the item's refusal, prefixed with its index (no object for a remote caller).
  expect(batch.isError).toBe(true);
  expect(batch.body).toMatchObject({ code: 'invalid_params', message: `items[0]: ${FACT_WITHDRAWN_MESSAGE} None of the 1 item(s) was saved.` });
  expect(batch.body.withdrawn).toBeUndefined();
  const localBatch = await call(engine, 'remember', { items: [{ fact: CLAIM, entity: 'crm/acme-example', provenance: 'call notes' }] }, 'local');
  expect(localBatch.body.withdrawn).toEqual(withdrawn);
}

/** Several ledger rows: the entity's own withdrawal outranks a newer one for all entities. */
export async function mostSpecificSubjectFirst(engine: BrainEngine): Promise<void> {
  await seedPages(engine);
  const linked = await remember(engine);
  expect((await call(engine, 'forget_fact', { id: Number(linked.body.id) })).body.expired).toBe(true);
  const unlinked = await call(engine, 'remember', { fact: CLAIM, provenance: 'call notes', infer_entity: false });
  expect(unlinked.body.status).toBe('inserted');
  expect((await call(engine, 'forget', { id: String(unlinked.body.id) })).body.expired).toBe(true);
  const acmeAt = await ledger(engine, 'crm/acme-example');
  expect(Date.parse(await ledger(engine, '*'))).toBeGreaterThanOrEqual(Date.parse(acmeAt));
  expect((await remember(engine, 'local')).body.withdrawn).toEqual({ at: acmeAt, subject: 'crm/acme-example', visibility: 'world' });
  // Without the entity, only the all-entities withdrawal applies.
  const bare = await call(engine, 'remember', { fact: CLAIM, provenance: 'call notes', infer_entity: false }, 'local');
  expect(bare.body.withdrawn.subject).toBe('all_entities');
}

/**
 * A withdrawal whose rows the caller cannot read gives no detail, and neither does one whose rows it can read or one
 * no row backs: a remote caller's refusal is byte-identical in all three cases. A local caller keeps the detail.
 */
export async function hiddenBackingOmitsDetail(engine: BrainEngine): Promise<void> {
  await seedPages(engine);
  const [row] = await engine.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,fact,kind,visibility,entity_slug,source_markdown_slug,source,confidence,valid_from)
    VALUES ('default',$1,'fact','world','crm/acme-example','crm/hidden-co','meeting notes',1,now()) RETURNING id`, [CLAIM]);
  expect((await call(engine, 'forget_fact', { id: Number(row!.id) }, 'local')).body.expired).toBe(true);
  const hidden = await remember(engine);
  expect(hidden.isError).toBe(true);
  expect(hidden.body).toMatchObject({ code: 'invalid_params', message: FACT_WITHDRAWN_MESSAGE, suggestion: FACT_WITHDRAWN_SUGGESTION });
  expect(hidden.body.withdrawn).toBeUndefined();
  const local = await remember(engine, 'local');
  expect(local.body.withdrawn).toEqual({ at: await ledger(engine, 'crm/acme-example'), subject: 'crm/acme-example', visibility: 'world' });
  // A visible withdrawal (its row on a page the caller reads) and one no row backs answer byte-identically.
  const VISIBLE = 'Acme Example opened an office in a second city.';
  const visibleSaved = await call(engine, 'remember', { fact: VISIBLE, entity: 'crm/acme-example', provenance: 'call notes' });
  expect((await call(engine, 'forget_fact', { id: Number(visibleSaved.body.id) }, 'local')).body.expired).toBe(true);
  const visible = await call(engine, 'remember', { fact: VISIBLE, entity: 'crm/acme-example', provenance: 'call notes' });
  const UNBACKED = 'Acme Example signed a lease for a warehouse.';
  await engine.executeRaw(`INSERT INTO fact_withdrawals(source_id,visibility,subject,fact_hash) VALUES ('default','world','*',gbrain_fact_fingerprint($1))`, [UNBACKED]);
  const unbacked = await call(engine, 'remember', { fact: UNBACKED, entity: 'crm/acme-example', provenance: 'call notes' });
  expect(JSON.stringify(visible.body)).toBe(JSON.stringify(hidden.body));
  expect(JSON.stringify(unbacked.body)).toBe(JSON.stringify(hidden.body));
  // Beside a visible withdrawal for all entities, the remote answer is still the plain one.
  const unlinked = await call(engine, 'remember', { fact: CLAIM, provenance: 'call notes', infer_entity: false });
  expect((await call(engine, 'forget', { id: String(unlinked.body.id) })).body.expired).toBe(true);
  const mixed = await remember(engine);
  expect(JSON.stringify(mixed.body)).toBe(JSON.stringify(hidden.body));
  expect((await remember(engine, 'local')).body.withdrawn.subject).toBe('crm/acme-example');
}

/** A withdrawal that lands after admission fails the receipt; a remote caller's response, receipt and replay carry no object. */
export async function receiptKeepsDetail(engine: BrainEngine): Promise<void> {
  await seedPages(engine);
  await engine.executeRaw(`CREATE OR REPLACE FUNCTION wd_withdraw_on_admit() RETURNS trigger AS $$
    BEGIN
      INSERT INTO fact_withdrawals(source_id,visibility,subject,fact_hash)
        VALUES (NEW.source_id,'world','*',gbrain_fact_fingerprint(NEW.intent->>'fact')) ON CONFLICT DO NOTHING;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await engine.executeRaw(`CREATE TRIGGER wd_withdraw_on_admit AFTER INSERT ON persistence_requests
    FOR EACH ROW WHEN (NEW.operation = 'remember') EXECUTE FUNCTION wd_withdraw_on_admit()`);
  try {
    const requestId = '7d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6';
    const res = await remember(engine, 'remote', { request_id: requestId });
    expect(res.body).toMatchObject({ code: 'invalid_params', write_error: 'invalid_params', message: FACT_WITHDRAWN_MESSAGE });
    expect(res.body.write_request).toMatchObject({ request_id: requestId, state: 'failed' });
    // A remote caller's refusal carries no object, so neither does its receipt or a replay.
    expect(res.body.withdrawn).toBeUndefined();
    const receipt = await call(engine, 'get_write_request', { request_id: requestId });
    expect(receipt.body).toMatchObject({ request_id: requestId, state: 'failed', write_error_message: FACT_WITHDRAWN_MESSAGE });
    expect(receipt.body.withdrawn).toBeUndefined();
    const replay = await remember(engine, 'remote', { request_id: requestId });
    expect(replay.body.withdrawn).toBeUndefined();
  } finally {
    await engine.executeRaw('DROP TRIGGER IF EXISTS wd_withdraw_on_admit ON persistence_requests');
    await engine.executeRaw('DROP FUNCTION IF EXISTS wd_withdraw_on_admit()');
  }
}

/**
 * A failed request whose stored detail names a withdrawal (a refusal stored before the no-detail rule, or a managed
 * extraction's locked check): a remote reader's get_write_request and the remote requester's replay drop the object;
 * a trusted local reader still sees it.
 */
export async function storedDetailStaysLocal(engine: BrainEngine): Promise<void> {
  await seedPages(engine);
  const withdrawn = { at: '2026-10-12T00:00:00.000Z', subject: 'crm/hidden-co', visibility: 'world' };
  const fail = (requestId: string) => engine.executeRaw(`UPDATE persistence_requests SET state='failed', error_code='invalid_params',
      error_message=$2, error_detail=$3::text::jsonb WHERE request_id=$1`,
    [requestId, FACT_WITHDRAWN_MESSAGE, JSON.stringify({ origin: 'withdrawal', withdrawn: { version: 1, ...withdrawn } })]);
  const remoteId = '2c4e6a8b-1d3f-4a5b-8c7d-9e0f1a2b3c4d';
  expect((await remember(engine, 'remote', { request_id: remoteId })).isError).toBe(false);
  await fail(remoteId);
  const remote = await call(engine, 'get_write_request', { request_id: remoteId });
  expect(remote.body).toMatchObject({ request_id: remoteId, state: 'failed', write_error_message: FACT_WITHDRAWN_MESSAGE });
  expect(remote.body.withdrawn).toBeUndefined();
  const replay = await remember(engine, 'remote', { request_id: remoteId });
  expect(replay.isError).toBe(true);
  expect(replay.body.message).toBe(FACT_WITHDRAWN_MESSAGE);
  expect(replay.body.withdrawn).toBeUndefined();
  // The same stored detail on a trusted local requester's own request: its receipt and replay keep the object.
  const localId = '3d5f7b9c-2e4a-4b6c-9d8e-0f1a2b3c4d5e';
  expect((await remember(engine, 'local', { request_id: localId, fact: 'Acme Example hired a new auditor.' })).isError).toBe(false);
  await fail(localId);
  expect((await call(engine, 'get_write_request', { request_id: localId }, 'local')).body.withdrawn).toEqual(withdrawn);
  expect((await remember(engine, 'local', { request_id: localId, fact: 'Acme Example hired a new auditor.' })).body.withdrawn).toEqual(withdrawn);
}

/** The single-fact writer applies the same rule (a caller with `remote` unset reads as remote); a purge never supplies the object. */
export async function singleWriterSameRule(engine: BrainEngine): Promise<void> {
  await seedPages(engine);
  const [row] = await engine.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,fact,kind,visibility,entity_slug,source_markdown_slug,source,confidence,valid_from)
    VALUES ('default',$1,'fact','world','crm/acme-example','crm/hidden-co','meeting notes',1,now()) RETURNING id`, [CLAIM]);
  expect((await call(engine, 'forget_fact', { id: Number(row!.id) }, 'local')).body.expired).toBe(true);
  const write = (remote?: boolean) => writeSingleFact(engine, 'default', { fact: CLAIM, provenance: 'call notes', entity: 'crm/acme-example', visibility: 'world', ...(remote === undefined ? {} : { remote }) })
    .then(() => null, (e: unknown) => e as OperationError);
  const local = await write(false);
  expect(local?.message).toBe(FACT_WITHDRAWN_MESSAGE);
  expect(local?.withdrawn).toEqual({ at: await ledger(engine, 'crm/acme-example'), subject: 'crm/acme-example', visibility: 'world' });
  const unset = await write();
  expect(unset?.message).toBe(FACT_WITHDRAWN_MESSAGE);
  expect(unset?.withdrawn).toBeUndefined();
  const purged = 'Acme Example moved its headquarters.';
  await engine.executeRaw(`INSERT INTO fact_purges(source_id,visibility,subject,fact_hash) VALUES ('default','world','*',gbrain_fact_fingerprint($1))`, [purged]);
  const refused = await writeSingleFact(engine, 'default', { fact: purged, provenance: 'call notes', entity: 'crm/acme-example', visibility: 'world', remote: false })
    .then(() => null, (e: unknown) => e as OperationError);
  expect(refused).toBeInstanceOf(OperationError);
  expect(refused?.withdrawn).toBeUndefined();
}
