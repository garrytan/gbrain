/**
 * access/labelled-only.ts labelledOnlyFor fails closed (authoring gate, docs/TESTING.md#authoring-gate):
 *  - Contract: a refused or failed member or owner read answers true (only narrows, never admits); no member identity
 *    answers false without reading.
 *  - Regression: a failure that answered false would let a labelled-only member read unlabelled pages.
 *  - Seam: an engine stub with the two typed members it reads.
 */
import { expect, test } from 'bun:test';
import { labelledOnlyFor } from '../src/core/access/labelled-only.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const refused = async (): Promise<never> => { throw Object.assign(new Error('not served'), { code: 'engine_capability_missing' }); };
const rows = async () => [{ id: 'alice-example', labelled_only: false }] as never;
const engine = (over: Partial<Pick<BrainEngine, 'readAccessMembers' | 'getConfig'>>) => ({ readAccessMembers: rows, getConfig: async () => null, ...over });

test('labelledOnlyFor counts a refused or failed read as labelled-only and reads nothing for no member', async () => {
  expect(await labelledOnlyFor(engine({}), [['member:alice-example']])).toBe(false);
  expect(await labelledOnlyFor(engine({ readAccessMembers: refused }), [['member:alice-example']])).toBe(true);
  expect(await labelledOnlyFor(engine({ readAccessMembers: async () => { throw new Error('io'); } }), [['member:alice-example']])).toBe(true);
  expect(await labelledOnlyFor(engine({ getConfig: refused }), [['member:alice-example']])).toBe(true);
  expect(await labelledOnlyFor(engine({ readAccessMembers: refused, getConfig: refused }), [['group:team-a']])).toBe(false);
});

test('labelledOnlyFor reads removed members, exempts a padded owner, and fails closed when the owner changes mid-read', async () => {
  const carol = async (by: unknown) => [{ id: 'carol-example', labelled_only: (by as { includeRemoved?: boolean }).includeRemoved === true }] as never;
  expect(await labelledOnlyFor(engine({ readAccessMembers: carol }), [['member:carol-example']])).toBe(true);
  expect(await labelledOnlyFor(engine({ readAccessMembers: carol, getConfig: async () => '  carol-example  ' }), [['member:carol-example']])).toBe(false);
  let n = 0; // the owner changes from bob to alice between the two owner reads
  expect(await labelledOnlyFor(engine({ readAccessMembers: rows, getConfig: async () => (n++ ? 'alice-example' : 'bob-example') }), [['member:alice-example']])).toBe(true);
});
