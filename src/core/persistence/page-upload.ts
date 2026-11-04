/**
 * Upload sessions (Wave B, spec 6.2): the session rows, parts, reservations and
 * the preparation of a committed upload. A session is a `page_body_stagings`
 * row of kind `upload` whose raw parts are `page_body_staging_parts`; its
 * declared bytes are reserved in `persistence_counters` (limits.ts
 * `stagedCounterKeys`) from begin until the session commits (in the
 * publication transaction of its write), aborts or expires (on its next use, at
 * the caller's next begin, or in the segment sweep). Begin recounts the live
 * sessions under the counter row locks, so a session a cascade removed never
 * keeps its capacity.
 *
 * A commit admits an ordinary put_page (or, for mode append, an append_page)
 * whose intent carries `body_ref: {kind: 'staging', staging_id, sha256, bytes}`
 * instead of the text; `withStagedUpload` binds the preparation to the sealed
 * session and commits it in the write's publication. A put_page body within the
 * single-string ceiling (PAGE_MAX_BYTES) is read back and prepared as if the
 * content had been sent, so every put_page rule (remote sanitizing, trust, the
 * timeline omission and shrink guards, the revision check under the page lock)
 * applies; a larger one streams through upload-streamed.ts.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import { encodedFrameBytes } from '../egress-budget.ts';
import { bodyStagingGoneError, LIVE_STAGING_STATES } from '../engine-sql/page-body.ts';
import { ENSURE_COUNTERS_SQL, LOCK_COUNTERS_SQL } from './journal.ts';
import { BRAIN_STAGED_KEY, RELEASE_STAGED_CTE, readUploadLimits, stagedCounterKeys, stagedQuotaExhausted } from './limits.ts';
import type { Principal, SqlEngine, WriteRequest } from './model.ts';
import { timelineSectionOf } from './timeline-omission.ts';
import { PAGE_MAX_BYTES } from '../page-size-policy.ts';

export type UploadMode = 'create' | 'replace' | 'append';
export type UploadState = 'open' | 'sealed' | 'prepared' | 'committed' | 'aborted' | 'expired';

/** Largest part frame on any connection: the stdio and local cap, so the journal and IPC stay small. */
export const UPLOAD_PART_FRAME_CAP_BYTES = 4 * 1024 ** 2;
/** Bytes of a part frame kept for the JSON-RPC envelope around the arguments. */
export const UPLOAD_FRAME_RESERVE_BYTES = 4096;
/** The legacy HTTP transport's default inbound cap (GBRAIN_HTTP_MAX_BODY_BYTES), assumed for an HTTP caller whose cap is unknown. */
export const LEGACY_HTTP_BODY_BYTES = 1024 ** 2;

/**
 * The largest `upload_page_part` frame this connection accepts: its inbound cap (`ctx.inboundFrameBytes`, set by
 * each transport) capped at UPLOAD_PART_FRAME_CAP_BYTES, minus the envelope reserve. A trusted local caller and
 * stdio get the cap; an HTTP caller without a recorded cap gets the legacy HTTP default.
 */
export function partMaxFrameBytes(ctx: Pick<OperationContext, 'remote' | 'transport' | 'inboundFrameBytes'>): number {
  const inbound = ctx.inboundFrameBytes ?? (ctx.remote !== false && ctx.transport !== 'stdio' ? LEGACY_HTTP_BODY_BYTES : UPLOAD_PART_FRAME_CAP_BYTES);
  return Math.min(inbound, UPLOAD_PART_FRAME_CAP_BYTES) - UPLOAD_FRAME_RESERVE_BYTES;
}

/**
 * The most parts one session takes: 64 plus one per 64 KiB of its declared bytes (one per eighth of the part limit on a
 * connection whose limit is under 512 KiB), so a client cutting parts near part_max_frame_bytes, even of fully escaped
 * text, never reaches it while a session of tiny parts cannot grow its part rows without bound.
 */
export function uploadPartLimit(declaredBytes: number, partFrameBytes: number): number {
  return 64 + Math.ceil(declaredBytes / Math.min(64 * 1024, Math.floor(partFrameBytes / 8)));
}

/** The encoded size of one `upload_page_part` call's arguments, the measure clients cut parts by (egress-budget.ts). */
export function uploadPartFrameBytes(args: { upload_id: string; part: number; text: string; part_sha256: string }): number {
  return encodedFrameBytes({ upload_id: args.upload_id, part: args.part, text: args.text, part_sha256: args.part_sha256 });
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** A part's raw UTF-8 bytes. A part that starts or ends inside a code point, or holds an unpaired surrogate, is refused. */
export function partBytes(text: unknown): Buffer {
  if (typeof text !== 'string' || text.length === 0) {
    throw opError('invalid_params', 'text must be a non-empty string.', 'Send the next slice of the page as text; every part holds at least one character.');
  }
  const first = text.charCodeAt(0), last = text.charCodeAt(text.length - 1);
  if ((last >= 0xd800 && last <= 0xdbff) || (first >= 0xdc00 && first <= 0xdfff)) {
    throw opError('part_splits_code_point', 'This part starts or ends inside a code point (half of a surrogate pair), so it was not stored.',
      'Cut parts between code points: move the cut before the high surrogate so both halves of the pair travel in the same part, then send the part again.');
  }
  if (LONE_SURROGATE.test(text)) {
    throw opError('invalid_params', 'text is not valid UTF-8: it holds an unpaired surrogate.', 'Send the page as valid Unicode text; an unpaired surrogate has no UTF-8 encoding.');
  }
  return Buffer.from(text, 'utf8');
}

/** The answer for an unknown upload id and for a session this caller may not use: identical, so it is no existence oracle. */
export function uploadNotFound(): OperationError {
  return opError('upload_not_found', 'No open upload session matches this upload_id for this connection.',
    'Begin a new upload with begin_page_upload (a new request_id), then send its parts from part 0.');
}

export function uploadExpired(row: Pick<UploadRow, 'slug' | 'source_id' | 'mode'>): OperationError {
  return opError('upload_expired', 'This upload session expired before it was committed, so its parts were discarded and nothing was written.',
    'Begin the upload again with begin_page_upload and a new request_id, then send every part from part 0.',
    { fix: { mcp: { tool: 'begin_page_upload', arguments: { slug: row.slug, source_id: row.source_id, mode: row.mode } }, consent: [], actor: 'agent', requires_exclusive: false,
      why: 'An expired session never resumes; a new session takes the same page from its first part.',
      inputs: [{ name: 'total_bytes', how: 'the UTF-8 byte length of the complete page' }, { name: 'sha256', how: 'the hex SHA-256 of those bytes' },
        { name: 'request_id', how: 'a new UUID' }] } });
}

export interface UploadRow {
  id: string; principal_kind: string; principal_id: string; client_request_id: string; source_id: string; source_incarnation: string;
  slug: string; page_id: number | null; mode: UploadMode; base_revision: string | null; base_generation: number | null;
  declared_bytes: number; declared_sha256: string; received_bytes: number; next_part: number; reserved_bytes: number;
  state: UploadState; commit_request_id: string | null; idle_expires_at: string; hard_expires_at: string;
  /** Past a deadline and held by no unfinished write: the session expires on its next use. */
  lapsed: boolean;
  current_incarnation: string | null; source_archived: boolean | null; current_page_id: number | null;
}

const LIVE = `'{${LIVE_STAGING_STATES.join(',')}}'::text[]`;
/** The session `s` is named by an unfinished write (its staged body is a GC root until that write ends). */
const REQUEST_HELD_SQL = `EXISTS (SELECT 1 FROM persistence_requests r WHERE r.state IN ('queued','running','recovering')
      AND r.intent->'body_ref'->>'staging_id' = s.id::text)`;
/**
 * The session `s` expires: an open session past either deadline, a sealed (committing) one only past its hard deadline,
 * which sealing extends by one idle period; never one an unfinished write names. A commit in progress is never expired.
 */
const LAPSED_SQL = `(s.state = ANY(${LIVE}) AND (s.hard_expires_at <= now() OR s.state = 'open' AND s.idle_expires_at <= now()) AND NOT ${REQUEST_HELD_SQL})`;

const iso = (value: unknown) => new Date(value as string | Date).toISOString();
const toRow = (raw: Record<string, unknown>): UploadRow => ({
  ...(raw as unknown as UploadRow),
  page_id: raw.page_id == null ? null : Number(raw.page_id),
  base_generation: raw.base_generation == null ? null : Number(raw.base_generation),
  declared_bytes: Number(raw.declared_bytes), received_bytes: Number(raw.received_bytes), next_part: Number(raw.next_part),
  reserved_bytes: Number(raw.reserved_bytes), current_page_id: raw.current_page_id == null ? null : Number(raw.current_page_id),
  idle_expires_at: iso(raw.idle_expires_at), hard_expires_at: iso(raw.hard_expires_at), lapsed: raw.lapsed === true,
});

const UPLOAD_SELECT = `SELECT s.id::text AS id, s.principal_kind, s.principal_id, s.client_request_id::text AS client_request_id, s.source_id,
    s.source_incarnation::text AS source_incarnation, s.slug, s.page_id, s.mode, s.base_revision::text AS base_revision, s.base_generation,
    s.declared_bytes, encode(s.declared_sha256, 'hex') AS declared_sha256, s.received_bytes, s.next_part, s.reserved_bytes, s.state,
    s.commit_request_id::text AS commit_request_id, s.idle_expires_at, s.hard_expires_at, ${LAPSED_SQL} AS lapsed,
    src.incarnation::text AS current_incarnation, src.archived AS source_archived, p.id AS current_page_id
  FROM page_body_stagings s LEFT JOIN sources src ON src.id = s.source_id LEFT JOIN pages p ON p.source_id = s.source_id AND p.slug = s.slug`;

/** The upload session `id` with its source's current incarnation and the page now at its slug; FOR UPDATE of the session with `lock`. */
export async function readUpload(exec: SqlEngine, id: string, opts: { lock?: boolean } = {}): Promise<UploadRow | null> {
  const [raw] = await exec.executeRaw<Record<string, unknown>>(`${UPLOAD_SELECT} WHERE s.id = $1::uuid AND s.kind = 'upload'${opts.lock ? ' FOR UPDATE OF s' : ''}`, [id]);
  return raw ? toRow(raw) : null;
}

export async function readUploadByRequest(exec: SqlEngine, principal: Principal, clientRequestId: string): Promise<UploadRow | null> {
  const [raw] = await exec.executeRaw<Record<string, unknown>>(`${UPLOAD_SELECT}
    WHERE s.principal_kind = $1 AND s.principal_id = $2 AND s.client_request_id = $3::uuid AND s.kind = 'upload'`, [principal.kind, principal.id, clientRequestId]);
  return raw ? toRow(raw) : null;
}

/**
 * Moves the live upload sessions `where` selects (over alias `s`, binding `params`) to `state`, deletes their parts and
 * releases their reservations in the same statement; returns how many moved. A commit records its request.
 */
export async function transitionUploads(exec: SqlEngine, state: 'aborted' | 'expired' | 'committed', where: string, params: unknown[],
  opts: { commitRequestId?: string } = {}): Promise<number> {
  const commit = opts.commitRequestId !== undefined ? `, commit_request_id = $${params.length + 1}::uuid` : '';
  const [row] = await exec.executeRaw<{ n: number }>(`WITH gone AS (UPDATE page_body_stagings s SET state = '${state}', updated_at = now()${commit}
      WHERE s.kind = 'upload' AND s.state = ANY(${LIVE}) AND ${where} RETURNING s.id, s.kind, s.principal_kind, s.principal_id, s.reserved_bytes),
    ${RELEASE_STAGED_CTE}
    SELECT count(*)::int AS n FROM gone`, opts.commitRequestId !== undefined ? [...params, opts.commitRequestId] : params);
  return Number(row?.n ?? 0);
}

/**
 * Expires the session if it lapsed (releasing its reservation); true only when it was already expired or this call
 * expired it. False on a row that moved on meanwhile (a commit sealed it): the caller re-reads it and follows its state.
 */
export async function expireIfLapsed(exec: SqlEngine, row: UploadRow): Promise<boolean> {
  if (row.state === 'expired') return true;
  if (!row.lapsed) return false;
  return await transitionUploads(exec, 'expired', `s.id = $1::uuid AND ${LAPSED_SQL}`, [row.id]) > 0;
}

/**
 * Aborts the live session unless a commit holds it: no commit was submitted, or the submitted one ended without
 * committing. True when it moved (its parts deleted and its bytes released).
 */
export async function abortUpload(exec: SqlEngine, id: string): Promise<boolean> {
  return await transitionUploads(exec, 'aborted', `s.id = $1::uuid AND NOT ${REQUEST_HELD_SQL} AND (s.commit_request_id IS NULL
    OR EXISTS (SELECT 1 FROM persistence_requests r WHERE r.id = s.commit_request_id AND r.state IN ('conflict','failed','cancelled')))`, [id]) > 0;
}

export interface UploadReservation {
  id: string; principal: Principal; clientRequestId: string; sourceId: string; sourceIncarnation: string; slug: string;
  pageId: number | null; mode: UploadMode; baseRevision: string | null; totalBytes: number; sha256: string;
}

/**
 * Begin: in one transaction, lock the caller's and the brain's staged counters (key order), expire the caller's lapsed
 * sessions, recount every live session (the brain sum leaves out other principals' lapsed sessions, which the sweep
 * expires and which nothing revives: a lapsed session takes no part and cannot be sealed), refuse past a cap (`write_quota_exhausted`), insert the session and store the
 * counts with its reservation.
 */
export async function reserveUpload(engine: BrainEngine, input: UploadReservation): Promise<void> {
  const limits = await readUploadLimits(engine);
  const keys = stagedCounterKeys(input.principal);
  const all = [keys.staged, keys.uploads, BRAIN_STAGED_KEY].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const owner = [input.principal.kind, input.principal.id];
  await engine.transaction(async tx => {
    await tx.executeRaw(ENSURE_COUNTERS_SQL, [all]);
    await tx.executeRaw(LOCK_COUNTERS_SQL, [all]);
    await transitionUploads(tx, 'expired', `s.principal_kind = $1 AND s.principal_id = $2 AND ${LAPSED_SQL}`, owner);
    const [usage] = await tx.executeRaw<{ staged: unknown; brain: unknown; uploads: unknown }>(`SELECT
        COALESCE(SUM(s.reserved_bytes) FILTER (WHERE s.principal_kind = $1 AND s.principal_id = $2), 0)::text AS staged,
        COALESCE(SUM(s.reserved_bytes) FILTER (WHERE NOT ${LAPSED_SQL}), 0)::text AS brain,
        (count(*) FILTER (WHERE s.principal_kind = $1 AND s.principal_id = $2))::text AS uploads
      FROM page_body_stagings s WHERE s.kind = 'upload' AND s.state = ANY(${LIVE})`, owner);
    const staged = Number(usage?.staged ?? 0), brain = Number(usage?.brain ?? 0), uploads = Number(usage?.uploads ?? 0);
    if (uploads + 1 > limits.principalUploads) throw stagedQuotaExhausted('open upload sessions for this connection', 'principalUploads', uploads, limits.principalUploads, 1, 'open_uploads');
    if (staged + input.totalBytes > limits.principalStagedBytes) throw stagedQuotaExhausted('staged upload bytes for this connection', 'principalStagedBytes', staged, limits.principalStagedBytes, input.totalBytes, 'staged_bytes');
    if (brain + input.totalBytes > limits.brainStagedBytes) throw stagedQuotaExhausted('staged upload bytes for this brain', 'brainStagedBytes', null, limits.brainStagedBytes, input.totalBytes, 'staged_bytes');
    await tx.executeRaw(`INSERT INTO page_body_stagings (id, kind, principal_kind, principal_id, client_request_id, source_id, source_incarnation, slug,
        page_id, mode, base_revision, base_generation, declared_bytes, declared_sha256, reserved_bytes, idle_expires_at, hard_expires_at)
      VALUES ($1::uuid, 'upload', $2, $3, $4::uuid, $5, $6::uuid, $7, $8::int, $9, $10::uuid, (SELECT body_generation FROM pages WHERE id = $8::int),
        $11::bigint, decode($12, 'hex'), $11::bigint,
        now() + LEAST($13::bigint, $14::bigint) * interval '1 second', now() + $14::bigint * interval '1 second')`,
    [input.id, input.principal.kind, input.principal.id, input.clientRequestId, input.sourceId, input.sourceIncarnation, input.slug, input.pageId,
      input.mode, input.baseRevision, input.totalBytes, input.sha256, limits.uploadIdleSeconds, limits.uploadMaxSeconds]);
    await tx.executeRaw(`UPDATE persistence_counters SET
        intent_bytes = CASE key WHEN $1 THEN $4::bigint WHEN $2 THEN $5::bigint ELSE intent_bytes END,
        outstanding_count = CASE key WHEN $3 THEN $6::bigint ELSE outstanding_count END
      WHERE key IN ($1, $2, $3)`, [keys.staged, BRAIN_STAGED_KEY, keys.uploads, staged + input.totalBytes, brain + input.totalBytes, uploads + 1]);
  });
}

export async function partSha256(exec: SqlEngine, stagingId: string, part: number): Promise<string | null> {
  const [row] = await exec.executeRaw<{ sha: string }>(`SELECT encode(sha256, 'hex') AS sha FROM page_body_staging_parts WHERE staging_id = $1::uuid AND part_no = $2`, [stagingId, part]);
  return row?.sha ?? null;
}

/** Stores part `next_part` of the locked session and advances it, restarting its idle deadline (never past the hard one). */
export async function appendPart(exec: SqlEngine, row: UploadRow, bytes: Buffer, sha256: string): Promise<{ received_bytes: number; next_part: number }> {
  const limits = await readUploadLimits(exec);
  await exec.executeRaw(`INSERT INTO page_body_staging_parts (staging_id, part_no, byte_start, byte_len, sha256, body)
    VALUES ($1::uuid, $2, $3::bigint, $4, decode($5, 'hex'), $6::bytea)`, [row.id, row.next_part, row.received_bytes, bytes.byteLength, sha256, bytes]);
  const [next] = await exec.executeRaw<{ received_bytes: unknown; next_part: unknown }>(`UPDATE page_body_stagings
    SET received_bytes = received_bytes + $2::bigint, next_part = next_part + 1, updated_at = now(),
        idle_expires_at = LEAST(hard_expires_at, now() + $3::bigint * interval '1 second')
    WHERE id = $1::uuid RETURNING received_bytes, next_part`, [row.id, bytes.byteLength, limits.uploadIdleSeconds]);
  return { received_bytes: Number(next!.received_bytes), next_part: Number(next!.next_part) };
}

/** Hex SHA-256 of the session's stored parts in order, read one part at a time; null when the parts are not contiguous. */
export async function stagedSha256(exec: SqlEngine, row: Pick<UploadRow, 'id' | 'next_part' | 'received_bytes'>): Promise<string | null> {
  const hash = createHash('sha256');
  let at = 0;
  for (let part = 0; part < row.next_part; part++) {
    const [stored] = await exec.executeRaw<{ byte_start: unknown; body: Uint8Array }>(`SELECT byte_start, body FROM page_body_staging_parts
      WHERE staging_id = $1::uuid AND part_no = $2`, [row.id, part]);
    if (!stored || Number(stored.byte_start) !== at) return null;
    hash.update(stored.body);
    at += stored.body.byteLength;
  }
  return at === row.received_bytes ? hash.digest('hex') : null;
}

/**
 * Seals the open session for its commit: no more parts, and no expiry until its hard deadline, which moves to at least
 * one idle period from now so the commit can journal. True when this call sealed it; false when it was no longer open.
 */
export async function sealUpload(exec: SqlEngine, id: string): Promise<boolean> {
  const limits = await readUploadLimits(exec);
  const sealed = await exec.executeRaw<{ id: string }>(`UPDATE page_body_stagings s SET state = 'sealed', updated_at = now(),
      hard_expires_at = GREATEST(s.hard_expires_at, now() + $2::bigint * interval '1 second')
    WHERE s.id = $1::uuid AND s.state = 'open' AND NOT ${LAPSED_SQL} RETURNING s.id::text AS id`, [id, limits.uploadIdleSeconds]);
  return sealed.length > 0;
}

/** A journal body reference to a sealed upload session (spec 3.2). */
export interface StagingBodyRef { kind: 'staging'; staging_id: string; sha256: string; bytes: number }

export function isStagingBodyRef(value: unknown): value is StagingBodyRef {
  const ref = value as Partial<StagingBodyRef> | null | undefined;
  return !!ref && typeof ref === 'object' && ref.kind === 'staging' && typeof ref.staging_id === 'string' && typeof ref.sha256 === 'string' && Number.isSafeInteger(ref.bytes);
}

/** @internal Work counters of the staged-body readers: whole-body strings built, streamed preparations, largest part held. */
export const stagedUploadWork = { wholeTexts: 0, streamed: 0, largestPart: 0 };

/** The staged parts of a body reference in order, one part at a time; null at a gap. */
export async function* stagedUploadParts(engine: SqlEngine, ref: StagingBodyRef): AsyncIterable<Uint8Array | null> {
  for (let part = 0, at = 0; at < ref.bytes; part++) {
    const [stored] = await engine.executeRaw<{ byte_start: unknown; body: Uint8Array }>(
      'SELECT byte_start, body FROM page_body_staging_parts WHERE staging_id = $1::uuid AND part_no = $2', [ref.staging_id, part]);
    if (!stored || Number(stored.byte_start) !== at) { yield null; return; }
    stagedUploadWork.largestPart = Math.max(stagedUploadWork.largestPart, stored.body.byteLength);
    at += stored.body.byteLength;
    yield stored.body;
  }
}

/** The staged page text a body reference names, verified against its byte count and sha256; null when it no longer matches. */
export async function stagedUploadText(engine: SqlEngine, ref: StagingBodyRef): Promise<string | null> {
  stagedUploadWork.wholeTexts++;
  const buffers: Buffer[] = [];
  for await (const part of stagedUploadParts(engine, ref)) {
    if (!part) return null;
    buffers.push(Buffer.from(part.buffer, part.byteOffset, part.byteLength));
  }
  const body = Buffer.concat(buffers);
  if (body.byteLength !== ref.bytes || createHash('sha256').update(body).digest('hex') !== ref.sha256) return null;
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
}

interface Publishable { apply(tx: BrainEngine, preimage?: never): Promise<Record<string, unknown>> }

/**
 * A write whose intent names a sealed upload session (put_page, or append_page with mode append): the session must
 * still be the sealed upload of the request's principal, source and slug, matching the reference. `prepare` builds the
 * write; its publication re-checks the session under a row lock, and the same transaction marks it committed and
 * releases its reservation.
 */
export async function withStagedUpload<T extends Publishable>(engine: BrainEngine, row: WriteRequest, prepare: (ref: StagingBodyRef) => Promise<T>): Promise<T> {
  const ref = (row.intent as Record<string, unknown>).body_ref as StagingBodyRef;
  const [staging] = await engine.executeRaw<{ state: string; principal_kind: string; principal_id: string; source_id: string; slug: string; declared_bytes: unknown; sha: string }>(
    `SELECT state, principal_kind, principal_id, source_id, slug, declared_bytes, encode(declared_sha256, 'hex') AS sha FROM page_body_stagings
      WHERE id = $1::uuid AND kind = 'upload'`, [ref.staging_id]);
  if (!staging || staging.principal_kind !== row.principal_kind || staging.principal_id !== row.principal_id || staging.source_id !== row.source_id
    || staging.slug !== row.slug || Number(staging.declared_bytes) !== ref.bytes || staging.sha !== ref.sha256) throw bodyStagingGoneError(row.slug, ref.staging_id, null);
  if (staging.state !== 'sealed') throw bodyStagingGoneError(row.slug, ref.staging_id, staging.state);
  const prepared = await prepare(ref);
  const apply = prepared.apply.bind(prepared);
  prepared.apply = async (tx, preimage) => {
    const [held] = await tx.executeRaw<{ state: string }>('SELECT state FROM page_body_stagings WHERE id = $1::uuid FOR UPDATE', [ref.staging_id]);
    if (held?.state !== 'sealed') throw bodyStagingGoneError(row.slug, ref.staging_id, held?.state ?? null);
    const outcome = await apply(tx, preimage);
    await transitionUploads(tx, 'committed', 's.id = $1::uuid', [ref.staging_id], { commitRequestId: row.id });
    return outcome;
  };
  return prepared;
}

/** `prepare` under withStagedUpload when the request's intent names an upload session (an append upload), else as is. */
export async function withStagedBodyIf<T extends Publishable>(engine: BrainEngine, row: WriteRequest, prepare: () => Promise<T>): Promise<T> {
  return isStagingBodyRef(row.intent?.body_ref) ? withStagedUpload(engine, row, prepare) : prepare();
}

/**
 * Preparation of a put_page whose intent names a sealed upload session. A body within the single-string ceiling
 * (PAGE_MAX_BYTES) is read back and `prepare` gets the request with it as its content (and the timeline section put_page
 * admission records for content), so every put_page rule applies; a larger body streams from its parts through the
 * segmented import (upload-streamed.ts) and is never held as one string.
 */
export async function prepareStagedUpload<T extends Publishable>(engine: BrainEngine, row: WriteRequest, prepare: (row: WriteRequest) => Promise<T>): Promise<T> {
  return withStagedUpload(engine, row, async ref => {
    if (ref.bytes > PAGE_MAX_BYTES) return (await import('./upload-streamed.ts')).prepareStreamedUpload(engine, row, ref) as unknown as Promise<T>;
    const content = await stagedUploadText(engine, ref);
    if (content === null) throw bodyStagingGoneError(row.slug, ref.staging_id, null);
    const { body_ref: _ref, ...rest } = row.intent as Record<string, unknown>;
    return prepare({ ...row, intent: { ...rest, content,
      ...(rest.kind === undefined && rest.timeline_section === undefined ? { timeline_section: timelineSectionOf(content, row.slug) } : {}) } });
  });
}
