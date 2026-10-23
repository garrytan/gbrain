/**
 * GBRA-161 PR 1a: a publication killed at any of its fault points leaves exactly one coherent generation.
 *
 * Protects: SIGKILL at `generation:published` or `generation:retired` (inside the activation transaction) leaves the old
 * generation live with every item, and the rerun activates the new one once; SIGKILL at `generation:activated` (after
 * commit) leaves the new generation live, and the rerun republishes nothing. No case leaves a held row, a second live
 * row or a retired item without its generation.
 * Fails when: any write of the publication commits outside the activation transaction, or a replay after commit writes again.
 * Seams: a real child process (test/fixtures/generation-crash-worker.ts) on disk PGLite, or a fresh Postgres database
 * when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { GENERATION_CRASH_POINTS, runGenerationCrashCase } from '../fixtures/generation-crash-worker.ts';
import { pathologicalArms } from './harness.ts';

const OLD = ['derived/a', 'derived/b', 'derived/c', 'derived/d'];
const NEW = ['derived/a', 'derived/b', 'derived/c'];

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`GBRA-161 generation publish survives SIGKILL (${backend})`, () => {
    for (const point of GENERATION_CRASH_POINTS) {
      test(`killed at ${point}`, async () => {
        const result = await runGenerationCrashCase({ kind: backend, point, databaseUrl });
        expect(result.killed_signal).toBe('SIGKILL');
        if (point === 'generation:activated') {
          expect(result.before).toEqual({ ledger: ['superseded:1', 'live:2'], live: NEW });
          expect({ rerun: result.rerun, generation: result.rerun_generation, again: result.again }).toEqual({ rerun: 'unchanged', generation: 2, again: 'unchanged' });
        } else {
          expect(result.before).toEqual({ ledger: ['live:1'], live: OLD });
          expect({ rerun: result.rerun, generation: result.rerun_generation, again: result.again }).toEqual({ rerun: 'published', generation: 2, again: 'unchanged' });
        }
        expect(result.after).toEqual({ ledger: ['superseded:1', 'live:2'], live: NEW, live_items: 4 });
      }, 240_000);
    }
  });
}
