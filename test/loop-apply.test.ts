/**
 * applyThreadLoopVerdict (src/core/google/loop-detect.ts) on PGLite:
 * verdict → open_loops rows, reply-driven auto-close, idempotent re-apply,
 * counterparty slug resolution (alias-exact only — never fallback_slugify),
 * and the suppression cache seam.
 *
 * Synthetic data only.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  applyThreadLoopVerdict,
  __clearSuppressionCacheForTests,
} from '../src/core/google/loop-detect.ts';
import { addSuppression, listOpenLoops } from '../src/core/loops/loops-store.ts';
import { normalizeAlias } from '../src/core/search/alias-normalize.ts';
import type { GmailMessageMeta, GmailThreadData } from '../src/core/google/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  __clearSuppressionCacheForTests();
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ('g1', 'g1', '{"kind":"google"}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
  );
});

const NOW = new Date('2026-08-25T12:00:00Z');
const MY = new Set(['me@example.com']);

let msgSeq = 0;

function msg(spec: {
  from: string;
  to?: string[];
  ageHours: number;
  sent?: boolean;
  body?: string;
  threadId?: string;
}): GmailMessageMeta {
  const internalDateMs = NOW.getTime() - spec.ageHours * 3_600_000;
  msgSeq += 1;
  return {
    id: `18c2f4a9b3d2${(0x2000 + msgSeq).toString(16)}`,
    threadId: spec.threadId ?? '18c2f4a9b3d21e07',
    from: spec.from,
    fromAddress: spec.from.toLowerCase(),
    to: (spec.to ?? []).map((a) => a.toLowerCase()),
    cc: [],
    subject: 'Quarterly plan',
    dateIso: new Date(internalDateMs).toISOString(),
    internalDateMs,
    labelIds: spec.sent ? ['SENT'] : ['INBOX'],
    listUnsubscribe: false,
    bodyText: spec.body ?? 'Can you review the plan?',
  };
}

function thread(messages: GmailMessageMeta[], threadId = '18c2f4a9b3d21e07'): GmailThreadData {
  return { threadId, account: 'me@example.com', messages };
}

/** Inbound thread from `from` that owes a reply (48h old, addressed to me). */
function inboundThread(from: string, threadId = '18c2f4a9b3d21e07'): GmailThreadData {
  return thread([msg({ from, to: ['me@example.com'], ageHours: 48, threadId })], threadId);
}

describe('applyThreadLoopVerdict', () => {
  test('creates the loop row with dedup thread:<tid>:unanswered_inbound and merges page_slug into evidence', async () => {
    await applyThreadLoopVerdict(
      engine,
      'g1',
      inboundThread('carol@example.com'),
      MY,
      'emails/quarterly-plan',
      NOW,
    );
    const rows = await listOpenLoops(engine, { sourceIds: ['g1'], status: 'open' });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.dedup_key).toBe('thread:18c2f4a9b3d21e07:unanswered_inbound');
    expect(row.loop_type).toBe('unanswered_inbound');
    expect(row.detector).toBe('deterministic_thread');
    expect(row.counterparty_email).toBe('carol@example.com');
    expect(row.thread_id).toBe('18c2f4a9b3d21e07');
    expect(row.page_slug).toBe('emails/quarterly-plan');
    expect(row.evidence).toHaveLength(1);
    expect(row.evidence[0].page_slug).toBe('emails/quarterly-plan');
    expect(row.evidence[0].quote).toBe('Can you review the plan?');
  });

  test('a second apply with a replied thread closes the loop (closed_by reply_detected)', async () => {
    await applyThreadLoopVerdict(engine, 'g1', inboundThread('carol@example.com'), MY, null, NOW);
    expect(await listOpenLoops(engine, { sourceIds: ['g1'], status: 'open' })).toHaveLength(1);

    // The thread now ends with MY reply (no '?') — nothing is owed.
    const replied = thread([
      msg({ from: 'carol@example.com', to: ['me@example.com'], ageHours: 48 }),
      msg({ from: 'me@example.com', to: ['carol@example.com'], ageHours: 1, sent: true, body: 'Done.' }),
    ]);
    await applyThreadLoopVerdict(engine, 'g1', replied, MY, null, NOW);

    expect(await listOpenLoops(engine, { sourceIds: ['g1'], status: 'open' })).toHaveLength(0);
    const done = await listOpenLoops(engine, { sourceIds: ['g1'], status: 'done' });
    expect(done).toHaveLength(1);
    expect(done[0].closed_by).toBe('reply_detected');
  });

  test('idempotent re-apply does not duplicate; a later re-apply after close reopens', async () => {
    const t = inboundThread('carol@example.com');
    await applyThreadLoopVerdict(engine, 'g1', t, MY, null, NOW);
    await applyThreadLoopVerdict(engine, 'g1', t, MY, null, NOW);
    let rows = await listOpenLoops(engine, { sourceIds: ['g1'] });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('open');
    const id = rows[0].id;

    // Reply closes it...
    const replied = thread([
      msg({ from: 'carol@example.com', to: ['me@example.com'], ageHours: 48 }),
      msg({ from: 'me@example.com', to: ['carol@example.com'], ageHours: 40, sent: true, body: 'Done.' }),
    ]);
    await applyThreadLoopVerdict(engine, 'g1', replied, MY, null, NOW);
    // ...a replay carrying NO newer activity must NOT reopen — that's the
    // manual-close-revert guard (a label-only history touch re-emits the
    // same spec; reverting a close on it would silently undo `loops done`)...
    await applyThreadLoopVerdict(engine, 'g1', t, MY, null, NOW);
    const closedRows = await listOpenLoops(engine, { sourceIds: ['g1'], status: 'done' });
    expect(closedRows).toHaveLength(1);
    expect(closedRows[0].id).toBe(id);
    // ...but a NEW inbound (genuinely newer activity, past the 24h grace)
    // reopens THE SAME row (dedup conflict path).
    const reAsked = thread([
      msg({ from: 'carol@example.com', to: ['me@example.com'], ageHours: 48 }),
      msg({ from: 'me@example.com', to: ['carol@example.com'], ageHours: 40, sent: true, body: 'Done.' }),
      msg({ from: 'carol@example.com', to: ['me@example.com'], ageHours: 30 }),
    ]);
    await applyThreadLoopVerdict(engine, 'g1', reAsked, MY, null, NOW);
    rows = await listOpenLoops(engine, { sourceIds: ['g1'] });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].status).toBe('open');
    expect(rows[0].closed_at).toBeNull();
  });

  test('outbound → inbound flip closes the outbound loop and opens the inbound one', async () => {
    // I asked 96h ago — waiting on them.
    const asked = thread([
      msg({ from: 'me@example.com', to: ['carol@example.com'], ageHours: 96, sent: true, body: 'Any update?' }),
    ]);
    await applyThreadLoopVerdict(engine, 'g1', asked, MY, null, NOW);
    let open = await listOpenLoops(engine, { sourceIds: ['g1'], status: 'open' });
    expect(open.map((l) => l.loop_type)).toEqual(['unanswered_outbound']);

    // They replied 48h ago — now I owe the reply.
    const theyReplied = thread([
      msg({ from: 'me@example.com', to: ['carol@example.com'], ageHours: 96, sent: true, body: 'Any update?' }),
      msg({ from: 'carol@example.com', to: ['me@example.com'], ageHours: 48 }),
    ]);
    await applyThreadLoopVerdict(engine, 'g1', theyReplied, MY, null, NOW);
    open = await listOpenLoops(engine, { sourceIds: ['g1'], status: 'open' });
    expect(open.map((l) => l.loop_type)).toEqual(['unanswered_inbound']);
    const done = await listOpenLoops(engine, { sourceIds: ['g1'], status: 'done' });
    expect(done.map((l) => l.loop_type)).toEqual(['unanswered_outbound']);
    expect(done[0].closed_by).toBe('reply_detected');
  });

  test('counterparty_slug resolves via alias-exact when a person page carries the email alias in the same source', async () => {
    await engine.putPage(
      'people/carol-example',
      { title: 'Carol Example', type: 'person', compiled_truth: 'Carol, a founder.' },
      { sourceId: 'g1' },
    );
    await engine.setPageAliases('people/carol-example', 'g1', [
      normalizeAlias('carol@example.com'),
    ]);

    await applyThreadLoopVerdict(engine, 'g1', inboundThread('carol@example.com'), MY, null, NOW);
    const rows = await listOpenLoops(engine, { sourceIds: ['g1'], status: 'open' });
    expect(rows).toHaveLength(1);
    expect(rows[0].counterparty_slug).toBe('people/carol-example');
    expect(rows[0].counterparty_email).toBe('carol@example.com');
  });

  test('counterparty_slug stays null when resolution would be fallback_slugify only', async () => {
    // No page, no alias for this address — resolveEntitySlugWithSource can
    // only fabricate a slug (fallback_slugify), which must NOT be persisted.
    await applyThreadLoopVerdict(engine, 'g1', inboundThread('dave@example.com'), MY, null, NOW);
    const rows = await listOpenLoops(engine, { sourceIds: ['g1'], status: 'open' });
    expect(rows).toHaveLength(1);
    expect(rows[0].counterparty_slug).toBeNull();
    expect(rows[0].counterparty_email).toBe('dave@example.com');
  });

  test('alias in a DIFFERENT source does not resolve (source isolation)', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('g2', 'g2') ON CONFLICT (id) DO NOTHING`,
    );
    await engine.putPage(
      'people/carol-example',
      { title: 'Carol Example', type: 'person', compiled_truth: 'Carol.' },
      { sourceId: 'g2' },
    );
    await engine.setPageAliases('people/carol-example', 'g2', [
      normalizeAlias('carol@example.com'),
    ]);

    await applyThreadLoopVerdict(engine, 'g1', inboundThread('carol@example.com'), MY, null, NOW);
    const rows = await listOpenLoops(engine, { sourceIds: ['g1'], status: 'open' });
    expect(rows).toHaveLength(1);
    expect(rows[0].counterparty_slug).toBeNull();
  });

  test('suppressed sender never opens a NEW loop (with the cache seam cleared)', async () => {
    await addSuppression(engine, 'g1', 'sender', 'eve@example.com');
    __clearSuppressionCacheForTests();

    await applyThreadLoopVerdict(engine, 'g1', inboundThread('eve@example.com'), MY, null, NOW);
    expect(await listOpenLoops(engine, { sourceIds: ['g1'] })).toHaveLength(0);

    // Unsuppressed sender on another thread still opens.
    await applyThreadLoopVerdict(
      engine,
      'g1',
      inboundThread('bob@example.com', '18c2f4a9b3d21e08'),
      MY,
      null,
      NOW,
    );
    expect(await listOpenLoops(engine, { sourceIds: ['g1'], status: 'open' })).toHaveLength(1);
  });

  test('suppressed thread never opens a NEW loop', async () => {
    await addSuppression(engine, 'g1', 'thread', '18c2f4a9b3d21e07');
    __clearSuppressionCacheForTests();

    await applyThreadLoopVerdict(engine, 'g1', inboundThread('bob@example.com'), MY, null, NOW);
    expect(await listOpenLoops(engine, { sourceIds: ['g1'] })).toHaveLength(0);
  });

  test('REGRESSION: muting does NOT close an existing open loop (no phantom reply_detected)', async () => {
    // Open a loop while unsuppressed…
    await applyThreadLoopVerdict(engine, 'g1', inboundThread('bob@example.com'), MY, null, NOW);
    expect(await listOpenLoops(engine, { sourceIds: ['g1'], status: 'open' })).toHaveLength(1);
    // …then mute the sender and re-apply the SAME still-unanswered thread.
    // The suppressed verdict is empty, but the RAW verdict still holds —
    // closes are decided by the raw verdict, so the loop must stay open
    // ("existing loops keep their state"), not close as 'reply_detected'.
    await addSuppression(engine, 'g1', 'sender', 'bob@example.com');
    __clearSuppressionCacheForTests();
    await applyThreadLoopVerdict(engine, 'g1', inboundThread('bob@example.com'), MY, null, NOW);
    const open = await listOpenLoops(engine, { sourceIds: ['g1'], status: 'open' });
    expect(open).toHaveLength(1);
    expect(open[0].closed_by).toBeNull();
  });

  test('suppression cache seam: without clearing, a stale cached set is served; clearing picks up new mutes', async () => {
    // Prime the cache with the empty suppression set.
    await applyThreadLoopVerdict(engine, 'g1', inboundThread('frank@example.com'), MY, null, NOW);
    expect(await listOpenLoops(engine, { sourceIds: ['g1'], status: 'open' })).toHaveLength(1);

    // Mute frank — but the 60s cache still holds the empty set, so a re-apply
    // on a NEW thread still opens (documents the TTL behavior).
    await addSuppression(engine, 'g1', 'sender', 'frank@example.com');
    await applyThreadLoopVerdict(
      engine,
      'g1',
      inboundThread('frank@example.com', '18c2f4a9b3d21e09'),
      MY,
      null,
      NOW,
    );
    expect(await listOpenLoops(engine, { sourceIds: ['g1'], status: 'open' })).toHaveLength(2);

    // Clearing the cache makes the mute effective.
    __clearSuppressionCacheForTests();
    await applyThreadLoopVerdict(
      engine,
      'g1',
      inboundThread('frank@example.com', '18c2f4a9b3d21e0a'),
      MY,
      null,
      NOW,
    );
    expect(await listOpenLoops(engine, { sourceIds: ['g1'], status: 'open' })).toHaveLength(2);
  });

  test('a thread with no loop state is a no-op (no rows created, no throw)', async () => {
    // Fresh inbound inside the grace window.
    const fresh = thread([msg({ from: 'bob@example.com', to: ['me@example.com'], ageHours: 2 })]);
    await applyThreadLoopVerdict(engine, 'g1', fresh, MY, null, NOW);
    expect(await listOpenLoops(engine, { sourceIds: ['g1'] })).toHaveLength(0);
  });
});
