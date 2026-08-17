/**
 * Output-format pin for `gbrain auth register-client` (cathedral-6 commit 1).
 *
 * The printed block is a PRODUCT contract, not just a test convenience:
 *   - src/commands/connect.ts defaultRegisterOAuthClient scrapes
 *     `/Client ID:\s+(\S+)/` and `/Client Secret:\s+(\S+)/` in production.
 *   - test/e2e/serve-http-oauth.test.ts (6 sites) + connect-bearer.test.ts
 *     scrape the same two lines with the gbrain_cl_/gbrain_cs_ prefixes.
 *
 * formatRegisterClientOutput is the single producer; this suite pins the
 * exact bytes so the registerScopedClient peel (and any future refactor)
 * cannot drift them.
 */
import { describe, test, expect } from 'bun:test';
import {
  formatRegisterClientOutput,
  parseRegisterClientArgs,
  type RegisteredClient,
} from '../src/commands/auth.ts';

const CONNECT_ID_RE = /Client ID:\s+(\S+)/;
const CONNECT_SECRET_RE = /Client Secret:\s+(\S+)/;
const E2E_ID_RE = /Client ID:\s+(gbrain_cl_\S+)/;
const E2E_SECRET_RE = /Client Secret:\s+(gbrain_cs_\S+)/;

function confidential(): RegisteredClient {
  return {
    clientId: 'gbrain_cl_abc123',
    clientSecret: 'gbrain_cs_secret456',
    grantTypes: ['client_credentials'],
    scopes: 'read write',
    authMethod: 'client_secret_post',
    redirectUris: [],
    sourceId: 'default',
    federatedRead: ['default'],
    created: { source: false },
  };
}

describe('auth register-client output pin (byte-identical product contract)', () => {
  test('confidential client: exact lines, in order', () => {
    const parsed = parseRegisterClientArgs(['--scopes', 'read write']);
    const lines = formatRegisterClientOutput('demo', confidential(), parsed);
    expect(lines).toEqual([
      'OAuth client registered: "demo"\n',
      '  Client ID:           gbrain_cl_abc123',
      '  Client Secret:       gbrain_cs_secret456\n',
      '  Grant types:         client_credentials',
      '  Scopes:              read write',
      '  Token auth method:   client_secret_post',
      '  Write source:        default',
      '  Federated reads:     default',
      '',
      'Save the client secret — it will not be shown again.',
      'Revoke with: gbrain auth revoke-client "gbrain_cl_abc123"',
    ]);
  });

  test('connect.ts production scraping regexes match the joined output', () => {
    const parsed = parseRegisterClientArgs([]);
    const stdout = formatRegisterClientOutput('demo', confidential(), parsed).join('\n');
    expect(stdout.match(CONNECT_ID_RE)?.[1]).toBe('gbrain_cl_abc123');
    expect(stdout.match(CONNECT_SECRET_RE)?.[1]).toBe('gbrain_cs_secret456');
  });

  test('serve-http-oauth e2e prefixed regexes match the joined output', () => {
    const parsed = parseRegisterClientArgs([]);
    const stdout = formatRegisterClientOutput('demo', confidential(), parsed).join('\n');
    expect(stdout.match(E2E_ID_RE)?.[1]).toBe('gbrain_cl_abc123');
    expect(stdout.match(E2E_SECRET_RE)?.[1]).toBe('gbrain_cs_secret456');
  });

  test('public client: placeholder secret line keeps the label prefix scrapeable shape', () => {
    const parsed = parseRegisterClientArgs(['--redirect-uri', 'https://a.example/cb']);
    const r: RegisteredClient = {
      ...confidential(),
      clientSecret: undefined,
      grantTypes: ['authorization_code', 'refresh_token'],
      authMethod: 'none',
      redirectUris: ['https://a.example/cb'],
    };
    const lines = formatRegisterClientOutput('pub', r, parsed);
    expect(lines).toContain('  Client Secret:       <public client — none issued>\n');
    expect(lines).toContain('  Redirect URIs:       https://a.example/cb');
    expect(lines).toContain('Public client (PKCE-only) — no secret needed.');
    // The e2e "public client" site scrapes ID only — must still match.
    expect(lines.join('\n').match(E2E_ID_RE)?.[1]).toBe('gbrain_cl_abc123');
  });

  test('agent-bindings block: all six lines, exact alignment', () => {
    const parsed = parseRegisterClientArgs([
      '--bound-tools', 'search,recall',
      '--bound-source', 'ws',
      '--bound-slug-prefixes', 'agents/',
      '--bound-max-concurrent', '2',
      '--budget-usd-per-day', '1.50',
    ]);
    const lines = formatRegisterClientOutput('bound', confidential(), parsed);
    expect(lines).toContain('  Bound tools:         search, recall');
    expect(lines).toContain('  Bound source:        ws');
    expect(lines).toContain('  Bound brain:         <none>');
    expect(lines).toContain('  Bound slug prefixes: agents/');
    expect(lines).toContain('  Max concurrency:     2');
    expect(lines).toContain('  Daily budget USD:    1.50');
  });
});
