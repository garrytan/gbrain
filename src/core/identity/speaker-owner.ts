/**
 * GST-3216 PR 2: which speaker on a conversation page is the brain's owner, as the importer that wrote the page
 * knew it. The importer stamps `speaker_owner` into the page frontmatter: the owner's speaker label, the signal it
 * rests on (`basis`), how many turns carry that label, and the member the import ran for. Only an importer that
 * can show the turns are the owner's own stamps it; every other page stays speaker-unknown.
 *
 * Frontmatter is something any writer can set, so the marker is honored only at read time and only when:
 *   - its shape is valid (a known basis, a short single-line label, a whole turn count);
 *   - the page's live revision was written by a trusted local importer (a transcripts import or a connector sync
 *     into a Google, iMessage or Meetings source), never by a remote caller: a remote write is journaled with a
 *     server-stamped `mcp:<operation>` provenance and a non-local principal (persistence/page-prepare.ts);
 *   - its member is the member the page's source belongs to (the bound members, else the brain's owner member, or
 *     no member on a brain without one), so a marker written for one person never names another.
 * No table holds it: the journal's write attribution (`revision_write_request_id`, the request's principal and
 * intent, `revision_principal_kind`) is the database record beside the page, so a repo-less brain works the same.
 */
import type { BrainEngine } from '../engine.ts';
import { ownerMemberId } from '../access/owner.ts';
import { listMembers } from '../access/members.ts';

export const SPEAKER_OWNER_KEY = 'speaker_owner';
export const SPEAKER_OWNER_BASES = ['is_from_me', 'gmail_sent', 'session_user', 'export_user'] as const;
export type SpeakerOwnerBasis = typeof SPEAKER_OWNER_BASES[number];
export const SPEAKER_LABEL_MAX_CHARS = 80;

export interface SpeakerOwnerMarker {
  label: string;
  basis: SpeakerOwnerBasis;
  turns: number;
  member?: string;
}

/** Provenance the trusted importers stamp on the pages they write. */
export const SPEAKER_OWNER_WRITERS: readonly string[] = ['cli:transcripts-ingest', 'cli:transcripts-archive'];
/** Connector kinds whose sync knows which messages are the account owner's. */
export const SPEAKER_OWNER_CONNECTOR_KINDS: readonly string[] = ['google', 'imessage', 'meetings'];

const MEMBER_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** A speaker label as the page body's anchors spell it, or null when it can't be one. */
export function speakerOwnerLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const label = raw.trim();
  if (!label || [...label].length > SPEAKER_LABEL_MAX_CHARS) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f*():]/.test(label)) return null;
  return label;
}

/** The marker, or null when the value is not a valid one. */
export function parseSpeakerOwner(value: unknown): SpeakerOwnerMarker | null {
  const v = typeof value === 'string' ? (() => { try { return JSON.parse(value); } catch { return null; } })() : value;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const record = v as Record<string, unknown>;
  const label = speakerOwnerLabel(record.label);
  const basis = SPEAKER_OWNER_BASES.find(b => b === record.basis);
  const turns = record.turns;
  if (!label || !basis || typeof turns !== 'number' || !Number.isSafeInteger(turns) || turns < 1) return null;
  if (record.member !== undefined && (typeof record.member !== 'string' || !MEMBER_RE.test(record.member))) return null;
  return { label, basis, turns, ...(typeof record.member === 'string' ? { member: record.member } : {}) };
}

/**
 * The marker an importer stamps, or null when the owner spoke no turn under a usable label. `member` is the
 * brain's owner member at import time (null on a brain without one).
 */
export function buildSpeakerOwner(label: unknown, basis: SpeakerOwnerBasis, turns: number, member: string | null): SpeakerOwnerMarker | null {
  return parseSpeakerOwner({ label, basis, turns, ...(member ? { member } : {}) });
}

/**
 * Whom a page writer stamps as the owner: the brain's owner member (null on a brain without one). Set by the caller
 * that writes the page; omitted, the page carries no speaker_owner marker.
 */
export interface SpeakerOwnerStamp { member: string | null }

/**
 * The marker for one page's turns, in page order: each turn's rendered speaker label and whether the source shows
 * the owner wrote it. Every owner turn must render under one label and no other turn under that label; anything else
 * is speaker-unknown.
 */
export function speakerOwnerFromTurns(turns: ReadonlyArray<{ label: string; owner: boolean }>, basis: SpeakerOwnerBasis, member: string | null): SpeakerOwnerMarker | null {
  const owned = turns.filter(t => t.owner);
  const labels = new Set(owned.map(t => t.label));
  if (labels.size !== 1) return null;
  const [label] = labels;
  if (turns.some(t => !t.owner && t.label === label)) return null;
  return buildSpeakerOwner(label, basis, owned.length, member);
}

/**
 * The stamp for a connector source's pages: the one member the source is bound to, else the owner member when no
 * other person shares the brain. A source bound to several members, or unbound on a shared brain (a team mailbox),
 * is nobody's own, so its pages stay speaker-unknown (null).
 */
export async function connectorSpeakerOwnerStamp(engine: BrainEngine, sourceId: string): Promise<SpeakerOwnerStamp | null> {
  const bound = (await engine.executeRaw<{ member_id: string }>(
    'SELECT member_id FROM access_member_sources WHERE source_id = $1 ORDER BY member_id', [sourceId])).map(r => r.member_id);
  if (bound.length) return bound.length === 1 ? { member: bound[0]! } : null;
  const owner = await ownerMemberId(engine);
  const people = (await listMembers(engine)).filter(m => m.status === 'enabled' && m.kind === 'person');
  return people.every(m => m.id === owner) ? { member: owner } : null;
}

/**
 * The SQL predicate: page alias `p`'s live revision was written by a trusted local importer. Joins `r` and `s`. With no
 * request, a writer's stamp vouches only while no later write moved the page past it (importerWroteLiveRevisionSql).
 */
function trustedWriterSql(writers: string): string {
  const connector = `s.config->>'kind' IN (${SPEAKER_OWNER_CONNECTOR_KINDS.map(k => `'${k}'`).join(',')})`;
  return `CASE WHEN p.revision_write_request_id IS NULL
                 THEN (p.ingested_via IN (${writers}) AND p.ingested_at >= p.updated_at) OR (p.ingested_via IS NULL AND ${connector})
            WHEN r.intent IS NOT NULL
                 THEN r.principal_kind = 'local_cli' AND (r.intent->>'ingested_via' IN (${writers})
                      OR (r.operation = 'submit_job' AND r.intent->>'kind' = 'connector_v2_import' AND ${connector}))
            ELSE p.revision_principal_kind IS NOT DISTINCT FROM 'local_cli'
                 AND (p.ingested_via IN (${writers}) OR (p.ingested_via IS NULL AND ${connector})) END`;
}

export type SpeakerOwnerStatus = 'trusted' | 'absent' | 'invalid' | 'untrusted_writer' | 'member_mismatch';
export interface SpeakerOwnerRead { slug: string; source_id: string; status: SpeakerOwnerStatus; marker: SpeakerOwnerMarker | null }

/**
 * The speaker-owner marker of each live page asked for, with why it is or isn't honored. Only a `trusted` read
 * carries a marker; every other status means the page is speaker-unknown.
 */
export async function readSpeakerOwners(engine: BrainEngine, pages: ReadonlyArray<{ source_id: string; slug: string }>): Promise<SpeakerOwnerRead[]> {
  if (!pages.length) return [];
  const writers = SPEAKER_OWNER_WRITERS.map((_, i) => `$${i + 1}`).join(',');
  const params: unknown[] = [...SPEAKER_OWNER_WRITERS];
  const wanted = pages.map(page => { params.push(page.source_id, page.slug); return `($${params.length - 1}::text, $${params.length}::text)`; });
  const rows = await engine.executeRaw<{ slug: string; source_id: string; marker: unknown; trusted: boolean; members: string[] | null }>(
    `SELECT p.slug, p.source_id, p.frontmatter->'${SPEAKER_OWNER_KEY}' AS marker, (${trustedWriterSql(writers)}) AS trusted,
            (SELECT array_agg(b.member_id ORDER BY b.member_id) FROM access_member_sources b WHERE b.source_id = p.source_id) AS members
       FROM pages p JOIN sources s ON s.id = p.source_id
       LEFT JOIN persistence_requests r ON r.id = p.revision_write_request_id
      WHERE p.deleted_at IS NULL AND (p.source_id, p.slug) IN (${wanted.join(', ')})`, params);
  const owner = await ownerMemberId(engine);
  const byKey = new Map(rows.map(row => [`${row.source_id}\u0000${row.slug}`, row]));
  return pages.flatMap((page): SpeakerOwnerRead[] => {
    const row = byKey.get(`${page.source_id}\u0000${page.slug}`);
    if (!row) return [];
    const read = (status: SpeakerOwnerStatus, marker: SpeakerOwnerMarker | null = null) => [{ slug: row.slug, source_id: row.source_id, status, marker }];
    if (row.marker === null || row.marker === undefined) return read('absent');
    const marker = parseSpeakerOwner(row.marker);
    if (!marker) return read('invalid');
    if (row.trusted !== true) return read('untrusted_writer');
    const bound = row.members ?? [];
    const member = marker.member ?? null;
    if (bound.length ? !member || !bound.includes(member) : member !== owner) return read('member_mismatch');
    return read('trusted', marker);
  });
}
