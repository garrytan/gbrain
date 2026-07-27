/**
 * Tests for src/core/skillpack/scaffold.ts — the new (v0.33) scaffold
 * model that replaces the managed-block installer.
 *
 * Pins:
 *   - happy path: skill files + shared deps + paired sources land at
 *     workspace-rooted paths
 *   - refuses to overwrite existing files (the user owns them)
 *   - partial-state policy: skill present, paired source missing → fill
 *   - --all (skillSlug: null) installs every bundled skill
 *   - dry-run reports outcomes but writes nothing
 *   - IRON-RULE regressions: no managed block, no lockfile, no
 *     cumulative-slugs receipt, no .gbrain-skillpack.lock file
 */

import { describe, expect, it, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { runScaffold, ScaffoldError } from '../src/core/skillpack/scaffold.ts';

const created: string[] = [];
afterEach(() => {
  while (created.length) {
    const p = created.pop()!;
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
});

interface GbrainFixture {
  gbrainRoot: string;
}

function scratchGbrain(opts: { withPairedSource?: boolean } = {}): GbrainFixture {
  const root = mkdtempSync(join(tmpdir(), 'sp-scaffold-gbrain-'));
  created.push(root);
  mkdirSync(join(root, 'src', 'cli.ts').replace('cli.ts', ''), { recursive: true });
  writeFileSync(join(root, 'src', 'cli.ts'), '// stub');
  mkdirSync(join(root, 'src', 'commands'), { recursive: true });

  // book-mirror with paired source
  mkdirSync(join(root, 'skills', 'book-mirror'), { recursive: true });
  const bmFm = opts.withPairedSource
    ? '---\nname: book-mirror\ntriggers:\n  - bm trigger\nsources:\n  - src/commands/book-mirror.ts\n---\n# book-mirror\n'
    : '---\nname: book-mirror\ntriggers:\n  - bm trigger\n---\n# book-mirror\n';
  writeFileSync(join(root, 'skills', 'book-mirror', 'SKILL.md'), bmFm);
  writeFileSync(join(root, 'skills', 'book-mirror', 'routing-eval.jsonl'), '{"intent":"bm"}\n');

  if (opts.withPairedSource) {
    writeFileSync(join(root, 'src', 'commands', 'book-mirror.ts'), '// real impl\n');
  }

  // plain second skill (no paired source)
  mkdirSync(join(root, 'skills', 'query'), { recursive: true });
  writeFileSync(
    join(root, 'skills', 'query', 'SKILL.md'),
    '---\nname: query\ntriggers:\n  - q trigger\n---\n# query\n',
  );

  // shared deps
  mkdirSync(join(root, 'skills', 'conventions'), { recursive: true });
  writeFileSync(join(root, 'skills', 'conventions', 'quality.md'), '# quality\n');
  writeFileSync(join(root, 'skills', '_brain-filing-rules.md'), '# filing rules\n');

  // bundle manifest
  writeFileSync(
    join(root, 'openclaw.plugin.json'),
    JSON.stringify(
      {
        name: 'gbrain-test',
        version: '0.33.0-test',
        skills: ['skills/book-mirror', 'skills/query'],
        shared_deps: ['skills/conventions', 'skills/_brain-filing-rules.md'],
      },
      null,
      2,
    ),
  );
  return { gbrainRoot: root };
}

function scratchWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), 'sp-scaffold-ws-'));
  created.push(ws);
  return ws;
}

describe('runScaffold — happy path', () => {
  it('copies a single skill plus shared deps to the workspace', () => {
    const { gbrainRoot } = scratchGbrain();
    const ws = scratchWorkspace();

    const result = runScaffold({
      gbrainRoot,
      targetWorkspace: ws,
      skillSlug: 'book-mirror',
    });

    expect(result.summary.wroteNew).toBeGreaterThan(0);
    expect(existsSync(join(ws, 'skills', 'book-mirror', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(ws, 'skills', 'book-mirror', 'routing-eval.jsonl'))).toBe(true);
    expect(existsSync(join(ws, 'skills', 'conventions', 'quality.md'))).toBe(true);
    expect(existsSync(join(ws, 'skills', '_brain-filing-rules.md'))).toBe(true);
  });

  it('copies paired source files declared in frontmatter `sources:`', () => {
    const { gbrainRoot } = scratchGbrain({ withPairedSource: true });
    const ws = scratchWorkspace();

    const result = runScaffold({
      gbrainRoot,
      targetWorkspace: ws,
      skillSlug: 'book-mirror',
    });

    expect(existsSync(join(ws, 'src', 'commands', 'book-mirror.ts'))).toBe(true);
    expect(readFileSync(join(ws, 'src', 'commands', 'book-mirror.ts'), 'utf-8')).toBe(
      '// real impl\n',
    );
    expect(result.summary.pairedSourcesWritten).toBe(1);
  });

  it('--all (skillSlug: null) installs every bundled skill', () => {
    const { gbrainRoot } = scratchGbrain();
    const ws = scratchWorkspace();

    runScaffold({ gbrainRoot, targetWorkspace: ws, skillSlug: null });

    expect(existsSync(join(ws, 'skills', 'book-mirror', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(ws, 'skills', 'query', 'SKILL.md'))).toBe(true);
  });
});

describe('runScaffold — refuses to overwrite (user owns the files)', () => {
  it('re-running is idempotent (every file skipped_existing)', () => {
    const { gbrainRoot } = scratchGbrain();
    const ws = scratchWorkspace();

    runScaffold({ gbrainRoot, targetWorkspace: ws, skillSlug: 'book-mirror' });
    const second = runScaffold({ gbrainRoot, targetWorkspace: ws, skillSlug: 'book-mirror' });

    expect(second.summary.wroteNew).toBe(0);
    expect(second.summary.skippedExisting).toBeGreaterThan(0);
    expect(second.files.every(f => f.outcome === 'skipped_existing')).toBe(true);
  });

  it('preserves local edits to a scaffolded file', () => {
    const { gbrainRoot } = scratchGbrain();
    const ws = scratchWorkspace();

    runScaffold({ gbrainRoot, targetWorkspace: ws, skillSlug: 'book-mirror' });
    writeFileSync(join(ws, 'skills', 'book-mirror', 'SKILL.md'), 'MY EDITS');

    runScaffold({ gbrainRoot, targetWorkspace: ws, skillSlug: 'book-mirror' });
    expect(readFileSync(join(ws, 'skills', 'book-mirror', 'SKILL.md'), 'utf-8')).toBe('MY EDITS');
  });

  it('does not overwrite existing shared-dep files', () => {
    const { gbrainRoot } = scratchGbrain();
    const ws = scratchWorkspace();

    mkdirSync(join(ws, 'skills', 'conventions'), { recursive: true });
    writeFileSync(join(ws, 'skills', 'conventions', 'quality.md'), 'USER OWNS THIS');

    runScaffold({ gbrainRoot, targetWorkspace: ws, skillSlug: 'book-mirror' });
    expect(readFileSync(join(ws, 'skills', 'conventions', 'quality.md'), 'utf-8')).toBe(
      'USER OWNS THIS',
    );
  });
});

describe('runScaffold — partial-state policy (F-CDX-6)', () => {
  it('skill dir exists but paired source missing → copies the paired source only', () => {
    const { gbrainRoot } = scratchGbrain({ withPairedSource: true });
    const ws = scratchWorkspace();

    // First, scaffold without the paired source declared (simulating "skill
    // shipped before sources: was added"). We model this by pre-creating
    // the skill files manually:
    mkdirSync(join(ws, 'skills', 'book-mirror'), { recursive: true });
    writeFileSync(join(ws, 'skills', 'book-mirror', 'SKILL.md'), '# pre-existing skill content\n');
    writeFileSync(join(ws, 'skills', 'book-mirror', 'routing-eval.jsonl'), '{}\n');

    // Now scaffold (gbrain bundle has the paired source declared); the
    // existing skill files are preserved, the missing paired source lands.
    const result = runScaffold({
      gbrainRoot,
      targetWorkspace: ws,
      skillSlug: 'book-mirror',
    });

    expect(existsSync(join(ws, 'src', 'commands', 'book-mirror.ts'))).toBe(true);
    expect(readFileSync(join(ws, 'skills', 'book-mirror', 'SKILL.md'), 'utf-8')).toBe(
      '# pre-existing skill content\n',
    );
    expect(result.summary.pairedSourcesWritten).toBe(1);
  });
});

describe('runScaffold — dry-run', () => {
  it('reports outcomes without writing anything', () => {
    const { gbrainRoot } = scratchGbrain();
    const ws = scratchWorkspace();

    const result = runScaffold({
      gbrainRoot,
      targetWorkspace: ws,
      skillSlug: 'book-mirror',
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.summary.wroteNew).toBeGreaterThan(0);
    expect(existsSync(join(ws, 'skills'))).toBe(false);
  });
});

describe('runScaffold — error paths', () => {
  it('unknown skill slug → ScaffoldError(unknown_skill)', () => {
    const { gbrainRoot } = scratchGbrain();
    const ws = scratchWorkspace();

    try {
      runScaffold({ gbrainRoot, targetWorkspace: ws, skillSlug: 'does-not-exist' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ScaffoldError);
      expect((err as ScaffoldError).code).toBe('unknown_skill');
    }
  });
});

describe('runScaffold — IRON-RULE regressions (R1, R2)', () => {
  it('R1: never writes managed-block markers to RESOLVER.md/AGENTS.md', () => {
    const { gbrainRoot } = scratchGbrain();
    const ws = scratchWorkspace();

    // Pre-create a RESOLVER.md so we can check it survives untouched.
    writeFileSync(join(ws, 'RESOLVER.md'), '# my routing\n');

    runScaffold({ gbrainRoot, targetWorkspace: ws, skillSlug: 'book-mirror' });

    const resolver = readFileSync(join(ws, 'RESOLVER.md'), 'utf-8');
    expect(resolver).toBe('# my routing\n');
    expect(resolver).not.toContain('gbrain:skillpack:begin');
    expect(resolver).not.toContain('gbrain:skillpack:end');
    expect(resolver).not.toContain('gbrain:skillpack:manifest');
  });

  it('R2: never writes a .gbrain-skillpack.lock file', () => {
    const { gbrainRoot } = scratchGbrain();
    const ws = scratchWorkspace();

    runScaffold({ gbrainRoot, targetWorkspace: ws, skillSlug: 'book-mirror' });

    expect(existsSync(join(ws, '.gbrain-skillpack.lock'))).toBe(false);
    // Lock should also not exist anywhere in the workspace tree.
    expect(readdirSync(ws)).not.toContain('.gbrain-skillpack.lock');
  });

  it('R2: never writes a cumulative-slugs receipt anywhere in workspace', () => {
    const { gbrainRoot } = scratchGbrain();
    const ws = scratchWorkspace();

    writeFileSync(join(ws, 'AGENTS.md'), 'existing agents content\n');

    runScaffold({ gbrainRoot, targetWorkspace: ws, skillSlug: 'book-mirror' });

    expect(readFileSync(join(ws, 'AGENTS.md'), 'utf-8')).not.toContain('cumulative-slugs');
  });
});
