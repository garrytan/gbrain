/**
 * Tests for src/core/skillpack/reference.ts — the read-only update lens.
 *
 * Pins:
 *   - per-file status: missing / identical / differs
 *   - unified diff text emitted for `differs`
 *   - paired source files included via frontmatter `sources:`
 *   - framing line present (load-bearing for the new model)
 *   - --all mode: one-line-per-skill summary
 *   - binary file path: stub message, no crash
 */

import { describe, expect, it, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { runReference, runReferenceAll } from '../src/core/skillpack/reference.ts';
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

function scratchGbrain(opts: { paired?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'sp-ref-gbrain-'));
  created.push(root);
  mkdirSync(join(root, 'src', 'commands'), { recursive: true });
  writeFileSync(join(root, 'src', 'cli.ts'), '// stub');

  mkdirSync(join(root, 'skills', 'demo'), { recursive: true });
  const fm = opts.paired
    ? '---\nname: demo\ntriggers:\n  - d\nsources:\n  - src/commands/demo.ts\n---\n# demo skill\n\nLine A\nLine B\nLine C\n'
    : '---\nname: demo\ntriggers:\n  - d\n---\n# demo skill\n\nLine A\nLine B\nLine C\n';
  writeFileSync(join(root, 'skills', 'demo', 'SKILL.md'), fm);
  if (opts.paired) {
    writeFileSync(join(root, 'src', 'commands', 'demo.ts'), '// real impl\n');
  }

  mkdirSync(join(root, 'skills', 'other'), { recursive: true });
  writeFileSync(
    join(root, 'skills', 'other', 'SKILL.md'),
    '---\nname: other\ntriggers:\n  - o\n---\n# other\n',
  );

  writeFileSync(
    join(root, 'openclaw.plugin.json'),
    JSON.stringify(
      {
        name: 'gbrain-test',
        version: '0.33.0-test',
        skills: ['skills/demo', 'skills/other'],
        shared_deps: [],
      },
      null,
      2,
    ),
  );
  return root;
}

function scratchWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), 'sp-ref-ws-'));
  created.push(ws);
  return ws;
}

describe('runReference — file statuses', () => {
  it('missing: nothing scaffolded yet', () => {
    const gbrainRoot = scratchGbrain();
    const ws = scratchWorkspace();

    const result = runReference({ gbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });

    expect(result.summary.missing).toBeGreaterThan(0);
    expect(result.summary.identical).toBe(0);
    expect(result.summary.differs).toBe(0);
    expect(result.files.every(f => f.status === 'missing')).toBe(true);
  });

  it('identical: scaffolded with no edits', () => {
    const gbrainRoot = scratchGbrain();
    const ws = scratchWorkspace();
    runScaffold({ gbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });

    const result = runReference({ gbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });

    expect(result.summary.identical).toBeGreaterThan(0);
    expect(result.summary.differs).toBe(0);
    expect(result.summary.missing).toBe(0);
  });

  it('differs: user edits a scaffolded file → unified diff emitted', () => {
    const gbrainRoot = scratchGbrain();
    const ws = scratchWorkspace();
    runScaffold({ gbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });

    const skillMd = join(ws, 'skills', 'demo', 'SKILL.md');
    writeFileSync(skillMd, readFileSync(skillMd, 'utf-8') + '\n## My edits\n');

    const result = runReference({ gbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });

    expect(result.summary.differs).toBe(1);
    const differ = result.files.find(f => f.status === 'differs')!;
    expect(differ.unifiedDiff).toContain('--- a/');
    expect(differ.unifiedDiff).toContain('+++ b/');
    expect(differ.unifiedDiff).toContain('+## My edits');
  });
});

describe('runReference — paired source files', () => {
  it('includes paired source files declared in frontmatter `sources:`', () => {
    const gbrainRoot = scratchGbrain({ paired: true });
    const ws = scratchWorkspace();

    const result = runReference({ gbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });

    const pairedEntries = result.files.filter(f => f.pairedSource);
    expect(pairedEntries.length).toBe(1);
    expect(pairedEntries[0].target).toBe(join(ws, 'src', 'commands', 'demo.ts'));
  });

  it('reports differs on a paired source after user edits', () => {
    const gbrainRoot = scratchGbrain({ paired: true });
    const ws = scratchWorkspace();
    runScaffold({ gbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });

    writeFileSync(join(ws, 'src', 'commands', 'demo.ts'), '// user replaced\n');

    const result = runReference({ gbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });
    const paired = result.files.find(f => f.pairedSource)!;
    expect(paired.status).toBe('differs');
    expect(paired.unifiedDiff).toContain('user replaced');
  });
});

describe('runReference — framing line (load-bearing)', () => {
  it('emits the agent-readable framing string for single-skill mode', () => {
    const gbrainRoot = scratchGbrain();
    const ws = scratchWorkspace();
    const result = runReference({ gbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });

    expect(result.framing).toContain('as reference');
    expect(result.framing).toContain('do not blindly overwrite');
    expect(result.framing).toContain(gbrainRoot);
  });

  it('emits the framing string for --all mode (with sweep summary)', () => {
    const gbrainRoot = scratchGbrain();
    const ws = scratchWorkspace();
    const result = runReferenceAll({ gbrainRoot, targetWorkspace: ws });

    expect(result.framing).toContain('as reference');
    expect(result.skills.length).toBe(2); // demo + other
    expect(result.skills.find(s => s.slug === 'demo')).toBeDefined();
  });
});

describe('runReference --json envelope shape', () => {
  it('result is JSON-stringify-able and round-trips losslessly', () => {
    const gbrainRoot = scratchGbrain();
    const ws = scratchWorkspace();
    const result = runReference({ gbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });

    const json = JSON.stringify(result);
    const round = JSON.parse(json);
    expect(round.framing).toBe(result.framing);
    expect(round.summary).toEqual(result.summary);
    expect(round.files.length).toBe(result.files.length);
  });
});

describe('runReference — binary files', () => {
  it('emits a binary-files-differ stub when content has NUL bytes', () => {
    const gbrainRoot = scratchGbrain();
    const ws = scratchWorkspace();

    // Plant a binary file in gbrain's bundle and a different one on host.
    const binPath = join(gbrainRoot, 'skills', 'demo', 'icon.png');
    writeFileSync(binPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]));
    runScaffold({ gbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });
    writeFileSync(join(ws, 'skills', 'demo', 'icon.png'), Buffer.from([0x89, 0x50, 0x00]));

    const result = runReference({ gbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });
    const bin = result.files.find(f => f.target.endsWith('icon.png'))!;
    expect(bin.status).toBe('differs');
    expect(bin.unifiedDiff).toContain('Binary');
  });
});
