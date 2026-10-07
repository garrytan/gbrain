import type { BrainEngine, NewFact } from '../engine.ts';
import { attributionCompatible } from '../facts/attribution.ts';
import type { GBrainConfig } from '../config.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { Action } from '../agent-output.ts';
import type { RegistryCode } from '../error-registry.ts';
import { parseFactsFence, upsertFactRow, formatFenceDate, renderFactsTable, replaceOrInsertFactsFence } from '../facts-fence.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { assertFactNotWithdrawn, decideSingleFact, type FactCandidate } from '../facts/single-prepare.ts';
import { extractFactsFromFenceText } from '../facts/extract-from-fence.ts';
import { authorizeWrite } from './authority.ts';
import { authorizePageVisibility } from './page-visibility.ts';
import { authorizeFactsBackstop } from './effect-facts.ts';
import { getWriteRequestById } from './journal.ts';
import { preparePageMutation } from './page-prepare.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { WriteRequest } from './model.ts';
import type { ManagedFactIntent, FrozenExtractedFact } from './facts-maintenance.ts';
import { assertManagedFactsEmbedding } from './facts-maintenance.ts';
import { normalizeTargetFences } from '../fence-repair/import-step.ts';
import { pageFencesNormalized } from '../fence-repair/report.ts';

const requestFix = (row: WriteRequest): Action => row.principal_kind === 'local_cli'
  ? readFix(`Reads fact request ${row.request_id}'s durable receipt: its state and recorded error, read-only.`, { argv: ['gbrain', 'write-request', '--', row.request_id] })
  : readFix(`Shows source ${row.source_id}'s canonical owner with its pending, failed and recovering requests, read-only.`,
    { argv: ['gbrain', 'sources', 'writer', 'status', '--source', row.source_id, '--json'] });

/**
 * A refused managed fact request. The journal keeps only code and message, so
 * the suggestion stands alone: inspect the request, then extract again.
 */
function factsRefusal(code: RegistryCode, message: string, row: WriteRequest, cause: string,
  next = 'once it is final, run extract_facts again for the same turn with a new request_id.', fix = requestFix(row)): OperationError {
  return opError(code, message, `${cause} Fact request ${row.request_id} in source ${row.source_id} was refused; inspect it first and do not resubmit it, then ${next}`, { fix });
}

/** #5836: an inferred subject dedups exact text only, so a similar fact is never superseded or dropped for it. */
function dedupEmbedding(fact: { embedding?: Float32Array | null; entity_inferred?: unknown }): Float32Array | null {
  return fact.entity_inferred ? null : fact.embedding ?? null;
}

function thawFact(fact: FrozenExtractedFact): NewFact & { entity_slug: string | null; kind: NonNullable<NewFact['kind']>; visibility: NonNullable<NewFact['visibility']> } {
  return { ...fact, entity_slug: fact.entity_slug ?? null, kind: fact.kind ?? 'fact', visibility: fact.visibility ?? 'private',
    valid_from: new Date(fact.valid_from), valid_until: fact.valid_until ? new Date(fact.valid_until) : null,
    embedding: fact.embedding ? new Float32Array(fact.embedding) : null };
}

export async function prepareManagedFactsMutation(engine: BrainEngine, row: WriteRequest, config: GBrainConfig): Promise<PreparedMutation> {
  const p = row.intent as ManagedFactIntent | null;
  if (!p || !['managed_facts_entity', 'managed_facts_complete'].includes(p.kind) || row.operation !== 'extract_facts'
    || row.authority.slugPrefixes !== null || row.authority.restrictedNamespace || row.authority.delegated) {
    throw factsRefusal('permission_denied', 'Unsupported fact extraction intent or confined authority.', row,
      'Managed fact extraction runs only for an extract_facts intent under an unconfined writer, and this request is limited to slug prefixes, a restricted namespace or a delegation, or carries another intent.',
      'record single facts with remember instead, or ask the user to run the extraction from a writer whose grant is not confined.');
  }
  const embedded = p.facts?.some(fact => fact.embedding !== null && fact.embedding !== undefined);
  const validate = async (tx: BrainEngine, lock = false) => {
    if (embedded) {
      await assertManagedFactsEmbedding(tx, config, p.embedding, lock);
      if (p.facts!.some(fact => fact.embedding && (fact.embedding.length !== p.embedding!.dimensions || !fact.embedding.every(Number.isFinite)))) {
        throw factsRefusal('embedding_configuration', 'Retained fact vectors do not match their embedding signature.', row,
          `A retained fact vector is not a finite ${p.embedding!.dimensions}-dimension vector of ${p.embedding!.model}, so none of these facts were installed.`);
      }
    }
    if (p.originalRequestId) {
      const original = await getWriteRequestById(tx, p.originalRequestId);
      if (!original || original.state !== 'committed' || original.source_id !== row.source_id || original.source_incarnation !== row.source_incarnation
        || original.principal_kind !== row.principal_kind || original.principal_id !== row.principal_id) {
        throw factsRefusal('permission_denied', 'The original fact extraction authority is unavailable.', row,
          'The committed page write that started this extraction is gone, not committed, or belongs to another source or writer, so its authority cannot back these facts.');
      }
      await authorizeFactsBackstop(tx, original, true);
    }
    if (p.origin) {
      await authorizeWrite(tx, row.authority, 'extract_facts', p.origin.slug);
      await authorizePageVisibility(tx, row.authority, p.origin.slug);
      const origin = await tx.readPageSnapshot(p.origin.slug, { sourceId: row.source_id });
      if (!origin || origin.page.id !== p.origin.pageId) throw factsRefusal('page_identity_changed', 'The source page was removed or replaced during fact extraction.', row,
        `Page ${p.origin.slug}, which these facts were extracted from, was deleted or replaced during extraction.`);
      if (origin.revision !== p.origin.revision) {
        const own = await tx.executeRaw(`SELECT id FROM persistence_requests WHERE operation='extract_facts' AND source_id=$1
          AND source_incarnation=$2::uuid AND principal_kind=$3 AND principal_id=$4 AND COALESCE(intent->>'batchKey',outcome->>'batch_key')=$5
          AND slug=$6 AND state='committed' AND outcome->>'revision'=$7`,
        [row.source_id, row.source_incarnation, row.principal_kind, row.principal_id, p.batchKey, p.origin.slug, origin.revision]);
        if (!own.length) throw factsRefusal('revision_conflict', 'The source page changed during fact extraction.', row,
          `Page ${p.origin.slug} changed after its facts were extracted, so facts from the older text were not published.`,
          `once it is final, run extract_facts again on the current text of ${p.origin.slug} with a new request_id.`);
      }
    }
  };
  await validate(engine);
  const additionalPageKeys = p.origin ? [{ sourceId: row.source_id, slug: p.origin.slug }] : [];
  if (p.kind === 'managed_facts_complete') return { observedRevision: null, noop: true, additionalPageKeys, validate, apply: async tx => {
    const children = p.children ?? [];
    const done = await tx.executeRaw<{ outcome: { inserted?: number; duplicate?: number; fact_ids?: number[] } }>(`SELECT outcome FROM persistence_requests WHERE id=ANY($1::uuid[]) AND source_incarnation=$2::uuid
      AND state='committed' AND COALESCE(intent->>'batchKey',outcome->>'batch_key')=$3 AND operation='extract_facts'`, [children, row.source_incarnation, p.batchKey]);
    if (done.length !== children.length) throw factsRefusal('revision_conflict', 'Some extracted facts have not committed.', row,
      `${children.length - done.length} of the batch's ${children.length} per-entity fact requests have not committed, so the extraction cannot be recorded as complete.`,
      'once the entity requests are final, run extract_facts again for the same turn with a new request_id only if facts are still missing.');
    return { status: 'completed', entity_requests: children.length, kind: p.kind, batch_key: p.batchKey, input_digest: p.inputDigest,
      inserted: done.reduce((sum, item) => sum + Number(item.outcome.inserted ?? 0), 0),
      duplicate: done.reduce((sum, item) => sum + Number(item.outcome.duplicate ?? 0), 0),
      fact_ids: done.flatMap(item => item.outcome.fact_ids ?? []) };
  } };
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
  if (snapshot?.page.deleted_at || (snapshot?.page.id ?? null) !== row.page_id || (snapshot?.revision ?? null) !== (p.expected_revision ?? null)) {
    throw factsRefusal('revision_conflict', 'The fact entity changed after extraction admission.', row,
      `Entity page ${row.slug} changed or was deleted after these facts were admitted, so none were published.`);
  }
  const facts = (p.facts ?? []).map(fact => ({ ...thawFact(fact), embedding_model: fact.embedding ? p.embedding?.model ?? null : null }));
  // writeSingleFact's opt-in: an unattributed row keeps its fallback entity slug, database-only.
  const fallback = (fact: { entity_slug: string | null }) => p.attribute_fallback === true && row.slug === 'memory/unattributed'
    && fact.entity_slug !== null && fact.entity_slug !== row.slug;
  if (!facts.length || facts.some(fact => !fallback(fact) && (fact.entity_slug !== null && fact.entity_slug !== row.slug || fact.entity_slug !== null && !snapshot))) {
    throw factsRefusal('invalid_params', 'The prepared facts do not match their entity.', row,
      `The request holds no facts, or facts attributed to a page other than ${row.slug}, so none were published.`);
  }
  // #6188 (D20): the entity's stored fence is normalized in this same write; a residual refuses typed `target_fence_malformed`.
  const target = snapshot ? await normalizeTargetFences(engine, { sourceId: row.source_id, slug: row.slug, kind: 'facts', page: snapshot.page }) : null;
  let body = target?.page.compiled_truth ?? '';
  const parsed = parseFactsFence(body);
  const [maximum] = await engine.executeRaw<{ n: number }>('SELECT COALESCE(MAX(row_num),0)::int AS n FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', [row.source_id, row.slug]);
  let nextRow = Math.max(maximum?.n ?? 0, ...parsed.facts.map(fact => fact.rowNum)) + 1;
  const entries: Array<{ fact: typeof facts[number]; duplicateId: number | null; rowNum?: number; duplicateOf?: number; supersedes?: FactCandidate }> = [];
  const seen = new Map<string, number[]>();
  for (const fact of facts) {
    await assertFactNotWithdrawn(engine, row.source_id, fact);
    const key = JSON.stringify([fact.fact, fact.visibility, fact.entity_slug]);
    const earlier = (seen.get(key) ?? []).find(i => attributionCompatible(entries[i].fact.attributed_to, fact.attributed_to));
    if (earlier !== undefined) { entries.push({ fact, duplicateId: null, duplicateOf: earlier }); continue; }
    seen.set(key, [...(seen.get(key) ?? []), entries.length]);
    const decision = await decideSingleFact(engine, row.source_id, fact, dedupEmbedding(fact), fact.embedding_model, fact.source);
    const supersedes = p.supersede === true && decision.status === 'superseded' ? decision.candidate! : undefined;
    if (decision.candidate && !supersedes) { entries.push({ fact, duplicateId: decision.candidate.id }); continue; }
    const rowNum = fact.entity_slug !== null && !fallback(fact) ? nextRow++ : undefined;
    if (rowNum !== undefined) body = upsertFactRow(body, { rowNum, claim: fact.fact, kind: fact.kind, visibility: fact.visibility,
      confidence: fact.confidence ?? 1, notability: fact.notability ?? 'medium', source: fact.source, context: fact.context ?? undefined,
      validFrom: formatFenceDate(fact.valid_from!), validUntil: fact.valid_until ? formatFenceDate(fact.valid_until) : undefined,
      claimMetric: fact.claim_metric ?? undefined, claimValue: fact.claim_value ?? undefined,
      claimUnit: fact.claim_unit ?? undefined, claimPeriod: fact.claim_period ?? undefined,
      ...(fact.attributed_to ? { attributedTo: fact.attributed_to } : {}) }).body;
    // Strike the superseded row in this page's fence, as the remember mutation does.
    if (supersedes && rowNum !== undefined && supersedes.source_markdown_slug === row.slug && supersedes.row_num != null) {
      body = replaceOrInsertFactsFence(body, renderFactsTable(parseFactsFence(body).facts.map(f => f.rowNum === Number(supersedes.row_num)
        ? { ...f, active: false, supersededBy: rowNum, context: `superseded by #${rowNum}` } : f)));
    }
    entries.push({ fact, duplicateId: null, rowNum, supersedes });
  }
  const canonicalFacts = extractFactsFromFenceText(parseFactsFence(body).facts, row.slug, row.source_id);
  for (const entry of entries) {
    if (entry.rowNum === undefined) continue;
    const canonical = canonicalFacts.find(fact => fact.row_num === entry.rowNum);
    if (!canonical) throw factsRefusal('invalid_params', 'An extracted fact could not be represented in its canonical fence.', row,
      `An extracted fact did not round-trip through the ## Facts table of page ${row.slug}, so none were published.`);
    entry.fact = { ...entry.fact, ...canonical, kind: canonical.kind ?? entry.fact.kind,
      visibility: canonical.visibility ?? entry.fact.visibility, entity_slug: row.slug,
      embedding: entry.fact.embedding, source_session: entry.fact.source_session };
  }
  let page: PreparedMutation | undefined;
  if (snapshot && entries.some(entry => entry.rowNum !== undefined)) {
    page = await preparePageMutation(engine, { ...row, intent: { ...p,
      content: serializePageToMarkdown({ ...snapshot.page, compiled_truth: body, timeline: target!.page.timeline }, snapshot.tags) } }, config);
    if (page.observedRevision !== snapshot.revision) throw factsRefusal('revision_conflict', 'The fact entity changed during preparation.', row,
      `Entity page ${row.slug} changed while its ## Facts table was being prepared, so none of these facts were published.`);
  }
  return { observedRevision: snapshot?.revision ?? null, file: page?.file, ...(page?.exclusiveSources ? { exclusiveSources: page.exclusiveSources } : {}), noop: entries.every(entry => entry.duplicateId !== null || entry.duplicateOf !== undefined),
    additionalPageKeys, validate: async tx => {
      await validate(tx, true);
      await page?.validate?.(tx);
      for (const entry of entries) {
        await assertFactNotWithdrawn(tx, row.source_id, entry.fact);
        if (entry.duplicateOf !== undefined) continue;
        const current = await decideSingleFact(tx, row.source_id, entry.fact, dedupEmbedding(entry.fact), entry.fact.embedding_model, entry.fact.source);
        if ((current.candidate?.id ?? null) !== (entry.duplicateId ?? entry.supersedes?.id ?? null)) throw factsRefusal('revision_conflict', 'The fact deduplication state changed before publication.', row,
          `A matching fact in source ${row.source_id} was added or retired before publication, so the deduplication decision for ${row.slug} is stale and none of these facts were published.`);
      }
    }, apply: async tx => {
      await page?.apply(tx);
      const ids: number[] = [];
      let inserted = 0;
      let superseded = 0;
      for (const entry of entries) {
        if (entry.duplicateOf !== undefined) { ids.push(ids[entry.duplicateOf]); continue; }
        if (entry.duplicateId !== null) { ids.push(entry.duplicateId); continue; }
        if (entry.rowNum !== undefined) {
          const result = await tx.insertFacts([{ ...entry.fact, row_num: entry.rowNum, source_markdown_slug: row.slug }], { source_id: row.source_id });
          if (result.ids.length !== 1) throw factsRefusal('storage_error', 'The canonical extracted fact was not indexed.', row,
            `A fact row written into the ## Facts table of ${row.slug} was not indexed, so the publication transaction rolled back.`);
          ids.push(result.ids[0]);
        } else ids.push((await tx.insertFact(entry.fact, { source_id: row.source_id })).id);
        inserted++;
        if (entry.supersedes) {
          await tx.executeRaw('UPDATE facts SET expired_at=COALESCE(expired_at,now()),superseded_by=$3 WHERE id=$1 AND source_id=$2',
            [entry.supersedes.id, row.source_id, ids[ids.length - 1]]);
          superseded++;
        }
      }
      return { status: 'completed', inserted, duplicate: entries.length - inserted, superseded, fact_ids: ids,
        fenced: page !== undefined, kind: p.kind, batch_key: p.batchKey, input_digest: p.inputDigest,
        ...(page && target?.fixes.length ? { fences_normalized: pageFencesNormalized({ sourceId: row.source_id, slug: row.slug, fixes: target.fixes,
          writer: row.principal_kind, path: snapshot?.page.source_path ?? null, remote: row.authority.remote }) } : {}) };
    } };
}
