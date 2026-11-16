/**
 * scripts/check-public-surface.ts against throwaway git repositories: a base branch, then a head commit that drops a
 * manifest entry, adds deprecation records or behaviour-change rows, or changes a CLI golden. Each case shows the
 * refusal and the change that clears it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { main } from '../../scripts/check-public-surface.ts';
import { main as buildMain, MANIFEST } from '../../scripts/build-public-surface.ts';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const TODAY = '2026-11-16';
const manifest = (over: Record<string, unknown> = {}) => JSON.stringify({
  version: 1,
  'cli-command': ['gbrain search'],
  'cli-flag': ['gbrain search --limit', 'gbrain search --match'],
  'mcp-tool': ['search'],
  'mcp-param': ['search.limit'],
  'config-key': ['search.mode'],
  'exit-code': { not_found: 4 },
  ...over,
}, null, 2) + '\n';

function git(root: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}
function write(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}
function repo(base: Record<string, string>, head: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-public-surface-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'base');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  write(root, { [MANIFEST]: manifest(), 'README.md': 'x\n', ...base });
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'checkout', '-q', '-b', 'head');
  write(root, head);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'head');
  return root;
}
function run(root: string, env: Record<string, string> = {}): { code: number; out: string } {
  const lines: string[] = [];
  const code = main({ cwd: root, env: { GBRAIN_SURFACE_BASE_REF: 'base', GBRAIN_SURFACE_TODAY: TODAY, ...env }, log: (l) => lines.push(l) });
  return { code, out: lines.join('\n') };
}
const record = (surface: string, name: string, removeAfter: string) => `---\nsurface: ${surface}\nname: ${name}\nowner: alice-example\nremove_after: ${removeAfter}\n---\nUse the new one.\n`;

describe('dropped manifest entries', () => {
  test('a flag removed with no record is refused', () => {
    const r = run(repo({}, { [MANIFEST]: manifest({ 'cli-flag': ['gbrain search --match'] }) }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('cli-flag `gbrain search --limit` is removed or changed with no deprecations.d/<id>.md naming it');
  });

  test('a record whose remove_after has not come refuses the removal; a matured one allows it', () => {
    const head = { [MANIFEST]: manifest({ 'cli-flag': ['gbrain search --match'] }) };
    const early = run(repo({ 'deprecations.d/search_limit_flag_1234.md': record('cli-flag', 'gbrain search --limit', '2026-11-20') }, head));
    expect(early.code).toBe(1);
    expect(early.out).toContain('is removed before its record deprecations.d/search_limit_flag_1234.md allows it (remove_after 2026-11-20)');
    const due = run(repo({ 'deprecations.d/search_limit_flag_1234.md': record('cli-flag', 'gbrain search --limit', '2026-11-16') }, head));
    expect(due.code).toBe(0);
  });

  test('an exit code whose number changed counts as a removal', () => {
    const r = run(repo({}, { [MANIFEST]: manifest({ 'exit-code': { not_found: 1 } }) }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('exit-code `not_found` is removed or changed');
  });

  test('adding entries is allowed, and a base with no manifest skips the removal check', () => {
    expect(run(repo({}, { [MANIFEST]: manifest({ 'mcp-tool': ['search', 'think'] }) })).code).toBe(0);
    const root = repo({}, {});
    git(root, 'checkout', '-q', 'base');
    git(root, 'rm', '-q', MANIFEST);
    git(root, 'commit', '-q', '-m', 'no manifest');
    git(root, 'checkout', '-q', '-b', 'head-after', 'base');
    write(root, { [MANIFEST]: manifest() });
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'head adds the manifest');
    const r = run(root);
    expect(r.code).toBe(0);
    expect(r.out).toContain('has no docs/contracts/public-surface.json yet');
  });

  test('a matured cli-command or mcp-tool record also covers the flags or parameters the removal drops', () => {
    const gone = { [MANIFEST]: manifest({ 'cli-command': [], 'cli-flag': [], 'mcp-tool': [], 'mcp-param': [] }) };
    const r = run(repo({
      'deprecations.d/search_command_1234.md': record('cli-command', 'gbrain search', '2026-11-10'),
      'deprecations.d/search_tool_1234.md': record('mcp-tool', 'search', '2026-11-10'),
    }, gone));
    expect(r.out).not.toContain('FAIL');
    expect(r.code).toBe(0);
  });
});

describe('the base it compares with', () => {
  test('changes the base made after the branch point are not this branch\'s (an added tool, a release that moved a row)', () => {
    const root = repo({ 'behavior-changes.d/old_row_1234.md': 'Plain text.\n' }, {});
    git(root, 'checkout', '-q', 'base');
    write(root, { [MANIFEST]: manifest({ 'mcp-tool': ['search', 'think'] }) });
    git(root, 'rm', '-q', 'behavior-changes.d/old_row_1234.md');
    git(root, 'commit', '-qam', 'base moves on');
    git(root, 'checkout', '-q', 'head');
    const r = run(root);
    expect(r.out).not.toContain('FAIL');
    expect(r.code).toBe(0);
  });

  test('a shallow CI clone is deepened until it has a merge base', () => {
    const origin = repo({}, {});
    git(origin, 'checkout', '-q', 'base');
    write(origin, { [MANIFEST]: manifest({ 'mcp-tool': ['search', 'think'] }) });
    git(origin, 'commit', '-qam', 'base adds think');
    const clone = mkdtempSync(join(tmpdir(), 'gbrain-public-surface-clone-'));
    roots.push(clone);
    git(clone, 'clone', '-q', '--depth=1', '--branch', 'head', `file://${origin}`, '.');
    git(clone, 'fetch', '-q', '--no-tags', '--depth=1', 'origin', '+refs/heads/base:refs/remotes/origin/base');
    const r = run(clone, { GBRAIN_SURFACE_BASE_REF: 'origin/base', CI: 'true' });
    expect(r.out).not.toContain('FAIL');
    expect(r.code).toBe(0);
  });

  test('a shallow pull-request merge commit whose parent is the base tip needs no fetch', () => {
    const origin = repo({}, { [MANIFEST]: manifest({ 'mcp-tool': ['search', 'think'] }) });
    git(origin, 'checkout', '-q', 'base');
    write(origin, { 'README.md': 'base moved\n' });
    git(origin, 'commit', '-qam', 'base moves on');
    git(origin, 'checkout', '-q', '-b', 'merge', 'base');
    git(origin, 'merge', '-q', '--no-ff', '--no-edit', 'head');
    const clone = mkdtempSync(join(tmpdir(), 'gbrain-public-surface-clone-'));
    roots.push(clone);
    git(clone, 'clone', '-q', '--depth=1', '--branch', 'merge', `file://${origin}`, '.');
    git(clone, 'fetch', '-q', '--no-tags', '--depth=1', 'origin', '+refs/heads/base:refs/remotes/origin/base');
    git(clone, 'remote', 'set-url', 'origin', join(clone, 'no-such-remote'));
    const r = run(clone, { GBRAIN_SURFACE_BASE_REF: 'origin/base', CI: 'true' });
    expect(r.out).not.toContain('FAIL');
    expect(r.code).toBe(0);
  });

  test('a missing base ref fails under CI and skips locally', () => {
    const root = repo({}, {});
    const ci = run(root, { GBRAIN_SURFACE_BASE_REF: 'nope', CI: 'true' });
    expect(ci.code).toBe(1);
    expect(ci.out).toContain('base ref nope is not available');
    const local = run(root, { GBRAIN_SURFACE_BASE_REF: 'nope' });
    expect(local.code).toBe(0);
    expect(local.out).toContain('GBRAIN_CHECK_SKIPPED: base ref nope unavailable');
  });
});

describe('deprecation records', () => {
  test('a new record must give at least 14 days; an old record keeps its date', () => {
    const short = run(repo({}, { 'deprecations.d/search_limit_flag_1234.md': record('cli-flag', 'gbrain search --limit', '2026-11-29') }));
    expect(short.code).toBe(1);
    expect(short.out).toContain('remove_after 2026-11-29 is less than 14 days away');
    expect(run(repo({}, { 'deprecations.d/search_limit_flag_1234.md': record('cli-flag', 'gbrain search --limit', '2026-11-30') })).code).toBe(0);
    expect(run(repo({ 'deprecations.d/search_limit_flag_1234.md': record('cli-flag', 'gbrain search --limit', '2026-11-29') }, {})).code).toBe(0);
  });

  test('an announced date can move later, never earlier', () => {
    const path = 'deprecations.d/search_limit_flag_1234.md';
    const early = run(repo({ [path]: record('cli-flag', 'gbrain search --limit', '2026-12-20') },
      { [path]: record('cli-flag', 'gbrain search --limit', '2026-11-16'), [MANIFEST]: manifest({ 'cli-flag': ['gbrain search --match'] }) }));
    expect(early.code).toBe(1);
    expect(early.out).toContain(`${path}: remove_after moves from 2026-12-20 to 2026-11-16`);
    expect(run(repo({ [path]: record('cli-flag', 'gbrain search --limit', '2026-11-20') }, { [path]: record('cli-flag', 'gbrain search --limit', '2026-12-20') })).code).toBe(0);
  });

  test('a record with a bad surface, no owner or no date is refused', () => {
    const r = run(repo({}, { 'deprecations.d/bad_record_1234.md': '---\nsurface: cli-thing\nname: gbrain x\n---\nText.\n' }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('surface: must be one of cli-command, cli-flag, mcp-tool, mcp-param, config-key, exit-code, page-format, json-field');
    expect(r.out).toContain('owner: is missing');
    expect(r.out).toContain('remove_after: must be a date (YYYY-MM-DD)');
  });

  test('a page-format or --json field record is accepted though the list does not hold those surfaces', () => {
    for (const surface of ['page-format', 'json-field']) {
      expect(run(repo({}, { 'deprecations.d/old_field_1234.md': record(surface, 'gbrain stats --json .old_field', '2026-11-30') })).code).toBe(0);
    }
  });
});

describe('new behaviour-change rows', () => {
  test('a new row needs kind:', () => {
    const r = run(repo({}, { 'behavior-changes.d/new_row_1234.md': 'Plain text.\n' }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('behavior-changes.d/new_row_1234.md: a new behaviour-change row needs front matter with kind:');
    expect(run(repo({}, { 'behavior-changes.d/new_row_1234.md': '---\nkind: fix\n---\nPlain text.\n' })).code).toBe(0);
  });

  test('a row already on the base needs nothing', () => {
    expect(run(repo({ 'behavior-changes.d/old_row_1234.md': 'Plain text.\n' }, {})).code).toBe(0);
  });

  test('kind: breaking needs an exception or a matured deprecation', () => {
    const bare = run(repo({}, { 'behavior-changes.d/new_row_1234.md': '---\nkind: breaking\n---\nText.\n' }));
    expect(bare.code).toBe(1);
    expect(bare.out).toContain('kind: breaking needs exception: security or data-loss, or deprecation: <id>');
    expect(run(repo({}, { 'behavior-changes.d/new_row_1234.md': '---\nkind: breaking\nexception: security\n---\nText.\n' })).code).toBe(0);
    const young = run(repo({ 'deprecations.d/search_limit_flag_1234.md': record('cli-flag', 'gbrain search --limit', '2026-12-01') },
      { 'behavior-changes.d/new_row_1234.md': '---\nkind: breaking\ndeprecation: search_limit_flag_1234\n---\nText.\n' }));
    expect(young.code).toBe(1);
    expect(young.out).toContain('deprecation: search_limit_flag_1234 has not matured (remove_after 2026-12-01)');
    expect(run(repo({ 'deprecations.d/search_limit_flag_1234.md': record('cli-flag', 'gbrain search --limit', '2026-11-10') },
      { 'behavior-changes.d/new_row_1234.md': '---\nkind: breaking\ndeprecation: search_limit_flag_1234\n---\nText.\n' })).code).toBe(0);
  });
});

describe('golden changes', () => {
  const golden = 'test/fixtures/goldens/cli/search-help.txt';
  test('a CLI golden change with no row and no waiver is refused; either clears it', () => {
    const r = run(repo({ [golden]: 'old\n' }, { [golden]: 'new\n' }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('CLI or agent-contract goldens changed (test/fixtures/goldens/cli/search-help.txt)');
    expect(run(repo({ [golden]: 'old\n' }, { [golden]: 'new\n', 'behavior-changes.d/new_row_1234.md': '---\nkind: add\n---\nText.\n' })).code).toBe(0);
    expect(run(repo({ [golden]: 'old\n' }, { [golden]: 'new\n', 'changelog.d/x.md': 'Entry.\n\n<!-- public-surface: no-behavior-change: help text reflowed -->\n' })).code).toBe(0);
  });

  test('other goldens are not covered', () => {
    expect(run(repo({ 'test/fixtures/goldens/doctor/a.json': '1\n' }, { 'test/fixtures/goldens/doctor/a.json': '2\n' })).code).toBe(0);
  });
});

describe('the committed manifest', () => {
  test('is fresh and lists documented surfaces by the names deprecations.d uses', async () => {
    expect(await buildMain(['--check'], join(import.meta.dir, '..', '..'))).toBe(0);
    expect(MANIFEST).toBe('docs/contracts/public-surface.json');
    const m = JSON.parse(await Bun.file(join(import.meta.dir, '..', '..', 'docs/contracts/public-surface.json')).text());
    expect(m['cli-command']).toContain('gbrain search');
    expect(m['cli-flag']).toContain('gbrain search --limit');
    expect(m['mcp-param']).toContain('search.query');
    expect(m['config-key']).toContain('engine');
    expect(typeof m['exit-code'].not_found).toBe('number');
  });
});
