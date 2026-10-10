/**
 * GBRA-69: the claim's "unfinished row ahead on the same root" probe matches
 * the root by indexed columns instead of a COALESCE text key. The fixture
 * compares the claimable rows, in claim order, of the current predicate and
 * the former one over randomized request tables: worktree and database-only
 * roots (two incarnations), every request state, sync rows that may be passed,
 * lane groups and recovery records. Both engines run it; the tables are
 * session-local shadows, so the brain's own request journal is never touched.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { CLAIM_ORDER, claimableWriteSql } from '../../src/core/persistence/journal.ts';

const NEW_EARLIER = 'AND NOT EXISTS (SELECT 1 FROM persistence_requests earlier\n        WHERE r.worktree_id IS NOT NULL AND earlier.worktree_id=r.worktree_id AND ';

/** The predicate as it was before GBRA-69, rebuilt from the current one around the shared head condition. */
export function formerClaimableWriteSql(priority: string, laneRoots?: string): string {
  const current = claimableWriteSql(priority, laneRoots);
  const start = current.indexOf(NEW_EARLIER);
  const end = current.lastIndexOf('AND NOT ((');
  if (start < 0 || end < 0) throw new Error('claimableWriteSql no longer has the two root probes this fixture rebuilds');
  const first = current.slice(start + NEW_EARLIER.length, current.indexOf('\n      AND NOT EXISTS', start + NEW_EARLIER.length));
  const head = first.slice(0, first.lastIndexOf(')'));
  return `${current.slice(0, start)}AND NOT EXISTS (SELECT 1 FROM persistence_requests earlier
        WHERE COALESCE(earlier.worktree_id::text,'db:'||earlier.source_incarnation::text)
              =COALESCE(r.worktree_id::text,'db:'||r.source_incarnation::text)
        AND ${head})
      ${current.slice(end)}`;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

async function shadowTables(tx: BrainEngine) {
  for (const table of ['persistence_requests', 'persistence_worktrees', 'persistence_effects', 'persistence_worktree_refreshes']) {
    await tx.executeRaw(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS INCLUDING INDEXES) ON COMMIT DROP`);
  }
}

const planNodes = (plan: Record<string, unknown>): Array<Record<string, unknown>> =>
  [plan, ...((plan.Plans as Array<Record<string, unknown>> | undefined) ?? []).flatMap(planNodes)];

/**
 * Postgres: the scans of the `earlier` probe under the current and the former predicate, with their
 * buffer hits, over `roots` worktrees that each hold `queued` queued rows (the former key walked every
 * root's pending rows once per candidate) plus `committed` committed rows on the first.
 */
export async function explainEarlierProbe(engine: BrainEngine, roots = 8, queued = 32, committed = 20_000) {
  const host = randomUUID(), incarnation = randomUUID();
  const worktrees = Array.from({ length: roots }, () => randomUUID());
  return engine.transaction(async tx => {
    await shadowTables(tx);
    const insert = (worktree: string, count: number, state: string) => tx.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,
        source_id,source_incarnation,slug,worktree_id,digest,intent,authority,intent_bytes,terminal_reservation,state)
      SELECT 'local_cli','fixture',gen_random_uuid(),'put_page','fixture-source',$1::uuid,'page-'||g,$2::uuid,'d','{"kind":"managed_file_import"}'::jsonb,'{}'::jsonb,0,0,$4
      FROM generate_series(1,$3::int) g`, [incarnation, worktree, count, state]);
    for (const worktree of worktrees) {
      await tx.executeRaw(`INSERT INTO persistence_worktrees(id,owner_host_id,state) VALUES ($1::uuid,$2::uuid,'active')`, [worktree, host]);
      await insert(worktree, queued, 'queued');
    }
    await insert(worktrees[0]!, committed, 'committed');
    await tx.executeRaw('ANALYZE persistence_requests');
    const explain = async (where: string) => {
      const [row] = await tx.executeRaw<{ 'QUERY PLAN': unknown }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT r.* FROM persistence_requests r
        LEFT JOIN persistence_worktrees w ON w.id=r.worktree_id WHERE ${where} ORDER BY ${CLAIM_ORDER('true')} LIMIT 1 FOR UPDATE OF r SKIP LOCKED`, [host, []]);
      const raw = row!['QUERY PLAN'];
      const plan = ((typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<{ Plan: Record<string, unknown> }>)[0]!.Plan;
      return { earlier: planNodes(plan).filter(node => node.Alias === 'earlier').map(node => ({ type: String(node['Node Type']), index: node['Index Name'] })),
        buffers: ['Shared Hit Blocks', 'Shared Read Blocks', 'Local Hit Blocks', 'Local Read Blocks'].reduce((sum, key) => sum + Number(plan[key] ?? 0), 0) };
    };
    return { current: await explain(claimableWriteSql('true')), former: await explain(formerClaimableWriteSql('true')) };
  });
}

export interface ClaimCase { seed: number; priority: boolean; lanes: boolean; current: string[]; former: string[] }

/** Runs `cases` randomized tables and returns both predicates' claim order for each. */
export async function compareClaimOrders(engine: BrainEngine, cases = 120): Promise<ClaimCase[]> {
  const host = randomUUID(), otherHost = randomUUID();
  const worktrees = [randomUUID(), randomUUID(), randomUUID()];
  const incarnations = [randomUUID(), randomUUID()];
  const out: ClaimCase[] = [];
  await engine.transaction(async tx => {
    await shadowTables(tx);
    await tx.executeRaw(`INSERT INTO persistence_worktrees(id,owner_host_id,state) VALUES ($1::uuid,$4::uuid,'active'),($2::uuid,$4::uuid,'active'),($3::uuid,$5::uuid,'active')`,
      [...worktrees, host, otherHost]);
    for (let seed = 1; seed <= cases; seed++) {
      const random = rng(seed);
      const pick = <T>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
      await tx.executeRaw('DELETE FROM persistence_requests');
      const rows = 4 + Math.floor(random() * 14);
      for (let i = 0; i < rows; i++) {
        const database = random() < 0.35;
        const worktree = database ? null : pick(worktrees);
        const sync = random() < 0.4;
        const lane = sync && random() < 0.3;
        const slug = pick(['alpha', 'beta', 'gamma', 'delta']);
        const intent = sync ? { kind: pick(['managed_sync_import', 'managed_sync_delete']), ...(lane ? { lane: 'group-1' } : {}),
          ...(random() < 0.2 ? { renameFrom: { slug: pick(['alpha', 'beta']) } } : {}) } : { kind: 'put_page' };
        await tx.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,page_id,slug,
            worktree_id,digest,intent,authority,intent_bytes,terminal_reservation,state,recovery)
          VALUES ('local_cli','fixture',$1::uuid,'put_page','fixture-source',$2::uuid,$3,$4,$5::uuid,'d',$6::text::jsonb,'{}'::jsonb,0,0,$7,$8::text::jsonb)`,
        [randomUUID(), database ? pick(incarnations) : incarnations[0], random() < 0.5 ? Math.floor(random() * 4) : null, slug, worktree, JSON.stringify(intent),
          pick(['queued', 'queued', 'queued', 'running', 'recovering', 'committed', 'failed']), random() < 0.08 ? JSON.stringify({ version: 1 }) : null]);
      }
      for (const priority of [true, false]) for (const lanes of [false, true]) {
        const laneRoots = lanes ? `ARRAY['${worktrees[0]}']::text[]` : undefined;
        const query = (where: string) => tx.executeRaw<{ id: string }>(`SELECT r.id::text AS id FROM persistence_requests r
          LEFT JOIN persistence_worktrees w ON w.id=r.worktree_id WHERE ${where} ORDER BY ${CLAIM_ORDER(String(priority))}`, [host, []]);
        const current = (await query(claimableWriteSql(String(priority), laneRoots))).map(row => row.id);
        const former = (await query(formerClaimableWriteSql(String(priority), laneRoots))).map(row => row.id);
        out.push({ seed, priority, lanes, current, former });
      }
    }
  });
  return out;
}
