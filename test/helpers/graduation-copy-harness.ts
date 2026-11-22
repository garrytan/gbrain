/**
 * Test helpers for the graduation copier: inventory entries from the real
 * GRADUATION_INVENTORY (a default carry entry for test-only tables), the
 * whole-brain copy in `copyOrder`, and digest comparison between a source
 * (transforms applied) and its copy, through the same `digestTable` verify uses.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import type { GraduationEngines, InventoryEntry, TriggerBypass } from '../../src/core/persistence/engine-graduation.types.ts';
import { copyTable } from '../../src/core/persistence/graduation-copy.ts';
import { digestPlan, readDigestRows, withDigestSession, digestTable } from '../../src/core/persistence/graduation-digest.ts';
import { copyOrder, GRADUATION_INVENTORY, listRelations } from '../../src/core/persistence/graduation-inventory.ts';

export function inventoryEntry(relation: string, extra: Partial<InventoryEntry> = {}): InventoryEntry {
  const known = GRADUATION_INVENTORY.entries.find(e => e.relation === relation);
  return { ...(known ?? { relation, kind: 'table', class: 'carry', engines: { pglite: true, postgres: true, rust: false }, lossKind: 'user_data', transforms: [], reason: 'test table' }), ...extra };
}

/** Carried and rebound entries present on both engines, parents first. */
export async function copiedEntries(e: GraduationEngines): Promise<readonly InventoryEntry[]> {
  const onTarget = new Set((await listRelations(e.target)).map(r => r.relation));
  return (await copyOrder(e.source)).filter(entry => onTarget.has(entry.relation));
}

export async function copyAll(e: GraduationEngines, entries: readonly InventoryEntry[], opts: { bypass: TriggerBypass; runId: string; batchBytes?: number }):
  Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const entry of entries) counts[entry.relation] = (await copyTable(e, entry, opts)).rows;
  return counts;
}

/** First row whose canonical text differs (bounded scan for a readable message). */
async function firstDifference(e: GraduationEngines, entry: InventoryEntry): Promise<string> {
  const [a, b] = [await digestPlan(e.source, entry, true), await digestPlan(e.target, entry, false)];
  const rowsA = await withDigestSession(e.source, tx => readDigestRows(tx, a, null, 100_000));
  const rowsB = await withDigestSession(e.target, tx => readDigestRows(tx, b, null, 100_000));
  for (let i = 0; i < Math.max(rowsA.length, rowsB.length); i++) {
    if (rowsA[i]?.text !== rowsB[i]?.text) return `${entry.relation} row ${i}: source ${rowsA[i]?.text ?? '<none>'} target ${rowsB[i]?.text ?? '<none>'}`.slice(0, 2000);
  }
  return `${entry.relation}: digests differ`;
}

/** Relations whose transformed source digest differs from the target digest, with the first differing row. */
export async function digestMismatches(e: GraduationEngines, entries: readonly InventoryEntry[]): Promise<string[]> {
  const mismatches: string[] = [];
  for (const entry of entries) {
    const [a, b] = [await digestTable(e.source, entry, { applyTransforms: true }), await digestTable(e.target, entry)];
    if (a.rows !== b.rows || a.rootSha256 !== b.rootSha256) mismatches.push(await firstDifference(e, entry));
  }
  return mismatches;
}

export async function rowCount(engine: BrainEngine, entry: InventoryEntry): Promise<number> {
  return (await digestTable(engine, entry, { applyTransforms: true })).rows;
}
