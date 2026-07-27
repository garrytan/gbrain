/**
 * Tests for `gbrain skillpack scrub-legacy-fence-rows` (TODO-2 folded).
 *
 * Pins:
 *   - removes legacy rows only when skill present AND triggers declared
 *   - preserves rows whose skill is missing or has no triggers
 *   - idempotent re-run is a no-op
 *   - dry-run reports plan but doesn't write
 *   - rows still inside a fence (no migrate-fence run yet) are NOT touched
 */

import { describe, expect, it, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { runScrubLegacy } from '../src/core/skillpack/scrub-legacy.ts';

const created: string[] = [];
afterEach(() => {
  while (created.length) {
    const p = created.pop()!;
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
});

function scratchWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), 'sp-sl-ws-'));
  created.push(ws);
  mkdirSync(join(ws, 'skills'), { recursive: true });
  return ws;
}

function seedSkill(ws: string, slug: string, triggers: string[] | null): void {
  const dir = join(ws, 'skills', slug);
  mkdirSync(dir, { recursive: true });
  const triggersBlock = triggers
    ? `triggers:\n${triggers.map(t => `  - "${t}"`).join('\n')}\n`
    : '';
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${slug}\n${triggersBlock}---\n# ${slug}\n`,
  );
}

describe('runScrubLegacy', () => {
  it('removes a row whose skill exists AND declares triggers', () => {
    const ws = scratchWorkspace();
    seedSkill(ws, 'book-mirror', ['mirror this book']);
    writeFileSync(
      join(ws, 'skills', 'RESOLVER.md'),
      `# RESOLVER

| "mirror this book" | \`skills/book-mirror/SKILL.md\` |
| "other unrelated" | something else |
`,
    );

    const result = runScrubLegacy({ targetWorkspace: ws });
    expect(result.removed).toEqual(['book-mirror']);
    expect(result.preserved).toEqual([]);

    const after = readFileSync(result.resolverFile!, 'utf-8');
    expect(after).not.toContain('| "mirror this book" | `skills/book-mirror/SKILL.md` |');
    expect(after).toContain('| "other unrelated" | something else |'); // user row survives
  });

  it('preserves a row whose skill directory does NOT exist', () => {
    const ws = scratchWorkspace();
    // Note: do NOT seed a skill dir.
    writeFileSync(
      join(ws, 'skills', 'RESOLVER.md'),
      `# RESOLVER\n\n| "user trigger" | \`skills/user-added/SKILL.md\` |\n`,
    );

    const result = runScrubLegacy({ targetWorkspace: ws });
    expect(result.removed).toEqual([]);
    expect(result.preserved).toEqual(['user-added']);
    expect(readFileSync(result.resolverFile!, 'utf-8')).toContain('user-added');
  });

  it('preserves a row whose skill has NO triggers declared', () => {
    const ws = scratchWorkspace();
    seedSkill(ws, 'no-triggers-skill', null); // no triggers in frontmatter
    writeFileSync(
      join(ws, 'skills', 'RESOLVER.md'),
      `| "fallback trigger" | \`skills/no-triggers-skill/SKILL.md\` |\n`,
    );

    const result = runScrubLegacy({ targetWorkspace: ws });
    expect(result.removed).toEqual([]);
    expect(result.preserved).toEqual(['no-triggers-skill']);
    // Row preserved.
    expect(readFileSync(result.resolverFile!, 'utf-8')).toContain('no-triggers-skill');
  });

  it('idempotency: re-run after scrub is a no-op', () => {
    const ws = scratchWorkspace();
    seedSkill(ws, 'book-mirror', ['mirror']);
    writeFileSync(
      join(ws, 'skills', 'RESOLVER.md'),
      `| "mirror" | \`skills/book-mirror/SKILL.md\` |\n`,
    );

    runScrubLegacy({ targetWorkspace: ws });
    const result2 = runScrubLegacy({ targetWorkspace: ws });
    expect(result2.removed).toEqual([]);
  });

  it('dry-run: reports plan but does not write', () => {
    const ws = scratchWorkspace();
    seedSkill(ws, 'book-mirror', ['mirror']);
    const original = `| "mirror" | \`skills/book-mirror/SKILL.md\` |\n`;
    writeFileSync(join(ws, 'skills', 'RESOLVER.md'), original);

    const result = runScrubLegacy({ targetWorkspace: ws, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.removed).toEqual(['book-mirror']);
    expect(readFileSync(result.resolverFile!, 'utf-8')).toBe(original);
  });

  it('skips rows still inside a fence (defensive — user has not run migrate-fence)', () => {
    const ws = scratchWorkspace();
    seedSkill(ws, 'book-mirror', ['mirror']);
    const inFence = `# RESOLVER

<!-- gbrain:skillpack:begin -->
| "mirror" | \`skills/book-mirror/SKILL.md\` |
<!-- gbrain:skillpack:end -->
`;
    writeFileSync(join(ws, 'skills', 'RESOLVER.md'), inFence);

    const result = runScrubLegacy({ targetWorkspace: ws });
    // Row was inside the fence — defensive skip.
    expect(result.removed).toEqual([]);
    expect(readFileSync(result.resolverFile!, 'utf-8')).toContain(
      '| "mirror" | `skills/book-mirror/SKILL.md` |',
    );
  });

  it('returns null resolverFile when no resolver exists', () => {
    const ws = scratchWorkspace();
    const result = runScrubLegacy({ targetWorkspace: ws });
    expect(result.resolverFile).toBeNull();
    expect(result.removed).toEqual([]);
  });

  it('mixed batch: some removed, some preserved in one pass', () => {
    const ws = scratchWorkspace();
    seedSkill(ws, 'has-triggers', ['t1']);
    seedSkill(ws, 'no-triggers', null);
    // 'missing-skill' deliberately not seeded.
    writeFileSync(
      join(ws, 'skills', 'RESOLVER.md'),
      `| "a" | \`skills/has-triggers/SKILL.md\` |
| "b" | \`skills/no-triggers/SKILL.md\` |
| "c" | \`skills/missing-skill/SKILL.md\` |
`,
    );

    const result = runScrubLegacy({ targetWorkspace: ws });
    expect(result.removed).toEqual(['has-triggers']);
    expect(result.preserved.sort()).toEqual(['missing-skill', 'no-triggers']);
  });
});
