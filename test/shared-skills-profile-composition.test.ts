import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withEnv } from './helpers/with-env.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { setupSharedBrainContent } from '../src/core/shared-skills/setup.ts';
import { createSharedSkillsAdapter, type SharedSkillsToolCaller } from '../src/core/shared-skills/adapter.ts';
import { listSharedSkills } from '../src/core/shared-skills/catalog.ts';
import { resolveGrantProfile } from '../src/core/grants/profiles.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { sharedSkillKey } from '../src/core/shared-skills/membership-types.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { installHarnessConnection } from '../src/core/harness/install.ts';
import { readHarnessConnectionStatus } from '../src/core/harness/status.ts';
import { existsSync } from 'node:fs';

for (const profile of ['memory-reader', 'coding-agent'] as const) test(`fresh packaged catalog delivers usable skills to the actual ${profile} profile`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-profile-delivery-'));
  try {
    await withEnv({ GBRAIN_HOME: join(dir, 'home'), DATABASE_URL: undefined }, async () => {
      const isolated = await isolatedSharedSkillsEngine(); const engine = isolated.engine;
      try {
        await engine.setConfig('mcp.publish_skills', 'true');
        const local: OperationContext = { engine, config: { engine: 'pglite' }, sourceId: 'default', remote: false, dryRun: false,
          logger: { info() {}, warn() {}, error() {} } };
        const setup = await setupSharedBrainContent(local, { fresh: true, git: 'none', root: join(dir, 'content') });
        expect(setup.status).toBe('ready');
        const grant = resolveGrantProfile({ profile, sourceId: 'default', boundSlugPrefixes: profile === 'coding-agent' ? ['work-example/'] : undefined });
        const scopes = [...grant.scopes!, 'skills_member_self'];
        const allowed = [...new Set([...grant.allowedOperations!, 'list_skills', 'get_skill', 'get_skill_asset', 'join_brain', 'sync_brain_skills', 'leave_brain'])];
        await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,scope,source_id,allowed_operations,bound_slug_prefixes)
          VALUES($1,$2,$3,'default',$4::text[],$5::text[])`, [profile, 'Synthetic profile', scopes.join(' '), allowed, grant.boundSlugPrefixes ?? null]);
        const ctx: OperationContext = { ...local, remote: true, auth: { token: 'synthetic', clientId: profile, principal: { kind: 'oauth_client', id: profile },
          scopes, issuedScopes: scopes, allowedOperations: allowed, sourceId: 'default', allowedSources: ['default'], boundSlugPrefixes: grant.boundSlugPrefixes ?? undefined,
          effectiveSurface: 'starter' } };
        const catalog = await listSharedSkills(ctx);
        const care = catalog.skills.find(skill => skill.name === 'memory-care')!;
        expect(care.usable).toBe(false);
        const call: SharedSkillsToolCaller = async <T>(name: string, params: Record<string, unknown>) => operationsByName[name].handler(ctx, params) as Promise<T>;
        const root = join(dir, 'cache');
        const adapter = createSharedSkillsAdapter({ root, adapter: 'generic', call });
        const receipt = await adapter.join({ approved: true });
        expect(receipt.installed_view).toBe(receipt.acknowledged_view);
        expect(receipt.blocked_skills?.some(skill => skill.key === sharedSkillKey(care))).toBe(true);
        const refs = JSON.parse(readFileSync(join(root, 'active.json'), 'utf8')).skills;
        for (const name of ['brain-router', 'memory-recall']) {
          const skill = catalog.skills.find(skill => skill.name === name)!;
          expect(refs[sharedSkillKey(skill)]).toBeDefined();
          expect((await adapter.admit(sharedSkillKey(skill))).revision).toBe(skill.revision);
        }
        await expect(adapter.admit(sharedSkillKey(care))).rejects.toMatchObject({ code: 'requirements_changed' });
        expect(readFileSync(join(root, 'router', 'SKILL.md'), 'utf8')).toContain('get_skill with schema_version:2');
        const credentials = { version: 1 as const, mcp_url: 'https://brain.example.com/mcp', issuer_url: 'https://brain.example.com',
          client_id: profile, access_token: 'synthetic-profile-token', shared_skills: { follow: true } };
        const options = { harness: 'claude-code', configPath: join(dir, 'claude.json'), nativeSkillsDir: join(dir, 'native-skills'), toolCaller: call };
        const installed = await installHarnessConnection(credentials, options);
        const nativePath = (installed.shared_skills as { native_router_path: string }).native_router_path;
        expect(existsSync(nativePath)).toBe(true);
        const installedStatus = readHarnessConnectionStatus(options);
        expect('recorded_skills' in installedStatus && installedStatus.recorded_skills.length).toBe(2);
        expect('usability' in installedStatus && installedStatus.usability).toBe('last_checked_unverified');
        expect('blocked_skills' in installedStatus && installedStatus.blocked_skills.length).toBe(1);
        expect('local_reference' in installedStatus && installedStatus.local_reference).toBe('owned');
        await engine.executeRaw('UPDATE oauth_clients SET scope=$2,allowed_operations=$3::text[] WHERE client_id=$1', [profile, grant.scopes!.join(' '), grant.allowedOperations]);
        const optedOut = await installHarnessConnection({ ...credentials, shared_skills: { follow: false } }, options);
        expect(optedOut.shared_skills.status).toBe('left');
        expect('remote_membership_pending' in optedOut && optedOut.remote_membership_pending).toBe(true);
        expect(existsSync(nativePath)).toBe(false);
        const removed = await installHarnessConnection({ ...credentials, shared_skills: { follow: false } }, { ...options, remove: true });
        expect(removed.status).toBe('removed');
        expect('remote_membership_pending' in removed && removed.remote_membership_pending).toBe(true);
        const status = readHarnessConnectionStatus(options);
        expect(status.current_authority).toBe('unprobed');
        expect(status.status).toBe('left');
        expect('remote_membership_pending' in status && status.remote_membership_pending).toBe(true);
        expect('recorded_skills' in status && status.recorded_skills).toEqual([]);
        expect(JSON.stringify(status)).not.toContain(credentials.access_token);
        await engine.executeRaw('UPDATE oauth_clients SET scope=$2,allowed_operations=$3::text[] WHERE client_id=$1', [profile, scopes.join(' '), allowed]);
        const rejoined = await installHarnessConnection(credentials, options);
        expect('remote_membership_pending' in rejoined && rejoined.remote_membership_pending).toBe(false);
        const rejoinedStatus = readHarnessConnectionStatus(options);
        expect('remote_membership_pending' in rejoinedStatus && rejoinedStatus.remote_membership_pending).toBe(false);
        expect('remote_membership_reason' in rejoinedStatus && rejoinedStatus.remote_membership_reason).toBeNull();
        expect('acknowledged_view' in rejoinedStatus && rejoinedStatus.acknowledged_view).toBe('installed_view' in rejoinedStatus && rejoinedStatus.installed_view);
        expect(existsSync(nativePath)).toBe(true);
        const before = readFileSync(join(root, 'active.json'), 'utf8');
        await engine.transaction(async tx => {
          await declarePersistenceProtocol(tx);
          await tx.executeRaw("SELECT set_config('gbrain.write_sources',$1,true)", [JSON.stringify(['default'])]);
          await tx.executeRaw("UPDATE shared_skill_heads SET revision=$1::uuid WHERE name='memory-recall'", [randomUUID()]);
        });
        await expect(adapter.refresh()).rejects.toMatchObject({ code: 'catalog_unavailable' });
        expect(readFileSync(join(root, 'active.json'), 'utf8')).toBe(before);
        expect(adapter.status()?.status).toBe('stale_unavailable');
      } finally { await disposePersistenceConsumer(engine); await isolated.close(); }
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120_000);
