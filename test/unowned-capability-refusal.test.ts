/**
 * Swap blockers from the refusal-swallow triage (docs/research/rust-refusal-swallow-triage.tsv, owner "unowned"): each
 * site caught a raw-SQL failure and fell back to an empty, zero or default answer. On the Rust engine every raw
 * statement refuses with `engine_capability_missing`, so a Rust brain answered with that default and looked healthy.
 *
 * Each site now either reads through a typed member the Rust engine serves, so the answer is the real one, or lets the
 * refusal through, so the caller sees it. Every other failure (a brain that predates a table) still falls open.
 *
 * The engine here is a real PGLite brain whose `executeRaw` refuses, with the error the Rust engine throws, every
 * statement that matches the site's pattern. Typed members run on PGLite. Each case failed before its fix.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { OperationError, type OperationContext } from '../src/core/ops/contract.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';
import { pendingLoopsExtractDepth } from '../src/core/google/loop-catchup.ts';
import { calendarPageRelPathByEventId, contactPageRelPathByContactId } from '../src/core/google/people-calendar-sweep.ts';
import type { GoogleSyncDeps } from '../src/core/google/sweep-shared.ts';
import { dailyLedger, FENCE_REPAIR_LEDGER } from '../src/core/budget/daily-ledger.ts';
import { rethrowNamingRevisionSource } from '../src/core/ops/put-page-revision-source.ts';
import { prepareExplainTarget } from '../src/core/ops/search.ts';
import { readClientSurfaces } from '../src/core/advisor/collect-mcp-client-fit.ts';
import { checkpointKey, clearBackfillCheckpoint, runBackfill } from '../src/core/backfill-base.ts';
import { recordRateLimit } from '../src/core/connectors/api-source.ts';
import { ConnectorHoldSession } from '../src/core/connectors/connector-hold-session.ts';
import { emptyItemHolds, ItemHoldsRun, type ItemHoldsState } from '../src/core/connectors/item-holds.ts';
import { requestHoldRetry } from '../src/core/connectors/item-holds-store.ts';
import { pendingCoreNotices } from '../src/core/core-memory.ts';
import { loadAllowedSlugPrefixes } from '../src/core/cycle/filing-rules.ts';
import { secretPublishMaintenance } from '../src/core/git/redact-finish.ts';
import { purgeStaleAppliedCaptures } from '../src/core/ingestion/applied-captures.ts';
import { readLastSynopsisSweep } from '../src/core/synopsis-sweep.ts';

let pglite: PGLiteEngine;
const cleanup: string[] = [];

beforeAll(async () => {
  pglite = new PGLiteEngine();
  await pglite.connect({});
  await pglite.initSchema();
  for (const id of ['s1', 's2']) await pglite.executeRaw(`INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [id]);
}, 60_000);

afterAll(async () => {
  await pglite.disconnect();
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

type Failure = 'refusal' | 'missing-table';

/** PGLite, except that `executeRaw` fails every statement matching `hit`: with the Rust refusal, or as a missing table. */
function failing(hit: RegExp, failure: Failure = 'refusal'): BrainEngine {
  return new Proxy(pglite, {
    get(target, prop) {
      if (prop === 'executeRaw') {
        return async (sql: string, params?: unknown[]) => {
          if (hit.test(sql)) {
            if (failure === 'refusal') throw capabilityMissing('raw_sql', 'executeRaw');
            throw new Error('relation "the_table" does not exist');
          }
          return target.executeRaw(sql, params);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as BrainEngine;
}

/** PGLite, except that the typed member `member` fails: with the Rust refusal, or as a missing table. */
function failingMember(member: string, failure: Failure = 'refusal'): BrainEngine {
  return new Proxy(pglite, {
    get(target, prop) {
      if (prop === member) {
        return async () => {
          if (failure === 'refusal') throw capabilityMissing('raw_sql', member);
          throw new Error('relation "the_table" does not exist');
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as BrainEngine;
}

const refused = { code: 'engine_capability_missing' };

function opCtx(engine: BrainEngine): OperationContext {
  return { engine, config: {} as OperationContext['config'], logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as OperationContext['logger'],
    dryRun: false, remote: false, sourceId: 'default' } as OperationContext;
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

describe('a refused read that has no typed member refuses instead of answering with a default', () => {
  test('site 2, google/loop-catchup.ts pendingLoopsExtractDepth: no zero backlog', async () => {
    await expect(pendingLoopsExtractDepth(failing(/\bminion_jobs\b/), 'default')).rejects.toMatchObject(refused);
    expect(await pendingLoopsExtractDepth(failing(/\bminion_jobs\b/, 'missing-table'), 'default')).toBe(0);
  });

  test('site 3, google/people-calendar-sweep.ts contactPageRelPathByContactId: no "new contact" on an unmanaged brain', async () => {
    const deps = (engine: BrainEngine) => ({ engine, sourceId: 'default', managed: null }) as unknown as GoogleSyncDeps;
    await expect(contactPageRelPathByContactId(deps(failing(/google_contact_id/)), 'people/c1')).rejects.toMatchObject(refused);
    expect(await contactPageRelPathByContactId(deps(failing(/google_contact_id/, 'missing-table')), 'people/c1')).toBeNull();
  });

  test('site 4, google/people-calendar-sweep.ts calendarPageRelPathByEventId: no "new event" on an unmanaged brain', async () => {
    const deps = (engine: BrainEngine) => ({ engine, sourceId: 'default', managed: null }) as unknown as GoogleSyncDeps;
    await expect(calendarPageRelPathByEventId(deps(failing(/'event_id'/)), 'ev1')).rejects.toMatchObject(refused);
    expect(await calendarPageRelPathByEventId(deps(failing(/'event_id'/, 'missing-table')), 'ev1')).toBeNull();
  });

  test('site 21, synopsis-sweep.ts readLastSynopsisSweep: no "queue unreadable" null', async () => {
    await expect(readLastSynopsisSweep(failing(/\bminion_jobs\b/))).rejects.toMatchObject(refused);
    expect(await readLastSynopsisSweep(failing(/\bminion_jobs\b/, 'missing-table'))).toBeNull();
  });
});

describe('a site whose read became a typed member in batch 12 still refuses when that member refuses', () => {
  // Sites 5 and 10 no longer send the raw statement: lane 10 (repair-rust-b9, d2561e37b1) made the ledger release the
  // typed member releaseBudgetReservation, and lane 15 (page-lists-access-rust, 7ae69944e3) made the explain probe the
  // typed member probeTargetRows. The Rust engine serves both. The catch around each still lets a refusal through.
  test('site 5, budget/daily-ledger.ts release: no silent false', async () => {
    expect(await dailyLedger(failing(/\bbudget_ledger\b/), FENCE_REPAIR_LEDGER).release('r1')).toBe(false);
    await expect(dailyLedger(failingMember('releaseBudgetReservation'), FENCE_REPAIR_LEDGER).release('r1')).rejects.toMatchObject(refused);
    expect(await dailyLedger(failingMember('releaseBudgetReservation', 'missing-table'), FENCE_REPAIR_LEDGER).release('r1')).toBe(false);
  });

  test('site 10, ops/search.ts prepareExplainTarget: an asked-for explain_target refuses instead of explaining nothing', async () => {
    const run = (engine: BrainEngine) => prepareExplainTarget(opCtx(engine), { explain_target: 'notes/a' }, {}, false, 'search');
    expect(await run(failing(/AS embedded/))).not.toBeNull();
    await expect(run(failingMember('probeTargetRows'))).rejects.toMatchObject(refused);
    const fallback = await run(failingMember('probeTargetRows', 'missing-table'));
    expect(fallback?.trace).toBeDefined();
  });
});

describe('a site that now reads through a typed member gives the real answer when raw SQL refuses', () => {
  test('site 9, ops/put-page-revision-source.ts rethrowNamingRevisionSource: the conflict names the source the page was read in', async () => {
    await pglite.putPage('notes/rev-a', { type: 'note', title: 'A', compiled_truth: 'in s1' }, { sourceId: 's1' });
    await pglite.putPage('notes/rev-a', { type: 'note', title: 'A', compiled_truth: 'in s2' }, { sourceId: 's2' });
    const s1Revision = (await pglite.readPageSnapshot('notes/rev-a', { sourceId: 's1' }))!.revision;
    const conflict = new OperationError('revision_conflict', 'the page moved', 'Re-read it.');
    const err = await rethrowNamingRevisionSource(opCtx(failing(/JOIN sources s ON s.id = p.source_id/)), 's2',
      { slug: 'notes/rev-a', expected_revision: s1Revision }, conflict).catch(e => e);
    expect(err).toBe(conflict);
    expect(String((err as OperationError).suggestion)).toContain('in source s1');
  });

  test('site 11, advisor/collect-mcp-client-fit.ts readClientSurfaces: the client surfaces are read', async () => {
    await pglite.executeRaw(`INSERT INTO oauth_clients (client_id, client_name, surface) VALUES ('client-fit-a', 'Fit A', 'verbs')`);
    const surfaces = await readClientSurfaces({ engine: failing(/\boauth_clients\b/) });
    expect(surfaces?.get('client-fit-a')).toBe('verbs');
  });

  test('site 12, backfill-base.ts getCheckpoint: a backfill resumes at its stored cursor', async () => {
    await pglite.putPage('notes/backfill-a', { type: 'note', title: 'B', compiled_truth: 'b' });
    const [{ max }] = await pglite.executeRaw<{ max: number }>('SELECT max(id)::int AS max FROM pages');
    await pglite.setConfig(checkpointKey('unowned-refusal'), String(max));
    const spec = { name: 'unowned-refusal', table: 'pages', selectColumns: ['slug'], needsBackfill: 'true', compute: async () => [] };
    const result = await runBackfill(failing(/FROM config WHERE key/), spec, { dryRun: true });
    expect(result.examined).toBe(0);
  });

  test('site 13, backfill-base.ts clearBackfillCheckpoint: the cursor is cleared', async () => {
    await pglite.setConfig(checkpointKey('unowned-clear'), '5');
    await clearBackfillCheckpoint(failing(/\bconfig\b/), 'unowned-clear');
    expect(await pglite.readStoredConfigValue(checkpointKey('unowned-clear'))).toBeNull();
  });

  test('site 14, connectors/api-source.ts recordRateLimit: the provider reset time is recorded', async () => {
    const retryAt = Date.parse('2026-11-23T18:00:00.000Z');
    await recordRateLimit(failing(/connector-rate-limit/), 's1', retryAt);
    const record = await pglite.readOpCheckpointRecord('connector-rate-limit', 's1');
    expect(record?.completed_keys).toEqual([{ version: 1, retry_at: '2026-11-23T18:00:00.000Z' }]);
  });

  test('site 15, connectors/connector-hold-session.ts open: a retry-held item is re-attempted', async () => {
    const [{ incarnation }] = await pglite.executeRaw<{ incarnation: string }>(`SELECT incarnation::text AS incarnation FROM sources WHERE id = 's1'`);
    let stored: ItemHoldsState = emptyItemHolds();
    for (let i = 0; i < 3; i++) {
      const holds = new ItemHoldsRun(stored);
      holds.shouldAttempt('k1', 'v1');
      holds.fail('k1', new Error('GitHub API HTTP 422 on /repos/acme-example/app/issues/7'), { version: 'v1' });
      stored = holds.finish().state;
    }
    expect(stored.items.k1?.state).toBe('held');
    await requestHoldRetry(pglite, 's1', incarnation, ['k1']);
    const session = await ConnectorHoldSession.open(failing(/\bsources\b|\bop_checkpoints\b/), 's1', null, {}, stored);
    expect(session.shouldAttempt('k1', 'v1')).toBe(true);
  });

  test('site 17, cycle/filing-rules.ts resolveBrainRepoPath: the brain repo\'s own filing rules are used', async () => {
    const repo = tempDir('gbrain-filing-rules-');
    mkdirSync(join(repo, 'skills'), { recursive: true });
    writeFileSync(join(repo, 'skills', '_brain-filing-rules.json'), JSON.stringify({ dream_synthesize_paths: { globs: ['custom-root/*'] } }));
    const cwd = process.cwd();
    const elsewhere = tempDir('gbrain-filing-cwd-');
    await pglite.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [repo]);
    process.chdir(elsewhere);
    try {
      const prefixes = await loadAllowedSlugPrefixes('wiki', failing(/FROM sources WHERE id = 'default'/));
      expect(prefixes).toContain('custom-root/*');
    } finally {
      process.chdir(cwd);
      await pglite.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    }
  });

  test('site 18, git/redact-finish.ts secretPublishMaintenance: a source checkout\'s old backup refs are pruned', async () => {
    const repo = tempDir('gbrain-redact-finish-');
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    git('init', '-q');
    git('-c', 'user.email=a@example.com', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init');
    git('update-ref', 'refs/gbrain/backup/redact-20200101T000000Z-x', git('rev-parse', 'HEAD'));
    await pglite.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 's2'`, [repo]);
    try {
      const out = await secretPublishMaintenance(failing(/local_path IS NOT NULL AND archived IS NOT TRUE/));
      expect(out.redact_backup_refs_deleted).toBe(1);
    } finally {
      await pglite.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 's2'`);
    }
  });
});

describe('a site with a new typed member gives the real answer when raw SQL refuses', () => {
  test('site 16, core-memory.ts pendingCoreNotices: the remote-edit notices are shown', async () => {
    await pglite.executeRaw(`INSERT INTO core_edit_notices (source_id, slug, revision, actor) VALUES ('default', 'core/rules', 'r1', 'agent-a')`);
    const notices = await pendingCoreNotices(failing(/\bcore_edit_notices\b/));
    expect(notices.map(n => `${n.source_id}:${n.slug}:${n.actor}`)).toEqual(['default:core/rules:agent-a']);
  });

  test('site 19, ingestion/applied-captures.ts purgeStaleAppliedCaptures: the stale record is purged and counted', async () => {
    await pglite.executeRaw(`INSERT INTO ingest_applied_captures (idempotency_key, source_id, slug, result, applied_at)
      VALUES ('old-key', 'default', 'notes/x', '{}'::jsonb, now() - interval '100 days')`);
    expect(await purgeStaleAppliedCaptures(failing(/\bingest_applied_captures\b/))).toBe(1);
  });
});
