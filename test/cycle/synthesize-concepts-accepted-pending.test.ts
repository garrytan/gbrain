/**
 * #7547: a concept publication the owner accepted but has not committed by the
 * end of its wait is progress, not a phase failure.
 *
 * Protects: synthesize_concepts on a managed brain records the accepted,
 * still-pending publication (`details.publication_pending`, status warn, no
 * completed round, no halt) instead of throwing `write_pending` and failing
 * the phase; the write keeps its request, commits later, and the next run
 * reuses it without a model call.
 * Fails when: the phase rethrows `write_pending` (or reports the concept
 * written before it commits).
 * Why new: managed-phase-matrix covers a publication that commits within the wait only.
 */
import { afterEach, expect, test } from 'bun:test';
import type { ChatResult } from '../../src/core/ai/gateway.ts';
import { runPhaseSynthesizeConcepts } from '../../src/core/cycle/synthesize-concepts.ts';
import { __setMaintenanceWriteWaitForTests } from '../../src/core/persistence/maintenance-wait.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { waitForWrite } from '../../src/core/persistence/service.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';
import { managedBrain } from '../helpers/managed-brain.ts';
import { testWaitMs } from '../helpers/wait-for.ts';

const MODEL = 'anthropic:claude-sonnet-4-6';
const CONCEPT = 'concepts/storage-example';
const ATOMS = [0, 1, 2, 3, 4].map(i => ({ slug: `atoms/storage-${i}`, concept_refs: [CONCEPT], body: `Atom ${i} about storage.`, title: `storage atom ${i}` }));

afterEach(() => { installFaultHook(undefined); });

test('#7547: a concept publication still pending after its wait is recorded as pending, commits later, and is not re-bought', async () => {
  await managedBrain(async ({ engine, root }) => {
    await engine.setConfig('models.dream.synthesize', MODEL);
    let calls = 0;
    const chat = async (): Promise<ChatResult> => {
      calls++;
      const text = 'A complete narrative about this concept.';
      return { text, blocks: [{ type: 'text', text }], stopReason: 'end', usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: MODEL, providerId: 'anthropic' };
    };
    const run = () => runPhaseSynthesizeConcepts(engine, { _atoms: ATOMS, _chat: chat, brainDir: root });

    let release!: () => void;
    const stalled = new Promise<void>(resolve => { release = resolve; });
    installFaultHook(async point => { if (point === 'consumer:prepared') await stalled; });
    const restore = __setMaintenanceWriteWaitForTests(testWaitMs(300));
    try {
      const first = await run();
      expect(first.status).toBe('warn');
      expect(first.details).toMatchObject({ concepts_written: 0, failures: [] });
      expect((first.details.publication_pending as Array<{ concept: string; reason: string }>).map(p => [p.concept, p.reason.split(':')[0]]))
        .toEqual([['storage-example', 'write_pending']]);
      const [rollup] = await engine.executeRaw<{ rounds: number; halts: number }>(
        "SELECT COALESCE(sum(round_completed_count),0)::int AS rounds, COALESCE(sum(halt_count),0)::int AS halts FROM extract_rollup_7d WHERE kind='concepts'");
      expect(rollup).toEqual({ rounds: 0, halts: 0 });
    } finally { release(); restore(); }

    const open = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id='default' AND state NOT IN ('committed','failed','cancelled')");
    expect(open.length).toBeGreaterThan(0);
    for (const row of open) expect((await waitForWrite(engine, row, { engine: engine.kind }, testWaitMs(20_000))).state).toBe('committed');
    expect((await engine.getPage(CONCEPT, { sourceId: 'default' }))?.frontmatter?.synthesis_mode).toBe('llm');

    const second = await run();
    expect(calls).toBe(1);
    expect(second.details.skipped_unchanged).toEqual([CONCEPT]);
    expect(second.details.provenance_restored).toEqual([CONCEPT]);
  }, { setup: async ({ engine }) => {
    for (const atom of ATOMS) await engine.putPage(atom.slug, { type: 'note', title: atom.title, compiled_truth: atom.body, timeline: '', frontmatter: {} });
  } });
}, 120_000);
