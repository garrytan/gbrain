/**
 * A brain-resident pack whose real folder name begins with two dots
 * (`..shared`, `..skills`) must still serve its skills; a symlink that leaves
 * the pack must still be refused (src/core/skillpack/brain-resident-locate.ts,
 * getResidentSkillDetail).
 *
 * Authoring gate:
 * 1. Protects: get_skill with a source_id serves a SKILL.md that lives in a
 *    folder named `..shared` inside the pack (reached through an in-pack
 *    symlink, which is allowed by design) and still refuses anything that
 *    resolves outside the pack root.
 * 2. Regression that fails it: the containment check treating any relative
 *    path that starts with the two characters `..` as "outside", instead of
 *    only a `..` path component. Or, the other way round, loosening the check
 *    so a sibling folder or an outside symlink is served.
 * 3. Why existing coverage misses it: skillpack-brain-resident-locate.test.ts
 *    only has the escape case (a symlink to an unrelated outside dir); no test
 *    uses an in-pack folder whose name starts with `..`, or a sibling folder
 *    that shares the pack root's name prefix.
 * 4. Production seam: none. Everything goes through the exported
 *    getResidentSkillDetail with a fake engine, as the sibling test does.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { runInitBrainPack } from '../src/core/skillpack/init-brain-pack.ts';
import { getResidentSkillDetail } from '../src/core/skillpack/brain-resident-locate.ts';
import { OperationError, type OperationContext } from '../src/core/operations.ts';

let root: string;
let packDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-brl-dotdot-'));
  packDir = join(root, 'pack-source');
  runInitBrainPack({ targetDir: packDir, name: 'deal-brain', firstSkillSlug: 'diligence', schemaPack: 'gbrain-base' });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function engineFor(localPath: string): OperationContext['engine'] {
  return {
    executeRaw: async () => [{
      id: 'default', name: 'default', local_path: localPath, last_commit: null, last_sync_at: null,
      config: {}, created_at: new Date(), archived: false,
    }],
    getConfig: async () => null,
  } as unknown as OperationContext['engine'];
}

function ctxFor(localPath: string): OperationContext {
  return {
    engine: engineFor(localPath),
    config: {} as OperationContext['config'],
    logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as OperationContext['logger'],
    dryRun: false,
    remote: false,
  } as OperationContext;
}

function skillMd(title: string): string {
  return `---\nname: diligence\ndescription: ${title}\n---\n\n# diligence\n\n${title}\n`;
}

async function expectEscape(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(OperationError);
    expect((e as OperationError).code).toBe('storage_error');
    expect((e as OperationError).message).toContain('escaped');
    return;
  }
  throw new Error('expected the skill path to be refused as escaped, but the call resolved');
}

describe('getResidentSkillDetail with a folder whose name starts with two dots', () => {
  test('serves a skill reached through a symlink into an in-pack ..shared folder', async () => {
    const real = join(packDir, '..shared', 'diligence');
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'SKILL.md'), skillMd('lives in the dotdot folder'));
    rmSync(join(packDir, 'skills', 'diligence'), { recursive: true, force: true });
    symlinkSync(join('..', '..shared', 'diligence'), join(packDir, 'skills', 'diligence'), 'dir');

    const detail = await getResidentSkillDetail(ctxFor(packDir), 'default', 'diligence');
    expect(detail.body).toContain('lives in the dotdot folder');
  });

  test('serves a skill when the whole skills folder is a symlink to an in-pack ..skills folder', async () => {
    renameSync(join(packDir, 'skills'), join(packDir, '..skills'));
    symlinkSync('..skills', join(packDir, 'skills'), 'dir');

    const detail = await getResidentSkillDetail(ctxFor(packDir), 'default', 'diligence');
    expect(detail.name).toBe('diligence');
    expect(detail.body).toContain('# diligence');
  });

  test('serves a skill when the pack root itself sits under a ..drafts folder', async () => {
    const nested = join(root, '..drafts', 'pack');
    mkdirSync(join(root, '..drafts'), { recursive: true });
    runInitBrainPack({ targetDir: nested, name: 'deal-brain', firstSkillSlug: 'diligence', schemaPack: 'gbrain-base' });

    const detail = await getResidentSkillDetail(ctxFor(nested), 'default', 'diligence');
    expect(detail.body).toContain('# diligence');
  });
});

describe('getResidentSkillDetail still refuses a skill that leaves the pack', () => {
  test('refuses a skill symlinked to an outside folder with a plain name', async () => {
    const outside = join(root, 'outside-skill');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'SKILL.md'), skillMd('TOP SECRET OUTSIDE PACK'));
    rmSync(join(packDir, 'skills', 'diligence'), { recursive: true, force: true });
    symlinkSync(outside, join(packDir, 'skills', 'diligence'), 'dir');

    await expectEscape(getResidentSkillDetail(ctxFor(packDir), 'default', 'diligence'));
  });

  test('refuses a skill symlinked to an outside folder whose name starts with two dots', async () => {
    const outside = join(root, '..outside', 'diligence');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'SKILL.md'), skillMd('TOP SECRET OUTSIDE PACK'));
    rmSync(join(packDir, 'skills', 'diligence'), { recursive: true, force: true });
    symlinkSync(outside, join(packDir, 'skills', 'diligence'), 'dir');

    await expectEscape(getResidentSkillDetail(ctxFor(packDir), 'default', 'diligence'));
  });

  test('refuses a skill symlinked into a sibling folder that shares the pack root name prefix', async () => {
    const sibling = join(root, 'pack-source2', 'diligence');
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'SKILL.md'), skillMd('TOP SECRET SIBLING PACK'));
    rmSync(join(packDir, 'skills', 'diligence'), { recursive: true, force: true });
    symlinkSync(sibling, join(packDir, 'skills', 'diligence'), 'dir');

    await expectEscape(getResidentSkillDetail(ctxFor(packDir), 'default', 'diligence'));
  });

  test('refuses a skills folder that is a symlink to an outside folder', async () => {
    const outside = join(root, 'outside-skills');
    mkdirSync(join(outside, 'diligence'), { recursive: true });
    writeFileSync(join(outside, 'diligence', 'SKILL.md'), skillMd('TOP SECRET OUTSIDE SKILLS'));
    rmSync(join(packDir, 'skills'), { recursive: true, force: true });
    symlinkSync(outside, join(packDir, 'skills'), 'dir');

    await expectEscape(getResidentSkillDetail(ctxFor(packDir), 'default', 'diligence'));
  });
});
