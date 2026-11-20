/**
 * Reads and writes of the decision, OAuth, feedback, question and credential tables that callers once ran through
 * `executeRaw`, as typed members: SQL once for both SQL engines, so a store that is not SQL serves the same members
 * (rust/docs/store). Each statement keeps the text its caller ran, and each listing breaks ties by byte
 * (`COLLATE "C"`), as the Rust store does.
 */
import type { BrainEngine } from '../engine.ts';
import { isMissingSchemaObject } from '../utils.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** One OAuth client that references a source through `oauth_clients.source_id`; `deleted` marks a soft-deleted row. */
export interface SourceClientReferentRow {
  clientId: string;
  clientName: string;
  deleted: boolean;
}

/** The statements destructive-guard.ts clientsReferencingSource ran through executeRaw: the whole read, then the read of a brain without `deleted_at`. */
export const CLIENTS_REFERENCING_SOURCE_SQL = {
  primary: `SELECT client_id, client_name, (deleted_at IS NOT NULL) AS deleted
       FROM oauth_clients
       WHERE source_id = $1
       ORDER BY client_id COLLATE "C"`,
  without_deleted_at: `SELECT client_id, client_name FROM oauth_clients
         WHERE source_id = $1
         ORDER BY client_id COLLATE "C"`,
} as const;

/**
 * Every OAuth client that references `sourceId`, by client id in byte order. The reference is PHYSICAL (ON DELETE
 * RESTRICT), so soft-deleted rows are returned too, tagged `deleted`. A brain without the `oauth_clients` table, or
 * without its `source_id` column, has no referents (no column, no foreign key); a brain without `deleted_at` reads every
 * referent as live. Any other failure is thrown unchanged.
 */
export async function listClientsReferencingSource(tx: Raw, sourceId: string): Promise<SourceClientReferentRow[]> {
  try {
    const rows = await tx.executeRaw<{ client_id: string; client_name: string; deleted: boolean }>(CLIENTS_REFERENCING_SOURCE_SQL.primary, [sourceId]);
    return rows.map((r) => ({ clientId: r.client_id, clientName: r.client_name, deleted: r.deleted === true }));
  } catch (e) {
    if (isMissingSchemaObject(e, 'table', 'oauth_clients')) return [];
    // The primary query references BOTH optional columns; the strict predicate tells them apart by the column the error names.
    if (isMissingSchemaObject(e, 'column', 'source_id')) return [];
    if (!isMissingSchemaObject(e, 'column', 'deleted_at')) throw e;
    try {
      const rows = await tx.executeRaw<{ client_id: string; client_name: string }>(CLIENTS_REFERENCING_SOURCE_SQL.without_deleted_at, [sourceId]);
      return rows.map((r) => ({ clientId: r.client_id, clientName: r.client_name, deleted: false }));
    } catch (e2) {
      // The fallback's only optional column is source_id: no column, no foreign key.
      if (isMissingSchemaObject(e2, 'column', 'source_id')) return [];
      throw e2;
    }
  }
}

/** One live credential bound to a member: `kind` is `client` or `token`, `row` the grant columns of its table as JSON. */
export interface OwnerCredentialRow {
  kind: 'client' | 'token';
  id: string;
  name: string;
  row: unknown;
}

/** The statement guests/owner-credentials.ts ownerCredentials ran through executeRaw (a token row carries its grant columns and read floor, never the token hash). */
export const OWNER_CREDENTIALS_SQL = `SELECT * FROM (SELECT 'token' AS kind, t.id::text AS id, t.name, jsonb_build_object('id', t.id, 'scopes', t.scopes, 'permissions', t.permissions, 'private_pages', t.private_pages, 'private_facts', t.private_facts, 'grant_revision', t.grant_revision, 'source_grant', t.source_grant, 'source_id', t.source_id, 'federated_read', t.federated_read, 'allowed_operations', t.allowed_operations, 'takes_holders', t.takes_holders, 'min_trust', t.min_trust) AS row FROM access_tokens t WHERE t.member_id = $1 AND t.revoked_at IS NULL UNION ALL SELECT 'client' AS kind, c.client_id AS id, COALESCE(c.client_name, c.client_id) AS name, to_jsonb(c) - 'client_secret_hash' AS row FROM oauth_clients c WHERE c.member_id = $1 AND (to_jsonb(c)->>'deleted_at') IS NULL) q ORDER BY kind COLLATE "C", name COLLATE "C", id COLLATE "C"`;

/**
 * Every live credential (an access token not revoked, an OAuth client not deleted) bound to `memberId`: clients before tokens,
 * then by name, then by id in byte order. A client row is the whole row less its secret hash.
 */
export async function readOwnerCredentials(tx: Raw, memberId: string): Promise<OwnerCredentialRow[]> {
  return tx.executeRaw<OwnerCredentialRow>(OWNER_CREDENTIALS_SQL, [memberId]);
}

/** One `pinned_questions` row as the SQL engines return it (times as `Date` or ISO text; `answer` is JSON text). */
export type PinnedQuestionRow = Record<string, unknown>;

/** The pin a caller adds: the columns `insertPin` writes. */
export interface PinnedQuestionInsert {
  sourceId: string;
  slug: string;
  question: string;
  scopeSlugPrefix: string | null;
  scopeEntity: string | null;
  state: string;
  inactiveReason: string | null;
  publishMode: string;
  createdBy: string;
}

/** What `listPinnedQuestions` keeps: the sources and states named, or (no states) every state but `archived` unless `includeArchived`. */
export interface PinnedQuestionFilter {
  sourceIds?: string[];
  states?: string[];
  includeArchived?: boolean;
}

/**
 * The statements questions/store.ts insertPin, getPin and listPins ran through executeRaw. The listing was composed from
 * its filters; it is one statement here, each filter a parameter that is NULL when not given (the same rows, the same order).
 */
export const PINNED_QUESTION_SQL = {
  insert: `INSERT INTO pinned_questions (source_id, slug, question, scope_slug_prefix, scope_entity, state, inactive_reason, publish_mode, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (source_id, slug) DO NOTHING RETURNING id, source_id, slug, question, scope_slug_prefix, scope_entity, state, inactive_reason, publish_mode, model,
  cooldown_days, origin, created_by, revision, answer_revision, answer, answer_model, last_refresh_at, last_attempt_at,
  last_error, watermark_generation, watermark_fact_id, watermark_at, lease_token, lease_owner, lease_expires_at,
  refresh_attempts, spend_usd, created_at, archived_at`,
  read: `SELECT id, source_id, slug, question, scope_slug_prefix, scope_entity, state, inactive_reason, publish_mode, model,
  cooldown_days, origin, created_by, revision, answer_revision, answer, answer_model, last_refresh_at, last_attempt_at,
  last_error, watermark_generation, watermark_fact_id, watermark_at, lease_token, lease_owner, lease_expires_at,
  refresh_attempts, spend_usd, created_at, archived_at FROM pinned_questions WHERE source_id = $1 AND slug = $2`,
  list: `SELECT id, source_id, slug, question, scope_slug_prefix, scope_entity, state, inactive_reason, publish_mode, model,
  cooldown_days, origin, created_by, revision, answer_revision, answer, answer_model, last_refresh_at, last_attempt_at,
  last_error, watermark_generation, watermark_fact_id, watermark_at, lease_token, lease_owner, lease_expires_at,
  refresh_attempts, spend_usd, created_at, archived_at FROM pinned_questions
   WHERE ($1::text[] IS NULL OR source_id = ANY($1::text[]))
     AND ($2::text[] IS NULL OR state = ANY($2::text[]))
     AND ($3::boolean OR $2::text[] IS NOT NULL OR state <> 'archived')
   ORDER BY source_id COLLATE "C", created_at, id`,
} as const;

/** `INSERT` one pin; its row, or null when `(source_id, slug)` already has one. */
export async function insertPinnedQuestion(tx: Raw, p: PinnedQuestionInsert): Promise<PinnedQuestionRow | null> {
  const rows = await tx.executeRaw<PinnedQuestionRow>(PINNED_QUESTION_SQL.insert,
    [p.sourceId, p.slug, p.question, p.scopeSlugPrefix, p.scopeEntity, p.state, p.inactiveReason, p.publishMode, p.createdBy]);
  return rows[0] ?? null;
}

/** The row of one pin, or null. */
export async function readPinnedQuestion(tx: Raw, sourceId: string, slug: string): Promise<PinnedQuestionRow | null> {
  return (await tx.executeRaw<PinnedQuestionRow>(PINNED_QUESTION_SQL.read, [sourceId, slug]))[0] ?? null;
}

/** The pins that pass the filter, by source id in byte order, then by creation time, then by id. */
export async function listPinnedQuestions(tx: Raw, filter: PinnedQuestionFilter): Promise<PinnedQuestionRow[]> {
  return tx.executeRaw<PinnedQuestionRow>(PINNED_QUESTION_SQL.list, [filter.sourceIds ?? null, filter.states ?? null, filter.includeArchived === true]);
}

/**
 * The statements feedback/store.ts ran through executeRaw for retrieval events, ratings and the status read, with the page-exists
 * filter and the neutral weight (0.5) written out where they were composed in. Each is the text the caller sent.
 */
export const RETRIEVAL_FEEDBACK_SQL = {
  events: `INSERT INTO retrieval_events (id, client_id, op)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[])
     ON CONFLICT (id) DO NOTHING`,
  pages: `INSERT INTO retrieval_event_pages (event_id, source_id, slug, content_hash, rank, cited)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[], $6::text[]::boolean[])
         AS t(event_id, source_id, slug, content_hash, rank, cited)
        WHERE EXISTS (SELECT 1 FROM pages pg WHERE pg.source_id = t.source_id AND pg.slug = t.slug FOR KEY SHARE)
       ON CONFLICT DO NOTHING`,
  links: `INSERT INTO retrieval_event_links (event_id, source_id, edge_key, to_slug)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS t(event_id, source_id, edge_key, to_slug)
        WHERE EXISTS (SELECT 1 FROM pages pg WHERE pg.source_id = t.source_id AND pg.slug = t.to_slug FOR KEY SHARE) AND EXISTS (SELECT 1 FROM pages pg WHERE pg.source_id = t.source_id AND pg.slug = split_part(t.edge_key, '|', 1) FOR KEY SHARE) AND EXISTS (SELECT 1 FROM pages pg WHERE pg.source_id = t.source_id AND pg.slug = reverse(split_part(reverse(t.edge_key), '|', 1)) FOR KEY SHARE)
       ON CONFLICT DO NOTHING`,
  readEvent: `SELECT id, client_id, op, created_at FROM retrieval_events WHERE id = $1`,
  readPages: `SELECT source_id, slug, content_hash, rank, cited FROM retrieval_event_pages WHERE event_id = $1 ORDER BY rank`,
  readLinks: `SELECT source_id, edge_key, to_slug FROM retrieval_event_links WHERE event_id = $1 ORDER BY source_id COLLATE "C", edge_key COLLATE "C", to_slug COLLATE "C"`,
  apply: `WITH input AS (
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::text[])
         AS t(element_kind, source_id, element_key, rating, content_hash)
        WHERE CASE t.element_kind WHEN 'page' THEN EXISTS (SELECT 1 FROM pages pg WHERE pg.source_id = t.source_id AND pg.slug = t.element_key FOR KEY SHARE)
                                  ELSE EXISTS (SELECT 1 FROM pages pg WHERE pg.source_id = t.source_id AND pg.slug = split_part(t.element_key, '|', 1) FOR KEY SHARE) AND EXISTS (SELECT 1 FROM pages pg WHERE pg.source_id = t.source_id AND pg.slug = reverse(split_part(reverse(t.element_key), '|', 1)) FOR KEY SHARE) END
     ),
     cur AS (
       SELECT i.*, COALESCE(w.weight, 0.5)::real AS w0,
              CASE WHEN w.weight IS NULL THEN 0.5
                   WHEN i.element_kind = 'page' AND w.content_hash IS DISTINCT FROM i.content_hash
                     THEN 0.5 + (w.weight - 0.5) / 2
                   ELSE w.weight END AS w_eff
         FROM input i
         LEFT JOIN retrieval_weights w
           ON w.source_id = i.source_id AND w.element_kind = i.element_kind AND w.element_key = i.element_key
     ),
     calc AS (
       SELECT c.*, LEAST(1, GREATEST(0, c.w_eff + $6::real * ((c.rating - 1) / 4.0 - c.w_eff)))::real AS w1
         FROM cur c
     ),
     ins AS (
       INSERT INTO retrieval_feedback
         (event_id, signal, element_kind, source_id, element_key, client_id, rating, weight_before, weight_after)
       SELECT $7, $8, element_kind, source_id, element_key, $9, rating, w_eff, w1 FROM calc
       ON CONFLICT DO NOTHING
       RETURNING element_kind, source_id, element_key, rating
     )
     INSERT INTO retrieval_weights AS rw (source_id, element_kind, element_key, weight, content_hash, updates, updated_at)
     SELECT ins.source_id, ins.element_kind, ins.element_key, calc.w1, calc.content_hash, 1, now()
       FROM ins JOIN calc ON calc.element_kind = ins.element_kind AND calc.source_id = ins.source_id AND calc.element_key = ins.element_key
     ON CONFLICT (source_id, element_kind, element_key) DO UPDATE SET
       weight = LEAST(1, GREATEST(0,
         (CASE WHEN rw.element_kind = 'page' AND rw.content_hash IS DISTINCT FROM EXCLUDED.content_hash
               THEN 0.5 + (rw.weight - 0.5) / 2 ELSE rw.weight END)
         + $6::real * ((SELECT rating FROM ins i2 WHERE i2.source_id = EXCLUDED.source_id AND i2.element_kind = EXCLUDED.element_kind AND i2.element_key = EXCLUDED.element_key) - 1) / 4.0
         - $6::real * (CASE WHEN rw.element_kind = 'page' AND rw.content_hash IS DISTINCT FROM EXCLUDED.content_hash
               THEN 0.5 + (rw.weight - 0.5) / 2 ELSE rw.weight END)))::real,
       content_hash = EXCLUDED.content_hash,
       updates = rw.updates + 1,
       updated_at = now()
     RETURNING rw.element_kind, rw.source_id, rw.element_key, rw.weight AS weight_after`,
  stored: `SELECT element_kind, source_id, element_key, rating, weight_before, weight_after
       FROM retrieval_feedback
      WHERE event_id = $1 AND signal = $2
        AND (element_kind, source_id, element_key) IN (
          SELECT * FROM unnest($3::text[], $4::text[], $5::text[]))`,
  statusCounts: `SELECT
       (SELECT count(*)::int FROM retrieval_events) AS events,
       (SELECT count(*)::int FROM retrieval_feedback WHERE signal = 'explicit') AS ratings_explicit,
       (SELECT count(*)::int FROM retrieval_feedback WHERE signal = 'cited') AS ratings_cited,
       (SELECT count(*)::int FROM retrieval_weights) AS weights_total,
       (SELECT count(*)::int FROM retrieval_weights WHERE abs(weight - 0.5) > 0.01) AS weights_off_neutral,
       (SELECT max(applied_at) FROM retrieval_feedback) AS last_rating_at,
       (SELECT max(n)::float / NULLIF(sum(n), 0) FROM (
          SELECT count(*) AS n FROM retrieval_feedback
           WHERE signal = 'explicit' AND applied_at > now() - interval '7 days'
           GROUP BY client_id) c) AS top_client_share_7d`,
  statusLowest: `SELECT w.source_id, w.element_key AS slug, w.weight,
            (SELECT count(*) FROM retrieval_feedback f
              WHERE f.element_kind = 'page' AND f.source_id = w.source_id
                AND f.element_key = w.element_key AND f.rating <= 2)::int AS low_ratings
       FROM retrieval_weights w
      WHERE w.element_kind = 'page' AND w.weight < 0.5
      ORDER BY w.weight ASC, w.source_id COLLATE "C", w.element_key COLLATE "C" LIMIT 10`,
  statusHighest: `SELECT source_id, element_key AS slug, weight FROM retrieval_weights
      WHERE element_kind = 'page' AND weight > 0.5
      ORDER BY weight DESC, source_id COLLATE "C", element_key COLLATE "C" LIMIT 10`,
} as const;

/** One retrieval event with the pages it returned and the links it used (feedback/store.ts RetrievalEventInput). */
export interface RetrievalEventInsert {
  id: string;
  client_id: string;
  op: string;
  pages: Array<{ source_id: string; slug: string; content_hash: string | null; rank: number; cited: boolean }>;
  links: Array<{ source_id: string; edge_key: string; to_slug: string }>;
}

/** One stored retrieval event: its row, its pages by rank and its links by byte of source, edge key and target. */
export interface RetrievalEventRead {
  id: string;
  client_id: string;
  op: string;
  created_at: Date | string;
  pages: Array<{ source_id: string; slug: string; content_hash: string | null; rank: number; cited: boolean }>;
  links: Array<{ source_id: string; edge_key: string; to_slug: string }>;
}

/** One rating batch (feedback/store.ts applyRatings arguments). */
export interface RetrievalRatingBatch {
  eventId: string;
  clientId: string;
  signal: string;
  alpha: number;
  targets: Array<{ kind: string; source_id: string; key: string; rating: number; content_hash: string | null }>;
}

/** One rating the batch holds: the weight it moved and whether this call moved it. */
export interface AppliedRatingRow {
  kind: string;
  source_id: string;
  key: string;
  rating: number;
  weight_before: number;
  weight_after: number;
  newly_applied: boolean;
}

/** The counts and the lowest and highest page weights `gbrain feedback status` shows. */
export interface FeedbackStatusData {
  counts: Record<string, number | string | Date | null>;
  lowest: Array<{ source_id: string; slug: string; weight: number | string; low_ratings: number | string }>;
  highest: Array<{ source_id: string; slug: string; weight: number | string }>;
}

/** Records retrieval events, the pages and links each returned; a page or link whose page row is gone is skipped, a repeat is ignored. */
export async function insertRetrievalEvents(tx: Raw, events: RetrievalEventInsert[]): Promise<void> {
  if (events.length === 0) return;
  await tx.executeRaw(RETRIEVAL_FEEDBACK_SQL.events, [events.map(e => e.id), events.map(e => e.client_id), events.map(e => e.op)]);
  const pages = events.flatMap(e => e.pages.map(p => ({ id: e.id, ...p })));
  if (pages.length > 0) {
    await tx.executeRaw(RETRIEVAL_FEEDBACK_SQL.pages, [
      pages.map(p => p.id), pages.map(p => p.source_id), pages.map(p => p.slug),
      pages.map(p => p.content_hash), pages.map(p => p.rank), pages.map(p => (p.cited ? 'true' : 'false')),
    ]);
  }
  const links = events.flatMap(e => e.links.map(l => ({ id: e.id, ...l })));
  if (links.length > 0) {
    await tx.executeRaw(RETRIEVAL_FEEDBACK_SQL.links, [links.map(l => l.id), links.map(l => l.source_id), links.map(l => l.edge_key), links.map(l => l.to_slug)]);
  }
}

/** One retrieval event with its pages by rank and its links by byte, or null. */
export async function readRetrievalEvent(tx: Raw, id: string): Promise<RetrievalEventRead | null> {
  const rows = await tx.executeRaw<{ id: string; client_id: string; op: string; created_at: Date | string }>(RETRIEVAL_FEEDBACK_SQL.readEvent, [id]);
  const row = rows[0];
  if (!row) return null;
  const pages = await tx.executeRaw<{ source_id: string; slug: string; content_hash: string | null; rank: number | string; cited: boolean }>(RETRIEVAL_FEEDBACK_SQL.readPages, [id]);
  const links = await tx.executeRaw<{ source_id: string; edge_key: string; to_slug: string }>(RETRIEVAL_FEEDBACK_SQL.readLinks, [id]);
  return { ...row, pages: pages.map(p => ({ ...p, rank: Number(p.rank) })), links };
}

/** Applies one batch of ratings; the weight of a rating this call newly stored moves, a repeat reads back what it stored. */
export async function applyRetrievalRatings(tx: Raw, args: RetrievalRatingBatch): Promise<AppliedRatingRow[]> {
  const { eventId, clientId, signal, alpha } = args;
  const targets = args.targets;
  if (targets.length === 0) return [];
  const kinds = targets.map(t => t.kind);
  const sources = targets.map(t => t.source_id);
  const keys = targets.map(t => t.key);
  const applied = await tx.executeRaw<{ element_kind: string; source_id: string; element_key: string; weight_after: number | string }>(
    RETRIEVAL_FEEDBACK_SQL.apply,
    [kinds, sources, keys, targets.map(t => t.rating), targets.map(t => t.content_hash), alpha, eventId, signal, clientId],
  );
  const newly = new Set(applied.map(a => `${a.element_kind}|${a.source_id}|${a.element_key}`));
  const stored = await tx.executeRaw<{ element_kind: string; source_id: string; element_key: string; rating: number | string; weight_before: number | string; weight_after: number | string }>(
    RETRIEVAL_FEEDBACK_SQL.stored, [eventId, signal, kinds, sources, keys]);
  const finalWeights = new Map(applied.map(a => [`${a.element_kind}|${a.source_id}|${a.element_key}`, Number(a.weight_after)]));
  return stored.map(r => {
    const id = `${r.element_kind}|${r.source_id}|${r.element_key}`;
    return {
      kind: r.element_kind,
      source_id: r.source_id,
      key: r.element_key,
      rating: Number(r.rating),
      weight_before: Number(r.weight_before),
      weight_after: newly.has(id) ? (finalWeights.get(id) ?? Number(r.weight_after)) : Number(r.weight_after),
      newly_applied: newly.has(id),
    };
  });
}

/** The feedback counts and the ten lowest and ten highest page weights, ties by byte of source and key. */
export async function readFeedbackStatus(tx: Raw): Promise<FeedbackStatusData> {
  const [counts] = await tx.executeRaw<Record<string, number | string | Date | null>>(RETRIEVAL_FEEDBACK_SQL.statusCounts);
  const lowest = await tx.executeRaw<{ source_id: string; slug: string; weight: number | string; low_ratings: number | string }>(RETRIEVAL_FEEDBACK_SQL.statusLowest);
  const highest = await tx.executeRaw<{ source_id: string; slug: string; weight: number | string }>(RETRIEVAL_FEEDBACK_SQL.statusHighest);
  return { counts: counts ?? {}, lowest, highest };
}

/** One volunteered page: the row `insertVolunteerEvents` writes when its page still exists. */
export interface VolunteerEventInsert {
  source_id: string;
  slug: string;
  confidence: number;
  match_arm: string;
  rationale: string;
  channel: string;
  session_id?: string | null;
  turn?: number | null;
}

/** One match arm and channel of the usage read: how many pages it volunteered and how many were retrieved afterwards. */
export interface VolunteerArmUsage {
  match_arm: string;
  channel: string;
  volunteered: number;
  used: number;
}

/**
 * The statements of src/core/context/volunteer-events.ts and volunteer.ts. The insert is one statement over parallel
 * arrays (it was composed from the row count), with the page-exists probe it ran under the feedback writers' key-share
 * lock (#9068).
 */
export const VOLUNTEER_SQL = {
  insert: `INSERT INTO context_volunteer_events
       (source_id, slug, confidence, match_arm, rationale, channel, session_id, turn)
     SELECT v.* FROM unnest($1::text[], $2::text[], $3::float8[], $4::text[], $5::text[], $6::text[], $7::text[], $8::int[])
       AS v(source_id, slug, confidence, match_arm, rationale, channel, session_id, turn)
     WHERE EXISTS (SELECT 1 FROM pages pg WHERE pg.source_id = v.source_id AND pg.slug = v.slug FOR KEY SHARE)`,
  usage: `SELECT e.match_arm, e.channel,
              count(*)::text AS volunteered,
              count(*) FILTER (WHERE GREATEST(p.last_retrieved_at, r.last_retrieved_at) > e.volunteered_at)::text AS used
         FROM context_volunteer_events e
         LEFT JOIN pages p
           ON p.source_id = e.source_id AND p.slug = e.slug AND p.deleted_at IS NULL
         LEFT JOIN page_retrievals r ON r.page_id = p.id
        WHERE e.source_id = ANY($1::text[])
          AND e.volunteered_at > now() - ($2 || ' days')::interval
        GROUP BY e.match_arm, e.channel
        ORDER BY e.match_arm COLLATE "C", e.channel COLLATE "C"`,
} as const;

/** Logs the volunteered pages whose page row still exists; the rest are dropped. */
export async function insertVolunteerEvents(tx: Raw, rows: VolunteerEventInsert[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.executeRaw(VOLUNTEER_SQL.insert, [
    rows.map(r => r.source_id), rows.map(r => r.slug), rows.map(r => r.confidence), rows.map(r => r.match_arm),
    rows.map(r => r.rationale), rows.map(r => r.channel), rows.map(r => r.session_id ?? null), rows.map(r => r.turn ?? null),
  ]);
}

/** The volunteered and used counts per match arm and channel over the last `days` days, by byte of arm then channel. */
export async function readVolunteerUsage(tx: Raw, sourceIds: string[], days: number): Promise<VolunteerArmUsage[]> {
  const rows = await tx.executeRaw<{ match_arm: string; channel: string; volunteered: string | number; used: string | number }>(
    VOLUNTEER_SQL.usage, [sourceIds, String(days)]);
  return rows.map(r => ({ match_arm: r.match_arm, channel: r.channel, volunteered: Number(r.volunteered), used: Number(r.used) }));
}

/** One automatic or backfill decision of the chronicle ledger: the row `upsertChronicleRow` writes (a pending or skipped row). */
export interface ChronicleRowUpsert {
  sourceId: string;
  pageId: number;
  contentHash: string;
  extractorVersion: number;
  slug: string;
  state: string;
  reason: string | null;
  trigger: string;
  principalKind: string | null;
  principalId: string | null;
  requestId: string | null;
  noExtract: boolean;
  /** An ISO instant, or null. */
  nextAttemptAt: string | null;
}

/** The page an automatic judge call is reserved for. */
export interface ChronicleJudgeKey {
  sourceId: string;
  pageId: number;
  contentHash: string;
}

/** The rows `readChronicleLedger` returns, before src/core/chronicle/ledger-stats.ts shapes them (counts as the database types them). */
export interface ChronicleLedgerSections {
  counts: { pending: number; extracted: number; failed: number; skipped: number; known_usd: number | null; unpriced: number; incomplete: number };
  reasons: Array<{ state: string; reason: string; n: number }>;
  calls: number;
  principals: Array<{ principal: string; calls: number }>;
}

/** The statements of src/core/chronicle/ledger.ts (the decision upsert, the judge slot) and ledger-stats.ts (the rollup), as they ran. */
export const CHRONICLE_LEDGER_SQL = {
  upsert: `INSERT INTO chronicle_page_state AS c (source_id, page_id, content_hash, extractor_version, slug, state, reason, trigger,
       principal_kind, principal_id, request_id, no_extract, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid, $12, $13::timestamptz)
     ON CONFLICT (source_id, page_id, content_hash, extractor_version) DO UPDATE SET
       slug=EXCLUDED.slug, state=EXCLUDED.state, reason=EXCLUDED.reason, trigger=EXCLUDED.trigger,
       principal_kind=EXCLUDED.principal_kind, principal_id=EXCLUDED.principal_id, request_id=EXCLUDED.request_id,
       no_extract=EXCLUDED.no_extract, next_attempt_at=EXCLUDED.next_attempt_at, decided_at=now(), updated_at=now(),
       campaign_id=NULL, attempt_cap_usd=NULL, max_attempts=NULL, pricing_policy=NULL, campaign_max_usd=NULL
     WHERE NOT (EXCLUDED.trigger='auto' AND c.trigger='backfill' AND c.state IN ('pending','failed'))
       AND (c.state <> 'extracted' OR EXISTS (SELECT 1 FROM chronicle_page_state newer
         WHERE newer.source_id=c.source_id AND newer.page_id=c.page_id AND newer.content_hash<>c.content_hash
           AND newer.state='extracted' AND newer.updated_at > c.updated_at))
     RETURNING page_id`,
  lock: "SELECT pg_advisory_xact_lock(hashtext('gbrain:chronicle:daily_reservation'))",
  count: "SELECT count(*) AS n FROM chronicle_judge_reservations WHERE reserved_at > now() - interval '24 hours'",
  reserve: 'INSERT INTO chronicle_judge_reservations (source_id, page_id, content_hash) VALUES ($1, $2, $3)',
  counts: `SELECT
         count(*) FILTER (WHERE state = 'pending')::int AS pending,
         count(*) FILTER (WHERE state = 'extracted' AND updated_at > now() - interval '7 days')::int AS extracted,
         count(*) FILTER (WHERE state = 'failed' AND updated_at > now() - interval '7 days')::int AS failed,
         count(*) FILTER (WHERE state = 'skipped' AND updated_at > now() - interval '7 days')::int AS skipped,
         sum(cost_usd) FILTER (WHERE NOT unpriced AND updated_at > now() - interval '7 days')::float8 AS known_usd,
         count(*) FILTER (WHERE unpriced AND state IN ('extracted','failed') AND updated_at > now() - interval '7 days')::int AS unpriced,
         count(*) FILTER (WHERE NOT unpriced AND cost_usd IS NULL AND state IN ('extracted','failed') AND attempts > 0
           AND updated_at > now() - interval '7 days')::int AS incomplete
       FROM chronicle_page_state WHERE trigger = 'auto'`,
  reasons: `SELECT state, reason, count(*)::int AS n FROM chronicle_page_state
       WHERE trigger = 'auto' AND state IN ('skipped','failed') AND reason IS NOT NULL AND updated_at > now() - interval '7 days'
       GROUP BY state, reason ORDER BY n DESC, reason COLLATE "C"`,
  calls: "SELECT count(*)::int AS n FROM chronicle_judge_reservations WHERE reserved_at > now() - interval '24 hours'",
  principals: `SELECT (coalesce(l.principal_kind, 'unattributed') || coalesce(':' || l.principal_id, '')) COLLATE "C" AS principal, count(*)::int AS calls
       FROM chronicle_judge_reservations r
       LEFT JOIN chronicle_page_state l ON l.source_id = r.source_id AND l.page_id = r.page_id
         AND l.content_hash = r.content_hash AND l.trigger = 'auto'
       WHERE r.reserved_at > now() - interval '24 hours'
       GROUP BY 1 ORDER BY calls DESC, principal LIMIT 5`,
} as const;

/** Records a decision; false when the guards leave the existing row as it was (see ledger.ts upsertChronicleRow). */
export async function upsertChronicleRow(tx: Raw, w: ChronicleRowUpsert): Promise<boolean> {
  const written = await tx.executeRaw(CHRONICLE_LEDGER_SQL.upsert,
    [w.sourceId, w.pageId, w.contentHash, w.extractorVersion, w.slug, w.state, w.reason, w.trigger,
      w.principalKind, w.principalId, w.requestId, w.noExtract, w.nextAttemptAt]);
  return written.length > 0;
}

/** Takes one automatic judge slot under the daily limit, serialized by an advisory lock; false when the limit is used up. */
export async function reserveChronicleJudgeSlot(tx: Pick<BrainEngine, 'transaction'>, limit: number, key: ChronicleJudgeKey): Promise<boolean> {
  return tx.transaction(async (inner) => {
    await inner.executeRaw(CHRONICLE_LEDGER_SQL.lock);
    const [row] = await inner.executeRaw<{ n: number | string }>(CHRONICLE_LEDGER_SQL.count);
    if (Number(row?.n ?? 0) >= limit) return false;
    await inner.executeRaw(CHRONICLE_LEDGER_SQL.reserve, [key.sourceId, key.pageId, key.contentHash]);
    return true;
  });
}

/** The automatic rows' counts, skip and failure reasons, 24-hour judge calls and the five busiest principals. */
export async function readChronicleLedger(tx: Raw): Promise<ChronicleLedgerSections> {
  const [counts] = await tx.executeRaw<ChronicleLedgerSections['counts']>(CHRONICLE_LEDGER_SQL.counts);
  const reasons = await tx.executeRaw<ChronicleLedgerSections['reasons'][number]>(CHRONICLE_LEDGER_SQL.reasons);
  const [calls] = await tx.executeRaw<{ n: number }>(CHRONICLE_LEDGER_SQL.calls);
  const principals = await tx.executeRaw<ChronicleLedgerSections['principals'][number]>(CHRONICLE_LEDGER_SQL.principals);
  return {
    counts: counts ?? { pending: 0, extracted: 0, failed: 0, skipped: 0, known_usd: null, unpriced: 0, incomplete: 0 },
    reasons, calls: Number(calls?.n ?? 0), principals,
  };
}

/** One member that follows a source, as `inspectSharedMemberMigration` reads it (epoch as a number on every engine). */
export interface SharedSkillMigrationRow {
  installation_id: string;
  adapter: string;
  epoch: number;
  active: boolean;
  approved_incarnation: string | null;
  desired_view: string | null;
  acknowledged_view: string | null;
  stage: string | null;
}

/** The statement shared-skills/migration-members.ts ran: its text, with the adapter sort key `COLLATE "C"` so Postgres sorts by byte like PGLite and the store. */
export const SHARED_SKILL_MIGRATION_SQL = `SELECT m.installation_id,m.adapter,m.epoch,m.active,m.follow_policy->'sources'->>$1 AS approved_incarnation,
      m.desired_view,m.acknowledged_view,
      (SELECT b.evidence->>'stage' FROM shared_skill_delivery_batches b WHERE b.installation_id=m.installation_id
        AND b.epoch=m.epoch AND b.sequence=m.acknowledged_sequence AND b.acknowledged_at IS NOT NULL LIMIT 1) AS stage
    FROM shared_skill_members m WHERE m.follow_policy->'sources' ? $1 ORDER BY m.adapter COLLATE "C",m.installation_id LIMIT 4096`;

/** The members that follow the source, by byte of adapter then installation id, at most 4096. */
export async function listSharedSkillMigrationRows(tx: Raw, sourceId: string): Promise<SharedSkillMigrationRow[]> {
  const rows = await tx.executeRaw<Omit<SharedSkillMigrationRow, 'epoch'> & { epoch: string | number }>(SHARED_SKILL_MIGRATION_SQL, [sourceId]);
  return rows.map(row => ({ ...row, epoch: Number(row.epoch) }));
}

/**
 * The statement page-body/segment-derive.ts derivationNeedles ran, with `foldSql('gbrain_fact_normalize(c)')` written out:
 * translate final sigma to sigma, drop the combining dot after an i (`\u0307` below is that one character), then keep the
 * distinct non-empty results by byte.
 */
export const DERIVATION_NEEDLES_SQL = `SELECT DISTINCT f COLLATE "C" AS f FROM (SELECT replace(translate(gbrain_fact_normalize(c), 'ς', 'σ'), 'i\u0307', 'i') AS f
    FROM unnest($1::text[]) c) x WHERE f <> '' ORDER BY f`;

/** The claims normalized by the database and folded: distinct, non-empty, in byte order. */
export async function normalizeDerivationClaims(tx: Raw, claims: string[]): Promise<string[]> {
  if (!claims.length) return [];
  const rows = await tx.executeRaw<{ f: string }>(DERIVATION_NEEDLES_SQL, [claims]);
  return rows.map(row => row.f);
}
