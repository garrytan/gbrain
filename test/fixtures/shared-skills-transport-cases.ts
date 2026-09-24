import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSharedSkillsAdapter, type SharedSkillsToolCaller } from '../../src/core/shared-skills/adapter.ts';
import type { SharedSkillDetail, SharedSkillList } from '../../src/core/shared-skills/model.ts';
import type { MembershipSnapshot } from '../../src/core/shared-skills/membership-types.ts';
import { sharedSkillKey } from '../../src/core/shared-skills/membership-types.ts';
import { setSharedSkillPolicy } from '../../src/core/shared-skills/policy.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { sharedSkillResourceUri } from '../../src/mcp/skill-resources.ts';
import { resetStrictParamsModeCache } from '../../src/mcp/validate-params.ts';
import { ASSET_PATH, blobResource, call, FULL_POLICY, READ_OPERATIONS, skillFiles, textResource, withTransportFixture } from './shared-skills-transports.ts';

export function sharedSkillsTransportCases(databaseUrl?: string) {
  describe(`shared skills over authenticated HTTP (${databaseUrl ? 'Postgres' : 'PGLite'})`, () => {
    test('strict MCP editor creates with null CAS, replays durably and rejects absent or malformed replacement revisions', () => withTransportFixture(async f => {
      await f.engine.setConfig('mcp.strict_params', 'reject');
      try {
        const client = f.peers.editor.client;
        const params = { request_id: randomUUID(), expected_revision: null, source_id: 'default', source_incarnation: f.incarnation,
          name: 'alpha', pack_id: 'example-pack', files: skillFiles('Created over real MCP', 'Created asset over real MCP') };
        const created = await call<{ state: string; revision: string }>(client, 'put_skill', params);
        expect(created.state).toBe('committed');
        const fetched = await call<SharedSkillDetail>(f.peers.reader.client, 'get_skill', { schema_version: 2, name: 'alpha' });
        expect(fetched.revision).toBe(created.revision); expect(fetched.body).toContain('Created over real MCP');
        expect(await textResource(f.peers.parent.client, sharedSkillResourceUri(fetched.qualified_id, fetched.revision))).toBe(fetched.body);
        expect(readFileSync(join(f.root, ASSET_PATH), 'utf8')).toBe('Created asset over real MCP');
        expect((await call(client, 'put_skill', params)).revision).toBe(created.revision);
        await expect(call(client, 'put_skill', { ...params, request_id: randomUUID(), expected_revision: undefined })).rejects.toMatchObject({ code: 'revision_conflict' });
        await expect(call(client, 'put_skill', { ...params, request_id: randomUUID(), expected_revision: 'not-a-revision' })).rejects.toMatchObject({ code: 'revision_required' });
        expect((await call<SharedSkillDetail>(client, 'get_skill', { schema_version: 2, name: 'alpha' })).revision).toBe(created.revision);
      } finally { resetStrictParamsModeCache(); }
    }, databaseUrl), 120_000);

    test('managed adapter sends schema-valid tool requests to a strict MCP server', () => withTransportFixture(async f => {
      await f.seed();
      await f.engine.setConfig('mcp.strict_params', 'reject');
      try {
        const catalog = await call<SharedSkillList>(f.peers.reader.client, 'list_skills', { schema_version: 2 });
        const skill = catalog.skills[0];
        const manifest = JSON.parse(await textResource(f.peers.reader.client, sharedSkillResourceUri(skill.qualified_id, skill.revision, '_manifest')));
        expect(manifest.files.map((file: { path: string }) => file.path).sort()).toEqual(['skills/alpha/SKILL.md', ASSET_PATH].sort());
        expect(manifest.body).toBeUndefined();
        const caller: SharedSkillsToolCaller = (tool, params) => call(f.peers.reader.client, tool, params);
        const root = join(f.dir, 'strict-cache');
        const adapter = createSharedSkillsAdapter({ root, adapter: 'generic', call: caller });
        const receipt = await adapter.join({ approved: true, source_ids: ['default'] });
        expect(receipt.acknowledged_view).toBe(receipt.installed_view);
        expect(receipt.status).toBe('advisory_refresh');
        expect(Object.keys(JSON.parse(readFileSync(join(root, 'active.json'), 'utf8')).skills)).toHaveLength(1);
      } finally { resetStrictParamsModeCache(); }
    }, databaseUrl), 120_000);

    test('reader, editor and parent follow one durable CAS revision and tombstones revoke historical tools and resources', () => withTransportFixture(async f => {
      await f.seed();
      const reader = f.peers.reader.client;
      expect(reader.getServerVersion()?.name).toBe('gbrain');
      expect(reader.getServerCapabilities()?.resources).toBeDefined();
      const memberTools = (await reader.listTools()).tools.map(tool => tool.name);
      expect(memberTools).toContain('sync_brain_skills'); expect(memberTools).not.toContain('sync_brain');
      expect(new Set(memberTools).size).toBe(memberTools.length);
      const catalog = await call<SharedSkillList>(reader, 'list_skills', { schema_version: 2 });
      expect(catalog.skills).toHaveLength(1);
      const original = await call<SharedSkillDetail>(reader, 'get_skill', { schema_version: 2, name: 'alpha' });
      expect(original.revision).toBe(catalog.skills[0].revision);
      const legacy = await call<{ schema_version: number; count: number; skills: { name: string }[] }>(reader, 'list_skills');
      expect(legacy.schema_version).toBe(1); expect(legacy.count).toBe(1); expect(legacy.skills[0].name).toBe('alpha');
      expect(await call<typeof legacy>(reader, 'list_skills', { schema_version: 1 })).toEqual(legacy);
      const legacySkill = await call(reader, 'get_skill', { name: 'alpha' });
      expect(legacySkill.schema_version).toBe(1); expect(legacySkill.body).toBe(original.body);
      expect((await call(reader, 'get_skill', { name: 'alpha', source_id: 'default' })).body).toBe(original.body);
      expect((await call<{ packs: { installed: boolean }[] }>(reader, 'list_brain_skillpack')).packs[0].installed).toBe(false);
      expect((await reader.listResources()).resources.some(r => r.uri === 'gbrain://skills')).toBe(true);
      const resourceCatalog = JSON.parse(await textResource(reader, 'gbrain://skills'));
      expect(resourceCatalog.skills[0].revision).toBe(original.revision);
      const uri = sharedSkillResourceUri(original.qualified_id, original.revision);
      expect(await textResource(reader, uri)).toBe(original.body);
      const assetUri = sharedSkillResourceUri(original.qualified_id, original.revision, ASSET_PATH);
      expect(Buffer.from(await blobResource(reader, assetUri), 'base64').toString()).toBe('Original shared asset');
      const adapters = Object.entries(f.peers).filter(([name]) => name !== 'memory').map(([name, peer]) => {
        const root = join(f.dir, `cache-${name}`);
        const caller: SharedSkillsToolCaller = (tool, params) => call(peer.client, tool, params);
        return { root, adapter: createSharedSkillsAdapter({ call: caller, root, adapter: 'generic', connectionName: 'synthetic-shared-brain' }) };
      });
      const receipts = [];
      for (const { adapter } of adapters) {
        const receipt = await adapter.join({ approved: true, source_ids: ['default'] });
        expect(receipt.native).toBe('unverified'); expect(receipt.native_registration).toBe('unverified');
        expect(receipt.status).toBe('advisory_refresh'); expect(receipt.acknowledged_view).toBe(receipt.installed_view);
        receipts.push(receipt);
      }
      expect(new Set(receipts.map(r => r.installation_id)).size).toBe(3);
      await expect(call(f.peers.parent.client, 'sync_brain_skills', { installation_id: receipts[0].installation_id,
        enrollment_epoch: receipts[0].enrollment_epoch })).rejects.toMatchObject({ code: 'membership_not_found' });
      const params = { request_id: randomUUID(), expected_revision: original.revision, source_id: 'default', source_incarnation: f.incarnation,
        pack_id: 'example-pack', name: 'alpha', files: skillFiles('Updated shared instructions', 'Updated shared asset') };
      const committed = await call<{ state: string; revision: string; request_id: string }>(f.peers.editor.client, 'put_skill', params);
      expect(committed.state).toBe('committed'); expect(committed.request_id).toBe(params.request_id);
      expect(committed.revision).not.toBe(original.revision);
      await disposePersistenceConsumer(f.engine);
      const freshEditor = await f.connect(f.peers.editor.token);
      expect((await call(freshEditor, 'put_skill', params)).revision).toBe(committed.revision);
      await expect(call(freshEditor, 'put_skill', { ...params, request_id: randomUUID() })).rejects.toMatchObject({ code: 'revision_conflict' });
      await expect(call(freshEditor, 'put_skill', { ...params, files: skillFiles('Different retry') })).rejects.toMatchObject({ code: 'idempotency_conflict' });
      expect((await f.engine.executeRaw('SELECT revision FROM shared_skill_revisions WHERE source_id=$1 AND name=$2', ['default', 'alpha']))).toHaveLength(2);
      for (const peer of [f.peers.reader, f.peers.editor, f.peers.parent]) {
        const current = await call<SharedSkillDetail>(peer.client, 'get_skill', { schema_version: 2, name: 'alpha' });
        expect(current.revision).toBe(committed.revision); expect(current.body).toContain('Updated shared instructions');
        const asset = await call<{ content: string }>(peer.client, 'get_skill_asset', { qualified_id: current.qualified_id, revision: current.revision, path: ASSET_PATH });
        expect(Buffer.from(asset.content, 'base64').toString()).toBe('Updated shared asset');
      }
      for (const { adapter, root } of adapters) {
        const receipt = await adapter.refresh();
        expect(receipt.acknowledged_view).toBe(receipt.installed_view); expect(receipt.native).toBe('unverified');
        const active = JSON.parse(readFileSync(join(root, 'active.json'), 'utf8'));
        const installed = active.skills[sharedSkillKey(original)];
        expect(installed.revision).toBe(committed.revision);
        expect(readFileSync(join(root, installed.files[ASSET_PATH]), 'utf8')).toBe('Updated shared asset');
        expect(readFileSync(join(root, installed.files['skills/alpha/SKILL.md']), 'utf8')).toContain('Updated shared instructions');
      }
      expect(readFileSync(join(f.root, ASSET_PATH), 'utf8')).toBe('Updated shared asset');
      expect(await textResource(reader, uri)).toBe(original.body);
      const deleted = await call(freshEditor, 'delete_skill', { ...params, files: undefined, request_id: randomUUID(), expected_revision: committed.revision });
      expect(deleted.state).toBe('committed'); expect(existsSync(join(f.root, ASSET_PATH))).toBe(false);
      for (const peer of [f.peers.reader, f.peers.editor, f.peers.parent]) {
        expect((await call<SharedSkillList>(peer.client, 'list_skills', { schema_version: 2 })).skills).toEqual([]);
        await expect(call(peer.client, 'get_skill', { schema_version: 2, qualified_id: original.qualified_id, revision: original.revision })).rejects.toMatchObject({ code: 'skill_not_found' });
        await expect(call(peer.client, 'get_skill_asset', { qualified_id: original.qualified_id, revision: original.revision, path: ASSET_PATH })).rejects.toMatchObject({ code: 'skill_not_found' });
        await expect(peer.client.readResource({ uri })).rejects.toThrow();
        await expect(peer.client.readResource({ uri: assetUri })).rejects.toThrow();
      }
      for (const { adapter, root } of adapters) {
        await adapter.refresh();
        expect(JSON.parse(readFileSync(join(root, 'active.json'), 'utf8')).skills).toEqual({});
        await expect(adapter.admit(sharedSkillKey(original))).rejects.toMatchObject({ code: 'skill_unavailable' });
      }
    }, databaseUrl), 120_000);

    test('scope, source and explicit operation grants fence guessed tools and resources without trusting the client name', () => withTransportFixture(async f => {
      await f.seed(); await f.seed('hidden', skillFiles('Hidden-source canary', 'Hidden asset canary'));
      const reader = f.peers.reader.client;
      const visible = await call<SharedSkillDetail>(reader, 'get_skill', { schema_version: 2, name: 'alpha' });
      const hiddenPeer = await f.credential('fixture-hidden', ['read'], READ_OPERATIONS, 'hidden');
      const hidden = await call<SharedSkillDetail>(hiddenPeer.client, 'get_skill', { schema_version: 2, name: 'alpha' });
      expect((await call<SharedSkillList>(reader, 'list_skills', { schema_version: 2 })).skills.map(s => s.source_id)).toEqual(['default']);
      const params = { request_id: randomUUID(), expected_revision: visible.revision, source_id: 'default', source_incarnation: f.incarnation,
        name: 'alpha', pack_id: 'example-pack', files: skillFiles('Denied memory-writer edit') };
      const memoryTools = (await f.peers.memory.client.listTools()).tools.map(t => t.name);
      expect(memoryTools).not.toContain('put_skill'); expect(memoryTools).not.toContain('join_brain');
      await expect(call(f.peers.memory.client, 'put_skill', params)).rejects.toMatchObject({ code: 'permission_denied' });
      await expect(call(f.peers.memory.client, 'join_brain', { adapter: 'generic', follow_policy: { approved: true } })).rejects.toMatchObject({ code: 'permission_denied' });
      await expect(call(f.peers.editor.client, 'set_skill_policy', { source_id: 'default', policy: FULL_POLICY })).rejects.toMatchObject({ code: 'permission_denied' });
      const noWriteOperation = await f.credential('fixture-editor-no-operation', ['read', 'write', 'skill_editor'], READ_OPERATIONS);
      await expect(call(noWriteOperation.client, 'put_skill', params)).rejects.toMatchObject({ code: 'permission_denied' });
      for (const selector of [{ source_id: 'hidden', name: 'alpha' }, { qualified_id: hidden.qualified_id }]) {
        await expect(call(reader, 'get_skill', { schema_version: 2, ...selector })).rejects.toThrow();
        await expect(call(reader, 'get_skill_asset', { ...selector, revision: hidden.revision, path: ASSET_PATH })).rejects.toThrow();
      }
      for (const path of ['SKILL.md', '_manifest', ASSET_PATH]) {
        await expect(reader.readResource({ uri: sharedSkillResourceUri(hidden.qualified_id, hidden.revision, path) })).rejects.toThrow();
      }
      for (const path of ['../secret', 'skills/alpha/assets/undeclared.txt']) {
        await expect(call(reader, 'get_skill_asset', { qualified_id: visible.qualified_id, revision: visible.revision, path })).rejects.toThrow();
        await expect(reader.readResource({ uri: sharedSkillResourceUri(visible.qualified_id, visible.revision, path) })).rejects.toThrow();
      }
      expect(JSON.stringify(await reader.readResource({ uri: 'gbrain://skills' }))).not.toContain('Hidden-source canary');
      await f.engine.executeRaw('UPDATE access_tokens SET permissions=$2::text::jsonb WHERE id=$1::uuid',
        [f.peers.reader.id, JSON.stringify({ source_id: 'default', allowed_operations: ['list_skills'] })]);
      expect((await reader.listTools()).tools.map(t => t.name)).toEqual(['list_skills']);
      await expect(call(reader, 'get_skill', { schema_version: 2, name: 'alpha' })).rejects.toMatchObject({ code: 'permission_denied' });
      await expect(reader.readResource({ uri: sharedSkillResourceUri(visible.qualified_id, visible.revision) })).rejects.toThrow();
      await expect(reader.readResource({ uri: sharedSkillResourceUri(visible.qualified_id, visible.revision, ASSET_PATH) })).rejects.toThrow();
      await f.engine.executeRaw('UPDATE access_tokens SET revoked_at=now() WHERE id=$1::uuid', [f.peers.reader.id]);
      await expect(reader.readResource({ uri: 'gbrain://skills' })).rejects.toThrow();
      const unauthenticated = await fetch(f.url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'gbrain://skills' } }) });
      expect(unauthenticated.status).toBe(401);
      expect((await call<SharedSkillDetail>(f.peers.parent.client, 'get_skill', { schema_version: 2, name: 'alpha' })).revision).toBe(visible.revision);
    }, databaseUrl), 120_000);

    test('false consent hides discovery and guessed resources while legacy prose consent never authorizes asset delivery or following', () => withTransportFixture(async f => {
      await f.seed();
      const client = f.peers.reader.client;
      const skill = await call<SharedSkillDetail>(client, 'get_skill', { schema_version: 2, name: 'alpha' });
      await expect(call(client, 'join_brain', { adapter: 'generic', follow_policy: { approved: false } })).rejects.toMatchObject({ code: 'follow_approval_required' });
      await f.engine.setConfig('mcp.publish_skills', 'false');
      expect((await client.listTools()).tools.map(t => t.name)).not.toContain('list_skills');
      expect((await client.listResources()).resources.map(r => r.uri)).not.toContain('gbrain://skills');
      await expect(call(client, 'list_skills', { schema_version: 2 })).rejects.toThrow();
      await expect(call(client, 'get_skill', { schema_version: 2, name: 'alpha' })).rejects.toThrow();
      for (const uri of ['gbrain://skills', sharedSkillResourceUri(skill.qualified_id, skill.revision), sharedSkillResourceUri(skill.qualified_id, skill.revision, ASSET_PATH)]) {
        await expect(client.readResource({ uri })).rejects.toThrow();
      }
      await f.engine.setConfig('mcp.publish_skills', 'true');
      await f.engine.executeRaw('DELETE FROM shared_skill_policies WHERE source_id=$1', ['default']);
      const prose = await call<SharedSkillDetail>(client, 'get_skill', { schema_version: 2, name: 'alpha' });
      expect(prose.allow_follow).toBe(false); expect(prose.delivery).toBe('prose_only');
      expect(prose.files.map(file => file.path)).toEqual(['skills/alpha/SKILL.md']);
      expect(JSON.stringify(prose)).not.toContain(ASSET_PATH);
      await expect(call(client, 'get_skill_asset', { qualified_id: skill.qualified_id, revision: skill.revision, path: ASSET_PATH })).rejects.toMatchObject({ code: 'skill_asset_not_found' });
      await expect(client.readResource({ uri: sharedSkillResourceUri(skill.qualified_id, skill.revision, ASSET_PATH) })).rejects.toThrow();
      const membership = await call<MembershipSnapshot>(client, 'join_brain', { adapter: 'generic', follow_policy: { approved: true } });
      expect(membership.skills).toEqual([]); expect(membership.blocked_skills).toHaveLength(1); expect(membership.status).toBe('requirements_changed');
      await setSharedSkillPolicy(f.local, 'default', FULL_POLICY);
      const synced = await call<MembershipSnapshot>(client, 'sync_brain_skills', { installation_id: membership.installation_id, enrollment_epoch: membership.enrollment_epoch });
      expect(synced.skills).toEqual([]); expect(synced.blocked_skills).toHaveLength(1);
      expect((await call<SharedSkillDetail>(client, 'get_skill', { schema_version: 2, name: 'alpha' })).files).toHaveLength(2);
    }, databaseUrl), 120_000);
  });
}
