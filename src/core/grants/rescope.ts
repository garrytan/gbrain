import type { SqlQuery } from '../sql-query.ts';
import { assertValidSourceId } from '../source-id.ts';
import { isUndefinedColumnError } from '../utils.ts';
import { assertValidSlugPrefixes, pgArray } from './encoding.ts';
import { rescopeClientGrantInTransaction } from './service.ts';
import type { GrantPatch, GrantProfileId } from './model.ts';

export interface RescopeClientOptions {
  sourceId?: string;
  federatedRead?: string[];
  boundSlugPrefixes?: string[] | null;
  /**
   * WP4 (D2/amendment 19): per-client tool surface. Tri-state —
   * undefined = untouched, null = clear (both surface AND
   * surface_set_by go NULL), value = set + surface_set_by='operator'
   * (the operator lock: request_tools persist cannot override it).
   */
  surface?: 'verbs' | 'starter' | 'full' | null;
  scopes?: string[];
  allowedOperations?: string[] | null;
  boundTools?: string[] | null;
  boundSourceId?: string | null;
  boundBrainId?: string | null;
  delegatedSlugPrefixes?: string[] | null;
  delegatedNamespace?: 'prefixes' | 'job';
  boundMaxConcurrent?: number;
  budgetUsdPerDay?: string | null;
  tokenTtlSeconds?: number | null;
  profile?: GrantProfileId | null;
  expectedRevision?: number;
  actor?: string;
  repair?: boolean;
  dryRun?: boolean;
}
export type RescopeClientResult = { clientId: string; clientName: string; sourceId: string; federatedRead: string[]; boundSlugPrefixes?: string[] | null; surface?: string | null; surfaceOld?: string | null };

export async function rescopeOAuthClient(sql: SqlQuery, clientId: string, opts: RescopeClientOptions): Promise<RescopeClientResult> {
    const { sourceId, federatedRead, boundSlugPrefixes, surface } = opts;
    if (sourceId === undefined && federatedRead === undefined && boundSlugPrefixes === undefined && surface === undefined && !Object.entries(opts).some(([key, value]) => !['actor', 'expectedRevision', 'dryRun', 'repair'].includes(key) && value !== undefined)) {
      throw new Error('rescope-client requires --source, --federated-read, --bound-slug-prefixes, and/or --surface');
    }
    if (sourceId !== undefined) assertValidSourceId(sourceId);
    if (federatedRead !== undefined) {
      if (federatedRead.length === 0) {
        throw new Error('--federated-read cannot be empty (pass at least one source id)');
      }
      for (const s of federatedRead) assertValidSourceId(s);
    }
    // WP4: only the three known surfaces are OPERATOR-writable here; the
    // column value space stays open (amendment 18) for future tier writers,
    // but this surface validates so a typo'd rescope fails loud, not silent.
    if (surface !== undefined && surface !== null
        && surface !== 'verbs' && surface !== 'starter' && surface !== 'full') {
      throw new Error(`--surface must be verbs | starter | full | clear (got "${String(surface)}")`);
    }
    // v0.42.72.0: bound_slug_prefixes rescope, so channel-membership churn
    // (the qm-harness roster case) updates the write fence in place instead
    // of forcing a register+rotate cycle. Tri-state: undefined = untouched,
    // null = clear the binding (client returns to unbound full-source write
    // authority), non-empty array = replace. Empty array is rejected here —
    // it means deny-all at the fence, which an operator should express by
    // revoking write scope, not by an ambiguous empty list.
    if (Array.isArray(boundSlugPrefixes)) {
      if (boundSlugPrefixes.length === 0) {
        throw new Error('--bound-slug-prefixes cannot be an empty list (pass prefixes, or "none" to clear the binding)');
      }
      assertValidSlugPrefixes(boundSlugPrefixes);
    }
    const schema = await sql`SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'oauth_clients'
        AND column_name IN ('grant_revision', 'allowed_operations', 'delegated_slug_prefixes', 'delegated_namespace', 'grant_profile', 'grant_repair_reasons', 'surface', 'surface_set_by', 'token_ttl', 'source_id', 'federated_read', 'bound_slug_prefixes', 'bound_tools', 'bound_source_id', 'bound_brain_id', 'bound_max_concurrent', 'budget_usd_per_day')`;
    if (schema.length === 17) {
      const { expectedRevision, actor, repair, dryRun, ...patch } = opts;
      if (surface !== undefined) (patch as GrantPatch).surfaceSetBy = surface === null ? null : 'operator';
      if (sourceId !== undefined) {
        const found = await sql`SELECT id FROM sources WHERE id = ${sourceId}`;
        if (!found.length) throw new Error(`Source "${sourceId}" does not exist. Create it first: gbrain sources add ${sourceId} ...`);
      }
      const result = await rescopeClientGrantInTransaction(sql, clientId, patch, { expectedRevision, actor: actor ?? 'operator', repair, dryRun });
      return { clientId, clientName: result.after.clientName, sourceId: result.after.sourceId ?? '',
        federatedRead: result.after.federatedRead,
        ...(boundSlugPrefixes !== undefined ? { boundSlugPrefixes: result.after.boundSlugPrefixes } : {}),
        ...(surface !== undefined ? { surface: result.after.surface, surfaceOld: result.before.surface } : {}) };
    }
    if (Object.entries(opts).some(([key, value]) => !['sourceId', 'federatedRead', 'boundSlugPrefixes', 'surface'].includes(key) && value !== undefined)) {
      throw new Error('Client grant changes require an up-to-date OAuth schema; run gbrain apply-migrations --yes');
    }
    let rows: Record<string, unknown>[];
    // WP4: when the surface axis is being touched, capture the OLD value
    // first so callers can write the amendment-32 audit row ({old, new}).
    let surfaceOld: string | null | undefined;
    try {
      if (surface !== undefined) {
        const prior = await sql`
          SELECT surface FROM oauth_clients WHERE client_id = ${clientId}
        `;
        surfaceOld = prior.length > 0 ? ((prior[0].surface as string | null) ?? null) : null;
      }
      // Only touch bound_slug_prefixes / surface when the caller actually
      // passed them. Naming a column unconditionally would make a plain
      // `rescope-client --source wiki` fail on a brain that has the v60/v61
      // OAuth columns but not v85's bound_* set (or v127's surface set) — a
      // regression on an axis the caller never asked about.
      const surfaceSetBy = surface === null ? null : 'operator';
      if (boundSlugPrefixes === undefined && surface === undefined) {
        rows = await sql`
            UPDATE oauth_clients
               SET source_id = COALESCE(${sourceId ?? null}::text, source_id),
                   federated_read = COALESCE(${federatedRead ? pgArray(federatedRead) : null}::text[], federated_read)
             WHERE client_id = ${clientId}
             RETURNING client_id, client_name, source_id, federated_read
          `;
      } else if (boundSlugPrefixes === undefined) {
        rows = await sql`
            UPDATE oauth_clients
               SET source_id = COALESCE(${sourceId ?? null}::text, source_id),
                   federated_read = COALESCE(${federatedRead ? pgArray(federatedRead) : null}::text[], federated_read),
                   surface = ${surface ?? null}::text,
                   surface_set_by = ${surfaceSetBy}::text
             WHERE client_id = ${clientId}
             RETURNING client_id, client_name, source_id, federated_read, surface, surface_set_by
          `;
      } else if (surface === undefined) {
        rows = await sql`
            UPDATE oauth_clients
               SET source_id = COALESCE(${sourceId ?? null}::text, source_id),
                   federated_read = COALESCE(${federatedRead ? pgArray(federatedRead) : null}::text[], federated_read),
                   bound_slug_prefixes = ${boundSlugPrefixes ? pgArray(boundSlugPrefixes) : null}::text[]
             WHERE client_id = ${clientId}
             RETURNING client_id, client_name, source_id, federated_read, bound_slug_prefixes
          `;
      } else {
        rows = await sql`
            UPDATE oauth_clients
               SET source_id = COALESCE(${sourceId ?? null}::text, source_id),
                   federated_read = COALESCE(${federatedRead ? pgArray(federatedRead) : null}::text[], federated_read),
                   bound_slug_prefixes = ${boundSlugPrefixes ? pgArray(boundSlugPrefixes) : null}::text[],
                   surface = ${surface ?? null}::text,
                   surface_set_by = ${surfaceSetBy}::text
             WHERE client_id = ${clientId}
             RETURNING client_id, client_name, source_id, federated_read, bound_slug_prefixes, surface, surface_set_by
          `;
      }
    } catch (err) {
      if (
        isUndefinedColumnError(err, 'source_id') ||
        isUndefinedColumnError(err, 'federated_read') ||
        isUndefinedColumnError(err, 'bound_slug_prefixes') ||
        isUndefinedColumnError(err, 'surface') ||
        isUndefinedColumnError(err, 'surface_set_by')
      ) {
        throw new Error('rescope-client requires an up-to-date OAuth schema; run `gbrain apply-migrations --yes` and retry.');
      }
      // FK oauth_clients.source_id → sources(id): translate the raw 23503
      // into an actionable message.
      if ((err as { code?: string })?.code === '23503') {
        throw new Error(`Source "${sourceId}" does not exist. Create it first: gbrain sources add ${sourceId} ...`);
      }
      throw err;
    }
    if (rows.length === 0) {
      throw new Error(`No OAuth client found with id "${clientId}"`);
    }
    const row = rows[0];
    return {
      clientId: row.client_id as string,
      clientName: (row.client_name as string | null) ?? '',
      sourceId: (row.source_id as string | null) ?? 'default',
      federatedRead: Array.isArray(row.federated_read) ? (row.federated_read as string[]) : [],
      // undefined = the column wasn't read this call (caller left the
      // binding untouched), which is distinct from null = no binding set.
      boundSlugPrefixes: 'bound_slug_prefixes' in row
        ? (Array.isArray(row.bound_slug_prefixes) ? (row.bound_slug_prefixes as string[]) : null)
        : undefined,
      // WP4: undefined = surface untouched this call; null = cleared.
      ...(surface !== undefined
        ? { surface: (row.surface as string | null) ?? null, surfaceOld: surfaceOld ?? null }
        : {}),
    };
}
