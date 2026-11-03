/**
 * #7870: the start of every managed extract_atoms run resumes generation
 * members a crash left pending (`resumeManagedGenerationMembers`). A
 * generation planned before #7851 may have extracted another source's session
 * transcript into the run's source; resuming its members resubmitted them
 * with no routing check, so the re-run overwrote or retired atoms on that
 * session's behalf. Now a transcript-derived member whose session no longer
 * resolves to the run's source (#6268) is held: not resubmitted, its atom page
 * left exactly as it is (moving misplaced atoms is #7845), and counted in the
 * phase's `details.source_routing.generation_members_held`. A member of the
 * run's own session source still resumes.
 *
 * Managed brain, PGLite and, with DATABASE_URL, Postgres.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChatResult } from '../src/core/ai/gateway.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { ensureCorpusSpoolDir, sessionCorpusFileName } from '../src/core/context/corpus-segments.ts';
import { disposePersistenceConsumer, waitForWrites } from '../src/core/persistence/service.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { listPendingMembers } from '../src/core/generations/managed.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const body = (label: string) => (label + ': the team ships small changes, measures each launch and reviews outcomes weekly. ').repeat(12);

function stub(titles: string[]) {
  return async (): Promise<ChatResult> => {
    const text = JSON.stringify(titles.map(title => ({ title, body: title + '.', atom_type: 'insight' })));
    return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
  };
}

/** A pre-#7851 run: the session transcript reaches the phase through the seam, unrouted. */
async function extractUnrouted(engine: BrainEngine, filePath: string, label: string, titles: string[]): Promise<void> {
  const content = body(label);
  writeFileSync(filePath, content);
  await runPhaseExtractAtoms(engine, { sourceId: 'default', _pages: [], _chat: stub(titles),
    _transcripts: [{ filePath, content, contentHash: sha256(content) }] });
  await disposePersistenceConsumer(engine);
}

async function drain(engine: BrainEngine): Promise<void> {
  const pending = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id='default' AND state IN ('queued','running','recovering')");
  await waitForWrites(engine, pending, { engine: engine.kind } as GBrainConfig, 60_000);
  await disposePersistenceConsumer(engine);
}

const atoms = (engine: BrainEngine) => engine.executeRaw<{ slug: string; live: boolean; retired_by: string | null }>(
  "SELECT slug, deleted_at IS NULL AS live, frontmatter->>'retired_by' AS retired_by FROM pages WHERE source_id='default' AND type='atom' ORDER BY slug");

/** Two unrouted extractions of one session file, the second crashing after its activation: its retire members stay pending. */
async function crashedGeneration(engine: BrainEngine, filePath: string): Promise<string[]> {
  await extractUnrouted(engine, filePath, 'first', ['Ship small changes', 'Review outcomes weekly', 'Measure each launch', 'Pair on reviews']);
  await settleManagedGitEffects(engine);
  const retiring = (await atoms(engine)).filter(row => /measure-each-launch|pair-on-reviews/.test(row.slug)).map(row => row.slug).sort();
  expect(retiring).toHaveLength(2);
  let crashes = 0;
  installFaultHook(async point => { if (point === 'generation:member') { crashes++; throw new OperationError('revision_conflict', 'Simulated crash: the member request never landed.', 'Run the atom drain again.'); } });
  try { await extractUnrouted(engine, filePath, 'second', ['Ship small changes', 'Review outcomes weekly', 'Track error budgets']).catch(() => undefined); await drain(engine); }
  finally { installFaultHook(undefined); }
  expect(crashes).toBeGreaterThan(0);
  expect((await listPendingMembers(engine, ['default'], 'atom')).filter(row => row.action === 'retire').map(row => row.slug).sort()).toEqual(retiring);
  return retiring;
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`#7870 resumed generation members honor the session source (${backend})`, () => {
    test('a pending member of another source\'s session is held, never resubmitted; its atom stays live', async () => {
      await managedBrain(async ({ engine, root }) => {
        const corpus = join(dirname(root), 'corpus');
        mkdirSync(corpus);
        await engine.setConfig('dream.synthesize.session_corpus_dir', corpus);
        const loadConfig = () => ({ dream: { synthesize: { session_corpus_dir: corpus } } }) as unknown as GBrainConfig;
        const retiring = await crashedGeneration(engine, join(ensureCorpusSpoolDir(corpus), sessionCorpusFileName('sess-other', 'source-b')));
        const pending = (await listPendingMembers(engine, ['default'], 'atom')).map(row => [row.slug, row.action]);
        expect(pending.length).toBeGreaterThan(retiring.length);

        const results = [];
        for (let run = 0; run < 2; run++) {
          results.push(await runPhaseExtractAtoms(engine, { sourceId: 'default', _pages: [], _transcripts: [], _loadConfig: loadConfig, _chat: stub([]) }));
          await disposePersistenceConsumer(engine);
        }
        const after = await atoms(engine);
        for (const slug of retiring) expect(after.find(row => row.slug === slug)).toMatchObject({ live: true, retired_by: null });
        expect(await engine.executeRaw("SELECT slug FROM persistence_requests WHERE source_id='default' AND intent->>'kind'='managed_atom_delete' AND state='committed'")).toEqual([]);
        expect((await listPendingMembers(engine, ['default'], 'atom')).map(row => [row.slug, row.action])).toEqual(pending);
        for (const result of results) {
          expect(result.details.source_routing).toMatchObject({ source_id: 'default', generation_members_held: { corpus_source_other: pending.length } });
          expect(result.summary).toContain(`${pending.length} pending generation member(s) held`);
        }
      }, { databaseUrl, setup: ({ engine }) => engine.executeRaw("INSERT INTO sources(id,name) VALUES('source-b','source-b')").then(() => undefined) });
    }, 240_000);

    test('a pending member of the run\'s own session source still resumes', async () => {
      await managedBrain(async ({ engine, root }) => {
        const corpus = join(dirname(root), 'corpus');
        mkdirSync(corpus);
        await engine.setConfig('dream.synthesize.session_corpus_dir', corpus);
        const loadConfig = () => ({ dream: { synthesize: { session_corpus_dir: corpus } } }) as unknown as GBrainConfig;
        const retiring = await crashedGeneration(engine, join(ensureCorpusSpoolDir(corpus), sessionCorpusFileName('sess-own', 'default')));
        const result = await runPhaseExtractAtoms(engine, { sourceId: 'default', _pages: [], _transcripts: [], _loadConfig: loadConfig, _chat: stub([]) });
        await disposePersistenceConsumer(engine);
        expect(result.details.source_routing).toBeUndefined();
        const after = await atoms(engine);
        for (const slug of retiring) expect(after.find(row => row.slug === slug)).toMatchObject({ live: false, retired_by: 'managed-reextract' });
        expect(await listPendingMembers(engine, ['default'], 'atom')).toEqual([]);
      }, { databaseUrl });
    }, 240_000);
  });
}
