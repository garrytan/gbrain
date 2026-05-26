import { describe, expect, test } from 'bun:test';
import {
  createGovernedCanonicalWriteService,
  explainCanonicalWritePolicy,
  type GovernedCanonicalWriteInput,
  type GovernedCanonicalWriteServiceOptions,
  type ProjectionMutationInput,
} from '../src/core/services/governed-canonical-write-service.ts';

const SOURCE_REF = 'Source: User, direct message, 2026-05-20 10:15 KST';

describe('governed canonical write service immediate projections', () => {
  test('user_direct decision writes the project decision timeline immediately with full lineage', async () => {
    const harness = createHarness();

    const result = await harness.service.applyCanonicalWrite({
      claim: {
        id: 'extracted-claim:decision-runtime',
        source_kind: 'user_direct',
        claim_type: 'decision',
        target_type: 'project',
        target_id: 'project:mbrain',
        target_slug: 'projects/mbrain',
        property: 'decision.timeline',
        value_json: {
          decision: 'Markdown is a governed projection of Postgres canonical memory.',
        },
        confidence: 1,
        sensitivity: 'normal',
        prompt_injection_flag: false,
        secret_flag: false,
      },
      evidence: {
        id: 'assertion-evidence:decision-runtime',
        source_id: 'source:user-direct',
        source_item_id: 'source-item:turn-1',
        source_chunk_id: 'source-chunk:turn-1',
      },
      source_refs: [SOURCE_REF],
      conflict_state: { kind: 'none' },
      assertion_state: 'canonical',
      user_override_policy: 'none',
      session_write_grant: activeWriteGrant(['auto_canonical']),
      realm: 'project:mbrain',
      runner_trust: 'trusted_interactive',
      actor: {
        actor: 'codex',
        session_id: 'session:phase-04-red',
        job_id: 'job:projection-red',
        runner_id: 'runner:codex',
      },
    });

    expect(result).toMatchObject({
      status: 'applied',
      policy: {
        decision: 'auto_canonical',
        explanation: 'user_direct decision is source-backed and safe for immediate canonical projection',
      },
      assertion_ids: ['assertion:decision-runtime'],
      assertion_evidence_ids: ['assertion-evidence:decision-runtime'],
      extracted_claim_ids: ['extracted-claim:decision-runtime'],
      projection_status: 'applied',
    });

    expect(harness.dbMutations).toHaveLength(1);
    expect(harness.projectionMutations).toHaveLength(1);
    expect(harness.projectionMutations[0]).toMatchObject({
      projection_target: {
        kind: 'project_decision_timeline',
        slug: 'projects/mbrain/decisions',
      },
      mutation_kind: 'append_decision_timeline',
      assertion_ids: ['assertion:decision-runtime'],
      assertion_evidence_ids: ['assertion-evidence:decision-runtime'],
      extracted_claim_ids: ['extracted-claim:decision-runtime'],
      source_refs: [SOURCE_REF],
    });
    expect(harness.projectionMutations[0].content).toContain(
      'Markdown is a governed projection of Postgres canonical memory.',
    );

    expect(harness.ledgerEvents).toHaveLength(1);
    expect(harness.ledgerEvents[0]).toMatchObject({
      operation: 'governed_canonical_write',
      target_kind: 'page',
      target_id: 'projects/mbrain/decisions',
      source_refs: [SOURCE_REF],
      result: 'applied',
      expected_target_snapshot_hash: 'dbhash:before:projects/mbrain',
      current_target_snapshot_hash: 'dbhash:after:projects/mbrain',
      metadata: {
        assertion_ids: ['assertion:decision-runtime'],
        assertion_evidence_ids: ['assertion-evidence:decision-runtime'],
        extracted_claim_ids: ['extracted-claim:decision-runtime'],
        projection_ids: ['projection:project-decisions'],
        policy_decision: 'auto_canonical',
        policy_explanation: 'user_direct decision is source-backed and safe for immediate canonical projection',
        before_db_hash: 'dbhash:before:projects/mbrain',
        after_db_hash: 'dbhash:after:projects/mbrain',
        before_markdown_hash: 'mdhash:before:projects/mbrain/decisions',
        after_markdown_hash: 'mdhash:after:projects/mbrain/decisions',
        actor: 'codex',
        session_id: 'session:phase-04-red',
        job_id: 'job:projection-red',
        runner_id: 'runner:codex',
      },
    });
  });

  test('project system compiled-truth projection records lineage on every projection mutation', async () => {
    const harness = createHarness();

    const result = await harness.service.applyCanonicalWrite({
      claim: {
        id: 'extracted-claim:system-runtime',
        source_kind: 'user_direct',
        claim_type: 'architecture_claim',
        target_type: 'system',
        target_id: 'system:mbrain-runtime',
        target_slug: 'systems/mbrain',
        property: 'compiled_truth.runtime_profile',
        value_json: {
          text: 'MBrain has truthful runtime profiles for managed Postgres and local SQLite.',
        },
        confidence: 1,
        sensitivity: 'normal',
        prompt_injection_flag: false,
        secret_flag: false,
      },
      evidence: {
        id: 'assertion-evidence:system-runtime',
        source_id: 'source:user-direct',
        source_item_id: 'source-item:turn-2',
        source_chunk_id: 'source-chunk:turn-2',
      },
      source_refs: [SOURCE_REF],
      conflict_state: { kind: 'none' },
      assertion_state: 'canonical',
      user_override_policy: 'none',
      session_write_grant: activeWriteGrant(['auto_canonical']),
      realm: 'project:mbrain',
      runner_trust: 'trusted_interactive',
      actor: {
        actor: 'codex',
        session_id: 'session:phase-04-red',
        job_id: 'job:projection-red',
        runner_id: 'runner:codex',
      },
    });

    expect(result.projection_status).toBe('applied');
    expect(harness.projectionMutations).toHaveLength(1);
    expect(harness.projectionMutations.every((mutation) => (
      mutation.assertion_ids.length > 0
      && mutation.assertion_evidence_ids.length > 0
      && mutation.extracted_claim_ids.length > 0
      && mutation.source_refs.length > 0
    ))).toBe(true);
    expect(harness.projectionMutations[0]).toMatchObject({
      projection_target: {
        kind: 'system_compiled_truth',
        slug: 'systems/mbrain',
      },
      mutation_kind: 'upsert_compiled_truth',
      assertion_ids: ['assertion:system-runtime'],
      assertion_evidence_ids: ['assertion-evidence:system-runtime'],
      extracted_claim_ids: ['extracted-claim:system-runtime'],
      source_refs: [SOURCE_REF],
    });

    expect(harness.ledgerEvents[0].metadata).toMatchObject({
      target_projection_ids: ['projection:system-compiled-truth'],
      assertion_ids: ['assertion:system-runtime'],
      assertion_evidence_ids: ['assertion-evidence:system-runtime'],
      extracted_claim_ids: ['extracted-claim:system-runtime'],
      source_refs: [SOURCE_REF],
    });
  });

  test('failed markdown projection after DB mutation marks reconcile state and ledgers failed markdown metadata', async () => {
    const harness = createHarness({
      writeProjection: async (mutation) => {
        harness.projectionMutations.push(mutation);
        throw new Error('simulated markdown projection failure');
      },
    });

    const result = await harness.service.applyCanonicalWrite({
      claim: {
        id: 'extracted-claim:decision-failed-markdown',
        source_kind: 'user_direct',
        claim_type: 'decision',
        target_type: 'project',
        target_id: 'project:mbrain',
        target_slug: 'projects/mbrain',
        property: 'decision.timeline',
        value_json: { decision: 'Keep Postgres canonical even when Markdown projection fails.' },
        confidence: 1,
        sensitivity: 'normal',
        prompt_injection_flag: false,
        secret_flag: false,
      },
      evidence: {
        id: 'assertion-evidence:decision-failed-markdown',
        source_id: 'source:user-direct',
        source_item_id: 'source-item:turn-3',
        source_chunk_id: 'source-chunk:turn-3',
      },
      source_refs: [SOURCE_REF],
      conflict_state: { kind: 'none' },
      assertion_state: 'canonical',
      user_override_policy: 'none',
      session_write_grant: activeWriteGrant(['auto_canonical']),
      realm: 'project:mbrain',
      runner_trust: 'trusted_interactive',
      actor: {
        actor: 'codex',
        session_id: 'session:phase-04-red-failure',
        job_id: 'job:projection-red-failure',
        runner_id: 'runner:codex',
      },
    });

    expect(result).toMatchObject({
      status: 'pending_reconcile',
      projection_status: 'failed_markdown',
      assertion_ids: ['assertion:decision-failed-markdown'],
      assertion_evidence_ids: ['assertion-evidence:decision-failed-markdown'],
      extracted_claim_ids: ['extracted-claim:decision-failed-markdown'],
      error: {
        code: 'failed_markdown',
        message: 'simulated markdown projection failure',
      },
    });
    expect(harness.dbMutations).toHaveLength(1);
    expect(harness.reconcileMarks).toEqual([{
      assertion_ids: ['assertion:decision-failed-markdown'],
      projection_ids: ['projection:project-decisions'],
      projection_kind: 'project_decision_timeline',
      projection_slug: 'projects/mbrain/decisions',
      status: 'pending_reconcile',
      reason: 'failed_markdown',
      error: 'simulated markdown projection failure',
    }]);
    expect(harness.ledgerEvents).toHaveLength(1);
    expect(harness.ledgerEvents[0]).toMatchObject({
      result: 'failed',
      source_refs: [SOURCE_REF],
      expected_target_snapshot_hash: 'dbhash:before:projects/mbrain',
      current_target_snapshot_hash: 'dbhash:after:projects/mbrain',
      metadata: {
        status: 'pending_reconcile',
        projection_status: 'failed_markdown',
        policy_decision: 'auto_canonical',
        policy_explanation: 'user_direct decision is source-backed and safe for immediate canonical projection',
        before_db_hash: 'dbhash:before:projects/mbrain',
        after_db_hash: 'dbhash:after:projects/mbrain',
        before_markdown_hash: 'mdhash:before:projects/mbrain/decisions',
        after_markdown_hash: null,
        assertion_ids: ['assertion:decision-failed-markdown'],
        assertion_evidence_ids: ['assertion-evidence:decision-failed-markdown'],
        extracted_claim_ids: ['extracted-claim:decision-failed-markdown'],
        source_refs: [SOURCE_REF],
        actor: 'codex',
        session_id: 'session:phase-04-red-failure',
        job_id: 'job:projection-red-failure',
        runner_id: 'runner:codex',
        error_code: 'failed_markdown',
        error_message: 'simulated markdown projection failure',
      },
    });
  });

  test('failed projection snapshot after DB mutation marks reconcile before any markdown write', async () => {
    const harness = createHarness({
      getProjectionSnapshot: async () => {
        throw new Error('simulated projection snapshot failure');
      },
      writeProjection: async (mutation) => {
        harness.projectionMutations.push(mutation);
        throw new Error('projection should not run after snapshot failure');
      },
    });

    const result = await harness.service.applyCanonicalWrite({
      claim: {
        id: 'extracted-claim:decision-failed-snapshot',
        source_kind: 'user_direct',
        claim_type: 'decision',
        target_type: 'project',
        target_id: 'project:mbrain',
        target_slug: 'projects/mbrain',
        property: 'decision.timeline',
        value_json: { decision: 'Projection snapshot failures require reconcile.' },
        confidence: 1,
        sensitivity: 'normal',
        prompt_injection_flag: false,
        secret_flag: false,
      },
      evidence: {
        id: 'assertion-evidence:decision-failed-snapshot',
        source_id: 'source:user-direct',
        source_item_id: 'source-item:turn-snapshot',
        source_chunk_id: 'source-chunk:turn-snapshot',
      },
      source_refs: [SOURCE_REF],
      conflict_state: { kind: 'none' },
      assertion_state: 'canonical',
      user_override_policy: 'none',
      session_write_grant: activeWriteGrant(['auto_canonical']),
      realm: 'project:mbrain',
      runner_trust: 'trusted_interactive',
      actor: {
        actor: 'codex',
        session_id: 'session:phase-04-red-snapshot',
        job_id: 'job:projection-red-snapshot',
        runner_id: 'runner:codex',
      },
    });

    expect(result).toMatchObject({
      status: 'pending_reconcile',
      projection_status: 'failed_markdown',
      assertion_ids: ['assertion:decision-failed-snapshot'],
      assertion_evidence_ids: ['assertion-evidence:decision-failed-snapshot'],
      extracted_claim_ids: ['extracted-claim:decision-failed-snapshot'],
      error: {
        code: 'failed_markdown',
        message: 'simulated projection snapshot failure',
      },
    });
    expect(harness.dbMutations).toHaveLength(1);
    expect(harness.projectionMutations).toHaveLength(0);
    expect(harness.reconcileMarks).toEqual([{
      assertion_ids: ['assertion:decision-failed-snapshot'],
      projection_ids: [],
      projection_kind: 'project_decision_timeline',
      projection_slug: 'projects/mbrain/decisions',
      status: 'pending_reconcile',
      reason: 'failed_markdown',
      error: 'simulated projection snapshot failure',
    }]);
    expect(harness.ledgerEvents).toHaveLength(1);
    expect(harness.ledgerEvents[0]).toMatchObject({
      result: 'failed',
      metadata: {
        status: 'pending_reconcile',
        projection_status: 'failed_markdown',
        before_markdown_hash: null,
        after_markdown_hash: null,
        projection_ids: [],
        error_code: 'failed_markdown',
        error_message: 'simulated projection snapshot failure',
      },
    });
  });

  test('failed markdown path still returns structured reconcile result when failure ledger cannot be written', async () => {
    const harness = createHarness({
      writeProjection: async (mutation) => {
        harness.projectionMutations.push(mutation);
        throw new Error('simulated markdown projection failure');
      },
      recordMutationLedger: async () => {
        throw new Error('simulated failed-ledger recording outage');
      },
    });

    const result = await harness.service.applyCanonicalWrite({
      claim: {
        id: 'extracted-claim:decision-failed-markdown-ledger',
        source_kind: 'user_direct',
        claim_type: 'decision',
        target_type: 'project',
        target_id: 'project:mbrain',
        target_slug: 'projects/mbrain',
        property: 'decision.timeline',
        value_json: { decision: 'Projection failure should still return structured state if ledger is down.' },
        confidence: 1,
        sensitivity: 'normal',
        prompt_injection_flag: false,
        secret_flag: false,
      },
      evidence: {
        id: 'assertion-evidence:decision-failed-markdown-ledger',
        source_id: 'source:user-direct',
        source_item_id: 'source-item:turn-markdown-ledger',
        source_chunk_id: 'source-chunk:turn-markdown-ledger',
      },
      source_refs: [SOURCE_REF],
      conflict_state: { kind: 'none' },
      assertion_state: 'canonical',
      user_override_policy: 'none',
      session_write_grant: activeWriteGrant(['auto_canonical']),
      realm: 'project:mbrain',
      runner_trust: 'trusted_interactive',
      actor: {
        actor: 'codex',
        session_id: 'session:phase-04-red-markdown-ledger',
        job_id: 'job:projection-red-markdown-ledger',
        runner_id: 'runner:codex',
      },
    });

    expect(result).toMatchObject({
      status: 'pending_reconcile',
      projection_status: 'failed_markdown',
      error: {
        code: 'failed_markdown',
        message: 'simulated markdown projection failure',
      },
    });
    expect(harness.reconcileMarks).toEqual([{
      assertion_ids: ['assertion:decision-failed-markdown-ledger'],
      projection_ids: ['projection:project-decisions'],
      projection_kind: 'project_decision_timeline',
      projection_slug: 'projects/mbrain/decisions',
      status: 'pending_reconcile',
      reason: 'failed_markdown',
      error: 'simulated markdown projection failure',
    }]);
  });

  test('failed DB mutation records failed_db and never writes the markdown projection', async () => {
    const harness = createHarness({
      applyDbMutation: async (input) => {
        harness.dbMutations.push(input as unknown as Record<string, unknown>);
        throw new Error('simulated db mutation failure');
      },
      writeProjection: async (mutation) => {
        harness.projectionMutations.push(mutation);
        throw new Error('projection should not run after DB failure');
      },
    });

    const result = await harness.service.applyCanonicalWrite({
      claim: {
        id: 'extracted-claim:decision-failed-db',
        source_kind: 'user_direct',
        claim_type: 'decision',
        target_type: 'project',
        target_id: 'project:mbrain',
        target_slug: 'projects/mbrain',
        property: 'decision.timeline',
        value_json: { decision: 'Never project Markdown when canonical DB mutation fails.' },
        confidence: 1,
        sensitivity: 'normal',
        prompt_injection_flag: false,
        secret_flag: false,
      },
      evidence: {
        id: 'assertion-evidence:decision-failed-db',
        source_id: 'source:user-direct',
        source_item_id: 'source-item:turn-4',
        source_chunk_id: 'source-chunk:turn-4',
      },
      source_refs: [SOURCE_REF],
      conflict_state: { kind: 'none' },
      assertion_state: 'canonical',
      user_override_policy: 'none',
      session_write_grant: activeWriteGrant(['auto_canonical']),
      realm: 'project:mbrain',
      runner_trust: 'trusted_interactive',
      actor: {
        actor: 'codex',
        session_id: 'session:phase-04-red-failed-db',
        job_id: 'job:projection-red-failed-db',
        runner_id: 'runner:codex',
      },
    });

    expect(result).toMatchObject({
      status: 'failed_db',
      projection_status: 'not_attempted',
      assertion_ids: [],
      assertion_evidence_ids: [],
      extracted_claim_ids: ['extracted-claim:decision-failed-db'],
      error: {
        code: 'failed_db',
        message: 'simulated db mutation failure',
      },
    });
    expect(harness.dbMutations).toHaveLength(1);
    expect(harness.projectionMutations).toHaveLength(0);
    expect(harness.ledgerEvents).toHaveLength(1);
    expect(harness.ledgerEvents[0]).toMatchObject({
      result: 'failed',
      expected_target_snapshot_hash: null,
      current_target_snapshot_hash: null,
      metadata: {
        status: 'failed_db',
        projection_status: 'not_attempted',
        policy_decision: 'auto_canonical',
        before_db_hash: null,
        after_db_hash: null,
        before_markdown_hash: null,
        after_markdown_hash: null,
        extracted_claim_ids: ['extracted-claim:decision-failed-db'],
        source_refs: [SOURCE_REF],
        error_code: 'failed_db',
        error_message: 'simulated db mutation failure',
      },
    });
  });

  test('failed ledger write after DB and Markdown mutation marks reconcile without misreporting markdown failure', async () => {
    const harness = createHarness({
      recordMutationLedger: async () => {
        throw new Error('simulated ledger failure');
      },
    });

    const result = await harness.service.applyCanonicalWrite({
      claim: {
        id: 'extracted-claim:decision-failed-ledger',
        source_kind: 'user_direct',
        claim_type: 'decision',
        target_type: 'project',
        target_id: 'project:mbrain',
        target_slug: 'projects/mbrain',
        property: 'decision.timeline',
        value_json: { decision: 'Ledger failures require reconcile after projection.' },
        confidence: 1,
        sensitivity: 'normal',
        prompt_injection_flag: false,
        secret_flag: false,
      },
      evidence: {
        id: 'assertion-evidence:decision-failed-ledger',
        source_id: 'source:user-direct',
        source_item_id: 'source-item:turn-5',
        source_chunk_id: 'source-chunk:turn-5',
      },
      source_refs: [SOURCE_REF],
      conflict_state: { kind: 'none' },
      assertion_state: 'canonical',
      user_override_policy: 'none',
      session_write_grant: activeWriteGrant(['auto_canonical']),
      realm: 'project:mbrain',
      runner_trust: 'trusted_interactive',
      actor: {
        actor: 'codex',
        session_id: 'session:phase-04-red-failed-ledger',
        job_id: 'job:projection-red-failed-ledger',
        runner_id: 'runner:codex',
      },
    });

    expect(result).toMatchObject({
      status: 'pending_reconcile',
      projection_status: 'applied',
      assertion_ids: ['assertion:decision-failed-ledger'],
      assertion_evidence_ids: ['assertion-evidence:decision-failed-ledger'],
      extracted_claim_ids: ['extracted-claim:decision-failed-ledger'],
      error: {
        code: 'failed_ledger',
        message: 'simulated ledger failure',
      },
    });
    expect(harness.dbMutations).toHaveLength(1);
    expect(harness.projectionMutations).toHaveLength(1);
    expect(harness.reconcileMarks).toEqual([{
      assertion_ids: ['assertion:decision-failed-ledger'],
      projection_ids: ['projection:project-decisions'],
      projection_kind: 'project_decision_timeline',
      projection_slug: 'projects/mbrain/decisions',
      status: 'pending_reconcile',
      reason: 'failed_ledger',
      error: 'simulated ledger failure',
    }]);
  });

  test('agent_session inferred_preference plans a candidate and does not mutate canonical state', async () => {
    const harness = createHarness({ decidePolicy: undefined });

    const result = await harness.service.planCanonicalWrite(policyInput({
      claim: {
        source_kind: 'agent_session',
        claim_type: 'inferred_preference',
        target_certainty: 'probable',
        confidence: 0.72,
        sensitivity: 'personal',
        property: 'ui.default_detail_level',
        value_json: { preference: 'simple_base_with_popup_detail' },
      },
      assertion_state: 'candidate',
      session_write_grant: activeWriteGrant(['candidate']),
      runner_trust: 'trusted_interactive',
    }));

    expect(result).toMatchObject({
      policy: {
        decision: 'candidate',
        explanation: 'source=agent_session claim=inferred_preference target=probable confidence=0.72 sensitivity=personal safety=clear conflict=none assertion=candidate grant=allowed runner=trusted_interactive => candidate',
      },
      mutation_plan: {
        operations: [],
        canonical_write_blocked: true,
      },
      candidate: {
        status: 'pending_review',
        reason_codes: [
          'source_not_authoritative_for_auto_write',
          'claim_is_inferred',
          'target_not_exact',
          'personal_sensitivity_requires_review',
        ],
        safe_value_json: { preference: 'simple_base_with_popup_detail' },
        source_refs: [SOURCE_REF],
      },
    });
    expect(harness.dbMutations).toHaveLength(0);
    expect(harness.projectionMutations).toHaveLength(0);
  });

  test('code_repo code_claim plans verify_first even with high confidence and a write grant', async () => {
    const harness = createHarness({ decidePolicy: undefined });

    const result = await harness.service.planCanonicalWrite(policyInput({
      claim: {
        source_kind: 'code_repo',
        claim_type: 'code_claim',
        target_certainty: 'exact',
        confidence: 0.99,
        sensitivity: 'internal',
        property: 'cli.entrypoint',
        value_json: { path: 'src/cli.ts' },
      },
      assertion_state: 'canonical',
      session_write_grant: activeWriteGrant(['auto_canonical', 'verify_first']),
      runner_trust: 'trusted_automation',
    }));

    expect(result.policy.decision).toBe('verify_first');
    expect(result.verification_request).toMatchObject({
      required: true,
      reason: 'code_claim_requires_live_verification',
      source_kind: 'code_repo',
      claim_type: 'code_claim',
      target_slug: 'projects/mbrain',
      property: 'cli.entrypoint',
    });
    expect(result.mutation_plan.operations).toEqual([]);
    expect(harness.dbMutations).toHaveLength(0);
    expect(harness.projectionMutations).toHaveLength(0);
  });

  test('prompt-injection flagged claims are quarantined and cannot auto-write', async () => {
    const harness = createHarness({ decidePolicy: undefined });

    const result = await harness.service.planCanonicalWrite(policyInput({
      claim: {
        source_kind: 'user_direct',
        claim_type: 'decision',
        target_certainty: 'exact',
        confidence: 1,
        sensitivity: 'normal',
        prompt_injection_flag: true,
      },
      assertion_state: 'canonical',
      session_write_grant: activeWriteGrant(['auto_canonical', 'quarantine']),
      runner_trust: 'trusted_interactive',
    }));

    expect(result.policy.decision).toBe('quarantine');
    expect(result.quarantine).toMatchObject({
      reason: 'prompt_injection_flag',
      source_id: 'source:user-direct',
      source_chunk_id: 'source-chunk:turn-policy',
      canonical_write_blocked: true,
    });
    expect(result.mutation_plan.operations).toEqual([]);
    expect(harness.dbMutations).toHaveLength(0);
    expect(harness.projectionMutations).toHaveLength(0);
  });

  test('secret-bearing claims quarantine secret canonicalization and expose only redacted review material', async () => {
    const harness = createHarness({ decidePolicy: undefined });

    const result = await harness.service.planCanonicalWrite(policyInput({
      claim: {
        source_kind: 'user_direct',
        claim_type: 'profile_fact',
        target_certainty: 'exact',
        confidence: 1,
        sensitivity: 'secret',
        secret_flag: true,
        property: 'api.openai_key',
        value_json: {
          key: 'sk-live-should-never-be-canonicalized',
          password: 'plain-password-should-never-leak',
        },
      },
      assertion_state: 'candidate',
      session_write_grant: activeWriteGrant(['auto_canonical', 'candidate', 'quarantine', 'reject']),
      runner_trust: 'trusted_interactive',
    }));

    expect(result.policy.decision).toBe('quarantine');
    expect(JSON.stringify(result)).not.toContain('sk-live-should-never-be-canonicalized');
    expect(JSON.stringify(result)).not.toContain('plain-password-should-never-leak');
    expect(result.quarantine).toMatchObject({
      reason: 'secret_flag',
      canonical_write_blocked: true,
      safe_value_json: '[REDACTED_SECRET]',
    });
    expect(result.mutation_plan.operations).toEqual([]);
    expect(harness.dbMutations).toHaveLength(0);
    expect(harness.projectionMutations).toHaveLength(0);
  });

  test('conflict route plans a conflict set instead of overwriting canonical projection', async () => {
    const harness = createHarness({ decidePolicy: undefined });

    const result = await harness.service.planCanonicalWrite(policyInput({
      claim: {
        source_kind: 'user_direct',
        claim_type: 'decision',
        target_certainty: 'exact',
        confidence: 0.97,
        sensitivity: 'normal',
      },
      conflict_state: {
        kind: 'contradicts_existing_canonical',
        existing_assertion_ids: ['assertion:runtime-sqlite-only'],
        conflict_set_id: null,
      },
      assertion_state: 'conflicted',
      session_write_grant: activeWriteGrant(['auto_canonical', 'conflict']),
      runner_trust: 'trusted_interactive',
    }));

    expect(result.policy.decision).toBe('conflict');
    expect(result.conflict_set).toMatchObject({
      id: 'conflict-set:project:projects/mbrain:decision.timeline',
      status: 'open',
      target_slug: 'projects/mbrain',
      property: 'decision.timeline',
      assertion_ids: [
        'assertion:runtime-sqlite-only',
        'assertion:decision-policy',
      ],
      source_refs: [SOURCE_REF],
    });
    expect(result.mutation_plan.operations).toEqual([]);
    expect(result.ledger_preview).toMatchObject({
      result: 'conflict',
      metadata: {
        policy_decision: 'conflict',
        conflict_set_id: 'conflict-set:project:projects/mbrain:decision.timeline',
      },
    });
  });

  test('revoked write grant blocks automatic canonical write', async () => {
    const harness = createHarness({ decidePolicy: undefined });

    const result = await harness.service.planCanonicalWrite(policyInput({
      session_write_grant: {
        ...activeWriteGrant(['auto_canonical', 'candidate']),
        revoked_at: '2026-05-20T10:00:00.000Z',
      },
    }));

    expect(result.policy.decision).toBe('no_write');
    expect(result.mutation_plan).toEqual({
      operations: [],
      canonical_write_blocked: true,
    });
    expect(harness.dbMutations).toHaveLength(0);
    expect(harness.projectionMutations).toHaveLength(0);
  });

  test('expired write grant blocks automatic canonical write at evaluation time', async () => {
    const harness = createHarness({ decidePolicy: undefined });

    const result = await harness.service.planCanonicalWrite(policyInput({
      session_write_grant: {
        ...activeWriteGrant(['auto_canonical', 'candidate']),
        expires_at: '2026-05-20T10:00:00.000Z',
      },
    }));

    expect(result.policy).toMatchObject({
      decision: 'no_write',
      explanation: 'source=user_direct claim=decision target=exact confidence=1 sensitivity=normal safety=clear conflict=none assertion=canonical grant=expired runner=trusted_interactive => no_write',
    });
    expect(result.mutation_plan).toEqual({
      operations: [],
      canonical_write_blocked: true,
    });
    expect(harness.dbMutations).toHaveLength(0);
    expect(harness.projectionMutations).toHaveLength(0);
  });

  test('write grant for a different session cannot authorize canonical write', async () => {
    const harness = createHarness({ decidePolicy: undefined });

    const result = await harness.service.planCanonicalWrite(policyInput({
      session_write_grant: {
        ...activeWriteGrant(['auto_canonical', 'candidate']),
        session_id: 'session:other',
      },
    }));

    expect(result.policy).toMatchObject({
      decision: 'no_write',
      explanation: 'source=user_direct claim=decision target=exact confidence=1 sensitivity=normal safety=clear conflict=none assertion=canonical grant=wrong_session runner=trusted_interactive => no_write',
    });
    expect(result.mutation_plan).toEqual({
      operations: [],
      canonical_write_blocked: true,
    });
    expect(harness.dbMutations).toHaveLength(0);
    expect(harness.projectionMutations).toHaveLength(0);
  });

  test('write grant for an unrelated target scope cannot authorize canonical write', async () => {
    const harness = createHarness({ decidePolicy: undefined });

    const result = await harness.service.planCanonicalWrite(policyInput({
      session_write_grant: {
        ...activeWriteGrant(['auto_canonical', 'candidate']),
        target_scope: 'projects/other',
      },
    }));

    expect(result.policy).toMatchObject({
      decision: 'no_write',
      explanation: 'source=user_direct claim=decision target=exact confidence=1 sensitivity=normal safety=clear conflict=none assertion=canonical grant=wrong_scope runner=trusted_interactive => no_write',
    });
    expect(result.mutation_plan).toEqual({
      operations: [],
      canonical_write_blocked: true,
    });
    expect(harness.dbMutations).toHaveLength(0);
    expect(harness.projectionMutations).toHaveLength(0);
  });

  test('untrusted runner cannot auto-write and routes to candidate when review is allowed', async () => {
    const harness = createHarness({ decidePolicy: undefined });

    const result = await harness.service.planCanonicalWrite(policyInput({
      session_write_grant: activeWriteGrant(['auto_canonical', 'candidate']),
      runner_trust: 'untrusted_runner',
    }));

    expect(result.policy.decision).toBe('candidate');
    expect(result.candidate).toMatchObject({
      status: 'pending_review',
      reason_codes: ['runner_not_trusted_for_auto_write'],
    });
    expect(result.mutation_plan).toEqual({
      operations: [],
      canonical_write_blocked: true,
    });
    expect(harness.dbMutations).toHaveLength(0);
    expect(harness.projectionMutations).toHaveLength(0);
  });

  test('policy explanation is deterministic for semantically identical inputs', () => {
    const left = policyInput({
      claim: {
        source_kind: 'user_direct',
        claim_type: 'decision',
        target_certainty: 'exact',
        confidence: 1,
        sensitivity: 'normal',
      },
      assertion_state: 'canonical',
      session_write_grant: activeWriteGrant(['auto_canonical']),
      runner_trust: 'trusted_interactive',
    });
    const rightBase = policyInput({});
    const right = {
      ...rightBase,
      claim: {
        ...rightBase.claim,
        sensitivity: 'normal',
        confidence: 1,
        target_certainty: 'exact',
        claim_type: 'decision',
        source_kind: 'user_direct',
      },
      assertion_state: 'canonical',
      session_write_grant: activeWriteGrant(['auto_canonical']),
      runner_trust: 'trusted_interactive',
    };

    expect(explainCanonicalWritePolicy(left)).toEqual(explainCanonicalWritePolicy(right));
    expect(explainCanonicalWritePolicy(left)).toMatchObject({
      decision: 'auto_canonical',
      explanation: 'source=user_direct claim=decision target=exact confidence=1 sensitivity=normal safety=clear conflict=none assertion=canonical grant=allowed runner=trusted_interactive => auto_canonical',
      explanation_hash: 'sha256:4c9642abfe5c0ac0d01b4cd3b579d55b8ce3ae85a978e7129b7c8046f0ff0c34',
    });
  });
});

function policyInput(overrides: {
  claim?: Partial<GovernedCanonicalWriteInput['claim']>;
  conflict_state?: GovernedCanonicalWriteInput['conflict_state'];
  assertion_state?: GovernedCanonicalWriteInput['assertion_state'];
  session_write_grant?: GovernedCanonicalWriteInput['session_write_grant'];
  runner_trust?: GovernedCanonicalWriteInput['runner_trust'];
} = {}): GovernedCanonicalWriteInput {
  return {
    claim: {
      id: 'extracted-claim:decision-policy',
      source_kind: 'user_direct',
      source_id: 'source:user-direct',
      source_item_id: 'source-item:turn-policy',
      source_chunk_id: 'source-chunk:turn-policy',
      claim_type: 'decision',
      target_certainty: 'exact',
      target_type: 'project',
      target_id: 'project:mbrain',
      target_slug: 'projects/mbrain',
      property: 'decision.timeline',
      value_json: {
        decision: 'Markdown is a governed projection of Postgres canonical memory.',
      },
      confidence: 1,
      sensitivity: 'normal',
      prompt_injection_flag: false,
      secret_flag: false,
      valid_from: '2026-05-20T00:00:00.000Z',
      valid_until: null,
      ...overrides.claim,
    },
    evidence: {
      id: 'assertion-evidence:decision-policy',
      source_id: 'source:user-direct',
      source_item_id: 'source-item:turn-policy',
      source_chunk_id: 'source-chunk:turn-policy',
    },
    source_refs: [SOURCE_REF],
    conflict_state: overrides.conflict_state ?? { kind: 'none' },
    assertion_state: overrides.assertion_state ?? 'canonical',
    user_override_policy: 'none',
    session_write_grant: overrides.session_write_grant ?? activeWriteGrant(['auto_canonical']),
    realm: 'project:mbrain',
    runner_trust: overrides.runner_trust ?? 'trusted_interactive',
    session_id: 'session:phase-04-red-policy',
    actor: {
      actor: 'codex',
      session_id: 'session:phase-04-red-policy',
      job_id: 'job:policy-red',
      runner_id: 'runner:codex',
    },
  };
}

function activeWriteGrant(allowed_policy_outcomes: string[]) {
  return {
    session_id: 'session:phase-04-red-policy',
    realm: 'project:mbrain',
    target_scope: 'projects/mbrain',
    allowed_policy_outcomes,
    expires_at: '2026-05-21T00:00:00.000Z',
    revoked_at: null,
  };
}

function createHarness(overrides: Partial<GovernedCanonicalWriteServiceOptions> = {}) {
  const dbMutations: Array<Record<string, unknown>> = [];
  const projectionMutations: ProjectionMutationInput[] = [];
  const ledgerEvents: Array<Record<string, unknown>> = [];
  const reconcileMarks: Array<Record<string, unknown>> = [];

  const service = createGovernedCanonicalWriteService({
    now: () => '2026-05-20T10:15:00.000Z',
    decidePolicy: async () => ({
      decision: 'auto_canonical',
      explanation: 'user_direct decision is source-backed and safe for immediate canonical projection',
    }),
    applyDbMutation: async (input: GovernedCanonicalWriteInput) => {
      dbMutations.push(input as unknown as Record<string, unknown>);
      return {
        before_db_hash: `dbhash:before:${input.claim.target_slug}`,
        after_db_hash: `dbhash:after:${input.claim.target_slug}`,
        assertions: [{
          id: input.claim.id.replace('extracted-claim', 'assertion'),
          target_slug: input.claim.target_slug,
        }],
        assertion_evidence: [{
          id: input.evidence.id,
          assertion_id: input.claim.id.replace('extracted-claim', 'assertion'),
          extracted_claim_id: input.claim.id,
        }],
      };
    },
    getProjectionSnapshot: async (target) => ({
      projection_id: target.kind === 'system_compiled_truth'
        ? 'projection:system-compiled-truth'
        : 'projection:project-decisions',
      markdown_hash: `mdhash:before:${target.slug}`,
    }),
    writeProjection: async (mutation) => {
      projectionMutations.push(mutation);
      return {
        projection_id: mutation.projection_target.kind === 'system_compiled_truth'
          ? 'projection:system-compiled-truth'
          : 'projection:project-decisions',
        markdown_hash: `mdhash:after:${mutation.projection_target.slug}`,
      };
    },
    markPendingReconcile: async (input) => {
      reconcileMarks.push(input as Record<string, unknown>);
    },
    recordMutationLedger: async (event) => {
      ledgerEvents.push(event as Record<string, unknown>);
    },
    ...overrides,
  });

  return {
    service,
    dbMutations,
    projectionMutations,
    ledgerEvents,
    reconcileMarks,
  };
}
