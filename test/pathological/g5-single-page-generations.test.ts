/**
 * GBRA-161 PR 5 (S-2, S-10, S-11): the dream summary, the think synthesis page and the drift report are single-item page
 * generations. Each writer binds its write to the page revision it read before composing, so a page that changed while it
 * composed is fenced and keeps its content; each overwrite is versioned (page_versions, the ledger preimage) and
 * restorable through gbrain repair generations. Real writers on PGLite and Postgres; model calls are the existing stubs.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureCorpusSpoolDir, sessionCorpusFileName } from '../../src/core/context/corpus-segments.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runThink, persistSynthesis, type ThinkLLMClient } from '../../src/core/think/index.ts';
import { runPhaseDrift } from '../../src/core/cycle/drift.ts';
import { runPhaseSynthesize } from '../../src/core/cycle/synthesize.ts';
import { resolveCycleDate } from '../../src/core/cycle/cycle-date.ts';
import { _resetBudgetMeterWarningsForTest } from '../../src/core/cycle/budget-meter.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../../src/core/ai/gateway.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { resolveRepairScope } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { pathologicalArms } from './harness.ts';

/** The slug persistSynthesis saves a question's answer under (synthesis/<slugified question>-<date>). */
const synthesisSlug = (q: string, today: string) => `synthesis/${q.toLowerCase().replace(/[^a-z0-9\s]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'untitled'}-${today}`;
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const codeOf = (error: unknown) => error instanceof OperationError ? error.code : String(error);

async function withBrain(databaseUrl: string | undefined, run: (engine: BrainEngine, dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-g5-'));
  try {
    await withEnv({ GBRAIN_HOME: join(dir, 'home'), DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, ANTHROPIC_API_KEY: 'sk-test-g5' }, async () => {
      _resetWriteThroughCacheForTest();
      _resetBudgetMeterWarningsForTest();
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try { await run(engine, dir); } finally { __setChatTransportForTests(null); resetGateway(); await close(); }
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const body = async (engine: BrainEngine, slug: string, sourceId = 'default') => (await engine.executeRaw<{ compiled_truth: string }>(
  'SELECT compiled_truth FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, slug]))[0]?.compiled_truth ?? null;
const versions = async (engine: BrainEngine, slug: string, sourceId = 'default') => (await engine.executeRaw<{ compiled_truth: string }>(
  'SELECT v.compiled_truth FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1 AND p.slug=$2 ORDER BY v.id', [sourceId, slug])).map(r => r.compiled_truth);
const handEdit = (engine: BrainEngine, slug: string, text: string, sourceId = 'default') =>
  engine.putPage(slug, { type: 'note', title: 'Edited by hand', compiled_truth: text }, { sourceId });

/** Previews and applies gbrain repair generations --mode restore for one kind; returns the applied outcome items. */
async function restore(engine: BrainEngine, kind: string, sourceId = 'default') {
  const scope = await resolveRepairScope(engine, sourceId);
  const generations = { kind, mode: 'restore' as const, since: new Date(Date.now() - 86_400_000).toISOString() };
  const preview = await (await repairRunner(engine, { apply: false, logger: quiet })).run('generations', scope, { explicit: true, sourceFlag: sourceId, generations } as never);
  expect(preview.preview_hash).toBeTruthy();
  const applied = await (await repairRunner(engine, { apply: true, logger: quiet })).run('generations', scope,
    { explicit: true, sourceFlag: sourceId, expect: preview.preview_hash, yes: true, generations } as never);
  return applied.outcome_items ?? [];
}

function thinkClient(answer: string, during?: () => Promise<void>): ThinkLLMClient {
  return { create: async () => {
    await during?.();
    return { id: 'msg_stub', type: 'message', role: 'assistant', model: 'stub', stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
      content: [{ type: 'text', text: JSON.stringify({ answer, citations: [], gaps: [] }) }] } as never;
  } };
}

async function seedDrift(engine: BrainEngine) {
  const alice = await engine.putPage('people/alice-example', { title: 'Alice', type: 'person', compiled_truth: 'Alice content' });
  await engine.addTakesBatch([{ page_id: alice.id, row_num: 1, claim: 'Strong technical founder', kind: 'take', holder: 'world', weight: 0.6 }]);
  await engine.addTimelineEntriesBatch([{ slug: 'people/alice-example', date: new Date().toISOString().slice(0, 10), source: 'meeting', summary: 'Funding round closed' }]);
  for (const [k, v] of Object.entries({ 'dream.drift.enabled': 'true', 'dream.drift.lookback_days': '30', 'dream.drift.budget': '1.0' })) await engine.setConfig(k, v);
}
const drift = (engine: BrainEngine, dir: string, reasoning: string, during?: () => Promise<void>) => runPhaseDrift(engine, { dryRun: false, auditPath: join(dir, `drift-${randomUUID()}.jsonl`),
  judge: async () => { await during?.(); return { drifted: true, confidence: 0.9, reasoning, suggested_weight: 0.3 }; } });

async function synthesisRig(engine: BrainEngine, dir: string) {
  const root = join(dir, 'brain'), corpus = join(dir, 'corpus');
  mkdirSync(root); mkdirSync(corpus);
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2) ON CONFLICT (id) DO NOTHING', ['g5src', root]);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.setConfig('sync.write_through', 'true');
  await claimWorktree(engine, 'g5src', root);
  for (const [k, v] of Object.entries({ 'dream.synthesize.enabled': 'true', 'dream.synthesize.cooldown_hours': '0', 'dream.synthesize.min_chars': '100',
    'dream.synthesize.link_manifest': 'false', 'dream.synthesize.mode': 'oneshot', 'dream.synthesize.session_corpus_dir': corpus, 'dream.synthesize.quote_verify': 'false',
    'dream.synthesize.budget_usd': 'unlimited', 'models.dream.synthesize': 'anthropic:claude-sonnet-4-6', 'models.dream.triage': 'anthropic:claude-sonnet-4-6', 'agent.use_gateway_loop': 'true' })) await engine.setConfig(k, v);
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 };
  const run = async (name: string, during?: () => Promise<void>) => {
    writeFileSync(join(ensureCorpusSpoolDir(corpus), sessionCorpusFileName(name, 'g5src')), `[user]\nWe settled the storage plan for ${name}.\n\n${'[assistant]\nNoted.\n\n'.repeat(20)}`);
    __setChatTransportForTests(async opts => {
      const mk = (text: string) => ({ text, blocks: [{ type: 'text', text }], stopReason: 'end', usage, model: opts.model!, providerId: 'anthropic' }) as never;
      if ((opts.system ?? '').startsWith('You triage a conversation transcript')) return mk(JSON.stringify({ score: 0.9, content_type: 'reflection', segments: [], entities: [], reasons: ['durable'] }));
      await during?.();
      const hash = /hash suffix \(USE THIS in slugs\): ([a-z0-9-]+)/i.exec(JSON.stringify(opts.messages))?.[1] ?? 'missing';
      return mk(JSON.stringify({ pages: [{ slug: `wiki/personal/reflections/${name}-${hash}`, title: name, type: 'note', body: `The storage plan for ${name} is settled with [[people/alice-example]].` }], skipped: false }));
    });
    const result = await runPhaseSynthesize(engine, { brainDir: root, sourceId: 'g5src', dryRun: false });
    __setChatTransportForTests(null);
    return result;
  };
  return { run, summary: `dream-cycle-summaries/${await resolveCycleDate(engine, {})}` };
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`GBRA-161 PR 5 single-page generations (${backend})`, () => {
    test('think: a synthesis page edited while the run composed is fenced and keeps the edit', async () => {
      await withBrain(databaseUrl, async engine => {
        const question = 'What about storage plans?';
        const slug = synthesisSlug(question, new Date().toISOString().slice(0, 10));
        const result = await runThink(engine, { question, client: thinkClient('The plan is settled.', () => handEdit(engine, slug, 'A person wrote this.').then(() => {})) });
        expect(codeOf(await persistSynthesis(engine, result).catch(e => e))).toBe('generation_fenced');
        expect(await body(engine, slug)).toBe('A person wrote this.');
      });
    }, 120_000);

    test('think: a same-day re-save versions the earlier page and repair generations restores it', async () => {
      await withBrain(databaseUrl, async engine => {
        const question = 'What about storage plans?';
        await persistSynthesis(engine, await runThink(engine, { question, client: thinkClient('First answer about storage.') }));
        const saved = await persistSynthesis(engine, await runThink(engine, { question, client: thinkClient('Second answer about storage.') }));
        expect(await body(engine, saved.slug)).toContain('Second answer about storage.');
        expect((await versions(engine, saved.slug)).some(v => v.includes('First answer about storage.'))).toBe(true);
        expect((await restore(engine, 'think_synthesis')).map(item => item.outcome)).toEqual(['restored']);
        expect(await body(engine, saved.slug)).toContain('First answer about storage.');
      });
    }, 120_000);

    test('drift: a report edited while the judge ran is fenced and keeps the edit', async () => {
      await withBrain(databaseUrl, async (engine, dir) => {
        await seedDrift(engine);
        const slug = `reports/drift-${await resolveCycleDate(engine, {})}`;
        const result = await drift(engine, dir, 'evidence shifted', () => handEdit(engine, slug, 'A person wrote this.').then(() => {}));
        expect(result.detail).not.toContain(slug);
        expect(await body(engine, slug)).toBe('A person wrote this.');
      });
    }, 120_000);

    test('drift: a same-day rerun versions the earlier report and repair generations restores it', async () => {
      await withBrain(databaseUrl, async (engine, dir) => {
        await seedDrift(engine);
        const slug = `reports/drift-${await resolveCycleDate(engine, {})}`;
        await drift(engine, dir, 'first-reasoning');
        await drift(engine, dir, 'second-reasoning');
        expect(await body(engine, slug)).toContain('second-reasoning');
        expect((await versions(engine, slug)).some(v => v.includes('first-reasoning'))).toBe(true);
        expect((await restore(engine, 'drift_report')).map(item => item.outcome)).toEqual(['restored']);
        expect(await body(engine, slug)).toContain('first-reasoning');
      });
    }, 120_000);

    test('dream summary: a summary edited while the children ran is fenced and keeps the edit', async () => {
      await withBrain(databaseUrl, async (engine, dir) => {
        const rig = await synthesisRig(engine, dir);
        expect((await rig.run('alpha')).status).not.toBe('fail');
        expect(await body(engine, rig.summary, 'g5src')).toContain('alpha');
        await rig.run('beta', () => handEdit(engine, rig.summary, 'A person wrote this.', 'g5src').then(() => {}));
        expect(await body(engine, rig.summary, 'g5src')).toBe('A person wrote this.');
      });
    }, 180_000);

    test('dream summary: a same-day rerun versions the earlier summary and repair generations restores it', async () => {
      await withBrain(databaseUrl, async (engine, dir) => {
        const rig = await synthesisRig(engine, dir);
        await rig.run('alpha');
        await rig.run('beta');
        expect(await body(engine, rig.summary, 'g5src')).toContain('beta');
        expect((await versions(engine, rig.summary, 'g5src')).some(v => v.includes('alpha'))).toBe(true);
        expect((await restore(engine, 'dream_summary', 'g5src')).map(item => item.outcome)).toEqual(['restored']);
        expect(await body(engine, rig.summary, 'g5src')).toContain('alpha');
      });
    }, 180_000);
  });
}
