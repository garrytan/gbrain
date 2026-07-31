/**
 * Tests for the GBRAIN_DISABLE_ADMIN kill switch in
 * src/commands/serve-http.ts.
 *
 * Why it exists: the entire /admin tree — login, magic-link issuance and
 * redemption, every /admin/api/* route and the SPA — mounts on the SAME
 * Express app and the SAME port as /mcp, and there was no way to turn it
 * off. Firewalling it is not an option either: Container Apps IP
 * restrictions (and most reverse proxies) apply per-app, not per-path, so
 * allowlisting /admin also allowlists /mcp, which breaks a roaming laptop.
 * /admin/login additionally carries no rate limiter of its own.
 *
 * For a single-user network-exposed deployment the admin web plane earns
 * nothing — the same operations are available over the CLI inside the
 * container — so the right posture is for the surface not to exist.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolveAdminDisabled } from '../src/commands/serve-http.ts';

describe('resolveAdminDisabled', () => {
  test('unset → admin stays mounted (opt-in, not a breaking upgrade)', () => {
    expect(resolveAdminDisabled({})).toBe(false);
  });

  test("'1' disables", () => {
    expect(resolveAdminDisabled({ GBRAIN_DISABLE_ADMIN: '1' })).toBe(true);
  });

  test("'true' disables", () => {
    expect(resolveAdminDisabled({ GBRAIN_DISABLE_ADMIN: 'true' })).toBe(true);
  });

  test("'0' does NOT disable — an explicit off must mean off", () => {
    // The trap this avoids: `Boolean(env.X)` would make '0' truthy, so an
    // operator writing GBRAIN_DISABLE_ADMIN=0 to re-enable the admin plane
    // would silently keep it disabled.
    expect(resolveAdminDisabled({ GBRAIN_DISABLE_ADMIN: '0' })).toBe(false);
  });

  test("'false' does NOT disable", () => {
    expect(resolveAdminDisabled({ GBRAIN_DISABLE_ADMIN: 'false' })).toBe(false);
  });

  test('empty string does NOT disable', () => {
    expect(resolveAdminDisabled({ GBRAIN_DISABLE_ADMIN: '' })).toBe(false);
  });

  test('an unrecognized value does NOT disable (fail-visible, not fail-quiet)', () => {
    // A typo'd value leaving the plane UP is the safer error: the operator
    // sees the admin URL in the startup banner and notices. Silently
    // disabling on a typo would look like a broken deploy instead.
    expect(resolveAdminDisabled({ GBRAIN_DISABLE_ADMIN: 'yes' })).toBe(false);
  });
});

describe('admin guard placement', () => {
  // The guard is a terminating middleware rather than a conditional wrapped
  // around ~700 lines of interleaved route registration. That is only safe
  // while it is registered ABOVE every /admin route — Express matches in
  // registration order, so a route mounted above the guard would escape it
  // entirely, and nothing else in the codebase would notice. Cheap source
  // assertion, because a full server boot is not otherwise needed here.
  const src = readFileSync('src/commands/serve-http.ts', 'utf8');
  const lines = src.split('\n');

  const guardLine = lines.findIndex(l => l.includes('resolveAdminDisabled()'));
  // Route registrations, not comments or string references.
  const adminRouteLines = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => /app\.(get|post|put|delete|use)\(\s*['"]\/admin/.test(l))
    .map(({ i }) => i);

  test('the guard exists', () => {
    expect(guardLine).toBeGreaterThan(-1);
  });

  test('there are /admin routes to guard (the check is not vacuous)', () => {
    expect(adminRouteLines.length).toBeGreaterThan(5);
  });

  test('every /admin route is registered below the guard', () => {
    const escaping = adminRouteLines
      .filter(i => i < guardLine)
      .map(i => `${i + 1}: ${lines[i]!.trim()}`);
    expect(escaping).toEqual([]);
  });
});
