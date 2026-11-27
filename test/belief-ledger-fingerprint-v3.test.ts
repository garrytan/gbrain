/**
 * The belief ledger keeps one subject per claim across the fact fingerprint change (migration fact_fingerprint_v3).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a claim the ledger recorded under the fingerprint Postgres computed before v353 keeps its subject after
 *    the upgrade: a revision reads as 'changed' with its before value, a purge redacts the whole recorded history, a
 *    later private flip still hides the earlier world history from a remote reader, a purge recorded before the
 *    upgrade still tombstones the claim, and a restore replays a purge made before or after the upgrade onto the claim's
 *    recorded subject. Every engine gives the same answers.
 *  - Regression: Postgres folded the locale's [[:space:]] before v353 (U+0085 kept, U+1680 folded), so a claim holding
 *    one of those characters got a new fingerprint at the upgrade, and every ledger match keyed on the old one missed.
 *  - Why existing coverage misses it: the ledger probes write no claim holding a character the two folds disagree on,
 *    and no probe writes ledger rows before the fingerprint migration; PGLite's [[:space:]] already is the explicit
 *    list, so only a Postgres arm can show it.
 *  - Seam: before the upgrade, gbrain_fact_fingerprint is replaced by the pre-v353 fold spelled out in this file (the
 *    locale's [[:space:]]), independent of the source under test, then v353 is run again; the process-local
 *    fingerprint cache is cleared at the upgrade, as a restart does. Synthetic claims only.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendBeliefEvents, type BeliefEventDraft } from '../src/core/belief/append.ts';
import { beliefChanges } from '../src/core/belief/changes.ts';
import { readBeliefHistory } from '../src/core/belief/history.ts';
import { purgeLinesFromDatabase, replayPurges } from '../src/core/belief/purge-mirror.ts';
import { __fingerprintCacheForTests } from '../src/core/belief/state.ts';
import { FINGERPRINT_PUNCTUATION } from '../src/core/facts/withdrawal-schema.ts';
import { operations } from '../src/core/operations.ts';
import { MIGRATIONS } from '../src/core/schema-migrations/registry.generated.ts';
import { testBackends } from './helpers/test-backends.ts';
import { beliefBrain, beliefEngineCase, beliefPage, type BeliefBrain } from './helpers/belief-ledger.ts';

const NEL = 'Next\u0085line claim of Acme';
const OGHAM = 'Ogham\u1680space claim of Acme';
const slug = 'companies/acme-example';
const purgeOp = operations.find(o => o.name === 'purge_fact')!;

/** The pre-v353 fingerprint: Postgres's locale [[:space:]] fold. */
const LEGACY_FINGERPRINT = `CREATE OR REPLACE FUNCTION gbrain_fact_fingerprint(claim TEXT) RETURNS TEXT LANGUAGE SQL IMMUTABLE STRICT AS $fn$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.regexp_replace(
    pg_catalog.regexp_replace(pg_catalog.translate(pg_catalog.lower(claim), '${FINGERPRINT_PUNCTUATION.replace(/'/g, "''")}',
    '${' '.repeat([...FINGERPRINT_PUNCTUATION].length)}'), '[[:space:]]+', ' ', 'g'), '\\.(?=[. ]|$)', ' ', 'g'), ' +', ' ', 'g'), ' '), 'UTF8')), 'hex')
$fn$`;

const legacy = async (b: BeliefBrain) => { await b.engine.executeRaw(LEGACY_FINGERPRINT); clearCache(); };
const clearCache = () => { const c = __fingerprintCacheForTests(); c.fingerprints.clear(); c.streams.clear(); };
/** The upgrade: v353 again, then a fresh process's empty fingerprint cache. */
async function upgrade(b: BeliefBrain): Promise<void> {
  const migration = MIGRATIONS.find(m => m.name === 'fact_fingerprint_v3')!;
  await b.engine.runMigration(migration.version, migration.sql);
  clearCache();
}

afterEach(clearCache);

const pause = () => new Promise(resolve => setTimeout(resolve, 25));
const at = async (b: BeliefBrain) => {
  await pause();
  const t = new Date((await b.engine.executeRaw<{ t: string }>('SELECT clock_timestamp() AS t'))[0]!.t).toISOString();
  await pause();
  return t;
};

async function purgeFact(b: BeliefBrain, claim: string): Promise<Record<string, any>> {
  const [row] = await b.engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id = $1 AND fact = $2 AND expired_at IS NULL ORDER BY id LIMIT 1', [b.sourceId, claim]);
  const dry = await purgeOp.handler(b.ctx, { id: Number(row!.id), dry_run: true }) as Record<string, any>;
  return await purgeOp.handler(b.ctx, { id: Number(row!.id), confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: randomUUID() }) as Record<string, any>;
}

/** The restored copy's row of `claim` (a database that predates the purge), written past the managed-writer guard as a restore does. */
async function restoreClaim(b: BeliefBrain, claim: string): Promise<void> {
  await b.engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.write_sources', $1, true)", [JSON.stringify([b.sourceId])]);
    await tx.executeRaw(`INSERT INTO facts(source_id, entity_slug, fact, kind, visibility, source, source_markdown_slug) VALUES ($1, $2, $3, 'fact', 'world', 'manual', $2)`,
      [b.sourceId, slug, claim]);
  });
}

/** The page first, so the claims below are asserted as fact events, not only in the creation body. */
const seed = (b: BeliefBrain) => b.put(slug, beliefPage({ facts: ['Acme sells widgets'] }));
const factEvents = async (b: BeliefBrain, claim: string) => (await b.events()).filter(e => e.subject_kind === 'fact' && e.slug === slug
  && (e.value?.fact === claim || e.value === null));

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe(`belief ledger across the fingerprint upgrade (${engineCase.name})`, () => {
    const brain = (run: (b: BeliefBrain) => Promise<void>) => beliefBrain(run, { managed: true, databaseUrl: engineCase.databaseUrl });

    test('a claim recorded before the upgrade keeps its subject: a revision after it reads as changed', () => brain(async b => {
      await legacy(b);
      await seed(b);
      await b.put(slug, beliefPage({ facts: ['Acme sells widgets', { claim: NEL, confidence: '0.6' }, { claim: OGHAM, confidence: '0.6' }] }));
      const first = (await b.events()).filter(e => e.subject_kind === 'fact' && e.event_type === 'fact.asserted');
      expect(first).toHaveLength(2);
      await upgrade(b);
      const t0 = await at(b);
      const mark = await b.lastId();
      await b.put(slug, beliefPage({ facts: ['Acme sells widgets', { claim: NEL, confidence: '0.9' }, { claim: OGHAM, confidence: '0.9' }] }));
      const t1 = await at(b);
      const after = (await b.events(mark)).filter(e => e.subject_kind === 'fact');
      expect(after.map(e => e.event_type)).toEqual(['fact.revised', 'fact.revised']);
      expect(after.map(e => e.subject_key).sort()).toEqual(first.map(e => e.subject_key).sort());
      expect(after.map(e => e.claim_fp).sort()).toEqual(first.map(e => e.claim_fp).sort());
      const facts = (await beliefChanges(b.engine, { sourceId: b.sourceId, since: t0, until: t1, remote: false })).changes.filter(c => c.kind === 'fact');
      expect(facts.map(c => [c.change, c.subject.claim, c.before_known, c.before?.confidence ?? null, c.after?.confidence ?? null]).sort()).toEqual([
        ['changed', NEL, true, 0.6, 0.9], ['changed', OGHAM, true, 0.6, 0.9]]);
    }), 240_000);

    test('a purge after the upgrade redacts the history recorded before it', () => brain(async b => {
      await legacy(b);
      await seed(b);
      await b.put(slug, beliefPage({ facts: ['Acme sells widgets', { claim: NEL, confidence: '0.6' }] }));
      await b.put(slug, beliefPage({ facts: ['Acme sells widgets', { claim: NEL, confidence: '0.7' }] }));
      const key = (await factEvents(b, NEL))[0]!.subject_key;
      await upgrade(b);
      await purgeFact(b, NEL);
      const history = await readBeliefHistory(b.engine, { sourceId: b.sourceId, subjectKey: key, remote: false });
      expect(history.map(e => [e.event_type, e.value, e.purged])).toEqual([['fact.asserted', null, true], ['fact.revised', null, true], ['fact.purged', null, true]]);
      expect(JSON.stringify(await b.events())).not.toContain('Next\u0085line');
    }), 240_000);

    test('a claim made private before the upgrade stays hidden from a remote reader of the earlier world body', () => brain(async b => {
      await legacy(b);
      const t0 = await at(b);
      await b.put(slug, beliefPage({ facts: ['Acme sells widgets', NEL] }));
      const t1 = await at(b);
      await b.put(slug, beliefPage({ facts: ['Acme sells widgets', { claim: NEL, visibility: 'private' }] }));
      await upgrade(b);
      const local = await beliefChanges(b.engine, { sourceId: b.sourceId, since: t0, until: t1, remote: false });
      expect(JSON.stringify(local)).toContain('Next\u0085line');
      const remote = await beliefChanges(b.engine, { sourceId: b.sourceId, since: t0, until: t1, remote: true });
      expect(JSON.stringify(remote)).not.toContain('Next\u0085line');
    }), 240_000);

    test('a claim made private after the upgrade hides its world history recorded before it from a remote reader', () => brain(async b => {
      await legacy(b);
      await seed(b);
      await b.put(slug, beliefPage({ facts: ['Acme sells widgets', NEL] }));
      await upgrade(b);
      await b.put(slug, beliefPage({ facts: ['Acme sells widgets', { claim: NEL, visibility: 'private' }] }));
      const local = await readBeliefHistory(b.engine, { sourceId: b.sourceId, slug, remote: false });
      expect(JSON.stringify(local)).toContain('Next\u0085line');
      const remote = await readBeliefHistory(b.engine, { sourceId: b.sourceId, slug, remote: true });
      expect(JSON.stringify(remote)).not.toContain('Next\u0085line');
    }), 240_000);

    test('a restore replays a purge made after the upgrade onto the subject the claim recorded before it', () => brain(async b => {
      await legacy(b);
      await seed(b);
      await b.put(slug, beliefPage({ facts: ['Acme sells widgets', NEL] }));
      const key = (await factEvents(b, NEL))[0]!.subject_key;
      await upgrade(b);
      await purgeFact(b, NEL);
      const lines = await purgeLinesFromDatabase(b.engine);
      await b.engine.executeRaw('DELETE FROM fact_purges WHERE source_id = $1', [b.sourceId]);
      await b.engine.executeRaw('DELETE FROM take_purges WHERE source_id = $1', [b.sourceId]);
      await restoreClaim(b, NEL);
      const before = await b.lastId();
      const replay = await replayPurges(b.engine, { lines, archivedAt: new Date(Date.now() - 60_000).toISOString(), apply: true });
      expect(replay.replays.map(r => [r.scope, r.outcome])).toEqual([['fact', 'complete']]);
      expect((await b.events(before)).filter(e => e.event_type === 'fact.purged').map(e => e.subject_key)).toEqual([key]);
    }), 240_000);

    test('a purge recorded before the upgrade still tombstones the claim, and a restore replays it', () => brain(async b => {
      await legacy(b);
      await seed(b);
      await b.put(slug, beliefPage({ facts: ['Acme sells widgets', NEL] }));
      const asserted = (await factEvents(b, NEL))[0]!;
      await purgeFact(b, NEL);
      await upgrade(b);
      const [current] = await b.engine.executeRaw<{ fp: string }>('SELECT gbrain_fact_fingerprint($1) AS fp', [NEL]);
      const publicationId = randomUUID();
      const draft: BeliefEventDraft = { sourceId: b.sourceId, incarnation: asserted.source_incarnation, lifetime: asserted.page_lifetime, slug, stream: slug,
        subjectKind: 'fact', subjectKey: asserted.subject_key, eventType: 'fact.asserted', trustTier: 'unknown', tierBasis: 'unknown', visibility: 'world',
        value: { fact: NEL, context: null }, stateHash: '', claimFp: current!.fp, cause: { op: 'backfill' } };
      await b.engine.transaction(tx => appendBeliefEvents(tx, [draft], { publicationId, origin: 'backfill' }));
      const backfilled = (await b.events()).filter(e => e.publication_id === publicationId);
      expect(backfilled.map(e => [e.event_type, e.value, e.purged])).toEqual([['fact.asserted', null, true]]);

      // The restore: a brain whose copy predates the purge (the claim back, no tombstone) replays the purge from the pre-restore database.
      const lines = await purgeLinesFromDatabase(b.engine);
      expect(lines.filter(l => l.kind === 'intent')).toHaveLength(1);
      await b.engine.executeRaw('DELETE FROM fact_purges WHERE source_id = $1', [b.sourceId]);
      await b.engine.executeRaw('DELETE FROM take_purges WHERE source_id = $1', [b.sourceId]);
      await restoreClaim(b, NEL);
      const before = await b.lastId();
      const replay = await replayPurges(b.engine, { lines, archivedAt: new Date(Date.now() - 60_000).toISOString(), apply: true });
      expect(replay.replays.map(r => [r.scope, r.outcome])).toEqual([['fact', 'complete']]);
      expect((await b.engine.executeRaw('SELECT 1 FROM facts WHERE source_id = $1 AND fact = $2', [b.sourceId, NEL])).length).toBe(0);
      const replayed = (await b.events(before)).filter(e => e.event_type === 'fact.purged');
      expect(replayed.map(e => e.subject_key)).toEqual([asserted.subject_key]);
    }), 240_000);
  });
}
