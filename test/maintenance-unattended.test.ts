/**
 * GBRA-438 PR 1: free unattended upkeep (src/core/maintenance/run.ts), its
 * status view and doctor check, on a repo-less brain (the default keyless
 * install) and on Postgres when DATABASE_URL is set.
 *
 * 1. Protects: upkeep runs only the free phases and the bookkeeping GC, never
 *    the page purge or a paid phase; it never writes a cycle freshness stamp;
 *    brain-wide steps run once per window on a multi-source brain; every skip
 *    comes back with its code, exit and fix; a keyed brain spends nothing past
 *    maintenance.embed_daily_usd; doctor and --status read one record.
 * 2. Fails when: a purge or paid phase enters the unattended list, a stamp is
 *    written, a global step repeats per source, a skip throws or exits 1, a
 *    gateway call happens with the cap at 0, or a doctor state is misread.
 * 3. Real seams: runCycle on PGLite and Postgres, the gateway's embed
 *    transport (a spy), the AI invocation observer, the CLI's runMaintain.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { ALL_PHASES, PHASE_SCOPE, runCycle, type CyclePhase } from '../src/core/cycle.ts';
import { MANAGED_PHASE_TABLE } from '../src/core/cycle/phase-table.ts';
import {
  MAINTAIN_SAFE_PHASES, MAINTENANCE_EMBED_SPEND_KEY, UPKEEP_INTERVAL_MS, readEmbedSpentToday, readUpkeepRecord, runUnattendedMaintenance, unattendedPlan,
  type SafePhaseProviders,
} from '../src/core/maintenance/run.ts';
import { checkUnattendedMaintenance } from '../src/commands/doctor/checks/unattended-maintenance.ts';
import { checkCycleFreshness } from '../src/commands/doctor/checks/consolidation-cycle.ts';
import { runMaintain } from '../src/commands/maintain.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { observeAIInvocations } from '../src/core/ai/invocation-guard.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import { DEGRADED_STATE } from '../src/core/degraded-marker.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';

const KEYLESS: SafePhaseProviders = { embedding: false, decideConflict: false, fenceRepairModel: false, contentRepairModel: false };
const KEYED: SafePhaseProviders = { ...KEYLESS, embedding: true };
const HOUR = 60 * 60 * 1000;
const FENCE = (claim: string) => ['## Facts', '<!--- gbrain:facts:begin -->',
  '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
  '| 1 | ' + claim + ' | fact | 1.0 | world | medium | 2017-01-01 |  | chat |  |', '<!--- gbrain:facts:end -->', ''].join('\n');

describe('the unattended step list', () => {
  test('free and filesystem phases only, plus the bookkeeping GC; never the purge or a paid phase', () => {
    for (const providers of [KEYLESS, KEYED, { ...KEYED, decideConflict: true, fenceRepairModel: true, contentRepairModel: true }]) {
      const plan = unattendedPlan(providers);
      const all = [...plan.global, ...plan.source];
      expect(all).toContain('bookkeeping_gc');
      expect(all).not.toContain('purge');
      for (const phase of all) expect(['free', 'filesystem', phase === 'bookkeeping_gc' ? 'deletes' : 'free']).toContain(MANAGED_PHASE_TABLE[phase].tier);
      expect(plan.global.every((phase) => PHASE_SCOPE[phase] !== 'source')).toBe(true);
      expect(plan.source.every((phase) => PHASE_SCOPE[phase] === 'source')).toBe(true);
    }
  });

  test('the --safe list is free or filesystem tier', () => {
    for (const phase of MAINTAIN_SAFE_PHASES) expect(['free', 'filesystem']).toContain(MANAGED_PHASE_TABLE[phase].tier);
  });

  test('a keyed brain keeps extract_facts with its embedding deferred; the System One slot holds it', () => {
    expect(unattendedPlan(KEYED)).toMatchObject({ embedding: true, held: ['fence_repair', 'content_repair'] });
    expect(unattendedPlan(KEYED).source).toContain('extract_facts');
    expect(unattendedPlan({ ...KEYLESS, decideConflict: true }).held).toContain('extract_facts');
    expect(unattendedPlan(KEYLESS)).toMatchObject({ embedding: false, held: [] });
  });
});

for (const kind of testBackends()) {
  describe(GBRA_TITLE(kind), () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let home: string;
    const calls: string[] = [];
    let stopObserving: () => void;

    beforeAll(async () => {
      home = mkdtempSync(join(tmpdir(), 'gbrain-upkeep-'));
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      stopObserving = observeAIInvocations((event) => { calls.push(event.call.kind); });
    });

    afterAll(async () => {
      _resetCliExitVerdictForTests();
      process.exitCode = 0;
      stopObserving();
      __setEmbedTransportForTests(null);
      resetGateway();
      await close();
      rmSync(home, { recursive: true, force: true });
    });

    beforeEach(async () => {
      calls.length = 0;
      _resetCliExitVerdictForTests();
      __setEmbedTransportForTests(null);
      resetGateway();
      await engine.executeRaw("DELETE FROM config WHERE key LIKE 'maintenance.%' OR key = 'autopilot.last_global_at'");
      await engine.executeRaw("DELETE FROM sources WHERE id <> 'default'");
      await engine.executeRaw("UPDATE sources SET config = '{}'::jsonb WHERE id = 'default'");
      await engine.executeRaw('DELETE FROM facts');
      await engine.executeRaw('DELETE FROM pages');
      await engine.executeRaw("DELETE FROM op_checkpoints WHERE op LIKE 'upkeep-%'");
    });

    /** A keyed brain at the schema's own vector width, with a spy for a transport. */
    async function keyed() {
      const [col] = await engine.executeRaw<{ dims: number }>("SELECT atttypmod AS dims FROM pg_attribute WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding'");
      const dims = Number(col!.dims);
      await engine.setConfig('embedding_model', 'openai:text-embedding-3-small');
      await engine.setConfig('embedding_dimensions', String(dims));
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: dims, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => new Array(dims).fill(0.01)) })) as never);
    }

    const upkeep = (e: BrainEngine, opts: Parameters<typeof runUnattendedMaintenance>[1]) => withEnv({ GBRAIN_HOME: home }, () => runUnattendedMaintenance(e, opts));

    async function maintainJson(args: string[]): Promise<Record<string, unknown>> {
      const out: string[] = [];
      const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
      try { await withEnv({ GBRAIN_HOME: home }, () => runMaintain(engine, args)); } finally { spy.mockRestore(); }
      return JSON.parse(out.join('\n'));
    }

    test('maintain --unattended removes GC rows past retention while a page soft-deleted 100h ago survives', async () => {
      await engine.putPage('notes/old', { type: 'concept', title: 'Old', compiled_truth: 'An old note.' });
      await engine.softDeletePage('notes/old');
      await engine.executeRaw("UPDATE pages SET deleted_at = now() - interval '100 hours' WHERE slug = 'notes/old'");
      await engine.executeRaw("INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at) VALUES ('upkeep-gc', 'a', '[]'::jsonb, now() - interval '8 days')");
      await engine.executeRaw("INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at) VALUES ('upkeep-fresh', 'b', '[]'::jsonb, now())");
      const out = await maintainJson(['--unattended', '--json']);
      expect(out).toMatchObject({ status: 'ran', exit: 0 });
      expect(await engine.executeRaw("SELECT op FROM op_checkpoints WHERE op LIKE 'upkeep-%' ORDER BY op")).toEqual([{ op: 'upkeep-fresh' }]);
      expect(await engine.executeRaw("SELECT slug FROM pages WHERE slug = 'notes/old' AND deleted_at IS NOT NULL")).toEqual([{ slug: 'notes/old' }]);
      const record = await readUpkeepRecord(engine);
      expect(record!.steps.map((s) => s.name)).toContain('bookkeeping_gc');
      expect(record!.steps.map((s) => s.name)).not.toContain('purge');
    });

    test('maintain --purge previews, refuses a missing or stale hash, and purges exactly the previewed set', async () => {
      await engine.putPage('notes/gone', { type: 'concept', title: 'Gone', compiled_truth: 'Deleted long ago.' });
      await engine.putPage('notes/recent', { type: 'concept', title: 'Recent', compiled_truth: 'Deleted an hour ago.' });
      await engine.softDeletePage('notes/gone');
      await engine.softDeletePage('notes/recent');
      await engine.executeRaw("UPDATE pages SET deleted_at = now() - interval '100 hours' WHERE slug = 'notes/gone'");
      const remaining = async () => (await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE slug LIKE 'notes/%' ORDER BY slug")).map((r) => r.slug);

      const preview = await maintainJson(['--purge', '--json']);
      expect(preview).toMatchObject({ mode: 'preview', count: 1, pages: [{ slug: 'notes/gone' }] });
      expect(typeof preview.hash).toBe('string');
      expect(await remaining()).toEqual(['notes/gone', 'notes/recent']);

      for (const args of [['--purge', '--yes'], ['--purge', '--yes', '--expect', 'stale0hash00']]) {
        _resetCliExitVerdictForTests();
        await withEnv({ GBRAIN_HOME: home }, () => runMaintain(engine, args));
        expect(currentExitCode()).toBe(1);
        expect(await remaining()).toEqual(['notes/gone', 'notes/recent']);
      }

      _resetCliExitVerdictForTests();
      const applied = await maintainJson(['--purge', '--yes', '--expect', String(preview.hash), '--json']);
      expect(applied).toMatchObject({ mode: 'applied', purged: 1 });
      expect(currentExitCode()).toBe(0);
      expect(await remaining()).toEqual(['notes/recent']);
    });

    test('maintain --purge --expect purges the previewed page, not a same-slug page in another source that became eligible after the preview', async () => {
      const purgeModule = await import('../src/core/persistence/purge-deleted.ts');
      await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-b', 'source-b')");
      await engine.putPage('notes/twin', { type: 'concept', title: 'Twin', compiled_truth: 'Deleted long ago.' });
      await engine.putPage('notes/twin', { type: 'concept', title: 'Twin', compiled_truth: 'Deleted an hour ago.' }, { sourceId: 'source-b' });
      await engine.softDeletePage('notes/twin');
      await engine.softDeletePage('notes/twin', { sourceId: 'source-b' });
      await engine.executeRaw("UPDATE pages SET deleted_at = now() - interval '100 hours' WHERE slug = 'notes/twin' AND source_id = 'default'");
      const preview = await maintainJson(['--purge', '--json']);
      expect(preview).toMatchObject({ mode: 'preview', count: 1, pages: [{ slug: 'notes/twin' }] });
      let raced = 0;
      const purge = purgeModule.purgeDeletedPagesCoordinated;
      const spy = spyOn(purgeModule, 'purgeDeletedPagesCoordinated').mockImplementation(async (e, hours, opts) => {
        await e.executeRaw("UPDATE pages SET deleted_at = now() - interval '100 hours' WHERE slug = 'notes/twin' AND source_id = 'source-b'");
        raced += 1;
        return purge(e, hours, opts);
      });
      _resetCliExitVerdictForTests();
      try {
        await maintainJson(['--purge', '--yes', '--expect', String(preview.hash), '--json']);
      } finally { spy.mockRestore(); }
      expect(raced).toBe(1);
      expect(await engine.executeRaw("SELECT source_id, slug FROM pages WHERE slug = 'notes/twin'")).toEqual([{ source_id: 'source-b', slug: 'notes/twin' }]);
      expect(preview.pages).toEqual([{ source_id: 'default', slug: 'notes/twin' }]);
    });

    test('stamp honesty: a keyed brain keeps last_full_cycle_at and last_source_cycle_at', async () => {
      await keyed();
      await engine.setConfig('maintenance.embed_daily_usd', '0');
      await engine.putPage('notes/a', { type: 'concept', title: 'A', compiled_truth: 'See [[notes/b]].' });
      const stamp = { last_full_cycle_at: '2026-01-01T00:00:00.000Z', last_source_cycle_at: '2026-01-02T00:00:00.000Z' };
      await engine.updateSourceConfig('default', stamp);
      const outcome = await upkeep(engine, { runner: 'test', providers: KEYED });
      expect(outcome.status).toBe('ran');
      const [source] = await engine.executeRaw<{ config: Record<string, unknown> }>("SELECT config FROM sources WHERE id = 'default'");
      const config = typeof source!.config === 'string' ? JSON.parse(source!.config as never) : source!.config;
      expect({ last_full_cycle_at: config.last_full_cycle_at, last_source_cycle_at: config.last_source_cycle_at }).toEqual(stamp);
    });

    test('a 3-source brain runs each global step once per window and each source step once per source', async () => {
      for (const id of ['wiki-a', 'wiki-b']) await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [id]);
      const outcome = await upkeep(engine, { runner: 'test', providers: KEYLESS });
      const plan = unattendedPlan(KEYLESS);
      const steps = outcome.record!.steps;
      for (const phase of plan.global) expect(steps.filter((s) => s.name === phase).map((s) => s.scope)).toEqual(['global']);
      for (const phase of plan.source) expect(steps.filter((s) => s.name === phase).map((s) => s.scope).sort()).toEqual(['default', 'wiki-a', 'wiki-b']);
      expect(outcome.record!.cursor).toBeNull();
      const again = await upkeep(engine, { runner: 'test', providers: KEYLESS });
      expect(again).toMatchObject({ status: 'not_due', exit: 0 });
      const later = await upkeep(engine, { runner: 'test', providers: KEYLESS, now: () => new Date(Date.now() + UPKEEP_INTERVAL_MS + HOUR) });
      expect(later.status).toBe('ran');
    });

    describe('error contract, one test per row', () => {
      test('lock held by another cycle: cycle_already_running, exit 0, wait', async () => {
        const held = await tryAcquireDbLock(engine, 'gbrain-cycle', 5);
        try {
          const outcome = await upkeep(engine, { runner: 'test', providers: KEYLESS });
          expect(outcome).toMatchObject({ status: 'skipped', exit: 0, code: 'cycle_already_running', fix: { actor: 'provider' } });
        } finally { await held!.release(); }
      });

      test('engine degraded: engine_degraded, exit 0, report', async () => {
        const degraded = Object.assign(Object.create(engine), { [DEGRADED_STATE]: () => true }) as BrainEngine;
        const outcome = await upkeep(degraded, { runner: 'test', providers: KEYLESS });
        expect(outcome).toMatchObject({ status: 'skipped', exit: 0, code: 'engine_degraded' });
        expect(outcome.fix?.argv).toBeUndefined();
      });

      test('migrations pending: migrations_pending, exit 0, run the migrate fix', async () => {
        const version = await engine.getConfig('version');
        await engine.setConfig('version', '1');
        try {
          const outcome = await upkeep(engine, { runner: 'test', providers: KEYLESS });
          expect(outcome).toMatchObject({ status: 'skipped', exit: 0, code: 'migrations_pending', fix: { argv: ['gbrain', 'apply-migrations', '--yes'], actor: 'agent' } });
        } finally { await engine.setConfig('version', version!); }
      });

      test('low write capacity: the capacity code, exit 0, tell_user_to_run', async () => {
        const outcome = await upkeep(engine, { runner: 'test', providers: KEYLESS,
          capacityPaused: async () => ({ command: 'gbrain config set persistence.capacity.max_request_ids 2000000', config_key: 'persistence.capacity.max_request_ids' }) });
        expect(outcome).toMatchObject({ status: 'skipped', exit: 0, code: 'write_capacity_backpressure', fix: { actor: 'host_admin' } });
      });

      test('maintenance.auto=false: maintenance_disabled, exit 0, no fix', async () => {
        await engine.setConfig('maintenance.auto', 'false');
        const outcome = await upkeep(engine, { runner: 'test', providers: KEYLESS });
        expect(outcome).toMatchObject({ status: 'skipped', exit: 0, code: 'maintenance_disabled' });
        expect(outcome.fix).toBeUndefined();
      });

      test('autopilot owns upkeep: maintenance_owned_by_autopilot, exit 0, no fix', async () => {
        await engine.setConfig('autopilot.last_global_at', new Date(Date.now() - HOUR).toISOString());
        const outcome = await upkeep(engine, { runner: 'test', providers: KEYLESS });
        expect(outcome).toMatchObject({ status: 'skipped', exit: 0, code: 'maintenance_owned_by_autopilot' });
        expect(outcome.fix).toBeUndefined();
      });

      test('a step failed: its own code, exit 1; three runs in a row back it off and doctor warns', async () => {
        const failing: typeof runCycle = async (e, o) => {
          const report = await runCycle(e, o);
          return { ...report, phases: report.phases.map((p) => p.phase === 'orphans' ? { ...p, status: 'fail' as const, code: 'orphans_probe_failed' } : p) };
        };
        let at = Date.now();
        for (let i = 0; i < 3; i++) {
          const outcome = await upkeep(engine, { runner: 'test', providers: KEYLESS, cycle: failing, now: () => new Date(at) });
          expect(outcome).toMatchObject({ status: 'ran', exit: 1, code: 'orphans_probe_failed' });
          at += UPKEEP_INTERVAL_MS + HOUR;
        }
        const record = await readUpkeepRecord(engine);
        expect(record!.consecutive_failures).toEqual([expect.objectContaining({ step: 'orphans', scope: 'global', code: 'orphans_probe_failed', count: 3 })]);
        const backedOff = await upkeep(engine, { runner: 'test', providers: KEYLESS, cycle: failing, now: () => new Date(at) });
        expect(backedOff.record!.steps).toContainEqual({ name: 'orphans', scope: 'global', status: 'skipped', reason: 'backed_off' });
        const check = await checkUnattendedMaintenance(engine, { nowMs: at });
        expect(check).toMatchObject({ status: 'warn', details: { state: 'failing' } });
        expect(check.message).toContain('orphans');
      });

      test('a cycle that threw three times reads failing until the next clean run clears it', async () => {
        let throws = 3;
        const flaky: typeof runCycle = async (e, o) => {
          if (throws > 0 && !o.sourceId) { throws -= 1; throw Object.assign(new Error('connection reset'), { code: 'db_connection_reset' }); }
          return runCycle(e, o);
        };
        let at = Date.now();
        for (let i = 0; i < 3; i++) {
          const outcome = await upkeep(engine, { runner: 'test', providers: KEYLESS, cycle: flaky, now: () => new Date(at) });
          expect(outcome).toMatchObject({ status: 'ran', exit: 1, code: 'db_connection_reset' });
          at += UPKEEP_INTERVAL_MS + HOUR;
        }
        expect(await checkUnattendedMaintenance(engine, { nowMs: at })).toMatchObject({ status: 'warn', details: { state: 'failing' } });
        const clean = await upkeep(engine, { runner: 'test', providers: KEYLESS, cycle: flaky, now: () => new Date(at) });
        expect(clean).toMatchObject({ status: 'ran', exit: 0 });
        expect(clean.record!.consecutive_failures).toEqual([]);
        expect(await checkUnattendedMaintenance(engine, { nowMs: at })).toMatchObject({ status: 'ok', details: { state: 'ok' } });
      });

      test('a failing step that is held back afterwards no longer keeps doctor failing', async () => {
        const failing: typeof runCycle = async (e, o) => {
          const report = await runCycle(e, o);
          return { ...report, phases: report.phases.map((p) => p.phase === 'fence_repair' ? { ...p, status: 'fail' as const, code: 'fence_probe_failed' } : p) };
        };
        let at = Date.now();
        for (let i = 0; i < 3; i++) {
          await upkeep(engine, { runner: 'test', providers: KEYLESS, cycle: failing, now: () => new Date(at) });
          at += UPKEEP_INTERVAL_MS + HOUR;
        }
        expect((await readUpkeepRecord(engine))!.consecutive_failures).toEqual([expect.objectContaining({ step: 'fence_repair', count: 3 })]);
        const held = await upkeep(engine, { runner: 'test', providers: { ...KEYLESS, fenceRepairModel: true }, now: () => new Date(at) });
        expect(held.record!.held).toContain('fence_repair');
        expect(held.record!.consecutive_failures).toEqual([]);
        expect(await checkUnattendedMaintenance(engine, { nowMs: at })).toMatchObject({ status: 'ok', details: { state: 'ok' } });
      });
    });

    describe('decision D: the embedding cap', () => {
      test('embed_daily_usd 0: zero gateway calls, extract_facts included', async () => {
        await keyed();
        await engine.setConfig('maintenance.embed_daily_usd', '0');
        await engine.putPage('people/alice-example', { type: 'person', title: 'Alice', compiled_truth: 'Alice works on search.\n\n' + FENCE('Alice leads the search team') });
        const outcome = await upkeep(engine, { runner: 'test', providers: KEYED });
        expect(outcome.status).toBe('ran');
        expect(outcome.record!.steps).toContainEqual(expect.objectContaining({ name: 'extract_facts', status: 'ok' }));
        expect(outcome.record!.steps).toContainEqual({ name: 'embed', scope: 'global', status: 'skipped', reason: 'embed_cap_off' });
        expect(await engine.executeRaw('SELECT fact FROM facts WHERE embedding IS NULL')).toEqual([{ fact: 'Alice leads the search team' }]);
        expect(calls).toEqual([]);
      });

      test('at the default $1 cap the step stops, and doctor shows the spend', async () => {
        await keyed();
        await engine.putPage('notes/embed-me', { type: 'concept', title: 'Embed', compiled_truth: 'A page whose chunks need vectors.' });
        const today = new Date().toISOString().slice(0, 10);
        await engine.setConfig(MAINTENANCE_EMBED_SPEND_KEY, JSON.stringify({ day: today, usd: 1 }));
        const outcome = await upkeep(engine, { runner: 'test', providers: KEYED });
        expect(outcome.record!.steps).toContainEqual({ name: 'embed', scope: 'global', status: 'skipped', reason: 'daily_cap_reached' });
        expect(calls).toEqual([]);
        const check = await withEnv({ OPENAI_API_KEY: 'test' }, () => checkUnattendedMaintenance(engine));
        expect(check.message).toContain('$1.00 of $1.00 today');
      });

      test('under the cap the backlog is embedded and the spend recorded', async () => {
        await keyed();
        await engine.putPage('notes/embed-me', { type: 'concept', title: 'Embed', compiled_truth: 'A page whose chunks need vectors.' });
        const outcome = await upkeep(engine, { runner: 'test', providers: KEYED });
        expect(outcome.record!.steps).toContainEqual(expect.objectContaining({ name: 'embed', status: 'ok' }));
        expect(outcome.record!.embed!.cap_usd).toBe(1);
        expect(outcome.record!.embed!.spent_today_usd).toBeLessThanOrEqual(1);
      });
    });

    describe('review fixes: the embed step and fact deferral', () => {
      const quick: typeof runCycle = async () => ({ status: 'ok', phases: [] }) as never;

      test('an edited fact on a keyed brain is replaced, not only expired, when upkeep defers its embedding', async () => {
        await keyed();
        await engine.putPage('people/alice-example', { type: 'person', title: 'Alice', compiled_truth: 'Alice works on search.\n\n' + FENCE('Alice leads the search team') });
        let at = Date.now();
        await upkeep(engine, { runner: 'test', providers: KEYED, now: () => new Date(at) });
        expect(await engine.executeRaw('SELECT fact FROM facts WHERE expired_at IS NULL AND embedding IS NOT NULL')).toEqual([{ fact: 'Alice leads the search team' }]);
        await engine.putPage('people/alice-example', { type: 'person', title: 'Alice', compiled_truth: 'Alice works on search.\n\n' + FENCE('Alice leads the ranking team') });
        at += UPKEEP_INTERVAL_MS + HOUR;
        await upkeep(engine, { runner: 'test', providers: KEYED, now: () => new Date(at) });
        expect(await engine.executeRaw('SELECT fact FROM facts WHERE expired_at IS NULL')).toEqual([{ fact: 'Alice leads the ranking team' }]);
      });

      test('two overlapping runs embed once: the second skips the embed step instead of spending the cap again', async () => {
        await keyed();
        const [col] = await engine.executeRaw<{ dims: number }>("SELECT atttypmod AS dims FROM pg_attribute WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding'");
        __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          return { embeddings: values.map(() => new Array(Number(col!.dims)).fill(0.01)) };
        }) as never);
        await engine.putPage('notes/embed-me', { type: 'concept', title: 'Embed', compiled_truth: 'A page whose chunks need vectors.' });
        const [a, b] = await Promise.all([1, 2].map(() => upkeep(engine, { runner: 'test', providers: KEYED, cycle: quick })));
        const embedSteps = [a, b].map((o) => o.record!.steps.find((s) => s.name === 'embed'));
        expect(embedSteps.filter((s) => s?.status === 'ok')).toHaveLength(1);
        expect(embedSteps).toContainEqual({ name: 'embed', scope: 'global', status: 'skipped', reason: 'embed_running' });
      });

      test('the ledger holds the rest of the cap while the step spends, so a run killed mid-step cannot spend it again', async () => {
        await keyed();
        const [col] = await engine.executeRaw<{ dims: number }>("SELECT atttypmod AS dims FROM pg_attribute WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding'");
        const midStep: number[] = [];
        __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
          midStep.push(await readEmbedSpentToday(engine, new Date()));
          return { embeddings: values.map(() => new Array(Number(col!.dims)).fill(0.01)) };
        }) as never);
        await engine.putPage('notes/embed-me', { type: 'concept', title: 'Embed', compiled_truth: 'A page whose chunks need vectors.' });
        const outcome = await upkeep(engine, { runner: 'test', providers: KEYED, cycle: quick });
        expect(outcome.record!.steps).toContainEqual(expect.objectContaining({ name: 'embed', status: 'ok' }));
        expect(midStep.length).toBeGreaterThan(0);
        expect(midStep.every((usd) => usd === 1)).toBe(true);
        expect(await readEmbedSpentToday(engine, new Date())).toBeLessThan(1);
      });

      test('the embed step does not start once the run budget is spent', async () => {
        await keyed();
        await engine.putPage('notes/embed-me', { type: 'concept', title: 'Embed', compiled_truth: 'A page whose chunks need vectors.' });
        const slowSource: typeof runCycle = async (e, o) => {
          if (o.sourceId) await new Promise((resolve) => setTimeout(resolve, 120));
          return quick(e, o);
        };
        const outcome = await upkeep(engine, { runner: 'test', providers: KEYED, cycle: slowSource, budgetMs: 60 });
        expect(outcome.record!.cursor).toBeNull();
        expect(outcome.record!.steps).toContainEqual({ name: 'embed', scope: 'global', status: 'skipped', reason: 'budget_exhausted' });
        expect(calls).toEqual([]);
      });
    });

    test('a purge limited to the previewed pages leaves a page that became eligible afterwards', async () => {
      const { purgeDeletedPagesCoordinated } = await import('../src/core/persistence/purge-deleted.ts');
      for (const slug of ['notes/previewed', 'notes/late']) {
        await engine.putPage(slug, { type: 'concept', title: slug, compiled_truth: 'Deleted long ago.' });
        await engine.softDeletePage(slug);
      }
      await engine.executeRaw("UPDATE pages SET deleted_at = now() - interval '100 hours' WHERE slug IN ('notes/previewed', 'notes/late')");
      const result = await purgeDeletedPagesCoordinated(engine, 72, { automatic: true, only: (page) => page.slug === 'notes/previewed' });
      expect(result.slugs).toEqual(['notes/previewed']);
      expect(await engine.executeRaw("SELECT slug FROM pages WHERE slug LIKE 'notes/%' ORDER BY slug")).toEqual([{ slug: 'notes/late' }]);
    });

    describe('doctor states with a fixed clock', () => {
      const NOW = Date.parse('2026-11-12T12:00:00.000Z');
      const record = (at: number, extra: Record<string, unknown> = {}) => engine.setConfig('maintenance.last_run', JSON.stringify({
        at: new Date(at).toISOString(), runner: 'cli', status: 'ok', steps: [{ name: 'extract', scope: 'default', status: 'ok' }], held: [], cursor: null,
        next_due_at: new Date(at + UPKEEP_INTERVAL_MS).toISOString(), consecutive_failures: [], ...extra }));

      test('ok', async () => {
        await record(NOW - 3 * HOUR);
        const check = await checkUnattendedMaintenance(engine, { nowMs: NOW });
        expect(check).toMatchObject({ status: 'ok', details: { state: 'ok', runner: 'cli' } });
        expect(check.message).toMatch(/^Free upkeep ran 3h ago \(cli, 1 steps ok\)\. Next due in 21h\./);
      });

      test('info on a brain under 48h old with no run', async () => {
        await engine.putPage('notes/new', { type: 'concept', title: 'New', compiled_truth: 'Fresh.' });
        const check = await checkUnattendedMaintenance(engine, { nowMs: Date.now() });
        expect(check).toMatchObject({ status: 'ok', severity: 'info', details: { state: 'never' } });
      });

      test('off', async () => {
        await engine.setConfig('maintenance.auto', 'false');
        expect(await checkUnattendedMaintenance(engine, { nowMs: NOW })).toMatchObject({ status: 'ok', details: { state: 'off' } });
      });

      test('autopilot owns', async () => {
        await engine.setConfig('autopilot.last_global_at', new Date(NOW - HOUR).toISOString());
        expect(await checkUnattendedMaintenance(engine, { nowMs: NOW })).toMatchObject({ status: 'ok', details: { state: 'autopilot' } });
      });

      test('warn overdue, with a free fix on a keyless brain', async () => {
        await record(NOW - 72 * HOUR);
        const check = await checkUnattendedMaintenance(engine, { nowMs: NOW });
        expect(check).toMatchObject({ status: 'warn', details: { state: 'overdue' }, fix: { argv: ['gbrain', 'maintain', '--unattended'], consent: [] } });
      });

      test('warn after 3 failures', async () => {
        await record(NOW - HOUR, { consecutive_failures: [{ step: 'extract', scope: 'default', code: 'extract_failed', count: 3, last_at: new Date(NOW - HOUR).toISOString() }] });
        const check = await checkUnattendedMaintenance(engine, { nowMs: NOW });
        expect(check).toMatchObject({ status: 'warn', details: { state: 'failing' } });
        expect(check.message).toContain('The last 3 upkeep runs failed at extract (default) with extract_failed');
      });

      test('maintain --status --json shape', async () => {
        await record(Date.now() - HOUR);
        const out = await maintainJson(['--status', '--json']);
        expect(Object.keys(out).sort()).toEqual(['embed_daily_cap_usd', 'embed_spend_today_usd', 'failing', 'held', 'last_run', 'message', 'next_due_at',
          'paid_phases_opt_in', 'parked', 'pending_purge_count', 'runner', 'state', 'steps']);
        expect(out).toMatchObject({ state: 'ok', runner: 'cli', embed_spend_today_usd: null, embed_daily_cap_usd: null, pending_purge_count: 0, parked: [] });
        expect(out.paid_phases_opt_in).toContain('embed');
      });

      test('cycle_freshness asks consent: [] on a keyless brain', async () => {
        await engine.putPage('notes/old', { type: 'concept', title: 'Old', compiled_truth: 'Old.' });
        await engine.executeRaw("UPDATE pages SET created_at = now() - interval '10 days'");
        await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [join(home, 'content')]);
        const check = await withEnv({ OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, VOYAGE_API_KEY: undefined, GEMINI_API_KEY: undefined }, () => checkCycleFreshness(engine));
        expect(check.status).toBe('warn');
        expect(check.fix).toMatchObject({ argv: ['gbrain', 'dream', '--source', 'default'], consent: [] });
      });
    });
  });
}

function GBRA_TITLE(kind: string): string {
  return 'unattended upkeep (' + kind + ', repo-less)';
}
