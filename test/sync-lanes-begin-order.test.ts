/**
 * #6574 CI: lane transactions begin in manifest order. A group's begun mark
 * used to be set when it finished waiting, before its BEGIN reached the
 * server, so the next group could BEGIN first and its `now()` (published_at)
 * came out of order (managed-sync-bulk "every page commits in manifest
 * order"). awaitLaneBegin now returns the mark for the caller to set inside
 * its transaction; until then the next group keeps waiting.
 */
import { expect, test } from 'bun:test';
import { awaitLaneBegin, type LaneState } from '../src/core/persistence/sync-lanes.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';

const lane = (): LaneState => ({ run: 'r', asked: 2, effective: 2, stepDown: null, overlapped: 0, fallbacks: 0, coordinationPath: null,
  claimed: new Set(['first', 'second']), begun: new Set(), tasks: 0, closing: false,
  timing: { open: 0, since: Date.now(), openArea: 0, activeMs: 0, applyMs: 0, appliedMembers: 0, turnWaitMs: 0, transactionMs: 0, recentPerMember: null } });
const group = (id: string, after?: string) => [{ request_id: id, intent: after ? { after } : {} }] as unknown as WriteRequest[];
const settledWithin = (p: Promise<unknown>, ms: number) => Promise.race([p.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), ms))]);

test('the next lane group waits until the group before it marks itself begun, not just until it stops waiting', async () => {
  const state = lane();
  const markFirst = await awaitLaneBegin(state, group('first'));
  expect(state.begun.has('first')).toBe(false);
  const second = awaitLaneBegin(state, group('second', 'first'));
  expect(await settledWithin(second, 120)).toBe(false);
  markFirst();
  expect(await settledWithin(second, 1_000)).toBe(true);
});

test('a predecessor that finished without beginning releases the next group', async () => {
  const state = lane();
  await awaitLaneBegin(state, group('first'));
  const second = awaitLaneBegin(state, group('second', 'first'));
  state.claimed.delete('first');
  expect(await settledWithin(second, 1_000)).toBe(true);
});
