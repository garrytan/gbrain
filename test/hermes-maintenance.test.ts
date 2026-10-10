import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHermesMaintenance, type HermesMaintenanceDependencies } from '../src/core/hermes-maintenance.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import type { TranscriptsIngestResult } from '../src/core/transcripts/ingest.ts';
import type { CycleReport } from '../src/core/cycle.ts';
import type { VerifiedLocalWriter } from '../src/core/persistence/identity.ts';
import { parseHermesMaintenanceArgs } from '../src/cli/commands/hermes.ts';

function cycleReport(status: CycleReport['status'], phases: CycleReport['phases'], reason?: string): CycleReport {
  return { schema_version: '1', timestamp: new Date().toISOString(), duration_ms: 1, status, phases, brain_dir: null,
    totals: { lint_fixes: 0, backlinks_added: 0, pages_synced: 0, pages_extracted: 0, pages_embedded: 0,
      orphans_found: 0, transcripts_processed: 0, synth_pages_written: 0, patterns_written: 0,
      pages_emotional_weight_recomputed: 0, edges_resolved: 0, edges_ambiguous: 0,
      purged_sources_count: 0, purged_pages_count: 0, facts_consolidated: 0, consolidate_takes_written: 0,
      phantoms_redirected: 0, phantoms_ambiguous: 0, phantoms_skipped_drift: 0 }, ...(reason ? { reason } : {}) };
}

function fixture() {
  const pages = new Map<string, { source: string }>();
  const configs = new Map<string, string>();
  const calls: Array<{ kind: string; engine: BrainEngine; options: any }> = [];
  const engine = {
    getConfig: async (key: string) => configs.get(key) ?? null,
    getPage: async (slug: string, opts: { sourceId: string }) => {
      const page = pages.get(slug);
      return page?.source === opts.sourceId ? page : null;
    },
  } as unknown as BrainEngine;
  const context = { remote: false, engine } as OperationContext;
  const result = {
    cleanScan: true, sessionsSeen: 1, sessionsImported: 1, slugsTouched: ['conversations/sessions/example'],
    pages: { imported: 1, skipped: 0, errored: 0, planned: 0 },
  } as TranscriptsIngestResult;
  let cycleStatus: CycleReport['status'] = 'ok';
  const dependencies: HermesMaintenanceDependencies = {
    currentVerifiedLocalWriter: () => undefined,
    ingest: async (eng, opts) => {
      calls.push({ kind: 'ingest', engine: eng, options: opts });
      for (const slug of result.slugsTouched) pages.set(slug, { source: opts.sourceId });
      return result;
    },
    cycle: async (eng, opts) => {
      calls.push({ kind: 'cycle', engine: eng, options: opts });
      return cycleReport(cycleStatus, [{ phase: 'facts_drain', status: 'ok', duration_ms: 1, summary: 'drained', details: { backlog_after: 0 } }]);
    },
  };
  const options = { stateDb: '/synthetic/state.db', sourceId: 'example-source', context };
  return { engine, context, pages, configs, calls, result, dependencies, options,
    setCycleStatus: (status: CycleReport['status']) => { cycleStatus = status; } };
}

test('explicit import defaults to no paid cycle and validates exact source on the same engine', async () => {
  const f = fixture();
  const report = await runHermesMaintenance(f.engine, f.options, f.dependencies);
  assert.equal(report.status, 'ok');
  assert.equal(report.validation.checked, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].engine, f.engine);
  assert.equal(f.calls[0].options.context, f.context);
  assert.equal(f.calls[0].options.embed, false);
  assert.equal(f.calls[0].options.limit, 100);
  assert.deepEqual(report.validation.missing, []);
});

test('enrichment uses configured synthesis and bounded shared cycle without changing config', async () => {
  const f = fixture();
  f.configs.set('dream.synthesize.enabled', 'true');
  f.configs.set('dream.synthesize.conversation_pages', 'true');
  const original = [...f.configs];
  const report = await runHermesMaintenance(f.engine, { ...f.options, enrich: true, brainDir: '/synthetic/brain' }, f.dependencies);
  assert.equal(report.status, 'ok');
  const call = f.calls[1];
  assert.equal(call.engine, f.engine);
  assert.deepEqual(call.options.phases, ['synthesize', 'facts_drain']);
  assert.equal(call.options.sourceId, 'example-source');
  assert.equal(call.options.pull, false);
  assert.ok(call.options.deadlineAtMs > Date.now());
  assert.ok(call.options.signal instanceof AbortSignal);
  assert.deepEqual([...f.configs], original);
});

test('unconfigured synthesis is a disclosed partial run; no consent config is written', async () => {
  const f = fixture();
  const report = await runHermesMaintenance(f.engine, { ...f.options, enrich: true }, f.dependencies);
  assert.equal(report.status, 'partial');
  assert.ok(report.reasons.includes('synthesis_not_configured'));
  assert.deepEqual(f.calls[1].options.phases, ['facts_drain']);
  assert.equal(f.configs.size, 0);
});

test('incomplete import prevents enrichment and retains the imported page for validation', async () => {
  const f = fixture();
  f.result.cleanScan = false;
  const report = await runHermesMaintenance(f.engine, { ...f.options, enrich: true }, f.dependencies);
  assert.equal(report.status, 'partial');
  assert.ok(report.reasons.includes('ingest_incomplete'));
  assert.equal(f.calls.length, 1);
  assert.equal(report.validation.checked, 1);
  assert.equal(f.pages.size, 1);
});

test('an empty store cannot become a successful zero-input nightly receipt', async () => {
  const f = fixture();
  f.result.sessionsSeen = 0;
  f.result.slugsTouched = [];
  const report = await runHermesMaintenance(f.engine, { ...f.options, enrich: true }, f.dependencies);
  assert.equal(report.status, 'partial');
  assert.ok(report.reasons.includes('no_sessions'));
  assert.equal(f.calls.length, 1);
});

test('cycle lock skip and remaining jobs are incomplete receipts', async () => {
  const f = fixture();
  f.setCycleStatus('skipped');
  f.dependencies.cycle = async () => cycleReport('skipped', [
    { phase: 'facts_drain', status: 'warn', duration_ms: 1, summary: 'backlog remains', details: { backlog_after: 3 } },
  ], 'cycle_already_running');
  const report = await runHermesMaintenance(f.engine, { ...f.options, enrich: true }, f.dependencies);
  assert.equal(report.status, 'partial');
  assert.ok(report.reasons.includes('cycle_already_running'));
  assert.ok(report.reasons.includes('enrichment_incomplete'));
});

test('bounded drain backlog resumes only on an explicit next invocation without resetting caller caps', async () => {
  const f = fixture();
  f.configs.set('dream.synthesize.enabled', 'true');
  f.configs.set('dream.synthesize.conversation_pages', 'true');
  f.dependencies.cycle = async (engine, cycleOptions) => {
    assert.equal(engine, f.engine);
    f.calls.push({ kind: 'cycle', engine, options: cycleOptions });
    return cycleReport('partial', [
      { phase: 'facts_drain', status: 'warn', duration_ms: 1, summary: 'budget reached', details: { backlog_after: 2 } },
    ]);
  };
  const options = { ...f.options, enrich: true, brainDir: '/synthetic/brain', windowSeconds: 45, limit: 7 };
  const first = await runHermesMaintenance(f.engine, options, f.dependencies);
  const second = await runHermesMaintenance(f.engine, options, f.dependencies);
  assert.equal(first.status, 'partial');
  assert.equal(second.status, 'partial');
  const cycles = f.calls.filter(call => call.kind === 'cycle');
  assert.equal(cycles.length, 2); // One bounded existing cycle per explicit request; never an internal unbounded loop.
  for (const call of cycles) {
    assert.ok(call.options.deadlineAtMs - Date.now() <= 45_000);
    assert.ok(call.options.deadlineAtMs > Date.now());
  }
  const imports = f.calls.filter(call => call.kind === 'ingest');
  assert.equal(imports.length, 2);
  assert.deepEqual(imports.map(call => [call.options.limit, call.options.signal instanceof AbortSignal]), [[7, true], [7, true]]);
});

test('abort and wrong-engine context start no import or provider work', async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort(new Error('operator cancelled'));
  const report = await runHermesMaintenance(f.engine, { ...f.options, signal: controller.signal }, f.dependencies);
  assert.equal(report.status, 'failed');
  assert.equal(f.calls.length, 0);
  await assert.rejects(runHermesMaintenance(f.engine, { ...f.options, context: { remote: false, engine: {} } as OperationContext }, f.dependencies), /same engine/);
});

test('a disabled facts drain is reported as skipped enrichment', async () => {
  const f = fixture();
  f.dependencies.cycle = async () => cycleReport('clean', [
    { phase: 'facts_drain', status: 'skipped', duration_ms: 1, summary: 'disabled', details: { reason: 'disabled' } },
  ]);
  const report = await runHermesMaintenance(f.engine, { ...f.options, enrich: true }, f.dependencies);
  assert.equal(report.status, 'partial');
  assert.ok(report.reasons.includes('enrichment_skipped'));
});

test('readback missing in the destination source fails validation', async () => {
  const f = fixture();
  f.dependencies.ingest = async () => f.result;
  const report = await runHermesMaintenance(f.engine, f.options, f.dependencies);
  assert.equal(report.status, 'failed');
  assert.deepEqual(report.validation.missing, f.result.slugsTouched);
});

test('maintenance flags separate destination, session origin and turn cutoff without opting into spend', () => {
  const parsed = parseHermesMaintenanceArgs([
    '--state-db', '/tmp/example-hermes/state.db', '--source', 'example-source',
    '--session-source', 'telegram', '--session-source', 'slack',
    '--messages-since', '2026-10-01T01:00:00+01:00', '--limit', '50', '--window', '120', '--json',
  ]);
  assert.equal(parsed.source, 'example-source');
  assert.deepEqual(parsed.sessionSources, ['telegram', 'slack']);
  assert.equal(parsed.messagesSinceIso, '2026-10-01T00:00:00.000Z');
  assert.equal(parsed.enrich, false);
  assert.equal(parsed.limit, 50);
  assert.equal(parsed.windowSeconds, 120);
  assert.equal(parsed.json, true);
});

test('invalid maintenance flags fail before opening an engine', () => {
  for (const args of [['--window', '0'], ['--limit', '1.5'], ['--source'], ['--enrich', '--surprise'], ['--since', 'garbage']]) {
    assert.throws(() => parseHermesMaintenanceArgs(args));
  }
});

test('source-limited enrichment refuses before import or brain-wide cycle', async () => {
  for (const grant of [
    { allowedSources: ['example-source'], sourceId: 'example-source' },
    { allowedSources: [] },
    { sourceId: 'example-source' },
    { boundSourceId: 'example-source' },
    { sourceId: 'default', hasSourceGrant: false },
    {},
    { sourceId: 'example-source', allowedSources: ['*'] }, // A fabricated read list grants no writer authority.
  ]) {
    const f = fixture();
    f.context.auth = { token: '', clientId: 'synthetic-cli', scopes: ['read', 'write'], ...grant };
    await assert.rejects(runHermesMaintenance(f.engine, { ...f.options, enrich: true }, f.dependencies), /verified unrestricted local CLI writer grant/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.pages.size, 0);
  }
});

test('source-limited import-only preserves its exact destination and authenticated context', async () => {
  const f = fixture();
  f.context.auth = { token: '', clientId: 'synthetic-cli', scopes: ['read', 'write'], sourceId: 'example-source', allowedSources: ['example-source'] };
  const report = await runHermesMaintenance(f.engine, f.options, f.dependencies);
  assert.equal(report.status, 'ok');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.sourceId, 'example-source');
  assert.equal(f.calls[0].options.context, f.context);
  assert.equal(report.validation.checked, 1);
});

test('verified unrestricted CLI writer authority may enrich the selected destination', async () => {
  const f = fixture();
  f.context.auth = { token: '', clientId: 'synthetic-cli', scopes: ['read', 'write'], sourceId: 'example-source' };
  f.dependencies.currentVerifiedLocalWriter = () => ({
    principal: { kind: 'local_cli', id: 'synthetic-cli' }, remote: false,
    grant: { sourceIds: ['*'], scopes: ['read', 'write'], operations: null, slugPrefixes: null },
  });
  const report = await runHermesMaintenance(f.engine, { ...f.options, enrich: true }, f.dependencies);
  assert.equal(report.status, 'partial');
  assert.equal(f.calls[0].kind, 'ingest');
  assert.equal(f.calls[0].options.sourceId, 'example-source');
  assert.equal(f.calls[1].kind, 'cycle');
});

test('verified writer scope narrowing and non-CLI authority refuse before import', async () => {
  const full: VerifiedLocalWriter = { principal: { kind: 'local_cli', id: 'synthetic-cli' }, remote: false,
    grant: { sourceIds: ['*'], scopes: ['read', 'write'], operations: null, slugPrefixes: null } };
  for (const writer of [
    { ...full, remote: true },
    { ...full, principal: { kind: 'local_stdio' as const, id: 'synthetic-cli' } },
    { ...full, principal: { kind: 'local_cli' as const, id: 'different-cli' } },
    { ...full, grant: { ...full.grant, sourceIds: ['example-source'] } },
    { ...full, grant: { ...full.grant, scopes: ['read'] } },
    { ...full, grant: { ...full.grant, scopes: ['write'] } },
    { ...full, grant: { ...full.grant, operations: ['capture'] } },
    { ...full, grant: { ...full.grant, slugPrefixes: ['conversations/'] } },
  ]) {
    const f = fixture();
    f.context.auth = { token: '', clientId: 'synthetic-cli', scopes: ['read', 'write'], sourceId: 'example-source' };
    f.dependencies.currentVerifiedLocalWriter = () => writer;
    await assert.rejects(runHermesMaintenance(f.engine, { ...f.options, enrich: true }, f.dependencies), /verified unrestricted local CLI writer grant/);
    assert.equal(f.calls.length, 0);
  }
});
