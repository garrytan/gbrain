/**
 * gbrain waiting / gbrain loops CLI (src/commands/loops.ts) on a real PGLite
 * engine with a seeded google source + loops.
 *
 * SCOPING: runWaiting/runLoops pass `sourceId: '__all__'` to handleToolCall,
 * so trusted-local CLI reads span the whole brain — loops living in a real
 * google source are visible without any --source flag (the '--source <id>'
 * flag narrows explicitly). Pinned below as the cross-source-visibility test.
 * Most tests here still seed loops into 'default' for convenience; the brain
 * span includes it.
 *
 * Output capture swaps process.stdout.write / process.stderr.write and stubs
 * process.exit (restored in finally — same harness as
 * test/sync-working-tree-cli.test.ts). Exit verdicts are read through
 * currentExitCode() (the gbrain-owned channel) and reset per run.
 *
 * Synthetic data only.
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runLoops, runWaiting } from '../src/commands/loops.ts';
import {
  currentExitCode,
  _resetCliExitVerdictForTests,
} from '../src/core/cli-force-exit.ts';
import {
  loadSuppressions,
  upsertOpenLoop,
  type OpenLoopUpsert,
} from '../src/core/loops/loops-store.ts';

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
  // Make 'default' a fresh google source: freshness gating needs at least one
  // google source, and seeding loops into 'default' keeps fixtures short (the
  // CLI's __all__ span includes it).
  await engine.executeRaw(
    `UPDATE sources SET config = '{"kind":"google"}'::jsonb, last_sync_at = now() WHERE id = 'default'`,
  );
  _resetCliExitVerdictForTests();
});

function loop(over: Partial<OpenLoopUpsert> = {}): OpenLoopUpsert {
  return {
    sourceId: 'default',
    dedupKey: `thread:${over.threadId ?? '18c2f4a9b3d21e07'}:${over.loopType ?? 'unanswered_inbound'}`,
    loopType: 'unanswered_inbound',
    counterpartyEmail: 'bob@example.com',
    summary: 'Reply owed to bob@example.com: "Quarterly plan" (2d)',
    evidence: [{ message_id: '18c2f4a9b3d21e07', quote: 'Can you review the plan?' }],
    threadId: '18c2f4a9b3d21e07',
    detector: 'deterministic_thread',
    ...over,
  };
}

async function makeStale(): Promise<void> {
  await engine.executeRaw(
    `UPDATE sources SET last_sync_at = now() - interval '3 days' WHERE id = 'default'`,
  );
}

interface Captured {
  out: string;
  err: string;
  /** gbrain's owned exit verdict after the run (0 when none was set). */
  verdict: number;
  /** Set only when the command hard-called process.exit(code). */
  exitCalled: number | undefined;
}

async function captured(fn: () => Promise<void>): Promise<Captured> {
  const outOrig = process.stdout.write.bind(process.stdout);
  const errOrig = process.stderr.write.bind(process.stderr);
  const exitOrig = process.exit;
  const prevExitCode = process.exitCode;
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  let exitCalled: number | undefined;
  _resetCliExitVerdictForTests();
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    outChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    errChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    exitCalled = code ?? 0;
    throw new Error('__exit__');
  }) as typeof process.exit;
  try {
    await fn();
  } catch (e) {
    if ((e as Error).message !== '__exit__') throw e;
  } finally {
    process.exit = exitOrig;
    process.stdout.write = outOrig;
    process.stderr.write = errOrig;
  }
  const verdict = currentExitCode();
  // Never leak a verdict (or its process.exitCode mirror) into other tests.
  _resetCliExitVerdictForTests();
  process.exitCode = prevExitCode ?? 0;
  return { out: outChunks.join(''), err: errChunks.join(''), verdict, exitCalled };
}

// ── gbrain waiting ───────────────────────────────────────────────────────────

describe('runWaiting', () => {
  test('stale google source → refusal on stderr with the exact sync fix, verdict 1', async () => {
    await upsertOpenLoop(engine, loop());
    await makeStale();
    const r = await captured(() => runWaiting(engine, []));
    expect(r.err).toContain('Refusing to answer from stale data');
    expect(r.err).toContain('gbrain sync --source default'); // the exact fix
    expect(r.err).toContain('--stale-ok');
    // The digest is withheld: no loop content leaks past the refusal.
    expect(r.out).toBe('');
    expect(r.err).not.toContain('Can you review the plan?');
    expect(r.verdict).toBe(1);
    expect(r.exitCalled).toBeUndefined(); // verdict channel, not a hard exit
  });

  test('stale + --json → { ok:false, status:"stale", next_action.command } envelope, verdict 1', async () => {
    await upsertOpenLoop(engine, loop());
    await makeStale();
    const r = await captured(() => runWaiting(engine, ['--json']));
    const env = JSON.parse(r.out) as {
      ok: boolean;
      status: string;
      sources: Array<{ id: string; stale: boolean; last_sync_at: string | null }>;
      next_action: { command: string };
    };
    expect(env.ok).toBe(false);
    expect(env.status).toBe('stale');
    expect(env.sources).toHaveLength(1);
    expect(env.sources[0].id).toBe('default');
    expect(env.sources[0].stale).toBe(true);
    expect(env.next_action.command).toBe('gbrain sync --source default');
    expect(r.verdict).toBe(1);
  });

  test('--stale-ok bypasses the refusal and prints the loops (with the staleness banner)', async () => {
    await upsertOpenLoop(engine, loop());
    await makeStale();
    const r = await captured(() => runWaiting(engine, ['--stale-ok']));
    expect(r.out).toContain('waiting on you'); // "1 person is waiting on you"
    expect(r.out).toContain('may be out of date'); // the honesty banner survives
    expect(r.out).toContain('Can you review the plan?');
    expect(r.verdict).toBe(0);
  });

  test('fresh source → the digest prints with quote, close hint, verdict 0', async () => {
    await upsertOpenLoop(engine, loop());
    const r = await captured(() => runWaiting(engine, []));
    expect(r.out).toContain('1 person is waiting on you');
    expect(r.out).toContain('bob@example.com');
    expect(r.out).toContain('Can you review the plan?');
    expect(r.out).toContain('gbrain loops done <id>'); // the management hint
    expect(r.verdict).toBe(0);
  });

  test('fresh source, zero loops → "You are clean", no management hint', async () => {
    const r = await captured(() => runWaiting(engine, []));
    expect(r.out).toContain('You are clean');
    expect(r.out).not.toContain('gbrain loops done');
    expect(r.verdict).toBe(0);
  });

  test('fresh --json → { ok:true, status:"ok" } envelope carrying groups + text', async () => {
    await upsertOpenLoop(engine, loop());
    const r = await captured(() => runWaiting(engine, ['--json']));
    const env = JSON.parse(r.out) as {
      ok: boolean;
      status: string;
      count: number;
      groups: Array<{ counterparty: string }>;
      text: string;
    };
    expect(env.ok).toBe(true);
    expect(env.status).toBe('ok');
    expect(env.count).toBe(1);
    expect(env.groups[0].counterparty).toBe('bob@example.com');
    expect(env.text).toContain('waiting on you');
    expect(r.verdict).toBe(0);
  });

  test('no google source in the brain → the honest connect hint prints (NOT "You are clean"), verdict 0; --json carries no_google_sources', async () => {
    // Flip 'default' back to a plain (non-google) source: the open-loop
    // engine now has nothing to read, and "You are clean" would be a
    // confident lie on a brain whose email arrives some other way.
    await engine.executeRaw(`UPDATE sources SET config = '{}'::jsonb WHERE id = 'default'`);
    const r = await captured(() => runWaiting(engine, []));
    expect(r.out).toContain('No google source is connected');
    expect(r.out).not.toContain('You are clean');
    expect(r.out).toContain('gbrain google setup'); // the connect fix rides along
    expect(r.verdict).toBe(0); // an unconnected brain is not an error state

    const j = await captured(() => runWaiting(engine, ['--json']));
    const env = JSON.parse(j.out) as {
      ok: boolean;
      status: string;
      count: number;
      no_google_sources: boolean;
      stale: boolean;
    };
    expect(env.ok).toBe(true);
    expect(env.status).toBe('ok');
    expect(env.no_google_sources).toBe(true);
    expect(env.count).toBe(0);
    expect(env.stale).toBe(false); // empty freshness set must not read stale
    expect(j.verdict).toBe(0);
  });

  test('loops in a NON-default google source are visible to the CLI (brain-wide __all__ scope)', async () => {
    // runWaiting passes sourceId '__all__' → trusted-local span of every
    // source — a loop detected by a real google sync (living in that source's
    // id, not 'default') shows up with no --source flag. This is the killer
    // output's correctness bar: "You are clean" while g1 holds a loop would
    // be a silent lie.
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config, last_sync_at)
       VALUES ('g1', 'g1', '{"kind":"google"}'::jsonb, now())
       ON CONFLICT (id) DO NOTHING`,
    );
    await upsertOpenLoop(engine, loop({ sourceId: 'g1' }));
    const r = await captured(() => runWaiting(engine, []));
    expect(r.out).toContain('waiting on you');
    expect(r.out).toContain('bob@example.com');
    expect(r.verdict).toBe(0);

    // --source narrows explicitly: scoping to 'default' hides g1's loop.
    const scoped = await captured(() => runWaiting(engine, ['--source', 'default']));
    expect(scoped.out).toContain('You are clean');
  });
});

// ── gbrain loops ─────────────────────────────────────────────────────────────

describe('runLoops', () => {
  test('list prints one line per loop; --json envelope carries ok/status/count', async () => {
    await upsertOpenLoop(engine, loop({ threadId: '18c2f4a9b3d21e01', counterpartyEmail: 'alice@example.com' }));
    await upsertOpenLoop(engine, loop({ threadId: '18c2f4a9b3d21e02', counterpartyEmail: 'bob@example.com' }));
    const human = await captured(() => runLoops(engine, ['list']));
    expect(human.out).toContain('#1');
    expect(human.out).toContain('#2');
    expect(human.out).toContain('[unanswered_inbound]');
    expect(human.verdict).toBe(0);

    const json = await captured(() => runLoops(engine, ['list', '--json']));
    const env = JSON.parse(json.out) as { ok: boolean; status: string; count: number; loops: unknown[] };
    expect(env.ok).toBe(true);
    expect(env.status).toBe('ok');
    expect(env.count).toBe(2);
    expect(env.loops).toHaveLength(2);
  });

  test('list with zero matches says so', async () => {
    const r = await captured(() => runLoops(engine, ['list']));
    expect(r.out).toContain('No loops match.');
    expect(r.verdict).toBe(0);
  });

  test('show <id> prints the loop with quote; --json wraps it in ok/status', async () => {
    await upsertOpenLoop(engine, loop());
    const human = await captured(() => runLoops(engine, ['show', '1']));
    expect(human.out).toContain('#1 [unanswered_inbound] open');
    expect(human.out).toContain('Reply owed to bob@example.com');
    expect(human.out).toContain('> "Can you review the plan?"');
    expect(human.verdict).toBe(0);

    const json = await captured(() => runLoops(engine, ['show', '1', '--json']));
    const env = JSON.parse(json.out) as { ok: boolean; status: string; loop: { id: number } };
    expect(env.ok).toBe(true);
    expect(env.status).toBe('ok');
    expect(env.loop.id).toBe(1);
  });

  test('show with an unknown id sets verdict 1', async () => {
    const r = await captured(() => runLoops(engine, ['show', '999']));
    expect(r.verdict).toBe(1);
  });

  test('done closes the loop; the --json envelope reports ok/status; re-close fails honestly', async () => {
    await upsertOpenLoop(engine, loop());
    const r = await captured(() => runLoops(engine, ['done', '1']));
    expect(r.out).toContain('Loop 1 done.');
    expect(r.verdict).toBe(0);
    const rows = await engine.executeRaw<{ status: string; closed_by: string }>(
      `SELECT status, closed_by FROM open_loops WHERE id = 1`,
    );
    expect(rows[0].status).toBe('done');
    expect(rows[0].closed_by).toBe('manual');

    // Second close: not_closed envelope + verdict 1.
    const again = await captured(() => runLoops(engine, ['done', '1', '--json']));
    const env = JSON.parse(again.out) as { ok: boolean; status: string; reason?: string };
    expect(env.ok).toBe(false);
    expect(env.status).toBe('not_closed');
    expect(env.reason).toBe('not_found_or_already_closed');
    expect(again.verdict).toBe(1);
  });

  test('drop marks the loop dropped; --json envelope carries ok + the loop status', async () => {
    await upsertOpenLoop(engine, loop());
    const r = await captured(() => runLoops(engine, ['drop', '1', '--json']));
    const env = JSON.parse(r.out) as { ok: boolean; status: string; loop_status: string; id: number };
    expect(env.ok).toBe(true);
    // Envelope status is the outcome; the row's terminal state rides as
    // loop_status (a spread-last op result must not clobber the envelope).
    expect(env.status).toBe('closed');
    expect(env.loop_status).toBe('dropped');
    expect(env.id).toBe(1);
    expect(r.verdict).toBe(0);
    const rows = await engine.executeRaw<{ status: string }>(`SELECT status FROM open_loops WHERE id = 1`);
    expect(rows[0].status).toBe('dropped');
  });

  test('done without a numeric id hard-exits with usage code 2', async () => {
    const r = await captured(() => runLoops(engine, ['done']));
    expect(r.exitCalled).toBe(2);
  });

  test('mute sender writes the suppression row (lowercased) and prints the semantics', async () => {
    const r = await captured(() => runLoops(engine, ['mute', 'sender', 'Bob@Example.com']));
    expect(r.out).toContain('Muted sender Bob@Example.com');
    expect(r.out).toContain("existing loops keep their state");
    expect(r.verdict).toBe(0);
    const set = await loadSuppressions(engine, 'default');
    expect(set.senders.has('bob@example.com')).toBe(true);
  });

  test('mute thread --json envelope carries ok/status "muted"', async () => {
    const r = await captured(() => runLoops(engine, ['mute', 'thread', '18C2F4A9B3D21E07', '--json']));
    const env = JSON.parse(r.out) as { ok: boolean; status: string; value: string };
    expect(env.ok).toBe(true);
    expect(env.status).toBe('muted');
    expect(env.value).toBe('18c2f4a9b3d21e07');
    const set = await loadSuppressions(engine, 'default');
    expect(set.threads.has('18c2f4a9b3d21e07')).toBe(true);
  });

  test('mute without kind/value hard-exits with usage code 2', async () => {
    const r = await captured(() => runLoops(engine, ['mute', 'sender']));
    expect(r.exitCalled).toBe(2);
  });

  test('--help paths answer without touching loops', async () => {
    const w = await captured(() => runWaiting(engine, ['--help']));
    expect(w.out).toContain('gbrain waiting');
    expect(w.out).toContain('--stale-ok');
    const l = await captured(() => runLoops(engine, ['--help']));
    expect(l.out).toContain('gbrain loops');
    expect(l.out).toContain('mute');
    expect(w.verdict).toBe(0);
    expect(l.verdict).toBe(0);
  });
});
