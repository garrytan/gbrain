import type { BrainEngine, NewFact } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { OperationError } from '../ops/contract.ts';
import { authorizeWrite } from './authority.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { ManagedConversationFactsIntent } from './conversation-facts.ts';
import type { WriteRequest } from './model.ts';
import { readConversationBodyForParsing } from '../conversation-parser/body.ts';
import { conversationSnapshotVersionToken } from '../conversation-parser/snapshot.ts';

const FACT_PREFIX = 'cli:extract-conversation-facts%';
const TERMINAL_SOURCE = 'cli:extract-conversation-facts:terminal:v2';
const NON_EXTRACTABLE_SOURCE = 'cli:extract-conversation-facts:non-extractable:v2';

function thaw(value: Record<string, unknown>): NewFact {
  return { ...value, embedding: Array.isArray(value.embedding) ? new Float32Array(value.embedding as number[]) : null,
    valid_from: typeof value.valid_from === 'string' ? new Date(value.valid_from) : value.valid_from as Date | undefined,
    valid_until: typeof value.valid_until === 'string' ? new Date(value.valid_until) : value.valid_until as Date | null | undefined } as NewFact;
}

export async function prepareManagedConversationFactsMutation(engine: BrainEngine, row: WriteRequest,
  _config: GBrainConfig): Promise<PreparedMutation> {
  const intent = row.intent as ManagedConversationFactsIntent | null;
  if (row.operation !== 'extract_facts' || intent?.kind !== 'managed_conversation_facts_page'
    || !intent.contentToken || !intent.expectedRevision || !['complete', 'non_extractable'].includes(intent.outcome)
    || !Array.isArray(intent.facts) || intent.facts.length > 100_000) {
    throw new OperationError('invalid_params', 'Invalid managed conversation fact batch.');
  }
  if (row.authority.slugPrefixes !== null || row.authority.restrictedNamespace || row.authority.delegated) {
    throw new OperationError('permission_denied', 'Conversation fact extraction requires a source-wide writer grant.');
  }
  const facts = intent.facts.map(thaw);
  if (facts.some(fact => !fact.fact || fact.source !== 'cli:extract-conversation-facts')) {
    throw new OperationError('invalid_params', 'The managed conversation fact batch has invalid provenance.');
  }
  const source = intent.outcome === 'complete' ? TERMINAL_SOURCE : NON_EXTRACTABLE_SOURCE;
  const audit: (NewFact & { row_num: number; source_markdown_slug: string }) | null = intent.terminal === false ? null : {
    fact: intent.outcome === 'complete' ? 'EXTRACTION_COMPLETE' : 'EXTRACTION_NOT_APPLICABLE',
    kind: 'fact', entity_slug: null, source, source_session: intent.outcomeSession,
    confidence: 1, notability: 'low', context: intent.auditContext ?? null, row_num: facts.length, source_markdown_slug: row.slug,
  };
  const validate = async (tx: BrainEngine) => {
    await authorizeWrite(tx, row.authority, 'extract_facts', row.slug, true);
    const snapshot = await tx.readPageSnapshot(row.slug, { sourceId: row.source_id });
    if (!snapshot || snapshot.page.id !== row.page_id || snapshot.revision !== intent.expectedRevision
      || conversationSnapshotVersionToken(snapshot.page, await readConversationBodyForParsing(tx, snapshot.page)) !== intent.contentToken) {
      throw new OperationError('revision_conflict', 'The conversation page changed after fact extraction; no rows were replaced.');
    }
  };
  await validate(engine);
  return { observedRevision: intent.expectedRevision, additionalPageKeys: [{ sourceId: row.source_id, slug: row.slug }],
    validate, apply: async tx => {
      const deleted = await tx.executeRaw<{ count: string }>(`WITH del AS (DELETE FROM facts WHERE source_id=$1
        AND source_markdown_slug=$2 AND source LIKE $3 RETURNING 1) SELECT COUNT(*)::text AS count FROM del`,
      [row.source_id, row.slug, FACT_PREFIX]);
      const [maximum] = await tx.executeRaw<{ n: number }>('SELECT COALESCE(MAX(row_num),-1)::int AS n FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', [row.source_id, row.slug]);
      const firstRow = (maximum?.n ?? -1) + 1;
      const rows = [...facts.map((fact, index) => ({ ...fact, row_num: firstRow + index, source_markdown_slug: row.slug })),
        ...(audit ? [{ ...audit, row_num: firstRow + facts.length }] : [])];
      const inserted = rows.length ? await tx.insertFacts(rows, { source_id: row.source_id }) : { ids: [] };
      if (inserted.ids.length !== rows.length) throw new OperationError('storage_error', 'The conversation fact batch was not fully indexed.');
      return { status: 'completed', inserted: facts.length, deleted: Number(deleted[0]?.count ?? 0),
        outcome: intent.outcome, content_token: intent.contentToken };
    } };
}
