import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { operationsByName } from '../src/core/operations.ts';
import type { SharedSkillDetail } from '../src/core/shared-skills/model.ts';
import { sharedSkillResourceUri } from '../src/mcp/skill-resources.ts';
import { resetStrictParamsModeCache } from '../src/mcp/validate-params.ts';
import { ASSET_PATH, call, textResource, withTransportFixture } from './fixtures/shared-skills-transports.ts';

test('expected shared skill brain identity asserts the connected database and never routes it', () => withTransportFixture(async fixture => {
  await fixture.seed();
  await fixture.engine.setConfig('mcp.strict_params', 'reject');
  try {
    const client = fixture.peers.reader.client;
    const detail = await call<SharedSkillDetail>(client, 'get_skill', { schema_version: 2, name: 'alpha' });
    const selector = { name: detail.name, source_id: detail.source_id, source_incarnation: detail.source_incarnation,
      pack_id: detail.pack_id, revision: detail.revision, expected_brain_id: detail.brain_id };
    expect((await call<SharedSkillDetail>(client, 'get_skill', { ...selector, schema_version: 2 })).revision).toBe(detail.revision);
    expect((await call<{ revision: string }>(client, 'get_skill_asset', { ...selector, path: ASSET_PATH })).revision).toBe(detail.revision);
    const wrong = randomUUID();
    await expect(call(client, 'get_skill', { ...selector, schema_version: 2, expected_brain_id: wrong })).rejects.toMatchObject({ code: 'skill_not_found' });
    await expect(call(client, 'get_skill_asset', { ...selector, path: ASSET_PATH, expected_brain_id: wrong })).rejects.toMatchObject({ code: 'skill_not_found' });
    await expect(call(client, 'get_skill', { schema_version: 2, qualified_id: detail.qualified_id, expected_brain_id: wrong })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(call(client, 'get_skill_asset', { qualified_id: detail.qualified_id, revision: detail.revision, path: ASSET_PATH, expected_brain_id: wrong })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(operationsByName.get_skill.handler(fixture.local, { schema_version: 2, ...selector, expected_brain_id: wrong })).rejects.toMatchObject({ code: 'skill_not_found' });
    await expect(operationsByName.get_skill_asset.handler(fixture.local, { ...selector, path: ASSET_PATH, expected_brain_id: wrong })).rejects.toMatchObject({ code: 'skill_not_found' });
    await expect(call(client, 'get_skill', { name: detail.name, expected_brain_id: detail.brain_id })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(call(client, 'get_skill', { schema_version: 2, name: detail.name, brain_id: detail.brain_id })).rejects.toThrow();
    const wrongQualified = detail.qualified_id.replace(detail.brain_id, wrong);
    await expect(textResource(client, sharedSkillResourceUri(wrongQualified, detail.revision))).rejects.toThrow();
    expect(await textResource(client, sharedSkillResourceUri(detail.qualified_id, detail.revision))).toBe(detail.body);
    const [brain] = await fixture.engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
    expect(brain.brain_id).toBe(detail.brain_id);
  } finally { resetStrictParamsModeCache(); }
}), 120_000);
