import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..');

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8');
}

describe('Dreams review workflow skill', () => {
  test('ships a resolver-wired skill with review-first safety boundaries', () => {
    const skillPath = 'skills/dreams/SKILL.md';
    expect(existsSync(join(repoRoot, skillPath)), `missing ${skillPath}`).toBe(true);

    const skill = read(skillPath);
    expect(skill).toContain('review `~/brain/inbox/**`');
    expect(skill).toContain('Do not import raw');
    expect(skill).toContain('no push');
    expect(skill).toContain('memory_units');
    expect(skill).toContain('importance_score');
    expect(skill).toContain('search result evidence');

    const resolver = read('skills/RESOLVER.md');
    expect(resolver).toContain('$dreams');
    expect(resolver).toContain('skills/dreams/SKILL.md');

    const manifest = JSON.parse(read('skills/manifest.json')) as {
      skills: Array<{ name: string; path: string; description: string }>;
    };
    const entry = manifest.skills.find((s) => s.name === 'dreams');
    expect(entry?.path).toBe('dreams/SKILL.md');
    expect(entry?.description).toContain('review');
  });

  test('documents the hook intake recipe and keeps private markers out', () => {
    const paths = [
      'docs/guides/dreams-review-workflow.md',
      'recipes/stop-memory-capture/README.md',
      'recipes/stop-memory-capture/stop-memory-capture.ts',
      'recipes/stop-memory-capture/codex-hooks.example.json',
    ];

    const combined = paths.map((p) => {
      expect(existsSync(join(repoRoot, p)), `missing ${p}`).toBe(true);
      return read(p);
    }).join('\n');

    expect(combined).toContain('UserPromptSubmit');
    expect(combined).toContain('SubagentStop');
    expect(combined).toContain('redacted review draft');
    expect(combined).toContain('raw local evidence');
    expect(combined).toContain('curated namespaces');

    expect(combined).not.toMatch(/\/Users\/[a-z0-9._-]+/i);
    expect(combined).not.toMatch(/\/home\/[a-z0-9._-]+/i);
    expect(combined).not.toMatch(/gh[pousr]_[a-z0-9_]+/i);
    expect(combined).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  });
});
