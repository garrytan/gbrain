import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..');

const expectedDreamsPackagePaths = [
  'skills/dreams/SKILL.md',
  'skills/dreams/agents/openai.yaml',
  'skills/dreams/scripts/archive-reviewed-sources.rb',
  'skills/dreams/scripts/check-index-allowlist.rb',
  'skills/dreams/scripts/export-session-audit.rb',
  'skills/dreams/scripts/finalize-session-state.rb',
  'skills/dreams/scripts/init-session-state.rb',
  'skills/dreams/scripts/inventory.rb',
  'skills/dreams/scripts/post_inventory_inbox_audit.rb',
  'skills/dreams/scripts/prepare-session-owner-tasks.rb',
  'skills/dreams/scripts/proposal_audit.rb',
  'skills/dreams/scripts/record-session-owner-assignment.rb',
  'skills/dreams/scripts/redact-staged-artifacts.rb',
  'skills/dreams/scripts/review_session_counts.rb',
  'skills/dreams/scripts/stamp-indexed-at.rb',
  'skills/dreams/scripts/sync-temporal-metadata.rb',
  'skills/dreams/scripts/test-archive-reviewed-sources.rb',
  'skills/dreams/scripts/test-check-index-allowlist.rb',
  'skills/dreams/scripts/test-export-session-audit.rb',
  'skills/dreams/scripts/test-finalize-session-state.rb',
  'skills/dreams/scripts/test-init-session-state.rb',
  'skills/dreams/scripts/test-inventory.rb',
  'skills/dreams/scripts/test-redact-staged-artifacts.rb',
  'skills/dreams/scripts/test-review-session-counts.rb',
  'skills/dreams/scripts/test-session-owner-workflow.rb',
  'skills/dreams/scripts/test-skill-contract.rb',
  'skills/dreams/scripts/test-stamp-indexed-at.rb',
  'skills/dreams/scripts/test-sync-temporal-metadata.rb',
  'skills/dreams/scripts/test-validate-curated-pages.rb',
  'skills/dreams/scripts/test-validate-review-ledger.rb',
  'skills/dreams/scripts/test-validate-session-state.rb',
  'skills/dreams/scripts/validate-curated-pages.rb',
  'skills/dreams/scripts/validate-review-ledger.rb',
  'skills/dreams/scripts/validate-session-owner-reports.rb',
  'skills/dreams/scripts/validate-session-state.rb',
  'skills/dreams/templates/review-ledger-row.json',
  'skills/dreams/templates/session-counts.json',
].sort();

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8');
}

describe('Dreams review workflow skill', () => {
  test('ships the full Dreams package inventory, scripts, tests, and templates', () => {
    const actualPaths = readdirSync(join(repoRoot, 'skills/dreams'), { recursive: true })
      .map(String)
      .filter((rel) => statSync(join(repoRoot, 'skills/dreams', rel)).isFile())
      .map((rel) => `skills/dreams/${rel}`)
      .sort();

    expect(actualPaths).toEqual(expectedDreamsPackagePaths);
    expect(actualPaths.length).toBe(37);
    expect(actualPaths.filter((p) => p.endsWith('.rb')).length).toBe(33);

    const totalLines = actualPaths
      .map((p) => read(p).split('\n').length)
      .reduce((sum, count) => sum + count, 0);
    expect(totalLines).toBeGreaterThan(8500);

    for (const templatePath of [
      'skills/dreams/templates/review-ledger-row.json',
      'skills/dreams/templates/session-counts.json',
    ]) {
      expect(() => JSON.parse(read(templatePath))).not.toThrow();
    }
  });

  test('ships a resolver-wired skill with review-first safety boundaries', () => {
    const skillPath = 'skills/dreams/SKILL.md';
    expect(existsSync(join(repoRoot, skillPath)), `missing ${skillPath}`).toBe(true);

    const skill = read(skillPath);
    expect(skill).toContain('redacted `~/brain/inbox/**` draft candidates');
    expect(skill).toContain('must not import raw');
    expect(skill).toContain('unattended full run');
    expect(skill).toContain('--apply --sync --commit --push');
    expect(skill).toContain('commit and push');
    expect(skill).toContain('memory_units');
    expect(skill).toContain('importance_score');
    expect(skill).toContain('session-owner');
    expect(skill).toContain('proposal mirrors');
    expect(skill).toContain('indexed_at');
    expect(skill).toContain('evidence lookup');
    expect(skill).toContain('validate-review-ledger.rb');
    expect(skill).toContain('validate-session-owner-reports.rb');
    expect(skill).toContain('validate-curated-pages.rb');
    expect(skill).toContain('archive-reviewed-sources.rb');
    expect(skill).toContain('redact-staged-artifacts.rb');
    expect(skill).toContain('review-ledger-row.json');
    expect(skill.split('\n').length).toBeGreaterThan(1100);
    expect(skill).not.toContain(['Bi', 'sh'].join(''));
    expect(skill).not.toContain('~/.codex/skills/dreams');
    expect(skill).not.toContain('разбери brain inbox');

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
