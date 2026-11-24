/**
 * The two terminal write failure statements as `src/core/persistence/terminal-failures.ts` composed them before they moved
 * to src/core/engine-sql/doctor-terminal.ts as literal text: test/doctor-terminal-sql.test.ts pins that text to this
 * composition of the same SQL builders, so a builder edit that leaves the literal behind fails there.
 */
import { TERMINAL_SQL_PARTS } from '../../src/core/persistence/terminal-failures.ts';
import { SYNC_PASS_SUPERSEDED } from '../../src/core/persistence/sync-checkpoint-replaced.ts';

const { ROUTED_MESSAGE, BUILD, ENDED, TERMINAL, RECOVERY, SCHEMA_AWARE_REASON, HISTORICAL_BY_BUILD, terminalKnockOnSql, supersessionSql, supersessionOrderSql } = TERMINAL_SQL_PARTS;

/** The aggregate over the base set (`$1` the span in days, `$2` the source filter, `$3` the window in days). */
export function composeTerminalGroupsSql(): string {
  const days = Array.from({ length: 7 }, (_, i) => `count(*) FILTER (WHERE state IN ('failed','conflict','cancelled') AND ended_at <= now()-interval '${i + 1} day' AND ended_at > now()-interval '${i + 2} day')::int AS d${i + 2}`).join(',\n      ');
  return `WITH base AS (
      SELECT r.id, r.request_id::text AS request_id, r.source_id, r.slug, r.digest, r.sequence, r.operation, r.intent->>'kind' AS intent_kind, r.state, r.error_code,
        r.error_detail->>'origin' AS origin, ${SCHEMA_AWARE_REASON('r')} AS reason, r.error_detail->>'cause' AS cause,
        r.recovery IS NOT NULL AS has_recovery, r.blocked_reason, r.compacted, ${terminalKnockOnSql('r')} AS knock_on,
        ${ROUTED_MESSAGE('r')} AS routed_message, ${BUILD('r')} AS build, ${ENDED('r')} AS ended_at
      FROM persistence_requests r JOIN sources s ON s.id=r.source_id AND s.archived IS NOT TRUE
      WHERE (${RECOVERY('r')} OR (${TERMINAL('r')} AND ${ENDED('r')} > now()-($1::int*interval '1 day')))
        AND ($2::text[] IS NULL OR r.source_id=ANY($2::text[]))
    ), resolved AS (
      SELECT r.id FROM base r WHERE NOT r.has_recovery AND EXISTS (SELECT 1 FROM persistence_requests c WHERE ${supersessionSql('r', 'c', 'r.intent_kind')})
    ), tagged AS (
      SELECT b.*, (x.id IS NOT NULL OR (NOT b.has_recovery AND b.error_code='${SYNC_PASS_SUPERSEDED}')) AS resolved, (b.has_recovery OR b.ended_at > now()-($3::int*interval '1 day')) AS in_window, ${HISTORICAL_BY_BUILD('b')} AS historical_build
      FROM base b LEFT JOIN resolved x ON x.id=b.id
    )
    SELECT GROUPING(state) AS set, source_id, state, error_code, origin, reason, cause, operation, intent_kind, has_recovery, blocked_reason, compacted, knock_on, routed_message, build, resolved,
      count(*) FILTER (WHERE in_window)::int AS rows, count(*) FILTER (WHERE in_window)::int AS in_window,
      count(*) FILTER (WHERE state IN ('failed','conflict','cancelled') AND ended_at > now()-interval '1 day')::int AS n_24h,
      ${days},
      to_char(min(ended_at) FILTER (WHERE in_window) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS oldest,
      floor(EXTRACT(EPOCH FROM now()-min(ended_at) FILTER (WHERE in_window)))::bigint AS oldest_age,
      count(DISTINCT slug) FILTER (WHERE in_window AND NOT resolved AND NOT has_recovery AND NOT historical_build)::int AS distinct_slugs,
      count(DISTINCT digest) FILTER (WHERE in_window AND NOT resolved AND NOT has_recovery AND NOT historical_build)::int AS distinct_intents,
      (array_agg(request_id ORDER BY sequence) FILTER (WHERE has_recovery))[1:20] AS recovery_ids,
      (array_agg(slug ORDER BY sequence) FILTER (WHERE has_recovery))[1:20] AS recovery_slugs
    FROM tagged
    GROUP BY GROUPING SETS ((source_id, state, error_code, origin, reason, cause, operation, intent_kind, has_recovery, blocked_reason, compacted, knock_on, routed_message, build, resolved), (source_id))
    -- Every group key, text by byte: a source's blockers, defects and tied categories list the same way on every engine and locale.
    ORDER BY source_id COLLATE "C", 1, state COLLATE "C", error_code COLLATE "C", origin COLLATE "C", reason COLLATE "C", cause COLLATE "C", operation COLLATE "C",
      intent_kind COLLATE "C", has_recovery, blocked_reason COLLATE "C", compacted, knock_on, routed_message COLLATE "C", build COLLATE "C", resolved`;
}

/** One batch of a source's receipts (`$1` the source, `$2` the window in days, `$3` the cursor, `$4` the batch size). */
export function composeTerminalBatchSql(): string {
  return `SELECT r.request_id::text AS request_id, r.sequence::text AS sequence, r.source_id, r.slug, r.operation, r.intent_kind, r.state, r.error_code, r.error_detail,
          r.error_detail->>'origin' AS origin, r.error_detail->>'reason' AS reason, r.error_detail->>'cause' AS cause,
          r.recovery IS NOT NULL AS has_recovery, r.blocked_reason, r.compacted, ${terminalKnockOnSql('r')} AS knock_on, ${ROUTED_MESSAGE('r')} AS routed_message, ${BUILD('r')} AS build,
          to_char(${ENDED('r')} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ended_at, to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS admitted_at,
          later.state AS later_state, later.same_intent
        FROM (SELECT p.*, p.intent->>'kind' AS intent_kind FROM persistence_requests p
          WHERE p.source_id=$1 AND (${RECOVERY('p')} OR (${TERMINAL('p')} AND ${ENDED('p')} > now()-($2::int*interval '1 day')))
            AND ($3::bigint IS NULL OR p.sequence < $3::bigint)
          ORDER BY p.sequence DESC LIMIT $4) r
        LEFT JOIN LATERAL (SELECT c.state, c.digest=r.digest AS same_intent FROM persistence_requests c WHERE ${supersessionSql('r', 'c', 'r.intent_kind')}
          ORDER BY ${supersessionOrderSql('r', 'c')} LIMIT 1) later ON r.recovery IS NULL
        ORDER BY r.sequence DESC`;
}
