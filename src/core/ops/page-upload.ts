/**
 * Upload sessions (Wave B, spec 6.2): begin_page_upload, upload_page_part,
 * get_page_upload, commit_page_upload and abort_page_upload write a page
 * larger than one request in parts. Every op is write scope and treats
 * `ctx.remote !== false` as untrusted, with put_page's posture: begin routes
 * the source through the write grant and the slug through both slug fences,
 * the session is bound to its creating principal, source incarnation and page
 * (any mismatch answers `upload_not_found`, exactly as an unknown id does),
 * staged bytes count against per-principal and per-brain quotas, and commit
 * submits an ordinary put_page by reference (persistence/page-upload.ts), so
 * admission, sanitizing and the revision check run as for content sent
 * inline. Never import from '../operations.ts' here (cycle).
 */
import { randomUUID } from 'node:crypto';
import type { Operation, OperationContext } from './contract.ts';
import { OperationError, opError } from './contract.ts';
import { enforceClientSlugFence, enforceSubagentSlugFence, sourceScopeOpts, validatePageSlug } from './context.ts';
import { initializeLocalPersistence, pageMutationSource, requestPrincipalForContext, submitPageMutation } from '../persistence/page-mutations.ts';
import { CONTENT_ORIGIN_PARAM, PAGE_MUTATION_PARAMS, WRITE_WAIT_PARAM } from '../persistence/params.ts';
import { parseWriteRequestId } from '../persistence/preconditions.ts';
import { isWriteRequestId } from '../persistence/types.ts';
import { getWriteRequest } from '../persistence/journal.ts';
import { submissionAuthority } from '../persistence/authority.ts';
import { pageNotVisibleError } from '../persistence/page-visibility.ts';
import { assertLargePageAdmission } from '../persistence/large-page-guard.ts';
import { sha256 } from '../persistence/digest.ts';
import { isTerminal, type Principal, type WriteRequest } from '../persistence/model.ts';
import { PAGE_MAX_BYTES } from '../page-size-policy.ts';
import { contentSizeHold } from '../markdown.ts';
import { readPageBodyPolicy } from '../page-body/limits.ts';
import { contentRefusalError, loadImportSanityConfig } from '../import-screen.ts';
import { DEFAULT_WRITE_GATE_CONFIG, writeGateApplies } from '../write-gate.ts';
import { admitPageAppend } from '../persistence/page-append.ts';
import {
  abortUpload, appendPart, expireIfLapsed, partBytes, partMaxFrameBytes, partSha256, readUpload, readUploadByRequest, reserveUpload,
  isStagingBodyRef, sealUpload, stagedSha256, transitionUploads, uploadExpired, uploadNotFound, uploadPartFrameBytes, uploadPartLimit, type StagingBodyRef, type UploadMode, type UploadRow,
} from '../persistence/page-upload.ts';

const MODES: readonly UploadMode[] = ['create', 'replace', 'append'];
const SHA256_HEX = /^[0-9a-f]{64}$/i;
const PUT_PAGE_FLAGS = ['allow_shrink', 'allow_empty', 'drop_timeline', 'content_origin'] as const;

async function callerPrincipal(ctx: OperationContext): Promise<Principal> {
  await initializeLocalPersistence(ctx);
  return requestPrincipalForContext(ctx);
}

/**
 * The binding every call after begin re-checks: the creating principal; for a remote caller, its write source (inside
 * its read scope); the source still active at the incarnation the session began under; and, until the session is
 * committed, the page it began against (for create: still no page at the slug).
 */
function callerMayUse(ctx: OperationContext, principal: Principal, row: UploadRow, opts: { ownerOnly?: boolean } = {}): boolean {
  if (row.principal_kind !== principal.kind || row.principal_id !== principal.id) return false;
  if (ctx.remote !== false) {
    const scope = sourceScopeOpts(ctx);
    const readable = scope.sourceIds ?? (scope.sourceId !== undefined ? [scope.sourceId] : null);
    if (row.source_id !== (ctx.auth?.sourceId ?? ctx.sourceId ?? 'default') || (readable && !readable.includes(row.source_id))) return false;
  }
  try {
    enforceClientSlugFence(ctx, row.slug, 'begin_page_upload');
    enforceSubagentSlugFence(ctx, row.slug, 'begin_page_upload');
  } catch { return false; }
  if (opts.ownerOnly) return true;
  if (row.source_archived !== false || row.current_incarnation !== row.source_incarnation) return false;
  const uncommitted = row.commit_request_id === null && ['open', 'sealed', 'prepared'].includes(row.state);
  if (uncommitted && (row.mode === 'create' ? row.current_page_id !== null : row.current_page_id !== row.page_id)) return false;
  return true;
}

async function boundUpload(ctx: OperationContext, principal: Principal, uploadId: unknown, opts: { exec?: OperationContext['engine']; lock?: boolean; ownerOnly?: boolean } = {}): Promise<UploadRow> {
  if (!isWriteRequestId(uploadId)) throw uploadNotFound();
  const row = await readUpload(opts.exec ?? ctx.engine, uploadId.toLowerCase(), { lock: opts.lock });
  if (!row || !callerMayUse(ctx, principal, row, { ownerOnly: opts.ownerOnly })) throw uploadNotFound();
  return row;
}

/**
 * A lapsed session expires here (`upload_expired`); when another call moved it on first (a commit sealed it), the row
 * is read again and the caller follows its real state instead of reporting an expiry that did not happen.
 */
async function settleLapse(ctx: OperationContext, principal: Principal, row: UploadRow, opts: { ownerOnly?: boolean } = {}): Promise<UploadRow> {
  if (await expireIfLapsed(ctx.engine, row)) throw uploadExpired(row);
  if (!row.lapsed) return row;
  const current = await boundUpload(ctx, principal, row.id, opts);
  if (current.state === 'expired') throw uploadExpired(current);
  return current;
}

/** @internal Forced-race seam of the commit test: runs after commit sealed the session and hashed its parts. */
export const uploadCommitProbe: { afterHash?: (uploadId: string) => Promise<void> } = {};

function sessionStatus(ctx: OperationContext, row: UploadRow) {
  return { upload_id: row.id, state: row.state, next_part: row.next_part, received_bytes: row.received_bytes, total_bytes: row.declared_bytes,
    part_max_frame_bytes: partMaxFrameBytes(ctx), expires: row.idle_expires_at < row.hard_expires_at ? row.idle_expires_at : row.hard_expires_at,
    idle_expires_at: row.idle_expires_at, hard_expires_at: row.hard_expires_at };
}

const statusFix = (uploadId: string) => ({ mcp: { tool: 'get_page_upload', arguments: { upload_id: uploadId } }, consent: [], actor: 'agent' as const, requires_exclusive: false,
  why: 'Returns the part to send next and the bytes received so far.' });
const pageFix = (slug: string, sourceId: string) => ({ argv: ['gbrain', 'get', '--source', sourceId, '--', slug],
  mcp: { tool: 'get_page', arguments: { slug, source_id: sourceId, body: 'none' } }, consent: [], actor: 'agent' as const, requires_exclusive: false,
  why: "Returns the page's current revision and size without its body." });

function revisionChanged(slug: string, sourceId: string): OperationError {
  return opError('revision_changed', `Page ${slug} changed since this upload began, so the upload was not committed and nothing was written.`,
    "Read the page's current revision with get_page body: 'none', then begin a new upload with mode replace and that expected_revision.",
    { fix: pageFix(slug, sourceId) });
}

function invalidParam(message: string, suggestion: string): OperationError {
  return opError('invalid_params', message, suggestion);
}

/**
 * A body over the single-string ceiling: create and replace go up to the brain's page ceiling (pages.max_bytes, the
 * engine ceiling by default) through the segmented streamed preparation; an append stays within the ceiling (lane 3a
 * reads appended text whole). A remote writer is refused at once where the write gate applies to an agent-written page,
 * since the gate scans a whole body and commit would refuse the same way.
 */
async function assertLargeUploadAdmissible(ctx: OperationContext, mode: UploadMode, total: number): Promise<void> {
  const ceiling = mode === 'append' ? PAGE_MAX_BYTES : Math.max(PAGE_MAX_BYTES, (await readPageBodyPolicy(ctx.engine)).maxBytes);
  if (total > ceiling) {
    throw opError('request_too_large', contentSizeHold(total, ceiling)!.message, mode === 'append'
      ? `Nothing was staged. An append upload carries at most ${PAGE_MAX_BYTES} bytes; append the text in several uploads.`
      : `Nothing was staged. Pages up to ${ceiling} bytes are stored and searchable on this brain; split the content into smaller pages.`);
  }
  if (ctx.remote !== false && mode !== 'append' && writeGateApplies('agent_written', (await loadImportSanityConfig(ctx.engine)).writeGate ?? DEFAULT_WRITE_GATE_CONFIG)) {
    throw contentRefusalError({ code: 'file_too_large', message: `Page too large (${total} bytes) for this writer: the write gate scans an agent-written page whole, and a page over ${PAGE_MAX_BYTES} bytes is never held whole.` },
      `Nothing was staged. Split the content into pages of at most ${PAGE_MAX_BYTES} bytes; whether agent-written pages may skip the write gate (write_gate.agent_mode) is the brain host operator's decision.`,
      { legacy_error: 'request_too_large' });
  }
}

const begin_page_upload: Operation = {
  name: 'begin_page_upload',
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Start writing a page too large for one request: then upload_page_part from part 0 and commit_page_upload. Same request_id resumes this upload.',
  params: {
    slug: { type: 'string', required: true, description: 'Page slug.' },
    source_id: PAGE_MUTATION_PARAMS.source_id,
    mode: { type: 'string', required: true, enum: [...MODES], description: 'create a new page, replace it (expected_revision required) or append to it.' },
    total_bytes: { type: 'number', required: true, description: 'UTF-8 bytes of the complete content.' },
    sha256: { type: 'string', required: true, description: 'Hex SHA-256 of those bytes.' },
    expected_revision: { type: 'string', description: 'Revision read; required for replace.' },
    request_id: { type: 'string', required: true, description: 'Reuse only to resume this upload.' },
  },
  mutating: true,
  scope: 'write',
  area: 'pages',
  handler: async (ctx, p) => {
    const sourceId = pageMutationSource(ctx, p, 'begin_page_upload');
    const mode = p.mode as UploadMode;
    if (!MODES.includes(mode)) throw invalidParam('mode must be create, replace or append.', 'Pass mode create for a new page, replace with expected_revision for an existing one, or append.');
    const slug = typeof p.slug === 'string' ? p.slug.toLowerCase() : '';
    validatePageSlug(slug);
    enforceClientSlugFence(ctx, slug, 'begin_page_upload');
    enforceSubagentSlugFence(ctx, slug, 'begin_page_upload');
    const total = p.total_bytes;
    if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 1) {
      throw invalidParam('total_bytes must be a positive whole number of bytes.', 'Pass the UTF-8 byte length of the complete content.');
    }
    if (total > PAGE_MAX_BYTES) await assertLargeUploadAdmissible(ctx, mode, total);
    if (typeof p.sha256 !== 'string' || !SHA256_HEX.test(p.sha256)) throw invalidParam('sha256 must be 64 hex characters.', 'Pass the hex SHA-256 of the complete content\'s UTF-8 bytes.');
    if (p.request_id === undefined) throw invalidParam('request_id is required.', 'Pass a new UUID; send the same request_id again only to resume this upload.');
    const clientRequestId = parseWriteRequestId(p.request_id)!;
    const expected = p.expected_revision;
    if (expected !== undefined && !isWriteRequestId(expected)) throw invalidParam('expected_revision must be the UUID returned by a page read.', 'Read the page and pass its revision unchanged.');
    if (mode === 'replace' && expected === undefined) {
      throw invalidParam('mode replace requires expected_revision.', "Read the page with get_page body: 'none' and pass its revision as expected_revision.");
    }
    if (mode === 'create' && expected !== undefined) throw invalidParam('mode create takes no expected_revision.', 'Use mode replace to write over an existing page.');
    if (ctx.dryRun) return { dry_run: true, action: 'begin_page_upload', slug, mode };
    const want = { sourceId, slug, mode, totalBytes: total, sha256: p.sha256.toLowerCase(), baseRevision: (expected as string | undefined)?.toLowerCase() ?? null };
    const principal = await callerPrincipal(ctx);
    const resumed = async (row: UploadRow) => {
      if (row.source_id !== want.sourceId || row.slug !== want.slug || row.mode !== want.mode || row.declared_bytes !== want.totalBytes
        || row.declared_sha256 !== want.sha256 || row.base_revision !== want.baseRevision) {
        throw opError('idempotency_conflict', 'This request_id already began a different upload.', 'Begin this upload with a new request_id; reuse a request_id only to resume the same upload.');
      }
      if (!callerMayUse(ctx, principal, row)) throw uploadNotFound();
      return sessionStatus(ctx, await settleLapse(ctx, principal, row));
    };
    const prior = await readUploadByRequest(ctx.engine, principal, clientRequestId);
    if (prior) return resumed(prior);
    const [source] = await ctx.engine.executeRaw<{ incarnation: string; archived: boolean }>('SELECT incarnation::text AS incarnation, archived FROM sources WHERE id=$1', [sourceId]);
    if (!source || source.archived) {
      throw opError('source_changed', 'The write source is not active.', `Source ${sourceId} is archived or not registered, so nothing was staged. Write to an active source (sources_list shows them).`);
    }
    // put_page's grant and visibility checks first: a page this caller may not see answers as put_page does, before any read of it.
    await submissionAuthority(ctx, mode === 'append' ? 'append_page' : 'put_page', sourceId, source.incarnation, slug);
    const snapshot = await ctx.engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
    if (mode === 'create' && snapshot) {
      throw opError('revision_required', `Page ${slug} already exists, so an upload with mode create cannot write it; nothing was staged.`,
        "Read the page with get_page body: 'none', then begin with mode replace and its revision as expected_revision.", { fix: pageFix(slug, sourceId) });
    }
    if (mode !== 'create' && (!snapshot || snapshot.page.deleted_at)) {
      if (ctx.remote !== false) throw pageNotVisibleError();
      throw opError('page_not_found', `Page not found: ${slug}`, `An upload with mode ${mode} writes an existing page; begin with mode create to make it.`);
    }
    if (mode !== 'create' && want.baseRevision !== null && snapshot!.revision !== want.baseRevision) throw revisionChanged(slug, sourceId);
    const id = randomUUID();
    try {
      await reserveUpload(ctx.engine, { id, principal, clientRequestId, sourceId, sourceIncarnation: source.incarnation, slug,
        pageId: snapshot ? Number(snapshot.page.id) : null, mode, baseRevision: want.baseRevision, totalBytes: total, sha256: want.sha256 });
    } catch (error) {
      const raced = await readUploadByRequest(ctx.engine, principal, clientRequestId);
      if (raced) return resumed(raced);
      throw error;
    }
    return sessionStatus(ctx, (await readUpload(ctx.engine, id))!);
  },
};

const upload_page_part: Operation = {
  name: 'upload_page_part',
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Send the next part of an upload: part equals next_part, the whole call within part_max_frame_bytes, cut between code points.',
  params: {
    upload_id: { type: 'string', required: true, description: 'From begin_page_upload.' },
    part: { type: 'number', required: true, description: 'Part number: next_part, from 0.' },
    text: { type: 'string', required: true, description: 'The next slice of the content.' },
    part_sha256: { type: 'string', required: true, description: "Hex SHA-256 of this part's UTF-8 bytes." },
  },
  mutating: true,
  scope: 'write',
  area: 'pages',
  handler: async (ctx, p) => {
    const part = p.part;
    if (typeof part !== 'number' || !Number.isSafeInteger(part) || part < 0) throw invalidParam('part must be a whole number from 0.', 'Send next_part from begin_page_upload or get_page_upload.');
    if (typeof p.part_sha256 !== 'string' || !SHA256_HEX.test(p.part_sha256)) throw invalidParam('part_sha256 must be 64 hex characters.', "Pass the hex SHA-256 of this part's UTF-8 bytes.");
    const partSha = p.part_sha256.toLowerCase();
    const cap = partMaxFrameBytes(ctx);
    const frame = uploadPartFrameBytes({ upload_id: String(p.upload_id), part, text: typeof p.text === 'string' ? p.text : '', part_sha256: partSha });
    if (frame > cap) {
      throw opError('part_too_large', `This part's frame is ${frame} bytes, over this connection's ${cap}-byte part limit (part_max_frame_bytes), so it was not stored.`,
        `Cut the part so the whole call's encoded JSON stays within ${cap} bytes (escaped quotes, backslashes and control characters count at their escaped size), then send it again as part ${part}.`,
        { detail: JSON.stringify({ frame_bytes: frame, part_max_frame_bytes: cap }) });
    }
    const bytes = partBytes(p.text);
    if (sha256(bytes) !== partSha) throw invalidParam('part_sha256 does not match the SHA-256 of this part\'s UTF-8 bytes.', 'Hash exactly the UTF-8 bytes of text and send the part again.');
    if (ctx.dryRun) return { dry_run: true, action: 'upload_page_part', upload_id: p.upload_id, part };
    const principal = await callerPrincipal(ctx);
    const outcome = await ctx.engine.transaction(async (tx): Promise<{ expired: UploadRow } | { state: { received_bytes: number; next_part: number } }> => {
      const row = await boundUpload(ctx, principal, p.upload_id, { exec: tx, lock: true });
      if (row.state === 'expired' || row.lapsed) return { expired: row };
      if (part < row.next_part) {
        if (await partSha256(tx, row.id, part) === partSha) return { state: { received_bytes: row.received_bytes, next_part: row.next_part } };
        throw opError('idempotency_conflict', `Part ${part} of this upload was already received with different bytes.`,
          `Resume at part ${row.next_part}; to change content already sent, abort this upload and begin a new one.`, { fix: statusFix(row.id) });
      }
      if (row.state !== 'open') {
        throw opError('invalid_params', `This upload is ${row.state}, so it takes no more parts.`, 'Commit it with commit_page_upload, or begin a new upload.', { fix: statusFix(row.id) });
      }
      if (part !== row.next_part) {
        throw opError('invalid_params', `Parts are sent in order: this upload expects part ${row.next_part}, not ${part}.`, `Send part ${row.next_part} next.`, { fix: statusFix(row.id) });
      }
      const limit = uploadPartLimit(row.declared_bytes, cap);
      if (part >= limit && row.received_bytes + bytes.byteLength < row.declared_bytes) {
        throw opError('upload_too_many_parts', `This upload takes at most ${limit} parts for its ${row.declared_bytes} bytes, and part ${part} does not complete it, so it was not stored.`,
          `Send the remaining ${row.declared_bytes - row.received_bytes} bytes in part ${part}, cut near part_max_frame_bytes (${cap}); or abort this upload and begin again with larger parts.`, { fix: statusFix(row.id) });
      }
      if (row.received_bytes + bytes.byteLength > row.declared_bytes) {
        throw invalidParam(`This part would make the upload ${row.received_bytes + bytes.byteLength} bytes, over its declared total_bytes (${row.declared_bytes}).`,
          'Send only the remaining bytes of the content, or abort and begin again with the right total_bytes.');
      }
      return { state: await appendPart(tx, row, bytes, partSha) };
    });
    if ('expired' in outcome) {
      const current = await settleLapse(ctx, principal, outcome.expired);
      throw opError('invalid_params', `This upload is ${current.state}, so it takes no more parts.`, 'Commit it with commit_page_upload, or begin a new upload.', { fix: statusFix(current.id) });
    }
    return outcome.state;
  },
};

const get_page_upload: Operation = {
  name: 'get_page_upload',
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'An upload\'s state and next_part, to resume after a lost reply.',
  params: { upload_id: { type: 'string', required: true, description: 'From begin_page_upload.' } },
  mutating: false,
  scope: 'write',
  area: 'pages',
  handler: async (ctx, p) => {
    const principal = await callerPrincipal(ctx);
    return sessionStatus(ctx, await settleLapse(ctx, principal, await boundUpload(ctx, principal, p.upload_id)));
  },
};

const abort_page_upload: Operation = {
  name: 'abort_page_upload',
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Discard an uncommitted upload session: its staged parts are deleted and its quota is freed.',
  params: { upload_id: { type: 'string', required: true, description: 'From begin_page_upload.' } },
  mutating: true,
  scope: 'write',
  area: 'pages',
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'abort_page_upload', upload_id: p.upload_id };
    // The creating principal in its source may always abort, even after the page, slug or source incarnation moved on.
    const principal = await callerPrincipal(ctx);
    const row = await settleLapse(ctx, principal, await boundUpload(ctx, principal, p.upload_id, { ownerOnly: true }), { ownerOnly: true });
    if (row.state === 'aborted') return { upload_id: row.id, state: 'aborted' };
    if (row.state !== 'committed' && await abortUpload(ctx.engine, row.id)) return { upload_id: row.id, state: 'aborted' };
    const [request] = row.commit_request_id ? await ctx.engine.executeRaw<Pick<WriteRequest, 'state'>>('SELECT state FROM persistence_requests WHERE id = $1::uuid', [row.commit_request_id]) : [];
    if (row.state !== 'committed' && request && !isTerminal(request)) {
      throw opError('write_pending', 'A commit of this upload is still being written, so it cannot be aborted now.',
        'Call commit_page_upload again with this upload_id to wait for its result; abort it only if that commit ends without writing.', { fix: statusFix(row.id) });
    }
    throw opError('invalid_params', 'This upload was already committed, so it cannot be aborted.', 'Read the write with commit_page_upload (it returns the receipt again).', { fix: statusFix(row.id) });
  },
};

const commit_page_upload: Operation = {
  name: 'commit_page_upload',
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Write an upload\'s page once every part is sent; returns put_page\'s receipt. Repeat after a lost reply.',
  params: {
    upload_id: { type: 'string', required: true, description: 'From begin_page_upload.' },
    allow_empty: { type: 'boolean', description: 'Allow emptying the page.' },
    allow_shrink: { type: 'boolean', description: 'Allow content under half a >256 KB page.', fullSurfaceOnly: true },
    drop_timeline: { type: 'boolean', description: 'No Timeline in content: delete its entries.' },
    content_origin: CONTENT_ORIGIN_PARAM,
    wait_ms: WRITE_WAIT_PARAM,
  },
  mutating: true,
  scope: 'write',
  area: 'pages',
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'commit_page_upload', upload_id: p.upload_id };
    const principal = await callerPrincipal(ctx);
    let row = await boundUpload(ctx, principal, p.upload_id);
    const isSubmitted = (r: UploadRow) => r.state === 'committed' || r.commit_request_id !== null;
    if (!isSubmitted(row)) row = await settleLapse(ctx, principal, row);
    // Sealing is the commit's claim: an atomic open -> sealed that takes the session out of idle expiry. A call that
    // loses it (another commit sealed first, or the session ended) reads the session again and follows its real state.
    if (!isSubmitted(row) && row.state === 'open') {
      if (row.received_bytes !== row.declared_bytes) {
        throw opError('invalid_params', `This upload has ${row.received_bytes} of its ${row.declared_bytes} bytes, so it cannot be committed yet.`,
          `Send part ${row.next_part} and the rest, then commit.`, { fix: statusFix(row.id) });
      }
      if (!await sealUpload(ctx.engine, row.id)) row = await settleLapse(ctx, principal, await boundUpload(ctx, principal, row.id));
      else {
        const hashed = await stagedSha256(ctx.engine, row);
        await uploadCommitProbe.afterHash?.(row.id);
        if (hashed !== row.declared_sha256) {
          await abortUpload(ctx.engine, row.id);
          throw opError('invalid_params', 'The uploaded bytes do not match the sha256 declared at begin, so the upload was discarded and nothing was written.',
            'Begin again with the SHA-256 of exactly the content you send.');
        }
        row = { ...row, state: 'sealed' };
      }
    }
    const submitted = isSubmitted(row);
    if (!submitted) {
      if (row.state === 'expired') throw uploadExpired(row);
      if (row.state === 'aborted') throw uploadNotFound();
      if (row.state === 'open') throw opError('write_pending', 'Another call is committing this upload.', 'Call commit_page_upload again with this upload_id.', { fix: statusFix(row.id) });
    }
    const bodyRef: StagingBodyRef = { kind: 'staging', staging_id: row.id, sha256: row.declared_sha256, bytes: row.declared_bytes };
    if (row.mode === 'append') {
      try {
        return await admitPageAppend(ctx, { slug: row.slug, source_id: row.source_id, request_id: row.client_request_id, body_ref: bodyRef,
          ...(row.base_revision ? { expected_revision: row.base_revision } : {}), ...(p.wait_ms !== undefined ? { wait_ms: p.wait_ms } : {}) }, { stagedBody: true });
      } finally {
        await settleCommit(ctx, principal, row).catch(() => undefined);
      }
    }
    const params: Record<string, unknown> = { slug: row.slug, source_id: row.source_id, request_id: row.client_request_id, body_ref: bodyRef,
      ...(row.mode === 'replace' ? { expected_revision: row.base_revision } : {}),
      ...Object.fromEntries(PUT_PAGE_FLAGS.filter(key => p[key] !== undefined).map(key => [key, p[key]])),
      ...(p.wait_ms !== undefined ? { wait_ms: p.wait_ms } : {}) };
    if (!submitted && row.mode === 'replace') {
      const current = await ctx.engine.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
      if (current?.revision !== row.base_revision) {
        await abortUpload(ctx.engine, row.id);
        throw revisionChanged(row.slug, row.source_id);
      }
      if (ctx.remote !== false) await assertLargePageAdmission(ctx.engine, row.slug, row.source_id, params);
    }
    try {
      return await submitPageMutation(ctx, { operation: 'put_page', params, stagedBody: true });
    } catch (error) {
      if (row.mode === 'replace' && error instanceof OperationError && error.code === 'revision_conflict') throw revisionChanged(row.slug, row.source_id);
      throw error;
    } finally {
      await settleCommit(ctx, principal, row).catch(() => undefined);
    }
  },
};

/** Records the session's commit request, and ends the session when that write ended without committing (releasing its bytes). */
async function settleCommit(ctx: OperationContext, principal: Principal, row: UploadRow): Promise<void> {
  const request = await getWriteRequest(ctx.engine, principal, row.client_request_id);
  const ref = (request?.intent as Record<string, unknown> | undefined)?.body_ref;
  if (!request || !isStagingBodyRef(ref) || ref.staging_id !== row.id) return;
  await ctx.engine.executeRaw('UPDATE page_body_stagings SET commit_request_id = COALESCE(commit_request_id, $2::uuid) WHERE id = $1::uuid', [row.id, request.id]);
  if (isTerminal(request) && request.state !== 'committed') await transitionUploads(ctx.engine, 'aborted', 's.id = $1::uuid', [row.id]);
}

export const pageUploadOperations: Operation[] = [begin_page_upload, upload_page_part, get_page_upload, commit_page_upload, abort_page_upload];
