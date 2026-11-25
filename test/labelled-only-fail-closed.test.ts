/**
 * access/labelled-only.ts labelledOnlyFor fails closed (authoring gate, docs/TESTING.md#authoring-gate):
 *  - Contract: a refusal from the typed member surfaces (engine_capability_missing), any other failed read answers true
 *    (only narrows, never admits); no member identity answers false without reading.
 *  - Regression: a failure that answered false would let a labelled-only member read unlabelled pages.
 *  - Seam: an engine stub with the one typed member it calls (hasLabelledOnlyMemberAmong), failing at the member, never at SQL text.
 */
import { expect, test } from 'bun:test';
import { labelledOnlyFor } from '../src/core/access/labelled-only.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const refused = async (): Promise<never> => { throw Object.assign(new Error('not served'), { code: 'engine_capability_missing' }); };
const engine = (among: BrainEngine['hasLabelledOnlyMemberAmong']) => ({ hasLabelledOnlyMemberAmong: among });

test('labelledOnlyFor surfaces a refusal, counts another failed read as labelled-only, and reads nothing for no member', async () => {
  expect(await labelledOnlyFor(engine(async () => false), [['member:alice-example']])).toBe(false);
  expect(await labelledOnlyFor(engine(async () => true), [['member:alice-example']])).toBe(true);
  await expect(labelledOnlyFor(engine(refused), [['member:alice-example']])).rejects.toMatchObject({ code: 'engine_capability_missing' });
  expect(await labelledOnlyFor(engine(async () => { throw new Error('io'); }), [['member:alice-example']])).toBe(true);
  expect(await labelledOnlyFor(engine(refused), [['group:team-a']])).toBe(false);
});
