/**
 * Schema-pack operation cluster — pure move from operations.ts (v0.46.x
 * tranche 3): the v0.40.6.0 Schema Cathedral v3 ops (7 read + 2 admin —
 * the admin pair is deliberately NOT localOnly per D2, so remote agents
 * (your OpenClaw, etc.) can author packs behind admin OAuth scope). Op
 * consts stay module-private; `schemaPacksOperations` below lists them in
 * EXACTLY the order they appear in the canonical `operations` array in
 * ../operations.ts. Never import from '../operations.ts' here (cycle).
 */

import type { Operation } from './contract.ts';
import { sourceScopeOpts } from './context.ts';

// ──────────────────────────────────────────────────────────────────────
// v0.40.6.0 Schema Cathedral v3 — 9 new MCP ops for the agent on-ramp.
//
// Read ops (scope: read; NOT localOnly) — any read-scope OAuth client.
// Write ops (scope: admin; NOT localOnly per D2) — admin-scope client
// (your OpenClaw and similar remote agents) can author schema packs
// remotely. Audit log captures actor=mcp:<clientId8> on every mutation
// (see src/core/schema-pack/mutate-audit.ts privacy posture per D20).
//
// Per-call schema_pack opt STAYS rejected for remote callers — that
// trust boundary is enforced by op-trust-gate.ts and is separate from
// the localOnly posture (R2 regression preserved).
// ──────────────────────────────────────────────────────────────────────

const get_active_schema_pack: Operation = {
  name: 'get_active_schema_pack',
  description: 'v0.40.6.0: cheap identity packet for the active schema pack. Returns {pack_name, version, sha8, page_types_count, link_types_count, primitive_summary, source_tier}. Useful for agents to know which pack they are operating against without paying full manifest load cost.',
  params: {},
  scope: 'read',
  handler: async (ctx) => {
    const { loadActivePack, resolveActivePackNameOnly } = await import('../schema-pack/load-active.ts');
    const { loadConfig } = await import('../config.ts');
    const cfg = loadConfig();
    const sourceOpts: Record<string, unknown> = {};
    if (ctx.sourceId) sourceOpts.sourceId = ctx.sourceId;
    // #3792: thread the DB-plane schema_pack (tier 4) so this identity
    // packet reports the SAME pack the engine actually queries with.
    let dbConfig: string | undefined;
    try {
      dbConfig = (await ctx.engine.getConfig('schema_pack')) ?? undefined;
    } catch { /* engine.config may not exist on very old brains */ }
    const resolution = resolveActivePackNameOnly({ cfg, remote: ctx.remote ?? true, dbConfig, ...sourceOpts });
    const pack = await loadActivePack({ cfg, remote: ctx.remote ?? true, dbConfig, ...sourceOpts });
    const primitiveSummary: Record<string, number> = {};
    for (const t of pack.manifest.page_types) {
      primitiveSummary[t.primitive] = (primitiveSummary[t.primitive] ?? 0) + 1;
    }
    return {
      pack_name: pack.manifest.name,
      version: pack.manifest.version,
      sha8: pack.manifest_sha8,
      identity: pack.identity,
      page_types_count: pack.manifest.page_types.length,
      link_types_count: pack.manifest.link_types.length,
      primitive_summary: primitiveSummary,
      source_tier: resolution.source,
    };
  },
};

const list_schema_packs: Operation = {
  name: 'list_schema_packs',
  description: 'v0.40.6.0: list installed schema packs (bundled + user-installed). Returns {bundled: string[], installed: string[]}. Read-only directory listing.',
  params: {},
  scope: 'read',
  handler: async (_ctx) => {
    const { existsSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { gbrainPath } = await import('../config.ts');
    const { BUNDLED_PACK_NAMES } = await import('../schema-pack/bundled.ts');
    const bundled = [...BUNDLED_PACK_NAMES];
    const installedDir = gbrainPath('schema-packs');
    const installed: string[] = [];
    if (existsSync(installedDir)) {
      for (const entry of readdirSync(installedDir)) {
        const candidates = ['pack.yaml', 'pack.yml', 'pack.json'];
        for (const c of candidates) {
          if (existsSync(join(installedDir, entry, c))) { installed.push(entry); break; }
        }
      }
    }
    return { bundled, installed };
  },
};

const schema_stats: Operation = {
  name: 'schema_stats',
  description: 'v0.40.6.0: per-type page counts + typed-coverage from the DB. Returns {schema_version:1, pack_identity, aggregate, per_source, dead_prefixes}. Multi-source aware via ctx.sourceId/allowedSources.',
  params: {},
  scope: 'read',
  handler: async (ctx) => {
    const { runStatsCore } = await import('../schema-pack/stats.ts');
    const scope = sourceScopeOpts(ctx);
    const opts: { sourceId?: string; sourceIds?: string[] } = {};
    if (scope.sourceIds && scope.sourceIds.length > 0) opts.sourceIds = scope.sourceIds;
    else if (scope.sourceId) opts.sourceId = scope.sourceId;
    return runStatsCore(ctx, opts);
  },
};

const schema_lint: Operation = {
  name: 'schema_lint',
  description: 'v0.40.6.0: lint the active (or named) schema pack. File-plane rules only over MCP — the with_db option is rejected for remote callers (DB-aware rules require local CLI). Returns {ok, errors, warnings} structured report.',
  params: {
    pack: { type: 'string', description: 'Pack name (default: active pack)' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { runAllLintRules } = await import('../schema-pack/lint-rules.ts');
    const { loadActivePack } = await import('../schema-pack/load-active.ts');
    const { loadConfig, gbrainPath } = await import('../config.ts');
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const cfg = loadConfig();
    let manifest;
    if (p.pack) {
      // Locate by name without trust-gating per-call schema_pack opt
      // (that's a separate axis — this is just file lookup).
      const packName = p.pack as string;
      const candidates = ['pack.yaml', 'pack.yml', 'pack.json'];
      let path: string | null = null;
      for (const c of candidates) {
        const candidate = join(gbrainPath('schema-packs', packName), c);
        if (existsSync(candidate)) { path = candidate; break; }
      }
      if (!path) return { error: 'pack_not_found', pack: packName };
      const { loadPackFromFile: loader } = await import('../schema-pack/loader.ts');
      manifest = loader(path);
    } else {
      const resolved = await loadActivePack({ cfg, remote: ctx.remote ?? true, sourceId: ctx.sourceId });
      manifest = resolved.manifest;
    }
    // File-plane only over MCP; the engine-aware --with-db opt-in is
    // CLI-only (Phase 5 wiring). MCP callers get the 9 file-plane rules.
    return await runAllLintRules(manifest);
  },
};

const schema_graph: Operation = {
  name: 'schema_graph',
  description: 'v0.40.6.0: schema pack graph as JSON edges. Returns {nodes: [{name, primitive}], edges: [{from, verb, to}]} derived from link_types inference + frontmatter_links.',
  params: {},
  scope: 'read',
  handler: async (ctx) => {
    const { loadActivePack } = await import('../schema-pack/load-active.ts');
    const { loadConfig } = await import('../config.ts');
    const cfg = loadConfig();
    const pack = await loadActivePack({ cfg, remote: ctx.remote ?? true, sourceId: ctx.sourceId });
    const nodes = pack.manifest.page_types.map((t) => ({ name: t.name, primitive: t.primitive }));
    const edges: Array<{ from: string; verb: string; to: string }> = [];
    for (const lt of pack.manifest.link_types) {
      if (lt.inference?.page_type) {
        edges.push({
          from: lt.inference.page_type,
          verb: lt.name,
          to: lt.inference.target_type ?? '*',
        });
      }
    }
    for (const fl of pack.manifest.frontmatter_links) {
      edges.push({ from: fl.page_type, verb: fl.link_type, to: '*' });
    }
    return { schema_version: 1, pack: pack.manifest.name, nodes, edges };
  },
};

const schema_explain_type: Operation = {
  name: 'schema_explain_type',
  description: 'v0.40.6.0: resolved settings for a single page_type in the active pack. Returns {pack, type, primitive, path_prefixes, aliases, extractable, expert_routing}.',
  params: {
    type: { type: 'string', required: true, description: 'Page type name to explain' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { loadActivePack } = await import('../schema-pack/load-active.ts');
    const { loadConfig } = await import('../config.ts');
    const cfg = loadConfig();
    const pack = await loadActivePack({ cfg, remote: ctx.remote ?? true, sourceId: ctx.sourceId });
    const found = pack.manifest.page_types.find((t) => t.name === p.type);
    if (!found) return { error: 'type_not_found', type: p.type as string, pack: pack.manifest.name };
    return { schema_version: 1, pack: pack.manifest.name, type: found };
  },
};

const schema_review_orphans: Operation = {
  name: 'schema_review_orphans',
  description: 'v0.40.6.0: list pages with no active-pack type match. Returns {orphan_count, orphans: [{slug, source_id}]}.',
  params: {
    limit: { type: 'number', description: 'Max orphans to return (default 100)' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const limit = Math.max(1, Math.min(10000, (p.limit as number) ?? 100));
    const scope = sourceScopeOpts(ctx);
    let where = `WHERE deleted_at IS NULL AND (type IS NULL OR type = '')`;
    const params: unknown[] = [];
    if (scope.sourceIds && scope.sourceIds.length > 0) {
      where += ` AND source_id = ANY($1::text[])`;
      params.push(scope.sourceIds);
    } else if (scope.sourceId) {
      where += ` AND source_id = $1`;
      params.push(scope.sourceId);
    }
    try {
      const rows = await ctx.engine.executeRaw<{ slug: string; source_id: string }>(
        `SELECT slug, COALESCE(source_id, 'default') AS source_id FROM pages ${where} ORDER BY source_id, slug LIMIT ${limit}`,
        params,
      );
      return {
        schema_version: 1,
        orphan_count: rows.length,
        orphans: rows.map((r) => ({ slug: r.slug, source_id: r.source_id })),
      };
    } catch {
      return { schema_version: 1, orphan_count: 0, orphans: [] };
    }
  },
};

const schema_apply_mutations: Operation = {
  name: 'schema_apply_mutations',
  description: 'v0.40.7.0: batched schema pack mutation. ATOMIC: every mutation is validated against an in-memory manifest first, and the pack file is written to disk at most once, after the FULL batch has proven valid — so a failure at any point leaves the pack file byte-identical to its pre-batch state (never a partial write). Audit log records one batch_id. Admin scope; NOT localOnly so remote agents (your OpenClaw, etc.) can author packs over normal MCP. Mutation shape per ApplyMutationsRequest type — supports add_type / remove_type / update_type / add_alias / remove_alias / add_prefix / remove_prefix / add_link_type / remove_link_type / set_extractable / set_expert_routing.',
  params: {
    pack: { type: 'string', required: true, description: 'Pack to mutate (must not be bundled)' },
    mutations: {
      type: 'array',
      required: true,
      description: 'Array of {op, ...args} mutation records to apply atomically',
      items: { type: 'object' },
    },
    force: { type: 'boolean', description: 'Steal stale per-pack lock' },
  },
  scope: 'admin',
  mutating: true,
  handler: async (ctx, p) => {
    const pack = p.pack as string;
    const mutations = p.mutations as Array<{ op: string; [k: string]: unknown }>;
    const force = p.force === true;
    if (!Array.isArray(mutations) || mutations.length === 0) {
      return { error: 'invalid_request', message: 'mutations must be a non-empty array' };
    }
    const batchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const actor = ctx.auth?.clientId ? `mcp:${ctx.auth.clientId.slice(0, 8)}` : 'cli';
    const sourceId = ctx.sourceId;  // codex C5: write-side scoping
    // `applyMutationsAtomic` (issue #2581) owns the lock + single read +
    // single write for the whole batch: every mutation is validated
    // in-memory first, and the pack file is written at most once, only
    // after the FULL batch checks out. That is what makes this actually
    // atomic (a failure at any index can never leave earlier mutations on
    // disk), vs. the old per-mutation-writes-as-it-goes shape.
    const { applyMutationsAtomic } = await import('../schema-pack/mutate.ts');
    try {
      const results = await applyMutationsAtomic(pack, mutations, {
        actor: actor as 'cli' | `mcp:${string}`,
        batchId,
        engine: ctx.engine,
        ...(sourceId ? { sourceId } : {}),
        ...(force ? { force: true } : {}),
      });
      return {
        schema_version: 1,
        pack,
        batch_id: batchId,
        mutations_applied: results.length,
        results,
      };
    } catch (e) {
      const code = (e as { code?: string }).code ?? 'UNKNOWN';
      const failedAtIndex = (e as { details?: { index?: number } }).details?.index;
      return {
        error: 'mutation_failed',
        code,
        message: (e as Error).message,
        batch_id: batchId,
        // Nothing was written to disk — applyMutationsAtomic only writes
        // once, after every mutation in the batch has validated cleanly.
        // (Pre-fix, this field was `partial_results` and listed mutations
        // that HAD already landed on disk, because the old implementation
        // wrote as it went — that shape is gone; a failed batch can no
        // longer imply partial application.)
        mutations_applied: 0,
        pack_unchanged: true,
        ...(failedAtIndex !== undefined ? { failed_at_index: failedAtIndex } : {}),
      };
    }
  },
};

const reload_schema_pack: Operation = {
  name: 'reload_schema_pack',
  description: 'v0.40.6.0: flush the in-process schema pack cache so the next loadActivePack re-reads from disk. Cascades through extends-chain (codex C6). Admin scope; NOT localOnly. Returns {invalidated: string[]}.',
  params: {
    pack: { type: 'string', description: 'Pack name to invalidate (omit to flush all)' },
  },
  scope: 'admin',
  mutating: false,  // no DB writes
  handler: async (_ctx, p) => {
    const { invalidatePackCache } = await import('../schema-pack/registry.ts');
    return invalidatePackCache(p.pack as string | undefined);
  },
};

export const schemaPacksOperations: Operation[] = [
  get_active_schema_pack, list_schema_packs,
  schema_stats, schema_lint, schema_graph, schema_explain_type,
  schema_review_orphans,
  schema_apply_mutations, reload_schema_pack,
];
