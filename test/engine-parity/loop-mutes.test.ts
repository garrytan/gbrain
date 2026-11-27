/**
 * BrainEngine parity — loop mutes (`loop_suppressions`) and the open-loop statements a mute, an unmute and the Gmail
 * thread verdict run (engine-sql/loop-mutes.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `loops_mute` records the mute and closes the reply-owed loops it covers (a thread mute matches the
 *    thread id in any case); `loops_unmute` removes it, queues the loops on a thread for re-check, leaves a loop with
 *    no thread closed and leaves a loop another mute still covers; both dry runs list and change nothing; the next
 *    sweep seeds the queued threads (`seedLoopRechecks`); and the re-fetched thread verdict
 *    (`applyThreadLoopVerdict`) reopens an unanswered thread, closes an answered one and settles a queued loop it
 *    neither opened nor closed. The same observable result on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: an engine that writes the mute but not the close, matches a thread mute case-sensitively, requeues a
 *    loop another mute still covers, or skips the re-check settle: a muted sender's loops stay open, an unmute reopens
 *    noise the owner still silences, or a queued loop never leaves the re-check queue.
 *  - Why existing coverage misses it: test/loops-noise-5012.test.ts drives these flows on PGLite alone; no case
 *    compares engines, and the Rust engine refused every one of these statements (raw SQL).
 *  - Seam: none. Real engines; the flows run through the MCP tool and the Gmail verdict, the rows are read with
 *    `listOpenLoops` and `listLoopSuppressions` (no executeRaw: D18).
 */
import { describe } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { applyThreadLoopVerdict, __clearSuppressionCacheForTests } from '../../src/core/google/loop-detect.ts';
import * as catchup from '../../src/core/google/loop-catchup.ts';
import type { OpenLoopUpsert } from '../../src/core/loops/loops-store.ts';
import type { GmailMessageMeta, GmailThreadData, GoogleSourceState } from '../../src/core/google/types.ts';
import { handleToolCall } from '../../src/mcp/server.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const NOW = new Date('2026-08-25T12:00:00Z');
const MY = new Set(['me@example.com']);
const T1 = new Date(NOW.getTime() - 48 * 3_600_000).toISOString();
const SENDER = 'alerts@bank-example.test';
const FOUNDER = 'founder@startup-example.test';

/** Loop ids counted from the case's first loop: the Postgres arm keeps its sequence between cases. */
function loopIds(first: { id: number }) {
  const base = Number(first.id) - 1;
  return { at: (n: number) => base + n, rel: (id: unknown) => Number(id) - base };
}

type LoopIds = ReturnType<typeof loopIds>;

async function source(engine: BrainEngine, backend: Parameters<typeof createSource>[1]) {
  __clearSuppressionCacheForTests(engine);
  await createSource(engine, backend, 'g1', { kind: 'google', g_account: 'me@example.com' });
}

function loop(over: Partial<OpenLoopUpsert> = {}): OpenLoopUpsert {
  const threadId = over.threadId === undefined ? '18c2f4a9b3d21e07' : over.threadId;
  return {
    sourceId: 'g1', dedupKey: `thread:${threadId}:${over.loopType ?? 'unanswered_inbound'}`, loopType: 'unanswered_inbound',
    counterpartyEmail: SENDER, summary: 'Reply owed', evidence: [{ message_id: 'm1', quote: 'Your balance is low.' }],
    threadId, detector: 'deterministic_thread', lastActivityAt: T1, ...over,
  };
}

let seq = 0;
function msg(spec: { from: string; to: string[]; ageHours: number; threadId: string; sent?: boolean; body: string }): GmailMessageMeta {
  const internalDateMs = NOW.getTime() - spec.ageHours * 3_600_000;
  seq += 1;
  return {
    id: `18c2f4a9b3d3${(0x3000 + seq).toString(16)}`, threadId: spec.threadId, from: spec.from, fromAddress: spec.from.toLowerCase(),
    to: spec.to, cc: [], subject: 'Intro', dateIso: new Date(internalDateMs).toISOString(), internalDateMs,
    labelIds: spec.sent ? ['SENT'] : ['INBOX'], listUnsubscribe: false, bodyText: spec.body,
  } as GmailMessageMeta;
}

function thread(messages: GmailMessageMeta[], threadId: string): GmailThreadData {
  return { threadId, account: 'me@example.com', messages };
}

/** Each loop of g1 as `{ id, thread_id, status, closed_by, page_slug }`, by id. */
async function loops(engine: BrainEngine, ids: LoopIds) {
  const rows = await engine.listOpenLoops({ sourceIds: ['g1'] });
  return rows.map(r => ({ id: ids.rel(r.id), thread_id: r.thread_id, status: r.status, closed_by: r.closed_by, page_slug: r.page_slug }))
    .sort((a, b) => a.id - b.id);
}

/** A tool result with its loop ids counted from the case's first loop. */
function relIds(ids: LoopIds, res: unknown) {
  const out: Record<string, unknown> = { ...(res as Record<string, unknown>) };
  for (const k of ['closed', 'would_close', 'requeued', 'would_requeue', 'unverifiable']) {
    if (Array.isArray(out[k])) out[k] = (out[k] as unknown[]).map(ids.rel);
  }
  return out;
}

async function suppressions(engine: BrainEngine) {
  return (await engine.listLoopSuppressions('g1')).map(r => `${r.kind}:${r.value}`).sort();
}

describe('engine parity: loop mutes', () => {
  parityTest(
    'loops_mute records the mute once and closes the reply-owed loops it covers; a thread mute matches in any case',
    { methods: [
      'addLoopSuppression', 'removeLoopSuppression', 'listLoopSuppressions', 'closeMutedLoops', 'upsertOpenLoop', 'listOpenLoops',
    ] },
    async (engine, backend) => {
      await source(engine, backend);
      const ids = loopIds(await engine.upsertOpenLoop(loop()));
      await engine.upsertOpenLoop(loop({ threadId: '18c2f4a9b3d21e0e' }));
      await engine.upsertOpenLoop(loop({ threadId: '18C2F4A9B3D21E0F', counterpartyEmail: 'carol@example.com' }));
      await engine.upsertOpenLoop(loop({ loopType: 'commitment_owed_by_me', threadId: '18c2f4a9b3d21e10' }));
      const dry = relIds(ids, await handleToolCall(engine, 'loops_mute', { kind: 'sender', value: 'Alerts@Bank-Example.test', source_id: 'g1', dry_run: true }));
      const afterDry = { loops: await loops(engine, ids), suppressions: await suppressions(engine) };
      const sender = relIds(ids, await handleToolCall(engine, 'loops_mute', { kind: 'sender', value: 'Alerts@Bank-Example.test', source_id: 'g1' }));
      const again = relIds(ids, await handleToolCall(engine, 'loops_mute', { kind: 'sender', value: SENDER, source_id: 'g1' }));
      const byThread = relIds(ids, await handleToolCall(engine, 'loops_mute', { kind: 'thread', value: '18c2f4a9b3d21e0f', source_id: 'g1' }));
      const removed = [await engine.removeLoopSuppression('g1', 'thread', 'nope'), await engine.removeLoopSuppression('g1', 'thread', '18c2f4a9b3d21e0f')];
      return { dry, afterDry, sender, again, byThread, removed, suppressions: await suppressions(engine), loops: await loops(engine, ids) };
    },
  );

  parityTest(
    'loops_unmute queues the loops on a thread, leaves a threadless loop closed and one another mute still covers, and a dry run changes nothing',
    { methods: [
      'addLoopSuppression', 'removeLoopSuppression', 'listLoopSuppressions', 'closeMutedLoops', 'upsertOpenLoop', 'listOpenLoops',
      'requeueMutedLoops', 'closeOpenLoop',
    ] },
    async (engine, backend) => {
      await source(engine, backend);
      const ids = loopIds(await engine.upsertOpenLoop(loop()));
      await engine.upsertOpenLoop(loop({ threadId: '18c2f4a9b3d21e0e' }));
      await engine.upsertOpenLoop(loop({ threadId: null, dedupKey: 'llm:no-thread' }));
      await engine.upsertOpenLoop(loop({ threadId: '18c2f4a9b3d21e11', dedupKey: 'manual-close' }));
      await engine.closeOpenLoop('g1', ids.at(4), 'dropped', 'manual');
      await handleToolCall(engine, 'loops_mute', { kind: 'sender', value: SENDER, source_id: 'g1' });
      await handleToolCall(engine, 'loops_mute', { kind: 'thread', value: '18C2F4A9B3D21E0E', source_id: 'g1' });
      const dry = relIds(ids, await handleToolCall(engine, 'loops_unmute', { kind: 'sender', value: SENDER, source_id: 'g1', dry_run: true }));
      const afterDry = await loops(engine, ids);
      const res = relIds(ids, await handleToolCall(engine, 'loops_unmute', { kind: 'sender', value: SENDER, source_id: 'g1' }));
      const twice = relIds(ids, await handleToolCall(engine, 'loops_unmute', { kind: 'sender', value: SENDER, source_id: 'g1' }));
      return { dry, afterDry, res, twice, suppressions: await suppressions(engine), loops: await loops(engine, ids) };
    },
  );

  parityTest(
    'after an unmute the sweep seeds the queued threads, and the re-fetched verdict reopens, closes or settles each',
    { methods: [
      'addLoopSuppression', 'removeLoopSuppression', 'listLoopSuppressions', 'closeMutedLoops', 'upsertOpenLoop', 'listOpenLoops',
      'requeueMutedLoops', 'listMuteRecheckThreads', 'closeThreadLoops', 'settleMuteRecheck',
    ] },
    async (engine, backend) => {
      await source(engine, backend);
      const quiet = '18c2f4a9b3d21e0c';
      const answered = '18c2f4a9b3d21e0d';
      const settled = '18c2f4a9b3d21e0b';
      const owed = (tid: string) => msg({ from: FOUNDER, to: ['me@example.com'], ageHours: 72, threadId: tid, body: 'Could we find 20 minutes next week?' });
      const [q0, a0, s0] = [owed(quiet), owed(answered), owed(settled)];
      await applyThreadLoopVerdict(engine, 'g1', thread([q0], quiet), MY, 'mail/quiet', NOW);
      await applyThreadLoopVerdict(engine, 'g1', thread([a0], answered), MY, 'mail/answered', NOW);
      await applyThreadLoopVerdict(engine, 'g1', thread([s0], settled), MY, null, NOW);
      const opened = await engine.listOpenLoops({ sourceIds: ['g1'] });
      const ids = loopIds({ id: Math.min(...opened.map(r => Number(r.id))) });
      const muted = relIds(ids, await handleToolCall(engine, 'loops_mute', { kind: 'sender', value: FOUNDER, source_id: 'g1' }));
      const unmuted = relIds(ids, await handleToolCall(engine, 'loops_unmute', { kind: 'sender', value: FOUNDER, source_id: 'g1' }));
      const recheckThreads = await engine.listMuteRecheckThreads('g1');
      const state = { loop_automated_backfill_done: true } as GoogleSourceState;
      const seeded = await catchup.seedLoopRechecks(engine, 'g1', state, () => {}, NOW.getTime());
      const holds = Object.keys(state.loop_grace_holds ?? {}).sort();
      __clearSuppressionCacheForTests(engine);
      await applyThreadLoopVerdict(engine, 'g1', thread([q0], quiet), MY, 'mail/quiet', NOW);
      await applyThreadLoopVerdict(engine, 'g1', thread([a0, msg({ from: 'me@example.com', to: [FOUNDER], ageHours: 10, sent: true,
        threadId: answered, body: 'Tuesday works, invite sent.' })], answered), MY, 'mail/answered', NOW);
      // A thread whose newest message is a stranger's note the owner does not owe: neither reopened nor answered.
      await applyThreadLoopVerdict(engine, 'g1', thread([s0, msg({ from: 'me@example.com', to: [FOUNDER], ageHours: 60, sent: true,
        threadId: settled, body: 'Thanks, noted.' }), msg({ from: FOUNDER, to: ['me@example.com'], ageHours: 50, threadId: settled, body: 'Thanks!' })], settled), MY, null, NOW);
      return { muted, unmuted, recheckThreads, seeded, holds, loops: await loops(engine, ids), left: await engine.listMuteRecheckThreads('g1') };
    },
  );

  parityTest(
    'closeThreadLoops closes only the named types of a thread and its queued loops; settleMuteRecheck settles only queued loops',
    { methods: [
      'addLoopSuppression', 'removeLoopSuppression', 'closeMutedLoops', 'upsertOpenLoop', 'listOpenLoops',
      'requeueMutedLoops', 'listMuteRecheckThreads', 'closeThreadLoops', 'settleMuteRecheck',
    ] },
    async (engine, backend) => {
      await source(engine, backend);
      const ids = loopIds(await engine.upsertOpenLoop(loop()));
      await engine.upsertOpenLoop(loop({ loopType: 'unanswered_outbound' }));
      await engine.upsertOpenLoop(loop({ dedupKey: 'llm', detector: 'llm_extract', loopType: 'commitment_owed_by_me' }));
      await engine.upsertOpenLoop(loop({ threadId: 'T-Two', counterpartyEmail: FOUNDER, pageSlug: 'mail/b' }));
      await engine.upsertOpenLoop(loop({ threadId: 'T-Two', counterpartyEmail: FOUNDER, dedupKey: 'thread:T-Two:second', pageSlug: 'mail/c' }));
      await engine.addLoopSuppression('g1', 'sender', FOUNDER);
      const closed = (await engine.closeMutedLoops('g1', 'sender', FOUNDER, true)).map(ids.rel);
      await engine.removeLoopSuppression('g1', 'sender', FOUNDER);
      const requeued = (await engine.requeueMutedLoops('g1', 'sender', FOUNDER, true)).map(r => ({ ...r, id: ids.rel(r.id) }));
      const recheck = await engine.listMuteRecheckThreads('g1');
      const counts = {
        onlyOutbound: await engine.closeThreadLoops('g1', '18c2f4a9b3d21e07', 'reply_detected', ['unanswered_outbound']),
        emptyOnly: await engine.closeThreadLoops('g1', '18c2f4a9b3d21e07', 'reply_detected', []),
        otherThread: await engine.closeThreadLoops('g1', 't-two', 'reply_detected', null),
        settle: await engine.settleMuteRecheck('g1', 'T-Two'),
        settleAgain: await engine.settleMuteRecheck('g1', 'T-Two'),
      };
      return { closed, requeued, recheck, counts, loops: await loops(engine, ids) };
    },
  );
  parityTest(
    'adding a mute that already exists still takes the next mute id, as a database sequence does',
    { methods: ['addLoopSuppression', 'readMigrationRows'] },
    async (engine, backend) => {
      await source(engine, backend);
      await engine.addLoopSuppression('g1', 'sender', SENDER);
      await engine.addLoopSuppression('g1', 'sender', SENDER);
      await engine.addLoopSuppression('g1', 'thread', '18c2f4a9b3d21e0e');
      const { rows } = (await engine.readMigrationRows('loop_suppressions'))!;
      const first = Math.min(...rows.map(r => Number(r.id)));
      return rows.map(r => ({ id: Number(r.id) - first, kind: r.kind, value: r.value }));
    },
  );
});
