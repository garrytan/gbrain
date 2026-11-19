/**
 * Byte-identical pins for the caller raw SQL that became typed engine members (Rust engine lane 11).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member sends Postgres exactly the statement text its caller ran through `executeRaw` before the
 *    move. Each expected text below is copied verbatim from the caller at 7470c703ed.
 *  - Regression: an edited statement changes what Postgres and PGLite answer while the parity cases may still pass on
 *    a small fixture.
 *  - Why existing coverage misses it: the sql-text goldens cover the W1 domains only (test/engine-sql-sql-text.test.ts),
 *    and these members live outside them.
 *  - Seam: the fake postgres.js driver (test/helpers/fake-postgres-sql.ts) records the text; no database runs.
 */
import { describe, expect, test } from 'bun:test';
import { runCase, withPinnedSqlEnvironment, type SqlCase } from './helpers/postgres-engine-sql-cases.ts';
import { edgeTrimSql } from '../src/core/edge-whitespace.ts';
import { planManualClient } from '../src/core/oauth-provider.ts';
import { clientGrantInsert, grantValidationContext, insertClientGrant } from '../src/core/grants/service.ts';
import { CREDENTIAL_SQL } from '../src/core/engine-sql/access-credentials.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';

/** caller.ts MEMBER_SQL at 7470c703ed: MEMBERS_WHERE_SQL(`m.id = (${member})`), copied verbatim. */
const memberSql = (member: string) => `SELECT m.id, COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id
  WHERE m.id = (${member}) AND m.disabled_at IS NULL AND m.tombstoned_at IS NULL
  GROUP BY m.id`;

interface Pin {
  /** The caller site the statement came from, at 7470c703ed. */
  from: string;
  case: SqlCase;
  /** The statement texts, in order, as the caller sent them. */
  texts: string[];
}

const PINS: Pin[] = [
  {
    from: 'src/core/access/caller.ts:376 appliedAccessSummary',
    case: { method: 'listAppliedPolicyRevisions', variant: 'default', run: e => e.listAppliedPolicyRevisions() },
    texts: [`SELECT s.source_id, (SELECT r.revision FROM access_policy_revisions r WHERE r.source_id = s.source_id AND r.applied_at IS NOT NULL
          ORDER BY r.revision DESC LIMIT 1) AS rev FROM access_policy_state s ORDER BY s.source_id`],
  },
  {
    from: 'src/core/access/caller.ts:196 mayActForOf (legacy token)',
    case: { method: 'readMayActFor', variant: 'legacy-token', run: e => e.readMayActFor('legacy_token', 'tok-1') },
    texts: ['SELECT may_act_for FROM access_tokens WHERE id::text = $1 AND revoked_at IS NULL'],
  },
  {
    from: 'src/core/access/caller.ts:200 mayActForOf (OAuth client)',
    case: { method: 'readMayActFor', variant: 'oauth-client', run: e => e.readMayActFor('oauth_client', 'client-1') },
    texts: ['SELECT may_act_for FROM oauth_clients WHERE client_id = $1 AND deleted_at IS NULL'],
  },
  {
    from: 'src/core/access/caller.ts:204 mayActForOf (stdio config)',
    case: { method: 'readMayActFor', variant: 'stdio-config', run: e => e.readMayActFor('stdio_config', 'mcp.stdio_may_act_for') },
    texts: ['SELECT value FROM config WHERE key = $1'],
  },
  {
    from: 'src/core/access/caller.ts:253 resolveAudienceIdentities (members, then groups)',
    case: { method: 'readAudiencePrincipals', variant: 'members-and-groups', run: e => e.readAudiencePrincipals(['alice-example'], ['team-a']) },
    texts: [`SELECT m.id, COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id
  WHERE m.id = ANY($1::text[]) AND m.disabled_at IS NULL AND m.tombstoned_at IS NULL
  GROUP BY m.id`, 'SELECT id FROM access_groups WHERE id = ANY($1::text[])'],
  },
  {
    from: 'src/core/access/caller.ts:253 resolveAudienceIdentities (an empty list reads nothing)',
    case: { method: 'readAudiencePrincipals', variant: 'groups-only', run: e => e.readAudiencePrincipals([], ['team-a']) },
    texts: ['SELECT id FROM access_groups WHERE id = ANY($1::text[])'],
  },
  {
    from: 'src/core/access/members.ts:124 getMember (one member by id)',
    case: { method: 'readAccessMembers', variant: 'by-id', run: e => e.readAccessMembers({ id: 'alice-example' }) },
    texts: [`SELECT m.id, m.display_name, m.email, m.kind, m.labelled_only, m.disabled_at, m.tombstoned_at, m.created_at,
  COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id WHERE m.id = $1 GROUP BY m.id`],
  },
  {
    from: 'src/core/access/members.ts:160 memberByEmail and :143 assertEmailFree (members declaring one email)',
    case: { method: 'readAccessMembers', variant: 'by-email', run: e => e.readAccessMembers({ email: 'alice@example.com' }) },
    texts: [`SELECT m.id, m.display_name, m.email, m.kind, m.labelled_only, m.disabled_at, m.tombstoned_at, m.created_at,
  COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id WHERE m.email = $1 GROUP BY m.id ORDER BY m.id`],
  },
  {
    from: 'src/core/access/members.ts:129 listMembers (removed members filtered out)',
    case: { method: 'readAccessMembers', variant: 'live', run: e => e.readAccessMembers({ includeRemoved: false }) },
    texts: [`SELECT m.id, m.display_name, m.email, m.kind, m.labelled_only, m.disabled_at, m.tombstoned_at, m.created_at,
  COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id WHERE m.tombstoned_at IS NULL GROUP BY m.id ORDER BY m.id`],
  },
  {
    from: 'src/core/access/members.ts:129 listMembers (--all)',
    case: { method: 'readAccessMembers', variant: 'all', run: e => e.readAccessMembers({ includeRemoved: true }) },
    texts: [`SELECT m.id, m.display_name, m.email, m.kind, m.labelled_only, m.disabled_at, m.tombstoned_at, m.created_at,
  COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id GROUP BY m.id ORDER BY m.id`],
  },
  {
    from: 'src/core/access/members.ts:199 legacyTokenByName (active tokens with one name)',
    case: { method: 'readAccessCredentials', variant: 'token-name', run: e => e.readAccessCredentials({ tokenName: 'laptop' }) },
    texts: ['SELECT id::text AS id, name FROM access_tokens WHERE name = $1 AND revoked_at IS NULL ORDER BY created_at'],
  },
  {
    from: 'src/core/access/members.ts:305/307 boundCredentials (tokens, then clients)',
    case: { method: 'readAccessCredentials', variant: 'member', run: e => e.readAccessCredentials({ memberId: 'alice-example' }) },
    texts: ['SELECT id::text AS id, name FROM access_tokens WHERE member_id = $1 AND revoked_at IS NULL ORDER BY name',
      "SELECT client_id AS id, client_name AS name FROM oauth_clients WHERE member_id = $1 AND (to_jsonb(oauth_clients)->>'deleted_at') IS NULL ORDER BY client_id"],
  },
  {
    from: 'src/core/access/members.ts:295 audienceMemberIds',
    case: { method: 'listAudienceAccessMembers', variant: 'default', run: e => e.listAudienceAccessMembers() },
    texts: ["SELECT id FROM access_members WHERE kind = 'audience' AND disabled_at IS NULL AND tombstoned_at IS NULL ORDER BY id"],
  },
  {
    from: 'src/core/access/caller.ts:94 liveIdentity (member id: :120 stdioMember, :146 stdioMemberIdentity)',
    case: { method: 'readLiveMember', variant: 'member', run: e => e.readLiveMember('member', 'alice-example') },
    texts: [memberSql('$1')],
  },
  {
    from: 'src/core/access/caller.ts:94 liveIdentity (stdio config: :121)',
    case: { method: 'readLiveMember', variant: 'stdio-config', run: e => e.readLiveMember('stdio_config', 'mcp.stdio_member') },
    texts: [memberSql(`SELECT ${edgeTrimSql('value')} FROM config WHERE key = $1`)],
  },
  {
    from: 'src/core/access/caller.ts:94 liveIdentity (legacy token: :123)',
    case: { method: 'readLiveMember', variant: 'legacy-token', run: e => e.readLiveMember('legacy_token', 'tok-1') },
    texts: [memberSql('SELECT member_id FROM access_tokens WHERE id::text = $1 AND revoked_at IS NULL')],
  },
  {
    from: 'src/core/access/caller.ts:94 liveIdentity (OAuth client: :123)',
    case: { method: 'readLiveMember', variant: 'oauth-client', run: e => e.readLiveMember('oauth_client', 'client-1') },
    texts: [memberSql('SELECT member_id FROM oauth_clients WHERE client_id = $1 AND deleted_at IS NULL')],
  },  {
    from: 'src/core/access/members.ts:345 listGroups (every group)',
    case: { method: 'readAccessGroups', variant: 'all', run: e => e.readAccessGroups(null) },
    texts: [`SELECT g.id, COALESCE(array_agg(gm.member_id ORDER BY gm.member_id) FILTER (WHERE gm.member_id IS NOT NULL), '{}') AS members
     FROM access_groups g LEFT JOIN access_group_members gm ON gm.group_id = g.id
      GROUP BY g.id ORDER BY g.id`],
  },
  {
    from: 'src/core/access/members.ts:345 listGroups (one group by id)',
    case: { method: 'readAccessGroups', variant: 'by-id', run: e => e.readAccessGroups('team-a') },
    texts: [`SELECT g.id, COALESCE(array_agg(gm.member_id ORDER BY gm.member_id) FILTER (WHERE gm.member_id IS NOT NULL), '{}') AS members
     FROM access_groups g LEFT JOIN access_group_members gm ON gm.group_id = g.id
     WHERE g.id = $1 GROUP BY g.id ORDER BY g.id`],
  },
  {
    from: 'src/core/access/members.ts:303 pagesNaming',
    case: { method: 'listPagesNamingReader', variant: 'default', run: e => e.listPagesNamingReader('member:alice-example') },
    texts: [`SELECT slug, source_id FROM pages WHERE frontmatter ? 'readable_by' AND gbrain_access_readers(frontmatter) @> ARRAY[$1]::text[]
     ORDER BY source_id, slug LIMIT 51`],
  },
  {
    from: 'src/core/wakeshift/forget.ts:23 forgetWakePrincipal (member), called from members.ts removeMember',
    case: { method: 'forgetWakeMember', variant: 'default', run: e => e.forgetWakeMember('alice-example') },
    texts: [
      `INSERT INTO wake_forgets (wake_user) SELECT DISTINCT wake_user FROM wake_subscriptions WHERE member_id = $1
        ON CONFLICT (wake_user) WHERE state = 'pending' DO NOTHING RETURNING id`,
      `UPDATE wake_subscriptions SET state = 'ended', last_error = 'principal_revoked', lease_until = NULL, updated_at = now()
        WHERE member_id = $1 AND state = 'open' RETURNING id`,
      'DELETE FROM wake_terms_acceptances WHERE principal_key = $1',
    ],
  },
  {
    from: 'src/core/wakeshift/forget.ts forgetWakePrincipal (credential), called from auth.ts revoke/revokeById/revokeClient and token-mint.ts revokeLegacyTokenById',
    case: { method: 'forgetWakeCredential', variant: 'default', run: e => e.forgetWakeCredential('oauth_client', 'client-a') },
    texts: [
      `INSERT INTO wake_forgets (wake_user) SELECT DISTINCT wake_user FROM wake_subscriptions
      WHERE principal_kind = $1 AND principal_id = $2 AND member_id IS NULL
      ON CONFLICT (wake_user) WHERE state = 'pending' DO NOTHING RETURNING id`,
      `UPDATE wake_subscriptions SET state = 'ended', last_error = 'principal_revoked', lease_until = NULL, updated_at = now()
      WHERE principal_kind = $1 AND principal_id = $2 AND state = 'open' RETURNING id`,
      'DELETE FROM wake_terms_acceptances WHERE principal_key = $1',
    ],
  },
  {
    from: 'src/commands/auth.ts revoke (by name)',
    case: { method: 'revokeAccessTokensNamed', variant: 'default', run: e => e.revokeAccessTokensNamed('laptop') },
    texts: [`
      UPDATE access_tokens SET revoked_at = now()
      WHERE name = $1 AND revoked_at IS NULL
      RETURNING id
    `],
  },
  {
    from: 'src/commands/auth.ts revokeById, src/core/token-mint.ts revokeLegacyTokenById',
    case: { method: 'revokeAccessToken', variant: 'default', run: e => e.revokeAccessToken('00000000-0000-4000-8000-0000000000c1') },
    texts: [`
      UPDATE access_tokens SET revoked_at = now()
      WHERE id = $1::uuid AND revoked_at IS NULL
      RETURNING name
    `],
  },
  {
    from: 'src/commands/auth.ts revokeClient',
    case: { method: 'deleteOAuthClient', variant: 'default', run: e => e.deleteOAuthClient('client-a') },
    texts: [`
        DELETE FROM oauth_clients WHERE client_id = $1
        RETURNING client_id, client_name
      `],
  },
  {
    from: 'src/commands/auth.ts:180 list (at 837c389e52)',
    case: { method: 'listAccessTokens', variant: 'default', run: e => e.listAccessTokens() },
    texts: [`
      SELECT * FROM access_tokens
      ORDER BY created_at DESC
    `],
  },
  {
    from: 'src/core/token-mint.ts:192 readActiveTokenPrivatePages (at 837c389e52)',
    case: { method: 'readActiveAccessTokenGrant', variant: 'private-pages', run: e => e.readActiveAccessTokenGrant('00000000-0000-4000-8000-0000000000c1', 'private_pages') },
    texts: ['SELECT private_pages FROM access_tokens WHERE id = $1::uuid AND revoked_at IS NULL'],
  },
  {
    from: 'src/core/token-mint.ts:209 readActiveTokenPermissions (at 837c389e52)',
    case: { method: 'readActiveAccessTokenGrant', variant: 'permissions', run: e => e.readActiveAccessTokenGrant('00000000-0000-4000-8000-0000000000c1', 'permissions') },
    texts: ['SELECT permissions FROM access_tokens WHERE id = $1::uuid AND revoked_at IS NULL'],
  },
  {
    from: 'src/core/wakeshift/drain.ts:80 principalLive (legacy token, at 837c389e52)',
    case: { method: 'accessTokenLive', variant: 'default', run: e => e.accessTokenLive('00000000-0000-4000-8000-0000000000c1') },
    texts: ['SELECT 1 FROM access_tokens WHERE id::text = $1 AND revoked_at IS NULL'],
  },
  {
    from: 'src/core/wakeshift/drain.ts:77 principalLive (OAuth client, at 837c389e52)',
    case: { method: 'oauthClientLive', variant: 'default', run: e => e.oauthClientLive('client-a') },
    texts: ['SELECT 1 FROM oauth_clients WHERE client_id = $1 AND deleted_at IS NULL'],
  },
  {
    from: 'src/commands/auth.ts:581 preflightOauthClientColumns (at 837c389e52)',
    case: { method: 'readOauthClientColumns', variant: 'preflight', run: e => e.readOauthClientColumns('preflight') },
    texts: [`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'oauth_clients'
      AND table_schema = current_schema()
      AND column_name IN ('token_ttl', 'surface', 'federated_read', 'source_id', 'deleted_at')
  `],
  },
  {
    from: 'src/core/oauth-provider.ts:1112 registerClientManual column probe (at 837c389e52)',
    case: { method: 'readOauthClientColumns', variant: 'grant', run: e => e.readOauthClientColumns('grant') },
    texts: [`SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'oauth_clients'
        AND column_name IN ('grant_revision', 'allowed_operations', 'delegated_slug_prefixes', 'delegated_namespace', 'grant_profile', 'grant_repair_reasons', 'surface', 'surface_set_by', 'token_ttl', 'source_id', 'federated_read', 'bound_slug_prefixes', 'bound_tools', 'bound_source_id', 'bound_brain_id', 'bound_max_concurrent', 'budget_usd_per_day')`],
  },
  {
    from: 'src/commands/auth.ts:677 registerScopedClient token_ttl write (at 837c389e52; the template, as $N text)',
    case: { method: 'setOauthClientTokenTtl', variant: 'default', run: e => e.setOauthClientTokenTtl('client-a', 3600) },
    texts: [`
        UPDATE oauth_clients SET token_ttl = $1
        WHERE client_id = $2
        RETURNING client_id
      `],
  },
  {
    from: 'src/commands/auth.ts:1111 tokenLifetimeClampedClients (at 837c389e52)',
    case: { method: 'readTokenLifetimeClampedClients', variant: 'default', run: e => e.readTokenLifetimeClampedClients() },
    texts: [`SELECT DISTINCT client_id FROM oauth_grant_audit WHERE actor = 'migration' AND action IN ('clamp_token_ttl', 'shorten_access_tokens')`],
  },
];

describe('caller raw SQL moved into typed members keeps its Postgres text byte for byte', () => {
  for (const pin of PINS) {
    test(`${pin.case.method}/${pin.case.variant} (${pin.from})`, async () => {
      const capture = await withPinnedSqlEnvironment(undefined, () => runCase(pin.case));
      expect(capture.error).toBeUndefined();
      const sent = capture.trace.filter(s => s.kind === 'query').map(s => s.text);
      expect(sent).toEqual(pin.texts);
    });
  }
});

describe('insertOauthClientGrant sends what insertClientGrant sends', () => {
  // The drift pin: grants/service.ts insertClientGrant stays the provider's path, so the member's constant text and
  // parameter order must keep matching the template it was captured from.
  test('same statement text and parameters for one planned client', async () => {
    const plan = planManualClient('pin-client', ['client_credentials'], 'read write', [], 'default', ['default']);
    const context = await grantValidationContext({ listAllSources: async () => [{ id: 'default' }] } as never);
    const grant = plan.grant(context);
    const sent = async (run: (e: any) => Promise<unknown>) => {
      const capture = await withPinnedSqlEnvironment(undefined, () => runCase({ method: 'insert', variant: 'default', run }));
      expect(capture.error).toBeUndefined();
      return capture.trace.filter(s => s.kind === 'query').map(s => ({ text: s.text, params: s.params }));
    };
    const template = await sent(e => insertClientGrant(sqlQueryForEngine(e), grant, plan.metadata));
    const member = await sent(e => e.insertOauthClientGrant(clientGrantInsert(grant, plan.metadata)));
    expect(template.length).toBe(1);
    expect(member).toEqual(template);
    expect(member[0].text).toBe(CREDENTIAL_SQL.client_grant_insert);
  });
});
