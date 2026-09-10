// test-reads-source-ok: this documentation/help discoverability contract checks source spelling intentionally; the existing endpoint registration anchors the documented route.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');
const deploy = read('../docs/mcp/DEPLOY.md');
const auth = read('../src/commands/auth.ts');
const server = read('../src/commands/serve-http.ts');

describe('admin login-link discoverability', () => {
  test('documents the owner request and existing mint endpoint', () => {
    expect(deploy).toContain('Give me the GBrain admin login link');
    expect(deploy).toContain('POST /admin/api/issue-magic-link');
    expect(server).toContain("app.post('/admin/api/issue-magic-link'");
  });
  test('auth help points to the owner login flow without inventing a CLI command', () => {
    expect(auth).toContain('Admin dashboard login (running HTTP server):');
    expect(auth).toContain('POST /admin/api/issue-magic-link');
    expect(auth).toContain('See docs/mcp/DEPLOY.md.');
  });
  test('warns against consuming the nonce during link verification', () => {
    expect(deploy).toContain('Do not GET or fetch the generated login URL');
    expect(auth).toContain('do not GET the generated link');
  });
  test('preserves private delivery and protected-bootstrap requirements', () => {
    expect(deploy).toContain('GBRAIN_ADMIN_BOOTSTRAP_TOKEN');
    expect(deploy).toContain('only to the requesting owner in');
    expect(deploy).toContain('Never expose its value in chat, logs, shell arguments,');
    expect(deploy).toContain('An MCP client bearer token or client secret is not the');
  });
  test('distinguishes login from client creation and describes lifecycle limits', () => {
    expect(deploy).toContain('does not create, reveal, or rotate');
    expect(deploy).toContain('expires after five minutes');
    expect(deploy).toContain('cannot be replayed');
    expect(deploy).toContain('invalidated by a server restart');
    expect(deploy).toContain("server's configured `--public-url`");
  });
});
