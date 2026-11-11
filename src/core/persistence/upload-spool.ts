/**
 * Wave C 1H-a (spec §3.1 step 1): disk-spooled upload sessions on a strict source with the git-first path on. A session's
 * parts go to one 0600 file under the owner's persistence home (`<persistence home>/uploads/<upload id>.spool`); the
 * database keeps only a per-part record (index, offset, size, sha256), never the bytes. Every reader of a session's staged
 * bytes goes through `spooledParts`, which re-verifies each part against its record.
 *
 * Cleanup (ceo-r3-native-4): the file is removed on commit (after the publication transaction), on abort, and by the owner
 * sweep for sessions that are no longer live or have lapsed; a spooled session's reservation is released only once its
 * file is gone (the expiry transitions skip a session whose spool row is not marked removed).
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statfsSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { opError, type OperationError } from '../ops/contract.ts';
import { persistenceHome } from './identity.ts';
import type { SqlEngine } from './model.ts';
import { PENDING_STATES_SQL } from './request-states.ts';

/** Free bytes kept on the persistence home's filesystem beyond a session's own needs (spec §3.1 step 1). */
export const SPOOL_DISK_HEADROOM_BYTES = 512 * 1024 ** 2;

export const uploadSpoolDir = () => join(persistenceHome(), 'uploads');
export const uploadSpoolPath = (stagingId: string) => join(uploadSpoolDir(), `${stagingId}.spool`);

/** The terms of the begin preflight: the spool (1×), the publication stage (1×), loose Git objects (0.5×) and the headroom. */
export function spoolDiskTerms(totalBytes: number): { spool: number; stages: number; loose_objects: number; headroom: number; required: number } {
  const loose = Math.ceil(totalBytes / 2);
  return { spool: totalBytes, stages: totalBytes, loose_objects: loose, headroom: SPOOL_DISK_HEADROOM_BYTES, required: 2 * totalBytes + loose + SPOOL_DISK_HEADROOM_BYTES };
}

/**
 * `disk_space_low`: the brain host's disk cannot hold the session. Remote callers get the byte terms, never a path; the fix
 * is the host administrator's (free space), retryable once space is freed.
 */
export function diskSpaceLow(terms: ReturnType<typeof spoolDiskTerms> | null, free: number | null, remote: boolean): OperationError {
  const detail = terms ? ` It needs ${terms.required} bytes free (spool ${terms.spool}, publication stage ${terms.stages}, loose Git objects ${terms.loose_objects}, headroom ${terms.headroom})${free === null ? '' : ` and ${free} are free`}.` : '';
  return opError('disk_space_low', `The brain host's disk is too full to hold this upload, so nothing more was stored.${detail}`,
    'Free space on the brain host, then resume the upload with the same request_id: parts already stored are kept.',
    { detail: JSON.stringify({ ...(terms ?? {}), free_bytes: free, ...(remote ? {} : { path: uploadSpoolDir() }) }),
      fix: { argv: ['df', '-h'], actor: 'host_admin', consent: [], requires_exclusive: false, why: 'Only the brain host administrator can free disk space; df shows what is free.' } });
}

const enospc = (error: unknown) => (error as { code?: string })?.code === 'ENOSPC';

/** Opens the spool of a new session: the preflight, the 0600 file, and its record (in the caller's transaction). */
export async function openSpool(exec: SqlEngine, stagingId: string, hostId: string, totalBytes: number, remote: boolean): Promise<void> {
  mkdirSync(uploadSpoolDir(), { recursive: true, mode: 0o700 });
  const terms = spoolDiskTerms(totalBytes);
  let free: number | null = null;
  try { const stats = statfsSync(uploadSpoolDir()); free = Number(stats.bavail) * Number(stats.bsize); } catch { /* no statfs: the writes map ENOSPC */ }
  if (free !== null && free < terms.required) throw diskSpaceLow(terms, free, remote);
  closeSync(openSync(uploadSpoolPath(stagingId), 'w', 0o600));
  await exec.executeRaw('INSERT INTO page_upload_spools (staging_id, host_id) VALUES ($1::uuid, $2::uuid)', [stagingId, hostId]);
}

/** Whether the session keeps its parts in a spool file (its record is not marked removed). */
export async function isSpooled(exec: SqlEngine, stagingId: string): Promise<boolean> {
  const [row] = await exec.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_upload_spools WHERE staging_id = $1::uuid', [stagingId]);
  return Number(row?.n ?? 0) > 0;
}

/** Writes part `part` at `byteStart`, fsyncs it, then records it. ENOSPC is `disk_space_low`; the parts before stay resumable. */
export async function appendSpoolPart(exec: SqlEngine, stagingId: string, part: number, byteStart: number, bytes: Buffer, sha256: string, remote: boolean): Promise<void> {
  try {
    const fd = openSync(uploadSpoolPath(stagingId), 'r+');
    try {
      for (let at = 0; at < bytes.byteLength;) at += writeSync(fd, bytes, at, bytes.byteLength - at, byteStart + at);
      fsyncSync(fd);
    } finally { closeSync(fd); }
  } catch (error) {
    if (enospc(error)) throw diskSpaceLow(null, null, remote);
    throw error;
  }
  await exec.executeRaw(`INSERT INTO page_upload_spool_parts (staging_id, part_no, byte_start, byte_len, sha256)
    VALUES ($1::uuid, $2, $3::bigint, $4, decode($5, 'hex'))`, [stagingId, part, byteStart, bytes.byteLength, sha256]);
}

export async function spoolPartSha256(exec: SqlEngine, stagingId: string, part: number): Promise<string | null> {
  const [row] = await exec.executeRaw<{ sha: string }>(`SELECT encode(sha256, 'hex') AS sha FROM page_upload_spool_parts WHERE staging_id = $1::uuid AND part_no = $2`, [stagingId, part]);
  return row?.sha ?? null;
}

/**
 * The session's spooled parts in order, each read from the file and checked against its recorded size and sha256; null
 * (and stop) at a gap, a missing file or a part whose bytes no longer match. The one reader of spooled bytes.
 */
export async function* spooledParts(exec: SqlEngine, stagingId: string, bytes: number): AsyncIterable<Uint8Array | null> {
  const parts = await exec.executeRaw<{ part_no: number; byte_start: unknown; byte_len: number; sha: string }>(
    `SELECT part_no, byte_start, byte_len, encode(sha256, 'hex') AS sha FROM page_upload_spool_parts WHERE staging_id = $1::uuid ORDER BY part_no`, [stagingId]);
  const path = uploadSpoolPath(stagingId);
  if (!existsSync(path)) { yield null; return; }
  const fd = openSync(path, 'r');
  try {
    let at = 0;
    for (const [index, part] of parts.entries()) {
      if (at >= bytes) return;
      if (Number(part.part_no) !== index || Number(part.byte_start) !== at) { yield null; return; }
      const buffer = Buffer.alloc(Number(part.byte_len));
      for (let read = 0; read < buffer.byteLength;) {
        const n = readSync(fd, buffer, read, buffer.byteLength - read, at + read);
        if (n === 0) break;
        read += n;
      }
      if (createHash('sha256').update(buffer).digest('hex') !== part.sha) { yield null; return; }
      at += buffer.byteLength;
      yield buffer;
    }
    if (at < bytes) yield null;
  } finally { closeSync(fd); }
}

/** Removes the session's spool file when this host holds it and marks its record removed; true when the file is gone. */
export async function removeSpool(exec: SqlEngine, stagingId: string, hostId: string): Promise<boolean> {
  const [row] = await exec.executeRaw<{ host_id: string }>('SELECT host_id::text AS host_id FROM page_upload_spools WHERE staging_id = $1::uuid AND removed_at IS NULL', [stagingId]);
  if (!row) return true;
  if (row.host_id !== hostId) return false;
  rmSync(uploadSpoolPath(stagingId), { force: true });
  await exec.executeRaw('UPDATE page_upload_spools SET removed_at = now() WHERE staging_id = $1::uuid', [stagingId]);
  return true;
}

/** A spool file no record names is kept this long: a session being opened has its file before its row commits (openSpool). */
const UNNAMED_SPOOL_GRACE_MS = 10 * 60 * 1000;
const spoolMtimeMs = (file: string) => { try { return statSync(file).mtimeMs; } catch { return 0; } };

/**
 * The owner sweep (at start and with segment GC): removes this host's spool files of sessions no longer live (committed,
 * aborted, expired) or lapsed, marks them removed so expiry releases their reservations, and deletes spool files no
 * record names once they are older than a grace period. Returns the files removed.
 */
export async function sweepUploadSpools(exec: SqlEngine, hostId: string): Promise<number> {
  const stale = await exec.executeRaw<{ id: string }>(`SELECT sp.staging_id::text AS id FROM page_upload_spools sp
    LEFT JOIN page_body_stagings s ON s.id = sp.staging_id
    WHERE sp.host_id = $1::uuid AND sp.removed_at IS NULL AND (s.id IS NULL OR s.state NOT IN ('open','sealed','prepared')
      OR (s.hard_expires_at <= now() OR s.state = 'open' AND s.idle_expires_at <= now())
        AND NOT EXISTS (SELECT 1 FROM persistence_requests r WHERE r.state IN ${PENDING_STATES_SQL} AND r.intent->'body_ref'->>'staging_id' = s.id::text))`,
  [hostId]);
  let removed = 0;
  for (const { id } of stale) if (await removeSpool(exec, id, hostId)) removed++;
  if (existsSync(uploadSpoolDir())) {
    const known = new Set((await exec.executeRaw<{ id: string }>('SELECT staging_id::text AS id FROM page_upload_spools WHERE removed_at IS NULL')).map(row => row.id));
    for (const name of readdirSync(uploadSpoolDir())) {
      const id = name.endsWith('.spool') ? name.slice(0, -'.spool'.length) : null;
      const file = join(uploadSpoolDir(), name);
      if (!id || known.has(id) || Date.now() - spoolMtimeMs(file) < UNNAMED_SPOOL_GRACE_MS) continue;
      rmSync(file, { force: true });
      removed++;
    }
  }
  return removed;
}

/**
 * Purge discovery over spooled sessions (ceo-r3-outside-5): the live sessions of `sourceId` whose spool holds `claim`'s exact
 * bytes, read in bounded windows that carry the last (claim - 1) bytes across reads. A session spooled on another host is
 * returned too: its bytes cannot be read here, so a purge aborts it rather than leave the claim in a write in flight.
 */
export async function spooledStagingsHoldingClaim(exec: SqlEngine, sourceId: string, claim: string, hostId: string): Promise<string[]> {
  const needle = Buffer.from(claim, 'utf8');
  if (!needle.length) return [];
  const sessions = await exec.executeRaw<{ id: string; host_id: string }>(`SELECT s.id::text AS id, sp.host_id::text AS host_id FROM page_body_stagings s
    JOIN page_upload_spools sp ON sp.staging_id = s.id WHERE s.source_id = $1 AND s.state IN ('open','sealed','prepared') AND sp.removed_at IS NULL`, [sourceId]);
  const hits: string[] = [];
  const window = Buffer.alloc(1024 ** 2);
  for (const { id, host_id: holder } of sessions) {
    if (holder !== hostId) { hits.push(id); continue; }
    if (!existsSync(uploadSpoolPath(id))) continue;
    const fd = openSync(uploadSpoolPath(id), 'r');
    try {
      let carry = Buffer.alloc(0);
      for (let at = 0; ; ) {
        const n = readSync(fd, window, 0, window.byteLength, at);
        if (n === 0) break;
        const chunk = Buffer.concat([carry, window.subarray(0, n)]);
        if (chunk.includes(needle)) { hits.push(id); break; }
        carry = chunk.subarray(Math.max(0, chunk.length - (needle.length - 1)));
        at += n;
      }
    } finally { closeSync(fd); }
  }
  return hits;
}
