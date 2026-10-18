/**
 * #5012 item 8: loop noise without hiding real people, on a real PGLite
 * engine (the store SQL is identical on Postgres; see
 * test/loops-noise-5012-store.test.ts and its Postgres run in
 * test/e2e/loops-noise-5012-postgres.test.ts).
 *
 *  - positively automated mail (Precedence / List-Id / no-reply Reply-To)
 *    opens no reply-owed loop through the apply step, and leaves a record;
 *  - `loops mute` closes the sender's (or thread's) open reply-owed loops,
 *    `unmute` queues them for re-check, and the re-check reopens only a
 *    thread nothing answered since the mute;
 *  - `loops drop sender` previews, then closes only that sender's loops;
 *  - `gbrain waiting` reports the loops the rule would not have opened;
 *  - the opt-in Updates reciprocity rule's owner-wrote-to set.
 *
 * Synthetic data only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { applyThreadLoopVerdict, __clearSuppressionCacheForTests } from '../src/core/google/loop-detect.ts';
import * as loopsStore from '../src/core/loops/loops-store.ts';
import { listOpenLoops, upsertOpenLoop, type OpenLoopUpsert } from '../src/core/loops/loops-store.ts';
import * as catchup from '../src/core/google/loop-catchup.ts';
import { runLoops, runWaiting } from '../src/commands/loops.ts';
import { handleToolCall } from '../src/mcp/server.ts';
import { currentExitCode, _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import type { GmailMessageMeta, GmailThreadData, GoogleSourceState } from '../src/core/google/types.ts';

let engine: PGLiteEngine;
let stateDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  stateDir = mkdtempSync(join(tmpdir(), 'gbrain-5012-'));
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(stateDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
  __clearSuppressionCacheForTests();
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config, last_sync_at) VALUES ('g1', 'g1', $1::text::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, last_sync_at = now()`,
    [JSON.stringify({ kind: 'google', g_account: 'me@example.com', g_dir: stateDir })],
  );
  writeFileSync(join(stateDir, '.google-source.json'), '{}');
  _resetCliExitVerdictForTests();
});

const NOW = new Date('2026-08-25T12:00:00Z');
const MY = new Set(['me@example.com']);
let seq = 0;

function msg(spec: { from: string; to?: string[]; ageHours: number; sent?: boolean; body?: string; threadId?: string;
  headers?: { precedence?: string; listId?: boolean; replyTo?: string[] } }): GmailMessageMeta {
  const internalDateMs = NOW.getTime() - spec.ageHours * 3_600_000;
  seq += 1;
  return {
    id: `18c2f4a9b3d3${(0x3000 + seq).toString(16)}`,
    threadId: spec.threadId ?? '18c2f4a9b3d21e07',
    from: spec.from,
    fromAddress: spec.from.toLowerCase(),
    to: (spec.to ?? []).map((a) => a.toLowerCase()),
    cc: [],
    subject: 'Balance alert',
    dateIso: new Date(internalDateMs).toISOString(),
    internalDateMs,
    labelIds: spec.sent ? ['SENT'] : ['INBOX'],
    listUnsubscribe: false,
    bodyText: spec.body ?? 'Can you review this?',
    ...(spec.headers ?? {}),
  } as GmailMessageMeta;
}

function thread(messages: GmailMessageMeta[], threadId = '18c2f4a9b3d21e07'): GmailThreadData {
  return { threadId, account: 'me@example.com', messages };
}

function loop(over: Partial<OpenLoopUpsert> = {}): OpenLoopUpsert {
  const threadId = over.threadId ?? '18c2f4a9b3d21e07';
  return {
    sourceId: 'g1',
    dedupKey: `thread:${threadId}:${over.loopType ?? 'unanswered_inbound'}`,
    loopType: 'unanswered_inbound',
    counterpartyEmail: 'alerts@bank-example.test',
    summary: 'Reply owed to alerts@bank-example.test: "Balance alert"',
    evidence: [{ message_id: 'm1', quote: 'Your balance is low.' }],
    threadId,
    detector: 'deterministic_thread',
    lastActivityAt: new Date(NOW.getTime() - 48 * 3_600_000).toISOString(),
    ...over,
  };
}

async function captured(fn: () => Promise<void>): Promise<{ out: string; err: string; verdict: number; exitCalled?: number }> {
  const outOrig = process.stdout.write.bind(process.stdout);
  const errOrig = process.stderr.write.bind(process.stderr);
  const cerrOrig = console.error;
  const exitOrig = process.exit;
  const out: string[] = [];
  const err: string[] = [];
  let exitCalled: number | undefined;
  _resetCliExitVerdictForTests();
  process.stdout.write = ((c: string | Uint8Array) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => { err.push(String(c)); return true; }) as typeof process.stderr.write;
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(' ') + '\n'); };
  process.exit = ((code?: number) => { exitCalled = code ?? 0; throw new Error('__exit__'); }) as typeof process.exit;
  try {
    await fn();
  } catch (e) {
    if ((e as Error).message !== '__exit__') throw e;
  } finally {
    process.exit = exitOrig;
    console.error = cerrOrig;
    process.stdout.write = outOrig;
    process.stderr.write = errOrig;
  }
  const verdict = currentExitCode();
  _resetCliExitVerdictForTests();
  process.exitCode = 0;
  return { out: out.join(''), err: err.join(''), verdict, ...(exitCalled !== undefined ? { exitCalled } : {}) };
}

async function row(id: number): Promise<{ status: string; closed_by: string | null }> {
  const [r] = await engine.executeRaw<{ status: string; closed_by: string | null }>('SELECT status, closed_by FROM open_loops WHERE id = $1', [id]);
  return r!;
}

describe('automated mail opens no reply-owed loop (forced probe)', () => {
  test('a Precedence: bulk bank alert to me opens nothing; the same alert without the header opens a loop', async () => {
    const alert = (headers?: { precedence?: string }) =>
      thread([msg({ from: 'alerts@bank-example.test', to: ['me@example.com'], ageHours: 48, headers })]);
    const v = await applyThreadLoopVerdict(engine, 'g1', alert({ precedence: 'bulk' }), MY, null, NOW);
    expect(await listOpenLoops(engine, { sourceIds: ['g1'], status: 'open' })).toHaveLength(0);
    expect((v as { withheld?: unknown }).withheld).toEqual({ reason: 'automated_mail', counterpartyEmail: 'alerts@bank-example.test' });
    await applyThreadLoopVerdict(engine, 'g1', alert(), MY, null, NOW);
    expect(await listOpenLoops(engine, { sourceIds: ['g1'], status: 'open' })).toHaveLength(1);
  });

  test('a List-Id or a no-reply Reply-To withholds the loop too', async () => {
    await applyThreadLoopVerdict(engine, 'g1', thread([msg({ from: 'team@lists-example.test', to: ['me@example.com'], ageHours: 48,
      headers: { listId: true } })], '18c2f4a9b3d21e08'), MY, null, NOW);
    await applyThreadLoopVerdict(engine, 'g1', thread([msg({ from: 'statements@bank-example.test', to: ['me@example.com'], ageHours: 48,
      headers: { replyTo: ['donotreply@bank-example.test'] } })], '18c2f4a9b3d21e09'), MY, null, NOW);
    expect(await listOpenLoops(engine, { sourceIds: ['g1'], status: 'open' })).toHaveLength(0);
  });

  test('the sweep record keeps the withheld sender until a later thread of theirs opens a loop', () => {
    const state = {} as GoogleSourceState;
    const record = (catchup as unknown as { recordWithheldVerdict: (s: GoogleSourceState, v: unknown, n: number) => void }).recordWithheldVerdict;
    record(state, { open: [], close: [], withheld: { reason: 'automated_mail', counterpartyEmail: 'alerts@bank-example.test' } }, 1);
    record(state, { open: [], close: [], withheld: { reason: 'automated_mail', counterpartyEmail: 'alerts@bank-example.test' } }, 2);
    expect(state.loop_withheld_senders).toEqual({ 'alerts@bank-example.test': { reason: 'automated_mail', count: 2, last_ms: 2 } });
    record(state, { open: [{ loopType: 'unanswered_inbound', counterpartyEmail: 'alerts@bank-example.test' }], close: [] }, 3);
    expect(state.loop_withheld_senders).toEqual({});
  });
});

describe('mute closes, unmute re-checks', () => {
  test('mute sender closes that sender\'s open reply-owed loops (muted) and prints the count and the undo', async () => {
    const a = await upsertOpenLoop(engine, loop());
    const b = await upsertOpenLoop(engine, loop({ threadId: '18c2f4a9b3d21e0a' }));
    const other = await upsertOpenLoop(engine, loop({ threadId: '18c2f4a9b3d21e0b', counterpartyEmail: 'carol@example.com' }));
    const commitment = await upsertOpenLoop(engine, loop({ dedupKey: 'commit:aaaa1111', loopType: 'commitment_owed_by_me', detector: 'llm_extract' }));
    const preview = await captured(() => runLoops(engine, ['mute', 'sender', 'alerts@bank-example.test', '--dry-run', '--json']));
    expect(JSON.parse(preview.out)).toMatchObject({ status: 'dry_run', would_close: [a.id, b.id], count: 2 });
    expect((await row(a.id)).status).toBe('open');

    const r = await captured(() => runLoops(engine, ['mute', 'sender', 'Alerts@Bank-Example.test']));
    expect(r.out).toContain(`closed 2 open reply-owed loop(s): ${a.id}, ${b.id}`);
    expect(r.out).toContain('Undo: gbrain loops unmute sender alerts@bank-example.test --source g1');
    expect(await row(a.id)).toEqual({ status: 'dropped', closed_by: 'muted' });
    expect(await row(b.id)).toEqual({ status: 'dropped', closed_by: 'muted' });
    expect((await row(other.id)).status).toBe('open');
    expect((await row(commitment.id)).status).toBe('open');
  });

  test('mute thread closes that thread\'s reply-owed loop; the MCP result lists it', async () => {
    const a = await upsertOpenLoop(engine, loop());
    const res = await handleToolCall(engine, 'loops_mute', { kind: 'thread', value: '18C2F4A9B3D21E07', source_id: 'g1' }) as Record<string, unknown>;
    expect(res).toMatchObject({ muted: true, closed: [a.id], count: 1, undo_command: 'gbrain loops unmute thread 18c2f4a9b3d21e07 --source g1' });
  });

  test('a sweep never reopens a muted loop for the same counterparty, even on newer activity', async () => {
    const a = await upsertOpenLoop(engine, loop());
    await handleToolCall(engine, 'loops_mute', { kind: 'sender', value: 'alerts@bank-example.test', source_id: 'g1' });
    const again = await upsertOpenLoop(engine, loop({ lastActivityAt: NOW.toISOString() }));
    expect(again.applied).toBe(false);
    expect(await row(a.id)).toEqual({ status: 'dropped', closed_by: 'muted' });
    // A different person writing later in the thread is not hidden by this sender's mute.
    const other = await upsertOpenLoop(engine, loop({ counterpartyEmail: 'carol@example.com', lastActivityAt: NOW.toISOString() }));
    expect(other.applied).toBe(true);
  });

  test('unmute queues the closed loops; the re-check reopens an unanswered thread and never one answered during the mute', async () => {
    const quiet = '18c2f4a9b3d21e0c';
    const answered = '18c2f4a9b3d21e0d';
    const owed = (tid: string) => msg({ from: 'founder@startup-example.test', to: ['me@example.com'], ageHours: 72, threadId: tid,
      body: 'Could we find 20 minutes next week?' });
    const q0 = owed(quiet);
    const a0 = owed(answered);
    await applyThreadLoopVerdict(engine, 'g1', thread([q0], quiet), MY, null, NOW);
    await applyThreadLoopVerdict(engine, 'g1', thread([a0], answered), MY, null, NOW);
    const [qLoop, aLoop] = await Promise.all([quiet, answered].map(async (tid) =>
      (await listOpenLoops(engine, { sourceIds: ['g1'], status: 'open' })).find((l) => l.thread_id === tid)!));
    await handleToolCall(engine, 'loops_mute', { kind: 'sender', value: 'founder@startup-example.test', source_id: 'g1' });

    const dry = await handleToolCall(engine, 'loops_unmute', { kind: 'sender', value: 'founder@startup-example.test', source_id: 'g1', dry_run: true }) as Record<string, unknown>;
    expect(dry).toMatchObject({ dry_run: true, would_requeue: [qLoop.id, aLoop.id].sort((x, y) => x - y) });
    expect((await row(qLoop.id)).closed_by).toBe('muted');

    const r = await captured(() => runLoops(engine, ['unmute', 'sender', 'founder@startup-example.test']));
    expect(r.out).toContain('Queued 2 loop(s) the mute closed for re-check on the next sync');
    expect(r.out).toContain('Undo: gbrain loops mute sender founder@startup-example.test --source g1');
    expect((await row(qLoop.id)).closed_by).toBe('mute_recheck');

    // The next sweep queues both threads through the grace-hold re-fetch.
    const state = {} as GoogleSourceState;
    await catchup.seedLoopRechecks(engine, 'g1', state, () => {}, NOW.getTime());
    expect(Object.keys(state.loop_grace_holds ?? {}).sort()).toEqual([quiet, answered].sort());

    // Re-fetched: the quiet thread is unchanged, the other was answered while muted.
    __clearSuppressionCacheForTests();
    await applyThreadLoopVerdict(engine, 'g1', thread([q0], quiet), MY, null, NOW);
    await applyThreadLoopVerdict(engine, 'g1', thread([a0, msg({ from: 'me@example.com', to: ['founder@startup-example.test'], ageHours: 10,
      sent: true, threadId: answered, body: 'Tuesday works, invite sent.' })], answered), MY, null, NOW);
    expect(await row(qLoop.id)).toEqual({ status: 'open', closed_by: null });
    expect(await row(aLoop.id)).toEqual({ status: 'done', closed_by: 'reply_detected' });
  });

  test('unmute never touches a manual disposition, and leaves a loop another mute still covers', async () => {
    const manual = await upsertOpenLoop(engine, loop());
    const covered = await upsertOpenLoop(engine, loop({ threadId: '18c2f4a9b3d21e0e' }));
    await loopsStore.closeOpenLoop(engine, 'g1', manual.id, 'dropped', 'manual');
    await handleToolCall(engine, 'loops_mute', { kind: 'sender', value: 'alerts@bank-example.test', source_id: 'g1' });
    await handleToolCall(engine, 'loops_mute', { kind: 'thread', value: '18c2f4a9b3d21e0e', source_id: 'g1' });
    const res = await handleToolCall(engine, 'loops_unmute', { kind: 'sender', value: 'alerts@bank-example.test', source_id: 'g1' }) as Record<string, unknown>;
    expect(res).toMatchObject({ removed: true, requeued: [], unverifiable: [] });
    expect(await row(manual.id)).toEqual({ status: 'dropped', closed_by: 'manual' });
    expect(await row(covered.id)).toEqual({ status: 'dropped', closed_by: 'muted' });
  });

  test('unmute reports a stale source with the sync that runs the re-check', async () => {
    await upsertOpenLoop(engine, loop());
    await handleToolCall(engine, 'loops_mute', { kind: 'sender', value: 'alerts@bank-example.test', source_id: 'g1' });
    await engine.executeRaw(`UPDATE sources SET last_sync_at = now() - interval '3 days' WHERE id = 'g1'`);
    const res = await handleToolCall(engine, 'loops_unmute', { kind: 'sender', value: 'alerts@bank-example.test', source_id: 'g1' }) as Record<string, unknown>;
    expect(res).toMatchObject({ stale_source: true, recheck_command: 'gbrain sync --source g1' });
  });
});

describe('the google-loops skill runbook matches the CLI', () => {
  test('skills/google-loops/SKILL.md names drop sender with its dry run, unmute, and withheld_noise', async () => {
    const skill = readFileSync(join(import.meta.dir, '..', 'skills', 'google-loops', 'SKILL.md'), 'utf8');
    for (const line of ['gbrain loops drop sender <email> --dry-run', 'gbrain loops unmute sender <email>', 'withheld_noise', 'cannot be undone']) {
      expect(skill).toContain(line);
    }
    const help = await captured(() => runLoops(engine, ['--help']));
    expect(help.out + help.err).toContain('drop  sender <email> [--source <id>] [--note <text>] [--dry-run]');
  });
});

describe('loops drop sender', () => {
  test('--dry-run lists ids and count and changes nothing; the apply closes only that sender\'s reply-owed loops', async () => {
    const a = await upsertOpenLoop(engine, loop());
    const b = await upsertOpenLoop(engine, loop({ threadId: '18c2f4a9b3d21e0f' }));
    const other = await upsertOpenLoop(engine, loop({ threadId: '18c2f4a9b3d21e10', counterpartyEmail: 'carol@example.com' }));
    const outbound = await upsertOpenLoop(engine, loop({ threadId: '18c2f4a9b3d21e11', loopType: 'unanswered_outbound' }));

    const dry = await captured(() => runLoops(engine, ['drop', 'sender', 'alerts@bank-example.test', '--dry-run', '--json']));
    expect(JSON.parse(dry.out)).toMatchObject({ ok: true, status: 'dry_run', would_close: [a.id, b.id], count: 2,
      apply_command: 'gbrain loops drop sender alerts@bank-example.test' });
    expect((await row(a.id)).status).toBe('open');
    const human = await captured(() => runLoops(engine, ['drop', 'sender', 'alerts@bank-example.test', '--dry-run']));
    expect(human.out).toContain('would be dropped');
    expect(human.out).toContain('cannot be undone');

    const r = await captured(() => runLoops(engine, ['drop', 'sender', 'alerts@bank-example.test', '--source', 'g1', '--json']));
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, status: 'dropped', closed: [a.id, b.id], failed: [], count: 2 });
    expect(await row(a.id)).toEqual({ status: 'dropped', closed_by: 'drop sender alerts@bank-example.test' });
    expect((await row(other.id)).status).toBe('open');
    expect((await row(outbound.id)).status).toBe('open');
    expect(r.verdict).toBe(0);
  });

  test('drop sender without an email is a usage error', async () => {
    const r = await captured(() => runLoops(engine, ['drop', 'sender']));
    expect(r.exitCalled).toBe(2);
  });
});

describe('gbrain waiting reports the loops the rule would not have opened', () => {
  test('counts open reply-owed loops from recorded senders and prints the exact dry-run command', async () => {
    await upsertOpenLoop(engine, loop());
    await upsertOpenLoop(engine, loop({ threadId: '18c2f4a9b3d21e12' }));
    await upsertOpenLoop(engine, loop({ threadId: '18c2f4a9b3d21e13', counterpartyEmail: 'carol@example.com' }));
    writeFileSync(join(stateDir, '.google-source.json'), JSON.stringify({
      loop_withheld_senders: { 'alerts@bank-example.test': { reason: 'automated_mail', count: 1, last_ms: 1 } } }));
    const r = await captured(() => runWaiting(engine, []));
    expect(r.out).toContain('2 open reply-owed loop(s) come from 1 sender(s) whose mail is automated');
    expect(r.out).toContain('gbrain loops drop sender alerts@bank-example.test --source g1 --dry-run');
    const j = await captured(() => runWaiting(engine, ['--json']));
    expect(JSON.parse(j.out).withheld_noise).toMatchObject({ loop_count: 2, sender_count: 1,
      senders: [{ email: 'alerts@bank-example.test', source_id: 'g1', open_loops: 2 }] });
  });

  test('the one-shot sender backfill queues the newest thread of each sender with open reply-owed loops', async () => {
    await upsertOpenLoop(engine, loop({ lastActivityAt: '2026-08-01T00:00:00Z' }));
    await upsertOpenLoop(engine, loop({ threadId: '18c2f4a9b3d21e14', lastActivityAt: '2026-08-02T00:00:00Z' }));
    await upsertOpenLoop(engine, loop({ threadId: '18c2f4a9b3d21e15', counterpartyEmail: 'carol@example.com' }));
    const state = {} as GoogleSourceState;
    expect(await catchup.seedLoopRechecks(engine, 'g1', state, () => {}, NOW.getTime())).toBe(2);
    expect(Object.keys(state.loop_grace_holds ?? {}).sort()).toEqual(['18c2f4a9b3d21e14', '18c2f4a9b3d21e15']);
    expect(state.loop_automated_backfill_done).toBe(true);
    expect(await catchup.seedLoopRechecks(engine, 'g1', { loop_automated_backfill_done: true } as GoogleSourceState, () => {}, NOW.getTime())).toBe(0);
  });

  test('the sender backfill leaves threads an unfinished backfill walk will fetch to that walk', async () => {
    await upsertOpenLoop(engine, loop({ lastActivityAt: '2026-08-01T00:00:00Z' }));
    await upsertOpenLoop(engine, loop({ threadId: '18c2f4a9b3d21e15', counterpartyEmail: 'carol@example.com', lastActivityAt: '2026-08-24T00:00:00Z' }));
    const state = {} as GoogleSourceState;
    const walkFromMs = Date.parse('2026-08-20T00:00:00Z');
    expect(await catchup.seedLoopRechecks(engine, 'g1', state, () => {}, NOW.getTime(), walkFromMs)).toBe(1);
    expect(Object.keys(state.loop_grace_holds ?? {})).toEqual(['18c2f4a9b3d21e07']);
    expect(state.loop_automated_backfill_done).toBe(true);
  });
});

describe('opt-in Updates reciprocity', () => {
  test('off by default (null); on, the set holds the people the owner wrote to', async () => {
    const r = (await import('../src/core/google/loops-reciprocity.ts')) as unknown as {
      ownerWroteToFor: (e: PGLiteEngine, s: string, my: Set<string>) => Promise<Set<string> | null>;
      validateLoopsReciprocityConfigValue: (k: string, v: string) => string | null;
      __clearReciprocityCacheForTests: (e: PGLiteEngine) => void;
    };
    r.__clearReciprocityCacheForTests(engine);
    expect(await r.ownerWroteToFor(engine, 'g1', MY)).toBeNull();
    await engine.putPage('email/2026/08/plan', { type: 'email', title: 'Plan', compiled_truth: 'x', timeline: '',
      frontmatter: { senders: ['me@example.com', 'bob@example.com'], participants: ['me@example.com', 'bob@example.com', 'Dana@Example.com'] } }, { sourceId: 'g1' });
    await engine.putPage('email/2026/08/news', { type: 'email', title: 'News', compiled_truth: 'x', timeline: '',
      frontmatter: { senders: ['news@example.com'], participants: ['news@example.com', 'me@example.com'] } }, { sourceId: 'g1' });
    await engine.setConfig('loops.updates_require_reciprocity', 'true');
    r.__clearReciprocityCacheForTests(engine);
    expect([...(await r.ownerWroteToFor(engine, 'g1', MY))!].sort()).toEqual(['bob@example.com', 'dana@example.com']);
    expect(r.validateLoopsReciprocityConfigValue('loops.updates_require_reciprocity', 'maybe')).toContain('must be true or false');
    expect(r.validateLoopsReciprocityConfigValue('loops.updates_require_reciprocity', 'false')).toBeNull();
  });
});
