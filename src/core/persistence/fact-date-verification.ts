/** Local operator attestations for existing event dates. A receipt never publishes or changes a fact. */
import { readDateVerificationIncarnation, readFactDatePin, readOriginalDateExcerpt, readRevocableDateVerification } from '../engine-sql/fact-date-verification.ts';
import { FACT_DATE_REVOCATION, FACT_DATE_VERIFICATION, factDateProof, matchesDatedExcerpt, type FactDateProof } from '../facts/fact-date-proof.ts';
import { opError, type OperationContext } from '../ops/contract.ts';
import { submissionAuthority } from './authority.ts';
import type { PreparedMutation } from './coordinator.ts';
import { requireUuid } from './digest.ts';
import { admitWrite } from './journal.ts';
import type { Principal, WriteAuthority, WriteRequest } from './model.ts';
import { getWorktreeBinding } from './ownership.ts';
import { PreadmitBrainChanged } from './preadmit-cache.ts';
import { assertPersistenceAccepting, waitForWrite, writeResponse } from './service.ts';

export const factDateReceiptSlug = (requestId: string) => `repairs/fact-date-verification/${requestId}`;
interface DateReceiptApproval { brainId: string; principal: Principal }

function parseEvidence(input: unknown): FactDateProof {
  const result = factDateProof.safeParse(input);
  if (!result.success) throw opError('invalid_params', 'Malformed proof for the existing event date.',
    'Provide the fact digest, current UTC day and exact excerpt from its retained original evidence.');
  return result.data;
}

function forbidden() {
  return opError('permission_denied', 'Fact date verification requires source-wide write authority from a local CLI operator.',
    'Run the original-evidence verification on the brain host for one source.');
}

/** Synthetic journal slugs cannot stand in for actual page-path grants. */
export function requireSourceWideDateAuthority(authority: WriteAuthority): void {
  if (authority.remote !== false || authority.principal.kind !== 'local_cli' ||
      authority.slugPrefixes !== null || authority.restrictedNamespace) throw forbidden();
}

function changed() {
  return opError('revision_conflict', 'The fact or original dated excerpt no longer matches the reviewed evidence.',
    'Read the current fact and retained original before reviewing the date again.');
}

/** The local operator's call attests the excerpt dates this fact. The server verifies the binding and content. */
export async function publishFactDateVerification(ctx: OperationContext, sourceId: string, requestId: string,
  reviewed: unknown, approval?: DateReceiptApproval) {
  const proof = parseEvidence(reviewed);
  return publishDateReceipt(ctx, sourceId, requestId, FACT_DATE_VERIFICATION, proof.source_incarnation, { proof }, approval);
}

/** The original receipt remains queryable. Only its eligibility as evidence is revoked. */
export function revokeFactDateVerification(ctx: OperationContext, sourceId: string, requestId: string,
  incarnation: string, receiptId: string, approval?: DateReceiptApproval) {
  return publishDateReceipt(ctx, sourceId, requestId, FACT_DATE_REVOCATION, requireUuid(incarnation),
    { revoked_receipt_id: requireUuid(receiptId) }, approval);
}

async function publishDateReceipt(ctx: OperationContext, sourceId: string, requestId: string,
  operation: typeof FACT_DATE_VERIFICATION | typeof FACT_DATE_REVOCATION, expectedIncarnation: string,
  intent: Record<string, unknown>, approval?: DateReceiptApproval) {
  if (ctx.remote !== false || ctx.auth || ctx.dryRun || ctx.sourceId !== sourceId) throw forbidden();
  const stableId = requireUuid(requestId);
  const { engine, config } = ctx;
  assertPersistenceAccepting(engine);
  const incarnation = await readDateVerificationIncarnation(engine, sourceId);
  if (incarnation !== expectedIncarnation) throw changed();
  const binding = await getWorktreeBinding(engine, sourceId);
  const slug = factDateReceiptSlug(stableId);
  const authority = await submissionAuthority(ctx, operation, sourceId, incarnation, slug);
  requireSourceWideDateAuthority(authority);
  const principal = authority.principal;
  if (approval && (principal.id !== approval.principal.id || principal.kind !== approval.principal.kind)) {
    throw opError('revision_conflict', 'The local writer no longer matches the date evidence preview.',
      'Preview again using the current registered local CLI writer.');
  }
  const request = await admitWrite(engine, { principal, operation, sourceId,
    sourceIncarnation: incarnation, slug, requestId: stableId, callerIntent: intent, intent, authority, brainId: approval?.brainId,
    worktreeId: binding?.worktree_id ?? null, topologyGeneration: binding?.topology_generation ?? null }).catch(error => {
    if (error instanceof PreadmitBrainChanged) throw opError('revision_conflict', 'The brain no longer matches the date evidence preview.',
      'Verify the connection and preview again.');
    throw error;
  });
  const finished = await waitForWrite(engine, request, config, 60_000);
  writeResponse(finished);
  return finished;
}

export function prepareFactDateVerification(request: WriteRequest): PreparedMutation {
  requireSourceWideDateAuthority(request.authority);
  if (request.principal_kind !== 'local_cli' || request.principal_id !== request.authority.principal.id || request.page_id !== null ||
      request.slug !== factDateReceiptSlug(request.request_id)) throw forbidden();
  const revoking = request.operation === FACT_DATE_REVOCATION;
  const rawId = request.intent?.revoked_receipt_id;
  const receiptId = revoking ? requireUuid(typeof rawId === 'string' ? rawId : '') : null;
  const proof = revoking ? null : parseEvidence(request.intent?.proof);
  return {
    observedRevision: null,
    async apply(tx) {
      const live = await tx.readLocalWriterRow(request.principal_id, { lock: true });
      if (live?.grant_ceiling.slugPrefixes !== null) throw forbidden();
      const incarnation = await readDateVerificationIncarnation(tx, request.source_id, true);
      if (incarnation !== request.source_incarnation ||
          await tx.readPageSnapshot(request.slug, { sourceId: request.source_id, includeDeleted: true })) throw changed();
      if (receiptId) {
        await requireRevocableFactDateReceipt(tx, request.source_id, incarnation, receiptId);
        return { revoked_receipt_id: receiptId };
      }
      if (!proof || proof.source_incarnation !== incarnation) throw changed();
      const excerpt = await readOriginalDateExcerpt(tx, request.source_id, proof.original_page_id,
        proof.original_revision, proof.excerpt_start, proof.excerpt_length);
      if (!matchesDatedExcerpt(proof, excerpt)) throw changed();
      const fact = await readFactDatePin(tx, request.source_id, proof.fact_id, true);
      if (fact?.utc_day !== proof.utc_day || fact.fact_digest !== proof.fact_digest) throw changed();
      return { verified_event_date: proof.utc_day, proof };
    },
  };
}

export async function requireRevocableFactDateReceipt(engine: OperationContext['engine'], sourceId: string,
  incarnation: string, receiptId: string) {
  const verification = await readRevocableDateVerification(engine, sourceId, incarnation, receiptId);
  const reviewed = factDateProof.safeParse(verification?.proof);
  if (!reviewed.success || reviewed.data.source_incarnation !== incarnation) throw opError('revision_conflict',
    'No committed verification receipt matches this source and incarnation.',
    'Read the verification receipt before revoking it.');
  return reviewed.data;
}
