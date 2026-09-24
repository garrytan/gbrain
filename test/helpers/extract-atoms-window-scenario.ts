/**
 * Engine-agnostic scenario for the `dream --drain --window` checkpoint: the
 * window must be enforced BETWEEN ITEMS inside a batch, not only between
 * batches. Driven through the production wiring (`runExtractAtomsDrainForSource`:
 * real cycle lock, real discovery, real backlog count, real phase) with a
 * fake clock that advances one minute per LLM call, so a batch of three pages
 * against a 90s window must stop after two items instead of running all three.
 *
 * Shared by the PGLite unit test and the Postgres e2e test so both engines
 * pin the same contract.
 */
import { expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';
import { runExtractAtomsDrainForSource } from '../../src/core/cycle/extract-atoms-drain.ts';
import { countExtractAtomsBacklog } from '../../src/core/cycle/extract-atoms.ts';

export const WINDOW_SCENARIO_SLUGS = [
  'meetings/window-example-a',
  'meetings/window-example-b',
  'meetings/window-example-c',
];

const ITEM_MS = 60_000;
const WINDOW_SECONDS = 90;

export async function seedWindowScenarioPages(engine: BrainEngine): Promise<void> {
  for (const slug of WINDOW_SCENARIO_SLUGS) {
    const body = `Synthetic evidence for ${slug} with enough source detail for extraction. `.repeat(20);
    await engine.putPage(slug, { title: slug, type: 'meeting', compiled_truth: body, timeline: '' });
  }
}

/** One atom per call, titled from the item's `Source:` label so slugs never collide. */
function makeClockedChat(clock: { t: number; calls: number }) {
  return async (o: ChatOpts): Promise<ChatResult> => {
    clock.calls++;
    clock.t += ITEM_MS; // each item takes a simulated minute
    const content = String((o.messages[0] as { content: unknown }).content);
    const label = /^Source: (\S+)/.exec(content)?.[1] ?? `item-${clock.calls}`;
    const text = JSON.stringify([{
      title: `Window lesson ${label.split('/').pop()}`,
      atom_type: 'insight',
      body: 'A bounded run should stop between items when its window elapses.',
    }]);
    return {
      text,
      blocks: [{ type: 'text', text }],
      stopReason: 'end',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-haiku-4-5',
      providerId: 'anthropic',
    };
  };
}

async function atomCount(engine: BrainEngine): Promise<number> {
  const rows = await engine.executeRaw<{ n: number | string }>(
    `SELECT count(*) AS n FROM pages WHERE type = 'atom' AND source_id = 'default' AND deleted_at IS NULL`,
  );
  return Number(rows[0]?.n ?? 0);
}

export async function assertWindowCheckpointScenario(engine: BrainEngine): Promise<void> {
  await seedWindowScenarioPages(engine);
  expect(await countExtractAtomsBacklog(engine, 'default')).toBe(3);

  // Run 1: the window elapses mid-batch.
  const clock = { t: 0, calls: 0 };
  const first = await runExtractAtomsDrainForSource(engine, {
    sourceId: undefined,
    windowSeconds: WINDOW_SECONDS,
    _now: () => clock.t,
    _phase: { _chat: makeClockedChat(clock), _transcripts: [] },
  });

  // Bounded: at most one in-flight item past the window, never the whole batch.
  expect(clock.t).toBeLessThanOrEqual(WINDOW_SECONDS * 1000 + ITEM_MS);
  expect(clock.calls).toBe(2);
  expect(first).toMatchObject({
    status: 'ok',
    stopped: 'window',
    batches: 1,
    extracted: 2,
    items_completed: 2,
    items_deferred: 1,
    remaining: 1,
    failure_count: 0,
  });
  // Persisted work is kept, deferred work stays due.
  expect(await atomCount(engine)).toBe(2);
  expect(await countExtractAtomsBacklog(engine, 'default')).toBe(1);

  // Run 2: an ample window finishes ONLY the deferred item — no rollback,
  // no re-extraction of completed pages, no double counting.
  const clock2 = { t: 0, calls: 0 };
  const second = await runExtractAtomsDrainForSource(engine, {
    sourceId: undefined,
    windowSeconds: 3600,
    _now: () => clock2.t,
    _phase: { _chat: makeClockedChat(clock2), _transcripts: [] },
  });
  expect(clock2.calls).toBe(1);
  expect(second).toMatchObject({
    stopped: 'drained',
    extracted: 1,
    items_completed: 1,
    items_deferred: 0,
    remaining: 0,
  });
  expect(await atomCount(engine)).toBe(3);
}

/**
 * Transcript deferral: transcripts are not in the page backlog count. A window
 * cut after the batch's only page (work order is page-first) defers both
 * transcripts and leaves `remaining` at 0. The drain must still report
 * stopped=window with the deferred items, never drained.
 */
export async function assertTranscriptDeferralScenario(engine: BrainEngine): Promise<void> {
  const slug = WINDOW_SCENARIO_SLUGS[0]!;
  await engine.putPage(slug, {
    title: slug, type: 'meeting', timeline: '',
    compiled_truth: `Synthetic evidence for ${slug} with enough source detail for extraction. `.repeat(20),
  });
  expect(await countExtractAtomsBacklog(engine, 'default')).toBe(1);
  const transcripts = ['a', 'b'].map(n => ({
    filePath: `/tmp/window-example-transcript-${n}.txt`,
    content: `Synthetic transcript ${n} with enough detail for extraction. `.repeat(20),
    contentHash: n.repeat(64),
  }));
  const clock = { t: 0, calls: 0 };
  const result = await runExtractAtomsDrainForSource(engine, {
    sourceId: undefined,
    windowSeconds: 30, // the page's simulated minute crosses the window
    _now: () => clock.t,
    _phase: { _chat: makeClockedChat(clock), _transcripts: transcripts },
  });
  expect(clock.calls).toBe(1);
  expect(result).toMatchObject({
    status: 'ok',
    stopped: 'window',
    remaining: 0, // the page backlog is empty; the transcripts are not counted there
    extracted: 1,
    items_completed: 1,
    items_deferred: 2,
    failure_count: 0,
  });
  expect(await atomCount(engine)).toBe(1);
  expect(await countExtractAtomsBacklog(engine, 'default')).toBe(0);
}
