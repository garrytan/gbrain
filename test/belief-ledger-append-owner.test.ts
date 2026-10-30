/**
 * #7123: append_page is not an owner edit of the belief ledger (`OWNER_EDIT_OPERATIONS`, belief/ledger.ts), so an
 * owner's append never releases a purge redaction, and the ledger attributes it as an append.
 *
 * 1. Protects: a local append to a page whose fact context is under a purge redaction commits, appends no
 *    `redaction.released` event, leaves the register unreleased, and every event of its publication carries
 *    `cause.op: 'append_page'` and its request. An owner-tier append publication (the append intent, and the same row
 *    with the intent's kind stripped) gets no `ownerEdit`, so a carrying field it rewrites stays the redaction marker.
 * 2. Fails when: append_page joins OWNER_EDIT_OPERATIONS (the kind-less publication releases the redaction), or the
 *    allowlist is dropped (the forced probe below: the append publication releases it and writes the new value).
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { REDACTION_MARKER } from '../src/core/belief/keys.ts';
import { __dropOwnerEditAllowlistForTests, publicationBeliefOptions, withBeliefBatch } from '../src/core/belief/ledger.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { operations } from '../src/core/operations.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { testBackends } from './helpers/test-backends.ts';
import { beliefBrain, beliefEngineCase, beliefPage, type BeliefBrain } from './helpers/belief-ledger.ts';

afterEach(() => { __dropOwnerEditAllowlistForTests(false); });

const X = 'Door code is 4417';
const SLUG = 'companies/acme-example';
const purgeOp = operations.find(o => o.name === 'purge_fact')!;

async function purgeFact(b: BeliefBrain, claim: string): Promise<string> {
  const [row] = await b.engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id = $1 AND fact = $2 AND expired_at IS NULL ORDER BY id LIMIT 1', [b.sourceId, claim]);
  const dry = await purgeOp.handler(b.ctx, { id: Number(row!.id), dry_run: true }) as Record<string, any>;
  const done = await purgeOp.handler(b.ctx, { id: Number(row!.id), confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: randomUUID() }) as Record<string, any>;
  return await requestOf(b, String(done.request_id));
}

const requestOf = async (b: BeliefBrain, clientRequestId: string) =>
  (await b.engine.executeRaw<{ id: string }>('SELECT id::text AS id FROM persistence_requests WHERE request_id = $1::uuid', [clientRequestId]))[0]!.id;
const releasedCount = async (b: BeliefBrain) =>
  (await b.engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM belief_redactions WHERE source_id = $1 AND released_hash IS NOT NULL', [b.sourceId]))[0]!.n;

/** Runs a brain scenario to completion (teardown included) and returns what it reported. */
async function collect<T>(run: (report: (value: T) => void) => Promise<void>): Promise<T> {
  let out: T | undefined;
  await run(value => { out = value; });
  return out as T;
}

/** A page whose second fact's context quotes the claim the scenario purges, so that context is under a redaction. */
const seeded = async (b: BeliefBrain) => {
  await b.put(SLUG, beliefPage({ facts: [X, { claim: 'Acme sells widgets', context: `notes say ${X}` }] }));
  return purgeFact(b, X);
};

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe(`append_page and the belief ledger owner edit (${engineCase.name})`, () => {
    const brain = (run: (b: BeliefBrain) => Promise<void>) => beliefBrain(run, { managed: true, databaseUrl: engineCase.databaseUrl });

    test('an owner\'s append next to a purged claim releases nothing and is attributed to append_page', async () => {
      const r = await collect<Record<string, unknown>>(report => brain(async b => {
        await seeded(b);
        const mark = await b.lastId();
        const clientRequest = randomUUID();
        await b.op('append_page', { slug: SLUG, text: 'Later note about the widget plan.', region: 'auto', separator: 'auto', request_id: clientRequest });
        const request = await requestOf(b, clientRequest);
        const [state] = await b.engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE id = $1::uuid', [request]);
        const events = await b.events(mark);
        const own = events.filter(e => e.publication_id === request);
        report({ state: state!.state, appended: (await b.engine.executeRaw<{ t: string }>('SELECT compiled_truth AS t FROM pages WHERE source_id = $1 AND slug = $2', [b.sourceId, SLUG]))[0]!.t.includes('Later note'),
          released: await releasedCount(b), releaseEvents: events.filter(e => e.event_type === 'redaction.released').length,
          published: own.map(e => [e.subject_kind, e.event_type, e.writer_tier]), causes: [...new Set(own.map(e => JSON.stringify(e.cause)))].map(c => JSON.parse(c)),
          leaks: events.filter(e => JSON.stringify(e.value ?? {}).includes(X)).length, request });
      }));
      expect(r).toEqual({ state: 'committed', appended: true, released: 0, releaseEvents: 0, published: [['page', 'page.published', null]],
        causes: [{ op: 'append_page', request: r.request }], leaks: 0, request: r.request });
    }, 240_000);

    test('an owner-tier append publication gets no ownerEdit, so a field it rewrites stays redacted (forced probe: dropping the allowlist releases it)', async () => {
      const run = (forced: boolean) => collect<Record<string, unknown>>(report => brain(async b => {
        const purge = await seeded(b);
        __dropOwnerEditAllowlistForTests(forced);
        const fact = `source_id = $1 AND fact = 'Acme sells widgets' AND expired_at IS NULL`;
        const intent = { kind: 'append_page', text: 'Later note.', region: 'auto', separator: 'auto', preconditions: {} };
        const out: Record<string, unknown> = { marker: REDACTION_MARKER(purge) };
        for (const [name, shape] of [['append', intent], ['kindless', {}]] as const) {
          const options = publicationBeliefOptions({ id: randomUUID(), source_id: b.sourceId, slug: SLUG, operation: 'append_page', authority: { remote: false }, intent: shape });
          const mark = await b.lastId();
          await b.engine.transaction(tx => withCoordinatedWrite(tx, [b.sourceId], async () => {
            await tx.lockPageKeys([{ sourceId: b.sourceId, slug: SLUG }]);
            await withBeliefBatch(tx, options, () => tx.executeRaw(`UPDATE facts SET context = '${name} rewrote it' WHERE ${fact}`, [b.sourceId]));
          }, { ...TEST_WRITE_ATTRIBUTION, trust: { tier: 'operator_curated', origin: { channel: 'append_page' } } }));
          const events = await b.events(mark);
          out[name] = { ownerEdit: options.ownerEdit === true, contexts: events.filter(e => e.event_type.startsWith('fact.')).map(e => e.value?.context),
            causes: [...new Set(events.filter(e => e.event_type.startsWith('fact.')).map(e => e.cause.op))] };
          if (forced) break;
        }
        out.released = await releasedCount(b);
        report(out);
      }));
      const r = await run(false);
      const m = r.marker;
      expect(r).toEqual({ marker: m, append: { ownerEdit: false, contexts: [m], causes: ['append_page'] }, kindless: { ownerEdit: false, contexts: [m], causes: ['append_page'] }, released: 0 });
      const forced = await run(true);
      expect(forced).toEqual({ marker: forced.marker, append: { ownerEdit: true, contexts: ['append rewrote it'], causes: ['append_page'] }, released: 1 });
    }, 240_000);
  });
}
