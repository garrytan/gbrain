/**
 * Canonical SQL coercion for historical `sources.config` shapes.
 *
 * Config is meant to be a JSONB object. Older writers could leave nested JSON
 * strings or arrays of config fragments. The recursive CTE unwraps strings up
 * to the same depth as the application reader, then merges recoverable array
 * fragments left-to-right. Invalid fragments are ignored instead of making a
 * repair or archive operation fail.
 *
 * This expression is static SQL: it contains no user input.
 */
export const SOURCE_CONFIG_OBJECT_SQL = `(
  WITH RECURSIVE
  root_layers(value, depth) AS (
    SELECT COALESCE(config, '{}'::jsonb), 0
    UNION ALL
    SELECT (value #>> '{}')::jsonb, depth + 1
      FROM root_layers
     WHERE depth < 10
       AND jsonb_typeof(value) = 'string'
       AND (value #>> '{}') IS JSON
  ),
  root(value) AS (
    SELECT value FROM root_layers ORDER BY depth DESC LIMIT 1
  ),
  fragment_seeds(ordinality, value) AS (
    SELECT 0::bigint, value FROM root WHERE jsonb_typeof(value) = 'object'
    UNION ALL
    SELECT item.ordinality, item.value
      FROM root,
           LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(root.value) = 'array' THEN root.value ELSE '[]'::jsonb END
           ) WITH ORDINALITY AS item(value, ordinality)
  ),
  fragment_layers(ordinality, value, depth) AS (
    SELECT ordinality, value, 0 FROM fragment_seeds
    UNION ALL
    SELECT ordinality, (value #>> '{}')::jsonb, depth + 1
      FROM fragment_layers
     WHERE depth < 10
       AND jsonb_typeof(value) = 'string'
       AND (value #>> '{}') IS JSON
  ),
  fragments AS (
    SELECT DISTINCT ON (ordinality) ordinality, value
      FROM fragment_layers
     ORDER BY ordinality, depth DESC
  )
  SELECT COALESCE(
    jsonb_object_agg(entry.key, entry.value ORDER BY fragments.ordinality),
    '{}'::jsonb
  )
    FROM fragments
    CROSS JOIN LATERAL jsonb_each(
      CASE WHEN jsonb_typeof(fragments.value) = 'object'
           THEN fragments.value
           ELSE '{}'::jsonb
      END
    ) AS entry(key, value)
)`;

/** Paste-ready repair used by `gbrain doctor`. */
export const REPAIR_SOURCE_CONFIG_SQL =
  `UPDATE sources SET config = ${SOURCE_CONFIG_OBJECT_SQL} ` +
  `WHERE jsonb_typeof(config) <> 'object';`;
