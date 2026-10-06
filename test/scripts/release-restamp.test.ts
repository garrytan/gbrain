/**
 * `bun run release:restamp` (scripts/release-restamp.ts) against throwaway git
 * repositories: a bare origin, a master clone that lands competing releases,
 * and a work clone holding the branch. The generator and drift-check commands
 * are replaced through GBRAIN_RESTAMP_STEPS / GBRAIN_RESTAMP_CHECKS with the
 * real schema-migration registry generator, registry freshness check and
 * migration-order guard, pointed at the fixture.
 *
 * Fixtures: collision-heavy branch (concurrent CHANGELOG entry, colliding
 * version and migration, TODO stamp) within the 5-minute target, idempotent
 * second run, repeated restamp after master moves again, squash-merged and
 * cherry-picked migrations, a decoy integer, leftover references, genuine
 * conflicts with --continue / --abort, dirty tree, offline fetch, --dry-run,
 * --no-commit, a missing CHANGELOG entry, and the CLAUDE.md coverage contract.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { main } from '../../scripts/release-restamp.ts';
import {
  COLLISION_DOCS, OTHER_STAMPED_FILES, RESTAMP_DOCS, STAMPS, findLeftoverRefs, migrationPayloadKey, nextPatchVersion,
  rebuildChangelog, renumberMigrationText, resolveVersionOnlyHunks, splitChangelog,
} from '../../scripts/lib/restamp.ts';

const REPO = join(import.meta.dir, '..', '..');
const GEN = join(REPO, 'scripts', 'build-schema-migrations.ts');
const ORDER = join(REPO, 'scripts', 'check-schema-migration-order.ts');
const DIR = 'src/core/schema-migrations';
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function put(root: string, files: Record<string, string | null>): void {
  for (const [path, text] of Object.entries(files)) {
    const file = join(root, path);
    if (text === null) {
      rmSync(file, { force: true });
      continue;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

function read(root: string, path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

function migration(version: number, name: string, sql = `CREATE TABLE IF NOT EXISTS ${name} (id INT);`, comment = ''): string {
  return `import type { Migration } from './types.ts';\n\n${comment}export const v${String(version).padStart(3, '0')}: Migration = {\n  version: ${version},\n  name: '${name}',\n  idempotent: true,\n  sql: \`\n    ${sql}\n  \`,\n};\n`;
}

function migrationFile(version: number, name: string): string {
  return `${DIR}/v${String(version).padStart(3, '0')}-${name.replace(/_/g, '-')}.ts`;
}

function release(version: string, date: string, body: string): string {
  return `## [${version}] - ${date}\n\n${body}\n`;
}

function stamps(version: string): Record<string, string> {
  const json = (name: string) => `{\n  "name": "${name}",\n  "version": "${version}"\n}\n`;
  return {
    VERSION: `${version}\n`,
    'package.json': `{\n  "name": "fixture",\n  "version": "${version}",\n  "dependencies": {}\n}\n`,
    'openclaw.plugin.json': json('openclaw-fixture'),
    '.codex-plugin/plugin.json': json('codex-fixture'),
    '.claude-plugin/plugin.json': json('claude-fixture'),
    'BOOTSTRAP_FOR_AGENTS.md': `<!-- gbrain-runbook-stamp: ${version} -->\n# Bootstrap\n`,
  };
}

function changelog(...entries: string[]): string {
  return `# Changelog\n\nAll notable changes.\n\n${entries.join('\n')}`;
}

function regen(root: string): void {
  execFileSync('bun', [GEN, '--dir', DIR], { cwd: root, stdio: 'ignore' });
}

function commit(root: string, message: string): void {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message);
}

interface Fixture { origin: string; master: string; work: string }

/** origin (bare) seeded with v0.1.0.0 and migrations 207-208; `master` lands releases; `work` holds the branch. */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-restamp-'));
  roots.push(root);
  const origin = join(root, 'origin.git');
  const master = join(root, 'master');
  const work = join(root, 'work');
  git(root, 'init', '-q', '--bare', '-b', 'master', origin);
  git(root, 'clone', '-q', origin, master);
  for (const r of [master]) {
    git(r, 'config', 'user.email', 't@t.co');
    git(r, 'config', 'user.name', 't');
    git(r, 'checkout', '-q', '-b', 'master');
  }
  put(master, {
    ...stamps('0.1.0.0'),
    'CHANGELOG.md': changelog(release('0.1.0.0', '2026-01-01', 'First release.')),
    'TODOS.md': '# TODOS\n',
    'src/shared.ts': 'export const GREETING = "hello";\n',
    [`${DIR}/types.ts`]: 'export interface Migration { version: number; name: string; idempotent?: boolean; sql?: string }\n',
    [migrationFile(207, 'seed_one')]: migration(207, 'seed_one'),
    [migrationFile(208, 'seed_two')]: migration(208, 'seed_two'),
  });
  regen(master);
  commit(master, 'v0.1.0.0 seed');
  git(master, 'push', '-q', 'origin', 'master');
  git(root, 'clone', '-q', origin, work);
  git(work, 'config', 'user.email', 't@t.co');
  git(work, 'config', 'user.name', 't');
  git(work, 'checkout', '-q', '-b', 'feature');
  return { origin, master, work };
}

/** master ships `version` with one migration and a CHANGELOG entry. */
function landOnMaster(fx: Fixture, version: string, mig: [number, string] | null, extra: Record<string, string | null> = {}): void {
  const prev = read(fx.master, 'CHANGELOG.md');
  const { preamble, sections } = splitChangelog(prev);
  put(fx.master, {
    ...stamps(version),
    'CHANGELOG.md': [preamble, release(version, '2026-10-04', `Master release ${version}.`), ...sections.map((s) => s.text)].join('\n'),
    ...(mig ? { [migrationFile(mig[0], mig[1])]: migration(mig[0], mig[1]) } : {}),
    ...extra,
  });
  regen(fx.master);
  commit(fx.master, `v${version} master release`);
  git(fx.master, 'push', '-q', 'origin', 'master');
}

/** The branch bumps to `version`, writes its CHANGELOG entry and adds `files`. */
function branchWork(fx: Fixture, version: string, files: Record<string, string | null>, body = 'Widgets now sync twice as fast.'): void {
  const { preamble, sections } = splitChangelog(read(fx.work, 'CHANGELOG.md'));
  put(fx.work, {
    ...stamps(version),
    'CHANGELOG.md': [preamble, release(version, '2026-10-03', `${body} Upgrade to v${version}.`), ...sections.map((s) => s.text)].join('\n'),
    ...files,
  });
  regen(fx.work);
  commit(fx.work, `v${version} feat: widgets`);
}

const STEPS = JSON.stringify([{ name: 'schema migration registry', argv: ['bun', GEN, '--dir', DIR] }]);
const CHECKS = JSON.stringify([
  { name: 'schema migration registry fresh', argv: ['bun', GEN, '--dir', DIR, '--check'] },
  { name: 'schema migration order', argv: ['bun', ORDER] },
]);

function restamp(cwd: string, args: string[] = [], env: Record<string, string> = {}): { code: number; out: string } {
  const lines: string[] = [];
  const code = main(args, {
    cwd,
    log: (l) => lines.push(l),
    env: { ...process.env, GBRAIN_RESTAMP_STEPS: STEPS, GBRAIN_RESTAMP_CHECKS: CHECKS, GBRAIN_RESTAMP_DATE: '2026-10-05', GBRAIN_RESTAMP_PR_TITLE: 'v0.1.1.0 feat(sync): faster widgets', ...env },
  });
  return { code, out: lines.join('\n') };
}

const head = (r: string) => git(r, 'rev-parse', 'HEAD').trim();
const subject = (r: string, rev = 'HEAD') => git(r, 'log', '-1', '--format=%s', rev).trim();
const parents = (r: string, rev: string) => git(r, 'log', '-1', '--format=%P', rev).trim().split(' ').filter(Boolean).length;
const status = (r: string) => git(r, 'status', '--porcelain').trim();
const stateFile = (r: string) => join(r, '.git', 'gbrain-restamp.json');

describe('release:restamp end to end', () => {
  test('collision-heavy branch: concurrent CHANGELOG entry, colliding version and migration, finishes within 5 minutes', () => {
    const started = performance.now();
    const fx = fixture();
    branchWork(fx, '0.1.1.0', {
      [migrationFile(209, 'branch_widgets')]: migration(209, 'branch_widgets'),
      'TODOS.md': '# TODOS\n\n## Widget follow-ups (follow-up from v0.1.1.0)\n',
      'src/shared.ts': 'export const GREETING = "hello";\nexport const WIDGETS = true;\n',
    });
    landOnMaster(fx, '0.1.1.0', [209, 'master_gadgets']);
    const before = read(fx.work, migrationFile(209, 'branch_widgets'));

    const r = restamp(fx.work);
    expect(r.code).toBe(0);
    expect(performance.now() - started).toBeLessThan(300_000);

    expect(subject(fx.work)).toBe('v0.1.2.0 chore(release): restamp onto master v0.1.1.0');
    expect(parents(fx.work, 'HEAD^')).toBe(2);
    expect(status(fx.work)).toBe('');
    expect(existsSync(stateFile(fx.work))).toBe(false);
    for (const s of STAMPS) expect(s.read(read(fx.work, s.file))).toBe('0.1.2.0');

    const log = splitChangelog(read(fx.work, 'CHANGELOG.md')).sections;
    expect(log.map((s) => s.header)).toEqual(['## [0.1.2.0] - 2026-10-05', '## [0.1.1.0] - 2026-10-04', '## [0.1.0.0] - 2026-01-01']);
    expect(log[0]!.text).toContain('Widgets now sync twice as fast. Upgrade to v0.1.2.0.');
    expect(log[1]!.text).toContain('Master release 0.1.1.0.');
    expect(read(fx.work, 'TODOS.md')).toContain('(follow-up from v0.1.2.0)');

    expect(existsSync(join(fx.work, migrationFile(209, 'branch_widgets')))).toBe(false);
    const moved = read(fx.work, migrationFile(210, 'branch_widgets'));
    expect(moved).toContain('export const v210: Migration');
    expect(moved).toContain('version: 210,');
    expect(migrationPayloadKey(moved, 'x.ts')).toBe(migrationPayloadKey(before, 'x.ts'));
    expect(read(fx.work, migrationFile(209, 'master_gadgets'))).toBe(migration(209, 'master_gadgets'));
    expect(read(fx.work, `${DIR}/registry.generated.ts`)).toContain("import { v210 } from './v210-branch-widgets.ts';");
    expect(read(fx.work, 'src/shared.ts')).toContain('WIDGETS');

    expect(r.out).toContain(`v209 -> v210  ${migrationFile(209, 'branch_widgets')} -> ${migrationFile(210, 'branch_widgets')}`);
    expect(r.out).toContain(COLLISION_DOCS);
    expect(r.out).toContain('no database was touched');
    expect(r.out).toContain('PR title: v0.1.2.0 feat(sync): faster widgets');
    expect(r.out).toContain('Verify: bun run verify');

    const again = restamp(fx.work);
    expect(again.code).toBe(0);
    expect(again.out).toContain('Nothing to change');
    expect(subject(fx.work)).toBe('v0.1.2.0 chore(release): restamp onto master v0.1.1.0');
  }, 360_000);

  test('repeated restamp after master moves again renumbers and re-stamps once more', () => {
    const fx = fixture();
    branchWork(fx, '0.1.1.0', { [migrationFile(209, 'branch_widgets')]: migration(209, 'branch_widgets') });
    landOnMaster(fx, '0.1.1.0', [209, 'master_gadgets']);
    expect(restamp(fx.work).code).toBe(0);
    landOnMaster(fx, '0.1.2.0', [210, 'master_sprockets']);

    const r = restamp(fx.work);
    expect(r.code).toBe(0);
    expect(subject(fx.work)).toBe('v0.1.3.0 chore(release): restamp onto master v0.1.2.0');
    expect(existsSync(join(fx.work, migrationFile(211, 'branch_widgets')))).toBe(true);
    expect(existsSync(join(fx.work, migrationFile(210, 'branch_widgets')))).toBe(false);
    const headers = splitChangelog(read(fx.work, 'CHANGELOG.md')).sections.map((s) => s.header);
    expect(headers).toEqual(['## [0.1.3.0] - 2026-10-05', '## [0.1.2.0] - 2026-10-04', '## [0.1.1.0] - 2026-10-04', '## [0.1.0.0] - 2026-01-01']);
    expect(read(fx.work, 'CHANGELOG.md')).toContain('Upgrade to v0.1.3.0.');
  }, 120_000);

  test('a migration squash-merged to master at the same path is published: never renumbered', () => {
    const fx = fixture();
    const shared = { [migrationFile(209, 'shared_index')]: migration(209, 'shared_index') };
    branchWork(fx, '0.1.1.0', { ...shared, [migrationFile(210, 'branch_extra')]: migration(210, 'branch_extra') });
    landOnMaster(fx, '0.1.1.0', null, shared);
    const r = restamp(fx.work);
    expect(r.code).toBe(0);
    expect(read(fx.work, migrationFile(209, 'shared_index'))).toBe(migration(209, 'shared_index'));
    expect(existsSync(join(fx.work, migrationFile(210, 'branch_extra')))).toBe(true);
    expect(r.out).not.toContain('Migration renumbering');
  }, 120_000);

  test('a branch copy of a migration master published under another number stops before touching anything', () => {
    const fx = fixture();
    branchWork(fx, '0.1.1.0', { [migrationFile(209, 'shared_index')]: migration(209, 'shared_index') });
    landOnMaster(fx, '0.1.1.0', [209, 'master_gadgets'], { [migrationFile(210, 'shared_index')]: migration(210, 'shared_index') });
    const pre = head(fx.work);
    const r = restamp(fx.work);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`FAIL: ${migrationFile(209, 'shared_index')} has the same payload as ${migrationFile(210, 'shared_index')}`);
    expect(r.out).toContain(`Fix:  drop this branch's copy: git rm ${migrationFile(209, 'shared_index')}`);
    expect(head(fx.work)).toBe(pre);
    expect(existsSync(stateFile(fx.work))).toBe(false);
  }, 120_000);

  test('a cherry-picked master migration stays put while the branch migration it collides with moves', () => {
    const fx = fixture();
    branchWork(fx, '0.1.1.0', { [migrationFile(209, 'branch_widgets')]: migration(209, 'branch_widgets') });
    landOnMaster(fx, '0.1.1.0', [209, 'master_hotfix']);
    git(fx.work, 'fetch', '-q', 'origin');
    const pick = git(fx.work, 'rev-parse', 'origin/master').trim();
    put(fx.work, { [migrationFile(209, 'master_hotfix')]: git(fx.work, 'show', `${pick}:${migrationFile(209, 'master_hotfix')}`) });
    commit(fx.work, 'cherry-pick master hotfix migration');
    const r = restamp(fx.work);
    expect(r.code).toBe(0);
    expect(read(fx.work, migrationFile(209, 'master_hotfix'))).toBe(migration(209, 'master_hotfix'));
    expect(read(fx.work, migrationFile(210, 'branch_widgets'))).toContain('version: 210,');
  }, 120_000);

  test('a decoy integer equal to the old number is never rewritten and does not stop the run', () => {
    const fx = fixture();
    branchWork(fx, '0.1.1.0', {
      [migrationFile(209, 'retry_budget')]: migration(209, 'retry_budget', 'ALTER TABLE jobs ADD COLUMN IF NOT EXISTS max_attempts INTEGER DEFAULT 209;'),
      'src/limits.ts': 'export const MAX_ATTEMPTS = 209;\n',
    });
    landOnMaster(fx, '0.1.1.0', [209, 'master_gadgets']);
    const r = restamp(fx.work);
    expect(r.code).toBe(0);
    const moved = read(fx.work, migrationFile(210, 'retry_budget'));
    expect(moved).toContain('version: 210,');
    expect(moved).toContain('DEFAULT 209;');
    expect(read(fx.work, 'src/limits.ts')).toBe('export const MAX_ATTEMPTS = 209;\n');
  }, 120_000);

  test('leftover references stop the run, are listed, and --continue resumes once they are edited', () => {
    const fx = fixture();
    branchWork(fx, '0.1.1.0', {
      [migrationFile(209, 'branch_widgets')]: migration(209, 'branch_widgets'),
      'test/widgets.test.ts': "import { v209 } from '../src/core/schema-migrations/v209-branch-widgets.ts';\n",
      'docs/widgets.md': '# Widgets\n\nMigration v209 adds the widgets table.\nIt applies after migration 208.\n',
    });
    landOnMaster(fx, '0.1.1.0', [209, 'master_gadgets']);
    const r = restamp(fx.work);
    expect(r.code).toBe(1);
    expect(r.out).toContain("2 line(s) this branch added still name a renumbered migration's old number");
    expect(r.out).toContain('test/widgets.test.ts:1:');
    expect(r.out).toContain('docs/widgets.md:3: Migration v209 adds the widgets table.   (v209 is now v210)');
    expect(r.out).toContain('then: bun run release:restamp --continue');
    expect(read(fx.work, 'test/widgets.test.ts')).toContain('v209-branch-widgets.ts');
    expect(existsSync(stateFile(fx.work))).toBe(true);

    expect(restamp(fx.work).out).toContain('a restamp is already in progress');
    put(fx.work, { 'test/widgets.test.ts': "import { v210 } from '../src/core/schema-migrations/v210-branch-widgets.ts';\n" });
    const partial = restamp(fx.work, ['--continue']);
    expect(partial.code).toBe(1);
    expect(partial.out).toContain('1 line(s) this branch added');
    const done = restamp(fx.work, ['--continue', '--accept-references']);
    expect(done.code).toBe(0);
    expect(done.out).toContain('kept 1 reference line(s) as written');
    expect(subject(fx.work)).toBe('v0.1.2.0 chore(release): restamp onto master v0.1.1.0');
    expect(status(fx.work)).toBe('');
  }, 120_000);

  test('a genuine conflict stops with the file list; --continue writes the merge commit after it is resolved', () => {
    const fx = fixture();
    branchWork(fx, '0.1.1.0', { 'src/shared.ts': 'export const GREETING = "hi from the branch";\n' });
    landOnMaster(fx, '0.1.1.0', null, { 'src/shared.ts': 'export const GREETING = "hi from master";\n' });
    const r = restamp(fx.work);
    expect(r.code).toBe(1);
    expect(r.out).toContain("conflict(s) restamp cannot resolve mechanically:\n      src/shared.ts");
    expect(r.out).not.toContain('CHANGELOG.md\n');
    expect(restamp(fx.work, ['--continue']).out).toContain('conflicts are still unresolved: src/shared.ts');
    put(fx.work, { 'src/shared.ts': 'export const GREETING = "hi from both";\n' });
    git(fx.work, 'add', 'src/shared.ts');
    const done = restamp(fx.work, ['--continue']);
    expect(done.code).toBe(0);
    expect(parents(fx.work, 'HEAD^')).toBe(2);
    expect(splitChangelog(read(fx.work, 'CHANGELOG.md')).sections.map((s) => s.header)[0]).toBe('## [0.1.2.0] - 2026-10-05');
  }, 120_000);

  test('--abort returns to the pre-run commit', () => {
    const fx = fixture();
    branchWork(fx, '0.1.1.0', { 'src/shared.ts': 'export const GREETING = "hi from the branch";\n' });
    landOnMaster(fx, '0.1.1.0', null, { 'src/shared.ts': 'export const GREETING = "hi from master";\n' });
    const pre = head(fx.work);
    expect(restamp(fx.work).code).toBe(1);
    const r = restamp(fx.work, ['--abort']);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`returned to ${pre.slice(0, 12)}`);
    expect(head(fx.work)).toBe(pre);
    expect(status(fx.work)).toBe('');
    expect(existsSync(stateFile(fx.work))).toBe(false);
    expect(restamp(fx.work, ['--abort']).out).toContain('FAIL: no restamp is in progress');
  }, 120_000);

  test('refuses a dirty tree and reports an unreachable remote with the next step', () => {
    const fx = fixture();
    put(fx.work, { 'scratch.txt': 'wip\n' });
    const dirty = restamp(fx.work);
    expect(dirty.code).toBe(1);
    expect(dirty.out).toContain('FAIL: the working tree is not clean');
    expect(dirty.out).toContain('git stash -u');
    rmSync(join(fx.work, 'scratch.txt'));
    git(fx.work, 'remote', 'set-url', 'origin', join(fx.origin, 'missing.git'));
    const offline = restamp(fx.work);
    expect(offline.code).toBe(1);
    expect(offline.out).toContain('FAIL: could not fetch origin/master');
    expect(offline.out).toContain('git fetch origin master && bun run release:restamp');
  }, 120_000);

  test('--dry-run prints every planned edit and changes nothing', () => {
    const fx = fixture();
    branchWork(fx, '0.1.1.0', {
      [migrationFile(209, 'branch_widgets')]: migration(209, 'branch_widgets'),
      'docs/widgets.md': 'Migration v209 adds widgets.\n',
    });
    landOnMaster(fx, '0.1.1.0', [209, 'master_gadgets']);
    const pre = head(fx.work);
    const r = restamp(fx.work, ['--dry-run']);
    expect(r.code).toBe(0);
    expect(head(fx.work)).toBe(pre);
    expect(status(fx.work)).toBe('');
    expect(r.out).toContain('this branch becomes 0.1.2.0');
    expect(r.out).toContain('predicted conflict CHANGELOG.md (mechanical');
    expect(r.out).toContain('  VERSION: 0.1.1.0 -> 0.1.2.0');
    expect(r.out).toContain('"## [0.1.1.0] - 2026-10-03" -> "## [0.1.2.0] - 2026-10-05"');
    expect(r.out).toContain(`v209 -> v210  ${migrationFile(209, 'branch_widgets')} -> ${migrationFile(210, 'branch_widgets')}`);
    expect(r.out).toContain('docs/widgets.md:1: Migration v209 adds widgets.');
    expect(r.out).toContain('PR title: v0.1.2.0 feat(sync): faster widgets');
  }, 120_000);

  test('--no-commit leaves the restamp edits staged on top of the merge commit', () => {
    const fx = fixture();
    branchWork(fx, '0.1.1.0', {});
    landOnMaster(fx, '0.1.1.0', null);
    const r = restamp(fx.work, ['--no-commit']);
    expect(r.code).toBe(0);
    expect(parents(fx.work, 'HEAD')).toBe(2);
    expect(git(fx.work, 'diff', '--cached', '--name-only')).toContain('VERSION');
    expect(r.out).toContain('Edits are staged (--no-commit)');
  }, 120_000);

  test('a branch without its CHANGELOG entry stops at the drift check until one is written', () => {
    const fx = fixture();
    put(fx.work, { ...stamps('0.1.1.0') });
    commit(fx.work, 'bump only');
    landOnMaster(fx, '0.1.1.0', null);
    const r = restamp(fx.work);
    expect(r.code).toBe(1);
    expect(r.out).toContain('CHANGELOG.md has no entry for this branch');
    const { preamble, sections } = splitChangelog(read(fx.work, 'CHANGELOG.md'));
    put(fx.work, { 'CHANGELOG.md': [preamble, release('0.1.2.0', '2026-10-05', 'Now with entry.'), ...sections.map((s) => s.text)].join('\n') });
    expect(restamp(fx.work, ['--continue']).code).toBe(0);
    expect(subject(fx.work)).toBe('v0.1.2.0 chore(release): restamp onto master v0.1.1.0');
  }, 120_000);

  test('an edit to a published migration stops: published migrations are never renumbered or edited', () => {
    const fx = fixture();
    branchWork(fx, '0.1.1.0', { [migrationFile(208, 'seed_two')]: migration(208, 'seed_two', 'CREATE TABLE IF NOT EXISTS seed_two (id BIGINT);') });
    landOnMaster(fx, '0.1.1.0', null);
    const r = restamp(fx.work);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`FAIL: ${migrationFile(208, 'seed_two')} is published on origin/master but this branch changes its payload`);
  }, 120_000);
});

describe('release:restamp helpers', () => {
  test('version: master MAJOR.MINOR.(PATCH+1).0', () => {
    expect(nextPatchVersion('0.60.69.0\n')).toBe('0.60.70.0');
    expect(nextPatchVersion('0.31.1.1-fixwave')).toBe('0.31.2.0');
    expect(() => nextPatchVersion('banana')).toThrow(/is not MAJOR.MINOR.PATCH.MICRO/);
  });

  test('version-only conflict hunks resolve; real edits stay conflicted', () => {
    const versionOnly = '{\n<<<<<<< HEAD\n  "version": "0.1.1.0",\n=======\n  "version": "0.1.2.0",\n>>>>>>> origin/master\n}\n';
    expect(resolveVersionOnlyHunks(versionOnly)).toEqual({ text: '{\n  "version": "0.1.1.0",\n}\n', unresolved: 0 });
    const real = '<<<<<<< HEAD\n"dep": "1"\n=======\n"dep": "2"\n>>>>>>> origin/master\n';
    expect(resolveVersionOnlyHunks(real).unresolved).toBe(1);
  });

  test('renumbering changes only the export name and the version literal', () => {
    const text = migration(209, 'widgets', 'SELECT 209;', '// v209 note\n');
    const moved = renumberMigrationText(text, 'x.ts', 212);
    expect(moved).toBe(text.replace('export const v209', 'export const v212').replace('version: 209,', 'version: 212,'));
    expect(migrationPayloadKey(moved, 'x.ts')).toBe(migrationPayloadKey(text, 'x.ts'));
    expect(migrationPayloadKey(text.replace('SELECT 209', 'SELECT 1'), 'x.ts')).not.toBe(migrationPayloadKey(text, 'x.ts'));
  });

  test('leftover scan lists reference shapes, skips decoys, generated files and the renamed constant lines', () => {
    const added = [
      { file: 'src/a.ts', line: 1, text: 'const LIMIT = 209;' },
      { file: 'docs/a.md', line: 2, text: 'schema_version moves to 209' },
      { file: 'test/a.test.ts', line: 3, text: "import { v209 } from './v209-widgets.ts';" },
      { file: 'llms-full.txt', line: 4, text: 'Migration v209' },
      { file: `${DIR}/v210-widgets.ts`, line: 5, text: '  version: 210,' },
    ];
    expect(findLeftoverRefs(added, [209, 210], new Set([`${DIR}/v210-widgets.ts`])).map((r) => r.line)).toEqual([2, 3]);
  });

  test('CHANGELOG rebuild keeps master entries and is idempotent', () => {
    const entry = { header: '## [0.1.1.0] - 2026-10-03', text: '## [0.1.1.0] - 2026-10-03\n\nBranch v0.1.1.0 notes.\n' };
    const merged = changelog(release('0.1.1.0', '2026-10-04', 'Master.'), release('0.1.0.0', '2026-01-01', 'First.'));
    const once = rebuildChangelog(merged, entry, '0.1.1.0', '0.1.2.0', '2026-10-05');
    expect(rebuildChangelog(once, entry, '0.1.1.0', '0.1.2.0', '2026-10-05')).toBe(once);
    expect(once).toBe(changelog(release('0.1.2.0', '2026-10-05', 'Branch v0.1.2.0 notes.'), release('0.1.1.0', '2026-10-04', 'Master.'), release('0.1.0.0', '2026-01-01', 'First.')));
  });

  test('every required row of the CLAUDE.md "Version locations" table is restamped', () => {
    const claude = read(REPO, 'CLAUDE.md');
    const table = claude.slice(claude.indexOf('**Required (every release must update every row):**'), claude.indexOf('**Auto-derived'));
    const files = [...table.matchAll(/^\| (.+?) \|/gm)].flatMap(([, cell]) => [...cell!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!));
    expect(files.length).toBeGreaterThan(5);
    const covered = new Set([...STAMPS.map((s) => s.file), ...OTHER_STAMPED_FILES]);
    expect(files.filter((f) => !covered.has(f))).toEqual([]);
  });

  test('every docs anchor restamp prints resolves', () => {
    const anchor = (h: string) => h.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    for (const ref of [RESTAMP_DOCS, COLLISION_DOCS]) {
      const [path, id] = ref.split('#');
      const headings = [...read(REPO, path!).replace(/^```[\s\S]*?^```/gm, '').matchAll(/^#{1,6}\s+(.+)$/gm)].map(([, h]) => anchor(h!));
      expect(headings, `${ref} does not resolve`).toContain(id!);
    }
  });
});
