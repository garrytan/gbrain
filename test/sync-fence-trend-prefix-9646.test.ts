/**
 * #9646: the fence trend of a pass stamp is tallied before its publication in statements over at most FENCE_TREND_PAGE request
 * sequences each, so no statement's cost grows with the request history and the stamp's publication reads only what is newer.
 */
import { expect, test } from 'bun:test';
import { FENCE_TREND_PAGE, readFenceTrendPrefix, recordPassFenceTrend } from '../src/core/persistence/sync-prepare.ts';

const NEWEST = FENCE_TREND_PAGE * 3 + 345;
const fenced = (sequence: number) => sequence % 1000 === 0;
function history(open: string[] = []) {
  const ranges: Array<[bigint, bigint | null]> = [];
  const trend: unknown[][] = [];
  const executeRaw = async (sql: string, params: unknown[] = []): Promise<any[]> => {
    if (sql.includes('FROM op_checkpoints WHERE op=$1 AND fingerprint=$2')) return [];
    if (sql.includes('max(sequence)')) return [{ through: String(NEWEST) }];
    if (sql.includes("state IN ('queued','deferred','running','recovering')")) return open.map(sequence => ({ sequence }));
    if (sql.includes('INSERT INTO op_checkpoints')) { trend.push(params); return []; }
    if (!sql.includes('AS fences')) throw new Error(`unexpected statement: ${sql}`);
    const after = BigInt(params[2] as string), upTo = sql.includes('sequence <= $4') ? BigInt(params[3] as string) : null;
    ranges.push([after, upTo]);
    const rows = [];
    // Every fenced request reads as committed, an open one included: it committed during the prefix.
    for (let s = Number(after) + 1; s <= Number(upTo ?? BigInt(NEWEST + 10)); s++) if (fenced(s)) rows.push({ path: `notes/p-${s}.md`, fences: [{ class: 'kind_map' }], sequence: String(s) });
    if (upTo === null && typeof params[3] === 'string') for (const s of params[3].slice(1, -1).split(',')) if (fenced(Number(s))) rows.push({ path: `notes/p-${s}.md`, fences: [{ class: 'kind_map' }], sequence: s });
    return rows;
  };
  return { engine: { executeRaw } as never, ranges, trend };
}

test('#9646: with no watermark the prefix reads the whole history in bounded ranges and the publication reads only past it', async () => {
  const h = history();
  const scope = { worktreeId: '00000000-0000-0000-0000-000000000001', sourceId: 'source-a', incarnation: '00000000-0000-0000-0000-000000000002' };
  const prefix = await readFenceTrendPrefix(h.engine, scope);
  expect(prefix).toMatchObject({ since: null, through: String(NEWEST), tally: { count: Math.floor(NEWEST / 1000) } });
  expect(h.ranges.length).toBe(Math.ceil(NEWEST / FENCE_TREND_PAGE));
  for (const [after, upTo] of h.ranges) { expect(upTo).not.toBeNull(); expect(upTo! - after).toBeLessThanOrEqual(BigInt(FENCE_TREND_PAGE)); }
  // Contiguous and non-overlapping: every request is read exactly once.
  h.ranges.forEach(([after], i) => expect(after).toBe(i === 0 ? 0n : h.ranges[i - 1]![1]!));
  h.ranges.length = 0;
  await recordPassFenceTrend(h.engine, { ...scope, passId: 'pass-1', since: null, prefix });
  expect(h.ranges).toEqual([[BigInt(NEWEST), null]]);
  expect(JSON.parse(h.trend[0]![2] as string)[0]).toMatchObject({ count: Math.floor(NEWEST / 1000) });
});

test('#9646: a prefix read from another watermark is not used: the publication tallies from its own watermark', async () => {
  const h = history();
  const scope = { worktreeId: '00000000-0000-0000-0000-000000000001', sourceId: 'source-a' };
  await recordPassFenceTrend(h.engine, { ...scope, passId: 'pass-2', since: String(NEWEST - 500), prefix: { since: null, through: String(NEWEST), tally: { count: 99, by_class: {}, sample_paths: [], dirs: {} } } });
  expect(h.ranges).toEqual([[BigInt(NEWEST - 500), null]]);
  expect(JSON.parse(h.trend[0]![2] as string)[0]).toMatchObject({ count: 1 });
});

test('#9646: an import still open when the prefix is read is left to the publication by sequence, so it is counted once and the publication still starts past the newest request', async () => {
  const h = history(['7000']);
  const scope = { worktreeId: '00000000-0000-0000-0000-000000000001', sourceId: 'source-a', incarnation: '00000000-0000-0000-0000-000000000002' };
  const prefix = await readFenceTrendPrefix(h.engine, scope);
  expect(prefix).toMatchObject({ since: null, through: String(NEWEST), open: ['7000'], tally: { count: Math.floor(NEWEST / 1000) - 1 } });
  h.ranges.length = 0;
  await recordPassFenceTrend(h.engine, { ...scope, passId: 'pass-3', since: null, prefix });
  expect(h.ranges).toEqual([[BigInt(NEWEST), null]]);
  expect(JSON.parse(h.trend[0]![2] as string)[0]).toMatchObject({ count: Math.floor(NEWEST / 1000) });
});
