import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  type AssertionEvidenceRecord,
  type AssertionRecord,
  type ExtractedClaimInput,
} from '../src/core/assertions/assertion-types.ts';
import { createSQLiteLifecycleForgettingStore } from '../src/core/maintenance/lifecycle-forgetting.ts';
import {
  createAssertionPipelineService,
  type AssertionPipelineService,
} from '../src/core/services/assertion-pipeline-service.ts';
import { createLifecycleForgettingService } from '../src/core/services/lifecycle-forgetting-service.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

const NOW = '2026-05-20T12:00:00.000Z';
const LATER = '2026-05-20T13:00:00.000Z';

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (path) rmSync(path, { recursive: true, force: true });
  }
});

describe('lifecycle forgetting service', () => {
  test('assertion supersession records durable lifecycle state and forgetting event', async () => {
    const harness = await createHarness();
    const pipeline = createPipeline(harness);
    const oldClaim = await pipeline.createExtractedClaim(runtimeClaim({
      idSuffix: 'old',
      value_json: { source_of_truth: 'postgres', profile: 'managed' },
      valid_from: '2026-05-20T09:00:00.000Z',
    }));
    const newClaim = await pipeline.createExtractedClaim(runtimeClaim({
      idSuffix: 'new',
      value_json: { source_of_truth: 'postgres', profile: 'managed_or_local_sqlite' },
      valid_from: '2026-05-20T10:00:00.000Z',
    }));

    const oldResolution = await pipeline.resolveExtractedClaim(oldClaim.id);
    await pipeline.resolveExtractedClaim(newClaim.id);

    const state = await harness.store.getLifecycleState('assertion', oldResolution.assertion.id);
    const events = await harness.store.listForgettingEvents({
      entity_type: 'assertion',
      entity_id: oldResolution.assertion.id,
    });

    expect(state).toMatchObject({
      entity_type: 'assertion',
      entity_id: oldResolution.assertion.id,
      lifecycle_state: 'expired',
      reason: 'newer temporal claim superseded prior assertion',
      source_id: 'source:codex-session',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: 'lifecycle_active_to_expired',
      from_lifecycle_state: 'active',
      to_lifecycle_state: 'expired',
    });
    expect(state?.last_transition_event_id).toBe(events[0]?.id);

    await harness.engine.disconnect();
  });

  test('archived assertions restore inside the policy window', async () => {
    const harness = await createHarness();
    await harness.service.transitionEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:archived',
      to_lifecycle_state: 'archived',
      reason: 'archive low-use assertion',
      restore_until: LATER,
      purge_after: '2026-05-21T12:00:00.000Z',
    });

    const restored = await harness.service.restoreEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:archived',
      reason: 'user requested restore',
      now: NOW,
    });

    expect(restored.state).toMatchObject({
      entity_type: 'assertion',
      entity_id: 'assertion:archived',
      lifecycle_state: 'active',
    });
    expect(restored.restore_event).toMatchObject({
      from_lifecycle_state: 'archived',
      to_lifecycle_state: 'active',
      reason: 'user requested restore',
    });

    await harness.engine.disconnect();
  });

  test('restored active lifecycle rows do not immediately re-expire from old created_at', async () => {
    const harness = await createHarness();
    const policy = await harness.store.upsertForgettingPolicy({
      id: 'forgetting-policy:restore-clock',
      scope_id: 'workspace:default',
      entity_type: 'assertion',
      stale_after: 'PT1H',
      now: '2026-05-20T09:00:00.000Z',
    });
    await harness.service.transitionEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:restore-clock',
      to_lifecycle_state: 'archived',
      policy_id: policy.id,
      reason: 'old archived assertion',
      restore_until: '2026-05-20T13:00:00.000Z',
      now: '2026-05-20T09:00:00.000Z',
    });
    await harness.service.restoreEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:restore-clock',
      reason: 'restore old assertion',
      now: '2026-05-20T12:00:00.000Z',
    });

    const sweep = await harness.service.runDueLifecycleTransitions({
      scope_id: 'workspace:default',
      now: '2026-05-20T12:30:00.000Z',
    });
    const state = await harness.store.getLifecycleState('assertion', 'assertion:restore-clock');

    expect(sweep.transitioned).toHaveLength(0);
    expect(state).toMatchObject({
      lifecycle_state: 'active',
      updated_at: '2026-05-20T12:00:00.000Z',
    });

    await harness.engine.disconnect();
  });

  test('restore rejects policies that disable restore for sensitive memory', async () => {
    const harness = await createHarness();
    const policy = await harness.store.upsertForgettingPolicy({
      id: 'forgetting-policy:no-secret-restore',
      scope_id: 'workspace:default',
      entity_type: 'assertion',
      sensitivity_level: 'secret',
      restore_window: 'never',
      now: NOW,
    });
    await harness.service.transitionEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:secret-archived',
      to_lifecycle_state: 'archived',
      policy_id: policy.id,
      sensitivity_level: 'secret',
      reason: 'archive secret assertion',
      restore_until: LATER,
    });

    await expect(harness.service.restoreEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:secret-archived',
      reason: 'user requested restore',
      now: NOW,
    })).rejects.toThrow('restore is not allowed');

    await harness.engine.disconnect();
  });

  test('assertion lifecycle transitions update the native assertion retrieval row', async () => {
    const harness = await createHarness();
    const assertion = canonicalAssertion('assertion:native-lifecycle');
    insertSQLiteAssertion(harness, assertion);

    await harness.service.transitionEntity({
      entity_type: 'assertion',
      entity_id: assertion.id,
      to_lifecycle_state: 'archived',
      reason: 'archive native assertion',
      restore_until: LATER,
    });
    expect(readSQLiteAssertionLifecycle(harness, assertion.id)).toBe('archived');

    await harness.service.restoreEntity({
      entity_type: 'assertion',
      entity_id: assertion.id,
      reason: 'restore native assertion',
      now: NOW,
    });
    expect(readSQLiteAssertionLifecycle(harness, assertion.id)).toBe('active');

    await harness.engine.disconnect();
  });

  test('source chunk lifecycle transitions expire native rows immediately', async () => {
    const harness = await createHarness();
    insertSQLiteSourceChunk(
      harness,
      'source-item:runtime',
      'source-chunk:expires',
      0,
      'expires soon',
      'source:codex-session',
      '2026-05-22T12:00:00.000Z',
    );

    await harness.service.transitionEntity({
      entity_type: 'source_chunk',
      entity_id: 'source-chunk:expires',
      to_lifecycle_state: 'expired',
      reason: 'source retention elapsed',
      now: NOW,
    });
    expect(readSQLiteSourceChunkExpiresAt(harness, 'source-chunk:expires')).toBe(NOW);

    await harness.service.restoreEntity({
      entity_type: 'source_chunk',
      entity_id: 'source-chunk:expires',
      reason: 'restore source chunk',
      to_lifecycle_state: 'active',
      now: NOW,
    });
    expect(readSQLiteSourceChunkExpiresAt(harness, 'source-chunk:expires')).toBeNull();

    await harness.engine.disconnect();
  });

  test('purge planning uses purge eligibility and daily report surfaces restore windows', async () => {
    const harness = await createHarness();
    const eligiblePolicy = await harness.store.upsertForgettingPolicy({
      id: 'forgetting-policy:eligible',
      scope_id: 'workspace:default',
      entity_type: 'assertion',
      sensitivity_level: 'normal',
      purge_eligible: true,
      now: NOW,
    });
    const retainedPolicy = await harness.store.upsertForgettingPolicy({
      id: 'forgetting-policy:retain',
      scope_id: 'workspace:default',
      entity_type: 'assertion',
      purge_eligible: false,
      now: NOW,
    });
    await harness.service.transitionEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:due',
      to_lifecycle_state: 'expired',
      reason: 'retention elapsed',
      policy_id: eligiblePolicy.id,
      sensitivity_level: 'normal',
      purge_after: '2026-05-20T11:00:00.000Z',
    });
    await harness.service.transitionEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:no-policy-default-retained',
      to_lifecycle_state: 'expired',
      reason: 'no explicit purge policy',
      sensitivity_level: 'secret',
      purge_after: '2026-05-20T11:00:00.000Z',
    });
    await harness.service.transitionEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:not-due',
      to_lifecycle_state: 'expired',
      reason: 'restore still open',
      restore_until: LATER,
      purge_after: '2026-05-21T11:00:00.000Z',
    });
    await harness.service.transitionEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:not-eligible',
      to_lifecycle_state: 'expired',
      reason: 'policy retains this assertion',
      policy_id: retainedPolicy.id,
      purge_after: '2026-05-20T11:00:00.000Z',
    });

    const purgePlan = await harness.service.planPurgeCandidates({
      scope_id: 'workspace:default',
      reason: 'daily forgetting review',
      now: NOW,
    });
    const report = await harness.service.buildDailyReport({
      scope_id: 'workspace:default',
      now: NOW,
    });

    expect(purgePlan.items.map((item) => item.entity_id)).toEqual(['assertion:due']);
    expect(purgePlan.items[0]).toMatchObject({
      lifecycle_state: 'expired',
      status: 'planned',
    });
    expect(report.purge_candidate_count).toBe(1);
    expect(report.restore_window_count).toBe(1);
    expect(report.summary_lines).toContain('Purge candidates: 1.');
    expect(report.summary_lines).toContain('Open restore windows: 1.');

    await harness.engine.disconnect();
  });

  test('purge planning stays report-only when there are no eligible candidates', async () => {
    const harness = await createHarness();

    const purgePlan = await harness.service.planPurgeCandidates({
      scope_id: 'workspace:default',
      reason: 'empty daily forgetting review',
      now: NOW,
    });

    expect(purgePlan.plan).toBeNull();
    expect(purgePlan.items).toEqual([]);

    await harness.engine.disconnect();
  });

  test('purge rejects active and not-yet-due lifecycle states even when policy is eligible', async () => {
    const harness = await createHarness();
    const policy = await harness.store.upsertForgettingPolicy({
      id: 'forgetting-policy:due-state-required',
      scope_id: 'workspace:default',
      entity_type: 'assertion',
      purge_eligible: true,
      now: NOW,
    });
    await harness.service.transitionEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:active-purge-denied',
      to_lifecycle_state: 'active',
      policy_id: policy.id,
      reason: 'active assertion',
      now: NOW,
    });
    await harness.service.transitionEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:not-due-purge-denied',
      to_lifecycle_state: 'expired',
      policy_id: policy.id,
      reason: 'expired but restore window still open',
      purge_after: '2026-05-21T12:00:00.000Z',
      now: NOW,
    });

    await expect(harness.service.purgeEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:active-purge-denied',
      reason: 'direct purge should be state gated',
      now: NOW,
    })).rejects.toThrow('memory purge requires expired or archived state');
    await expect(harness.service.purgeEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:not-due-purge-denied',
      reason: 'direct purge should be due gated',
      now: NOW,
    })).rejects.toThrow('memory purge is not due');

    await harness.engine.disconnect();
  });

  test('source item purge clears child source chunk content and degrades affected evidence', async () => {
    const harness = await createHarness();
    ensureSQLiteNativeLifecycleTables(harness);
    const assertion = canonicalAssertion('assertion:source-item-purge');
    const retainedEvidence = {
      ...evidenceRecord('assertion-evidence:source-item-retained', assertion.id, 'source-chunk:retained:0', 0.9),
      source_item_id: 'source-item:retained',
    };
    const purgedEvidence = {
      ...evidenceRecord('assertion-evidence:source-item-purged', assertion.id, 'source-chunk:purge-source:0', 0.7),
      source_item_id: 'source-item:purge-source',
    };
    insertSQLiteAssertion(harness, assertion);
    insertSQLiteSourceChunk(harness, 'source-item:purge-source', 'source-chunk:purge-source:0', 0, 'child raw text');
    insertSQLiteSourceChunk(harness, 'source-item:purge-source', 'source-chunk:purge-source:1', 1, 'second child raw text');
    insertSQLiteSourceChunk(harness, 'source-item:retained', 'source-chunk:retained:0', 0, 'retained source text');
    insertSQLiteEvidence(harness, retainedEvidence);
    insertSQLiteEvidence(harness, purgedEvidence);
    const policy = await harness.store.upsertForgettingPolicy({
      id: 'forgetting-policy:source-item-purge',
      scope_id: 'workspace:default',
      entity_type: 'source_item',
      purge_eligible: true,
      now: NOW,
    });
    await harness.service.transitionEntity({
      entity_type: 'source_item',
      entity_id: 'source-item:purge-source',
      to_lifecycle_state: 'expired',
      policy_id: policy.id,
      reason: 'source item retention elapsed',
      purge_after: '2026-05-20T11:00:00.000Z',
      now: NOW,
    });
    const plan = await createApprovedPurgePlan(harness, 'source_item', 'source-item:purge-source');

    await harness.service.purgeEntity({
      entity_type: 'source_item',
      entity_id: 'source-item:purge-source',
      reason: 'purge source item raw children',
      content_hash: 'sha256:source-item',
      purge_plan_id: plan.id,
      now: NOW,
    });

    expect(readSQLiteSourceItemStatus(harness, 'source-item:purge-source')).toBe('purged');
    expect(readSQLiteSourceChunkText(harness, 'source-chunk:purge-source:0')).toBe('');
    expect(readSQLiteSourceChunkText(harness, 'source-chunk:purge-source:1')).toBe('');
    expect(readSQLiteSourceChunkText(harness, 'source-chunk:retained:0')).toBe('retained source text');
    for (const sourceChunkId of ['source-chunk:purge-source:0', 'source-chunk:purge-source:1']) {
      expect(await harness.store.getLifecycleState('source_chunk', sourceChunkId)).toMatchObject({
        entity_type: 'source_chunk',
        entity_id: sourceChunkId,
        lifecycle_state: 'purged',
        reason: 'purge source item raw children',
      });
      expect(await harness.store.getMemoryTombstone('source_chunk', sourceChunkId)).toMatchObject({
        entity_type: 'source_chunk',
        entity_id: sourceChunkId,
        purge_plan_id: plan.id,
        reason: 'purge source item raw children',
      });
      expect(await harness.store.listForgettingEvents({
        entity_type: 'source_chunk',
        entity_id: sourceChunkId,
      })).toEqual([
        expect.objectContaining({
          event_type: 'lifecycle_initialized',
          to_lifecycle_state: 'purged',
          reason: 'purge source item raw children',
        }),
      ]);
    }
    expect(readSQLiteEvidenceForgettingState(harness, purgedEvidence.id)).toMatchObject({
      revocation_state: 'source_purged',
      forgetting_state: 'purged',
    });
    expect(readSQLiteEvidenceForgettingState(harness, retainedEvidence.id)).toMatchObject({
      revocation_state: 'active',
      forgetting_state: 'retained',
    });
    expect(readSQLiteAssertionSummary(harness, assertion.id)).toMatchObject({
      evidence_count: 1,
      confidence: 0.9,
    });
    expect(await harness.store.getLifecycleState('assertion_evidence', purgedEvidence.id)).toMatchObject({
      entity_type: 'assertion_evidence',
      entity_id: purgedEvidence.id,
      lifecycle_state: 'purged',
      reason: 'purge source item raw children',
    });

    await harness.engine.disconnect();
  });

  test('purge planning and reports stay inside the requested lifecycle scope', async () => {
    const harness = await createHarness();
    await harness.store.upsertForgettingPolicy({
      id: 'forgetting-policy:default-scope-purge',
      scope_id: 'workspace:default',
      entity_type: 'assertion',
      purge_eligible: true,
      now: NOW,
    });
    const tenantPolicy = await harness.store.upsertForgettingPolicy({
      id: 'forgetting-policy:tenant-scope-purge',
      scope_id: 'workspace:tenant-a',
      entity_type: 'assertion',
      purge_eligible: true,
      now: NOW,
    });
    await harness.service.transitionEntity({
      scope_id: 'workspace:tenant-a',
      entity_type: 'assertion',
      entity_id: 'assertion:tenant-only',
      to_lifecycle_state: 'expired',
      policy_id: tenantPolicy.id,
      reason: 'tenant assertion retention elapsed',
      restore_until: LATER,
      purge_after: '2026-05-20T11:00:00.000Z',
      now: NOW,
    });

    const defaultPlan = await harness.service.planPurgeCandidates({
      scope_id: 'workspace:default',
      reason: 'default scope review',
      now: NOW,
    });
    const defaultReport = await harness.service.buildDailyReport({
      scope_id: 'workspace:default',
      now: NOW,
    });
    const tenantPlan = await harness.service.planPurgeCandidates({
      scope_id: 'workspace:tenant-a',
      reason: 'tenant scope review',
      now: NOW,
    });

    expect(defaultPlan.items).toEqual([]);
    expect(defaultReport.purge_candidate_count).toBe(0);
    expect(defaultReport.restore_window_count).toBe(0);
    expect(tenantPlan.items.map((item) => item.entity_id)).toEqual(['assertion:tenant-only']);

    await harness.engine.disconnect();
  });

  test('claim-type policies only apply to matching assertion claims', async () => {
    const harness = await createHarness();
    insertSQLiteAssertion(harness, canonicalAssertion('assertion:code-claim', { claimType: 'code_claim' }));
    insertSQLiteAssertion(harness, canonicalAssertion('assertion:preference-claim', { claimType: 'preference' }));
    await harness.store.upsertForgettingPolicy({
      id: 'forgetting-policy:code-claim-purge',
      scope_id: 'workspace:default',
      entity_type: 'assertion',
      claim_type: 'code_claim',
      purge_eligible: true,
      now: NOW,
    });
    await harness.service.transitionEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:code-claim',
      to_lifecycle_state: 'expired',
      reason: 'code claim stale',
      purge_after: '2026-05-20T11:00:00.000Z',
      now: NOW,
    });
    await harness.service.transitionEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:preference-claim',
      to_lifecycle_state: 'expired',
      reason: 'preference should not match code policy',
      purge_after: '2026-05-20T11:00:00.000Z',
      now: NOW,
    });

    const purgePlan = await harness.service.planPurgeCandidates({
      scope_id: 'workspace:default',
      reason: 'claim type review',
      now: NOW,
    });

    expect(purgePlan.items.map((item) => item.entity_id)).toEqual(['assertion:code-claim']);

    await harness.engine.disconnect();
  });

  test('importance-specific policies only apply to matching lifecycle rows', async () => {
    const harness = await createHarness();
    await harness.store.upsertForgettingPolicy({
      id: 'forgetting-policy:normal-retain',
      scope_id: 'workspace:default',
      entity_type: 'assertion',
      purge_eligible: false,
      now: NOW,
    });
    await harness.store.upsertForgettingPolicy({
      id: 'forgetting-policy:high-importance-purge',
      scope_id: 'workspace:default',
      entity_type: 'assertion',
      importance: 'high',
      purge_eligible: true,
      now: NOW,
    });
    await harness.service.transitionEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:high-importance',
      to_lifecycle_state: 'expired',
      reason: 'important claim retention elapsed',
      importance: 'high',
      purge_after: '2026-05-20T11:00:00.000Z',
      now: NOW,
    });
    await harness.service.transitionEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:normal-importance',
      to_lifecycle_state: 'expired',
      reason: 'normal claim retention elapsed',
      purge_after: '2026-05-20T11:00:00.000Z',
      now: NOW,
    });

    const purgePlan = await harness.service.planPurgeCandidates({
      scope_id: 'workspace:default',
      reason: 'importance review',
      now: NOW,
    });

    expect(purgePlan.items.map((item) => item.entity_id)).toEqual(['assertion:high-importance']);
    expect(await harness.store.getLifecycleState('assertion', 'assertion:high-importance')).toMatchObject({
      importance: 'high',
    });

    await harness.engine.disconnect();
  });

  test('source-kind policy changes purge eligibility even when lifecycle row has no policy id', async () => {
    const harness = await createHarness();
    ensureSQLiteNativeLifecycleTables(harness);
    insertSQLiteSource(harness, 'source:user-direct', 'user_direct');
    insertSQLiteSource(harness, 'source:session', 'codex_session');
    await harness.store.upsertForgettingPolicy({
      id: 'forgetting-policy:user-direct-purge',
      scope_id: 'workspace:default',
      entity_type: 'source_chunk',
      source_kind: 'user_direct',
      purge_eligible: true,
      now: NOW,
    });
    await harness.store.upsertForgettingPolicy({
      id: 'forgetting-policy:session-retain',
      scope_id: 'workspace:default',
      entity_type: 'source_chunk',
      source_kind: 'codex_session',
      purge_eligible: false,
      now: NOW,
    });
    insertSQLiteSourceChunk(harness, 'source-item:user-direct', 'source-chunk:user-direct', 0, 'user direct', 'source:user-direct');
    insertSQLiteSourceChunk(harness, 'source-item:session', 'source-chunk:session', 0, 'session', 'source:session');
    await harness.service.transitionEntity({
      entity_type: 'source_chunk',
      entity_id: 'source-chunk:user-direct',
      to_lifecycle_state: 'expired',
      reason: 'user direct retention elapsed',
      purge_after: '2026-05-20T11:00:00.000Z',
    });
    await harness.service.transitionEntity({
      entity_type: 'source_chunk',
      entity_id: 'source-chunk:session',
      to_lifecycle_state: 'expired',
      reason: 'session retention elapsed',
      purge_after: '2026-05-20T11:00:00.000Z',
    });

    const purgePlan = await harness.service.planPurgeCandidates({
      scope_id: 'workspace:default',
      reason: 'daily forgetting review',
      now: NOW,
    });

    expect(purgePlan.items.map((item) => item.entity_id)).toEqual(['source-chunk:user-direct']);

    await harness.engine.disconnect();
  });

  test('policy transition sweep moves due lifecycle states automatically', async () => {
    const harness = await createHarness();
    const policy = await harness.store.upsertForgettingPolicy({
      id: 'forgetting-policy:auto-stale',
      scope_id: 'workspace:default',
      entity_type: 'assertion',
      stale_after: 'PT1H',
      restore_window: 'PT2H',
      now: '2026-05-20T09:00:00.000Z',
    });
    await harness.service.transitionEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:auto-stale',
      to_lifecycle_state: 'active',
      policy_id: policy.id,
      reason: 'initial lifecycle row',
      now: '2026-05-20T09:00:00.000Z',
    });

    const sweep = await harness.service.runDueLifecycleTransitions({
      scope_id: 'workspace:default',
      now: '2026-05-20T10:30:00.000Z',
    });
    const state = await harness.store.getLifecycleState('assertion', 'assertion:auto-stale');

    expect(sweep.transitioned).toHaveLength(1);
    expect(sweep.transitioned[0].state.lifecycle_state).toBe('stale');
    expect(state).toMatchObject({
      lifecycle_state: 'stale',
      policy_id: policy.id,
      restore_until: '2026-05-20T12:30:00.000Z',
    });

    await harness.engine.disconnect();
  });

  test('policy transition sweep uses the last transition time for sequential lifecycle moves', async () => {
    const harness = await createHarness();
    const policy = await harness.store.upsertForgettingPolicy({
      id: 'forgetting-policy:sequential-transition',
      scope_id: 'workspace:default',
      entity_type: 'assertion',
      stale_after: 'PT1H',
      expire_after: 'PT1H',
      now: '2026-05-20T09:00:00.000Z',
    });
    await harness.service.transitionEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:sequential',
      to_lifecycle_state: 'active',
      policy_id: policy.id,
      reason: 'initial lifecycle row',
      now: '2026-05-20T09:00:00.000Z',
    });
    await harness.service.runDueLifecycleTransitions({
      scope_id: 'workspace:default',
      now: '2026-05-20T10:30:00.000Z',
    });

    const sweep = await harness.service.runDueLifecycleTransitions({
      scope_id: 'workspace:default',
      now: '2026-05-20T10:45:00.000Z',
    });
    const state = await harness.store.getLifecycleState('assertion', 'assertion:sequential');

    expect(sweep.transitioned).toHaveLength(0);
    expect(state).toMatchObject({
      lifecycle_state: 'stale',
      updated_at: '2026-05-20T10:30:00.000Z',
    });

    await harness.engine.disconnect();
  });

  test('task session projection and report lifecycle rows exist while task purge clears operational payloads only', async () => {
    const harness = await createHarness();
    const assertion = canonicalAssertion('assertion:task-derived');
    insertSQLiteAssertion(harness, assertion);
    insertSQLiteOperationalMemory(harness);
    const policy = await harness.store.upsertForgettingPolicy({
      id: 'forgetting-policy:operational-purge',
      scope_id: 'workspace:default',
      entity_type: 'any',
      purge_eligible: true,
      now: NOW,
    });
    const entities = [
      ['projection_target', 'projection:systems/mbrain'],
      ['task_thread', 'task:phase-08'],
      ['task_event', 'task-event:phase-08'],
      ['task_attempt', 'task-attempt:phase-08'],
      ['working_set', 'task:phase-08'],
      ['retrieval_trace', 'retrieval-trace:phase-08'],
      ['handoff', 'handoff:phase-08'],
      ['memory_session', 'memory-session:phase-08'],
      ['report', 'report:daily:phase-08'],
    ] as const;
    for (const [entityType, entityId] of entities) {
      await harness.service.transitionEntity({
        entity_type: entityType,
        entity_id: entityId,
        to_lifecycle_state: 'expired',
        policy_id: policy.id,
        reason: `${entityType} retention elapsed`,
        purge_after: '2026-05-20T11:00:00.000Z',
        now: NOW,
      });
    }

    for (const [entityType, entityId] of entities) {
      expect(await harness.store.getLifecycleState(entityType, entityId)).toMatchObject({
        entity_type: entityType,
        entity_id: entityId,
        lifecycle_state: 'expired',
      });
    }
    for (const [entityType, entityId] of entities.filter(([entityType]) => entityType !== 'projection_target' && entityType !== 'report')) {
      const plan = await createApprovedPurgePlan(harness, entityType, entityId);
      await harness.service.purgeEntity({
        entity_type: entityType,
        entity_id: entityId,
        reason: `${entityType} operational payload purge`,
        content_hash: `sha256:${entityType}`,
        purge_plan_id: plan.id,
        now: NOW,
      });
    }

    expect(readSQLiteAssertionPayload(harness, assertion.id)).toMatchObject({
      normalized_claim: assertion.normalized_claim,
      evidence_count: assertion.evidence_count,
    });
    expect(readSQLiteTaskThread(harness)).toMatchObject({
      goal: '',
      current_summary: '[purged task thread]',
    });
    expect(readSQLiteTaskWorkingSet(harness)).toMatchObject({
      active_paths: '[]',
      active_symbols: '[]',
      blockers: '[]',
      open_questions: '[]',
      next_steps: '[]',
      verification_notes: '[]',
    });
    expect(readSQLiteTaskAttempt(harness)).toMatchObject({
      summary: '[purged task attempt]',
      evidence: '[]',
    });
    expect(readSQLiteRetrievalTrace(harness)).toMatchObject({
      route: '[]',
      source_refs: '[]',
      derived_consulted: '[]',
      verification: '[]',
      outcome: '[purged retrieval trace]',
    });
    expect(readSQLiteHandoff(harness)).toMatchObject({
      resume_summary: '[purged handoff]',
      pending_decisions: '[]',
      next_actions: '[]',
    });
    expect(readSQLiteMemorySession(harness)).toMatchObject({
      status: 'expired',
      actor_ref: null,
      closed_at: NOW,
      expires_at: NOW,
    });

    await harness.engine.disconnect();
  });

  test('projection lifecycle transitions mark the projection for reconcile instead of deleting canonical assertions', async () => {
    const harness = await createHarness();

    await harness.service.transitionEntity({
      entity_type: 'projection_target',
      entity_id: 'projection:systems/mbrain',
      to_lifecycle_state: 'expired',
      reason: 'projection target retained too long',
      now: NOW,
    });

    expect(readSQLiteProjectionReconcileMarks(harness)).toEqual([{
      projection_kind: 'lifecycle_projection',
      projection_slug: 'systems/mbrain',
      projection_ids: '["projection:systems/mbrain"]',
      status: 'pending_reconcile',
      reason: 'projection_drift',
      error_message: 'Lifecycle expired for projection:systems/mbrain: projection target retained too long',
    }]);

    await harness.engine.disconnect();
  });

  test('purge leaves a tombstone and a purged lifecycle state', async () => {
    const harness = await createHarness();
    const assertion = canonicalAssertion('assertion:purge-me');
    insertSQLiteAssertion(harness, assertion);
    const policy = await harness.store.upsertForgettingPolicy({
      id: 'forgetting-policy:assertion-purge',
      scope_id: 'workspace:default',
      entity_type: 'assertion',
      purge_eligible: true,
      now: NOW,
    });
    await harness.service.transitionEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:purge-me',
      to_lifecycle_state: 'expired',
      policy_id: policy.id,
      reason: 'assertion retention elapsed',
      purge_after: '2026-05-20T11:00:00.000Z',
      now: NOW,
    });
    const plan = await createApprovedPurgePlan(harness, 'assertion', 'assertion:purge-me');

    const result = await harness.service.purgeEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:purge-me',
      reason: 'user explicit purge',
      content_hash: 'sha256:before',
      metadata_json: { content_removed: true },
      purge_plan_id: plan.id,
    });
    const tombstone = await harness.store.getMemoryTombstone('assertion', 'assertion:purge-me');
    const purgedPayload = readSQLiteAssertionPayload(harness, 'assertion:purge-me');

    expect(result.state.lifecycle_state).toBe('purged');
    expect(result.event).toMatchObject({
      event_type: 'purged',
      to_lifecycle_state: 'purged',
    });
    expect(tombstone).toMatchObject({
      entity_type: 'assertion',
      entity_id: 'assertion:purge-me',
      purge_event_id: result.event.id,
      content_hash: 'sha256:before',
      metadata_json: { content_removed: true },
    });
    expect(purgedPayload).toMatchObject({
      value_json: '{}',
      normalized_claim: '[purged assertion content removed]',
      authority_summary: '{"purged":true}',
      confidence: 0,
      evidence_count: 0,
    });

    await harness.engine.disconnect();
  });

  test('lifecycle audit events and tombstones are isolated by lifecycle scope', async () => {
    const harness = await createHarness();
    const defaultPolicy = await harness.store.upsertForgettingPolicy({
      id: 'forgetting-policy:default-scoped-tombstone',
      scope_id: 'workspace:default',
      entity_type: 'assertion',
      purge_eligible: true,
      now: NOW,
    });
    const tenantPolicy = await harness.store.upsertForgettingPolicy({
      id: 'forgetting-policy:tenant-scoped-tombstone',
      scope_id: 'workspace:tenant-a',
      entity_type: 'assertion',
      purge_eligible: true,
      now: NOW,
    });
    for (const [scopeId, policyId, contentHash] of [
      ['workspace:default', defaultPolicy.id, 'sha256:default'],
      ['workspace:tenant-a', tenantPolicy.id, 'sha256:tenant'],
    ] as const) {
      await harness.service.transitionEntity({
        scope_id: scopeId,
        entity_type: 'assertion',
        entity_id: 'assertion:shared-id',
        to_lifecycle_state: 'expired',
        policy_id: policyId,
        reason: `${scopeId} retention elapsed`,
        purge_after: '2026-05-20T11:00:00.000Z',
        now: NOW,
      });
      const plan = await createApprovedPurgePlan(harness, 'assertion', 'assertion:shared-id', { scope_id: scopeId });
      await harness.service.purgeEntity({
        scope_id: scopeId,
        entity_type: 'assertion',
        entity_id: 'assertion:shared-id',
        reason: `${scopeId} explicit purge`,
        content_hash: contentHash,
        purge_plan_id: plan.id,
        now: NOW,
      });
    }

    expect(await harness.store.getMemoryTombstone('assertion', 'assertion:shared-id', 'workspace:default'))
      .toMatchObject({ scope_id: 'workspace:default', content_hash: 'sha256:default' });
    expect(await harness.store.getMemoryTombstone('assertion', 'assertion:shared-id', 'workspace:tenant-a'))
      .toMatchObject({ scope_id: 'workspace:tenant-a', content_hash: 'sha256:tenant' });
    expect((await harness.store.listForgettingEvents({
      scope_id: 'workspace:default',
      entity_type: 'assertion',
      entity_id: 'assertion:shared-id',
    })).map((event) => event.scope_id)).toEqual(['workspace:default', 'workspace:default']);
    expect((await harness.store.listForgettingEvents({
      scope_id: 'workspace:tenant-a',
      entity_type: 'assertion',
      entity_id: 'assertion:shared-id',
    })).map((event) => event.scope_id)).toEqual(['workspace:tenant-a', 'workspace:tenant-a']);

    await harness.engine.disconnect();
  });

  test('purge rejects lifecycle states without a purge-eligible policy', async () => {
    const harness = await createHarness();
    const policy = await harness.store.upsertForgettingPolicy({
      id: 'forgetting-policy:retain-assertion',
      scope_id: 'workspace:default',
      entity_type: 'assertion',
      purge_eligible: false,
      now: NOW,
    });
    await harness.service.transitionEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:retain-me',
      to_lifecycle_state: 'expired',
      policy_id: policy.id,
      reason: 'retain by policy',
      purge_after: '2026-05-20T11:00:00.000Z',
      now: NOW,
    });

    await expect(harness.service.purgeEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:retain-me',
      reason: 'direct purge should be gated',
      content_hash: 'sha256:retain',
      now: NOW,
    })).rejects.toThrow('purge is not allowed');

    expect(await harness.store.getMemoryTombstone('assertion', 'assertion:retain-me')).toBeNull();

    await harness.engine.disconnect();
  });

  test('source chunk purge re-resolves affected evidence and stores a source-chunk tombstone', async () => {
    const harness = await createHarness();
    const assertion = canonicalAssertion('assertion:runtime');
    const retainedEvidence = evidenceRecord('assertion-evidence:retained', assertion.id, 'source-chunk:runtime:retained', 0.9);
    const purgedEvidence = evidenceRecord('assertion-evidence:purged', assertion.id, 'source-chunk:runtime:purged', 0.7);
    insertSQLiteAssertion(harness, assertion);
    insertSQLiteSourceChunk(harness, 'source-item:runtime', 'source-chunk:runtime:retained', 0, 'retained chunk text');
    insertSQLiteSourceChunk(
      harness,
      'source-item:runtime',
      'source-chunk:runtime:purged',
      1,
      'purged chunk text',
      'source:codex-session',
      '2026-05-22T12:00:00.000Z',
    );
    insertSQLiteEvidence(harness, retainedEvidence);
    insertSQLiteEvidence(harness, purgedEvidence);
    const policy = await harness.store.upsertForgettingPolicy({
      id: 'forgetting-policy:source-chunk-purge',
      scope_id: 'workspace:default',
      entity_type: 'source_chunk',
      purge_eligible: true,
      now: NOW,
    });
    await harness.service.transitionEntity({
      entity_type: 'source_chunk',
      entity_id: 'source-chunk:runtime:purged',
      to_lifecycle_state: 'expired',
      policy_id: policy.id,
      reason: 'source chunk retention elapsed',
      purge_after: '2026-05-20T11:00:00.000Z',
      now: NOW,
    });
    const plan = await createApprovedPurgePlan(harness, 'source_chunk', 'source-chunk:runtime:purged');

    const result = await harness.service.reResolveSourceChunkPurge({
      source_chunk_id: 'source-chunk:runtime:purged',
      assertion,
      evidence: [retainedEvidence, purgedEvidence],
      reason: 'source chunk retention elapsed',
      content_hash: 'sha256:chunk',
      purge_plan_id: plan.id,
    });
    const state = await harness.store.getLifecycleState('source_chunk', 'source-chunk:runtime:purged');
    const tombstone = await harness.store.getMemoryTombstone('source_chunk', 'source-chunk:runtime:purged');

    expect(state?.lifecycle_state).toBe('purged');
    expect(tombstone).toMatchObject({
      entity_type: 'source_chunk',
      entity_id: 'source-chunk:runtime:purged',
      content_hash: 'sha256:chunk',
    });
    expect(result.evidence.find((entry) => entry.id === purgedEvidence.id)).toMatchObject({
      revocation_state: 'source_purged',
      forgetting_state: 'purged',
    });
    expect(result.assertion).toMatchObject({
      evidence_count: 1,
      confidence: 0.9,
    });
    expect(readSQLiteSourceChunkText(harness, 'source-chunk:runtime:purged')).toBe('');
    expect(readSQLiteSourceChunkExpiresAt(harness, 'source-chunk:runtime:purged')).toBe(NOW);
    expect(readSQLiteEvidenceForgettingState(harness, purgedEvidence.id)).toMatchObject({
      revocation_state: 'source_purged',
      forgetting_state: 'purged',
    });
    expect(await harness.store.getLifecycleState('assertion_evidence', purgedEvidence.id)).toMatchObject({
      entity_type: 'assertion_evidence',
      entity_id: purgedEvidence.id,
      lifecycle_state: 'purged',
      reason: 'source chunk retention elapsed',
    });
    expect(await harness.store.listForgettingEvents({
      entity_type: 'assertion_evidence',
      entity_id: purgedEvidence.id,
    })).toEqual([
      expect.objectContaining({
        event_type: 'lifecycle_initialized',
        to_lifecycle_state: 'purged',
        reason: 'source chunk retention elapsed',
      }),
    ]);
    expect(readSQLiteAssertionSummary(harness, assertion.id)).toMatchObject({
      evidence_count: 1,
      confidence: 0.9,
    });

    await harness.engine.disconnect();
  });

  test('purge requires an approved plan and approved matching item', async () => {
    const harness = await createHarness();
    const policy = await harness.store.upsertForgettingPolicy({
      id: 'forgetting-policy:plan-approval-required',
      scope_id: 'workspace:default',
      entity_type: 'assertion',
      purge_eligible: true,
      now: NOW,
    });
    await harness.service.transitionEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:planned-purge',
      to_lifecycle_state: 'expired',
      policy_id: policy.id,
      reason: 'retention elapsed',
      purge_after: '2026-05-20T11:00:00.000Z',
      now: NOW,
    });
    const draft = await harness.service.planPurgeCandidates({
      scope_id: 'workspace:default',
      reason: 'draft review',
      now: NOW,
    });

    await expect(harness.service.purgeEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:planned-purge',
      reason: 'missing plan should not purge',
      now: NOW,
    })).rejects.toThrow('approved purge plan');
    await expect(harness.service.purgeEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:planned-purge',
      purge_plan_id: draft.plan?.id,
      reason: 'draft plan should not purge',
      now: NOW,
    })).rejects.toThrow('approved purge plan');

    const approved = await harness.store.createPurgePlan({
      id: 'purge-plan:approved',
      scope_id: 'workspace:default',
      status: 'approved',
      reason: 'approved review',
      requested_by: 'test',
      created_at: NOW,
    });
    await harness.store.createPurgePlanItem({
      plan_id: approved.id,
      entity_type: 'assertion',
      entity_id: 'assertion:planned-purge',
      lifecycle_state: 'expired',
      status: 'approved',
      purge_after: '2026-05-20T11:00:00.000Z',
      created_at: NOW,
    });

    await expect(harness.service.purgeEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:planned-purge',
      purge_plan_id: approved.id,
      reason: 'approved plan purge',
      now: NOW,
    })).resolves.toMatchObject({
      state: { lifecycle_state: 'purged' },
    });

    await harness.engine.disconnect();
  });

  test('generic source chunk purge also degrades affected assertion evidence', async () => {
    const harness = await createHarness();
    const assertion = canonicalAssertion('assertion:generic-source-chunk');
    const retainedEvidence = evidenceRecord('assertion-evidence:generic-retained', assertion.id, 'source-chunk:generic:retained', 0.9);
    const purgedEvidence = evidenceRecord('assertion-evidence:generic-purged', assertion.id, 'source-chunk:generic:purged', 0.7);
    insertSQLiteAssertion(harness, assertion);
    insertSQLiteSourceChunk(harness, 'source-item:generic', 'source-chunk:generic:retained', 0, 'retained generic chunk');
    insertSQLiteSourceChunk(harness, 'source-item:generic', 'source-chunk:generic:purged', 1, 'purged generic chunk');
    insertSQLiteEvidence(harness, retainedEvidence);
    insertSQLiteEvidence(harness, purgedEvidence);
    const policy = await harness.store.upsertForgettingPolicy({
      id: 'forgetting-policy:generic-source-chunk-purge',
      scope_id: 'workspace:default',
      entity_type: 'source_chunk',
      purge_eligible: true,
      now: NOW,
    });
    await harness.service.transitionEntity({
      entity_type: 'source_chunk',
      entity_id: 'source-chunk:generic:purged',
      to_lifecycle_state: 'expired',
      policy_id: policy.id,
      reason: 'source chunk retention elapsed',
      purge_after: '2026-05-20T11:00:00.000Z',
      now: NOW,
    });
    const plan = await createApprovedPurgePlan(harness, 'source_chunk', 'source-chunk:generic:purged');

    await harness.service.purgeEntity({
      entity_type: 'source_chunk',
      entity_id: 'source-chunk:generic:purged',
      reason: 'generic source chunk purge',
      content_hash: 'sha256:generic-chunk',
      purge_plan_id: plan.id,
      now: NOW,
    });

    expect(readSQLiteEvidenceForgettingState(harness, purgedEvidence.id)).toMatchObject({
      revocation_state: 'source_purged',
      forgetting_state: 'purged',
    });
    expect(readSQLiteAssertionSummary(harness, assertion.id)).toMatchObject({
      evidence_count: 1,
      confidence: 0.9,
    });
    expect(await harness.store.getLifecycleState('assertion_evidence', purgedEvidence.id)).toMatchObject({
      entity_type: 'assertion_evidence',
      entity_id: purgedEvidence.id,
      lifecycle_state: 'purged',
      reason: 'generic source chunk purge',
    });
    expect(await harness.store.listForgettingEvents({
      scope_id: 'workspace:default',
      entity_type: 'assertion_evidence',
      entity_id: purgedEvidence.id,
    })).toEqual([
      expect.objectContaining({
        event_type: 'lifecycle_initialized',
        to_lifecycle_state: 'purged',
        reason: 'generic source chunk purge',
      }),
    ]);

    await harness.engine.disconnect();
  });

  test('source chunk purge re-resolution honors caller scope policy', async () => {
    const harness = await createHarness();
    const assertion = canonicalAssertion('assertion:scoped-runtime');
    const evidence = evidenceRecord(
      'assertion-evidence:scoped-purge',
      assertion.id,
      'source-chunk:runtime:scoped',
      0.7,
    );
    insertSQLiteAssertion(harness, assertion);
    insertSQLiteSourceChunk(harness, 'source-item:runtime', 'source-chunk:runtime:scoped', 0, 'scoped chunk text');
    insertSQLiteEvidence(harness, evidence);
    const defaultPolicy = await harness.store.upsertForgettingPolicy({
      id: 'forgetting-policy:default-retain-source-chunk',
      scope_id: 'workspace:default',
      entity_type: 'source_chunk',
      purge_eligible: false,
      now: NOW,
    });
    const scopedPolicy = await harness.store.upsertForgettingPolicy({
      id: 'forgetting-policy:tenant-purge-source-chunk',
      scope_id: 'workspace:tenant-a',
      entity_type: 'source_chunk',
      purge_eligible: true,
      now: NOW,
    });
    await harness.service.transitionEntity({
      entity_type: 'source_chunk',
      entity_id: 'source-chunk:runtime:scoped',
      to_lifecycle_state: 'expired',
      policy_id: defaultPolicy.id,
      reason: 'default retain policy',
      purge_after: '2026-05-20T11:00:00.000Z',
      now: NOW,
    });

    await expect(harness.service.reResolveSourceChunkPurge({
      source_chunk_id: 'source-chunk:runtime:scoped',
      assertion,
      evidence: [evidence],
      reason: 'default scope should reject',
      content_hash: 'sha256:scoped',
      now: NOW,
    })).rejects.toThrow('purge is not allowed');

    await harness.service.transitionEntity({
      entity_type: 'source_chunk',
      entity_id: 'source-chunk:runtime:scoped',
      to_lifecycle_state: 'expired',
      policy_id: scopedPolicy.id,
      reason: 'scoped retention elapsed',
      purge_after: '2026-05-20T11:00:00.000Z',
      now: NOW,
    });
    const scopedPlan = await createApprovedPurgePlan(
      harness,
      'source_chunk',
      'source-chunk:runtime:scoped',
      { scope_id: 'workspace:tenant-a' },
    );
    const result = await harness.service.reResolveSourceChunkPurge({
      scope_id: 'workspace:tenant-a',
      source_chunk_id: 'source-chunk:runtime:scoped',
      assertion,
      evidence: [evidence],
      reason: 'scoped source chunk retention elapsed',
      content_hash: 'sha256:scoped',
      purge_plan_id: scopedPlan.id,
      now: NOW,
    });

    expect(result.purge.state.policy_id).toBe(scopedPolicy.id);
    expect(result.purge.state.lifecycle_state).toBe('purged');
    expect(await harness.store.getMemoryTombstone('source_chunk', 'source-chunk:runtime:scoped', 'workspace:tenant-a')).toMatchObject({
      entity_type: 'source_chunk',
      entity_id: 'source-chunk:runtime:scoped',
      content_hash: 'sha256:scoped',
    });

    await harness.engine.disconnect();
  });

  test('purge writes roll back atomically when tombstone creation fails', async () => {
    const harness = await createHarness();
    const policy = await harness.store.upsertForgettingPolicy({
      id: 'forgetting-policy:rollback-purge',
      scope_id: 'workspace:default',
      entity_type: 'assertion',
      purge_eligible: true,
      now: NOW,
    });
    await harness.service.transitionEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:already-purged',
      to_lifecycle_state: 'expired',
      policy_id: policy.id,
      reason: 'initial purge candidate',
      purge_after: '2026-05-20T11:00:00.000Z',
      now: NOW,
    });
    const plan = await createApprovedPurgePlan(harness, 'assertion', 'assertion:already-purged');
    await harness.service.purgeEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:already-purged',
      reason: 'initial purge',
      content_hash: 'sha256:first',
      purge_plan_id: plan.id,
    });

    await expect(harness.service.purgeEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:already-purged',
      reason: 'second purge should fail',
      content_hash: 'sha256:second',
    })).rejects.toThrow('memory is already purged');

    const state = await harness.store.getLifecycleState('assertion', 'assertion:already-purged');
    const events = await harness.store.listForgettingEvents({
      entity_type: 'assertion',
      entity_id: 'assertion:already-purged',
    });
    const tombstone = await harness.store.getMemoryTombstone('assertion', 'assertion:already-purged');

    expect(state?.reason).toBe('initial purge');
    expect(events).toHaveLength(2);
    expect(events.some((event) => event.reason === 'second purge should fail')).toBe(false);
    expect(events.some((event) => event.event_type === 'purged' && event.reason === 'initial purge')).toBe(true);
    expect(tombstone?.content_hash).toBe('sha256:first');

    await harness.engine.disconnect();
  });

});

async function createHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-lifecycle-service-'));
  tempPaths.push(dir);
  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
  await engine.initSchema();
  const store = createSQLiteLifecycleForgettingStore((engine as any).database);
  const service = createLifecycleForgettingService({
    store,
    now: () => NOW,
    transaction: (fn) => engine.transaction(async () => fn(store)),
  });
  return { engine, store, service };
}

function createPipeline(harness: Awaited<ReturnType<typeof createHarness>>): AssertionPipelineService {
  return createAssertionPipelineService({
    now: () => NOW,
    extractor: async () => [],
    lifecycle_store: harness.store,
    lifecycle_transaction: (fn) => harness.engine.transaction(async () => fn(harness.store)),
  });
}

function insertSQLiteAssertion(
  harness: Awaited<ReturnType<typeof createHarness>>,
  assertion: AssertionRecord,
) {
  ensureSQLiteNativeLifecycleTables(harness);
  (harness.engine as any).database.query(`
    INSERT INTO assertions (
      id,
      claim_type,
      target_type,
      target_id,
      target_slug,
      property,
      value_json,
      normalized_claim,
      authority_summary,
      confidence,
      evidence_count,
      authority_state,
      lifecycle_state,
      valid_from,
      valid_until,
      supersedes_assertion_id,
      superseded_by_assertion_id,
      conflict_set_id,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    assertion.id,
    assertion.claim_type,
    assertion.target_type,
    assertion.target_id,
    assertion.target_slug,
    assertion.property,
    JSON.stringify(assertion.value_json),
    assertion.normalized_claim,
    JSON.stringify(assertion.authority_summary),
    assertion.confidence,
    assertion.evidence_count,
    assertion.authority_state,
    assertion.lifecycle_state,
    assertion.valid_from,
    assertion.valid_until,
    assertion.supersedes_assertion_id,
    assertion.superseded_by_assertion_id,
    assertion.conflict_set_id,
    assertion.created_at,
    assertion.updated_at,
  );
}

function insertSQLiteSourceChunk(
  harness: Awaited<ReturnType<typeof createHarness>>,
  sourceItemId: string,
  sourceChunkId: string,
  chunkIndex: number,
  chunkText: string,
  sourceId = 'source:codex-session',
  expiresAt: string | null = null,
) {
  ensureSQLiteNativeLifecycleTables(harness);
  (harness.engine as any).database.query(`
    INSERT OR IGNORE INTO source_items (
      id,
      source_id,
      external_id,
      origin_event,
      title,
      ingested_at,
      content_hash,
      metadata_json,
      raw_copy_mode,
      sensitivity_level,
      ingest_status
    ) VALUES (?, ?, ?, 'session_capture', 'Runtime source item', ?, ?, '{}', 'none', 'normal', 'ready')
  `).run(sourceItemId, sourceId, sourceItemId, NOW, `sha256:${sourceItemId}`);
  (harness.engine as any).database.query(`
    INSERT INTO source_chunks (
      id,
      source_item_id,
      chunk_index,
      chunk_hash,
      chunk_text,
      redacted_text,
      token_count,
      parser_version,
      extractor_version,
      sensitivity_flags,
      prompt_injection_risk,
      secret_risk,
      created_at,
      expires_at
    ) VALUES (?, ?, ?, ?, ?, '', 3, 'test-parser', 'test-extractor', '[]', 'none', 'none', ?, ?)
  `).run(sourceChunkId, sourceItemId, chunkIndex, `sha256:${sourceChunkId}`, chunkText, NOW, expiresAt);
}

function insertSQLiteSource(
  harness: Awaited<ReturnType<typeof createHarness>>,
  sourceId: string,
  sourceKind: string,
) {
  ensureSQLiteNativeLifecycleTables(harness);
  (harness.engine as any).database.query(`
    INSERT OR IGNORE INTO sources (
      id,
      kind,
      display_name,
      consent_state,
      enabled,
      metadata_json,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, 'granted', 1, '{}', ?, ?)
  `).run(sourceId, sourceKind, sourceKind, NOW, NOW);
}

function insertSQLiteEvidence(
  harness: Awaited<ReturnType<typeof createHarness>>,
  evidence: AssertionEvidenceRecord,
) {
  ensureSQLiteNativeLifecycleTables(harness);
  (harness.engine as any).database.query(`
    INSERT INTO assertion_evidence (
      id,
      assertion_id,
      extracted_claim_id,
      source_id,
      source_item_id,
      source_chunk_id,
      session_id,
      task_event_id,
      contribution_type,
      evidence_authority,
      evidence_confidence,
      valid_from,
      valid_until,
      revocation_state,
      forgetting_state,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    evidence.id,
    evidence.assertion_id,
    evidence.extracted_claim_id,
    evidence.source_id,
    evidence.source_item_id,
    evidence.source_chunk_id,
    evidence.session_id,
    evidence.task_event_id,
    evidence.contribution_type,
    evidence.evidence_authority,
    evidence.evidence_confidence,
    evidence.valid_from,
    evidence.valid_until,
    evidence.revocation_state,
    evidence.forgetting_state,
    evidence.created_at,
  );
}

function insertSQLiteOperationalMemory(
  harness: Awaited<ReturnType<typeof createHarness>>,
) {
  ensureSQLiteNativeLifecycleTables(harness);
  const db = (harness.engine as any).database;
  db.query(`
    INSERT INTO task_threads (
      id, scope, title, goal, status, repo_path, branch_name, current_summary, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'task:phase-08',
    'workspace:default',
    'Phase 08',
    'finish lifecycle forgetting',
    'active',
    '/Users/meghendra/Work/mbrain',
    'mbrain-postgres-runtime-spec',
    'operational task summary',
    NOW,
    NOW,
  );
  db.query(`
    INSERT INTO task_working_sets (
      task_id, active_paths, active_symbols, blockers, open_questions, next_steps, verification_notes, last_verified_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'task:phase-08',
    '["src/core/services/lifecycle-forgetting-service.ts"]',
    '["LifecycleForgettingService"]',
    '["tier2 unavailable"]',
    '["transition clock"]',
    '["add tests"]',
    '["focused tests passed before changes"]',
    NOW,
    NOW,
  );
  db.query(`
    INSERT INTO task_attempts (
      id, task_id, summary, outcome, applicability_context, evidence, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'task-attempt:phase-08',
    'task:phase-08',
    'attempt payload that should be cleared',
    'completed',
    '{"phase":"08"}',
    '["command output"]',
    NOW,
  );
  db.query(`
    INSERT INTO retrieval_traces (
      id, task_id, scope, route, source_refs, derived_consulted, verification,
      write_outcome, selected_intent, scope_gate_policy, scope_gate_reason, outcome, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'retrieval-trace:phase-08',
    'task:phase-08',
    'workspace:default',
    '["read_context"]',
    '["source:codex-session"]',
    '["derived:index"]',
    '["verified"]',
    'no_durable_write',
    'implementation',
    'workspace',
    'allowed',
    'trace payload that should be cleared',
    NOW,
  );
  db.query(`
    INSERT INTO memory_sessions (
      id, task_id, status, actor_ref, created_at, closed_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL)
  `).run(
    'memory-session:phase-08',
    'task:phase-08',
    'active',
    'codex:phase-08',
    NOW,
  );
  db.exec(`
    CREATE TABLE IF NOT EXISTS handoffs (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      session_id TEXT,
      resume_summary TEXT NOT NULL,
      pending_decisions TEXT NOT NULL DEFAULT '[]',
      next_actions TEXT NOT NULL DEFAULT '[]',
      linked_assertion_ids TEXT NOT NULL DEFAULT '[]',
      linked_projection_ids TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
  `);
  db.query(`
    INSERT INTO handoffs (
      id, task_id, session_id, resume_summary, pending_decisions, next_actions,
      linked_assertion_ids, linked_projection_ids, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'handoff:phase-08',
    'task:phase-08',
    'memory-session:phase-08',
    'handoff payload that should be cleared',
    '["decide purge"]',
    '["continue"]',
    '["assertion:task-derived"]',
    '["projection:systems/mbrain"]',
    NOW,
  );
}

function ensureSQLiteNativeLifecycleTables(
  harness: Awaited<ReturnType<typeof createHarness>>,
) {
  (harness.engine as any).database.exec(`
    CREATE TABLE IF NOT EXISTS assertions (
      id TEXT PRIMARY KEY,
      claim_type TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      target_slug TEXT,
      property TEXT NOT NULL,
      value_json TEXT NOT NULL,
      normalized_claim TEXT NOT NULL,
      authority_summary TEXT NOT NULL DEFAULT '{}',
      confidence REAL NOT NULL DEFAULT 0,
      evidence_count INTEGER NOT NULL DEFAULT 0,
      authority_state TEXT NOT NULL,
      lifecycle_state TEXT NOT NULL,
      valid_from TEXT,
      valid_until TEXT,
      supersedes_assertion_id TEXT,
      superseded_by_assertion_id TEXT,
      conflict_set_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_items (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      origin_event TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      ingested_at TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      raw_copy_mode TEXT NOT NULL,
      sensitivity_level TEXT NOT NULL DEFAULT 'normal',
      ingest_status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      display_name TEXT NOT NULL,
      consent_state TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_chunks (
      id TEXT PRIMARY KEY,
      source_item_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_hash TEXT NOT NULL,
      chunk_text TEXT NOT NULL,
      redacted_text TEXT NOT NULL DEFAULT '',
      token_count INTEGER NOT NULL DEFAULT 0,
      parser_version TEXT NOT NULL,
      extractor_version TEXT NOT NULL DEFAULT '',
      sensitivity_flags TEXT NOT NULL DEFAULT '[]',
      prompt_injection_risk TEXT NOT NULL,
      secret_risk TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT
    );
    CREATE TABLE IF NOT EXISTS assertion_evidence (
      id TEXT PRIMARY KEY,
      assertion_id TEXT NOT NULL,
      extracted_claim_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_item_id TEXT NOT NULL,
      source_chunk_id TEXT NOT NULL,
      session_id TEXT,
      task_event_id TEXT,
      contribution_type TEXT NOT NULL,
      evidence_authority TEXT NOT NULL,
      evidence_confidence REAL NOT NULL,
      valid_from TEXT,
      valid_until TEXT,
      revocation_state TEXT NOT NULL DEFAULT 'active',
      forgetting_state TEXT NOT NULL DEFAULT 'retained',
      created_at TEXT NOT NULL
    );
  `);
}

function readSQLiteAssertionLifecycle(
  harness: Awaited<ReturnType<typeof createHarness>>,
  assertionId: string,
): string {
  return String((harness.engine as any).database.query(`
    SELECT lifecycle_state FROM assertions WHERE id = ?
  `).get(assertionId).lifecycle_state);
}

function readSQLiteSourceChunkText(
  harness: Awaited<ReturnType<typeof createHarness>>,
  sourceChunkId: string,
): string {
  return String((harness.engine as any).database.query(`
    SELECT chunk_text FROM source_chunks WHERE id = ?
  `).get(sourceChunkId).chunk_text);
}

function readSQLiteSourceChunkExpiresAt(
  harness: Awaited<ReturnType<typeof createHarness>>,
  sourceChunkId: string,
): string | null {
  const row = (harness.engine as any).database.query(`
    SELECT expires_at FROM source_chunks WHERE id = ?
  `).get(sourceChunkId);
  return row.expires_at === null ? null : String(row.expires_at);
}

function readSQLiteSourceItemStatus(
  harness: Awaited<ReturnType<typeof createHarness>>,
  sourceItemId: string,
): string {
  return String((harness.engine as any).database.query(`
    SELECT ingest_status FROM source_items WHERE id = ?
  `).get(sourceItemId).ingest_status);
}

function readSQLiteAssertionPayload(
  harness: Awaited<ReturnType<typeof createHarness>>,
  assertionId: string,
) {
  return (harness.engine as any).database.query(`
    SELECT value_json, normalized_claim, authority_summary, confidence, evidence_count
    FROM assertions
    WHERE id = ?
  `).get(assertionId);
}

function readSQLiteTaskThread(
  harness: Awaited<ReturnType<typeof createHarness>>,
) {
  return (harness.engine as any).database.query(`
    SELECT goal, current_summary FROM task_threads WHERE id = 'task:phase-08'
  `).get();
}

function readSQLiteTaskWorkingSet(
  harness: Awaited<ReturnType<typeof createHarness>>,
) {
  return (harness.engine as any).database.query(`
    SELECT active_paths, active_symbols, blockers, open_questions, next_steps, verification_notes
    FROM task_working_sets
    WHERE task_id = 'task:phase-08'
  `).get();
}

function readSQLiteTaskAttempt(
  harness: Awaited<ReturnType<typeof createHarness>>,
) {
  return (harness.engine as any).database.query(`
    SELECT summary, evidence FROM task_attempts WHERE id = 'task-attempt:phase-08'
  `).get();
}

function readSQLiteRetrievalTrace(
  harness: Awaited<ReturnType<typeof createHarness>>,
) {
  return (harness.engine as any).database.query(`
    SELECT route, source_refs, derived_consulted, verification, outcome
    FROM retrieval_traces
    WHERE id = 'retrieval-trace:phase-08'
  `).get();
}

function readSQLiteHandoff(
  harness: Awaited<ReturnType<typeof createHarness>>,
) {
  return (harness.engine as any).database.query(`
    SELECT resume_summary, pending_decisions, next_actions FROM handoffs WHERE id = 'handoff:phase-08'
  `).get();
}

function readSQLiteMemorySession(
  harness: Awaited<ReturnType<typeof createHarness>>,
) {
  return (harness.engine as any).database.query(`
    SELECT status, actor_ref, closed_at, expires_at FROM memory_sessions WHERE id = 'memory-session:phase-08'
  `).get();
}

function readSQLiteProjectionReconcileMarks(
  harness: Awaited<ReturnType<typeof createHarness>>,
) {
  return (harness.engine as any).database.query(`
    SELECT projection_kind, projection_slug, projection_ids, status, reason, error_message
    FROM canonical_projection_reconcile_marks
    ORDER BY created_at ASC, id ASC
  `).all();
}

function readSQLiteEvidenceForgettingState(
  harness: Awaited<ReturnType<typeof createHarness>>,
  evidenceId: string,
) {
  return (harness.engine as any).database.query(`
    SELECT revocation_state, forgetting_state FROM assertion_evidence WHERE id = ?
  `).get(evidenceId);
}

function readSQLiteAssertionSummary(
  harness: Awaited<ReturnType<typeof createHarness>>,
  assertionId: string,
) {
  return (harness.engine as any).database.query(`
    SELECT confidence, evidence_count FROM assertions WHERE id = ?
  `).get(assertionId);
}

async function createApprovedPurgePlan(
  harness: Awaited<ReturnType<typeof createHarness>>,
  entityType: string,
  entityId: string,
  options: { scope_id?: string; lifecycle_state?: 'expired' | 'archived' } = {},
) {
  const scopeId = options.scope_id ?? 'workspace:default';
  const plan = await harness.store.createPurgePlan({
    id: `purge-plan:${scopeId}:${entityType}:${entityId}:${crypto.randomUUID()}`,
    scope_id: scopeId,
    status: 'approved',
    reason: 'approved lifecycle purge review',
    requested_by: 'test',
    created_at: NOW,
  });
  await harness.store.createPurgePlanItem({
    plan_id: plan.id,
    entity_type: entityType,
    entity_id: entityId,
    lifecycle_state: options.lifecycle_state ?? 'expired',
    status: 'approved',
    purge_after: '2026-05-20T11:00:00.000Z',
    created_at: NOW,
  });
  return plan;
}

function runtimeClaim(input: {
  idSuffix: string;
  value_json: Record<string, unknown>;
  valid_from: string;
}): ExtractedClaimInput {
  return {
    id: `extracted-claim:${input.idSuffix}`,
    source_id: 'source:codex-session',
    source_item_id: `source-item:${input.idSuffix}`,
    source_chunk_id: `source-chunk:${input.idSuffix}:0`,
    extractor_kind: 'llm_structured',
    extractor_version: 'assertion-extractor-v1',
    claim_text: 'MBrain runtime semantic state changed.',
    claim_type: 'architecture_claim',
    target_hint: 'systems/mbrain',
    property_hint: 'runtime.semantic_state',
    value_json: input.value_json,
    confidence: 0.9,
    sensitivity_level: 'normal',
    prompt_injection_flag: false,
    secret_flag: false,
    valid_from: input.valid_from,
  };
}

function canonicalAssertion(id: string, input: { claimType?: AssertionRecord['claim_type'] } = {}): AssertionRecord {
  return {
    id,
    claim_type: input.claimType ?? 'architecture_claim',
    target_type: 'system',
    target_id: 'systems/mbrain',
    target_slug: 'systems/mbrain',
    property: 'runtime.semantic_state',
    value_json: { source_of_truth: 'postgres' },
    normalized_claim: 'systems/mbrain runtime.semantic_state = postgres',
    authority_summary: 'seeded',
    confidence: 0,
    evidence_count: 0,
    authority_state: 'canonical',
    lifecycle_state: 'active',
    valid_from: null,
    valid_until: null,
    supersedes_assertion_id: null,
    superseded_by_assertion_id: null,
    conflict_set_id: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function evidenceRecord(
  id: string,
  assertionId: string,
  sourceChunkId: string,
  confidence: number,
): AssertionEvidenceRecord {
  return {
    id,
    assertion_id: assertionId,
    extracted_claim_id: id.replace('assertion-evidence', 'extracted-claim'),
    source_id: 'source:codex-session',
    source_item_id: 'source-item:runtime',
    source_chunk_id: sourceChunkId,
    session_id: 'session:codex',
    task_event_id: 'task-event:phase-08',
    contribution_type: 'supports',
    evidence_authority: 'session_derived',
    evidence_confidence: confidence,
    valid_from: NOW,
    valid_until: null,
    revocation_state: 'active',
    forgetting_state: 'retained',
    created_at: NOW,
  };
}
