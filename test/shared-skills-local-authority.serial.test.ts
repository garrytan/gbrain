import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { setupSharedBrainContent } from '../src/core/shared-skills/setup.ts';
import { authorizeSkillRead } from '../src/core/shared-skills/policy.ts';
import { createPersistenceIpcProvider } from '../src/core/persistence/provider.ts';
import { readLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { withEnv } from './helpers/with-env.ts';

test('resident stdio reads honor verified identity, original ceilings, and live revocation without CLI authority', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-shared-local-authority-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine();
      const ctx: OperationContext = { engine, config: { engine: 'pglite' }, sourceId: 'default', remote: false,
        dryRun: false, logger: { info() {}, warn() {}, error() {} } };
      try {
        await engine.setConfig('mcp.publish_skills', 'true');
        await setupSharedBrainContent(ctx, { fresh: true });
        const provider = await createPersistenceIpcProvider(engine, ctx.config);
        const registration = await readLocalWriter(engine, 'stdio');
        const request = { version: 1 as const, kind: 'operation' as const, brain_id: provider.brainId,
          operation: 'list_skills' as const, params: { schema_version: 2 }, registration,
          routing: { source: 'default', cwd: home } };
        const result = await provider.dispatch(request) as { skills: Array<{ name: string; qualified_id: string; revision: string }> };
        expect(result.skills).toHaveLength(3);
        const selected = result.skills.find(skill => skill.name === 'memory-recall')!;
        const detail = await provider.dispatch({ ...request, operation: 'get_skill', params: {
          schema_version: 2, qualified_id: selected.qualified_id, revision: selected.revision,
        } }) as { body: string };
        expect(detail.body).toContain('Recall saved context');
        await expect(provider.dispatch({ ...request, operation: 'get_skill_policy', params: { source_id: 'default' } }))
          .rejects.toMatchObject({ code: 'permission_denied' });
        const grant = { sourceIds: ['default'], scopes: ['read'], operations: ['list_skills', 'get_skill'], slugPrefixes: null };
        await engine.executeRaw('UPDATE persistence_local_writers SET grant_ceiling=$1::text::jsonb WHERE id=$2::uuid', [JSON.stringify(grant), registration.id]);
        await withVerifiedLocalRegistration(engine, registration, async () => {
          const remote: OperationContext = { ...ctx, remote: true, auth: { token: '', clientId: registration.id,
            scopes: ['read'], allowedSources: ['default', 'unapproved'], allowedOperations: ['list_skills'] } };
          expect((await authorizeSkillRead(remote, 'list_skills')).auth?.allowedSources).toEqual(['default']);
          expect((await authorizeSkillRead({ ...ctx, sourceId: '', remote: true }, 'list_skills')).auth?.allowedSources).toEqual(['default']);
          for (const auth of [
            { ...remote.auth!, allowedOperations: [] }, { ...remote.auth!, scopes: [] },
            { ...remote.auth!, clientId: 'unverified-identity' }, { ...remote.auth!, grantProjectionDegraded: true },
            { ...remote.auth!, fenceProjectionDegraded: true }, { ...remote.auth!, effectiveSurface: 'verbs' as const },
          ]) await expect(authorizeSkillRead({ ...remote, auth }, 'list_skills')).rejects.toMatchObject({ code: 'permission_denied' });
          await expect(authorizeSkillRead(remote, 'get_skill')).rejects.toMatchObject({ code: 'permission_denied' });
          await engine.executeRaw('UPDATE persistence_local_writers SET grant_ceiling=$1::text::jsonb WHERE id=$2::uuid',
            [JSON.stringify({ ...grant, sourceIds: ['unapproved'] }), registration.id]);
          expect((await authorizeSkillRead(remote, 'list_skills')).auth?.allowedSources).toEqual([]);
          await engine.executeRaw('UPDATE persistence_local_writers SET revoked_at=now() WHERE id=$1::uuid', [registration.id]);
          await expect(authorizeSkillRead(remote, 'list_skills')).rejects.toMatchObject({ code: 'permission_denied' });
        });
        await expect(provider.dispatch(request)).rejects.toMatchObject({ code: 'permission_denied' });
      } finally { await disposePersistenceConsumer(engine); await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 120_000);
