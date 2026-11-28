/**
 * BrainEngine parity — the facts purge statements that ran through `executeRaw` in gone-page-facts.ts, purge-reasons.ts,
 * held-fact-move.ts and purge-verify.ts (engine-sql/facts-purge.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: expireFactsOfGonePages, readPurgeSourceLocalPath, listGitEffectsCarryingReason,
 *    listPageGitEffectsForStrip, setPurgeEffectData, listPageChangeReasons, listRequestsRecordingReasons, heldEntityPageDeleted,
 *    heldTargetPageLive, readHeldAccessState, listHeldMoveRows, listStruckHeldRows, readHeldRowVisibility, heldMoveDue,
 *    readHeldConfigValue, readHeldPageLocation, readHeldVersionsEdited, listSegmentedPageBodies, listSegmentedVersionBodies,
 *    setPurgeProbeTimeout, probePurgeDerivations, listBeliefEventsForPurgeProbe, listFactContextsForPurgeProbe,
 *    listPageSourcePathsForPurge, listNearestFactsForPurge, countLegacyDerivedPages, vacuumPurgedTables, listPageProseHits,
 *    readPurgeReceiptSourcePath, countPagePurgeTombstones, readDeletePageRequest, listPurgeEffects and
 *    countPurgeFingerprintResidue return the same observable result on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: an engine that answers one of these differently changes which facts a page purge expires, which commit
 *    messages and change reasons a purge redacts or tombstones, which held facts a sync moves to which page, and what the
 *    purge receipt says is left; the Rust engine has no SQL, so each read has to exist as a typed method it can implement
 *    or refuse.
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call (D18),
 *    so no case compared them across engines.
 *  - Seam: none in the cases. Typed members only (no executeRaw: D18). The write journal's requests and effects are
 *    seeded through the typed journal members (insertWriteRequest, insertPublicationEffects, completeWriteRow); access
 *    rules, page purge tombstones, sources and the belief ledger's coverage through the harness fixtures. Takes are
 *    seeded with addTakesBatch, stored derivation results with publishSegmentedPage and upsertSegmentDerivations, and
 *    belief events by the production baseline (enableBeliefCoverage), so each of those three has a case on real rows
 *    next to the empty-table answers of the older cases. Generated values (fact ids, effect ids, journal ids, revisions,
 *    page and occurrence ids) are compared by relation or shape, never by value.
 */
import { describe, expect } from 'bun:test';
import { createSource, enableBeliefCoverage, parityArms, recordPagePurge, restrictFolder } from './harness.ts';
import { pageMeta, publishSegmentedPage, segmentText, sha256 } from '../helpers/page-body-fixtures.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine, NewFact } from '../../src/core/engine.ts';
import { CONVERSATION_FACTS_SOURCE_PREFIX } from '../../src/core/facts/conversation-publication.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const LANE = 'hook:agent-session';
const HOLDING = 'memory/unattributed';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQ = 'b0000000-0000-4000-8000-0000000000b1';
const REQ2 = 'b0000000-0000-4000-8000-0000000000b2';
const TOKEN = 'c0000000-0000-4000-8000-0000000000c1';
const PRINCIPAL = { kind: 'local_cli', id: 'parity-writer' };
const KEYS = ['principal:local_cli:parity-writer', 'brain'];

const note = (title: string, body: string, frontmatter: Record<string, unknown> = {}, type = 'note', extra: Record<string, unknown> = {}) =>
  ({ type: type as 'note', title, compiled_truth: body, frontmatter, ...extra });

/** The next fence row number of each engine, so every arm numbers its rows alike. */
const rows = new WeakMap<BrainEngine, number>();
function nextRow(engine: BrainEngine): number {
  const n = (rows.get(engine) ?? 0) + 1;
  rows.set(engine, n);
  return n;
}

/** One fact through the typed `insertFact`; `extra` overrides the defaults. Returns the id as a number. */
async function fact(engine: BrainEngine, text: string, extra: Record<string, unknown> = {}, sourceId = SRC): Promise<number> {
  const out = await engine.insertFact({ fact: text, entity_slug: null, visibility: 'private', source: LANE, embedding: null, ...extra } as NewFact, { source_id: sourceId });
  expect(out.status).toBe('inserted');
  return Number(out.id);
}

/** A fact held by a page's fence: `insertFacts` keeps `row_num` and `source_markdown_slug`. */
async function fenced(engine: BrainEngine, text: string, extra: Record<string, unknown> = {}, sourceId = SRC): Promise<number> {
  const res = await engine.insertFacts([{ fact: text, entity_slug: null, kind: 'fact', visibility: 'world', source: 'fence', row_num: nextRow(engine), ...extra }] as never, { source_id: sourceId });
  return Number(res.ids[0]);
}

/** A 1536-wide vector with `head` in the first slots. */
function vec(...head: number[]): Float32Array {
  const v = new Float32Array(1536);
  head.forEach((x, i) => { v[i] = x; });
  return v;
}

/** What each fact says and whether it is still live, by its text. */
async function liveness(engine: BrainEngine, sourceId = SRC): Promise<Record<string, boolean>> {
  const all = await engine.listFactsSince(sourceId, new Date(0), { activeOnly: false, limit: 1000 } as never);
  return Object.fromEntries(all.map(f => [f.fact, f.expired_at == null]).sort(([a], [b]) => String(a).localeCompare(String(b))));
}

/** One queued write request of the default source; returns its journal id. */
async function admit(engine: BrainEngine, requestId: string, over: { operation?: string; slug?: string | null; intent?: unknown } = {}): Promise<string> {
  const source = await engine.readSourceMembership(SRC);
  await engine.lockPersistenceCounters(KEYS);
  const slug = over.slug === undefined ? 'notes/a' : over.slug;
  return (await engine.insertWriteRequest({
    principalKind: PRINCIPAL.kind, principalId: PRINCIPAL.id, requestId, operation: over.operation ?? 'put_page', sourceId: SRC,
    sourceIncarnation: source!.incarnation, pageId: null, slug, worktreeId: null, topologyGeneration: null,
    digest: 'd'.repeat(64), intent: over.intent ?? { kind: 'put_page', slug }, authority: { scopes: ['write'] }, intentBytes: 100,
    terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: KEYS,
    clientRequestId: null, state: 'queued', deferredRefreshId: null,
  })).id;
}

/** Queue the given effects under the request `journalId`. */
async function queueEffects(engine: BrainEngine, journalId: string, effects: Array<{ kind: string; data: Record<string, unknown> }>): Promise<void> {
  const incarnation = (await engine.readSourceMembership(SRC))!.incarnation;
  await engine.transactionDirect(async tx => {
    await tx.declarePersistence();
    return tx.insertPublicationEffects({ requestId: journalId, revision: null, sourceId: SRC, sourceIncarnation: incarnation, worktreeId: null, effects: effects as never });
  });
}

describe('engine parity: purge, purge receipt and held-fact move statements of the facts store', () => {
  parityTest('expireFactsOfGonePages expires the facts filed on, extracted from and about the gone pages, and only theirs', {
    methods: ['putPage', 'insertFact', 'insertFacts', 'listFactsSince', 'expireFactsOfGonePages'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('notes/kept', note('Kept', 'a live page'));
    // Filed on a gone page: expired. Filed on a live page, or in another source: kept.
    await fenced(engine, 'filed on gone', { source_markdown_slug: 'notes/gone', visibility: 'private' });
    await fenced(engine, 'filed on kept', { source_markdown_slug: 'notes/kept', visibility: 'private' });
    await fenced(engine, 'filed on gone, other source', { source_markdown_slug: 'notes/gone', visibility: 'private' }, 'other');
    // A conversation fact's slot is filed on the page and gives up its slot with the row.
    await fenced(engine, 'slot on gone', { source_markdown_slug: 'notes/gone', source: `${CONVERSATION_FACTS_SOURCE_PREFIX}:parity`, dimension: 'city', value: 'Paris', visibility: 'private' });
    // An ontology observation filed under another source is provenance, not a filed fact: kept.
    await fenced(engine, 'ontology observation', { source_markdown_slug: 'notes/gone', source: 'sync:import', dimension: 'city', value: 'Rome', visibility: 'private' });
    // Extracted from the gone page (a page-extraction source, its slug as the context head): expired; any other source or head: kept.
    await fact(engine, 'extracted from gone', { source: 'mcp:put_page', context: 'notes/gone \u2014 a note' });
    await fact(engine, 'extracted from kept', { source: 'mcp:put_page', context: 'notes/kept \u2014 a note' });
    await fact(engine, 'chat from gone', { source: 'chat', context: 'notes/gone \u2014 a note' });
    // About the gone page (no page row holds it): expired; held by another page that exists: kept.
    await fact(engine, 'about gone', { entity_slug: 'notes/gone' });
    await fenced(engine, 'about gone, held by kept', { entity_slug: 'notes/gone', source_markdown_slug: 'notes/kept', visibility: 'private' });
    await fact(engine, 'about kept', { entity_slug: 'notes/kept' });
    const before = await liveness(engine);
    await engine.expireFactsOfGonePages([SRC, SRC], ['notes/gone', 'notes/missing']);
    const after = await liveness(engine);
    const untouched = await liveness(engine, 'other');
    await engine.expireFactsOfGonePages([SRC], ['notes/kept']);
    const second = await liveness(engine);
    expect(Object.values(before).every(Boolean)).toBe(true);
    expect(after).toEqual({
      'about gone': false, 'about gone, held by kept': true, 'about kept': true, 'chat from gone': true, 'extracted from gone': false,
      'extracted from kept': true, 'filed on gone': false, 'filed on kept': true, 'ontology observation': true, 'slot on gone': false,
    });
    expect(untouched).toEqual({ 'filed on gone, other source': true });
    expect(second['filed on kept']).toBe(false);
    return { after, untouched, second };
  });

  parityTest('readPurgeSourceLocalPath and readPurgeReceiptSourcePath read the checkout of one source, null for none', {
    methods: ['readPurgeSourceLocalPath', 'readPurgeReceiptSourcePath'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'with-path', {}, '/parity/checkout');
    await createSource(engine, backend, 'no-path');
    const answers = {
      scan: [await engine.readPurgeSourceLocalPath('with-path'), await engine.readPurgeSourceLocalPath('no-path'), await engine.readPurgeSourceLocalPath('unknown')],
      receipt: [await engine.readPurgeReceiptSourcePath('with-path'), await engine.readPurgeReceiptSourcePath('no-path'), await engine.readPurgeReceiptSourcePath('unknown')],
    };
    expect(answers).toEqual({ scan: ['/parity/checkout', null, null], receipt: ['/parity/checkout', null, null] });
    return answers;
  });

  parityTest('the Git effect reads lock the effects that carry a reason or name a page, and setPurgeEffectData rewrites one effect\'s data', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'transactionDirect', 'declarePersistence', 'insertPublicationEffects', 'transaction',
      'listGitEffectsCarryingReason', 'listPageGitEffectsForStrip', 'setPurgeEffectData'],
  }, async (engine) => {
    const journal = await admit(engine, REQ);
    await queueEffects(engine, journal, [
      { kind: 'git', data: { slug: 'notes/a', commit_line: 'Fix the Needle claim', commit_trailers: ['gbrain-reason: needle', 'other: kept'] } },
      { kind: 'embedding', data: { slug: 'notes/a', commit_line: 'needle in a non-Git effect' } },
    ]);
    const second = await admit(engine, REQ2, { slug: 'notes/b' });
    await queueEffects(engine, second, [{ kind: 'git', data: { slug: 'notes/b', commit_line: 'unrelated', relative_path: 'notes/b.md' } }]);
    const shape = (list: Array<{ id: string; state: string; request_id: string; data: Record<string, unknown> }>) =>
      list.map(r => ({ idIsText: typeof r.id === 'string' && /^\d+$/.test(r.id), state: r.state, request: r.request_id, data: r.data }));
    const answers = await engine.transaction(async tx => {
      const carrying = await tx.listGitEffectsCarryingReason(SRC, 'needle', 'no-such-escaped-form', 'no-such-folded-form');
      const none = await tx.listGitEffectsCarryingReason(SRC, 'absent', 'absent-too', 'absent-three');
      const escaped = await tx.listGitEffectsCarryingReason(SRC, 'absent', 'unrelated', 'absent-three');
      const named = await tx.listPageGitEffectsForStrip(SRC, 'notes/a');
      const nameless = await tx.listPageGitEffectsForStrip(SRC, 'notes/missing');
      await tx.setPurgeEffectData(carrying[0]!.id, { slug: 'notes/a', commit_line: '[purged]', commit_trailers: ['other: kept'] });
      const redacted = await tx.listPageGitEffectsForStrip(SRC, 'notes/a');
      return { carrying: shape(carrying), none: shape(none), escaped: shape(escaped), named: shape(named), nameless: shape(nameless), redacted: shape(redacted) };
    });
    expect(answers.carrying).toHaveLength(1);
    expect(answers.none).toEqual([]);
    expect(answers.escaped.map(r => r.request)).toEqual([REQ2]);
    expect(answers.nameless).toEqual([]);
    expect(answers.redacted[0]!.data).toEqual({ slug: 'notes/a', commit_line: '[purged]', commit_trailers: ['other: kept'] });
    return answers;
  });

  parityTest('listPageChangeReasons gathers the reasons of a page\'s versions and its requests, and listRequestsRecordingReasons the requests that recorded one', {
    methods: ['putPage', 'createVersion', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'listPageChangeReasons', 'listRequestsRecordingReasons'],
  }, async (engine) => {
    const page = await engine.putPage('notes/a', note('A', 'body'));
    await engine.createVersion('notes/a', { sourceId: SRC, reason: 'rewrote the intro' });
    await engine.createVersion('notes/a', { sourceId: SRC });
    await admit(engine, REQ, { slug: 'notes/a', intent: { kind: 'put_page', slug: 'notes/a', reason: 'created it' } });
    await admit(engine, REQ2, { slug: 'notes/a', intent: { kind: 'put_page', slug: 'notes/a' } });
    await admit(engine, 'b0000000-0000-4000-8000-0000000000b3', { slug: 'notes/other', intent: { kind: 'put_page', reason: 'someone else' } });
    const reasons = (await engine.listPageChangeReasons(SRC, 'notes/a', page.id)).map(r => r.reason).sort((a, b) => String(a).localeCompare(String(b)));
    const noPage = (await engine.listPageChangeReasons(SRC, 'notes/none', page.id + 1000)).map(r => r.reason);
    const recording = (await engine.listRequestsRecordingReasons(SRC, 'notes/a')).map(r => ({ principal: `${r.principal_kind}:${r.principal_id}`, idIsText: typeof r.id === 'string' }));
    const nobody = await engine.listRequestsRecordingReasons(SRC, 'notes/none');
    expect(reasons).toEqual(['created it', 'rewrote the intro', null].sort((a, b) => String(a).localeCompare(String(b))));
    expect(noPage).toEqual([]);
    expect(recording).toEqual([{ principal: 'local_cli:parity-writer', idIsText: true }]);
    expect(nobody).toEqual([]);
    return { reasons, noPage, recording, nobody };
  });

  parityTest('heldEntityPageDeleted and heldTargetPageLive tell a soft-deleted page from a live one and from none', {
    methods: ['putPage', 'softDeletePage', 'heldEntityPageDeleted', 'heldTargetPageLive'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('people/live', note('Live', 'a'));
    await engine.putPage('people/gone', note('Gone', 'b'));
    await engine.softDeletePage('people/gone');
    const asked = async (slug: string, sourceId = SRC) => ({ deleted: await engine.heldEntityPageDeleted(sourceId, slug), live: await engine.heldTargetPageLive(sourceId, slug) });
    const answers = { live: await asked('people/live'), gone: await asked('people/gone'), none: await asked('people/none'), otherSource: await asked('people/live', 'other') };
    expect(answers).toEqual({ live: { deleted: false, live: true }, gone: { deleted: true, live: false }, none: { deleted: false, live: false }, otherSource: { deleted: false, live: false } });
    return answers;
  });

  parityTest('readHeldAccessState reads whether the access state is readable, an exact page rule covers the entity and a folder rule restricts it', {
    methods: ['readHeldAccessState'],
  }, async (engine, backend) => {
    // The harness fixture writes one fixed rule id per source, so each kind of rule goes to its own source.
    await createSource(engine, backend, 'folder-src');
    await createSource(engine, backend, 'pending-src');
    const read = async (entity: string, sourceId = SRC) => (await engine.readHeldAccessState(sourceId, entity)).map(r => ({ unreadable: r.unreadable, page_rule: r.page_rule, restricted: r.restricted }));
    const open = await read('people/a');
    await restrictFolder(engine, backend, SRC, 'people/exact', 'rule');
    await restrictFolder(engine, backend, 'folder-src', 'secret/', 'rule');
    await restrictFolder(engine, backend, 'pending-src', 'later/', 'pending');
    const answers = { open, exact: await read('people/exact'), folder: await read('secret/x', 'folder-src'), pending: await read('later/x', 'pending-src'), other: await read('people/b') };
    expect(answers.open).toEqual([{ unreadable: false, page_rule: false, restricted: false }]);
    expect(answers.exact[0]!.page_rule).toBe(true);
    expect(answers.folder[0]).toMatchObject({ page_rule: false, restricted: true });
    expect(answers.pending[0]).toMatchObject({ page_rule: false, restricted: true });
    expect(answers.other[0]).toMatchObject({ page_rule: false, restricted: false });
    return answers;
  });

  parityTest('listHeldMoveRows lists a holding page\'s live held rows and listStruckHeldRows its struck ones, keyed by page and entity', {
    methods: ['putPage', 'insertFacts', 'expireFact', 'listHeldMoveRows', 'listStruckHeldRows'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage(HOLDING, note('Held', 'holding page'));
    await engine.putPage('people/a', note('A', 'a'));
    const held = (text: string, entity: string, extra: Record<string, unknown> = {}, sourceId = SRC) =>
      fenced(engine, text, { source_markdown_slug: HOLDING, entity_slug: entity, visibility: 'private', ...extra }, sourceId);
    await held('live for a', 'people/a');
    await held('live for b', 'people/b');
    const struckOnce = await held('struck once', 'people/a');
    const struckReused = await held('struck then reused', 'people/b');
    await engine.expireFact(struckOnce);
    await engine.expireFact(struckReused);
    // Not held rows: a row of the holding page itself, no row number, a dimension, another source, another page's fence.
    await held('about the holding page', HOLDING);
    await fenced(engine, 'on another page', { source_markdown_slug: 'people/a', entity_slug: 'people/a', visibility: 'private' });
    await fenced(engine, 'a slot', { source_markdown_slug: HOLDING, entity_slug: 'people/a', source: `${CONVERSATION_FACTS_SOURCE_PREFIX}:parity`, dimension: 'city', value: 'Paris', visibility: 'private' });
    await held('in another source', 'people/a', {}, 'other');
    const liveRows = await engine.listHeldMoveRows(SRC);
    const struckRows = await engine.listStruckHeldRows(SRC);
    const answers = {
      live: liveRows.map(r => ({ fact: r.fact, entity: r.entity_slug, from: r.from_slug, source: r.source_id, pageExists: r.page_exists })),
      struck: struckRows.map(r => ({ fact: r.fact, entity: r.entity_slug, from: r.from_slug, row: typeof r.row_num })),
      otherSource: (await engine.listHeldMoveRows('other')).map(r => r.fact),
    };
    expect(answers.live.map(r => r.fact)).toEqual(['live for a', 'live for b']);
    expect(answers.struck.map(r => r.fact).sort()).toEqual(['struck once', 'struck then reused']);
    return answers;
  });

  parityTest('readHeldRowVisibility says whether a live page is readable by every reader, null for none', { methods: ['putPage', 'softDeletePage', 'readHeldRowVisibility'] }, async (engine) => {
    await engine.putPage('people/open', note('Open', 'a'));
    await engine.putPage('people/private', note('Private', 'b', { visibility: 'private' }));
    await engine.putPage('people/gone', note('Gone', 'c'));
    await engine.softDeletePage('people/gone');
    const answers = { open: await engine.readHeldRowVisibility(SRC, 'people/open'), private: await engine.readHeldRowVisibility(SRC, 'people/private'),
      gone: await engine.readHeldRowVisibility(SRC, 'people/gone'), none: await engine.readHeldRowVisibility(SRC, 'people/none') };
    expect(answers).toEqual({ open: { visible: true }, private: { visible: false }, gone: null, none: null });
    return answers;
  });

  parityTest('heldMoveDue is true once a rule narrows a held row\'s entity below its holding page, and only then', {
    methods: ['putPage', 'insertFacts', 'heldMoveDue'],
  }, async (engine, backend) => {
    await engine.putPage(HOLDING, note('Held', 'holding page'));
    await fenced(engine, 'held for a', { source_markdown_slug: HOLDING, entity_slug: 'people/a', visibility: 'private' });
    const open = await engine.heldMoveDue(SRC);
    await restrictFolder(engine, backend, SRC, 'people/', 'rule');
    const ruled = await engine.heldMoveDue(SRC);
    const elsewhere = await engine.heldMoveDue('no-such-source');
    expect({ open, ruled, elsewhere }).toEqual({ open: false, ruled: true, elsewhere: false });
    return { open, ruled, elsewhere };
  });

  parityTest('readHeldConfigValue reads one config row, null when unset', { methods: ['setConfig', 'readHeldConfigValue'] }, async (engine) => {
    await engine.setConfig('sync.write_through', 'false');
    const answers = { set: await engine.readHeldConfigValue('sync.write_through'), unset: await engine.readHeldConfigValue('sync.never_set') };
    expect(answers).toEqual({ set: 'false', unset: null });
    return answers;
  });

  parityTest('readHeldPageLocation reads a live page\'s file path and URI, null for a deleted or missing page', {
    methods: ['putPage', 'softDeletePage', 'readHeldPageLocation'],
  }, async (engine) => {
    await engine.putPage('people/file', note('File', 'a', {}, 'note', { source_path: 'people/file.md' }));
    await engine.putPage('people/db-only', note('Db', 'b'));
    await engine.putPage('people/gone', note('Gone', 'c', {}, 'note', { source_path: 'people/gone.md' }));
    await engine.softDeletePage('people/gone');
    const answers = { file: await engine.readHeldPageLocation(SRC, 'people/file'), dbOnly: await engine.readHeldPageLocation(SRC, 'people/db-only'),
      gone: await engine.readHeldPageLocation(SRC, 'people/gone'), none: await engine.readHeldPageLocation(SRC, 'people/none'),
      bounded: await engine.readHeldPageLocation(SRC, 'people/file', { timeoutMs: 30_000 }) };
    expect(answers.file).toEqual({ source_path: 'people/file.md', source_uri: answers.file!.source_uri });
    expect(answers.dbOnly).toEqual({ source_path: null, source_uri: null });
    expect(answers.gone).toBeNull();
    expect(answers.none).toBeNull();
    expect(answers.bounded).toEqual(answers.file);
    return answers;
  });

  parityTest('the held rows of a nested holding page and a soft-deleted holding page are listed, keyed by page then entity then id', {
    methods: ['putPage', 'softDeletePage', 'insertFacts', 'expireFact', 'listHeldMoveRows', 'listStruckHeldRows'],
  }, async (engine) => {
    const NESTED = 'members/ann/memory/unattributed';
    const GONE = 'archive/memory/unattributed';
    for (const slug of [HOLDING, NESTED, GONE]) await engine.putPage(slug, note('Held', slug));
    const held = (text: string, page: string, entity: string, extra: Record<string, unknown> = {}) =>
      fenced(engine, text, { source_markdown_slug: page, entity_slug: entity, visibility: 'private', ...extra });
    await held('top for z', HOLDING, 'people/z');
    await held('nested for a', NESTED, 'people/a');
    await held('top for a, first', HOLDING, 'people/a');
    await held('top for a, second', HOLDING, 'people/a');
    await held('gone for m', GONE, 'people/m');
    const deadTop = await held('struck on nested', NESTED, 'people/a');
    await engine.expireFact(deadTop);
    // A page that is no holding page, and an entity that is itself a holding page: not held rows.
    await held('on an ordinary page', 'people/a', 'people/a');
    await held('about a nested holding page', HOLDING, NESTED);
    // Deleting a holding page leaves its row in `pages`, which is all the SQL tests for.
    await engine.softDeletePage(GONE);
    const live = (await engine.listHeldMoveRows(SRC)).map(r => `${r.from_slug}|${r.entity_slug}|${r.fact}|${r.page_exists}`);
    const struck = (await engine.listStruckHeldRows(SRC)).map(r => `${r.from_slug}|${r.entity_slug}|${r.fact}`);
    expect(live).toEqual([
      'archive/memory/unattributed|people/m|gone for m|true',
      'members/ann/memory/unattributed|people/a|nested for a|true',
      'memory/unattributed|people/a|top for a, first|true',
      'memory/unattributed|people/a|top for a, second|true',
      'memory/unattributed|people/z|top for z|true',
    ]);
    expect(struck).toEqual(['members/ann/memory/unattributed|people/a|struck on nested']);
    return { live, struck };
  });

  parityTest('readHeldRowVisibility hides a page that names readers or carries an access alias, and shows a page of another source only as none', {
    methods: ['putPage', 'readHeldRowVisibility'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('people/open', note('Open', 'a'));
    await engine.putPage('people/readers', note('Readers', 'b', { readable_by: ['member:ann'] }));
    await engine.putPage('people/alias', note('Alias', 'c', { access: 'confidential' }));
    await engine.putPage('people/atom', note('Atom', 'd', {}, 'atom'));
    await engine.putPage('people/open', note('Open elsewhere', 'e', { visibility: 'private' }), { sourceId: 'other' } as never);
    const answers = {
      open: await engine.readHeldRowVisibility(SRC, 'people/open'), readers: await engine.readHeldRowVisibility(SRC, 'people/readers'),
      alias: await engine.readHeldRowVisibility(SRC, 'people/alias'), atom: await engine.readHeldRowVisibility(SRC, 'people/atom'),
      other: await engine.readHeldRowVisibility('other', 'people/open'), nowhere: await engine.readHeldRowVisibility('other', 'people/readers'),
    };
    expect(answers.open).toEqual({ visible: true });
    expect(answers.readers).toEqual({ visible: false });
    expect(answers.other).toEqual({ visible: false });
    expect(answers.nowhere).toBeNull();
    return answers;
  });

  parityTest('readHeldVersionsEdited reads the segmented versions a held-fact move did not edit, 0 when none was recorded', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow', 'transaction', 'readHeldVersionsEdited'],
  }, async (engine) => {
    const source = await engine.readSourceMembership(SRC);
    const insert = (tx: BrainEngine, requestId: string) => tx.insertWriteRequest({
      principalKind: PRINCIPAL.kind, principalId: PRINCIPAL.id, requestId, operation: 'put_page', sourceId: SRC,
      sourceIncarnation: source!.incarnation, pageId: null, slug: 'notes/a', worktreeId: null, topologyGeneration: null,
      digest: 'd'.repeat(64), intent: { kind: 'put_page', slug: 'notes/a' }, authority: { scopes: ['write'] }, intentBytes: 100,
      terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: KEYS,
      clientRequestId: null, state: 'queued', deferredRefreshId: null,
    });
    await engine.transaction(async tx => {
      await tx.lockPersistenceCounters(KEYS);
      const withEdits = await insert(tx, REQ);
      await tx.stampWriteClaim(withEdits.id, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
      await tx.completeWriteRow({
        id: withEdits.id, state: 'committed', outcome: { held_versions_edited: { segmented_versions_not_edited: 3 } }, errorCode: null, errorMessage: null, consumerVersion: 'parity',
        consumerHostId: null, errorDetail: null, resultBytes: 1200, counterKeys: KEYS, intentBytes: 100, retainedBytes: 1500, terminalReservation: 4096, probePurges: false,
      });
    });
    await engine.transaction(async tx => { await tx.lockPersistenceCounters(KEYS); await insert(tx, REQ2); });
    const answers = { edited: await engine.readHeldVersionsEdited(REQ), unrecorded: await engine.readHeldVersionsEdited(REQ2), unknown: await engine.readHeldVersionsEdited('b0000000-0000-4000-8000-0000000000ff') };
    expect(answers).toEqual({ edited: 3, unrecorded: 0, unknown: 0 });
    return answers;
  });

  parityTest('listSegmentedPageBodies and listSegmentedVersionBodies list the segmented bodies of a source in id order, within the limit', {
    methods: ['putPage', 'createSegmentedPageShell', 'createVersion', 'listSegmentedPageBodies', 'listSegmentedVersionBodies'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('notes/inline', note('Inline', 'a body'));
    await engine.createSegmentedPageShell('notes/seg-a', pageMeta('Seg A'), { sourceId: SRC });
    await engine.createSegmentedPageShell('notes/seg-b', pageMeta('Seg B'), { sourceId: SRC });
    await engine.createSegmentedPageShell('notes/seg-other', pageMeta('Seg other'), { sourceId: 'other' });
    await engine.createVersion('notes/inline', { sourceId: SRC });
    let versionError: string | null = null;
    try { await engine.createVersion('notes/seg-a', { sourceId: SRC }); } catch (e) { versionError = String((e as Error).message).slice(0, 60); }
    const slugs = (list: Array<{ slug: string }>) => list.map(r => r.slug);
    const answers = {
      pages: (await engine.listSegmentedPageBodies(SRC, 10)).map(r => ({ slug: r.slug, generation: r.generation, version: r.version_id })),
      limited: slugs(await engine.listSegmentedPageBodies(SRC, 1)),
      other: slugs(await engine.listSegmentedPageBodies('other', 10)),
      versions: slugs(await engine.listSegmentedVersionBodies(SRC, 10)),
      versionsLimited: slugs(await engine.listSegmentedVersionBodies(SRC, 0)),
      versionError,
    };
    expect(answers.pages).toEqual([{ slug: 'notes/seg-a', generation: null, version: null }, { slug: 'notes/seg-b', generation: null, version: null }]);
    expect(answers.limited).toEqual(['notes/seg-a']);
    expect(answers.other).toEqual(['notes/seg-other']);
    expect(answers.versionsLimited).toEqual([]);
    return answers;
  });

  parityTest('setPurgeProbeTimeout bounds the statements of its transaction, and probePurgeDerivations scans one batch of stored derivation results', {
    methods: ['putPage', 'transaction', 'setPurgeProbeTimeout', 'probePurgeDerivations'],
  }, async (engine) => {
    const page = await engine.putPage('notes/a', note('A', 'body'));
    const probe = (cursor: [number, string, string] | null, ids: number[]) => engine.transaction(async tx => {
      await tx.setPurgeProbeTimeout(2000);
      return tx.probePurgeDerivations(SRC, ['needle'], ids, ['%needle%'], cursor, 100);
    });
    const empty = await probe(null, []);
    const withPages = await probe(null, [page.id]);
    const afterCursor = await probe([page.id, 'synopsis', '9'], [page.id]);
    const shape = (r: Awaited<typeof empty>) => ({ scanned: Number(r.scanned), normalized: Number(r.normalized), swept: Number(r.swept), kept: Number(r.kept),
      last_page: r.last_page, last_pipeline: r.last_pipeline, last_occurrence: r.last_occurrence });
    const answers = { empty: shape(empty), withPages: shape(withPages), afterCursor: shape(afterCursor) };
    const none = { scanned: 0, normalized: 0, swept: 0, kept: 0, last_page: null, last_pipeline: null, last_occurrence: null };
    expect(answers).toEqual({ empty: none, withPages: none, afterCursor: none });
    return answers;
  });

  parityTest('listBeliefEventsForPurgeProbe and listFactContextsForPurgeProbe page through a source\'s recorded values and fact contexts after an id', {
    methods: ['insertFact', 'listFactContextsForPurgeProbe', 'listBeliefEventsForPurgeProbe'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const first = await fact(engine, 'first', { context: 'ctx one' });
    await fact(engine, 'second', { context: 'ctx two' });
    await fact(engine, 'no context', { context: null });
    await fact(engine, 'blank context', { context: '' });
    const expired = await fact(engine, 'expired', { context: 'ctx expired' });
    await fact(engine, 'elsewhere', { context: 'ctx other' }, 'other');
    await engine.expireFact(expired);
    const contexts = async (after: number) => (await engine.listFactContextsForPurgeProbe(SRC, after)).map(r => r.context);
    const answers = {
      all: await contexts(0), afterFirst: await contexts(first), afterAll: await contexts(first + 1000), beliefs: await engine.listBeliefEventsForPurgeProbe(SRC, 0),
    };
    expect(answers).toEqual({ all: ['ctx one', 'ctx two'], afterFirst: ['ctx two'], afterAll: [], beliefs: [] });
    return answers;
  });

  parityTest('listFactContextsForPurgeProbe is a keyset read: the lowest 1000 live ids with a context above the cursor, in id order', {
    methods: ['insertFacts', 'expireFact', 'listFactContextsForPurgeProbe'],
    timeout: 120_000,
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const label = (n: number) => `ctx ${String(n).padStart(4, '0')}`;
    const batch = async (from: number, to: number, sourceId = SRC) => {
      const out = [];
      for (let n = from; n <= to; n++) {
        // Row 5 has a blank context and row 7 none, so the probe passes them by.
        const context = n === 5 ? '' : n === 7 ? null : sourceId === SRC ? label(n) : `other ${n}`;
        out.push({ fact: `fact ${n} of ${sourceId}`, entity_slug: null, kind: 'fact', visibility: 'world', source: 'fence', source_markdown_slug: 'notes/contexts', row_num: nextRow(engine), context });
      }
      const res = await engine.insertFacts(out as never, { source_id: sourceId });
      expect(res.inserted).toBe(to - from + 1);
      return res.ids.map(Number);
    };
    // The other source's ids sit inside the range of this source's ids, so a read that drops the source test fails.
    const low = await batch(1, 500);
    const other = await batch(1, 3, 'other');
    await batch(501, 1010);
    await engine.expireFact(low[9]!); // row 10
    const page = async (after: number) => {
      const got = await engine.listFactContextsForPurgeProbe(SRC, after);
      const ids = got.map(r => Number(r.id));
      expect(ids.every((id, i) => i === 0 || id > ids[i - 1]!)).toBe(true);
      expect(ids.every(id => id > after)).toBe(true);
      return { contexts: got.map(r => r.context), last: ids.at(-1) ?? null };
    };
    const first = await page(0);
    const second = await page(first.last!);
    const third = await page(second.last!);
    // A cursor that is another source's id starts after it, with this source's next row.
    const fromOther = await page(other[0]!);
    const live = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i).filter(n => n !== 5 && n !== 7 && n !== 10).map(label);
    expect(first.contexts).toEqual(live(1, 1003));
    expect(second.contexts).toEqual(live(1004, 1010));
    expect(third.contexts).toEqual([]);
    expect(fromOther.contexts.slice(0, 2)).toEqual([label(501), label(502)]);
    expect(fromOther.contexts.length).toBe(510);
    return { first: first.contexts, second: second.contexts, third: third.contexts, fromOther: fromOther.contexts };
  });

  // On a Rust brain the receipt's ledger reads (listBeliefEventsForPurgeProbe, listFactContextsForPurgeProbe) are served
  // and the source records no belief events, so the CLI call passes the purge's pre-write check
  // (persistence/fact-purge-path-members.ts) and equals PGLite. The MCP call is refused as host-only first.
  parityTest('purge_fact gives CLI and MCP callers the same belief_events and fact_context reports when the brain records no belief events', {
    methods: ['insertFact', 'listBeliefEventsForPurgeProbe', 'listFactContextsForPurgeProbe'],
    timeout: 120_000,
  }, async (engine) => {
    const target = await fact(engine, 'Alice likes oolong tea', { entity_slug: 'people/alice', context: 'said at lunch' });
    const quoting = await fact(engine, 'Bob met Alice', { entity_slug: 'people/bob', context: 'Bob said alice likes oolong tea at lunch' });
    const call = async (name: string, params: Record<string, unknown>, remote: boolean) => {
      const res = await dispatchToolCall(engine, name, params, { remote });
      const text = res.content[0]!.text!;
      // A refused CLI call ends the case with its error envelope (an engine refusal stops the Rust arm by name).
      if (!remote && res.isError === true) throw Object.assign(new Error(text), JSON.parse(text) as Record<string, unknown>);
      return { isError: res.isError === true, text };
    };
    try {
      const mcp = await call('purge_fact', { id: target, dry_run: true }, true);
      const dry = JSON.parse((await call('purge_fact', { id: target, dry_run: true }, false)).text) as Record<string, unknown>;
      const run = await call('purge_fact', { id: target, confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: REQ }, false);
      const stores = (JSON.parse(run.text) as { stores: { store: string }[] }).stores;
      const out = {
        mcp: { isError: mcp.isError, code: (JSON.parse(mcp.text) as { error?: string; code?: string }).code ?? (JSON.parse(mcp.text) as { error?: string }).error },
        // The receipt text, with the generated id of the quoting fact named by relation.
        cli: { isError: run.isError, ledger: JSON.stringify(stores.filter(s => s.store === 'belief_events' || s.store === 'fact_context')).replaceAll(`"f${quoting}"`, '"f<quoting>"') },
      };
      expect(out.cli.isError).toBe(false);
      expect(JSON.parse(out.cli.ledger)).toEqual([{ store: 'belief_events', status: 'not_present', removed: 0 },
        expect.objectContaining({ store: 'fact_context', status: 'out_of_scope', reason: 'source_prose', remaining: 1, items: ['f<quoting>'] })]);
      return out;
    } finally {
      await disposePersistenceConsumer(engine).catch(() => undefined);
    }
  });

  parityTest('listPageSourcePathsForPurge lists the distinct relative file paths of pages and their versions, skipping absolute and parent paths', {
    methods: ['putPage', 'createVersion', 'listPageSourcePathsForPurge'],
  }, async (engine) => {
    const at = (path: string | undefined) => (path === undefined ? {} : { source_path: path });
    const a = await engine.putPage('notes/a', note('A', 'a', {}, 'note', at('notes/a.md')));
    const b = await engine.putPage('notes/b', note('B', 'b', {}, 'note', at('notes/b.md')));
    const absolute = await engine.putPage('notes/abs', note('Abs', 'c', {}, 'note', at('/etc/abs.md')));
    const parent = await engine.putPage('notes/parent', note('Parent', 'd', {}, 'note', at('notes/../parent.md')));
    const bare = await engine.putPage('notes/bare', note('Bare', 'e', {}));
    await engine.createVersion('notes/a', { sourceId: SRC });
    const ids = [a, b, absolute, parent, bare].map(p => p.id);
    const answers = { all: (await engine.listPageSourcePathsForPurge(ids)).map(r => r.source_path).sort(), onlyA: (await engine.listPageSourcePathsForPurge([a.id])).map(r => r.source_path),
      none: await engine.listPageSourcePathsForPurge([]) };
    expect(answers).toEqual({ all: ['notes/a.md', 'notes/b.md'], onlyA: ['notes/a.md'], none: [] });
    return answers;
  });

  parityTest('listNearestFactsForPurge ranks the same-model facts of the source by distance, naming the ones that contain the claim', {
    methods: ['insertFact', 'loadPurgeTarget', 'listNearestFactsForPurge'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const names = new Map<number, string>();
    const one = async (label: string, head: number[], model: string | null, text = label, sourceId = SRC) => {
      const id = await fact(engine, text, { embedding: vec(...head), embedding_model: model }, sourceId);
      names.set(id, label);
      return id;
    };
    const target = await one('target', [1, 0.5, 0.1], 'm1', 'Alice likes tea');
    await one('near', [1, 0.4, 0.1], 'm1', 'ALICE LIKES TEA too');
    await one('far', [0, 0, 1], 'm1');
    await one('other model', [1, 0.5, 0.1], 'm2');
    await one('other source', [1, 0.5, 0.1], 'm1', 'Alice likes tea', 'other');
    await fact(engine, 'no vector', { embedding: null });
    const t = (await engine.loadPurgeTarget(target, SRC))!;
    const ranked = (await engine.listNearestFactsForPurge(t.embedding!, SRC, 'm1', 'alice likes tea'))
      .map(r => ({ fact: names.get(Number(r.id)), similarity: Math.round(Number(r.similarity) * 1000) / 1000, contains: r.contains_claim === true }));
    expect(ranked.map(r => r.fact)).toEqual(['target', 'near', 'far']);
    expect(ranked.map(r => r.contains)).toEqual([true, true, false]);
    return ranked;
  });

  parityTest('countLegacyDerivedPages counts the live atom and dream pages that no derivation edge explains', { methods: ['putPage', 'softDeletePage', 'countLegacyDerivedPages'] }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('atoms/a', note('A', 'a', {}, 'atom'));
    await engine.putPage('dreams/b', note('B', 'b', { dream_generated: true }));
    await engine.putPage('notes/plain', note('Plain', 'c'));
    await engine.putPage('atoms/gone', note('Gone', 'd', {}, 'atom'));
    await engine.softDeletePage('atoms/gone');
    const answers = { counted: await engine.countLegacyDerivedPages(SRC), other: await engine.countLegacyDerivedPages('other') };
    expect(answers).toEqual({ counted: 2, other: 0 });
    return answers;
  });

  parityTest('vacuumPurgedTables vacuums the purge-touched tables, with or without the query cache', { methods: ['vacuumPurgedTables'] }, async (engine) => {
    await engine.vacuumPurgedTables(false);
    await engine.vacuumPurgedTables(true);
    return 'ran';
  });

  parityTest('listPageProseHits lists the live pages whose own text, chunks, versions or timeline entries state a needle, case-insensitively', {
    methods: ['putPage', 'upsertChunks', 'createVersion', 'addTimelineEntry', 'softDeletePage', 'listPageProseHits'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('notes/body', note('Body', 'The Needle is in the body.'));
    await engine.putPage('notes/timeline', note('Timeline', 'nothing here', {}, 'note', { timeline: '- 2026-01-01: a NEEDLE in the timeline' }));
    await engine.putPage('notes/chunked', note('Chunked', 'plain'));
    await engine.upsertChunks('notes/chunked', [{ chunk_index: 0, chunk_text: 'a needle in a chunk', chunk_source: 'compiled_truth' }]);
    await engine.putPage('notes/versioned', note('Versioned', 'a needle before the rewrite'));
    await engine.createVersion('notes/versioned', { sourceId: SRC });
    await engine.putPage('notes/versioned', note('Versioned', 'rewritten clean'));
    await engine.putPage('notes/entry', note('Entry', 'nothing'));
    await engine.addTimelineEntry('notes/entry', { date: '2026-02-02', summary: 'Needle entry', detail: '' });
    await engine.putPage('notes/elsewhere', note('Elsewhere', 'needle', {}), { sourceId: 'other' } as never);
    await engine.putPage('notes/gone', note('Gone', 'needle in a deleted page'));
    await engine.softDeletePage('notes/gone');
    const stores = ['pages', 'content_chunks', 'page_versions', 'timeline_entries'] as const;
    const answers: Record<string, string[]> = {};
    for (const store of stores) answers[store] = (await engine.listPageProseHits(store, SRC, ['needle'])).map(r => r.slug);
    answers.nothing = (await engine.listPageProseHits('pages', SRC, ['absent'])).map(r => r.slug);
    answers.several = (await engine.listPageProseHits('pages', SRC, ['absent', 'rewritten'])).map(r => r.slug);
    expect(answers.pages).toEqual(['notes/body', 'notes/timeline']);
    expect(answers.page_versions).toEqual(['notes/versioned']);
    expect(answers.nothing).toEqual([]);
    return answers;
  });

  parityTest('countPagePurgeTombstones counts the page purge tombstones of one slug, and readDeletePageRequest finds that page\'s delete request', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'countPagePurgeTombstones', 'readDeletePageRequest'],
  }, async (engine, backend) => {
    await recordPagePurge(engine, backend, SRC, 'notes/a', 'h1');
    await recordPagePurge(engine, backend, SRC, 'notes/a', 'h2');
    await recordPagePurge(engine, backend, SRC, 'notes/b', 'h3');
    await admit(engine, REQ, { operation: 'delete_page', slug: 'notes/a' });
    await admit(engine, REQ2, { operation: 'put_page', slug: 'notes/a' });
    const request = await engine.readDeletePageRequest(SRC, REQ);
    const answers = {
      counts: [await engine.countPagePurgeTombstones(SRC, 'notes/a'), await engine.countPagePurgeTombstones(SRC, 'notes/b'), await engine.countPagePurgeTombstones(SRC, 'notes/none')],
      request: request && { idIsUuid: UUID.test(request.id), request_id: request.request_id, state: request.state, source_id: request.source_id, outcome: request.outcome ?? null },
      notDelete: await engine.readDeletePageRequest(SRC, REQ2),
      unknown: await engine.readDeletePageRequest(SRC, 'b0000000-0000-4000-8000-0000000000ff'),
    };
    expect(answers).toEqual({ counts: [2, 1, 0], request: { idIsUuid: true, request_id: REQ, state: 'queued', source_id: SRC, outcome: null }, notDelete: null, unknown: null });
    return answers;
  });

  parityTest('listPurgeEffects lists a request\'s effects in kind order with whether any target is parked', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'transactionDirect', 'declarePersistence', 'insertPublicationEffects', 'listPurgeEffects'],
  }, async (engine) => {
    const journal = await admit(engine, REQ, { operation: 'delete_page' });
    await queueEffects(engine, journal, [{ kind: 'git', data: { slug: 'notes/a', parked: [{ target: 'x' }] } }, { kind: 'embedding', data: { slug: 'notes/a' } }, { kind: 'links', data: { slug: 'notes/a', parked: [] } }]);
    const bare = await admit(engine, REQ2, { operation: 'delete_page' });
    const answers = { effects: await engine.listPurgeEffects(journal), none: await engine.listPurgeEffects(bare) };
    expect(answers.effects.map(e => [e.kind, e.state, e.error_code, e.parked])).toEqual([['embedding', 'queued', null, false], ['git', 'queued', null, true], ['links', 'queued', null, false]]);
    expect(answers.none).toEqual([]);
    return answers;
  });

  parityTest('countPurgeFingerprintResidue counts the facts and takes that still carry a purged claim, for one subject or all', {
    methods: ['insertFact', 'loadPurgeTarget', 'countPurgeFingerprintResidue'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const target = await fact(engine, 'Alice likes tea', { entity_slug: 'people/a' });
    await fact(engine, 'alice  LIKES tea', { entity_slug: 'people/a' });
    await fact(engine, 'Alice likes tea', { entity_slug: 'people/b' });
    await fact(engine, 'Alice likes coffee', { entity_slug: 'people/a' });
    await fact(engine, 'Alice likes tea', { entity_slug: 'people/a' }, 'other');
    const hash = (await engine.loadPurgeTarget(target, SRC))!.fact_hash;
    const answers = {
      everyone: await engine.countPurgeFingerprintResidue(SRC, hash, '*'), alice: await engine.countPurgeFingerprintResidue(SRC, hash, 'people/a'),
      nobody: await engine.countPurgeFingerprintResidue(SRC, hash, 'people/none'), otherHash: await engine.countPurgeFingerprintResidue(SRC, 'not-a-hash', '*'),
    };
    expect(answers).toEqual({ everyone: { facts: 3, takes: 0 }, alice: { facts: 2, takes: 0 }, nobody: { facts: 0, takes: 0 }, otherHash: { facts: 0, takes: 0 } });
    return answers;
  });

  parityTest('countPurgeFingerprintResidue counts the takes that carry a purged claim, by the slug of the page that holds them', {
    methods: ['insertFact', 'putPage', 'addTakesBatch', 'loadPurgeTarget', 'countPurgeFingerprintResidue'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const target = await fact(engine, 'Alice likes tea', { entity_slug: 'people/a' });
    await fact(engine, 'Alice likes tea', { entity_slug: 'people/b' });
    const a = Number((await engine.putPage('people/a', note('A', 'a person'))).id);
    const b = Number((await engine.putPage('people/b', note('B', 'a person'))).id);
    const elsewhere = Number((await engine.putPage('people/a', note('A elsewhere', 'a person'), { sourceId: 'other' })).id);
    const take = (page_id: number, row_num: number, claim: string, extra: Record<string, unknown> = {}) =>
      ({ page_id, row_num, claim, kind: 'take', holder: 'self', weight: 0.5, since_date: '2026-01-01', source: 'parity', ...extra }) as never;
    expect(await engine.addTakesBatch([
      take(a, 1, 'Alice likes tea'), take(a, 2, 'alice  LIKES tea'), take(a, 3, 'Alice likes coffee'), take(a, 4, 'Alice likes tea', { active: false }),
      take(b, 1, 'Alice likes tea'), take(elsewhere, 1, 'Alice likes tea'),
    ])).toBe(6);
    const hash = (await engine.loadPurgeTarget(target, SRC))!.fact_hash;
    const answers = {
      everyone: await engine.countPurgeFingerprintResidue(SRC, hash, '*'), a: await engine.countPurgeFingerprintResidue(SRC, hash, 'people/a'),
      b: await engine.countPurgeFingerprintResidue(SRC, hash, 'people/b'), nobody: await engine.countPurgeFingerprintResidue(SRC, hash, 'people/none'),
      otherHash: await engine.countPurgeFingerprintResidue(SRC, 'not-a-hash', '*'), other: await engine.countPurgeFingerprintResidue('other', hash, '*'),
    };
    expect(answers).toEqual({ everyone: { facts: 2, takes: 4 }, a: { facts: 1, takes: 3 }, b: { facts: 1, takes: 1 }, nobody: { facts: 0, takes: 0 },
      otherHash: { facts: 0, takes: 0 }, other: { facts: 0, takes: 1 } });
    return answers;
  });

  parityTest('probePurgeDerivations counts the stored derivation results that hold a claim, swept or kept, and walks them in key order', {
    methods: ['createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'openBodyStaging', 'stageSegmentTexts', 'stageManifestRows', 'flipBodyGeneration',
      'setBodyStagingState', 'transaction', 'upsertSegmentDerivations', 'setPurgeProbeTimeout', 'probePurgeDerivations'],
  }, async (engine) => {
    const texts = [segmentText('# One\nfirst segment\n'), segmentText('## Two\nsecond segment\n'), segmentText('## Three\nthird segment\n')];
    const a = await publishSegmentedPage(engine, 'notes/seg-a', texts);
    const b = await publishSegmentedPage(engine, 'notes/seg-b', [segmentText('# Other\nanother page\n')]);
    const row = (pageId: number, kind: 'links' | 'timeline', occurrenceId: number, segmentSha256: ReturnType<typeof sha256>, output: unknown, receipt: unknown = {}) =>
      ({ pageId, kind, occurrenceId, version: 1, segmentSha256, contextHash: sha256(`ctx:${kind}`), state: 'done' as const, output, receipt });
    await engine.upsertSegmentDerivations([
      // Backed by its live segment and holding the claim inside a longer excerpt: kept, unless the purge rewrote its page.
      row(a.pageId, 'links', a.occurrences[0]!, texts[0]!.sha256, { links: [{ excerpt: 'Today ALICE likes   tea at noon' }] }),
      // No live segment backs it (the sha differs): swept.
      row(a.pageId, 'links', a.occurrences[1]!, sha256('a segment since rewritten'), ['Alice likes tea']),
      // A word apart from the claim: it passes the prefilter, but is no hit. Another pipeline, no claim: no candidate.
      row(a.pageId, 'links', a.occurrences[2]!, texts[2]!.sha256, { note: 'Alice likes teas' }),
      row(a.pageId, 'timeline', a.occurrences[2]!, texts[2]!.sha256, { dates: 1 }),
      // The claim in an object key and in the receipt.
      row(b.pageId, 'links', b.occurrences[0]!, sha256('b segment gone'), { 'alice likes tea': true }),
      row(b.pageId, 'timeline', b.occurrences[0]!, sha256('b segment gone'), {}, { found: 'Alice likes tea' }),
    ]);
    const needles = [' alice likes tea '];
    const patterns = ['%alice%likes%tea%'];
    const pages = new Map<number, string>([[a.pageId, 'a'], [b.pageId, 'b']]);
    const occurrences = [...a.occurrences, ...b.occurrences];
    const probe = (source: string, pageIds: number[], cursor: [number, string, string] | null, rows: number) => engine.transaction(async tx => {
      await tx.setPurgeProbeTimeout(5000);
      const r = await tx.probePurgeDerivations(source, needles, pageIds, patterns, cursor, rows);
      return { scanned: Number(r.scanned), normalized: Number(r.normalized), swept: Number(r.swept), kept: Number(r.kept),
        last: r.last_page === null ? null : [pages.get(Number(r.last_page)), r.last_pipeline, occurrences.indexOf(Number(r.last_occurrence))] };
    });
    const first = await probe(SRC, [], null, 2);
    const cursorOf = (last: Array<string | number | null | undefined> | null): [number, string, string] =>
      [[...pages].find(([, label]) => label === last![0])![0], String(last![1]), String(occurrences[Number(last![2])])];
    const answers = {
      whole: await probe(SRC, [], null, 100), rewritten: await probe(SRC, [a.pageId], null, 100), first,
      second: await probe(SRC, [], cursorOf(first.last), 2), third: await probe(SRC, [], cursorOf((await probe(SRC, [], cursorOf(first.last), 2)).last), 2),
      past: await probe(SRC, [], [b.pageId, 'timeline', String(b.occurrences[0]!)], 100), other: await probe('other', [], null, 100),
    };
    expect(answers.whole).toMatchObject({ scanned: 6, normalized: 5, swept: 3, kept: 1 });
    expect(answers.rewritten).toMatchObject({ scanned: 6, normalized: 5, swept: 4, kept: 0 });
    expect(answers.first).toMatchObject({ scanned: 2, last: ['a', 'links', 1] });
    expect(answers.past).toMatchObject({ scanned: 0, last: null });
    return answers;
  });

  parityTest('listBeliefEventsForPurgeProbe reads the recorded values of a source after an id, in id order', {
    methods: ['putPage', 'insertFact', 'listBeliefEventsForPurgeProbe'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('notes/a', note('A', 'a body'));
    await engine.putPage('notes/b', note('B', 'another body'));
    await engine.putPage('notes/c', note('C', 'elsewhere'), { sourceId: 'other' });
    await fact(engine, 'Alice likes tea', { entity_slug: 'people/a' });
    await enableBeliefCoverage(engine, backend, SRC);
    await enableBeliefCoverage(engine, backend, 'other');
    const all = await engine.listBeliefEventsForPurgeProbe(SRC, 0);
    const base = all[0]!.id;
    // Page lifetimes, source incarnations, revisions and the write time are generated: each reads as its shape.
    const unvolatile = (value: unknown) => JSON.parse(JSON.stringify(value)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>').replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, '<time>'));
    const view = (rows: typeof all) => rows.map(r => ({ id: Number(r.id) - Number(base), subject_kind: r.subject_kind, subject_key: unvolatile(r.subject_key), value: unvolatile(r.value) }));
    const answers = {
      all: view(all), afterFirst: view(await engine.listBeliefEventsForPurgeProbe(SRC, Number(base))),
      afterAll: view(await engine.listBeliefEventsForPurgeProbe(SRC, Number(all[all.length - 1]!.id))), other: (await engine.listBeliefEventsForPurgeProbe('other', 0)).length,
      nobody: await engine.listBeliefEventsForPurgeProbe('nobody', 0),
    };
    expect(answers.all.map(r => r.subject_kind)).toEqual(['page', 'page', 'fact']);
    expect(answers.all[2]!.value).toMatchObject({ fact: 'Alice likes tea', valid_from: null }); // #10288: no event date given, none stored
    expect(answers.afterFirst.map(r => r.id)).toEqual(answers.all.slice(1).map(r => r.id));
    expect(answers.other).toBe(1);
    expect({ afterAll: answers.afterAll, nobody: answers.nobody }).toEqual({ afterAll: [], nobody: [] });
    return answers;
  });
});
