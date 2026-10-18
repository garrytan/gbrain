/**
 * Belief ledger trust, withdrawal and database-only writer probes
 * (docs/designs/BELIEF_LEDGER.md section 11: 8, 20, 23, 24, 25, 26, 28, plus
 * forget's withdrawal events and preimages, section 10). Each asserts exact
 * event types, keys, tiers and values on PGLite and on Postgres when
 * DATABASE_URL is set, and each has a forced probe: a deliberately broken
 * emitter that must make the assertion fail.
 *
 * The brain is a managed one whose probe source is database-only (no
 * worktree), so remote agent writes, owner decisions and database-only writes
 * all run through their production paths.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { registerLocalWriter, readLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import type { Principal } from '../src/core/persistence/model.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { withCoordinatedWrite, withTrustBackfill, withTrustPromotion } from '../src/core/persistence/context.ts';
import { listTrustProposals } from '../src/core/trust/proposals.ts';
import { decideTrustProposal } from '../src/core/trust/decide.ts';
import { recordDerivationInputs } from '../src/core/facts/derivation-inputs.ts';
import { setRowTier } from '../src/core/trust/page-handlers.ts';
import { runTrustBackfill } from '../src/core/trust/backfill.ts';
import { enableBeliefLedger } from '../src/core/belief/coverage.ts';
import { __setBeliefEmitterFaultForTests, type BeliefEventDraft } from '../src/core/belief/append.ts';
import { lifetimeRef, pageKey } from '../src/core/belief/keys.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { waitForValue } from './helpers/wait-for.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { testBackends } from './helpers/test-backends.ts';
import { beliefBrain, beliefEngineCase, beliefPage, readEvents, shape, type BeliefEvent } from './helpers/belief-ledger.ts';
import { unmarkedPublications } from '../src/core/belief/coverage-report.ts';
import { forgetFactInFence } from '../src/core/facts/forget.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-belief-trust-'));
const quiet = { info() {}, warn() {}, error() {} };
const owner = { confirmation: { via: 'tty' as const } };

afterEach(() => __setBeliefEmitterFaultForTests(null));
afterAll(() => rmSync(home, { recursive: true, force: true }));

interface Brain { engine: BrainEngine; sourceId: string; remote: OperationContext; local: OperationContext }

const run = (ctx: OperationContext, op: string, params: Record<string, unknown>) =>
  operationsByName[op]!.handler(ctx, { request_id: randomUUID(), ...params }) as Promise<Record<string, any>>;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as { code?: string; message: string });
const lastId = async (b: Brain) => Number((await b.engine.executeRaw<{ id: number | null }>('SELECT max(id) AS id FROM belief_events WHERE source_id = $1', [b.sourceId]))[0]?.id ?? 0);
/** The events `fn` appended. */
async function since(b: Brain, fn: () => Promise<unknown>): Promise<BeliefEvent[]> {
  const mark = await lastId(b);
  await fn();
  return readEvents(b.engine, b.sourceId, mark);
}
const coordinated = (b: Brain, fn: (tx: BrainEngine) => Promise<unknown>) =>
  b.engine.transaction(tx => withCoordinatedWrite(tx, [b.sourceId], () => fn(tx), TEST_WRITE_ATTRIBUTION));
/** The owner confirms a row (CEO-9), through the promotion seam. */
const confirm = (b: Brain, table: string, id: number) =>
  coordinated(b, tx => withTrustPromotion(tx, 'user_confirmed', () => tx.executeRaw(`UPDATE ${table} SET trust_tier='user_confirmed' WHERE id=$1`, [id])));
/** A row classified operator_curated through the deterministic backfill seam (CEO-10). */
const curate = (b: Brain, table: string, id: number) => coordinated(b, async tx => {
  await withTrustPromotion(tx, 'user_confirmed', () => tx.executeRaw(`UPDATE ${table} SET trust_tier='unknown' WHERE id=$1`, [id]));
  await withTrustBackfill(tx, () => tx.executeRaw(`UPDATE ${table} SET trust_tier='operator_curated' WHERE id=$1`, [id]));
});
const pageId = async (b: Brain, slug: string) => Number((await b.engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [b.sourceId, slug]))[0]!.id);
const factId = async (b: Brain, claim: string) => Number((await b.engine.executeRaw<{ id: number }>(
  'SELECT id FROM facts WHERE source_id=$1 AND fact=$2 AND expired_at IS NULL ORDER BY id DESC LIMIT 1', [b.sourceId, claim]))[0]!.id);
const takeRows = async (b: Brain, slug: string) => b.engine.executeRaw<{ id: number; row_num: number; claim: string; active: boolean; trust_tier: string }>(
  'SELECT id::int AS id, row_num, claim, active, trust_tier FROM takes WHERE page_id=$1 ORDER BY row_num', [await pageId(b, slug)]);
const content = async (b: Brain, slug: string) => operationsByName.get_page!.handler(b.local, { slug, include_content: true }) as Promise<Record<string, any>>;
/** The newest event naming `key`, before this point. */
const latest = async (b: Brain, key: string) => (await readEvents(b.engine, b.sourceId)).filter(e => e.subject_key === key).at(-1)!;
const parts = (e: BeliefEvent) => JSON.parse(e.subject_key) as unknown[];
const fault = (fn: (drafts: BeliefEventDraft[]) => BeliefEventDraft[]) => __setBeliefEmitterFaultForTests(fn);
const dropType = (type: string, kind?: string) => (drafts: BeliefEventDraft[]) => drafts.filter(d => d.eventType !== type || (kind !== undefined && d.subjectKind !== kind));
const retype = (from: string, to: string) => (drafts: BeliefEventDraft[]) => drafts.map(d => d.eventType === from ? { ...d, eventType: to } : d);

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe(`belief ledger trust and identity writers (${engineCase.name})`, () => {
    let engine: BrainEngine;
    let close: (() => Promise<void>) | undefined;
    beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
      configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
      if (engineCase.databaseUrl) ({ engine, close } = await isolatedPersistencePostgres(engineCase.databaseUrl));
      else { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite; }
    }), 120_000);
    afterAll(async () => { resetGateway(); await disposePersistenceConsumer(engine); if (close) await close(); else await engine.disconnect(); });

    /** A database-only source with active coverage, a local CLI context and a remote agent token. */
    async function brain(opts: { enable?: boolean } = {}): Promise<Brain> {
      const sourceId = `belief-trust-${randomUUID().slice(0, 8)}`;
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      await registerLocalWriter(engine, 'cli');
      const minted = await mintLegacyToken(engine, { name: `token-${sourceId}`, scopes: ['read', 'write'], sourceGrant: [sourceId], takesHolders: ['world'] });
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      await readLocalWriter(engine, 'cli');
      if (opts.enable !== false) await enableBeliefLedger(engine, sourceId);
      const base = { engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId, dryRun: false, logger: quiet };
      return { engine, sourceId,
        remote: { ...base, remote: true, transport: 'http', takesHoldersAllowList: ['world'],
          auth: { token: '', clientId: minted.id, principal: { kind: 'legacy_token', id: minted.id } as Principal, sourceId, allowedSources: [sourceId], scopes: ['read', 'write'] } } as unknown as OperationContext,
        local: { ...base, remote: false } as unknown as OperationContext };
    }
    const withHome = (fn: () => Promise<void>) => () => withEnv({ GBRAIN_HOME: home }, fn);

    test('forget: fact.withdrawn and page.view_changed with the pre-withdrawal body kept as a version; materialization is a second view change', withHome(async () => {
      const b = await brain();
      const slug = 'companies/acme-example';
      await run(b.local, 'put_page', { slug, content: beliefPage({ facts: ['Acme raised a seed round', 'Acme has ten staff'] }) });
      const published = (await readEvents(b.engine, b.sourceId)).find(e => e.event_type === 'page.published')!;
      const lifetime = published.page_lifetime!;
      const before = String((await content(b, slug)).revision);
      const staff = await factId(b, 'Acme has ten staff');
      const check = (events: BeliefEvent[], revisionBefore: string) => {
        const forget = events.filter(e => e.cause.op === 'forget');
        expect(shape(forget)).toEqual(['page:page.view_changed', 'fact:fact.withdrawn']);
        expect(forget[0]!.value).toMatchObject({ revision_before: revisionBefore });
        expect(forget[0]!.subject_key).toBe(pageKey(lifetime));
        expect(parts(forget[1]!).slice(0, 3)).toEqual(['f', lifetimeRef(lifetime), 2]);
        expect(forget[1]!).toMatchObject({ value: null, trust_tier: 'agent_written', page_lifetime: lifetime });
        return forget;
      };
      const mark = await lastId(b);
      await run(b.local, 'forget', { id: String(staff) });
      const forget = check(await readEvents(b.engine, b.sourceId, mark), before);
      const after = String(forget[0]!.value!.revision_after);
      expect(after).not.toBe(before);
      // The effect worker materializes the body at the withdrawal's revision: one more view change, and its preimage version.
      const materialized = await waitForValue(async () => (await readEvents(b.engine, b.sourceId, mark)).find(e => e.cause.op === 'withdrawal_materialize'),
        { timeoutMs: 30_000, label: 'withdrawal materialization' });
      expect(materialized).toMatchObject({ event_type: 'page.view_changed', subject_key: pageKey(lifetime), value: { materialized: true, revision_before: after, revision_after: after } });
      const versions = await b.engine.executeRaw<{ knowledge_revision: string; compiled_truth: string }>(
        'SELECT knowledge_revision::text AS knowledge_revision, compiled_truth FROM page_versions WHERE page_id=$1 ORDER BY id', [await pageId(b, slug)]);
      expect(versions.map(v => v.knowledge_revision)).toEqual([before, after]);
      expect(versions[0]!.compiled_truth).toContain('Acme has ten staff');
      // Forced probe: an emitter that records the withdrawal as a plain retraction is caught.
      fault(retype('fact.withdrawn', 'fact.retracted'));
      const seed = await factId(b, 'Acme raised a seed round');
      const current = String((await content(b, slug)).revision);
      const forced = await since(b, () => run(b.local, 'forget', { id: String(seed) }));
      expect(() => check(forced, current)).toThrow();
    }), 120_000);

    test('review #25: the withdrawal, its materialization and an unmanaged forget each leave a commit mark', withHome(async () => {
      const b = await brain();
      const slug = 'companies/acme-example';
      await run(b.local, 'put_page', { slug, content: beliefPage({ facts: ['Acme raised a seed round', 'Acme has ten staff'] }) });
      const mark = await lastId(b);
      await run(b.local, 'forget', { id: String(await factId(b, 'Acme has ten staff')) });
      await waitForValue(async () => (await readEvents(b.engine, b.sourceId, mark)).find(e => e.cause.op === 'withdrawal_materialize'), { timeoutMs: 30_000, label: 'withdrawal materialization' });
      const ops = new Set((await readEvents(b.engine, b.sourceId, mark)).map(e => e.cause.op));
      expect([...ops].sort()).toEqual(['forget', 'withdrawal_materialize']);
      expect(await unmarkedPublications(b.engine, b.sourceId)).toEqual([]);
      await beliefBrain(async u => {
        const remembered = await operationsByName.remember!.handler(u.ctx, { fact: 'Dana example likes tea', provenance: 'notes', entity: 'people/dana-example', request_id: randomUUID() }) as Record<string, any>;
        const row = { id: Number(remembered.id) };
        const before = await u.lastId();
        // The legacy fence path (`forgetFactInFence`), which records the withdrawal in its own maintenance transaction.
        expect((await forgetFactInFence(u.engine, Number(row!.id), { sourceId: u.sourceId })).ok).toBe(true);
        expect((await u.events(before)).filter(e => e.event_type === 'fact.withdrawn')).toHaveLength(1);
        expect(await unmarkedPublications(u.engine, u.sourceId)).toEqual([]);
      }, { databaseUrl: engineCase.databaseUrl });
    }), 180_000);

    test('probe 8: a lower-tier fence rewrite, remember.replaces, takes_supersede and a refused remote forget each append trust.contested with the proposal', withHome(async () => {
      const b = await brain();
      const slug = 'companies/acme-example';
      await run(b.local, 'put_page', { slug, content: beliefPage({ facts: ['Acme raised a seed round', 'Acme has ten staff'] }) });
      await run(b.local, 'takes_add', { slug, claim: 'Acme will win its market', kind: 'bet', holder: 'world', weight: 0.6 });
      const staff = await factId(b, 'Acme has ten staff');
      await confirm(b, 'facts', staff);
      const staffKey = (await readEvents(b.engine, b.sourceId)).find(e => e.event_type === 'page.published')!;
      const lifetime = staffKey.page_lifetime!;
      const contested = (events: BeliefEvent[], kind: string, ref: string) => {
        const e = events.find(x => x.event_type === 'trust.contested' && x.subject_kind === kind);
        expect(e).toBeDefined();
        expect(e!).toMatchObject({ trust_tier: 'user_confirmed', writer_tier: 'agent_written', value: null });
        expect(e!.cause.proposal).toBe(ref);
        return e!;
      };
      // A lower-tier rewrite that drops the confirmed fence row: the row stays, the event names it, nothing retracts it.
      const current = await operationsByName.get_page!.handler(b.remote, { slug, include_content: true }) as Record<string, any>;
      const edited = String(current.content).split('\n').filter(line => !line.includes('Acme has ten staff')).join('\n');
      let put: Record<string, any> = {};
      const fence = await since(b, async () => { put = await run(b.remote, 'put_page', { slug, content: edited, expected_revision: current.revision }); });
      const ref = put.contested?.proposal_ref ?? put.contested?.proposal_refs?.[0];
      expect(ref).toMatch(/^tp\d+$/);
      const fenceEvent = contested(fence, 'fact', ref);
      expect(parts(fenceEvent).slice(0, 3)).toEqual(['f', lifetimeRef(lifetime), 2]);
      expect(fence.filter(e => e.subject_key === fenceEvent.subject_key).map(e => e.event_type)).toEqual(['trust.contested']);
      // remember.replaces of a confirmed database-only fact.
      const old = await run(b.local, 'remember', { fact: 'Bob example likes tea', provenance: 'owner', entity: 'people/bob-example' });
      await confirm(b, 'facts', Number(old.id));
      let agent: Record<string, any> = {};
      const remember = await since(b, async () => { agent = await run(b.remote, 'remember', { fact: 'Bob example likes coffee', provenance: 'web', entity: 'people/bob-example', replaces: String(old.id) }); });
      expect(shape(remember)).toEqual(['fact:trust.contested', 'fact:fact.asserted']);
      const rememberEvent = contested(remember, 'fact', agent.contested.proposal_ref);
      expect(rememberEvent.cause.guard).toBe('remember.replaces');
      expect(remember[1]!).toMatchObject({ trust_tier: 'agent_written', value: { fact: 'Bob example likes coffee' } });
      // takes_supersede of a confirmed take: contested plus the new take asserted.
      const [take] = await takeRows(b, slug);
      await confirm(b, 'takes', take!.id);
      let superseded: Record<string, any> = {};
      const takes = await since(b, async () => { superseded = await run(b.remote, 'takes_supersede', { slug, row_num: take!.row_num, claim: 'Acme will lose its market' }); });
      expect(shape(takes).sort()).toEqual(['page:page.published', 'take:take.asserted', 'take:trust.contested']);
      expect(contested(takes, 'take', superseded.contested.proposal_ref).cause.guard).toBe('takes_supersede');
      expect(takes.find(e => e.event_type === 'take.asserted')!.value).toMatchObject({ claim: 'Acme will lose its market' });
      // A refused remote forget: its own transaction records the contest, and nothing is withdrawn.
      let refused: { code?: string; message: string } | null = null;
      const forget = await since(b, async () => { refused = await refusal(run(b.remote, 'forget', { id: String(old.id) })); });
      expect(refused!.message).toContain('forget_requires_owner');
      const forgetRef = /Proposal (tp\d+)/.exec(refused!.message)![1]!;
      expect(shape(forget)).toEqual(['fact:trust.contested']);
      expect(contested(forget, 'fact', forgetRef).cause).toMatchObject({ guard: 'remote_forget', refused: 'forget_requires_owner' });
      expect(forget[0]!.subject_key).toBe(rememberEvent.subject_key);
      // Forced probe: an emitter that drops trust.contested is caught on each path.
      fault(dropType('trust.contested'));
      const another = await run(b.local, 'remember', { fact: 'Bob example likes jazz', provenance: 'owner', entity: 'people/bob-example' });
      await confirm(b, 'facts', Number(another.id));
      const forcedForget = await since(b, () => refusal(run(b.remote, 'forget', { id: String(another.id) })));
      expect(() => contested(forcedForget, 'fact', 'tp0')).toThrow();
      const forcedRemember = await since(b, () => run(b.remote, 'remember', { fact: 'Bob example likes rock', provenance: 'web', entity: 'people/bob-example', replaces: String(another.id) }));
      expect(() => expect(shape(forcedRemember)).toEqual(['fact:trust.contested', 'fact:fact.asserted'])).toThrow();
    }), 180_000);

    test('probes 24 and 28: every destructive path on a more trusted take or row leaves it, files a proposal and appends trust.contested; only the owner accept retracts', withHome(async () => {
      const b = await brain();
      const slug = 'people/gina-example';
      await run(b.local, 'put_page', { slug, content: `${beliefPage({ type: 'person', title: 'Gina', facts: ['Gina lives in Lisbon'] })}\n## Timeline\n\n- **2026-01-05** | note — Gina joined acme-example\n  Joined as an advisor.\n` });
      for (const claim of ['Gina will join acme-example', 'Gina moves to Lisbon', 'Gina ships the beta', 'Gina runs a marathon']) {
        await run(b.local, 'takes_add', { slug, claim, kind: 'bet', holder: 'world', weight: 0.6 });
      }
      const takes = await takeRows(b, slug);
      for (const take of takes) await confirm(b, 'takes', take.id);
      await confirm(b, 'facts', await factId(b, 'Gina lives in Lisbon'));
      const [timeline] = await b.engine.executeRaw<{ id: number }>('SELECT id::int AS id FROM timeline_entries WHERE page_id=$1', [await pageId(b, slug)]);
      await confirm(b, 'timeline_entries', timeline!.id);
      // One agent rewrite: take 1 omitted, take 2 replaced in place, take 3 struck (active = false), the fact row omitted, the timeline detail replaced.
      const current = await content(b, slug);
      const edited = String(current.content).split('\n').filter(line => !line.includes('Gina will join acme-example') && !line.includes('Gina lives in Lisbon'))
        .join('\n').replace('Gina moves to Lisbon', 'Gina moves to Porto').replace('| Gina ships the beta |', '| ~~Gina ships the beta~~ |')
        .replace('Joined as an advisor.', 'Joined as CTO.');
      let put: Record<string, any> = {};
      const rewrite = await since(b, async () => { put = await run(b.local, 'put_page', { slug, content: edited, expected_revision: current.revision }); });
      const refs: string[] = put.contested?.proposal_refs ?? [];
      const proposals = await listTrustProposals(b.engine, { sourceId: b.sourceId });
      const proposalOf = (table: string, id: number) => proposals.find(p => p.target_table === table && p.target_id === id);
      const changes = [[takes[0]!.id, 'removed'], [takes[1]!.id, 'replaced'], [takes[2]!.id, 'deactivated']] as const;
      const check = (events: BeliefEvent[]) => {
        expect(events.filter(e => e.subject_kind === 'take').map(e => e.event_type)).toEqual(['trust.contested', 'trust.contested', 'trust.contested']);
        expect(events.some(e => e.event_type === 'take.retracted' || e.event_type === 'fact.retracted' || e.event_type === 'take.revised')).toBe(false);
        for (const [id, change] of changes) {
          const proposal = proposalOf('takes', id)!;
          expect(proposal.before_state).toMatchObject({ change });
          expect(events.find(e => e.subject_kind === 'take' && e.cause.proposal === `tp${proposal.id}`)).toMatchObject({ trust_tier: 'user_confirmed', writer_tier: 'agent_written' });
        }
        const fact = events.find(e => e.subject_kind === 'fact')!;
        expect(fact).toMatchObject({ event_type: 'trust.contested', trust_tier: 'user_confirmed' });
        expect(fact.cause.proposal).toBe(`tp${proposals.find(p => p.target_table === 'facts')!.id}`);
      };
      check(rewrite);
      expect(refs.length).toBeGreaterThanOrEqual(4);
      // The rows are unchanged, and the timeline row (not a ledger subject) keeps its proposal with no event.
      expect((await takeRows(b, slug)).map(t => [t.id, t.claim, t.active, t.trust_tier])).toEqual(takes.map(t => [t.id, t.claim, true, 'user_confirmed']));
      expect(proposalOf('timeline_entries', timeline!.id)!.before_state).toMatchObject({ change: 'detail_changed' });
      expect(rewrite.some(e => e.cause.proposal === `tp${proposalOf('timeline_entries', timeline!.id)!.id}`)).toBe(false);
      // An explicit remote takes_remove of a confirmed take: refused in its own transaction, which records the contest.
      let refused: { code?: string; message: string } | null = null;
      const removal = await since(b, async () => { refused = await refusal(run(b.remote, 'takes_remove', { slug, row_num: takes[3]!.row_num })); });
      expect(refused!.code).toBe('forget_requires_owner');
      expect(shape(removal)).toEqual(['take:trust.contested']);
      const removalProposal = (await listTrustProposals(b.engine, { sourceId: b.sourceId })).find(p => p.target_table === 'takes' && p.target_id === takes[3]!.id)!;
      expect(removalProposal).toMatchObject({ action: 'forget', proposer: 'takes_remove' });
      expect(removal[0]!.cause).toMatchObject({ guard: 'takes_remove', refused: 'forget_requires_owner', proposal: `tp${removalProposal.id}` });
      expect(removal[0]!).toMatchObject({ trust_tier: 'user_confirmed', writer_tier: 'agent_written' });
      // The owner's accept applies the removal: only now does the take retract, at its preimage tier.
      const removed = proposalOf('takes', takes[0]!.id)!;
      const accepted = await since(b, async () => { expect((await decideTrustProposal(b.engine, removed.id, 'accept', owner)).status).toBe('accepted'); });
      const retracted = accepted.filter(e => e.event_type === 'take.retracted');
      expect(retracted).toHaveLength(1);
      expect(retracted[0]!).toMatchObject({ trust_tier: 'user_confirmed', writer_tier: 'agent_written', value: null, cause: { proposal: `tp${removed.id}` } });
      // Forced probe: an emitter that turns a contest into a completed retraction is caught.
      fault(retype('trust.contested', 'take.retracted'));
      await run(b.local, 'takes_add', { slug, claim: 'Gina writes a book', kind: 'bet', holder: 'world', weight: 0.6 });
      const added = (await takeRows(b, slug)).find(t => t.claim === 'Gina writes a book')!;
      await confirm(b, 'takes', added.id);
      const again = await content(b, slug);
      const forced = await since(b, () => run(b.local, 'put_page', { slug, content: String(again.content).split('\n').filter(l => !l.includes('Gina writes a book')).join('\n'), expected_revision: again.revision }));
      expect(forced.some(e => e.event_type === 'take.retracted')).toBe(true);
      expect(() => expect(forced.filter(e => e.subject_kind === 'take').map(e => e.event_type)).toEqual(['trust.contested'])).toThrow();
    }), 180_000);

    test('probe 23: destructive events carry the preimage tier and a separate writer_tier; a baseline link event carries trust_tier unknown', withHome(async () => {
      const b = await brain({ enable: false });
      await run(b.local, 'put_page', { slug: 'people/alice-example', content: beliefPage({ type: 'person', title: 'Alice Example' }) });
      await run(b.local, 'put_page', { slug: 'companies/huge-example', content: beliefPage({ prose: 'Long prose. '.repeat(100_000), links: ['people/alice-example'] }) });
      const baseline = await since(b, () => enableBeliefLedger(b.engine, b.sourceId));
      const link = baseline.filter(e => e.subject_kind === 'link' && e.slug === 'companies/huge-example');
      expect(link.map(e => [e.event_type, e.trust_tier, e.tier_basis, e.writer_tier])).toEqual([['baseline', 'unknown', 'unknown', null]]);
      const slug = 'companies/acme-example';
      await run(b.local, 'put_page', { slug, content: beliefPage({ facts: ['Acme raised a seed round'] }) });
      await run(b.local, 'takes_add', { slug, claim: 'Acme will win its market', kind: 'bet', holder: 'world', weight: 0.6 });
      const [take] = await takeRows(b, slug);
      // Rows below the writer: the owner lowered them, so the agent's removal is not contested and the tiers differ.
      expect(await setRowTier(b.engine, { table: 'takes', id: take!.id, sourceId: b.sourceId, tier: 'external_untrusted' })).toBe(true);
      expect(await setRowTier(b.engine, { table: 'pages', id: await pageId(b, slug), sourceId: b.sourceId, tier: 'external_untrusted' })).toBe(true);
      const check = (events: BeliefEvent[], type: string) => {
        const e = events.find(x => x.event_type === type)!;
        expect(e).toBeDefined();
        expect([e.trust_tier, e.writer_tier, e.tier_basis, e.value?.revision_before === undefined ? e.value : 'page']).toEqual(['external_untrusted', 'agent_written', 'row', type === 'take.retracted' ? null : 'page']);
      };
      const retract = await since(b, () => run(b.local, 'takes_remove', { slug, row_num: take!.row_num }));
      check(retract, 'take.retracted');
      const deleted = await since(b, async () => run(b.local, 'delete_page', { slug, expected_revision: (await content(b, slug)).revision }));
      expect(shape(deleted)).toEqual(['page:page.deleted']);
      check(deleted, 'page.deleted');
      // Forced probes: an emitter that drops the writer tier, or stamps a baseline link with the scanner's tier, is caught.
      fault(drafts => drafts.map(d => ({ ...d, writerTier: null })));
      await run(b.local, 'put_page', { slug: 'companies/other-example', content: beliefPage({ title: 'Other Example' }) });
      await setRowTier(b.engine, { table: 'pages', id: await pageId(b, 'companies/other-example'), sourceId: b.sourceId, tier: 'external_untrusted' });
      const forced = await since(b, async () => run(b.local, 'delete_page', { slug: 'companies/other-example', expected_revision: (await content(b, 'companies/other-example')).revision }));
      expect(() => check(forced, 'page.deleted')).toThrow();
      fault(drafts => drafts.map(d => d.subjectKind === 'link' ? { ...d, trustTier: 'agent_written', tierBasis: 'writer' as const } : d));
      const rebaseline = await since(b, async () => { const { disableBeliefLedger } = await import('../src/core/belief/coverage.ts'); await disableBeliefLedger(b.engine, b.sourceId); await enableBeliefLedger(b.engine, b.sourceId); });
      expect(() => expect(rebaseline.filter(e => e.subject_kind === 'link').map(e => [e.event_type, e.trust_tier, e.tier_basis])).toEqual([['baseline', 'unknown', 'unknown']])).toThrow();
    }), 180_000);

    test('probe 25: a lowered input lowers each dependent with its own trust.retiered citing the input\'s event; a raised input promotes none', withHome(async () => {
      const b = await brain();
      const slug = 'notes/kiko-example';
      await run(b.local, 'put_page', { slug, content: beliefPage({ type: 'note', title: 'Kiko', prose: 'Kiko runs the lab.' }) });
      const input = await pageId(b, slug);
      await curate(b, 'pages', input);
      const fact = await run(b.local, 'remember', { fact: 'Kiko runs the lab', provenance: 'notes', entity: 'people/kiko-example' });
      const derived = Number(fact.id);
      await curate(b, 'facts', derived);
      await coordinated(b, tx => recordDerivationInputs(tx, { table: 'facts', id: derived, sourceId: b.sourceId }, [{ table: 'pages', id: input }]));
      const check = (events: BeliefEvent[], to: string) => {
        const page = events.find(e => e.subject_kind === 'page' && e.event_type === 'trust.retiered')!;
        const dependent = events.find(e => e.subject_kind === 'fact' && e.event_type === 'trust.retiered')!;
        expect(page.value).toEqual({ from: 'operator_curated', to });
        expect(dependent).toMatchObject({ slug: 'people/kiko-example', trust_tier: to, value: { from: 'operator_curated', to } });
        expect(dependent.cause).toEqual({ op: 'trust.propagation', inputs: [{ subject_key: page.subject_key, event_key: page.event_key }] });
        expect(dependent.publication_id).toBe(page.publication_id);
      };
      const lowered = await since(b, () => setRowTier(b.engine, { table: 'pages', id: input, sourceId: b.sourceId, tier: 'external_untrusted' }));
      expect(shape(lowered).sort()).toEqual(['fact:trust.retiered', 'page:trust.retiered']);
      check(lowered, 'external_untrusted');
      const raised = await since(b, () => setRowTier(b.engine, { table: 'pages', id: input, sourceId: b.sourceId, tier: 'user_confirmed', ceiling: 'user_confirmed' }));
      expect(shape(raised)).toEqual(['page:trust.retiered']);
      expect(raised[0]!.value).toEqual({ from: 'external_untrusted', to: 'user_confirmed' });
      // Forced probe: an emitter that drops the dependent's event is caught.
      await curate(b, 'facts', derived);
      await curate(b, 'pages', input);
      fault(dropType('trust.retiered', 'fact'));
      const forced = await since(b, () => setRowTier(b.engine, { table: 'pages', id: input, sourceId: b.sourceId, tier: 'external_untrusted' }));
      expect(() => check(forced, 'external_untrusted')).toThrow();
    }), 180_000);

    test('probe 26: a bulk trust backfill appends one summary trust.retiered per stream and batch, and a manifest row for every changed subject', withHome(async () => {
      const b = await brain();
      const slug = 'companies/acme-example';
      await run(b.local, 'put_page', { slug, content: beliefPage({ facts: ['Acme raised a seed round', 'Acme has ten staff'] }) });
      const facts = [await factId(b, 'Acme raised a seed round'), await factId(b, 'Acme has ten staff')];
      const page = await pageId(b, slug);
      await coordinated(b, async tx => {
        await tx.executeRaw(`UPDATE pages SET trust_tier='unknown' WHERE id=$1`, [page]);
        await tx.executeRaw(`UPDATE facts SET trust_tier='unknown' WHERE id=ANY($1::bigint[])`, [facts]);
      });
      const lifetime = (await readEvents(b.engine, b.sourceId)).find(e => e.event_type === 'page.published' && e.slug === slug)!.page_lifetime!;
      const check = async (events: BeliefEvent[]) => {
        const summaries = events.filter(e => e.event_type === 'trust.retiered');
        expect(summaries.every(e => e.subject_kind === 'page' && e.value!.summary === true && e.cause.manifest === true && e.cause.op === 'trust_claim')).toBe(true);
        expect(summaries.map(e => [e.slug, e.subject_key, e.value!.subjects])).toEqual([[slug, pageKey(lifetime), 1], [slug, pageKey(lifetime), 2]]);
        expect(new Set(summaries.map(e => `${e.publication_id}:${e.slug}`)).size).toBe(summaries.length);
        const manifest = await b.engine.executeRaw<{ summary_event: number; subject_kind: string; subject_key: string; from_tier: string; to_tier: string }>(
          `SELECT summary_event::int AS summary_event, subject_kind, subject_key, from_tier, to_tier FROM belief_retier_manifest WHERE source_id=$1 AND summary_event = ANY($2::bigint[])`,
          [b.sourceId, summaries.map(e => e.id)]);
        for (const summary of summaries) expect(manifest.filter(m => m.summary_event === summary.id)).toHaveLength(Number(summary.value!.subjects));
        const tiers = new Map((await b.engine.executeRaw<{ id: number; trust_tier: string }>(`SELECT id::int AS id, trust_tier FROM facts WHERE id=ANY($1::bigint[])`, [facts])).map(r => [r.id, r.trust_tier]));
        const [pageTier] = await b.engine.executeRaw<{ trust_tier: string }>('SELECT trust_tier FROM pages WHERE id=$1', [page]);
        const subject = (m: { subject_key: string }) => (JSON.parse(m.subject_key) as unknown[])[1];
        expect(manifest.map(m => [m.subject_kind, m.subject_kind === 'page' ? m.subject_key : subject(m), m.from_tier, m.to_tier]).sort()).toEqual([
          ['fact', lifetimeRef(lifetime), 'unknown', tiers.get(facts[0]!)], ['fact', lifetimeRef(lifetime), 'unknown', tiers.get(facts[1]!)],
          ['page', pageKey(lifetime), 'unknown', pageTier!.trust_tier]].sort());
        expect(new Set(manifest.filter(m => m.subject_kind === 'fact').map(m => m.subject_key)).size).toBe(2);
      };
      const events = await since(b, () => runTrustBackfill(b.engine, { sources: [b.sourceId], log: () => undefined }));
      await check(events);
      // Forced probe: an emitter that drops the summaries leaves no manifest, which is caught.
      await coordinated(b, tx => tx.executeRaw(`UPDATE facts SET trust_tier='unknown' WHERE id=ANY($1::bigint[])`, [facts]));
      await coordinated(b, tx => tx.executeRaw(`UPDATE pages SET trust_tier='unknown' WHERE id=$1`, [page]));
      fault(dropType('trust.retiered'));
      const forced = await since(b, () => runTrustBackfill(b.engine, { sources: [b.sourceId], log: () => undefined }));
      await expect(check(forced)).rejects.toThrow();
    }), 180_000);

    test('probe 20: ontology stints with identical claim text are distinct keys; an agent observation against a confirmed stint is contested', withHome(async () => {
      const b = await brain();
      const entity = 'people/lena-example';
      const observe = (ctx: OperationContext, value: string, validFrom: string) => run(ctx, 'ontology_propose', { entity, dimension: 'role', value, valid_from: validFrom, source: 'notes', visibility: 'world' });
      const asserted = await since(b, async () => {
        await observe(b.local, 'advisor', '2024-01-01');
        await observe(b.local, 'founder', '2025-01-01');
        await observe(b.local, 'advisor', '2023-01-01');
      });
      const check = (events: BeliefEvent[], starts: string[]) => {
        const advisor = events.filter(e => e.event_type === 'fact.asserted' && e.value?.value === 'advisor');
        expect(advisor).toHaveLength(2);
        const [a, c] = advisor.map(parts);
        expect(a!.slice(0, 5)).toEqual(c!.slice(0, 5));
        expect(a![0]).toBe('o');
        expect([a![5], c![5]].sort()).toEqual(starts);
        expect(advisor[0]!.value!.fact).toBe(advisor[1]!.value!.fact);
      };
      check(asserted, ['2023-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z']);
      const founder = asserted.find(e => e.value?.value === 'founder')!;
      const [stint] = await b.engine.executeRaw<{ id: number }>(`SELECT id::int AS id FROM facts WHERE source_id=$1 AND entity_slug=$2 AND value='founder'`, [b.sourceId, entity]);
      await confirm(b, 'facts', stint!.id);
      let result: Record<string, any> = {};
      const contest = await since(b, async () => { result = await observe(b.remote, 'investor', '2026-01-01'); });
      expect(result.contested?.proposal_ref).toMatch(/^tp\d+$/);
      const contested = contest.find(e => e.event_type === 'trust.contested')!;
      expect(contested).toMatchObject({ subject_key: founder.subject_key, trust_tier: 'user_confirmed', writer_tier: 'agent_written', cause: { guard: 'ontology', proposal: result.contested.proposal_ref } });
      expect(contest.filter(e => e.subject_key === founder.subject_key).map(e => e.event_type)).toEqual(['trust.contested']);
      // Forced probe: an emitter that keys stints without their start collapses them, which is caught.
      fault(drafts => drafts.map(d => d.subjectKey.startsWith('["o"') ? { ...d, subjectKey: JSON.stringify((JSON.parse(d.subjectKey) as unknown[]).slice(0, 5)) } : d));
      const forced = await since(b, async () => {
        await observe(b.local, 'mentor', '2020-01-01');
        await observe(b.local, 'advisor', '2019-01-01');
        await observe(b.local, 'advisor', '2018-01-01');
      });
      expect(() => check(forced, ['2018-01-01T00:00:00.000Z', '2019-01-01T00:00:00.000Z'])).toThrow();
    }), 180_000);

    test('owner decisions: accepting a contested supersession supersedes the old belief and confirms the new one; undo reverses both', withHome(async () => {
      const b = await brain();
      const old = await run(b.local, 'remember', { fact: 'Bob example likes tea', provenance: 'owner', entity: 'people/bob-example' });
      await confirm(b, 'facts', Number(old.id));
      const agent = await run(b.remote, 'remember', { fact: 'Bob example likes coffee', provenance: 'web', entity: 'people/bob-example', replaces: String(old.id) });
      const ref = Number(String(agent.contested.proposal_ref).slice(2));
      const keys = (await readEvents(b.engine, b.sourceId)).filter(e => e.event_type === 'fact.asserted' && e.slug === 'people/bob-example').map(e => e.subject_key);
      const [oldKey, newKey] = keys;
      const checkAccept = (events: BeliefEvent[], replacement: string) => {
        expect(events.map(e => [e.subject_key, e.event_type, e.trust_tier, e.value])).toEqual([
          [oldKey, 'fact.superseded', 'user_confirmed', null],
          [replacement, 'trust.retiered', 'user_confirmed', { from: 'agent_written', to: 'user_confirmed' }]]);
        expect(events[0]!.cause).toMatchObject({ op: 'decide_proposal', replaced_by: replacement });
      };
      const accepted = await since(b, async () => { expect((await decideTrustProposal(b.engine, ref, 'accept', owner)).status).toBe('accepted'); });
      checkAccept(accepted, newKey!);
      const undone = await since(b, async () => { expect((await decideTrustProposal(b.engine, ref, 'undo', owner)).status).toBe('undone'); });
      expect(undone.map(e => [e.subject_key, e.event_type, e.trust_tier, e.value?.fact ?? e.value])).toEqual([
        [oldKey, 'fact.asserted', 'user_confirmed', 'Bob example likes tea'],
        [newKey, 'trust.retiered', 'agent_written', { from: 'user_confirmed', to: 'agent_written' }]]);
      // Forced probe: an emitter that records the accepted supersession as a plain retraction is caught.
      const again = await run(b.remote, 'remember', { fact: 'Bob example likes cocoa', provenance: 'web', entity: 'people/bob-example', replaces: String(old.id) });
      const cocoa = (await readEvents(b.engine, b.sourceId)).find(e => e.event_type === 'fact.asserted' && e.value?.fact === 'Bob example likes cocoa')!.subject_key;
      fault(retype('fact.superseded', 'fact.retracted'));
      const forced = await since(b, async () => { await decideTrustProposal(b.engine, Number(String(again.contested.proposal_ref).slice(2)), 'accept', owner); });
      expect(() => checkAccept(forced, cocoa)).toThrow();
    }), 120_000);
  });
}
