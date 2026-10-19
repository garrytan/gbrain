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
import { currentCliWriteWait } from '../persistence/write-wait.ts';
import { REPAIR_KINDS, runRepair, type RepairHandler, type RepairKind, type RepairResult, type RepairScope } from './core.ts';
import { timelineRepair } from './timeline.ts';
import { timelineCommentsRepair } from './timeline-comments.ts';
import { visibilityRepair } from './visibility.ts';
import { safeChunksRepair } from './safe-chunks.ts';
import { contextualModeRepair } from './contextual-mode.ts';
import { connectorCheckpointsRepair } from './connector-checkpoints.ts';
import { requestIndexesRepair } from './request-indexes.ts';
import { connectorFencesRepair } from './connector-fences.ts';
import { takeSupersessionRepair } from './take-supersession.ts';
import { acceptedTakesRepair } from './accepted-takes.ts';
import { orphanBindingsRepair } from './orphan-bindings.ts';
import { managedSyncOrphansRepair } from './managed-sync-orphans.ts';
import { contentReceiptRootRepair } from './content-receipt-root.ts';
import { embeddingEffectsRepair } from './embedding-effects.ts';
import { googleFileModesRepair } from './google-file-modes.ts';
import { staleAtomsRepair } from './stale-atoms.ts';
import { atomsRestoreRepair } from './atoms-restore.ts';
import { extractorFactsRepair } from './extractor-facts.ts';
import { conversationLabelsRepair } from './conversation-labels.ts';
import { capturedFactsRepair } from './captured-facts.ts';
import { loopFactsRepair } from './loop-facts.ts';
import { ontologyFactsRepair } from './ontology-facts.ts';
import { factsRehomeRepair } from './facts-rehome.ts';
import { orphanChildrenRepair } from './orphan-children.ts';
import { failedWritesRepair } from './failed-writes.ts';
import { frontmatterRepair } from './frontmatter.ts';
import { attributionBackfillRepair } from './attribution-backfill.ts';
import { plannerStatsRepair } from './planner-stats.ts';
import { fencesRepair } from './fences.ts';
import { splitFactsRepair } from './split-facts.ts';
import { slugConflictsRepair } from './slug-conflicts.ts';
import { frontmatterKeysRepair } from './frontmatter-keys.ts';
import { fileDriftRepair } from './file-drift.ts';
import { stuckRecoveryRepair } from './stuck-recovery.ts';
import { ghostPagesRepair, GHOST_CONSENT_TEXT, GHOST_CONSEQUENCES, GHOST_PURGE_FUSE_HOURS } from './ghost-pages.ts';
import { originTwinsRepair, ORIGIN_TWINS_CONSENT_TEXT, ORIGIN_TWINS_PURGE_FUSE_HOURS } from './origin-twins.ts';
import { receiptCompactionRepair } from './receipt-compaction.ts';
import { aliasesRepair } from './aliases.ts';
import { renameIdentityRepair, RENAME_IDENTITY_CONSENT_TEXT } from './rename-identity.ts';
import { overwrittenEditsRepair } from './overwritten-edits.ts';
import { missingTablesRepair } from './missing-tables.ts';
import { urlCloneFencesRepair } from './url-clone-fences.ts';
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
  /** `destructive`: the apply rewrites user files or retires stored rows, so it also needs the user's consent (`--yes` with the preview hash, or a terminal prompt). */
  consent?: 'destructive';
  /** The consent payload's wording for a destructive kind: what the apply does and how to undo it (default: the frontmatter file rewrite). */
  consentText?: { what: string; why: string; risk: string; user_message: string };
  /** `llm`: the kind may call a paid chat model; its spend is metered by the daily USD ledger and reported in `cost.llm_usd`. */
  spends?: 'llm';
  /**
   * `unbound`: the remediation approval (`--expect <plan_hash>`) leaves this kind out. Its plan follows live server
   * statistics that autovacuum changes between preview and run, and its apply changes no stored record; the run
   * still applies what is pending then.
   */
  approval?: 'unbound';
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
  'accepted-takes': {
    handler: acceptedTakesRepair, embeds: 'effect', checks: [], explicit_only: true, preview_bound: true,
    summary: 'Restore takes that accepting a held strike-through or kind change removed on v0.60.253.0 (gbrain trust confirm tp<id> ran a takes_remove '
      + 'instead of applying the change). Only what the records prove: the accepted proposal, the takes_remove receipt bound to it, the page version that '
      + 'receipt archived (the fence row the accept should have applied) and the reservation row still holding its number. --apply --expect <hash> '
      + 'republishes each page with that row (a revision-bound put_page) at the tier of the write the owner accepted. A grade or resolution only the '
      + 'database held is not in any record and is not restored. Runs only when named.',
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
  'atoms-restore': {
    handler: atomsRestoreRepair, embeds: 'effect', checks: ['atom_retirements_restorable'], explicit_only: true, preview_bound: true,
    summary: 'Restore atoms a managed re-extraction retired when its model returned no atoms for their origin (#7013, retired_by: managed-reextract). '
      + 'Only the latest retired generation of a live origin that no later extraction replaced; imported atoms, stale-atoms retirements and older '
      + 'generations are kept. Preview-bound: --apply --expect <hash> restores exactly the previewed set (managed: one revision-bound request per atom '
      + 'that writes the canonical file back, its request id in the outcome); an atom that changed since reports changed_since_preview and stays deleted. '
      + 'The purge holds these atoms for 30 days after deletion. Runs only when named; never on upgrade.',
  },
  'extractor-facts': {
    handler: extractorFactsRepair, embeds: 'none', checks: ['extractor_facts_expired'], explicit_only: true,
    summary: 'Restore conversation-extractor facts that the pre-v0.60.11.0 canonical projection expired (#5731). Restores only facts with receipt evidence '
      + '(a committed write of the page completed in the same transaction, by an older consumer); --include-ambiguous widens the hashed set to facts '
      + 'without that evidence. Preview-bound: --apply --expect <hash> restores exactly the previewed set; a fact that changed since reports '
      + 'changed_since_preview and stays expired. Superseded, withdrawn and duplicated facts are never restored. Database-only; no page is rewritten.',
  },
  'conversation-labels': {
    handler: conversationLabelsRepair, embeds: 'none', checks: ['conversation_label_facts'], explicit_only: true, consent: 'destructive',
    consentText: {
      what: 'Retire the previewed label-misattributed conversation facts in the database',
      why: 'The preview listed each fact; applying it expires exactly those rows (and the page completion markers they invalidate), with no model calls.',
      risk: 'Database rows only: no page or file changes. Retired facts are expired, not deleted, and keep "retired: conversation-labels" in their context; '
        + 'recall stops returning them. Re-extracting a page writes fresh facts (gbrain extract-conversation-facts --slugs <page> --dry-run, then with --max-cost-usd).',
      user_message: 'Retire the previewed label-misattributed conversation facts? They stop appearing in recall; the rows are expired, not deleted, and nothing calls a model.',
    },
    summary: 'Retire conversation facts the pre-v0.60.69 parser attributed to meeting-note labels (**Date:**, **Attendees:**, …) instead of speakers. '
      + 'Default set: facts whose context names a 1970-01-01 segment, which only that parser wrote; --include-ambiguous adds the other extractor facts of '
      + 'label pages, listed fact by fact. Preview-bound and destructive: --apply --expect <hash> --yes expires exactly the previewed rows, expires the '
      + 'page completion marker and writes the not-extractable outcome for prose or undated pages. No model calls; the other pages re-enter the '
      + 'extraction backlog and the preview prints the capped re-extract commands. Withdrawn, superseded and referenced facts are kept.',
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
  'ontology-facts': {
    handler: ontologyFactsRepair, embeds: 'none', checks: ['ontology_facts_fenced'], explicit_only: true,
    summary: 'Restore ontology observations that the extract_facts fence step (v0.60.53.0 until this release, #6264) moved onto an entity page\'s Facts '
      + 'table: each gets its own provenance back, leaves the fence and, if a later page write retired it, becomes active again. Withdrawn, consolidated '
      + 'and duplicated observations are never restored. Preview-bound: --apply --expect <hash> restores exactly the previewed set; a row that changed '
      + 'since reports changed_since_preview. Database-only; no page is rewritten.',
  },
  'facts-rehome': {
    handler: factsRehomeRepair, embeds: 'none', checks: [], explicit_only: true, preview_bound: true,
    summary: 'Move facts off an entity slug no page answers for (#6925: companies/x minted while the page is orgs/x) onto the page the strict resolver '
      + 'reaches by identity evidence (exact page, organization directory variant, unique alias; never a bare-name guess). The preview lists every '
      + 'page-less slug with its class; ambiguous, unverified, unresolved and fence-owned slugs are listed and never moved. Preview-bound: --apply '
      + '--expect <hash> moves exactly the previewed database-only facts; a slug that gained a page, lost its target or whose facts changed reports '
      + 'changed_since_preview. Database-only; no page is rewritten.',
  },
  'orphan-children': {
    handler: orphanChildrenRepair, embeds: 'none', checks: ['child_table_orphans'], explicit_only: true,
    summary: 'Delete rows of page child tables (chunks, versions, tags, takes, raw data, timeline, links) whose page no longer exists, and clear dangling '
      + 'links.origin_page_id and files.page_id references (#5216, #4738). The preview also probes every page body and reports torn TOAST rows '
      + '(SQLSTATE XX000) as torn_pages without changing them. Bookkeeping only; no journal admission. Brain-wide; runs only when named.',
  },
  'failed-writes': {
    handler: failedWritesRepair, embeds: 'effect', checks: ['lost_caller_writes'], explicit_only: true,
    summary: 'Resubmit caller writes (put_page, add_timeline_entry, remember) that the managed writer guard refused before v0.60.38.0 (#5983) or that ended '
      + 'conflict with source_changed because the page\'s file and database differed (#6429), from the intent their terminal receipt retains until receipt compaction. A write is kept when a later request with the same intent committed (already_written) '
      + 'or is pending (duplicate), or a later write or delete of the page committed (superseded). Writes gbrain itself produced (sync and file imports, '
      + 'reconcile, relink, maintenance) are counted with the command that produces them again. Preview-bound: --apply --expect <hash> replays exactly '
      + 'the previewed set under new request ids, after re-checking each write\'s original authority; the failed receipts stay as history.',
  },
  'split-facts': {
    handler: splitFactsRepair, embeds: 'effect', checks: [], explicit_only: true,
    summary: 'Merge the two ## Facts fences of a page whose fence lived below the timeline sentinel and to which a managed writer before this release '
      + 'added a second fence above it (#6686). The merged fence stays below the sentinel and keeps every row of both fences under its own row number; '
      + 'the body fence goes, with its ## Facts heading when that holds nothing else. A page is kept when a fence does not parse (unparsed), a row '
      + 'number is in both fences (row_collision: a person chooses), or the merged page would not read back exactly (not_conserved). Preview-bound: '
      + '--apply --expect <hash> merges exactly the previewed pages through revision-bound put_page (changed_since_preview when a page moved). Runs only when named.',
  },
  frontmatter: {
    handler: frontmatterRepair, embeds: 'effect', checks: ['git_held_files', 'frontmatter_repairable'], explicit_only: true, consent: 'destructive',
    summary: 'Fix files whose YAML frontmatter gbrain holds or reads only by guessing (#5988), and pages an older import stored wrong: per file the minimal '
      + 'line change (safe: quoting a value as gbrain already reads it, NUL bytes, nested quotes; interpretive with --include-ambiguous: folded lines, '
      + 'duplicate keys, #-leading titles, a missing closing fence, a conflicting slug line, re-imports and rename re-binds). --only/--skip <path> '
      + 'select files. Preview-bound: --apply --expect <hash> --yes writes exactly the previewed bytes, imports them and clears the hold (managed '
      + 'sources commit through the Git effect; legacy sources back up first and print the commit step). Files no rule fixes are listed with the exact manual fix.',
  },
  'timeline-comments': {
    handler: timelineCommentsRepair, embeds: 'effect', checks: [], explicit_only: true,
    summary: 'Clean timeline rows filed from adjacent HTML comments (#6184): drop the materialized bullets that copied a section END marker into the page, '
      + 'delete rows that are only comment markup, and strip the markup from the rest. Each page whose bullets change is re-embedded by its publication.',
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
  'slug-conflicts': {
    handler: slugConflictsRepair, embeds: 'effect', checks: [], preview_bound: true, spends: 'llm',
    summary: 'Clear frontmatter_slug_conflict sync holds (#6377): a file whose frontmatter slug: names another page. A stray slug (no such page and no such '
      + 'file, or a page of another type with no title word in common) loses the slug: line deterministically; anything else is judged by the content-repair '
      + 'model (models.content_repair, else models.fence_repair, else the measured list) under the fences.repair caps and the same daily ledger as fences: '
      + 'remove_slug applies the one-line edit, merge_into and needs_human write nothing and record the recommendation on the hold for a person '
      + '(gbrain sync status shows the paragraph). Managed sources commit through the Git effect with a gbrain-repair: trailer, legacy sources back up and '
      + 'print the commit step. --only/--skip <path> select; --no-llm keeps to the deterministic tier; --max-usd <n> lowers the model cap for this run. '
      + 'Preview-bound: --apply --expect <hash> applies exactly the previewed set. gbrain repair content runs fences, then this kind.',
  },
  'planner-stats': {
    handler: plannerStatsRepair, embeds: 'none', checks: ['planner_stats_stale'], approval: 'unbound',
    summary: 'ANALYZE the hot tables (pages, links, facts, takes, content_chunks, timeline_entries) whose planner statistics are stale (F4b), '
      + 'so search and graph reads stop planning as slow nested loops. PGLite also resets each table\'s pending row count; Postgres runs each '
      + 'ANALYZE with a 60 s statement and 2 s lock timeout. No journal admission and no user data changes. Brain-wide.',
  },
  'managed-sync-orphans': {
    handler: managedSyncOrphansRepair, embeds: 'none', checks: ['sync_failures'], explicit_only: true, preview_bound: true,
    summary: 'Retire managed sync bookkeeping nothing current can resume or clear (#5459): failure rows whose cursor key has no cursor, and unfinished '
      + 'cursors recorded by a principal that is no longer an active local writer (or superseded pre-options cursors) whose pending request is terminal. '
      + 'Bookkeeping only (op_checkpoints); no journal admission. The preview prints a hash; --apply --expect <hash> retires exactly that set. '
      + 'A cursor with a live pending request, or one the live writer can still resume, is kept and counted.',
  },
  'content-receipt-root': {
    handler: contentReceiptRootRepair, embeds: 'none', checks: ['sync_freshness'], explicit_only: true, preview_bound: true,
    summary: 'Rebind a gbrain-owned content source\'s shared-skills content receipt that still names an old root after a writer transfer or relocation (#6892), '
      + 'so doctor sync_freshness exempts the source again. Owner host only; rebinds only when the owner\'s tree still hashes to the recorded worktree manifest, '
      + 'and otherwise lists why (source_path_mismatch: run sources set-path; tree_mismatch: a self-transfer re-verifies). The receipt row only; the previous '
      + 'value is kept under <key>.backup. Preview-bound: --apply --expect <hash> rebinds exactly the previewed set.',
  },
  'frontmatter-keys': {
    handler: frontmatterKeysRepair, embeds: 'none', checks: ['stale_frontmatter_keys'], explicit_only: true, preview_bound: true,
    summary: 'Strip the parser\'s reserved keys (type, title, tags, slug) that older imports stored inside pages.frontmatter (#6454). Since this release '
      + 'those keys are not file/database drift and never render, so the sweep is hygiene: database rows only, in source-scoped coordinated batches of up '
      + 'to 1,000 pages, no file, body or embedding change. Each swept page advances its knowledge_revision once (a client holding an older revision '
      + 'gets one revision_conflict). Preview-bound: --apply --expect <hash> sweeps exactly the previewed set; runs only when named.',
  },
  'file-drift': {
    handler: fileDriftRepair, embeds: 'effect', checks: ['maintenance_write_drift'], explicit_only: true, preview_bound: true,
    summary: 'Resolve pages whose canonical file differs from the database (source_changed / file_database_drift, #6643) through canonical reconciliation: '
      + '--prefer file or --prefer database wins every ordinary field, within reconcile\'s protections (protected metadata stays as stored, tags are '
      + 'the union, protected takes and private fact rows are kept; the preview lists each page\'s exceptions). Select with --slug <slug>, --request '
      + '<conflict request id> or --all-drifted (refused across mixed drift classes unless --class <name> keeps one), narrowed by --only/--skip '
      + 'canonical file path globs (* within a segment, ** across; bound into the hash and the apply command). Needs --source. The preview '
      + 'writes each resolved result to a private artifact; --apply --expect <hash> applies exactly that set with request ids derived from the hash, '
      + 'resumable, per page repaired, refused or changed_since_preview. Backups are reconcile\'s own. A selected page whose canonical file is gone from the '
      + 'last commit: --prefer database recreates the file from the page, --prefer file soft-deletes exactly that page (mass-delete valve applies); a file '
      + 'deleted only in the worktree is listed deletion_uncommitted and routed to committing the deletion or repair ghost-pages. Trusted local CLI only; runs only when named.',
  },
  'stuck-recovery': {
    handler: stuckRecoveryRepair, embeds: 'none', checks: [], explicit_only: true, preview_bound: true, consent: 'destructive',
    consentText: {
      what: 'Resolve the previewed stuck publication recovery by keeping the chosen version of each blocked file',
      why: 'The preview listed each blocked file with its recorded prior and its bytes on disk and wrote their diff; the apply keeps the version the user chose so the owner can finish the recovery.',
      risk: 'Both the disk bytes and the prior bytes are backed up under ~/.gbrain/backups/stuck-recovery/ before anything changes. --keep prior overwrites the edited file and lets the accepted write publish again; --keep disk keeps the edit and abandons the write (it ends conflict). Terminal requests are never changed.',
      user_message: 'Resolve the stuck recovery as previewed? The other version is kept only in the backup directory',
    },
    summary: 'Resolve a page publication recovery blocked on unexpected_file_bytes (#6650): a file that matches neither its recorded prior nor its '
      + 'published bytes, which stops every write on its worktree. The preview starts from the head blocker, lists each file of each blocked record '
      + '(prior and disk hash, size and mode) and writes a private diff to ~/.gbrain/backups/stuck-recovery/. --request-id <uuid> selects one request. '
      + 'Apply on the owner host with --apply --expect <hash> --keep prior|disk --yes (no default): both versions are backed up first; prior writes the recorded '
      + 'bytes back and the accepted write publishes again, disk keeps the edit and abandons the write (reconcile the page afterwards). A file over 24 MiB is '
      + 'hashed, copied and compared in pieces, and its diff is a bounded summary. A terminal request is '
      + 'refused (recovery_choice_refused). Runs only when named.',
  },
  'ghost-pages': {
    handler: ghostPagesRepair, embeds: 'none', checks: ['ghost_pages'], explicit_only: true, preview_bound: true, consent: 'destructive',
    consentText: GHOST_CONSENT_TEXT,
    summary: 'Soft-delete live pages whose canonical file is missing on the owner host (ghost pages, #6696): every write to them refuses source_changed / '
      + 'canonical_file_missing and no sync can import a file that is not there. Needs --source; refused off the canonical owner host (not_owner_host) '
      + 'and when the checkout cannot be read (ghost_storage_unknown). Declared db_only and never-filed derived pages are never listed. The preview lists '
      + 'each page with its recorded path and revision, bound to the owner; --apply --expect <hash> --yes soft-deletes exactly that set through delete_page, '
      + 'rechecking each file is still absent (a restored file keeps its page and asks for a new preview). Refused when ghosts are over half of the source\'s '
      + `file-backed pages unless GBRAIN_ALLOW_MASS_RECONCILE=1. Purged after ${GHOST_PURGE_FUSE_HOURS} h; ${GHOST_CONSEQUENCES.undo} Runs only when named.`,
  },
  'origin-twins': {
    handler: originTwinsRepair, embeds: 'none', checks: ['origin_twins'], explicit_only: true, preview_bound: true, consent: 'destructive',
    consentText: ORIGIN_TWINS_CONSENT_TEXT,
    summary: 'Resolve duplicate-origin twins (#6948): several live pages of one source recording the same file, which sync holds origin_conflict. Needs --source; '
      + 'refused off the canonical owner host. A group whose pages are verified duplicates (the page the path names, one body, readable file, compatible ids, one '
      + 'visibility and trust tier, no slug-keyed withdrawals, no file at a twin\'s slug path, no evidence the merge would lose) is merged: links, relationship dates, '
      + 'timeline, raw data, user tags, aliases and facts move to the canonical page, the twin\'s slug becomes an alias, and the twin is soft-deleted (the file stays) '
      + `and purged after ${ORIGIN_TWINS_PURGE_FUSE_HOURS} h; the receipt lists the twin\'s frontmatter keys the survivor lacks and the restore command. Any other group is listed with the `
      + 'commands to decide it; --slug <kept-slug> then only detaches the other pages (they forget the file and stay live). Refused when merges are over half of '
      + 'the source\'s file-backed pages unless GBRAIN_ALLOW_MASS_RECONCILE=1. Once no source has a group, --apply builds the pages_live_origin_key index. '
      + 'Preview-bound: --apply --expect <hash> --yes resolves exactly the previewed set. Runs only when named.',
  },
  'receipt-compaction': {
    handler: receiptCompactionRepair, embeds: 'none', checks: ['persistence_capacity'], explicit_only: true, preview_bound: true, consent: 'destructive',
    consentText: {
      what: 'Compact the previewed terminal write receipts now',
      why: 'The preview selected terminal receipts older than the cutoff it printed; compacting them drops each one\'s intent and error message and returns its unused receipt bytes to the capacity counters.',
      risk: 'Database rows only. A compacted receipt still answers its request id with its outcome, error code and detail, but its original intent is gone and cannot be restored. Open sync runs and the newest sync receipt of each worktree are never touched.',
      user_message: 'Compact the previewed write receipts? Their original request bodies are dropped for good; outcomes stay',
    },
    summary: 'Compact terminal write receipts now instead of waiting for idle maintenance (#6696), returning their unused receipt bytes. Same compaction as the '
      + 'consumer: the intent and error message go, the outcome, error code and detail stay. --older-than <72h|30d> is floored at the configured retention '
      + '(persistence.receipt_retention_days) unless --force; committed receipts only unless --include-failures. Receipts of a run whose sync cursor is '
      + 'open, and the newest sync receipt per worktree, are kept. Preview-bound and destructive: --apply --expect <hash> --yes compacts only the '
      + 'previewed set. No admission, so it runs at a full cap. Brain-wide. Runs only when named.',
  },
  aliases: {
    handler: aliasesRepair, embeds: 'none', checks: ['dangling_aliases'], explicit_only: true,
    summary: 'Delete free-text page aliases and slug redirects whose target page has no row at all (purged or hard-deleted, #6619), which doctor '
      + 'dangling_aliases reports as orphaned. Aliases of a soft-deleted page are kept for gbrain restore and counted; a redirect from an old name '
      + 'of a page that still exists is never touched. Each target slug is rechecked under its page lock; coordinated maintenance write on a managed '
      + 'brain, no journal admission. Runs only when named.',
  },
  'rename-identity': {
    handler: renameIdentityRepair, embeds: 'none', checks: ['rename_identity_downgrades'], explicit_only: true, preview_bound: true, consent: 'destructive',
    consentText: RENAME_IDENTITY_CONSENT_TEXT,
    summary: 'Carry the page identity across an inexact Git rename that sync split into a delete plus an add (#6729): the operator picks the pair '
      + '(--source <id> --slug <new-slug>, --from <old-slug> when two pairs share it); without --slug the preview lists the open pairs and their '
      + 'preview commands. --apply --expect <hash> --yes moves the old page id to the new slug (version history, timeline, links and facts stay on it), '
      + 'imports the new file onto it as an edit, retires the provisional page purge-style (soft-deleted, nothing hard-deleted) and records the '
      + 'old -> new redirect; fence rows that would collide refuse fact_rows_collide before anything is written. --close releases the purge hold and '
      + 'moves nothing. Carry is classic-only: on a managed source the preview states managed_remedy_unavailable, an apply refuses with it, and --close is the remedy. Runs only when named.',
  },
  'overwritten-edits': {
    handler: overwrittenEditsRepair, embeds: 'effect', checks: ['sync_overwritten_db_edits'], explicit_only: true, preview_bound: true,
    summary: 'Restore database edits an incremental managed sync overwrote with a committed file edit and no file_drift hold (#6712, fixed by #6887). '
      + 'Only what the records prove: a database-only revision (its receipt published no file) archived by a managed-sync import that wrote different '
      + 'content, with no later revision holding the edit again. The preview shows a diff of the live page against the edit; --apply --expect <hash> '
      + 'reverts each page to that version through a revision-bound, database-only revert_version, then holds the committed file file_drift when it '
      + 'differs, so sync never publishes it over the edit. Narrow with --slug. Runs only when named.',
  },
  'missing-tables': {
    handler: missingTablesRepair, embeds: 'none', checks: ['schema_missing_tables'], explicit_only: true, preview_bound: true,
    summary: 'Recreate, empty, a rebuildable cache table (query_cache, code_traversal_cache) that the applied migrations created but the brain no longer '
      + 'has (#6911), so the coordinated purge and search caching work again. A missing table that holds user data is listed for a restore, never '
      + 'recreated. DDL only (IF NOT EXISTS), no journal admission. The preview prints a hash; --apply --expect <hash> recreates exactly that set. '
      + 'Runs only when named; never on upgrade. Brain-wide.',
  },
  'url-clone-fences': {
    handler: urlCloneFencesRepair, embeds: 'none', checks: [], explicit_only: true, preview_bound: true, consent: 'destructive',
    consentText: {
      what: 'Restore the previewed files of a clone gbrain owns from HEAD after keeping their gbrain fence rows database-only',
      why: 'An older release appended ## Facts fence rows to these clone files, and the local change blocks every git pull --ff-only that touches them; the preview proved each file differs from HEAD by those rows alone.',
      risk: 'Each file is backed up under ~/.gbrain/backups/url-clone-fences/ before it changes, and its fact rows stay active and recallable in the database. A file that changed since the preview is skipped. Copy the backup back to undo.',
      user_message: 'Restore the previewed clone files from the last pulled commit? Their facts stay in the database and each file is backed up first',
    },
    summary: 'Clear the local changes an older release left in a gbrain-owned clone (sources add --url), which make every sync stop at the pull with '
      + 'pull_blocked_local_changes (#6946). The preview lists each tracked file that differs from HEAD and proves the difference is only ## Facts fence '
      + 'rows gbrain appended; any other difference (a user edit, a staged change, a deleted file) is named and left untouched. --apply --expect <hash> --yes, '
      + 'per previewed file: back it up, keep its appended rows database-only in one transaction, import HEAD\'s bytes as the page, then restore the file '
      + 'from HEAD. Unmanaged brains only (a managed brain uses gbrain sources mirror-readonly). Runs only when named.',
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
  // #6185: an apply waits for each publication like every other CLI write (`--wait`, GBRAIN_WRITE_WAIT_MS,
  // persistence.write_wait_ms, else 30 s). Resolved before any kind runs, so a malformed value refuses before
  // a checkpoint is written; a preview never publishes and never reads it.
  const writeWaitMs = opts.apply ? currentCliWriteWait().waitMs : undefined;
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
      slugs?: string[]; noLlm?: boolean; maxLlmUsd?: number; deadline?: number;
      prefer?: 'file' | 'database'; requests?: string[]; allDrifted?: boolean; driftClass?: string; since?: string;
      keep?: 'prior' | 'disk' | 'withdrawn'; requestId?: string; olderThan?: string; includeFailures?: boolean; force?: boolean; from?: string; close?: boolean } = {}): Promise<RepairResult> {
      const ctx = { engine, config, logger, dryRun: !opts.apply, remote: false, sourceId: scope.source_ids[0], writeWaitMs } as OperationContext;
      const spec = repairSpec(kind, opts.registry);
      return runRepair(ctx, spec.handler, scope, { apply: opts.apply, limit: run.limit, embeddingModel, sourceFlag: run.sourceFlag, spec,
        embed: !opts.noEmbed && embeddingModel !== undefined, applyArgs: [...(opts.noEmbed && spec.embeds === 'inline' ? ['--no-embed'] : []),
          ...(run.olderThan ? ['--older-than', run.olderThan] : []), ...(run.includeFailures ? ['--include-failures'] : []), ...(run.force ? ['--force'] : [])],
        explicit: run.explicit, expect: run.expect, includeAmbiguous: run.includeAmbiguous, only: run.only, skip: run.skip, slugs: run.slugs, noLlm: run.noLlm,
        maxLlmUsd: run.maxLlmUsd, deadline: run.deadline, prefer: run.prefer, requests: run.requests, allDrifted: run.allDrifted, driftClass: run.driftClass, since: run.since,
        keep: run.keep, requestId: run.requestId, olderThan: run.olderThan, includeFailures: run.includeFailures, force: run.force, from: run.from, close: run.close });
    },
  };
}
