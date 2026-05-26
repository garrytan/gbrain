import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const repoRoot = new URL('..', import.meta.url).pathname;

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf-8');
}

describe('Postgres target runtime product messaging', () => {
  test('package metadata describes the current Postgres target engine story', () => {
    const pkg = JSON.parse(readRepoFile('package.json'));

    expect(pkg.description).toContain('Postgres + pgvector');
    expect(pkg.description).toContain('SQLite/offline compatibility');
    expect(pkg.description).not.toContain('Local-first');
    expect(pkg.description).not.toContain('optional Postgres');
  });

  test('README starts users on target Postgres and keeps SQLite as explicit legacy compatibility', () => {
    const readme = readRepoFile('README.md');

    expect(readme).toContain('MBrain is a Postgres + pgvector personal memory runtime');
    expect(readme).toContain('mbrain init --profile homebrew-postgres');
    expect(readme).toContain('Requires a running local Postgres server with a database named mbrain');
    expect(readme).toContain('Postgres init currently starts with `embedding_provider="none"`');
    expect(readme).toContain('Create a Postgres brain');
    expect(readme).toContain('Default target');
    expect(readme).toContain('Legacy local SQLite mode remains available with `mbrain init --local`');
    expect(readme).toContain('Explicit legacy path');
    expect(readme).toContain('for one person');
    expect(readme).toContain('personal brain');
    expect(readme).toContain('Managed Postgres');
    expect(readme).toContain('For target Postgres runtime verification, run:');
    expect(readme).toContain('Legacy local SQLite verification is isolated compatibility coverage');
    expect(readme).toContain('bun test');
    expect(readme).toContain('bun run test:e2e:sqlite');
    expect(readme).not.toContain('MBrain is a local SQLite memory layer');
    expect(readme).not.toContain('Quick Start: Local SQLite');
    expect(readme).not.toContain('SQLite is the recommended engine');
    expect(readme).not.toContain('Postgres remains optional');
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

  test('README presents SQLite as supported legacy compatibility, not future work or target default', () => {
    const readme = readRepoFile('README.md');

    expect(readme).toContain('began as a fork of [garrytan/gbrain]');
    expect(readme).toContain('SQLiteEngine');
    expect(readme).toContain('The SQLite E2E suite covers');
    expect(readme).toContain('Legacy local SQLite mode remains available');
    expect(readme).toContain('Memory Inbox');
    expect(readme).toContain('candidate status events');
    expect(readme).toContain('Managed Postgres storage estimates');
    expect(readme).toContain('Use Postgres for the target runtime');
    expect(readme).toContain('legacy SQLite/PGLite paths remain available');
    expect(readme).toContain('Historical v0 spec');
    expect(readme).not.toContain('SQLite-first');
    expect(readme).not.toContain('SQLiteEngine | Single-user local/offline personal brain | Recommended default');
    expect(readme).not.toContain('designed, community PRs welcome');
    expect(readme).not.toContain('SQLite engine implementation');
    expect(readme).not.toContain('docs/SQLITE_ENGINE.md');
    expect(existsSync(join(repoRoot, 'docs', 'SQLITE_ENGINE.md'))).toBe(false);
  });

  test('engine documentation names Postgres as the target and keeps SQLite/PGLite explicit local paths', () => {
    const engines = readRepoFile('docs/ENGINES.md');

    expect(engines).toContain('PostgresEngine` is the target runtime');
    expect(engines).toContain('Postgres + pgvector');
    expect(engines).toContain('Single-user personal brain');
    expect(engines).toContain('Offline compatibility');
    expect(engines).toContain('SQLiteEngine');
    expect(engines).toContain('stored vectors + local cosine scan');
    expect(engines).toContain('Target Postgres Runtime');
    expect(engines).toContain('explicit legacy/local contract paths');
    expect(engines).not.toContain('Optional Managed/Remote Postgres Path');
    expect(engines).not.toContain('Postgres remains the full cloud path');
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

  test('agent setup docs include installed-command readiness verification', () => {
    const readme = readRepoFile('README.md');
    const english = readRepoFile('docs/local-offline.md');
    const korean = readRepoFile('docs/local-offline.ko.md');

    for (const doc of [readme, english, korean]) {
      expect(doc).toContain('mbrain doctor --agent --json');
      expect(doc).toContain('MBRAIN_SMOKE_COMMAND=mbrain bun run smoke:installed-mcp');
    }

    expect(english).toContain('route_memory_writeback');
    expect(korean).toContain('route_memory_writeback');
  });

  test('setup skill defaults to target Postgres while preserving explicit legacy local guidance', () => {
    const setupSkill = readRepoFile('skills/setup/SKILL.md');

    expect(setupSkill).toContain('four setup paths');
    expect(setupSkill).toContain('Target Local Postgres');
    expect(setupSkill).toContain('recommended default for new personal brains');
    expect(setupSkill).toContain('does not start Postgres or create the database');
    expect(setupSkill).toContain('embedding_provider="none"');
    expect(setupSkill).toContain('For Target Local Postgres');
    expect(setupSkill).toContain('mbrain init --profile homebrew-postgres');
    expect(setupSkill).toContain('mbrain init --local');
    expect(setupSkill).toContain('Legacy Local SQLite');
    expect(setupSkill).toContain('Managed Postgres');
    expect(setupSkill).toContain('mkdir -p "$HOME/.local/bin"');
    expect(setupSkill).not.toContain('Default to Local SQLite');
    expect(setupSkill).not.toContain('Local SQLite Setup (recommended default)');
    expect(setupSkill).not.toContain('mbrain init --local` -- recommended');
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
