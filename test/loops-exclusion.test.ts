/**
 * #5445 — per-source Gmail label exclusion for loop extraction
 * (src/core/google/loops-exclusion.ts and its three eligibility sites).
 *
 *  - tokens resolve once against the label catalog; a name nobody has is
 *    unresolved and the policy FAILS CLOSED (`excluded_label_unresolved`);
 *  - the eligibility gate sits before the owner override: replying inside an
 *    excluded label does not buy the thread back;
 *  - the deterministic lane withholds new opens on an excluded thread and
 *    still closes answered loops;
 *  - a grace hold published before the policy changed is re-checked when it
 *    comes due: excluded → dropped without opening, unresolved → kept;
 *  - the catch-up skips with the visible reason while anything is unresolved;
 *  - the stored resolution is reused for the same tokens only.
 *
 * Synthetic data only. PGLite in memory; no model call anywhere.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  isExcludedByLabels,
  loadLoopsExclusionPolicy,
  LOOPS_EXCLUDE_LABELS_CONFIG_KEY,
  NO_EXCLUSION,
  pageLabelIds,
  parseExcludeLabelTokens,
  resolveExcludedLabels,
  storeLoopsExclusion,
  type LoopsExclusionPolicy,
} from '../src/core/google/loops-exclusion.ts';
import { loopExtractionEligibility } from '../src/core/google/loops-extract.ts';
import { applyThreadLoopVerdict, detectThreadLoop, openDueGraceHold, withLabelExclusion, __clearSuppressionCacheForTests } from '../src/core/google/loop-detect.ts';
import { recordGraceVerdict, runLoopsCatchup, settleDueGraceHolds } from '../src/core/google/loop-catchup.ts';
import { parseGoogleSourceConfig } from '../src/core/google/source-config.ts';
import { listOpenLoops } from '../src/core/loops/loops-store.ts';
import type { GmailMessageMeta, GmailThreadData, GoogleSourceState } from '../src/core/google/types.ts';

const CATALOG = [
  { id: 'INBOX', name: 'INBOX' },
  { id: 'Label_7', name: 'Newsletters' },
  { id: 'Label_12', name: 'Recruiting/Agencies' },
];
const EXCLUDE_7: LoopsExclusionPolicy = { tokens: ['Newsletters'], ids: new Set(['Label_7']), unresolved: [] };
const UNRESOLVED: LoopsExclusionPolicy = { tokens: ['Nope'], ids: new Set(), unresolved: ['Nope'] };

const NOW = new Date('2026-08-25T12:00:00Z');
const MY = new Set(['me@example.com']);
let seq = 0;

function msg(spec: { from: string; to?: string[]; ageHours: number; labels?: string[]; body?: string; threadId?: string }): GmailMessageMeta {
  const internalDateMs = NOW.getTime() - spec.ageHours * 3_600_000;
  seq += 1;
  return {
    id: `18c2f4a9b3d2${(0x3000 + seq).toString(16)}`,
    threadId: spec.threadId ?? '18c2f4a9b3d21e07',
    from: spec.from,
    fromAddress: spec.from.toLowerCase(),
    to: (spec.to ?? ['me@example.com']).map((a) => a.toLowerCase()),
    cc: [],
    subject: 'Quarterly plan',
    dateIso: new Date(internalDateMs).toISOString(),
    internalDateMs,
    labelIds: spec.labels ?? (spec.from === 'me@example.com' ? ['SENT'] : ['INBOX']),
    listUnsubscribe: false,
    bodyText: spec.body ?? 'Can you review the plan?',
  };
}
const thread = (messages: GmailMessageMeta[], threadId = '18c2f4a9b3d21e07'): GmailThreadData => ({ threadId, account: 'me@example.com', messages });

describe('#5445 resolution', () => {
  test('tokens parse from a comma list or an array, trimmed and de-duplicated', () => {
    expect(parseExcludeLabelTokens(' Newsletters, Label_7 ,, Newsletters')).toEqual(['Newsletters', 'Label_7']);
    expect(parseExcludeLabelTokens(['Recruiting/Agencies', 'INBOX'])).toEqual(['Recruiting/Agencies', 'INBOX']);
    expect(parseExcludeLabelTokens(undefined)).toEqual([]);
  });

  test('a name resolves case-insensitively to its id, an id passes through, an unknown name stays unresolved', () => {
    const p = resolveExcludedLabels(['newsletters', 'Label_12', 'Nope'], CATALOG);
    expect([...p.ids].sort()).toEqual(['Label_12', 'Label_7']);
    expect(p.unresolved).toEqual(['Nope']);
  });

  test('without a catalog only id-shaped tokens resolve; names fail closed', () => {
    const p = resolveExcludedLabels(['Label_7', 'CATEGORY_FORUMS', 'Newsletters'], null);
    expect([...p.ids].sort()).toEqual(['CATEGORY_FORUMS', 'Label_7']);
    expect(p.unresolved).toEqual(['Newsletters']);
  });

  test('an id the catalog no longer has is unresolved (a deleted label is not silently ignored)', () => {
    expect(resolveExcludedLabels(['Label_99'], CATALOG).unresolved).toEqual(['Label_99']);
  });

  test('isExcludedByLabels and pageLabelIds', () => {
    expect(isExcludedByLabels(EXCLUDE_7, ['INBOX', 'Label_7'])).toBe(true);
    expect(isExcludedByLabels(EXCLUDE_7, ['INBOX'])).toBe(false);
    expect(isExcludedByLabels(NO_EXCLUSION, ['Label_7'])).toBe(false);
    expect(pageLabelIds({ labels: ['INBOX', 'Label_7', 3] })).toEqual(['INBOX', 'Label_7']);
    expect(pageLabelIds({})).toEqual([]);
  });

  test('g_loops_exclude_labels parses onto the source config and is absent when unset', () => {
    const base = { kind: 'google', g_account: 'a@example.com', g_services: 'gmail', g_history_days: 90, g_dir: '/tmp/x' };
    expect(parseGoogleSourceConfig(base, '/tmp/x').loopsExcludeLabels).toBeUndefined();
    expect(parseGoogleSourceConfig({ ...base, g_loops_exclude_labels: 'Newsletters, Label_12' }, '/tmp/x').loopsExcludeLabels).toEqual(['Newsletters', 'Label_12']);
  });
});

describe('#5445 eligibility gate', () => {
  const inbound = thread([msg({ from: 'peer@example.com', ageHours: 48, labels: ['INBOX', 'Label_7'] })]);

  test('a thread under an excluded label is ineligible with excluded_label', () => {
    expect(loopExtractionEligibility(inbound, MY, EXCLUDE_7)).toEqual({ eligible: false, reason: 'excluded_label' });
    expect(loopExtractionEligibility(inbound, MY).eligible).toBe(true);
  });

  test('the owner replying inside the excluded label does not rescue the thread (gate precedes the owner override)', () => {
    const replied = thread([
      ...inbound.messages,
      msg({ from: 'me@example.com', to: ['peer@example.com'], ageHours: 20, labels: ['SENT', 'Label_7'], body: 'Yes, I will review it tomorrow and send notes.' }),
    ]);
    expect(loopExtractionEligibility(replied, MY, EXCLUDE_7).reason).toBe('excluded_label');
  });

  test('an unresolved policy fails closed for every thread, with the visible retryable reason', () => {
    const plain = thread([msg({ from: 'peer@example.com', ageHours: 48 })]);
    expect(loopExtractionEligibility(plain, MY, UNRESOLVED)).toEqual({ eligible: false, reason: 'excluded_label_unresolved' });
  });
});

describe('#5445 deterministic lane and holds (PGLite)', () => {
  let engine: PGLiteEngine;
  const SRC = 'g1';

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => {
    await resetPgliteState(engine);
    __clearSuppressionCacheForTests();
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('g1', 'g1', '{"kind":"google"}'::jsonb) ON CONFLICT (id) DO NOTHING`);
  });

  const openLoops = async () => listOpenLoops(engine, { sourceIds: [SRC], status: 'open' });

  test('withLabelExclusion withholds opens and keeps closes; an unresolved policy withholds the same way', () => {
    const asked = thread([msg({ from: 'me@example.com', to: ['peer@example.com'], ageHours: 200, labels: ['SENT', 'Label_7'] })]);
    const verdict = detectThreadLoop(asked, MY, NOW);
    expect(verdict.open.length).toBe(1);
    expect(withLabelExclusion(verdict, EXCLUDE_7, ['SENT', 'Label_7'])).toEqual({ open: [], close: verdict.close });
    expect(withLabelExclusion(verdict, UNRESOLVED, ['SENT'])).toEqual({ open: [], close: verdict.close });
    expect(withLabelExclusion(verdict, EXCLUDE_7, ['SENT'])).toBe(verdict);
  });

  test('an excluded thread opens nothing, and the exclusion never blocks the close of a loop opened earlier', async () => {
    const asked = thread([msg({ from: 'me@example.com', to: ['peer@example.com'], ageHours: 200 })]);
    await applyThreadLoopVerdict(engine, SRC, asked, MY, null, NOW);
    expect((await openLoops()).length).toBe(1);
    const answered = thread([...asked.messages, msg({ from: 'peer@example.com', ageHours: 10, labels: ['INBOX', 'Label_7'], body: 'Reviewed, looks good to me.' })]);
    await applyThreadLoopVerdict(engine, SRC, answered, MY, null, NOW, EXCLUDE_7);
    expect((await openLoops()).length).toBe(0);
    const fresh = thread([msg({ from: 'peer@example.com', ageHours: 60, labels: ['INBOX', 'Label_7'], threadId: '18c2f4a9b3d21e08' })], '18c2f4a9b3d21e08');
    await applyThreadLoopVerdict(engine, SRC, fresh, MY, null, NOW, EXCLUDE_7);
    expect((await openLoops()).length).toBe(0);
    await applyThreadLoopVerdict(engine, SRC, fresh, MY, null, NOW);
    expect((await openLoops()).length).toBe(1);
  });

  async function heldThread(labels: string[]): Promise<{ t: GmailThreadData; state: GoogleSourceState; slug: string }> {
    const t = thread([msg({ from: 'peer@example.com', ageHours: 2, labels, threadId: '18c2f4a9b3d21e09' })], '18c2f4a9b3d21e09');
    const slug = 'emails/2026/08/2026-08-25-quarterly-plan-18c2f4a9';
    await engine.putPage(slug, { type: 'email', title: 'Quarterly plan', compiled_truth: 'Can you review the plan?',
      frontmatter: { thread_id: t.threadId, message_id: t.messages[0].id, labels } }, { sourceId: SRC });
    const verdict = detectThreadLoop(t, MY, NOW);
    expect(verdict.held).toBeDefined();
    const state = { loop_grace_holds: {} } as unknown as GoogleSourceState;
    recordGraceVerdict(state, t, verdict, slug, MY, () => {});
    expect(state.loop_grace_holds?.[t.threadId]?.spec).toBeDefined();
    return { t, state, slug };
  }

  test('policy flipped after the hold: a due hold under a now-excluded label is dropped without opening', async () => {
    const { t, state, slug } = await heldThread(['INBOX', 'Label_7']);
    const hold = state.loop_grace_holds![t.threadId];
    expect(await openDueGraceHold(engine, SRC, t.threadId, hold.spec!, slug, EXCLUDE_7)).toBe('excluded');
    expect((await openLoops()).length).toBe(0);
    expect(await openDueGraceHold(engine, SRC, t.threadId, hold.spec!, slug)).toBe('opened');
    expect((await openLoops()).length).toBe(1);
  });

  test('policy unresolved when the hold comes due: the hold is kept (deferred), nothing is published', async () => {
    const { t, state, slug } = await heldThread(['INBOX']);
    const hold = state.loop_grace_holds![t.threadId];
    expect(hold.slug).toBe(slug);
    const r = await settleDueGraceHolds({ engine, sourceId: SRC, state, log: () => {}, processed: new Set(), now: hold.due_ms + 1,
      refetch: async () => 'ok', exclusion: UNRESOLVED });
    expect(r).toEqual({ opened: 0, refetched: 0, deferred: 1 });
    expect(state.loop_grace_holds?.[t.threadId]).toBeDefined();
    expect((await openLoops()).length).toBe(0);
    const again = await settleDueGraceHolds({ engine, sourceId: SRC, state, log: () => {}, processed: new Set(), now: hold.due_ms + 1,
      refetch: async () => 'ok' });
    expect(again).toEqual({ opened: 1, refetched: 0, deferred: 0 });
    expect(state.loop_grace_holds?.[t.threadId]).toBeUndefined();
  });

  test('a thread held while excluded is not recorded as a grace hold', async () => {
    const t = thread([msg({ from: 'peer@example.com', ageHours: 2, labels: ['INBOX', 'Label_7'] })]);
    const state = { loop_grace_holds: {} } as unknown as GoogleSourceState;
    recordGraceVerdict(state, t, detectThreadLoop(t, MY, NOW), 'emails/x', MY, () => {}, EXCLUDE_7);
    expect(state.loop_grace_holds?.[t.threadId]).toBeUndefined();
  });

  test('the catch-up skips with excluded_label_unresolved while any name is unresolved', async () => {
    await engine.setConfig('loops.extraction_enabled', 'true');
    const state = {} as GoogleSourceState;
    const r = await runLoopsCatchup({ engine, sourceId: SRC, state, log: () => {}, myAddresses: MY, inFlight: new Set(),
      fetchThread: async () => null, exclusion: UNRESOLVED });
    expect(r?.skipped_reason).toBe('excluded_label_unresolved');
    expect(r?.enqueued).toBe(0);
  });

  test('the stored resolution is reused for the same tokens; changed tokens fall back to id-only (names unresolved)', async () => {
    await engine.setConfig(LOOPS_EXCLUDE_LABELS_CONFIG_KEY, 'Newsletters');
    expect((await loadLoopsExclusionPolicy(engine, SRC)).unresolved).toEqual(['Newsletters']);
    await storeLoopsExclusion(engine, SRC, resolveExcludedLabels(['Newsletters'], CATALOG));
    const loaded = await loadLoopsExclusionPolicy(engine, SRC);
    expect([...loaded.ids]).toEqual(['Label_7']);
    expect(loaded.unresolved).toEqual([]);
    await engine.setConfig(LOOPS_EXCLUDE_LABELS_CONFIG_KEY, 'Newsletters, Recruiting/Agencies');
    const changed = await loadLoopsExclusionPolicy(engine, SRC);
    expect(changed.unresolved).toEqual(['Newsletters', 'Recruiting/Agencies']);
    const sourceWins = await loadLoopsExclusionPolicy(engine, SRC, { loopsExcludeLabels: ['Label_12'] });
    expect([...sourceWins.ids]).toEqual(['Label_12']);
    expect(sourceWins.unresolved).toEqual([]);
    await engine.setConfig(LOOPS_EXCLUDE_LABELS_CONFIG_KEY, '');
    expect(await loadLoopsExclusionPolicy(engine, SRC)).toBe(NO_EXCLUSION);
  });
});
