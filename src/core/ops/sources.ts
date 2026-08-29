/**
 * whoami + sources-management operation cluster — pure move from
 * operations.ts (v0.46.x tranche 3). Op consts stay module-private;
 * `sourcesOperations` below lists them in EXACTLY the order they appear in
 * the canonical `operations` array in ../operations.ts. Never import from
 * '../operations.ts' here (cycle).
 */

import type { Operation } from './contract.ts';
import { OperationError } from './contract.ts';
import { sourceScopeOpts } from './context.ts';

// --- v0.28: whoami + sources management ---

const whoami: Operation = {
  name: 'whoami',
  description:
    'Introspect the calling identity. Returns one of three transport shapes: ' +
    '{transport: "oauth", client_id, client_name, scopes, expires_at, source_id, federated_read}, ' +
    '{transport: "legacy", token_name, scopes, expires_at: null}, or ' +
    '{transport: "local", scopes: []}, or {transport: "stdio", scopes: []} ' +
    'for the auth-less stdio MCP pipe. Throws unknown_transport when the ' +
    'context is ambiguous (remote=true without auth and no transport marker) ' +
    '— fail-closed posture mirroring the v0.26.9 trust-boundary contract.',
  params: {},
  scope: 'read',
  handler: async (ctx) => {
    // Trust boundary: ctx.remote === false is the trusted local CLI surface.
    // Returning OAuth-shaped scopes here would resurrect the v0.26.9 footgun
    // where code conditionally trusted on `scopes.includes('admin')` instead
    // of `ctx.remote === false`. Empty scopes array forces clients to
    // special-case `transport: 'local'` explicitly.
    if (ctx.remote === false) {
      return { transport: 'local', scopes: [] };
    }
    // #1061: stdio MCP is remote/untrusted by design but has no per-token
    // auth (local pipe) — a known transport, not a bug. Report it instead of
    // throwing. Empty scopes: nothing here may be used to gate anything.
    if (!ctx.auth && ctx.transport === 'stdio') {
      return { transport: 'stdio', scopes: [] };
    }
    if (!ctx.auth) {
      throw new OperationError(
        'unknown_transport',
        'whoami called over a remote transport that did not thread ctx.auth. ' +
          'This is a transport bug — every remote call site must populate ctx.auth ' +
          'or set ctx.remote === false.',
      );
    }
    // OAuth tokens have client_id starting with 'gbrain_cl_'; legacy
    // access_tokens reuse `name` as both clientId and clientName (verifyAccessToken
    // at oauth-provider.ts:417-430). Detect by inspecting the prefix.
    const isOauth = ctx.auth.clientId.startsWith('gbrain_cl_');
    if (isOauth) {
      return {
        transport: 'oauth',
        client_id: ctx.auth.clientId,
        client_name: ctx.auth.clientName ?? ctx.auth.clientId,
        scopes: ctx.auth.scopes,
        expires_at: ctx.auth.expiresAt ?? null,
        // Read-only self-introspection of the token's source grants —
        // widens nothing; absent grants serialize fail-closed (null / []).
        source_id: ctx.auth.sourceId ?? null,
        federated_read: ctx.auth.allowedSources ?? [],
      };
    }
    return {
      transport: 'legacy',
      token_name: ctx.auth.clientName ?? ctx.auth.clientId,
      scopes: ctx.auth.scopes,
      expires_at: null,
    };
  },
  cliHints: { name: 'whoami' },
};

const sources_add: Operation = {
  name: 'sources_add',
  description:
    'Register a new source. Supports either --path (existing v0.17 behavior) ' +
    'or --url (v0.28 federated remote-clone path: parses the URL through the ' +
    'SSRF gate, clones into $GBRAIN_HOME/clones/<id>/ via temp-dir + rename ' +
    'atomicity, and stores remote_url in sources.config). Pre-flight collision ' +
    'check on id; rollback on either-side failure.',
  params: {
    id: {
      type: 'string',
      required: true,
      description: 'Source id ([a-z0-9-]{1,32}). Immutable citation key.',
    },
    name: { type: 'string', description: 'Display name (defaults to id).' },
    path: { type: 'string', description: 'Local path. Mutually optional with url.' },
    url: {
      type: 'string',
      description:
        'HTTPS git URL. Cloned into $GBRAIN_HOME/clones/<id>/. SSRF-guarded.',
    },
    federated: {
      type: 'boolean',
      description: 'true → cross-source default search. false → isolated.',
    },
    clone_dir: {
      type: 'string',
      description:
        'Override clone destination (only valid with url). Default: $GBRAIN_HOME/clones/<id>/.',
    },
  },
  mutating: true,
  scope: 'sources_admin',
  handler: async (ctx, p) => {
    const { addSource } = await import('../sources-ops.ts');

    // v0.28.1 codex finding (CRITICAL + HIGH): a `sources_admin` token over
    // HTTP MCP must not be able to plant content at arbitrary host paths.
    //
    // - `path` lets a remote caller register `/etc/` (or any host dir) as a
    //   "source"; later `gbrain sync --all` walks every sources.local_path,
    //   which exfiltrates host content into the brain.
    // - `clone_dir` lets a remote caller name the destination directly;
    //   addSource's renameSync places the cloned tree there with no
    //   confinement, AND validateRepoState's degraded-state recovery later
    //   does rm -rf on src.local_path, so the same primitive doubles as
    //   arbitrary-delete.
    //
    // Both fields are CLI-only (the operator runs `gbrain sources add --path
    // /home/me/notes`). For HTTP MCP, ignore overrides — clone_dir defaults
    // to $GBRAIN_HOME/clones/<id>/ and path is rejected. Local CLI callers
    // (ctx.remote === false, per F7b fail-closed contract) keep the override.
    const isLocal = ctx.remote === false;
    const remotePath = isLocal ? (p.path as string | undefined) ?? null : null;
    const remoteCloneDir = isLocal ? (p.clone_dir as string | undefined) : undefined;
    if (!isLocal && p.path !== undefined) {
      throw new OperationError(
        'invalid_params',
        'sources_add: path is not honored over MCP (security confinement). ' +
          'Register with --url instead, or run `gbrain sources add --path ...` on the host CLI.',
        'Use --url to register a remote source, or run the command locally with --path.',
      );
    }

    const row = await addSource(ctx.engine, {
      id: p.id as string,
      name: p.name as string | undefined,
      localPath: remotePath,
      remoteUrl: p.url as string | undefined,
      federated:
        p.federated === undefined ? null : (p.federated as boolean),
      cloneDir: remoteCloneDir,
    });
    return row;
  },
  cliHints: { name: 'sources_add', hidden: true },
};

const sources_list: Operation = {
  name: 'sources_list',
  description:
    'List registered sources with page counts and remote_url. v0.28 surfaces ' +
    'the new remote_url field so a remote MCP caller can confirm a source is ' +
    'managed by clone+pull rather than user-supplied path.',
  params: {
    include_archived: { type: 'boolean', description: 'Include soft-deleted sources.' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { listSources } = await import('../sources-ops.ts');
    // #4433: row-filter the listing to the caller's source scope — a client
    // whose scope excludes a source must not learn that source's id, name,
    // or page_count. Wave-L posture (maintainer decision, supersedes the
    // wave-g "scalar callers keep the full listing" carve-out): EVERY
    // untrusted caller (anything not strictly remote === false) is confined
    // through the canonical sourceScopeOpts ladder, matching the rest of
    // the read-op surface — federated grant > scalar bound source >
    // fail-closed '__all__' (the sentinel passes through as a literal that
    // matches no real source id, so it yields an empty listing rather than
    // the whole registry). Trusted local CLI keeps the full operator view.
    const scope = ctx.remote === false ? {} : sourceScopeOpts(ctx);
    const allowedSourceIds =
      scope.sourceIds ?? (scope.sourceId !== undefined ? [scope.sourceId] : undefined);
    return {
      sources: await listSources(ctx.engine, {
        includeArchived: (p.include_archived as boolean) === true,
        ...(allowedSourceIds !== undefined ? { allowedSourceIds } : {}),
      }),
    };
  },
  cliHints: { name: 'sources_list', hidden: true },
};

const sources_remove: Operation = {
  name: 'sources_remove',
  description:
    'Hard-remove a source (cascades pages/chunks/embeddings). Refuses to ' +
    'delete the auto-managed clone dir unless its resolved path is confined ' +
    'under $GBRAIN_HOME/clones/ (realpath+lstat — symlink-safe). For most ' +
    'workflows prefer sources_archive for the soft-delete path.',
  params: {
    id: { type: 'string', required: true, description: "Source id to remove, as listed by sources_list (e.g. 'wiki'). A source id, not a page slug." },
    confirm_destructive: {
      type: 'boolean',
      description:
        'Required when the source has data (pages, chunks). Without it the op refuses.',
    },
    dry_run: { type: 'boolean', description: 'Preview impact without side effects.' },
    keep_storage: {
      type: 'boolean',
      description: 'Skip clone-dir cleanup even when the source is auto-managed.',
    },
  },
  mutating: true,
  scope: 'sources_admin',
  handler: async (ctx, p) => {
    const { removeSource } = await import('../sources-ops.ts');
    return removeSource(ctx.engine, {
      id: p.id as string,
      confirmDestructive: (p.confirm_destructive as boolean) === true,
      dryRun: (p.dry_run as boolean) === true || ctx.dryRun,
      keepStorage: (p.keep_storage as boolean) === true,
    });
  },
  cliHints: { name: 'sources_remove', hidden: true },
};

const sources_status: Operation = {
  name: 'sources_status',
  description:
    'Per-source diagnostic. Returns clone_state ("healthy" | "missing" | ' +
    '"not-a-dir" | "no-git" | "url-drift" | "corrupted" | "not-applicable") ' +
    'so a remote MCP caller can diagnose whether the on-disk clone is ' +
    'syncable without SSH access to the brain host.',
  params: {
    id: { type: 'string', required: true, description: "Source id to diagnose, as listed by sources_list (e.g. 'wiki'). A source id, not a page slug." },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    // Source isolation, mirroring sources_list's #4433 wave-L posture
    // exactly (the maintainer decision that superseded the wave-g "scalar
    // callers keep the full listing" carve-out): EVERY untrusted caller
    // (anything not strictly remote === false) is confined through the
    // canonical sourceScopeOpts ladder — federated grant > scalar bound
    // source. Trusted local CLI keeps the full operator view. Out-of-scope
    // ids answer not_found, indistinguishable from a nonexistent source
    // (anti-enumeration), matching get_agent_job's shape.
    const scope = ctx.remote === false ? {} : sourceScopeOpts(ctx);
    const allowed = scope.sourceIds ?? (scope.sourceId !== undefined ? [scope.sourceId] : null);
    if (allowed && !allowed.includes(p.id as string)) {
      throw new OperationError('not_found', `Unknown source: ${p.id}`);
    }
    const { getSourceStatus } = await import('../sources-ops.ts');
    return getSourceStatus(ctx.engine, p.id as string);
  },
  cliHints: { name: 'sources_status', hidden: true },
};

export const sourcesOperations: Operation[] = [
  whoami, sources_add, sources_list, sources_remove, sources_status,
];
