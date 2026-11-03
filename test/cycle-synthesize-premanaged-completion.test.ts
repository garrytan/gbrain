/**
 * #6924: synthesis completions a brain recorded before it went managed.
 *
 * A managed run keys its synth-v2 completions `<source>/<incarnation>`; the
 * classic runs before activation wrote legacy `dream:synth:` keys and synth-v2
 * keys under the bare source id. Those used to be ignored after activation, so
 * re-enabling synthesize re-synthesized every transcript (duplicate pages and
 * paid spend).
 *
 * The rule: a completion without an incarnation counts on a managed brain
 * only when its own source still holds that synthesis's output (a live
 * `dream_generated` page whose `raw_source` names the transcript). Pages are
 * deleted with their source row, so a completion of another source, or of a
 * removed and re-added source, never suppresses synthesis.
 *
 * Dry runs use a triage model with no provider recipe: a transcript that
 * reaches triage shows up as `degraded`, one screened out first never does.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseSynthesize } from '../src/core/cycle/synthesize.ts';
import { executeRawJsonb } from '../src/core/sql-query.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { managedSynthesisFixture } from './helpers/managed-synthesis-fixture.ts';
import { freezeCorpusSessions } from './helpers/frozen-corpus.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let dataDir: string;
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'gbrain-premanaged-synth-'));
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: join(dataDir, 'pglite') });
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

interface DryRunDetails {
  triage: { degraded: number };
  synthesis_state: { candidates: number; already_synthesized: number };
}

interface Corpus {
  engine: BrainEngine;
  write: (name: string) => { filePath: string; name: string; hash16: string };
  addSource: () => Promise<string>;
  job: (sourceId: string, key: string) => Promise<void>;
  archived: (sourceId: string, key: string) => Promise<void>;
  output: (sourceId: string, rawSource: string, opts?: { deleted?: boolean; dreamGenerated?: boolean }) => Promise<void>;
  dryRun: (sourceId: string) => Promise<DryRunDetails>;
}

/** One corpus per engine: transcripts on disk plus sources, completions and output pages seeded before managed mode. */
async function withCorpus(run: (c: Corpus) => Promise<void>): Promise<void> {
  for (const engine of engines) {
    const dir = mkdtempSync(join(dataDir, 'corpus-'));
    const corpusDir = join(dir, 'corpus');
    const brainDir = join(dir, 'brain');
    mkdirSync(corpusDir);
    mkdirSync(brainDir);
    try {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      for (const [key, value] of Object.entries({
        'dream.synthesize.enabled': 'true', 'dream.synthesize.cooldown_hours': '0',
        'dream.synthesize.session_corpus_dir': corpusDir, 'models.dream.triage': 'no-such-provider:judge',
      })) await engine.setConfig(key, value);
      let pages = 0;
      await run({
        engine,
        write: name => {
          const content = `conversation in ${name}\n`.repeat(200);
          writeFileSync(join(corpusDir, name), content);
          return { filePath: join(corpusDir, name), name, hash16: createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16) };
        },
        addSource: async () => {
          const id = `premanaged-${randomUUID().slice(0, 8)}`;
          await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [id]);
          return id;
        },
        job: async (sourceId, key) => {
          await engine.executeRaw(
            `INSERT INTO minion_jobs (submission_authority, name, queue, status, data, idempotency_key, finished_at)
             VALUES ('{"version":1,"kind":"application"}'::jsonb, 'subagent', 'dream-inline-done', 'completed',
                     jsonb_build_object('source_id', $1::text), $2, now())`, [sourceId, key]);
        },
        archived: async (sourceId, key) => {
          await engine.executeRaw('INSERT INTO dream_synthesis_completions (source_id, idempotency_key) VALUES ($1, $2)', [sourceId, key]);
        },
        output: async (sourceId, rawSource, opts = {}) => {
          await executeRawJsonb(engine,
            `INSERT INTO pages (source_id, slug, type, title, deleted_at, frontmatter)
             VALUES ($1, $2, 'note', 'Synthesis output', CASE WHEN $3::boolean THEN now() END, $4::jsonb)`,
            [sourceId, `wiki/personal/reflections/output-${++pages}`, opts.deleted === true],
            [{ ...(opts.dreamGenerated === false ? {} : { dream_generated: true }), raw_source: rawSource }]);
        },
        dryRun: async sourceId => {
          freezeCorpusSessions(corpusDir, sourceId);
          await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
          const result = await runPhaseSynthesize(engine, { brainDir, sourceId, dryRun: true });
          expect(result.status).toBe('ok');
          return result.details as unknown as DryRunDetails;
        },
      });
    } finally {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

const v2Key = (identity: string, name: string, hash16: string) =>
  `dream:synth-v2:${encodeURIComponent(identity)}:filename:${encodeURIComponent(name)}:${hash16}`;

describe('#6924 managed synthesis and completions recorded before activation', () => {
  test('a managed dry run skips pre-managed completions whose output this source still holds', async () => {
    await withCorpus(async ({ engine, write, addSource, job, archived, output, dryRun }) => {
      const source = await addSource();
      const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [source]);
      const single = write('2026-09-01-single.txt');
      const chunked = write('2026-09-02-chunked.txt');
      const legacy = write('2026-09-03-legacy.txt');
      const pruned = write('2026-09-04-pruned.txt');
      const current = write('2026-09-05-current.txt');
      write('2026-09-06-new.txt');
      await job(source, v2Key(source, single.name, single.hash16));
      await job(source, `${v2Key(source, chunked.name, chunked.hash16)}:c0of2`);
      await job(source, `${v2Key(source, chunked.name, chunked.hash16)}:c1of2`);
      await job(source, `dream:synth:/old/root/${legacy.name}:${legacy.hash16}`);
      await archived(source, v2Key(source, pruned.name, pruned.hash16));
      await job(source, v2Key(`${source}/${incarnation}`, current.name, current.hash16));
      for (const t of [single, chunked, pruned]) await output(source, t.filePath);
      await output(source, `/old/root/${legacy.name}`);
      const d = await dryRun(source);
      expect(d.synthesis_state).toEqual({ candidates: 1, already_synthesized: 5 });
      expect(d.triage.degraded).toBe(1);
    });
  }, 120_000);

  test('a pre-managed completion never counts unless this source holds its output', async () => {
    await withCorpus(async ({ write, addSource, job, archived, output, dryRun }) => {
      const source = await addSource();
      const other = await addSource();
      const noOutput = write('2026-09-11-no-output.txt');
      const outputElsewhere = write('2026-09-12-output-elsewhere.txt');
      const otherCompletion = write('2026-09-13-other-completion.txt');
      const deletedOutput = write('2026-09-14-deleted-output.txt');
      const userPage = write('2026-09-15-user-page.txt');
      const oldIncarnation = write('2026-09-16-old-incarnation.txt');
      await job(source, v2Key(source, noOutput.name, noOutput.hash16));
      await job(source, v2Key(source, outputElsewhere.name, outputElsewhere.hash16));
      await output(other, outputElsewhere.filePath);
      await job(other, v2Key(other, otherCompletion.name, otherCompletion.hash16));
      await job(other, `dream:synth:${otherCompletion.filePath}:${otherCompletion.hash16}`);
      await archived(other, v2Key(other, otherCompletion.name, otherCompletion.hash16));
      await output(source, otherCompletion.filePath);
      await job(source, v2Key(source, deletedOutput.name, deletedOutput.hash16));
      await output(source, deletedOutput.filePath, { deleted: true });
      await job(source, v2Key(source, userPage.name, userPage.hash16));
      await output(source, userPage.filePath, { dreamGenerated: false });
      await job(source, v2Key(`${source}/${randomUUID()}`, oldIncarnation.name, oldIncarnation.hash16));
      await output(source, oldIncarnation.filePath);
      const d = await dryRun(source);
      expect(d.synthesis_state).toEqual({ candidates: 6, already_synthesized: 0 });
      expect(d.triage.degraded).toBe(6);
    });
  }, 120_000);

  test('completions of a removed source do not carry over to a source re-added under the same id', async () => {
    await withCorpus(async ({ engine, write, addSource, job, archived, output, dryRun }) => {
      const source = await addSource();
      const t = write('2026-09-21-recreated.txt');
      await job(source, v2Key(source, t.name, t.hash16));
      await job(source, `dream:synth:${t.filePath}:${t.hash16}`);
      await archived(source, v2Key(source, t.name, t.hash16));
      await output(source, t.filePath);
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [source]);
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [source]);
      const d = await dryRun(source);
      expect(d.synthesis_state).toEqual({ candidates: 1, already_synthesized: 0 });
      expect(d.triage.degraded).toBe(1);
    });
  }, 120_000);
});

test('#6924 a managed run skips a transcript the classic runs synthesized and submits nothing for it', async () => {
  await managedSynthesisFixture(engines, async ({ engine, sourceId, opts, calls }) => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const classic = await runPhaseSynthesize(engine, opts);
    expect(classic.status).toBe('ok');
    expect(classic.details.pages_written).toBe(1);
    const [page] = await engine.executeRaw<{ raw_source: string }>(
      "SELECT frontmatter->>'raw_source' AS raw_source FROM pages WHERE source_id=$1 AND frontmatter->>'dream_generated'='true' AND slug LIKE 'wiki/personal/reflections/%'", [sourceId]);
    expect(page.raw_source).toBe(opts.inputFile);
    const spent = calls();
    const jobsBefore = await engine.executeRaw('SELECT id FROM minion_jobs ORDER BY id');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const managed = await runPhaseSynthesize(engine, opts);
    expect(managed.status).toBe('ok');
    expect(managed.details.synthesis_state).toEqual({ candidates: 0, already_synthesized: 1 });
    expect(managed.details.skips).toEqual([{ filePath: opts.inputFile, reason: 'already_synthesized_v2_single_chunk' }]);
    expect(managed.details.children_submitted).toBe(0);
    expect(calls()).toBe(spent);
    expect(await engine.executeRaw('SELECT id FROM minion_jobs ORDER BY id')).toEqual(jobsBefore);
  });
}, 240_000);
