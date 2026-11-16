/**
 * #7923: two extract_atoms runs of one origin under the same run key (a
 * force-evicted phase still running when the next run starts, or a manual
 * drain beside autopilot's cycle). Both see no accepted batch, both call the
 * model, and the one that admits second reuses the batch's deterministic
 * completion request id with a different intent (other children, possibly
 * another atom set). The journal refused that as idempotency_conflict, the
 * phase counted it as a hard failure and the round halted (item_error),
 * although the origin's atoms had just been published by the other run.
 * Now the second run finds the batch the first one admitted under its run
 * key and waits on it, so the round completes and nothing is admitted twice.
 *
 * Managed brain, PGLite and, with DATABASE_URL, Postgres. Synthetic data only.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChatResult } from '../src/core/ai/gateway.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { ensureCorpusSpoolDir, sessionCorpusFileName } from '../src/core/context/corpus-segments.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const body = (label: string) => (label + ': the team ships small changes, measures each launch and reviews outcomes weekly. ').repeat(12);

function reply(titles: string[]): ChatResult {
  const text = JSON.stringify(titles.map(title => ({ title, body: title + '.', atom_type: 'insight' })));
  return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
    usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`#7923 a second run of one origin waits on the batch the first admitted (${backend})`, () => {
    for (const [label, second] of [['a different atom set', ['Ship small changes', 'Measure each launch']], ['the same atom set', ['Ship small changes', 'Review outcomes weekly']]] as const) {
      test(`the run that admits second, with ${label}, completes instead of halting on idempotency_conflict`, async () => {
        await managedBrain(async ({ engine, root }) => {
          const corpus = join(dirname(root), 'corpus');
          mkdirSync(corpus);
          await engine.setConfig('dream.synthesize.session_corpus_dir', corpus);
          const filePath = join(ensureCorpusSpoolDir(corpus), sessionCorpusFileName('sess-a', 'default'));
          const content = body('race');
          writeFileSync(filePath, content);
          const transcripts = [{ filePath, content, contentHash: sha256(content) }];
          let first: Awaited<ReturnType<typeof runPhaseExtractAtoms>> | undefined;
          const outer = await runPhaseExtractAtoms(engine, { sourceId: 'default', _pages: [], _transcripts: transcripts,
            _chat: async () => {
              // The other run extracts and publishes this origin while this run waits on its model call.
              first = await runPhaseExtractAtoms(engine, { sourceId: 'default', _pages: [], _transcripts: transcripts,
                _chat: async () => reply(['Ship small changes', 'Review outcomes weekly']) });
              return reply([...second]);
            } });
          await disposePersistenceConsumer(engine);
          expect(first?.status).not.toBe('fail');
          expect(outer.details.failures).toEqual([]);
          expect(outer.status).toBe('ok');
          expect(outer.details.duplicates_skipped).toBe(1);
          const atoms = await engine.executeRaw<{ slug: string }>(
            "SELECT slug FROM pages WHERE source_id='default' AND type='atom' AND deleted_at IS NULL ORDER BY slug");
          expect(atoms.map(row => row.slug).filter(slug => /ship-small-changes|review-outcomes-weekly/.test(slug))).toHaveLength(2);
          expect(atoms.some(row => /measure-each-launch/.test(row.slug))).toBe(false);
        }, { databaseUrl });
      }, 240_000);
    }
  });
}
