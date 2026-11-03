/**
 * #7805: dream synthesis writes each captured session's pages to the session's
 * own frozen source (#6268: the `.src-<id>` spool stamp, else the session's
 * `<sid>.source.json` record), never to the cycle's source.
 *
 * A multi-source brain (default plus two sources) with a repo-less checkout per
 * source: a session stamped to the cycle's source synthesizes there; a session
 * stamped, or frozen by its record, to the other source is skipped and
 * synthesizes only when the phase runs for that source; an unresolved session
 * and a legacy unstamped file are held with the resolver's reason. Before the
 * fix every transcript was synthesized into the cycle's source. Runs managed
 * and unmanaged, on PGLite and, with DATABASE_URL, Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseSynthesize } from '../src/core/cycle/synthesize.ts';
import { CORPUS_UNRESOLVED_STAMP, ensureCorpusSpoolDir, sessionCorpusFileName } from '../src/core/context/corpus-segments.ts';
import { assignCorpusSessions, freezeSessionSource, listCorpusSourceHolds } from '../src/core/context/corpus-source.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { __setMaintenanceWriteWaitForTests } from '../src/core/persistence/maintenance-wait.ts';
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
  __setMaintenanceWriteWaitForTests(5_000);
  dataDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-source-db-'));
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

const quote = 'we keep the quarterly plan in one place so every team reads the same numbers';
const usage = { input_tokens: 100, output_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0 };

interface Fixture { engine: BrainEngine; cycle: { id: string; root: string }; other: { id: string; root: string }; corpus: string }

async function fixture(managed: boolean, run: (f: Fixture) => Promise<void>, solo = false) {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-synth-source-'));
    const corpus = join(dir, 'corpus');
    const tag = randomUUID().slice(0, 8);
    const cycle = { id: solo ? 'default' : `source-a-${tag}`, root: join(dir, 'brain-a') };
    const other = { id: `source-b-${tag}`, root: join(dir, 'brain-b') };
    mkdirSync(corpus);
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home'), ANTHROPIC_API_KEY: 'sk-test-synth-source', GBRAIN_SOURCE: undefined }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        const sources = solo ? [cycle] : [cycle, other];
        for (const s of sources) {
          mkdirSync(s.root);
          if (solo) {
            await engine.executeRaw("DELETE FROM sources WHERE id <> 'default'");
            await engine.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1', [s.id, s.root]);
          }
          else await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [s.id, s.root]);
        }
        await engine.setConfig('sync.write_through', 'true');
        for (const s of sources) await claimWorktree(engine, s.id, s.root);
        for (const [key, value] of Object.entries({
          'dream.synthesize.enabled': 'true', 'dream.synthesize.cooldown_hours': '0',
          'dream.synthesize.min_chars': '100', 'dream.synthesize.link_manifest': 'false',
          'dream.synthesize.mode': 'oneshot', 'dream.synthesize.session_corpus_dir': corpus,
          'models.dream.synthesize': 'anthropic:claude-sonnet-4-6', 'models.dream.triage': 'anthropic:claude-sonnet-4-6',
        })) await engine.setConfig(key, value);
        if (managed) await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        __setChatTransportForTests(async opts => {
          const user = String(opts.messages?.[0]?.content ?? '');
          const hash = /hash suffix \(USE THIS in slugs\): ([a-z0-9-]+)/i.exec(user)?.[1] ?? 'missing';
          const text = (opts.system ?? '').startsWith('You triage a conversation transcript')
            ? JSON.stringify({ score: 0.9, content_type: 'reflection', segments: [{ quote, note: 'evidence' }], entities: [], reasons: ['durable insight'] })
            : JSON.stringify({ pages: [{ slug: `wiki/personal/reflections/session-${hash}`, title: 'Session', type: 'note',
              body: 'A durable planning habit with [[people/example]].' }], skipped: false });
          return { text, blocks: [{ type: 'text', text }], stopReason: 'end', usage, model: opts.model!, providerId: 'anthropic' };
        });
        await run({ engine, cycle, other, corpus });
      });
    } finally {
      __setChatTransportForTests(null);
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

function writeTranscript(path: string, topic: string): void {
  writeFileSync(path, `[user]\n${quote}. Today we covered ${topic}.\n\n${'[assistant]\nDiscuss the long term roadmap.\n\n'.repeat(15)}`);
}

/** The source every synthesized page landed in, by the basename of the transcript it came from. */
async function synthesizedSources(engine: BrainEngine, f: Pick<Fixture, 'cycle' | 'other'>): Promise<Record<string, string[]>> {
  const rows = await engine.executeRaw<{ source_id: string; raw_source: string }>(
    `SELECT source_id, frontmatter->>'raw_source' AS raw_source FROM pages
      WHERE slug LIKE 'wiki/personal/reflections/session-%' AND deleted_at IS NULL
        AND source_id IN ('default', $1, $2) ORDER BY source_id`, [f.cycle.id, f.other.id]);
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[basename(r.raw_source)] ??= []).push(r.source_id);
  return out;
}

for (const managed of [false, true]) describe(`${managed ? 'managed' : 'unmanaged'} synthesis honors the session's frozen source (#7805)`, () => {
  test('a multi-source brain synthesizes each session only into its own source; unresolved and legacy files are held', async () => {
    await fixture(managed, async ({ engine, cycle, other, corpus }) => {
      const spool = ensureCorpusSpoolDir(corpus);
      const own = sessionCorpusFileName('sess-own', cycle.id);
      const stamped = sessionCorpusFileName('sess-stamped', other.id);
      const recorded = sessionCorpusFileName('sess-recorded', CORPUS_UNRESOLVED_STAMP);
      const unresolved = sessionCorpusFileName('sess-unresolved', CORPUS_UNRESOLVED_STAMP);
      writeTranscript(join(spool, own), 'the shared planning calendar');
      writeTranscript(join(spool, stamped), 'the client renewal terms');
      writeTranscript(join(spool, recorded), 'the client onboarding checklist');
      writeTranscript(join(spool, unresolved), 'the hiring loop');
      writeTranscript(join(corpus, 'sess-legacy.txt'), 'the office move');
      expect(freezeSessionSource(corpus, 'sess-recorded', other.id, 'operator')?.source_id).toBe(other.id);

      const first = await runPhaseSynthesize(engine, { brainDir: cycle.root, sourceId: cycle.id, dryRun: false });
      expect(first.status).toBe('ok');
      expect(await synthesizedSources(engine, { cycle, other })).toEqual({ [own]: [cycle.id] });
      expect(first.details.source_routing).toEqual({
        source_id: cycle.id,
        corpus_source_other: { [other.id]: 2 },
        held: { corpus_legacy_unstamped: 1, corpus_source_unresolved: 1 },
        fix: [`gbrain dream --source ${other.id} --phase synthesize`, 'gbrain sweep --assign-corpus <source>'],
      });
      expect(first.summary).toContain(`2 corpus file(s) belong to other sources (${other.id}: 2)`);
      expect(existsSync(join(other.root, 'wiki'))).toBe(false);

      const second = await runPhaseSynthesize(engine, { brainDir: other.root, sourceId: other.id, dryRun: false });
      expect(second.status).toBe('ok');
      expect(await synthesizedSources(engine, { cycle, other })).toEqual({ [own]: [cycle.id], [stamped]: [other.id], [recorded]: [other.id] });
      expect(second.details.source_routing).toMatchObject({ corpus_source_other: { [cycle.id]: 1 } });
    });
  }, 180_000);

  test('an --input file from the session corpus keeps its session source', async () => {
    await fixture(managed, async ({ engine, cycle, other, corpus }) => {
      const stamped = join(ensureCorpusSpoolDir(corpus), sessionCorpusFileName('sess-input', other.id));
      writeTranscript(stamped, 'the client renewal terms');
      const result = await runPhaseSynthesize(engine, { brainDir: cycle.root, sourceId: cycle.id, dryRun: false, inputFile: stamped });
      expect(result.details.transcripts_processed).toBe(0);
      expect(result.details.source_routing).toMatchObject({ corpus_source_other: { [other.id]: 1 } });
      expect(await synthesizedSources(engine, { cycle, other })).toEqual({});
    });
  }, 120_000);

  test('a legacy file the sweep already extracted stays held until the operator maps its session', async () => {
    await fixture(managed, async ({ engine, cycle, other, corpus }) => {
      writeTranscript(join(corpus, 'sess-extracted.txt'), 'the office move');
      writeFileSync(join(corpus, 'sess-extracted.txt.ingested'), '{}\n');
      const opts = { brainDir: cycle.root, sourceId: cycle.id, dryRun: false };
      const held = await runPhaseSynthesize(engine, opts);
      expect(held.details.source_routing).toMatchObject({ held: { corpus_legacy_unstamped: 1 } });
      expect(listCorpusSourceHolds(corpus, false).sessions).toEqual([]);
      expect(listCorpusSourceHolds(corpus, false, { includeIngested: true }).sessions).toEqual(['sess-extracted']);
      expect(assignCorpusSessions(corpus, ['sess-extracted'], cycle.id)).toEqual(['sess-extracted']);
      const released = await runPhaseSynthesize(engine, opts);
      expect(released.status).toBe('ok');
      expect(released.details.source_routing).toBeUndefined();
      expect(await synthesizedSources(engine, { cycle, other })).toEqual({ 'sess-extracted.txt': [cycle.id] });
    });
  }, 120_000);

  test('a top-level corpus file whose name starts with two dots is a corpus file, held like any legacy file', async () => {
    await fixture(managed, async ({ engine, cycle, other, corpus }) => {
      writeTranscript(join(corpus, '..stray.txt'), 'the office move');
      const result = await runPhaseSynthesize(engine, { brainDir: cycle.root, sourceId: cycle.id, dryRun: false });
      expect(result.details.source_routing).toMatchObject({ held: { corpus_legacy_unstamped: 1 } });
      expect(await synthesizedSources(engine, { cycle, other })).toEqual({});
    });
  }, 120_000);

  test('an --input file outside the corpus is kept for the cycle source, in no routing bucket', async () => {
    await fixture(managed, async ({ engine, cycle, other, corpus }) => {
      const outside = join(dirname(corpus), 'meeting-notes.txt');
      writeTranscript(outside, 'the quarterly offsite');
      const result = await runPhaseSynthesize(engine, { brainDir: cycle.root, sourceId: cycle.id, dryRun: false, inputFile: outside });
      expect(result.status).toBe('ok');
      expect(result.details.source_routing).toBeUndefined();
      expect(await synthesizedSources(engine, { cycle, other })).toEqual({ 'meeting-notes.txt': [cycle.id] });
    });
  }, 120_000);
});

test('a sole-source brain (unmanaged) still synthesizes a legacy top-level file (#7805)', async () => {
  await fixture(false, async ({ engine, cycle, other, corpus }) => {
    writeTranscript(join(corpus, 'sess-solo.txt'), 'the office move');
    const result = await runPhaseSynthesize(engine, { brainDir: cycle.root, sourceId: cycle.id, dryRun: false });
    expect(result.status).toBe('ok');
    expect(result.details.source_routing).toBeUndefined();
    expect(await synthesizedSources(engine, { cycle, other })).toEqual({ 'sess-solo.txt': ['default'] });
  }, true);
}, 120_000);

describe('assign-corpus listing includes sessions the sweep already extracted (#7805)', () => {
  const extracted = (dir: string, name: string) => { writeTranscript(join(dir, name), 'the office move'); writeFileSync(join(dir, name + '.ingested'), '{}\n'); };

  test('only a held extracted session is listed: not a stamped or frozen one, not a sole-source legacy file, not a file outside the corpus', () => {
    const corpus = mkdtempSync(join(tmpdir(), 'gbrain-assign-corpus-'));
    try {
      const spool = ensureCorpusSpoolDir(corpus);
      extracted(spool, sessionCorpusFileName('sess-held', CORPUS_UNRESOLVED_STAMP));
      extracted(spool, sessionCorpusFileName('sess-stamped', 'source-a'));
      extracted(spool, sessionCorpusFileName('sess-frozen', CORPUS_UNRESOLVED_STAMP));
      expect(freezeSessionSource(corpus, 'sess-frozen', 'source-b', 'operator')?.source_id).toBe('source-b');
      extracted(corpus, 'sess-legacy.txt');
      const outside = join(dirname(corpus), `${basename(corpus)}-elsewhere`);
      mkdirSync(outside);
      extracted(outside, 'sess-elsewhere.txt');

      expect(listCorpusSourceHolds(corpus, false).sessions).toEqual([]);
      expect(listCorpusSourceHolds(corpus, false, { includeIngested: true })).toMatchObject({ unresolved: 1, legacy_unstamped: 1, sessions: ['sess-held', 'sess-legacy'] });
      expect(listCorpusSourceHolds(corpus, true, { includeIngested: true }).sessions).toEqual(['sess-held']);
      expect(assignCorpusSessions(corpus, ['sess-held', 'sess-frozen'], 'source-a')).toEqual(['sess-held']);
      expect(freezeSessionSource(corpus, 'sess-frozen', 'source-a', 'operator')?.source_id).toBe('source-b');
      rmSync(outside, { recursive: true, force: true });
    } finally { rmSync(corpus, { recursive: true, force: true }); }
  });
});
