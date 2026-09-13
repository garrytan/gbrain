import type { BrainEngine } from '../engine.ts';
import { sqlQueryForEngine } from '../sql-query.ts';
import { grantFromRow, delegationReasons } from './model.ts';
import { GRANT_CONSTRAINTS_SQL } from './schema.ts';

/** Migration only narrows unusable delegation; never grants tools or scopes. */
export async function repairLegacyClientGrants(engine: BrainEngine): Promise<void> {
  await engine.transaction(async tx => {
    const sql = sqlQueryForEngine(tx);
    // Backfill the old shared restriction before separating the two axes.
    await sql`UPDATE oauth_clients SET delegated_slug_prefixes = bound_slug_prefixes
      WHERE delegated_slug_prefixes IS NULL AND grant_profile IS NULL
        AND COALESCE(scope, '') ~ '(^|[[:space:]])agent([[:space:]]|$)'`;
    await sql`UPDATE oauth_clients SET delegated_namespace = 'job'
      WHERE delegated_slug_prefixes IS NULL AND bound_slug_prefixes IS NULL AND grant_profile IS NULL`;
    const rows = await sql`SELECT * FROM oauth_clients
      WHERE COALESCE(scope, '') ~ '(^|[[:space:]])agent([[:space:]]|$)' FOR UPDATE`;
    if (rows.length) {
      // Registry validation is needed only for existing delegated clients.
      // Eager loading registers unrelated background sinks on every engine
      // import, changing the empty-engine disconnect/watchdog contract.
      const { grantValidationContext } = await import('./service.ts'); // engine-dynamic-import-ok
      const ctx = await grantValidationContext(tx);
      for (const row of rows) {
        const before = grantFromRow(row);
        const reasons = delegationReasons(before, ctx).filter(reason => reason !== 'client_revoked');
        if (!reasons.length) continue;
        const scopes = before.scopes.filter(scope => scope !== 'agent');
        await sql`UPDATE oauth_clients SET scope = ${scopes.join(' ')},
          grant_repair_reasons = ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(reasons)}::text::jsonb)),
          grant_revision = grant_revision + 1 WHERE client_id = ${before.clientId}`;
        await sql`INSERT INTO oauth_grant_audit (client_id, actor, action, revision, before_grant, after_grant)
          VALUES (${before.clientId}, 'migration', 'disable_invalid_delegation', ${before.revision + 1},
            ${JSON.stringify(before)}::text::jsonb,
            ${JSON.stringify({ ...before, scopes, repairReasons: reasons, revision: before.revision + 1 })}::text::jsonb)`;
      }
    }
    for (const statement of GRANT_CONSTRAINTS_SQL.split(';').map(sql => sql.trim()).filter(Boolean)) {
      await tx.executeRaw(statement);
    }
  });
}
