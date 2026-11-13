/**
 * #7849: synthesis corpus holds after #7805.
 *
 * 1. Dream discovery walks the session corpus recursively for .txt and .md
 *    files, and routing holds every one of them that names no source on a
 *    multi-source brain (corpus_legacy_unstamped). The operator mapping
 *    (gbrain sweep --assign-corpus) listed only top-level .txt files, so a
 *    .md note or a file in a nested folder could never be released.
 * 2. Only corpus_legacy_unstamped and corpus_source_unresolved holds are
 *    released by the mapping (it fills only records naming no source); every
 *    other reason prints its own fix.
 * 3. Doctor counts the sessions dream synthesis holds, already-swept ones
 *    included, as the mapping does.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { assignCorpusSessions, listCorpusSourceHolds } from '../src/core/context/corpus-source.ts';
import { corpusFileOwner, refuseChangedSessionSource, withSessionSourceRouting } from '../src/core/cycle/synthesize-source-routing.ts';
import { ensureCorpusSpoolDir, sessionCorpusFileName } from '../src/core/context/corpus-segments.ts';
import { buildMemoryWritebackCheck } from '../src/commands/doctor/checks/memory-writeback.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const dirs: string[] = [];
const scratch = (tag: string) => { const dir = mkdtempSync(join(tmpdir(), tag)); dirs.push(dir); return dir; };

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('source-a','source-a')");
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const transcript = '[user]\nwe keep the quarterly plan in one place.\n\n[assistant]\nNoted.\n';

describe('#7849 held corpus files beyond top-level .txt', () => {
  test('a .md note and a nested file routing holds are listed by the operator mapping, which releases them', async () => {
    const corpus = join(scratch('gbrain-holds-7849-'), 'corpus');
    mkdirSync(join(corpus, 'meetings'), { recursive: true });
    const note = join(corpus, 'planning-notes.md');
    const nested = join(corpus, 'meetings', 'standup-example.txt');
    writeFileSync(note, transcript);
    writeFileSync(nested, transcript);

    for (const file of [note, nested]) expect(await corpusFileOwner(engine, file, corpus)).toEqual({ ok: false, reason: 'corpus_legacy_unstamped' });
    const holds = listCorpusSourceHolds(corpus, false, { includeIngested: true });
    expect(holds).toMatchObject({ legacy_unstamped: 2, sessions: ['planning-notes.md', 'standup-example'] });

    expect(assignCorpusSessions(corpus, holds.sessions, 'source-a')).toEqual(['planning-notes.md', 'standup-example']);
    for (const file of [note, nested]) expect(await corpusFileOwner(engine, file, corpus)).toMatchObject({ ok: true, sourceId: 'source-a' });
    expect(listCorpusSourceHolds(corpus, false, { includeIngested: true }).sessions).toEqual([]);
  });
});

describe('#7849 each hold reason prints its own fix', () => {
  const route = (held: Record<string, number>) => withSessionSourceRouting({ phase: 'synthesize', status: 'ok', duration_ms: 0, summary: 'done', details: {} },
    { corpus_source_other: {}, held }, 'source-a').details.source_routing as { fix: string[] };

  test('archived and re-created sources never print the mapping, which releases nothing for them', () => {
    expect(route({ corpus_source_archived: 1 }).fix).toEqual(['gbrain sources archived', 'gbrain sources restore <archived-source>']);
    expect(route({ corpus_source_incarnation_changed: 1 }).fix).toEqual([]);
    expect(route({ corpus_source_archived: 1, corpus_source_incarnation_changed: 2 }).fix.join(' ')).not.toContain('--assign-corpus');
  });

  test('a queued synthesis child whose session source was archived names the restore, not the mapping', async () => {
    await engine.executeRaw("INSERT INTO sources(id,name,archived) VALUES('source-archived','source-archived',true)");
    const corpus = join(scratch('gbrain-holds-refuse-7849-'), 'corpus');
    const file = join(ensureCorpusSpoolDir(corpus), sessionCorpusFileName('sess-archived', 'source-archived'));
    writeFileSync(file, transcript);
    const refusal = await refuseChangedSessionSource(engine, { corpus_source: { raw_source: file, corpus_dir: corpus, incarnation: 'x' }, source_id: 'source-archived' })
      .then(() => null, (error: Error) => error.message);
    expect(refusal).toContain('session_source_changed: corpus_source_archived');
    expect(refusal).toContain('It synthesizes after gbrain sources restore <archived-source>.');
    expect(refusal).not.toContain('--assign-corpus');
  });

  test('held sessions with no source keep the mapping, once', () => {
    expect(route({ corpus_legacy_unstamped: 1, corpus_source_unresolved: 1, corpus_source_archived: 1 }).fix)
      .toEqual(['gbrain sweep --assign-corpus <source>', 'gbrain sources archived', 'gbrain sources restore <archived-source>']);
  });
});

describe('#7849 doctor counts what dream synthesis holds', () => {
  test('a legacy file the sweep already extracted is still counted as held', async () => {
    const home = scratch('gbrain-holds-doctor-7849-');
    const corpus = join(home, '.gbrain', 'transcripts', 'corpus');
    mkdirSync(corpus, { recursive: true });
    writeFileSync(join(corpus, 'sess-extracted.txt'), transcript);
    writeFileSync(join(corpus, 'sess-extracted.txt.ingested'), '{}\n');
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const check = await buildMemoryWritebackCheck(engine);
      expect(check.details?.corpus_source_holds).toEqual({ legacy_unstamped: 1, unresolved: 0, sessions: 1 });
      expect(check.status).toBe('warn');
      expect(check.message).toContain('gbrain sweep --assign-corpus <source>');
    });
  });
});
