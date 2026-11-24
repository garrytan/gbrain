/**
 * owner_only_marks_triggers names the connected login in its fix when a delete trigger is missing on a table that login
 * does not own (src/commands/doctor/checks/owner-only-marks-triggers.ts: `ALTER TABLE public.<t> OWNER TO <role>`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the fix line names the login the check ran as (`quote_ident(current_user)`), the table's owner, and the
 *    table, and the check fails with no automatic fix.
 *  - Regression: a fix line that names a fixed role (`postgres`) tells an operator connected as another login to give
 *    the table to the wrong role.
 *  - Why existing coverage misses it: test/engine-parity/doctor-join-checks.test.ts compares the healthy output, which
 *    never prints the role, and leaves the role out of the state it compares (it is the login name: gbrain_test on CI
 *    Postgres, postgres elsewhere). No test reached this message.
 *  - Seam: inside one transaction, the superuser test login creates a table owner role and a login role, gives `takes`
 *    to the owner role, drops its delete trigger, then `SET LOCAL ROLE`s to the login role (granted the reads the check
 *    makes, BYPASSRLS so row-level security does not hide them) and runs the check; the transaction rolls back, so the
 *    roles, the owner change and the dropped trigger are undone. The expected role is read in the same transaction.
 *  - Rust: a Rust brain cannot reach this path. The store keeps no SQL triggers, so `missing` is always [] there
 *    (store-members/owner-only-marks.ts), and it has no logins. This case runs on PGLite and Postgres only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { Check } from '../src/commands/doctor.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { ownerOnlyMarksTriggersEntry } from '../src/commands/doctor/checks/owner-only-marks-triggers.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

class Rollback extends Error { constructor(readonly value: { check: Check; role: string; owner: string }) { super('rollback'); } }

for (const backend of testBackends()) {
  describe(`owner_only_marks_triggers fix line names the connected login (${backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const pg = new PGLiteEngine(); await pg.connect({ engine: 'pglite' } as never); await pg.initSchema(); engine = pg; close = () => pg.disconnect(); }
    }, 120_000);
    afterAll(async () => { await close?.(); }, 60_000);

    test('a missing trigger on a table the login does not own: fail, with ALTER TABLE ... OWNER TO the login', async () => {
      const tag = randomUUID().replace(/-/g, '').slice(0, 12);
      const owner = `gbrain_parity_owner_${tag}`;
      const login = `gbrain_parity_login_${tag}`;
      const seen = await engine.transaction(async (tx) => {
        await tx.executeRaw(`CREATE ROLE ${owner} NOLOGIN`);
        await tx.executeRaw(`CREATE ROLE ${login} NOLOGIN BYPASSRLS`);
        await tx.executeRaw(`GRANT SELECT ON config, owner_only_marks TO ${login}`);
        await tx.executeRaw(`ALTER TABLE takes OWNER TO ${owner}`);
        await tx.executeRaw('DROP TRIGGER gbrain_owner_only_row_deleted_trg ON takes');
        await tx.executeRaw(`SET LOCAL ROLE ${login}`);
        const [{ role }] = await tx.executeRaw<{ role: string }>('SELECT quote_ident(current_user) AS role');
        const ctx = { engine: tx, progress: { heartbeat: () => undefined } } as unknown as DoctorContext;
        const checks = await ownerOnlyMarksTriggersEntry.run(ctx);
        if (!Array.isArray(checks)) throw new Error('owner_only_marks_triggers stopped doctor');
        throw new Rollback({ check: checks[0]!, role: role!, owner });
      }).then(() => null, (e: unknown) => { if (e instanceof Rollback) return e.value; throw e; });
      expect(seen).not.toBeNull();
      const { check, role } = seen!;
      expect(role).toBe(login);
      expect(check.status).toBe('fail');
      expect(check.fix_unavailable_reason).toBe('no_safe_automatic_fix');
      expect(check.message).toContain(`1 owner-only delete trigger(s) are missing or disabled (takes (owner ${owner}))`);
      expect(check.message).toContain(`connected as ${owner}, run gbrain apply-migrations --force-schema, or run ALTER TABLE public.takes OWNER TO ${role};`);
      expect((check.details as { sql: string[] }).sql).toEqual([`ALTER TABLE public.takes OWNER TO ${role};`]);
      // The rollback undid the roles, the owner change and the dropped trigger.
      const after = await engine.ownerOnlyMarkTriggers();
      expect(after.missing).toEqual([]);
      expect(await engine.executeRaw('SELECT 1 FROM pg_roles WHERE rolname IN ($1, $2)', [owner, login])).toEqual([]);
    }, 120_000);
  });
}
