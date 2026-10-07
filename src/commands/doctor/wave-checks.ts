/**
 * Wave checks: the doctor checks that report residual state from the managed
 * persistence waves, each with a stable id and a declared resolution. One
 * table feeds four consumers so they can never disagree:
 *
 *   - the local doctor (checks registered here rather than inline in doctor.ts),
 *   - the remote doctor's sanitized host-action lines (report-remote.ts),
 *   - `gbrain doctor --remediate` finding classification,
 *   - the `gbrain post-upgrade` banner.
 *
 * `resolution` says how a non-ok finding clears: `repair` (a registered
 * `gbrain repair` kind names this check in its `checks`), `operator` (a named
 * manual action on the brain host), or `unsupported` (no command can clear it
 * yet; it is reported, never hidden). Add a check by appending one entry.
 */
import type { BrainEngine } from '../../core/engine.ts';
import type { Check } from '../doctor.ts';
import { repairForCheck } from '../../core/repair/registry.ts';

export type WaveResolution = 'repair' | 'operator' | 'unsupported';

export interface WaveScope {
  /** Remote source scope; undefined means brain-wide (local trusted callers). */
  sourceIds?: string[];
}

export interface WaveCheckSpec {
  id: string;
  resolution: WaveResolution;
  /** Count-free, path-free impact line safe for remote callers. */
  impact: string;
  /** The named instruction for an operator-required or unsupported finding. */
  instruction?: string;
  /** Where the local doctor runs it: inline in doctor.ts, or from this table. */
  registration: 'doctor.ts' | 'wave';
  /** Reason the check is not offered to remote callers, if any. */
  hostOnly?: string;
  /** Items behind a finding, read from the check's details (host-side banners only). */
  count(details: Record<string, any>): number;
  /**
   * The banner's parenthetical when the finding's details change it: `how` is the
   * default from the resolution, `source` the one source the finding names.
   */
  bannerHow?(details: Record<string, any>, how: string, source?: string): string;
  run(engine: BrainEngine, scope: WaveScope): Promise<Check>;
}

/**
 * #6188 (D7): what clears malformed fences, from a check's `auto_repair` detail: the next maintenance run while
 * one is active and `fences.repair.enabled` is on, otherwise `gbrain repair fences` (whose preview prints the apply command).
 */
function fenceRepairHow(details: Record<string, any>, source?: string): string {
  const preview = `preview with: gbrain repair fences${source ? ` --source ${source}` : ''}`;
  const auto = details.auto_repair as { active?: boolean; enabled?: boolean } | undefined;
  if (auto && auto.active === false) return `not repaired automatically (${auto.enabled === false ? 'fences.repair.enabled is false' : 'no maintenance run is active'}); ${preview}`;
  const manual = Array.isArray(details.sources) ? details.sources.reduce((sum: number, c: { by_tier?: { manual?: number } }) => sum + Number(c.by_tier?.manual ?? 0), 0) : 0;
  return `repaired automatically by the next maintenance run${manual ? `, except ${manual} that need a manual edit` : ''}; ${preview}`;
}

/** Checks that take one optional source id: run once brain-wide, or once per scoped source and merged. */
async function perSource(scope: WaveScope, run: (sourceId?: string) => Promise<Check>): Promise<Check> {
  if (!scope.sourceIds) return run();
  const checks = await Promise.all(scope.sourceIds.map(id => run(id)));
  const worst = checks.find(c => c.status === 'fail') ?? checks.find(c => c.status === 'warn') ?? checks[0];
  return worst ?? { name: '', status: 'ok', message: '' };
}

export const WAVE_CHECKS: readonly WaveCheckSpec[] = [
  {
    id: 'timeline_history', resolution: 'repair', registration: 'doctor.ts',
    count: d => Number(d.materializable_rows ?? 0),
    impact: 'Some timeline rows exist only in the database and are missing from their pages',
    run: async (engine, scope) => { const { timelineHistoryCheck } = await import('./checks/timeline-history.ts'); return perSource(scope, id => timelineHistoryCheck(engine, id)); },
  },
  {
    id: 'derived_visibility', resolution: 'repair', registration: 'doctor.ts',
    count: d => Number(d.unstamped_atoms ?? 0) + Number(d.unstamped_concepts ?? 0) + Number(d.looser_atoms ?? 0) + Number(d.looser_concepts ?? 0),
    impact: 'Some derived pages have no explicit visibility or are stored looser than their origin',
    run: async (engine, scope) => { const { derivedVisibilityCheck } = await import('./checks/derived-visibility.ts'); return perSource(scope, id => derivedVisibilityCheck(engine, id)); },
  },
  {
    id: 'safe_index_pending', resolution: 'repair', registration: 'wave',
    count: d => Number(d.pages_pending ?? 0),
    impact: 'Some pages are below the safe-chunk index version and are withheld from remote search',
    run: async (engine, scope) => (await import('./checks/safe-index.ts')).safeIndexPendingCheck(engine, scope.sourceIds),
  },
  {
    id: 'credential_projection_pending', resolution: 'operator', registration: 'wave',
    count: d => Number(d.pages_pending ?? 0) + Number(d.kept_pages ?? 0),
    impact: 'Some pages holding a private key are withheld from search until their credential-safe re-chunk completes',
    instruction: 'Run `gbrain apply-migrations --yes --no-autopilot-install` on the brain host (no provider calls), then `gbrain embed --stale` when ready; re-import code pages without a recorded source path.',
    run: async (engine, scope) => (await import('./checks/credential-projection.ts')).credentialProjectionPendingCheck(engine, scope.sourceIds),
  },
  {
    id: 'connector_checkpoints', resolution: 'repair', registration: 'wave',
    count: d => Number(d.count ?? 0),
    impact: 'Some connector checkpoint rows can no longer be loaded by any connector source',
    run: async engine => (await import('./checks/connector-checkpoints.ts')).checkConnectorCheckpoints(engine),
  },
  {
    id: 'persistence_request_indexes', resolution: 'repair', registration: 'wave',
    count: d => Number(d.count ?? 0),
    impact: 'A managed sync request index is missing or INVALID, so sync checkpoints can time out on a large request table',
    run: async engine => (await import('./checks/persistence-requests.ts')).requestIndexesCheck(engine),
  },
  {
    id: 'persistence_request_growth', resolution: 'operator', registration: 'wave',
    count: d => (d.scopes ?? []).filter((scope: { days_to_exhaustion?: number | null }) => scope.days_to_exhaustion != null && scope.days_to_exhaustion < 90).length,
    impact: 'At its current admission rate a writer exhausts its lifetime request IDs within 90 days',
    instruction: 'Raise the named limit with the `gbrain config set persistence.limits.<limit> <value>` command doctor prints, on the brain host (docs/guides/repair.md#request-growth).',
    run: async engine => (await import('./checks/persistence-requests.ts')).requestGrowthCheck(engine),
  },
  {
    id: 'connector_held_items', resolution: 'operator', registration: 'wave',
    count: d => Number(d.held ?? 0),
    impact: 'Some connector items are held after repeated failures and are not imported',
    instruction: 'Inspect them with `gbrain sources status <source>`, fix the cause, then run `gbrain sources retry-held <source>` and `gbrain sync --source <source>` (docs/guides/repair.md#connector-held-items).',
    run: async (engine, scope) => (await import('./checks/connector-holds.ts')).connectorHeldItemsCheck(engine, scope.sourceIds),
  },
  {
    id: 'git_held_files', resolution: 'repair', registration: 'wave',
    hostOnly: 'Held file paths are host-local; remote callers see held counts on sync results, get_page and search.',
    count: d => Number(d.held ?? 0),
    impact: 'Some Git source files are held instead of imported, so their pages are missing or keep an older revision',
    bannerHow: (d, how, source) => !d.fences ? how : d.fences >= Number(d.held ?? 0) ? `fence holds: ${fenceRepairHow(d, source)}` : `${how}; fence holds: ${fenceRepairHow(d, source)}`,
    run: async (engine, scope) => (await import('./checks/git-holds.ts')).gitHeldFilesCheck(engine, scope.sourceIds),
  },
  {
    id: 'fence_integrity', resolution: 'repair', registration: 'doctor.ts',
    count: d => Number(d.total ?? 0),
    impact: 'Some facts or takes fences are malformed and wait for repair; none of them blocks a sync',
    bannerHow: (d, _how, source) => fenceRepairHow(d, source),
    run: async (engine, scope) => (await import('./checks/fence-integrity.ts')).fenceIntegrityCheck(engine, scope.sourceIds),
  },
  {
    id: 'frontmatter_repairable', resolution: 'repair', registration: 'doctor.ts',
    hostOnly: 'The scan reads source checkouts on the brain host, and the frontmatter repair rewrites files there (explicit-only).',
    count: d => Number(d.repairable ?? 0),
    impact: 'Some source files have frontmatter gbrain reads only by quoting or interpreting it',
    run: async (engine, scope) => { const { frontmatterRepairableCheck } = await import('./checks/frontmatter-repairable.ts'); return perSource(scope, id => frontmatterRepairableCheck(engine, id)); },
  },
  {
    id: 'frontmatter_hook', resolution: 'operator', registration: 'wave',
    hostOnly: 'Pre-commit hooks live in the source checkouts on the brain host.',
    count: d => Number(d.count ?? 0),
    impact: 'An installed frontmatter pre-commit hook predates this release and checks working-tree files instead of staged content',
    instruction: 'Refresh it on the brain host with `gbrain frontmatter install-hook --force` (add `--source <id>` for one source); only the gbrain hook script is rewritten.',
    run: async (engine, scope) => (await import('./checks/frontmatter-hook.ts')).frontmatterHookCheck(engine, scope.sourceIds),
  },
  {
    id: 'orphan_persistence_bindings', resolution: 'repair', registration: 'wave',
    hostOnly: 'Bindings of removed sources are brain-wide persistence bookkeeping outside any source scope.',
    count: d => Number(d.count ?? 0),
    impact: 'Some persistence source bindings belong to a removed source or an earlier source incarnation',
    run: async engine => (await import('./checks/orphan-bindings.ts')).checkOrphanBindings(engine),
  },
  {
    id: 'unbound_source', resolution: 'operator', registration: 'wave',
    count: d => (d.sources ?? []).filter((source: { bound?: boolean }) => source.bound).reduce((sum: number, source: { pages?: number }) => sum + Number(source.pages ?? 0), 0),
    impact: 'Some pages written database-only while their source was unbound now sit outside canonical files',
    instruction: 'Keep them database-only, or for a page whose slug already has a canonical file preview both sides with `gbrain sources reconcile <source> <slug> --brain <brain> --preview` and apply the agreed resolution (docs/guides/write-refusals.md#unbound-sources-on-postgres).',
    run: async engine => (await import('./checks/unbound-source.ts')).checkUnboundSource(engine),
  },
  {
    id: 'persistence_capacity', resolution: 'operator', registration: 'doctor.ts',
    count: d => (d.resources ?? []).length,
    impact: 'A cumulative managed-write limit is at or above 80%',
    instruction: 'Raise the named journal limit with the `gbrain config set` command doctor prints, on the brain host.',
    run: async engine => (await import('./checks/persistence-capacity.ts')).checkPersistenceCapacity(engine),
  },
  {
    id: 'parked_effects', resolution: 'operator', registration: 'doctor.ts',
    count: d => Number(d.parked_effects ?? 0),
    impact: 'Some Git or withdrawal effects are parked after repeated failures',
    instruction: 'Fix the cause, then run the `gbrain sources writer retry-effects <source> --request-id <id>` command doctor prints (preview with --dry-run first).',
    run: async (engine, scope) => (await import('./checks/parked-effects.ts')).checkParkedEffects(engine, scope.sourceIds),
  },
  {
    id: 'dream_paid_loop', resolution: 'operator', registration: 'doctor.ts',
    count: d => (d.keys ?? []).length,
    impact: 'A dream synthesis key keeps dying and was paid for on each attempt',
    instruction: 'Fix the cause, then reset the breaker with the command doctor prints.',
    run: async engine => (await import('./checks/dream-breaker.ts')).dreamPaidLoopCheck(engine),
  },
  {
    id: 'writer_version', resolution: 'operator', registration: 'wave',
    impact: 'A writer older than this release admitted or published a recent write',
    instruction: 'Run `gbrain upgrade` on each host doctor names (by host UUID), then restart its gbrain processes; an older writer may still delete database-only timeline rows.',
    count: d => Number(d.count ?? 0),
    run: async engine => (await import('./checks/writer-version.ts')).writerVersionCheck(engine),
  },
  {
    id: 'self_capture', resolution: 'operator', registration: 'wave',
    count: d => Number(d.classified ?? 0),
    impact: 'The session corpus still holds files captured from gbrain\'s own model sessions',
    instruction: 'Quarantine the listed corpus files by hand with the commands in docs/guides/repair.md#quarantine-self-captured-corpus-files; nothing is deleted automatically.',
    run: async engine => (await import('./checks/self-capture.ts')).selfCaptureCheck(engine),
  },
  {
    id: 'vector_plan', resolution: 'operator', registration: 'wave',
    count: d => (d.outcome === 'index_unused' || d.outcome === 'legacy_guard' ? 1 : 0),
    impact: 'Vector search on the active embedding column does not use its HNSW index, so vector candidates can time out and hybrid search falls back to keyword hits',
    instruction: 'Upgrade gbrain on the brain host and rerun `gbrain doctor`; check the HNSW index state doctor reports; remove `search.vector_legacy_guard` / GBRAIN_VECTOR_LEGACY_GUARD unless it rolled back a regression, then restart the owning service (docs/guides/troubleshooting.md#hybrid-search-returns-only-keyword-hits).',
    run: async engine => (await import('./checks/vector-plan.ts')).vectorPlanCheck(engine),
  },
  {
    id: 'stale_embedding_effects', resolution: 'repair', registration: 'wave',
    count: d => Number(d.stale_effects ?? 0),
    impact: 'A committed write still has a stale queued or failed embedding effect that blocks compaction and activation',
    run: async (engine, scope) => (await import('./checks/stale-embedding-effects.ts')).staleEmbeddingEffectsCheck(engine, scope.sourceIds),
  },
  {
    id: 'google_file_modes', resolution: 'repair', registration: 'wave',
    hostOnly: 'File permissions and directory paths on the brain host are host-local filesystem state.',
    count: d => Number(d.count ?? 0),
    impact: 'Some files gbrain wrote under a Google source directory outside ~/.gbrain are readable by other local users',
    run: async (engine, scope) => (await import('./checks/google-file-modes.ts')).checkGoogleFileModes(engine, scope.sourceIds),
  },
  {
    id: 'atom_provenance_drift', resolution: 'repair', registration: 'doctor.ts',
    hostOnly: 'Retiring stale atoms is a host-side, explicit-only repair.',
    count: d => Number(d.drifted ?? 0),
    impact: 'Some atoms reference a source page that is gone or was edited, and still surface in search with a quote no current page contains',
    run: async engine => (await import('./checks/extraction-sync.ts')).computeAtomProvenanceDriftCheck(engine),
  },
  {
    id: 'extractor_facts_expired', resolution: 'repair', registration: 'wave',
    hostOnly: 'Restoring expired extractor facts is a host-side, explicit-only repair.',
    count: d => Number(d.evidenced ?? 0) + Number(d.ambiguous ?? 0),
    impact: 'Some conversation-extractor facts were expired by the pre-v0.60.11.0 canonical projection and recall no longer returns them',
    run: async (engine, scope) => (await import('./checks/extractor-facts.ts')).extractorFactsCheck(engine, scope.sourceIds),
  },
  {
    id: 'captured_facts_active', resolution: 'repair', registration: 'wave',
    hostOnly: 'Classifying captured facts reads harness transcripts and the session corpus on the brain host; the repair is explicit-only.',
    count: d => Number(d.evidenced ?? 0) + Number(d.ambiguous ?? 0),
    impact: 'Some active facts were captured from gbrain\'s own model sessions or from pasted text before v0.60.30.0',
    run: async (engine, scope) => (await import('./checks/captured-facts.ts')).capturedFactsCheck(engine, scope.sourceIds),
  },
  {
    id: 'loop_facts_drift', resolution: 'repair', registration: 'wave',
    hostOnly: 'Retiring closed-loop commitment facts is a host-side, explicit-only repair.',
    count: d => Number(d.drifted ?? 0),
    impact: 'Some closed commitment loops still have an active commitment fact, so recall keeps the finished promise',
    run: async (engine, scope) => (await import('./checks/loop-facts.ts')).loopFactsDriftCheck(engine, scope.sourceIds),
  },
];

/** A check that could not run reports unknown, never ok. */
export function checkHealthUnknown(check: Check): boolean {
  return check.details?.health === 'unknown' || check.details?.count === 'unknown';
}

export interface WaveFinding { spec: WaveCheckSpec; check: Check; state: 'ok' | 'finding' | 'unknown' }

/** Run wave checks; a throwing check becomes an unknown finding instead of aborting the rest. */
export async function runWaveChecks(engine: BrainEngine, opts: WaveScope & { only?: WaveCheckSpec['registration']; remote?: boolean } = {}): Promise<WaveFinding[]> {
  const specs = WAVE_CHECKS.filter(spec => (!opts.only || spec.registration === opts.only) && (!opts.remote || !spec.hostOnly));
  const findings: WaveFinding[] = [];
  for (const spec of specs) {
    let check: Check;
    try { check = await spec.run(engine, { sourceIds: opts.sourceIds }); }
    catch (error) {
      check = { name: spec.id, status: 'warn', message: `${spec.id} could not run: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
        details: { health: 'unknown' } };
    }
    check = { ...check, name: spec.id };
    findings.push({ spec, check, state: checkHealthUnknown(check) ? 'unknown' : check.status === 'ok' ? 'ok' : 'finding' });
  }
  return findings;
}

/** The one source a finding names (`details.source_ids` of length 1), so its repair command can say `--source <id>`. */
export function findingSource(finding: Pick<WaveFinding, 'check'>): string | undefined {
  const ids = finding.check.details?.source_ids;
  return Array.isArray(ids) && ids.length === 1 && typeof ids[0] === 'string' ? ids[0] : undefined;
}

/** The repair kind that clears a wave finding, when its resolution is `repair`. */
export function waveRepairKind(spec: WaveCheckSpec) {
  return spec.resolution === 'repair' ? repairForCheck(spec.id)?.kind : undefined;
}

export const REMOTE_HOST_ACTION = 'host operator action required: on the brain host run `gbrain doctor --remediation-plan`';

/**
 * Remote doctor lines: one per remotely offered wave check, with a stable id,
 * the count-free impact summary and the on-host preview command. No host
 * paths, row contents, SQL, account emails or installation ids.
 */
export async function remoteWaveHandoff(engine: BrainEngine, sourceIds?: string[]): Promise<Check[]> {
  const findings = await runWaveChecks(engine, { sourceIds, remote: true });
  return findings.map(({ spec, state }) => {
    const host_action = { check_id: spec.id, state: state === 'finding' ? 'action_required' : state, preview_command: 'gbrain doctor --remediation-plan' };
    if (state === 'ok') return { name: spec.id, status: 'ok' as const, message: 'No host action needed.', details: { host_action } };
    if (state === 'unknown') return { name: spec.id, status: 'warn' as const, details: { host_action },
      message: `Unknown: this check could not run for the remote caller; ${REMOTE_HOST_ACTION}.` };
    return { name: spec.id, status: 'warn' as const, details: { host_action }, message: `${spec.impact}; ${REMOTE_HOST_ACTION}.` };
  });
}
