/**
 * runHarnessReference / runHarnessReferenceApply — the harness diff lens.
 *
 * Three-way trichotomy with install-time hashes (local_edit vs
 * upstream_drift), stub-aware expected content (a fresh stub reads
 * identical), marker fallback after state loss, and clean-hunk apply that
 * refuses stub files.
 */

import { describe, expect, test, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  STUB_MARKER,
  applyHarnessBridge,
  planHarnessBridge,
  runHarnessReference,
  runHarnessReferenceApply,
} from '../src/core/skillpack/harness-bridge.ts';

const cleanups: string[] = [];
afterEach(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

const SKILL_MD = (name: string) =>
  `---\nname: ${name}\ndescription: fixture skill ${name}\n---\n# ${name}\n\nline one\nline two\nline three\n`;

function fixtureRoot(): string {
  const root = tmp('gb-ref-root-');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'cli.ts'), '// stub');
  writeFileSync(
    join(root, 'openclaw.plugin.json'),
    JSON.stringify({ name: 'fixture', version: '0.0.0.0', skills: ['skills/alpha'], shared_deps: ['skills/_rules.md'] }),
  );
  mkdirSync(join(root, 'skills', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'skills', 'alpha', 'SKILL.md'), SKILL_MD('alpha'));
  writeFileSync(join(root, 'skills', '_rules.md'), 'shared rules\n');
  writeFileSync(
    join(root, 'skills', 'manifest.json'),
    JSON.stringify({ skills: [{ name: 'alpha', path: 'alpha/SKILL.md', description: 'fixture' }] }),
  );
  writeFileSync(
    join(root, 'skills', 'plugin-lanes.json'),
    JSON.stringify({ starter_policy: 'fixture', additions: {}, base_exclusions: {}, not_added: {}, starter_gaps: {} }),
  );
  return root;
}

function install(root: string, dest: string, statePath: string, mode: 'full' | 'stub'): void {
  const plan = planHarnessBridge({ gbrainRoot: root, destDir: dest, slugs: ['alpha'], mode });
  applyHarnessBridge(plan, {
    harness: 'claude-code',
    persona: null,
    gbrainVersion: '0.0.0-test',
    statePath,
    nowIso: '2026-08-16T00:00:00Z',
  });
}

const REF = (root: string, dest: string, statePath?: string) =>
  runHarnessReference({ gbrainRoot: root, destDir: dest, slugs: ['alpha'], harness: 'claude-code', statePath });

describe('trichotomy', () => {
  test('fresh full install → all identical', () => {
    const root = fixtureRoot();
    const dest = tmp('gb-ref-dest-');
    const statePath = join(tmp('gb-ref-st-'), 's.json');
    install(root, dest, statePath, 'full');
    expect(REF(root, dest, statePath).summary).toEqual({ identical: 2, differs: 0, missing: 0 });
  });

  test('local edit → differs [local_edit] with a unified diff', () => {
    const root = fixtureRoot();
    const dest = tmp('gb-ref-dest-');
    const statePath = join(tmp('gb-ref-st-'), 's.json');
    install(root, dest, statePath, 'full');
    writeFileSync(join(dest, 'alpha', 'SKILL.md'), SKILL_MD('alpha').replace('line two', 'line two EDITED'));
    const ref = REF(root, dest, statePath);
    const d = ref.files.find(f => f.status === 'differs')!;
    expect(d.differsKind).toBe('local_edit');
    expect(d.unifiedDiff).toContain('EDITED');
  });

  test('upstream drift → differs [upstream_drift] (file still matches the install hash)', () => {
    const root = fixtureRoot();
    const dest = tmp('gb-ref-dest-');
    const statePath = join(tmp('gb-ref-st-'), 's.json');
    install(root, dest, statePath, 'full');
    // gbrain moves on; the installed file is untouched.
    writeFileSync(join(root, 'skills', 'alpha', 'SKILL.md'), SKILL_MD('alpha').replace('line three', 'line three UPSTREAM'));
    const d = REF(root, dest, statePath).files.find(f => f.status === 'differs')!;
    expect(d.differsKind).toBe('upstream_drift');
  });

  test('no install-time hash (state lost) → differsKind unknown', () => {
    const root = fixtureRoot();
    const dest = tmp('gb-ref-dest-');
    const statePath = join(tmp('gb-ref-st-'), 's.json');
    install(root, dest, statePath, 'full');
    unlinkSync(statePath);
    writeFileSync(join(root, 'skills', 'alpha', 'SKILL.md'), SKILL_MD('alpha') + 'moved\n');
    const d = REF(root, dest, statePath).files.find(f => f.status === 'differs')!;
    expect(d.differsKind).toBe('unknown');
  });

  test('deleted file → missing', () => {
    const root = fixtureRoot();
    const dest = tmp('gb-ref-dest-');
    const statePath = join(tmp('gb-ref-st-'), 's.json');
    install(root, dest, statePath, 'full');
    unlinkSync(join(dest, '_rules.md'));
    expect(REF(root, dest, statePath).summary.missing).toBe(1);
  });
});

describe('stub awareness', () => {
  test('a fresh stub reads identical (expected = rendered stub, not the source body)', () => {
    const root = fixtureRoot();
    const dest = tmp('gb-ref-dest-');
    const statePath = join(tmp('gb-ref-st-'), 's.json');
    install(root, dest, statePath, 'stub');
    expect(REF(root, dest, statePath).summary).toEqual({ identical: 2, differs: 0, missing: 0 });
  });

  test('marker fallback: state deleted, stub still judged in stub mode [CX8]', () => {
    const root = fixtureRoot();
    const dest = tmp('gb-ref-dest-');
    const statePath = join(tmp('gb-ref-st-'), 's.json');
    install(root, dest, statePath, 'stub');
    unlinkSync(statePath);
    const ref = REF(root, dest, statePath);
    expect(ref.summary.differs).toBe(0);
    const skillFile = ref.files.find(f => f.relTarget === 'alpha/SKILL.md')!;
    expect(skillFile.mode).toBe('stub');
  });
});

describe('apply-clean-hunks [CX10]', () => {
  test('upstream drift applies cleanly; the file lands on the new source', () => {
    const root = fixtureRoot();
    const dest = tmp('gb-ref-dest-');
    const statePath = join(tmp('gb-ref-st-'), 's.json');
    install(root, dest, statePath, 'full');
    const moved = SKILL_MD('alpha').replace('line three', 'line three UPSTREAM');
    writeFileSync(join(root, 'skills', 'alpha', 'SKILL.md'), moved);
    const r = runHarnessReferenceApply({ gbrainRoot: root, destDir: dest, slugs: ['alpha'], harness: 'claude-code', statePath });
    expect(r.summary.totalHunksApplied).toBeGreaterThan(0);
    expect(r.summary.totalHunksConflicted).toBe(0);
    expect(readFileSync(join(dest, 'alpha', 'SKILL.md'), 'utf-8')).toBe(moved);
  });

  test('a body-only upstream change leaves stubs identical (cold pull already serves the new body)', () => {
    const root = fixtureRoot();
    const dest = tmp('gb-ref-dest-');
    const statePath = join(tmp('gb-ref-st-'), 's.json');
    install(root, dest, statePath, 'stub');
    writeFileSync(join(root, 'skills', 'alpha', 'SKILL.md'), SKILL_MD('alpha') + 'moved\n');
    expect(REF(root, dest, statePath).summary.differs).toBe(0);
  });

  test('a drifted stub file is refused, never merged', () => {
    const root = fixtureRoot();
    const dest = tmp('gb-ref-dest-');
    const statePath = join(tmp('gb-ref-st-'), 's.json');
    install(root, dest, statePath, 'stub');
    // A hand-edited stub (or a frontmatter change upstream) makes it differ;
    // apply must refuse rather than merge into generated content.
    const stubPath = join(dest, 'alpha', 'SKILL.md');
    writeFileSync(stubPath, readFileSync(stubPath, 'utf-8') + '\nhand edit\n');
    const before = readFileSync(stubPath, 'utf-8');
    const r = runHarnessReferenceApply({ gbrainRoot: root, destDir: dest, slugs: ['alpha'], harness: 'claude-code', statePath });
    expect(r.summary.refusedStub).toBe(1);
    expect(readFileSync(stubPath, 'utf-8')).toBe(before);
    expect(before).toContain(STUB_MARKER);
  });

  test('dry-run is inert', () => {
    const root = fixtureRoot();
    const dest = tmp('gb-ref-dest-');
    const statePath = join(tmp('gb-ref-st-'), 's.json');
    install(root, dest, statePath, 'full');
    const before = readFileSync(join(dest, 'alpha', 'SKILL.md'), 'utf-8');
    writeFileSync(join(root, 'skills', 'alpha', 'SKILL.md'), SKILL_MD('alpha') + 'moved\n');
    const r = runHarnessReferenceApply({
      gbrainRoot: root,
      destDir: dest,
      slugs: ['alpha'],
      harness: 'claude-code',
      statePath,
      dryRun: true,
    });
    expect(r.summary.totalHunksApplied).toBeGreaterThan(0);
    expect(readFileSync(join(dest, 'alpha', 'SKILL.md'), 'utf-8')).toBe(before);
  });

  test('stub installs ship aux files; a deleted aux reports missing like any other file', () => {
    const root = fixtureRoot();
    writeFileSync(join(root, 'skills', 'alpha', 'aux.md'), 'aux\n');
    const dest = tmp('gb-ref-dest-');
    const statePath = join(tmp('gb-ref-st-'), 's.json');
    install(root, dest, statePath, 'stub');
    expect(existsSync(join(dest, 'alpha', 'aux.md'))).toBe(true); // closure shipped
    expect(REF(root, dest, statePath).summary.missing).toBe(0);
    unlinkSync(join(dest, 'alpha', 'aux.md'));
    expect(REF(root, dest, statePath).summary.missing).toBe(1);
  });

  test('unknown provenance is refused by apply (pre-existing file the install skipped)', () => {
    const root = fixtureRoot();
    const dest = tmp('gb-ref-dest-');
    const statePath = join(tmp('gb-ref-st-'), 's.json');
    // A user file exists BEFORE the install: skipped_existing, never hashed.
    mkdirSync(join(dest, 'alpha'), { recursive: true });
    writeFileSync(join(dest, 'alpha', 'SKILL.md'), SKILL_MD('alpha') + 'mine, before the bridge\n');
    install(root, dest, statePath, 'full');
    const r = runHarnessReferenceApply({ gbrainRoot: root, destDir: dest, slugs: ['alpha'], harness: 'claude-code', statePath });
    expect(r.summary.refusedUnknown).toBe(1);
    expect(r.summary.totalHunksApplied).toBe(0);
    expect(readFileSync(join(dest, 'alpha', 'SKILL.md'), 'utf-8')).toContain('mine, before the bridge');
  });

  test('ledger refresh after a clean apply: the NEXT upstream change still classifies as drift', () => {
    const root = fixtureRoot();
    const dest = tmp('gb-ref-dest-');
    const statePath = join(tmp('gb-ref-st-'), 's.json');
    install(root, dest, statePath, 'full');
    // First upstream move + clean apply.
    writeFileSync(join(root, 'skills', 'alpha', 'SKILL.md'), SKILL_MD('alpha').replace('line two', 'line two V2'));
    const r1 = runHarnessReferenceApply({ gbrainRoot: root, destDir: dest, slugs: ['alpha'], harness: 'claude-code', statePath });
    expect(r1.summary.totalHunksApplied).toBeGreaterThan(0);
    // Second upstream move: without the refresh this would be local_edit.
    writeFileSync(join(root, 'skills', 'alpha', 'SKILL.md'), SKILL_MD('alpha').replace('line two', 'line two V3'));
    const d = REF(root, dest, statePath).files.find(f => f.status === 'differs')!;
    expect(d.differsKind).toBe('upstream_drift');
    const r2 = runHarnessReferenceApply({ gbrainRoot: root, destDir: dest, slugs: ['alpha'], harness: 'claude-code', statePath });
    expect(r2.summary.totalHunksApplied).toBeGreaterThan(0);
    expect(readFileSync(join(dest, 'alpha', 'SKILL.md'), 'utf-8')).toContain('line two V3');
  });

  test('shared-dep drift is three-way too (hashed under the shared ledger key)', () => {
    const root = fixtureRoot();
    const dest = tmp('gb-ref-dest-');
    const statePath = join(tmp('gb-ref-st-'), 's.json');
    install(root, dest, statePath, 'full');
    writeFileSync(join(root, 'skills', '_rules.md'), 'shared rules, updated upstream\n');
    const d = REF(root, dest, statePath).files.find(f => f.relTarget === '_rules.md')!;
    expect(d.status).toBe('differs');
    expect(d.differsKind).toBe('upstream_drift');
  });
});
