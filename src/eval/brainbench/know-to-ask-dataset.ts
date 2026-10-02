/**
 * `gbrain decide dataset --slot recall_needed --from know-to-ask <dir>`: S6
 * labelled items from BrainBench know-to-ask gold turns. `<dir>` holds
 * `fixtures/` and `gold/` (the committed corpus is `evals/brainbench`).
 *
 * Each gold user turn becomes one item: state = the prompt plus the turn
 * before it, label = gold `should_retrieve`. The builder seeds each fixture
 * into an in-memory brain and replays the shipped reflex path
 * (assembleTurnContext with every decide slot off, the hook's 4-turn window,
 * cross-turn dedupe on its own prior blocks) so the item records what the
 * reflex did on that turn: `slice` reflex:fired / reflex:silent and
 * `protected` for an identity hit (alias or exact title). The S6 reducer needs
 * both to decide suppression, so qualification sees production's actions.
 *
 * Families: one item per turn (one request each, the production shape); the
 * calibrate/eval split is by fixture (conversation), so turns of one
 * conversation never straddle the halves. Holdout fixtures are skipped.
 */
import { join } from 'node:path';
import { stableSplit, type DatasetItem } from '../../core/ai/decide/dataset.ts';
import { recallReflex, REFLEX_FIRED_SLICE, REFLEX_SILENT_SLICE } from '../../core/ai/decide/recall-needed.ts';
import type { DecideSlot } from '../../core/ai/decide/types.ts';
import { assembleTurnContext } from '../../core/context/turn-context.ts';
import { createBenchmarkBrain, resetTables } from '../longmemeval/harness.ts';
import { loadCorpus } from './fixtures.ts';
import { seedBrain } from './seed.ts';

/** The hook's transcript window (commands/hook.ts USER_PROMPT_WINDOW_TURNS) before the prompt. */
const HOOK_WINDOW_TURNS = 4;

export async function buildKnowToAskDataset(
  path: string,
  opts: { slot: DecideSlot; calibrateShare?: number },
): Promise<DatasetItem[]> {
  const corpus = await loadCorpus(join(path, 'fixtures'), join(path, 'gold'));
  const engine = await createBenchmarkBrain();
  const items: DatasetItem[] = [];
  try {
    for (const { fixture, gold } of corpus.fixtures) {
      if (fixture.holdout || !fixture.suites.includes('know-to-ask')) continue;
      await resetTables(engine);
      await seedBrain(engine, fixture);
      const sourceId = fixture.active_source ?? 'default';
      const split = stableSplit(fixture.fixture_id, opts.calibrateShare);
      const priorBlocks: string[] = [];
      for (let i = 0; i < fixture.turns.length; i++) {
        const turn = fixture.turns[i]!;
        if (turn.role !== 'user') continue;
        const window = fixture.turns.slice(Math.max(0, i - HOOK_WINDOW_TURNS), i + 1).map((t) => ({ role: t.role, text: t.text }));
        const reflex = await assembleTurnContext(engine, {
          sourceId, window, ...(priorBlocks.length ? { priorContextText: priorBlocks.join('\n\n') } : {}),
        });
        if (reflex.text) priorBlocks.push(reflex.text);
        const g = gold.turns[String(turn.turn_id)];
        if (!g) continue;
        const observed = recallReflex([...reflex.pointers, ...(reflex.volunteered ?? [])]);
        const previous = fixture.turns[i - 1];
        items.push({
          id: `${fixture.fixture_id}#${turn.turn_id}`,
          family: `${fixture.fixture_id}#${turn.turn_id}`,
          slot: opts.slot,
          split,
          slice: observed.fired ? REFLEX_FIRED_SLICE : REFLEX_SILENT_SLICE,
          state: { prompt: turn.text, ...(previous ? { last_turn: previous.text } : {}) },
          inputs: {},
          label: g.should_retrieve,
          ...(observed.identityHit ? { protected: true } : {}),
        });
      }
    }
  } finally {
    await engine.disconnect();
  }
  return items;
}
