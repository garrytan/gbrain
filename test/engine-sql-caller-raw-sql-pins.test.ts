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
    from: 'src/core/access/caller.ts:168 folderAccessForAll (rules, then coverage; at 949a7c98cc)',
    case: { method: 'readFolderAccess', variant: 'readers', run: e => e.readFolderAccess(['member:alice-example', 'group:team-a']) },
    texts: ['SELECT source_id, rule_id, readable_by FROM access_rules WHERE readable_by && $1::text[]', `SELECT * FROM (SELECT DISTINCT source_id, prefix FROM access_pending_coverage
      UNION ALL SELECT '!unreadable', '' WHERE gbrain_access_state_unreadable()) c ORDER BY source_id, prefix`],
  },
  {
    from: 'src/core/access/caller.ts:171 folderAccessForAll (no readers reads the coverage only; at 949a7c98cc)',
    case: { method: 'readFolderAccess', variant: 'no-readers', run: e => e.readFolderAccess([]) },
    texts: [`SELECT * FROM (SELECT DISTINCT source_id, prefix FROM access_pending_coverage
      UNION ALL SELECT '!unreadable', '' WHERE gbrain_access_state_unreadable()) c ORDER BY source_id, prefix`],
  },
  {
    from: 'src/core/access/policy.ts:92 readAccessStore (at 6e123afe98)',
    case: { method: 'readAccessStoreConfig', variant: 'default', run: e => e.readAccessStoreConfig('src-a') },
    texts: [`SELECT config->>'access_store' AS store FROM sources WHERE id = $1`],
  },
  {
    from: 'src/core/access/policy.ts:99 writeAccessStore (at 6e123afe98)',
    case: { method: 'writeAccessStoreConfig', variant: 'default', run: e => e.writeAccessStoreConfig('src-a', 'database') },
    texts: [`UPDATE sources SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{access_store}', to_jsonb($2::text)) WHERE id = $1`],
  },
  {
    from: 'src/core/access/policy.ts:104 ensurePolicyState (at 6e123afe98)',
    case: { method: 'ensureAccessPolicyState', variant: 'default', run: e => e.ensureAccessPolicyState('src-a') },
    texts: ['INSERT INTO access_policy_state (source_id) VALUES ($1) ON CONFLICT (source_id) DO NOTHING'],
  },
  {
    from: 'src/core/access/policy.ts:112 and :113 lockSource (at 6e123afe98)',
    case: { method: 'lockAccessPolicy', variant: 'default', run: e => e.lockAccessPolicy('src-a') },
    texts: ['SELECT 1 FROM sources WHERE id = $1 FOR NO KEY UPDATE', 'SELECT 1 FROM access_policy_state WHERE source_id = $1 FOR UPDATE'],
  },
  {
    from: 'src/core/access/policy.ts:117 appliedRules (at 6e123afe98)',
    case: { method: 'listAccessRules', variant: 'default', run: e => e.listAccessRules('src-a') },
    texts: ['SELECT rule_id, prefix, readable_by, covers_derived FROM access_rules WHERE source_id = $1 ORDER BY rule_id'],
  },
  {
    from: 'src/core/access/policy.ts:123 listRevisions (at 6e123afe98)',
    case: { method: 'readAccessPolicyRevisions', variant: 'recent', run: e => e.readAccessPolicyRevisions({ by: 'recent', sourceId: 'src-a', limit: 50 }) },
    texts: ['SELECT * FROM access_policy_revisions WHERE source_id = $1 ORDER BY revision DESC LIMIT $2'],
  },
  {
    from: 'src/core/access/policy.ts:130 getRevision (latest) (at 6e123afe98)',
    case: { method: 'readAccessPolicyRevisions', variant: 'latest', run: e => e.readAccessPolicyRevisions({ by: 'latest', sourceId: 'src-a' }) },
    texts: ['SELECT * FROM access_policy_revisions WHERE source_id = $1 ORDER BY revision DESC LIMIT 1'],
  },
  {
    from: 'src/core/access/policy.ts:131 getRevision (one revision) (at 6e123afe98)',
    case: { method: 'readAccessPolicyRevisions', variant: 'revision', run: e => e.readAccessPolicyRevisions({ by: 'revision', sourceId: 'src-a', revision: 2 }) },
    texts: ['SELECT * FROM access_policy_revisions WHERE source_id = $1 AND revision = $2'],
  },
  {
    from: 'src/core/access/policy.ts:246 proposeRevision (idempotency read) (at 6e123afe98)',
    case: { method: 'readAccessPolicyRevisions', variant: 'operation', run: e => e.readAccessPolicyRevisions({ by: 'operation', operationId: 'op-1' }) },
    texts: ['SELECT * FROM access_policy_revisions WHERE operation_id = $1'],
  },
  {
    from: 'src/core/access/policy.ts:136 coverageRows (at 6e123afe98)',
    case: { method: 'listAccessCoverage', variant: 'default', run: e => e.listAccessCoverage('src-a') },
    texts: ['SELECT prefix, reason, revision, detail FROM access_pending_coverage WHERE source_id = $1 ORDER BY reason, prefix'],
  },
  {
    from: 'src/core/access/policy.ts:151 requireReadableAccessState (at 6e123afe98)',
    case: { method: 'readAccessStateUnreadable', variant: 'default', run: e => e.readAccessStateUnreadable() },
    texts: ['SELECT gbrain_access_state_unreadable() AS unreadable'],
  },
  {
    from: 'src/core/access/policy.ts:168, :174 and :179 installRulebook (at 6e123afe98)',
    case: { method: 'applyAccessRuleChanges', variant: 'default', run: e => e.applyAccessRuleChanges('src-a', { remove: ['old'], insert: [{ rule_id: 'team', prefix: 'team/', readable_by: ['member:alice-example'], covers_derived: true }], pending: ['team/'], revision: 2, actor: 'cli' }) },
    texts: ['DELETE FROM access_rules WHERE source_id = $1 AND rule_id = $2', 'INSERT INTO access_rules (source_id, rule_id, prefix, readable_by, revision, created_by, covers_derived) VALUES ($1, $2, $3, $4::text[], $5, $6, $7)', `INSERT INTO access_pending_coverage (source_id, prefix, reason, revision) VALUES ($1, $2, 'pending', $3)
      ON CONFLICT (source_id, prefix, reason) DO UPDATE SET revision = EXCLUDED.revision`],
  },
  {
    from: 'src/core/access/policy.ts:198 restampSource (batched window) (at 6e123afe98)',
    case: { method: 'restampAccessWindow', variant: 'default', run: e => e.restampAccessWindow('src-a', 0, 2000) },
    texts: [`WITH w AS (SELECT id FROM pages WHERE source_id = $1 AND id > $2 ORDER BY id LIMIT $3),
        u AS (UPDATE pages p SET folder_rule_ids = gbrain_access_folder_rules(p.source_id, p.slug) FROM w
              WHERE p.id = w.id AND p.folder_rule_ids IS DISTINCT FROM gbrain_access_folder_rules(p.source_id, p.slug) RETURNING p.id)
      SELECT (SELECT max(id) FROM w) AS last, (SELECT count(*) FROM w)::int AS scanned, (SELECT count(*) FROM u)::int AS changed`],
  },
  {
    from: 'src/core/access/policy.ts:212, :216 and :217 restampSource (final pass) (at 6e123afe98)',
    case: { method: 'finishAccessRestamp', variant: 'default', run: e => e.finishAccessRestamp('src-a') },
    texts: [`UPDATE pages SET folder_rule_ids = gbrain_access_folder_rules(source_id, slug)
        WHERE source_id = $1 AND folder_rule_ids IS DISTINCT FROM gbrain_access_folder_rules(source_id, slug) RETURNING id`, `DELETE FROM access_pending_coverage WHERE source_id = $1 AND reason = 'pending'`, 'UPDATE access_policy_revisions SET applied_at = now() WHERE source_id = $1 AND applied_at IS NULL'],
  },
  {
    from: 'src/core/access/policy.ts:263 proposeRevision (revision insert) (at 6e123afe98)',
    case: { method: 'insertAccessPolicyRevision', variant: 'default', run: e => e.insertAccessPolicyRevision({ source_id: 'src-a', revision: 2, rules: [], digest: 'd', change_kind: 'narrowing', origin: 'cli', operation_id: null, proposed_by: 'cli', approved_by: 'auto:narrowing', approved: true }) },
    texts: [`INSERT INTO access_policy_revisions (source_id, revision, rules, digest, change_kind, origin, operation_id, proposed_by, approved_by, approved_at)
      VALUES ($1, $2, $3::text::jsonb, $4, $5, $6, $7, $8, $9, CASE WHEN $10::boolean THEN now() END)`],
  },
  {
    from: 'src/core/access/policy.ts:268 proposeRevision (applied mark) (at 6e123afe98)',
    case: { method: 'markAccessRevisionsApplied', variant: 'all', run: e => e.markAccessRevisionsApplied('src-a') },
    texts: ['UPDATE access_policy_revisions SET applied_at = now() WHERE source_id = $1 AND applied_at IS NULL'],
  },
  {
    from: 'src/core/access/policy.ts:388 applyApproved (applied mark) (at 6e123afe98)',
    case: { method: 'markAccessRevisionsApplied', variant: 'up-to', run: e => e.markAccessRevisionsApplied('src-a', 3) },
    texts: ['UPDATE access_policy_revisions SET applied_at = now() WHERE source_id = $1 AND applied_at IS NULL AND revision <= $2'],
  },
  {
    from: 'src/core/access/policy.ts:387 applyApproved (approval) (at 6e123afe98)',
    case: { method: 'approveAccessPolicyRevision', variant: 'default', run: e => e.approveAccessPolicyRevision('src-a', 3, 'cli') },
    texts: ['UPDATE access_policy_revisions SET approved_by = $3, approved_at = now() WHERE source_id = $1 AND revision = $2'],
  },
  {
    from: 'src/core/access/policy.ts:296 resumePolicy (at 6e123afe98)',
    case: { method: 'hasAccessPolicyState', variant: 'default', run: e => e.hasAccessPolicyState('src-a') },
    texts: ['SELECT count(*)::int AS n FROM access_policy_state WHERE source_id = $1'],
  },
  {
    from: 'src/core/access/policy.ts:348 previewApply (derived release) (at 6e123afe98)',
    case: { method: 'listAccessPrefixSlugs', variant: 'one-prefix', run: e => e.listAccessPrefixSlugs('src-a', 'team/') },
    texts: ['SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND starts_with(slug, $2) ORDER BY slug'],
  },
  {
    from: 'src/core/access/policy.ts:354 previewApply (widened prefixes) (at 6e123afe98)',
    case: { method: 'listAccessPrefixSlugs', variant: 'prefixes', run: e => e.listAccessPrefixSlugs('src-a', ['team/', 'old/']) },
    texts: ['SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM unnest($2::text[]) AS pfx WHERE starts_with(slug, pfx)) ORDER BY slug'],
  },
  {
    from: 'src/core/access/policy.ts:420 policyStatus (at 6e123afe98)',
    case: { method: 'readAccessPolicyMarks', variant: 'default', run: e => e.readAccessPolicyMarks('src-a') },
    texts: ['SELECT max(revision) FILTER (WHERE applied_at IS NOT NULL) AS applied, max(revision) FILTER (WHERE approved_at IS NOT NULL) AS approved FROM access_policy_revisions WHERE source_id = $1'],
  },
  {
    from: 'src/core/access/policy.ts:420 and :431 policyStatus (with an operation) (at 6e123afe98)',
    case: { method: 'readAccessPolicyMarks', variant: 'operation', run: e => e.readAccessPolicyMarks('src-a', 'op-1') },
    texts: ['SELECT max(revision) FILTER (WHERE applied_at IS NOT NULL) AS applied, max(revision) FILTER (WHERE approved_at IS NOT NULL) AS approved FROM access_policy_revisions WHERE source_id = $1', 'SELECT revision, applied_at, approved_at FROM access_policy_revisions WHERE source_id = $1 AND operation_id = $2'],
  },
  {
    from: 'src/core/access/policy.ts:450 and :452 markPolicyInvalid (at 6e123afe98)',
    case: { method: 'replaceAccessInvalidCoverage', variant: 'prefixes', run: e => e.replaceAccessInvalidCoverage('src-a', ['bad/'], { line: 3 }) },
    texts: [`DELETE FROM access_pending_coverage WHERE source_id = $1 AND reason = 'invalid'`, `INSERT INTO access_pending_coverage (source_id, prefix, reason, detail) VALUES ($1, $2, 'invalid', $3::text::jsonb)`],
  },
  {
    from: 'src/core/access/policy.ts:459 clearPolicyInvalid (at 6e123afe98)',
    case: { method: 'replaceAccessInvalidCoverage', variant: 'clear', run: e => e.replaceAccessInvalidCoverage('src-a', [], null) },
    texts: [`DELETE FROM access_pending_coverage WHERE source_id = $1 AND reason = 'invalid'`],
  },
  {
    from: 'src/core/access/members.ts:124 getMember (one member by id)',
    case: { method: 'readAccessMembers', variant: 'by-id', run: e => e.readAccessMembers({ id: 'alice-example' }) },
    texts: [`SELECT m.id, m.display_name, m.email, m.kind, m.labelled_only, m.disabled_at, m.tombstoned_at, m.created_at,
  COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id WHERE m.id = $1 GROUP BY m.id`],
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
    from: 'src/commands/access-serves.ts:135 unboundCredentials (tokens) (at 6e123afe98)',
    case: { method: 'listUnboundTokenNames', variant: 'default', run: e => e.listUnboundTokenNames() },
    texts: ['SELECT DISTINCT name FROM access_tokens WHERE revoked_at IS NULL AND member_id IS NULL ORDER BY name'],
  },
  {
    from: 'src/commands/access-serves.ts:136 unboundCredentials (clients) (at 6e123afe98)',
    case: { method: 'listUnboundClientIds', variant: 'default', run: e => e.listUnboundClientIds() },
    texts: ['SELECT client_id FROM oauth_clients WHERE deleted_at IS NULL AND member_id IS NULL ORDER BY client_id'],
  },
  {
    from: 'src/commands/access-serves.ts:186 member key plan (live token) (at 6e123afe98)',
    case: { method: 'readLiveAccessToken', variant: 'default', run: e => e.readLiveAccessToken('member-alice-example') },
    texts: ['SELECT member_id, token_hash, source_grant, source_id, federated_read, permissions FROM access_tokens WHERE name = $1 AND revoked_at IS NULL'],
  },
  {
    from: 'src/commands/access-serves.ts:197 member key plan (active sources) (at 6e123afe98)',
    case: { method: 'listUnarchivedSourceIds', variant: 'default', run: e => e.listUnarchivedSourceIds(['src-a', 'src-b']) },
    texts: ['SELECT id FROM sources WHERE id = ANY($1::text[]) AND archived IS NOT TRUE'],
  },
  {
    from: 'src/commands/access-serves.ts:241 recordSetupReads (at 6e123afe98)',
    case: { method: 'recordTokenSetupReads', variant: 'default', run: e => e.recordTokenSetupReads('member-alice-example', ['src-a']) },
    texts: ["UPDATE access_tokens SET permissions = COALESCE(permissions, '{}'::jsonb) || jsonb_build_object('setup_reads', $2::text[]) WHERE name = $1 AND revoked_at IS NULL AND (permissions IS NULL OR jsonb_typeof(permissions) = 'object')"],
  },
  {
    from: 'src/commands/access-serves.ts:251 keysStillReading (at 6e123afe98)',
    case: { method: 'listKeysReadingSource', variant: 'default', run: e => e.listKeysReadingSource('src-a') },
    texts: ["SELECT name, member_id, federated_read FROM access_tokens WHERE revoked_at IS NULL AND member_id IS NOT NULL AND source_grant = 'federated' AND source_id <> $1 AND $1 = ANY(federated_read) ORDER BY name"],
  },
  {
    from: 'src/commands/access-serves.ts:265 companyCounts (at 6e123afe98)',
    case: { method: 'countCompanyPages', variant: 'default', run: e => e.countCompanyPages('company') },
    texts: ["SELECT count(*)::int AS pages, count(*) FILTER (WHERE slug LIKE 'company/calls/%')::int AS calls FROM pages WHERE source_id = $1 AND deleted_at IS NULL"],
  },
  {
    from: 'src/commands/access-serves.ts:339 serves key mint (revoke on a failed key file) (at 6e123afe98)',
    case: { method: 'revokeAccessTokenById', variant: 'default', run: e => e.revokeAccessTokenById('00000000-0000-0000-0000-000000000001') },
    texts: ['UPDATE access_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL'],
  },
  {
    from: 'src/core/access/policy-migrate.ts:41 unfinished (at 6e123afe98)',
    case: { method: 'readUnfinishedAccessMigration', variant: 'default', run: e => e.readUnfinishedAccessMigration('src-a') },
    texts: ["SELECT id, phase, direction, receipts FROM access_policy_migrations WHERE source_id = $1 AND phase <> 'switched' ORDER BY created_at DESC LIMIT 1"],
  },
  {
    from: 'src/core/access/policy-migrate.ts:80 migratePolicyStore (start) (at 6e123afe98)',
    case: { method: 'insertAccessMigration', variant: 'default', run: e => e.insertAccessMigration('mig_1', 'src-a', 'to_git') },
    texts: ["INSERT INTO access_policy_migrations (id, source_id, direction, phase) VALUES ($1, $2, $3, 'started')"],
  },
  {
    from: 'src/core/access/policy-migrate.ts:85 migratePolicyStore (record a phase) (at 6e123afe98)',
    case: { method: 'recordAccessMigrationPhase', variant: 'default', run: e => e.recordAccessMigrationPhase('mig_1', 'exported', { approved: 'abc' }) },
    texts: ['UPDATE access_policy_migrations SET phase = $2, receipts = $3::text::jsonb, updated_at = now() WHERE id = $1'],
  },
  {
    from: 'src/core/access/policy-migrate.ts:104 migratePolicyStore (switch) (at 6e123afe98)',
    case: { method: 'switchAccessMigration', variant: 'default', run: e => e.switchAccessMigration('mig_1', { approved: 'abc' }) },
    texts: ["UPDATE access_policy_migrations SET phase = 'switched', receipts = $2::text::jsonb, updated_at = now() WHERE id = $1"],
  },
  {
    from: 'src/core/access/policy-transfer.ts:34 exportPolicyFiles (at 6e123afe98)',
    case: { method: 'listAccessPolicySources', variant: 'default', run: e => e.listAccessPolicySources() },
    texts: ['SELECT source_id FROM access_policy_state ORDER BY source_id'],
  },
  {
    from: 'src/core/access/serves.ts:38 unlabeledPeopleFolders (at 6e123afe98)',
    case: { method: 'countPeopleFolderPages', variant: 'default', run: e => e.countPeopleFolderPages() },
    texts: [`SELECT source_id, split_part(slug, '/', 2) AS folder, count(*)::int AS pages FROM pages
      WHERE deleted_at IS NULL AND slug LIKE 'people/%/%' GROUP BY 1, 2 ORDER BY 1, 2`],
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
