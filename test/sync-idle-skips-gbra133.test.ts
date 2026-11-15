/**
 * GBRA-133 (PR 2b): the managed no-op fast path. An idle tick under the drain lease records what its pin read; each settle
 * after it that only acts on a hold, a hold summary, a recorded failure, a ledger row or an owed tail is skipped when the
 * pin read none (src/core/persistence/sync-idle-skips.ts). The tick's result, lease and pass row are unchanged. Both
 * backends; test/e2e/sync-idle-skips-gbra133-postgres.test.ts runs the Postgres arm in the E2E lane.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SyncOpts, SyncResult } from '../src/commands/sync.ts';
import { performSync } from '../src/commands/sync/perform.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { GIT_HOLD_OP, GIT_HOLD_SUMMARY_OP, summaryFingerprint, writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { SYNC_TAIL_OP, recordPassTail } from '../src/core/persistence/sync-tail-record.ts';
import { MANAGED_SYNC_PASS_OP, passFingerprint } from '../src/core/persistence/sync-pass-row.ts';
import { IDLE_SKIPS, idleClear, type IdleFacts, type IdleSkip } from '../src/core/persistence/sync-idle-skips.ts';
import { clearFailures, recordFailures } from '../src/core/sync-failure-ledger.ts';
import { buildSingleSyncJsonEnvelope } from '../src/core/sync-embed-backfill.ts';
import { freshBrainFactory } from './helpers/persistence-request-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const cliOpts = (sourceId: string): SyncOpts => ({ sourceId, noPull: true, noEmbed: true, noExtract: true, drain: true, followDrainLease: true, drainHolder: { kind: 'cli', id: null } });

/** The statements (text and parameters) the engine's top-level executeRaw sends while `fn` runs. */
async function recordStatements<T>(engine: BrainEngine, fn: () => Promise<T>): Promise<{ result: T; sent: Array<{ sql: string; params: unknown[] }> }> {
  const sent: Array<{ sql: string; params: unknown[] }> = [];
  const target = engine as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const original = target.executeRaw!;
  target.executeRaw = function (this: unknown, ...args: unknown[]) {
    sent.push({ sql: String(args[0]).replace(/\s+/g, ' ').trim(), params: (args[1] as unknown[] | undefined) ?? [] });
    return original.apply(this, args);
  };
  try { return { result: await fn(), sent }; }
  finally { delete target.executeRaw; }
}

/** What each settle in IDLE_SKIPS sends when it runs, counted in a run's statements. */
const settles = (sent: Array<{ sql: string; params: unknown[] }>, sourceId: string) => ({
  holdReads: sent.filter(s => (s.sql.startsWith('SELECT ') && s.sql.includes(' AS record FROM op_checkpoints h')) && s.params[0] === GIT_HOLD_OP && s.params[2] === null).length,
  holdReport: sent.filter(s => s.sql.includes("COALESCE((completed_keys->0->>'count')::int,0) AS count") && s.params[0] === GIT_HOLD_SUMMARY_OP).length,
  failureRows: sent.filter(s => s.sql.includes("f.op='managed-sync-failure' AND f.completed_keys->0->>'source_id'=$1")).length,
  needsHuman: sent.filter(s => s.sql === 'SELECT incarnation::text AS incarnation FROM sources WHERE id=$1' && s.params[0] === sourceId).length,
  tailReads: sent.filter(s => s.params[0] === SYNC_TAIL_OP && s.params[1] === sourceId && s.sql.startsWith('SELECT completed_keys FROM op_checkpoints')).length,
});

const databaseUrl = process.env.DATABASE_URL;

for (const kind of testBackends()) {
  describe('GBRA-133 managed no-op fast path (' + kind + ')', () => {
    let factory: Awaited<ReturnType<typeof freshBrainFactory>>;
    let home: string;
    beforeAll(async () => {
      home = mkdtempSync(join(tmpdir(), 'gbrain-idle-skips-'));
      factory = await freshBrainFactory(kind, databaseUrl);
    }, 120_000);
    afterAll(async () => {
      await factory?.dispose();
      if (home) rmSync(home, { recursive: true, force: true });
    });

    /** A managed source of three committed pages, synced until its pass row records an idle tick. */
    async function idleSource(engine: BrainEngine): Promise<{ id: string; incarnation: string }> {
      const id = 'idle-' + randomUUID().slice(0, 12), root = join(home, id);
      mkdirSync(root); git(root, 'init', '-q');
      for (const name of ['alice-example', 'acme-example', 'fund-a']) writeFileSync(join(root, name + '.md'), '---\ntitle: ' + name + '\n---\nA durable observation about ' + name + '.\n');
      git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'seed');
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
      await claimWorktree(engine, id, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [id]);
      for (let run = 0; run < 4; run++) {
        const result = await performSync(engine, cliOpts(id));
        const [row] = await engine.executeRaw<{ kind: string | null }>("SELECT completed_keys->0->'telemetry'->>'kind' AS kind FROM op_checkpoints WHERE op=$1 AND fingerprint=$2",
          [MANAGED_SYNC_PASS_OP, passFingerprint(id, incarnation)]);
        if (result.status === 'up_to_date' && row?.kind === 'idle') return { id, incarnation };
      }
      throw new Error('the source never reached an idle tick');
    }

    const check = (name: string, fn: (engine: BrainEngine) => Promise<void>) => test(name, async () => {
      const engine = await factory.fresh();
      try {
        await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined,
          GBRAIN_SYNC_IDLE_FAST_PATH: undefined }, () => fn(engine));
      } finally { await withEnv({ GBRAIN_HOME: home }, () => disposePersistenceConsumer(engine)); }
    }, 180_000);

    check('an idle tick skips the settles its pin read nothing for, and its result and JSON envelope are the full settles\' result', async engine => {
      const { id } = await idleSource(engine);
      const full = await withEnv({ GBRAIN_SYNC_IDLE_FAST_PATH: '0' }, () => recordStatements(engine, () => performSync(engine, cliOpts(id))));
      const fast = await recordStatements(engine, () => performSync(engine, cliOpts(id)));
      expect(settles(full.sent, id)).toEqual({ holdReads: 4, holdReport: 1, failureRows: 1, needsHuman: 1, tailReads: 2 });
      expect(settles(fast.sent, id)).toEqual({ holdReads: 1, holdReport: 0, failureRows: 0, needsHuman: 0, tailReads: 1 });
      expect(fast.sent.length).toBeLessThan(full.sent.length);
      const envelope = (result: SyncResult) => buildSingleSyncJsonEnvelope(id, result);
      expect(fast.result.status).toBe('up_to_date');
      expect(envelope(fast.result)).toEqual(envelope(full.result));
      expect(fast.result).toEqual(full.result);
    });

    /** A state that gives each skipped settle work, and the count that shows the settle ran (IDLE_SKIPS: a new skip needs a case). */
    const blocking: Record<IdleSkip, { seed: (engine: BrainEngine, source: { id: string; incarnation: string }) => Promise<void>; ran: (counts: ReturnType<typeof settles>) => boolean }> = {
      hold_report: {
        seed: (engine, { id, incarnation }) => engine.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,jsonb_build_array(jsonb_build_object('count',1)))",
          [GIT_HOLD_SUMMARY_OP, summaryFingerprint(id, incarnation)]).then(() => undefined),
        ran: counts => counts.holdReport === 1,
      },
      settled_failures: {
        seed: (engine, { id }) => engine.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync-failure',$1,jsonb_build_array(jsonb_build_object('source_id',$2::text,'path','fund-a.md')))",
          ['older-key-' + id, id]).then(() => undefined),
        ran: counts => counts.failureRows === 1,
      },
      needs_human_sweep: { seed: (engine, source) => hold(engine, source), ran: counts => counts.needsHuman === 1 },
      sync_tail: { seed: (engine, { id }) => recordPassTail(engine, id, randomUUID(), { changed: 1, extract: false }), ran: counts => counts.tailReads >= 2 },
      slug_heal: { seed: (engine, source) => hold(engine, source), ran: counts => counts.holdReads >= 4 },
      origin_heal: { seed: (engine, source) => hold(engine, source), ran: counts => counts.holdReads >= 4 },
    };
    const hold = (engine: BrainEngine, { id, incarnation }: { id: string; incarnation: string }) => engine.transaction(tx => writeGitHold(tx, {
      source_id: id, incarnation, path: 'acme-example.md', source_path: 'acme-example.md', slug: 'acme-example', page_id: null, code: 'frontmatter_slug_conflict',
      message: 'slug conflict', upstream_version: null, observed_at: new Date().toISOString(), run_id: null, mode: 'managed', meta: {} as never })).then(() => undefined);

    for (const skip of Object.keys(IDLE_SKIPS) as IdleSkip[]) {
      check('the ' + skip + ' settle runs on a tick whose pin read work for it', async engine => {
        const source = await idleSource(engine);
        await blocking[skip].seed(engine, source);
        const { sent } = await recordStatements(engine, () => performSync(engine, cliOpts(source.id)));
        expect(blocking[skip].ran(settles(sent, source.id))).toBe(true);
      });
    }

    check('a ledger row of the source keeps the settled-failures settle on an idle tick', async engine => {
      const { id } = await idleSource(engine);
      recordFailures(id, [{ path: 'fund-a.md', error: 'parse error' }], 'abc1234');
      try {
        const { sent } = await recordStatements(engine, () => performSync(engine, cliOpts(id)));
        expect(settles(sent, id).failureRows).toBe(1);
      } finally { clearFailures(id, ['fund-a.md']); }
    });
  });
}

describe('GBRA-133 idle-clear facts', () => {
  const clear: IdleFacts = { tail: false, holds: 0, holdSummary: 0, failures: false };
  const blocked: Record<keyof IdleFacts, Partial<IdleFacts>> = { tail: { tail: true }, holds: { holds: 1 }, holdSummary: { holdSummary: 2 }, failures: { failures: true } };
  test('every fact the pin reads blocks the skips on its own, and GBRAIN_SYNC_IDLE_FAST_PATH=0 blocks them all', async () => {
    await withEnv({ GBRAIN_SYNC_IDLE_FAST_PATH: undefined }, async () => {
      expect(idleClear(clear)).toBe(true);
      for (const [fact, value] of Object.entries(blocked)) expect([fact, idleClear({ ...clear, ...value })]).toEqual([fact, false]);
    });
    await withEnv({ GBRAIN_SYNC_IDLE_FAST_PATH: '0' }, async () => { expect(idleClear(clear)).toBe(false); });
  });
});
