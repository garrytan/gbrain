/**
 * #7846: extract_atoms writes each captured session's atoms only to the
 * session's own frozen source (#6268: the `.src-<id>` spool stamp, else the
 * session's `<sid>.source.json` record), never to the cycle's source.
 *
 * A brain with default plus two sources and a repo-less brain directory (no Git
 * checkout; the sources table and the corpus records are the record): a session
 * stamped to the cycle's source is extracted there; a session stamped, or frozen
 * by its record, to another source is skipped and extracts only when the phase
 * runs for that source; an unresolved session and legacy unstamped files (one
 * the sweep already ingested) are held with the resolver's reason, and
 * `gbrain sweep --assign-corpus <source> --apply` releases every one of them.
 * Meeting transcripts stay default's. Before the fix every corpus transcript
 * was extracted into default and no other source discovered any. Runs on PGLite
 * and, with DATABASE_URL, Postgres.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { runSweep } from '../src/commands/sweep.ts';
import { CORPUS_UNRESOLVED_STAMP, ensureCorpusSpoolDir, sessionCorpusFileName } from '../src/core/context/corpus-segments.ts';
import { freezeSessionSource } from '../src/core/context/corpus-source.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let dataDir: string;
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'gbrain-atoms-source-db-'));
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

const QUOTE = 'we keep the quarterly plan in one place so every team reads the same numbers';

function writeTranscript(path: string, topic: string): void {
  writeFileSync(path, `[user]\n${QUOTE}. Today we covered ${topic}.\n\n${'[assistant]\nNoted, we will measure it for two weeks.\n\n'.repeat(60)}`);
}

interface Run { result: Awaited<ReturnType<typeof runPhaseExtractAtoms>>; read: string[] }

describe('extract_atoms honors the session\'s frozen source (#7846)', () => {
  test('each session is extracted only into its own source; held files are released by --assign-corpus', async () => {
    for (const engine of engines) {
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-atoms-source-'));
      const corpus = join(dir, 'corpus');
      const meetings = join(dir, 'meetings');
      const brainDir = join(dir, 'brain');
      for (const d of [corpus, meetings, brainDir, join(dir, 'claude')]) mkdirSync(d);
      const tag = randomUUID().slice(0, 8);
      const a = `source-a-${tag}`;
      const b = `source-b-${tag}`;
      const cleanup: string[] = [a, b];
      try {
        await withEnv({ GBRAIN_HOME: join(dir, 'home'), CLAUDE_CONFIG_DIR: join(dir, 'claude'), GBRAIN_SOURCE: undefined }, async () => {
          await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
          for (const id of [a, b]) await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [id]);
          await engine.setConfig('dream.synthesize.session_corpus_dir', corpus);

          const spool = ensureCorpusSpoolDir(corpus);
          const own = sessionCorpusFileName('sess-own', 'default');
          const stamped = sessionCorpusFileName('sess-stamped', b);
          const recorded = sessionCorpusFileName('sess-recorded', CORPUS_UNRESOLVED_STAMP);
          const unresolved = sessionCorpusFileName('sess-unresolved', CORPUS_UNRESOLVED_STAMP);
          writeTranscript(join(spool, own), 'the shared planning calendar');
          writeTranscript(join(spool, stamped), 'the client renewal terms');
          writeTranscript(join(spool, recorded), 'the client onboarding checklist');
          writeTranscript(join(spool, unresolved), 'the hiring loop');
          writeTranscript(join(corpus, 'sess-legacy.txt'), 'the office move');
          writeTranscript(join(corpus, 'sess-ingested.txt'), 'the budget review');
          writeFileSync(join(corpus, 'sess-ingested.txt.ingested'), JSON.stringify({ ingested_at: '2026-01-01T00:00:00.000Z' }) + '\n');
          writeTranscript(join(meetings, 'standup.txt'), 'the weekly standup');
          expect(freezeSessionSource(corpus, 'sess-recorded', b, 'operator')?.source_id).toBe(b);

          const extract = async (sourceId: string): Promise<Run> => {
            const read: string[] = [];
            const result = await runPhaseExtractAtoms(engine, {
              sourceId, brainDir, _pages: [],
              _loadConfig: () => ({ dream: { synthesize: { session_corpus_dir: corpus, meeting_transcripts_dir: meetings } } }) as unknown as GBrainConfig,
              _chat: async (opts: ChatOpts): Promise<ChatResult> => {
                const file = basename(/^Source: (.*)$/m.exec(String(opts.messages[0]?.content ?? ''))?.[1] ?? '');
                read.push(file);
                const text = JSON.stringify({ atoms: [{ title: `Atom of ${file}`, atom_type: 'insight', body: `A planning habit from ${file}.`,
                  source_quote: QUOTE, lesson: 'Keep one plan.', concepts: ['planning'], virality_score: 10, emotional_register: 'practical' }] });
                return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
                  usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
                  model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' } as ChatResult;
              },
            });
            return { result, read: read.sort() };
          };
          const atomSources = async (): Promise<Record<string, string[]>> => {
            const rows = await engine.executeRaw<{ source_id: string; title: string }>(
              `SELECT source_id, title FROM pages WHERE type = 'atom' AND deleted_at IS NULL
                 AND source_id IN ('default', $1, $2) ORDER BY source_id`, [a, b]);
            const out: Record<string, string[]> = {};
            for (const r of rows) (out[r.title.replace(/^Atom of /, '')] ??= []).push(r.source_id);
            return out;
          };

          const first = await extract('default');
          expect(first.read).toEqual([own, 'standup.txt']);
          expect(first.result.details.source_routing).toEqual({
            source_id: 'default',
            corpus_source_other: { [b]: 2 },
            held: { corpus_legacy_unstamped: 2, corpus_source_unresolved: 1 },
            fix: [`gbrain dream --source ${b} --phase extract_atoms`, 'gbrain sweep --assign-corpus <source>'],
          });
          expect(first.result.summary).toContain(`2 corpus file(s) belong to other sources (${b}: 2)`);
          expect(first.result.summary).toContain('3 held with no frozen session source');

          const second = await extract(b);
          expect(second.read).toEqual([recorded, stamped].sort());
          expect(second.result.details.source_routing).toEqual({
            source_id: b,
            corpus_source_other: { default: 1 },
            held: { corpus_legacy_unstamped: 2, corpus_source_unresolved: 1 },
            fix: ['gbrain dream --source default --phase extract_atoms', 'gbrain sweep --assign-corpus <source>'],
          });

          const log = spyOn(console, 'log').mockImplementation(() => {});
          try {
            await runSweep(engine, ['--assign-corpus', a, '--apply', '--json']);
            const out = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
            expect(out.assigned_sessions).toEqual(['sess-ingested', 'sess-legacy', 'sess-unresolved']);
          } finally { log.mockRestore(); }

          const third = await extract(a);
          expect(third.read).toEqual(['sess-ingested.txt', 'sess-legacy.txt', unresolved].sort());
          expect(third.result.details.source_routing).toEqual({
            source_id: a, corpus_source_other: { default: 1, [b]: 2 }, held: {},
            fix: ['gbrain dream --source default --phase extract_atoms', `gbrain dream --source ${b} --phase extract_atoms`],
          });

          expect(await atomSources()).toEqual({
            [own]: ['default'], 'standup.txt': ['default'],
            [recorded]: [b], [stamped]: [b],
            'sess-ingested.txt': [a], 'sess-legacy.txt': [a], [unresolved]: [a],
          });
        });
      } finally {
        await engine.executeRaw(`DELETE FROM pages WHERE type = 'atom'`);
        for (const id of cleanup) await engine.executeRaw('DELETE FROM sources WHERE id = $1', [id]).catch(() => {});
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 120_000);
});
