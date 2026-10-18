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

/** Every surface carries one identical object; the frozen code, message and suggestion are unchanged. */
export async function detailOnEverySurface(engine: BrainEngine): Promise<void> {
  await seedPages(engine);
  const saved = await call(engine, 'remember', { fact: CLAIM, provenance: 'call notes', infer_entity: false });
  expect((await call(engine, 'forget', { id: String(saved.body.id) })).body.expired).toBe(true);
  const withdrawn = { at: await ledger(engine, '*'), subject: 'all_entities', visibility: 'world' };
  for (const caller of ['remote', 'http', 'local'] as const) {
    const r = await remember(engine, caller);
    expect(r.isError).toBe(true);
    expect(r.body).toMatchObject({ code: 'invalid_params', message: FACT_WITHDRAWN_MESSAGE, suggestion: FACT_WITHDRAWN_SUGGESTION });
    expect(r.body.withdrawn).toEqual(withdrawn);
  }
  const batch = await call(engine, 'remember', { items: [{ fact: CLAIM, entity: 'crm/acme-example', provenance: 'call notes' }] });
  expect(batch.body.items[0].error).toMatchObject({ code: 'invalid_params', message: FACT_WITHDRAWN_MESSAGE, withdrawn });
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
  expect((await remember(engine)).body.withdrawn).toEqual({ at: acmeAt, subject: 'crm/acme-example', visibility: 'world' });
  // Without the entity, only the all-entities withdrawal applies.
  const bare = await call(engine, 'remember', { fact: CLAIM, provenance: 'call notes', infer_entity: false });
  expect(bare.body.withdrawn.subject).toBe('all_entities');
}

/** A withdrawal whose rows the caller cannot read gives no detail; #6509's refusal is unchanged. */
export async function hiddenBackingOmitsDetail(engine: BrainEngine): Promise<void> {
  await seedPages(engine);
  const hiddenPage = await call(engine, 'remember', { fact: CLAIM, entity: 'crm/hidden-co', provenance: 'call notes' });
  const [row] = await engine.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,fact,kind,visibility,entity_slug,source_markdown_slug,source,confidence,valid_from)
    VALUES ('default',$1,'fact','world','crm/acme-example','crm/hidden-co','meeting notes',1,now()) RETURNING id`, [CLAIM]);
  expect((await call(engine, 'forget_fact', { id: Number(row!.id) }, 'local')).body.expired).toBe(true);
  const remote = await remember(engine);
  for (const key of ['code', 'error', 'message', 'suggestion']) expect(remote.body[key]).toEqual(hiddenPage.body[key]);
  expect(remote.body.withdrawn).toBeUndefined();
  const local = await remember(engine, 'local');
  expect(local.body.withdrawn).toEqual({ at: await ledger(engine, 'crm/acme-example'), subject: 'crm/acme-example', visibility: 'world' });
  // A visible withdrawal for all entities: the remote caller is told about that one, never the hidden one.
  const unlinked = await call(engine, 'remember', { fact: CLAIM, provenance: 'call notes', infer_entity: false });
  expect((await call(engine, 'forget', { id: String(unlinked.body.id) })).body.expired).toBe(true);
  const mixed = await remember(engine);
  expect(mixed.body.message).toBe(FACT_WITHDRAWN_MESSAGE);
  expect(mixed.body.withdrawn).toEqual({ at: await ledger(engine, '*'), subject: 'all_entities', visibility: 'world' });
  expect((await remember(engine, 'local')).body.withdrawn.subject).toBe('crm/acme-example');
}

/** A withdrawal that lands after admission fails the receipt; the object rides the response and get_write_request. */
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
    const withdrawn = { at: await ledger(engine, '*'), subject: 'all_entities', visibility: 'world' };
    expect(res.body.withdrawn).toEqual(withdrawn);
    const receipt = await call(engine, 'get_write_request', { request_id: requestId });
    expect(receipt.body).toMatchObject({ request_id: requestId, state: 'failed', write_error_message: FACT_WITHDRAWN_MESSAGE, withdrawn });
    const replay = await remember(engine, 'remote', { request_id: requestId });
    expect(replay.body.withdrawn).toEqual(withdrawn);
  } finally {
    await engine.executeRaw('DROP TRIGGER IF EXISTS wd_withdraw_on_admit ON persistence_requests');
    await engine.executeRaw('DROP FUNCTION IF EXISTS wd_withdraw_on_admit()');
  }
}

/** The single-fact writer applies the same predicate (fail-closed when `remote` is unset); a purge never supplies the object. */
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
  expect(unset?.message).toBe('Page not found.');
  expect(unset?.withdrawn).toBeUndefined();
  const purged = 'Acme Example moved its headquarters.';
  await engine.executeRaw(`INSERT INTO fact_purges(source_id,visibility,subject,fact_hash) VALUES ('default','world','*',gbrain_fact_fingerprint($1))`, [purged]);
  const refused = await writeSingleFact(engine, 'default', { fact: purged, provenance: 'call notes', entity: 'crm/acme-example', visibility: 'world', remote: false })
    .then(() => null, (e: unknown) => e as OperationError);
  expect(refused).toBeInstanceOf(OperationError);
  expect(refused?.withdrawn).toBeUndefined();
}
