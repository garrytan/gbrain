import type { BrainEngine, NewFact } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { maintenanceTransaction } from './attribution.ts';
import { managedPersistenceEnabled } from './ownership.ts';
import { deriveTrust, recordTaintEdges } from '../trust/taint.ts';
import { applyGateDecision, derivedGateConfig, derivedGateInput, emptyGateTally, type GateTally } from '../trust/derived-gate.ts';
import { decideFactWrite, recordFlaggedRow } from '../write-gate-store.ts';

/**
 * #5575 I2: the conversation fact extractor's context is the page alone, so
 * its rows carry the page's stored tier capped at agent_written (an
 * own-session transcript import is agent_written, a third-party one
 * external_untrusted) and an edge to the page.
 */
export const conversationDerivation = (engine: BrainEngine, sourceId: string, slug: string) =>
  deriveTrust(engine, [{ table: 'pages', sourceId, slug }], { channel: 'derive:conversation_facts' });

/** Edges for the fact ids a batch insert returned (`{ ids }`); other results (deletes, counts) record none. */
async function recordInsertedEdges(tx: BrainEngine, sourceId: string, result: unknown, inputs: Awaited<ReturnType<typeof conversationDerivation>>['inputs']) {
  const ids = (result as { ids?: unknown } | null)?.ids;
  for (const id of Array.isArray(ids) ? ids : []) await recordTaintEdges(tx, { table: 'facts', id: Number(id), sourceId }, inputs);
}

/**
 * #5575 B3: one batch of extracted rows through the write gate at the page's
 * declared tier (ENG-18): allowed rows are inserted with their input edges
 * and flag receipts, held rows go to write_gate_holds, rejected rows are
 * counted and skipped.
 */
type FenceRow = NewFact & { row_num: number; source_markdown_slug: string };
export async function insertGatedFacts(tx: BrainEngine, sourceId: string, slug: string, rows: FenceRow[],
  derivation: Awaited<ReturnType<typeof conversationDerivation>>): Promise<{ inserted: number; ids: number[]; write_gate: GateTally }> {
  const cfg = await derivedGateConfig(tx);
  const input = derivedGateInput(derivation.trust);
  const write_gate = emptyGateTally();
  const decisions = rows.map(row => decideFactWrite({ fact: row.fact, context: row.context, source: row.source },
    { sourceId, slug, payload: { ...row, embedding: null }, input, cfg }));
  for (const decision of decisions) if (decision.action !== 'insert') await applyGateDecision(tx, decision, { table: 'facts', sourceId }, async () => null, write_gate);
  const allowed = rows.filter((_, i) => decisions[i].action === 'insert');
  const flags = decisions.filter(decision => decision.action === 'insert');
  const result = allowed.length ? await tx.insertFacts(allowed, { source_id: sourceId }) : { inserted: 0, ids: [] }; // gbrain-allow-direct-insert: conversation fact rows that passed the write gate
  for (const [i, id] of result.ids.entries()) {
    await recordTaintEdges(tx, { table: 'facts', id, sourceId }, derivation.inputs);
    if (result.ids.length === allowed.length && await recordFlaggedRow(tx, flags[i], { table: 'facts', id, sourceId }) !== null) write_gate.flagged++;
  }
  return { inserted: result.inserted, ids: result.ids, write_gate };
}

/** The conversation fact index's gated batch insert, in writeDerivedFacts' transaction shape (unmanaged brains). */
export async function insertDerivedFacts(engine: BrainEngine, sourceId: string, slug: string, rows: FenceRow[]) {
  const derivation = await conversationDerivation(engine, sourceId, slug);
  return writeDerivedFacts(engine, sourceId, slug, db => insertGatedFacts(db, sourceId, slug, rows, derivation));
}

/**
 * Unmanaged brains: database-only fact rows derived from page text (the
 * conversation fact index) commit in one maintenance transaction under the
 * maintenance principal, at the page's derived tier (#5575 I2). A managed
 * brain publishes them as receipted maintenance requests instead
 * (facts/conversation-publication.ts, cycle/extract-facts.ts), so this
 * refuses there rather than write a guarded table without a receipt.
 */
export async function writeDerivedFacts<T>(engine: BrainEngine, sourceId: string, slug: string,
  fn: (db: BrainEngine) => Promise<T>): Promise<T> {
  if (await managedPersistenceEnabled(engine)) {
    throw opError('writer_coordinator_required', 'Managed brains publish derived facts through receipted maintenance requests.',
      `The derived facts of ${slug} in source ${sourceId} were not written: a managed brain publishes them through the coordinator, which this caller bypassed. Run the extraction command again; report this if it repeats.`);
  }
  const { trust, inputs } = await conversationDerivation(engine, sourceId, slug);
  return maintenanceTransaction(engine, async db => { const result = await fn(db); await recordInsertedEdges(db, sourceId, result, inputs); return result; }, trust);
}
