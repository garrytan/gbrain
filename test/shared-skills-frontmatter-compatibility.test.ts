/**
 * Value: protects=public declaration/privacy and exact-byte import contract;
 * fails_when=channel/path classification or legacy projection is removed;
 * why_new=existing publication tests reject these nonboolean declarations;
 * seam=none; no_claim=live adoption, skill execution or evaluation quality.
 * All content is synthetic. The channel token is the legacy protocol spelling.
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { skillsCatalogOperations } from '../src/core/ops/skills-catalog.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { normalizeSkillFiles, skillMetadata } from '../src/core/shared-skills/manifest.ts';
import type { SharedSkillFileInput } from '../src/core/shared-skills/model.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';

const body = (name: string, declarations: string) => `---\nname: ${name}\ntype: skill\ndescription: Synthetic compatibility fixture\n${declarations}\n---\nSynthetic instructions only.\n`;
const metadata = (declarations: string, params: Record<string, unknown> = {}) =>
  skillMetadata('example', normalizeSkillFiles('example', [{ path: 'skills/example/SKILL.md', content: body('example', declarations), file_class: 'prose' }]), params);

test('boolean markers keep their semantics and channel/path declarations grant nothing', () => {
  for (const value of ['true', 'TRUE', 'yes', 'YES', 'false', 'FALSE', 'no', 'NO']) {
    const positive = ['true', 'yes'].includes(value.toLowerCase());
    for (const key of ['private', 'publish', 'mcp_publish', 'writes_pages', 'mutating']) {
      const result = metadata(`${key}: ${value}`);
      expect(result.private).toBe(key === 'private' ? positive : ['publish', 'mcp_publish'].includes(key) ? !positive : false);
      expect(result.writes_pages).toBe(key === 'writes_pages' && positive);
      expect(result.mutating).toBe(key === 'mutating' && positive);
    }
  }
  expect(metadata('publish: teio')).toMatchObject({ publish_channel: 'teio', private: false, writes_pages: false, requirements: [] });
  for (const declaration of ['private: true', 'mcp_publish: false']) {
    expect(metadata(`publish: teio\n${declaration}`, { private: false }).private).toBe(true);
  }
  expect(metadata('publish: false', { private: false }).private).toBe(true);
  expect(metadata('MCP-PUBLISH: no', { private: false }).private).toBe(true);
  expect(metadata('writes_pages: [drafts/report.md, inbox/*]')).toMatchObject({
    writes_pages: true, mutating: false, declared_write_paths: ['drafts/report.md', 'inbox/*'], requirements: [],
  });
  expect(metadata('writes_pages: true\nwrites_to: [inbox/]')).toMatchObject({ writes_pages: true });
});

test('unknown, duplicate and ambiguous declarations remain refused', () => {
  for (const declaration of [
    'publish: public', 'publish: external', 'publish: TEIO', 'Publish: teio',
    'private: teio', 'mcp_publish: teio', 'mutating: [inbox/*]',
    'publish: teio\nPUBLISH: false', 'writes_pages: [inbox/*]\nwrites-pages: false',
    'writes_pages: []', 'writes_pages: [inbox/*]\nwrites_to: [inbox/]',
    'writes_pages: [null]', 'writes_pages: [1]', 'writes_pages: [{path: inbox}]',
    'writes_pages: [/absolute]', 'writes_pages: [../escape]', 'writes_pages: [inbox/../escape]',
    'writes_pages: [inbox/**]', 'writes_pages: [inbox/*.md]', 'writes_pages: ["inbox/secret\\n"]',
    'writes_pages: ["inbox/\\u202evalue"]', 'writes_pages: [credentials/.hidden]',
    '<<: {private: true}', 'publish: teio\npublish: false',
  ]) expect(() => metadata(declaration)).toThrow();
  expect(() => metadata(`writes_pages: [${Array.from({ length: 65 }, (_, i) => `inbox/note-${i}`).join(', ')}]`)).toThrow();
  expect(() => metadata(`writes_pages: [inbox/${'x'.repeat(257)}]`)).toThrow();
});

test('trusted-local public imports preserve declarations/bytes and still enforce privacy, policy and CAS', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-marker-compat-'));
  try {
    await withEnv({ GBRAIN_HOME: join(dir, 'home'), DATABASE_URL: undefined }, async () => {
      const isolated = await isolatedSharedSkillsEngine();
      const engine = isolated.engine;
      try {
        const root = join(dir, 'source'); mkdirSync(root);
        await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [root, 'default']);
        await claimWorktree(engine, 'default', root);
        await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
        await engine.setConfig('mcp.publish_skills', 'true');
        const local: OperationContext = { engine, config: { engine: 'pglite' }, remote: false, sourceId: 'default', dryRun: false,
          logger: { info() {}, warn() {}, error() {} } };
        const call = (name: string, params: Record<string, unknown>, ctx = local) => skillsCatalogOperations.find(op => op.name === name)!.handler(ctx, params);
        const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', ['default']);
        const allowed = ['get_backlinks', 'get_page', 'get_timeline', 'list_pages', 'query', 'recall', 'search', 'traverse_graph', 'add_link', 'add_timeline_entry', 'put_page', 'sync_brain'].map(t => `tool:${t}`);
        const before = await call('get_skill_policy', { source_id: 'default' }) as { policy_epoch: string };
        await call('set_skill_policy', { source_id: 'default', expected_policy_epoch: before.policy_epoch,
          policy: { version: 1, enabled: true, classes: ['prose', 'reference'], audiences: ['readers'], requirements: allowed, allow_follow: false } });
        const importParams = (name: string, content: string, extra: Record<string, unknown> = {}) => {
          const path = `skills/${name}/SKILL.md`;
          const files: SharedSkillFileInput[] = [{ path, content, file_class: 'prose' }];
          return { request_id: randomUUID(), expected_revision: null, source_id: 'default', source_incarnation: source.incarnation,
            pack_id: 'fixture-pack', name, files,
            expected_hashes: { [path]: null, 'skillpack.json': existsSync(join(root, 'skillpack.json')) ? sha256(readFileSync(join(root, 'skillpack.json'))) : null }, ...extra };
        };
        const raw = '\uFEFF' + body('channel-path', 'publish: teio\nwrites_pages: [drafts/report.md, inbox/*]').replaceAll('\n', '\r\n');
        const params = importParams('channel-path', raw);
        const assetPath = 'skills/channel-path/references/synthetic.bin';
        const asset = Buffer.from([0, 255, 13, 10, 32]);
        params.files[0].depends_on = [assetPath];
        params.files.push({ path: assetPath, content: asset.toString('base64'), encoding: 'base64', file_class: 'reference' });
        params.expected_hashes[assetPath] = null;
        const result = await call('import_skill_proposal', params) as { state: string; revision: string };
        expect(result.state).toBe('committed');
        const current = await call('get_skill', { schema_version: 2, name: 'channel-path' }) as Record<string, unknown>;
        expect(current).toMatchObject({ body: raw, publish_channel: 'teio', declared_write_paths: ['drafts/report.md', 'inbox/*'], writes_pages: true, private: false, allow_follow: false, requirements: [] });
        expect(readFileSync(join(root, 'skills/channel-path/SKILL.md'))).toEqual(Buffer.from(raw));
        expect(readFileSync(join(root, assetPath))).toEqual(asset);
        const downloaded = await call('get_skill_asset', { name: 'channel-path', revision: result.revision, path: assetPath }) as { content: string };
        expect(Buffer.from(downloaded.content, 'base64')).toEqual(asset);
        const legacy = await call('get_skill', { name: 'channel-path' }) as { frontmatter: { writes_pages: boolean }; body: string };
        expect(legacy.frontmatter.writes_pages).toBe(true); expect(legacy.body).toBe(raw);
        const replay = await call('import_skill_proposal', params) as { revision: string };
        expect(replay.revision).toBe(result.revision);

        // Synthetic metadata shapes of the three frozen compatible inputs;
        // never their actual bodies, receipts or claimed evaluation output.
        for (const [name, markers, tools] of [
          ['fixture-query', 'mutating: false', ['get_backlinks', 'get_page', 'get_timeline', 'list_pages', 'query', 'recall', 'search', 'traverse_graph']],
          ['fixture-ops', 'mutating: true\nwrites_pages: true', ['add_link', 'add_timeline_entry', 'get_backlinks', 'get_page', 'put_page', 'query', 'recall', 'search', 'sync_brain']],
          ['fixture-pdf', '', []],
        ] as const) {
          const content = body(name, `${markers}\ntools: [${tools.join(', ')}]`);
          expect((await call('import_skill_proposal', importParams(name, content)) as { state: string }).state).toBe('committed');
          expect((await call('get_skill', { schema_version: 2, name }) as { body: string }).body).toBe(content);
        }
        await engine.executeRaw("INSERT INTO oauth_clients(client_id,client_name,scope,source_id,allowed_operations) VALUES('reader','Synthetic reader','read','default',ARRAY['get_skill','list_skills'])");
        const reader: OperationContext = { ...local, remote: true, auth: { token: 'synthetic', clientId: 'reader',
          principal: { kind: 'oauth_client', id: 'reader' }, scopes: ['read'], sourceId: 'default', allowedOperations: ['get_skill', 'list_skills'] } };
        for (const [name, markers] of [['private-channel', 'publish: teio\nprivate: true'], ['optout-channel', 'publish: teio\nmcp_publish: false'], ['optout-boolean', 'publish: false']]) {
          await call('import_skill_proposal', importParams(name, body(name, markers), { private: false }));
          await expect(call('get_skill', { schema_version: 2, name }, reader)).rejects.toMatchObject({ code: 'skill_not_found' });
        }
        const policyFailure = importParams('wrong-policy', body('wrong-policy', 'publish: teio\nwrites_pages: [inbox/*]\nrequires: [unapproved:capability]'));
        await expect(call('import_skill_proposal', policyFailure)).rejects.toMatchObject({ code: 'requirements_changed' });
        expect(existsSync(join(root, 'skills/wrong-policy/SKILL.md'))).toBe(false);
        await expect(call('import_skill_proposal', importParams('wrong-tool', body('wrong-tool', 'publish: teio\ntools: [unapproved_tool]'))))
          .rejects.toMatchObject({ code: 'requirements_changed' });
        await expect(call('import_skill_proposal', importParams('bad-path', body('bad-path', 'writes_pages: [../escape]'))))
          .rejects.toMatchObject({ code: 'invalid_params' });
        const ambiguous = importParams('ambiguous', body('ambiguous', 'publish: teio\nPUBLISH: false'));
        await expect(call('import_skill_proposal', ambiguous)).rejects.toMatchObject({ code: 'approval_required' });
        expect(existsSync(join(root, 'skills/ambiguous/SKILL.md'))).toBe(false);
        const stale = importParams('stale', body('stale', 'publish: teio'));
        stale.expected_hashes['skillpack.json'] = '0'.repeat(64);
        await expect(call('import_skill_proposal', stale)).rejects.toMatchObject({ code: 'local_conflict' });
        expect(existsSync(join(root, 'skills/stale/SKILL.md'))).toBe(false);
      } finally { await disposePersistenceConsumer(engine); await isolated.close(); }
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120_000);
