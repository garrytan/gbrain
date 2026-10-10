/**
 * Real PGLite + SQLite path for Hermes maintenance: the registered CLI identity
 * is verified by the resident owner, import writes through that same engine,
 * and the report's source-scoped readback observes the committed page.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { buildHermesFixture } from './fixtures/transcripts/hermes-fixture-builder.ts';
import { registerLocalWriter, revokeLocalWriter } from '../src/core/persistence/identity.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import { startDelegatedHermesMaintenance, getDelegatedHermesMaintenanceStatus, shutdownDelegatedHermesMaintenance } from '../src/core/serve-hermes-runner.ts';

const root = mkdtempSync(join(tmpdir(), 'gbrain-hermes-maintenance-integration-'));
const home = join(root, 'home');
const databasePath = join(root, 'brain-db');
const sourceId = `hermes-integ-${randomUUID().slice(0, 10)}`;
let engine: PGLiteEngine;
let competitor: PGLiteEngine;
let registration: Awaited<ReturnType<typeof registerLocalWriter>>;
let stateDb: string;

beforeAll(async () => {
  mkdirSync(home, { recursive: true });
  await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    engine = new PGLiteEngine();
    competitor = new PGLiteEngine();
    await engine.connect({ database_path: databasePath });
    await engine.initSchema();
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    registration = await registerLocalWriter(engine, 'cli');
  });
  stateDb = buildHermesFixture(root);
}, 120_000);

afterAll(async () => {
  __setChatTransportForTests(null);
  resetGateway();
  if (competitor) await competitor.disconnect().catch(() => {});
  if (engine) {
    await shutdownDelegatedHermesMaintenance(engine);
    await engine.disconnect();
  }
  rmSync(root, { recursive: true, force: true });
});

test('resident owner claims the real registration, imports into its live engine, and reads the source back', async () => {
  await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    const options = { stateDb, sourceId, limit: 10, windowSeconds: 20 };
    const first = await startDelegatedHermesMaintenance(engine, options, 'synthetic-import-intent', registration, sourceId);
    expect(first).toMatchObject({ ok: true, protocol: 2 });
    const retry = await startDelegatedHermesMaintenance(engine, options, 'synthetic-import-intent', registration, sourceId);
    expect(retry.jobId).toBe(first.jobId);
    let status = getDelegatedHermesMaintenanceStatus(engine, first.jobId!, sourceId);
    for (let i = 0; i < 200 && status.state === 'running'; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      status = getDelegatedHermesMaintenanceStatus(engine, first.jobId!, sourceId);
    }
    expect(status).toMatchObject({ ok: true, state: 'done', report: { status: 'ok', source_id: sourceId,
      validation: { checked: 2, missing: [] }, ingest: { sessionsSeen: 2, sessionsImported: 2 } } });
    const slugs = status.report?.ingest?.slugsTouched ?? [];
    expect(slugs).toHaveLength(2);
    for (const slug of slugs) expect(await engine.getPage(slug, { sourceId })).toBeTruthy();
    const rows = await engine.executeRaw<{ slug: string; source_id: string }>(
      "SELECT slug,source_id FROM pages WHERE source_id=$1 AND slug LIKE 'conversations/sessions/%' ORDER BY slug", [sourceId]);
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.source_id === sourceId)).toBe(true);
  });
}, 60_000);

test('an exact but empty Hermes selection remains non-success and performs no new source writes', async () => {
  await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    const before = await engine.executeRaw<{ count: number }>(
      'SELECT count(*)::int AS count FROM pages WHERE source_id=$1', [sourceId]);
    const start = await startDelegatedHermesMaintenance(engine,
      { stateDb, sourceId, sessionSources: ['source-that-does-not-exist'], windowSeconds: 20 },
      'empty-selection-intent', registration, sourceId);
    expect(start.ok).toBe(true);
    let status = getDelegatedHermesMaintenanceStatus(engine, start.jobId!, sourceId);
    for (let i = 0; i < 200 && status.state === 'running'; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      status = getDelegatedHermesMaintenanceStatus(engine, start.jobId!, sourceId);
    }
    expect(status).toMatchObject({ state: 'done', report: { status: 'partial', reasons: expect.arrayContaining(['no_sessions']) } });
    expect(await engine.executeRaw('SELECT count(*)::int AS count FROM pages WHERE source_id=$1', [sourceId])).toEqual(before);
  });
});

test('unchanged real Hermes import drains an existing facts job and validates the PGLite write', async () => {
  await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
    ANTHROPIC_API_KEY: 'synthetic-test-key', OPENAI_API_KEY: undefined }, async () => {
    // Establish the prior import in this test too, so a focused run is independent.
    const imported = await startDelegatedHermesMaintenance(engine,
      { stateDb, sourceId, windowSeconds: 120 }, 'backlog-prior-import', registration, sourceId);
    expect(imported.ok).toBe(true);
    let prior = getDelegatedHermesMaintenanceStatus(engine, imported.jobId!, sourceId);
    for (let i = 0; i < 1000 && prior.state === 'running'; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      prior = getDelegatedHermesMaintenanceStatus(engine, imported.jobId!, sourceId);
    }
    expect(prior).toMatchObject({ state: 'done', report: { status: 'ok', validation: { checked: 2, missing: [] } } });
    const slug = 'notes/hermes-nightly-drain-fixture';
    await engine.putPage(slug, { type: 'note', title: 'Hermes nightly drain fixture',
      compiled_truth: `This synthetic page contains a durable project fact: the Hermes nightly runner drained a queued extraction task in 2026. ${'The integration fixture holds enough substantive text to exercise extraction and persistence. '.repeat(5)}`,
      timeline: '', frontmatter: {} } as never, { sourceId });
    expect(await engine.getPage(slug, { sourceId })).toBeTruthy();
    await engine.setConfig('facts.extraction_model', 'anthropic:claude-sonnet-4-6');
    await engine.setConfig('embedding_disabled', 'true');
    configureGateway({ embedding_disabled: true, env: { ANTHROPIC_API_KEY: 'synthetic-test-key' } } as never);
    __setChatTransportForTests(async (_opts: ChatOpts) => {
      const text = JSON.stringify({ facts: [{ fact: 'Synthetic fixture confirms a nightly facts drain in 2026.',
        kind: 'fact', entity: 'companies/hermes-nightly-fixture', confidence: 0.9, notability: 'high',
        metric: null, value: null, unit: null, period: null }] });
      return { text, blocks: [{ type: 'text', text }], stopReason: 'end', model: 'claude-sonnet-4-6', providerId: 'anthropic',
        usage: { input_tokens: 10, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 } } as ChatResult;
    });
    await new MinionQueue(engine).add('facts-absorb', { slug, sourceId, source: 'synthetic-maintenance-test',
      notabilityFilter: 'all', visibility: 'private' },
    { queue: 'default', idempotency_key: `facts-absorb:maintenance:${sourceId}:${slug}`, max_attempts: 3 });

    const start = await startDelegatedHermesMaintenance(engine,
      { stateDb, sourceId, enrich: true, windowSeconds: 120 }, 'synthetic-backlog-drain-intent', registration, sourceId);
    expect(start).toMatchObject({ ok: true });
    let status = getDelegatedHermesMaintenanceStatus(engine, start.jobId!, sourceId);
    for (let i = 0; i < 1000 && status.state === 'running'; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      status = getDelegatedHermesMaintenanceStatus(engine, start.jobId!, sourceId);
    }
    expect(status.state).toBe('done');
    expect(status.report).toMatchObject({ status: 'partial', reasons: expect.arrayContaining(['synthesis_not_configured']),
      validation: { checked: 2, missing: [] }, ingest: { sessionsSeen: 2, pages: { imported: 0 }, slugsTouched: expect.any(Array) },
      cycle: { phases: [expect.objectContaining({ phase: 'facts_drain', status: 'ok' })] } });
    expect(status.report?.cycle?.phases.some(phase => phase.phase === 'synthesize')).toBe(false);
    const jobs = await engine.executeRaw<{ status: string }>(
      "SELECT status FROM minion_jobs WHERE name='facts-absorb' AND data->>'slug'=$1", [slug]);
    expect(jobs).toEqual([{ status: 'completed' }]);
    const facts = await engine.executeRaw<{ fact: string; source_id: string }>(
      "SELECT fact,source_id FROM facts WHERE fact LIKE 'Synthetic fixture confirms a nightly facts drain%'", []);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.fact).toContain('Synthetic fixture confirms');
  });
}, 60_000);

test('fresh Hermes import synthesizes and drains without relaxing derived-extraction policy', async () => {
  const brainDir = join(root, 'classic-brain');
  mkdirSync(join(brainDir, 'skills'), { recursive: true });
  copyFileSync(join(import.meta.dir, '../skills/_brain-filing-rules.json'), join(brainDir, 'skills/_brain-filing-rules.json'));
  // This fixture must not discover the agent home (or its ownership receipt) as a Git root.
  const gitCeiling = root;
  const gitProbe = Bun.spawnSync(['git', '-C', brainDir, 'rev-parse', '--show-toplevel'], {
    env: { ...process.env, GIT_CEILING_DIRECTORIES: gitCeiling }, stdout: 'pipe', stderr: 'pipe',
  });
  expect(gitProbe.exitCode).not.toBe(0);

  const pipelineSource = `hermes-fresh-${randomUUID().slice(0, 10)}`;
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [pipelineSource]);
  const freshDir = join(root, 'fresh-hermes');
  mkdirSync(freshDir, { recursive: true });
  const freshDb = buildHermesFixture(freshDir);
  // Public AWS documentation example, constructed only as a synthetic redaction fixture.
  const plantedSecret = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
  const fixtureDb = new Database(freshDb);
  try {
    fixtureDb.query(`UPDATE messages SET content=? WHERE session_id='hermes-fixture-1' AND role='user'`).run(
      `We selected the August 2026 launch window for acme-seed. The deploy key is ${plantedSecret} keep it safe.`);
  } finally { fixtureDb.close(); }
  let synthesisSlug = '';
  const extractionClaim = 'acme-seed selected the August 2026 launch window.';
  const transportCalls: string[] = [];

  await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
    ANTHROPIC_API_KEY: 'scripted-local-only', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/v1',
    OPENAI_API_KEY: undefined, GIT_CEILING_DIRECTORIES: gitCeiling }, async () => {
    await engine.setConfig('facts.extraction_enabled', 'true');
    await engine.setConfig('facts.extraction_model', 'anthropic:claude-sonnet-4-6');
    await engine.setConfig('dream.synthesize.enabled', 'true');
    await engine.setConfig('dream.synthesize.conversation_pages', 'true');
    await engine.setConfig('dream.synthesize.mode', 'oneshot');
    await engine.setConfig('dream.synthesize.min_chars', '0');
    await engine.setConfig('dream.synthesize.cooldown_hours', '0');
    await engine.setConfig('dream.synthesize.quote_verify', 'false');
    await engine.setConfig('dream.synthesize.link_manifest', 'false');
    await engine.setConfig('dream.triage.max_ms', '0');
    await engine.setConfig('dream.triage.threshold', '0');
    await engine.setConfig('embedding_disabled', 'true');
    configureGateway({ embedding_disabled: true, env: { ANTHROPIC_API_KEY: 'scripted-local-only',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/v1' } } as never);
    __setChatTransportForTests(async (opts: ChatOpts) => {
      const material = `${String(opts.system ?? '')}\n${opts.messages.map(message =>
        typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n')}`;
      transportCalls.push(`${opts.model ?? 'unknown'}:${material.slice(0, 100)}`);
      let text: string;
      if (String(opts.system ?? '').startsWith('You triage a conversation transcript')) {
        text = JSON.stringify({ score: 0.99, content_type: 'decision', segments: [], entities: ['acme-seed'], reasons: ['concrete decision'] });
      } else if (!String(opts.system ?? '').startsWith('You are a knowledge-synthesis engine.') && /extract.*facts|facts.*extract/i.test(material)) {
        // Only the decision page carries this exact dated claim; the reflection does not.
        const datedDecision = material.includes('The team selected the August 2026 launch window');
        text = JSON.stringify({ facts: datedDecision ? [{ fact: extractionClaim, kind: 'fact', entity: 'companies/acme-seed', confidence: 0.95,
          notability: 'high', metric: null, value: null, unit: null, period: null }] : [] });
      } else {
        expect(String(opts.system ?? '')).toStartWith('You are a knowledge-synthesis engine.');
        const suffix = material.match(/Transcript hash suffix \(USE THIS in slugs\): ([0-9a-f]{6})/)?.[1];
        expect(suffix).toBeTruthy();
        synthesisSlug = `wiki/originals/ideas/2026-08-05-launch-window-${suffix}`;
        const reflectionSlug = `wiki/personal/reflections/2026-08-05-launch-window-${suffix}`;
        text = JSON.stringify({ pages: [
          { slug: synthesisSlug, title: 'Launch window decision', type: 'note', body: `The team selected the August 2026 launch window for acme-seed. The decision appears in the imported conversation. See [[${reflectionSlug}]] for a related note.` },
          { slug: reflectionSlug, title: 'Launch planning reflection', type: 'note', body: `A launch window was selected for acme-seed. This choice is recorded in the imported conversation. See [[${synthesisSlug}]] for the decision.` },
        ], skipped: false, skip_reason: null });
      }
      return { text, blocks: [{ type: 'text', text }], stopReason: 'end', model: String(opts.model ?? 'synthetic'), providerId: 'anthropic',
        usage: { input_tokens: 10, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 } } as ChatResult;
    });

    const runOwned = async (options: { enrich: boolean }, intent: string) => {
      const start = await startDelegatedHermesMaintenance(engine,
        { stateDb: freshDb, sourceId: pipelineSource, brainDir, enrich: options.enrich, sessionSources: ['cli'], windowSeconds: 600 },
        intent, registration, pipelineSource);
      expect(start).toMatchObject({ ok: true });
      let status = getDelegatedHermesMaintenanceStatus(engine, start.jobId!, pipelineSource);
      for (let i = 0; i < 1000 && status.state === 'running'; i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
        status = getDelegatedHermesMaintenanceStatus(engine, start.jobId!, pipelineSource);
      }
      expect(status.state).toBe('done');
      return status.report!;
    };
    const first = await runOwned({ enrich: false }, 'fresh-import-only');
    expect(first.status).toBe('ok');
    expect(first.ingest?.pages.imported).toBeGreaterThan(0);
    expect(first.ingest?.redactions).toBeGreaterThan(0);
    expect(first.cycle).toBeNull();
    expect(transportCalls).toHaveLength(0);

    const second = await runOwned({ enrich: true }, 'fresh-import-enrich-retry');
    expect(['ok', 'partial']).toContain(second.status);
    expect(second.ingest?.pages.imported).toBe(0);
    const synthPhase = second.cycle?.phases.find(phase => phase.phase === 'synthesize');
    expect(synthPhase?.status, JSON.stringify({ synthPhase, transportCalls, children: await engine.executeRaw("SELECT status,error_text,result FROM minion_jobs WHERE name='subagent'") })).toBe('ok');
    expect(second.reasons.every(reason => reason === 'no_matching_input'), JSON.stringify({ second, jobs: await engine.executeRaw("SELECT data,result,error_text,status FROM minion_jobs WHERE name='facts-absorb'"), transportCalls })).toBe(true);
    expect(second.cycle?.phases.map(phase => phase.phase)).toContain('facts_drain');
    expect(transportCalls.length).toBeGreaterThan(0);

    const imported = await engine.executeRaw<{ slug: string; source_uri: string | null; content: string }>(
      `SELECT p.slug, p.source_uri AS source_uri, p.compiled_truth AS content
         FROM pages p WHERE p.source_id=$1 AND p.type='conversation' AND p.deleted_at IS NULL`, [pipelineSource]);
    expect(imported.length).toBeGreaterThan(0);
    expect(imported.every(row => row.source_uri === freshDb)).toBe(true);
    expect(imported.some(row => row.content.includes('TOOL-ONLY-TEXT'))).toBe(false);
    expect(imported.every(row => !row.content.includes(plantedSecret))).toBe(true);
    const synthesized = await engine.getPage(synthesisSlug, { sourceId: pipelineSource });
    expect(synthesized).toBeTruthy();
    expect(synthesized?.compiled_truth).toContain('August 2026 launch window');
    // Synthesis jobs must finish; confined/dream-generated pages must NOT acquire
    // source-wide facts authority merely to make a nightly test insert a claim.
    const generatedJobs = await engine.executeRaw<{ id: number; status: string }>(
      "SELECT id,status FROM minion_jobs WHERE name='subagent' AND data->>'source_id'=$1 ORDER BY id", [pipelineSource]);
    expect(generatedJobs.length).toBeGreaterThan(0);
    expect(generatedJobs.every(job => job.status === 'completed')).toBe(true);
    const receipts = await engine.executeRaw<{ state: string; principal_kind: string; principal_id: string }>(
      "SELECT state,principal_kind,principal_id FROM persistence_requests WHERE source_id=$1 AND slug=$2 AND authority->'localSubagent' IS NOT NULL", [pipelineSource, synthesisSlug]);
    expect(receipts.length).toBeGreaterThan(0);
    expect(receipts.every(row => row.state === 'committed' && row.principal_kind === 'local_cli' && row.principal_id === registration.id)).toBe(true);
    expect(synthesized?.frontmatter.dream_generated).toBe(true);
    const stranded = await engine.executeRaw<{ count: number }>(
      "SELECT count(*)::int AS count FROM minion_jobs WHERE COALESCE(data->>'source_id',data->>'sourceId')=$1 AND status IN ('waiting','delayed','active','waiting-children','paused')", [pipelineSource]);
    expect(stranded[0]?.count).toBe(0);
    expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='facts-absorb' AND data->>'sourceId'=$1", [pipelineSource])).toHaveLength(0);
    expect(await engine.executeRaw('SELECT fact FROM facts WHERE fact=$1 AND source_id=$2', [extractionClaim, pipelineSource])).toHaveLength(0);
    expect(second.cycle?.phases.find(phase => phase.phase === 'facts_drain')?.details.remaining_after).toBe(0);

    const firstJobIds = generatedJobs.map(job => job.id);
    const callsBeforeRerun = transportCalls.length;
    const rerun = await runOwned({ enrich: true }, 'fresh-import-idempotent-rerun');
    expect(['ok', 'partial']).toContain(rerun.status);
    expect(rerun.reasons.every(reason => reason === 'no_matching_input')).toBe(true);
    expect(rerun.ingest?.pages.imported).toBe(0);
    expect(rerun.cycle?.phases.map(phase => phase.phase)).toContain('synthesize');
    expect(transportCalls.length).toBe(callsBeforeRerun);
    const afterRerun = await engine.executeRaw<{ id: number; status: string }>(
      `SELECT id, status FROM minion_jobs WHERE name='subagent' AND data->>'source_id'=$1 ORDER BY id`, [pipelineSource]);
    expect(afterRerun.map(job => job.id)).toEqual(firstJobIds);
    expect(afterRerun.every(job => job.status === 'completed')).toBe(true);
    expect(await engine.executeRaw('SELECT fact FROM facts WHERE fact=$1 AND source_id=$2', [extractionClaim, pipelineSource])).toHaveLength(0);
    expect(second.duration_ms).toBeLessThan(600_000);
    expect(rerun.duration_ms).toBeLessThan(600_000);
  });
}, 60_000);

test('a second PGLite engine cannot compete with the resident owner on its datastore', async () => {
  await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    try {
      await expect(competitor.connect({ database_path: databasePath })).rejects.toThrow();
    } finally {
      try { await competitor.disconnect(); } catch { /* failed opens have no connection to release */ }
    }
  });
}, 60_000);

test('revoked native registration is refused before touching the imported source', async () => {
  await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    const before = await engine.executeRaw<{ count: number }>(
      'SELECT count(*)::int AS count FROM pages WHERE source_id=$1', [sourceId]);
    expect(await revokeLocalWriter(engine, registration.id)).toBe(true);
    const result = await startDelegatedHermesMaintenance(engine, { stateDb, sourceId }, 'revoked-intent', registration, sourceId);
    expect(result).toMatchObject({ ok: false, protocol: 2, error: 'permission_denied' });
    const after = await engine.executeRaw<{ count: number }>(
      'SELECT count(*)::int AS count FROM pages WHERE source_id=$1', [sourceId]);
    expect(after).toEqual(before);
  });
});
