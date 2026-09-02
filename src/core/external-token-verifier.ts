/**
 * External-issuer JWT verification for the HTTP MCP surface.
 *
 * Lets an upstream gateway that signs MCP tool calls with short-lived JWTs
 * (e.g. LiteLLM's `mcp_jwt_signer` guardrail, which publishes its keys at
 * `<issuer>/.well-known/jwks.json`) act on behalf of registered GBrain
 * clients. The JWT proves WHO called through the gateway; a deploy-owned
 * caller map decides WHICH registered `oauth_clients` row that identity
 * maps to. GBrain's own source isolation (source_id / federated_read /
 * bound_slug_prefixes / surface) then applies exactly as it would for a
 * token the client obtained directly — no new authorization axis.
 *
 * Fail-closed by design:
 * - disabled unless issuer + audience + caller map are ALL configured;
 * - signature, `iss`, `aud`, `exp`/`nbf` verified (RS256 only);
 * - a verified JWT whose `sub`/`email` is not in the caller map is rejected;
 * - a mapped client_id that does not exist (or is deleted) is rejected.
 *
 * Configuration (environment):
 * - GBRAIN_EXTERNAL_TOKEN_ISSUER      required. Expected `iss` claim.
 * - GBRAIN_EXTERNAL_TOKEN_AUDIENCE    required. Expected `aud` claim.
 * - GBRAIN_EXTERNAL_TOKEN_CALLER_MAP  required. JSON object mapping a JWT
 *   `sub` (or `email`) value to a registered oauth_clients.client_id, e.g.
 *   `{"litellm-user-3f9":"acl-ruslan","hassan@example.com":"acl-hassan"}`.
 * - GBRAIN_EXTERNAL_TOKEN_JWKS_URI    optional. Defaults to
 *   `<issuer>/.well-known/jwks.json`.
 * - GBRAIN_EXTERNAL_TOKEN_JWKS        optional. Inline JWKS JSON (offline /
 *   air-gapped deploys and tests). Takes precedence over the URI.
 */

import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';

export type ExternalTokenVerifierConfig = {
  issuer: string;
  audience: string;
  /** sub-or-email -> registered oauth_clients.client_id */
  callerMap: Record<string, string>;
  jwksUri?: string;
  /** Inline key set; takes precedence over jwksUri. */
  jwks?: JSONWebKeySet;
};

export class ExternalTokenVerificationError extends Error {}

export class ExternalTokenVerifier {
  private readonly getKey: JWTVerifyGetKey;

  constructor(private readonly config: ExternalTokenVerifierConfig) {
    if (config.jwks) {
      this.getKey = createLocalJWKSet(config.jwks);
    } else {
      const uri =
        config.jwksUri ?? `${config.issuer.replace(/\/$/, '')}/.well-known/jwks.json`;
      // createRemoteJWKSet caches keys and refetches on unknown `kid`, so
      // gateway key rotation needs no restart here.
      this.getKey = createRemoteJWKSet(new URL(uri));
    }
  }

  /**
   * Verify a compact JWS and resolve it to a registered client_id.
   * `subject` is the caller-map key that matched (`sub`, or `email` when the
   * map matched on email) — the audit identity of the exact gateway key,
   * since several keys can map to one client_id.
   * Throws ExternalTokenVerificationError on any failure — callers must
   * treat that as an invalid token, never fall through to another auth path.
   */
  async verify(token: string): Promise<{ clientId: string; subject: string; payload: JWTPayload }> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.getKey, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: ['RS256'],
      }));
    } catch (err) {
      throw new ExternalTokenVerificationError(
        `external token rejected: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const sub = typeof payload.sub === 'string' ? payload.sub : undefined;
    const email = typeof payload.email === 'string' ? payload.email : undefined;
    const subject =
      sub !== undefined && this.config.callerMap[sub] !== undefined
        ? sub
        : email !== undefined && this.config.callerMap[email] !== undefined
          ? email
          : undefined;
    if (subject === undefined) {
      // Deliberately does not echo sub/email back to the caller.
      throw new ExternalTokenVerificationError('external token subject is not a mapped caller');
    }
    return { clientId: this.config.callerMap[subject], subject, payload };
  }
}

/** Opaque GBrain tokens never contain two dots; compact JWS always does. */
export function looksLikeCompactJws(token: string): boolean {
  return token.split('.').length === 3;
}

let cached: ExternalTokenVerifier | null | undefined;

/**
 * Build (once) the verifier from the environment, or null when not
 * configured. Partial configuration is a hard startup error rather than a
 * silently disabled verifier — a deploy that set the issuer but mangled the
 * map must not fall back to "external tokens are simply never accepted
 * locally but the operator believes they are".
 */
export function getExternalTokenVerifier(env: NodeJS.ProcessEnv = process.env): ExternalTokenVerifier | null {
  if (cached !== undefined) return cached;

  const issuer = env.GBRAIN_EXTERNAL_TOKEN_ISSUER?.trim();
  const audience = env.GBRAIN_EXTERNAL_TOKEN_AUDIENCE?.trim();
  const mapRaw = env.GBRAIN_EXTERNAL_TOKEN_CALLER_MAP?.trim();
  const jwksUri = env.GBRAIN_EXTERNAL_TOKEN_JWKS_URI?.trim();
  const jwksRaw = env.GBRAIN_EXTERNAL_TOKEN_JWKS?.trim();

  if (!issuer && !audience && !mapRaw) {
    cached = null;
    return cached;
  }
  if (!issuer || !audience || !mapRaw) {
    throw new Error(
      'External token verification is partially configured: GBRAIN_EXTERNAL_TOKEN_ISSUER, ' +
        'GBRAIN_EXTERNAL_TOKEN_AUDIENCE and GBRAIN_EXTERNAL_TOKEN_CALLER_MAP must all be set ' +
        '(or none of them).',
    );
  }

  let callerMap: Record<string, string>;
  try {
    const parsed: unknown = JSON.parse(mapRaw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not a JSON object');
    }
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v !== 'string' || v.trim() === '' || k.trim() === '') {
        throw new Error(`entry ${JSON.stringify(k)} must map to a non-empty client_id string`);
      }
    }
    callerMap = parsed as Record<string, string>;
  } catch (err) {
    throw new Error(
      `GBRAIN_EXTERNAL_TOKEN_CALLER_MAP is not a valid {subject: client_id} JSON object: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  let jwks: JSONWebKeySet | undefined;
  if (jwksRaw) {
    try {
      jwks = JSON.parse(jwksRaw) as JSONWebKeySet;
    } catch (err) {
      throw new Error(
        `GBRAIN_EXTERNAL_TOKEN_JWKS is not valid JWKS JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  cached = new ExternalTokenVerifier({ issuer, audience, callerMap, jwksUri, jwks });
  return cached;
}

/** Test hook: forget the env-derived singleton. */
export function resetExternalTokenVerifierCache(): void {
  cached = undefined;
}
