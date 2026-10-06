/**
 * #5150 residual: a canonical shared skill published without `tools:` inherits
 * the caller's available brain tools, like a host-repository skill; `tools: []`
 * still permits none. A-NEW-5: an empty or whitespace-only SKILL.md is refused
 * at publication instead of listing as a blank skill.
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { submitSharedSkillMutation } from '../src/core/shared-skills/publication.ts';
import { getSharedSkill, listSharedSkills } from '../src/core/shared-skills/catalog.ts';
import { getLegacySharedSkill, listLegacySharedSkills } from '../src/core/shared-skills/compatibility.ts';
import { sharedSkillToolAccess } from '../src/core/shared-skills/tool-access.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';

async function fixture(run: (local: OperationContext) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-skill-tools-'));
  await withEnv({ GBRAIN_HOME: join(dir, 'home'), DATABASE_URL: undefined }, async () => {
    const isolated = await isolatedSharedSkillsEngine();
    const engine = isolated.engine;
    try {
      const root = join(dir, 'default'); mkdirSync(root);
      await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [root, 'default']);
      await claimWorktree(engine, 'default', root);
      await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
      await engine.setConfig('mcp.publish_skills', 'true');
      await run({ engine, config: { engine: 'pglite' }, remote: false, sourceId: 'default', dryRun: false, logger: { info() {}, warn() {}, error() {} } });
    } finally { await disposePersistenceConsumer(engine); await isolated.close(); }
  });
  rmSync(dir, { recursive: true, force: true });
}
async function put(ctx: OperationContext, name: string, body: string) {
  const [source] = await ctx.engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', ['default']);
  return submitSharedSkillMutation(ctx, 'put_skill', { request_id: randomUUID(), expected_revision: null, source_id: 'default',
    source_incarnation: source.incarnation, pack_id: 'example-pack', name, files: [{ path: `skills/${name}/SKILL.md`, content: body, file_class: 'prose' }] });
}

test('a canonical skill without tools inherits the available brain tools; tools: [] permits none; declared tools narrow (#5150)', () => fixture(async local => {
  await put(local, 'notools', '---\nname: notools\ndescription: Portable fixture skill\n---\n\nUse search.\n');
  await put(local, 'emptytools', '---\nname: emptytools\ndescription: Locked fixture skill\ntools: []\n---\n\nNo tools.\n');
  await put(local, 'onetool', '---\nname: onetool\ndescription: Narrow fixture skill\ntools: [search]\n---\n\nUse search.\n');
  const available = await sharedSkillToolAccess(local);
  expect(available).toContain('search');
  const listed = new Map((await listSharedSkills(local, { limit: 100 })).skills.map(skill => [skill.name, skill]));
  expect(listed.get('notools')!.usable_tools).toEqual(available);
  expect(listed.get('emptytools')!.usable_tools).toEqual([]);
  expect(listed.get('onetool')!.usable_tools).toEqual(['search']);
  expect((await getSharedSkill(local, { name: 'notools' })).usable_tools).toEqual(available);
  expect((await getSharedSkill(local, { name: 'emptytools' })).usable_tools).toEqual([]);
  const legacy = new Map((await listLegacySharedSkills(local)).skills.map(skill => [skill.name, skill]));
  expect(legacy.get('notools')!.usable_tools).toEqual(available);
  expect(legacy.get('emptytools')!.usable_tools).toEqual([]);
  expect(((await getLegacySharedSkill(local, 'notools')) as { usable_tools: string[] }).usable_tools).toEqual(available);
}), 120_000);

test('an empty or whitespace-only SKILL.md is refused at publication (A-NEW-5)', () => fixture(async local => {
  await expect(put(local, 'blank', '')).rejects.toMatchObject({ code: 'invalid_params' });
  await expect(put(local, 'spaces', '  \n\t\n')).rejects.toMatchObject({ code: 'invalid_params' });
  expect((await listSharedSkills(local, { limit: 100 })).skills.map(skill => skill.name)).toEqual([]);
}), 120_000);

test('revisions published before tools_declared re-read their SKILL.md; unreadable frontmatter fails closed (#5150)', async () => {
  const { skillToolsDeclared } = await import('../src/core/shared-skills/manifest.ts');
  expect(skillToolsDeclared({ requirements: [] }, '---\nname: a\ndescription: x\n---\nBody\n')).toBe(false);
  expect(skillToolsDeclared({ requirements: [] }, '---\nname: a\ntools: []\n---\nBody\n')).toBe(true);
  expect(skillToolsDeclared({ requirements: ['tool:search'] }, '---\nname: a\n---\nBody\n')).toBe(true);
  expect(skillToolsDeclared({ requirements: [] }, '---\nname: [unclosed\n---\nBody\n')).toBe(true);
  expect(skillToolsDeclared({ requirements: [] }, null)).toBe(true);
  expect(skillToolsDeclared({ requirements: [], tools_declared: false }, null)).toBe(false);
});
