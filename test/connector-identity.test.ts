import { describe, expect, test } from 'bun:test';
import { classifyConnectorLeaf, connectorConfigLeaves, connectorIdentity, CONNECTOR_LEAF_RULES, isConnectorIntentKind } from '../src/core/persistence/connector-identity.ts';
import { parseGoogleSourceConfig } from '../src/core/google/google-source.ts';
import { parseGitHubSourceConfig } from '../src/core/github-source.ts';

// #5686: the connector identity is the parsed config minus credential-delivery
// fields. Raw sources.config bookkeeping (cycle stamps) never changes it.

const google = { kind: 'google', g_account: 'owner@example.invalid', g_services: 'gmail,calendar', g_access: 'env', g_token_env: 'TOKEN_A', g_history_days: 30 };
const githubRepos = { kind: 'github', gh_scope: 'repos', gh_repos: 'acme-example/app,acme-example/api', gh_token_env: 'TOKEN_A' };
const githubAuto = { kind: 'github', gh_scope: 'auto', gh_token_env: 'TOKEN_A' };
const githubApp = { kind: 'github', gh_scope: 'auto', gh_app_id: 42, gh_app_pem_path: '/keys/a.pem', gh_app_install_id: 7, gh_token_env: 'TOKEN_A' };
const id = (kind: 'google' | 'github', raw: Record<string, unknown>) => connectorIdentity(kind, raw, '/brain/source').digest;

describe('connector identity leaf classification', () => {
  test('every leaf each parser returns is classified as identity or excluded', () => {
    const samples: Array<['google' | 'github', Record<string, unknown>]> = [
      ['google', { ...google, g_access: 'command', g_token_command: 'print-token', g_calendar_id: 'team@example.invalid', g_dir: '/brain/google' }],
      ['github', { ...githubApp, gh_dir: '/brain/github' }], ['github', githubRepos], ['github', githubAuto],
    ];
    for (const [kind, raw] of samples) {
      const parsed = kind === 'google' ? parseGoogleSourceConfig(raw, '/brain') : parseGitHubSourceConfig(raw, '/brain');
      for (const leaf of Object.keys(connectorConfigLeaves(parsed))) {
        expect(classifyConnectorLeaf(kind, parsed, leaf), `${kind}:${leaf}`).toMatch(/^(identity|excluded)$/);
        expect(Object.hasOwn(CONNECTOR_LEAF_RULES[kind], leaf), `${kind}:${leaf} has a rule`).toBe(true);
      }
    }
  });

  test('nested GitHub App leaves: pemPath excluded; appId and installId identity under scope auto', () => {
    const parsed = parseGitHubSourceConfig(githubApp, '/brain');
    expect(classifyConnectorLeaf('github', parsed, 'app.pemPath')).toBe('excluded');
    expect(classifyConnectorLeaf('github', parsed, 'app.appId')).toBe('identity');
    expect(classifyConnectorLeaf('github', parsed, 'app.installId')).toBe('identity');
    const repos = parseGitHubSourceConfig({ ...githubApp, gh_scope: 'repos', gh_repos: 'acme-example/app' }, '/brain');
    expect(classifyConnectorLeaf('github', repos, 'app.appId')).toBe('excluded');
  });
});

describe('connector identity stability', () => {
  test('cycle stamps and other raw bookkeeping keys never change the identity', () => {
    const stamped = { ...google, last_source_cycle_at: '2026-09-29T00:00:00Z', last_full_cycle_at: '2026-09-29T00:00:00Z', slug_root_mode: 'source-root' };
    expect(id('google', stamped)).toBe(id('google', google));
    expect(id('github', { ...githubRepos, last_source_cycle_at: 'x' })).toBe(id('github', githubRepos));
  });
  test('a content field changes the identity; reordered or duplicated services and repos do not', () => {
    expect(id('google', { ...google, g_history_days: 90 })).not.toBe(id('google', google));
    expect(id('google', { ...google, g_services: 'calendar,gmail,calendar' })).toBe(id('google', google));
    expect(id('github', { ...githubRepos, gh_repos: 'acme-example/api,acme-example/app,acme-example/app' })).toBe(id('github', githubRepos));
  });
  test('credential-delivery fields: Google access mode and token env, GitHub token env under scope repos, do not change it', () => {
    expect(id('google', { ...google, g_token_env: 'TOKEN_B' })).toBe(id('google', google));
    expect(id('google', { ...google, g_access: 'command', g_token_command: 'print-token' })).toBe(id('google', google));
    expect(id('github', { ...githubRepos, gh_token_env: 'TOKEN_B' })).toBe(id('github', githubRepos));
  });
  test('under scope auto the token env is identity without an App and ignored with one; moving the PEM keeps it', () => {
    expect(id('github', { ...githubAuto, gh_token_env: 'TOKEN_B' })).not.toBe(id('github', githubAuto));
    expect(id('github', { ...githubApp, gh_token_env: 'TOKEN_B' })).toBe(id('github', githubApp));
    expect(id('github', { ...githubApp, gh_app_pem_path: '/moved/a.pem' })).toBe(id('github', githubApp));
    expect(id('github', { ...githubApp, gh_app_install_id: 8 })).not.toBe(id('github', githubApp));
  });
  test('one predicate accepts both connector intent namespaces', () => {
    expect(isConnectorIntentKind('connector_v2_import')).toBe(true);
    expect(isConnectorIntentKind('managed_connector_checkpoint')).toBe(true);
    expect(isConnectorIntentKind('managed_sync_import')).toBe(false);
  });
});
