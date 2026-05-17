/**
 * Tests for `reference --apply-clean-hunks` (D15, TODO-3 folded).
 *
 * Pins:
 *   - clean apply: user's local file gets gbrain's upstream changes
 *     where context is unchanged
 *   - conflict reporting: conflicting hunks listed with file:line+kind
 *   - identical / missing / binary files reported, not touched
 *   - dry-run: outcomes computed, no writes
 *   - paired source files included
 *   - --all is intentionally NOT supported (apply one skill at a time)
 */

import { describe, expect, it, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { runReferenceApply } from '../src/core/skillpack/reference.ts';
import { runScaffold } from '../src/core/skillpack/scaffold.ts';

const created: string[] = [];
afterEach(() => {
  while (created.length) {
    const p = created.pop()!;
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
});

function scratchGbrain(): string {
  const root = mkdtempSync(join(tmpdir(), 'sp-refapply-gbrain-'));
  created.push(root);
  mkdirSync(join(root, 'src', 'commands'), { recursive: true });
  writeFileSync(join(root, 'src', 'cli.ts'), '// stub');

  mkdirSync(join(root, 'skills', 'demo'), { recursive: true });
  // Long SKILL.md so the diff has well-isolated hunks.
  const baseLines = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}`).join('\n') + '\n';
  writeFileSync(join(root, 'skills', 'demo', 'SKILL.md'), baseLines);

  writeFileSync(
    join(root, 'openclaw.plugin.json'),
    JSON.stringify(
      {
        name: 'gbrain-test',
        version: '0.33.0-test',
        skills: ['skills/demo'],
        shared_deps: [],
      },
      null,
      2,
    ),
  );
  return root;
}

function scratchWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), 'sp-refapply-ws-'));
  created.push(ws);
  return ws;
}

describe('runReferenceApply — happy paths', () => {
  it('applies upstream gbrain changes to a file the user has not edited', () => {
    const gbrainRoot = scratchGbrain();
    const ws = scratchWorkspace();
    runScaffold({ gbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });

    // gbrain ships a new version with line 15 updated. User has not
    // touched the file locally.
    const gbrainSkill = join(gbrainRoot, 'skills', 'demo', 'SKILL.md');
    writeFileSync(
      gbrainSkill,
      readFileSync(gbrainSkill, 'utf-8').replace('Line 15\n', 'Line 15 UPDATED\n'),
    );

    const userSkill = join(ws, 'skills', 'demo', 'SKILL.md');
    const result = runReferenceApply({ gbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });

    expect(result.summary.filesApplied).toBe(1);
    expect(result.summary.totalHunksApplied).toBe(1);
    expect(result.summary.totalHunksConflicted).toBe(0);
    expect(readFileSync(userSkill, 'utf-8')).toContain('Line 15 UPDATED');
  });

  it('two-way limitation: user edits in differing area DO get replaced by gbrain content', () => {
    // D15 contract: this is a TWO-WAY diff against gbrain's current
    // bundle. Without scaffold-time base tracking, we cannot tell
    // whether a difference came from gbrain or from the user. Applied
    // hunks therefore align everything to gbrain. The agent uses
    // --dry-run / reference (read-only) BEFORE applying to decide.
    const gbrainRoot = scratchGbrain();
    const ws = scratchWorkspace();
    runScaffold({ gbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });

    // gbrain changes line 25. User changes line 5 (independent areas).
    const gbrainSkill = join(gbrainRoot, 'skills', 'demo', 'SKILL.md');
    writeFileSync(
      gbrainSkill,
      readFileSync(gbrainSkill, 'utf-8').replace('Line 25\n', 'Line 25 GBRAIN\n'),
    );
    const userSkill = join(ws, 'skills', 'demo', 'SKILL.md');
    writeFileSync(
      userSkill,
      readFileSync(userSkill, 'utf-8').replace('Line 5\n', 'Line 5 USER\n'),
    );

    const result = runReferenceApply({ gbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });
    expect(result.summary.totalHunksApplied).toBeGreaterThanOrEqual(1);
    // gbrain's change lands…
    expect(readFileSync(userSkill, 'utf-8')).toContain('Line 25 GBRAIN');
    // …AND the user's edit gets overwritten (the two-way limitation).
    expect(readFileSync(userSkill, 'utf-8')).not.toContain('Line 5 USER');
  });

  it('identical file: reported as identical, not touched', () => {
    const gbrainRoot = scratchGbrain();
    const ws = scratchWorkspace();
    runScaffold({ gbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });

    const before = readFileSync(join(ws, 'skills', 'demo', 'SKILL.md'), 'utf-8');
    const result = runReferenceApply({ gbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });
    const after = readFileSync(join(ws, 'skills', 'demo', 'SKILL.md'), 'utf-8');

    expect(result.summary.filesIdentical).toBe(1);
    expect(after).toBe(before);
  });

  it('missing file: reported as missing, not created', () => {
    const gbrainRoot = scratchGbrain();
    const ws = scratchWorkspace();
    // Don't scaffold — leave target missing.

    const result = runReferenceApply({ gbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });
    expect(result.summary.filesMissing).toBe(1);
    expect(existsSync(join(ws, 'skills', 'demo', 'SKILL.md'))).toBe(false);
  });
});

describe('runReferenceApply — applied-status surface', () => {
  it('applied_clean status set when every hunk lands without conflict', () => {
    // runReferenceApply uses just-in-time diff (user→gbrain), so its
    // own before-blocks are by construction always found in the user
    // file. The conflict path is exercised structurally by the
    // underlying applyHunks tests (apply-hunks.test.ts) — see those
    // for the conflict_missing / conflict_ambiguous coverage. Here we
    // just pin the status-label surface that the CLI reports.
    const gbrainRoot = scratchGbrain();
    const ws = scratchWorkspace();
    runScaffold({ gbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });

    const gbrainSkill = join(gbrainRoot, 'skills', 'demo', 'SKILL.md');
    writeFileSync(
      gbrainSkill,
      readFileSync(gbrainSkill, 'utf-8').replace('Line 15\n', 'Line 15 GBRAIN\n'),
    );

    const result = runReferenceApply({ gbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });
    expect(result.files.some(f => f.status === 'applied_clean')).toBe(true);
  });
});

describe('runReferenceApply — dry-run', () => {
  it('reports apply outcomes without writing the file', () => {
    const gbrainRoot = scratchGbrain();
    const ws = scratchWorkspace();
    runScaffold({ gbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });

    // gbrain ships an upstream change.
    const gbrainSkill = join(gbrainRoot, 'skills', 'demo', 'SKILL.md');
    writeFileSync(
      gbrainSkill,
      readFileSync(gbrainSkill, 'utf-8').replace('Line 15\n', 'Line 15 GBRAIN\n'),
    );

    const userSkill = join(ws, 'skills', 'demo', 'SKILL.md');
    const before = readFileSync(userSkill, 'utf-8');

    const result = runReferenceApply({
      gbrainRoot,
      targetWorkspace: ws,
      skillSlug: 'demo',
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.summary.totalHunksApplied).toBeGreaterThan(0);
    // File NOT modified (dry-run).
    expect(readFileSync(userSkill, 'utf-8')).toBe(before);
  });
});

describe('runReferenceApply — binary files', () => {
  it('binary files are reported binary_skip and not touched', () => {
    const gbrainRoot = scratchGbrain();
    const ws = scratchWorkspace();

    const binPath = join(gbrainRoot, 'skills', 'demo', 'icon.png');
    writeFileSync(binPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
    runScaffold({ gbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });

    writeFileSync(join(ws, 'skills', 'demo', 'icon.png'), Buffer.from([0x89, 0x50, 0x00]));

    const result = runReferenceApply({ gbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });
    expect(result.summary.filesBinarySkipped).toBeGreaterThan(0);
    const bin = result.files.find(f => f.target.endsWith('icon.png'))!;
    expect(bin.status).toBe('binary_skip');
  });
});

describe('runReferenceApply — --all is not supported', () => {
  it('throws when called with skillSlug: null', () => {
    const gbrainRoot = scratchGbrain();
    const ws = scratchWorkspace();
    expect(() =>
      runReferenceApply({ gbrainRoot, targetWorkspace: ws, skillSlug: null }),
    ).toThrow(/--all\+--apply-clean-hunks is intentionally not supported|apply one skill/);
  });
});
