import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { gitHoldFix, readGitHoldListing, readGitImageHoldCounts, readSyncHoldPolicy } from '../../../core/persistence/sync-holds.ts';
import { readHeldCoverage } from '../../../core/persistence/held-reads.ts';
import { agentFix } from '../check-fix.ts';
import { isContentRefusal } from '../../../core/import-screen.ts';

const SAMPLE_PATHS = 5;

/**
 * #5988: files a Git source holds instead of importing (unreadable or
 * ambiguous frontmatter, a conflicting slug, over-size, an operator content
 * reject). Connector holds stay on `connector_held_items`. Warns per source
 * with the missing and stale counts, the first paths with their code and next
 * step (the check is host-only, so paths never reach a remote caller), and the
 * inspect and repair commands; fails once a source carries more holds than
 * `sync.hold_escalate_count`, the same count rule that escalates a sync result.
 * Unsupported-image holds (#5493) are listed but never escalate.
 */
export async function gitHeldFilesCheck(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  try {
    const [coverage, policy] = await Promise.all([readHeldCoverage(engine, sourceIds ? { sourceIds } : {}), readSyncHoldPolicy(engine)]);
    const listing = new Map((await readGitHoldListing(engine, coverage.map(source => source.source_id), SAMPLE_PATHS)).map(entry => [entry.sourceId, entry.holds]));
    const images = await readGitImageHoldCounts(engine, coverage.map(source => source.source_id));
    const sources = coverage.map(source => ({ source_id: source.source_id, held: source.missing + source.stale, stale: source.stale, missing: source.missing,
      first: (listing.get(source.source_id) ?? []).map(hold => ({ path: hold.path, code: hold.code, ...(hold.meta.reason ? { reason: hold.meta.reason } : {}), why: gitHoldFix(hold).why })),
      escalated: source.missing + source.stale - (images.get(source.source_id) ?? 0) > policy.escalateCount,
      status: `gbrain sources status ${source.source_id}`, repair: `gbrain repair frontmatter --source ${source.source_id}` }));
    const held = sources.reduce((sum, source) => sum + source.held, 0);
    const details = { held, source_ids: sources.map(source => source.source_id), sources, escalate_count: policy.escalateCount,
      docs: 'docs/guides/repair.md#held-files' };
    if (!held) return { name: 'git_held_files', status: 'ok', message: 'No Git source files are held.', details };
    const escalated = sources.filter(source => source.escalated);
    const single = sources.length === 1 ? sources[0]!.source_id : undefined;
    const lines = sources.map(source => `${source.source_id}: ${source.held} held (${source.stale} page(s) keep an older revision, ${source.missing} file(s) have no page), `
      + `first: ${source.first.map(hold => `${hold.path} [${hold.code}${hold.reason ? `/${hold.reason}` : ''}]`).join(', ')}`);
    return {
      name: 'git_held_files', status: escalated.length ? 'fail' : 'warn', details,
      message: `${held} file(s) in Git sources are held and not imported; the rest of each sync continues. ${lines.join('; ')}. `
        + (escalated.length ? `Escalated: ${escalated.map(source => source.source_id).join(', ')} hold more than ${policy.escalateCount} files (sync.hold_escalate_count), so a generator or an upgrade is likely writing or reading them wrong; fix the cause first. ` : '')
        + 'A page whose newer file is held is read-only for put_page until the file is repaired, so do not retry a refused write. '
        + `Inspect with ${sources.map(source => source.status).join('; ')}; preview the fix with ${sources.map(source => source.repair).join('; ')}.`,
      fix: agentFix(['gbrain', 'repair', 'frontmatter', ...(single ? ['--source', single] : [])],
        'Previews the minimal line fix for each held file (or names the line to fix by hand) and prints the hash-bound apply command; it writes nothing.', 'git_held_files',
        { docs: 'docs/guides/repair.md#held-files' }),
    };
  } catch (error) {
    return { name: 'git_held_files', status: 'warn', fix_unavailable_reason: 'check_errored',
      message: `Git source holds could not be inspected: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { held: 0, health: 'unknown' } };
  }
}

/** Sources whose unfinished managed sync cursor is stopped on a failed content refusal (fixed by the next sync, which converts it in place). */
export async function contentBlockedSources(engine: BrainEngine): Promise<string[]> {
  const rows = await engine.executeRaw<{ source_id: string; error_code: string | null; error_message: string | null }>(`SELECT c.completed_keys->0->>'sourceId' AS source_id,
      r.error_code, r.error_message FROM op_checkpoints c JOIN persistence_requests r ON r.request_id::text = c.completed_keys->0->'pending'->>'requestId'
      AND r.source_id = c.completed_keys->0->>'sourceId'
    WHERE c.op = 'managed-sync' AND COALESCE(c.completed_keys->0->>'done','false') <> 'true' AND r.state IN ('failed','conflict','cancelled')
    ORDER BY 1`).catch(() => []);
  return [...new Set(rows.filter(row => isContentRefusal(row.error_code, row.error_message)).map(row => row.source_id))];
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
  if (blocked.length) {
    parts.push(`${blocked.length} source(s) are blocked by a file gbrain could not import (${blocked.join(', ')}). The next scheduled or manual sync recovers a blocked source `
      + `automatically; to do it now run ${blocked.map(id => `gbrain sync --source ${id} --no-pull`).join('; ')}. The file is then held and the rest of the source imports; `
      + `inspect it with ${blocked.map(id => `gbrain sources status ${id}`).join('; ')} and preview the backlog fix with ${blocked.map(id => `gbrain repair frontmatter --source ${id}`).join('; ')} (writes nothing; ask the user before applying)`);
  }
  if (hooks.length) parts.push(`an older frontmatter pre-commit hook is installed; refresh it with ${hooks.map(hook => hook.fix.join(' ')).join('; ')}`);
  return parts.length ? `frontmatter_holds: ${parts.join('. ')}. Recipe: docs/guides/repair.md#held-files` : null;
}
