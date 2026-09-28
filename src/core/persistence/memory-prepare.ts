import type { BrainEngine, NewFact } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { OperationError } from '../ops/contract.ts';
import { assertPageRevision } from '../page-state/types.ts';
import { parseFactsFence, renderFactsTable, replaceOrInsertFactsFence, upsertFactRow } from '../facts-fence.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { assertFactNotWithdrawn, decideSingleFact, prepareFactEmbedding, type SingleFactIntent } from '../facts/single-prepare.ts';
import { engineMutationPrecondition, parseMutationPrecondition } from './preconditions.ts';
import { preparePageMutation } from './page-prepare.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { WriteRequest } from './model.ts';

function conflict(): never { throw new OperationError('revision_conflict', 'The memory changed during semantic preparation.'); }
function candidateState(value: Awaited<ReturnType<typeof decideSingleFact>>): string {
  const c = value.candidate;
  return JSON.stringify([value.status, c?.id, c?.fact, c?.kind, c?.visibility,
    c?.valid_until ? new Date(c.valid_until).toISOString() : null, c?.source_markdown_slug, c?.row_num]);
}
function outcome(id: number, status: 'inserted' | 'duplicate' | 'superseded', entitySlug: string | null, validUntil: Date | string | null, degraded: boolean) {
  const statusText = status === 'inserted' ? `remembered as fact #${id}` : status === 'duplicate'
    ? `already knew this — kept fact #${id}` : `updated — fact #${id} supersedes the previous version`;
  return { id: String(id), status, status_text: statusText, entity_slug: entitySlug,
    valid_until: validUntil ? new Date(validUntil).toISOString() : null,
    ...(degraded ? { degraded_dedup: true } : {}), protocol_version: 1 };
}

/** Every retry renders the semantic append from the latest coherent snapshot. */
export async function prepareMemoryMutation(engine: BrainEngine, row: WriteRequest, config: GBrainConfig, signal?: AbortSignal): Promise<PreparedMutation> {
  signal?.throwIfAborted();
  if (row.operation !== 'remember' || !row.intent) throw new OperationError('storage_error', 'Unknown memory mutation intent.');
  const p = row.intent;
  const input: SingleFactIntent = { fact: String(p.fact).trim(), kind: (p.kind ?? 'fact') as SingleFactIntent['kind'],
    visibility: (p.visibility ?? 'world') as SingleFactIntent['visibility'], entity_slug: p.entity_slug as string | null };
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
  if ((snapshot?.page.id ?? null) !== row.page_id) throw new OperationError('page_identity_changed', 'The accepted entity was deleted or recreated.');
  if (p.expected_revision !== undefined) assertPageRevision(snapshot, engineMutationPrecondition(parseMutationPrecondition(p)));
  const observedRevision = snapshot?.revision ?? null;
  await assertFactNotWithdrawn(engine, row.source_id, input);
  signal?.throwIfAborted();
  const { embedding, degraded } = await prepareFactEmbedding(input.fact, signal);
  signal?.throwIfAborted();
  const decision = await decideSingleFact(engine, row.source_id, input, embedding);
  const validate = async (tx: BrainEngine) => {
    await assertFactNotWithdrawn(tx, row.source_id, input);
    const current = await decideSingleFact(tx, row.source_id, input, embedding);
    if (candidateState(current) !== candidateState(decision)) conflict();
  };
  if (decision.status === 'duplicate') {
    const duplicate = decision.candidate!;
    return { observedRevision, noop: true, validate, apply: async () => outcome(duplicate.id, 'duplicate', input.entity_slug, duplicate.valid_until, degraded) };
  }
  const validUntil = p.valid_until ? new Date(String(p.valid_until)) : null;
  const validFrom = new Date(String(p.valid_from));
  const confidence = typeof p.confidence === 'number' && Number.isFinite(p.confidence)
    && p.confidence >= 0 && p.confidence <= 1 ? p.confidence : 1;
  const fact: NewFact = { ...input, source: String(p.provenance).trim(), valid_from: validFrom, valid_until: validUntil,
    confidence, embedding };
  let page: PreparedMutation | undefined;
  let rowNum: number | undefined;
  if (p.fence === true && snapshot) {
    const parsed = parseFactsFence(snapshot.page.compiled_truth);
    if (parsed.warnings.length) throw new OperationError('storage_error', 'The entity facts fence is malformed; repair it before appending memory.');
    const appended = upsertFactRow(snapshot.page.compiled_truth, { claim: input.fact, kind: input.kind, visibility: input.visibility,
      confidence, notability: 'medium', validFrom: validFrom.toISOString().slice(0, 10),
      validUntil: validUntil?.toISOString().slice(0, 10), source: fact.source });
    rowNum = appended.rowNum;
    let body = appended.body;
    const old = decision.candidate;
    if (decision.status === 'superseded' && old?.source_markdown_slug === row.slug && old.row_num != null) {
      const rows = parseFactsFence(body).facts.map(f => f.rowNum === old.row_num
        ? { ...f, active: false, supersededBy: rowNum, context: `superseded by #${rowNum}` } : f);
      body = replaceOrInsertFactsFence(body, renderFactsTable(rows));
    }
    const content = serializePageToMarkdown({ ...snapshot.page, compiled_truth: body }, snapshot.tags);
    // Reuse the canonical parser/chunker and durable filesystem publication.
    // The original caller revision was checked above; this CAS binds this render.
    page = await preparePageMutation(engine, { ...row, intent: { ...p, content, expected_revision: observedRevision, force: false } }, config, undefined, signal);
    if (page.observedRevision !== observedRevision) conflict();
  }
  return { observedRevision, file: page?.file, validate: async tx => { await validate(tx); await page?.validate?.(tx); }, apply: async tx => {
    await page?.apply(tx);
    let id: number;
    if (rowNum !== undefined) {
      const inserted = await tx.insertFacts([{ ...fact, row_num: rowNum, source_markdown_slug: row.slug }], { source_id: row.source_id }); // gbrain-allow-direct-insert: coordinator atomically publishes the prepared canonical fact fence and its new indexed row
      if (inserted.ids.length !== 1) throw new OperationError('storage_error', 'The new canonical fact row was not indexed.');
      id = inserted.ids[0];
    } else {
      const inserted = await tx.insertFact(fact, { source_id: row.source_id }); // gbrain-allow-direct-insert: journaled source-scoped semantic publication for subjectless or unresolved entity memory
      id = inserted.id;
    }
    if (decision.status === 'superseded') await tx.executeRaw(`UPDATE facts SET expired_at=now(),superseded_by=$3
      WHERE id=$1 AND source_id=$2 AND expired_at IS NULL`, [decision.candidate!.id, row.source_id, id]);
    return outcome(id, decision.status, input.entity_slug, validUntil, degraded);
  } };
}
