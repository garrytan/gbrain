export const VALID_SCOPES = [
  'pages:read',
  'pages:write',
  'chunks:read',
  'chunks:write',
  'log:write',
  'admin',
] as const;

export type Scope = typeof VALID_SCOPES[number];

const VALID_SCOPE_SET = new Set<string>(VALID_SCOPES);

const LEGACY_SCOPE_EXPANSIONS: Record<string, Scope[]> = {
  read: ['pages:read', 'chunks:read', 'log:write'],
  write: ['pages:read', 'pages:write', 'chunks:read', 'chunks:write', 'log:write'],
  admin: ['admin'],
};

export const PHASE_4B_TOKEN_PRESETS: Record<string, Scope[]> = {
  'agent-cto-ryde': ['pages:read', 'chunks:read', 'log:write'],
  'agent-backend-ryde': ['pages:read', 'pages:write', 'chunks:read', 'chunks:write', 'log:write'],
  'agent-frontend-ryde': ['pages:read', 'chunks:read', 'log:write'],
  'agent-ios-ryde': ['pages:read', 'chunks:read', 'log:write'],
  'agent-head-of-product-ryde': ['pages:read', 'pages:write', 'chunks:read', 'log:write'],
  'orchestrator-ryde': ['pages:read', 'pages:write', 'chunks:read', 'chunks:write', 'log:write', 'admin'],
  'orchestrator': ['pages:read', 'pages:write', 'chunks:read', 'chunks:write', 'log:write', 'admin'],
};

export const OPERATION_REQUIRED_SCOPES: Record<string, Scope[]> = {
  get_page: ['pages:read'],
  put_page: ['pages:write', 'chunks:write'],
  delete_page: ['pages:write', 'chunks:write'],
  list_pages: ['pages:read'],
  restore_page: ['pages:write', 'chunks:write'],
  purge_deleted_pages: ['admin'],

  search: ['pages:read', 'chunks:read'],
  query: ['pages:read', 'chunks:read'],

  add_tag: ['pages:write'],
  remove_tag: ['pages:write'],
  get_tags: ['pages:read'],

  add_link: ['pages:write'],
  remove_link: ['pages:write'],
  get_links: ['pages:read'],
  get_backlinks: ['pages:read'],
  traverse_graph: ['pages:read'],

  add_timeline_entry: ['pages:write'],
  get_timeline: ['pages:read'],

  get_stats: ['admin'],
  get_health: ['admin'],
  get_versions: ['pages:read'],
  revert_version: ['pages:write', 'chunks:write'],

  sync_brain: ['pages:write', 'chunks:write'],

  put_raw_data: ['pages:write'],
  get_raw_data: ['pages:read'],

  resolve_slugs: ['pages:read'],
  get_chunks: ['chunks:read'],

  log_ingest: ['pages:write', 'log:write'],
  get_ingest_log: ['admin'],

  file_list: ['pages:read'],
  file_upload: ['pages:write'],
  file_url: ['pages:read'],

  submit_job: ['admin'],
  get_job: ['admin'],
  list_jobs: ['admin'],
  cancel_job: ['admin'],
  retry_job: ['admin'],
  get_job_progress: ['admin'],
  pause_job: ['admin'],
  resume_job: ['admin'],
  replay_job: ['admin'],
  send_job_message: ['admin'],

  find_orphans: ['pages:read'],
};

export function normalizeTokenScopes(scopes: readonly string[] | string | null | undefined): Scope[] {
  const raw = Array.isArray(scopes)
    ? scopes
    : typeof scopes === 'string'
      ? scopes.split(/[\s,]+/)
      : [];
  const expanded = new Set<Scope>();
  for (const scope of raw.map(s => s.trim()).filter(Boolean)) {
    if (LEGACY_SCOPE_EXPANSIONS[scope]) {
      for (const expandedScope of LEGACY_SCOPE_EXPANSIONS[scope]) expanded.add(expandedScope);
    } else if (VALID_SCOPE_SET.has(scope)) {
      expanded.add(scope as Scope);
    }
  }
  return VALID_SCOPES.filter(scope => expanded.has(scope));
}

export function validateScopes(scopes: readonly string[]): Scope[] {
  const unknown = scopes.filter(scope => !VALID_SCOPE_SET.has(scope));
  if (unknown.length > 0) {
    throw new Error(`Unknown scope(s): ${unknown.join(', ')}. Valid scopes: ${VALID_SCOPES.join(', ')}`);
  }
  return VALID_SCOPES.filter(scope => scopes.includes(scope));
}

export function requiredScopesForOperation(operationName: string): Scope[] {
  const scopes = OPERATION_REQUIRED_SCOPES[operationName];
  if (!scopes) throw new Error(`No requiredScopes registered for operation: ${operationName}`);
  return scopes;
}

export function authorizeScopes(
  tokenScopes: readonly string[] | string | null | undefined,
  requiredScopes: readonly string[] | null | undefined,
): { ok: true } | { ok: false; missingScopes: Scope[] } {
  const normalized = normalizeTokenScopes(tokenScopes);
  const granted = new Set(normalized);
  const missing = (requiredScopes || []).filter(scope => !granted.has(scope as Scope)) as Scope[];
  return missing.length === 0 ? { ok: true } : { ok: false, missingScopes: missing };
}

export function operationLogName(method?: string, toolName?: string): string {
  if (method === 'tools/call' && toolName) return toolName;
  return method || 'unknown';
}
