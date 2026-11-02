/**
 * #7869: an explicit managed atom retry (`gbrain jobs submit extract-atoms-drain
 * --params '{"retryRequestId": …}'`) re-checks a transcript item's session
 * source before it starts anything. A batch that failed before #7851 may hold
 * another source's session transcript, extracted into the run's source; the
 * retry passed it to the phase through the `_transcripts` seam, which skips
 * `keepSessionSourceTranscripts`, so the rerun wrote that session's atoms into
 * the request's source. Now a transcript that does not resolve to the retry's
 * source (#6268: stamp, frozen record, tier-4 cwd) is refused with
 * `transcript_source_mismatch`: no model call, no write. A session of the
 * retry's own source still retries.
 *
 * Managed brain, PGLite and, with DATABASE_URL, Postgres.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { __setChatTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { CORPUS_UNRESOLVED_STAMP, ensureCorpusSpoolDir, sessionCorpusFileName } from '../src/core/context/corpus-segments.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { retryManagedAtomBatch } from '../src/core/persistence/atom-retry.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const VALID = JSON.stringify([{ title: 'Measured progress', atom_type: 'insight', body: 'Measure progress against clear exit criteria.' }]);
const TEXT = 'A careful session transcript about measured progress. '.repeat(40);

function reply(text: string): ChatResult {
  return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
    usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
}

/** A pre-#7851 run: the transcript reaches the phase through the seam, unrouted, and the model reply is malformed. */
async function failedBatch(engine: BrainEngine, filePath: string): Promise<string> {
  writeFileSync(filePath, TEXT);
  const result = await runPhaseExtractAtoms(engine, { sourceId: 'default', _pages: [],
    _transcripts: [{ filePath, content: TEXT, contentHash: sha256(TEXT) }], _chat: async () => reply('not valid output') });
  expect(result.details.malformed_outputs).toBe(1);
  await disposePersistenceConsumer(engine);
  const [row] = await engine.executeRaw<{ request_id: string }>(
    `SELECT completed_keys->0->>'requestId' AS request_id FROM op_checkpoints WHERE op='managed-atoms' AND completed_keys->0->>'failure' IS NOT NULL
      AND completed_keys::text LIKE '%' || $1 || '%' ORDER BY updated_at DESC LIMIT 1`, [filePath.split('/').pop()]);
  expect(row?.request_id).toBeTruthy();
  return row!.request_id;
}

const atoms = (engine: BrainEngine) => engine.executeRaw<{ source_id: string; slug: string }>(
  "SELECT source_id, slug FROM pages WHERE type='atom' AND deleted_at IS NULL ORDER BY slug");

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`#7869 explicit atom retry honors the session source (${backend})`, () => {
    test('a failed batch of another source\'s session, or of an unresolved one, is refused; nothing starts', async () => {
      await managedBrain(async ({ engine, root }) => {
        const corpus = join(dirname(root), 'corpus');
        mkdirSync(corpus);
        await engine.setConfig('dream.synthesize.session_corpus_dir', corpus);
        const spool = ensureCorpusSpoolDir(corpus);
        let calls = 0;
        __setChatTransportForTests(async () => { calls++; return reply(VALID); });
        try {
          for (const [file, reason] of [
            [join(spool, sessionCorpusFileName('sess-other', 'source-b')), 'corpus_source_other'],
            [join(spool, sessionCorpusFileName('sess-unresolved', CORPUS_UNRESOLVED_STAMP)), 'corpus_source_unresolved'],
          ] as const) {
            const requestId = await failedBatch(engine, file);
            const error = await retryManagedAtomBatch(engine, 'default', requestId, `job:7869-${reason}`).catch(e => e);
            expect(error).toMatchObject({ code: 'transcript_source_mismatch', reason });
            expect(String(error.message)).toContain('nothing was started');
            expect(calls).toBe(0);
            expect(await atoms(engine)).toEqual([]);
          }
        } finally { __setChatTransportForTests(null); }
      }, { databaseUrl, setup: ({ engine }) => engine.executeRaw("INSERT INTO sources(id,name) VALUES('source-b','source-b')").then(() => undefined) });
    }, 180_000);

    test('a failed batch of the retry\'s own session source still reruns and extracts', async () => {
      await managedBrain(async ({ engine, root }) => {
        const corpus = join(dirname(root), 'corpus');
        mkdirSync(corpus);
        await engine.setConfig('dream.synthesize.session_corpus_dir', corpus);
        const requestId = await failedBatch(engine, join(ensureCorpusSpoolDir(corpus), sessionCorpusFileName('sess-own', 'default')));
        let calls = 0;
        __setChatTransportForTests(async () => { calls++; return reply(VALID); });
        try {
          expect(await retryManagedAtomBatch(engine, 'default', requestId, 'job:7869-own')).toMatchObject({ model_rerun: true });
        } finally { __setChatTransportForTests(null); }
        expect(calls).toBe(1);
        expect((await atoms(engine)).map(row => row.source_id)).toEqual(['default']);
      }, { databaseUrl });
    }, 180_000);
  });
}
