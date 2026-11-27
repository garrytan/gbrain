/**
 * The shadow write comparison judges a putPage by its options (src/shadow/write-capture.ts). The Rust store takes
 * `contextualRetrieval` (store-members/pages.ts), so the list of options it takes names it. A write that stamps contextual
 * retrieval is compared: the replay carries the option and runs the stamp's later write (write-capture.ts STAMP); the
 * real-import cases in test/helpers/shadow-write-compare-scenarios.ts check the tally.
 *
 * Protects: the options list names every option the store takes; an option set with a contextual-retrieval stamp is
 * comparable like any other option set the store takes; a key the store does not take is not.
 * Fails when the list lacks a key the store takes, or a key the store refuses is judged comparable.
 * No engine: the Rust putPage member runs on a stand-in brain that records the call.
 */
import { expect, test } from 'bun:test';
import { STORE_MEMBERS } from '../src/core/rust-engine/store-members/index.ts';
import { isEngineCapabilityRefusal } from '../src/core/engine-capability-refusal.ts';
import { PUT_PAGE_OPTIONS, putPageOptionsComparable } from '../src/shadow/write-capture.ts';

/** Whether the Rust putPage member refuses `opts` with the typed capability refusal (the store's own option list), on a brain that records the call. */
async function storeRefusesOption(key: string): Promise<boolean> {
  const brain = { putPage: async () => ({}) } as never;
  const page = { type: 'note', title: 'Opt Example', compiled_truth: 'body' } as never;
  try { await STORE_MEMBERS.putPage(brain, 'people/opt-example', page, { [key]: true } as never); } catch (error) { return isEngineCapabilityRefusal(error); }
  return false;
}

test('the options list is the store\'s own, contextualRetrieval included', async () => {
  // Every option the list names is one the store takes (or ignores); a key it does not name is refused by the store.
  for (const key of PUT_PAGE_OPTIONS) expect(await storeRefusesOption(key), `${key} is on the list but the store refuses it`).toBe(false);
  for (const key of ['reuseSegments', 'somethingNew', 'prepare']) {
    expect(PUT_PAGE_OPTIONS.has(key)).toBe(false);
    expect(await storeRefusesOption(key), `${key} is not on the list, so the store must refuse it`).toBe(true);
  }
  expect(PUT_PAGE_OPTIONS.has('contextualRetrieval')).toBe(true);
});

test('a put_page that stamps contextual retrieval is comparable, as is one that does not', () => {
  expect(putPageOptionsComparable(undefined)).toBe(true);
  expect(putPageOptionsComparable({ sourceId: 'default', inline: true })).toBe(true);
  expect(putPageOptionsComparable({ contextualRetrieval: { mode: 'none', corpusGeneration: null } })).toBe(true);
  expect(putPageOptionsComparable({ contextualRetrieval: undefined })).toBe(true);
  expect(putPageOptionsComparable({ contextualRetrieval: { mode: 'title', corpusGeneration: null } })).toBe(true);
  expect(putPageOptionsComparable({ sourceId: 'default', contextualRetrieval: { mode: 'llm', corpusGeneration: 3 } })).toBe(true);
});

test('a key the store does not take is still not comparable', () => {
  expect(putPageOptionsComparable({ reuseSegments: {} })).toBe(false);
  expect(putPageOptionsComparable({ sourceId: 'default', somethingNew: 1 })).toBe(false);
});
