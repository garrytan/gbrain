/**
 * BrainEngine parity — the doctor's persistence, knowledge and extraction reads list text keys in byte order on every engine and locale.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the doctor checks persistence_capacity (counters, outstanding-request holders), persistence_counter_drift,
 *    persistence_request_growth, owner_host_stale, local_edit_adoptions, unbound_source, facts_extraction and
 *    facts_write_contention, the visibility-held and content-blocked sources of the git-held-files check, content-hash
 *    duplicates, the extract-atoms backlog and extract_health list their keys (counter keys, source ids, local paths,
 *    slugs, extraction kinds) in byte order, the order PGLite and the Rust store sort in, so a check reports the same
 *    rows, in the same order, on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with
 *    GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: an en_US Postgres sorted these keys by its locale, which skips punctuation (`ab` before `a-z`), so the
 *    same doctor run named different holders, different first sources and a different first slug than a PGLite or
 *    Rust brain, and a capped list (the first 3 holders, the first 5 held pages) cut at a different row.
 *  - Why existing coverage misses it: the doctor checks run through `executeRaw`, which the parity cases did not call,
 *    and the checks' own tests use keys that sort the same in every locale, on PGLite. CI's Postgres runs in C.UTF-8.
 *    Every case here mixes `a-z`, `ab` and `ac` (or `a.b` and `a_b` where the key allows them); run it against an en_US
 *    Postgres to see it fail.
 *  - Seam: each case seeds through typed engine members: sources, pages, the ingest log, counters, write requests, the
 *    database-only marker (detachPageOrigin) and the worktree and host bindings (the claim store). The extract_health
 *    case still seeds its rollup with SQL here; the extract-rollup-readers branch converts it. Three cases keep a named stop on the Rust arm: persistence_capacity's holders seed requests aged past the stall
 *    window, which no typed writer can backdate (`requires: 'raw_sql'`); owner_host_stale and maintenance_write_drift need
 *    managed writes (`requires: 'managed_persistence'`). Only returned orders are compared, never ids or timestamps.
 */
import { describe, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createSource, parityArms } from './harness.ts';
import { seedTypedRequest } from '../helpers/persistence-typed-seed.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { byteOrder, MIXED_IDS } from '../helpers/byte-order.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { FILE_DRIFT_MESSAGE } from '../../src/core/persistence/drift-conflicts.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ExtractRollupDelta } from '../../src/core/engine-sql/extract-bookkeeping.ts';
import type { DoctorContext, DoctorEntry } from '../../src/commands/doctor/context.ts';
import type { Check } from '../../src/commands/doctor.ts';
import { requireManagedPersistence } from '../../src/core/rust-engine/errors.ts';

const { parityTest } = parityArms(testBackends());

/** Source ids (lower case, `-` allowed, no `_` or `.`): en_US sorts them `ab, ac, a-z`; bytes put `a-z` first. */
const SRC = ['ac', 'a-z', 'ab'] as const;
const SRC_BYTES = byteOrder(SRC);
/** Four ids for a list cut at 3: bytes keep a-z, ab, ac; en_US keeps ab, ac, ad. */
const SRC4 = ['ad', 'a-z', 'ab', 'ac'] as const;
const SRC4_BYTES = byteOrder(SRC4);

const ctx = (engine: BrainEngine) => ({ engine, progress: { heartbeat() {} } }) as unknown as DoctorContext;
const runEntry = async (entry: DoctorEntry, engine: BrainEngine): Promise<Check[]> => entry.run(ctx(engine)) as Promise<Check[]>;
const detailsOf = (check: Check | undefined) => (check?.details ?? {}) as Record<string, any>;
const named = (checks: Check[], name: string): Check => {
  const check = checks.find(c => c.name === name);
  if (!check) throw new Error(`no ${name} check among ${checks.map(c => c.name).join(', ')}`);
  return check;
};
/** The positions at which `needles` first appear in `text`, which must come in the given order. */
const inOrder = (text: string, needles: readonly string[]): boolean => {
  let from = 0;
  for (const needle of needles) {
    const at = text.indexOf(needle, from);
    if (at < 0) return false;
    from = at + needle.length;
  }
  return true;
};

async function setLimit(engine: BrainEngine, key: string, value: number): Promise<void> {
  await engine.executeRaw(`INSERT INTO config(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [key, String(value)]);
}

async function counter(engine: BrainEngine, key: string, cols: { outstanding?: number; lifetime?: number; terminal?: number } = {}): Promise<void> {
  await engine.executeRaw(`INSERT INTO persistence_counters(key,outstanding_count,lifetime_ids,terminal_bytes) VALUES($1,$2,$3,$4)
    ON CONFLICT (key) DO UPDATE SET outstanding_count=EXCLUDED.outstanding_count,lifetime_ids=EXCLUDED.lifetime_ids,terminal_bytes=EXCLUDED.terminal_bytes`,
  [key, cols.outstanding ?? 0, cols.lifetime ?? 0, cols.terminal ?? 0]);
}

/** The same counter row as `counter`, through the typed counter members: create it, then add each column. */
async function typedCounter(engine: BrainEngine, key: string, cols: { outstanding?: number; lifetime?: number; terminal?: number } = {}): Promise<void> {
  await engine.lockPersistenceCounters([key]);
  await engine.addPersistenceCounters(key, { outstanding_count: cols.outstanding ?? 0, lifetime_ids: cols.lifetime ?? 0, terminal_bytes: cols.terminal ?? 0 });
}

interface Req { principal?: string; source: string; slug?: string; state?: string; ageSql?: string; outcome?: unknown; worktree?: string; requestId?: string; errorCode?: string }
/** One request row under the protocol the table's guard asks for. */
async function request(engine: BrainEngine, r: Req): Promise<void> {
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.persistence_protocol','2',true)");
    await tx.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,intent_bytes,terminal_reservation,state,created_at,completed_at,outcome,worktree_id,error_code)
      VALUES('local_cli',$1,$2::uuid,'put_page',$3,(SELECT incarnation FROM sources WHERE id=$3),$4,$5,'{}'::jsonb,0,0,$6,now()-${r.ageSql ?? "interval '0 seconds'"},
        CASE WHEN $6 IN ('committed','conflict','failed','cancelled') THEN now() END,$7::text::jsonb,$8::uuid,$9)`,
    [r.principal ?? 'doctor', r.requestId ?? randomUUID(), r.source, r.slug ?? 'notes/x', randomUUID(), r.state ?? 'queued', r.outcome === undefined ? null : JSON.stringify(r.outcome), r.worktree ?? null, r.errorCode ?? null]);
  });
}

describe('doctor persistence reads sort text keys by byte', () => {
  parityTest('persistence_capacity, persistence_counter_drift and persistence_request_growth list counters by byte key', {
    methods: ['setConfig', 'lockPersistenceCounters', 'addPersistenceCounters', 'listCapacityCounters', 'readCounterDrift', 'listLifetimeCounters'],
  }, async engine => {
    const { checkPersistenceCapacity } = await import('../../src/commands/doctor/checks/persistence-capacity.ts');
    const { checkPersistenceCounterDrift } = await import('../../src/commands/doctor/checks/persistence-compaction.ts');
    const { requestGrowthCheck } = await import('../../src/commands/doctor/checks/persistence-requests.ts');
    await engine.setConfig('persistence.limits.principal_lifetime_ids', '10');
    const keys = MIXED_IDS.map(id => `principal:local_cli:${id}`);
    for (const key of keys) await typedCounter(engine, key, { lifetime: 9, terminal: 100 });
    const principals = (rows: { scope: string }[]) => rows.map(r => r.scope).filter(s => s.startsWith('principal:'));
    const capacity = await checkPersistenceCapacity(engine);
    const drift = await checkPersistenceCounterDrift(engine);
    const growth = await requestGrowthCheck(engine);
    const expected = byteOrder(keys);
    const out = {
      capacity: principals(detailsOf(capacity).resources),
      capacityMessage: expected.map(k => capacity.message.indexOf(`${k} lifetime_ids`)).every((at, i, all) => at >= 0 && (i === 0 || at > all[i - 1]!)),
      drift: principals(detailsOf(drift).drift),
      driftMessage: inOrder(drift.message, expected.map(k => `${k} counter 100`)),
      growth: principals(detailsOf(growth).scopes),
    };
    expect(out).toEqual({ capacity: expected, capacityMessage: true, drift: expected, driftMessage: true, growth: expected });
    return out;
  });

  parityTest('persistence_capacity names the outstanding-request holders by stalled, count, then byte source id, at most 3', {
    methods: ['executeRaw'], requires: 'raw_sql',
  }, async (engine, backend) => {
    const { checkPersistenceCapacity } = await import('../../src/commands/doctor/checks/persistence-capacity.ts');
    for (const id of SRC4) await createSource(engine, backend, id);
    await counter(engine, 'principal:local_cli:holder', { outstanding: 100 });
    for (const id of SRC4) await request(engine, { principal: 'holder', source: id, ageSql: "interval '2 hours'" });
    const capacity = await checkPersistenceCapacity(engine);
    const [row] = detailsOf(capacity).outstanding as { scope: string; holders: { source_id: string }[] }[];
    const holders = row!.holders.map(h => h.source_id);
    const expected = SRC4_BYTES.slice(0, 3);
    const out = { status: capacity.status, scope: row!.scope, holders, fix: capacity.fix?.argv, message: inOrder(capacity.message, expected.map(id => `source ${id} (1)`)) };
    expect(out).toEqual({ status: 'warn', scope: 'principal:local_cli:holder', holders: expected, fix: ['gbrain', 'sources', 'writer', 'status', '--source', expected[0]!, '--json'], message: true });
    return out;
  });

  // managed_persistence held for callers: the check reads writes waiting on a managed worktree, and such a write is only
  // admitted through admitWrite, which refuses on an engine without managed_persistence (persistence/journal.ts). The case
  // takes the same guard before it seeds the waiting write, so the Rust arm stops by name where a real write would.
  parityTest('owner_host_stale lists the sources bound to a stale owner by byte id', {
    methods: ['executeRaw', 'transaction'], requires: 'managed_persistence',
  }, async (engine, backend) => {
    requireManagedPersistence(engine, 'admitWrite', 'a write to a managed worktree checks its refresh fence, owner and binding');
    const { ownerHostStaleCheck } = await import('../../src/commands/doctor/checks/owner-host-stale.ts');
    const home = mkdtempSync(join(tmpdir(), 'gbrain-collate-owner-stale-'));
    try {
      for (const id of SRC) await createSource(engine, backend, id);
      const [tree] = await engine.executeRaw<{ id: string }>("INSERT INTO persistence_worktrees(owner_host_id,heartbeat_at) VALUES($1::uuid,now()-interval '2 days') RETURNING id::text", [randomUUID()]);
      for (const id of SRC) {
        await engine.executeRaw(`INSERT INTO persistence_source_bindings(source_id,source_incarnation,worktree_id) VALUES($1,(SELECT incarnation FROM sources WHERE id=$1),$2::uuid)`, [id, tree!.id]);
      }
      await request(engine, { source: SRC[0], worktree: tree!.id });
      const check = await withEnv({ GBRAIN_HOME: home }, () => ownerHostStaleCheck(engine));
      const stale = detailsOf(check).stale as { source_ids: string[] }[];
      const out = { status: check.status, sourceIds: stale[0]?.source_ids, message: check.message.includes(`${SRC_BYTES.join(', ')}: owner host`) };
      expect(out).toEqual({ status: 'warn', sourceIds: SRC_BYTES, message: true });
      return out;
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  parityTest('local_edit_adoptions lists sources, and each source\'s paths, by byte', {
    methods: ['insertWriteRequest', 'completeWriteRow', 'listLocalEditAdoptions'],
  }, async (engine, backend) => {
    const { localEditAdoptionsEntry } = await import('../../src/commands/doctor/checks/local-edit-adoptions.ts');
    for (const id of SRC) await createSource(engine, backend, id);
    for (const id of SRC) {
      for (const path of MIXED_IDS) await seedTypedRequest(engine, { source: id, principalId: 'doctor', slug: 'notes/x', digest: randomUUID(), state: 'committed', outcome: { adopted_local_edit: { path: `${path}.md` } } });
    }
    const [check] = await runEntry(localEditAdoptionsEntry, engine);
    const sources = detailsOf(check).sources as { source_id: string; paths: string[] }[];
    const paths = byteOrder(MIXED_IDS.map(id => `${id}.md`));
    const out = { sources: sources.map(s => s.source_id), paths: sources.map(s => s.paths), message: inOrder(check!.message, SRC_BYTES.map(id => `${id}: 5 (`)) };
    expect(out).toEqual({ sources: SRC_BYTES, paths: SRC_BYTES.map(() => paths), message: true });
    return out;
  });
  parityTest('unbound_source lists the sources holding database-only pages by byte id', {
    methods: ['putPage', 'getPage', 'detachPageOrigin', 'listUnboundSourcePages'],
  }, async (engine, backend) => {
    const { checkUnboundSource } = await import('../../src/commands/doctor/checks/unbound-source.ts');
    for (const id of SRC) {
      await createSource(engine, backend, id);
      await engine.putPage('notes/p', { type: 'note', title: id, compiled_truth: 'x', timeline: '' }, { sourceId: id });
      // The same row the raw UPDATE wrote: no file path or uri, database-only for an unbound source.
      await engine.detachPageOrigin(Number((await engine.getPage('notes/p', { sourceId: id }))!.id), 'unbound_source');
    }
    const check = await checkUnboundSource(engine);
    const out = { sources: (detailsOf(check).sources as { source_id: string }[]).map(s => s.source_id), message: inOrder(check.message, SRC_BYTES.map(id => `${id}: 1`)) };
    expect(out).toEqual({ sources: SRC_BYTES, message: true });
    return out;
  });

  // Contention persists when a source has more than 10 deferred writes or its oldest is over an hour old; the ingest log
  // takes no timestamp, so each source gets 11 deferrals (the count arm) instead of one aged row.
  parityTest('facts_extraction_health lists sources, and the sources whose writes stay deferred, by byte id', {
    methods: ['logIngest', 'listPersistentWriterContention'],
  }, async (engine, backend) => {
    const { factsExtractionEntry } = await import('../../src/commands/doctor/checks/knowledge-health.ts');
    const { WRITE_DEFERRED_UNADMITTED } = await import('../../src/core/facts/absorb-log.ts');
    const DEFERRED = 11;
    for (const id of SRC) {
      await createSource(engine, backend, id);
      for (let i = 0; i < DEFERRED; i++) {
        await engine.logIngest({ source_id: id, source_type: 'facts:absorb', source_ref: 'notes/p', pages_updated: [], summary: `${WRITE_DEFERRED_UNADMITTED}: writer_lock_unavailable` });
      }
    }
    const checks = await runEntry(factsExtractionEntry, engine);
    const check = named(checks, 'facts_extraction_health');
    const contention = detailsOf(check).persistent_writer_contention as { source_id: string }[];
    const out = {
      status: check.status,
      summary: inOrder(check.message, SRC_BYTES.map(id => `${id}: ${DEFERRED} ${WRITE_DEFERRED_UNADMITTED}`)),
      contention: contention.map(c => c.source_id),
      contended: inOrder(check.message, SRC_BYTES.map(id => `source ${id}: ${DEFERRED} facts write(s) deferred`)),
      fix: check.fix?.argv,
    };
    expect(out).toEqual({ status: 'warn', summary: true, contention: SRC_BYTES, contended: true, fix: ['gbrain', 'sources', 'writer', 'status', '--source', SRC_BYTES[0]!, '--json'] });
    return out;
  });

  parityTest('git_held_files names the stored pages asking for private, five at most, by byte source id then slug', {
    methods: ['putPage', 'listVisibilityCandidatePages', 'countReadersNoncanonicalHolds', 'listReaderCandidatePages'],
  }, async (engine, backend) => {
    const { gitHeldFilesCheck } = await import('../../src/commands/doctor/checks/git-holds.ts');
    const slugs = ['ab', 'a/z', 'a-z'];
    for (const id of SRC) {
      await createSource(engine, backend, id);
      for (const slug of slugs) await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'x', timeline: '', frontmatter: { Visibility: 'Private' } }, { sourceId: id });
    }
    const pairs = SRC_BYTES.flatMap(id => byteOrder(slugs).map(slug => `${id}:${slug}`));
    const check = await gitHeldFilesCheck(engine);
    const out = { status: check.status, stored: detailsOf(check).visibility_noncanonical?.stored, message: check.message.includes(`(first: ${pairs.slice(0, 5).join(', ')})`),
      fix: check.fix?.argv };
    const [source, slug] = pairs[0]!.split(':') as [string, string];
    expect(out).toEqual({ status: 'warn', stored: 9, message: true, fix: ['gbrain', 'get', '--source', source, '--', slug] });
    return out;
  });

  parityTest('git_held_files counts the visibility and readers spelling holds of live sources at their incarnation', {
    methods: ['readSourceMembership', 'writeOpCheckpointRecord', 'countVisibilityNoncanonicalHolds', 'countReadersNoncanonicalHolds'],
  }, async (engine, backend) => {
    const { GIT_HOLD_OP } = await import('../../src/core/engine-sql/persistence-journal.ts');
    for (const id of SRC) await createSource(engine, backend, id);
    const hold = async (fingerprint: string, source: string, code: string, incarnation?: string) =>
      engine.writeOpCheckpointRecord(GIT_HOLD_OP, fingerprint, [{ source_id: source, incarnation: incarnation ?? (await engine.readSourceMembership(source))!.incarnation, code, path: `${fingerprint}.md` }]);
    for (const [n, id] of SRC.entries()) {
      await hold(`v-${n}`, id, 'visibility_noncanonical');
      await hold(`r-${n}`, id, 'readers_noncanonical');
    }
    // A hold recorded under another incarnation of its source no longer counts.
    await hold('v-stale', SRC[0], 'visibility_noncanonical', randomUUID());
    const out = {
      visibility: await engine.countVisibilityNoncanonicalHolds(GIT_HOLD_OP, null),
      readers: await engine.countReadersNoncanonicalHolds(GIT_HOLD_OP, null),
      scoped: await engine.countReadersNoncanonicalHolds(GIT_HOLD_OP, [SRC[0]]),
    };
    expect(out).toEqual({ visibility: 3, readers: 3, scoped: 1 });
    return out;
  });

  parityTest('listAtomBacklogSourceIds and listReaderCandidatePages list sources and pages by byte', {
    methods: ['putPage', 'listAtomBacklogSourceIds', 'listReaderCandidatePages'],
  }, async (engine, backend) => {
    for (const id of SRC) {
      await createSource(engine, backend, id);
      for (const slug of ['ab', 'a/z', 'a-z']) {
        await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'x', timeline: '', frontmatter: { 'Readable-By': ['member:x'] } }, { sourceId: id });
      }
    }
    const sources = (await engine.listAtomBacklogSourceIds()).map(row => row.source_id).filter(id => (SRC as readonly string[]).includes(id));
    const pages = (await engine.listReaderCandidatePages([...SRC])).map(row => `${row.source_id}:${row.slug}`);
    expect(sources).toEqual(SRC_BYTES);
    // The reader-candidate statement sorts by byte (COLLATE "C") on both keys, as PGLite and the Rust store do.
    expect(pages).toEqual(SRC_BYTES.flatMap(id => byteOrder(['ab', 'a/z', 'a-z']).map(slug => `${id}:${slug}`)));
    return { sources, pages };
  });

  parityTest('git_held_files names the stored pages with a misspelled readers key, five at most, by byte source id then slug', {
    methods: ['putPage', 'listReaderCandidatePages', 'countReadersNoncanonicalHolds'],
  }, async (engine, backend) => {
    const { gitHeldFilesCheck } = await import('../../src/commands/doctor/checks/git-holds.ts');
    const slugs = ['ab', 'a/z', 'a-z'];
    for (const id of SRC) {
      await createSource(engine, backend, id);
      for (const slug of slugs) await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'x', timeline: '', frontmatter: { 'Readable-By': ['member:x'] } }, { sourceId: id });
    }
    const pairs = SRC_BYTES.flatMap(id => byteOrder(slugs).map(slug => `${id}:${slug}`));
    const check = await gitHeldFilesCheck(engine);
    const out = { status: check.status, stored: detailsOf(check).readers_noncanonical?.stored,
      first: /name their readers with a key page access does not read, so every member can read them \(first: ([^)]*)\)/.exec(check.message)?.[1] ?? null, fix: check.fix?.argv };
    const [source, slug] = pairs[0]!.split(':') as [string, string];
    expect(out).toEqual({ status: 'warn', stored: 9, first: pairs.slice(0, 5).join(', '), fix: ['gbrain', 'get', '--source', source, '--', slug] });
    return out;
  });

  parityTest('contentBlockedSources lists the sources a failed content refusal stops by byte id', {
    methods: ['insertWriteRequest', 'completeWriteRow', 'writeOpCheckpointRecord', 'listContentBlockedReceipts'],
  }, async (engine, backend) => {
    const { contentBlockedSources } = await import('../../src/commands/doctor/checks/git-holds.ts');
    for (const id of SRC) {
      await createSource(engine, backend, id);
      const requestId = randomUUID();
      await seedTypedRequest(engine, { source: id, principalId: 'doctor', digest: randomUUID(), state: 'failed', requestId, errorCode: 'invalid_frontmatter' });
      await engine.writeOpCheckpointRecord('managed-sync', id, [{ sourceId: id, pending: { requestId }, done: false }]);
    }
    const blocked = await contentBlockedSources(engine);
    const out = blocked.map(b => b.source_id);
    expect(out).toEqual(SRC_BYTES);
    return out;
  });

  parityTest('content_hash_duplicates names a duplicate group\'s slugs by byte', {
    methods: ['putPage', 'listContentHashDuplicates'],
  }, async engine => {
    const { checkContentHashDuplicates } = await import('../../src/commands/doctor/checks/extraction-sync.ts');
    const slugs = ['ab11', 'a-z1', 'aa-1'];
    // putPage stores the content hash it is given, so three pages share one hash as an import of identical files leaves them.
    for (const slug of slugs) await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `body of ${slug}`, timeline: '', content_hash: 'same-content-hash' });
    const check = await checkContentHashDuplicates(engine);
    const group = byteOrder(slugs).join(' == ');
    const out = { status: check.status, groups: detailsOf(check).sample_distinct_slug_groups, message: check.message.includes(`Sample: ${group}.`) };
    expect(out).toEqual({ status: 'warn', groups: [group], message: true });
    return out;
  });

  parityTest('extract_atoms_backlog names the backlog sources by byte id in its drain hint', {
    methods: ['putPage', 'countAtomExtractionBacklog', 'listAtomBacklogSourceIds'],
  }, async (engine, backend) => {
    const { computeExtractAtomsBacklogCheck } = await import('../../src/commands/doctor.ts');
    const home = mkdtempSync(join(tmpdir(), 'gbrain-collate-atoms-home-'));
    try {
      for (const id of SRC) {
        await createSource(engine, backend, id);
        for (let i = 0; i < 4; i++) await engine.putPage(`article-${i}`, { type: 'article', title: `a${i}`, compiled_truth: 'x'.repeat(600) }, { sourceId: id });
      }
      const check = await withEnv({ GBRAIN_HOME: home }, () => computeExtractAtomsBacklogCheck(engine));
      const out = { status: check.status, bySource: (detailsOf(check).backlog_by_source as { source_id: string }[]).map(s => s.source_id), hint: detailsOf(check).fix_hint as string };
      expect(out).toEqual({ status: 'warn', bySource: SRC_BYTES,
        hint: `gbrain dream --phase extract_atoms --drain --source ${SRC_BYTES[0]} --window 120 (repeat for backlog source(s): ${SRC_BYTES.join(', ')}; or declare extract_atoms in your active schema pack)` });
      return out;
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  /** One rollup day row through the typed writer the extract rollup uses (extract/rollup-writer.ts). */
  const rollupDay = (engine: BrainEngine, kind: string, daysAgo: number, extra: Partial<ExtractRollupDelta> = {}) =>
    engine.upsertExtractRollupDay({
      kind, source_id: 'default', day: new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10), cost_usd: 0,
      halt_count: 0, eval_fail_count: 0, eval_pass_count: 0, round_completed_count: 0, expected_limit_count: 0, rollup_write_failures: 0,
      halt_reason: null, ...extra,
    });

  parityTest('extract_health lists the extraction kinds by byte', {
    methods: ['upsertExtractRollupDay', 'readExtractRollup7d', 'listRecordedHaltReasons7d'],
  }, async engine => {
    const { computeExtractHealthCheck } = await import('../../src/commands/doctor/checks/extraction-sync.ts');
    const kinds = ['kab', 'ka-z', 'kac'];
    for (const kind of kinds) await rollupDay(engine, kind, 0, { halt_count: 1, round_completed_count: 1 });
    const check = await computeExtractHealthCheck(engine);
    const out = (detailsOf(check).kinds as { kind: string }[]).map(k => k.kind);
    expect(out).toEqual(byteOrder(kinds));
    return out;
  });

  parityTest('extract_health sums the 7-day rollup per kind, with its halt reasons, last halt age and write failures', {
    methods: ['upsertExtractRollupDay', 'readExtractRollup7d', 'listRecordedHaltReasons7d', 'readExtractKindRollup7d'],
  }, async engine => {
    const { computeExtractHealthCheck } = await import('../../src/commands/doctor/checks/extraction-sync.ts');
    // takes: a halt 3 days ago (reason timeout, twice), a clean day today with costs and evals; a day 9 days ago is outside.
    await rollupDay(engine, 'takes', 3, { halt_count: 2, halt_reason: 'timeout', cost_usd: 0.1 });
    await rollupDay(engine, 'takes', 3, { halt_count: 1, cost_usd: 0.2 });
    await rollupDay(engine, 'takes', 0, { round_completed_count: 3, eval_pass_count: 4, eval_fail_count: 1, cost_usd: 0.3, expected_limit_count: 2 });
    await rollupDay(engine, 'takes', 9, { halt_count: 50, halt_reason: 'old', cost_usd: 5 });
    await rollupDay(engine, 'atoms', 1, { round_completed_count: 1, rollup_write_failures: 1 });
    const check = await computeExtractHealthCheck(engine);
    const kinds: Array<Record<string, unknown>> = (detailsOf(check).kinds as Array<Record<string, unknown>>).map(({ last_updated_at, ...k }) =>
      ({ ...k, updated: typeof last_updated_at === 'string' && !Number.isNaN(Date.parse(last_updated_at)) }));
    const takes = await engine.readExtractKindRollup7d('takes');
    const none = await engine.readExtractKindRollup7d('absent');
    const one = takes && { ...takes, last_updated_at: takes.last_updated_at !== null };
    const out = { status: check.status, message: check.message, kinds, failures: detailsOf(check).rollup_write_failures_7d, one, none };
    expect(out.kinds.map(k => [k.kind, k.halt_count, k.round_completed_count, k.expected_limit_count, k.last_halt_age_days, k.halt_reasons])).toEqual([
      ['atoms', 0, 1, 0, null, {}],
      ['takes', 3, 3, 2, 3, { timeout: 2, unknown: 1 }],
    ]);
    expect(out.one).toEqual({ cost_7d_usd: 0.6, eval_pass_count: '4', eval_fail_count: '1', halt_count: '3', round_completed_count: '3', last_updated_at: true });
    expect(out.none).toEqual({ cost_7d_usd: null, eval_pass_count: null, eval_fail_count: null, halt_count: null, round_completed_count: null, last_updated_at: null });
    return out;
  });

  parityTest('foreign_writers scans the repositories bound to this host in byte path order', {
    methods: ['transaction', 'worktreeClaimStore', 'listHostRepositoryRoots'],
  }, async engine => {
    const { foreignWritersEntry } = await import('../../src/commands/doctor/checks/foreign-writers.ts');
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-collate-foreign-')));
    try {
      const out = await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        const host = localHostId();
        for (const name of SRC) {
          const root = join(dir, 'repos', name);
          mkdirSync(root, { recursive: true });
          execFileSync('git', ['init', '-q', root], { stdio: 'ignore' });
          // The worktree and its host binding through the claim store, as the unmanaged writer claim records them.
          const tree = randomUUID();
          await engine.transaction(async tx => {
            const store = await tx.worktreeClaimStore();
            await store.insertWorktree({ id: tree, ownerHostId: host });
            await store.insertHostBinding({ worktreeId: tree, hostId: host, localPath: root, coordinationPath: root });
          });
        }
        const [check] = await runEntry(foreignWritersEntry, engine);
        return (detailsOf(check).window as { common: string }[]).map(w => basename(dirname(w.common)));
      });
      expect(out).toEqual(SRC_BYTES);
      return out;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // managed_persistence held for callers: the drift receipts come from managed page writes (a claimed worktree, the
  // persistence switch on, submitPageMutation), which an engine without managed_persistence does not run. The case takes
  // that guard first, so the Rust arm stops by name where a real managed write would, as owner_host_stale does.
  parityTest('maintenance_write_drift samples the drifted pages by byte slug, from the recent receipts then the older ones', {
    methods: ['executeRaw', 'transaction', 'setConfig'], requires: 'managed_persistence',
  }, async (engine, backend) => {
    const { maintenanceWriteDriftCheck } = await import('../../src/commands/doctor/checks/maintenance-drift.ts');
    requireManagedPersistence(engine, 'submitPageMutation', 'a managed page write publishes through a claimed worktree');
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-collate-drift-')));
    const root = join(dir, 'brain');
    mkdirSync(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    const sourceId = 'drift-src';
    /** Pages whose only conflict receipts sit inside the newest 20,000 request sequences, and pages whose receipts fell below them. */
    const recent = ['ab', 'a-z'];
    const older = ['bb', 'b/z', 'b-z'];
    try {
      return await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await createSource(engine, backend, sourceId, {}, root);
        await engine.setConfig('sync.write_through', 'true');
        await claimWorktree(engine, sourceId, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        const logger = { info() {}, warn() {}, error() {} };
        const ctx = { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger } as OperationContext;
        try {
          for (const slug of [...recent, ...older]) {
            await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content: `---\ntype: note\ntitle: ${slug}\n---\nbody of ${slug}\n`, request_id: randomUUID() } });
            appendFileSync(join(root, `${slug}.md`), 'A line added in the file only.\n');
          }
          const receipt = (slug: string) => engine.transaction(async tx => {
            await tx.executeRaw("SELECT set_config('gbrain.persistence_protocol','2',true)");
            await tx.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,intent_bytes,terminal_reservation,state,error_code,error_message,completed_at)
              VALUES('local_cli','doctor',$1::uuid,'put_page',$2,(SELECT incarnation FROM sources WHERE id=$2),$3,$4,'{}'::jsonb,0,0,'conflict','source_changed',$5,now())`,
            [randomUUID(), sourceId, slug, randomUUID(), FILE_DRIFT_MESSAGE]);
          });
          for (const slug of older) await receipt(slug);
          await engine.executeRaw("SELECT setval(pg_get_serial_sequence('persistence_requests','sequence'), (SELECT max(sequence) FROM persistence_requests) + 30000)");
          for (const slug of recent) await receipt(slug);
          const check = await maintenanceWriteDriftCheck(engine, [sourceId]);
          const [row] = detailsOf(check).sources as { sample: string[]; drifted: number }[];
          const out = { status: check.status, drifted: row?.drifted, sample: row?.sample };
          expect(out).toEqual({ status: 'warn', drifted: 5, sample: [...byteOrder(recent), ...byteOrder(older)] });
          return out;
        } finally {
          await disposePersistenceConsumer(engine);
          await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        }
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
