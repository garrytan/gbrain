/**
 * `gbrain projections drain` (#5401): rebuilds queued Markdown and code text
 * projections in-process, in batches of up to 100, until every row queued
 * before the run started has been tried once; pages stored in segments go
 * first through buildSegmentedProjection, skipping a live claim (Wave B). Then
 * (#6803) it restores the importer's own seal on `sealable` image pages
 * (page-state/image-seal.ts), keyless and without re-embedding. Trusted local
 * CLI only; it is not an operation, so MCP and remediation cannot run it.
 *
 * Postgres: safe beside a resident owner, because each page is rebuilt or
 * sealed under its page lock with a revision recheck. PGLite: a resident owner
 * holds the datastore and drains text only, so the command does not run and
 * prints the exclusive stop, drain and start steps instead.
 */
import type { Action } from '../core/agent-output.ts';
import type { OperationError } from '../core/ops/contract.ts';
import { catalogueError } from '../core/error-catalogue.ts';
import type { LockHolderInfo } from '../core/pglite-lock.ts';
import type { ProjectionBacklog, ProjectionDrainResult, ProjectionRebuildFailure } from '../core/page-state/projections.ts';
import { IMAGE_SEAL_PAGES_PER_SECOND, TEXT_REBUILD_PAGES_PER_SECOND, projectionDrainLimit } from '../core/page-state/image-seal.ts';
// #6286: the drain lives in core so `migrate` can run it on its target before the config flip.
export { drainProjections, previewProjectionDrain, type ProjectionDrainResult } from '../core/page-state/projections.ts';
import { SERVE_LAUNCHD_LABEL, SERVE_SYSTEMD_UNIT } from '../core/serve-service.ts';
import { resolveAutopilotJob } from '../core/autopilot-paths.ts';
import { detectInstalledJob } from './autopilot/jobs.ts';

export const PROJECTION_DRAIN_DOCS = 'docs/guides/repair.md#projection-drain';

export const PROJECTIONS_HELP = `Usage: gbrain projections drain [--dry-run] [--limit <n>] [--json]

Rebuild queued Markdown and code text projections now, in batches of up to 100,
until every row queued before the run started has been tried once. Pages stored
in segments are built first, except one another gbrain process is building.
Then seal the image pages the importer already attested safe (sealable). Keyless:
no provider call, no file read, no re-embedding. Image pages it cannot seal
(reimport) need their importer: preview with gbrain embed --stale --images --dry-run.
Protected-OCR images and archived-source pages stay unsealed by design.

  --dry-run     Change nothing: print every class count (queued text, sealable,
                reimport, protected, archived) and the rows a drain would take,
                oldest first, up to --limit (default 50)
  --limit <n>   Try at most n pages in this run (default: no cap); doctor's fix
                sizes it to about a minute (${projectionDrainLimit()} images,
                ${projectionDrainLimit(1)} while text pages wait)
  --json        Print {rebuilt, superseded, failed, remaining, limited, sealed,
                sealed_with_visual, sealed_text_only, statistics_refreshed,
                remaining_by_class} to stdout (the class counts and rows with --dry-run)

Exit codes: 0 nothing tried failed; 1 some pages failed; 2 did not run
(projection_owner_resident: a resident gbrain process holds this PGLite brain;
it drains text only, so stop it, drain and start it again as printed).

On Postgres the drain is safe while \`gbrain serve\` runs. Progress goes to stderr.
Docs: ${PROJECTION_DRAIN_DOCS}
`;

/** The next step for one failed page, from the preparation error it reported. */
export function projectionFailureNextAction(failure: ProjectionRebuildFailure): string {
  if (failure.reason.startsWith('Code projection requires a recorded source path')) {
    return `restore frontmatter.file or source_path on ${failure.slug}, then run \`gbrain projections drain\` again`;
  }
  if (failure.reason.startsWith('This page kind requires its source importer')) {
    return `re-import it from its source: preview with \`gbrain embed --stale --images --dry-run --source ${failure.source_id}\` (image pages), or run \`gbrain sync --source ${failure.source_id}\``;
  }
  if (failure.reason.startsWith('revision_conflict:')) {
    return 'the page changed while it was being rebuilt; it stays queued at its new revision and `gbrain projections drain` rebuilds it on its next run';
  }
  return 'run `gbrain doctor`; the page stays queued and `gbrain projections drain` tries it again on its next run';
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The class counts of a backlog, one phrase. */
export function projectionClassSummary(backlog: Required<ProjectionBacklog>): string {
  return `${backlog.pending} queued text, ${backlog.sealable} sealable image(s) (${backlog.sealable_with_visual} with a visual vector), `
    + `${backlog.reimport} to reimport, ${backlog.protected} protected, ${backlog.archived} archived, ${backlog.failed} last failed`;
}

/** What remains after a drain or preview, past what the drain itself takes: never "empty" while an image row needs work. */
function remainderLines(backlog: Required<ProjectionBacklog>): string[] {
  const lines: string[] = [];
  if (backlog.reimport) lines.push(`${plural(backlog.reimport, 'image page')} need their importer (fresh OCR and pixels): preview with \`gbrain embed --stale --images --dry-run\`.`);
  if (backlog.protected || backlog.archived) {
    lines.push(`${plural(backlog.protected, 'protected-OCR image')} and ${plural(backlog.archived, 'archived-source page')} stay unsealed by design; search leaves them out until the image is reimported clean or the source is restored.`);
  }
  return lines;
}

/** Human output of `--dry-run`. */
export function formatDrainPreview(preview: Awaited<ReturnType<typeof import('../core/page-state/projections.ts').previewProjectionDrain>>): string {
  const rows = preview.rows.map(row => `  ${row.reason === 'rebuild_failed' ? 'last failed' : row.page_kind === 'image' ? 'sealable' : 'queued'}: ${row.source_id}/${row.slug} (${row.reason}, since ${row.updated_at})`);
  const work = preview.pending + preview.sealable;
  const empty = work + preview.reimport + preview.protected + preview.archived === 0;
  return [`projections drain --dry-run: ${projectionClassSummary(preview)}; nothing was changed.`, ...rows,
    ...(work ? [`Run \`gbrain projections drain --limit ${projectionDrainLimit(preview.pending)}\` (repeat until sealable is 0) to rebuild the text rows and seal the sealable images; a page that fails again is printed with its next step.`] : []),
    ...remainderLines(preview), ...(empty ? ['The projection backlog is empty.'] : [])].join('\n');
}

/** Human output of a drain; `limit` is the caller's `--limit`, repeated in the continuation. */
export function formatDrainResult(result: ProjectionDrainResult, limit?: number): string {
  const after = result.remaining_by_class;
  const summary = `projections drain: ${result.rebuilt} rebuilt, ${result.superseded} superseded, ${result.failed.length} failed, ${result.remaining} remaining.`;
  const empty = !after || after.pending + after.sealable + after.reimport + after.protected + after.archived === 0;
  const tail = result.limited ? ` Stopped at --limit ${limit}; run \`gbrain projections drain --limit ${limit}\` again to continue.`
    : result.failed.length ? ' Failed pages stay queued; fix them as shown above, then run `gbrain projections drain` again.'
      : result.remaining === 0 && empty ? ' The projection backlog is empty.'
        : result.remaining === 0 ? ''
          : ' Rows queued during this run are left for the next run or the resident owner.';
  const lines = [summary + tail];
  if (result.sealed !== undefined) {
    lines.push(`images: ${result.sealed} sealed (${result.sealed_with_visual} with a visual vector, ${result.sealed_text_only} text-only)`
      + (result.sealed_text_only ? '; the text-only ones get their visual vector from `gbrain embed --stale --images --dry-run` then the paid run.' : '.')
      + (result.statistics_refreshed ? ' Projection statistics were refreshed.' : ''));
  }
  if (after) {
    lines.push(`remaining: ${projectionClassSummary(after)}.`);
    lines.push(...remainderLines(after));
  }
  return lines.join('\n');
}

/**
 * Stop, drain and restart commands for each way a resident owner can run. The
 * restart runs whether or not a page failed, so a drain exit of 1 never leaves
 * the owner stopped. `brain` keeps a mounted brain selected in every command.
 */
export function residentDrainSteps(pid: number | undefined, brain = 'host', limit?: number): string {
  const uid = '$(id -u)';
  // #5195: this brain's own autopilot job, or the shared job an older install still runs it from.
  const job = resolveAutopilotJob();
  const installed = detectInstalledJob(job).installed;
  const launchd = installed?.target === 'macos' ? installed.name : job.launchdLabel;
  const systemd = installed?.target === 'linux-systemd' ? installed.name : job.systemdUnit;
  const drain = `gbrain projections drain${limit === undefined ? '' : ` --limit ${limit}`}${brain === 'host' ? '' : ` --brain ${brain}`}`;
  const cycle = (stop: string, start: string) => `${stop} && { ${drain}; ${start}; }`;
  return [
    `To drain faster, stop the owner, drain, then restart it:`,
    `  serve service (launchd): ${cycle(`launchctl bootout gui/${uid}/${SERVE_LAUNCHD_LABEL}`, `launchctl bootstrap gui/${uid} ~/Library/LaunchAgents/${SERVE_LAUNCHD_LABEL}.plist`)}`,
    `  serve service (systemd): ${cycle(`systemctl --user stop ${SERVE_SYSTEMD_UNIT}`, `systemctl --user start ${SERVE_SYSTEMD_UNIT}`)}`,
    `  autopilot (launchd): ${cycle(`launchctl bootout gui/${uid}/${launchd}`, `launchctl bootstrap gui/${uid} ~/Library/LaunchAgents/${launchd}.plist`)}`,
    `  autopilot (systemd): ${cycle(`systemctl --user stop ${systemd}`, `systemctl --user start ${systemd}`)}`,
    `  a manual gbrain serve: stop it${pid ? ` (kill ${pid})` : ''}, run ${drain}, then start gbrain serve again`,
  ].join('\n');
}

/**
 * #6803: the exclusive two-step Action for a PGLite brain a resident holds:
 * stop the owner (step one, the user's), then the drain (`requires_exclusive`),
 * then start the owner and verify through the resident-backed doctor read.
 * `status` is the resident's `projection_status` (null: it gave none).
 */
export function residentDrainAction(holder: LockHolderInfo, brain = 'host', status: ProjectionBacklog | null = null): Action {
  const limit = projectionDrainLimit(status ? status.pending : 1);
  const brainArgs = brain === 'host' ? [] : ['--brain', brain];
  const owner = `${holder.subcommand ? `gbrain ${holder.subcommand}` : 'a gbrain process'}${holder.pid ? ` (pid ${holder.pid})` : ''}`;
  const text = Math.min(status?.pending ?? limit, limit);
  const seconds = Math.max(1, Math.ceil(text / TEXT_REBUILD_PAGES_PER_SECOND + Math.min(status?.sealable ?? 0, limit - text) / IMAGE_SEAL_PAGES_PER_SECOND));
  const counts = status ? `${status.sealable ?? 'an unknown number of'} image page(s) the drain can seal and ${status.pending} queued text page(s)`
    : 'queued pages (the resident did not report its counts)';
  const argv = ['gbrain', 'projections', 'drain', '--limit', String(limit), ...brainArgs];
  const drain: Action = {
    argv, consent: [], actor: 'user', requires_exclusive: true,
    why: `Seals importer-attested image pages and rebuilds queued text, keyless, at most ${limit} pages per run (repeat until sealable is 0); start the owner again afterwards.`,
    verify: { argv: ['gbrain', 'doctor', ...brainArgs, '--only', 'text_projection_readiness', '--json'] },
  };
  return {
    ...(holder.pid ? { argv: ['kill', String(holder.pid)] } : {}), consent: [], actor: 'user', requires_exclusive: false,
    why: `${owner} holds this PGLite brain and drains text only; sealing images needs the database to itself. Stop it, run the next step, then start it again (the commands are in the error hint).`,
    user_message: `This brain has ${counts}. The running gbrain owner, ${owner}, drains text only, so sealing needs it stopped for about ${seconds} second(s) per drain run; harnesses connected through that serve disconnect until it restarts. Please stop it, run \`${argv.join(' ')}\`, then start it again.`,
    then: drain,
  };
}

/** DX-O5 refusal: the drain did not run because a resident process holds this PGLite brain. */
export function projectionOwnerResidentError(holder: LockHolderInfo, dataDir: string, brain = 'host', status: ProjectionBacklog | null = null): OperationError {
  const owner = `${holder.subcommand ? `gbrain ${holder.subcommand}` : 'a gbrain process'}${holder.pid ? ` (pid ${holder.pid})` : ''}`;
  const error = catalogueError('projection_owner_resident',
    `The PGLite brain at ${dataDir} is held by ${owner}, so the drain did not run.`,
    [
      `The upgraded resident drains queued text projections itself (up to 100 pages per pass, fewer while writes wait); it never seals image pages, so watch the pending count with \`gbrain doctor${brain === 'host' ? '' : ` --brain ${brain}`}\` (text_projection_readiness).`,
      residentDrainSteps(holder.pid, brain),
    ].join('\n'));
  error.fix = residentDrainAction(holder, brain, status);
  return error;
}

