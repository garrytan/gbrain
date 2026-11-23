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
 *  - Seam: rows are written with the production writers where one exists (insertPin, insertRetrievalEvents, the
 *    OAuth provider, addMember, bindCredential, setOwner, insertCalibration) and harness-only SQL otherwise
 *    (receipts, weights, plain OAuth clients). Every reader goes through raw SQL, so the Rust arm stops on its
 *    raw_sql refusal.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { clientsReferencingSource } from '../../src/core/destructive-guard.ts';
import { feedbackStatus, getRetrievalEvent, insertRetrievalEvents } from '../../src/core/feedback/store.ts';
import { listPins, insertPin } from '../../src/core/questions/store.ts';
import { insertCalibration, listCalibrations, receiptStats, slotUsage } from '../../src/core/ai/decide/store.ts';
import { readCandidateRecords, upsertCandidatePart } from '../../src/core/fence-repair/census-store.ts';
import { readUncommittedFenceRepairs, recordUncommittedFenceRepair, type UncommittedFenceRepair } from '../../src/core/fence-repair/uncommitted.ts';
import { readChronicleLedgerStats } from '../../src/core/chronicle/ledger-stats.ts';
import { volunteerUsageStats } from '../../src/core/context/volunteer.ts';
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

/** A page over the inline limit with one chunk waiting for a vector and a held budget row carrying `reason`. */
async function heldPage(engine: BrainEngine, sourceId: string, slug: string, reason: string) {
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

  parityTest('receiptStats lists a slot, mode, outcome and error reason tie by byte', { methods: ['executeRaw'], requires: 'raw_sql' }, async (engine) => {
    for (const reason of MIXED_SLUGS) {
      await engine.executeRaw(
        `INSERT INTO decision_receipts (decision_id, slot, mode, provider, outcome, call_site, lane, error_reason)
         VALUES ('d', 'conflict', 'on', 'p', 'skipped', 'site', 'hot', $1)`, [reason]);
    }
    expect((await receiptStats(engine, { sinceHours: 1 })).map(r => r.error_reason)).toEqual([...BYTE_SLUGS]);
  });

  parityTest('clientsReferencingSource lists clients by byte of client id', { methods: ['executeRaw'], requires: 'raw_sql' }, async (engine, backend) => {
    await createSource(engine, backend, 'guest-src');
    for (const id of MIXED_SLUGS) {
      await engine.executeRaw(`INSERT INTO oauth_clients (client_id, client_name, source_id) VALUES ($1, $1, 'guest-src')`, [id]);
    }
    expect((await clientsReferencingSource(engine, 'guest-src')).map(c => c.clientId)).toEqual([...BYTE_SLUGS]);
  });

  parityTest('feedbackStatus lists the lowest weights by byte of source and key', { methods: ['executeRaw'], requires: 'raw_sql' }, async (engine, backend) => {
    await seedSources(engine, backend);
    for (const source of MIXED_SOURCES) {
      for (const key of MIXED_SLUGS) {
        await engine.executeRaw(`INSERT INTO retrieval_weights (source_id, element_kind, element_key, weight) VALUES ($1, 'page', $2, 0.2)`, [source, key]);
      }
    }
    expect((await feedbackStatus(engine)).lowest.map(r => [r.source_id, r.slug])).toEqual(byteTuples(MIXED_SOURCES, MIXED_SLUGS));
  });

  parityTest('feedbackStatus lists the highest weights by byte of source and key', { methods: ['executeRaw'], requires: 'raw_sql' }, async (engine, backend) => {
    await seedSources(engine, backend);
    for (const source of MIXED_SOURCES) {
      for (const key of MIXED_SLUGS) {
        await engine.executeRaw(`INSERT INTO retrieval_weights (source_id, element_kind, element_key, weight) VALUES ($1, 'page', $2, 0.8)`, [source, key]);
      }
    }
    expect((await feedbackStatus(engine)).highest.map(r => [r.source_id, r.slug])).toEqual(byteTuples(MIXED_SOURCES, MIXED_SLUGS));
  });

  parityTest('getRetrievalEvent lists links by byte of source, edge key and target', { methods: ['executeRaw'], requires: 'raw_sql' }, async (engine, backend) => {
    await seedSources(engine, backend);
    await insertRetrievalEvents(engine, [{ id: 'evt-1', client_id: 'local', op: 'query', pages: [], links: [] }]);
    const rows: string[][] = [];
    for (const source of MIXED_SOURCES) for (const key of MIXED_SLUGS) rows.push([source, key, 'to']);
    for (const target of MIXED_SLUGS) rows.push(['a-z', 'same-edge', target]);
    for (const [source, edge, target] of rows) {
      await engine.executeRaw(`INSERT INTO retrieval_event_links (event_id, source_id, edge_key, to_slug) VALUES ('evt-1', $1, $2, $3)`, [source, edge, target]);
    }
    const event = await getRetrievalEvent(engine, 'evt-1');
    expect(event?.links.map(l => [l.source_id, l.edge_key, l.to_slug])).toEqual(byteRows(rows));
  });

  parityTest('listPins lists pinned questions by byte of source id', { methods: ['executeRaw'], requires: 'raw_sql' }, async (engine, backend) => {
    await seedSources(engine, backend);
    for (const sourceId of MIXED_SOURCES) {
      await insertPin(engine, {
        sourceId, slug: 'pin', question: 'q?', scope: { source: sourceId }, state: 'active', inactiveReason: null, publishMode: 'publish', createdBy: 'test',
      });
    }
    expect((await listPins(engine)).map(p => p.source_id)).toEqual(BYTE_SOURCES);
  });

  parityTest('ownerCredentials lists clients of one kind by byte of name and id', { methods: ['executeRaw', 'getConfig', 'setConfig', 'transaction'], requires: 'raw_sql' }, async (engine) => {
    await addMember(engine, 'owner-example');
    await setOwner(engine, 'owner-example');
    for (const name of MIXED_SLUGS) {
      const { clientId } = await provider(engine).registerClientManual(name, ['client_credentials'], 'read write', [], 'default', ['default']);
      await bindCredential(engine, { kind: 'client', id: clientId }, { member: 'owner-example' });
    }
    expect((await ownerCredentials(engine, 'guest-src')).credentials.map(c => c.name)).toEqual([...BYTE_SLUGS]);
  });

  parityTest('ownerCredentials lists clients with one name by byte of id', { methods: ['executeRaw', 'getConfig', 'setConfig'], requires: 'raw_sql' }, async (engine) => {
    await addMember(engine, 'owner-example');
    await setOwner(engine, 'owner-example');
    for (const id of MIXED_SLUGS) {
      await engine.executeRaw(`INSERT INTO oauth_clients (client_id, client_name, member_id) VALUES ($1, 'same-name', 'owner-example')`, [id]);
    }
    expect((await ownerCredentials(engine, 'guest-src')).credentials.map(c => c.id)).toEqual([...BYTE_SLUGS]);
  });

  parityTest('readCandidateRecords lists candidates by byte of fingerprint', { methods: ['executeRaw'], requires: 'raw_sql' }, async (engine, backend) => {
    await createSource(engine, backend, 'census-src');
    const [source] = await engine.executeRaw<{ incarnation: string | number }>(`SELECT incarnation::text AS incarnation FROM sources WHERE id = 'census-src'`);
    const incarnation = String(source!.incarnation);
    for (const key of MIXED_SLUGS) await upsertCandidatePart(engine, { sourceId: 'census-src', incarnation, key }, 'page', { findings: [key] } as never);
    expect((await readCandidateRecords(engine, ['census-src'])).map(r => r.key)).toEqual([...BYTE_SLUGS]);
  });

  parityTest('readUncommittedFenceRepairs lists notices by byte of fingerprint', { methods: ['executeRaw'], requires: 'raw_sql' }, async (engine) => {
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

  parityTest('volunteerUsageStats lists arms and channels by byte', { methods: ['executeRaw'], requires: 'raw_sql' }, async (engine) => {
    for (const arm of MIXED_SLUGS) {
      await engine.executeRaw(`INSERT INTO context_volunteer_events (source_id, slug, confidence, match_arm, channel) VALUES ('default', 'p', 0.5, $1, 'op')`, [arm]);
    }
    for (const channel of MIXED_SLUGS) {
      await engine.executeRaw(`INSERT INTO context_volunteer_events (source_id, slug, confidence, match_arm, channel) VALUES ('default', 'p', 0.5, 'z-arm', $1)`, [channel]);
    }
    const stats = await volunteerUsageStats(engine, ['default']);
    expect(stats.by_arm.map(r => [r.match_arm, r.channel])).toEqual(byteRows([...MIXED_SLUGS.map(arm => [arm, 'op']), ...MIXED_SLUGS.map(channel => ['z-arm', channel])]));
  });

  /** One skipped automatic ledger row and one judge reservation per key: the key is both the reason and the principal id. */
  async function seedLedger(engine: BrainEngine) {
    for (const key of MIXED_SLUGS) {
      await engine.putPage(`notes/${key}`, { type: 'note', title: key, compiled_truth: key, timeline: '' });
      await engine.executeRaw(
        `INSERT INTO chronicle_page_state (source_id, page_id, content_hash, extractor_version, slug, state, reason, trigger, principal_kind, principal_id)
         SELECT 'default', id, 'h', 1, slug, 'skipped', $1, 'auto', 'client', $1 FROM pages WHERE slug = $2 AND source_id = 'default'`, [key, `notes/${key}`]);
      await engine.executeRaw(`INSERT INTO chronicle_judge_reservations (source_id, page_id, content_hash) SELECT 'default', id, 'h' FROM pages WHERE slug = $1 AND source_id = 'default'`, [`notes/${key}`]);
    }
  }

  parityTest('readChronicleLedgerStats lists principals by byte', { methods: ['putPage', 'executeRaw'], requires: 'raw_sql' }, async (engine) => {
    await seedLedger(engine);
    expect((await readChronicleLedgerStats(engine)).principals24h.map(p => p.principal)).toEqual(BYTE_SLUGS.map(key => `client:${key}`));
  });

  parityTest('readChronicleLedgerStats lists reasons by byte', { methods: ['putPage', 'executeRaw'], requires: 'raw_sql' }, async (engine) => {
    await seedLedger(engine);
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

  parityTest('slotUsage lists slots by byte', { methods: ['executeRaw'], requires: 'raw_sql' }, async (engine) => {
    for (const slot of MIXED_SLUGS) {
      await engine.executeRaw(
        `INSERT INTO decision_receipts (decision_id, slot, mode, provider, outcome, call_site, lane) VALUES ('d', $1, 'on', 'p', 'skipped', 'site', 'hot')`, [slot]);
    }
    expect((await slotUsage(engine)).map(r => r.slot)).toEqual([...BYTE_SLUGS]);
  });

  parityTest('readBudgetLimited lists held reasons by byte of source and reason', { methods: ['executeRaw'], requires: 'raw_sql' }, async (engine, backend) => {
    await seedSources(engine, backend);
    // The rows come back by (source, state, reason); held_reasons keeps that order. One reason per source shows the source order.
    for (const source of MIXED_SOURCES) await heldPage(engine, source, 'big', `by-${source}`);
    expect(Object.keys((await readBudgetLimited(engine)).held_reasons)).toEqual(BYTE_SOURCES.map(source => `by-${source}`));
  });

  parityTest('readBudgetLimited lists the held reasons of one source by byte', { methods: ['executeRaw'], requires: 'raw_sql' }, async (engine) => {
    for (const reason of MIXED_SLUGS) await heldPage(engine, 'default', `big-${reason}`, reason);
    expect(Object.keys((await readBudgetLimited(engine)).held_reasons)).toEqual([...BYTE_SLUGS]);
  });

  parityTest('readBudgetLimited lists sources with equal pending chunks by byte of source id', { methods: ['executeRaw'], requires: 'raw_sql' }, async (engine) => {
    // Ids with punctuation and an upper-case letter, as rows that predate the source id check can hold: localeCompare
    // puts `a_b` before `a-z` and `B` last; bytes put `B` first and `a-z` before `a_b`. (Valid ids, a-z 0-9 and `-`,
    // sort the same both ways.) The Rust store refuses such ids, so they go in by harness SQL.
    for (const id of MIXED_IDS) await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ($1, $1)`, [id]);
    for (const id of MIXED_IDS) await heldPage(engine, id, 'big', 'r');
    const bySource = (await readBudgetLimited(engine)).by_source;
    expect(bySource.map(s => s.pending_chunks)).toEqual(MIXED_IDS.map(() => 1));
    expect(bySource.map(s => s.source_id)).toEqual([...BYTE_IDS]);
  });

  parityTest('inspectSharedMemberMigration lists installations by byte of adapter', { methods: ['executeRaw'], requires: 'raw_sql' }, async (engine) => {
    for (const adapter of MIXED_SLUGS) {
      await engine.executeRaw(
        `INSERT INTO shared_skill_members (installation_id, principal_kind, principal_id, adapter, brain_id, follow_policy)
         VALUES (gen_random_uuid(), 'client', 'c', $1, gen_random_uuid(), '{"sources": {"s": "1"}}'::jsonb)`, [adapter]);
    }
    expect((await inspectSharedMemberMigration(engine, 's', '1')).map(m => m.adapter)).toEqual([...BYTE_SLUGS]);
  });
});
