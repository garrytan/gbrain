/**
 * Listings read from the decisions, feedback, questions, OAuth and credential tables come out in byte order on every
 * engine arm.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    these readers list rows by byte order of their text keys, as PGLite sorts: the decide calibration and receipt
 *    lists (listCalibrations, receiptStats), the OAuth clients that reference a source (clientsReferencingSource),
 *    the feedback status lowest/highest weight lists (feedbackStatus), a stored event's links (getRetrievalEvent), a
 *    source's pinned questions (listPins), and the brain owner's credentials (ownerCredentials).
 *  - Regression: an en_US Postgres sorted these keys by its locale, which skips `-` and `/` (`ab, a/z, a-z` instead of
 *    `a-z, a/z, ab`), so the same rows listed in another order than a PGLite brain did: the status tables, the
 *    pinned-question refresh order and the credential preview all moved with the host's locale.
 *    The held-embedding source list broke equal pending counts with JS localeCompare, which puts `a_b` before `a-z`
 *    and `B` last on every database.
 *  - Why existing coverage misses it: the tests of these readers use keys that sort the same in every locale, and
 *    CI's Postgres runs in C.UTF-8. Every case here uses keys that differ by byte and by en_US; run it against an
 *    en_US Postgres to see it fail.
 *  - Seam: rows are written with the production writers or typed engine writers where one exists (insertPin,
 *    insertRetrievalEvents, addMember, bindCredential, setOwner, insertCalibration, insertDecideReceipts,
 *    insertOauthClient, enrollSharedSkillMember, putPage, upsertChunks, recordPageEmbeddingHold) and harness-only
 *    SQL otherwise (weights, event links, volunteer and chronicle rows, source ids the Rust store refuses). A case
 *    whose writer or reader still runs raw SQL stops on the Rust arm's raw_sql refusal; the rest compare equal.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { clientsReferencingSource } from '../../src/core/destructive-guard.ts';
import { applyRatings, feedbackStatus, getRetrievalEvent, insertRetrievalEvents } from '../../src/core/feedback/store.ts';
import { listPins, insertPin } from '../../src/core/questions/store.ts';
import { insertCalibration, listCalibrations, receiptStats, slotUsage } from '../../src/core/ai/decide/store.ts';
import { readCandidateRecords, upsertCandidatePart } from '../../src/core/fence-repair/census-store.ts';
import { readUncommittedFenceRepairs, recordUncommittedFenceRepair, type UncommittedFenceRepair } from '../../src/core/fence-repair/uncommitted.ts';
import { readChronicleLedgerStats } from '../../src/core/chronicle/ledger-stats.ts';
import { reserveChronicleSlot, upsertChronicleRow } from '../../src/core/chronicle/ledger.ts';
import { volunteerUsageStats } from '../../src/core/context/volunteer.ts';
import { insertVolunteerEvents } from '../../src/core/context/volunteer-events.ts';
import { derivationNeedles } from '../../src/core/page-body/segment-derive.ts';
import { readMissingTables } from '../../src/core/schema-missing-tables.ts';
import { readBudgetLimited } from '../../src/core/held-embedding.ts';
import { PAGE_INLINE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { inspectSharedMemberMigration } from '../../src/core/shared-skills/migration-members.ts';
import { addMember, bindCredential } from '../../src/core/access/members.ts';
import { setOwner } from '../../src/core/access/owner.ts';
import { ownerCredentials } from '../../src/core/guests/owner-credentials.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { BYTE_IDS, BYTE_SLUGS, byteOrder, MIXED_IDS, MIXED_SLUGS } from '../helpers/byte-order.ts';

const { parityTest } = parityArms(testBackends());

/** Source ids (lower case, digits and `-` only): en_US sorts them `a0, ab, a-z`; bytes put `a-z` first. */
const MIXED_SOURCES = ['ab', 'a0', 'a-z'];
const BYTE_SOURCES = byteOrder(MIXED_SOURCES);

const provider = (engine: BrainEngine) => new GBrainOAuthProvider({
  sql: sqlQueryForEngine(engine),
  transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))),
});

/** Rows sorted field by field by UTF-8 bytes (the order `ORDER BY a, b, c COLLATE "C"` gives). */
const byteRows = (rows: string[][]) => [...rows].sort((x, y) => {
  for (let i = 0; i < x.length; i++) {
    const c = Buffer.compare(Buffer.from(x[i]!, 'utf8'), Buffer.from(y[i]!, 'utf8'));
    if (c !== 0) return c;
  }
  return 0;
});
/** Every (first, second) pair in byte order. */
const byteTuples = (firsts: readonly string[], seconds: readonly string[]) => byteRows(firsts.flatMap(a => seconds.map(b => [a, b])));

/** A page over the inline limit with one chunk waiting for a vector and a held budget row carrying `reason`, by typed writers. */
async function heldPage(engine: BrainEngine, sourceId: string, slug: string, reason: string) {
  const page = await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'x'.repeat(PAGE_INLINE_MAX_BYTES + 1), timeline: '' }, { sourceId });
  await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: 'chunk', chunk_source: 'compiled_truth' }], { sourceId });
  await engine.recordPageEmbeddingHold(Number(page.id), reason);
}

/** The same rows written by harness SQL, for source ids no engine writer accepts (the Rust arm stops on its raw_sql refusal). */
async function rawHeldPage(engine: BrainEngine, sourceId: string, slug: string, reason: string) {
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, type, title, compiled_truth, frontmatter, content_hash, created_at, updated_at)
     VALUES ($1, $2, 'note', $1, repeat('x', ${PAGE_INLINE_MAX_BYTES + 1}), '{}', 'h', now(), now())`, [slug, sourceId]);
  await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text) SELECT id, 0, 'chunk' FROM pages WHERE slug = $1 AND source_id = $2`, [slug, sourceId]);
  await engine.executeRaw(`INSERT INTO page_embedding_budget (page_id, state, reason) SELECT id, 'held', $3 FROM pages WHERE slug = $1 AND source_id = $2`, [slug, sourceId, reason]);
}

async function seedSources(engine: BrainEngine, backend: ParityBackend) {
  for (const id of MIXED_SOURCES) await createSource(engine, backend, id);
}

describe('store listings come out by byte', () => {
  parityTest('listCalibrations lists a slot tie by byte', { methods: ['insertDecideCalibration', 'listDecideCalibrations'] }, async (engine) => {
    for (const slot of MIXED_SLUGS) {
      await insertCalibration(engine, {
        slot, call_site: 'site', provider: 'p', model_resolved: 'm', threshold: 0.5, min_keep: 1, metric: 'ece', metric_value: 0.1, ece: 0.1,
        retest_sd: null, repack_sd: null, n: 10, dataset_hash: 'd', split_hash: 's', calibrate_ids_hash: 'c', calibrate_only: true, pack_shape: 'x', notes: null,
      } as never);
    }
    expect((await listCalibrations(engine, {})).map(r => r.slot as string)).toEqual([...BYTE_SLUGS]);
  });

  parityTest('receiptStats lists a slot, mode, outcome and error reason tie by byte', { methods: ['insertDecideReceipts', 'listDecideReceiptStats'] }, async (engine) => {
    await engine.insertDecideReceipts(MIXED_SLUGS.map(reason => ({
      decision_id: 'd', slot: 'conflict', mode: 'on', provider: 'p', outcome: 'skipped', call_site: 'site', lane: 'hot', error_reason: reason,
    })));
    expect((await receiptStats(engine, { sinceHours: 1 })).map(r => r.error_reason)).toEqual([...BYTE_SLUGS]);
  });

  parityTest('clientsReferencingSource lists clients by byte of client id', { methods: ['insertOauthClient', 'listSourceOAuthClients'] }, async (engine, backend) => {
    await createSource(engine, backend, 'guest-src');
    for (const id of MIXED_SLUGS) await engine.insertOauthClient({ client_id: id, client_name: id, source_id: 'guest-src' });
    expect((await clientsReferencingSource(engine, 'guest-src')).map(c => c.clientId)).toEqual([...BYTE_SLUGS]);
  });

  /** One page per (source, key), each returned by one retrieval event and rated `rating` once, by the feedback writers. */
  async function ratedPages(engine: BrainEngine, backend: ParityBackend, rating: number) {
    await seedSources(engine, backend);
    const pages = MIXED_SOURCES.flatMap(source_id => MIXED_SLUGS.map(slug => ({ source_id, slug })));
    for (const p of pages) await engine.putPage(p.slug, { type: 'note', title: p.slug, compiled_truth: p.slug, timeline: '' }, { sourceId: p.source_id });
    await insertRetrievalEvents(engine, [{ id: 'evt-1', client_id: 'local', op: 'query', links: [],
      pages: pages.map((p, i) => ({ ...p, content_hash: 'h', rank: i + 1, cited: false })) }]);
    await applyRatings(engine, { eventId: 'evt-1', clientId: 'local', signal: 'explicit', alpha: 0.3,
      targets: pages.map(p => ({ kind: 'page' as const, source_id: p.source_id, key: p.slug, rating, content_hash: 'h' })) });
    // A second rating of each page after an edit (another content hash): its learned weight decays halfway to neutral
    // first, and the stored weight moves by the upsert's own arithmetic.
    await insertRetrievalEvents(engine, [{ id: 'evt-2', client_id: 'other', op: 'search', links: [],
      pages: pages.map((p, i) => ({ ...p, content_hash: 'h2', rank: i + 1, cited: true })) }]);
    return applyRatings(engine, { eventId: 'evt-2', clientId: 'other', signal: 'explicit', alpha: 0.37,
      targets: pages.map(p => ({ kind: 'page' as const, source_id: p.source_id, key: p.slug, rating: rating === 1 ? 2 : 4, content_hash: 'h2' })) });
  }

  parityTest('feedbackStatus lists the lowest weights by byte of source and key', { methods: ['putPage', 'insertRetrievalEvents', 'applyRetrievalRatings', 'readFeedbackStatus'] }, async (engine, backend) => {
    const applied = await ratedPages(engine, backend, 1);
    const status = await feedbackStatus(engine);
    expect(status.lowest.map(r => [r.source_id, r.slug])).toEqual(byteTuples(MIXED_SOURCES, MIXED_SLUGS));
    // The weights each rating moved and the whole status (counts, weights, low ratings) are compared across engines.
    const bytes = (x: string, y: string) => Buffer.compare(Buffer.from(x), Buffer.from(y));
    return { applied: [...applied].sort((a, b) => bytes(a.source_id, b.source_id) || bytes(a.key, b.key)),
      status: { ...status, last_rating_at: status.last_rating_at !== null } };
  });

  parityTest('feedbackStatus lists the highest weights by byte of source and key', { methods: ['putPage', 'insertRetrievalEvents', 'applyRetrievalRatings', 'readFeedbackStatus'] }, async (engine, backend) => {
    await ratedPages(engine, backend, 5);
    const status = await feedbackStatus(engine);
    expect(status.highest.map(r => [r.source_id, r.slug])).toEqual(byteTuples(MIXED_SOURCES, MIXED_SLUGS));
    return { ...status, last_rating_at: status.last_rating_at !== null };
  });

  parityTest('getRetrievalEvent lists links by byte of source, edge key and target', { methods: ['putPage', 'insertRetrievalEvents', 'readRetrievalEvent'] }, async (engine, backend) => {
    await seedSources(engine, backend);
    const rows: string[][] = [];
    for (const source of MIXED_SOURCES) for (const key of MIXED_SLUGS) rows.push([source, key, 'to']);
    for (const target of MIXED_SLUGS) rows.push(['a-z', 'same-edge', target]);
    // An event keeps a link only while the pages at both ends of its edge and its target exist.
    for (const source of MIXED_SOURCES) for (const slug of [...MIXED_SLUGS, 'to', 'same-edge']) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: slug, timeline: '' }, { sourceId: source });
    }
    await insertRetrievalEvents(engine, [{ id: 'evt-1', client_id: 'local', op: 'query', pages: [],
      links: rows.map(([source_id, edge_key, to_slug]) => ({ source_id: source_id!, edge_key: edge_key!, to_slug: to_slug! })) }]);
    const event = await getRetrievalEvent(engine, 'evt-1');
    expect(event?.links.map(l => [l.source_id, l.edge_key, l.to_slug])).toEqual(byteRows(rows));
    return { ...event, created_at: event?.created_at instanceof Date };
  });

  /** Source `work` with pages a, b and c; an event that returned a and b and used the link a|t|b; ratings of a, b and the link; one volunteer event per page. */
  async function feedbackAndVolunteerRows(engine: BrainEngine, backend: ParityBackend) {
    await createSource(engine, backend, 'work');
    for (const slug of ['a', 'b', 'c']) await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: slug, timeline: '' }, { sourceId: 'work' });
    // The engine members themselves (the product writers above call them).
    await engine.insertRetrievalEvents([{ id: 'e1', client_id: 'local', op: 'query',
      pages: ['a', 'b'].map((slug, i) => ({ source_id: 'work', slug, content_hash: null, rank: i + 1, cited: false })),
      links: [{ source_id: 'work', edge_key: 'a|t|b', to_slug: 'c' }] }]);
    expect((await engine.readRetrievalEvent('e1'))?.pages.map(p => p.slug)).toEqual(['a', 'b']);
    await engine.applyRetrievalRatings({ eventId: 'e1', clientId: 'local', signal: 'explicit', alpha: 0.5, targets: [
      { kind: 'page', source_id: 'work', key: 'a', rating: 1, content_hash: null }, { kind: 'page', source_id: 'work', key: 'b', rating: 5, content_hash: null },
      { kind: 'link', source_id: 'work', key: 'a|t|b', rating: 5, content_hash: null }] });
    await insertVolunteerEvents(engine, ['a', 'b', 'c'].map(slug => ({ source_id: 'work', slug, confidence: 0.5, match_arm: 'arm', rationale: '', channel: 'op' as never })));
  }

  const feedbackView = async (engine: BrainEngine) => {
    const event = await getRetrievalEvent(engine, 'e1');
    const status = await feedbackStatus(engine);
    const channels = (await engine.listVolunteerChannels(null)).map(r => [r.channel, Number(r.n)]);
    return { pages: event?.pages.map(p => p.slug), links: event?.links, events: status.events, ratings: status.ratings_explicit, weights: status.weights_total, channels };
  };

  parityTest('a hard delete scrubs its slug from the retrieval feedback and the volunteer log', {
    methods: ['putPage', 'insertRetrievalEvents', 'applyRetrievalRatings', 'insertVolunteerEvents', 'deletePages', 'readRetrievalEvent', 'readFeedbackStatus', 'listVolunteerChannels'],
  }, async (engine, backend) => {
    await feedbackAndVolunteerRows(engine, backend);
    expect(await engine.deletePages(['a'], { sourceId: 'work' })).toEqual(['a']);
    const out = await feedbackView(engine);
    // The page row of a, the link whose edge starts at a, and the rating and weight of a and of that edge go.
    expect(out).toEqual({ pages: ['b'], links: [], events: 1, ratings: 1, weights: 1, channels: [['op', 2]] });
    return out;
  });

  parityTest('removing a source drops its retrieval feedback and volunteer log and keeps the event', {
    methods: ['putPage', 'insertRetrievalEvents', 'applyRetrievalRatings', 'insertVolunteerEvents', 'deletePages', 'deleteSourceRecord', 'readRetrievalEvent', 'readFeedbackStatus', 'listVolunteerChannels'],
  }, async (engine, backend) => {
    await feedbackAndVolunteerRows(engine, backend);
    // A source with pages goes only when its pages cascade; delete them first, as `sources remove` does.
    await engine.deletePages(['a', 'b', 'c'], { sourceId: 'work' });
    expect((await engine.deleteSourceRecord('work')).deleted).toBe(true);
    const out = await feedbackView(engine);
    expect(out).toEqual({ pages: [], links: [], events: 1, ratings: 0, weights: 0, channels: [] });
    return out;
  });

  parityTest('listPins lists pinned questions by byte of source id', { methods: ['insertPinnedQuestion', 'listPinnedQuestions'] }, async (engine, backend) => {
    await seedSources(engine, backend);
    for (const sourceId of MIXED_SOURCES) {
      await insertPin(engine, {
        sourceId, slug: 'pin', question: 'q?', scope: { source: sourceId }, state: 'active', inactiveReason: null, publishMode: 'publish', createdBy: 'test',
      });
    }
    const pins = await listPins(engine);
    expect(pins.map(p => p.source_id)).toEqual(BYTE_SOURCES);
    // The rows (all but the engine-assigned id and creation time) are compared across engines.
    return pins.map(({ id: _id, created_at: _at, ...rest }) => rest);
  });

  parityTest('ownerCredentials lists clients of one kind by byte of name and id', { methods: ['insertOauthClient', 'getConfig', 'setConfig', 'transaction', 'listOwnerCredentialRows'] }, async (engine) => {
    await addMember(engine, 'owner-example');
    await setOwner(engine, 'owner-example');
    for (const [i, name] of MIXED_SLUGS.entries()) {
      await engine.insertOauthClient({ client_id: `client-${i}`, client_name: name, grant_types: ['client_credentials'], scope: 'read write', source_id: 'default', federated_read: ['default'] });
      await bindCredential(engine, { kind: 'client', id: `client-${i}` }, { member: 'owner-example' });
    }
    const { credentials } = await ownerCredentials(engine, 'guest-src');
    expect(credentials.map(c => c.name)).toEqual([...BYTE_SLUGS]);
    // The whole listing (grants, read lists, commands) is compared across engines.
    return credentials;
  });

  parityTest('ownerCredentials lists clients with one name by byte of id', { methods: ['insertOauthClient', 'getConfig', 'setConfig', 'listOwnerCredentialRows'] }, async (engine) => {
    await addMember(engine, 'owner-example');
    await setOwner(engine, 'owner-example');
    for (const id of MIXED_SLUGS) await engine.insertOauthClient({ client_id: id, client_name: 'same-name', member_id: 'owner-example' });
    const { credentials } = await ownerCredentials(engine, 'guest-src');
    expect(credentials.map(c => c.id)).toEqual([...BYTE_SLUGS]);
    return credentials;
  });

  parityTest('readCandidateRecords lists candidates by byte of fingerprint', { methods: ['readSourceState', 'upsertFenceCandidatePart', 'listFenceCandidateRecords'] }, async (engine, backend) => {
    await createSource(engine, backend, 'census-src');
    const incarnation = String((await engine.readSourceState('census-src'))!.incarnation);
    for (const key of MIXED_SLUGS) await upsertCandidatePart(engine, { sourceId: 'census-src', incarnation, key }, 'page', { findings: [key] } as never);
    expect((await readCandidateRecords(engine, ['census-src'])).map(r => r.key)).toEqual([...BYTE_SLUGS]);
  });

  parityTest('readUncommittedFenceRepairs lists notices by byte of fingerprint', { methods: ['writeOpCheckpointRecord', 'listSourceCheckpointRecords'] }, async (engine) => {
    const root = mkdtempSync(join(tmpdir(), 'collate-uncommitted-'));
    try {
      for (const path of MIXED_SLUGS) {
        await recordUncommittedFenceRepair(engine, {
          source_id: 'src', incarnation: '1', path, root, repaired_at: '2026-01-01T00:00:00.000Z', backup: null, commit_step: 'git commit', receipt: {} as never,
        } satisfies UncommittedFenceRepair);
      }
      expect((await readUncommittedFenceRepairs(engine, ['src'])).map(n => n.path)).toEqual([...BYTE_SLUGS]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  parityTest('volunteerUsageStats lists arms and channels by byte', { methods: ['putPage', 'insertVolunteerEvents', 'readVolunteerUsage', 'listVolunteerChannels'] }, async (engine) => {
    // The log keeps an event only while its page exists.
    await engine.putPage('p', { type: 'note', title: 'p', compiled_truth: 'p', timeline: '' });
    const event = (match_arm: string, channel: string) => ({ source_id: 'default', slug: 'p', confidence: 0.5, match_arm, rationale: '', channel: channel as never });
    await insertVolunteerEvents(engine, [...MIXED_SLUGS.map(arm => event(arm, 'op')), ...MIXED_SLUGS.map(channel => event('z-arm', channel))]);
    const stats = await volunteerUsageStats(engine, ['default']);
    expect(stats.by_arm.map(r => [r.match_arm, r.channel])).toEqual(byteRows([...MIXED_SLUGS.map(arm => [arm, 'op']), ...MIXED_SLUGS.map(channel => ['z-arm', channel])]));
    // The doctor's per-channel read of the same log: channels by byte, with their counts.
    const channels = (await engine.listVolunteerChannels(['default'])).map(r => [r.channel, Number(r.n), r.last_fired !== null]);
    expect(channels).toEqual(byteOrder([...MIXED_SLUGS, 'op']).map(c => [c, c === 'op' ? 3 : 1, true]));
    return { stats, channels };
  });

  /** One skipped automatic ledger row and one judge reservation per key, by the ledger writers: the key is both the reason and the principal id. */
  async function seedLedger(engine: BrainEngine) {
    for (const key of MIXED_SLUGS) {
      const page = await engine.putPage(`notes/${key}`, { type: 'note', title: key, compiled_truth: key, timeline: '' });
      const at = { sourceId: 'default', pageId: Number(page.id), contentHash: 'h' };
      expect(await upsertChronicleRow(engine, { ...at, slug: page.slug, state: 'skipped', reason: key, trigger: 'auto', principalKind: 'client', principalId: key, nextAttemptAt: null })).toBe(true);
      expect(await reserveChronicleSlot(engine, 1000, at)).toBe(true);
    }
  }

  parityTest('readChronicleLedgerStats lists principals by byte', { methods: ['putPage', 'upsertChronicleRow', 'reserveChronicleJudgeSlot', 'readChronicleLedgerStats'] }, async (engine) => {
    await seedLedger(engine);
    const stats = await readChronicleLedgerStats(engine);
    expect(stats.principals24h.map(p => p.principal)).toEqual(BYTE_SLUGS.map(key => `client:${key}`));
    // The whole rollup (counts, reasons, calls, spend) is compared across engines.
    return stats;
  });

  parityTest('readChronicleLedgerStats lists reasons by byte', { methods: ['putPage', 'getPage', 'upsertChronicleRow', 'reserveChronicleJudgeSlot', 'readChronicleLedgerStats'] }, async (engine) => {
    await seedLedger(engine);
    // The engine members themselves: a repeat of a skip decision rewrites it, and a slot past the limit is refused.
    const page = (await engine.getPage(`notes/${MIXED_SLUGS[0]}`))!;
    expect(await engine.upsertChronicleRow({ sourceId: 'default', pageId: Number(page.id), contentHash: 'h', extractorVersion: 2, slug: page.slug,
      state: 'skipped', reason: MIXED_SLUGS[0], trigger: 'auto', principalKind: 'client', principalId: MIXED_SLUGS[0], requestId: null, noExtract: false, nextAttemptAt: null })).toBe(true);
    expect(await engine.reserveChronicleJudgeSlot(MIXED_SLUGS.length, { sourceId: 'default', pageId: Number(page.id), contentHash: 'h' })).toBe(false);
    expect(Object.keys((await readChronicleLedgerStats(engine)).last7d.reasons)).toEqual([...BYTE_SLUGS]);
  });

  parityTest('derivationNeedles lists claim needles by byte', { methods: ['listDerivationClaimForms'] }, async (engine) => {
    const { needles } = await derivationNeedles(engine, ['ab', 'a b', 'a c']);
    expect(needles).toEqual([' a b ', ' a c ', ' ab ']);
  });

  parityTest('readMissingTables lists missing tables by byte', { methods: ['transaction', 'executeRaw', 'getConfig'], requires: 'raw_sql' }, async (engine) => {
    // `access_members` and `access_member_sources` swap places under en_US (it skips `_`). The drops roll back with the transaction.
    const rollback = new Error('rollback');
    let missing: string[] = [];
    await engine.transaction(async (tx) => {
      await tx.executeRaw('DROP TABLE access_members CASCADE');
      await tx.executeRaw('DROP TABLE access_member_sources CASCADE');
      const report = await readMissingTables(tx);
      missing = report.status === 'checked' ? report.missing.map(m => m.table) : [];
      throw rollback;
    }).catch((e) => { if (e !== rollback) throw e; });
    expect(missing).toEqual(['access_member_sources', 'access_members']);
  });

  parityTest('slotUsage lists slots by byte', { methods: ['insertDecideReceipts', 'decideSlotUsage'] }, async (engine) => {
    await engine.insertDecideReceipts(MIXED_SLUGS.map(slot => ({ decision_id: 'd', slot, mode: 'on', provider: 'p', outcome: 'skipped', call_site: 'site', lane: 'hot' })));
    expect((await slotUsage(engine)).map(r => r.slot)).toEqual([...BYTE_SLUGS]);
  });

  parityTest('readBudgetLimited lists held reasons by byte of source and reason', { methods: ['putPage', 'upsertChunks', 'recordPageEmbeddingHold', 'listBudgetLimitedRows'] }, async (engine, backend) => {
    await seedSources(engine, backend);
    // The rows come back by (source, state, reason); held_reasons keeps that order. One reason per source shows the source order.
    for (const source of MIXED_SOURCES) await heldPage(engine, source, 'big', `by-${source}`);
    const limited = await readBudgetLimited(engine);
    expect(Object.keys(limited.held_reasons)).toEqual(BYTE_SOURCES.map(source => `by-${source}`));
    // The whole report (counts, pending chunks and characters per source) is compared across engines.
    return limited;
  });

  parityTest('readBudgetLimited lists the held reasons of one source by byte', { methods: ['putPage', 'upsertChunks', 'recordPageEmbeddingHold', 'listBudgetLimitedRows', 'readBudgetHoldAge'] }, async (engine) => {
    for (const reason of MIXED_SLUGS) await heldPage(engine, 'default', `big-${reason}`, reason);
    expect(Object.keys((await readBudgetLimited(engine)).held_reasons)).toEqual([...BYTE_SLUGS]);
    // The same holds feed the hold age: none has waited a day, and the oldest update time is set.
    const age = await engine.readBudgetHoldAge();
    expect({ stale: Number(age?.stale), oldest: age?.oldest != null }).toEqual({ stale: 0, oldest: true });
    return await readBudgetLimited(engine);
  });

  parityTest('readBudgetLimited lists sources with equal pending chunks by byte of source id', { methods: ['executeRaw'], requires: 'raw_sql' }, async (engine) => {
    // Ids with punctuation and an upper-case letter, as rows that predate the source id check can hold: localeCompare
    // puts `a_b` before `a-z` and `B` last; bytes put `B` first and `a-z` before `a_b`. (Valid ids, a-z 0-9 and `-`,
    // sort the same both ways.) The Rust store refuses such ids, so they go in by harness SQL.
    for (const id of MIXED_IDS) await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ($1, $1)`, [id]);
    for (const id of MIXED_IDS) await rawHeldPage(engine, id, 'big', 'r');
    const bySource = (await readBudgetLimited(engine)).by_source;
    expect(bySource.map(s => s.pending_chunks)).toEqual(MIXED_IDS.map(() => 1));
    expect(bySource.map(s => s.source_id)).toEqual([...BYTE_IDS]);
  });

  parityTest('inspectSharedMemberMigration lists installations by byte of adapter', { methods: ['enrollSharedSkillMember', 'listSharedMemberMigrationRows'] }, async (engine) => {
    for (const adapter of MIXED_SLUGS) {
      await engine.enrollSharedSkillMember({ installationId: randomUUID(), principalKind: 'client', principalId: 'c', adapter, brainId: randomUUID(), followPolicy: { sources: { s: '1' } } });
    }
    expect((await inspectSharedMemberMigration(engine, 's', '1')).map(m => m.adapter)).toEqual([...BYTE_SLUGS]);
  });
});
