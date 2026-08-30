/**
 * gbrain OAuth scope hierarchy + allowlist (v0.28).
 *
 * Single source of truth for the OAuth scope strings. Used by:
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
 *   Exact opt-in siblings (not implied by admin): agent, readback, retract
 *
 * sources_admin and users_admin are siblings (different axes — sources-mgmt
 * vs user-account-mgmt — neither implies the other).
 */

export type Scope = 'read' | 'write' | 'admin' | 'sources_admin' | 'users_admin' | 'agent' | 'readback' | 'retract';

export const ALLOWED_SCOPES: ReadonlySet<Scope> = new Set<Scope>([
  'read',
  'write',
  'admin',
  'sources_admin',
  'users_admin',
  'agent',
  'readback',
  'retract',
]);

/**
 * Sorted list (deterministic for OAuth metadata + drift-check output).
 * Use this when emitting `scopes_supported` over the wire.
 */
export const ALLOWED_SCOPES_LIST: ReadonlyArray<Scope> = Object.freeze([
  'admin',
  'agent',
  'read',
  'readback',
  'retract',
  'sources_admin',
  'users_admin',
  'write',
]);

/**
 * Hierarchy table: which required scopes are implied by which granted scope.
 * `admin` implies the legacy management axis (admin, both `*_admin` scopes,
 * write, and read), but not the explicit opt-in siblings below.
 * `write` implies `read`. The two `*_admin` siblings only imply themselves.
 *
 * `agent`, `readback`, and `retract` are SIBLINGS, not implied by admin. A
 * super-admin token still needs to be re-registered to opt into any narrow
 * capability.
 * This prevents existing admin clients from silently gaining agent dispatch
 * telemetry-free compiled-page readback, or destructive retraction capability
 * on upgrade.
 */
const IMPLIES: Record<Scope, ReadonlySet<Scope>> = {
  admin: new Set(['admin', 'sources_admin', 'users_admin', 'write', 'read']),
  write: new Set(['write', 'read']),
  sources_admin: new Set(['sources_admin']),
  users_admin: new Set(['users_admin']),
  read: new Set(['read']),
  agent: new Set(['agent']),
  readback: new Set(['readback']),
  retract: new Set(['retract']),
};

/**
 * Does the granted scope set include something that satisfies `required`?
 * - admin in granted → true for the legacy admin/write/read management axis
 * - write in granted → true for {write, read}
 * - sources_admin in granted → true for {sources_admin}
 * - users_admin in granted → true for {users_admin}
 * - read in granted → true for {read}
 * - agent/readback/retract in granted → true only for that exact sibling capability
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

/**
 * v0.39.3.0 WARN-9 + CV12 — normalize the `scopes` (or `scope`) field that
 * arrives from the admin SPA's register-client request body to the
 * space-separated wire format `registerClientManual` expects. Three valid
 * input shapes; everything else throws Error to be caught and surfaced
 * as 400 invalid_scopes.
 *
 * Valid shapes:
 *   - `undefined` / `null` / missing  →  defaults to 'read'
 *   - `string`                         →  split on /\s+/, filter empty,
 *                                         dedupe, validate each, re-join
 *   - `string[]`                       →  validate each element is a non-
 *                                         empty single scope (no internal
 *                                         whitespace — that's the bug
 *                                         shape codex flagged where
 *                                         ['read write'] silently lets
 *                                         `read write` through as a single
 *                                         unknown scope), dedupe, validate
 *                                         each against ALLOWED_SCOPES
 *
 * Rejection cases:
 *   - non-string non-array (number, object, boolean) → Error
 *   - empty array after normalization → Error
 *   - array element with internal whitespace → Error (the ['read write'] bug)
 *   - array element that's not a string (null, number, ...) → Error
 *   - any element not in ALLOWED_SCOPES → InvalidScopeError
 *
 * Returns the space-separated string (e.g. 'read write') in sorted order
 * for determinism so two registrations with the same scope set produce
 * identical DB rows.
 */
export function normalizeScopesInput(raw: unknown): string {
  if (raw == null) return 'read';

  let candidates: string[];

  if (typeof raw === 'string') {
    candidates = raw.split(/\s+/).filter(Boolean);
  } else if (Array.isArray(raw)) {
    for (const el of raw) {
      if (typeof el !== 'string') {
        throw new Error(
          `scopes array must contain only strings, got ${el === null ? 'null' : typeof el}`,
        );
      }
      if (el.length === 0) {
        throw new Error('scopes array must not contain empty strings');
      }
      if (/\s/.test(el)) {
        throw new Error(
          `scopes array element "${el}" contains whitespace. Each element must be a single scope name; use ['read', 'write'] not ['read write'].`,
        );
      }
    }
    candidates = raw as string[];
  } else {
    throw new Error(
      `scopes must be a string or array of strings, got ${typeof raw}`,
    );
  }

  // Dedupe via Set + sort for stable output.
  const deduped = Array.from(new Set(candidates)).sort();

  if (deduped.length === 0) {
    throw new Error('scopes is empty after normalization');
  }

  // Validate against ALLOWED_SCOPES (throws InvalidScopeError on miss).
  assertAllowedScopes(deduped);

  return deduped.join(' ');
}
