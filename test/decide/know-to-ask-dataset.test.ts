/**
 * `gbrain decide dataset --slot recall_needed --from know-to-ask <dir>` over
 * two committed BrainBench fixtures (copied to a temp corpus dir).
 *
 * Protects: one item per gold user turn with the gold label, the reflex state
 * replayed through the shipped path (a named-entity prompt records
 * reflex:fired with an identity hit, a chatter turn reflex:silent), state is
 * prompt plus the previous turn, the split is by fixture, and the output
 * round-trips through the dataset parser and the S6 adapter.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { datasetAdapter, datasetBuilder, parseDatasetJsonl, stableSplit, toJsonl } from '../../src/core/ai/decide/dataset.ts';
import '../../src/core/ai/decide/recall-needed.ts';

const corpus = join(import.meta.dir, '../../evals/brainbench');
const dir = mkdtempSync(join(tmpdir(), 'gbrain-kta-dataset-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('know-to-ask dataset builder', () => {
  test('labels, reflex slices, state shape and per-fixture split', async () => {
    mkdirSync(join(dir, 'fixtures'));
    mkdirSync(join(dir, 'gold'));
    for (const id of ['gen-kta-pos-001', 'gen-kta-neg-001']) {
      copyFileSync(join(corpus, 'fixtures', `${id}.fixture.json`), join(dir, 'fixtures', `${id}.fixture.json`));
      copyFileSync(join(corpus, 'gold', `${id}.gold.json`), join(dir, 'gold', `${id}.gold.json`));
    }
    const items = await datasetBuilder('know-to-ask')!(dir, { slot: 'recall_needed' });
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(Object.keys(byId).sort()).toEqual(['gen-kta-neg-001#1', 'gen-kta-neg-001#3', 'gen-kta-pos-001#1', 'gen-kta-pos-001#3']);

    const named = byId['gen-kta-pos-001#1']!;
    expect(named).toMatchObject({ slot: 'recall_needed', family: 'gen-kta-pos-001#1', label: true, slice: 'reflex:fired', protected: true, inputs: {} });
    expect(Object.keys(named.state)).toEqual(['prompt']);
    expect(named.state.prompt).toContain('Alarico Marrowfield');

    const chatter = byId['gen-kta-pos-001#3']!;
    expect(chatter).toMatchObject({ label: false, slice: 'reflex:silent' });
    expect(chatter.protected).toBeUndefined();
    expect(chatter.state.last_turn).toBe('Here is what I have.');

    for (const it of items) expect(it.split).toBe(stableSplit(it.id.split('#')[0]!));

    const parsed = parseDatasetJsonl(toJsonl(items));
    const req = datasetAdapter('recall_needed')!.request([parsed.find((i) => i.id === chatter.id)!]);
    expect(Object.keys(req.state)).toEqual(['prompt', 'last_turn']);
  }, 60_000);
});
