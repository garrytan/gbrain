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

import type { MinionJobContext } from '../types.ts';
import type { BrainEngine } from '../../engine.ts';
import type { IngestionEvent } from '../../ingestion/types.ts';
import { validateIngestionEvent } from '../../ingestion/types.ts';
import { importFromContent } from '../../import-file.ts';
import { maintenanceTransaction } from '../../persistence/attribution.ts';
import { managedPersistenceEnabled } from '../../persistence/ownership.ts';
import { privateRequestRefusal } from '../../persistence/visibility-request.ts';
import { parseMarkdown } from '../../markdown.ts';
import { OperationError, type OperationContext } from '../../ops/contract.ts';
import { submitPageMutation } from '../../persistence/page-mutations.ts';

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

export function makeIngestCaptureHandler(engine: BrainEngine) {
  return async function ingestCaptureHandler(job: MinionJobContext): Promise<IngestCaptureResult> {
    const data = job.data as { event?: unknown; slug?: unknown; sourceId?: unknown };
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
      const put = async (sid: string) => {
        const snapshot = await engine.readPageSnapshot(slug, { sourceId: sid, includeDeleted: true });
        return door('put_page', sid, { content: event.content, content_origin: 'tool_output', source_kind: event.source_kind, source_uri: event.source_uri,
          ingested_via: 'ingest_capture', ...(snapshot ? { expected_revision: snapshot.revision } : {}),
          // #2044/#4548: as `remote: untrustedPayload` does unmanaged, an untrusted body keeps the non-world facts rows and takes rows its sender could not see.
          ...(untrustedPayload ? { keep_hidden_rows: true } : {}) });
      };
      let response: Record<string, unknown>;
      try {
        response = await put(sourceId ?? 'default');
      } catch (err) {
        // The door refuses a source that vanished or was archived after the pre-check (the managed form of the FK retry).
        const vanished = sourceId !== undefined && err instanceof OperationError && err.code === 'source_changed'
          ? await engine.executeRaw<{ archived: boolean | null }>('SELECT archived FROM sources WHERE id = $1', [sourceId]) : null;
        if (!vanished || (vanished.length > 0 && vanished[0]?.archived !== true)) throw err;
        sourceFallback = { requested: sourceId!, effective: 'default', reason: vanished.length ? 'archived' : 'fk_violation' };
        response = await put('default');
      }
      if (sourceFallback) {
        console.error(
          `[WARN] ingest_capture: requested source '${sourceFallback.requested}' unavailable ` +
          `(${sourceFallback.reason}); wrote under default`,
        );
      }
      const outcome = (response.outcome ?? {}) as { noop?: boolean; chunks?: number };
      return {
        slug,
        status: outcome.noop ? 'skipped' : 'imported',
        chunks: Number(outcome.chunks ?? 0),
        untrusted_payload: untrustedPayload,
        source_kind: event.source_kind,
        source_uri: event.source_uri,
        ...(sourceFallback ? { source_fallback: sourceFallback } : {}),
      };
    }

    let result;
    try {
      result = await importFromContent(engine, slug, event.content, { ...importOpts, sourceId });
    } catch (err) {
      // The sources row can vanish (ON DELETE CASCADE) between the pre-check and
      // this write. 23503 = foreign_key_violation (cf. oauth-provider.ts:1053),
      // but SQLSTATE alone is too broad: a violation from chunks/tags/versions
      // would be misread as "source unavailable" and silently rewritten to the
      // default partition, masking a real integrity failure.
      //
      // Match the PAGES source FK specifically. Matching any message mentioning
      // "source" is not tight enough to carry a routing decision: many tables
      // reference sources(id) (files_source_id_fkey, facts_source_id_fkey,
      // code_edges, calibration_profiles, …), so a genuine integrity failure on
      // one of those would be rewritten as reason:'fk_violation' — exactly the
      // masking this check exists to prevent. maybeRewriteSourceFkError
      // (commands/capture.ts) can afford the looser match because it only
      // formats a human hint; here the verdict moves data. Prefer the driver's
      // structured constraint/table fields (postgres.js and PGLite both expose
      // them) and fall back to the message for wrapped errors.
      const errMsg = err instanceof Error ? err.message : String(err);
      const fkErr = err as { code?: string; constraint?: string; table?: string };
      const namesPagesSourceFk =
        (typeof fkErr.constraint === 'string' && /^pages_source_id_fk/.test(fkErr.constraint)) ||
        (fkErr.table === 'pages' && typeof fkErr.constraint === 'string' && fkErr.constraint.includes('source')) ||
        /pages_source_id_fk/.test(errMsg) ||
        (errMsg.includes('foreign key constraint') && errMsg.includes('"pages"'));
      const isSourceFk = fkErr?.code === '23503' && namesPagesSourceFk;
      if (sourceId !== undefined && isSourceFk) {
        sourceFallback = { requested: sourceId, effective: 'default', reason: 'fk_violation' };
        result = await importFromContent(engine, slug, event.content, { ...importOpts, sourceId: undefined });
      } else {
        throw err;
      }
    }
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

    return {
      slug,
      status: result.status,
      chunks: result.chunks,
      untrusted_payload: untrustedPayload,
      source_kind: event.source_kind,
      source_uri: event.source_uri,
      ...(sourceFallback ? { source_fallback: sourceFallback } : {}),
    };
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
