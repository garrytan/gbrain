import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { withTransportFixture, call } from '../fixtures/shared-skills-transports.ts';
import { SHARED_SKILLS_SCHEMA_SQL } from '../../src/core/shared-skills/schema-all.ts';

const databaseUrl = process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL;

(databaseUrl ? test : test.skip)('shared catalog and operational secrets are denied to a non-bypass database role', async () => {
  await withTransportFixture(async fixture => {
    await fixture.seed();
    const tables = ['shared_skill_state', 'shared_skill_policies', 'shared_skill_policy_audit', 'shared_skill_packs', 'shared_skill_heads',
      'shared_skill_revisions', 'shared_skill_revision_leases', 'shared_skill_members', 'shared_skill_delivery_batches', 'persistence_writer_protocols'];
    const role = `gbrain_skill_rls_${randomUUID().replaceAll('-', '')}`;
    await fixture.engine.executeRaw(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    try {
      await fixture.engine.executeRaw('DROP EVENT TRIGGER IF EXISTS auto_rls_on_create_table');
      for (const table of tables) await fixture.engine.executeRaw(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
      await fixture.engine.executeRaw(SHARED_SKILLS_SCHEMA_SQL);
      await fixture.engine.executeRaw(`GRANT USAGE ON SCHEMA public TO ${role}`);
      for (const table of tables) {
        const [state] = await fixture.engine.executeRaw<{ rowsecurity: boolean }>(
          'SELECT rowsecurity FROM pg_tables WHERE schemaname=current_schema() AND tablename=$1', [table]);
        expect(state?.rowsecurity, table).toBe(true);
        await fixture.engine.executeRaw(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
        await fixture.engine.executeRaw(`GRANT SELECT ON ${table} TO ${role}`);
      }
      expect((await fixture.engine.executeRaw('SELECT revision FROM shared_skill_revisions')).length).toBeGreaterThan(0);
      await fixture.engine.transaction(async tx => {
        await tx.executeRaw(`SET LOCAL ROLE ${role}`);
        const [effective] = await tx.executeRaw<{ rolsuper: boolean; rolbypassrls: boolean }>(
          'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
        expect(effective).toEqual({ rolsuper: false, rolbypassrls: false });
        for (const table of tables) expect(await tx.executeRaw(`SELECT * FROM ${table} LIMIT 1`), table).toEqual([]);
      });
      const authorized = await call<{ body: string }>(fixture.peers.reader.client, 'get_skill', { schema_version: 2, name: 'alpha' });
      expect(authorized.body).toContain('Original shared instructions');
    } finally {
      await fixture.engine.executeRaw(`DROP OWNED BY ${role}`);
      await fixture.engine.executeRaw(`DROP ROLE ${role}`);
    }
  }, databaseUrl!);
}, 120_000);
