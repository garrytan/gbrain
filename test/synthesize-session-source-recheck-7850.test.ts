/**
 * #7850: dream synthesis re-checks a session's source when the work runs, and
 * dry runs write no session record.
 *
 * 1. Each synthesis child job carries the corpus file it synthesizes, the
 *    corpus dir and the source incarnation discovery resolved
 *    (`corpus_source`). When the child runs it resolves the file again
 *    (read-only) and refuses, before any model call or write, when the session
 *    no longer resolves to the job's source or the source's incarnation
 *    changed. A child queued by an earlier release (no pin) is re-checked from
 *    its `dream_output.raw_source` and the configured corpus dir.
 * 2. `gbrain dream --dry-run` (synthesize) resolves corpus files read-only:
 *    an unresolved session's record is not frozen by a preview.
 *
 * Repo-less brain directories; PGLite and, with DATABASE_URL, Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseSynthesize } from '../src/core/cycle/synthesize.ts';
import { CORPUS_UNRESOLVED_STAMP, corpusSpoolDir, ensureCorpusSpoolDir, sessionCorpusFileName } from '../src/core/context/corpus-segments.ts';
import { openSessionSource, readSessionSource } from '../src/core/context/corpus-source.ts';
import { makeSubagentHandler } from '../src/core/minions/handlers/subagent.ts';
import type { MinionJobContext, SubagentHandlerData } from '../src/core/minions/types.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let dataDir: string;
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-recheck-db-'));
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
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  resetGateway();
  rmSync(dataDir, { recursive: true, force: true });
});

const quote = 'we keep the quarterly plan in one place so every team reads the same numbers';
const usage = { input_tokens: 100, output_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0 };

interface Fixture { engine: BrainEngine; dir: string; cycle: { id: string; root: string }; other: string; corpus: string; calls: () => number }

async function fixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-synth-recheck-'));
    const corpus = join(dir, 'corpus');
    const tag = randomUUID().slice(0, 8);
    const cycle = { id: `source-a-${tag}`, root: join(dir, 'brain-a') };
    const other = `source-b-${tag}`;
    mkdirSync(corpus);
    mkdirSync(cycle.root);
    let calls = 0;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home'), ANTHROPIC_API_KEY: 'sk-test-synth-recheck', GBRAIN_SOURCE: undefined }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [cycle.id, cycle.root]);
        await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [other]);
        await engine.setConfig('sync.write_through', 'true');
        await claimWorktree(engine, cycle.id, cycle.root);
        for (const [key, value] of Object.entries({
          'dream.synthesize.enabled': 'true', 'dream.synthesize.cooldown_hours': '0',
          'dream.synthesize.min_chars': '100', 'dream.synthesize.link_manifest': 'false',
          'dream.synthesize.mode': 'oneshot', 'dream.synthesize.session_corpus_dir': corpus,
          'models.dream.synthesize': 'anthropic:claude-sonnet-4-6', 'models.dream.triage': 'anthropic:claude-sonnet-4-6',
          'agent.use_gateway_loop': 'true',
        })) await engine.setConfig(key, value);
        __setChatTransportForTests(async opts => {
          calls++;
          const user = String(opts.messages?.[0]?.content ?? '');
          const hash = /hash suffix \(USE THIS in slugs\): ([a-z0-9-]+)/i.exec(user)?.[1] ?? 'missing';
          const text = (opts.system ?? '').startsWith('You triage a conversation transcript')
            ? JSON.stringify({ score: 0.9, content_type: 'reflection', segments: [{ quote, note: 'evidence' }], entities: [], reasons: ['durable insight'] })
            : JSON.stringify({ pages: [{ slug: `wiki/personal/reflections/session-${hash}`, title: 'Session', type: 'note',
              body: 'A durable planning habit with [[people/example]].' }], skipped: false });
          return { text, blocks: [{ type: 'text', text }], stopReason: 'end', usage, model: opts.model!, providerId: 'anthropic' };
        });
        await run({ engine, dir, cycle, other, corpus, calls: () => calls });
      });
    } finally {
      __setChatTransportForTests(null);
      await disposePersistenceConsumer(engine);
      await engine.executeRaw("DELETE FROM pages WHERE slug LIKE 'wiki/personal/reflections/%'");
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

function writeTranscript(path: string, topic: string): void {
  writeFileSync(path, `[user]\n${quote}. Today we covered ${topic}.\n\n${'[assistant]\nDiscuss the long term roadmap.\n\n'.repeat(15)}`);
}

let clientCalls = 0;

/** A synthesis child as the fan-out queues it, run by the real subagent handler (no queue worker). */
async function runChild(engine: BrainEngine, data: Partial<SubagentHandlerData>): Promise<unknown> {
  const full = { prompt: 'Synthesize the transcript.', model: 'anthropic:claude-sonnet-4-6', mode: 'oneshot', require_writes: true,
    allowed_slug_prefixes: ['wiki/personal/reflections/*'], oneshot_slug_suffix: 'abc123', ...data };
  const [job] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs (submission_authority, name, status, data, queue, priority, created_at)
     VALUES ('{"version":1,"kind":"application"}'::jsonb, 'subagent', 'active', $1::text::jsonb, 'default', 0, now()) RETURNING id`,
    [JSON.stringify(full)]);
  const ctx = {
    id: job.id, name: 'subagent', data: full, attempts_made: 1,
    signal: new AbortController().signal, deadlineAtMs: null, shutdownSignal: new AbortController().signal,
    updateProgress: async () => {}, updateTokens: async () => {}, log: async () => {},
    isActive: async () => true, readInbox: async () => [],
  } as unknown as MinionJobContext;
  const client = { create: async () => { clientCalls++; throw new Error('the legacy Messages client was called'); } };
  const handler = makeSubagentHandler({ engine, client: client as never, config: { engine: engine.kind } as never });
  return handler(ctx);
}

const reflections = (engine: BrainEngine) => engine.executeRaw<{ source_id: string; slug: string }>(
  "SELECT source_id, slug FROM pages WHERE slug LIKE 'wiki/personal/reflections/%' AND deleted_at IS NULL ORDER BY slug");

describe('#7850 synthesis re-checks the session source when the child runs', () => {
  test('every queued child carries the corpus file, corpus dir and source incarnation discovery resolved', async () => {
    await fixture(async ({ engine, cycle, corpus }) => {
      const own = join(ensureCorpusSpoolDir(corpus), sessionCorpusFileName('sess-own', cycle.id));
      writeTranscript(own, 'the shared planning calendar');
      const result = await runPhaseSynthesize(engine, { brainDir: cycle.root, sourceId: cycle.id, dryRun: false });
      expect(result.summary).toContain('1 transcript(s) synthesized');
      const [incarnation] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [cycle.id]);
      const jobs = await engine.executeRaw<{ data: Record<string, unknown> }>("SELECT data FROM minion_jobs WHERE name='subagent' AND data->>'source_id'=$1", [cycle.id]);
      expect(jobs.length).toBeGreaterThan(0);
      for (const job of jobs) {
        const data = typeof job.data === 'string' ? JSON.parse(job.data) : job.data;
        expect(data.corpus_source).toEqual({ raw_source: own, corpus_dir: corpus, incarnation: incarnation.incarnation });
      }
    });
  }, 180_000);

  test('a child whose session belongs to another source, or whose source was recreated, is refused before any model call', async () => {
    await fixture(async ({ engine, cycle, other, corpus, calls }) => {
      const spool = ensureCorpusSpoolDir(corpus);
      const foreign = join(spool, sessionCorpusFileName('sess-foreign', other));
      writeTranscript(foreign, 'the client renewal terms');
      const legacy = await runChild(engine, { source_id: cycle.id,
        dream_output: { raw_source: foreign, transcript_hash: 'h', cycle_date: '2026-10-28', quote_verify: false } }).then(() => new Error('the child ran'), (e: Error) => e);
      expect(legacy).toBeInstanceOf(Error);
      expect(String(legacy.message)).toMatch(/^session_source_changed: corpus_source_other/);

      const own = join(spool, sessionCorpusFileName('sess-own', cycle.id));
      writeTranscript(own, 'the shared planning calendar');
      const pinned = await runChild(engine, { source_id: cycle.id,
        corpus_source: { raw_source: own, corpus_dir: corpus, incarnation: '00000000-0000-4000-8000-000000000000' } }).then(() => new Error('the child ran'), (e: Error) => e);
      expect(pinned).toBeInstanceOf(Error);
      expect(String(pinned.message)).toMatch(/^session_source_changed: corpus_source_incarnation_changed/);

      const unresolved = join(spool, sessionCorpusFileName('sess-unresolved', CORPUS_UNRESOLVED_STAMP));
      writeTranscript(unresolved, 'the hiring loop');
      const held = await runChild(engine, { source_id: cycle.id,
        corpus_source: { raw_source: unresolved, corpus_dir: corpus, incarnation: '00000000-0000-4000-8000-000000000000' } }).then(() => new Error('the child ran'), (e: Error) => e);
      expect(String(held.message)).toMatch(/^session_source_changed: corpus_source_unresolved/);

      expect(calls()).toBe(0);
      expect(clientCalls).toBe(0);
      expect(await reflections(engine)).toEqual([]);
    });
  }, 180_000);
});

describe('#7850 a synthesize dry run writes no session record', () => {
  test('an unresolved session in the cycle source\'s checkout is previewed, not frozen', async () => {
    await fixture(async ({ engine, cycle, corpus }) => {
      const cwd = join(cycle.root, 'task');
      mkdirSync(cwd);
      expect((await openSessionSource(corpus, 'sess-preview', { cwd, harness: 'test' })).stamp).toBe(CORPUS_UNRESOLVED_STAMP);
      writeTranscript(join(ensureCorpusSpoolDir(corpus), sessionCorpusFileName('sess-preview', CORPUS_UNRESOLVED_STAMP)), 'the hiring loop');
      const result = await runPhaseSynthesize(engine, { brainDir: cycle.root, sourceId: cycle.id, dryRun: true });
      expect(result.details.source_routing).toBeUndefined();
      expect(readSessionSource(corpusSpoolDir(corpus), 'sess-preview')).toMatchObject({ source_id: null, tier: null, source_incarnation: null });
      expect(await reflections(engine)).toEqual([]);
    });
  }, 180_000);
});
