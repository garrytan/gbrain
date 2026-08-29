/**
 * Sync-facing embed-backfill delivery contract.
 *
 * Keeps queue capability, automatic submission results, human text, and the
 * single-source JSON envelope aligned without growing the sync command facade.
 */
import type { BrainEngine } from './engine.ts';
import { submitEmbedBackfill } from './embed-backfill-submit.ts';
import { resolveWorkerBackedSyncEmbedMode } from './embedding.ts';
import {
  embedBackfillManualDrainCommand,
  embedBackfillWorkerSurface,
  type EmbedBackfillWorkerSurface,
} from './minions/embed-backfill-admission.ts';
import { runInlineCostGate } from './sync-cost-gate.ts';

type SyncCostGateSource = {
  id: string;
  local_path: string | null;
  config: Record<string, unknown>;
  last_commit: string | null;
  chunker_version: string | null;
};

type SyncCostGateFlags = {
  dryRun: boolean;
  jsonOut: boolean;
  yesFlag: boolean;
  full: boolean;
  includeGitignored: boolean;
  noAutoEmbed: boolean;
};

export async function resolveSyncAllEmbedPlan(
  engine: BrainEngine,
  sources: SyncCostGateSource[],
  opts: SyncCostGateFlags & { v2Enabled: boolean; serialFlag: boolean; noEmbed: boolean },
): Promise<{
  stop: boolean;
  workerSurface: EmbedBackfillWorkerSurface;
  deferEligible: boolean;
  fanOutEligible: boolean;
  autoDeferEmbeds: boolean;
  effectiveNoEmbed: boolean;
  shouldBackfill: boolean;
}> {
  const workerSurface = embedBackfillWorkerSurface(engine);
  const deferEligible =
    opts.v2Enabled && !opts.serialFlag && workerSurface.status === 'worker_backed';
  const fanOutEligible = deferEligible && sources.length > 1;
  const buildPlan = (stop: boolean, autoDeferEmbeds: boolean) => ({
    stop,
    workerSurface,
    deferEligible,
    fanOutEligible,
    autoDeferEmbeds,
    effectiveNoEmbed: deferEligible || opts.noEmbed || autoDeferEmbeds,
    shouldBackfill: deferEligible || autoDeferEmbeds || (opts.v2Enabled && opts.noEmbed),
  });
  let autoDeferEmbeds = false;
  if (!opts.noEmbed) {
    const gate = await runInlineCostGate(engine, {
      sources: sources.map((source) => ({ ...source, sourceId: source.id })),
      mode: resolveWorkerBackedSyncEmbedMode({ deferEligible, noEmbed: opts.noEmbed }),
      dryRun: opts.dryRun,
      jsonOut: opts.jsonOut,
      yesFlag: opts.yesFlag,
      full: opts.full,
      includeGitignored: opts.includeGitignored,
      label: 'sync --all',
      workerSurface,
      autoSubmitEnabled: !opts.noAutoEmbed,
    });
    if (gate.action === 'stop') {
      return buildPlan(true, false);
    }
    autoDeferEmbeds = gate.autoDeferEmbeds;
  }
  return buildPlan(false, autoDeferEmbeds);
}

export async function resolveSingleSyncEmbedPlan(
  engine: BrainEngine,
  source: Omit<SyncCostGateSource, 'id'> & { sourceId: string },
  opts: SyncCostGateFlags,
): Promise<{
  stop: boolean;
  workerSurface: EmbedBackfillWorkerSurface;
  autoDeferEmbeds: boolean;
}> {
  const workerSurface = embedBackfillWorkerSurface(engine);
  const gate = await runInlineCostGate(engine, {
    sources: [source],
    mode: 'inline',
    dryRun: opts.dryRun,
    jsonOut: opts.jsonOut,
    yesFlag: opts.yesFlag,
    full: opts.full,
    includeGitignored: opts.includeGitignored,
    label: 'sync',
    workerSurface,
    autoSubmitEnabled: !opts.noAutoEmbed,
  });
  return gate.action === 'stop'
    ? { stop: true, workerSurface, autoDeferEmbeds: false }
    : { stop: false, workerSurface, autoDeferEmbeds: gate.autoDeferEmbeds };
}

export type SyncEmbedBackfillOutcome =
  | { status: 'queued'; job_id: number }
  | {
      status: 'manual_drain_required';
      command: string;
      reason: 'no_worker_surface' | 'auto_submit_disabled';
    }
  | { status: 'skipped'; reason: 'cooldown'; command: string }
  | { status: 'skipped'; reason: 'spend_capped'; command: string; spend_cap_usd: number };

export async function resolveSyncEmbedBackfill(
  engine: BrainEngine,
  sourceId: string,
  opts: {
    reason: string;
    autoSubmitDisabled: boolean;
  },
): Promise<SyncEmbedBackfillOutcome> {
  const command = embedBackfillManualDrainCommand(sourceId);
  if (embedBackfillWorkerSurface(engine).status === 'no_worker_surface') {
    return { status: 'manual_drain_required', command, reason: 'no_worker_surface' };
  }
  if (opts.autoSubmitDisabled) {
    return { status: 'manual_drain_required', command, reason: 'auto_submit_disabled' };
  }

  const submitted = await submitEmbedBackfill(engine, sourceId, { reason: opts.reason });
  switch (submitted.status) {
    case 'submitted':
      return { status: 'queued', job_id: submitted.jobId };
    case 'cooldown':
      return { status: 'skipped', reason: 'cooldown', command };
    case 'spend_capped':
      return {
        status: 'skipped',
        reason: 'spend_capped',
        command,
        spend_cap_usd: submitted.spendCapUsd,
      };
    case 'no_worker_surface':
      return { status: 'manual_drain_required', command, reason: 'no_worker_surface' };
    default:
      submitted satisfies never;
      throw new Error('unreachable embed-backfill submission result');
  }
}

export function formatSyncEmbedBackfillOutcome(
  outcome: SyncEmbedBackfillOutcome,
  sourceName?: string,
): string {
  const source = sourceName ? ` for ${sourceName}` : '';
  switch (outcome.status) {
    case 'queued':
      return `embed-backfill job ${outcome.job_id} queued${source}`;
    case 'manual_drain_required':
      return `embed-backfill not queued; manual drain required: \`${outcome.command}\`${source}`;
    case 'skipped': {
      const detail = outcome.reason === 'cooldown'
        ? 'cooldown'
        : `24h spend cap $${outcome.spend_cap_usd}`;
      return `embed-backfill skipped (${detail})${source}; manual drain: \`${outcome.command}\``;
    }
    default:
      outcome satisfies never;
      throw new Error('unreachable sync embed-backfill outcome');
  }
}

export function buildSingleSyncJsonEnvelope(
  sourceId: string,
  result: {
    status: string;
    reason?: string;
    added: number;
    modified: number;
    deleted: number;
    chunksCreated: number;
    embedded: number;
  },
  embedBackfill?: SyncEmbedBackfillOutcome,
): Record<string, unknown> {
  return {
    schema_version: 1,
    source_id: sourceId,
    sync_status: result.status,
    ...(result.reason ? { reason: result.reason } : {}),
    added: result.added,
    modified: result.modified,
    deleted: result.deleted,
    chunks_created: result.chunksCreated,
    embedded: result.embedded,
    ...(embedBackfill ? { embed_backfill: embedBackfill } : {}),
  };
}
