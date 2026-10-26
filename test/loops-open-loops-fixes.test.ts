/**
 * Open-loops fix wave (#7285 #7286 #7287 #7288 #7291) on PGLite: the store,
 * the op handlers and the CLI together. Each test fails on the pre-fix code.
 *
 * Synthetic data only (sender-a@example.com, src-google).
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { loopsOperations } from '../src/core/ops/loops.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { runLoops, runWaiting } from '../src/commands/loops.ts';
import { currentExitCode, _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import {
  addSuppression,
  closeMutedLoops,
  countOpenLoops,
  listLoopsByAge,
  listOpenLoops,
  markStaleLoops,
  requeueMutedLoops,
  undoAgeDrop,
  upsertOpenLoop,
  type OpenLoopUpsert,
} from '../src/core/loops/loops-store.ts';

const SRC = 'src-google';
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
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config, last_sync_at) VALUES ($1, $1, '{"kind":"google"}'::jsonb, now())
     ON CONFLICT (id) DO NOTHING`, [SRC]);
  _resetCliExitVerdictForTests();
});

const openLoopsOp = loopsOperations.find((o) => o.name === 'open_loops')!;
const loopsMuteOp = loopsOperations.find((o) => o.name === 'loops_mute')!;

function ctx(over: Partial<OperationContext> = {}): OperationContext {
  return {
    engine, config: {} as OperationContext['config'], logger: { info() {}, warn() {}, error() {} },
    dryRun: false, remote: false, sourceId: SRC, ...over,
  } as OperationContext;
}

let seq = 0;
function loop(over: Partial<OpenLoopUpsert> = {}): OpenLoopUpsert {
  seq++;
  const threadId = over.threadId ?? `thread-${seq}`;
  return {
    sourceId: SRC,
    dedupKey: `thread:${threadId}:${over.loopType ?? 'unanswered_inbound'}`,
    loopType: 'unanswered_inbound',
    counterpartyEmail: 'sender-a@example.com',
    summary: `Reply owed ${seq}`,
    evidence: [{ message_id: `m${seq}`, quote: `quote ${seq}` }],
    threadId,
    detector: 'deterministic_thread',
    ...over,
  };
}

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

async function status(id: number): Promise<{ status: string; closed_by: string | null }> {
  const [r] = await engine.executeRaw<{ status: string; closed_by: string | null }>(
    `SELECT status, closed_by FROM open_loops WHERE id = $1`, [id]);
  return r;
}

async function captured(fn: () => Promise<void>): Promise<{ out: string; err: string; verdict: number }> {
  const outOrig = process.stdout.write.bind(process.stdout);
  const errOrig = process.stderr.write.bind(process.stderr);
  const cerrOrig = console.error;
  const exitOrig = process.exit;
  const out: string[] = [];
  const err: string[] = [];
  _resetCliExitVerdictForTests();
  process.stdout.write = ((c: string | Uint8Array) => { out.push(typeof c === 'string' ? c : Buffer.from(c).toString()); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => { err.push(typeof c === 'string' ? c : Buffer.from(c).toString()); return true; }) as typeof process.stderr.write;
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(' ') + '\n'); };
  process.exit = ((code?: number) => { throw new Error(`__exit__${code ?? 0}`); }) as typeof process.exit;
  try {
    await fn();
  } catch (e) {
    if (!(e as Error).message.startsWith('__exit__')) throw e;
  } finally {
    process.exit = exitOrig;
    process.stdout.write = outOrig;
    process.stderr.write = errOrig;
    console.error = cerrOrig;
  }
  const verdict = currentExitCode();
  _resetCliExitVerdictForTests();
  return { out: out.join(''), err: err.join(''), verdict };
}

describe('#7291 paging', () => {
  async function seed(n: number): Promise<void> {
    for (let i = 0; i < n; i++) await upsertOpenLoop(engine, loop({ counterpartyEmail: `p${i}@example.com`, lastActivityAt: daysAgo(i) }));
  }

  test('store: offset pages the recency order and countOpenLoops is the true total', async () => {
    await seed(7);
    const all = await listOpenLoops(engine, { status: 'open' });
    const page = await listOpenLoops(engine, { status: 'open', limit: 3, offset: 3 });
    expect(page.map((l) => l.id)).toEqual(all.slice(3, 6).map((l) => l.id));
    expect(await countOpenLoops(engine, { status: 'open' })).toBe(7);
    expect(await countOpenLoops(engine, { status: 'dropped' })).toBe(0);
  });

  test('op: flat view reports total, offset and an honest truncated flag', async () => {
    await seed(7);
    type Flat = { loops: Array<{ id: number }>; total: number; offset: number; truncated: boolean };
    const first = (await openLoopsOp.handler(ctx(), { group_by: 'none', limit: 3 })) as Flat;
    expect(first).toMatchObject({ total: 7, offset: 0, truncated: true });
    const last = (await openLoopsOp.handler(ctx(), { group_by: 'none', limit: 3, offset: 6 })) as Flat;
    expect(last.loops).toHaveLength(1);
    expect(last).toMatchObject({ total: 7, offset: 6, truncated: false });
    expect(last.loops[0].id).not.toBe(first.loops[0].id);
    await expect(openLoopsOp.handler(ctx(), { group_by: 'none', offset: -1 })).rejects.toThrow(/offset/);
  });

  test('cli: --limit/--offset/--json carry the true total and next_offset; --all returns every row', async () => {
    await seed(7);
    const paged = JSON.parse((await captured(() => runLoops(engine, ['list', '--limit', '2', '--offset', '1', '--json']))).out) as
      { loops: unknown[]; total: number; truncated: boolean; next_offset: number; returned: number };
    expect(paged).toMatchObject({ total: 7, truncated: true, next_offset: 3, returned: 2 });
    const everything = JSON.parse((await captured(() => runLoops(engine, ['list', '--all', '--json']))).out) as
      { loops: unknown[]; total: number; truncated: boolean };
    expect(everything.loops).toHaveLength(7);
    expect(everything.truncated).toBe(false);
    const human = (await captured(() => runLoops(engine, ['list', '--limit', '2']))).out;
    expect(human).toContain('Showing 2 of 7');
    expect(human).toContain('--offset 2');
    const bad = await captured(() => runLoops(engine, ['list', '--limit', 'abc']));
    expect(bad.err + bad.out).toContain('--limit');
  });
});

describe('#7287 mute closes every loop type', () => {
  test('store: sender mute closes extracted commitments too; loopTypes narrows it', async () => {
    const inbound = await upsertOpenLoop(engine, loop());
    const commitment = await upsertOpenLoop(engine, loop({ loopType: 'commitment_owed_to_me', detector: 'llm_extract' }));
    const other = await upsertOpenLoop(engine, loop({ counterpartyEmail: 'sender-b@example.com', loopType: 'commitment_owed_to_me', detector: 'llm_extract' }));
    expect(await closeMutedLoops(engine, SRC, 'sender', 'sender-a@example.com', false, ['unanswered_inbound'])).toEqual([inbound.id]);
    expect(await closeMutedLoops(engine, SRC, 'sender', 'sender-a@example.com', true)).toEqual([inbound.id, commitment.id].sort((a, b) => a - b));
    expect((await status(commitment.id))).toEqual({ status: 'dropped', closed_by: 'muted' });
    expect((await status(other.id)).status).toBe('open');
  });

  test('op: loops_mute drops the sender\'s commitment loops and honors loop_type', async () => {
    const inbound = await upsertOpenLoop(engine, loop());
    const commitment = await upsertOpenLoop(engine, loop({ loopType: 'commitment_owed_to_me', detector: 'llm_extract' }));
    const narrowed = (await loopsMuteOp.handler(ctx(), { kind: 'sender', value: 'sender-a@example.com', source_id: SRC, loop_type: 'unanswered_inbound' })) as { closed: number[] };
    expect(narrowed.closed).toEqual([inbound.id]);
    expect((await status(commitment.id)).status).toBe('open');
    const full = (await loopsMuteOp.handler(ctx(), { kind: 'sender', value: 'sender-a@example.com', source_id: SRC })) as { closed: number[]; facts_retired: number };
    expect(full.closed).toEqual([commitment.id]);
    expect(full.facts_retired).toBe(0);
    expect((await status(commitment.id)).closed_by).toBe('muted');
  });

  test('unmute re-checks only deterministic thread loops; an extracted loop stays closed', async () => {
    const inbound = await upsertOpenLoop(engine, loop());
    const commitment = await upsertOpenLoop(engine, loop({ loopType: 'commitment_owed_to_me', detector: 'llm_extract' }));
    await addSuppression(engine, SRC, 'sender', 'sender-a@example.com');
    await closeMutedLoops(engine, SRC, 'sender', 'sender-a@example.com', true);
    const r = await requeueMutedLoops(engine, SRC, 'sender', 'sender-a@example.com', true);
    expect(r.requeued).toEqual([inbound.id]);
    expect(r.unverifiable).toEqual([commitment.id]);
    expect((await status(commitment.id)).closed_by).toBe('unmuted');
  });
});

describe('#7288 age-based close', () => {
  test('store: reply-owed horizon is off by default, on with days, and leaves recent loops open', async () => {
    const old = await upsertOpenLoop(engine, loop({ lastActivityAt: daysAgo(120) }));
    const recent = await upsertOpenLoop(engine, loop({ lastActivityAt: daysAgo(5) }));
    const oldCommitment = await upsertOpenLoop(engine, loop({ loopType: 'commitment_owed_by_me', detector: 'manual', lastActivityAt: daysAgo(120) }));
    expect(await markStaleLoops(engine, SRC)).toBe(0);
    expect(await markStaleLoops(engine, SRC, { replyOwedStaleDays: 90 })).toBe(1);
    expect((await status(old.id)).status).toBe('stale');
    expect((await status(recent.id)).status).toBe('open');
    expect((await status(oldCommitment.id)).status).toBe('open');
  });

  test('cli: drop --older-than previews, closes with closed_by age_drop, and --undo-age-drop reverses it', async () => {
    const old1 = await upsertOpenLoop(engine, loop({ counterpartyEmail: 'sender-a@example.com', lastActivityAt: daysAgo(60) }));
    const old2 = await upsertOpenLoop(engine, loop({ counterpartyEmail: 'sender-b@example.com', lastActivityAt: daysAgo(45) }));
    const recent = await upsertOpenLoop(engine, loop({ lastActivityAt: daysAgo(3) }));
    expect((await listLoopsByAge(engine, { olderThanDays: 30 })).map((l) => l.id).sort((a, b) => a - b)).toEqual([old1.id, old2.id].sort((a, b) => a - b));

    const dry = JSON.parse((await captured(() => runLoops(engine, ['drop', '--older-than', '30d', '--dry-run', '--json']))).out) as
      { status: string; count: number; apply_command: string; undo_command: string };
    expect(dry).toMatchObject({ status: 'dry_run', count: 2 });
    expect(dry.apply_command).toContain('--older-than 30d');
    expect(dry.undo_command).toContain('--undo-age-drop');
    expect((await status(old1.id)).status).toBe('open');

    const run = JSON.parse((await captured(() => runLoops(engine, ['drop', '--older-than', '30d', '--json']))).out) as { status: string; count: number };
    expect(run).toMatchObject({ status: 'dropped', count: 2 });
    expect(await status(old1.id)).toEqual({ status: 'dropped', closed_by: 'age_drop' });
    expect((await status(recent.id)).status).toBe('open');

    expect((await undoAgeDrop(engine, {}, false)).reopened).toHaveLength(2);
    const undo = JSON.parse((await captured(() => runLoops(engine, ['drop', '--undo-age-drop', '--json']))).out) as { reopened: number[] };
    expect(undo.reopened).toHaveLength(2);
    expect(await status(old2.id)).toEqual({ status: 'open', closed_by: null });
  });

  test('cli: --type narrows, a malformed horizon is refused', async () => {
    await upsertOpenLoop(engine, loop({ lastActivityAt: daysAgo(60) }));
    const c = await upsertOpenLoop(engine, loop({ loopType: 'commitment_owed_to_me', detector: 'llm_extract', lastActivityAt: daysAgo(60) }));
    const dry = JSON.parse((await captured(() => runLoops(engine, ['drop', '--older-than', '30', '--type', 'commitment_owed_to_me', '--dry-run', '--json']))).out) as { would_close: number[] };
    expect(dry.would_close).toEqual([c.id]);
    const bad = await captured(() => runLoops(engine, ['drop', '--older-than', 'soon']));
    expect(bad.err + bad.out).toContain('--older-than');
  });
});

describe('#7285 withheld_noise lists every sender', () => {
  test('12 automated senders, no connector record: all 12 come back, most loops first; --noise prints them all', async () => {
    for (let i = 0; i < 12; i++) {
      for (let j = 0; j <= i; j++) await upsertOpenLoop(engine, loop({ counterpartyEmail: `noreply-${String(i).padStart(2, '0')}@example.com` }));
    }
    await upsertOpenLoop(engine, loop({ counterpartyEmail: 'sender-a@example.com' }));
    const res = (await openLoopsOp.handler(ctx(), {})) as { withheld_noise: { sender_count: number; loop_count: number; senders: Array<{ email: string; open_loops: number }> } };
    expect(res.withheld_noise.sender_count).toBe(12);
    expect(res.withheld_noise.senders).toHaveLength(12);
    expect(res.withheld_noise.senders[0]).toMatchObject({ email: 'noreply-11@example.com', open_loops: 12 });
    expect(res.withheld_noise.senders.some((s) => s.email === 'sender-a@example.com')).toBe(false);

    const digest = (await captured(() => runWaiting(engine, []))).out;
    expect(digest).toContain('and 2 more sender(s)');
    expect(digest).toContain('gbrain waiting --noise');
    const full = (await captured(() => runWaiting(engine, ['--noise']))).out;
    expect(full).not.toContain('more sender(s)');
    expect(full).toContain('noreply-00@example.com');
  });
});

describe('#7286 out-of-scope google sources', () => {
  test('a caller bound to a non-google source is told sources exist elsewhere (ids only)', async () => {
    for (let i = 0; i < 3; i++) await upsertOpenLoop(engine, loop());
    const res = (await openLoopsOp.handler(ctx({ remote: true, sourceId: 'default' }), { group_by: 'none' })) as Record<string, unknown>;
    expect(res.loops).toEqual([]);
    expect(res.no_google_sources).toBe(true);
    expect(res.google_sources_out_of_scope).toEqual([SRC]);
    // Ids only: no loop counts, summaries or senders of the hidden source reach the caller.
    expect(JSON.stringify(res)).not.toContain('Reply owed');
    expect(res.total).toBe(0);

    const grouped = (await openLoopsOp.handler(ctx({ remote: true, sourceId: 'default' }), {})) as { google_sources_out_of_scope: string[] };
    expect(grouped.google_sources_out_of_scope).toEqual([SRC]);
  });

  test('no marker when the caller can see a google source, or when the brain has none', async () => {
    const inScope = (await openLoopsOp.handler(ctx({ remote: true, sourceId: SRC }), { group_by: 'none' })) as Record<string, unknown>;
    expect(inScope.google_sources_out_of_scope).toBeUndefined();
    await engine.executeRaw(`DELETE FROM sources WHERE id = $1`, [SRC]);
    const none = (await openLoopsOp.handler(ctx({ remote: true, sourceId: 'default' }), { group_by: 'none' })) as Record<string, unknown>;
    expect(none.google_sources_out_of_scope).toBeUndefined();
    expect(none.no_google_sources).toBe(true);
  });
});
