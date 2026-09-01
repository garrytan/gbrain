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
import { afterAll, beforeAll, describe, expect, test, afterEach } from 'bun:test';
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
  // Engine lifecycle in beforeAll/afterAll per the test-isolation rules
  // (R3/R4): one engine for the live-precondition tests, disconnected so it
  // never leaks across files in the shard process.
  let engine: import('../src/core/pglite-engine.ts').PGLiteEngine;
  beforeAll(async () => {
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => {
    await engine.disconnect();
  });

  test('null engine -> ok skip (no connected brain)', async () => {
    const dir = makeDir('gbrain-precond-');
    const check = await skillPreconditionsCheck(dir, null);
    expect(check.name).toBe('skill_preconditions');
    expect(check.status).toBe('ok');
    expect(check.message).toBe('skill preconditions not checked (no connected brain)');
  });

  test('#4278 bare `source` met by a populated default-only brain', async () => {
    // Pre-fix, the doctor wiring filtered `id <> 'default'`, so a healthy
    // single-source brain (everything in 'default') failed `requires: source`
    // forever — a permanent doctor WARN on real bundled skills. No other
    // source is registered here, so the ONLY way this passes is by counting
    // the populated default corpus.
    await engine.putPage('notes/one', {
      type: 'note', title: 'One', compiled_truth: 'corpus content',
    }, { sourceId: 'default' });
    const dir = makeDir('gbrain-precond-live-');
    mkdirSync(join(dir, 'needs-corpus'));
    writeFileSync(
      join(dir, 'needs-corpus', 'SKILL.md'),
      `---\nname: needs-corpus\ndescription: test skill\nrequires:\n  - source\n---\n\n# needs-corpus\n`,
    );
    const check = await skillPreconditionsCheck(dir, engine as never);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('all met');

    // Regression guard for the split: `source:<id>` is an EXISTENCE
    // contract — a registered-but-never-synced source is met. A naive
    // shared populated-only accessor would flip this to warn.
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('newsrc', 'newsrc') ON CONFLICT (id) DO NOTHING`,
    );
    const dir2 = makeDir('gbrain-precond-live2-');
    mkdirSync(join(dir2, 'needs-newsrc'));
    writeFileSync(
      join(dir2, 'needs-newsrc', 'SKILL.md'),
      `---\nname: needs-newsrc\ndescription: test skill\nrequires:\n  - source:newsrc\n---\n\n# needs-newsrc\n`,
    );
    const check2 = await skillPreconditionsCheck(dir2, engine as never);
    expect(check2.status).toBe('ok');
    expect(check2.message).toContain('all met');
  }, 60_000);
});
