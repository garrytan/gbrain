import express, { type Express, type Request, type Response, type RequestHandler } from 'express';
import type { BrainEngine } from '../core/engine.ts';
import { sqlQueryForEngine } from '../core/sql-query.ts';
import { normalizeScopesInput } from '../core/scope.ts';
import { normalizeSourceInput, normalizeFederatedReadInput } from '../core/source-id.ts';
import { validateTokenEndpointAuthMethod, validateRedirectUri } from '../core/oauth-provider.ts';
import { registerScopedClient, preflightOauthClientColumns, TOKEN_TTL_MIN_SECONDS, TOKEN_TTL_MAX_SECONDS, type RegisteredClient } from './auth.ts';
import { registerClientNameLockKey } from './agent-register.ts';
import { retainCredentialDelivery } from '../core/harness/delivery.ts';
import { readClientGrant } from '../core/grants/service.ts';
import { buildClientSetup, clientMetadata } from '../core/harness/oauth-setup.ts';
import { harnessAdapter } from '../core/harness/registry.ts';
import { GrantError } from '../core/grants/model.ts';
import { parseAdminGrantRequest, previewNewAdminGrant, sendAdminMutationError, GRANT_TOKEN_IMPLICATIONS } from './serve-http-grants.ts';

export function mountAdminRegistration(app: Express, requireAdmin: RequestHandler, engine: BrainEngine, mcpResourceUrl: URL, issuerUrl: URL): void {
  const sql = sqlQueryForEngine(engine);
  // Register client from admin dashboard
  app.post('/admin/api/register-client', requireAdmin, express.json(), async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    // Set only once the client row has COMMITTED — the catch below folds it
    // into the error receipt so a post-commit failure never reads as
    // "nothing was created".
    let createdClientId: string | undefined;
    let mutationStarted = false;
    try {
      // v0.39.3.0 WARN-9 + CV12: accept BOTH `scopes` (admin SPA convention)
      // AND `scope` (OAuth wire-format convention, singular). The pre-fix
      // code destructured only `scopes` and used `scopes || 'read'` which:
      //   - Silently ignored `scope` requests (always defaulted to 'read')
      //   - Threw on array input because registerClientManual's parseScopeString
      //     calls .split(' ') which arrays don't have
      //   - Accepted `['read write']` (space-in-element bug shape codex flagged)
      //     and other malformed inputs
      // normalizeScopesInput handles all four valid shapes (string, string[],
      // missing, empty) and rejects the rest with a structured 400.
      const { name, source, federatedRead, tokenTtl, grantTypes, redirectUris, tokenEndpointAuthMethod } = req.body;
      let harness = 'generic';
      try {
        if (req.body.harness !== undefined && typeof req.body.harness !== 'string') throw new Error('harness must be a registered adapter ID');
        harness = harnessAdapter(req.body.harness ?? 'generic').id;
      } catch { throw new GrantError('invalid_grant', 'Unknown harness; list supported adapters with gbrain mcp adapters'); }
      const rawScopes = (req.body as Record<string, unknown>).scopes ?? (req.body as Record<string, unknown>).scope;
      if (typeof name !== 'string' || !name.trim()) { res.status(400).json({ error: 'Name required' }); return; }
      let scopeString: string;
      try {
        scopeString = normalizeScopesInput(rawScopes);
      } catch (e) {
        res.status(400).json({
          error: 'invalid_scopes',
          message: e instanceof Error ? e.message : String(e),
        });
        return;
      }
      const grants = grantTypes === undefined ? ['client_credentials'] : grantTypes;
      const uris = redirectUris === undefined ? [] : redirectUris;
      if (!Array.isArray(grants) || !grants.length || grants.some(g => !['client_credentials', 'authorization_code', 'refresh_token'].includes(g))
        || !Array.isArray(uris) || uris.some(u => typeof u !== 'string' || !u.trim())) {
        res.status(400).json({ error: 'invalid_client_metadata', message: 'grantTypes and redirectUris must contain supported non-empty strings' }); return;
      }
      if (grants.includes('authorization_code') && !uris.length) {
        res.status(400).json({ error: 'redirect_uri_required', message: 'Native OAuth requires the exact redirect URI supplied by the intended client' }); return;
      }
      try {
        for (const uri of uris) {
          validateRedirectUri(uri);
          const parsed = new URL(uri);
          if (parsed.hash || parsed.username || parsed.password) throw new Error('Redirect URIs must not contain fragments or user credentials');
        }
      } catch {
        res.status(400).json({ error: 'invalid_redirect_uri', message: 'Use an exact HTTPS, loopback HTTP, or native app callback URI without a fragment or user credentials' }); return;
      }
      // v0.41.3 (T1+T4): validate token_endpoint_auth_method via shared
      // ALLOWED_TOKEN_ENDPOINT_AUTH_METHODS before reaching the provider.
      // Pre-v0.41.3 this endpoint did INSERT (confidential) → UPDATE (NULL
      // out secret_hash) for the 'none' case, which left a confidential
      // row stranded if the UPDATE failed (codex F4). Atomic now: pass the
      // method to registerClientManual and let it INSERT the correct row
      // in a single statement.
      let validatedAuthMethod: string | undefined;
      try {
        validatedAuthMethod = validateTokenEndpointAuthMethod(tokenEndpointAuthMethod);
      } catch (e) {
        res.status(400).json({
          error: 'invalid_token_endpoint_auth_method',
          message: e instanceof Error ? e.message : String(e),
        });
        return;
      }
      if (validatedAuthMethod === 'none' && grants.includes('client_credentials')) {
        res.status(400).json({ error: 'invalid_client_metadata', message: 'Machine credentials require a confidential client; public clients use authorization_code with PKCE' }); return;
      }
      if (grants.includes('refresh_token') && !grants.includes('authorization_code')) {
        res.status(400).json({ error: 'invalid_client_metadata', message: 'Refresh grants require authorization_code' }); return;
      }
      // v0.41.x: honor optional `source` (write source_id) and `federatedRead`
      // (read source set) from the request body, mirroring the CLI's
      // `--source` / `--federated-read` flags. Omitting both preserves the
      // historical behavior (source_id='default', federated_read=[source_id]).
      // Pre-fix this endpoint hardcoded 'default'/undefined, so an admin SPA or
      // a proxy could never mint a client bound to a non-default brain source
      // over HTTP — only the CLI could. Validated here for a structured 400.
      let sourceId: string;
      let federatedReadIds: string[] | undefined;
      try {
        if (req.body.sourceId !== undefined && source !== undefined && req.body.sourceId !== source) throw new Error('source and sourceId must agree when both are provided');
        sourceId = normalizeSourceInput(req.body.sourceId ?? source);
        federatedReadIds = normalizeFederatedReadInput(federatedRead);
      } catch (e) {
        res.status(400).json({
          error: 'invalid_source',
          message: e instanceof Error ? e.message : String(e),
        });
        return;
      }
      // cathedral-6: a WELL-FORMED but nonexistent source used to surface as
      // a 500 (the source_id FK fires inside the INSERT). Check existence +
      // archived up front for a structured 400 — same contract as the
      // malformed case, mirroring the CLI lane. ONE batched query on the
      // engine lane (SqlQuery forbids arrays; engine is in scope).
      {
        const idsToCheck = [...new Set([sourceId, ...(federatedReadIds ?? [])])];
        const found = await engine.executeRaw<{ id: string; archived: boolean | null }>(
          `SELECT id, archived FROM sources WHERE id = ANY($1::text[])`,
          [idsToCheck],
        );
        const byId = new Map(found.map(r => [r.id, r]));
        for (const id of idsToCheck) {
          const row = byId.get(id);
          if (!row) {
            res.status(400).json({
              error: 'unknown_source',
              message: `source "${id}" does not exist — create it first (gbrain sources add ${id})`,
            });
            return;
          }
          if (row.archived) {
            res.status(400).json({
              error: 'archived_source',
              message: `source "${id}" is archived — unarchive it or drop it from the grant`,
            });
            return;
          }
        }
      }
      // cathedral-6: validate tokenTtl BEFORE the transaction. The old
      // `Number(tokenTtl) > 0` passed Infinity/floats through to fail the
      // integer UPDATE inside the tx (rollback → opaque 500). Falsy values
      // (omitted / null / 0 / '') keep the historical "no TTL requested"
      // meaning; anything else must be an integer inside the shared bounds.
      let ttlNum: number | undefined;
      if (tokenTtl) {
        const v = Number(tokenTtl);
        if (!Number.isInteger(v) || v < TOKEN_TTL_MIN_SECONDS || v > TOKEN_TTL_MAX_SECONDS) {
          res.status(400).json({
            error: 'invalid_token_ttl',
            message: `tokenTtl must be an integer number of seconds between ${TOKEN_TTL_MIN_SECONDS} and ${TOKEN_TTL_MAX_SECONDS} (90 days); got ${JSON.stringify(tokenTtl)}. Omit the field (or pass 0/null) to keep the server default.`,
          });
          return;
        }
        ttlNum = v;
      }
      // Profile resolution and all advanced bindings use the same canonical
      // validation as CLI registration. Preview performs no credential writes.
      const grantRequest = parseAdminGrantRequest(req.body);
      const preview = await previewNewAdminGrant(engine, name, grantRequest.patch, { sourceId, federatedRead: federatedReadIds, scopes: scopeString });
      if (grantRequest.dryRun) {
        const existing = await sql`SELECT client_id FROM oauth_clients WHERE client_name = ${name} AND deleted_at IS NULL`;
        if (existing.length) { res.status(409).json({ error: 'duplicate_name', client_id: existing[0].client_id }); return; }
        res.json({ before: null, after: preview, grant: preview, revision: 0, dryRun: true, dry_run: true,
          grantTypes: grants, redirectUris: uris, harness, tokenEndpointAuthMethod: validatedAuthMethod, tokenImplications: GRANT_TOKEN_IMPLICATIONS });
        return;
      }
      // Column pre-flight OUTSIDE the tx (25P02 — nothing inside may degrade):
      // pre-v61 brains lack the scoped-client columns and registerClientManual's
      // internal 42703 retry ladder would abort the transaction, so refuse up
      // front with the CLI lane's brain_too_old contract. Passing {columns}
      // through also makes the ttl write SKIP (rather than throw) on brains
      // without token_ttl.
      const columns = await preflightOauthClientColumns(sql);
      if (!columns.has('source_id') || !columns.has('federated_read')) {
        res.status(400).json({
          error: 'brain_too_old',
          message: 'this brain predates scoped OAuth clients (source_id/federated_read columns) — run `gbrain apply-migrations --yes` first.',
        });
        return;
      }
      // Duplicate-name parity with the CLI lane: a second client under the
      // same name is a 409, never a silent second row. The dup-check and the
      // INSERT run in ONE transaction under the SAME name-scoped advisory
      // lock the CLI takes — two concurrent same-name requests serialize, and
      // the loser sees the winner's committed row (as two separate autocommit
      // statements, both used to pass the pre-check). deleted_at tolerance is
      // preflight-decided (no in-tx 42703 retry).
      let dupClientId: string | null = null;
      let registered: RegisteredClient | undefined;
      mutationStarted = true;
      await engine.transaction(async (tx) => {
        await tx.executeRaw(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [registerClientNameLockKey(name)]);
        const txSql = sqlQueryForEngine(tx);
        const dupRows = columns.has('deleted_at')
          ? await txSql`SELECT client_id FROM oauth_clients WHERE client_name = ${name} AND deleted_at IS NULL`
          : await txSql`SELECT client_id FROM oauth_clients WHERE client_name = ${name}`;
        if (dupRows.length > 0) {
          dupClientId = String(dupRows[0].client_id);
          return;
        }
        // Compose the SAME core the CLI uses (registerScopedClient) instead of
        // open-coding registerClientManual + a raw TTL UPDATE — the two paths
        // had already drifted once (this route hardcoded 'default' pre-v0.41).
        registered = await registerScopedClient(txSql, name, {
          grantTypes: grants,
          scopes: preview.scopes.join(' '),
          sourceId: preview.sourceId!,
          federatedRead: preview.federatedRead,
          redirectUris: uris,
          tokenEndpointAuthMethod: validatedAuthMethod,
          boundTools: undefined,
          boundSourceId: undefined,
          boundBrainId: undefined,
          boundSlugPrefixes: undefined,
          boundMaxConcurrent: undefined,
          budgetUsdPerDay: undefined,
          tokenTtlSeconds: undefined,
        }, { tokenTtlSeconds: preview.tokenTtlSeconds ?? ttlNum, columns, grant: grantRequest.patch });
        if (registered.clientSecret) {
          // Preserve delivery before COMMIT so a lost browser response is
          // recoverable without rotating or duplicating the registered client.
          retainCredentialDelivery({ version: 1, mcp_url: mcpResourceUrl.toString(), issuer_url: issuerUrl.origin,
            client_id: registered.clientId, client_secret: registered.clientSecret,
            profile: preview.profile ?? undefined, source_id: preview.sourceId ?? undefined });
        }
      });
      if (dupClientId !== null) {
        res.status(409).json({
          error: 'duplicate_name',
          client_id: dupClientId,
        });
        return;
      }
      // Post-commit: the row exists from here on — any later failure must
      // name the created client (no false "nothing was created").
      const reg = registered!;
      createdClientId = reg.clientId;
      const grant = await readClientGrant(engine, reg.clientId);
      const oauthSetup = grants.includes('authorization_code') && !grants.includes('client_credentials')
        ? buildClientSetup(clientMetadata({ client_id: reg.clientId, client_name: name, redirect_uris: uris,
          grant_types: grants, token_endpoint_auth_method: reg.authMethod }), mcpResourceUrl.toString(), grant.scopes, harness, 'authorization-code') : undefined;
      if (oauthSetup && reg.clientSecret) oauthSetup.client.client_secret = reg.clientSecret;
      res.json({
        clientId: reg.clientId,
        ...(reg.clientSecret !== undefined ? { clientSecret: reg.clientSecret } : {}),
        tokenTtl: reg.tokenTtl ?? null,
        grant, ...(oauthSetup ? { oauthSetup } : {}), status: 'registered',
        next_action: 'Obtain setup instructions and complete a connection in the intended harness.',
      });
    } catch (e) {
      // A lost COMMIT acknowledgement may leave a registration even when the
      // transaction promise rejects. Never expose raw database/transport errors.
      sendAdminMutationError(res, e, { stage: 'register', mutationStarted, clientId: createdClientId });
    }
  });

}
