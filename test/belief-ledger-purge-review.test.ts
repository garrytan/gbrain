/**
 * Regression probes for the lane A findings of the #6806 review (purge,
 * redaction, mirror). Each was reproduced failing on the reviewed code; each
 * runs on PGLite and on Postgres when DATABASE_URL is set.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { purgeMirrorPath } from '../src/core/belief/purge-mirror.ts';
import { CODES } from '../src/core/error-registry.ts';
import { __dropRedactionReleaseEventsForTests, __setBeliefEmitterFaultForTests } from '../src/core/belief/append.ts';
import { applyOwnerAction, previewOwnerAction } from '../src/core/trust/owner-actions.ts';
import { __dropOwnerEditAllowlistForTests, publicationBeliefOptions, withBeliefBatch } from '../src/core/belief/ledger.ts';
import { performSync } from '../src/commands/sync/perform.ts';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { backfillBeliefHistory } from '../src/core/belief/backfill.ts';
import { coverageAt, coverageIntervals } from '../src/core/belief/coverage-report.ts';
import { recordDerivationInputs } from '../src/core/facts/derivation-inputs.ts';
import { claimForms, quotes, redactCarryingFields, registerLiveCarriers } from '../src/core/belief/purge.ts';
import { REDACTION_MARKER } from '../src/core/belief/keys.ts';
import { withCoordinatedWrite, withTrustPromotion } from '../src/core/persistence/context.ts';
import { submitRememberMutation } from '../src/core/persistence/memory-mutations.ts';
import { operations } from '../src/core/operations.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { testBackends } from './helpers/test-backends.ts';
import { waitFor } from './helpers/wait-for.ts';
import { tryAcquirePublicationCapacity } from '../src/core/persistence/pool-capacity.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { readHeadBlockers } from '../src/core/persistence/head-blocker.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { beliefBrain, beliefEngineCase, beliefPage, type BeliefBrain, type BeliefEvent } from './helpers/belief-ledger.ts';

afterEach(() => { __setBeliefEmitterFaultForTests(null); __dropOwnerEditAllowlistForTests(false); __dropRedactionReleaseEventsForTests(false); });

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const X = 'Door code is 4417';
const purgeOp = operations.find(o => o.name === 'purge_fact')!;
const deleteOp = operations.find(o => o.name === 'delete_page')!;

async function purgeFact(b: BeliefBrain, claim: string): Promise<Record<string, any>> {
  const [row] = await b.engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id = $1 AND fact = $2 AND expired_at IS NULL ORDER BY id LIMIT 1', [b.sourceId, claim]);
  const dry = await purgeOp.handler(b.ctx, { id: Number(row!.id), dry_run: true }) as Record<string, any>;
  return await purgeOp.handler(b.ctx, { id: Number(row!.id), confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: randomUUID() }) as Record<string, any>;
}

async function purgePage(b: BeliefBrain, slug: string): Promise<Record<string, any>> {
  const snapshot = await b.engine.readPageSnapshot(slug, { sourceId: b.sourceId, includeDeleted: true });
  return await deleteOp.handler(b.ctx, { slug, purge: true, expected_revision: snapshot!.revision, request_id: randomUUID() }) as Record<string, any>;
}

const requestOf = async (b: BeliefBrain, clientRequestId: string) =>
  (await b.engine.executeRaw<{ id: string }>('SELECT id::text AS id FROM persistence_requests WHERE request_id = $1::uuid', [clientRequestId]))[0]!.id;

const quoting = (events: BeliefEvent[], claim: string) => events.filter(e => JSON.stringify(e.value ?? {}).toLowerCase().includes(claim.toLowerCase())).map(e => [e.id, e.event_type, e.origin]);

/** Runs a brain scenario to completion (teardown included) and returns what it reported. */
async function collect<T>(run: (report: (value: T) => void) => Promise<void>): Promise<T> {
  let out: T | undefined;
  await run(value => { out = value; });
  return out as T;
}

/**
 * Edits a canonical file the way a user does (write, git commit) and runs the managed sync to completion. The deadline sits
 * well inside the test timeout, so a blocked drain ends as a reported stop and the brain tears down; it never outlives the test.
 * `governMs` sets how often the drain's governor looks and how long it confirms a blocker (5 s by default).
 */
async function editAndSync(b: BeliefBrain, slug: string, content: string, deadlineMs = 90_000, governMs?: number) {
  writeFileSync(join(b.root, `${slug}.md`), content);
  git(b.root, 'add', '-A'); git(b.root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'edit');
  const result = await performSync(b.engine, { sourceId: b.sourceId, noPull: true, noEmbed: true, noExtract: true, drain: true, deadlineAtMs: Date.now() + deadlineMs,
    ...(governMs ? { governMs } : {}) } as never);
  return { outcome: result.drain?.outcome ?? null, stop: result.drain?.stop_reason ?? null };
}

const mirrorEffects = (b: BeliefBrain) => b.engine.executeRaw<{ id: string; state: string; recovering: boolean; error_code: string | null }>(
  `SELECT id::text AS id, state, recovery IS NOT NULL AS recovering, error_code FROM persistence_effects WHERE source_id = $1 AND kind = 'withdrawal-mirror' ORDER BY id`, [b.sourceId]);

/** A purge commits first and mirrors the canonical file after; a user edits the file only once that mirror has finished. */
const mirrorSettled = (b: BeliefBrain) => waitFor(async () => (await mirrorEffects(b)).every(e => !e.recovering && !['queued', 'running'].includes(e.state)),
  { timeoutMs: 30_000, intervalMs: 50, label: 'withdrawal mirror settled' });

/** An owner-tier, trusted local write in its own batch: the shape of sync, reconcile and file repair (or, with ownerEdit, an explicit owner edit). */
const ownerTierWrite = (b: BeliefBrain, slug: string, op: string, sql: string, ownerEdit = false) => b.engine.transaction(tx => withCoordinatedWrite(tx, [b.sourceId], async () => {
  await tx.lockPageKeys([{ sourceId: b.sourceId, slug }]);
  await withBeliefBatch(tx, { sourceId: b.sourceId, slugs: [slug], op, remote: false, ...(ownerEdit ? { ownerEdit } : {}) }, () => tx.executeRaw(sql, [b.sourceId]));
}, { ...TEST_WRITE_ATTRIBUTION, trust: { tier: 'operator_curated', origin: { channel: op } } }));

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe(`belief ledger purge review (${engineCase.name})`, () => {
    const brain = (run: (b: BeliefBrain) => Promise<void>, managed = true) => beliefBrain(run, { managed, databaseUrl: engineCase.databaseUrl });

    test('#1: sync, reconcile and file repair at owner tier never release a redaction; an explicit owner edit releases only a different value', async () => {
      const r = await collect<Record<string, unknown>>(report => brain(async b => {
        const slug = 'companies/acme-example';
        await b.put(slug, beliefPage({ facts: [X, { claim: 'Acme sells widgets', context: `notes say ${X}` }] }));
        const request = await requestOf(b, String((await purgeFact(b, X)).request_id));
        const ctx = async (fn: () => Promise<unknown>) => { const mark = await b.lastId(); await fn(); return (await b.events(mark)).filter(e => e.event_type.startsWith('fact.')).map(e => e.value?.context); };
        const fact = `source_id = $1 AND fact = 'Acme sells widgets' AND expired_at IS NULL`;
        const out: Record<string, unknown> = { request };
        for (const op of ['canonical_reconcile', 'managed_file_import', 'managed_file_repair', 'trust_release', 'trust_accept'])
          out[op] = await ctx(() => ownerTierWrite(b, slug, op, `UPDATE facts SET confidence = confidence * 0.9 WHERE ${fact}`));
        out.unchangedOwnerEdit = await ctx(() => ownerTierWrite(b, slug, 'owner_edit', `UPDATE facts SET confidence = 0.4 WHERE ${fact}`, true));
        out.syncSetsField = await ctx(() => ownerTierWrite(b, slug, 'managed_file_import', `UPDATE facts SET context = 'sync rewrote it' WHERE ${fact}`));
        out.ownerEdit = await ctx(() => ownerTierWrite(b, slug, 'owner_edit', `UPDATE facts SET context = 'owner rewrote it' WHERE ${fact}`, true));
        out.released = (await b.engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM belief_redactions WHERE source_id = $1 AND released_hash IS NOT NULL', [b.sourceId]))[0]!.n;
        report(out);
      }));
      const m = REDACTION_MARKER(r.request as string);
      expect(r).toEqual({ request: r.request, canonical_reconcile: [m], managed_file_import: [m], managed_file_repair: [m], trust_release: [m], trust_accept: [m],
        unchangedOwnerEdit: [m], syncSetsField: [m], ownerEdit: ['owner rewrote it'], released: 1 });
    }, 240_000);

    test('#1: only a local direct edit (put_page, edit_page, takes edits) is an owner edit; sync, import and the local agent-tier put_page never release', async () => {
      const run = (forced: boolean) => collect<Record<string, unknown>>(report => brain(async b => {
        const slug = 'companies/acme-example';
        const page = (context: string) => beliefPage({ facts: [{ claim: 'Acme sells widgets', context }] });
        const contexts = async (fn: () => Promise<unknown>) => { const mark = await b.lastId(); await fn(); return (await b.events(mark)).filter(e => e.event_type.startsWith('fact.')).map(e => e.value?.context); };
        const released = async () => (await b.engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM belief_redactions WHERE source_id = $1 AND released_hash IS NOT NULL', [b.sourceId]))[0]!.n;
        git(b.root, 'init', '-q');
        mkdirSync(join(b.root, 'companies'), { recursive: true });
        const syncs: unknown[] = [];
        const sync = async (content: string) => { syncs.push(await editAndSync(b, slug, content)); };
        await sync(beliefPage({ facts: [X, { claim: 'Acme sells widgets', context: `notes say ${X}` }] }));
        const request = await requestOf(b, String((await purgeFact(b, X)).request_id));
        await mirrorSettled(b);
        __dropOwnerEditAllowlistForTests(forced);
        const out: Record<string, unknown> = { marker: REDACTION_MARKER(request), mirrored: !readFileSync(join(b.root, `${slug}.md`), 'utf8').includes(`| ${X} |`) };
        out.sync = await contexts(() => sync(page('sync rewrote it')));
        out.afterSync = await released();
        out.syncs = syncs;
        if (forced) { report(out); return; }
        out.agentTierPut = await contexts(() => b.put(slug, page('agent rewrote it')));
        const fact = `source_id = $1 AND fact = 'Acme sells widgets' AND expired_at IS NULL`;
        const publish = (operation: string, intent: Record<string, unknown>, context: string) => contexts(() => b.engine.transaction(tx => withCoordinatedWrite(tx, [b.sourceId], async () => {
          await tx.lockPageKeys([{ sourceId: b.sourceId, slug }]);
          await withBeliefBatch(tx, publicationBeliefOptions({ id: randomUUID(), source_id: b.sourceId, slug, operation, authority: { remote: false }, intent }),
            () => tx.executeRaw(`UPDATE facts SET context = '${context}' WHERE ${fact}`, [b.sourceId]));
        }, { ...TEST_WRITE_ATTRIBUTION, trust: { tier: 'operator_curated', origin: { channel: operation } } })));
        out.import = await publish('put_page', { kind: 'managed_file_import' }, 'import rewrote it');
        out.syncRow = await publish('submit_job', { kind: 'managed_sync_import' }, 'sync row rewrote it');
        out.revert = await publish('revert_version', {}, 'revert rewrote it');
        out.beforeOwner = await released();
        out.ownerPut = await publish('put_page', {}, 'owner rewrote it');
        out.afterOwner = await released();
        report(out);
      }));
      const r = await run(false);
      const m = r.marker;
      const synced = [{ outcome: 'synced', stop: null }, { outcome: 'synced', stop: null }];
      expect(r).toEqual({ marker: m, mirrored: true, sync: [m], afterSync: 0, syncs: synced, agentTierPut: [m], import: [m], syncRow: [m], revert: [m], beforeOwner: 0, ownerPut: ['owner rewrote it'], afterOwner: 1 });
      // Forced probe: without the allowlist the owner-tier managed sync releases the redaction and writes the new value.
      const forced = await run(true);
      expect(forced).toEqual({ marker: forced.marker, mirrored: true, sync: ['sync rewrote it'], afterSync: 1, syncs: synced });
    }, 240_000);

    test('#1 (CI stall): a canonical edit that lands inside the purge mirror\'s reserve-to-verify window leaves its recovery record blocking the root, so the next sync cannot finish', async () => {
      // The next sync stops as `blocked` / `drain_stalled` once its governor has read the blocker (only the user clears it) on two
      // ticks, and as `resumable` / `deadline` if its deadline comes first; either way it ends inside the test. The 20 s deadline stops
      // the drain at about 10 s, where the default 5 s governor confirms too, so each case sets the governor's tick.
      const run = (governMs: number) => collect<Record<string, unknown>>(report => brain(async b => {
        const slug = 'companies/acme-example';
        const edited = beliefPage({ facts: [{ claim: 'Acme sells widgets', context: 'sync rewrote it' }] });
        git(b.root, 'init', '-q');
        mkdirSync(join(b.root, 'companies'), { recursive: true });
        const first = await editAndSync(b, slug, beliefPage({ facts: [X, { claim: 'Acme sells widgets', context: `notes say ${X}` }] }));
        // Forced interleaving: the mirror is queued but not yet run when the purge returns, then it reserves its recovery
        // record and waits for publication capacity the test holds; the user's edit lands in that window.
        await b.engine.executeRaw("ALTER TABLE persistence_effects ALTER COLUMN next_attempt_at SET DEFAULT (now()+interval '1 hour')");
        try { await purgeFact(b, X); } finally { await b.engine.executeRaw('ALTER TABLE persistence_effects ALTER COLUMN next_attempt_at SET DEFAULT now()'); }
        const held: Array<() => void> = [];
        try {
          for (let release = tryAcquirePublicationCapacity(b.engine); release; release = tryAcquirePublicationCapacity(b.engine)) held.push(release);
          await b.engine.transaction(async tx => { await declarePersistenceProtocol(tx);
            await tx.executeRaw("UPDATE persistence_effects SET next_attempt_at = now() WHERE source_id = $1 AND kind = 'withdrawal-mirror'", [b.sourceId]); });
          await waitFor(async () => (await mirrorEffects(b)).some(e => e.recovering), { timeoutMs: 30_000, intervalMs: 20, label: 'mirror reserved its recovery record' });
          writeFileSync(join(b.root, `${slug}.md`), edited);
        } finally { for (const release of held) release(); }
        await waitFor(async () => (await mirrorEffects(b)).some(e => e.error_code === 'unexpected_file_bytes'), { timeoutMs: 30_000, intervalMs: 50, label: 'mirror refused the edited bytes' });
        const raced = await editAndSync(b, slug, edited, 20_000, governMs);
        const queued = (await b.engine.executeRaw<{ id: string }>("SELECT id::text AS id FROM persistence_requests WHERE source_id = $1 AND state = 'queued'", [b.sourceId])).map(row => row.id);
        const blocked = [...(await readHeadBlockers(b.engine, queued, localHostId())).values()].map(read => read.status === 'blocked' ? read.blocker.predicate : read.status);
        report({ first, mirror: (await mirrorEffects(b)).map(e => ({ recovering: e.recovering, error_code: e.error_code })), raced, blocked });
      }));
      // The CI signature: `0/1 processed · stalled on queued · blocked_by=effect_recovery(1)` until the test timed out.
      const expected = (raced: Record<string, unknown>) => ({ first: { outcome: 'synced', stop: null }, mirror: [{ recovering: true, error_code: 'unexpected_file_bytes' }], raced,
        blocked: ['effect_recovery'] });
      // The governor confirms at about 1 s, long before the deadline.
      expect(await run(500)).toEqual(expected({ outcome: 'blocked', stop: 'drain_stalled' }));
      // Forced probe: a governor that would confirm only after a minute leaves the stop to the deadline.
      expect(await run(60_000)).toEqual(expected({ outcome: 'resumable', stop: 'deadline' }));
    }, 240_000);

    test('#43/#5: every redaction release appends one redaction.released in the publication released_by names, also when the confirm leaves the tier unchanged', async () => {
      const run = (dropped: boolean) => collect<Record<string, unknown>>(report => brain(async b => {
        const slug = 'companies/acme-example';
        const page = (context: string, confidence = '1.0') => beliefPage({ facts: [X, { claim: 'Acme sells widgets', context, confidence },
          { claim: 'Acme has a board', context: `minutes say ${X}`, confidence }] });
        await b.put(slug, page(`notes say ${X}`));
        await b.put(slug, page(`notes say ${X}`, '0.9'));
        const factId = async (claim: string) => Number((await b.engine.executeRaw<{ id: number }>(`SELECT id FROM facts WHERE source_id = $1 AND fact = $2 AND expired_at IS NULL`, [b.sourceId, claim]))[0]!.id);
        const confirm = async (claim: string) => {
          const ref = `f${await factId(claim)}`;
          const preview = await previewOwnerAction(b.engine, { action: 'confirm', ref });
          return applyOwnerAction(b.engine, { action: 'confirm', ref }, { binding: preview.binding, confirmation: { via: 'tty' } });
        };
        await confirm('Acme has a board');
        const request = await requestOf(b, String((await purgeFact(b, X)).request_id));
        __dropRedactionReleaseEventsForTests(dropped);
        const fact = (claim: string) => `source_id = $1 AND fact = '${claim}' AND expired_at IS NULL`;
        const publications = async (claim: string) => (await b.engine.executeRaw<{ released_by: string; released_hash: string }>(`SELECT DISTINCT r.released_by::text AS released_by, r.released_hash
          FROM belief_redactions r WHERE r.source_id = $1 AND r.released_by IS NOT NULL AND r.subject_key = (SELECT subject_key FROM belief_events e
            WHERE e.source_id = $1 AND e.value->>'fact' = $2 ORDER BY e.id DESC LIMIT 1)`, [b.sourceId, claim]));
        const shapeOf = async (publication: string) => (await b.events()).filter(e => e.publication_id === publication)
          .map(e => [e.event_type, e.event_type === 'redaction.released' ? [(e.cause as any).released_by === publication, e.value] : e.value?.context ?? null]);
        // The append path: an owner-tier direct edit that sets a different value.
        await b.engine.transaction(tx => withCoordinatedWrite(tx, [b.sourceId], async () => {
          await tx.lockPageKeys([{ sourceId: b.sourceId, slug }]);
          await withBeliefBatch(tx, publicationBeliefOptions({ id: randomUUID(), source_id: b.sourceId, slug, operation: 'put_page', authority: { remote: false }, intent: {} }),
            () => tx.executeRaw(`UPDATE facts SET context = 'owner rewrote it' WHERE ${fact('Acme sells widgets')}`, [b.sourceId]));
        }, { ...TEST_WRITE_ATTRIBUTION, trust: { tier: 'operator_curated', origin: { channel: 'put_page' } } }));
        const [edit] = await publications('Acme sells widgets');
        // The confirm path on a row already confirmed: a write that keeps its tier changes the field (redacted, nothing released),
        // then the confirm leaves the tier as it is, so the release is the publication's only event.
        await b.engine.transaction(tx => withCoordinatedWrite(tx, [b.sourceId], async () => {
          await tx.lockPageKeys([{ sourceId: b.sourceId, slug }]);
          await withBeliefBatch(tx, { sourceId: b.sourceId, slugs: [slug], op: 'managed_file_import', remote: false },
            () => withTrustPromotion(tx, 'user_confirmed', () => tx.executeRaw(`UPDATE facts SET context = 'minutes rewritten' WHERE ${fact('Acme has a board')}`, [b.sourceId])));
        }, { ...TEST_WRITE_ATTRIBUTION, trust: { tier: 'user_confirmed', origin: { channel: 'managed_file_import' } } }));
        const tier = (await b.engine.executeRaw<{ t: string }>(`SELECT trust_tier AS t FROM facts WHERE ${fact('Acme has a board')}`, [b.sourceId]))[0]!.t;
        const unchanged = await confirm('Acme has a board');
        const [confirmed] = await publications('Acme has a board');
        const all = await b.events();
        report({ tier, edit: (await shapeOf(edit!.released_by)).filter(([type]) => type !== 'trust.retiered'), confirmed: await shapeOf(confirmed!.released_by), status: unchanged.status, request,
          hashes: [edit!.released_hash, confirmed!.released_hash], text: all.filter(e => e.event_type === 'redaction.released' && /rewr/.test(JSON.stringify(e.value))).length });
      }));
      const r = await run(false);
      const [editHash, confirmHash] = r.hashes as string[];
      expect(r).toEqual({ tier: 'user_confirmed', request: r.request, status: 'confirmed', hashes: r.hashes, text: 0,
        edit: [['fact.revised', 'owner rewrote it'], ['redaction.released', [true, { releases: [{ field: 'context', purge_request: r.request, released_hash: editHash }] }]]],
        confirmed: [['redaction.released', [true, { releases: [{ field: 'context', purge_request: r.request, released_hash: confirmHash }] }]]] });
      // Forced probe: with the event dropped, the release leaves the publication released_by names without any event.
      const forced = await run(true);
      expect(forced.edit).toEqual([['fact.revised', 'owner rewrote it']]);
      expect(forced.confirmed).toEqual([]);
    }, 240_000);

    test('#2: the first page purge in a source writes no purged text into the ledger', async () => {
      const r = await collect<Record<string, unknown>>(report => brain(async b => {
        const claim = 'Vault code is 7731';
        await submitRememberMutation(b.ctx, { fact: 'Secret example owns a vault', entity: 'people/secret-example', provenance: 'probe' });
        await b.put('people/secret-example', beliefPage({ type: 'person', title: 'Secret Example', facts: [claim] }));
        await b.engine.executeRaw(`UPDATE facts SET context = $2 WHERE source_id = $1 AND source_markdown_slug IS NULL AND entity_slug = 'people/secret-example'`,
          [b.sourceId, `per memo: ${claim.toLowerCase()}`]);
        const mark = await b.lastId();
        const result = await purgePage(b, 'people/secret-example');
        report({ status: result.status, leaks: quoting(await b.events(), claim), published: (await b.events(mark)).filter(e => e.subject_kind === 'fact').map(e => [e.event_type, e.redacted_fields]) });
      }, false));
      expect(r.status).toBe('purged');
      expect(r.leaks).toEqual([]);
    }, 240_000);
    test('#6: the purge passes never substring-scan in SQL; 200 claims cost one keyset pass over the carrying fields', async () => {
      const r = await collect<Record<string, unknown>>(report => brain(async b => {
        await b.put('companies/acme-example', beliefPage({ prose: 'Acme.' }));
        await b.put('companies/acme-example', beliefPage({ facts: [{ claim: 'Acme sells widgets', context: `notes say ${X}` }, 'Acme has two offices'] }));
        const claims = [X, ...Array.from({ length: 199 }, (_, i) => `needle claim number ${i} about something`)];
        const statements: Array<{ sql: string; params: unknown[] }> = [];
        const out = await b.engine.transaction(async tx => withCoordinatedWrite(tx, [b.sourceId], async () => {
          const spy = new Proxy(tx, { get: (t, k) => k === 'executeRaw' ? (sql: string, params: unknown[] = []) => { statements.push({ sql, params }); return t.executeRaw(sql, params); }
            : (t as any)[k] });
          const request = randomUUID();
          return { redacted: (await redactCarryingFields(spy, { sourceId: b.sourceId, request, claims })).map(f => f.field),
            live: (await registerLiveCarriers(spy, { sourceId: b.sourceId, request, claims })).map(f => f.field) };
        }, TEST_WRITE_ATTRIBUTION));
        report({ ...out, substring: statements.filter(st => /strpos\(/i.test(st.sql)).length,
          claimParams: statements.filter(st => JSON.stringify(st.params, (_k, v) => typeof v === 'bigint' ? String(v) : v).includes('needle claim')).length });
      }));
      expect(r).toEqual({ redacted: ['context'], live: ['context'], substring: 0, claimParams: 0 });
    }, 240_000);

    test('#11: a claim whose case folds differently in SQL and JS (Turkish dotted I, Greek sigma) is still redacted and registered', async () => {
      const r = await collect<Record<string, unknown>>(report => brain(async b => {
        const slug = 'companies/acme-example';
        const claims = ['İstanbul office code is 4417', 'ΟΔΟΣ ΣΟΦΙΑΣ door code 9921'];
        for (const [i, claim] of claims.entries()) await b.put(`vault/code-${i}-example`, beliefPage({ facts: [claim] }));
        await b.put(slug, beliefPage({ prose: 'Acme.' }));
        await b.put(slug, beliefPage({ facts: [{ claim: 'Acme sells widgets', context: `memo: ${claims[0]}` }, { claim: 'Acme has two offices', context: `memo: ${claims[1]}` }] }));
        for (const claim of claims) await purgeFact(b, claim);
        report({ leaks: quoting(await b.events(), claims[0]!).concat(quoting(await b.events(), claims[1]!)),
          register: (await b.engine.executeRaw<{ n: number }>('SELECT count(DISTINCT subject_key)::int AS n FROM belief_redactions WHERE source_id = $1', [b.sourceId]))[0]!.n });
      }));
      expect(r).toEqual({ leaks: [], register: 2 });
    }, 240_000);

    test('#12: the receipt reports another subject\'s recorded value that still quotes the claim, naming its key', async () => {
      const r = await collect<Record<string, unknown>>(report => brain(async b => {
        const slug = 'companies/acme-example';
        await b.put(slug, beliefPage({ facts: ['Acme sells widgets'] }));
        await b.put(slug, beliefPage({ facts: [`${X} for the back office`, 'Acme sells widgets'] }));
        await b.put(slug, beliefPage({ facts: [X, 'Acme sells widgets'] }));
        const result = await purgeFact(b, X);
        const store = (result.stores as Array<Record<string, any>>).find(st => st.store === 'belief_events')!;
        const carrier = (await b.events()).find(e => e.value?.fact === `${X} for the back office`)!;
        report({ status: store.status, items: store.items, key: carrier.subject_key });
      }));
      expect(r.status).toBe('out_of_scope');
      expect(r.items).toEqual([`fact@${r.key}`]);
    }, 240_000);
    test('#13: a backfill after a fact purge does not copy a pre-coverage context that quoted the purged claim', async () => {
      const r = await collect<Record<string, unknown>>(report => beliefBrain(async b => {
        const slug = 'companies/acme-example';
        await b.put(slug, beliefPage({ facts: [X, { claim: 'Acme sells widgets', context: `notes say ${X}` }] }));
        await b.put(slug, beliefPage({ facts: [X, { claim: 'Acme sells widgets', context: 'rewritten context' }] }));
        await new Promise(resolve => setTimeout(resolve, 50));
        await b.enable();
        const result = await purgeFact(b, X);
        const backfill = await backfillBeliefHistory(b.engine, b.sourceId);
        const events = await b.events();
        report({ store: (result.stores as Array<Record<string, any>>).find(st => st.store === 'belief_events')!.status, backfilled: backfill.events > 0,
          leaks: quoting(events, X), redacted: events.filter(e => e.origin === 'backfill' && /^\[redacted: purge [0-9a-f-]+\]$/.test(String(e.value?.context))).length > 0 });
      }, { managed: true, enable: false, databaseUrl: engineCase.databaseUrl }));
      expect(r).toEqual({ store: 'deleted', backfilled: true, leaks: [], redacted: true });
    }, 240_000);

    test('#13: a backfill tags a version that was private as private, whatever the page is now', async () => {
      const r = await collect<string[][]>(report => beliefBrain(async b => {
        const slug = 'companies/acme-example';
        await b.put(slug, beliefPage({ frontmatter: { visibility: 'private' }, takes: ['Acme will raise in Q3'] }));
        await b.put(slug, beliefPage({ takes: ['Acme will raise in Q3', 'Acme hires a CFO'] }));
        await new Promise(resolve => setTimeout(resolve, 50));
        await b.enable();
        await backfillBeliefHistory(b.engine, b.sourceId);
        report((await b.events()).filter(e => e.origin === 'backfill' && e.event_type !== 'backfill').map(e => [e.event_type, e.visibility]));
      }, { managed: true, enable: false, databaseUrl: engineCase.databaseUrl }));
      expect(r).toEqual([['page.published', 'private'], ['take.asserted', 'private'], ['page.published', 'world'], ['take.asserted', 'world']]);
    }, 240_000);

    test('#36: no recorded hash of a purged or redacted value survives as a prior_hash', async () => {
      const r = await collect<Record<string, unknown>>(report => brain(async b => {
        const slug = 'companies/acme-example';
        await b.put(slug, beliefPage({ facts: [X, { claim: 'Acme sells widgets', context: `notes say ${X}` }] }));
        await b.put(slug, beliefPage({ facts: [{ claim: X, confidence: '0.9' }, { claim: 'Acme sells widgets', context: `notes say ${X}`, confidence: '0.8' }] }));
        const quoted = new Set((await b.events()).filter(e => JSON.stringify(e.value ?? {}).includes(X)).flatMap(e => [e.value_hash, e.prior_hash]).filter((h): h is string => !!h));
        await purgeFact(b, X);
        const events = await b.events();
        report({ quoted: quoted.size >= 4, prior: events.filter(e => e.prior_hash && quoted.has(e.prior_hash)).map(e => [e.event_type, e.purged]),
          value: events.filter(e => e.value_hash && quoted.has(e.value_hash)).length });
      }));
      expect(r).toEqual({ quoted: true, prior: [], value: 0 });
    }, 240_000);

    test('#39: a short purged claim redacts the fields that quote it as a word, not every field containing its letters', async () => {
      const r = await collect<Record<string, unknown>>(report => brain(async b => {
        await b.put('notes/short-example', beliefPage({ title: 'Short Example', facts: ['CEO'] }));
        const acme = (confidence: string) => beliefPage({ facts: [{ claim: 'Acme sells widgets', context: 'herbaceous borders sell well', confidence },
          { claim: 'Acme hired staff', context: 'the _CEO_ approved it', confidence }, { claim: 'Acme has a board', context: 'board of the CEO-office', confidence }] });
        await b.put('companies/acme-example', acme('1.0'));
        await b.put('companies/acme-example', acme('0.8'));
        await purgePage(b, 'notes/short-example');
        const contexts = Object.fromEntries((await b.events()).filter(e => e.slug === 'companies/acme-example' && e.subject_kind === 'fact')
          .map(e => [e.value?.fact, /^\[redacted: purge [0-9a-f-]+\]$/.test(String(e.value?.context)) ? 'redacted' : e.value?.context]));
        report(contexts);
      }));
      expect(r).toEqual({ 'Acme sells widgets': 'herbaceous borders sell well', 'Acme hired staff': 'redacted', 'Acme has a board': 'redacted' });
      const cases = [['CEO', 'a CEO.'], ['CEO', 'x_ceo_y'], ['CEO', 'ceo2'], ['東京', '東京都に住む'], ['Door code is 4417', 'door code is 44170'], ['ИП', 'ИПотека']];
      expect(cases.map(([claim, text]) => quotes(text!, claimForms([claim!])))).toEqual([true, true, false, true, true, false]);
    }, 240_000);

    test('#14: a hard delete (purge, managed and unmanaged retention) records every cascaded inbound link as link.retracted in its own stream', async () => {
      const run = (managed: boolean, remove: (b: BeliefBrain, slug: string) => Promise<unknown>) => collect<string[]>(report => brain(async b => {
        await b.put('people/target-example', beliefPage({ type: 'person', title: 'Target Example' }));
        await b.put('companies/acme-example', beliefPage({ prose: 'Acme.' }));
        await b.put('companies/acme-example', beliefPage({ facts: ['Acme sells widgets'], links: ['people/target-example'] }));
        const mark = await b.lastId();
        await remove(b, 'people/target-example');
        report((await b.events(mark)).filter(e => e.subject_kind === 'link').map(e => `${e.slug}:${e.event_type}`));
      }, managed));
      const expire = async (b: BeliefBrain, slug: string) => {
        const snapshot = await b.engine.readPageSnapshot(slug, { sourceId: b.sourceId });
        await deleteOp.handler(b.ctx, { slug, expected_revision: snapshot!.revision, request_id: randomUUID() });
        await purgeDeletedPagesCoordinated(b.engine, 0);
      };
      expect({ purge: await run(true, purgePage), managedRetention: await run(true, expire), unmanagedRetention: await run(false, expire) }).toEqual({
        purge: ['companies/acme-example:link.retracted'], managedRetention: ['companies/acme-example:link.retracted'], unmanagedRetention: ['companies/acme-example:link.retracted'] });
    }, 240_000);

    test('#26: a retention removal does not take the source exclusively; an owner purge does', async () => {
      const r = await collect<Record<string, unknown>>(report => brain(async b => {
        const exclusive: string[] = [];
        const proto = Object.getPrototypeOf(b.engine) as { executeRaw: (sql: string, ...rest: unknown[]) => Promise<unknown> };
        const original = proto.executeRaw;
        proto.executeRaw = function (this: unknown, sql: string, ...rest: unknown[]) {
          if (/^SELECT id FROM sources WHERE id=\$1 FOR UPDATE$/.test(sql)) exclusive.push(sql);
          return original.call(this, sql, ...rest);
        };
        try {
          await b.put('notes/old-example', beliefPage({ prose: 'Old.' }));
          await b.put('notes/vault-example', beliefPage({ prose: 'Vault.' }));
          const snapshot = await b.engine.readPageSnapshot('notes/old-example', { sourceId: b.sourceId });
          await deleteOp.handler(b.ctx, { slug: 'notes/old-example', expected_revision: snapshot!.revision, request_id: randomUUID() });
          exclusive.length = 0;
          await purgeDeletedPagesCoordinated(b.engine, 0);
          const retention = exclusive.length;
          exclusive.length = 0;
          await purgePage(b, 'notes/vault-example');
          report({ retention, purge: exclusive.length });
        } finally { proto.executeRaw = original; }
      }));
      expect(r).toEqual({ retention: 0, purge: 1 });
    }, 240_000);
    test('#21: a truncated derivation walk withholds certification of the interval it ran in', async () => {
      const r = await collect<Record<string, unknown>>(report => brain(async b => {
        const derived = Array.from({ length: 9 }, (_, i) => `Acme derived note ${i + 1}`);
        await b.put('companies/acme-example', beliefPage({ facts: [X] }));
        await b.put('notes/derived-example', beliefPage({ title: 'Derived Example', facts: derived }));
        const ids = async (claims: string[]) => Promise.all(claims.map(async c => Number((await b.engine.executeRaw<{ id: number }>(
          'SELECT id FROM facts WHERE source_id = $1 AND fact = $2 AND expired_at IS NULL', [b.sourceId, c]))[0]!.id)));
        const chain = await ids([X, ...derived]);
        for (let i = 1; i < chain.length; i++) await recordDerivationInputs(b.engine, { table: 'facts', id: chain[i]!, sourceId: b.sourceId }, [{ table: 'facts', id: chain[i - 1]! }]);
        const before = await coverageAt(b.engine, b.sourceId, new Date());
        const result = await purgeFact(b, X);
        const after = await coverageAt(b.engine, b.sourceId, new Date());
        const [interval] = await coverageIntervals(b.engine, b.sourceId);
        report({ truncated: result.purge.derived.truncated, before: before.ok && before.certified, after: after.ok && [after.certified, after.uncertified_reason],
          walks: interval!.truncated_walks.length });
      }));
      expect(r).toEqual({ truncated: true, before: true, after: [false, 'truncated_walk'], walks: 1 });
    }, 240_000);

    test('#22: an unwritable purge mirror refuses the purge with a typed error, with or without a ledger', async () => {
      const run = (enable: boolean) => collect<Record<string, unknown>>(report => beliefBrain(async b => {
        await b.put('companies/acme-example', beliefPage({ facts: [X, 'Acme sells widgets'] }));
        mkdirSync(purgeMirrorPath(), { recursive: true });
        const error = await purgeFact(b, X).then(() => null, (e: { code?: string }) => e.code ?? 'untyped');
        const live = (await b.engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM facts WHERE source_id = $1 AND fact = $2 AND expired_at IS NULL', [b.sourceId, X]))[0]!.n;
        report({ error, live, registered: 'purge_mirror_unwritable' in CODES });
      }, { managed: true, enable, databaseUrl: engineCase.databaseUrl }));
      expect({ ledger: await run(true), none: await run(false) }).toEqual({
        ledger: { error: 'purge_mirror_unwritable', live: 1, registered: true }, none: { error: 'purge_mirror_unwritable', live: 1, registered: true } });
    }, 240_000);

    test('#23: a page purge\'s committed mirror line is written after the commit even when no op handler finishes the reply', async () => {
      const r = await collect<Record<string, unknown>>(report => brain(async b => {
        await b.put('notes/vault-example', beliefPage({ facts: [X] }));
        const snapshot = await b.engine.readPageSnapshot('notes/vault-example', { sourceId: b.sourceId });
        const done = await b.op('delete_page', { slug: 'notes/vault-example', purge: true, expected_revision: snapshot!.revision });
        const request = await requestOf(b, String(done.request_id));
        const lines = readFileSync(purgeMirrorPath(), 'utf8').trim().split('\n').map(l => JSON.parse(l) as { kind: string; request: string });
        report({ state: done.state, kinds: lines.filter(l => l.request === request).map(l => l.kind) });
      }));
      expect(r).toEqual({ state: 'committed', kinds: ['intent', 'committed'] });
    }, 240_000);
  });
}
