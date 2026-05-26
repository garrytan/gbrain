import {
  canonicalJson,
  stableId,
  type AssertionAuthorityState,
  type AssertionLifecycleState,
  type AssertionRecord,
  type ConflictSetRecord,
  type ExtractedClaim,
  type ExtractedClaimInput,
  type JsonValue,
} from '../assertions/assertion-types.ts';
import {
  type AssertionEvidenceService,
  createAssertionEvidenceService,
} from '../assertions/assertion-evidence.ts';
import {
  type AssertionRetrievalMode,
  planRetrievableAssertions,
  type AssertionRetrievalPlan,
} from '../assertions/assertion-resolution.ts';
import type { LifecycleForgettingStore } from '../maintenance/lifecycle-forgetting.ts';
import { createLifecycleForgettingService } from './lifecycle-forgetting-service.ts';

export interface AssertionPipelineService {
  extractClaimsFromSourceChunk(input: SourceChunkExtractionInput): Promise<ExtractedClaim[]>;
  createExtractedClaim(input: ExtractedClaimInput): Promise<ExtractedClaim>;
  resolveExtractedClaim(id: string): Promise<PipelineResolutionResult>;
  createAssertion(input: AssertionCreateInput): Promise<AssertionRecord>;
  getAssertion(id: string): Promise<AssertionRecord | null>;
  listAssertions(filters?: { include_non_canonical?: boolean }): Promise<AssertionRecord[]>;
  listCanonicalAssertions(filters?: { target_slug?: string }): Promise<AssertionRecord[]>;
  listRetrievableAssertions(filters?: { target_slug?: string; mode?: AssertionRetrievalMode; scope_id?: string }): Promise<AssertionRetrievalPlan[]>;
}

export interface SourceChunkExtractionInput {
  source_id: string;
  source_item_id: string;
  source_chunk_id: string;
  chunk_text: string;
  extractor_kind: string;
  extractor_version: string;
  runner_job_id?: string | null;
  prompt_injection_flag?: boolean;
  secret_flag?: boolean;
  session_id?: string | null;
  task_event_id?: string | null;
}

export interface AssertionPipelineOptions {
  now: () => string;
  extractor: (input: SourceChunkExtractionInput) => Promise<ExtractedClaimInput[]>;
  lifecycle_store?: LifecycleForgettingStore;
  lifecycle_transaction?: <T>(fn: (store: LifecycleForgettingStore) => Promise<T>) => Promise<T>;
}

export interface AssertionCreateInput {
  id?: string;
  claim_type: AssertionRecord['claim_type'];
  target_type: string;
  target_id?: string | null;
  target_slug?: string | null;
  property: string;
  value_json: JsonValue;
  normalized_claim?: string;
  authority_summary?: AssertionRecord['authority_summary'];
  confidence: number;
  evidence_count?: number;
  authority_state: AssertionAuthorityState;
  lifecycle_state: AssertionLifecycleState;
  valid_from?: string | null;
  valid_until?: string | null;
  supersedes_assertion_id?: string | null;
  superseded_by_assertion_id?: string | null;
  conflict_set_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface PipelineResolutionResult {
  kind: 'created_assertion' | 'linked_duplicate' | 'superseded_previous' | 'created_conflict';
  assertion: AssertionRecord;
  evidence: Awaited<ReturnType<AssertionEvidenceService['linkEvidence']>>;
  events: Array<{ event_type: string }>;
  conflict_set?: ConflictSetRecord & { assertion_ids: string[] };
}

export function createAssertionPipelineService(options: AssertionPipelineOptions): AssertionPipelineService {
  const claims = new Map<string, ExtractedClaim>();
  const claimOrigins = new Map<string, { session_id: string | null; task_event_id: string | null }>();
  const assertions = new Map<string, AssertionRecord>();
  const evidenceService = createAssertionEvidenceService({ now: options.now });
  if (options.lifecycle_store && !options.lifecycle_transaction) {
    throw new Error('assertion lifecycle store requires a transaction boundary');
  }
  const lifecycleService = options.lifecycle_store
    ? createLifecycleForgettingService({
      store: options.lifecycle_store,
      now: options.now,
      transaction: options.lifecycle_transaction as NonNullable<AssertionPipelineOptions['lifecycle_transaction']>,
    })
    : null;

  return {
    async extractClaimsFromSourceChunk(input) {
      const extracted = await options.extractor(input);
      const results: ExtractedClaim[] = [];
      for (const claimInput of extracted) {
        results.push(await this.createExtractedClaim({
          ...claimInput,
          source_id: input.source_id,
          source_item_id: input.source_item_id,
          source_chunk_id: input.source_chunk_id,
          extractor_kind: input.extractor_kind,
          extractor_version: input.extractor_version,
          runner_job_id: input.runner_job_id ?? claimInput.runner_job_id ?? null,
          session_id: input.session_id ?? claimInput.session_id ?? null,
          task_event_id: input.task_event_id ?? claimInput.task_event_id ?? null,
          prompt_injection_flag: input.prompt_injection_flag ?? claimInput.prompt_injection_flag,
          secret_flag: input.secret_flag ?? claimInput.secret_flag,
        }));
      }
      return results;
    },
    async createExtractedClaim(input) {
      const claim = extractedClaimFromInput(input, options.now());
      claims.set(claim.id, claim);
      claimOrigins.set(claim.id, {
        session_id: input.session_id ?? null,
        task_event_id: input.task_event_id ?? null,
      });
      return { ...claim };
    },
    async resolveExtractedClaim(id) {
      const claim = claims.get(id);
      if (!claim) throw new Error(`extracted claim not found: ${id}`);
      const target = resolveTarget(claim.target_hint);
      const matching = [...assertions.values()].filter((assertion) => (
        assertion.target_type === target.target_type
        && assertion.target_slug === target.target_slug
        && assertion.property === claim.property_hint
        && assertion.lifecycle_state !== 'expired'
        && assertion.lifecycle_state !== 'archived'
        && assertion.lifecycle_state !== 'purged'
      ));
      const duplicate = matching.find((assertion) => canonicalJson(assertion.value_json) === canonicalJson(claim.value_json));
      if (duplicate) {
        const evidence = await evidenceService.linkEvidence(evidenceInputFor(duplicate.id, claim, claimOrigins.get(claim.id)));
        const summary = await evidenceService.recomputeAssertionEvidenceSummary(duplicate.id);
        const updated = {
          ...duplicate,
          evidence_count: summary.evidence_count,
          confidence: summary.confidence,
          authority_summary: summary.authority_summary,
          updated_at: options.now(),
        };
        assertions.set(updated.id, updated);
        return {
          kind: 'linked_duplicate',
          assertion: { ...updated },
          evidence,
          events: [{ event_type: 'duplicate_linked' }],
        };
      }

      const superseded = matching.find((assertion) => claim.valid_from && assertion.valid_from
        && new Date(claim.valid_from).getTime() > new Date(assertion.valid_from).getTime());
      const conflict = !superseded && matching.length > 0;
      const conflictSetId = conflict ? stableId('conflict-set', target.target_type, target.target_slug ?? '', claim.property_hint) : null;
      const assertion = await this.createAssertion({
        claim_type: claim.claim_type,
        target_type: target.target_type,
        target_id: target.target_id,
        target_slug: target.target_slug,
        property: claim.property_hint,
        value_json: claim.value_json,
        confidence: claim.confidence,
        authority_state: conflict ? 'conflicted' : 'canonical',
        lifecycle_state: 'active',
        valid_from: claim.valid_from,
        valid_until: claim.valid_until,
        supersedes_assertion_id: superseded?.id ?? null,
        conflict_set_id: conflictSetId,
      });
      const evidence = await evidenceService.linkEvidence(evidenceInputFor(assertion.id, claim, claimOrigins.get(claim.id)));
      const summary = await evidenceService.recomputeAssertionEvidenceSummary(assertion.id);
      const hydrated = {
        ...assertion,
        evidence_count: summary.evidence_count,
        confidence: summary.confidence,
        authority_summary: summary.authority_summary,
      };
      assertions.set(hydrated.id, hydrated);

      if (superseded) {
        assertions.set(superseded.id, {
          ...superseded,
          lifecycle_state: 'expired',
          superseded_by_assertion_id: hydrated.id,
          updated_at: options.now(),
        });
        await lifecycleService?.transitionEntity({
          entity_type: 'assertion',
          entity_id: superseded.id,
          from_lifecycle_state: superseded.lifecycle_state,
          to_lifecycle_state: 'expired',
          reason: 'newer temporal claim superseded prior assertion',
          source_id: claim.source_id,
          sensitivity_level: claim.sensitivity_level,
          source_refs_json: [
            `extracted-claim:${claim.id}`,
            `source-chunk:${claim.source_chunk_id}`,
            `superseded-by:${hydrated.id}`,
          ],
          actor: 'mbrain:assertion_pipeline',
          job_id: claim.runner_job_id,
        });
      }
      if (conflict && conflictSetId) {
        for (const existing of matching) {
          assertions.set(existing.id, {
            ...existing,
            authority_state: 'conflicted',
            conflict_set_id: conflictSetId,
            updated_at: options.now(),
          });
        }
      }

      return {
        kind: conflict ? 'created_conflict' : superseded ? 'superseded_previous' : 'created_assertion',
        assertion: { ...assertions.get(hydrated.id)! },
        evidence,
        events: [
          { event_type: conflict ? 'conflict_created' : superseded ? 'assertion_superseded_previous' : 'assertion_created' },
          ...(superseded ? [{ event_type: 'assertion_lifecycle_transition' }] : []),
        ],
        ...(conflict && conflictSetId ? {
          conflict_set: {
            id: conflictSetId,
            target_type: target.target_type,
            target_id: target.target_id ?? '',
            property: claim.property_hint,
            status: 'open',
            created_at: options.now(),
            updated_at: options.now(),
            assertion_ids: [...matching.map((entry) => entry.id), hydrated.id],
          },
        } : {}),
      };
    },
    async createAssertion(input) {
      const now = options.now();
      const assertion: AssertionRecord = {
        id: input.id ?? stableId('assertion', input.target_type, input.target_slug ?? input.target_id ?? '', input.property, canonicalJson(input.value_json), input.valid_from ?? ''),
        claim_type: input.claim_type,
        target_type: input.target_type,
        target_id: input.target_id ?? input.target_slug ?? null,
        target_slug: input.target_slug ?? null,
        property: input.property,
        value_json: input.value_json,
        normalized_claim: input.normalized_claim ?? `${input.target_slug ?? input.target_id ?? input.target_type} ${input.property} = ${canonicalJson(input.value_json)}`,
        authority_summary: input.authority_summary ?? 'seeded',
        confidence: input.confidence,
        evidence_count: input.evidence_count ?? 0,
        authority_state: input.authority_state,
        lifecycle_state: input.lifecycle_state,
        valid_from: input.valid_from ?? null,
        valid_until: input.valid_until ?? null,
        supersedes_assertion_id: input.supersedes_assertion_id ?? null,
        superseded_by_assertion_id: input.superseded_by_assertion_id ?? null,
        conflict_set_id: input.conflict_set_id ?? null,
        created_at: input.created_at ?? now,
        updated_at: input.updated_at ?? now,
      };
      assertions.set(assertion.id, assertion);
      await evidenceService.createAssertion(assertion);
      return { ...assertion };
    },
    async getAssertion(id) {
      const assertion = assertions.get(id);
      return assertion ? { ...assertion } : null;
    },
    async listAssertions(filters = {}) {
      const all = [...assertions.values()];
      return (filters.include_non_canonical ? all : canonicalOnly(all)).map((assertion) => ({ ...assertion }));
    },
    async listCanonicalAssertions(filters = {}) {
      return canonicalOnly([...assertions.values()])
        .filter((assertion) => !filters.target_slug || assertion.target_slug === filters.target_slug)
        .map((assertion) => ({ ...assertion }));
    },
    async listRetrievableAssertions(filters = {}) {
      const planned = planRetrievableAssertions([...assertions.values()], {
        mode: filters.mode ?? 'default',
      })
        .filter((entry) => !filters.target_slug || entry.assertion.target_slug === filters.target_slug)
        .map((entry) => ({
          ...entry,
          assertion: { ...entry.assertion },
          reason_codes: [...entry.reason_codes],
        }));
      if (!options.lifecycle_store || filters.mode !== 'audit') return planned;
      const decorated: AssertionRetrievalPlan[] = [];
      const scopeId = filters.scope_id ?? 'workspace:default';
      for (const entry of planned) {
        const [events, tombstone] = await Promise.all([
          options.lifecycle_store.listForgettingEvents({
            scope_id: scopeId,
            entity_type: 'assertion',
            entity_id: entry.assertion.id,
          }),
          options.lifecycle_store.getMemoryTombstone('assertion', entry.assertion.id, scopeId),
        ]);
        decorated.push({
          ...entry,
          lifecycle_events: events.map((event) => ({
            id: event.id,
            event_type: event.event_type,
            from_lifecycle_state: event.from_lifecycle_state,
            to_lifecycle_state: event.to_lifecycle_state,
            reason: event.reason,
            created_at: event.created_at,
          })),
          tombstone: tombstone ? {
            id: tombstone.id,
            reason: tombstone.reason,
            content_hash: tombstone.content_hash,
            created_at: tombstone.created_at,
          } : null,
        });
      }
      return decorated;
    },
  };
}

function extractedClaimFromInput(input: ExtractedClaimInput, now: string): ExtractedClaim {
  return {
    id: input.id ?? stableId('extracted-claim', input.source_chunk_id ?? '', input.claim_type, input.target_hint, input.property_hint, canonicalJson(input.value_json)),
    source_id: input.source_id ?? '',
    source_item_id: input.source_item_id ?? '',
    source_chunk_id: input.source_chunk_id ?? '',
    extractor_kind: input.extractor_kind ?? 'unknown',
    extractor_version: input.extractor_version ?? 'unknown',
    runner_job_id: input.runner_job_id ?? null,
    claim_text: input.claim_text,
    claim_type: input.claim_type,
    target_hint: input.target_hint,
    property_hint: input.property_hint,
    value_json: input.value_json,
    confidence: input.confidence,
    sensitivity_level: input.sensitivity_level ?? 'normal',
    prompt_injection_flag: input.prompt_injection_flag ?? false,
    secret_flag: input.secret_flag ?? false,
    status: 'pending_resolution',
    valid_from: input.valid_from ?? null,
    valid_until: input.valid_until ?? null,
    created_at: now,
  };
}

function evidenceInputFor(
  assertionId: string,
  claim: ExtractedClaim,
  origin: { session_id: string | null; task_event_id: string | null } | undefined,
) {
  return {
    assertion_id: assertionId,
    extracted_claim_id: claim.id,
    source_id: claim.source_id,
    source_item_id: claim.source_item_id,
    source_chunk_id: claim.source_chunk_id,
    session_id: origin?.session_id ?? null,
    task_event_id: origin?.task_event_id ?? null,
    contribution_type: 'supports' as const,
    evidence_authority: claim.source_id.includes('user-direct') || claim.source_id.includes('user_direct') ? 'user_direct' : 'session_derived',
    evidence_confidence: claim.confidence,
    valid_from: claim.valid_from,
    valid_until: claim.valid_until,
  };
}

function resolveTarget(targetHint: string): { target_type: string; target_id: string | null; target_slug: string | null } {
  if (targetHint.startsWith('systems/')) {
    return { target_type: 'system', target_id: targetHint, target_slug: targetHint };
  }
  if (targetHint.startsWith('brain/')) {
    return { target_type: 'page', target_id: targetHint, target_slug: targetHint };
  }
  return { target_type: 'entity', target_id: targetHint, target_slug: null };
}

function canonicalOnly(assertions: AssertionRecord[]): AssertionRecord[] {
  return assertions.filter((assertion) => (
    assertion.authority_state === 'canonical'
    && assertion.lifecycle_state === 'active'
  ));
}
