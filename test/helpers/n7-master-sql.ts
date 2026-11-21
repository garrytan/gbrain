/**
 * Master's text for the statements N7's callers ran before they moved behind BrainEngine members and typed source reads
 * (the N7 base 4206107ed9, before the move). Each literal below is expanded from the call site by file and line (the
 * line is the one scripts/sql-move-check.mjs reports as the statement's origin, or the master line for a statement the
 * check does not list because its text is a one-line literal); nothing is retyped from the members. The run-time text
 * building each site did around its statement is copied with it.
 *
 * test/n7-sql-move-parity.test.ts runs these against the members the callers now use.
 */
import { resolve } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { ENTITY_LINKABLE_SQL } from '../../src/core/facts/attribution.ts';
import { conversationPaidSql, conversationTriedSql } from '../../src/core/facts/conversation-memo.ts';
import { boundedBodyPrefixSql } from '../../src/core/page-window/bounded-lead.ts';
import { CONNECTOR_KINDS_SQL } from '../../src/core/persistence/connector-kinds.ts';
import { ALL_SOURCES } from '../../src/core/source-id.ts';
import { STORAGE_ROLE } from '../../src/core/storage-manifest/door.ts';

type Q = Pick<BrainEngine, 'executeRaw'>;
type Row = Record<string, unknown>;

/** src/commands/doctor/checks/queue-assets.ts:58. */
export const atomFactRows = (e: Q) => e.executeRaw<{ n: number }>(
        `SELECT count(*)::int AS n FROM facts
          WHERE expired_at IS NULL AND (source_markdown_slug LIKE 'atoms/%' OR context LIKE 'atoms/%')`);

/** src/commands/doctor/checks/trust-release-unpreviewed.ts:21 (`LIMIT ${LIMIT}`, interpolated by the caller). */
export const unpreviewedTrustRows = (e: Q, LIMIT: number) => e.executeRaw<Row>(
      `SELECT f.id, f.source_id, f.source_markdown_slug AS slug, f.row_num, h.id AS hold_id, COUNT(*) OVER () AS total
         FROM facts f JOIN LATERAL (SELECT id FROM write_gate_holds WHERE kind = 'fact' AND status = 'released' AND source_id = f.source_id
          AND slug = f.source_markdown_slug AND payload->>'row_num' = f.row_num::text
          AND request_id::text IS NOT DISTINCT FROM f.write_origin->>'request_id' ORDER BY id DESC LIMIT 1) h ON true
        WHERE f.trust_tier = 'user_confirmed' AND f.expired_at IS NULL AND f.write_origin->>'channel' = 'trust_release'
          AND f.write_origin->>'fields_previewed' IS NULL
        ORDER BY f.id LIMIT ${LIMIT}`);

// src/commands/doctor/checks/unlinked-facts.ts: the constants the statements splice.
const DERIVED = `f.source LIKE 'cli:extract-conversation-facts%'`;
const ACTIVE = `f.expired_at IS NULL AND (f.valid_until IS NULL OR f.valid_until > now()) AND f.source <> ALL($2::text[]) AND ${ENTITY_LINKABLE_SQL}`;
const ORIGIN = `CASE WHEN ${DERIVED} THEN 'conversation' WHEN f.source = 'mcp:put_page' THEN 'mcp:put_page'
  WHEN f.source LIKE 'mcp:%' OR f.source LIKE 'sync:%' OR f.source LIKE 'hook:%' OR f.source IN ('file_upload', 'code_import') THEN 'extraction'
  ELSE 'remember' END`;
const INFERRED = `(f.context LIKE 'entity inferred from %' OR f.context LIKE '% — entity inferred from %')`;
const INFERRED_TIER = `substring(f.context from 'entity inferred from ([a-z]+)')`;

/** src/commands/doctor/checks/unlinked-facts.ts:79. */
export const factTableCatalogRows = (e: Q) => e.executeRaw<{ facts: string | null; attempts: string | null }>(
    `SELECT to_regclass('facts')::text AS facts, to_regclass('fact_relink_attempts')::text AS attempts`);

/** src/commands/doctor/checks/unlinked-facts.ts:87 (`ids`, `audit` and `UNLINKED_WINDOW_PER_SOURCE` as the caller computed them). */
export function unlinkedOriginRows(e: Q, ids: string[], audit: string[], UNLINKED_WINDOW_PER_SOURCE: number, hasAttempts: boolean) {
  const tried = hasAttempts ? conversationTriedSql : 'false';
  const paid = hasAttempts ? conversationPaidSql : 'false';
  return e.executeRaw<Row>(
    `SELECT s.id AS source_id, w.origin, COUNT(*)::int AS active, COUNT(*) FILTER (WHERE w.unlinked)::int AS unlinked,
            COUNT(*) FILTER (WHERE w.unlinked AND w.fence_owned AND NOT w.derived)::int AS fence_owned,
            COUNT(*) FILTER (WHERE w.unlinked AND w.derived)::int AS conversation,
            COUNT(*) FILTER (WHERE w.unlinked AND w.derived AND w.tried)::int AS conversation_tried,
            COUNT(*) FILTER (WHERE w.unlinked AND w.derived AND w.tried AND w.paid)::int AS conversation_paid
       FROM unnest($1::text[]) AS s(id) CROSS JOIN LATERAL (
         SELECT ${ORIGIN} AS origin, f.entity_slug IS NULL AS unlinked, ${DERIVED} AS derived,
                CASE WHEN f.entity_slug IS NULL AND ${DERIVED} THEN ${tried} ELSE false END AS tried,
                CASE WHEN f.entity_slug IS NULL AND ${DERIVED} THEN ${paid} ELSE false END AS paid,
                (f.row_num IS NOT NULL OR f.source_markdown_slug IS NOT NULL) AS fence_owned
           FROM facts f WHERE f.source_id = s.id AND ${ACTIVE}
          ORDER BY f.created_at DESC LIMIT $3) w
      GROUP BY s.id, w.origin`,
    [ids, audit, UNLINKED_WINDOW_PER_SOURCE],
  );
}

/** src/commands/doctor/checks/unlinked-facts.ts:116. */
export function unlinkedFactStatRows(e: Q, ids: string[], audit: string[], hasAttempts: boolean) {
  const tried = hasAttempts ? conversationTriedSql : 'false';
  const judged = hasAttempts
    ? `EXISTS (SELECT 1 FROM fact_relink_attempts a WHERE a.source_id = f.source_id AND a.fact_id = f.id AND a.outcome = 'no_subject')`
    : 'false';
  return e.executeRaw<Row>(
    `SELECT COUNT(*)::int AS facts, COUNT(*) FILTER (WHERE f.entity_slug IS NULL)::int AS unlinked,
            COUNT(*) FILTER (WHERE f.entity_slug IS NULL AND ${judged})::int AS no_subject,
            COUNT(*) FILTER (WHERE f.entity_slug IS NULL AND ${tried})::int AS conversation_unresolved,
            COUNT(*) FILTER (WHERE ${INFERRED} AND ${INFERRED_TIER} = 'page')::int AS inferred_page,
            COUNT(*) FILTER (WHERE ${INFERRED} AND ${INFERRED_TIER} = 'mention')::int AS inferred_mention
       FROM facts f WHERE f.source_id = ANY($1::text[]) AND f.created_at >= now() - interval '7 days' AND ${ACTIVE}`,
    [ids, audit],
  );
}

/** src/commands/doctor/checks/unlinked-facts.ts:128. */
export const factRelinkOutcomeRows = (e: Q, ids: string[]) => e.executeRaw<Row>(
      `SELECT outcome, tier, COUNT(*)::int AS n FROM fact_relink_attempts
        WHERE source_id = ANY($1::text[])
          AND (outcome = 'no_subject' OR (outcome = 'linked' AND attempted_at >= now() - interval '7 days'))
        GROUP BY outcome, tier`,
      [ids],
    );

/** src/commands/doctor/checks/unlinked-facts.ts:144 (`hitSql` as the caller chose it from the fix kind). */
export function unlinkedConversationSlugRows(e: Q, sourceId: string, audit: string[], UNLINKED_WINDOW_PER_SOURCE: number, fixKind: 'relink' | 'reextract' | 'manual', hasAttempts: boolean) {
  const tried = hasAttempts ? conversationTriedSql : 'false';
  const paid = hasAttempts ? conversationPaidSql : 'false';
  const hitSql = { relink: `NOT ${tried}`, reextract: `${tried} AND NOT ${paid}`, manual: `${tried} AND ${paid}` }[fixKind];
  return e.executeRaw<{ slug: string }>(
      `SELECT w.slug FROM (SELECT f.source_markdown_slug AS slug, f.entity_slug IS NULL AND ${DERIVED} AND ${hitSql} AS hit
           FROM facts f WHERE f.source_id = $1 AND ${ACTIVE} ORDER BY f.created_at DESC LIMIT $3) w
        WHERE w.hit AND w.slug IS NOT NULL GROUP BY w.slug ORDER BY COUNT(*) DESC, w.slug`,
      [sourceId, audit, UNLINKED_WINDOW_PER_SOURCE],
    );
}

/** src/commands/doctor/checks/facts-pages.ts:26. */
export const factsPageBodyRows = (e: Q) => e.executeRaw<Row>(
      `SELECT p.slug, p.source_id, p.body_storage = 'segmented' AS segmented, ${boundedBodyPrefixSql('p')} AS body
         FROM pages p WHERE p.type = 'facts' AND p.deleted_at IS NULL ORDER BY p.source_id, p.slug`);

/** src/commands/graph-query.ts:133 (in), :141 (both) and :149 (out). */
export async function foreignEdgeRows(e: Q, rootSlug: string, direction: 'in' | 'out' | 'both', sourceId: string) {
  const sql = direction === 'in'
    ? `SELECT COUNT(*)::text AS n
         FROM links l
         JOIN pages fp ON l.from_page_id = fp.id
         JOIN pages tp ON l.to_page_id = tp.id
        WHERE tp.slug = $1 AND tp.source_id = $2
          AND fp.source_id IS NOT NULL
          AND fp.source_id <> tp.source_id`
    : direction === 'both'
    ? `SELECT COUNT(*)::text AS n
         FROM links l
         JOIN pages fp ON l.from_page_id = fp.id
         JOIN pages tp ON l.to_page_id = tp.id
        WHERE ((fp.slug = $1 AND fp.source_id = $2) OR (tp.slug = $1 AND tp.source_id = $2))
          AND fp.source_id IS NOT NULL
          AND tp.source_id IS NOT NULL
          AND fp.source_id <> tp.source_id`
    : `SELECT COUNT(*)::text AS n
         FROM links l
         JOIN pages fp ON l.from_page_id = fp.id
         JOIN pages tp ON l.to_page_id = tp.id
        WHERE fp.slug = $1 AND fp.source_id = $2
          AND tp.source_id IS NOT NULL
          AND fp.source_id <> tp.source_id`;
  const rows = await e.executeRaw<{ n: string }>(sql, [rootSlug, sourceId]);
  return Number(rows[0]?.n ?? 0);
}
/** src/commands/doctor/checks/writer-version.ts:16. */
export const writerVersionCutoffRows = (e: Q) => e.executeRaw<{ cutoff: unknown }>('SELECT writer_version_cutoff AS cutoff FROM persistence_brain WHERE singleton=1');


// ------------------------------------------------------------------ `sources` and `config` reads

/** The one-line source id reads of the doctor checks, ghost-pages, chronicle, repair and shared-skills. */
export const liveSourceIdRows = (e: Q) => e.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id');
export const notArchivedSourceIdRows = (e: Q) => e.executeRaw<{ id: string }>('SELECT id FROM sources WHERE NOT archived ORDER BY id');
export const allSourceIdRows = (e: Q) => e.executeRaw<{ id: string }>('SELECT id FROM sources ORDER BY id');

/** src/commands/doctor/checks/db-ahead-of-git.ts:67. */
export const sourcePathRows = (e: Q) => e.executeRaw<{ id: string; local_path: string | null }>('SELECT id, local_path FROM sources WHERE NOT archived ORDER BY id');

/** src/core/repair/core.ts:292 (`source` as the caller passed it). */
export const repairSourceRows = (e: Q, source?: string) => e.executeRaw<{ id: string }>(
    `SELECT id FROM sources WHERE archived IS NOT TRUE ${source ? 'AND id=$1' : ''} ORDER BY id`, source ? [source] : []);

/** src/core/remediation/context.ts:45. */
export const firstSourceLocalPathRows = (e: Q) => e.executeRaw<{ local_path: string }>(
      `SELECT local_path FROM sources WHERE NOT archived AND local_path IS NOT NULL AND local_path <> ''
        ORDER BY (id = 'default') DESC, id LIMIT 1`);

/** src/core/ops/skills-catalog.ts:364 and the fallback read after it. */
export const skillsSourceRows = (e: Q) => e.executeRaw<{ id: string; name: string; local_path: string | null; config: Record<string, unknown> | null }>(
        `SELECT id, name, local_path, config FROM sources WHERE COALESCE(archived, FALSE) = FALSE ORDER BY id`);
export const skillsSourceFallbackRows = (e: Q) => e.executeRaw<{ id: string; name: string; local_path: string | null; config: Record<string, unknown> | null }>(
  `SELECT id, name, local_path, config FROM sources ORDER BY id`);

/** src/core/connectors/item-holds-store.ts:78 and its CONNECTOR_SOURCES_SQL (the same text twice). */
export const connectorSourceRows = (e: Q) => e.executeRaw<Row>(
    `SELECT id,incarnation::text AS incarnation,local_path,config FROM sources WHERE archived IS NOT TRUE AND config->>'kind' IN (${CONNECTOR_KINDS_SQL}) ORDER BY id`);
/** src/core/persistence/connector-status.ts:65 (readConnectorLastError). */
export const connectorIncarnationRows = (e: Q, sourceId: string) => e.executeRaw<{ incarnation: string }>(
    `SELECT incarnation::text FROM sources WHERE id=$1 AND NOT archived AND config->>'kind' IN (${CONNECTOR_KINDS_SQL})`, [sourceId]);
/** src/core/persistence/connector-status.ts:74 (readConnectorSourceStatuses). */
export const connectorStatusSourceRows = (e: Q, sourceIds?: string[]) => e.executeRaw<{ id: string; incarnation: string }>(
    `SELECT id,incarnation::text FROM sources WHERE NOT archived AND config->>'kind' IN (${CONNECTOR_KINDS_SQL}) AND ($1::text[] IS NULL OR id=ANY($1::text[]))`,
    [sourceIds ?? null]);

/** src/core/storage-manifest/door.ts:36. */
export const storageRoleRows = (e: Q, sourceId: string) => e.executeRaw('SELECT 1 FROM sources WHERE id = $1 AND config->>\'role\' = $2', [sourceId, STORAGE_ROLE]);

/** src/core/restore-target.ts:30, :35, :37 and :48, with the branching of resolveRestoreTarget around them. */
export async function resolveRestoreTargetMaster(
  engine: BrainEngine, source: string | undefined, repo: string | undefined,
  resolveDefault: (e: BrainEngine) => Promise<string>,
): Promise<{ source: string; repo: string } | { error: string }> {
  if (source === ALL_SOURCES) return { error: 'one source' };
  if (!source && repo) {
    const matches = await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE AND local_path=$1 LIMIT 2', [resolve(repo)]);
    if (matches.length === 1) source = matches[0]!.id;
    else {
      const [archived] = matches.length ? [] : await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS TRUE AND local_path=$1 ORDER BY id LIMIT 1', [resolve(repo)]);
      if (archived) return { error: `archived ${archived.id}` };
      const owners = await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id LIMIT 2');
      if (!matches.length && owners.length === 1) source = owners[0]!.id;
      else return { error: 'not exactly one source' };
    }
  }
  source ??= await resolveDefault(engine);
  if (!repo) {
    const [owner] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id=$1', [source]);
    repo = owner?.local_path ?? (source === 'default' ? await engine.getConfig('sync.repo_path') : undefined) ?? undefined;
  }
  if (!repo) return { error: 'no repo' };
  return { source, repo };
}

/** src/core/search/query-cache.ts:495, src/commands/doctor/registry.ts:607 and src/core/backfill-effective-date.ts:112, :126 and :134. */
export const configKeyRows = (e: Q, keys: string[]) => e.executeRaw<{ key: string; value: string }>(`SELECT key, value FROM config WHERE key = ANY($1)`, [keys]);
export const configValueRows = (e: Q, key: string) => e.executeRaw<{ value: string }>('SELECT value FROM config WHERE key=$1', [key]);
export const checkpointReadRows = (e: Q, key: string) => e.executeRaw<{ value: string }>(`SELECT value FROM config WHERE key = $1 LIMIT 1`, [key]);
export const checkpointWrite = (e: Q, key: string, value: string) => e.executeRaw(
      `INSERT INTO config (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value]);
export const checkpointDelete = (e: Q, key: string) => e.executeRaw(`DELETE FROM config WHERE key = $1`, [key]);
