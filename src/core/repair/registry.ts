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
 * `spends: 'llm'` kinds may also call a paid chat model; every surface that
 * counts paid work (`repairMaySpend`, the remediation plan's `paid` and
 * `est_usd_cost`) includes that spend, and `repairRunner` passes a run's
 * remaining allowance through as `maxLlmUsd`.
 *
 * `preview_bound` kinds print a preview hash, and `--apply --expect <hash>`
 * applies exactly the previewed set (`changed_since_preview` for anything that
 * moved); it is independent of `explicit_only`, so a preview-bound kind that
 * is not explicit-only also runs from `--all`, the remediation plan and the
 * maintenance cycle with a bare `--apply` (the current plan).
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
import { takeSupersessionRepair } from './take-supersession.ts';
import { orphanBindingsRepair } from './orphan-bindings.ts';
import { embeddingEffectsRepair } from './embedding-effects.ts';
import { googleFileModesRepair } from './google-file-modes.ts';
import { staleAtomsRepair } from './stale-atoms.ts';
import { extractorFactsRepair } from './extractor-facts.ts';
import { capturedFactsRepair } from './captured-facts.ts';
import { loopFactsRepair } from './loop-facts.ts';
import { orphanChildrenRepair } from './orphan-children.ts';
import { failedWritesRepair } from './failed-writes.ts';
import { frontmatterRepair } from './frontmatter.ts';
import { attributionBackfillRepair } from './attribution-backfill.ts';
import { plannerStatsRepair } from './planner-stats.ts';
import { fencesRepair } from './fences.ts';
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
  /** The preview prints a hash and `--apply --expect <hash>` applies exactly that set (accepted with or without `explicit_only`). */
  preview_bound?: true;
  /** `destructive`: the apply rewrites user files, so it also needs the user's consent (`--yes` with the preview hash, or a terminal prompt). */
  consent?: 'destructive';
  /** `llm`: the kind may call a paid chat model; its spend is metered by the daily USD ledger and reported in `cost.llm_usd`. */
  spends?: 'llm';
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
  'take-supersession': {
    handler: takeSupersessionRepair, embeds: 'effect', checks: [],
    summary: 'Rebuild takes.superseded_by for supersession chains written before the pointer moved onto the old fence row (#5886). Each struck row is linked '
      + 'to the row that replaced it only from evidence: a committed takes_supersede receipt, a stored superseded_by, or a row carrying the old '
      + '`superseded by #<own row>` pointer with exactly one possible predecessor. The pointer is written onto the old row and stale self-pointers are '
      + 'dropped through a revision-bound put_page; a page whose fence is right but whose stored pointers differ is reprojected. Ambiguous pages are '
      + 'listed with the manual edit and never changed.',
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
  'attribution-backfill': {
    handler: attributionBackfillRepair, embeds: 'none', checks: [],
    summary: 'Fill write attribution (who wrote it) on pages, page versions and facts written before attribution was recorded, only where exactly one '
      + 'committed request in the write journal proves the writer: the page mutation whose outcome revision is the row\'s revision, or the remember '
      + 'that inserted the fact. Fills NULLs only, in committed batches of 1,000 that resume after an interruption. Everything else stays NULL and reads '
      + 'as unrecorded. Bookkeeping only; no journal admission, no content or revision change.',
  },
  'google-file-modes': {
    handler: googleFileModesRepair, embeds: 'none', checks: ['google_file_modes'], explicit_only: true,
    summary: 'Clear group and other permission bits on files and directories gbrain wrote under a Google source directory outside ~/.gbrain '
      + '(cursor state, mail/calendar/contact pages and the subdirectories gbrain laid out), written before this release with the default umask. '
      + 'Never the directory you chose, never through a symlink, never another user\'s file. Filesystem only; runs only when named (`gbrain repair google-file-modes`).',
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
  'captured-facts': {
    handler: capturedFactsRepair, embeds: 'effect', checks: ['captured_facts_active'], explicit_only: true,
    summary: 'Expire facts the capture lanes (writeback, compact, corpus sweep) extracted before v0.60.30.0 from gbrain\'s own claude-cli sessions '
      + '(evidence: a scratch-project harness transcript or a quarantined corpus file). Paste-derived facts are found by a heuristic over the retained '
      + 'corpus file and expire only with --include-ambiguous. A claim that also has an active copy from another lane is kept. Preview-bound: --apply '
      + '--expect <hash> expires exactly the previewed set; a fact that changed since reports changed_since_preview. Rows are expired, never withdrawn, '
      + 'so remember can save the same claim again; fenced rows are struck in their page, which is re-embedded by its publication.',
  },
  'loop-facts': {
    handler: loopFactsRepair, embeds: 'effect', checks: ['loop_facts_drift'], explicit_only: true,
    summary: 'Retire the commitment facts of loops closed before this release (#5869): expires each fact and strikes its fence row in one coordinated write, '
      + 'only when no open loop shares the fact. Preview-bound: --apply --expect <hash> retires exactly the previewed set; a loop or fact that changed since '
      + 'reports changed_since_preview and is kept. Never writes a withdrawal, so the same promise made again is stored normally.',
  },
  'orphan-children': {
    handler: orphanChildrenRepair, embeds: 'none', checks: ['child_table_orphans'], explicit_only: true,
    summary: 'Delete rows of page child tables (chunks, versions, tags, takes, raw data, timeline, links) whose page no longer exists, and clear dangling '
      + 'links.origin_page_id and files.page_id references (#5216, #4738). The preview also probes every page body and reports torn TOAST rows '
      + '(SQLSTATE XX000) as torn_pages without changing them. Bookkeeping only; no journal admission. Brain-wide; runs only when named.',
  },
  'failed-writes': {
    handler: failedWritesRepair, embeds: 'effect', checks: [], explicit_only: true,
    summary: 'Resubmit caller writes (put_page, add_timeline_entry, remember) that the managed writer guard refused before v0.60.38.0 (#5983), from the '
      + 'intent their failed receipt retains until receipt compaction. A write is kept when a later request with the same intent committed (already_written) '
      + 'or is pending (duplicate), or a later write or delete of the page committed (superseded). Writes gbrain itself produced (sync and file imports, '
      + 'reconcile, relink, maintenance) are counted with the command that produces them again. Preview-bound: --apply --expect <hash> replays exactly '
      + 'the previewed set under new request ids, after re-checking each write\'s original authority; the failed receipts stay as history.',
  },
  frontmatter: {
    handler: frontmatterRepair, embeds: 'effect', checks: ['git_held_files', 'frontmatter_repairable'], explicit_only: true, consent: 'destructive',
    summary: 'Fix files whose YAML frontmatter gbrain holds or reads only by guessing (#5988), and pages an older import stored wrong: per file the minimal '
      + 'line change (safe: quoting a value as gbrain already reads it, NUL bytes, nested quotes; interpretive with --include-ambiguous: folded lines, '
      + 'duplicate keys, #-leading titles, a missing closing fence, a conflicting slug line, re-imports and rename re-binds). --only/--skip <path> '
      + 'select files. Preview-bound: --apply --expect <hash> --yes writes exactly the previewed bytes, imports them and clears the hold (managed '
      + 'sources commit through the Git effect; legacy sources back up first and print the commit step). Files no rule fixes are listed with the exact manual fix.',
  },
  fences: {
    handler: fencesRepair, embeds: 'effect', checks: ['fence_integrity'], preview_bound: true, spends: 'llm',
    summary: 'Repair malformed facts and takes fences (#6188) that sync held or that pages store: per file or page the free tiers first (the lossless '
      + 'Tier 1 rules, then holder names verified against people/ and companies/ pages), then, for rows only a model can realign, the configured '
      + 'chat model (models.fence_repair) sees only the header and those rows under the fences.repair caps. Every proposal passes the validation gates '
      + '(a)-(g) and is a Tier 1 fixed point, or it is not written. Managed sources commit through the Git effect, legacy sources back up and print '
      + 'the commit step, database-only pages take a revision-bound write. --only/--skip <path> and --slug <slug> select; --no-llm keeps to the free '
      + 'tiers; --max-usd <n> lowers the model cap for this run. Preview-bound: --apply --expect <hash> applies exactly the previewed set.',
  },
  'planner-stats': {
    handler: plannerStatsRepair, embeds: 'none', checks: ['planner_stats_stale'],
    summary: 'ANALYZE the hot tables (pages, links, facts, takes, content_chunks, timeline_entries) whose planner statistics are stale (F4b), '
      + 'so search and graph reads stop planning as slow nested loops. PGLite also resets each table\'s pending row count; Postgres runs each '
      + 'ANALYZE with a 60 s statement and 2 s lock timeout. No journal admission and no user data changes. Brain-wide.',
  },
};

export const REPAIR_REGISTRY: readonly RepairKindSpec[] = REPAIR_KINDS.map(kind => ({ kind, ...SPECS[kind] }));

/** Whether a kind may spend on embeddings under these flags (before knowing whether a model is configured). */
export function repairMayEmbed(spec: RepairKindSpec, noEmbed?: boolean): boolean {
  return spec.embeds === 'effect' || (spec.embeds === 'inline' && !noEmbed);
}

/** Whether a kind may spend at all under these flags: on embeddings, or on a paid chat model (`spends: 'llm'`). */
export function repairMaySpend(spec: RepairKindSpec, noEmbed?: boolean): boolean {
  return spec.spends === 'llm' || repairMayEmbed(spec, noEmbed);
}

/** The kinds `--all`, the remediation plan and `gbrain repair` with no kind run, in dependency order. */
export const AUTO_REPAIR_REGISTRY: readonly RepairKindSpec[] = REPAIR_REGISTRY.filter(spec => !spec.explicit_only);

/** The explicit-only kinds, listed by those surfaces with their preview command but never run by them. */
export const EXPLICIT_REPAIR_REGISTRY: readonly RepairKindSpec[] = REPAIR_REGISTRY.filter(spec => spec.explicit_only);

/** The kinds whose `--apply` accepts `--expect <hash>`: explicit-only kinds and preview-bound ones. */
export const PREVIEW_BOUND_REPAIR_REGISTRY: readonly RepairKindSpec[] = REPAIR_REGISTRY.filter(spec => spec.explicit_only || spec.preview_bound);

/** The kinds that may call a paid chat model, the only ones `--max-usd` applies to. */
export const LLM_REPAIR_REGISTRY: readonly RepairKindSpec[] = REPAIR_REGISTRY.filter(spec => spec.spends === 'llm');

/** `registry`: the kinds to look in; production callers use the registered ones, tests pass stub specs. */
export function repairSpec(kind: RepairKind, registry: readonly RepairKindSpec[] = REPAIR_REGISTRY): RepairKindSpec {
  return registry.find(spec => spec.kind === kind)!;
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
 * `registry` replaces the registered kinds (tests register stub specs here).
 */
export async function repairRunner(engine: BrainEngine, opts: { apply: boolean; noEmbed?: boolean; logger?: OperationContext['logger']; registry?: readonly RepairKindSpec[] }) {
  const config = loadConfig() ?? { engine: engine.kind };
  let embeddingModel: string | undefined;
  try { embeddingModel = config.embedding_disabled ? undefined : (await import('../ai/gateway.ts')).getEmbeddingModel(); } catch { embeddingModel = undefined; }
  const logger = opts.logger ?? { info: console.error, warn: console.error, error: console.error };
  return {
    embeddingModel,
    /**
     * `explicit`: the operator named `kind`; required for explicit-only kinds.
     * `maxLlmUsd`: what this run may spend on a paid chat model (`spends: 'llm'` kinds; undefined = no run cap).
     */
    async run(kind: RepairKind, scope: RepairScope, run: { limit?: number; sourceFlag?: string; explicit?: boolean; expect?: string; includeAmbiguous?: boolean; only?: string[]; skip?: string[];
      slugs?: string[]; noLlm?: boolean; maxLlmUsd?: number; deadline?: number } = {}): Promise<RepairResult> {
      const ctx = { engine, config, logger, dryRun: !opts.apply, remote: false, sourceId: scope.source_ids[0] } as OperationContext;
      const spec = repairSpec(kind, opts.registry);
      return runRepair(ctx, spec.handler, scope, { apply: opts.apply, limit: run.limit, embeddingModel, sourceFlag: run.sourceFlag, spec,
        embed: !opts.noEmbed && embeddingModel !== undefined, applyArgs: opts.noEmbed && spec.embeds === 'inline' ? ['--no-embed'] : [],
        explicit: run.explicit, expect: run.expect, includeAmbiguous: run.includeAmbiguous, only: run.only, skip: run.skip, slugs: run.slugs, noLlm: run.noLlm,
        maxLlmUsd: run.maxLlmUsd, deadline: run.deadline });
    },
  };
}
