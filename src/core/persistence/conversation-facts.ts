import { createHash } from 'node:crypto';
import type { BrainEngine, NewFact } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { OperationContext } from '../ops/contract.ts';
import { OperationError } from '../ops/contract.ts';
import { authorizeWrite, submissionAuthority } from './authority.ts';
import { admitWriteInTransaction, getWriteRequest } from './journal.ts';
import { initializeLocalPersistence, requestPrincipalForContext } from './page-mutations.ts';
import { currentVerifiedLocalWriter, localHostId } from './identity.ts';
import { getWorktreeBinding, managedPersistenceEnabled } from './ownership.ts';
import { assertPersistenceAccepting, startPersistenceConsumer, waitForWrite } from './service.ts';
import { TERMINAL_AUDIT_SOURCE, NON_EXTRACTABLE_AUDIT_SOURCE } from '../facts/audit-sources.ts';

export interface ManagedConversationFactsIntent extends Record<string, unknown> {
  kind: 'managed_conversation_facts_page';
  contentToken: string;
  expectedRevision: string;
  facts: Array<Record<string, unknown>>;
  outcome: 'complete' | 'non_extractable';
  outcomeSession: string;
  terminal: boolean;
  auditContext?: string;
}

export function conversationFactsRequestId(sourceId: string, slug: string, pageId: number, expectedRevision: string,
  contentToken: string, variant: string): string {
  const hex = createHash('sha256').update(JSON.stringify([sourceId, slug, pageId, expectedRevision, contentToken,
    `extract-conversation-facts:v2:${variant}`])).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-8${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}

export async function submitManagedConversationFacts(engine: BrainEngine, input: {
  sourceId: string; slug: string; pageId: number; expectedRevision: string; contentToken: string;
  facts: NewFact[]; outcome: 'complete' | 'non_extractable'; outcomeSession: string;
  terminal?: boolean;
  auditContext?: string;
}): Promise<{ inserted: number; deleted: number; state: string }> {
  if (!(await managedPersistenceEnabled(engine))) throw new OperationError('writer_coordinator_required', 'Managed conversation facts require the managed writer.');
  assertPersistenceAccepting(engine);
  const writer = currentVerifiedLocalWriter();
  if (writer?.remote) throw new OperationError('permission_denied', 'Conversation fact extraction requires a trusted local writer.');
  const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean }>('SELECT incarnation,archived FROM sources WHERE id=$1', [input.sourceId]);
  if (!source || source.archived) throw new OperationError('source_changed', 'The conversation source is unavailable.');
  const context = { engine, remote: false, sourceId: input.sourceId, config: { engine: engine.kind } } as OperationContext;
  await initializeLocalPersistence(context);
  const principal = await requestPrincipalForContext(context);
  const authority = await submissionAuthority(context, 'extract_facts', input.sourceId, source.incarnation, input.slug);
  if (authority.slugPrefixes !== null || authority.restrictedNamespace || authority.delegated) {
    throw new OperationError('permission_denied', 'Conversation facts require a source-wide writer grant.');
  }
  const binding = await getWorktreeBinding(engine, input.sourceId);
  if (binding && (binding.owner_host_id !== localHostId() || binding.state !== 'active' || !binding.local_path)) {
    throw new OperationError('owner_unavailable', 'The canonical conversation source owner is unavailable.');
  }
  const variant = `${input.outcome}:${input.terminal === false ? 'partial' : 'terminal'}`;
  const requestId = conversationFactsRequestId(input.sourceId, input.slug, input.pageId, input.expectedRevision, input.contentToken, variant);
  let intent: ManagedConversationFactsIntent = {
    kind: 'managed_conversation_facts_page', contentToken: input.contentToken,
    expectedRevision: input.expectedRevision, facts: input.facts.map(fact => ({ ...fact,
      embedding: fact.embedding ? Array.from(fact.embedding as Float32Array) : null,
      valid_from: fact.valid_from instanceof Date ? fact.valid_from.toISOString() : fact.valid_from,
      valid_until: fact.valid_until instanceof Date ? fact.valid_until.toISOString() : fact.valid_until })),
    outcome: input.outcome, outcomeSession: input.outcomeSession, terminal: input.terminal ?? true,
    auditContext: input.auditContext,
  };
  const prior = await getWriteRequest(engine, principal, requestId);
  if (prior) {
    if (prior.operation !== 'extract_facts' || prior.source_id !== input.sourceId || prior.source_incarnation !== source.incarnation
      || prior.page_id !== input.pageId || prior.intent?.kind !== 'managed_conversation_facts_page'
      || prior.intent.contentToken !== input.contentToken || prior.intent.expectedRevision !== input.expectedRevision
      || prior.intent.outcome !== input.outcome || prior.intent.terminal !== (input.terminal ?? true)) {
      throw new OperationError('idempotency_conflict', 'This conversation page request ID belongs to another extraction snapshot.');
    }
    intent = prior.intent as ManagedConversationFactsIntent;
  }
  const row = await engine.transaction(tx => admitWriteInTransaction(tx, {
    principal, operation: 'extract_facts', sourceId: input.sourceId, sourceIncarnation: source.incarnation,
    slug: input.slug, pageId: input.pageId, worktreeId: binding?.worktree_id ?? null,
    topologyGeneration: binding?.topology_generation ?? null, requestId, callerIntent: intent, intent, authority,
  }));
  startPersistenceConsumer(engine, { engine: engine.kind } as GBrainConfig);
  const done = await waitForWrite(engine, row, { engine: engine.kind } as GBrainConfig);
  if (done.state !== 'committed') throw new OperationError(done.error_code ?? 'storage_error', done.error_message ?? `Managed conversation fact write ended in ${done.state}.`);
  return { inserted: Number(done.outcome?.inserted ?? 0), deleted: Number(done.outcome?.deleted ?? 0), state: done.state };
}

export async function replaceManagedConversationFacts(engine: BrainEngine, input: {
  sourceId: string; slug: string; pageId: number; revision: string; token: string; facts: NewFact[];
  outcome: 'complete' | 'non_extractable'; terminal?: boolean; auditContext?: string;
}) {
  const source = input.outcome === 'complete' ? TERMINAL_AUDIT_SOURCE : NON_EXTRACTABLE_AUDIT_SOURCE;
  return submitManagedConversationFacts(engine, { sourceId: input.sourceId, slug: input.slug, pageId: input.pageId,
    expectedRevision: input.revision, contentToken: input.token, facts: input.facts, outcome: input.outcome,
    outcomeSession: `${source}:${input.slug}:${input.token}`, terminal: input.terminal, auditContext: input.auditContext });
}
