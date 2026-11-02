/**
 * #7868: an unresolved session's deferred resolution accepts only tier-4
 * evidence, a registered source whose local_path contains the session's
 * recorded cwd (active over archived). Before the fix it ran the whole
 * resolution chain, whose last tiers are `sources.default`, the sole
 * non-default convenience and finally `default`, and froze the answer: a
 * session captured anywhere else on a multi-source brain was pinned to the
 * fallback for good. A session with no tier-4 evidence now stays held as
 * `corpus_source_unresolved` (nothing frozen) until `gbrain sweep
 * --assign-corpus <source>` maps it. A single-source brain still resolves its
 * only source, without freezing, so a second source added later holds the
 * session instead of inheriting a stale pin.
 *
 * #7850: `resolveCorpusFileSource(..., { readOnly: true })` (every dry run)
 * freezes no record and binds no incarnation; an extract_atoms dry run passes it.
 *
 * Repo-less brain directories (no Git checkout); PGLite and, with
 * DATABASE_URL, Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { CORPUS_UNRESOLVED_STAMP, corpusSpoolDir, ensureCorpusSpoolDir, sessionCorpusFileName } from '../src/core/context/corpus-segments.ts';
import { assignCorpusSessions, freezeSessionSource, listCorpusSourceHolds, openSessionSource, readSessionSource, resolveCorpusFileSource } from '../src/core/context/corpus-source.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import type { ChatResult } from '../src/core/ai/gateway.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let dataDir: string;
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'gbrain-deferred-source-db-'));
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
  rmSync(dataDir, { recursive: true, force: true });
});

interface Brain { engine: BrainEngine; dir: string; corpus: string; a: string; b: string }

async function brain(run: (b: Brain) => Promise<void>): Promise<void> {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-deferred-source-'));
    const corpus = join(dir, 'corpus');
    mkdirSync(corpus);
    const tag = randomUUID().slice(0, 8);
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_SOURCE: undefined }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await run({ engine, dir, corpus, a: `source-a-${tag}`, b: `source-b-${tag}` });
      });
    } finally {
      await engine.executeRaw("DELETE FROM sources WHERE id <> 'default'");
      await engine.executeRaw("DELETE FROM config WHERE key = 'sources.default'");
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

const TRANSCRIPT = `[user]\nwe keep the quarterly plan in one place.\n\n${'[assistant]\nNoted, we will measure it for two weeks.\n\n'.repeat(60)}`;

/** A captured session no client-side tier resolved: its record keeps the cwd, its file is stamped unresolved. */
async function unresolvedSession(corpus: string, sessionId: string, cwd: string): Promise<string> {
  mkdirSync(cwd, { recursive: true });
  expect((await openSessionSource(corpus, sessionId, { cwd, harness: 'test' })).stamp).toBe(CORPUS_UNRESOLVED_STAMP);
  const name = sessionCorpusFileName(sessionId, CORPUS_UNRESOLVED_STAMP);
  writeFileSync(join(ensureCorpusSpoolDir(corpus), name), TRANSCRIPT);
  return name;
}

const addSource = (engine: BrainEngine, id: string, localPath: string | null = null, archived = false) =>
  engine.executeRaw('INSERT INTO sources(id,name,local_path,archived) VALUES($1,$1,$2,$3)', [id, localPath, archived]);

describe('#7868 deferred session resolution accepts only tier-4 evidence', () => {
  test('a cwd no registered source contains stays held: never the configured default, never default; --assign-corpus releases it', async () => {
    await brain(async ({ engine, dir, corpus, a, b }) => {
      await addSource(engine, a);
      await addSource(engine, b);
      await engine.setConfig('sources.default', b);
      const configured = await unresolvedSession(corpus, 'sess-configured', join(dir, 'ws-1'));
      expect(await resolveCorpusFileSource(engine, corpus, configured, 'spool')).toEqual({ ok: false, reason: 'corpus_source_unresolved' });
      expect(readSessionSource(corpusSpoolDir(corpus), 'sess-configured')).toMatchObject({ source_id: null, tier: null });

      await engine.executeRaw("DELETE FROM config WHERE key = 'sources.default'");
      const seeded = await unresolvedSession(corpus, 'sess-seeded', join(dir, 'ws-2'));
      expect(await resolveCorpusFileSource(engine, corpus, seeded, 'spool')).toEqual({ ok: false, reason: 'corpus_source_unresolved' });
      expect(readSessionSource(corpusSpoolDir(corpus), 'sess-seeded')).toMatchObject({ source_id: null, tier: null });
      expect(listCorpusSourceHolds(corpus, false)).toMatchObject({ unresolved: 2, sessions: ['sess-configured', 'sess-seeded'] });

      expect(assignCorpusSessions(corpus, ['sess-configured', 'sess-seeded'], a)).toEqual(['sess-configured', 'sess-seeded']);
      expect(await resolveCorpusFileSource(engine, corpus, configured, 'spool')).toMatchObject({ ok: true, sourceId: a, via: 'session_record' });
      expect(await resolveCorpusFileSource(engine, corpus, seeded, 'spool')).toMatchObject({ ok: true, sourceId: a, via: 'session_record' });
    });
  }, 120_000);

  test('the sole non-default convenience is not evidence either', async () => {
    await brain(async ({ engine, dir, corpus, a }) => {
      await addSource(engine, a, join(dir, 'brain-a'));
      const name = await unresolvedSession(corpus, 'sess-elsewhere', join(dir, 'ws'));
      expect(await resolveCorpusFileSource(engine, corpus, name, 'spool')).toEqual({ ok: false, reason: 'corpus_source_unresolved' });
      expect(readSessionSource(corpusSpoolDir(corpus), 'sess-elsewhere')?.source_id).toBeNull();
    });
  }, 120_000);

  test('tier 4: the deepest active registered path containing the cwd resolves and freezes; an archived deeper path loses', async () => {
    await brain(async ({ engine, dir, corpus, a, b }) => {
      await addSource(engine, a, join(dir, 'ws'));
      await addSource(engine, b, join(dir, 'ws', 'deep'), true);
      const name = await unresolvedSession(corpus, 'sess-inside', join(dir, 'ws', 'deep', 'task'));
      expect(await resolveCorpusFileSource(engine, corpus, name, 'spool')).toMatchObject({ ok: true, sourceId: a, via: 'session_record' });
      expect(readSessionSource(corpusSpoolDir(corpus), 'sess-inside')).toMatchObject({ source_id: a, tier: 'engine' });
    });
  }, 120_000);

  test('a cwd only an archived source contains stays held, unfrozen', async () => {
    await brain(async ({ engine, dir, corpus, a, b }) => {
      await addSource(engine, a);
      await addSource(engine, b, join(dir, 'ws'), true);
      const name = await unresolvedSession(corpus, 'sess-archived', join(dir, 'ws', 'task'));
      expect(await resolveCorpusFileSource(engine, corpus, name, 'spool')).toEqual({ ok: false, reason: 'corpus_source_unresolved' });
      expect(readSessionSource(corpusSpoolDir(corpus), 'sess-archived')?.source_id).toBeNull();
    });
  }, 120_000);

  test('a single-source brain resolves its only source without freezing; a second source then holds the session', async () => {
    await brain(async ({ engine, dir, corpus, a }) => {
      const name = await unresolvedSession(corpus, 'sess-solo', join(dir, 'ws'));
      expect(await resolveCorpusFileSource(engine, corpus, name, 'spool')).toMatchObject({ ok: true, sourceId: 'default', via: 'sole_source' });
      expect(readSessionSource(corpusSpoolDir(corpus), 'sess-solo')).toMatchObject({ source_id: null, source_incarnation: null });
      expect(listCorpusSourceHolds(corpus, true).unresolved).toBe(0);

      await addSource(engine, a);
      expect(await resolveCorpusFileSource(engine, corpus, name, 'spool')).toEqual({ ok: false, reason: 'corpus_source_unresolved' });
      expect(listCorpusSourceHolds(corpus, false).sessions).toEqual(['sess-solo']);
    });
  }, 120_000);
});

describe('#7850 the read-only resolver writes no session record', () => {
  test('readOnly resolves tier-4 evidence without freezing, and binds no incarnation on a frozen record', async () => {
    await brain(async ({ engine, dir, corpus, a }) => {
      await addSource(engine, a, join(dir, 'ws'));
      const name = await unresolvedSession(corpus, 'sess-preview', join(dir, 'ws', 'task'));
      expect(await resolveCorpusFileSource(engine, corpus, name, 'spool', { readOnly: true })).toMatchObject({ ok: true, sourceId: a });
      expect(readSessionSource(corpusSpoolDir(corpus), 'sess-preview')).toMatchObject({ source_id: null, tier: null });

      expect(freezeSessionSource(corpus, 'sess-bound', a, 'operator')?.source_incarnation).toBeNull();
      const bound = sessionCorpusFileName('sess-bound', a);
      writeFileSync(join(ensureCorpusSpoolDir(corpus), bound), '[user]\nthe weekly plan\n');
      expect(await resolveCorpusFileSource(engine, corpus, bound, 'spool', { readOnly: true })).toMatchObject({ ok: true, sourceId: a });
      expect(readSessionSource(corpusSpoolDir(corpus), 'sess-bound')?.source_incarnation).toBeNull();

      expect(await resolveCorpusFileSource(engine, corpus, name, 'spool')).toMatchObject({ ok: true, sourceId: a });
      expect(readSessionSource(corpusSpoolDir(corpus), 'sess-preview')).toMatchObject({ source_id: a, tier: 'engine' });
      expect(await resolveCorpusFileSource(engine, corpus, bound, 'spool')).toMatchObject({ ok: true, sourceId: a });
      expect(readSessionSource(corpusSpoolDir(corpus), 'sess-bound')?.source_incarnation).not.toBeNull();
    });
  }, 120_000);

  test('an extract_atoms dry run lists the session under its source and leaves its record unresolved', async () => {
    await brain(async ({ engine, dir, corpus, a }) => {
      await addSource(engine, a, join(dir, 'ws'));
      const brainDir = join(dir, 'brain-a');
      mkdirSync(brainDir);
      await unresolvedSession(corpus, 'sess-dry', join(dir, 'ws', 'task'));
      const result = await runPhaseExtractAtoms(engine, {
        sourceId: a, brainDir, dryRun: true, _pages: [],
        _loadConfig: () => ({ dream: { synthesize: { session_corpus_dir: corpus } } }) as unknown as GBrainConfig,
        _chat: async (): Promise<ChatResult> => ({ text: '[]', blocks: [{ type: 'text', text: '[]' }], stopReason: 'end',
          usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' }),
      });
      expect(result.details.transcripts_total).toBe(1);
      expect(result.details.source_routing).toBeUndefined();
      expect(readSessionSource(corpusSpoolDir(corpus), 'sess-dry')).toMatchObject({ source_id: null, tier: null });
    });
  }, 120_000);
});
