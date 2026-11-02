/**
 * GBRA-218 (A2) folder rules under a scoped database role. The folder-rule stamp and the pending-coverage reads run as
 * the role doing the write or read. A role that neither owns the access tables nor bypasses RLS read them empty: a page
 * written under a ruled prefix was stamped with no rule and read remotely as unruled, and a prefix still being narrowed
 * stayed visible. Contract: an access table that row-level security hides from the role is never read as "no rule".
 * The stamp refuses the write (writer_coordinator_required, unreadable_state) and every pending-coverage read covers
 * everything. A role holding the docs/ENGINES.md access recipe (applied verbatim) gets the correct stamp and the
 * normal read. Postgres only (PGLite has no roles): it runs in the unit-lane PostgreSQL arms (test/postgres-unit-arms.txt).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { BrainEngine } from '../src/core/engine.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { folderAccessFor } from '../src/core/access/caller.ts';
import { restampSource } from '../src/core/access/policy.ts';
import { folderRestricted, folderRulesAllowedSql, withCallerAccess } from '../src/core/search/private-visibility.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const SCOPED = `gbrain_access_scoped_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const ACCESS_TABLES = ['access_policy_state', 'access_rules', 'access_pending_coverage'];
const UNREADABLE = /writer_coordinator_required: writer state is unreadable to this database role/;
const ALICE = ['member:alice-example'];

/** The SQL between the access recipe markers in docs/ENGINES.md, for `role`. */
function docsRecipe(role: string): string {
  // test-reads-source-ok[structural]: the operator recipe is applied verbatim, so the documented policies are the tested ones.
  const doc = readFileSync(new URL('../docs/ENGINES.md', import.meta.url), 'utf8');
  const block = /<!-- gbrain:access-rls-recipe:begin[^>]*-->\s*```sql\n([\s\S]*?)```\s*<!-- gbrain:access-rls-recipe:end -->/.exec(doc);
  if (!block) throw new Error('docs/ENGINES.md has no access-rls-recipe block');
  return block[1]!.replaceAll('<writer-role>', role);
}

(testBackends().includes('postgres') ? describe : describe.skip)('folder rules under a scoped database role (Postgres)', () => {
  let engine: BrainEngine;
  let close: (() => Promise<void>) | undefined;
  let tables: string[] = [];

  /** Open policies for the scoped role on every table except `hidden`. */
  async function policies(hidden: string[]) {
    for (const table of tables) {
      await engine.executeRaw(`DROP POLICY IF EXISTS ${SCOPED}_open ON ${table}`);
      if (!hidden.includes(table)) await engine.executeRaw(`CREATE POLICY ${SCOPED}_open ON ${table} FOR ALL TO ${SCOPED} USING (true) WITH CHECK (true)`);
    }
  }
  /** Runs `fn` inside a transaction as the scoped role; the transaction rolls back. */
  async function asScoped<T>(fn: (tx: BrainEngine) => Promise<T>): Promise<{ value?: T; error?: string; state?: string }> {
    const marker = new Error('scoped-probe-rollback');
    let value: T | undefined;
    try {
      await engine.transaction(async tx => {
        await tx.executeRaw(`SET LOCAL ROLE ${SCOPED}`);
        await tx.executeRaw(`SELECT set_config('gbrain.write_principal_kind','application',true), set_config('gbrain.write_principal_id','scoped-probe',true)`);
        value = await fn(tx);
        throw marker;
      });
    } catch (e) {
      if (e !== marker) {
        const detail = (e as { detail?: string }).detail;
        return { error: (e as Error).message, ...(detail?.startsWith('{') ? { state: JSON.parse(detail).state } : {}) };
      }
    }
    return { value };
  }
  const insertPage = (tx: BrainEngine, slug: string) => tx.executeRaw<{ folder_rule_ids: string[] | null }>(
    `INSERT INTO pages(source_id,slug,type,title,compiled_truth,content_hash) VALUES('default',$1,'note','T','b',repeat('a',64)) RETURNING folder_rule_ids`, [slug]);
  /** Whether `slug` passes the folder-rule read predicate for `identity`, with the caller record read as the role. */
  async function remoteReads(tx: BrainEngine, slug: string, identity: string[]): Promise<boolean> {
    const folder = await folderAccessFor(tx, identity);
    return withCallerAccess({ identity, ...folder }, async () =>
      (await tx.executeRaw(`SELECT 1 FROM pages p WHERE p.source_id = 'default' AND p.slug = $1 AND ${folderRulesAllowedSql('p', folder.satisfiedRuleIds)}`, [slug])).length === 1);
  }
  /** The same predicate outside any caller record (the live pending-coverage read). */
  const liveReads = async (tx: BrainEngine, slug: string) =>
    (await tx.executeRaw(`SELECT 1 FROM pages p WHERE p.source_id = 'default' AND p.slug = $1 AND ${folderRulesAllowedSql('p', [])}`, [slug])).length === 1;

  beforeAll(async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engine = pg.engine; close = pg.close;
    await engine.executeRaw(`CREATE ROLE ${SCOPED} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await engine.executeRaw(`GRANT USAGE ON SCHEMA public TO ${SCOPED}`);
    await engine.executeRaw(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${SCOPED}`);
    await engine.executeRaw(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${SCOPED}`);
    for (const table of ACCESS_TABLES) await engine.executeRaw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    tables = (await engine.executeRaw<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).map(r => r.t);
    await engine.executeRaw(`INSERT INTO access_policy_state(source_id) VALUES('default')`);
    await engine.executeRaw(`INSERT INTO access_rules(source_id,rule_id,prefix,readable_by,revision) VALUES('default','r1','partners/',ARRAY['member:alice-example'],1)`);
    await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth,content_hash) VALUES('default','drafts/x','note','T','b',repeat('a',64)), ('default','notes/y','note','T','b',repeat('a',64))`);
    await engine.executeRaw(`INSERT INTO access_pending_coverage(source_id,prefix,reason,revision) VALUES('default','drafts/','pending',2)`);
  }, 180_000);
  afterAll(async () => {
    if (engine) {
      await engine.executeRaw(`DROP OWNED BY ${SCOPED}`).catch(() => undefined);
      await engine.executeRaw(`DROP ROLE IF EXISTS ${SCOPED}`);
      await disposePersistenceConsumer(engine);
      await engine.disconnect();
    }
    await close?.();
    resetGateway();
  });

  test('the owner stamps the rule and reads the pending prefix as covered', async () => {
    const [row] = await engine.transaction(async tx => {
      await tx.executeRaw(`SELECT set_config('gbrain.write_principal_kind','application',true), set_config('gbrain.write_principal_id','owner-probe',true)`);
      return insertPage(tx, 'partners/a');
    });
    expect(row!.folder_rule_ids).toEqual(['default:r1']);
    expect(await liveReads(engine, 'drafts/x')).toBe(false);
    expect(await liveReads(engine, 'notes/y')).toBe(true);
  });

  test('a scoped role that cannot read the rulebook is refused, not stamped with no rule', async () => {
    await policies(ACCESS_TABLES);
    const outcome = await asScoped(tx => insertPage(tx, 'partners/b'));
    expect(outcome.error).toMatch(UNREADABLE);
    expect(outcome.value).toBeUndefined();
  });

  test('a scoped role that reads the policy row but not the rules is refused', async () => {
    await policies(['access_rules']);
    const outcome = await asScoped(tx => insertPage(tx, 'partners/b'));
    expect(outcome).toEqual({ error: expect.stringMatching(UNREADABLE), state: 'access_rules' });
  });

  test('a scoped role that can read the policy row but not lock it is refused', async () => {
    await policies(ACCESS_TABLES);
    await engine.executeRaw(`CREATE POLICY ${SCOPED}_ro ON access_policy_state FOR SELECT TO ${SCOPED} USING (true)`);
    await engine.executeRaw(`CREATE POLICY ${SCOPED}_ro ON access_rules FOR SELECT TO ${SCOPED} USING (true)`);
    try {
      const outcome = await asScoped(tx => insertPage(tx, 'partners/b'));
      expect(outcome).toEqual({ error: expect.stringMatching(UNREADABLE), state: 'access_policy_state' });
    } finally {
      for (const t of ['access_policy_state', 'access_rules']) await engine.executeRaw(`DROP POLICY IF EXISTS ${SCOPED}_ro ON ${t}`);
    }
  });

  test('a scoped role that cannot read the rules reads every page as covered and cannot restamp', async () => {
    await policies(['access_rules']);
    const outcome = await asScoped(async tx => ({
      record: await remoteReads(tx, 'notes/y', ALICE),
      live: await liveReads(tx, 'notes/y'),
      restricted: await folderRestricted(tx, 'default', 'notes/y'),
    }));
    expect(outcome).toEqual({ value: { record: false, live: false, restricted: true } });
    const restamp = await asScoped(tx => restampSource(tx, 'default'));
    expect(restamp.error).toMatch(/cannot read the folder access tables/);
  });

  test('a scoped role that cannot read the pending prefixes reads every page as covered', async () => {
    await policies(['access_pending_coverage']);
    const outcome = await asScoped(async tx => ({
      record: await remoteReads(tx, 'drafts/x', ALICE),
      unruled: await remoteReads(tx, 'notes/y', ALICE),
      live: await liveReads(tx, 'drafts/x'),
      restricted: await folderRestricted(tx, 'default', 'notes/y'),
    }));
    expect(outcome).toEqual({ value: { record: false, unruled: false, live: false, restricted: true } });
  });

  test('a scoped role that cannot read the rename history reads every page as covered', async () => {
    await policies(['slug_rename_history']);
    const outcome = await asScoped(async tx => ({
      record: await remoteReads(tx, 'notes/y', ALICE),
      live: await liveReads(tx, 'notes/y'),
      restricted: await folderRestricted(tx, 'default', 'notes/y'),
    }));
    expect(outcome).toEqual({ value: { record: false, live: false, restricted: true } });
  });

  test('the docs/ENGINES.md access recipe, applied verbatim, stamps the rule and keeps the normal read', async () => {
    await policies(ACCESS_TABLES);
    const recipe = docsRecipe(SCOPED);
    const created = [...recipe.matchAll(/CREATE POLICY (\w+) ON (\w+)/g)].map(m => ({ name: m[1]!, table: m[2]! }));
    expect([...new Set(created.map(p => p.table))].sort()).toEqual([...ACCESS_TABLES].sort());
    await engine.executeRaw(recipe);
    try {
      const outcome = await asScoped(async tx => {
        const [row] = await insertPage(tx, 'partners/b');
        return {
          stamped: row!.folder_rule_ids,
          stranger: await remoteReads(tx, 'partners/b', ['member:bob-example']),
          alice: await remoteReads(tx, 'partners/b', ALICE),
          pending: await remoteReads(tx, 'drafts/x', ALICE),
          unruled: await remoteReads(tx, 'notes/y', ['member:bob-example']),
          rulesUnchanged: (await tx.executeRaw(`UPDATE access_rules SET readable_by = ARRAY['member:bob-example'] WHERE rule_id = 'r1' RETURNING 1`)).length,
          rulesKept: (await tx.executeRaw(`DELETE FROM access_rules WHERE rule_id = 'r1' RETURNING 1`)).length,
          coverageKept: (await tx.executeRaw(`DELETE FROM access_pending_coverage WHERE source_id = 'default' RETURNING 1`)).length,
        };
      });
      expect(outcome).toEqual({ value: { stamped: ['default:r1'], stranger: false, alice: true, pending: false, unruled: true, rulesUnchanged: 0, rulesKept: 0, coverageKept: 0 } });
      const policyRowLocked = await asScoped(tx => tx.executeRaw(`UPDATE access_policy_state SET created_at = now() WHERE source_id = 'default'`));
      expect(policyRowLocked.error).toMatch(/row-level security/);
      for (const table of ACCESS_TABLES) {
        expect((await asScoped(tx => tx.executeRaw(`TRUNCATE ${table} CASCADE`))).error).toMatch(/permission denied/);
      }
    } finally {
      for (const p of created) await engine.executeRaw(`DROP POLICY IF EXISTS ${p.name} ON ${p.table}`);
      await engine.executeRaw(`GRANT ALL ON ${ACCESS_TABLES.join(', ')} TO ${SCOPED}`);
    }
  });
});
