import {
  buildRawIngestPlan,
  type RawIngestPlan,
  type RawIngestPolicy,
} from '../source-registry/raw-ingest.ts';
import {
  assertProjectionTargetType,
  isRuntimeOnlyProjectionTarget,
  type ProjectionTargetStatus,
  type ProjectionTargetType,
} from '../reconciler/projection-targets.ts';
import {
  parseMarkdownProjection,
  projectionContentHash,
} from '../reconciler/markdown-contracts.ts';

export type SystemOfRecordReconcilerMode =
  | 'check'
  | 'repair_markdown'
  | 'repair_db'
  | 'import_markdown_edit'
  | 'rebuild_derived'
  | 'quarantine_conflict';

export interface ProjectionTargetRecord {
  id: string;
  target_type: ProjectionTargetType;
  target_id: string;
  locator: string;
  source_assertion_ids: string[];
  projection_hash: string;
  rendered_markdown: string;
  last_rendered_at: string | null;
  last_reconciled_at: string | null;
  status: ProjectionTargetStatus;
  runtime_only?: boolean;
  canonical_changed_since_projection?: boolean;
}

export interface SystemOfRecordHealthSummary {
  pending_reconcile: number;
  failed: number;
  conflict: number;
}

export interface ReconcilerItemResult {
  target_id: string;
  projection_id: string;
  status: 'ok' | 'pending_reconcile' | 'reconciled' | 'failed' | 'conflict';
  reason?:
    | 'projection_drift'
    | 'missing_markdown'
    | 'db_and_markdown_changed'
    | 'not_found'
    | 'invalid_markdown_projection'
    | 'target_mismatch'
    | 'policy_pipeline_required';
  action?: SystemOfRecordReconcilerMode;
  semantic_assertion_mutations?: number;
}

export interface SystemOfRecordReconcilerResult {
  mode: SystemOfRecordReconcilerMode;
  items: ReconcilerItemResult[];
  excluded_runtime_only: string[];
  raw_ingest_plans?: RawIngestPlan[];
  raw_ingest_plan?: RawIngestPlan;
}

export interface SystemOfRecordReconcilerInput {
  mode: SystemOfRecordReconcilerMode;
  target_id?: string;
}

export interface SystemOfRecordReconcilerDeps {
  now: () => string;
  listProjectionTargets: () => Promise<ProjectionTargetRecord[]>;
  updateProjectionTarget: (target: ProjectionTargetRecord) => Promise<void>;
  readMarkdown: (locator: string) => Promise<string | null>;
  writeMarkdown: (locator: string, content: string) => Promise<void>;
  renderCanonicalProjection: (target: ProjectionTargetRecord) => Promise<string>;
  recordMutationEvent: (event: Record<string, unknown>) => Promise<void>;
  rawIngestPolicy?: RawIngestPolicy;
}

export interface SystemOfRecordReconcilerService {
  run(input: SystemOfRecordReconcilerInput): Promise<SystemOfRecordReconcilerResult>;
}

const DEFAULT_MARKDOWN_EDIT_POLICY: RawIngestPolicy = {
  consent_state: 'granted',
  enabled: true,
  raw_copy_mode: 'metadata+chunks',
  automatic_canonical_write_authority: 'review_required',
};

export function createSystemOfRecordReconcilerService(
  deps: SystemOfRecordReconcilerDeps,
): SystemOfRecordReconcilerService {
  return {
    async run(input) {
      const allTargets = await deps.listProjectionTargets();
      const excludedRuntimeOnly = allTargets
        .filter(isRuntimeOnlyProjectionTarget)
        .map((target) => target.id);
      const targets = allTargets
        .filter((target) => !isRuntimeOnlyProjectionTarget(target))
        .filter((target) => !input.target_id || target.target_id === input.target_id);

      if (targets.length === 0) {
        return {
          mode: input.mode,
          items: input.target_id
            ? [{
                target_id: input.target_id,
                projection_id: '',
                status: 'failed',
                reason: 'not_found',
                action: input.mode,
              }]
            : [],
          excluded_runtime_only: excludedRuntimeOnly,
        };
      }

      const items: ReconcilerItemResult[] = [];
      const rawIngestPlans: RawIngestPlan[] = [];
      for (const target of targets) {
        assertProjectionTargetType(target.target_type);
        const markdown = await deps.readMarkdown(target.locator);
        switch (input.mode) {
          case 'check':
            items.push(checkTarget(target, markdown));
            break;
          case 'repair_markdown':
            items.push(await repairMarkdown(deps, target, markdown));
            break;
          case 'repair_db':
            items.push(await repairDb(deps, target, markdown));
            break;
          case 'import_markdown_edit':
            rawIngestPlans.push(importMarkdownEdit(deps, target, markdown));
            items.push({
              target_id: target.target_id,
              projection_id: target.id,
              status: 'pending_reconcile',
              reason: 'policy_pipeline_required',
              action: 'import_markdown_edit',
              semantic_assertion_mutations: 0,
            });
            break;
          case 'quarantine_conflict':
            items.push(await quarantineConflict(deps, target, markdown));
            break;
          case 'rebuild_derived':
            items.push({
              target_id: target.target_id,
              projection_id: target.id,
              status: 'reconciled',
              action: 'rebuild_derived',
              semantic_assertion_mutations: 0,
            });
            await deps.recordMutationEvent(mutationEvent(deps, target, 'rebuild_derived', 'applied'));
            break;
        }
      }

      return {
        mode: input.mode,
        items,
        excluded_runtime_only: excludedRuntimeOnly,
        ...(rawIngestPlans.length > 0 ? {
          raw_ingest_plans: rawIngestPlans,
          raw_ingest_plan: rawIngestPlans[0],
        } : {}),
      };
    },
  };
}

export function summarizeSystemOfRecordHealth(targets: Array<Pick<ProjectionTargetRecord, 'status'>>): SystemOfRecordHealthSummary {
  return {
    pending_reconcile: targets.filter((target) => target.status === 'pending_reconcile').length,
    failed: targets.filter((target) => target.status === 'failed').length,
    conflict: targets.filter((target) => target.status === 'conflict').length,
  };
}

function checkTarget(target: ProjectionTargetRecord, markdown: string | null): ReconcilerItemResult {
  if (markdown === null) {
    return {
      target_id: target.target_id,
      projection_id: target.id,
      status: 'pending_reconcile',
      reason: 'missing_markdown',
    };
  }
  const projection = readProjectionState(target, markdown);
  if (!projection.ok) {
    return {
      target_id: target.target_id,
      projection_id: target.id,
      status: 'pending_reconcile',
      reason: projection.reason,
    };
  }
  if (projection.hash !== target.projection_hash) {
    return {
      target_id: target.target_id,
      projection_id: target.id,
      status: 'pending_reconcile',
      reason: 'projection_drift',
    };
  }
  return {
    target_id: target.target_id,
    projection_id: target.id,
    status: 'ok',
  };
}

async function repairMarkdown(
  deps: SystemOfRecordReconcilerDeps,
  target: ProjectionTargetRecord,
  markdown: string | null,
): Promise<ReconcilerItemResult> {
  const existingProjection = markdown === null ? null : readProjectionState(target, markdown);
  const markdownChanged = existingProjection !== null && (!existingProjection.ok || existingProjection.hash !== target.projection_hash);
  if (markdownChanged) {
    if (target.canonical_changed_since_projection) {
      const updated = { ...target, status: 'conflict' as const };
      await deps.updateProjectionTarget(updated);
      await deps.recordMutationEvent(mutationEvent(deps, updated, 'repair_markdown', 'conflict'));
      return {
        target_id: target.target_id,
        projection_id: target.id,
        status: 'conflict',
        reason: 'db_and_markdown_changed',
        action: 'repair_markdown',
        semantic_assertion_mutations: 0,
      };
    }

    const updated = { ...target, status: 'pending_reconcile' as const };
    await deps.updateProjectionTarget(updated);
    return {
      target_id: target.target_id,
      projection_id: target.id,
      status: 'pending_reconcile',
      reason: existingProjection?.ok === false ? existingProjection.reason : 'projection_drift',
      action: 'repair_markdown',
      semantic_assertion_mutations: 0,
    };
  }

  const renderedMarkdown = await deps.renderCanonicalProjection(target);
  const renderedProjection = readProjectionState(target, renderedMarkdown);
  if (!renderedProjection.ok) {
    return {
      target_id: target.target_id,
      projection_id: target.id,
      status: 'failed',
      reason: renderedProjection.reason,
      action: 'repair_markdown',
      semantic_assertion_mutations: 0,
    };
  }

  await deps.writeMarkdown(target.locator, renderedMarkdown);
  const updated = {
    ...target,
    projection_hash: renderedProjection.hash,
    rendered_markdown: renderedMarkdown,
    last_reconciled_at: deps.now(),
    status: 'reconciled' as const,
  };
  await deps.updateProjectionTarget(updated);
  await deps.recordMutationEvent(mutationEvent(deps, updated, 'repair_markdown', 'applied'));
  return {
    target_id: target.target_id,
    projection_id: target.id,
    status: 'reconciled',
    action: 'repair_markdown',
    semantic_assertion_mutations: 0,
  };
}

async function repairDb(
  deps: SystemOfRecordReconcilerDeps,
  target: ProjectionTargetRecord,
  markdown: string | null,
): Promise<ReconcilerItemResult> {
  if (markdown === null) {
    return {
      target_id: target.target_id,
      projection_id: target.id,
      status: 'pending_reconcile',
      reason: 'missing_markdown',
      action: 'repair_db',
      semantic_assertion_mutations: 0,
    };
  }
  const projection = readProjectionState(target, markdown);
  const markdownChanged = !projection.ok || projection.hash !== target.projection_hash;
  if (markdownChanged && target.canonical_changed_since_projection) {
    const updated = { ...target, status: 'conflict' as const };
    await deps.updateProjectionTarget(updated);
    await deps.recordMutationEvent(mutationEvent(deps, updated, 'repair_db', 'conflict'));
    return {
      target_id: target.target_id,
      projection_id: target.id,
      status: 'conflict',
      reason: 'db_and_markdown_changed',
      action: 'repair_db',
      semantic_assertion_mutations: 0,
    };
  }
  if (!projection.ok) {
    const updated = { ...target, status: 'failed' as const };
    await deps.updateProjectionTarget(updated);
    return {
      target_id: target.target_id,
      projection_id: target.id,
      status: 'failed',
      reason: projection.reason,
      action: 'repair_db',
      semantic_assertion_mutations: 0,
    };
  }
  const updated = {
    ...target,
    projection_hash: projection.hash,
    rendered_markdown: markdown,
    last_reconciled_at: deps.now(),
    status: 'reconciled' as const,
  };
  await deps.updateProjectionTarget(updated);
  await deps.recordMutationEvent(mutationEvent(deps, updated, 'repair_db', 'applied'));
  return {
    target_id: target.target_id,
    projection_id: target.id,
    status: 'reconciled',
    action: 'repair_db',
    semantic_assertion_mutations: 0,
  };
}

function importMarkdownEdit(
  deps: SystemOfRecordReconcilerDeps,
  target: ProjectionTargetRecord,
  markdown: string | null,
): RawIngestPlan {
  const content = markdown ?? '';
  return buildRawIngestPlan({
    source_id: 'source:markdown-file',
    external_id: target.locator,
    origin_event: 'markdown_edit',
    locator: target.locator,
    title: target.target_id,
    chunk_texts: [content],
    raw_text: content,
    parser_version: 'markdown-projection:v1',
    now: deps.now(),
  }, deps.rawIngestPolicy ?? DEFAULT_MARKDOWN_EDIT_POLICY);
}

async function quarantineConflict(
  deps: SystemOfRecordReconcilerDeps,
  target: ProjectionTargetRecord,
  markdown: string | null,
): Promise<ReconcilerItemResult> {
  const projection = markdown === null ? null : readProjectionState(target, markdown);
  const markdownChanged = projection !== null && (!projection.ok || projection.hash !== target.projection_hash);
  if (target.canonical_changed_since_projection && markdownChanged) {
    const updated = { ...target, status: 'conflict' as const };
    await deps.updateProjectionTarget(updated);
    await deps.recordMutationEvent(mutationEvent(deps, updated, 'quarantine_conflict', 'conflict'));
    return {
      target_id: target.target_id,
      projection_id: target.id,
      status: 'conflict',
      reason: 'db_and_markdown_changed',
      action: 'quarantine_conflict',
      semantic_assertion_mutations: 0,
    };
  }
  return {
    target_id: target.target_id,
    projection_id: target.id,
    status: 'ok',
    action: 'quarantine_conflict',
    semantic_assertion_mutations: 0,
  };
}

function mutationEvent(
  deps: SystemOfRecordReconcilerDeps,
  target: ProjectionTargetRecord,
  mode: SystemOfRecordReconcilerMode,
  result: 'applied' | 'conflict',
): Record<string, unknown> {
  return {
    operation: 'system_of_record_reconcile',
    target_kind: 'projection_target',
    target_id: target.id,
    scope_id: target.target_id,
    source_refs: target.source_assertion_ids,
    result,
    expected_target_snapshot_hash: target.projection_hash,
    current_target_snapshot_hash: projectionSnapshotHash(target),
    metadata: {
      mode,
      target_type: target.target_type,
      locator: target.locator,
      recorded_at: deps.now(),
    },
  };
}

function projectionSnapshotHash(target: ProjectionTargetRecord): string {
  const projection = readProjectionState(target, target.rendered_markdown);
  return projection.ok ? projection.hash : projectionContentHash(target.rendered_markdown);
}

function readProjectionState(
  target: ProjectionTargetRecord,
  markdown: string,
): { ok: true; hash: string } | { ok: false; reason: 'invalid_markdown_projection' | 'target_mismatch' } {
  try {
    const parsed = parseMarkdownProjection(markdown);
    if (parsed.target_id !== target.target_id || parsed.target_type !== target.target_type) {
      return { ok: false, reason: 'target_mismatch' };
    }
    return { ok: true, hash: parsed.projection_hash };
  } catch {
    return { ok: false, reason: 'invalid_markdown_projection' };
  }
}
