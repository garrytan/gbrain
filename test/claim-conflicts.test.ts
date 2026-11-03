/**
 * The keyless claim-conflict lane (GBRA-216 PR B): the detector
 * (facts/claim-conflicts.ts), the claim_conflicts dream phase on a source with
 * no local path, gbrain decide sweep --claims, the trust review contradiction
 * kind with every advertised command executed, and recall's contested label
 * under the caller's read policy.
 *
 * Protects: only same-entity, same-metric, same-unit/period, same-bucket
 * conflicts are proposed (monthly series, funding rounds and forecast vs
 * actual are history or different claims); one proposal per pair across runs
 * and concurrent runs; the cap defers without starving; audit rows, other
 * entities and mixed visibility never pair; a remote or floor-limited caller
 * never learns of a fact it cannot read; a failed contested lookup degrades.
 * Repo-less (facts in the database, sources with no local path). Both engines:
 * PGLite here, Postgres through test/e2e/claim-conflicts-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { BrainEngine } from '../src/core/engine.ts';
import * as cliForceExit from '../src/core/cli-force-exit.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { AUDIT_ROW_SOURCES } from '../src/core/facts/audit-sources.ts';
import { claimBucket, claimBucketSql, parseClaimParams, sameClaimSlot } from '../src/core/facts/typed-claim.ts';
import { CLAIM_CONFLICTS_MODE_KEY, claimConflictsCyclePhase, claimConflictsModeRefusal, runClaimConflicts } from '../src/core/facts/claim-conflicts.ts';
import { CLAIM_CONFLICTS_MAX_PAIRS_KEY, parsePhaseConfigValue } from '../src/core/cycle/phase-config-values.ts';
import { runCycle } from '../src/core/cycle.ts';
import { buildTrustReview, renderTrustReview } from '../src/core/trust/review.ts';
import { previewOwnerAction } from '../src/core/trust/owner-actions.ts';
import { __setConfirmationIoForTests } from '../src/core/trust/confirm.ts';
import { localTrustBackend, runTrustOwnerCommand } from '../src/commands/trust.ts';
import { runProposalsCommand, runSweepCommand } from '../src/commands/decide/proposals.ts';
import { runForget } from '../src/commands/recall.ts';
import { withTrustPromotion } from '../src/core/persistence/context.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = Record<string, any>;
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

describe('typed claims (pure)', () => {
  test('as-of buckets: day by default and for unknown periods; ISO week, month, quarter and year by cadence', () => {
    expect(claimBucket(null, '2026-03-20T23:30:00Z')).toBe('2026-03-20');
    expect(claimBucket('per launch', '2026-03-20T10:00:00Z')).toBe('2026-03-20');
    expect(claimBucket('monthly', '2026-03-02T00:00:00Z')).toBe('2026-03');
    expect(claimBucket('Quarterly', '2026-03-30T00:00:00Z')).toBe('2026-Q1');
    expect(claimBucket('annual', '2026-12-31T00:00:00Z')).toBe('2026');
    expect(claimBucket('weekly', '2025-12-29T00:00:00Z')).toBe('2026-W01');
    expect(claimBucket('weekly', '2026-01-01T00:00:00Z')).toBe('2026-W01');
    expect(claimBucket('weekly', '2027-01-03T00:00:00Z')).toBe('2026-W53');
  });

  test('a slot is the metric, unit, period and bucket; two untyped facts share one', () => {
    const at = '2026-03-02T00:00:00Z';
    expect(sameClaimSlot({ valid_from: at }, { valid_from: '2020-01-01T00:00:00Z' })).toBe(true);
    expect(sameClaimSlot({ claim_metric: 'mrr', claim_period: 'monthly', valid_from: at }, { claim_metric: 'mrr', claim_period: 'monthly', valid_from: '2026-03-28T00:00:00Z' })).toBe(true);
    expect(sameClaimSlot({ claim_metric: 'mrr', claim_period: 'monthly', valid_from: at }, { claim_metric: 'mrr', claim_period: 'monthly', valid_from: '2026-04-01T00:00:00Z' })).toBe(false);
    expect(sameClaimSlot({ claim_metric: 'mrr', valid_from: at }, { claim_metric: 'arr', valid_from: at })).toBe(false);
    expect(sameClaimSlot({ claim_metric: 'mrr', valid_from: at }, { valid_from: at })).toBe(false);
    expect(sameClaimSlot({ claim_metric: 'mrr', claim_unit: 'USD', valid_from: at }, { claim_metric: 'mrr', valid_from: at })).toBe(false);
  });

  test('claim params validate like the fence parser; a bad call is refused with the corrected call as fix', () => {
    expect(parseClaimParams({ fact: 'x' })).toBeNull();
    expect(parseClaimParams({ claim_metric: ' mrr ', claim_value: 50000, claim_unit: 'USD', claim_period: 'fortnightly' }))
      .toEqual({ claim_metric: 'mrr', claim_value: 50000, claim_unit: 'USD', claim_period: 'fortnightly' });
    const refused = (p: R) => { try { parseClaimParams(p); } catch (e) { return e as R; } throw new Error('not refused'); };
    const str = refused({ fact: 'Acme MRR', provenance: 'call', claim_metric: 'mrr', claim_value: '2.5M' });
    expect(str.code).toBe('invalid_params');
    expect(str.message).toContain('claim_value must be a finite number');
    expect(str.fix.mcp).toEqual({ tool: 'remember', arguments: { fact: 'Acme MRR', provenance: 'call', claim_metric: 'mrr', claim_value: 2500000 } });
    expect(refused({ claim_metric: 'mrr', claim_value: Number.POSITIVE_INFINITY }).fix.mcp.arguments).toEqual({ claim_metric: 'mrr' });
    expect(refused({ claim_metric: 42, claim_value: 1 }).fix.mcp.arguments).toEqual({ claim_metric: '42', claim_value: 1 });
    const noMetric = refused({ fact: 'x', claim_value: 5 });
    expect(noMetric.message).toContain('claim_metric is required');
    expect(noMetric.fix.mcp.arguments).toEqual({ fact: 'x' });
    expect(refused({ claim_metric: '  ' }).message).toContain('claim_metric must be a non-empty string');
  });

  test('config: the mode takes propose or off; max_pairs takes 1..100000', () => {
    expect(claimConflictsModeRefusal('propose')).toBeNull();
    expect(claimConflictsModeRefusal('OFF')).toBeNull();
    expect(claimConflictsModeRefusal('on')).toContain('must be propose or off');
    expect(parsePhaseConfigValue(CLAIM_CONFLICTS_MAX_PAIRS_KEY, '25')).toBe(25);
    expect(() => parsePhaseConfigValue(CLAIM_CONFLICTS_MAX_PAIRS_KEY, '0')).toThrow();
    expect(() => parsePhaseConfigValue(CLAIM_CONFLICTS_MAX_PAIRS_KEY, '1.5')).toThrow();
  });
});

for (const kind of testBackends()) {
  describe('claim-conflict lane (' + kind + ')', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const home = mkdtempSync(join(tmpdir(), 'gbrain-claim-conflicts-'));
    const ctxOf = (remote: boolean, eng: BrainEngine = engine): OperationContext => ({
      engine: eng, config: { engine: engine.kind, embedding_disabled: true } as unknown as GBrainConfig, logger: quiet, dryRun: false, remote,
      transport: remote ? 'http' : 'stdio', sourceId: 'default',
    } as OperationContext);

    async function source(): Promise<string> {
      const id = 'claims-' + randomUUID().slice(0, 8);
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [id]);
      return id;
    }
    interface F { entity?: string | null; metric?: string | null; value?: number | null; unit?: string | null; period?: string | null; at: string;
      visibility?: 'world' | 'private'; source?: string; text?: string; expired?: boolean; tier?: string; provenancePage?: string }
    async function fact(src: string, f: F): Promise<number> {
      const [r] = await engine.executeRaw<{ id: number | string }>(
        'INSERT INTO facts (source_id, entity_slug, fact, kind, source, visibility, valid_from, claim_metric, claim_value, claim_unit, claim_period, expired_at, source_markdown_slug, row_num)\n'
        + " VALUES ($1, $2, $3, 'fact', $4, $5, $6::timestamptz, $7, $8, $9, $10, CASE WHEN $11 THEN now() ELSE NULL END, $12, CASE WHEN $12::text IS NULL THEN NULL ELSE 1 END) RETURNING id",
        [src, f.entity === undefined ? 'companies/acme-example' : f.entity, f.text ?? (String(f.metric) + ' is ' + String(f.value) + ' at ' + f.at), f.source ?? 'test',
          f.visibility ?? 'world', f.at, f.metric === undefined ? 'mrr' : f.metric, f.value === undefined ? 1 : f.value, f.unit === undefined ? 'USD' : f.unit,
          f.period === undefined ? 'monthly' : f.period, f.expired === true, f.provenancePage ?? null]);
      const id = Number(r!.id);
      if (f.tier) await engine.transaction(tx => withTrustPromotion(tx, 'user_confirmed', () => tx.executeRaw('UPDATE facts SET trust_tier = $1 WHERE id = $2', [f.tier, id])));
      return id;
    }
    const proposals = (src: string) => engine.executeRaw<R>('SELECT * FROM decide_proposals WHERE source_id = $1 ORDER BY id', [src]);
    const lastJson = (out: string) => out.slice(out.lastIndexOf('\n{\n') + 1);
    const pairKeys = (pairs: Array<{ new_fact_id: number; old_fact_id: number }>) => pairs.map(p => p.new_fact_id + '>' + p.old_fact_id).sort();
    const capture = async (fn: () => Promise<unknown>) => {
      const out: string[] = [];
      const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
      const err = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
      const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { out.push(String(chunk)); return true; }) as never);
      const errWrite = spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { out.push(String(chunk)); return true; }) as never);
      const final = spyOn(cliForceExit, 'writeStdoutFinal').mockImplementation(async (doc: string) => { out.push(doc); });
      try { return { result: await fn(), out: out.join('\n') }; } finally { log.mockRestore(); err.mockRestore(); write.mockRestore(); errWrite.mockRestore(); final.mockRestore(); }
    };

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
    }, 180_000);
    afterAll(async () => {
      resetGateway(); __setConfirmationIoForTests(null);
      await disposePersistenceConsumer(engine); await close?.();
      rmSync(home, { recursive: true, force: true });
    });

    test('the bucket SQL agrees with claimBucket on this engine', async () => {
      const cases: Array<[string | null, string]> = [[null, '2026-03-20T23:30:00Z'], ['monthly', '2026-03-02T00:00:00Z'], ['quarterly', '2026-03-30T00:00:00Z'],
        ['annual', '2026-12-31T12:00:00Z'], ['weekly', '2025-12-29T00:00:00Z'], ['weekly', '2027-01-03T00:00:00Z'], ['per launch', '2026-05-05T05:00:00Z']];
      for (const [period, at] of cases) {
        const [row] = await engine.executeRaw<{ b: string }>('SELECT ' + claimBucketSql('f') + ' AS b FROM (SELECT $1::text AS claim_period, $2::timestamptz AS valid_from) f', [period, at]);
        expect(row!.b).toBe(claimBucket(period, at));
      }
    });

    test('proposes same-bucket conflicts only: history, funding rounds, forecast vs actual, other entities, mixed visibility, audit and expired rows never pair', async () => {
      const src = await source();
      const marOld = await fact(src, { value: 40000, at: '2026-03-02T09:00:00Z' });
      const marNew = await fact(src, { value: 45000, at: '2026-03-20T09:00:00Z' });
      await fact(src, { value: 50000, at: '2026-04-05T09:00:00Z' });
      await fact(src, { value: 55000, at: '2026-05-05T09:00:00Z' });
      await fact(src, { value: 47000, at: '2026-03-25T09:00:00Z', expired: true });
      await fact(src, { value: 46000, at: '2026-03-26T09:00:00Z', source: AUDIT_ROW_SOURCES[0] });
      await fact(src, { entity: 'companies/beta-example', value: 41000, at: '2026-03-10T09:00:00Z' });
      await fact(src, { entity: null, value: 42000, at: '2026-03-11T09:00:00Z' });
      await fact(src, { metric: 'funding_round_usd', period: null, value: 2_000_000, at: '2025-01-10T09:00:00Z' });
      await fact(src, { metric: 'funding_round_usd', period: null, value: 8_000_000, at: '2026-02-14T09:00:00Z' });
      await fact(src, { metric: 'revenue_forecast', period: 'quarterly', value: 1_000_000, at: '2026-06-30T09:00:00Z' });
      await fact(src, { metric: 'revenue', period: 'quarterly', value: 900_000, at: '2026-06-30T10:00:00Z' });
      await fact(src, { metric: 'headcount', unit: 'people', period: null, value: 12, at: '2026-07-01T09:00:00Z' });
      await fact(src, { metric: 'headcount', unit: 'people', period: null, value: 12, at: '2026-07-01T10:00:00Z' });
      await fact(src, { metric: 'churn', unit: 'pct', period: null, value: 2, at: '2026-08-01T09:00:00Z', visibility: 'private' });
      await fact(src, { metric: 'churn', unit: 'pct', period: null, value: 3, at: '2026-08-01T10:00:00Z' });
      const arrOld = await fact(src, { metric: 'arr', unit: null, period: null, value: 1, at: '2026-09-01T08:00:00Z' });
      const arrNew = await fact(src, { metric: 'arr', unit: null, period: null, value: 2, at: '2026-09-01T09:00:00Z' });
      await fact(src, { metric: 'arr2', unit: null, period: null, value: 1, at: '2026-09-02T08:00:00Z' });
      await fact(src, { metric: 'arr2', unit: 'USD', period: null, value: 2, at: '2026-09-02T09:00:00Z' });
      const qOld = await fact(src, { metric: 'bookings', period: 'quarterly', value: 10, at: '2026-01-15T09:00:00Z' });
      const qNew = await fact(src, { metric: 'bookings', period: 'quarterly', value: 11, at: '2026-03-30T09:00:00Z' });
      const wOld = await fact(src, { metric: 'signups', unit: null, period: 'weekly', value: 5, at: '2025-12-29T09:00:00Z' });
      const wNew = await fact(src, { metric: 'signups', unit: null, period: 'weekly', value: 6, at: '2026-01-01T09:00:00Z' });

      const preview = await runClaimConflicts(engine, { sourceIds: [src], dryRun: true });
      expect(preview).toMatchObject({ status: 'complete', dry_run: true, pairs_found: 4, proposals_written: 0, deferred: 0 });
      expect(await proposals(src)).toEqual([]);
      expect(pairKeys(preview.sources[0]!.pairs)).toEqual(pairKeys([{ new_fact_id: marNew, old_fact_id: marOld }, { new_fact_id: arrNew, old_fact_id: arrOld },
        { new_fact_id: qNew, old_fact_id: qOld }, { new_fact_id: wNew, old_fact_id: wOld }]));

      const run = await runClaimConflicts(engine, { sourceIds: [src] });
      expect(run).toMatchObject({ status: 'complete', pairs_found: 4, proposals_written: 4 });
      const rows = await proposals(src);
      expect(rows).toHaveLength(4);
      for (const p of rows) {
        expect(String(p.sweep_id)).toBe(run.sweep_id);
        expect(p).toMatchObject({ status: 'pending', direction: 'new_supersedes_old', model_resolved: null });
        expect(Number(p.p_supersede)).toBe(1);
      }
      const again = await runClaimConflicts(engine, { sourceIds: [src] });
      expect(again).toMatchObject({ status: 'complete', pairs_found: 0, proposals_written: 0 });
      expect(await proposals(src)).toHaveLength(4);
    });

    test('concurrent runs file one proposal per pair; a pair with a pending trust supersede_fact proposal is skipped', async () => {
      const src = await source();
      await fact(src, { value: 1, at: '2026-03-01T00:00:00Z' });
      await fact(src, { value: 2, at: '2026-03-02T00:00:00Z' });
      const runs = await Promise.all([runClaimConflicts(engine, { sourceIds: [src] }), runClaimConflicts(engine, { sourceIds: [src] }), runClaimConflicts(engine, { sourceIds: [src] })]);
      expect(runs.reduce((n, r) => n + r.proposals_written, 0)).toBe(1);
      expect(runs.every(r => r.status === 'complete')).toBe(true);
      expect(await proposals(src)).toHaveLength(1);

      const other = await source();
      const old = await fact(other, { value: 1, at: '2026-03-01T00:00:00Z' });
      const neu = await fact(other, { value: 2, at: '2026-03-02T00:00:00Z' });
      await engine.executeRaw("INSERT INTO trust_proposals (action, source_id, target_table, target_id, related_table, related_id, proposer) VALUES ('supersede_fact', $1, 'facts', $2, 'facts', $3, 'conflict_slot')", [other, old, neu]);
      expect(await runClaimConflicts(engine, { sourceIds: [other] })).toMatchObject({ pairs_found: 0, proposals_written: 0 });
    });

    test('the cap defers the rest (partial) and the next run takes them, so already-proposed pairs never starve new ones', async () => {
      const src = await source();
      for (const [day, value] of [[1, 1], [2, 2], [3, 3]] as const) await fact(src, { value, at: '2026-03-0' + day + 'T00:00:00Z' });
      await engine.setConfig(CLAIM_CONFLICTS_MAX_PAIRS_KEY, '2');
      try {
        const first = await runClaimConflicts(engine, { sourceIds: [src] });
        expect(first).toMatchObject({ status: 'partial', pairs_found: 2, proposals_written: 2, deferred: 1, max_pairs: 2 });
        const second = await runClaimConflicts(engine, { sourceIds: [src] });
        expect(second).toMatchObject({ status: 'complete', pairs_found: 1, proposals_written: 1, deferred: 0 });
        expect(await proposals(src)).toHaveLength(3);
      } finally { await engine.executeRaw('DELETE FROM config WHERE key = $1', [CLAIM_CONFLICTS_MAX_PAIRS_KEY]); }
    });

    test('the dream phase is off by default, runs on a source with no local path when set to propose, and runs through runCycle', async () => {
      const src = await source();
      expect((await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id = $1', [src]))[0]!.local_path).toBeNull();
      await fact(src, { value: 7, at: '2026-06-01T00:00:00Z' });
      await fact(src, { value: 8, at: '2026-06-02T00:00:00Z' });
      expect(await claimConflictsCyclePhase(engine, false)).toMatchObject({ phase: 'claim_conflicts', status: 'skipped', details: { reason: 'mode_off' } });
      expect(await proposals(src)).toEqual([]);
      await engine.setConfig(CLAIM_CONFLICTS_MODE_KEY, 'propose');
      try {
        const dry = await claimConflictsCyclePhase(engine, true);
        expect(dry.status).toBe('ok');
        expect(await proposals(src)).toEqual([]);
        const report = await runCycle(engine, { brainDir: null, phases: ['claim_conflicts'] });
        const phase = report.phases.find(p => p.phase === 'claim_conflicts')!;
        expect(phase.status).toBe('ok');
        expect(Number(phase.details.proposals_written)).toBeGreaterThanOrEqual(1);
        expect(await proposals(src)).toHaveLength(1);
      } finally { await engine.executeRaw('DELETE FROM config WHERE key = $1', [CLAIM_CONFLICTS_MODE_KEY]); }
    });

    test('decide sweep --claims: no slot or key needed, --dry-run writes nothing, text and JSON give one verdict, an unknown or archived source is refused with nothing written', async () => {
      const src = await source();
      await fact(src, { value: 3, at: '2026-07-01T00:00:00Z' });
      await fact(src, { value: 4, at: '2026-07-03T00:00:00Z' });
      const dry = await capture(() => runSweepCommand(engine, ['--claims', '--source', src, '--dry-run', '--json']));
      expect(dry.result).toBe(0);
      const dryJson = JSON.parse(lastJson(dry.out));
      expect(dryJson).toMatchObject({ lane: 'claims', status: 'complete', dry_run: true, pairs_found: 1, proposals_written: 0 });
      expect(await proposals(src)).toEqual([]);
      const text = await capture(() => runSweepCommand(engine, ['--claims', '--source', src]));
      expect(text.result).toBe(0);
      expect(text.out).toContain(': complete (1 pair(s) found, 1 proposal(s) written');
      expect(text.out).toContain('Review: gbrain trust review --kind contradiction');
      expect(await proposals(src)).toHaveLength(1);
      const json = await capture(() => runSweepCommand(engine, ['--claims', '--source', src, '--json']));
      expect(JSON.parse(lastJson(json.out))).toMatchObject({ status: 'complete', pairs_found: 0 });

      const before = (await engine.executeRaw<{ n: number | string }>('SELECT COUNT(*) AS n FROM decide_proposals'))[0]!.n;
      const archived = await source();
      await fact(archived, { value: 5, at: '2026-07-01T00:00:00Z' });
      await fact(archived, { value: 6, at: '2026-07-02T00:00:00Z' });
      await engine.executeRaw('UPDATE sources SET archived = true WHERE id = $1', [archived]);
      for (const bad of ['no-such-source-example', archived]) {
        const refused = await capture(() => runSweepCommand(engine, ['--claims', '--source', bad, '--json']));
        expect(refused.result).not.toBe(0);
        expect(refused.out).toContain('unknown_source');
      }
      expect((await engine.executeRaw<{ n: number | string }>('SELECT COUNT(*) AS n FROM decide_proposals'))[0]!.n).toEqual(before);
    });

    test('trust review lists each pending pair as a contradiction, and every advertised command runs as printed', async () => withEnv({ GBRAIN_HOME: home }, async () => {
      const src = await source();
      const pair = async (entity: string, day: number) => {
        const old = await fact(src, { entity, value: 100, at: '2026-09-' + String(day).padStart(2, '0') + 'T08:00:00Z', tier: 'agent_written' });
        const neu = await fact(src, { entity, value: 120, at: '2026-09-' + String(day).padStart(2, '0') + 'T09:00:00Z', tier: 'agent_written' });
        return { old, neu };
      };
      const accept = await pair('companies/accept-example', 1);
      const forget = await pair('companies/forget-example', 2);
      const confirm = await pair('companies/confirm-example', 3);
      const drop = await pair('companies/drop-example', 4);
      await runClaimConflicts(engine, { sourceIds: [src] });
      const review = await buildTrustReview(engine, { sourceId: src, kind: 'contradiction' });
      expect(review.counts.contradiction).toBe(4);
      expect(renderTrustReview(review)).toContain('4 contradiction(s)');
      const item = (newId: number) => review.items.find(i => i.summary.startsWith('f' + newId + ' '))!;
      const it = item(accept.neu);
      expect(it).toMatchObject({ kind: 'contradiction', detail: 'claim_conflict', source_id: src, page: null });
      expect(it.summary).toContain('(mrr USD monthly: 120 vs 100)');
      expect(it.command_meta!.forget).toMatchObject({ consent: 'ask_user', durable: true });
      expect(it.command_meta!.supersede!.undo).toEqual(['gbrain', 'decide', 'proposals', 'undo', it.ref.slice(2)]);
      const run = async (argv: string[]) => {
        expect(argv[0]).toBe('gbrain');
        if (argv[1] === 'decide') return capture(() => runProposalsCommand(engine, argv.slice(3)));
        if (argv[1] === 'forget') return capture(() => runForget(engine, argv.slice(2)));
        if (argv[1] === 'trust') return capture(() => runTrustOwnerCommand(localTrustBackend(engine), argv[2]!, argv.slice(3)));
        throw new Error('unexpected argv ' + argv.join(' '));
      };
      const factState = async (id: number) => (await engine.executeRaw<R>('SELECT expired_at IS NOT NULL AS expired, superseded_by::int AS superseded_by, trust_tier FROM facts WHERE id = $1', [id]))[0]!;

      expect((await run(it.commands.supersede!)).result).toBe(0);
      expect(await factState(accept.old)).toMatchObject({ expired: true, superseded_by: accept.neu });
      expect((await run(it.command_meta!.supersede!.undo!)).result).toBe(0);
      expect(await factState(accept.old)).toMatchObject({ expired: false, superseded_by: null });

      await run(item(forget.neu).commands.forget!);
      expect(await factState(forget.neu)).toMatchObject({ expired: true });
      expect(await factState(forget.old)).toMatchObject({ expired: false });

      const confirmItem = item(confirm.neu);
      const ref = confirmItem.commands.confirm![3]!;
      const token = (await previewOwnerAction(engine, { action: 'confirm', ref })).token;
      const input = new PassThrough(); const output = new PassThrough();
      output.on('data', chunk => { if (String(chunk).includes('to confirm')) input.write(token + '\n'); });
      __setConfirmationIoForTests({ probe: { stdinIsTTY: true, stdoutIsTTY: true, env: { GBRAIN_INTERACTIVE: '1' } }, input, output, timeoutMs: 3000 });
      await run(confirmItem.commands.confirm!);
      __setConfirmationIoForTests(null);
      expect((await factState(confirm.neu)).trust_tier).toBe('user_confirmed');

      expect((await run(item(drop.neu).commands.drop!)).result).toBe(0);
      const after = await buildTrustReview(engine, { sourceId: src, kind: 'contradiction' });
      expect(after.items.map(i => i.summary.split(' ')[0])).toEqual(['f' + confirm.neu]);

      const all = await capture(() => runTrustOwnerCommand(localTrustBackend(engine), 'review', ['--accept-all', '--from', src, '--kind', 'contradiction', '--json']));
      const allJson = JSON.parse(lastJson(all.out));
      expect(allJson.accepted).toEqual([]);
      expect(allJson.skipped).toEqual([{ ref: after.items[0]!.ref, reason: 'contradiction', next: 'Decide it with one of its commands: gbrain trust review --kind contradiction' }]);
    }));

    test('recall labels a fact in a pending pair contested, only when the caller can read the other fact; a failed lookup degrades', async () => {
      const entity = 'companies/contested-example';
      const old = await fact('default', { entity, value: 10, at: '2026-10-01T08:00:00Z' });
      const neu = await fact('default', { entity, value: 12, at: '2026-10-01T09:00:00Z' });
      await runClaimConflicts(engine, { sourceIds: ['default'] });
      const [p] = await engine.executeRaw<{ id: number | string }>('SELECT id FROM decide_proposals WHERE new_fact_id = $1', [neu]);
      const recall = async (remote: boolean, extra: R = {}, eng: BrainEngine = engine) => {
        __resetPrivateVisibilityCacheForTests();
        return (await operationsByName.recall.handler(ctxOf(remote, eng), { entity, ...extra })) as R;
      };
      const local = await recall(false);
      const byId = (r: R, id: number) => r.facts.find((f: R) => f.id === id);
      expect(byId(local, neu).contested).toEqual({ proposal_ref: 'dp' + Number(p!.id), role: 'challenger', fact_id: String(old) });
      expect(byId(local, old).contested).toEqual({ proposal_ref: 'dp' + Number(p!.id), role: 'challenged', fact_id: String(neu) });
      expect(byId(local, neu)).toMatchObject({ claim_metric: 'mrr', claim_value: 12, claim_unit: 'USD', claim_period: 'monthly' });
      expect(byId(await recall(true), neu).contested).toBeDefined();

      await engine.executeRaw("INSERT INTO pages (slug, source_id, title, type, page_kind, compiled_truth, timeline, frontmatter) VALUES ('notes/private-example', 'default', 'Private', 'note', 'markdown', 'x', '', $1::text::jsonb)",
        [JSON.stringify({ visibility: 'private' })]);
      const hiddenPair = async (name: string, visible: Partial<F>, other: Partial<F>) => {
        const entity = 'companies/' + name + '-example';
        const shown = await fact('default', { entity, value: 1, at: '2026-10-02T09:00:00Z', ...visible });
        const hidden = await fact('default', { entity, value: 2, at: '2026-10-02T08:00:00Z', ...other });
        await engine.executeRaw("INSERT INTO decide_proposals (source_id, sweep_id, pair_index, new_fact_id, old_fact_id, p_supersede, proposal_floor) VALUES ('default', $1, 0, $2, $3, 1, 1)",
          ['conflict:test-' + randomUUID(), shown, hidden]);
        return async (remote: boolean, extra: R = {}) => byId(await recall(remote, { entity, ...extra }), shown)?.contested;
      };
      const privateRow = await hiddenPair('private-row', {}, { visibility: 'private' });
      expect(await privateRow(false)).toBeDefined();
      expect(await privateRow(true)).toBeUndefined();
      const privatePage = await hiddenPair('private-page', {}, { provenancePage: 'notes/private-example' });
      expect(await privatePage(false)).toBeDefined();
      expect(await privatePage(true)).toBeUndefined();
      const belowFloor = await hiddenPair('below-floor', { tier: 'user_confirmed' }, { tier: 'external_untrusted' });
      expect(await belowFloor(false)).toBeDefined();
      expect(await belowFloor(false, { min_trust: 'user_confirmed' })).toBeUndefined();
      const withdrawn = await hiddenPair('withdrawn', {}, { expired: true });
      expect(await withdrawn(false)).toBeUndefined();

      const failing = new Proxy(engine, { get(target, prop) {
        if (prop === 'executeRaw') return (sql: string, params?: unknown[]) => sql.includes('unnest($1::bigint[]) AS x(id)') ? Promise.reject(new Error('lookup failed')) : target.executeRaw(sql, params);
        const v = (target as unknown as R)[prop as string];
        return typeof v === 'function' ? v.bind(target) : v;
      } }) as BrainEngine;
      const degraded = await recall(false, {}, failing);
      expect(degraded.facts.length).toBeGreaterThan(0);
      expect(degraded.facts_degraded).toEqual({ reason: 'contested_unavailable' });
      expect(byId(degraded, neu).contested).toBeUndefined();
    });
  });
}
