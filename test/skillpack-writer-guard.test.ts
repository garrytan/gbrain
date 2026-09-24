import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { confinedSkillChildWrite } from '../src/core/skillpack/writer-guard.ts';
import { applyInstall, type InstallOptions, type InstallPlan } from '../src/core/skillpack/installer.ts';
import { recordManagedRoots } from '../src/core/persistence/root-registry.ts';
import { withEnv } from './helpers/with-env.ts';

async function fixture(run: (base: string, root: string) => void | Promise<void>) {
  const base = mkdtempSync(join(tmpdir(), 'gbrain-skill-child-'));
  const root = join(base, 'workspace'); mkdirSync(root);
  try { await withEnv({ GBRAIN_HOME: join(base, 'home') }, async () => { await run(base, root); }); }
  finally { rmSync(base, { recursive: true, force: true }); }
}

test('skill child writes reject absolute, traversal and ambiguous relative paths before creating files', () => fixture((_base, root) => {
  for (const child of ['', '.', '..', '../canary', 'alpha/../canary', 'alpha/./SKILL.md', 'alpha//SKILL.md', 'alpha/',
    '/outside/SKILL.md', 'C:\\outside\\SKILL.md', 'C:outside', '\\\\host\\share\\SKILL.md', 'alpha\\..\\canary', 'alpha/\0canary', 'alpha/line\nbreak']) {
    expect(() => confinedSkillChildWrite(root, child)).toThrow(expect.objectContaining({ code: 'target_escape' }));
  }
  const target = confinedSkillChildWrite(root, 'alpha/new references/SKILL.md');
  expect(target).toBe(resolve(root, 'alpha/new references/SKILL.md'));
  expect(existsSync(dirname(target))).toBe(false);
}));

test('skill child writes preserve root aliases and missing descendants like macOS var aliases', () => fixture((base) => {
  const realVar = join(base, 'private', 'var'); mkdirSync(realVar, { recursive: true });
  const aliasVar = join(base, 'var'); symlinkSync(realVar, aliasVar, 'dir');
  const aliasRoot = join(aliasVar, 'new-workspace');
  const target = confinedSkillChildWrite(aliasRoot, 'skills/alpha/SKILL.md');
  expect(target).toBe(resolve(aliasRoot, 'skills/alpha/SKILL.md'));
  mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, 'Unmanaged instructions');
  expect(readFileSync(join(realVar, 'new-workspace/skills/alpha/SKILL.md'), 'utf8')).toBe('Unmanaged instructions');
  expect(confinedSkillChildWrite(aliasRoot, 'skills/alpha/SKILL.md')).toBe(target);
}));

test('skill child writes refuse symlinked ancestor escapes and deceptive sibling prefixes', () => fixture((_base, root) => {
  const outside = `${root}-other`; mkdirSync(outside);
  const canary = join(outside, 'SKILL.md'); writeFileSync(canary, 'Preserve this');
  symlinkSync(outside, join(root, 'escape'), 'dir');
  symlinkSync(canary, join(root, 'leaf.md'));
  for (const child of ['escape/SKILL.md', 'escape/not-created/asset.txt', 'leaf.md']) {
    expect(() => confinedSkillChildWrite(root, child)).toThrow(expect.objectContaining({ code: 'target_escape' }));
    expect(() => confinedSkillChildWrite(root, child, { dryRun: true })).toThrow(expect.objectContaining({ code: 'target_escape' }));
  }
  const parent = join(root, 'inside'); mkdirSync(parent);
  symlinkSync(parent, join(root, 'inside-alias'), 'dir');
  expect(confinedSkillChildWrite(root, 'inside-alias/new.md')).toBe(join(root, 'inside-alias/new.md'));
  expect(readFileSync(canary, 'utf8')).toBe('Preserve this');
  expect(existsSync(join(outside, 'not-created'))).toBe(false);
}));

test('skill child writes fail closed on dangling symlinks and non-directory ancestors', () => fixture((base, root) => {
  symlinkSync(join(base, 'missing-outside'), join(root, 'dangling'), 'dir');
  symlinkSync(join(base, 'missing.md'), join(root, 'dangling.md'));
  writeFileSync(join(root, 'not-a-directory'), 'Preserve this');
  for (const child of ['dangling/new.md', 'dangling.md', 'not-a-directory/new.md']) {
    expect(() => confinedSkillChildWrite(root, child)).toThrow(expect.objectContaining({ code: 'target_escape' }));
  }
  expect(() => confinedSkillChildWrite(join(root, 'dangling'), 'new.md')).toThrow(expect.objectContaining({ code: 'target_escape' }));
  expect(readFileSync(join(root, 'not-a-directory'), 'utf8')).toBe('Preserve this');
}));

test('confined children still refuse canonical roots and multiply linked files while dry runs remain read-only', () => fixture((base, root) => {
  const managed = join(base, 'canonical'); mkdirSync(managed);
  const canonical = join(managed, 'SKILL.md'); writeFileSync(canonical, 'Canonical instructions');
  recordManagedRoots(randomUUID(), [{ local_path: managed }]);
  expect(() => confinedSkillChildWrite(managed, 'SKILL.md')).toThrow(expect.objectContaining({ code: 'skill_bundle_required' }));
  expect(confinedSkillChildWrite(managed, 'new/SKILL.md', { dryRun: true })).toBe(join(managed, 'new/SKILL.md'));
  const alias = join(base, 'canonical-alias'); symlinkSync(managed, alias, 'dir');
  expect(() => confinedSkillChildWrite(alias, 'new/SKILL.md')).toThrow(expect.objectContaining({ code: 'skill_bundle_required' }));
  linkSync(canonical, join(root, 'linked.md'));
  expect(() => confinedSkillChildWrite(root, 'linked.md')).toThrow(expect.objectContaining({ code: 'skill_bundle_required' }));
  expect(readFileSync(canonical, 'utf8')).toBe('Canonical instructions');
  expect(existsSync(join(managed, 'new'))).toBe(false);
}));

test('installer child preflight prevents a partial copy before a traversal or symlink escape', () => fixture((base, root) => {
  const outside = join(base, 'outside'); mkdirSync(outside);
  const canary = join(outside, 'canary.md'); writeFileSync(canary, 'Preserve this');
  const source = join(base, 'source.md'); writeFileSync(source, 'Replacement');
  symlinkSync(outside, join(root, 'escape'), 'dir');
  for (const relTarget of ['../outside/canary.md', 'escape/canary.md']) {
    const entries = [{ source, relTarget: 'alpha/SKILL.md', sharedDep: false }, { source, relTarget, sharedDep: false }];
    const plan: InstallPlan = { gbrainRoot: base, targetSkillsDir: root, targetWorkspace: base,
      manifest: { name: 'fixture', version: '1.0.0', skills: [], shared_deps: [] }, entries,
      entryOutcomes: entries.map(entry => ({ entry, existing: false, identical: false })) };
    const opts: InstallOptions = { gbrainRoot: base, targetSkillsDir: root, targetWorkspace: base, skillSlug: 'alpha' };
    expect(() => applyInstall(plan, opts)).toThrow(expect.objectContaining({ code: 'target_escape' }));
    expect(existsSync(join(root, 'alpha/SKILL.md'))).toBe(false);
    expect(readFileSync(canary, 'utf8')).toBe('Preserve this');
  }
}));
