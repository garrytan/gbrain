import { describe, expect, test } from 'bun:test';
import { classifyConnectorLeaf, connectorCheckpointKey, connectorCheckpointKeys, connectorConfigLeaves, connectorIdentity, connectorIdentityMatches, CONNECTOR_LEAF_RULES, isConnectorIntentKind } from '../src/core/persistence/connector-identity.ts';
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

// #6561: v0.60.176.0 added an always-emitted `contactsDir: 'people'` leaf, which re-keyed every Google checkpoint
// (the pre-field cursor was lost and exposed to orphan cleanup). Both digests below come from the issue's real runs:
// the v0.60.126.0 implementation, and the interim releases that hashed the default leaf.
describe('#6561: a parser default that preserves behavior keeps the pre-field identity', () => {
  const raw = { kind: 'google', g_account: 'fixture@example.test', g_services: 'gmail,contacts', g_dir: '/fixture' };
  const PRE_FIELD = '81b1c0b0c86d07b67f11eb6dd6e8ebdc5839f74db8c2f033eb48c19cfae7b6e8';
  const INTERIM = '52a7990a8ff21b7fe252a86ac5cea35141f6952aeb35da37c445476e184126ee';
  const fixture = (extra: Record<string, unknown> = {}) => connectorIdentity('google', { ...raw, ...extra }, '/fixture');

  test('an unchanged default-contacts config hashes to the pre-field digest; the interim digest is its alias', () => {
    expect(fixture().digest).toBe(PRE_FIELD);
    expect(fixture().aliasDigests).toEqual([INTERIM]);
  });
  test('absent, explicit default and a spelled-out default contacts dir are one identity', () => {
    expect(fixture({ g_contacts_dir: 'people' }).digest).toBe(PRE_FIELD);
    expect(fixture({ g_contacts_dir: '/people/' }).digest).toBe(PRE_FIELD);
  });
  test('a non-default contacts dir and every other content change still isolate, with no alias', () => {
    const changed = [fixture({ g_contacts_dir: 'contacts' }), fixture({ g_account: 'other@example.test' }), fixture({ g_services: 'gmail' }),
      fixture({ g_dir: '/elsewhere' }), fixture({ g_history_days: 30 })];
    for (const identity of changed) expect(identity.digest).not.toBe(PRE_FIELD);
    expect(new Set(changed.map(identity => identity.digest)).size).toBe(changed.length);
    expect(fixture({ g_contacts_dir: 'contacts' }).aliasDigests).toEqual([]);
  });
  test('the checkpoint keys of a source: the canonical key first, then the interim alias; incarnation still isolates', () => {
    const keys = connectorCheckpointKeys('fixture-google', '11111111-1111-4111-8111-111111111111', fixture());
    expect(keys).toEqual([
      connectorCheckpointKey('fixture-google', '11111111-1111-4111-8111-111111111111', { kind: 'google', digest: PRE_FIELD }),
      connectorCheckpointKey('fixture-google', '11111111-1111-4111-8111-111111111111', { kind: 'google', digest: INTERIM }),
    ]);
    expect(connectorCheckpointKeys('fixture-google', '22222222-2222-4222-8222-222222222222', fixture())).not.toContain(keys[0]);
  });
  test('a write admitted under the interim digest (its frozen configHash) still matches the unchanged source; a real change does not', () => {
    expect(connectorIdentityMatches(fixture(), INTERIM)).toBe(true);
    expect(connectorIdentityMatches(fixture(), PRE_FIELD)).toBe(true);
    expect(connectorIdentityMatches(fixture({ g_services: 'gmail' }), INTERIM)).toBe(false);
    expect(connectorIdentityMatches(fixture({ g_contacts_dir: 'contacts' }), INTERIM)).toBe(false);
  });
  test('every parser leaf with an always-present default declares the value that elides it', () => {
    const bare = parseGoogleSourceConfig({ kind: 'google' }, '/brain');
    const leaves = connectorConfigLeaves(bare);
    const defaulted = Object.keys(leaves).filter(leaf => !['account', 'services', 'historyDays', 'calendarId', 'dir', 'access'].includes(leaf));
    expect(defaulted).toEqual(['contactsDir']);
    for (const leaf of defaulted) expect((CONNECTOR_LEAF_RULES.google[leaf] as { elideWhen?: unknown }).elideWhen, `google:${leaf}`).toBe(leaves[leaf]);
  });
});
