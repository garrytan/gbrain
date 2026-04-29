import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const repoRoot = new URL('..', import.meta.url).pathname;

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf-8');
}

describe('SQLite-first product messaging', () => {
  test('package metadata describes the current local-first engine story', () => {
    const pkg = JSON.parse(readRepoFile('package.json'));

    expect(pkg.description).toContain('Local-first');
    expect(pkg.description).toContain('SQLite');
    expect(pkg.description).not.toContain('Postgres-native');
  });

  test('README starts users on local SQLite and keeps managed Postgres optional', () => {
    const readme = readRepoFile('README.md');

    expect(readme).toContain('MBrain is a local SQLite memory layer for one person');
    expect(readme).toContain('mbrain init --local');
    expect(readme).toContain('No Supabase, OpenAI,');
    expect(readme).toContain('SQLite is the recommended engine');
    expect(readme).toContain('single-user');
    expect(readme).toContain('personal brain');
    expect(readme).toContain('Postgres remains optional');
    expect(readme).toContain('managed scale and remote/cloud');
    expect(readme).toContain('Managed Postgres');
    expect(readme).toContain('For local/default verification, run:');
    expect(readme).toContain('bun test');
    expect(readme).toContain('bun run test:e2e:sqlite');
    expect(readme).not.toContain('Imported 342 files into Supabase');
    expect(readme).not.toContain('walk through Supabase setup');
    expect(readme).not.toContain('auto-provision Supabase via CLI');
  });

  test('README documents a stable local source checkout install path', () => {
    const readme = readRepoFile('README.md');

    expect(readme).toContain('Local source checkout install');
    expect(readme).toContain('bun install');
    expect(readme).toContain('bun run build');
    expect(readme).toContain('mkdir -p "$HOME/.local/bin"');
    expect(readme).toContain('install -m 755 bin/mbrain "$HOME/.local/bin/mbrain"');
  });

  test('README does not advertise shipped SQLite support as future work', () => {
    const readme = readRepoFile('README.md');

    expect(readme).toContain('began as a fork of [garrytan/gbrain]');
    expect(readme).toContain('SQLiteEngine');
    expect(readme).toContain('SQLite uses FTS5');
    expect(readme).toContain('stored-vector local cosine scan');
    expect(readme).toContain('Memory Inbox');
    expect(readme).toContain('candidate status events');
    expect(readme).toContain('Managed Postgres storage estimates');
    expect(readme).toContain('Historical v0 spec');
    expect(readme).not.toContain('designed, community PRs welcome');
    expect(readme).not.toContain('SQLite engine implementation');
    expect(readme).not.toContain('docs/SQLITE_ENGINE.md');
    expect(existsSync(join(repoRoot, 'docs', 'SQLITE_ENGINE.md'))).toBe(false);
  });

  test('engine documentation matches the shipped SQLite behavior', () => {
    const engines = readRepoFile('docs/ENGINES.md');

    expect(engines).toContain('Single-user personal brain');
    expect(engines).toContain('SQLiteEngine');
    expect(engines).toContain('stored vectors + local cosine scan');
    expect(engines).toContain('Optional Managed/Remote Postgres Path');
    expect(engines).not.toContain('Phase 0 contract path');
    expect(engines).not.toContain('docs/SQLITE_ENGINE.md');
    expect(engines).not.toContain('sqlite-vss or vec0');
    expect(engines).not.toContain('SQLiteEngine + sync (someday)');
    expect(engines).not.toContain('PostgresEngine (v0, ships)');
    expect(engines).not.toContain('Why not self-hosted');
    expect(engines).not.toContain('SQLite would use');
  });

  test('local offline guides include doctor verification for local capability boundaries', () => {
    const english = readRepoFile('docs/local-offline.md');
    const korean = readRepoFile('docs/local-offline.ko.md');

    for (const guide of [english, korean]) {
      expect(guide).toContain('mbrain doctor --json');
      expect(guide).toContain('local/offline');
      expect(guide).toContain('managed/Postgres');
    }
  });

  test('local offline guides make Claude MCP user scope explicit', () => {
    const english = readRepoFile('docs/local-offline.md');
    const korean = readRepoFile('docs/local-offline.ko.md');

    for (const guide of [english, korean]) {
      expect(guide).toContain('claude mcp add -s user mbrain -- mbrain serve');
      expect(guide).toContain('mbrain setup-agent --claude --scope local');
      expect(guide).toContain('mkdir -p "$HOME/.local/bin"');
    }
  });

  test('setup skill reflects local SQLite support instead of stale Postgres-only guidance', () => {
    const setupSkill = readRepoFile('skills/setup/SKILL.md');

    expect(setupSkill).toContain('mbrain init --local');
    expect(setupSkill).toContain('Local SQLite');
    expect(setupSkill).toContain('Managed Postgres');
    expect(setupSkill).toContain('mkdir -p "$HOME/.local/bin"');
    expect(setupSkill).not.toContain('There is no `--local`, `--sqlite`, or offline mode');
    expect(setupSkill).not.toContain('MBrain requires Postgres + pgvector');
    expect(setupSkill).not.toContain('Every check should be OK');
    expect(setupSkill).not.toContain('Live Sync Setup (MUST ADD)');
    expect(setupSkill).not.toContain('pooler bug is silently skipping pages');
  });

  test('repository no longer ships historical RFC docs as current guidance', () => {
    const rfcDir = join(repoRoot, 'docs', 'rfcs');
    const rfcFiles = existsSync(rfcDir)
      ? readdirSync(rfcDir).filter((name) => name.endsWith('.md'))
      : [];

    expect(rfcFiles).toEqual([]);
  });

  test('current guidance does not link to deleted RFC docs', () => {
    const guidance = [
      readRepoFile('README.md'),
      readRepoFile('docs/ENGINES.md'),
      readRepoFile('docs/MCP_INSTRUCTIONS.md'),
      readRepoFile('src/core/operations.ts'),
    ].join('\n');

    expect(guidance).not.toContain('docs/rfcs');
    expect(guidance).not.toContain('rfcs/');
  });
});
