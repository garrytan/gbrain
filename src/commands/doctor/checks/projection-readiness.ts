import type { BrainEngine } from '../../../core/engine.ts';
import type { PageReadScope } from '../../../core/types.ts';
import type { Action } from '../../../core/agent-output.ts';
import { probeProjectionReadiness } from '../../../core/search/projection-readiness.ts';
import { projectionBacklog, type ProjectionBacklog } from '../../../core/page-state/projections.ts';
import { projectionDrainLimit } from '../../../core/page-state/image-seal.ts';
import type { PersistenceProjectionStatus } from '../../../core/persistence/ipc.ts';
import { isMultimodalEnabled } from '../../../core/sync.ts';
import { readCredentialResealHolds } from '../../../core/page-state/credential-reseal.ts';
import type { Check } from '../../doctor.ts';
import type { DoctorContext, DoctorEntry } from '../context.ts';

const DOCS = 'docs/guides/repair.md#projection-drain';
const UNCHANGED = 'No repair or embedding was started by this check.';
const CODE_REPAIR = 'For code metadata repair, run `gbrain reindex-code --force --no-embed`. If work stays pending, inspect the recorded source path.';
const DRAIN_PREVIEW = ['gbrain', 'projections', 'drain', '--dry-run', '--json'];
const IMAGES_PREVIEW = ['gbrain', 'embed', '--stale', '--images', '--dry-run', '--json'];

/** #6803: the class counts doctor reports (counts only, never identifiers). */
function classDetails(backlog: Required<ProjectionBacklog>) {
  const { pending, failed, sealable, sealable_with_visual, reimport, ocr_required, protected: guarded, archived, oldest_age_seconds, as_of } = backlog;
  return { pending, failed, sealable, sealable_with_visual, reimport, ocr_required, protected: guarded, archived, oldest_age_seconds, as_of };
}

/** One sentence per class that needs work or is unsealed by design, from the backlog's counts. */
function classSentences(backlog: Required<ProjectionBacklog>, resident: boolean): string[] {
  const sentences: string[] = [];
  if (backlog.sealable) {
    sentences.push(`${backlog.sealable} image page(s) the importer already attested (${backlog.sealable_with_visual} with a visual vector) are out of search until \`gbrain projections drain\` seals them (keyless: no provider call, no re-embedding; preview with \`gbrain projections drain --dry-run --json\`)${resident ? '; the resident never seals images' : ''}.`);
  }
  if (backlog.reimport) {
    sentences.push(`${backlog.reimport} image page(s) need their importer (fresh OCR and pixels, paid): preview with \`gbrain embed --stale --images --dry-run\`${backlog.ocr_required
      ? `; ${backlog.ocr_required} of them held protected OCR before an edit and are sealed only after a successful fresh OCR pass, so they need OCR enabled (GBRAIN_EMBEDDING_IMAGE_OCR=true)` : ''}.`);
  }
  if (backlog.protected || backlog.archived) {
    sentences.push(`${backlog.protected} protected-OCR image(s) and ${backlog.archived} archived-source page(s) stay unsealed by design: search leaves them out until the image is reimported without protected content or the source is restored.`);
  }
  return sentences;
}

/**
 * The fix for a queue that needs work: the drain when text or sealable images
 * wait (ask first when it would seal images: Decision 3), else the paid
 * importer route for `reimport` images, or null with the setting that blocks it.
 * A remote caller cannot run either: the host admin does.
 */
function projectionFix(backlog: Required<ProjectionBacklog>, opts: { remote?: boolean }): { fix?: Action; blocked?: string } {
  const actor = opts.remote ? 'host_admin' as const : 'agent' as const;
  if (backlog.pending || backlog.sealable) {
    const limit = projectionDrainLimit(backlog.pending);
    return { fix: { argv: ['gbrain', 'projections', 'drain', '--limit', String(limit)], preview_argv: DRAIN_PREVIEW, consent: [], actor, requires_exclusive: false,
      ...(backlog.sealable ? { ask_user: true as const,
        user_message: `${backlog.sealable} image page(s) are out of search until they are sealed. \`gbrain projections drain --limit ${limit}\` seals the ones the importer already attested (keyless, no provider call, no re-embedding), at most ${limit} per run; may I run it, repeating until sealable is 0?` } : {}),
      why: `Rebuilds queued Markdown and code projections and seals importer-attested image pages in place, at most ${limit} pages per run; repeat until the dry run shows sealable 0.`,
      verify: { argv: DRAIN_PREVIEW }, docs: DOCS } };
  }
  if (!backlog.reimport) return {};
  if (!isMultimodalEnabled()) return { blocked: 'GBRAIN_EMBEDDING_MULTIMODAL' };
  return { fix: { argv: ['gbrain', 'embed', '--stale', '--images', '--max-usd', '<USD>'], preview_argv: IMAGES_PREVIEW, consent: ['paid', 'egress'], actor, ask_user: true,
    requires_exclusive: false, inputs: [{ name: 'USD', how: 'a dollar cap the user approves after reading the dry run' }],
    user_message: `${backlog.reimport} image page(s) can be sealed only by a fresh import (OCR and one multimodal embedding per image, paid)${backlog.ocr_required
      ? `; ${backlog.ocr_required} of them need OCR enabled (GBRAIN_EMBEDDING_IMAGE_OCR=true) and a successful fresh OCR pass` : ''}. The dry run counts them; may I run the paid sweep with a cap you choose?`,
    why: 'Re-imports each image from its source file: fresh OCR decides safety from the current pixels, then the importer seals it.',
    verify: { argv: IMAGES_PREVIEW }, docs: DOCS } };
}

/**
 * #5401: `resident` is true when the caller runs inside a PGLite resident (the
 * run_doctor operation on a serving process), where the drain command would
 * refuse; the resident drains text itself. #6803: the check reports every
 * class of the queue (page-state/projection-class.ts): `pending` text,
 * `sealable` and `reimport` images and `failed` rows warn; `protected` and
 * `archived` are by design (ok, info). `remote` callers get the host admin's fix.
 */
export async function checkProjectionReadiness(engine: BrainEngine, scope: PageReadScope = {}, opts: { resident?: boolean; remote?: boolean } = {}): Promise<Check> {
  const readiness = await probeProjectionReadiness(engine, scope);
  const backlog = readiness.status === 'unknown' ? null : await projectionBacklog(engine, scope).catch(() => null);
  if (!backlog) {
    return { name: 'text_projection_readiness', status: 'warn', details: { readiness: 'unknown', ready: false },
      message: 'Text projection readiness is unknown because its read-only probe failed; index completeness could not be verified.' };
  }
  // Wave B: pages stored in segments whose chunks were not built after their write committed (not searchable yet);
  // counted brain-wide, so only for an unscoped (local) doctor.
  const segmented = readiness.status === 'projection_pending' && Object.keys(scope).length === 0 ? Number((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages
    WHERE deleted_at IS NULL AND body_storage='segmented' AND text_projection_revision IS DISTINCT FROM knowledge_revision`).catch(() => []))[0]?.n ?? 0) : 0;
  const segmentedNote = segmented ? ` ${segmented} page(s) stored in segments are not searchable yet; ${opts.resident
    ? 'the resident builds them too.' : '`gbrain projections drain` builds them as well.'}` : '';
  // GBRA-130 A-27: pages the v0.60.31 credential re-chunk held; remote callers get the count only.
  const held = await readCredentialResealHolds(engine, scope.sourceIds ?? (scope.sourceId ? [scope.sourceId] : undefined)).catch(() => []);
  const details = { readiness: readiness.status, ready: readiness.ready, ...classDetails(backlog), ...(segmented ? { segmented_pending: segmented } : {}),
    ...(held.length ? { credential_reseal_held: held.length, ...(opts.remote ? {} : { held_pages: held.slice(0, 20).map(hold => ({ source_id: hold.source_id, slug: hold.slug,
      code: hold.code, attempts: hold.attempts, fix: hold.fix.argv })) }) } : {}) };
  const work = backlog.pending + backlog.sealable + backlog.reimport;
  if (work === 0 && readiness.status !== 'projection_pending' && !held.length) {
    const byDesign = classSentences(backlog, false);
    return byDesign.length
      ? { name: 'text_projection_readiness', status: 'ok', severity: 'info', fix_unavailable_reason: 'operator_judgement', details,
        message: `No queued projection needs work. ${byDesign.join(' ')}` }
      : { name: 'text_projection_readiness', status: 'ok', message: 'Visible text projections match their canonical revisions.', details };
  }
  const heldText = held.length ? `${held.length} page(s) holding a private key failed their credential-safe re-chunk and stay withheld from search${opts.remote ? '' : ` (${held.slice(0, 3)
    .map(hold => `${hold.source_id}:${hold.slug} ${hold.code}`).join(', ')}${held.length > 3 ? ', ...' : ''})`}; retry them with ${[...new Set(held.map(hold => `\`${hold.fix.argv!.join(' ')}\``))].join(', ')}.` : '';
  const text = backlog.pending || (work === 0 && readiness.status === 'projection_pending')
    ? `Visible pages have missing or stale text projections${backlog.pending ? ` (${backlog.pending} queued Markdown/code page(s)${backlog.failed ? `, ${backlog.failed} last failed` : ''})` : ''}; search and code results may be incomplete. ${opts.resident
      ? 'The resident gbrain process that holds this PGLite brain is rebuilding queued Markdown and code projections (up to 100 pages per pass, fewer while writes wait). On the brain host, `gbrain doctor --only text_projection_readiness --json` shows the counts and how to drain faster.'
      : 'Run `gbrain projections drain` to rebuild queued Markdown and code projections now; it is safe while `gbrain serve` runs on Postgres.'}${segmentedNote} ${CODE_REPAIR}`
    : '';
  const projection = opts.resident ? {} : projectionFix(backlog, opts);
  const blocked = projection.blocked;
  const fix = projection.fix ?? (held.length && !opts.resident ? { ...held[0]!.fix, actor: opts.remote ? 'host_admin' as const : 'agent' as const } : undefined);
  const unavailable = blocked ? ` Re-importing images needs multimodal embeddings, which are off (set ${blocked}=true on the brain host, then preview with \`gbrain embed --stale --images --dry-run\`).` : '';
  return {
    name: 'text_projection_readiness', status: 'warn',
    message: [text, heldText, ...classSentences(backlog, opts.resident === true)].filter(Boolean).join(' ') + unavailable + ` ${UNCHANGED}`,
    details: blocked ? { ...details, reimport_blocked_by: blocked } : details,
    ...(fix ? { fix } : { fix_unavailable_reason: 'operator_judgement' as const }),
  };
}

/** The doctor text when a PGLite resident holds the datastore, from its projection_status reply (null: it gave none). */
export function residentProjectionReadiness(pid: number | undefined, status: PersistenceProjectionStatus | null, steps: string, drainFix?: Action): Pick<Check, 'status' | 'message' | 'details' | 'fix' | 'fix_unavailable_reason'> {
  const owner = `The resident gbrain process${pid ? ` (pid ${pid})` : ''} holds this PGLite brain`;
  if (!status) {
    return {
      status: 'warn',
      message: `${owner} and did not report its projection backlog, so it may predate the faster projection drain. Restart it on the upgraded gbrain so it drains up to 100 pages per pass. ${steps}`,
      details: { readiness: 'unknown', ready: false, owner_pid: pid ?? null, docs: DOCS },
      fix_unavailable_reason: 'operator_judgement',
    };
  }
  // #6803: a resident that predates the class counts answers only pending/failed; its image rows are invisible to it.
  if (status.sealable === undefined) {
    return {
      status: 'warn',
      message: `${owner} and predates this upgrade: it reports only ${status.pending} queued text projection(s) and cannot count image pages. Restart it on the upgraded gbrain, then run \`gbrain doctor --only text_projection_readiness --json\` again. ${steps}`,
      details: { readiness: 'unknown', ready: false, owner_pid: pid ?? null, ...status, docs: DOCS },
      fix_unavailable_reason: 'operator_judgement',
    };
  }
  const backlog = { sealable_with_visual: 0, reimport: 0, ocr_required: 0, protected: 0, archived: 0, as_of: '', ...status } as Required<ProjectionBacklog>;
  const work = backlog.pending + backlog.sealable + backlog.reimport;
  const details = { readiness: work ? 'projection_pending' : 'ready', ready: work === 0, owner_pid: pid ?? null, ...classDetails(backlog), docs: DOCS };
  const images = classSentences(backlog, true);
  if (work === 0) {
    return images.length
      ? { status: 'ok', message: `${owner} and reports no queued text projections. ${images.join(' ')}`, details, fix_unavailable_reason: 'operator_judgement' }
      : { status: 'ok', message: `${owner} and reports no queued text projections.`, details };
  }
  const age = status.oldest_age_seconds === null ? '' : `; the oldest was queued ${status.oldest_age_seconds}s ago`;
  const failed = status.failed ? `; ${status.failed} last failed and are retried after 30 seconds` : '';
  const draining = status.pending
    ? `${owner} and is draining ${status.pending} queued text projections${age}${failed}. Search and code results may be incomplete until it finishes; it rebuilds up to 100 pages per pass, fewer while writes wait. Re-run \`gbrain doctor\` to watch the count.`
    : `${owner}; it has no queued text projections${age}.`;
  return {
    status: 'warn',
    message: [draining, ...images, steps, UNCHANGED].join(' '),
    details,
    ...(backlog.sealable && drainFix ? { fix: drainFix } : { fix_unavailable_reason: 'operator_judgement' as const }),
  };
}

async function runProjectionResident(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  if (ctx.engine || ctx.fastMode) return checks;
  const { loadConfig } = await import('../../../core/config.ts');
  const { getCliOptions } = await import('../../../core/cli-options.ts');
  const { resolveBrainId } = await import('../../../core/brain-resolver.ts');
  const { loadMounts } = await import('../../../core/brain-registry.ts');
  const { persistenceConfigForBrain } = await import('../../../core/persistence/local-client.ts');
  const { inspectLockHolder } = await import('../../../core/pglite-lock.ts');
  const { persistenceSocketPathForConfig, requestPersistenceProjectionStatus } = await import('../../../core/persistence/ipc.ts');
  const { residentDrainSteps, residentDrainAction } = await import('../../projections.ts');
  let config: ReturnType<typeof persistenceConfigForBrain>;
  let brainId: string;
  try {
    brainId = resolveBrainId(getCliOptions().brain, process.cwd());
    config = persistenceConfigForBrain(loadConfig(), brainId, brainId === 'host' ? [] : loadMounts());
  } catch { return checks; }
  if (config?.engine !== 'pglite' || !config.database_path || config.database_url) return checks;
  const holder = inspectLockHolder(config.database_path);
  if (!holder.held) return checks;
  const socketPath = persistenceSocketPathForConfig(config);
  let status: PersistenceProjectionStatus | null = null;
  if (socketPath) {
    try { status = await requestPersistenceProjectionStatus(socketPath); } catch { /* an older resident, or none listening */ }
  }
  checks.push({ name: 'text_projection_readiness', ...residentProjectionReadiness(holder.pid, status, residentDrainSteps(holder.pid, brainId),
    residentDrainAction(holder, brainId, status)) });
  return checks;
}

/**
 * Filesystem-lane entry (#5401, E-T1): when the engine did not open because a
 * PGLite resident holds the datastore, ask that resident for its projection
 * backlog over the read-only persistence IPC op.
 */
export const projectionResidentEntry: DoctorEntry = {
  name: 'text_projection_readiness',
  emits: ['text_projection_readiness'],
  run: runProjectionResident,
};
