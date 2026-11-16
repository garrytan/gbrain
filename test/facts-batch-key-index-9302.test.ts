/**
 * #9302: managed fact extraction looks a batch up by its batch key (facts-maintenance.ts storedBatch) before it
 * admits the batch, so the lookup runs once per extraction.
 *
 * 1. Protects: the lookup reaches persistence_requests only through index probes, the batch-key index
 *    (persistence_requests_facts_batch, v317) for the key and a request-id index for the completion receipt, and it
 *    still returns exactly the batch's requests: the ones whose key is in the intent and a compacted one whose key
 *    survives only in the outcome.
 * 2. Fails when: the batch-key index is missing, so the `request_id OR batch key` filter reads every extract_facts
 *    receipt of the principal and decompresses each intent (14.5 s a call on the reporter's Postgres brain).
 * 3. Seams: executeRaw is wrapped to record the statement resumeManagedFacts runs; in-memory PGLite with planner
 *    statistics; receipts are seeded directly, since only the lookup is under test.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resumeManagedFacts, type ManagedFactsSession } from '../src/core/persistence/facts-maintenance.ts';

const PRINCIPAL = { kind: 'local_cli', id: 'facts-batch-9302' } as const;
const KEY = (n: number) => `batch-key-${n}`;
let engine: PGLiteEngine;
let incarnation: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>(`SELECT incarnation::text AS incarnation FROM sources WHERE id='default'`);
  // A journal of 2,000 committed receipts under one principal, three per batch, as on a personal brain.
  await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,
      digest,intent,authority,intent_bytes,terminal_reservation,state,outcome,completed_at)
    SELECT $1,$2,gen_random_uuid(),'extract_facts','default',$3::uuid,'people/p-' || g,md5(g::text),
      jsonb_build_object('kind','managed_facts_entity','batchKey','batch-key-' || (g / 3),'facts',
        jsonb_build_array(jsonb_build_object('fact','Synthetic fact ' || g,'embedding',array_fill(0.125::float8, ARRAY[64])))),
      '{}'::jsonb,0,0,'committed',jsonb_build_object('status','completed','batch_key','batch-key-' || (g / 3)),now()
    FROM generate_series(1, 2000) g`, [PRINCIPAL.kind, PRINCIPAL.id, incarnation]);
  // A compacted receipt of batch 7: the intent is gone and the key survives in the outcome only.
  await engine.executeRaw(`UPDATE persistence_requests SET intent=NULL, compacted=true WHERE slug='people/p-21'`);
  await engine.executeRaw('ANALYZE persistence_requests');
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

const session = (batchKey: string) => ({
  authority: { version: 1, principal: PRINCIPAL, remote: false, sourceId: 'default', sourceIncarnation: incarnation },
  batchKey, completionRequestId: randomUUID(),
}) as unknown as ManagedFactsSession;

type PlanNode = { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; Plans?: PlanNode[] };
const walk = (node: PlanNode, out: PlanNode[] = []): PlanNode[] => { out.push(node); for (const child of node.Plans ?? []) walk(child, out); return out; };

test('the batch lookup probes the batch-key index instead of reading every receipt, and finds the batch', async () => {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const raw = engine.executeRaw.bind(engine);
  engine.executeRaw = ((sql: string, params?: unknown[]) => { statements.push({ sql, params: params ?? [] }); return raw(sql, params); }) as typeof engine.executeRaw;
  try {
    expect(await resumeManagedFacts(engine, session('batch-key-unknown'))).toBeNull();
  } finally { engine.executeRaw = raw; }

  const lookups = statements.filter(({ sql }) => /FROM persistence_requests/i.test(sql) && /batchKey/.test(sql));
  expect(lookups.length).toBe(1);
  const [{ sql, params }] = lookups;
  const [{ 'QUERY PLAN': plan }] = await engine.executeRaw<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(`EXPLAIN (FORMAT JSON) ${sql}`, params);
  const nodes = walk(plan[0].Plan);
  expect(nodes.filter(node => node['Relation Name'] === 'persistence_requests' && node['Node Type'] === 'Seq Scan')).toEqual([]);
  const indexes = nodes.map(node => node['Index Name']).filter(Boolean);
  expect(indexes).toContain('persistence_requests_facts_batch');
  expect(indexes).not.toContain('persistence_requests_principal');

  // Same statement, a stored batch: its three receipts, the compacted one included, in sequence order.
  const found = await engine.executeRaw<{ slug: string }>(sql, params.map((value, i) => i === 4 ? KEY(7) : value));
  expect(found.map(row => row.slug)).toEqual(['people/p-21', 'people/p-22', 'people/p-23']);
});
