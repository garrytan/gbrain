import type { BrainEngine, NewFact } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { OperationError } from '../ops/contract.ts';
import { parseFactsFence, upsertFactRow } from '../facts-fence.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { assertFactNotWithdrawn, decideSingleFact } from '../facts/single-prepare.ts';
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

function thawFact(fact: FrozenExtractedFact): NewFact & { entity_slug: string | null; kind: NonNullable<NewFact['kind']>; visibility: NonNullable<NewFact['visibility']> } {
  return { ...fact, entity_slug: fact.entity_slug ?? null, kind: fact.kind ?? 'fact', visibility: fact.visibility ?? 'private',
    valid_from: new Date(fact.valid_from), valid_until: fact.valid_until ? new Date(fact.valid_until) : null,
    embedding: fact.embedding ? new Float32Array(fact.embedding) : null };
}

export async function prepareManagedFactsMutation(engine: BrainEngine, row: WriteRequest, config: GBrainConfig): Promise<PreparedMutation> {
  const p = row.intent as ManagedFactIntent | null;
  if (!p || !['managed_facts_entity', 'managed_facts_complete'].includes(p.kind) || row.operation !== 'extract_facts'
    || row.authority.slugPrefixes !== null || row.authority.restrictedNamespace || row.authority.delegated) {
    throw new OperationError('permission_denied', 'Unsupported fact extraction intent or confined authority.');
  }
  const embedded = p.facts?.some(fact => fact.embedding !== null && fact.embedding !== undefined);
  const validate = async (tx: BrainEngine, lock = false) => {
    if (embedded) {
      await assertManagedFactsEmbedding(tx, config, p.embedding, lock);
      if (p.facts!.some(fact => fact.embedding && (fact.embedding.length !== p.embedding!.dimensions || !fact.embedding.every(Number.isFinite)))) {
        throw new OperationError('embedding_configuration', 'Retained fact vectors do not match their embedding signature.');
      }
    }
    if (p.originalRequestId) {
      const original = await getWriteRequestById(tx, p.originalRequestId);
      if (!original || original.state !== 'committed' || original.source_id !== row.source_id || original.source_incarnation !== row.source_incarnation
        || original.principal_kind !== row.principal_kind || original.principal_id !== row.principal_id) {
        throw new OperationError('permission_denied', 'The original fact extraction authority is unavailable.');
      }
      await authorizeFactsBackstop(tx, original, true);
    }
    if (p.origin) {
      await authorizeWrite(tx, row.authority, 'extract_facts', p.origin.slug);
      await authorizePageVisibility(tx, row.authority, p.origin.slug);
      const origin = await tx.readPageSnapshot(p.origin.slug, { sourceId: row.source_id });
      if (!origin || origin.page.id !== p.origin.pageId) throw new OperationError('page_identity_changed', 'The source page was removed or replaced during fact extraction.');
      if (origin.revision !== p.origin.revision) {
        const own = await tx.executeRaw(`SELECT id FROM persistence_requests WHERE operation='extract_facts' AND source_id=$1
          AND source_incarnation=$2::uuid AND principal_kind=$3 AND principal_id=$4 AND COALESCE(intent->>'batchKey',outcome->>'batch_key')=$5
          AND slug=$6 AND state='committed' AND outcome->>'revision'=$7`,
        [row.source_id, row.source_incarnation, row.principal_kind, row.principal_id, p.batchKey, p.origin.slug, origin.revision]);
        if (!own.length) throw new OperationError('revision_conflict', 'The source page changed during fact extraction.');
      }
    }
  };
  await validate(engine);
  const additionalPageKeys = p.origin ? [{ sourceId: row.source_id, slug: p.origin.slug }] : [];
  if (p.kind === 'managed_facts_complete') return { observedRevision: null, noop: true, additionalPageKeys, validate, apply: async tx => {
    const children = p.children ?? [];
    const done = await tx.executeRaw<{ outcome: { inserted?: number; duplicate?: number; fact_ids?: number[] } }>(`SELECT outcome FROM persistence_requests WHERE id=ANY($1::uuid[]) AND source_incarnation=$2::uuid
      AND state='committed' AND COALESCE(intent->>'batchKey',outcome->>'batch_key')=$3 AND operation='extract_facts'`, [children, row.source_incarnation, p.batchKey]);
    if (done.length !== children.length) throw new OperationError('revision_conflict', 'Some extracted facts have not committed.');
    return { status: 'completed', entity_requests: children.length, kind: p.kind, batch_key: p.batchKey, input_digest: p.inputDigest,
      inserted: done.reduce((sum, item) => sum + Number(item.outcome.inserted ?? 0), 0),
      duplicate: done.reduce((sum, item) => sum + Number(item.outcome.duplicate ?? 0), 0),
      fact_ids: done.flatMap(item => item.outcome.fact_ids ?? []) };
  } };
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
  if (snapshot?.page.deleted_at || (snapshot?.page.id ?? null) !== row.page_id || (snapshot?.revision ?? null) !== (p.expected_revision ?? null)) {
    throw new OperationError('revision_conflict', 'The fact entity changed after extraction admission.');
  }
  const facts = (p.facts ?? []).map(thawFact);
  if (!facts.length || facts.some(fact => fact.entity_slug !== null && fact.entity_slug !== row.slug || fact.entity_slug !== null && !snapshot)) {
    throw new OperationError('invalid_params', 'The prepared facts do not match their entity.');
  }
  let body = snapshot?.page.compiled_truth ?? '';
  const parsed = parseFactsFence(body);
  if (parsed.warnings.length) throw new OperationError('invalid_params', 'The entity facts fence is malformed.');
  const [maximum] = await engine.executeRaw<{ n: number }>('SELECT COALESCE(MAX(row_num),0)::int AS n FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', [row.source_id, row.slug]);
  let nextRow = Math.max(maximum?.n ?? 0, ...parsed.facts.map(fact => fact.rowNum)) + 1;
  const entries: Array<{ fact: typeof facts[number]; duplicateId: number | null; rowNum?: number; duplicateOf?: number }> = [];
  const seen = new Map<string, number>();
  for (const fact of facts) {
    await assertFactNotWithdrawn(engine, row.source_id, fact);
    const key = JSON.stringify([fact.fact, fact.visibility]);
    const earlier = seen.get(key);
    if (earlier !== undefined) { entries.push({ fact, duplicateId: null, duplicateOf: earlier }); continue; }
    seen.set(key, entries.length);
    const decision = await decideSingleFact(engine, row.source_id, fact, fact.embedding ?? null);
    if (decision.candidate) { entries.push({ fact, duplicateId: decision.candidate.id }); continue; }
    const rowNum = fact.entity_slug !== null ? nextRow++ : undefined;
    if (rowNum !== undefined) body = upsertFactRow(body, { rowNum, claim: fact.fact, kind: fact.kind, visibility: fact.visibility,
      confidence: fact.confidence ?? 1, notability: fact.notability ?? 'medium', source: fact.source, context: fact.context ?? undefined,
      validFrom: fact.valid_from!.toISOString().slice(0, 10), validUntil: fact.valid_until?.toISOString().slice(0, 10),
      claimMetric: fact.claim_metric ?? undefined, claimValue: fact.claim_value ?? undefined,
      claimUnit: fact.claim_unit ?? undefined, claimPeriod: fact.claim_period ?? undefined }).body;
    entries.push({ fact, duplicateId: null, rowNum });
  }
  const canonicalFacts = extractFactsFromFenceText(parseFactsFence(body).facts, row.slug, row.source_id);
  for (const entry of entries) {
    if (entry.rowNum === undefined) continue;
    const canonical = canonicalFacts.find(fact => fact.row_num === entry.rowNum);
    if (!canonical) throw new OperationError('invalid_params', 'An extracted fact could not be represented in its canonical fence.');
    entry.fact = { ...entry.fact, ...canonical, kind: canonical.kind ?? entry.fact.kind,
      visibility: canonical.visibility ?? entry.fact.visibility, entity_slug: row.slug,
      embedding: entry.fact.embedding, source_session: entry.fact.source_session };
  }
  let page: PreparedMutation | undefined;
  if (snapshot && entries.some(entry => entry.rowNum !== undefined)) {
    page = await preparePageMutation(engine, { ...row, intent: { ...p,
      content: serializePageToMarkdown({ ...snapshot.page, compiled_truth: body }, snapshot.tags) } }, config);
    if (page.observedRevision !== snapshot.revision) throw new OperationError('revision_conflict', 'The fact entity changed during preparation.');
  }
  return { observedRevision: snapshot?.revision ?? null, file: page?.file, noop: entries.every(entry => entry.duplicateId !== null || entry.duplicateOf !== undefined),
    additionalPageKeys, validate: async tx => {
      await validate(tx, true);
      await page?.validate?.(tx);
      for (const entry of entries) {
        await assertFactNotWithdrawn(tx, row.source_id, entry.fact);
        if (entry.duplicateOf !== undefined) continue;
        const current = await decideSingleFact(tx, row.source_id, entry.fact, entry.fact.embedding ?? null);
        if ((current.candidate?.id ?? null) !== entry.duplicateId) throw new OperationError('revision_conflict', 'The fact deduplication state changed before publication.');
      }
    }, apply: async tx => {
      await page?.apply(tx);
      const ids: number[] = [];
      let inserted = 0;
      for (const entry of entries) {
        if (entry.duplicateOf !== undefined) { ids.push(ids[entry.duplicateOf]); continue; }
        if (entry.duplicateId !== null) { ids.push(entry.duplicateId); continue; }
        if (entry.rowNum !== undefined) {
          const result = await tx.insertFacts([{ ...entry.fact, row_num: entry.rowNum, source_markdown_slug: row.slug }], { source_id: row.source_id });
          if (result.ids.length !== 1) throw new OperationError('storage_error', 'The canonical extracted fact was not indexed.');
          ids.push(result.ids[0]);
        } else ids.push((await tx.insertFact(entry.fact, { source_id: row.source_id })).id);
        inserted++;
      }
      return { status: 'completed', inserted, duplicate: entries.length - inserted, superseded: 0, fact_ids: ids,
        fenced: page !== undefined, kind: p.kind, batch_key: p.batchKey, input_digest: p.inputDigest };
    } };
}
