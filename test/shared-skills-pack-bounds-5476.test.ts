/**
 * #5476 item 2 / A-NEW-4: one canonical adoption publishes one SKILL.md per
 * declared skill plus skillpack.json, so the pack-level publication bound is
 * separate from the per-skill file bound (64). The bundled pack (75 skills)
 * must fit; a pack beyond the persistence bundle bound is refused by name.
 */
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { BUNDLE_FILE_LIMITS } from '../src/core/persistence/bundle-files.ts';
import { adoptSharedSkillpack } from '../src/core/shared-skills/publication.ts';
import { listSharedSkills } from '../src/core/shared-skills/catalog.ts';
import { SHARED_SKILL_LIMITS } from '../src/core/shared-skills/model.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';

async function fixture(run: (local: OperationContext, root: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-pack-bounds-'));
  await withEnv({ GBRAIN_HOME: join(dir, 'home'), DATABASE_URL: undefined }, async () => {
    const isolated = await isolatedSharedSkillsEngine();
    const engine = isolated.engine;
    try {
      const root = join(dir, 'default'); mkdirSync(root);
      await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [root, 'default']);
      await claimWorktree(engine, 'default', root);
      await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
      await engine.setConfig('mcp.publish_skills', 'true');
      await run({ engine, config: { engine: 'pglite' }, remote: false, sourceId: 'default', dryRun: false, logger: { info() {}, warn() {}, error() {} } }, root);
    } finally { await disposePersistenceConsumer(engine); await isolated.close(); }
  });
  rmSync(dir, { recursive: true, force: true });
}
function writePack(root: string, count: number) {
  const names = Array.from({ length: count }, (_, i) => `skill-${String(i).padStart(3, '0')}`);
  for (const name of names) {
    mkdirSync(join(root, 'skills', name), { recursive: true });
    writeFileSync(join(root, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: A synthetic fixture skill\n---\n\nInstructions for ${name}.\n`);
  }
  writeFileSync(join(root, 'skillpack.json'), JSON.stringify({ name: 'example-pack', brain_resident: true, skills: names.map(name => `skills/${name}`) }));
  return names;
}

test('the pack publication bound is the persistence bundle bound, not the per-skill file bound', () => {
  expect(SHARED_SKILL_LIMITS.packFiles).toBe(BUNDLE_FILE_LIMITS.files);
  expect(SHARED_SKILL_LIMITS.packFiles).toBeGreaterThan(SHARED_SKILL_LIMITS.files);
});

test('a 75-skill pack (the bundled set size) adopts in one canonical publication', () => fixture(async (local, root) => {
  const names = writePack(root, 75);
  const adopted = await adoptSharedSkillpack(local, 'default');
  expect(adopted.receipts.map(receipt => (receipt.write_request as { state?: string } | undefined)?.state)).toEqual(['committed']);
  const listed = await listSharedSkills(local, { limit: 100 });
  expect(listed.skills.map(skill => skill.name).sort()).toEqual(names);
}), 180_000);
