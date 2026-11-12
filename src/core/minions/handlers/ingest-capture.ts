/**
 * `ingest_capture` Minion job handler. Receives an IngestionEvent payload
 * from the daemon's dispatcher (or the webhook source's POST /ingest
 * handler) and routes it through `importFromContent` to land as a brain
 * page.
 *
 * Trust posture (E1 + eng-review decisions):
 *   - The event's `untrusted_payload` flag is preserved on the job's
 *     result for audit, but does NOT change the importFromContent call
 *     itself — auto-link runs at the put_page operation layer, which we
 *     deliberately bypass here. The handler calls importFromContent
 *     directly. v1 path: webhook OAuth gate is the trust boundary; the
 *     handler trusts the event-shape but treats content as user-authored
 *     markdown.
 *   - Auto-link integration with the untrusted_payload tag is a v2
 *     improvement (would require routing through the put_page op AND
 *     extending OperationContext with the trust tag). See TODOs in the
 *     plan.
 *   - G6: on a managed brain the capture is a local put_page through the
 *     persistence door (a tombstone a delete_page), so its file is published
 *     before its row; content_origin tool_output keeps it external_untrusted.
 *
 * Slug resolution (in order):
 *   1. `job.data.slug` if caller provided one
 *   2. `job.data.metadata.slug` if event metadata carried one
 *   3. Generated default: `inbox/YYYY-MM-DD-<hash6>` using the event's
 *      content_hash prefix. Stable for the same content.
 *
 * The default slug deliberately lives under `inbox/` — that's the
 * triage convention the user will discover when reviewing recent
 * captures. A downstream skill (post-capture-triage) can promote inbox
 * pages to canonical homes later.
 */

import { randomUUID } from 'node:crypto';
import type { MinionJobContext } from '../types.ts';
import type { BrainEngine } from '../../engine.ts';
import type { IngestionEvent } from '../../ingestion/types.ts';
import { validateIngestionEvent } from '../../ingestion/types.ts';
import { importFromContent } from '../../import-file.ts';
import { maintenanceTransaction } from '../../persistence/attribution.ts';
import { managedPersistenceEnabled } from '../../persistence/ownership.ts';
import { privateRequestRefusal } from '../../persistence/visibility-request.ts';
import { parseMarkdown } from '../../markdown.ts';
import { OperationError, opError, type OperationContext } from '../../ops/contract.ts';
import { submitPageMutation } from '../../persistence/page-mutations.ts';
import { authorizePageVisibility, defaultSourceMemberWriter, excludesPrivateWrites, remoteLabelsChecked } from '../../persistence/page-visibility.ts';
import type { Principal, WriteAuthority } from '../../persistence/model.ts';
import { assertMemberPageWriter, assertScopePageWriter } from '../../access/member-facts.ts';
import { validateSlug } from '../../utils.ts';
import { REVISION_BACKFILL_PENDING, RevisionBackfillPendingError } from '../../page-state/types.ts';
import { appliedCaptureRequestPrefix, readAppliedCapture, recordAppliedCapture, saveAppliedCapture } from '../../ingestion/applied-captures.ts';

export interface IngestCaptureResult {
  slug: string;
  status: 'imported' | 'skipped' | 'deleted' | 'error';
  chunks: number;
  untrusted_payload: boolean;
  source_kind: string;
  source_uri: string;
  source_fallback?: {
    requested: string;
    effective: 'default';
    reason: 'not_registered' | 'archived' | 'fk_violation';
  };
}

/** Builds the default slug for an event when the caller didn't provide one. */
export function defaultSlugForEvent(event: IngestionEvent, now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const hashPrefix = event.content_hash.slice(0, 6);
  return `inbox/${y}-${m}-${d}-${hashPrefix}`;
}

/**
 * A foreign_key_violation (23503, cf. oauth-provider.ts:1053) on the PAGES source FK. SQLSTATE alone is too broad: a
 * violation from chunks/tags/versions would be misread as "source unavailable" and silently rewritten to the default
 * partition, masking a real integrity failure.
 *
 * Matching any message mentioning "source" is not tight enough to carry a routing decision: many tables reference
 * sources(id) (files_source_id_fkey, facts_source_id_fkey, code_edges, calibration_profiles, …), so a genuine integrity
 * failure on one of those would be rewritten as reason:'fk_violation' — exactly the masking this check exists to
 * prevent. maybeRewriteSourceFkError (commands/capture.ts) can afford the looser match because it only formats a human
 * hint; here the verdict moves data. Prefer the driver's structured constraint/table fields (postgres.js and PGLite both
 * expose them) and fall back to the message for wrapped errors.
 */
function isPagesSourceFkViolation(err: unknown): boolean {
  const errMsg = err instanceof Error ? err.message : String(err);
  const fkErr = err as { code?: string; constraint?: string; table?: string };
  const namesPagesSourceFk =
    (typeof fkErr.constraint === 'string' && /^pages_source_id_fk/.test(fkErr.constraint)) ||
    (fkErr.table === 'pages' && typeof fkErr.constraint === 'string' && fkErr.constraint.includes('source')) ||
    /pages_source_id_fk/.test(errMsg) ||
    (errMsg.includes('foreign key constraint') && errMsg.includes('"pages"'));
  return fkErr?.code === '23503' && namesPagesSourceFk;
}

/** Rolls back a capture's page write when another run of its idempotency key already recorded the capture (GST-1856). */
class CaptureAlreadyApplied extends Error {}

/** The token or OAuth client the POST /ingest route stored on the job, or undefined (checked as a guest). */
function webhookPrincipal(writer: unknown): Principal | undefined {
  const principal = (writer as { principal?: { kind?: unknown; id?: unknown } } | null | undefined)?.principal;
  if (!principal || typeof principal.id !== 'string' || (principal.kind !== 'legacy_token' && principal.kind !== 'oauth_client')) return undefined;
  return { kind: principal.kind, id: principal.id } as Principal;
}

/**
 * A webhook capture replaces a page only where its writer's own remote write could: never a member fact page or the
 * scope page, and never a page the writer cannot read (another member's readable_by page, a private page). A job with
 * no stored writer is checked as a guest, which reads no restricted page.
 */
export async function assertWebhookWriterMayReplace(engine: BrainEngine, writer: unknown, sourceId: string, slug: string, content?: string): Promise<string | null | undefined> {
  const target = validateSlug(slug);
  assertMemberPageWriter({ remote: true }, target, 'ingest_capture');
  assertScopePageWriter({ remote: true }, target, 'ingest_capture');
  const authority = { version: 1, principal: webhookPrincipal(writer), remote: true, sourceId, sourceIncarnation: '',
    scopes: [], operations: null, slugPrefixes: null, excludePrivate: await excludesPrivateWrites(engine, true) } as WriteAuthority;
  // GST-2051 x GST-2112: POST /ingest refuses a member-bound credential writing to default; a job queued before that
  // refusal (or before the binding) is refused here at write time, since the capture cannot keep the page to the member.
  if (authority.principal && await defaultSourceMemberWriter(engine, authority)) {
    throw opError('permission_denied', `A capture from a credential bound to a member whose write source is ${sourceId}, which every credential without a source grant reads, is refused: its page would land where other members and unbound credentials read.`,
      'Write through the MCP put_page op, which keeps a new page to its member, or ask the brain operator to grant this credential its own write source that is not federated (gbrain auth rescope --sources <private-source>,default).');
  }
  // GST-2112: the snapshot is read before the visibility check, so the revision returned (which binds the write) is
  // never older than the state the writer was authorized against.
  const stored = content === undefined ? undefined : await engine.readPageSnapshot(target, { sourceId, includeDeleted: true });
  await authorizePageVisibility(engine, authority, target);
  if (content === undefined) return;
  // The capture writes through a trusted local path, so apply the remote put_page readers rule here: a body never
  // drops readable_by from a page that names readers, and the readers it names keep the writer.
  const frontmatter = parseMarkdown(content, target + '.md', { validate: true }).frontmatter;
  await remoteLabelsChecked(engine, authority, target, stored?.page, { parsedPage: { frontmatter } });
  // A page the revision backfill has not reached has no revision to bind the write to: refused, kept in the job row for `gbrain jobs retry`.
  if (stored?.revision === REVISION_BACKFILL_PENDING) throw new RevisionBackfillPendingError(null);
  return stored?.revision ?? null;
}

export function makeIngestCaptureHandler(engine: BrainEngine) {
  return async function ingestCaptureHandler(job: MinionJobContext): Promise<IngestCaptureResult> {
    const data = job.data as { event?: unknown; slug?: unknown; sourceId?: unknown; writer?: unknown };
    const event = data.event as IngestionEvent | undefined;
    if (!event) {
      throw new Error('ingest_capture: job.data.event is required');
    }
    const validationErr = validateIngestionEvent(event);
    if (validationErr) {
      throw new Error(`ingest_capture: invalid event payload: ${validationErr.message}`);
    }

    // Slug resolution. #3756 added the top-level event.slug (required for
    // tombstones, optional upsert hint) between the caller-provided job slug
    // and the legacy metadata.slug channel.
    let slug: string;
    if (typeof data.slug === 'string' && data.slug.length > 0) {
      slug = data.slug;
    } else if (typeof event.slug === 'string' && event.slug.length > 0) {
      slug = event.slug;
    } else if (
      event.metadata &&
      typeof (event.metadata as Record<string, unknown>).slug === 'string'
    ) {
      slug = (event.metadata as Record<string, unknown>).slug as string;
    } else {
      slug = defaultSlugForEvent(event);
    }

    // Untrusted-payload posture. For v1, the flag is propagated for audit
    // but not enforced at this layer (see file header). Future v2 wiring
    // through put_page will use this flag.
    const untrustedPayload = event.untrusted_payload === true;

    // For text-typed events, content is the inline markdown/text. For
    // binary types (image/audio/video/pdf), content is a path-or-URI that
    // the content-type processor pipeline transforms. The v1 wave lands
    // the text path; processors arrive in subsequent commits.
    const isText =
      event.content_type === 'text/markdown' ||
      event.content_type === 'text/plain' ||
      event.content_type === 'text/html' ||
      event.content_type === 'application/json' ||
      event.content_type === 'unknown';

    // #3756: tombstones carry no importable content — they name a page to
    // delete. Content-type gating below is an import concern; skip it.
    const isTombstone = event.kind === 'tombstone';

    if (isTombstone && event.untrusted_payload !== false) {
      // Trusted-source gate: an untrusted channel (webhook payload, URL
      // fetcher) must never be able to delete pages. FAIL-CLOSED: deletes
      // require the EXPLICIT trusted marker (untrusted_payload: false) —
      // rejecting only `=== true` left an omitted flag treated as trusted,
      // so any emitter that forgot the field could tombstone pages. Fail
      // the job loud so the attempt is visible in the jobs ledger, not
      // silently dropped.
      throw new Error(
        'ingest_capture: refusing tombstone without an explicit trusted marker — ' +
          'deletes are only honored from trusted local emitters that set ' +
          'untrusted_payload: false on the event',
      );
    }

    if (!isText && !isTombstone) {
      // Binary content without a processor would land as a path-string
      // page, which isn't useful. Surface as job-level error so the
      // operator sees the gap in `gbrain doctor` and can decide whether
      // to install the appropriate skillpack-distributed processor.
      throw new Error(
        `ingest_capture: content_type '${event.content_type}' requires a content-type ` +
          `processor that is not yet installed. Install a processor skillpack ` +
          `(e.g. gbrain-audio-transcribe, gbrain-image-ocr) or pre-extract the ` +
          `content to text/markdown before emitting.`,
      );
    }

    // noEmbed defaults to true. Mirrors the sync handler's pattern:
    // embed runs as a separate Minion job (autopilot's embed phase OR an
    // explicit `gbrain embed --stale`). Callers can opt in to inline embed
    // by passing { noEmbed: false } in job.data.
    const noEmbed = (data as { noEmbed?: unknown }).noEmbed !== false;

    // Write-source resolution — two distinct paths, kept separate on purpose.
    //
    //   1. job.data.sourceId — the server-resolved write source. The webhook
    //      route sets it from authInfo.sourceId (never from a request header),
    //      so it is not caller-chosen on that path. NOTE it is not structurally
    //      confined to that producer: `ingest_capture` is absent from
    //      PROTECTED_JOB_NAMES, so an admin-scoped `submit_job` can also set it
    //      (as it can already forge event.source_id on path 2). Validated here
    //      against a LIVE (non-archived) sources row; on a miss we fall back to
    //      the default source AND report it via source_fallback (+ a stderr
    //      warning) so the miss is observable.
    //   2. event.source_id — the daemon / non-webhook emitter path (#1522):
    //      used iff it names a registered source row, silent fallback to default
    //      otherwise. Deliberately NOT archived-filtered and NOT reported, so
    //      daemon steady-state behavior stays byte-identical (an unregistered
    //      emitter id is normal there, not worth a per-capture warning). A source
    //      that vanishes mid-write is still caught by the FK-violation retry
    //      below (never-lose) regardless of path.
    let sourceId: string | undefined;
    let sourceFallback: IngestCaptureResult['source_fallback'];
    const trustedSourceId =
      typeof data.sourceId === 'string' && data.sourceId.length > 0
        ? data.sourceId
        : undefined;
    if (trustedSourceId && trustedSourceId !== 'default') {
      // `archived` reads as a real JS boolean on both engines; match the
      // established idiom at sources-ops.ts:784 (`?.archived === true`).
      //
      // This read is outside the write transaction, so a source archived in the
      // gap still has its row and the write's FK succeeds: the capture lands in
      // a just-archived source (search hides archived sources) and reports no
      // fallback. Deliberately not locked — archiving is an operator action with
      // a recovery window, the page is recoverable by un-archiving, and taking a
      // row lock on `sources` for every capture would serialize ingestion behind
      // it. Deletion, the destructive case, IS covered by the FK retry below.
      const rows = await engine.executeRaw<{ id: string; archived: boolean | null }>(
        `SELECT id, archived FROM sources WHERE id = $1`,
        [trustedSourceId],
      );
      if (rows.length === 0) {
        sourceFallback = { requested: trustedSourceId, effective: 'default', reason: 'not_registered' };
      } else if (rows[0]?.archived === true) {
        sourceFallback = { requested: trustedSourceId, effective: 'default', reason: 'archived' };
      } else {
        sourceId = trustedSourceId;
      }
    } else if (!untrustedPayload && event.source_id && event.source_id !== 'default') {
      // #1522 daemon path, unchanged: register-and-use, silent default fallback.
      const rows = await engine.executeRaw<{ id: string }>(
        `SELECT id FROM sources WHERE id = $1`,
        [event.source_id],
      );
      if (rows.length > 0) sourceId = event.source_id;
    }

    // G6: a managed brain refuses direct writes, so its captures and tombstones go through the door (put_page /
    // delete_page), which publishes the file before the row.
    const managed = await managedPersistenceEnabled(engine);
    const captured = (status: IngestCaptureResult['status'], chunks: number): IngestCaptureResult => ({ slug, status, chunks,
      untrusted_payload: untrustedPayload, source_kind: event.source_kind, source_uri: event.source_uri, ...(sourceFallback ? { source_fallback: sourceFallback } : {}) });
    // GST-1856: a capture applies once per job idempotency key. A later run of the key (a stalled attempt re-run after
    // its write landed, a POST /ingest replayed after `gbrain jobs prune`) returns the first run's result and writes
    // nothing, so it never reverts a newer edit. Tombstones and jobs queued without a key keep their old behavior.
    const appliedKey = !isTombstone && job.idempotency_key ? job.idempotency_key : null;
    const managedOutcome = (outcome: { noop?: boolean; chunks?: number }) => captured(outcome.noop ? 'skipped' : 'imported', Number(outcome.chunks ?? 0));
    const journal = managed ? { sourceIds: [...new Set([sourceId ?? 'default', 'default'])], slug: slug.toLowerCase(), result: managedOutcome } : undefined;
    const applied = appliedKey ? await readAppliedCapture<IngestCaptureResult>(engine, appliedKey, journal) : null;
    if (applied) return applied;

    const webhookWrite = untrustedPayload && event.source_kind === 'webhook' && !isTombstone;
    const checkWriter = (sid: string) => webhookWrite ? assertWebhookWriterMayReplace(engine, data.writer, sid, slug, event.content) : Promise.resolve(undefined);
    let checkedRevision = await checkWriter(sourceId ?? 'default');
    const door = (operation: 'put_page' | 'delete_page', sid: string, params: Record<string, unknown>) => submitPageMutation(
      { engine, config: { engine: engine.kind } as OperationContext['config'], remote: false, dryRun: false, sourceId: sid, logger: { info() {}, warn() {}, error() {} } },
      { operation, params: { ...params, slug, source_id: sid } });

    // #3756: tombstone → reconciler-style soft-delete (deleted_at stamp, page
    // restorable), scoped to the resolved source — never unscoped, so a
    // same-slug page in another source is untouched. Idempotent: a missing or
    // already-deleted page reports 'skipped'.
    if (isTombstone) {
      const deleted = managed ? await managedTombstone(engine, slug, sourceId ?? 'default', door)
        : await maintenanceTransaction(engine, tx => tx.softDeletePage(slug, { sourceId: sourceId ?? 'default' }));
      if (sourceFallback) {
        console.error(
          `[WARN] ingest_capture: requested source '${sourceFallback.requested}' unavailable ` +
            `(${sourceFallback.reason}); tombstone applied under default`,
        );
      }
      return {
        slug,
        status: deleted ? 'deleted' : 'skipped',
        chunks: 0,
        untrusted_payload: untrustedPayload,
        source_kind: event.source_kind,
        source_uri: event.source_uri,
        ...(sourceFallback ? { source_fallback: sourceFallback } : {}),
      };
    }

    // Shared across the write and its FK-violation retry so provenance can't
    // drift between the two call sites.
    const importOpts = {
      noEmbed,
      source_kind: event.source_kind,
      source_uri: event.source_uri,
      ingested_via: 'ingest_capture',
      // #1699 trust boundary. This handler bypasses the put_page op layer, so
      // the marker-stripping put_page performs for remote callers never ran on
      // this path. Untrusted content (every POST /ingest body) must not be able
      // to carry gate-owned frontmatter: `quarantine` hides a page from search,
      // and `content_flag.detail` injects text into the agent-trusted warning
      // channel. Trusted daemon emitters leave it false and keep their markers.
      remote: untrustedPayload,
      // #5575 A3: webhook and ingestion-daemon captures are external content: stored external_untrusted and gated.
      writeGate: { tier: 'external_untrusted' as const, origin: { channel: `ingest:${event.source_kind}`, source_uri: event.source_uri ?? null, source_kind: event.source_kind }, requestId: null },
      // #7880: a private request page privacy would not read is held, not stored world-readable (refused below).
      holdNoncanonicalPrivate: true,
    };

    if (managed) {
      // The door's put_page strips gate-owned markers from every ordinary write (#1699/#6259), and content_origin
      // tool_output stores and gates the capture external_untrusted (#5575 A3), as importOpts does unmanaged.
      // A capture replaces the page as it stands, so it binds to the revision read just before (the door requires one to
      // replace an existing page); a write landing in between refuses revision_conflict and the job retries.
      // GST-1856: each run of a keyed capture sends a new request_id under the capture's prefix, so the applied check above
      // finds a committed run in the door's journal even when the worker died before recording it. The id is new per run
      // because a stall re-run keeps attempts_made and `gbrain jobs retry` resets it: an id reused for an earlier request
      // that failed would replay that failure instead of writing. Another run of the key can commit after the check above
      // (a stalled original resuming after its re-run), so the check repeats after the snapshot read: any edit that
      // snapshot holds then post-dates a committed run, and expected_revision refuses a run committing after it.
      const requestId = appliedKey ? `${appliedCaptureRequestPrefix(appliedKey)}${job.attempts_made}:${randomUUID()}` : undefined;
      let appliedSince: IngestCaptureResult | null = null;
      const put = async (sid: string, request?: string) => {
        const snapshot = await engine.readPageSnapshot(slug, { sourceId: sid, includeDeleted: true });
        // Checked after the snapshot the write binds to, so readers added before it are seen and any change after it refuses revision_conflict.
        await checkWriter(sid);
        appliedSince = appliedKey ? await readAppliedCapture<IngestCaptureResult>(engine, appliedKey, journal) : null;
        if (appliedSince) return {};
        return door('put_page', sid, { content: event.content, content_origin: 'tool_output', source_kind: event.source_kind, source_uri: event.source_uri,
          ingested_via: 'ingest_capture', ...(snapshot ? { expected_revision: snapshot.revision } : {}), ...(request ? { request_id: request } : {}),
          // #2044/#4548: as `remote: untrustedPayload` does unmanaged, an untrusted body keeps the non-world facts rows and takes rows its sender could not see.
          ...(untrustedPayload ? { keep_hidden_rows: true } : {}) });
      };
      let response: Record<string, unknown>;
      try {
        response = await put(sourceId ?? 'default', requestId);
      } catch (err) {
        // The door refuses a source that vanished or was archived after the pre-check (the managed form of the FK retry).
        const vanished = sourceId !== undefined && err instanceof OperationError && err.code === 'source_changed'
          ? await engine.executeRaw<{ archived: boolean | null }>('SELECT archived FROM sources WHERE id = $1', [sourceId]) : null;
        if (!vanished || (vanished.length > 0 && vanished[0]?.archived !== true)) throw err;
        sourceFallback = { requested: sourceId!, effective: 'default', reason: vanished.length ? 'archived' : 'fk_violation' };
        await checkWriter('default');
        response = await put('default', requestId && `${requestId}:default`);
      }
      if (appliedSince) return appliedSince;
      if (sourceFallback) {
        console.error(
          `[WARN] ingest_capture: requested source '${sourceFallback.requested}' unavailable ` +
          `(${sourceFallback.reason}); wrote under default`,
        );
      }
      // The door answers only a committed write; a pending one throws write_pending and the job retries.
      const result = managedOutcome((response.outcome ?? {}) as { noop?: boolean; chunks?: number });
      if (appliedKey) await recordAppliedCapture(engine, appliedKey, sourceFallback ? 'default' : sourceId ?? 'default', slug, result);
      return result;
    }

    // GST-1856: the record goes in the page write's own transaction; when another run of the key recorded it first, the
    // whole write rolls back (null) and the stored result is returned. The FK retry's first transaction rolls its record back too.
    const importAs = async (sid: string | undefined) => {
      try {
        return await importFromContent(engine, slug, event.content, { ...importOpts, sourceId: sid, ...(checkedRevision !== undefined ? { expectedBaseRevision: checkedRevision } : {}), ...(appliedKey ? { beforeCommit: async (tx: BrainEngine) => {
          if (!await recordAppliedCapture(tx, appliedKey, sid ?? 'default', slug, captured('imported', 0))) throw new CaptureAlreadyApplied();
        } } : {}) });
      } catch (err) {
        if (err instanceof CaptureAlreadyApplied) return null;
        throw err;
      }
    };
    let result;
    try {
      result = await importAs(sourceId);
    } catch (err) {
      // The sources row can vanish (ON DELETE CASCADE) between the pre-check and this write.
      if (sourceId !== undefined && isPagesSourceFkViolation(err)) {
        sourceFallback = { requested: sourceId, effective: 'default', reason: 'fk_violation' };
        checkedRevision = await checkWriter('default');
        result = await importAs(undefined);
      } else {
        throw err;
      }
    }
    if (result === null) return (await readAppliedCapture<IngestCaptureResult>(engine, appliedKey!))!;
    const refused = result.refusal?.code === 'visibility_noncanonical';
    if (sourceFallback) {
      console.error(
        `[WARN] ingest_capture: requested source '${sourceFallback.requested}' unavailable ` +
        `(${sourceFallback.reason}); ${refused ? 'refused' : 'wrote'} under default`,
      );
    }
    // #7880: nothing was stored; the job refuses visibility_not_applied without a retry, as the door's put_page refuses it on a managed brain.
    if (refused) {
      throw privateRequestRefusal({ slug: result.slug, source_id: sourceFallback ? 'default' : sourceId ?? 'default' }, parseMarkdown(event.content, `${result.slug}.md`).frontmatter);
    }

    // The final result replaces the provisional one; an import that wrote nothing (no transaction ran) inserts the row here.
    const final = captured(result.status, result.chunks);
    if (appliedKey && result.status !== 'error') await saveAppliedCapture(engine, appliedKey, sourceFallback ? 'default' : sourceId ?? 'default', slug, final);
    return final;
  };
}

/** A managed tombstone: delete_page through the door when the page is live in the source; a missing page is skipped. */
async function managedTombstone(engine: BrainEngine, slug: string, sourceId: string,
  door: (operation: 'delete_page', sid: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>): Promise<boolean> {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId });
  if (!snapshot || snapshot.page.deleted_at) return false;
  try {
    await door('delete_page', sourceId, { expected_revision: snapshot.revision });
    return true;
  } catch (err) {
    if (err instanceof OperationError && err.code === 'page_not_found') return false;
    throw err;
  }
}
