/**
 * Belief ledger purge probes (docs/designs/BELIEF_LEDGER.md section 11: 10,
 * 22, 27, 30, 31, 35, 36 (live half), 37, 38). Each asserts exact event keys,
 * types and values and the reconstructed history on PGLite and on Postgres
 * when DATABASE_URL is set, and each has a forced probe: a deliberately broken
 * emitter or redaction pass that must make the same assertion fail.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { __setBeliefEmitterFaultForTests, appendBeliefEvents, type BeliefEventDraft } from '../src/core/belief/append.ts';
import { __setPurgeRedactionFaultForTests, type PurgeRedactionFault } from '../src/core/belief/purge.ts';
import { readBeliefHistory } from '../src/core/belief/history.ts';
import { withBeliefBatch } from '../src/core/belief/ledger.ts';
import { REDACTION_MARKER, fieldHash } from '../src/core/belief/keys.ts';
import { __setNamedRowProbesForTests } from '../src/core/facts/purge-verify.ts';
import { recordDerivationInputs } from '../src/core/facts/derivation-inputs.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { applyOwnerAction, previewOwnerAction } from '../src/core/trust/owner-actions.ts';
import { configDir } from '../src/core/config.ts';
import { operations } from '../src/core/operations.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { testBackends } from './helpers/test-backends.ts';
import { beliefBrain, beliefEngineCase, beliefPage, shape, type BeliefBrain, type BeliefEvent } from './helpers/belief-ledger.ts';

afterEach(() => { __setBeliefEmitterFaultForTests(null); __setPurgeRedactionFaultForTests(null); __setNamedRowProbesForTests(true); });

const X = 'Door code is 4417';
const purgeOp = operations.find(o => o.name === 'purge_fact')!;
const deleteOp = operations.find(o => o.name === 'delete_page')!;
const marker = (request: string) => REDACTION_MARKER(request);

async function fp(b: BeliefBrain, claim: string): Promise<string> {
  return (await b.engine.executeRaw<{ fp: string }>('SELECT gbrain_fact_fingerprint($1) AS fp', [claim]))[0]!.fp;
}

async function purgeFact(b: BeliefBrain, claim: string): Promise<Record<string, any>> {
  const [row] = await b.engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id = $1 AND fact = $2 AND expired_at IS NULL ORDER BY id LIMIT 1', [b.sourceId, claim]);
  const dry = await purgeOp.handler(b.ctx, { id: Number(row!.id), dry_run: true }) as Record<string, any>;
  return await purgeOp.handler(b.ctx, { id: Number(row!.id), confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: randomUUID() }) as Record<string, any>;
}

async function purgePage(b: BeliefBrain, slug: string): Promise<Record<string, any>> {
  const snapshot = await b.engine.readPageSnapshot(slug, { sourceId: b.sourceId, includeDeleted: true });
  return await deleteOp.handler(b.ctx, { slug, purge: true, expected_revision: snapshot!.revision, request_id: randomUUID() }) as Record<string, any>;
}

/** The purge's internal request id (the `purge_request` its events and markers name). */
async function purgeRequest(b: BeliefBrain, clientRequestId: string): Promise<string> {
  return (await b.engine.executeRaw<{ id: string }>('SELECT id::text AS id FROM persistence_requests WHERE request_id = $1::uuid', [clientRequestId]))[0]!.id;
}

const history = (b: BeliefBrain, q: { slug?: string; subjectKey?: string } = {}) => readBeliefHistory(b.engine, { sourceId: b.sourceId, remote: false, ...q });

/** Runs a brain scenario to completion (teardown included, so withEnv scopes never overlap) and returns what it reported. */
async function collect<T>(run: (report: (value: T) => void) => Promise<void>): Promise<T> {
  let out: T | undefined;
  await run(value => { out = value; });
  return out as T;
}

/** Runs `scenario` once for real and once under `fault`; the real run must pass `check` and the faulty one must fail it. */
async function forced<T>(scenario: () => Promise<T>, check: (value: T) => void, fault: () => void): Promise<void> {
  check(await scenario());
  fault();
  try {
    const value = await scenario();
    let failed = false;
    try { check(value); } catch { failed = true; }
    expect(failed).toBe(true);
  } finally { __setBeliefEmitterFaultForTests(null); __setPurgeRedactionFaultForTests(null); __setNamedRowProbesForTests(true); }
}
const redactionFault = (fault: PurgeRedactionFault) => () => __setPurgeRedactionFaultForTests(fault);

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe(`belief ledger purge (${engineCase.name})`, () => {
    const brain = (run: (b: BeliefBrain) => Promise<void>, managed = true) => beliefBrain(run, { managed, databaseUrl: engineCase.databaseUrl });

    test('probe 10: purge redacts the key\'s whole history to skeletons and appends one fact.purged; nothing re-asserts it', async () => {
      const scenario = () => collect<Record<string, unknown>>(resolve => brain(async b => {
        const slug = `companies/acme-${randomUUID().slice(0, 6)}`;
        const stale = beliefPage({ facts: [X, 'Acme sells widgets'] });
        await b.put(slug, stale);
        await b.put(slug, beliefPage({ facts: [{ claim: X, confidence: '0.5' }, 'Acme sells widgets'] }));
        const revised = (await b.events()).find(e => e.event_type === 'fact.revised')!;
        const mark = await b.lastId();
        const result = await purgeFact(b, X);
        const request = await purgeRequest(b, String(result.request_id));
        const after = await b.events(mark);
        const keyHistory = await history(b, { subjectKey: revised.subject_key });
        const beforeInsert = await b.lastId();
        const insert = await b.engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source_markdown_slug) VALUES ($1, $2, $3, 'fact', 'world', $2)`,
          [b.sourceId, slug, X]).then(() => 'inserted', (e: Error) => e.message.includes('purged') || e.message.includes('writer_coordinator_required') ? 'refused' : e.message);
        const afterInsert = await b.lastId();
        await b.put(slug, stale);
        const reimport = (await b.events(afterInsert)).filter(e => e.claim_fp === revised.claim_fp && /asserted|revised|adopted/.test(e.event_type));
        const prepared: BeliefEventDraft = { sourceId: b.sourceId, incarnation: revised.source_incarnation, lifetime: revised.page_lifetime, slug, stream: slug,
          subjectKind: 'fact', subjectKey: revised.subject_key, eventType: 'fact.asserted', trustTier: 'unknown', tierBasis: 'unknown', visibility: 'world',
          value: { fact: X, context: null }, stateHash: '', claimFp: revised.claim_fp, cause: { op: 'backfill' } };
        const backfillId = randomUUID();
        await b.engine.transaction(tx => appendBeliefEvents(tx, [prepared], { publicationId: backfillId, origin: 'backfill' }));
        const backfilled = (await b.events(afterInsert)).filter(e => e.publication_id === backfillId);
        const [epoch] = await b.engine.executeRaw<{ e: number }>('SELECT purge_epoch AS e FROM sources WHERE id = $1', [b.sourceId]);
        await b.put(`notes/other-${randomUUID().slice(0, 6)}`, beliefPage({ facts: ['Acme has a second claim'] }));
        await purgeFact(b, 'Acme has a second claim');
        const stalePrepared = await b.engine.transaction(tx => appendBeliefEvents(tx, [{ ...prepared, subjectKey: `${prepared.subjectKey}#stale` }],
          { publicationId: randomUUID(), origin: 'backfill', preparedEpoch: Number(epoch!.e) })).then(() => 'appended', (e: { code?: string }) => e.code ?? 'error');
        resolve({ request, after, revised, keyHistory, insert, inserted: afterInsert - beforeInsert, reimport, backfilled, stalePrepared, fp: await fp(b, X) });
      }));
      await forced(scenario, (r: any) => {
        expect(shape(r.after)).toEqual(['page:page.published', 'fact:fact.purged']);
        const purged = r.after[1] as BeliefEvent;
        expect(purged).toMatchObject({ subject_key: r.revised.subject_key, value: null, value_hash: null, purged: true, claim_fp: r.fp });
        expect(purged.cause).toMatchObject({ op: 'purge_fact', purge_request: r.request });
        expect(r.keyHistory.map((e: BeliefEvent) => [e.event_type, e.value, e.value_hash, e.purged])).toEqual([
          ['fact.revised', null, null, true], ['fact.purged', null, null, true]]);
        expect(r.insert).toBe('refused');
        expect(r.inserted).toBe(0);
        expect(r.reimport).toEqual([]);
        expect(r.backfilled.map((e: BeliefEvent) => [e.event_type, e.value, e.purged])).toEqual([['fact.asserted', null, true]]);
        expect(r.stalePrepared).toBe('belief_stale_preparation');
      }, redactionFault('skip_purged_keys'));
      await forced(scenario, (r: any) => expect(shape(r.after)).toEqual(['page:page.published', 'fact:fact.purged']),
        () => __setBeliefEmitterFaultForTests(drafts => drafts.map(d => d.eventType === 'fact.purged' ? { ...d, eventType: 'fact.retracted' } : d)));
    }, 240_000);

    test('probe 22: a claim quoted only in another fact\'s context, a take\'s resolution evidence or a link\'s context is redacted', async () => {
      const scenario = () => collect<Record<string, unknown>>(resolve => brain(async b => {
        await b.put('people/alice-example', beliefPage({ type: 'person', title: 'Alice Example' }));
        await b.put('companies/acme-example', beliefPage({ facts: ['Acme sells widgets'], takes: ['Acme will win its market'] }));
        await b.put('companies/acme-example', beliefPage({ facts: [{ claim: 'Acme sells widgets', context: `notes say ${X}` }], takes: ['Acme will win its market'],
          prose: `The lobby sign says ${X}.`, links: ['people/alice-example'] }));
        await b.op('takes_resolve', { slug: 'companies/acme-example', row_num: 1, quality: 'correct', evidence: `confirmed: ${X}` });
        await b.put('vault/codes-example', beliefPage({ facts: [X] }));
        const result = await purgeFact(b, X);
        const request = await purgeRequest(b, String(result.request_id));
        const carriers = (await b.events()).filter(e => e.redacted_fields?.length);
        const leaks = (await b.events()).filter(e => JSON.stringify(e.value ?? {}).toLowerCase().includes(X.toLowerCase()));
        const register = await b.engine.executeRaw<{ field: string; purge_request: string }>(`SELECT DISTINCT field, purge_request::text AS purge_request
          FROM belief_redactions WHERE source_id = $1 ORDER BY field`, [b.sourceId]);
        resolve({ request, carriers, leaks, register });
      }));
      await forced(scenario, (r: any) => {
        const byKind = Object.fromEntries((r.carriers as BeliefEvent[]).map(e => [`${e.subject_kind}:${e.event_type}`, e]));
        expect(Object.keys(byKind).sort()).toEqual(['fact:fact.revised', 'link:link.asserted', 'take:take.resolved']);
        expect(byKind['fact:fact.revised']!.value!.context).toBe(marker(r.request));
        expect(byKind['fact:fact.revised']!.redacted_fields).toEqual(['context']);
        expect(byKind['take:take.resolved']!.value!.resolved_source).toBe(marker(r.request));
        expect(byKind['take:take.resolved']!.redacted_fields).toEqual(['resolved_source']);
        expect(byKind['link:link.asserted']!.value!.context).toBe(marker(r.request));
        expect(byKind['link:link.asserted']!.redacted_fields).toEqual(['context']);
        expect(r.leaks).toEqual([]);
        expect(r.register).toEqual([{ field: 'context', purge_request: r.request }, { field: 'resolved_source', purge_request: r.request }]);
      }, redactionFault('skip_carrying_fields'));
    }, 240_000);

    test('probe 37: a context that quotes a purged claim stays the marker until an owner replaces it, and again after an agent change', async () => {
      const page = (context: string, confidence = '1.0') => beliefPage({ facts: [X, { claim: 'Acme sells widgets', context, confidence }] });
      const scenario = () => collect<Record<string, unknown>>(resolve => brain(async b => {
        const slug = 'companies/acme-example';
        await b.put(slug, page(`notes say ${X}`));
        const result = await purgeFact(b, X);
        const request = await purgeRequest(b, String(result.request_id));
        const receiptKeys = (result.stores as Array<{ store: string; items?: string[] }>).find(s => s.store === 'fact_context')?.items ?? [];
        const step = async (fn: () => Promise<unknown>) => { const mark = await b.lastId(); await fn(); return (await b.events(mark)).filter(e => e.event_type.startsWith('fact.')); };
        const confidence = await step(() => b.put(slug, page(`notes say ${X}`, '0.5')));
        const agentEdit = await step(() => b.put(slug, page(`notes say ${X} and more`, '0.5')));
        const owner = await step(() => b.engine.transaction(tx => withCoordinatedWrite(tx, [b.sourceId], async () => {
          await tx.lockPageKeys([{ sourceId: b.sourceId, slug }]);
          await withBeliefBatch(tx, { sourceId: b.sourceId, slugs: [slug], op: 'owner_edit', remote: false, ownerEdit: true },
            () => tx.executeRaw(`UPDATE facts SET context = 'owner rewrote this' WHERE source_id = $1 AND fact = 'Acme sells widgets' AND expired_at IS NULL`, [b.sourceId]));
        }, { ...TEST_WRITE_ATTRIBUTION, trust: { tier: 'operator_curated', origin: { channel: 'cli:owner_edit' } } })));
        const later = await step(() => b.put(slug, page('agent rewrote this', '0.5')));
        const [fact] = await b.engine.executeRaw<{ id: number }>(`SELECT id FROM facts WHERE source_id = $1 AND fact = 'Acme sells widgets' AND expired_at IS NULL`, [b.sourceId]);
        const preview = await previewOwnerAction(b.engine, { action: 'confirm', ref: `f${fact!.id}` });
        await applyOwnerAction(b.engine, { action: 'confirm', ref: `f${fact!.id}` }, { binding: preview.binding, confirmation: { via: 'tty' } });
        const confirmed = await step(() => b.put(slug, page('agent rewrote this', '0.25')));
        resolve({ request, receiptKeys, confidence, agentEdit, owner, later, confirmed, raises: preview.raises });
      }));
      await forced(scenario, (r: any) => {
        const ctx = (events: BeliefEvent[]) => events.map(e => [e.event_type, e.value?.context, e.redacted_fields]);
        expect(r.receiptKeys.length).toBe(2);
        expect(ctx(r.confidence)).toEqual([['fact.revised', marker(r.request), ['context']]]);
        expect(ctx(r.agentEdit)).toEqual([['fact.revised', marker(r.request), ['context']]]);
        expect(ctx(r.owner)).toEqual([['fact.revised', 'owner rewrote this', null]]);
        expect(ctx(r.later)).toEqual([['fact.revised', marker(r.request), ['context']]]);
        expect(r.raises).toBe(true);
        expect(ctx(r.confirmed)).toEqual([['fact.revised', 'agent rewrote this', null]]);
        expect(r.receiptKeys).toContain(r.confidence[0].subject_key);
      }, redactionFault('skip_live_carriers'));
    }, 240_000);

    test('review #43: a confirm releases the purge redaction in its own publication, which released_by names and the row records', async () => {
      await brain(async b => {
        const slug = 'companies/acme-example';
        const page = (context: string, confidence = '1.0') => beliefPage({ facts: [X, { claim: 'Acme sells widgets', context, confidence }] });
        await b.put(slug, page(`notes say ${X}`));
        await purgeFact(b, X);
        await b.put(slug, page('agent rewrote this', '0.5'));
        const [fact] = await b.engine.executeRaw<{ id: number }>(`SELECT id FROM facts WHERE source_id = $1 AND fact = 'Acme sells widgets' AND expired_at IS NULL`, [b.sourceId]);
        const preview = await previewOwnerAction(b.engine, { action: 'confirm', ref: `f${fact!.id}` });
        const mark = await b.lastId();
        const result = await applyOwnerAction(b.engine, { action: 'confirm', ref: `f${fact!.id}` }, { binding: preview.binding, confirmation: { via: 'tty' } });
        expect(result).toMatchObject({ status: 'confirmed', detail: { released_redactions: ['context'] } });
        const [register] = await b.engine.executeRaw<{ released_by: string }>(`SELECT released_by::text AS released_by FROM belief_redactions
          WHERE source_id = $1 AND field = 'context' AND released_hash IS NOT NULL`, [b.sourceId]);
        const confirm = (await b.events(mark)).filter(e => e.publication_id === register!.released_by);
        expect(confirm.map(e => [`${e.subject_kind}:${e.event_type}`, e.trust_tier])).toEqual([['fact:redaction.released', 'user_confirmed'], ['fact:trust.retiered', 'user_confirmed']]);
        const [row] = await b.engine.executeRaw<{ publication: string; marked: boolean }>(`SELECT f.write_origin->'owner_decision'->>'publication_id' AS publication,
            EXISTS (SELECT 1 FROM belief_commit_marks m WHERE m.publication_id::text = f.write_origin->'owner_decision'->>'publication_id') AS marked
          FROM facts f WHERE f.id = $1`, [fact!.id]);
        expect(row).toEqual({ publication: register!.released_by, marked: true });
      });
    }, 240_000);

    test('probe 38: the suppression follows replacement, adoption, transfer and a verbatim copy into an unlinked fact', async () => {
      const scenario = () => collect<Record<string, unknown>>(resolve => brain(async b => {
        const slug = 'companies/acme-example', quote = `notes say ${X}`;
        await b.put(slug, beliefPage({ facts: [{ claim: 'Acme sells widgets', context: quote }, X] }));
        await b.engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, context, source) VALUES ($1, 'people/bob-example', 'Bob runs ops', 'fact', 'world', $2, 'test')`,
          [b.sourceId, quote]);
        const result = await purgeFact(b, X);
        const request = await purgeRequest(b, String(result.request_id));
        let mark = await b.lastId();
        await b.put(slug, beliefPage({ facts: [{ claim: 'Acme sells gadgets', context: quote }] }));
        const replaced = (await b.events(mark)).filter(e => e.subject_kind === 'fact');
        mark = await b.lastId();
        await b.put('people/bob-example', beliefPage({ type: 'person', title: 'Bob Example' }));
        const adopted = (await b.events(mark)).filter(e => e.event_type === 'fact.adopted');
        const source = replaced.find(e => e.event_type === 'fact.asserted')!;
        const transferId = randomUUID();
        await b.engine.transaction(tx => appendBeliefEvents(tx, [{ sourceId: b.sourceId, incarnation: source.source_incarnation, lifetime: null, slug: 'companies/merged-example',
          subjectKind: 'fact', subjectKey: '["f","S:transfer","x"]', eventType: 'fact.transferred', trustTier: 'agent_written', visibility: 'world',
          value: { fact: 'Acme sells gadgets', context: quote }, stateHash: '', cause: { op: 'merge', from_key: source.subject_key } }], { publicationId: transferId, origin: 'live' }));
        const transferred = (await b.events(mark)).filter(e => e.publication_id === transferId);
        mark = await b.lastId();
        await b.put('notes/copy-example', beliefPage({ facts: ['Gadget orders doubled'] }));
        await b.put('notes/copy-example', beliefPage({ facts: [{ claim: 'Gadget orders doubled', context: quote }] }));
        const copied = (await b.events(mark)).filter(e => e.subject_kind === 'fact');
        resolve({ request, replaced, adopted, transferred, copied });
      }, false));
      await forced(scenario, (r: any) => {
        const ctx = (events: BeliefEvent[]) => events.map(e => [e.event_type, e.value?.context ?? null, e.redacted_fields]);
        expect(ctx(r.replaced)).toEqual([['fact.retracted', null, null], ['fact.asserted', marker(r.request), ['context']]]);
        expect(r.replaced[1].cause.replaces).toBe(r.replaced[0].subject_key);
        expect(ctx(r.adopted)).toEqual([['fact.adopted', marker(r.request), ['context']]]);
        expect(ctx(r.transferred)).toEqual([['fact.transferred', marker(r.request), ['context']]]);
        expect(ctx(r.copied)).toEqual([['fact.revised', marker(r.request), ['context']]]);
      }, redactionFault('skip_live_carriers'));
    }, 240_000);
    test('probe 27: purge-verify names the link, timeline and raw-data rows that still carry the claim', async () => {
      const scenario = () => collect<Record<string, unknown>>(resolve => brain(async b => {
        await b.put('companies/acme-example', beliefPage({ facts: [X] }));
        await b.put('people/alice-example', beliefPage({ type: 'person', title: 'Alice Example' }));
        const ids = await b.engine.transaction(tx => withCoordinatedWrite(tx, [b.sourceId], async () => {
          const [from] = await tx.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id = $1 AND slug = $2', [b.sourceId, 'people/alice-example']);
          const [to] = await tx.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id = $1 AND slug = $2', [b.sourceId, 'companies/acme-example']);
          const [link] = await tx.executeRaw<{ id: number }>(`INSERT INTO links (from_page_id, to_page_id, link_type, context) VALUES ($1, $2, 'mentions', $3) RETURNING id`, [from!.id, to!.id, `said ${X}`]);
          const [line] = await tx.executeRaw<{ id: number }>(`INSERT INTO timeline_entries (page_id, date, summary, detail) VALUES ($1, '2026-01-02', 'Visited', $2) RETURNING id`, [from!.id, `heard ${X}`]);
          const [raw] = await tx.executeRaw<{ id: number }>(`INSERT INTO raw_data (page_id, source, data) VALUES ($1, 'crm', $2::jsonb) RETURNING id`, [from!.id, JSON.stringify({ note: X })]);
          return { link: link!.id, line: line!.id, raw: raw!.id };
        }, TEST_WRITE_ATTRIBUTION));
        const result = await purgeFact(b, X);
        const stores = Object.fromEntries((result.stores as Array<{ store: string; status: string; items?: string[] }>)
          .filter(s => ['links', 'timeline_entries', 'raw_data'].includes(s.store)).map(s => [s.store, { status: s.status, items: s.items ?? null }]));
        resolve({ ids, stores });
      }));
      await forced(scenario, (r: any) => expect(r.stores).toEqual({
        links: { status: 'out_of_scope', items: [`link:${r.ids.link} people/alice-example -> companies/acme-example`] },
        timeline_entries: { status: 'out_of_scope', items: [`timeline:${r.ids.line} people/alice-example 2026-01-02`] },
        raw_data: { status: 'out_of_scope', items: [`raw_data:${r.ids.raw} people/alice-example crm`] },
      }), () => __setNamedRowProbesForTests(false));
    }, 240_000);

    test('probe 30: a page purge redacts quotes of its 40th claim, a short claim and a claim left only in historical take events', async () => {
      const many = Array.from({ length: 40 }, (_, i) => `Vault fact ${i + 1} is sealed`);
      const short = 'Code Z9', gone = 'Vault will reopen in May';
      const scenario = () => collect<Record<string, unknown>>(resolve => brain(async b => {
        const slug = 'vault/codes-example';
        await b.put(slug, beliefPage({ prose: 'Vault index.' }));
        await b.put(slug, beliefPage({ facts: [...many, short], takes: [gone] }));
        await b.put(slug, beliefPage({ facts: [...many, short] }));
        await b.put('notes/quotes-example', beliefPage({ prose: 'Quotes.' }));
        await b.put('notes/quotes-example', beliefPage({ facts: [
          { claim: 'Quote one', context: `as noted, ${many[39]}` }, { claim: 'Quote two', context: `badge: ${short}` }, { claim: 'Quote three', context: `plan: ${gone}` }] }));
        const result = await purgePage(b, slug);
        const request = await purgeRequest(b, String(result.request_id));
        const all = await b.events();
        const quotes = all.filter(e => e.slug === 'notes/quotes-example' && e.subject_kind === 'fact').map(e => [e.value?.fact, e.value?.context, e.redacted_fields]);
        const leaks = all.filter(e => [many[39]!, short, gone].some(c => JSON.stringify(e.value ?? {}).toLowerCase().includes(c.toLowerCase()))).map(e => e.id);
        resolve({ request, quotes, leaks });
      }));
      await forced(scenario, (r: any) => {
        expect(r.quotes).toEqual([['Quote one', marker(r.request), ['context']], ['Quote two', marker(r.request), ['context']], ['Quote three', marker(r.request), ['context']]]);
        expect(r.leaks).toEqual([]);
      }, redactionFault('bounded_inventory'));
    }, 240_000);

    test('probes 31 and 35: after purge, re-derivation and a backfill of the pre-purge derived page, history shows no pre-purge derived event', async () => {
      const Y = 'Acme had a strong quarter';
      const scenario = () => collect<Record<string, unknown>>(resolve => brain(async b => {
        const derivedSlug = 'notes/summary-example';
        await b.put('companies/acme-example', beliefPage({ facts: [X] }));
        await b.put(derivedSlug, beliefPage({ prose: 'Summary.' }));
        await b.put(derivedSlug, beliefPage({ facts: [Y] }));
        const [x] = await b.engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id = $1 AND fact = $2', [b.sourceId, X]);
        const [y] = await b.engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id = $1 AND fact = $2', [b.sourceId, Y]);
        await b.engine.transaction(tx => withCoordinatedWrite(tx, [b.sourceId],
          () => recordDerivationInputs(tx, { table: 'facts', id: y!.id, sourceId: b.sourceId }, [{ table: 'facts', id: x!.id }]), TEST_WRITE_ATTRIBUTION));
        const before = (await b.events()).filter(e => e.slug === derivedSlug && e.subject_kind === 'fact');
        const result = await purgeFact(b, X);
        const request = await purgeRequest(b, String(result.request_id));
        const hidden = (await b.events()).filter(e => e.event_type === 'derived.hidden');
        const mark = await b.lastId();
        await b.put(derivedSlug, beliefPage({ facts: [Y], prose: 'Re-derived.' }));
        const rederived = (await b.events(mark)).filter(e => e.subject_kind === 'fact');
        const key = before[0]!.subject_key;
        const backfillId = randomUUID();
        await b.engine.transaction(tx => appendBeliefEvents(tx, [{ sourceId: b.sourceId, incarnation: before[0]!.source_incarnation, lifetime: before[0]!.page_lifetime,
          slug: derivedSlug, stream: derivedSlug, subjectKind: 'fact', subjectKey: key, eventType: 'fact.asserted', trustTier: 'unknown', tierBasis: 'unknown',
          visibility: 'world', value: before[0]!.value, stateHash: '', claimFp: before[0]!.claim_fp, cause: { op: 'backfill' } }], { publicationId: backfillId, origin: 'backfill' }));
        const read = (await history(b, { slug: derivedSlug })).filter(e => e.subject_kind === 'fact').map(e => [e.id, e.event_type, e.origin]);
        resolve({ request, key, before: before.map(e => e.id), hidden, rederived: rederived.map(e => [e.id, e.event_type, e.subject_key]), read });
      }));
      await forced(scenario, (r: any) => {
        expect(r.hidden.map((e: BeliefEvent) => [e.subject_key, e.value, e.cause.purge_request])).toEqual([[r.key, null, r.request]]);
        expect(r.rederived.map((e: unknown[]) => e.slice(1))).toEqual([['fact.asserted', r.key]]);
        expect(r.read).toEqual([[r.hidden[0].id, 'derived.hidden', 'live'], [r.rederived[0][0], 'fact.asserted', 'live']]);
        for (const id of r.before) expect(r.read.map((e: unknown[]) => e[0])).not.toContain(id);
      }, redactionFault('skip_derived_hidden'));
    }, 240_000);
  });
}
