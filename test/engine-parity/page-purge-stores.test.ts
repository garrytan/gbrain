/**
 * BrainEngine parity — the slug stores a page purge scrubs and the change reasons it reads
 * (src/core/persistence/purge-slug-stores.ts scrubPurgedSlugStores, facts/purge-reasons.ts pageChangeReasons and
 * requestsRecordingReasons).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the slug-store scrub removes the proposed takes, open loops, aliases and rename rows keyed to a purged slug and
 *    counts them as the purge receipt names them, and the reason reads list the reasons a page's versions and requests
 *    recorded (each once) and the slug's requests that recorded one: each answers the same, and leaves the same rows, on every
 *    engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1) over one seeded slug with
 *    rows around it (another slug, another source).
 *  - Regression: an engine that scrubs a store differently leaves a purged page's aliases or proposals behind (or removes another
 *    slug's) and the receipt counts the wrong rows; one that lists the reasons differently lets the purge miss a reason it
 *    must redact from the journal. The Rust engine has no SQL, so each statement has to exist as a typed member it can serve.
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call (D18), so
 *    only the PGLite and Postgres purge suites (test/page-purge*.test.ts) exercised them.
 *  - Seam: the exported functions of persistence/purge-slug-stores.ts and facts/purge-reasons.ts, called with the arm's engine
 *    (a transaction handle). Every row is seeded through typed writers: putPage, insertTakeProposal, upsertOpenLoop,
 *    setPageAliases, updateSlug, createVersion and the write journal. core_edit_notices and the secret store have no typed
 *    writer, so their counts are the empty-store answer on every arm. Generated values are compared by label or shape.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { scrubPurgedSlugStores } from '../../src/core/persistence/purge-slug-stores.ts';
import { pageChangeReasons, requestsRecordingReasons } from '../../src/core/facts/purge-reasons.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const OTHER = 'other';
const SLUG = 'notes/doomed';
const PRINCIPAL = { kind: 'local_cli', id: 'parity-writer' };
const KEYS = ['principal:local_cli:parity-writer', 'brain'];
const TOKEN = 'c0000000-0000-4000-8000-0000000000c1';

const note = (title: string, body: string) => ({ type: 'note' as const, title, compiled_truth: body, frontmatter: {} });

/** One journal row of the page: admitted, claimed and completed with `outcome` (null: left queued). */
async function journal(engine: BrainEngine, requestId: string, operation: string, slug: string, opts: { intent?: unknown; outcome?: unknown; sourceId?: string } = {}): Promise<string> {
  const sourceId = opts.sourceId ?? SRC;
  const source = await engine.readSourceMembership(sourceId);
  await engine.lockPersistenceCounters(KEYS);
  const row = await engine.insertWriteRequest({
    principalKind: PRINCIPAL.kind, principalId: PRINCIPAL.id, requestId, operation, sourceId, sourceIncarnation: source!.incarnation, pageId: null, slug,
    worktreeId: null, topologyGeneration: null, digest: 'd'.repeat(64), intent: opts.intent ?? { kind: operation, slug }, authority: { scopes: ['write'] },
    intentBytes: 100, terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: KEYS,
    clientRequestId: null, state: 'queued', deferredRefreshId: null,
  });
  if (opts.outcome !== undefined) {
    await engine.stampWriteClaim(row.id, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
    await engine.completeWriteRow({
      id: row.id, state: 'committed', outcome: opts.outcome, errorCode: null, errorMessage: null, consumerVersion: 'parity', consumerHostId: null, errorDetail: null,
      resultBytes: 1200, counterKeys: KEYS, intentBytes: 100, retainedBytes: 1500, terminalReservation: 4096, probePurges: false,
    });
  }
  return row.id;
}

describe('engine parity: the slug stores a page purge scrubs and the change reasons it reads', () => {
  parityTest('scrubPurgedSlugStores removes the proposed takes, open loops, aliases and rename rows keyed to a slug, counts them as the receipt names them, and leaves other slugs and sources', {
    methods: ['putPage', 'insertTakeProposal', 'upsertOpenLoop', 'setPageAliases', 'updateSlug', 'listPendingTakeProposals', 'listOpenLoops', 'readPageAliasRows', 'listSlugAliases',
      'transaction', 'deletePurgedSlugStoreRows'],
  }, async (engine, backend) => {
    await createSource(engine, backend, OTHER);
    await engine.putPage(SLUG, note('Doomed', 'The harbor ledger starts here.'));
    await engine.putPage('notes/keeper', note('Keeper', 'Keeper notes.'));
    await engine.putPage('notes/old-name', note('Old Name', 'Renamed later.'));
    await engine.putPage(SLUG, note('Doomed', 'The harbor ledger starts here.'), { sourceId: OTHER } as never);
    const proposal = (sourceId: string, pageSlug: string, claimText: string) => engine.insertTakeProposal({ sourceId, pageSlug, contentHash: 'hash-1', promptVersion: 'parity-v1', proposalRunId: 'run-1', claimText,
      kind: 'bet', holder: 'brain', weight: 0.6, domain: null, dedupAgainst: [], modelId: 'parity-model' });
    await proposal(SRC, SLUG, 'Doomed-co ships soon'); await proposal(SRC, SLUG, 'Doomed-co never ships'); await proposal(SRC, 'notes/keeper', 'Keeper-co ships'); await proposal(OTHER, SLUG, 'Other-co ships');
    const at = '2026-03-01T10:00:00.000Z';
    const loop = (key: string, sourceId: string, pageSlug: string) => engine.upsertOpenLoop({ sourceId, dedupKey: key, loopType: 'commitment_owed_by_me', counterpartyEmail: 'a@example.com', summary: key,
      evidence: [], detector: 'manual', pageSlug, lastActivityAt: at, openedAt: at } as never);
    await loop('loop-doomed', SRC, SLUG); await loop('loop-keeper', SRC, 'notes/keeper'); await loop('loop-other', OTHER, SLUG);
    await engine.setPageAliases(SLUG, SRC, ['doomed alias', 'old harbor']);
    await engine.setPageAliases('notes/keeper', SRC, ['keeper alias']);
    await engine.setPageAliases(SLUG, OTHER, ['other alias']);
    // A rename leaves a redirect from the old slug and a history row that ends at the new one; a second rename ends at another page.
    await engine.updateSlug('notes/old-name', 'notes/doomed-renamed');
    await engine.updateSlug('notes/doomed-renamed', SLUG, { sourceId: SRC }).catch(() => undefined);
    const state = async () => ({
      proposals: (await engine.listPendingTakeProposals({ limit: 100 })).map(p => `${p.source_id}:${p.page_slug}:${p.claim_text}`).sort(),
      loops: (await engine.listOpenLoops({ sourceIds: [SRC, OTHER] })).map(l => `${l.source_id}:${String(l.dedup_key)}`).sort(),
      aliases: (await engine.readPageAliasRows([SRC, OTHER], [SLUG, 'notes/keeper'])).map(a => `${a.source_id}:${a.slug}:${a.alias_norm}`).sort(),
      redirects: (await engine.listSlugAliases(SRC)).map(a => `${a.alias_slug}->${a.canonical_slug}`).sort(),
    });
    const before = await state();
    const none = await engine.transaction(tx => scrubPurgedSlugStores(tx, SRC, [], {}));
    const removed = await engine.transaction(tx => scrubPurgedSlugStores(tx, SRC, [SLUG], { pageIds: [] }));
    const after = await state();
    const again = await engine.transaction(tx => scrubPurgedSlugStores(tx, SRC, [SLUG], {}));
    const unknown = await engine.transaction(tx => scrubPurgedSlugStores(tx, 'nobody', ['notes/never'], {}));
    expect(none).toEqual({});
    expect(removed).toMatchObject({ take_proposals: 2, open_loops: 1, core_edit_notices: 0 });
    expect(after.proposals).toEqual(['default:notes/keeper:Keeper-co ships', 'other:notes/doomed:Other-co ships']);
    expect(after.loops).toEqual(['default:loop-keeper', 'other:loop-other']);
    expect(again).toMatchObject({ take_proposals: 0, open_loops: 0, page_aliases: 0 });
    return { before, none, removed, after, again, unknown };
  });

  parityTest('deletePurgedSlugStoreRows reports each store it scrubbed, counts a slug named twice once, and leaves another source; listPageSecretOccurrences finds no secret on a page the store has none for', {
    methods: ['putPage', 'insertTakeProposal', 'upsertOpenLoop', 'setPageAliases', 'updateSlug', 'listPendingTakeProposals', 'listOpenLoops', 'readPageAliasRows',
      'deletePurgedSlugStoreRows', 'listPageSecretOccurrences'],
  }, async (engine, backend) => {
    await createSource(engine, backend, OTHER);
    const doomed = await engine.putPage(SLUG, note('Doomed', 'The harbor ledger starts here.'));
    await engine.putPage('notes/keeper', note('Keeper', 'Keeper notes.'));
    await engine.putPage('notes/old-name', note('Old Name', 'Renamed later.'));
    const proposal = (sourceId: string, pageSlug: string, claimText: string) => engine.insertTakeProposal({ sourceId, pageSlug, contentHash: 'hash-1', promptVersion: 'parity-v1', proposalRunId: 'run-1', claimText,
      kind: 'bet', holder: 'brain', weight: 0.6, domain: null, dedupAgainst: [], modelId: 'parity-model' });
    await proposal(SRC, SLUG, 'Doomed-co ships soon'); await proposal(SRC, 'notes/keeper', 'Keeper-co ships'); await proposal(OTHER, SLUG, 'Other-co ships');
    const at = '2026-03-01T10:00:00.000Z';
    const loop = (key: string, sourceId: string, pageSlug: string) => engine.upsertOpenLoop({ sourceId, dedupKey: key, loopType: 'commitment_owed_by_me', counterpartyEmail: 'a@example.com', summary: key,
      evidence: [], detector: 'manual', pageSlug, lastActivityAt: at, openedAt: at } as never);
    await loop('loop-doomed', SRC, SLUG); await loop('loop-keeper', SRC, 'notes/keeper'); await loop('loop-other', OTHER, SLUG);
    await engine.setPageAliases(SLUG, SRC, ['doomed alias', 'old harbor']);
    await engine.setPageAliases('notes/keeper', SRC, ['keeper alias']);
    await engine.setPageAliases(SLUG, OTHER, ['other alias']);
    await engine.updateSlug('notes/old-name', SLUG, { sourceId: SRC }).catch(() => undefined);
    const state = async () => ({
      proposals: (await engine.listPendingTakeProposals({ limit: 100 })).map(p => `${p.source_id}:${p.page_slug}`).sort(),
      loops: (await engine.listOpenLoops({ sourceIds: [SRC, OTHER] })).map(l => `${l.source_id}:${String(l.dedup_key)}`).sort(),
      aliases: (await engine.readPageAliasRows([SRC, OTHER], [SLUG, 'notes/keeper'])).map(a => `${a.source_id}:${a.slug}:${a.alias_norm}`).sort(),
    });
    const before = await state();
    // The rows per store are what the purge receipt names; whether the database has the secret store is the one answer that differs by engine.
    const split = (r: { removed: Record<string, number>; secretStore: boolean }) => ({ removed: r.removed, hasSecretStore: r.secretStore });
    const empty = split(await engine.deletePurgedSlugStoreRows(SRC, []));
    const removed = split(await engine.deletePurgedSlugStoreRows(SRC, [SLUG, SLUG, 'notes/never'], { ifPresent: true }));
    const after = await state();
    const again = split(await engine.deletePurgedSlugStoreRows(SRC, [SLUG]));
    const other = split(await engine.deletePurgedSlugStoreRows(OTHER, [SLUG]));
    const occurrences = [await engine.listPageSecretOccurrences([]), await engine.listPageSecretOccurrences([doomed.id, 987654])];
    const sql = backend !== 'rust';
    expect([empty.hasSecretStore, removed.hasSecretStore, again.hasSecretStore, other.hasSecretStore]).toEqual(Array(4).fill(sql));
    expect(removed.removed).toMatchObject({ take_proposals: 1, open_loops: 1, core_edit_notices: 0, page_aliases: 2 });
    expect(after.proposals).toEqual(['default:notes/keeper', 'other:notes/doomed']);
    return { before, empty: empty.removed, removed: removed.removed, after, again: again.removed, other: other.removed, occurrences };
  });

  parityTest('pageChangeReasons lists the reasons a page\'s versions and requests recorded, each once, and requestsRecordingReasons the slug\'s requests that recorded one', {
    methods: ['putPage', 'createVersion', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow', 'transaction', 'listPageChangeReasons', 'listRequestsRecordingReasons'],
  }, async (engine, backend) => {
    await createSource(engine, backend, OTHER);
    const doomed = await engine.putPage(SLUG, note('Doomed', 'The harbor ledger starts here.'));
    const keeper = await engine.putPage('notes/keeper', note('Keeper', 'Keeper notes.'));
    await engine.createVersion(SLUG, { sourceId: SRC, reason: 'noted the harbor ledger' });
    await engine.createVersion(SLUG, { sourceId: SRC, reason: 'noted the harbor ledger' });
    await engine.createVersion(SLUG, { sourceId: SRC, reason: '[purged]' });
    await engine.createVersion(SLUG, { sourceId: SRC });
    await engine.createVersion('notes/keeper', { sourceId: SRC, reason: 'keeper edit' });
    const ids: Record<string, string> = {};
    const rec = async (label: string, requestId: string, slug: string, opts: { intent?: unknown; outcome?: unknown; sourceId?: string; operation?: string }) => {
      ids[label] = await journal(engine, requestId, opts.operation ?? 'put_page', slug, opts);
    };
    await rec('intentReason', 'b1000000-0000-4000-8000-0000000000a1', SLUG, { intent: { kind: 'put_page', slug: SLUG, reason: 'created for the harbor audit' }, outcome: { status: 'ok' } });
    await rec('outcomeReason', 'b1000000-0000-4000-8000-0000000000a2', SLUG, { outcome: { status: 'ok', reason_recorded: { reason: 'edited after the audit', version_id: 7 } } });
    await rec('both', 'b1000000-0000-4000-8000-0000000000a3', SLUG, { intent: { kind: 'put_page', slug: SLUG, reason: 'noted the harbor ledger' }, outcome: { reason_recorded: { reason: 'noted the harbor ledger' } } });
    await rec('queuedReason', 'b1000000-0000-4000-8000-0000000000a4', SLUG, { intent: { kind: 'put_page', slug: SLUG, reason: 'still queued' } });
    await rec('nullReason', 'b1000000-0000-4000-8000-0000000000a5', SLUG, { intent: { kind: 'put_page', slug: SLUG, reason: null }, outcome: { status: 'ok' } });
    await rec('markerOnly', 'b1000000-0000-4000-8000-0000000000a6', SLUG, { outcome: { reason_recorded: null } });
    await rec('noReason', 'b1000000-0000-4000-8000-0000000000a7', SLUG, { outcome: { status: 'ok' } });
    await rec('keeper', 'b1000000-0000-4000-8000-0000000000a8', 'notes/keeper', { intent: { kind: 'put_page', slug: 'notes/keeper', reason: 'keeper request reason' }, outcome: { status: 'ok' } });
    await rec('otherSource', 'b1000000-0000-4000-8000-0000000000a9', SLUG, { intent: { kind: 'put_page', slug: SLUG, reason: 'other source reason' }, outcome: { status: 'ok' }, sourceId: OTHER });
    const label = (id: string) => Object.entries(ids).find(([, v]) => v === id)?.[0] ?? `unknown:${id}`;
    const out = await engine.transaction(async tx => ({
      reasons: (await pageChangeReasons(tx, SRC, SLUG, doomed.id)).sort(),
      keeper: (await pageChangeReasons(tx, SRC, 'notes/keeper', keeper.id)).sort(),
      otherSource: (await pageChangeReasons(tx, OTHER, SLUG, doomed.id)).sort(),
      nobody: await pageChangeReasons(tx, SRC, 'notes/never', 987654),
      recording: (await requestsRecordingReasons(tx, SRC, SLUG)).map(r => ({ id: label(r.id), principal: `${r.principal_kind}:${r.principal_id}` })),
      recordingKeeper: (await requestsRecordingReasons(tx, SRC, 'notes/keeper')).map(r => label(r.id)),
      recordingOther: (await requestsRecordingReasons(tx, OTHER, SLUG)).map(r => label(r.id)),
      recordingNone: await requestsRecordingReasons(tx, SRC, 'notes/never'),
    }));
    expect(out.reasons).toContain('noted the harbor ledger');
    expect(out.reasons).not.toContain('[purged]');
    expect(out.recording.map(r => r.id)).toEqual(['intentReason', 'outcomeReason', 'both', 'queuedReason', 'markerOnly']);
    expect(out.recordingKeeper).toEqual(['keeper']);
    return out;
  });
});
