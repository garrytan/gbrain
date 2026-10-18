/**
 * #6650: a heartbeat row or claim stamp names a process this one can prove
 * dead (same boot and pid namespace, pid gone or reused), so a killed sync
 * client's row never outranks the serve started after it and its claims are
 * reclaimable at once. Anything not provable from here (another boot or pid
 * namespace, an owner without the markers, a live process with its recorded
 * start time) keeps the time-based rule.
 *
 * The probe runs against a stub engine that answers the probe's query with the
 * rows the database would hold; the SQL time filter is not what is under test.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { consumerIdentity, consumerProvablyDead, probeLiveFullConsumer } from '../src/core/persistence/consumer-heartbeat.ts';
import { claimOwnerProvablyDead } from '../src/core/persistence/claim-phase.ts';
import { processStartTime, readBootId } from '../src/core/pglite-lock.ts';
import { deadPid } from './helpers/dead-pid.ts';

const linux = process.platform === 'linux' && readBootId() !== null;
let live: ChildProcess;
let liveStart: string;

beforeAll(async () => {
  if (!linux) return;
  live = spawn('sleep', ['60'], { stdio: 'ignore' });
  await new Promise(resolve => live.once('spawn', resolve));
  liveStart = processStartTime(live.pid!)!;
});
afterAll(() => { live?.kill('SIGKILL'); });

const self = () => consumerIdentity();
const owner = (pid: number, over: Record<string, string | null> = {}) =>
  ({ pid, nonce: `n-${pid}`, pid_ns: self().pid_ns, boot_id: self().boot_id ?? null, start: '1', ...over });

function row(pid: number, kind: string, startedAt: string, over: Record<string, string | null> = {}) {
  const o = owner(pid, over);
  return { host_id: '00000000-0000-0000-0000-000000000001', pid, nonce: o.nonce, pid_ns: o.pid_ns, kind, mode: 'full', started_at: startedAt,
    renewed_at: startedAt, restart_required: false, root_barrier_age_ms: null, pool: null, host_json_path: '/h', persistence_home: '/p',
    minted_under: null, version: '0.0.0', boot_id: o.boot_id, process_start: o.start, renewed_age_ms: '1000', age_ms: '5000' };
}
const stub = (rows: unknown[]) => ({ kind: 'postgres' as const, executeRaw: async () => rows }) as never;

describe.skipIf(!linux)('consumerProvablyDead', () => {
  test('a reaped pid under this boot and pid namespace is dead', () => {
    expect(consumerProvablyDead(owner(deadPid()))).toBe(true);
  });
  test('a live pid whose start time differs is a reused pid, so the recorded owner is dead', () => {
    expect(consumerProvablyDead(owner(live.pid!, { start: '1' }))).toBe(true);
  });
  test('a live pid with its recorded start time is alive', () => {
    expect(consumerProvablyDead(owner(live.pid!, { start: liveStart }))).toBe(false);
  });
  test('another boot, another pid namespace, or an owner without markers is never provably dead', () => {
    const pid = deadPid();
    expect(consumerProvablyDead(owner(pid, { boot_id: '00000000-0000-0000-0000-000000000000' }))).toBe(false);
    expect(consumerProvablyDead(owner(pid, { pid_ns: 'pid:[1]' }))).toBe(false);
    expect(consumerProvablyDead(owner(pid, { start: null }))).toBe(false);
    expect(consumerProvablyDead({ pid, nonce: 'older-owner', pid_ns: self().pid_ns })).toBe(false);
  });
  test('a checker whose /proc numbers another pid namespace (no start time of its own) proves nothing', () => {
    expect(consumerProvablyDead(owner(deadPid()), { ...self(), start: null })).toBe(false);
  });
  test('this process is never dead to itself', () => {
    const me = self();
    expect(consumerProvablyDead({ ...me, start: '1' })).toBe(false);
  });
});

describe.skipIf(!linux)('probeLiveFullConsumer skips a row whose owner is provably dead (#6650 bug 1)', () => {
  test("a killed sync client's fresh row does not outrank the serve started after it", async () => {
    const found = await probeLiveFullConsumer(stub([
      row(deadPid(), 'sync', '2026-10-13 10:00:00+00'),
      row(live.pid!, 'serve', '2026-10-13 10:00:05+00', { start: liveStart }),
    ]), '00000000-0000-0000-0000-000000000001');
    expect({ kind: found?.kind, pid: found?.pid }).toEqual({ kind: 'serve', pid: live.pid });
  });
  test('only a dead row reads as no owner', async () => {
    expect(await probeLiveFullConsumer(stub([row(deadPid(), 'serve', '2026-10-13 10:00:00+00')]), '00000000-0000-0000-0000-000000000001')).toBeNull();
  });
  test('a row from another boot keeps the time-only rule', async () => {
    const pid = deadPid();
    const found = await probeLiveFullConsumer(stub([row(pid, 'serve', '2026-10-13 10:00:00+00', { boot_id: '00000000-0000-0000-0000-000000000000' })]),
      '00000000-0000-0000-0000-000000000001');
    expect(found?.pid).toBe(pid);
  });
});

describe.skipIf(!linux)('the probe skips dead rows before it bounds the rows it reads (#6650)', () => {
  test('a live serve behind more than eight dead rows is still the owner', async () => {
    const dead = Array.from({ length: 9 }, (_, i) => row(deadPid(), 'sync', `2026-10-13 10:00:0${i}+00`));
    const rows = [...dead, row(live.pid!, 'serve', '2026-10-13 10:00:30+00', { start: liveStart })];
    const limited = { kind: 'postgres' as const, executeRaw: async (sql: string) => {
      const limit = /LIMIT (\d+)/.exec(sql);
      return limit ? rows.slice(0, Number(limit[1])) : rows;
    } } as never;
    expect((await probeLiveFullConsumer(limited, '00000000-0000-0000-0000-000000000001'))?.pid).toBe(live.pid);
  });
});

describe.skipIf(!linux)('claimOwnerProvablyDead reads a claim stamp (#6650 defect 2)', () => {
  const stamp = (o: Record<string, unknown>) => JSON.stringify({ phase: 'publishing', token: 't', owner: { kind: 'sync', version: '0.0.0', ...o } });
  test('a stamp naming a dead owner, as text or jsonb', () => {
    const o = owner(deadPid());
    expect(claimOwnerProvablyDead(stamp(o))).toBe(true);
    expect(claimOwnerProvablyDead(JSON.parse(stamp(o)))).toBe(true);
  });
  test('a live owner, a foreign boot, an older stamp without markers, and no stamp are kept', () => {
    expect(claimOwnerProvablyDead(stamp(owner(live.pid!, { start: liveStart })))).toBe(false);
    expect(claimOwnerProvablyDead(stamp(owner(deadPid(), { boot_id: '00000000-0000-0000-0000-000000000000' })))).toBe(false);
    expect(claimOwnerProvablyDead(stamp({ pid: deadPid(), nonce: 'n', pid_ns: self().pid_ns }))).toBe(false);
    expect(claimOwnerProvablyDead(null)).toBe(false);
  });
  test('the stamp this process writes carries the markers', async () => {
    const { claimOwner } = await import('../src/core/persistence/claim-phase.ts');
    expect(claimOwner()).toMatchObject({ pid: process.pid, boot_id: readBootId(), start: processStartTime(process.pid) });
  });
});

describe.skipIf(!linux)('electOwner never defers to a provably dead owner (#6650 bug 1)', () => {
  const listed = (pid: number, over: Record<string, string | null> = {}) => {
    const r = row(pid, 'serve', '2026-10-13 10:00:00+00', over);
    return { ...r, pool: null, minted_under: null, renewed_age_ms: 1000, age_ms: 5000, liveness: 'live', self: false } as never;
  };
  test('a dead current owner is neither kept nor elected; the live one is', async () => {
    const { electOwner } = await import('../src/core/persistence/consumer-election.ts');
    const dead = deadPid();
    const elected = electOwner([listed(dead), listed(live.pid!, { start: liveStart })], { pid: dead, nonce: `n-${dead}` }, 600_000);
    expect((elected as { pid: number } | null)?.pid).toBe(live.pid);
  });
  test('a row from another boot is still kept on time alone', async () => {
    const { electOwner } = await import('../src/core/persistence/consumer-election.ts');
    const pid = deadPid();
    const elected = electOwner([listed(pid, { boot_id: '00000000-0000-0000-0000-000000000000' })], { pid, nonce: `n-${pid}` }, 600_000);
    expect((elected as { pid: number } | null)?.pid).toBe(pid);
  });
});
