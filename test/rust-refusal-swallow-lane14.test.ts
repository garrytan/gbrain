/**
 * The lane 14 swap blockers of the refusal-swallow triage (docs/research/rust-refusal-swallow-triage.tsv on
 * rust-engine/refusal-swallow-triage) that no parity case reaches cheaply: each site, run on an engine that refuses raw
 * SQL as the Rust engine does, now answers from a typed member or lets the capability refusal surface.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `config set search_embedding_column` still refuses a low-coverage column; doctor embedding_provider still
 *    names the chunk counts of a width drift; extract_atoms_backlog still lists the backlog per source; embedStalePages,
 *    prepareEmbeddingProjections and the frontmatter scan's page count refuse instead of skipping; the embed-backfill job
 *    still dead-letters a retry that meets the same blockers.
 *  - Regression: on the parent head each site caught the refusal and went on with a quiet default (the coverage gate
 *    warned and switched the column, the drift warn vanished, the per-source list was omitted, the embed calls reported
 *    0 with no error, the stall record was dropped so the job retried forever).
 *  - Why existing coverage misses it: their tests run on PGLite, where the raw statements succeed.
 *  - Seam: a real PGLite brain behind a Proxy whose executeRaw refuses with the Rust engine's refusal; for the per-page
 *    catches, one typed member refuses instead (nothing raw is left there).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { capabilityMissing, isCapabilityMissing } from '../src/core/rust-engine/errors.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { runConfig } from '../src/commands/config.ts';
import { embeddingProviderEntry } from '../src/commands/doctor/checks/embedding-health.ts';
import { computeExtractAtomsBacklogCheck } from '../src/commands/doctor/checks/extraction-sync.ts';
import { scanBrainSources } from '../src/core/brain-writer.ts';
import { embedStalePages } from '../src/core/embed-stale.ts';
import { prepareEmbeddingProjections } from '../src/core/embedding-readiness.ts';
import { makeEmbedBackfillHandler } from '../src/core/minions/handlers/embed-backfill.ts';
import { UnrecoverableError } from '../src/core/minions/errors.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';

let pglite: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-refusal-swallow-'));

beforeAll(async () => {
  pglite = new PGLiteEngine();
  await pglite.connect({});
  await pglite.initSchema();
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite' }));
}, 60_000);

afterAll(async () => {
  await pglite.disconnect();
  resetGateway();
  rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(pglite);
  resetGateway();
});

/** PGLite, except that executeRaw refuses as the Rust engine refuses raw SQL, and `refuse` members refuse too. */
function rustLike(refuse: readonly string[] = [], overrides: Record<string, unknown> = {}): BrainEngine {
  return new Proxy(pglite, {
    get(target, prop) {
      if (prop === 'executeRaw') return async () => { throw capabilityMissing('raw_sql', 'executeRaw'); };
      if (typeof prop === 'string' && refuse.includes(prop)) return async () => { throw capabilityMissing('pages', prop); };
      if (typeof prop === 'string' && prop in overrides) return overrides[prop];
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as BrainEngine;
}

async function unembeddedPage(slug: string): Promise<void> {
  await pglite.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body text`, timeline: '' });
  await installFixtureChunks(pglite, slug, [{ chunk_index: 0, chunk_text: `${slug} body text`, chunk_source: 'compiled_truth', token_count: 4 }]);
}

async function capture<T>(run: () => Promise<T>): Promise<{ errs: string[]; exit: number | null; error: unknown }> {
  const errs: string[] = [];
  let exit: number | null = null;
  const logSpy = spyOn(console, 'log').mockImplementation(() => {});
  const errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.join(' ')); });
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => { exit ??= code ?? 0; throw new Error(`EXIT:${code}`); }) as never);
  let error: unknown = null;
  try { await run(); } catch (e) { error = e; } finally { logSpy.mockRestore(); errSpy.mockRestore(); exitSpy.mockRestore(); }
  return { errs, exit, error };
}

describe('refusal-swallow swap blockers on an engine without raw SQL (lane 14)', () => {
  test('config.ts:1459: config set search_embedding_column refuses a low-coverage column from the typed coverage read', async () => {
    await unembeddedPage('notes/one');
    const out = await withEnv({ GBRAIN_HOME: home }, () => capture(() => runConfig(rustLike(), ['set', 'search_embedding_column', 'embedding'])));
    expect(out.errs.some(e => e.includes('does not support'))).toBe(false);
    expect(out.errs.some(e => e.includes('is 0.0% populated (1 total chunks)'))).toBe(true);
    expect(out.exit).toBe(1);
  });

  test('embedding-health.ts:95: embedding_provider names the chunk counts of a width drift from the typed coverage read', async () => {
    await unembeddedPage('notes/one');
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 768, env: { OPENAI_API_KEY: 'sk-test-fake' } });
    const checks = await withEnv({ GBRAIN_HOME: home }, () =>
      embeddingProviderEntry.run({ engine: rustLike(), args: [], progress: { heartbeat() {} } } as unknown as DoctorContext)) as Check[];
    const check = checks.find(c => c.name === 'embedding_provider');
    expect(check?.status).toBe('warn');
    expect(check?.message).toContain('Existing brain (1 chunks, 0 embedded)');
  });

  test('extraction-sync.ts:499: extract_atoms_backlog lists the backlog per source from the typed source roster', async () => {
    await pglite.putPage('notes/one', { type: 'note', title: 'One', compiled_truth: 'body', timeline: '' });
    const engine = rustLike([], { countAtomExtractionBacklog: async () => 20 });
    const check = await computeExtractAtomsBacklogCheck(engine);
    expect(check.status).toBe('warn');
    expect((check.details as { backlog_by_source?: unknown }).backlog_by_source).toEqual([{ source_id: 'default', backlog: 20 }]);
  });

  test('content-quality.ts:368: the frontmatter scan refuses when the engine cannot count a source\'s pages', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-fm-scan-'));
    try {
      writeFileSync(join(dir, 'one.md'), '---\ntitle: One\n---\nbody\n');
      await pglite.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', ['fm', dir, '{}']);
      const scan = scanBrainSources(rustLike(), {
        dbPageCountForSource: async () => { throw capabilityMissing('pages', 'countLivePagesInSource'); },
        frontmatterOnly: true,
      });
      const error = await scan.then(() => null, (e: unknown) => e);
      expect(isCapabilityMissing(error)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('embed-stale.ts:380: embedStalePages refuses when the engine cannot read the page, instead of reporting 0', async () => {
    await unembeddedPage('notes/one');
    const embedFn = async (texts: string[]) => texts.map(() => new Float32Array(1536).fill(0.1));
    const error = await embedStalePages(rustLike(['readLivePageIdBySlug']), ['notes/one'], 'default', { embedFn }).then(() => null, (e: unknown) => e);
    expect(isCapabilityMissing(error)).toBe(true);
  });

  test('embedding-readiness.ts:140: prepareEmbeddingProjections refuses when the engine cannot rebuild a page, instead of skipping it', async () => {
    const engine = rustLike(['readPageIsSegmented'], {
      countEmbedPendingProjections: async () => 1,
      listEmbedProjectionRepairPages: async (_scope: unknown, after: number) => after === 0 ? [{ id: 1, slug: 'notes/absent', source_id: 'default' }] : [],
    });
    const error = await prepareEmbeddingProjections(engine, { repair: true }).then(() => null, (e: unknown) => e);
    expect(isCapabilityMissing(error)).toBe(true);
  });

  test('embed-backfill.ts:393: a retry that meets the same blockers dead-letters, reading the stall record through getJob', async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test-fake' } });
    const [row] = await pglite.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, queue, data, submission_authority, claim_generation) VALUES ('embed-backfill', 'default', '{}'::jsonb, '{"kind":"local"}'::jsonb, 0) RETURNING id`);
    const jobId = Number(row!.id);
    const job = (attempts: number): MinionJobContext => {
      const controller = new AbortController();
      return {
        id: jobId, name: 'embed-backfill', data: { sourceId: 'default' }, attempts_made: attempts, idempotency_key: null,
        signal: controller.signal, deadlineAtMs: null, shutdownSignal: controller.signal,
        updateProgress: async (progress: unknown) => { await pglite.executeRaw('UPDATE minion_jobs SET progress = $1::text::jsonb WHERE id = $2', [JSON.stringify(progress), jobId]); },
        updateTokens: async () => {}, log: async () => {}, isActive: async () => true, readInbox: async () => [],
      };
    };
    const runStale = (async () => ({ embedded: 0, chunksProcessed: 0, pagesProcessed: 0, invalidated: 0, lastCursor: null, done: true, remaining: 3 })) as never;
    const first = await makeEmbedBackfillHandler(pglite, { runStale })(job(0)).then(() => null, (e: unknown) => e);
    expect(first).toBeInstanceOf(Error);
    expect(first).not.toBeInstanceOf(UnrecoverableError);
    const stall = (await pglite.getJob(jobId))?.progress as { stall?: { fingerprint?: string } } | null;
    expect(typeof stall?.stall?.fingerprint).toBe('string');
    const second = await makeEmbedBackfillHandler(rustLike(), { runStale })(job(1)).then(() => null, (e: unknown) => e);
    expect(second).toBeInstanceOf(UnrecoverableError);
  });
});
