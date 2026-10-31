/**
 * GBRA-161 PR 4 (#7065): a re-synthesis replaces the earlier outputs of the same transcript only on a complete result,
 * always version first, always reversible. Real synthesize phase runs (oneshot children through the existing chat
 * transport stub, no paid calls) on PGLite and Postgres: the matched earlier output retires at activation, an unmatched
 * one stays live and is listed for cleanup, a chunk failure retires nothing, a restore brings the earlier output back,
 * \`generations.synthesis.retire_previous=false\` retires nothing, and an output from before the ledger is never adopted.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureCorpusSpoolDir, sessionCorpusFileName } from '../../src/core/context/corpus-segments.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseSynthesize } from '../../src/core/cycle/synthesize.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { __setMaintenanceWriteWaitForTests } from '../../src/core/persistence/maintenance-wait.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../../src/core/ai/gateway.ts';
import { resolveRepairScope } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';
import { testBackends } from '../helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let dataDir: string;
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  __setMaintenanceWriteWaitForTests(5_000);
  dataDir = mkdtempSync(join(tmpdir(), 'gbrain-g4-resynth-db-'));
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir });
    await engine.initSchema();
    engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine);
    closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  __setMaintenanceWriteWaitForTests(null);
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  resetGateway();
  rmSync(dataDir, { recursive: true, force: true });
});

const usage = { input_tokens: 100, output_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0 };
const PREFIX = 'wiki/personal/reflections';
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const SINCE = new Date(Date.now() - 86_400_000).toISOString();

interface Fixture { engine: BrainEngine; sourceId: string; root: string; corpus: string; transcript: string; managed: boolean }
/** What the fake model writes for one child: the slug stem and body per page, keyed by the hash suffix the prompt names. */
type Writer = (hash: string) => Array<{ stem: string; title: string; body: string }> | 'fail';

const TRANSCRIPT = '[user]\nWe moved the storage plan to object storage and we charge for durability.\n\n' + '[assistant]\nNoted, discussing the roadmap.\n\n'.repeat(15);

async function fixture(managed: boolean, run: (f: Fixture) => Promise<void>) {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-g4-resynth-'));
    const f: Fixture = { engine, sourceId: `resynth-${randomUUID().slice(0, 8)}`, root: join(dir, 'brain'), corpus: join(dir, 'corpus'), transcript: '', managed };
    for (const path of [f.root, f.corpus]) mkdirSync(path);
    f.transcript = join(ensureCorpusSpoolDir(f.corpus), sessionCorpusFileName('sess-a', f.sourceId));
    writeFileSync(f.transcript, TRANSCRIPT);
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home'), ANTHROPIC_API_KEY: 'sk-test-resynth' }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [f.sourceId, f.root]);
        await engine.setConfig('sync.write_through', 'true');
        await engine.setConfig('generations.synthesis.retire_previous', 'true');
        await claimWorktree(engine, f.sourceId, f.root);
        for (const [key, value] of Object.entries({
          'dream.synthesize.enabled': 'true', 'dream.synthesize.cooldown_hours': '0', 'dream.synthesize.min_chars': '100',
          'dream.synthesize.link_manifest': 'false', 'dream.synthesize.mode': 'oneshot', 'dream.synthesize.session_corpus_dir': f.corpus,
          'dream.synthesize.quote_verify': 'false', 'dream.synthesize.budget_usd': 'unlimited',
          'models.dream.synthesize': 'anthropic:claude-sonnet-4-6', 'models.dream.triage': 'anthropic:claude-sonnet-4-6', 'agent.use_gateway_loop': 'true',
        })) await engine.setConfig(key, value);
        if (managed) await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        await run(f);
      });
    } finally {
      __setChatTransportForTests(null);
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** One synthesize run whose children write what \`writer\` returns; a 'fail' child mangles its oneshot and its fallback write is refused (dead). */
async function synthesize(f: Fixture, writer: Writer) {
  const failTurns = new Map<string, number>();
  __setChatTransportForTests(async opts => {
    const mk = (text: string, blocks: unknown[] = [{ type: 'text', text }], stop = 'end') =>
      ({ text, blocks, stopReason: stop, usage, model: opts.model!, providerId: 'anthropic' }) as never;
    if ((opts.system ?? '').startsWith('You triage a conversation transcript')) {
      return mk(JSON.stringify({ score: 0.9, content_type: 'reflection', segments: [{ quote: 'we charge for durability', note: 'evidence' }], entities: [], reasons: ['durable insight'] }));
    }
    const convo = JSON.stringify(opts.messages);
    const hash = /hash suffix \(USE THIS in slugs\): ([a-z0-9-]+)/i.exec(convo)?.[1] ?? 'missing';
    const pages = writer(hash);
    if (pages === 'fail') {
      const turn = (failTurns.get(hash) ?? 0) + 1;
      failTurns.set(hash, turn);
      if (turn === 1) return mk('here you go! pages!');
      if (turn === 2) return mk('', [{ type: 'tool-call', toolCallId: `tc-${hash}`, toolName: 'brain_put_page', input: { slug: 'notallowed/sneaky-page', content: 'nope' } }], 'tool_calls');
      return mk('done');
    }
    return mk(JSON.stringify({ pages: pages.map(p => ({ slug: `${PREFIX}/${p.stem}-${hash}`, title: p.title, type: 'note', body: p.body })), skipped: false }));
  });
  const result = await runPhaseSynthesize(f.engine, { brainDir: f.root, sourceId: f.sourceId, dryRun: false });
  __setChatTransportForTests(null);
  return result;
}

/** Grows the transcript, so the next run re-synthesizes it under a new content hash (same path, same transcript key). */
const grow = (f: Fixture, turn: string) => appendFileSync(f.transcript, `[user]\n${turn}\n\n`);

async function pages(f: Fixture) {
  return f.engine.executeRaw<{ slug: string; deleted: boolean; retired_by: string | null; versions: number }>(
    `SELECT p.slug, p.deleted_at IS NOT NULL AS deleted, p.frontmatter->>'retired_by' AS retired_by,
            (SELECT count(*)::int FROM page_versions v WHERE v.page_id = p.id) AS versions
       FROM pages p WHERE p.source_id = $1 AND p.slug LIKE $2 ORDER BY p.slug`, [f.sourceId, `${PREFIX}/%`]);
}
const live = async (f: Fixture) => (await pages(f)).filter(p => !p.deleted).map(p => p.slug);
const byStem = async (f: Fixture, stem: string) => (await pages(f)).filter(p => p.slug.startsWith(`${PREFIX}/${stem}-`));

async function repair(f: Fixture, mode: 'restore' | 'cleanup', apply?: string) {
  const scope = await resolveRepairScope(f.engine, f.sourceId);
  return (await repairRunner(f.engine, { apply: apply !== undefined, logger: quiet })).run('generations', scope,
    { explicit: true, sourceFlag: f.sourceId, ...(apply ? { expect: apply, yes: true } : {}), generations: { kind: 'synthesis', mode, since: SINCE } } as never);
}

const PLAN = 'The storage plan moved to object storage.\n\n> we charge for durability\n\nDecided with [[people/alice-example]].';
const PLAN_COVERED = PLAN + '\n\nThe team also set a weekly review of the storage costs.';

for (const managed of [false, true]) describe(`${managed ? 'managed' : 'unmanaged'} re-synthesis (#7065)`, () => {
  test('a complete re-synthesis retires the earlier output it covers: versioned, stamped synthesis-resynthesis, file removed', async () => {
    await fixture(managed, async f => {
      await synthesize(f, () => [{ stem: 'storage-plan', title: 'Storage plan', body: PLAN }]);
      const [first] = await byStem(f, 'storage-plan');
      expect(first?.deleted).toBe(false);
      if (!managed) expect(existsSync(join(f.root, `${first!.slug}.md`))).toBe(true);
      grow(f, 'We also agreed on a weekly review of the storage costs.');
      const result = await synthesize(f, () => [{ stem: 'storage-plan', title: 'Storage plan', body: PLAN_COVERED }]);
      const after = await byStem(f, 'storage-plan');
      expect(after).toHaveLength(2);
      const earlier = after.find(p => p.slug === first!.slug)!;
      const successor = after.find(p => p.slug !== first!.slug)!;
      expect(successor.deleted).toBe(false);
      expect({ deleted: earlier.deleted, retired_by: earlier.retired_by }).toEqual({ deleted: true, retired_by: 'synthesis-resynthesis' });
      expect(earlier.versions).toBeGreaterThan(0);
      expect((result.details as { synthesis_generations?: { retired: string[] } }).synthesis_generations?.retired).toEqual([first!.slug]);
      if (!managed) expect(existsSync(join(f.root, `${first!.slug}.md`))).toBe(false);
    });
  }, 180_000);
});

describe('unmanaged re-synthesis (#7065): what stays live', () => {
  test('an earlier output holding an unquoted claim the successor lacks stays live; cleanup lists it and retires it only on apply', async () => {
    await fixture(false, async f => {
      const unique = 'The storage budget is capped at four hundred dollars a month.';
      await synthesize(f, () => [{ stem: 'storage-plan', title: 'Storage plan', body: `${PLAN}\n\n${unique}` }]);
      const [first] = await byStem(f, 'storage-plan');
      grow(f, 'We also agreed on a weekly review of the storage costs.');
      await synthesize(f, () => [{ stem: 'storage-plan', title: 'Storage plan', body: PLAN_COVERED }]);
      expect((await live(f)).filter(slug => slug.includes('storage-plan'))).toHaveLength(2);
      const preview = await repair(f, 'cleanup');
      const listing = (preview as unknown as { listing?: Array<{ item: string; class: string; detail: string }> }).listing ?? [];
      expect(listing.map(row => [row.item, row.class])).toEqual([[`${f.sourceId}:${first!.slug}`, 'unmatched_predecessor']]);
      expect(listing[0]!.detail).toContain('holds alone 1 claim(s), 0 quote(s), 0 citation(s)');
      expect((await byStem(f, 'storage-plan')).find(p => p.slug === first!.slug)?.deleted).toBe(false);
      await repair(f, 'cleanup', preview.preview_hash!);
      const earlier = (await byStem(f, 'storage-plan')).find(p => p.slug === first!.slug)!;
      expect({ deleted: earlier.deleted, retired_by: earlier.retired_by }).toEqual({ deleted: true, retired_by: 'synthesis-cleanup' });
    });
  }, 180_000);

  test('a chunk failure holds the generation partial and retires nothing; the next complete run retires it', async () => {
    await fixture(false, async f => {
      await f.engine.setConfig('dream.synthesize.max_prompt_tokens', '100000');
      await synthesize(f, () => [{ stem: 'storage-plan', title: 'Storage plan', body: PLAN }]);
      const [first] = await byStem(f, 'storage-plan');
      grow(f, `We also agreed on a weekly review of the storage costs.\n\n${'[assistant]\nA long digression about the roadmap and its many milestones.\n\n'.repeat(6_000)}`);
      const partial = await synthesize(f, hash => hash.endsWith('-c1') ? 'fail' : [{ stem: 'storage-plan', title: 'Storage plan', body: PLAN_COVERED }]);
      const outcomes = (partial.details as { child_outcomes: Array<{ status: string }> }).child_outcomes.map(o => o.status).sort();
      expect(outcomes).toEqual(['completed', 'dead']);
      expect((await byStem(f, 'storage-plan')).find(p => p.slug === first!.slug)?.deleted).toBe(false);
      expect((partial.details as { synthesis_generations: { partial: number; retired: string[] } }).synthesis_generations).toMatchObject({ partial: 1, retired: [] });
      const done = await synthesize(f, () => [{ stem: 'storage-plan', title: 'Storage plan', body: PLAN_COVERED }]);
      expect((done.details as { synthesis_generations: { retired: string[] } }).synthesis_generations.retired).toEqual([first!.slug]);
    });
  }, 300_000);

  test('restore brings the retired earlier output back and retires the successor, both versioned, files following', async () => {
    await fixture(false, async f => {
      await synthesize(f, () => [{ stem: 'storage-plan', title: 'Storage plan', body: PLAN }]);
      const [first] = await byStem(f, 'storage-plan');
      grow(f, 'We also agreed on a weekly review of the storage costs.');
      await synthesize(f, () => [{ stem: 'storage-plan', title: 'Storage plan', body: PLAN_COVERED }]);
      const successor = (await live(f)).find(slug => slug.includes('storage-plan'))!;
      expect(successor).not.toBe(first!.slug);
      const preview = await repair(f, 'restore');
      await repair(f, 'restore', preview.preview_hash!);
      const after = await byStem(f, 'storage-plan');
      expect(after.find(p => p.slug === first!.slug)?.deleted).toBe(false);
      expect(after.find(p => p.slug === successor)).toMatchObject({ deleted: true, retired_by: 'generation-restore' });
      const [body] = await f.engine.executeRaw<{ compiled_truth: string }>('SELECT compiled_truth FROM pages WHERE source_id=$1 AND slug=$2', [f.sourceId, first!.slug]);
      expect(body!.compiled_truth).toContain('The storage plan moved to object storage.');
      expect(existsSync(join(f.root, `${first!.slug}.md`))).toBe(true);
      expect(existsSync(join(f.root, `${successor}.md`))).toBe(false);
    });
  }, 180_000);

  test('generations.synthesis.retire_previous=false retires nothing; switched back on, the next re-synthesis retires', async () => {
    await fixture(false, async f => {
      await f.engine.setConfig('generations.synthesis.retire_previous', 'false');
      await synthesize(f, () => [{ stem: 'storage-plan', title: 'Storage plan', body: PLAN }]);
      const [first] = await byStem(f, 'storage-plan');
      grow(f, 'We also agreed on a weekly review of the storage costs.');
      await synthesize(f, () => [{ stem: 'storage-plan', title: 'Storage plan', body: PLAN_COVERED }]);
      expect((await live(f)).filter(slug => slug.includes('storage-plan'))).toHaveLength(2);
      await f.engine.setConfig('generations.synthesis.retire_previous', 'true');
      grow(f, 'Nothing else changed.');
      const on = await synthesize(f, () => [{ stem: 'storage-plan', title: 'Storage plan', body: PLAN_COVERED }]);
      expect((on.details as { synthesis_generations: { retired: string[] } }).synthesis_generations.retired.sort())
        .toEqual((await byStem(f, 'storage-plan')).filter(p => p.deleted).map(p => p.slug).sort());
      expect((await byStem(f, 'storage-plan')).find(p => p.slug === first!.slug)?.deleted).toBe(true);
    });
  }, 240_000);

  test('an output written before the ledger is never retired; what the ledger recorded since is', async () => {
    await fixture(false, async f => {
      await synthesize(f, () => [{ stem: 'storage-plan', title: 'Storage plan', body: PLAN }]);
      const [backlog] = await byStem(f, 'storage-plan');
      await f.engine.executeRaw(`DELETE FROM derived_generation_items WHERE generation_id IN (SELECT id FROM derived_generations WHERE source_id=$1 AND kind='synthesis')`, [f.sourceId]);
      await f.engine.executeRaw(`DELETE FROM derived_generations WHERE source_id=$1 AND kind='synthesis'`, [f.sourceId]);
      grow(f, 'We also agreed on a weekly review of the storage costs.');
      await synthesize(f, () => [{ stem: 'storage-plan', title: 'Storage plan', body: PLAN_COVERED }]);
      const second = (await live(f)).find(slug => slug.includes('storage-plan') && slug !== backlog!.slug)!;
      expect((await byStem(f, 'storage-plan')).find(p => p.slug === backlog!.slug)?.deleted).toBe(false);
      grow(f, 'Nothing else changed.');
      await synthesize(f, () => [{ stem: 'storage-plan', title: 'Storage plan', body: PLAN_COVERED }]);
      const after = await byStem(f, 'storage-plan');
      expect(after.find(p => p.slug === backlog!.slug)?.deleted).toBe(false);
      expect(after.find(p => p.slug === second)).toMatchObject({ deleted: true, retired_by: 'synthesis-resynthesis' });
    });
  }, 240_000);
});
