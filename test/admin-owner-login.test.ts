/**
 * Lane 3 P3: the owner login page leads with the owner's own command. The page itself is exercised in Chromium by
 * admin/e2e/admin.pw.ts (`bun run test:admin`); this covers the strings admin/src/lib/oauth-request.ts builds for
 * admin/src/pages/Login.tsx, so a change to either is caught by the unit lanes too.
 *
 * 1. Protects: the command keeps a waiting connector's request id and names the owner credential file; the prompt for
 *    someone else who runs the host keeps the same request; neither carries a login link.
 * 2. Fails when: the request id is dropped (the link would land on the dashboard, not the approval page), or the page
 *    goes back to telling the owner to ask an agent for the link.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ownerLoginCommand, ownerLoginPrompt } from '../admin/src/lib/oauth-request.ts';

const URL_ = 'https://brain.example.com/mcp';
const REQUEST = 'b'.repeat(64);

describe('owner login strings', () => {
  test('the owner\'s own command keeps the waiting request and names the credential file', () => {
    expect(ownerLoginCommand(URL_, REQUEST)).toBe(`gbrain mcp admin login-link --url '${URL_}' --oauth-request ${REQUEST} --admin-token-file ~/.gbrain/serve/admin-token`);
    expect(ownerLoginCommand(URL_)).toBe(`gbrain mcp admin login-link --url '${URL_}' --admin-token-file ~/.gbrain/serve/admin-token`);
    expect(ownerLoginPrompt(URL_, REQUEST)).toContain(`--oauth-request ${REQUEST}`);
    for (const s of [ownerLoginCommand(URL_, REQUEST), ownerLoginPrompt(URL_, REQUEST)]) expect(s).not.toContain('/admin/auth/');
  });

  test('the login page leads with the owner\'s command and folds the host-administrator prompt', () => {
    // test-reads-source-ok[structural]: the login page has no component harness in the unit lanes; admin/e2e/admin.pw.ts drives it in Chromium.
    const page = readFileSync('admin/src/pages/Login.tsx', 'utf8');
    expect(page).not.toContain('Ask the agent that administers the brain host');
    const command = page.indexOf('owner-login-command');
    const prompt = page.indexOf('owner-login-prompt');
    expect(command).toBeGreaterThan(0);
    expect(prompt).toBeGreaterThan(command);
    expect(page.slice(page.lastIndexOf('<details', prompt), prompt)).toContain('Someone else runs the brain host');
  });

  test('the Chromium suite still drives the login page with a waiting request', () => {
    const browser = readFileSync('admin/e2e/admin.pw.ts', 'utf8');
    expect(browser).toContain("getByLabel('Owner login command', { exact: true })");
    expect(browser).toContain('/admin/?oauth_request=');
  });
});
