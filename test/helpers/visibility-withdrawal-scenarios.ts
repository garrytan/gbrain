/**
 * Engine-parametrized scenarios: remote forget refusals and entity cards respect
 * visibility and withdrawal (test/visibility-withdrawal.test.ts on PGLite,
 * test/e2e/visibility-withdrawal-postgres.test.ts on Postgres). Each scenario
 * expects a fresh brain. Zero model calls.
 */
import { expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { FACT_WITHDRAWN_MESSAGE } from '../../src/core/facts/withdrawal.ts';

const CLAIM = 'Acme Example renewed for three years at 40 seats.';
const ACTIVE = 'Acme Example opened a second office in Lisbon.';
const GENERIC_CLAIM_LINKED = (id: number | string) =>
  `claim_linked: the same claim as fact #${id} is active elsewhere in this brain. Forgetting #${id} would withdraw it there too, so nothing was forgotten.`;

type Caller = 'remote' | 'local' | 'unset';
async function call(engine: BrainEngine, name: string, params: Record<string, unknown>, caller: Caller = 'remote') {
  const ctx = caller === 'remote' ? { remote: true, takesHoldersAllowList: ['world'], sourceId: 'default' }
    : caller === 'local' ? { remote: false } : { sourceId: 'default' };
  const res = await dispatchToolCall(engine as never, name, params, ctx as never);
  return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text!) as Record<string, any> };
}

async function seedPages(engine: BrainEngine): Promise<void> {
  for (const [slug, title, extra] of [['crm/acme-example', 'Acme Example', ''], ['crm/hidden-co', 'Hidden Co', 'visibility: private\n'],
    ['crm/hidden-two', 'Hidden Two', 'visibility: private\n']]) {
    await dispatchToolCall(engine as never, 'put_page', { slug, content: `---\ntitle: ${title}\ntype: company\n${extra}---\n# ${title}\n\nA company.\n` }, { remote: false });
  }
}

/** A fact about a visible entity whose provenance is a private page. */
async function insertHiddenSourced(engine: BrainEngine, entity: string, sourcePage: string): Promise<number> {
  const [row] = await engine.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,fact,kind,visibility,entity_slug,source_markdown_slug,source,confidence,valid_from)
    VALUES ('default',$1,'fact','world',$2,$3,'meeting notes',1,now()) RETURNING id`, [CLAIM, entity, sourcePage]);
  return Number(row!.id);
}
const active = async (engine: BrainEngine, id: number) =>
  (await engine.executeRaw<{ a: boolean }>('SELECT expired_at IS NULL AS a FROM facts WHERE id=$1', [id]))[0]!.a;
const withdrawals = async (engine: BrainEngine) => Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM fact_withdrawals'))[0]!.n);

/** 1a: a remote forget of an unlinked fact never names or withdraws a linked copy on a page the caller cannot read. */
export async function unlinkedForgetKeepsHiddenCopies(engine: BrainEngine): Promise<void> {
  await seedPages(engine);
  const hidden = await call(engine, 'remember', { fact: CLAIM, entity: 'crm/hidden-co', provenance: 'meeting notes' }, 'local');
  expect(hidden.body.status).toBe('inserted');
  const unlinked = await call(engine, 'remember', { fact: CLAIM, provenance: 'call notes', infer_entity: false });
  const id = unlinked.body.id;
  const one = await call(engine, 'forget', { id: String(id) });
  expect(one.isError).toBe(true);
  expect(one.body.code).toBe('invalid_params');
  expect(one.body.message).toBe(GENERIC_CLAIM_LINKED(id));
  expect(JSON.stringify(one.body)).not.toContain('hidden-co');
  expect(JSON.stringify(one.body)).not.toContain(`#${hidden.body.id}`);
  expect(await active(engine, Number(hidden.body.id))).toBe(true);
  expect(await withdrawals(engine)).toBe(0);
  // Fail closed: a call that does not say it is local is treated as remote.
  expect((await call(engine, 'forget', { id: String(id) }, 'unset')).body.message).toBe(GENERIC_CLAIM_LINKED(id));
  // One fixed text whatever the number of hidden copies.
  await call(engine, 'remember', { fact: CLAIM, entity: 'crm/hidden-two', provenance: 'meeting notes' }, 'local');
  const two = await call(engine, 'forget', { id: String(id) });
  expect(two.body.message).toBe(one.body.message);
  expect(two.body.suggestion).toBe(one.body.suggestion);
  // A local caller keeps the detailed refusal naming the linked facts.
  const local = await call(engine, 'forget', { id: String(id) }, 'local');
  expect(local.body.message).toStartWith(`claim_linked: fact #${id} was saved without an entity, and the same claim is active as #${hidden.body.id} (crm/hidden-co)`);
  expect(await active(engine, Number(hidden.body.id))).toBe(true);
}

/** 1a: a remote forget of a linked fact never withdraws a copy about the same entity filed from a page the caller cannot read. */
export async function linkedForgetKeepsHiddenCopies(engine: BrainEngine): Promise<void> {
  await seedPages(engine);
  const hiddenId = await insertHiddenSourced(engine, 'crm/acme-example', 'crm/hidden-co');
  const visible = await call(engine, 'remember', { fact: CLAIM, entity: 'crm/acme-example', provenance: 'call notes' });
  expect(visible.body.status).toBe('inserted');
  const refused = await call(engine, 'forget', { id: String(visible.body.id) });
  expect(refused.body.message).toBe(GENERIC_CLAIM_LINKED(visible.body.id));
  expect(await active(engine, hiddenId)).toBe(true);
  expect(await active(engine, Number(visible.body.id))).toBe(true);
  const local = await call(engine, 'forget', { id: String(visible.body.id) }, 'local');
  expect(local.isError).toBe(false);
  expect(local.body.expired).toBe(true);
}

/** 1b: a withdrawal backed only by rows the caller cannot read refuses exactly as a page the caller may not see does. */
export async function hiddenWithdrawalRefusesGenerically(engine: BrainEngine): Promise<void> {
  await seedPages(engine);
  const hiddenPage = await call(engine, 'remember', { fact: CLAIM, entity: 'crm/hidden-co', provenance: 'call notes' });
  expect(hiddenPage.isError).toBe(true);
  const hiddenId = await insertHiddenSourced(engine, 'crm/acme-example', 'crm/hidden-co');
  expect((await call(engine, 'forget_fact', { id: hiddenId }, 'local')).body.expired).toBe(true);
  const remote = await call(engine, 'remember', { fact: CLAIM, entity: 'crm/acme-example', provenance: 'call notes' });
  expect(remote.isError).toBe(true);
  for (const key of ['code', 'error', 'message', 'suggestion']) expect(remote.body[key]).toEqual(hiddenPage.body[key]);
  expect(JSON.stringify(remote.body)).not.toContain('withdrawn');
  const unset = await call(engine, 'remember', { fact: CLAIM, entity: 'crm/acme-example', provenance: 'call notes' }, 'unset');
  expect(unset.body.message).toBe(hiddenPage.body.message);
  const batch = await call(engine, 'remember', { items: [{ fact: CLAIM, entity: 'crm/acme-example', provenance: 'call notes' }] });
  expect(batch.body.items[0].error.message).toBe(hiddenPage.body.message);
  // The local caller keeps fact_withdrawn.
  const local = await call(engine, 'remember', { fact: CLAIM, entity: 'crm/acme-example', provenance: 'call notes' }, 'local');
  expect(local.body.message).toBe(FACT_WITHDRAWN_MESSAGE);
  // A withdrawal the caller can see keeps fact_withdrawn for remote callers too.
  const own = await call(engine, 'remember', { fact: ACTIVE, entity: 'crm/acme-example', provenance: 'call notes' });
  expect((await call(engine, 'forget', { id: String(own.body.id) })).body.expired).toBe(true);
  expect((await call(engine, 'remember', { fact: ACTIVE, entity: 'crm/acme-example', provenance: 'call notes' })).body.message).toBe(FACT_WITHDRAWN_MESSAGE);
}

/** 2: the card's identity_excerpt carries the withdrawal overlay; a private primary page is never carded for a remote caller. */
export async function cardExcerptHidesWithdrawnRows(engine: BrainEngine): Promise<void> {
  await seedPages(engine);
  const kept = await call(engine, 'remember', { fact: ACTIVE, entity: 'crm/acme-example', provenance: 'call notes' });
  const gone = await call(engine, 'remember', { fact: CLAIM, entity: 'crm/acme-example', provenance: 'call notes' });
  expect([kept.body.status, gone.body.status]).toEqual(['inserted', 'inserted']);
  const lines = async (caller: Caller) =>
    ((await call(engine, 'entity', { name: 'crm/acme-example' }, caller)).body.card?.identity_excerpt ?? []).map((l: { line: string }) => l.line).join('\n');
  expect(await lines('remote')).toContain('renewed for three years');
  expect((await call(engine, 'forget_fact', { id: Number(gone.body.id) })).body.expired).toBe(true);
  for (const caller of ['remote', 'local'] as const) {
    const text = await lines(caller);
    expect(text).not.toContain('renewed for three years');
    expect(text).toContain('second office in Lisbon');
  }
  // Upstream filter (src/core/verbs/entity-card.ts, the privatePredicate on the page lookup): no card for a private page.
  expect((await call(engine, 'entity', { name: 'crm/hidden-co' })).body.found).toBe(false);
  expect((await call(engine, 'entity', { name: 'crm/hidden-co' }, 'local')).body.found).not.toBe(false);
}
