/**
 * gbrain OAuth scope hierarchy + allowlist (v0.28).
 *
 * Single source of truth for the 5 scope strings. Used by:
 *  - src/commands/serve-http.ts (scopesSupported, request-time hasScope)
 *  - src/core/oauth-provider.ts (F3 refresh, token issuance, registration)
 *  - src/commands/auth.ts (CLI register-client validation)
 *  - admin/src/lib/scope-constants.ts (HAND-MAINTAINED MIRROR; CI drift check
 *    in scripts/check-admin-scope-drift.sh keeps them aligned)
 *
 * Hierarchy (see plan ASCII diagram):
 *
 *                    admin
 *                      │
 *      ┌──────────┬────┴────┬──────────┐
 *      ▼          ▼         ▼          ▼
 *   sources_admin  users_admin  write  read
 *                                │      ▲
 *                                └──────┘
 *
 * sources_admin and users_admin are siblings (different axes — sources-mgmt
 * vs user-account-mgmt — neither implies the other).
 */

export type Scope = 'read' | 'write' | 'admin' | 'sources_admin' | 'users_admin';

export const ALLOWED_SCOPES: ReadonlySet<Scope> = new Set<Scope>([
  'read',
  'write',
  'admin',
  'sources_admin',
  'users_admin',
]);

/**
 * Sorted list (deterministic for OAuth metadata + drift-check output).
 * Use this when emitting `scopes_supported` over the wire.
 */
export const ALLOWED_SCOPES_LIST: ReadonlyArray<Scope> = Object.freeze([
  'admin',
  'read',
  'sources_admin',
  'users_admin',
  'write',
]);

/**
 * Hierarchy table: which required scopes are implied by which granted scope.
 * `admin` implies all (escape hatch for legacy + super-admin tokens).
 * `write` implies `read`. The two `*_admin` siblings only imply themselves.
 */
const IMPLIES: Record<Scope, ReadonlySet<Scope>> = {
  admin: new Set(['admin', 'sources_admin', 'users_admin', 'write', 'read']),
  write: new Set(['write', 'read']),
  sources_admin: new Set(['sources_admin']),
  users_admin: new Set(['users_admin']),
  read: new Set(['read']),
};

/**
 * Does the granted scope set include something that satisfies `required`?
 * - admin in granted → true for any required
 * - write in granted → true for {write, read}
 * - sources_admin in granted → true for {sources_admin}
 * - users_admin in granted → true for {users_admin}
 * - read in granted → true for {read}
 *
 * Unknown scopes in `granted` are ignored (forward-compat — pre-allowlist
 * tokens with bogus scopes don't crash hasScope; they just don't satisfy).
 */
export function hasScope(grantedScopes: readonly string[], requiredScope: string): boolean {
  for (const granted of grantedScopes) {
    if (!isScope(granted)) continue;
    const implied = IMPLIES[granted];
    if (implied.has(requiredScope as Scope)) return true;
  }
  return false;
}

export function isScope(s: string): s is Scope {
  return ALLOWED_SCOPES.has(s as Scope);
}

/**
 * Validate that every scope in the input is allowed. Throws on the first
 * unknown scope. Used at OAuth client registration time (CLI, DCR, manual).
 */
export class InvalidScopeError extends Error {
  constructor(public readonly invalidScope: string, public readonly allScopes: readonly string[]) {
    super(
      `Unknown scope "${invalidScope}". Allowed: ${ALLOWED_SCOPES_LIST.join(', ')}.`,
    );
    this.name = 'InvalidScopeError';
  }
}

export function assertAllowedScopes(scopes: readonly string[]): void {
  for (const s of scopes) {
    if (!isScope(s)) throw new InvalidScopeError(s, scopes);
  }
}

/**
 * Parse a space-separated scope string (OAuth wire format) into an array,
 * dropping empty fragments. Does NOT validate against ALLOWED_SCOPES — call
 * assertAllowedScopes afterward at registration time.
 */
export function parseScopeString(s: string | undefined | null): string[] {
  if (!s) return [];
  return s.split(' ').filter(Boolean);
}
