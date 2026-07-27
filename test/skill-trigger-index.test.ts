/**
 * Unit suite for `src/core/skill-trigger-index.ts` — the v0.41.11
 * shared primitive that unifies frontmatter-declared triggers with
 * curated RESOLVER.md / AGENTS.md rows.
 *
 * Hermetic: every case builds a fresh tempdir skills tree and runs the
 * loader against it. No PGLite, no env var mutation (R1/R2 from
 * CLAUDE.md test-isolation rules), no mock.module.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  FRONTMATTER_SECTION,
  _resetWarnedSkillsForTests,
  entriesToResolverContent,
  findPrimaryResolverPath,
  loadSkillTriggerIndex,
} from '../src/core/skill-trigger-index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEMPDIRS: string[] = [];

function makeSkillsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'skill-trigger-index-'));
  const skillsDir = join(dir, 'skills');
  mkdirSync(skillsDir, { recursive: true });
  TEMPDIRS.push(dir);
  return skillsDir;
}

function writeSkill(skillsDir: string, name: string, content: string): void {
  const dir = join(skillsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), content);
}

function skillWithTriggers(name: string, triggers: string[]): string {
  const triggerLines = triggers.map(t => `  - "${t}"`).join('\n');
  return `---
name: ${name}
description: Test skill ${name}.
triggers:
${triggerLines}
---

# ${name}
Test body.
`;
}

afterAll(() => {
  for (const d of TEMPDIRS) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

beforeEach(() => {
  _resetWarnedSkillsForTests();
});

// ---------------------------------------------------------------------------
// Frontmatter auto-registration
// ---------------------------------------------------------------------------

describe('loadSkillTriggerIndex — frontmatter auto-registration', () => {
  test('skill with block-form triggers, no RESOLVER.md → frontmatter entries appear', () => {
    const skillsDir = makeSkillsDir();
    writeSkill(skillsDir, 'query', skillWithTriggers('query', ['what do we know', 'who is']));

    const entries = loadSkillTriggerIndex(skillsDir);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      trigger: 'what do we know',
      skillPath: 'skills/query/SKILL.md',
      isGStack: false,
      section: FRONTMATTER_SECTION,
      source: 'frontmatter',
    });
    expect(entries[1].trigger).toBe('who is');
    expect(entries[1].source).toBe('frontmatter');
  });

  test('skill with inline-form triggers (triggers: ["a", "b"]) parses the same', () => {
    const skillsDir = makeSkillsDir();
    writeSkill(skillsDir, 'lint', `---
name: lint
triggers: ["lint this", "audit pages"]
---
body
`);

    const entries = loadSkillTriggerIndex(skillsDir);
    const triggers = entries.map(e => e.trigger).sort();
    expect(triggers).toEqual(['audit pages', 'lint this']);
    expect(entries.every(e => e.source === 'frontmatter')).toBe(true);
  });

  test('skill with no triggers: field → not registered, no error', () => {
    const skillsDir = makeSkillsDir();
    writeSkill(skillsDir, 'install', '# Deprecated skill — replaced by setup.\n\nNo frontmatter.\n');

    const entries = loadSkillTriggerIndex(skillsDir);
    expect(entries).toEqual([]);
  });

  test('skill with empty triggers: array → not registered', () => {
    const skillsDir = makeSkillsDir();
    writeSkill(skillsDir, 'empty', `---
name: empty
triggers: []
---
body
`);

    const entries = loadSkillTriggerIndex(skillsDir);
    expect(entries).toEqual([]);
  });

  test('directory without SKILL.md → silently skipped', () => {
    const skillsDir = makeSkillsDir();
    // `install/` exists in the bundled tree but has no SKILL.md.
    mkdirSync(join(skillsDir, 'install'), { recursive: true });
    writeSkill(skillsDir, 'query', skillWithTriggers('query', ['what is']));

    const entries = loadSkillTriggerIndex(skillsDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].trigger).toBe('what is');
  });

  test('_brain-filing-rules.md and conventions/ subdirs are ignored', () => {
    const skillsDir = makeSkillsDir();
    // Underscore-prefixed file at the top level (not a skill).
    writeFileSync(join(skillsDir, '_brain-filing-rules.md'), '# Rules\n');
    // Underscore-prefixed directory.
    mkdirSync(join(skillsDir, '_conventions-private'), { recursive: true });
    writeFileSync(
      join(skillsDir, '_conventions-private', 'SKILL.md'),
      skillWithTriggers('_priv', ['should not appear']),
    );
    // conventions/ subtree.
    mkdirSync(join(skillsDir, 'conventions'), { recursive: true });
    writeFileSync(
      join(skillsDir, 'conventions', 'SKILL.md'),
      skillWithTriggers('conv', ['should not appear either']),
    );
    // One real skill that SHOULD register.
    writeSkill(skillsDir, 'query', skillWithTriggers('query', ['what is']));

    const entries = loadSkillTriggerIndex(skillsDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].trigger).toBe('what is');
  });

  test('non-directory entries in skillsDir → silently skipped', () => {
    const skillsDir = makeSkillsDir();
    writeFileSync(join(skillsDir, 'README.md'), '# skills/ index\n');
    writeSkill(skillsDir, 'query', skillWithTriggers('query', ['what is']));

    const entries = loadSkillTriggerIndex(skillsDir);
    expect(entries).toHaveLength(1);
  });

  test('skillsDir does not exist → empty array, no throw', () => {
    const entries = loadSkillTriggerIndex('/tmp/does-not-exist-' + Date.now());
    expect(entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RESOLVER.md merge
// ---------------------------------------------------------------------------

describe('loadSkillTriggerIndex — RESOLVER.md merge (UNION semantics)', () => {
  test('skill with frontmatter AND RESOLVER.md row → both contribute; duplicate triggers collapse', () => {
    const skillsDir = makeSkillsDir();
    writeSkill(skillsDir, 'query', skillWithTriggers('query', ['what is', 'who is']));
    writeFileSync(
      join(skillsDir, 'RESOLVER.md'),
      `# Test resolver

## Brain operations

| trigger | skill |
| --- | --- |
| what is | \`skills/query/SKILL.md\` |
| tell me about | \`skills/query/SKILL.md\` |
`,
    );

    const entries = loadSkillTriggerIndex(skillsDir);
    const triggers = entries.map(e => e.trigger).sort();
    // 'what is' present in BOTH surfaces → one entry (dedup keeps
    // frontmatter source since it's loaded first). 'who is' from
    // frontmatter only. 'tell me about' from RESOLVER.md only.
    expect(triggers).toEqual(['tell me about', 'what is', 'who is']);

    const whatIs = entries.find(e => e.trigger === 'what is')!;
    expect(whatIs.source).toBe('frontmatter'); // first occurrence wins
    const tellMe = entries.find(e => e.trigger === 'tell me about')!;
    expect(tellMe.source).toBe('resolver_md');
    expect(tellMe.section).toBe('Brain operations');
    const whoIs = entries.find(e => e.trigger === 'who is')!;
    expect(whoIs.source).toBe('frontmatter');
  });

  test('case-insensitive dedupe: "What Is" in frontmatter + "what is" in RESOLVER.md → one entry', () => {
    const skillsDir = makeSkillsDir();
    writeSkill(skillsDir, 'query', skillWithTriggers('query', ['What Is']));
    writeFileSync(
      join(skillsDir, 'RESOLVER.md'),
      `## Brain operations

| trigger | skill |
| --- | --- |
| what is | \`skills/query/SKILL.md\` |
`,
    );

    const entries = loadSkillTriggerIndex(skillsDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].trigger).toBe('What Is'); // first-occurrence-wins preserves original casing
    expect(entries[0].source).toBe('frontmatter');
  });

  test('AGENTS.md at workspace root (OpenClaw layout) is merged via parent-dir scan', () => {
    const skillsDir = makeSkillsDir();
    // Put AGENTS.md ONE LEVEL UP from skillsDir (parent of `skills/`).
    const workspaceRoot = join(skillsDir, '..');
    writeFileSync(
      join(workspaceRoot, 'AGENTS.md'),
      `## Operational

| trigger | skill |
| --- | --- |
| openclaw dispatch | \`skills/query/SKILL.md\` |
`,
    );
    writeSkill(skillsDir, 'query', skillWithTriggers('query', ['what is']));

    const entries = loadSkillTriggerIndex(skillsDir);
    const triggers = entries.map(e => e.trigger).sort();
    expect(triggers).toEqual(['openclaw dispatch', 'what is']);
  });

  test('skill with RESOLVER.md row but NO frontmatter triggers → still registered from RESOLVER.md', () => {
    const skillsDir = makeSkillsDir();
    // install/ is the canonical deprecated-skill shape (no frontmatter).
    mkdirSync(join(skillsDir, 'install'), { recursive: true });
    writeFileSync(join(skillsDir, 'install', 'SKILL.md'), '# Install (Deprecated)\n');
    writeFileSync(
      join(skillsDir, 'RESOLVER.md'),
      `## Setup

| trigger | skill |
| --- | --- |
| install gbrain | \`skills/install/SKILL.md\` |
`,
    );

    const entries = loadSkillTriggerIndex(skillsDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe('resolver_md');
    expect(entries[0].trigger).toBe('install gbrain');
  });
});

// ---------------------------------------------------------------------------
// entriesToResolverContent (synthesis for runRoutingEval compat)
// ---------------------------------------------------------------------------

describe('entriesToResolverContent', () => {
  test('synthesized markdown is re-parseable by parseResolverEntries', async () => {
    const { parseResolverEntries } = await import('../src/core/check-resolvable.ts');
    const skillsDir = makeSkillsDir();
    writeSkill(skillsDir, 'query', skillWithTriggers('query', ['what is', 'tell me about']));

    const entries = loadSkillTriggerIndex(skillsDir);
    const synthesized = entriesToResolverContent(entries);
    const reparsed = parseResolverEntries(synthesized);

    // Same skill paths and trigger strings (modulo source field).
    expect(reparsed.map(e => e.trigger).sort()).toEqual(['tell me about', 'what is']);
    expect(reparsed.every(e => e.skillPath === 'skills/query/SKILL.md')).toBe(true);
  });

  test('pipes inside trigger strings are escaped in synthesis (defensive)', () => {
    // Defense-in-depth: the synthesizer escapes `|` so it can't break
    // the markdown table row. parseResolverEntries does not currently
    // unescape (its pipe-split doesn't honor backslashes), so a
    // pipe-bearing trigger is lost on re-parse — but it ALSO doesn't
    // corrupt neighboring rows, which is the actual risk we're hedging
    // against. Real-world triggers don't contain `|` (it'd be unusual
    // natural language). Filed as v0.42+ TODO if we ever start
    // declaring pipe-bearing triggers.
    const synthesized = entriesToResolverContent([
      {
        trigger: 'option a | option b',
        skillPath: 'skills/x/SKILL.md',
        isGStack: false,
        section: FRONTMATTER_SECTION,
        source: 'frontmatter',
      },
    ]);
    expect(synthesized).toContain('option a \\| option b');
  });

  test('GStack/external entries re-emit with prose skillPath (no backticks)', async () => {
    const { parseResolverEntries } = await import('../src/core/check-resolvable.ts');
    const synthesized = entriesToResolverContent([
      {
        trigger: 'review this plan',
        skillPath: 'GStack: ceo-review',
        isGStack: true,
        section: 'Thinking',
        source: 'resolver_md',
      },
    ]);
    const reparsed = parseResolverEntries(synthesized);
    expect(reparsed).toHaveLength(1);
    expect(reparsed[0].isGStack).toBe(true);
    expect(reparsed[0].skillPath).toBe('GStack: ceo-review');
  });
});

// ---------------------------------------------------------------------------
// findPrimaryResolverPath
// ---------------------------------------------------------------------------

describe('findPrimaryResolverPath', () => {
  test('returns RESOLVER.md path when present in skillsDir', () => {
    const skillsDir = makeSkillsDir();
    const resolverPath = join(skillsDir, 'RESOLVER.md');
    writeFileSync(resolverPath, '# resolver\n');

    expect(findPrimaryResolverPath(skillsDir)).toBe(resolverPath);
  });

  test('returns AGENTS.md path when only that exists', () => {
    const skillsDir = makeSkillsDir();
    const agentsPath = join(skillsDir, 'AGENTS.md');
    writeFileSync(agentsPath, '# agents\n');

    expect(findPrimaryResolverPath(skillsDir)).toBe(agentsPath);
  });

  test('returns null when neither exists in skillsDir or parent', () => {
    const skillsDir = makeSkillsDir();
    expect(findPrimaryResolverPath(skillsDir)).toBeNull();
  });
});
