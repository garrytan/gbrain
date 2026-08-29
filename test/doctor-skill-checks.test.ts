/**
 * Skill-cluster doctor checks (src/commands/doctor/skill-checks.ts):
 * skillsManifestIntegrityCheck, skillCurrencyCheck, skillPreconditionsCheck.
 *
 * Pins:
 *   - no skills.lock.json -> ok / not-applicable;
 *   - corrupt manifest JSON -> ok "skipped" (NEVER warn — fail-safe by design);
 *   - a tampered file -> warn listing it in details.modified;
 *   - >5 drifted files -> the ", … +N more" sample truncation;
 *   - fresh manifest -> ok naming the tracked-file count;
 *   - skillCurrencyCheck with workspace === gbrain repo root -> ok / N-A;
 *   - skillCurrencyCheck against an empty workspace -> warn recommending
 *     `gbrain skillpack sync` (bundled skills classify as `new`);
 *   - skillPreconditionsCheck with a null engine -> ok skip.
 *
 * All fixtures live in mkdtemp dirs; no engine and no env mutation needed.
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  skillsManifestIntegrityCheck,
  skillCurrencyCheck,
  skillPreconditionsCheck,
} from '../src/commands/doctor/skill-checks.ts';
import {
  SKILLS_MANIFEST_FILENAME,
  computeSkillsManifest,
} from '../src/core/skills-integrity.ts';
import { findGbrainRoot } from '../src/core/skillpack/bundle.ts';

const cleanups: string[] = [];

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

/** Write `files` into a fresh tmpdir and (optionally) a matching manifest. */
function makeSkillsDir(files: Record<string, string>, withManifest: boolean): string {
  const dir = makeDir('gbrain-skillcheck-');
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  if (withManifest) {
    writeFileSync(
      join(dir, SKILLS_MANIFEST_FILENAME),
      JSON.stringify(computeSkillsManifest(dir), null, 2) + '\n',
    );
  }
  return dir;
}

describe('skillsManifestIntegrityCheck', () => {
  test('no manifest file -> ok / not-applicable', () => {
    const dir = makeSkillsDir({ 'a.md': 'alpha\n' }, false);
    const check = skillsManifestIntegrityCheck(dir);
    expect(check.name).toBe('skills_manifest_integrity');
    expect(check.status).toBe('ok');
    expect(check.message).toContain(`No ${SKILLS_MANIFEST_FILENAME}`);
    expect(check.message).toContain('integrity check not applicable');
  });

  test('corrupt manifest JSON -> ok "skipped" — NEVER warn', () => {
    const dir = makeSkillsDir({ 'a.md': 'alpha\n' }, false);
    writeFileSync(join(dir, SKILLS_MANIFEST_FILENAME), '{ this is not json');
    const check = skillsManifestIntegrityCheck(dir);
    // Pinned: an unreadable/unparseable manifest is a SKIP, not a warn —
    // this check must never block (fail-safe comment in the implementation).
    expect(check.status).toBe('ok');
    expect(check.message).toContain(`Could not verify ${SKILLS_MANIFEST_FILENAME}`);
    expect(check.message).toContain('integrity check skipped');
  });

  test('fresh manifest, untouched tree -> ok naming the tracked count', () => {
    const dir = makeSkillsDir({ 'a.md': 'alpha\n', 'b.md': 'beta\n' }, true);
    const check = skillsManifestIntegrityCheck(dir);
    expect(check.status).toBe('ok');
    expect(check.message).toBe(`2 bundled skill files match ${SKILLS_MANIFEST_FILENAME}`);
  });

  test('a tampered file -> warn listing it in details.modified', () => {
    const dir = makeSkillsDir({ 'a.md': 'alpha\n', 'b.md': 'beta\n' }, true);
    writeFileSync(join(dir, 'a.md'), 'alpha TAMPERED\n');
    const check = skillsManifestIntegrityCheck(dir);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('1 modified (a.md)');
    expect(check.message).toContain('advisory — local edits are fine');
    expect(check.message).toContain('scripts/generate-skills-manifest.ts');
    expect(check.details).toEqual({ modified: ['a.md'], missing: [], extra: [] });
  });

  test('>5 drifted files -> sample truncates with "+N more"', () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 7; i++) files[`f${i}.md`] = `body ${i}\n`;
    const dir = makeSkillsDir(files, true);
    for (let i = 1; i <= 7; i++) writeFileSync(join(dir, `f${i}.md`), `body ${i} DRIFTED\n`);
    const check = skillsManifestIntegrityCheck(dir);
    expect(check.status).toBe('warn');
    // Sample shows the first 5 (sorted manifest order) then truncates.
    expect(check.message).toContain('7 modified (f1.md, f2.md, f3.md, f4.md, f5.md, … +2 more)');
    expect(check.message).not.toContain('f6.md');
    expect((check.details as { modified: string[] }).modified).toHaveLength(7);
  });
});

describe('skillCurrencyCheck', () => {
  test('workspace === gbrain repo root -> ok / not applicable', () => {
    const root = findGbrainRoot();
    expect(root).not.toBeNull();
    const check = skillCurrencyCheck(join(root!, 'skills'));
    expect(check.name).toBe('skill_currency');
    expect(check.status).toBe('ok');
    expect(check.message).toBe('skill currency not applicable (running inside the gbrain repo)');
  });

  test('workspace missing bundled skills -> warn recommending `gbrain skillpack sync`', () => {
    const workspace = makeDir('gbrain-currency-ws-');
    const skillsDir = join(workspace, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    const check = skillCurrencyCheck(skillsDir);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('new built-in skill(s) available');
    expect(check.message).toContain('`gbrain skillpack sync`');
    const details = check.details as { new: string[]; drifted: string[] };
    expect(details.new.length).toBeGreaterThan(0);
  });
});

describe('skillPreconditionsCheck', () => {
  test('null engine -> ok skip (no connected brain)', async () => {
    const dir = makeDir('gbrain-precond-');
    const check = await skillPreconditionsCheck(dir, null);
    expect(check.name).toBe('skill_preconditions');
    expect(check.status).toBe('ok');
    expect(check.message).toBe('skill preconditions not checked (no connected brain)');
  });
});
