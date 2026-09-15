/**
 * #4500: docs/mcp/DEPLOY.md + ALTERNATIVES.md must document the tailnet/LAN-only
 * `serve --http` shape and the MCP SDK's "Issuer URL must be HTTPS" exit.
 *
 * The HTTPS-issuer check lives in @modelcontextprotocol/sdk (checkIssuerUrl), so
 * gbrain cannot soften it; the only fix is telling operators which shapes work
 * (Tailscale Serve, plain-HTTP bearer-only without --public-url) and naming the
 * SDK's own opt-in. Doc-text pins, same precedent as docs-cli-commands.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';

const ROOT = dirname(import.meta.dir);
const deploy = readFileSync(join(ROOT, 'docs/mcp/DEPLOY.md'), 'utf8');
const alternatives = readFileSync(join(ROOT, 'docs/mcp/ALTERNATIVES.md'), 'utf8');

describe('DEPLOY.md documents the tailnet/LAN-only serve --http shape (#4500)', () => {
  test('troubleshooting names the SDK issuer error and its opt-in', () => {
    const troubleshooting = deploy.slice(deploy.indexOf('## Troubleshooting'));
    expect(troubleshooting).toContain('Issuer URL must be HTTPS');
    expect(troubleshooting).toContain('MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL');
  });

  test('HTTP section states --source-guard is stdio-only and points at the CORS allowlist', () => {
    expect(deploy).toContain('--source-guard');
    expect(deploy).toContain('GBRAIN_HTTP_CORS_ORIGIN');
  });

  test('ALTERNATIVES.md distinguishes tailnet-only Serve from public Funnel', () => {
    expect(alternatives).toContain('tailscale serve');
    expect(alternatives).toContain('tailscale funnel');
  });
});

describe('DEPLOY.md documents dual-mode /mcp auth (#4893)', () => {
  // The anonymous 401 + resource_metadata challenge is spec discovery, not
  // proof the configured bearer failed; client status probes that omit the
  // header report needsAuth while authenticated tool calls succeed.
  test('troubleshooting covers "needsAuth while tool calls succeed"', () => {
    const troubleshooting = deploy.slice(deploy.indexOf('## Troubleshooting'));
    expect(troubleshooting).toContain('needsAuth');
    expect(troubleshooting).toContain('whoami');
  });
});

describe('DEPLOY.md documents the owner magic-link flow (#5007)', () => {
  // The admin login page tells owners to ask their agent for a login link; the
  // mint endpoint already exists, so the only fix is documenting it where the
  // agent looks (DEPLOY.md + `gbrain auth --help`). Source reads below pin the
  // help text and anchor the documented route to the real registration.
  // test-reads-source-ok: AUTH_USAGE is a help-text template literal; pinning its spelling IS the contract
  const auth = readFileSync(join(ROOT, 'src/commands/auth.ts'), 'utf8');
  // test-reads-source-ok: anchors the documented route to the existing app.post registration
  const server = readFileSync(join(ROOT, 'src/commands/serve-http.ts'), 'utf8');

  test('documents the owner request and the existing mint endpoint', () => {
    expect(deploy).toContain('Give me the GBrain admin login link');
    expect(deploy).toContain('POST /admin/api/issue-magic-link');
    expect(server).toContain("app.post('/admin/api/issue-magic-link'");
  });

  test('auth help points at the owner login flow without inventing a CLI command', () => {
    expect(auth).toContain('Admin dashboard login (running HTTP server):');
    expect(auth).toContain('POST /admin/api/issue-magic-link');
    expect(auth).toContain('See docs/mcp/DEPLOY.md.');
  });

  test('warns against consuming the single-use nonce during verification', () => {
    expect(deploy).toContain('Do not GET or fetch the generated login URL');
    expect(auth).toContain('do not GET the generated link');
  });

  test('preserves private delivery and protected-bootstrap requirements', () => {
    expect(deploy).toContain('GBRAIN_ADMIN_BOOTSTRAP_TOKEN');
    expect(deploy).toContain('only to the requesting owner in');
    expect(deploy).toContain('Never expose its value in chat, logs, shell arguments,');
    expect(deploy).toContain('An MCP client bearer token or client secret is not the');
  });

  test('distinguishes login from client creation and states lifecycle limits', () => {
    expect(deploy).toContain('does not create, reveal, or rotate');
    expect(deploy).toContain('expires after five minutes');
    expect(deploy).toContain('cannot be replayed');
    expect(deploy).toContain('invalidated by a server restart');
    expect(deploy).toContain("server's configured `--public-url`");
  });
});
