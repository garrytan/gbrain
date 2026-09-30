import type { Migration } from './types.ts';

export const v046: Migration = {
  version: 46,
  name: 'mcp_request_log_params_jsonb_normalize',
  idempotent: true,
  // v0.31.3 wave (D-codex-2 / D1): mcp_request_log.params is JSONB, but
  // pre-v0.31.3 serve-http.ts wrote `JSON.stringify(...)` strings into it
  // via the postgres.js template tag's loose typing. The column was
  // technically JSONB but stored as a JSON-encoded string, so reads via
  // `params->>'op'` returned the encoded string '"search"' instead of
  // 'search'. The /admin/api/requests endpoint returned both shapes raw
  // to the SPA depending on row age.
  //
  // The v0.31.3 commit re-routes those INSERTs through executeRawJsonb,
  // which writes real objects. This one-shot UPDATE lifts existing
  // string-shaped rows up to objects so the read side sees one
  // consistent shape. Idempotent: subsequent runs find no rows where
  // jsonb_typeof = 'string' and the UPDATE is a no-op.
  //
  // `params #>> '{}'` extracts the underlying string at the top level,
  // then ::jsonb re-parses it as JSON. The `WHERE` filter guards against
  // running on already-object rows AND limits the unwrap to strings that
  // start with `{` (object-shaped) so a malformed legacy string can't
  // abort the migration.
  sql: `
      UPDATE mcp_request_log
        SET params = (params #>> '{}')::jsonb
        WHERE jsonb_typeof(params) = 'string'
          AND params #>> '{}' LIKE '{%';
    `,
};
