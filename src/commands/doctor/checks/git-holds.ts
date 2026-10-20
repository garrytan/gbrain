import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { gitHoldFix, holdRepairSteps, readGitHoldListing, readGitImageHoldCounts, readSyncHoldPolicy } from '../../../core/persistence/sync-holds.ts';
import { coverageRoute, readHeldCoverage } from '../../../core/persistence/held-reads.ts';
import { fenceReceiptLocation } from '../../../core/fence-repair/refusal.ts';
import { readFenceAutoRepair, type FenceAutoRepair } from '../../../core/fence-repair/hold-fix.ts';
import { summarizeFenceCensus } from '../../../core/fence-repair/census.ts';
import { agentFix } from '../check-fix.ts';
import { isContentRefusal } from '../../../core/import-screen.ts';
import { SETTLE_MISMATCH_STREAK } from '../../../core/persistence/sync-pass-row.ts';

const SAMPLE_PATHS = 5;

/**
 * #5988: files a Git source holds instead of importing (unreadable or
 * ambiguous frontmatter, a conflicting slug, over-size, an operator content
 * reject, and #6188 a facts or takes fence that cannot be imported). Connector
 * holds stay on `connector_held_items`. Warns per source with the missing and
 * stale counts, the first paths with their code and next step (the check is
 * host-only, so paths never reach a remote caller), and each source's next
 * step from the hold router (D6: the frontmatter repair preview, the fence
 * repair preview, or both); fails once a source carries more holds than
 * `GBRAIN_SYNC_HOLD_ESCALATE_COUNT`, the same count rule that escalates a sync result.
 * Unsupported-image holds (#5493) are listed but never escalate. With fence
 * holds, details carry `fences` and `auto_repair` (whether the maintenance run
 * repairs them by itself), which the post-upgrade banner reads.
 * #6712 PR 4b (design v3.2 §3.7): a non-company source whose passes keep
 * stopping (`passHealth`: the newest ended `blocked`, a `not_converged`
 * streak, or a `settle_mismatch` streak that becomes a hold) is listed under
 * `details.passes` with its reason, stop reason, the time it began and the
 * paths whose settle keeps mismatching, and warns even with no file held.
 */
export async function gitHeldFilesCheck(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  try {
    const { readPassReadings, passStuck, passStuckSince } = await import('../../../core/persistence/sync-pass-readers.ts');
    const passes = (await readPassReadings(engine, { sourceIds, head: false })).filter(reading => passStuck(reading.health)).map(({ source_id, row, health }) => ({
      source_id, reason: health.reason!, stop_reason: row.value.telemetry.stop_reason, since: passStuckSince(row), not_converged_streak: row.value.obligations.not_converged_streak ?? 0,
      mismatch: Object.entries(row.value.obligations.mismatch ?? {}).filter(([, entry]) => entry.streak >= SETTLE_MISMATCH_STREAK - 1).map(([path, entry]) => ({ path, streak: entry.streak })).slice(0, SAMPLE_PATHS) }));
    const passLines = passes.map(pass => `${pass.source_id}: every pass since ${pass.since} stopped ${pass.reason}${pass.stop_reason ? ` (${pass.stop_reason})` : ''}`
      + (pass.mismatch.length ? `, settle keeps mismatching on ${pass.mismatch.map(entry => entry.path).join(', ')}` : ''));
    const passNote = passes.length ? ` Managed sync passes that keep stopping: ${passLines.join('; ')}; inspect with ${passes.map(pass => `gbrain sync status --source ${pass.source_id} --json`).join('; ')}.` : '';
    const [coverage, policy] = await Promise.all([readHeldCoverage(engine, sourceIds ? { sourceIds } : {}), readSyncHoldPolicy(engine)]);
    const listing = new Map((await readGitHoldListing(engine, coverage.map(source => source.source_id), SAMPLE_PATHS)).map(entry => [entry.sourceId, entry.holds]));
    const images = await readGitImageHoldCounts(engine, coverage.map(source => source.source_id));
    const fences = coverage.reduce((sum, source) => sum + coverageRoute(source).fences, 0);
    const auto = fences ? await readFenceAutoRepair(engine) : undefined;
    const sources = coverage.map(source => {
      const route = coverageRoute(source);
      const steps = holdRepairSteps(source.source_id, route, auto);
      return { source_id: source.source_id, held: source.missing + source.stale, stale: source.stale, missing: source.missing, ...(route.fences ? { fences: route.fences } : {}), ...(route.concurrent ? { concurrent: route.concurrent } : {}),
        ...(route.stalled ? { stalled: route.stalled } : {}), ...(route.dirty ? { dirty: route.dirty } : {}), ...(route.drift ? { drift: route.drift } : {}),
        first: (listing.get(source.source_id) ?? []).map(hold => ({ path: hold.path, code: hold.code, ...(hold.meta.reason ? { reason: hold.meta.reason } : {}), why: gitHoldFix(hold, auto).why })),
        escalated: source.missing + source.stale - (images.get(source.source_id) ?? 0) - (route.drift ?? 0) > policy.escalateCount,
        status: `gbrain sources status ${source.source_id}`, repair: steps.commands.join('; '),
        argv: steps.argv, next: steps.text };
    });
    const held = sources.reduce((sum, source) => sum + source.held, 0);
    const details = { held, source_ids: sources.map(source => source.source_id), sources: sources.map(({ argv: _argv, ...source }) => source), escalate_count: policy.escalateCount,
      ...(fences ? { fences, auto_repair: auto } : {}), ...(passes.length ? { passes } : {}), docs: 'docs/guides/repair.md#held-files' };
    if (!held && passes.length) return { name: 'git_held_files', status: 'warn', details,
      message: `No Git source files are held, but managed sync does not converge.${passNote}`,
      fix: agentFix(['gbrain', 'sync', 'status', '--source', passes[0]!.source_id, '--json'],
        'Read-only: the convergence of the source, the reason its passes stop and the next step (a hold to reconcile, a blocked step, or the resume command).', 'git_held_files', { docs: 'docs/guides/repair.md#held-files' }) };
    if (!held) return { name: 'git_held_files', status: 'ok', message: 'No Git source files are held.', details };
    const escalated = sources.filter(source => source.escalated);
    const single = sources.length === 1 ? sources[0]! : undefined;
    const fenceOnly = sources.every(source => source.fences === source.held);
    // #6278: stalled holds are the writer's, not the files': the fix is writer status, never a file repair.
    const stalledOnly = sources.every(source => source.stalled === source.held);
    const stalled = sources.reduce((sum, source) => sum + (source.stalled ?? 0), 0);
    const lines = sources.map(source => `${source.source_id}: ${source.held} held (${source.stale} page(s) keep an older revision, ${source.missing} file(s) have no page), `
      + `first: ${source.first.map(hold => `${hold.path} [${hold.code}${hold.reason ? `/${hold.reason}` : ''}]`).join(', ')}`);
    return {
      name: 'git_held_files', status: escalated.length ? 'fail' : 'warn', details,
      message: `${held} file(s) in Git sources are held and not imported; the rest of each sync continues. ${lines.join('; ')}. `
        + (escalated.length ? `Escalated: ${escalated.map(source => source.source_id).join(', ')} hold more than ${policy.escalateCount} files (GBRAIN_SYNC_HOLD_ESCALATE_COUNT), so ${stalled * 2 > held
          ? 'the write owner (not the files) is the likely cause; inspect it with writer status' : 'a generator or an upgrade is likely writing or reading them wrong; fix the cause'} first. ` : '')
        + 'A page whose newer file is held is read-only for put_page until the file is repaired, so do not retry a refused write. '
        + `Inspect with ${sources.map(source => source.status).join('; ')}; `
        + (sources.some(source => source.fences || source.stalled) ? `then ${sources.map(source => `${source.source_id}: ${source.next}`).join('; ')}.` : `preview the fix with ${sources.map(source => source.repair).join('; ')}.`)
        + passNote,
      fix: single
        ? agentFix(single.argv, fenceOnly ? `Previews the fence repair of each held file of ${single.source_id} (read-only, no model call): ${single.next}.`
          : stalledOnly ? `Shows what the write owner of ${single.source_id} was stuck on (read-only); the held files are fine. ${single.next}.`
            : 'Previews the minimal line fix for each held file (or names the line to fix by hand) and prints the hash-bound apply command; it writes nothing.',
        'git_held_files', { docs: fenceOnly ? 'docs/guides/repair.md#fences' : stalledOnly ? 'docs/guides/write-refusals.md#preparation_stalled' : 'docs/guides/repair.md#held-files' })
        : agentFix(fenceOnly ? ['gbrain', 'repair', 'fences'] : stalledOnly ? ['gbrain', 'sources', 'writer', 'status', '--json'] : ['gbrain', 'repair', 'frontmatter'],
          fenceOnly ? `Previews the fence repair of every held file (read-only, no model call) with each one's planned repair or exact edit, and prints the apply command with --expect <hash>. ${fenceAutoSentence(auto)}`
            : stalledOnly ? 'Shows every source\'s write owner and what it was stuck on (read-only); the held files are fine. Fix what it names or upgrade gbrain, then gbrain sources retry-held <id> and the same sync per source.'
              : 'Previews the minimal line fix for each held file (or names the line to fix by hand) and prints the hash-bound apply command; it writes nothing. '
              + `Fence holds are previewed by gbrain repair fences instead${stalled ? ', and preparation-stalled holds need no file repair (see each source\'s next step)' : ''}. ${fenceAutoSentence(auto)}`,
          'git_held_files', { docs: fenceOnly ? 'docs/guides/repair.md#fences' : stalledOnly ? 'docs/guides/write-refusals.md#preparation_stalled' : 'docs/guides/repair.md#held-files' }),
    };
  } catch (error) {
    return { name: 'git_held_files', status: 'warn', fix_unavailable_reason: 'check_errored',
      message: `Git source holds could not be inspected: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { held: 0, health: 'unknown' } };
  }
}

/** Whether the maintenance run repairs fence holds by itself, as one sentence ('' when nothing says). */
function fenceAutoSentence(auto: FenceAutoRepair | undefined): string {
  if (!auto) return '';
  return auto.active ? 'The next maintenance run repairs the fence holds it can by itself.'
    : `Nothing repairs fence holds by itself (${auto.enabled ? 'no maintenance run is active' : 'fences.repair.enabled is false'}), so apply the plan the preview prints.`;
}

/**
 * Sources stopped on a failed content refusal: a company (or not yet retired) cursor pending on it, or a non-company source whose
 * newest pass ended blocked on it. The next sync fixes either (the file is held and the rest imports).
 * `fence` marks a source whose refusal is a facts or takes fence (#6188); it is held and repaired by `gbrain repair fences`, not by frontmatter repair.
 */
export async function contentBlockedSources(engine: BrainEngine): Promise<Array<{ source_id: string; fence: boolean }>> {
  type Receipt = { source_id: string; error_code: string | null; error_message: string | null; error_detail: unknown };
  const rows: Receipt[] = await engine.executeRaw<Receipt>(`SELECT c.completed_keys->0->>'sourceId' AS source_id,
      r.error_code, r.error_message, r.error_detail FROM op_checkpoints c JOIN persistence_requests r ON r.request_id::text = c.completed_keys->0->'pending'->>'requestId'
      AND r.source_id = c.completed_keys->0->>'sourceId'
    WHERE c.op = 'managed-sync' AND COALESCE(c.completed_keys->0->>'done','false') <> 'true' AND r.state IN ('failed','conflict','cancelled')
    ORDER BY 1`).catch(() => []);
  // #6712 PR 4b (design v3.2 §3.7): a non-company source has no cursor; it is blocked when its newest pass ended blocked on a
  // receipt that pass admitted (the receipt's intent carries the pass id).
  const { readPassReadings } = await import('../../../core/persistence/sync-pass-readers.ts');
  for (const { source_id, row, health } of await readPassReadings(engine, { head: false }).catch(() => [])) {
    if (health.reason !== 'blocked') continue;
    rows.push(...await engine.executeRaw<Receipt>(`SELECT source_id,
        error_code, error_message, error_detail FROM persistence_requests WHERE source_id=$1 AND intent->>'passId'=$2 AND state IN ('failed','conflict','cancelled')`,
      [source_id, row.value.telemetry.pass_id]).catch(() => []));
  }
  const out = new Map<string, boolean>();
  for (const row of rows) {
    const fence = fenceReceiptLocation(row) !== null;
    if (fence || isContentRefusal(row.error_code, row.error_message)) out.set(row.source_id, (out.get(row.source_id) ?? false) || fence);
  }
  return [...out].map(([source_id, fence]) => ({ source_id, fence }));
}

/**
 * #5988 `gbrain post-upgrade` line: a source blocked by one file recovers on
 * its next sync (scheduled or manual) without ledger surgery. The line names
 * the command that does it now and the repair preview for the backlog, plus
 * the hook refresh when an older hook is installed (held files already appear
 * as the `git_held_files` finding). Null when neither applies.
 */
export async function frontmatterHoldsBannerNote(engine: BrainEngine): Promise<string | null> {
  const { outdatedFrontmatterHooks } = await import('./frontmatter-hook.ts');
  const [blocked, hooks] = await Promise.all([contentBlockedSources(engine), outdatedFrontmatterHooks(engine).catch(() => [])]);
  const parts: string[] = [];
  const ids = blocked.filter(source => !source.fence).map(source => source.source_id);
  if (ids.length) {
    parts.push(`${ids.length} source(s) are blocked by a file gbrain could not import (${ids.join(', ')}). The next scheduled or manual sync recovers a blocked source `
      + `automatically; to do it now run ${ids.map(id => `gbrain sync --source ${id} --no-pull`).join('; ')}. The file is then held and the rest of the source imports; `
      + `inspect it with ${ids.map(id => `gbrain sources status ${id}`).join('; ')} and preview the backlog fix with ${ids.map(id => `gbrain repair frontmatter --source ${id}`).join('; ')} (writes nothing; ask the user before applying)`);
  }
  if (hooks.length) parts.push(`an older frontmatter pre-commit hook is installed; refresh it with ${hooks.map(hook => hook.fix.join(' ')).join('; ')}`);
  return parts.length ? `frontmatter_holds: ${parts.join('. ')}. Recipe: docs/guides/repair.md#held-files` : null;
}

/**
 * #6188 (D7) `gbrain post-upgrade` line, separate from the frontmatter one: a
 * source blocked by a malformed facts or takes fence (a typed receipt or the
 * message an older gbrain stored) recovers on its next sync with no command
 * (the file is held and the rest of the source imports), the malformed fences
 * the stored census knows and whether the next maintenance run repairs them,
 * the read-only preview and the pause setting. Never an applying command.
 * Null when no source is blocked.
 */
export async function fenceHoldsBannerNote(engine: BrainEngine): Promise<string | null> {
  const ids = (await contentBlockedSources(engine)).filter(source => source.fence).map(source => source.source_id);
  if (!ids.length) return null;
  const [auto, census] = await Promise.all([readFenceAutoRepair(engine), summarizeFenceCensus(engine).catch(() => [])]);
  const malformed = census.reduce((sum, source) => sum + source.total, 0);
  const repair = auto.active ? 'the next maintenance run repairs them automatically (the manual ones are listed with the exact edit)'
    : `nothing repairs them by itself until a maintenance run is active${auto.enabled ? '' : ' and fences.repair.enabled is true again'}, so preview them and apply the plan the preview prints once the user agrees`;
  return `fence_holds: ${ids.length} source(s) are blocked by a file whose facts or takes fence gbrain could not import (${ids.join(', ')}). The next scheduled or manual sync `
    + `recovers each with no command; to do it now run ${ids.map(id => `gbrain sync --source ${id} --no-pull`).join('; ')}. The file is then held and the rest of the source imports. `
    + `${malformed} malformed fence(s) are known so far (gbrain doctor --only fence_integrity counts them by tier); ${repair}. `
    + 'Preview (read-only, no model call): gbrain repair fences. Pause automatic fence repair first with: gbrain config set fences.repair.enabled false. Recipe: docs/guides/repair.md#fences';
}
