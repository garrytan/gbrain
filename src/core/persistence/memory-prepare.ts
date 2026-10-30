import type { BrainEngine, NewFact } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { opError } from '../ops/contract.ts';
import { pageIdentityError } from './page-identity.ts';
import { assertPageRevision } from '../page-state/types.ts';
import { assertFactNotWithdrawn, decideReplacement, decideSingleFact, prepareFactEmbedding, type SingleFactIntent } from '../facts/single-prepare.ts';
import { supersededValidUntil } from '../facts/supersede-interval.ts';
import { factEmbeddingDisabled } from '../embedding-disabled.ts';
import { engineMutationPrecondition, parseMutationPrecondition } from './preconditions.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { WriteRequest } from './model.ts';
import { appendContextNote, type InferredVia } from '../facts/subject-infer.ts';
import { inferenceNote } from '../facts/subject-infer-write.ts';
import { requestChannelTrust } from '../trust/channel.ts';
import { gateField, gateInput, heldOutcome, loadWriteGateConfig } from '../trust/gate-outcomes.ts';
import { decideFactWrite, recordFlaggedRow, recordWriteGateHold } from '../write-gate-store.ts';
import { writeGateRejectedError } from '../write-gate.ts';
import { lexicalContestCandidate, recordContestedFact, supersessionGuarded } from '../trust/supersede-handlers.ts';
import { storedTrustTier } from '../trust/tier.ts';
import { fenceAppendPendingTier } from '../eligibility/fence-overlay.ts';
import { prepareFenceFactAppend, requestReceiptFix, type FenceFactAppend } from '../facts/fence-fact-append.ts';
import { privateProvenanceFilterFragment, resolveExcludePrivatePages } from '../search/private-visibility.ts';
import { tightenToPage } from '../facts/visibility.ts';
import { noteBelief } from '../belief/ledger.ts';

function conflict(row: WriteRequest): never {
  throw opError('revision_conflict', 'The memory changed during semantic preparation.',
    `Another write changed the facts or entity page in source ${row.source_id} while remember request ${row.request_id} was prepared, so it did not save. Check that request's receipt; once it shows conflict, nothing was saved and remembering the fact again is safe.`,
    { fix: requestReceiptFix(row) });
}
function candidateState(value: Awaited<ReturnType<typeof decideSingleFact>>): string {
  const c = value.candidate;
  return JSON.stringify([value.status, c?.id, c?.fact, c?.kind, c?.visibility,
    c?.valid_until ? new Date(c.valid_until).toISOString() : null, c?.source_markdown_slug, c?.row_num, c?.trust_tier ?? null]);
}
export const NO_ENTITY_HINT = 'Saved without an entity, so entity-scoped recall will not find it. To link it, remember the same claim again with `entity` (the person, company or project it is about): that replaces this copy, so there is nothing to forget. Do not forget it: a claim forgotten without an entity is withdrawn for every entity and cannot be saved again.';
function outcome(id: number, status: 'inserted' | 'duplicate' | 'superseded', entitySlug: string | null, validUntil: Date | string | null, degraded: boolean, p: Record<string, unknown>, supersededId?: number, linkedCopy = false) {
  const statusText = status === 'inserted' ? `remembered as fact #${id}` : status === 'duplicate'
    ? `already knew this — kept fact #${id}` : linkedCopy
      ? `linked — fact #${id} replaces #${supersededId}, the same claim saved without an entity; nothing to forget`
      : `updated — fact #${id} supersedes the previous version`;
  return { id: String(id), status, status_text: statusText, entity_slug: entitySlug,
    ...(status === 'superseded' && supersededId !== undefined ? { superseded_fact_id: String(supersededId) } : {}),
    ...(status === 'superseded' && p.replaces !== undefined && p.replaces !== null ? { replaced_by_caller: true } : {}),
    valid_until: validUntil ? new Date(validUntil).toISOString() : null,
    ...(degraded ? { degraded_dedup: true } : {}),
    ...(entitySlug !== null && p.entity_inferred ? { entity_inferred: p.entity_inferred as InferredVia } : {}),
    ...(entitySlug === null ? { warnings: [p.entity_warning === 'ENTITY_LINK_FAILED' ? 'ENTITY_LINK_FAILED' : 'NO_ENTITY'], hint: NO_ENTITY_HINT } : {}),
    protocol_version: 1 };
}

/** The newest active fact in this source and visibility that states the same normalized claim without an entity. */
async function activeUnlinkedCopy(engine: BrainEngine, sourceId: string, input: SingleFactIntent, excludePrivate: boolean): Promise<number | null> {
  const [row] = await engine.executeRaw<{ id: number }>(`SELECT id FROM facts
    WHERE source_id=$1 AND visibility=$2 AND entity_slug IS NULL AND expired_at IS NULL
      AND (valid_until IS NULL OR valid_until > now()) AND gbrain_fact_fingerprint(fact)=gbrain_fact_fingerprint($3)${excludePrivate ? ` AND ${privateProvenanceFilterFragment('facts')}` : ''}
    ORDER BY id DESC LIMIT 1`, [sourceId, input.visibility, input.fact]);
  return row ? Number(row.id) : null;
}

/** Every retry renders the semantic append from the latest coherent snapshot. */
export async function prepareMemoryMutation(engine: BrainEngine, row: WriteRequest, config: GBrainConfig, signal?: AbortSignal): Promise<PreparedMutation> {
  signal?.throwIfAborted();
  if (row.operation !== 'remember' || !row.intent) {
    throw opError('storage_error', 'Unknown memory mutation intent.',
      `Request ${row.request_id} in source ${row.source_id} carries no remember intent, so the coordinator cannot apply it and nothing was saved. This is an internal fault: inspect the request, then report it to the user.`,
      { fix: requestReceiptFix(row) });
  }
  const p = row.intent;
  const input: SingleFactIntent = { fact: String(p.fact).trim(), kind: (p.kind ?? 'fact') as SingleFactIntent['kind'],
    visibility: (p.visibility ?? 'world') as SingleFactIntent['visibility'], entity_slug: p.entity_slug as string | null };
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
  if ((snapshot?.page.id ?? null) !== row.page_id) throw pageIdentityError(snapshot != null || row.page_id === null, 'The accepted entity was deleted or recreated.');
  // A defaulted visibility never lands broader than the target page as it stands at publication.
  if (p.visibility_defaulted === true && snapshot) input.visibility = tightenToPage(input.visibility, snapshot.page);
  if (p.expected_revision !== undefined) assertPageRevision(snapshot, engineMutationPrecondition(parseMutationPrecondition(p)));
  const observedRevision = snapshot?.revision ?? null;
  const excludePrivate = await resolveExcludePrivatePages(engine, row.authority.remote === true);
  await assertFactNotWithdrawn(engine, row.source_id, input, { excludePrivate });
  signal?.throwIfAborted();
  const embeddingConfigSql = "SELECT key,value FROM config WHERE key IN ('embedding_model','embedding_dimensions') ORDER BY key";
  const observedEmbeddingConfig = JSON.stringify(await engine.executeRaw(embeddingConfigSql));
  const { embedding, embedding_model, degraded } = await prepareFactEmbedding(input.fact, signal, await factEmbeddingDisabled(engine, config));
  signal?.throwIfAborted();
  // #5836: an inferred link dedups exact text only, so it never supersedes or drops a similar fact.
  const dedupEmbedding = p.entity_inferred ? null : embedding;
  // `replaces`: the caller names the fact this one replaces (checked; the cosine rule does not apply).
  const replaces = p.replaces !== undefined && p.replaces !== null ? Number(p.replaces) : null;
  const replace = (e: BrainEngine, target: number, lock: boolean) =>
    decideReplacement(e, row.source_id, input, target, { pageSlug: row.slug, remote: row.authority.remote === true, lock, excludePrivate, slugPrefixes: row.authority.slugPrefixes });
  const decide = async (e: BrainEngine, lock = false) => {
    if (replaces !== null) return replace(e, replaces, lock);
    // The same claim saved earlier without an entity is this fact unlinked: linking it supersedes that copy,
    // so no subjectless duplicate is left whose forget would withdraw the claim from every entity.
    const unlinked = input.entity_slug === null ? null : await activeUnlinkedCopy(e, row.source_id, input, excludePrivate);
    if (unlinked !== null) {
      const linked = await replace(e, unlinked, lock).catch(() => null);
      if (linked) return linked;
    }
    return decideSingleFact(e, row.source_id, input, dedupEmbedding, embedding_model, undefined, { excludePrivate });
  };
  const decision = await decide(engine);
  // #5575 I3: a lower-tier write never supersedes; it is inserted contested and the owner decides (re-checked under lock by validate).
  const writerTier = requestChannelTrust(row)?.tier ?? 'unknown';
  const contested = decision.status === 'superseded' && supersessionGuarded(writerTier, decision.candidate!.trust_tier);
  const status = contested ? 'inserted' : decision.status;
  // Without a fact vector the slot has no cosine; a lexical same-subject match still contests a more trusted fact (never supersedes).
  const lexical = (tx: BrainEngine) => decision.status === 'inserted' && !dedupEmbedding && replaces === null ? lexicalContestCandidate(tx, row.source_id, input, writerTier) : Promise.resolve(null);
  const lexicalOld = await lexical(engine);
  const contestedOld = contested ? decision.candidate! : lexicalOld;
  const validate = async (tx: BrainEngine) => {
    await assertFactNotWithdrawn(tx, row.source_id, input, { excludePrivate });
    if (embedding && JSON.stringify(await tx.executeRaw(`${embeddingConfigSql} FOR SHARE`)) !== observedEmbeddingConfig) conflict(row);
    const current = await decide(tx, true);
    if (candidateState(current) !== candidateState(decision)) conflict(row);
    if ((await lexical(tx))?.id !== lexicalOld?.id) conflict(row);
  };
  if (decision.status === 'duplicate') {
    const duplicate = decision.candidate!;
    return { observedRevision, noop: true, validate, apply: async () => outcome(duplicate.id, 'duplicate', input.entity_slug, duplicate.valid_until, degraded, p) };
  }
  const validUntil = p.valid_until ? new Date(String(p.valid_until)) : null;
  const validFrom = new Date(String(p.valid_from));
  const context = p.entity_inferred ? appendContextNote(null, inferenceNote(p.entity_inferred as InferredVia)) : undefined;
  const fact: NewFact & { valid_from: Date } = { ...input, source: String(p.provenance).trim(), valid_from: validFrom, valid_until: validUntil,
    confidence: 1, embedding, embedding_model, source_session: typeof p.session_id === 'string' ? p.session_id : null,
    ...(context ? { context } : {}) };
  // #5575 B3: the row-level write gate at the request's declared tier (ENG-18); a held fact inserts nothing.
  const gate = decideFactWrite({ fact: input.fact, context: context ?? null, source: fact.source }, { sourceId: row.source_id, slug: row.slug,
    payload: { fact: input.fact, kind: input.kind, visibility: input.visibility, entity_slug: input.entity_slug, source: fact.source, context: context ?? null,
      valid_from: validFrom.toISOString(), valid_until: validUntil?.toISOString() ?? null, source_session: fact.source_session },
    input: gateInput(requestChannelTrust(row) ?? { tier: 'unknown', origin: null }, row.id), cfg: await loadWriteGateConfig(engine) });
  if (gate.action === 'reject') throw writeGateRejectedError(gate.assessment);
  if (gate.action === 'hold') return { observedRevision, validate, apply: async tx => heldOutcome(gate.assessment, (await recordWriteGateHold(tx, gate.hold!)).holdId) };
  const retiredUntil = status === 'superseded' ? supersededValidUntil(decision.candidate!, validFrom) : null;
  // The fact is published as a row of its entity page's facts fence, file before facts row (facts/fence-fact-append.ts).
  let fence: FenceFactAppend | undefined;
  if (p.fence === true && snapshot) {
    const old = decision.candidate;
    fence = await prepareFenceFactAppend(engine, row, config, snapshot, { fact, pendingTier: fenceAppendPendingTier(writerTier),
      supersede: status === 'superseded' && old?.source_markdown_slug === row.slug && old.row_num != null ? { rowNum: Number(old.row_num), validUntil: retiredUntil } : undefined }, signal);
  }
  // The belief ledger records the superseded fact in its own stream, so that stream's page key is held too.
  const supersededStream = status === 'superseded' ? decision.candidate!.source_markdown_slug ?? decision.candidate!.entity_slug ?? null : null;
  const additionalPageKeys = supersededStream && supersededStream !== row.slug ? [{ sourceId: row.source_id, slug: supersededStream }] : undefined;
  const page = fence?.prepared ?? undefined;
  return { observedRevision, file: page?.file, ...(page?.exclusiveSources ? { exclusiveSources: page.exclusiveSources } : {}), ...(additionalPageKeys ? { additionalPageKeys } : {}), validate: async tx => { await validate(tx); await page?.validate?.(tx); }, apply: async tx => {
    let id: number;
    let pageReceipt: { size_state?: unknown } | undefined;
    if (fence) {
      ({ id, pageReceipt } = await fence.apply(tx));
    } else {
      const inserted = await tx.insertFact(fact, { source_id: row.source_id }); // gbrain-allow-direct-insert: journaled source-scoped semantic publication for subjectless or unresolved entity memory
      id = inserted.id;
    }
    if (status === 'superseded') {
      await tx.executeRaw(`UPDATE facts SET expired_at=now(),superseded_by=$3,valid_until=COALESCE($4::timestamptz,valid_until)
      WHERE id=$1 AND source_id=$2 AND expired_at IS NULL`, [decision.candidate!.id, row.source_id, id, retiredUntil]);
      noteBelief({ kind: 'superseded', oldId: Number(decision.candidate!.id), newId: id });
    }
    const contestedBy = contestedOld ? await recordContestedFact(tx, { sourceId: row.source_id, oldId: contestedOld.id,
      oldTier: storedTrustTier(contestedOld.trust_tier), newId: id, newTier: writerTier,
      guard: replaces !== null ? 'remember.replaces' : contested ? 'conflict_slot' : 'conflict_slot_lexical' }) : null;
    const flagged = gateField(gate.assessment, `f${id}`, await recordFlaggedRow(tx, gate, { table: 'facts', id, sourceId: row.source_id }));
    const superseded = status === 'superseded' ? decision.candidate! : undefined;
    return { ...outcome(id, status, input.entity_slug, validUntil, degraded, p, superseded?.id,
      superseded !== undefined && superseded.entity_slug == null && input.entity_slug !== null), ...fence?.fencesNormalized,
      ...(contestedBy ? { contested: contestedBy } : {}), ...(flagged ? { gate: flagged } : {}),
      ...(pageReceipt?.size_state ? { size_state: pageReceipt.size_state } : {}) };
  } };
}
