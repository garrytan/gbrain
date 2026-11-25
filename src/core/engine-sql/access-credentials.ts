

/** The other credential statements, each its caller's text byte for byte. */
export const CREDENTIAL_SQL = {
  token_list: `
      SELECT * FROM access_tokens
      ORDER BY created_at DESC
    `,
  token_private_pages: 'SELECT private_pages FROM access_tokens WHERE id = $1::uuid AND revoked_at IS NULL',
  token_permissions: 'SELECT permissions FROM access_tokens WHERE id = $1::uuid AND revoked_at IS NULL',
  token_live: 'SELECT 1 FROM access_tokens WHERE id::text = $1 AND revoked_at IS NULL',
  client_live: 'SELECT 1 FROM oauth_clients WHERE client_id = $1 AND deleted_at IS NULL',
  client_columns_preflight: `
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'oauth_clients'
      AND table_schema = current_schema()
      AND column_name IN ('token_ttl', 'surface', 'federated_read', 'source_id', 'deleted_at')
  `,
  client_columns_grant: `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'oauth_clients'
        AND column_name IN ('grant_revision', 'allowed_operations', 'delegated_slug_prefixes', 'delegated_namespace', 'grant_profile', 'grant_repair_reasons', 'surface', 'surface_set_by', 'token_ttl', 'source_id', 'federated_read', 'bound_slug_prefixes', 'bound_tools', 'bound_source_id', 'bound_brain_id', 'bound_max_concurrent', 'budget_usd_per_day')`,
  client_token_ttl: `
        UPDATE oauth_clients SET token_ttl = $1
        WHERE client_id = $2
        RETURNING client_id
      `,
  client_grant_insert: `
    WITH created AS (
      INSERT INTO oauth_clients (client_id, client_name, client_secret_hash, redirect_uris, grant_types,
        token_endpoint_auth_method, client_id_issued_at, scope, source_id, federated_read,
        bound_slug_prefixes, allowed_operations, bound_tools, bound_source_id, bound_brain_id,
        delegated_slug_prefixes, delegated_namespace, bound_max_concurrent, budget_usd_per_day,
        surface, surface_set_by, token_ttl, grant_profile, grant_revision, grant_repair_reasons)
      VALUES ($1, $2, $3,
        ARRAY(SELECT jsonb_array_elements_text($4::text::jsonb)),
        ARRAY(SELECT jsonb_array_elements_text($5::text::jsonb)),
        $6, $7, $8, $9,
        ARRAY(SELECT jsonb_array_elements_text($10::text::jsonb)),
        CASE WHEN $11 THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text($12::text::jsonb)) END,
        CASE WHEN $13 THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text($14::text::jsonb)) END,
        CASE WHEN $15 THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text($16::text::jsonb)) END,
        $17, $18,
        CASE WHEN $19 THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text($20::text::jsonb)) END,
        $21, $22, $23, $24, $25,
        $26, $27, $28,
        ARRAY(SELECT jsonb_array_elements_text($29::text::jsonb)))
      RETURNING client_id
    ) INSERT INTO oauth_grant_audit (client_id, actor, action, revision, before_grant, after_grant)
      SELECT client_id, $30, 'register', $31, NULL, $32::text::jsonb FROM created
  `,
  clamped_clients: `SELECT DISTINCT client_id FROM oauth_grant_audit WHERE actor = 'migration' AND action IN ('clamp_token_ttl', 'shorten_access_tokens')`,
  // The order never reaches output: it fixes the lock order, plain id like lockAllSourceRows, so every locker of these rows takes them the same way.
  scope_sources_update: 'SELECT id, config FROM sources WHERE id IN (SELECT jsonb_array_elements_text($1::text::jsonb)) ORDER BY id FOR UPDATE',
  // The order never reaches output: it fixes the lock order (plain id, as in scope_sources_update), not a listing.
  scope_sources_share: 'SELECT id, config FROM sources WHERE id IN (SELECT jsonb_array_elements_text($1::text::jsonb)) ORDER BY id FOR SHARE',
  scope_sources: 'SELECT id, config FROM sources WHERE id IN (SELECT jsonb_array_elements_text($1::text::jsonb))',
} as const;
