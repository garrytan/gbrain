/**
 * oauth_client_scope_health (cathedral-6) — scoped-client grant hygiene.
 *
 * - (a) a federated read grant naming a nonexistent source (federated_read
 *   is a TEXT[] with no FK) → warn naming the client + the missing id.
 * - (b) an empty auto-created '<name>-workspace' source with no live client
 *   referencing it (the post-failure / post-revoke residue from
 *   `gbrain agent register`) → warn naming the source.
 * - A pages-bearing non-default source is NEVER flagged (that shape is
 *   every ordinary local brain, not residue).
 * - An empty workspace still referenced by a live client is NOT residue.
 * - Deleted clients (deleted_at set) don't produce dangling-grant warns.
 *
 * Hermetic via PGLite. Imports from doctor.ts (the façade re-export), same
 * as the sibling routing-federation check tests.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkOauthClientScopeHealth } from '../src/commands/doctor.ts';
import { DCR_PRIVILEGED_SCOPES } from '../src/commands/doctor/checks/routing-federation.ts';
import { ALLOWED_SCOPES_LIST, DCR_REGISTRABLE_SCOPES } from '../src/core/scope.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

async function truncate(): Promise<void> {
  for (const t of ['pages', 'facts', 'oauth_tokens', 'oauth_codes', 'oauth_clients']) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
  await (engine as any).db.exec(`DELETE FROM sources WHERE id <> 'default'`);
}

describe('checkOauthClientScopeHealth', () => {
  beforeEach(truncate);

  test('clean brain → ok', async () => {
    const r = await checkOauthClientScopeHealth(engine);
    expect(r.status).toBe('ok');
    expect(r.message).toMatch(/consistent/i);
  });

  test('dangling federated grant + orphaned empty workspace → both warn', async () => {
    // (a) live client granted a read on a source that no longer exists.
    await engine.executeRaw(
      `INSERT INTO oauth_clients (client_id, client_name, scope, federated_read)
       VALUES ('c-dangler', 'nova-daily', 'read write', $1)`,
      [['default', 'ghost-source']],
    );
    // (b) empty derived workspace, DB-only, referenced by no live client.
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('aurora-coder-workspace', 'aurora-coder-workspace')`,
    );
    const r = await checkOauthClientScopeHealth(engine);
    expect(r.status).toBe('warn');
    // Arm (a): names the client and the missing grant id, with the rescope hint.
    expect(r.message).toMatch(/nova-daily/);
    expect(r.message).toMatch(/ghost-source/);
    expect(r.message).toMatch(/rescope-client/);
    // Arm (b): names the orphaned workspace, with the removal hint.
    expect(r.message).toMatch(/aurora-coder-workspace/);
    expect(r.message).toMatch(/gbrain sources remove/);
  });

  test('zero-page workspace WITH facts → NOT flagged (revoked agent memory, not residue)', async () => {
    // A revoked agent's workspace: the client row is gone, no pages were ever
    // written, but FACTS exist (the primary agent write lane). Recommending
    // `gbrain sources remove` here would cascade the facts away.
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('revoked-agent-workspace', 'revoked-agent-workspace')`,
    );
    await engine.executeRaw(
      `INSERT INTO facts (source_id, fact, source)
       VALUES ('revoked-agent-workspace', 'agent memory row', 'test')`,
    );
    const r = await checkOauthClientScopeHealth(engine);
    expect(r.status).toBe('ok');
    expect(r.message).not.toMatch(/revoked-agent-workspace/);
  });

  test('pages-bearing non-default source → NOT flagged', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('proj-widget-workspace', 'proj-widget-workspace')`,
    );
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
       VALUES ('p1', 'proj-widget-workspace', 'note', 'p1', '', '')`,
    );
    const r = await checkOauthClientScopeHealth(engine);
    expect(r.status).toBe('ok');
  });

  test('empty workspace referenced by a live client → NOT flagged', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('aurora-coder-workspace', 'aurora-coder-workspace')`,
    );
    await engine.executeRaw(
      `INSERT INTO oauth_clients (client_id, client_name, scope, source_id, federated_read)
       VALUES ('c-live', 'aurora-coder', 'read write', 'aurora-coder-workspace', $1)`,
      [['aurora-coder-workspace', 'default']],
    );
    const r = await checkOauthClientScopeHealth(engine);
    expect(r.status).toBe('ok');
  });

  test('deleted client with a dangling grant → NOT flagged', async () => {
    await engine.executeRaw(
      `INSERT INTO oauth_clients (client_id, client_name, scope, federated_read, deleted_at)
       VALUES ('c-deleted', 'retired-agent', 'read', $1, now())`,
      [['ghost-source']],
    );
    const r = await checkOauthClientScopeHealth(engine);
    expect(r.status).toBe('ok');
  });

  // (c) Privileged self-registered clients. A row created through the
  // anonymous DCR path carries grant_revision = 0 and no oauth_grant_audit
  // 'register' row (operator paths write one). Rows that hold a scope beyond
  // the DCR ceiling with that signature predate the ceiling (or predate the
  // grant audit log) and deserve an operator look — advisory WARN with the
  // rescope / revoke remedy.
  describe('privileged self-registered (DCR-signature) clients', () => {
    async function seedClient(id: string, scope: string, opts: { audited?: boolean; revision?: number; deleted?: boolean } = {}): Promise<void> {
      await engine.executeRaw(
        `INSERT INTO oauth_clients (client_id, client_name, scope, source_id, federated_read, grant_revision, deleted_at)
         VALUES ($1, $2, $3, 'default', $4, $5, ${opts.deleted ? 'now()' : 'NULL'})`,
        [id, `${id}-name`, scope, ['default'], opts.revision ?? 0],
      );
      if (opts.audited) {
        await engine.executeRaw(
          `INSERT INTO oauth_grant_audit (client_id, actor, action, revision, before_grant, after_grant)
           VALUES ($1, 'operator', 'register', 0, NULL, '{}'::jsonb)`,
          [id],
        );
      }
    }

    beforeEach(async () => {
      await (engine as any).db.exec('DELETE FROM oauth_grant_audit');
    });

    test('admin-scoped DCR-signature row → warn naming the client + rescope/revoke remedy', async () => {
      await seedClient('c-dcr-admin', 'read admin');
      const r = await checkOauthClientScopeHealth(engine);
      expect(r.status).toBe('warn');
      expect(r.message).toMatch(/c-dcr-admin/);
      expect(r.message).toMatch(/admin/);
      expect(r.message).toMatch(/rescope-client <client_id> --scopes read,write|rescope-client .*--scopes/);
      expect(r.message).toMatch(/revoke-client/);
    });

    test('sources_admin and users_admin also trip the arm; the client name is shown', async () => {
      await seedClient('c-dcr-sources', 'sources_admin');
      await seedClient('c-dcr-users', 'read users_admin');
      const r = await checkOauthClientScopeHealth(engine);
      expect(r.status).toBe('warn');
      expect(r.message).toMatch(/c-dcr-sources-name/);
      expect(r.message).toMatch(/c-dcr-users-name/);
    });

    test('read/write DCR-signature rows are within the ceiling → NOT flagged', async () => {
      await seedClient('c-dcr-rw', 'read write');
      await seedClient('c-dcr-empty', '');
      const r = await checkOauthClientScopeHealth(engine);
      expect(r.status).toBe('ok');
    });

    test('operator-registered admin client (audit register row) → NOT flagged', async () => {
      await seedClient('c-op-admin', 'admin', { audited: true });
      const r = await checkOauthClientScopeHealth(engine);
      expect(r.status).toBe('ok');
    });

    test('rescoped admin client (grant_revision > 0) → NOT flagged', async () => {
      await seedClient('c-rescoped-admin', 'admin', { revision: 2 });
      const r = await checkOauthClientScopeHealth(engine);
      expect(r.status).toBe('ok');
    });

    test('revoked (deleted_at) DCR-signature admin row → NOT flagged', async () => {
      await seedClient('c-dcr-revoked', 'admin', { deleted: true });
      const r = await checkOauthClientScopeHealth(engine);
      expect(r.status).toBe('ok');
    });

    test('grant audit table missing → arm skipped with an explicit note, other arms intact', async () => {
      await seedClient('c-dcr-admin-noaudit', 'admin');
      await (engine as any).db.exec('DROP TABLE oauth_grant_audit');
      try {
        const r = await checkOauthClientScopeHealth(engine);
        // Fail-open: cannot tell operator rows from self-registered ones
        // without the audit log, so the arm reports unknown instead of
        // guessing — and says so.
        expect(r.status).toBe('ok');
        expect(r.message).toMatch(/self-registered.*(skipped|unknown)|(skipped|unknown).*self-registered/i);
      } finally {
        const { GRANT_AUDIT_SCHEMA_SQL } = await import('../src/core/grants/schema.ts');
        await (engine as any).db.exec(GRANT_AUDIT_SCHEMA_SQL);
      }
    });
  });
});

// Arm (c) edge shapes not pinned above: the `agent` scope (seeded with the
// delegation bindings its check constraint demands), the 5-client display cap
// with its "+N more" tail, and the word-bounded scope match (a token that
// merely CONTAINS a privileged word is not one).
describe('checkOauthClientScopeHealth — arm (c) edge shapes', () => {
  async function seed(id: string, scope: string): Promise<void> {
    await engine.executeRaw(
      `INSERT INTO oauth_clients (client_id, client_name, scope, source_id, federated_read, grant_revision, deleted_at)
       VALUES ($1, $2, $3, 'default', $4, 0, NULL)`,
      [id, `${id}-name`, scope, ['default']],
    );
  }

  beforeEach(async () => {
    await truncate();
    await (engine as any).db.exec('DELETE FROM oauth_grant_audit');
  });

  test('agent-scoped DCR-signature row is flagged (agent sits beyond the ceiling too)', async () => {
    // `oauth_clients_complete_agent_grant` (grants/schema.ts) refuses an agent
    // scope without complete delegation bindings — seed a complete one.
    await engine.executeRaw(
      `INSERT INTO oauth_clients (client_id, client_name, scope, source_id, federated_read, grant_revision, deleted_at,
                                  bound_tools, bound_source_id, delegated_namespace, delegated_slug_prefixes, bound_max_concurrent)
       VALUES ('c-dcr-agent', 'c-dcr-agent-name', 'read agent', 'default', $1, 0, NULL,
               $2, 'default', 'job', NULL, 1)`,
      [['default'], ['get_page']],
    );
    const r = await checkOauthClientScopeHealth(engine);
    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/c-dcr-agent/);
    expect(r.message).toContain('scope=read agent');
  });

  // (client_name is NOT NULL in the schema, so the `?? client_id` display
  // fallback cannot be reached through the database — not pinned here.)

  test('more than five offenders: five shown (ordered by client_id), the rest counted', async () => {
    for (let i = 0; i < 7; i++) await seed(`c-dcr-many-${i}`, 'admin');
    const r = await checkOauthClientScopeHealth(engine);
    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/^7 active OAuth client\(s\)/);
    for (let i = 0; i < 5; i++) expect(r.message).toContain(`(c-dcr-many-${i})`);
    expect(r.message).not.toContain('(c-dcr-many-5)');
    expect(r.message).not.toContain('(c-dcr-many-6)');
    expect(r.message).toContain('(+2 more)');
  });

  test('a scope token that merely CONTAINS a privileged word is not flagged (word-bounded match)', async () => {
    await seed('c-dcr-substring', 'readmin write');
    const r = await checkOauthClientScopeHealth(engine);
    expect(r.status).toBe('ok');
  });

  test('grant_revision column missing → arm skipped with the explicit note, other arms intact', async () => {
    // A brain whose oauth_clients predates the grant schema: the DCR
    // signature cannot be evaluated, so the arm reports unknown (ok + note)
    // rather than guessing — even with an admin-scoped row present.
    await (engine as any).db.exec('ALTER TABLE oauth_clients DROP COLUMN grant_revision');
    try {
      await engine.executeRaw(
        `INSERT INTO oauth_clients (client_id, client_name, scope, source_id, federated_read, deleted_at)
         VALUES ('c-dcr-norev', 'c-dcr-norev-name', 'admin', 'default', $1, NULL)`,
        [['default']],
      );
      const r = await checkOauthClientScopeHealth(engine);
      expect(r.status).toBe('ok');
      expect(r.message).toMatch(/self-registered.*(skipped|unknown)|(skipped|unknown).*self-registered/i);
      expect(r.message).not.toMatch(/c-dcr-norev/);
    } finally {
      await (engine as any).db.exec('ALTER TABLE oauth_clients ADD COLUMN grant_revision integer NOT NULL DEFAULT 0');
    }
  });
});

// The privileged set arm (c) matches is DERIVED from scope.ts (the complement
// of the DCR ceiling), never a hand-copied literal — so a scope added to
// ALLOWED_SCOPES_LIST without joining DCR_REGISTRABLE_SCOPES is audited
// automatically, and the copy names the ceiling from the same constant.
describe('checkOauthClientScopeHealth — arm (c) privileged set is the derived complement of the DCR ceiling', () => {
  const complement = ALLOWED_SCOPES_LIST.filter((s) => !DCR_REGISTRABLE_SCOPES.has(s));

  test('DCR_PRIVILEGED_SCOPES === ALLOWED_SCOPES_LIST \\ DCR_REGISTRABLE_SCOPES (disjoint, jointly exhaustive)', () => {
    expect([...DCR_PRIVILEGED_SCOPES]).toEqual(complement);
    expect(DCR_PRIVILEGED_SCOPES.length).toBeGreaterThan(0);
    for (const s of DCR_PRIVILEGED_SCOPES) expect(DCR_REGISTRABLE_SCOPES.has(s as any)).toBe(false);
    expect([...DCR_PRIVILEGED_SCOPES, ...DCR_REGISTRABLE_SCOPES].sort()).toEqual([...ALLOWED_SCOPES_LIST].sort());
  });

  /** Seed a DCR-signature row; `agent` needs complete delegation bindings (check constraint). */
  async function seedDcrSignature(id: string, scope: string): Promise<void> {
    if (scope.split(' ').includes('agent')) {
      await engine.executeRaw(
        `INSERT INTO oauth_clients (client_id, client_name, scope, source_id, federated_read, grant_revision, deleted_at,
                                    bound_tools, bound_source_id, delegated_namespace, delegated_slug_prefixes, bound_max_concurrent)
         VALUES ($1, $2, $3, 'default', $4, 0, NULL, $5, 'default', 'job', NULL, 1)`,
        [id, `${id}-name`, scope, ['default'], ['get_page']],
      );
      return;
    }
    await engine.executeRaw(
      `INSERT INTO oauth_clients (client_id, client_name, scope, source_id, federated_read, grant_revision, deleted_at)
       VALUES ($1, $2, $3, 'default', $4, 0, NULL)`,
      [id, `${id}-name`, scope, ['default']],
    );
  }

  beforeEach(async () => {
    await truncate();
    await (engine as any).db.exec('DELETE FROM oauth_grant_audit');
  });

  test('every scope in the complement trips the arm on its own; every ceiling scope does not', async () => {
    for (const scope of complement) {
      await (engine as any).db.exec('DELETE FROM oauth_clients');
      await seedDcrSignature(`c-dcr-${scope}`, scope);
      const r = await checkOauthClientScopeHealth(engine);
      expect(r.status).toBe('warn');
      expect(r.message).toContain(`(c-dcr-${scope}) scope=${scope}`);
    }
    for (const scope of DCR_REGISTRABLE_SCOPES) {
      await (engine as any).db.exec('DELETE FROM oauth_clients');
      await seedDcrSignature(`c-dcr-${scope}`, scope);
      const r = await checkOauthClientScopeHealth(engine);
      expect(r.status).toBe('ok');
    }
  });

  test('the remedy copy names the ceiling from the constant, not a literal', async () => {
    await seedDcrSignature('c-dcr-copy', complement[0]);
    const r = await checkOauthClientScopeHealth(engine);
    const ceiling = [...DCR_REGISTRABLE_SCOPES];
    expect(r.message).toContain(`self-registration ceiling (${ceiling.join('/')})`);
    expect(r.message).toContain(`--scopes ${ceiling.join(',')}`);
  });
});
