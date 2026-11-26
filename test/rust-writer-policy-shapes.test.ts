/**
 * Row 32e-d-1, step 2: which writer policies the Rust store serves (store-members/remote-links.ts writerPolicy), pinned on
 * the rendered text. The member renders renderWriterReadPolicy in the ambient caller record and compares it with two
 * fixed forms (no identity, and one identity with hidePrivate) built in a fresh record.
 * Root cause of the owner's refusal: the ambient owner record drops the owner-only clause from the text, so the owner's
 * one-identity policy equals neither form (it equals the identity form rendered with `owner: true`).
 * Fails when the owner's writer policy is refused while a plain member's, the same one-identity policy, is served.
 * Row 32e-b-1: a labelled-only writer's policy and a writer with a satisfied folder rule are served too (the store judges
 * the labelled-only conjunct and the folder rules); a writer with more than one identity is still refused.
 */
import { expect, test } from 'bun:test';
import type { WriterReadPolicy } from '../src/core/engine-sql/remote-links.ts';
import { withCallerAccess } from '../src/core/search/private-visibility.ts';
import { readLinkTargetPages } from '../src/core/rust-engine/store-members/remote-links.ts';
import type { StoreBrain } from '../src/core/rust-engine/store.ts';

const brain = { readLinkTargetPages: async () => [] } as unknown as StoreBrain;
const policy: WriterReadPolicy = { identities: [['member:alice-example']], satisfiedRuleIds: [], folderCoverage: [], owner: false, labelledOnly: false };
const serve = (ambient: { owner?: boolean }, writer: WriterReadPolicy = policy) => withCallerAccess({ restricted: true, hidePrivate: true, ...ambient }, () => readLinkTargetPages(brain, 'work', ['notes/a'], writer))
  .then(() => 'served', (e: { code?: string }) => e.code);

test('a one-identity writer policy is served for a plain member', async () => expect(await serve({})).toBe('served'));
test('a one-identity writer policy is served for the brain owner', async () => expect(await serve({ owner: true })).toBe('served'));
test('a labelled-only writer policy and a satisfied folder rule are served, owner or not', async () => {
  const labelled = { ...policy, labelledOnly: true }, folder = { ...policy, satisfiedRuleIds: ['work:a'] };
  for (const writer of [labelled, folder]) for (const owner of [false, true]) expect(await serve({ owner }, writer)).toBe('served');
});
test('a writer policy with more than one identity is still refused, owner or not', async () => {
  const two = { ...policy, identities: [['member:alice-example'], ['member:bob-example']] };
  for (const owner of [false, true]) expect(await serve({ owner }, two)).toBe('engine_capability_missing');
});
