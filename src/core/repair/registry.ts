/**
 * The `gbrain repair` kind registry: one entry per kind in `REPAIR_KINDS`
 * order (the `--all` dependency order). Everything that lists, previews or
 * runs repairs reads this table — the `gbrain repair` command, the doctor
 * remediation plan and run, and the post-upgrade banner — so a new kind plugs
 * in by adding its name to `REPAIR_KINDS` and one entry here.
 *
 * `checks` names the doctor checks whose findings this kind clears; the
 * remediation run uses it to classify those findings. `embeds` says how a kind
 * can spend on embeddings when a model is configured: `effect` kinds publish a
 * page write whose embedding effect the persistence consumer runs (outside
 * this process, not affected by `--no-embed`); `inline` kinds embed in this
 * process unless `--no-embed` is given.
 *
 * `explicit_only` kinds run only when the operator names them
 * (`gbrain repair <kind>`): `--all`, the remediation plan and run, and the
 * post-upgrade banner list them with their preview command
 * (`explicit_kind_required`) but never run them, and `runRepair` refuses one
 * that was not named, so a supplied remediation step cannot run it either.
 */
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { loadConfig } from '../config.ts';
import { REPAIR_KINDS, runRepair, type RepairHandler, type RepairKind, type RepairResult, type RepairScope } from './core.ts';
import { timelineRepair } from './timeline.ts';
import { visibilityRepair } from './visibility.ts';
import { safeChunksRepair } from './safe-chunks.ts';
import { contextualModeRepair } from './contextual-mode.ts';
import { connectorCheckpointsRepair } from './connector-checkpoints.ts';
import { requestIndexesRepair } from './request-indexes.ts';
import { connectorFencesRepair } from './connector-fences.ts';
import { orphanBindingsRepair } from './orphan-bindings.ts';
import { embeddingEffectsRepair } from './embedding-effects.ts';
import { staleAtomsRepair } from './stale-atoms.ts';
import { extractorFactsRepair } from './extractor-facts.ts';
import { ERROR_CATALOGUE, catalogueError } from '../error-catalogue.ts';
import type { OperationError } from '../ops/contract.ts';

export interface RepairKindSpec {
  kind: RepairKind;
  handler: RepairHandler;
  /** Help text for `REPAIR_HELP`, wrapped at 80 columns by the caller. */
  summary: string;
  /** How the kind can spend on embeddings; `none` for bookkeeping-row kinds. */
  embeds: 'effect' | 'inline' | 'none';
  /** Doctor check ids whose findings this kind clears. */
  checks: string[];
  /** Runs only when named on the command line; never from `--all`, the remediation plan or a supplied step. */
  explicit_only?: true;
}

const SPECS: Record<RepairKind, Omit<RepairKindSpec, 'kind'>> = {
  timeline: {
    handler: timelineRepair, embeds: 'effect', checks: ['timeline_history'],
    summary: 'Write database-only timeline rows back into their pages as marked bullets (#5567). Rows that cannot round-trip are kept and counted. Each repaired page is re-embedded by its publication.',
  },
  visibility: {
    handler: visibilityRepair, embeds: 'effect', checks: ['derived_visibility'],
    summary: 'Stamp explicit visibility on extracted atoms and synthesized concepts, tighten-only (#5525). Transcript and missing origins become private; nothing is ever loosened. Each repaired page is re-embedded by its publication.',
  },
  'safe-chunks': {
    handler: safeChunksRepair, embeds: 'inline', checks: ['safe_index_pending'],
    summary: 'Re-seal pages of every kind (markdown and code) chunked before the safe-chunk fence, which remote/MCP search withholds (#5050, #5247). '
      + 'Projection-only: no page write and no journal admission. Unchanged vectors are kept; the rest are embedded unless --no-embed.',
  },
  'contextual-mode': {
    handler: contextualModeRepair, embeds: 'inline', checks: ['contextual_retrieval_coverage'],
    summary: 'Stamp the contextual retrieval mode on markdown pages imported without one (#5621), exactly as a fresh import would. '
      + 'Projection-only. Vectors whose embedding input is unchanged are kept; a page whose input changes is re-embedded once unless --no-embed.',
  },
  'connector-checkpoints': {
    handler: connectorCheckpointsRepair, embeds: 'none', checks: ['connector_checkpoints'],
    summary: 'Delete connector checkpoint rows and retry pointers that no registered connector source can load and that are older than 7 days (#5686). '
      + 'Cleanup only; no journal admission. Rows a pending write still references are kept. Brain-wide.',
  },
  'request-indexes': {
    handler: requestIndexesRepair, embeds: 'none', checks: ['persistence_request_indexes'],
    summary: 'Create a missing managed sync request index, or drop an INVALID one and rebuild it (#5762), so sync checkpoints validate within their '
      + 'statement budget. Postgres builds CONCURRENTLY, one index at a time. No journal admission and no user data changes. Brain-wide.',
  },
  'connector-fences': {
    handler: connectorFencesRepair, embeds: 'effect', checks: [],
    summary: 'Move facts and takes fences that sit below the timeline sentinel of Google and GitHub pages into the page body, so connector re-renders '
      + 'carry them instead of refusing with connector_fence_below_timeline (fix wave 4). Ambiguous fences are kept and counted for a manual edit. '
      + 'Each repaired page is re-embedded by its publication.',
  },
  'orphan-bindings': {
    handler: orphanBindingsRepair, embeds: 'none', checks: ['orphan_persistence_bindings'],
    summary: 'Delete persistence source bindings whose source or source incarnation no longer exists (#5732), so a source re-added under the same id can be claimed again. '
      + 'Bookkeeping only; no journal admission. A binding a pending request still references is kept. Brain-wide.',
  },
  'embedding-effects': {
    handler: embeddingEffectsRepair, embeds: 'effect', checks: ['stale_embedding_effects'],
    summary: 'Settle stale queued or failed embedding effects of committed writes (#5629, #5734), which block receipt compaction and activation. '
      + 'Each effect is reconciled (current vectors pass the effect verifier), superseded (page deleted, or a newer revision owns its own effect), '
      + 'retry_queued for its owner (paid; a consumed retry allowance gets one new bounded cycle per explicit run) or blocked with the reason. Never drops an obligation.',
  },
  'stale-atoms': {
    handler: staleAtomsRepair, embeds: 'none', checks: ['atom_provenance_drift'], explicit_only: true,
    summary: 'Retire, by soft delete, page-bound atoms whose source page is gone, or whose source page changed after its current text was already extracted (#5770). '
      + 'Preview-bound: --apply --expect <hash> retires exactly the previewed set; an atom that changed since reports changed_since_preview and is kept. '
      + 'A later extraction that produces a retired atom again restores it. Never touches imported or file-bound atoms.',
  },
  'extractor-facts': {
    handler: extractorFactsRepair, embeds: 'none', checks: ['extractor_facts_expired'], explicit_only: true,
    summary: 'Restore conversation-extractor facts that the pre-v0.60.11.0 canonical projection expired (#5731). Restores only facts with receipt evidence '
      + '(a committed write of the page completed in the same transaction, by an older consumer); --include-ambiguous widens the hashed set to facts '
      + 'without that evidence. Preview-bound: --apply --expect <hash> restores exactly the previewed set; a fact that changed since reports '
      + 'changed_since_preview and stays expired. Superseded, withdrawn and duplicated facts are never restored. Database-only; no page is rewritten.',
  },
};

export const REPAIR_REGISTRY: readonly RepairKindSpec[] = REPAIR_KINDS.map(kind => ({ kind, ...SPECS[kind] }));

/** Whether a kind may spend on embeddings under these flags (before knowing whether a model is configured). */
export function repairMaySpend(spec: RepairKindSpec, noEmbed?: boolean): boolean {
  return spec.embeds === 'effect' || (spec.embeds === 'inline' && !noEmbed);
}

/** The kinds `--all`, the remediation plan and `gbrain repair` with no kind run, in dependency order. */
export const AUTO_REPAIR_REGISTRY: readonly RepairKindSpec[] = REPAIR_REGISTRY.filter(spec => !spec.explicit_only);

/** The explicit-only kinds, listed by those surfaces with their preview command but never run by them. */
export const EXPLICIT_REPAIR_REGISTRY: readonly RepairKindSpec[] = REPAIR_REGISTRY.filter(spec => spec.explicit_only);

export function repairSpec(kind: RepairKind): RepairKindSpec {
  return REPAIR_REGISTRY.find(spec => spec.kind === kind)!;
}

/** `gbrain repair <kind> [--source <id>]`, the read-only preview of one kind. */
export function repairPreviewCommand(kind: RepairKind, opts: { source?: string } = {}): string {
  return `gbrain repair ${kind}${opts.source ? ` --source ${opts.source}` : ''}`;
}

/** How `--all`, the remediation plan and the banner report an explicit-only kind instead of running it. */
export interface ExplicitRepairNotice { kind: RepairKind; code: 'explicit_kind_required'; preview_command: string; docs: string }

export function explicitRepairNotices(opts: { source?: string } = {}): ExplicitRepairNotice[] {
  return EXPLICIT_REPAIR_REGISTRY.map(spec => ({ kind: spec.kind, code: 'explicit_kind_required' as const,
    preview_command: repairPreviewCommand(spec.kind, opts), docs: ERROR_CATALOGUE.explicit_kind_required.docs }));
}

/** `explicit_kind_required`: an explicit-only kind reached a runner without being named. */
export function explicitKindRequired(kind: RepairKind): OperationError {
  return catalogueError('explicit_kind_required', `gbrain repair ${kind} is explicit-only and runs only when named, never from --all or a remediation step.`,
    `Preview it on the brain host: ${repairPreviewCommand(kind)}`);
}

/** The registered kind that clears a doctor check's findings, if any. */
export function repairForCheck(checkId: string): RepairKindSpec | undefined {
  return REPAIR_REGISTRY.find(spec => spec.checks.includes(checkId));
}

/** `gbrain repair <kind> --apply [--source <id>] [--no-embed]`, the exact command that applies one kind. */
export function repairApplyCommand(kind: RepairKind, opts: { source?: string; noEmbed?: boolean } = {}): string {
  return `gbrain repair ${kind}${opts.source ? ` --source ${opts.source}` : ''}${opts.noEmbed && repairSpec(kind).embeds === 'inline' ? ' --no-embed' : ''} --apply`;
}

/**
 * One local, trusted repair context shared by `gbrain repair` and the doctor
 * remediation run: the same config, embedding model and `--no-embed` handling,
 * so a kind previews and applies identically from either entry point.
 */
export async function repairRunner(engine: BrainEngine, opts: { apply: boolean; noEmbed?: boolean; logger?: OperationContext['logger'] }) {
  const config = loadConfig() ?? { engine: engine.kind };
  let embeddingModel: string | undefined;
  try { embeddingModel = config.embedding_disabled ? undefined : (await import('../ai/gateway.ts')).getEmbeddingModel(); } catch { embeddingModel = undefined; }
  const logger = opts.logger ?? { info: console.error, warn: console.error, error: console.error };
  return {
    embeddingModel,
    /** `explicit`: the operator named `kind`; required for explicit-only kinds. */
    async run(kind: RepairKind, scope: RepairScope, run: { limit?: number; sourceFlag?: string; explicit?: boolean; expect?: string; includeAmbiguous?: boolean } = {}): Promise<RepairResult> {
      const ctx = { engine, config, logger, dryRun: !opts.apply, remote: false, sourceId: scope.source_ids[0] } as OperationContext;
      const spec = repairSpec(kind);
      return runRepair(ctx, spec.handler, scope, { apply: opts.apply, limit: run.limit, embeddingModel, sourceFlag: run.sourceFlag,
        embed: !opts.noEmbed && embeddingModel !== undefined, applyArgs: opts.noEmbed && spec.embeds === 'inline' ? ['--no-embed'] : [],
        explicit: run.explicit, expect: run.expect, includeAmbiguous: run.includeAmbiguous });
    },
  };
}
