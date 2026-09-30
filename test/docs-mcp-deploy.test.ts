/**
 * #5007: docs/mcp/DEPLOY.md names the owner login-link request and the existing
 * mint endpoint, anchored to the real route registration. The `gbrain auth --help`
 * half of this contract is asserted on spawned output in
 * test/cli-help-discoverability.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { surfaceSource } from './helpers/source-surface.ts';

const ROOT = dirname(import.meta.dir);
const deploy = readFileSync(join(ROOT, 'docs/mcp/DEPLOY.md'), 'utf8');

describe('DEPLOY.md documents the owner magic-link flow (#5007)', () => {
  // test-reads-source-ok[structural]: anchors the documented route to the existing app.post registration
  const server = surfaceSource('serve-http');

  test('documents the owner request and the existing mint endpoint', () => {
    expect(deploy).toContain('Give me the GBrain admin login link');
    expect(deploy).toContain('POST /admin/api/issue-magic-link');
    expect(server).toContain("app.post('/admin/api/issue-magic-link'");
  });
});
