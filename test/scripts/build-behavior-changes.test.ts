/**
 * scripts/build-behavior-changes.ts against throwaway trees: behavior-changes.d/<id>.md fragments dated by the
 * <!-- behavior-change: <id> --> marker's CHANGELOG section, pending markers (changelog.d, [Unreleased]) counted only
 * while VERSION is newer than the top release heading, the fragment problems, releasedIn('<id>') function rows, the
 * --check exit codes, and the byte-identity between a release in progress and the same release folded, which
 * gstack's release check relies on.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { build, main, NOTICE_FILE, OUT } from '../../scripts/build-behavior-changes.ts';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-behavior-changes-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const marker = (id: string) => `<!-- behavior-change: ${id} -->`;
const section = (version: string, ...lines: string[]) => `## [${version}] - 2026-11-01\n\n${lines.join('\n')}\n`;
const changelog = (...sections: string[]) => `# Changelog\n\n${sections.join('\n')}`;
const notice = (...rows: string[]) => ['export const BEHAVIOR_CHANGES = [', ...rows.map((r) => `  ${r}`), '];', ''].join('\n');

function run(root: string, argv: string[]): { code: number; out: string } {
  const lines: string[] = [];
  const code = main(argv, { cwd: root, log: (l) => lines.push(l) });
  return { code, out: lines.join('\n') };
}

const rowsOf = (text: string) => [...text.matchAll(/^ {2}\{ since: '([^']+)', id: '([^']+)', text: (".*") \},$/gm)].map((m) => ({ since: m[1], id: m[2], text: JSON.parse(m[3]!) }));
const releasesOf = (text: string) => Object.fromEntries([...text.matchAll(/^ {2}([a-z0-9_]+): '([^']+)',$/gm)].map((m) => [m[1], m[2]]));

describe('build()', () => {
  test('a pending fragment (marker in changelog.d, VERSION at the top heading) generates nothing', () => {
    const root = tree({
      VERSION: '0.1.0.0\n',
      'CHANGELOG.md': changelog(section('0.1.0.0', 'First.')),
      'changelog.d/feature-x.md': `**Faster sync.**\n\n${marker('faster_sync_abc')}\n`,
      'behavior-changes.d/faster_sync_abc.md': 'Sync is faster now.\n',
    });
    const { text, problems } = build(root);
    expect(problems).toEqual([]);
    expect(rowsOf(text)).toEqual([]);
    expect(releasesOf(text)).toEqual({});
  });

  test('an [Unreleased] marker is pending too until a release is being stamped', () => {
    const files = {
      'CHANGELOG.md': changelog(`## [Unreleased]\n\n${marker('faster_sync_abc')}\n`, section('0.1.0.0', 'First.')),
      'behavior-changes.d/faster_sync_abc.md': 'Sync is faster now.\n',
    };
    expect(rowsOf(build(tree({ VERSION: '0.1.0.0\n', ...files })).text)).toEqual([]);
    expect(rowsOf(build(tree({ VERSION: '0.1.1.0\n', ...files })).text)).toEqual([{ since: '0.1.1.0', id: 'faster_sync_abc', text: 'Sync is faster now.' }]);
  });

  test('a marker under a released CHANGELOG heading dates the row with that version, text joined to one line', () => {
    const root = tree({
      VERSION: '0.1.1.0\n',
      'CHANGELOG.md': changelog(section('0.1.1.0', 'Second.', marker('newer_row_abc')), section('0.1.0.0', 'First.', marker('older_row_abc'))),
      'behavior-changes.d/older_row_abc.md': 'Older\n  change.\n',
      'behavior-changes.d/newer_row_abc.md': 'Newer change.\n',
    });
    const { text, problems } = build(root);
    expect(problems).toEqual([]);
    expect(rowsOf(text)).toEqual([
      { since: '0.1.0.0', id: 'older_row_abc', text: 'Older change.' },
      { since: '0.1.1.0', id: 'newer_row_abc', text: 'Newer change.' },
    ]);
    expect(releasesOf(text)).toEqual({ older_row_abc: '0.1.0.0', newer_row_abc: '0.1.1.0' });
  });

  test('stamping (VERSION newer than the top heading) dates pending changelog.d markers with VERSION', () => {
    const root = tree({
      VERSION: '0.1.1.0\n',
      'CHANGELOG.md': changelog(section('0.1.0.0', 'First.', marker('older_row_abc'))),
      'changelog.d/feature-x.md': `**Faster sync.**\n\n${marker('faster_sync_abc')}\n`,
      'changelog.d/README.md': `Docs mention ${marker('readme_only_abc')} and are not a fragment.\n`,
      'behavior-changes.d/older_row_abc.md': 'Older change.\n',
      'behavior-changes.d/faster_sync_abc.md': 'Sync is faster now.\n',
    });
    const { text, problems } = build(root);
    expect(problems).toEqual([]);
    expect(rowsOf(text)).toEqual([
      { since: '0.1.0.0', id: 'older_row_abc', text: 'Older change.' },
      { since: '0.1.1.0', id: 'faster_sync_abc', text: 'Sync is faster now.' },
    ]);
  });

  test('problems: fragment without marker, marker without fragment, id repeating a table row, over-long text, bad filename', () => {
    const root = tree({
      VERSION: '0.1.0.0\n',
      'CHANGELOG.md': changelog(section('0.1.0.0', marker('no_fragment_abc'), marker('old_table_row'), marker('too_long_abc'))),
      [NOTICE_FILE]: notice("{ since: '0.0.9.0', id: 'old_table_row', text: 'Released long ago.' },"),
      'behavior-changes.d/no_marker_abc.md': 'Nobody names me.\n',
      'behavior-changes.d/old_table_row.md': 'Same id as a table row.\n',
      'behavior-changes.d/too_long_abc.md': 'x'.repeat(2001),
      'behavior-changes.d/Bad-Name.md': 'Bad name.\n',
      'behavior-changes.d/notes.txt': 'Not markdown.\n',
    });
    const { problems } = build(root);
    expect(problems.sort()).toEqual([
      'behavior-changes.d/Bad-Name.md: a fragment is named <id>.md, the id lowercase letters, digits and _, starting with a letter (3-96 characters)',
      'behavior-changes.d/no_marker_abc.md has no <!-- behavior-change: no_marker_abc --> marker in a changelog.d fragment or the CHANGELOG, so no release would disclose it',
      'behavior-changes.d/notes.txt: a fragment is named <id>.md, the id lowercase letters, digits and _, starting with a letter (3-96 characters)',
      `behavior-changes.d/old_table_row.md repeats the id of a row in ${NOTICE_FILE}`,
      'behavior-changes.d/too_long_abc.md is 2001 characters; the notice renders at most 2000',
      `the marker <!-- behavior-change: no_fragment_abc --> names no behavior-changes.d/no_fragment_abc.md and no function row dated releasedIn('no_fragment_abc')`,
    ]);
  });

  test('text at exactly 2000 characters is accepted', () => {
    const root = tree({
      VERSION: '0.1.0.0\n',
      'CHANGELOG.md': changelog(section('0.1.0.0', marker('cap_row_abc'))),
      'behavior-changes.d/cap_row_abc.md': 'y'.repeat(2000) + '\n',
    });
    expect(build(root).problems).toEqual([]);
  });

  test("releasedIn('<id>') function rows need a marker and take their release from BEHAVIOR_CHANGE_RELEASES", () => {
    const fnRow = "{ since: releasedIn('fn_row_abc'), id: 'fn_row_abc', text: (chain) => `chain ${chain}` },";
    const unmarked = build(tree({ VERSION: '0.1.0.0\n', 'CHANGELOG.md': changelog(section('0.1.0.0', 'First.')), [NOTICE_FILE]: notice(fnRow) }));
    expect(unmarked.problems).toEqual([`the releasedIn('fn_row_abc') row in ${NOTICE_FILE} has no <!-- behavior-change: fn_row_abc --> marker, so no release would date it`]);

    const pending = build(tree({ VERSION: '0.1.0.0\n', 'CHANGELOG.md': changelog(section('0.1.0.0', 'First.')), 'changelog.d/fn.md': `${marker('fn_row_abc')}\n`, [NOTICE_FILE]: notice(fnRow) }));
    expect(pending.problems).toEqual([]);
    expect(releasesOf(pending.text)).toEqual({});

    const released = build(tree({ VERSION: '0.1.1.0\n', 'CHANGELOG.md': changelog(section('0.1.1.0', marker('fn_row_abc')), section('0.1.0.0', 'First.')), [NOTICE_FILE]: notice(fnRow) }));
    expect(released.problems).toEqual([]);
    expect(rowsOf(released.text)).toEqual([]);
    expect(releasesOf(released.text)).toEqual({ fn_row_abc: '0.1.1.0' });
  });

  test('release in progress and release folded generate byte-identical text', () => {
    const fnRow = "{ since: releasedIn('fn_row_abc'), id: 'fn_row_abc', text: () => 'computed' },";
    const shared = {
      [NOTICE_FILE]: notice("{ since: '0.0.9.0', id: 'table_row_abc', text: 'Old.' },", fnRow),
      'behavior-changes.d/older_row_abc.md': 'Older change.\n',
      'behavior-changes.d/alpha_row_abc.md': 'Alpha change.\n',
      'behavior-changes.d/beta_row_abc.md': 'Beta\nchange.\n',
      'changelog.d/README.md': 'One file per PR.\n',
    };
    const released = section('0.1.0.0', 'First.', marker('older_row_abc'));
    const alpha = `**Alpha.**\n\n${marker('alpha_row_abc')}\n${marker('fn_row_abc')}`;
    const beta = `**Beta.**\n\n${marker('beta_row_abc')}`;
    const fragments = { 'changelog.d/a-alpha.md': `${alpha}\n`, 'changelog.d/b-beta.md': `${beta}\n` };
    const inProgress = build(tree({ ...shared, ...fragments, VERSION: '0.1.1.0\n', 'CHANGELOG.md': changelog(released) }));
    const folded = build(tree({ ...shared, VERSION: '0.1.1.0\n', 'CHANGELOG.md': changelog(section('0.1.1.0', alpha, '', beta), released) }));
    expect(inProgress.problems).toEqual([]);
    expect(folded.problems).toEqual([]);
    expect(folded.text).toBe(inProgress.text);
    expect(rowsOf(folded.text).map((r) => `${r.id}@${r.since}`)).toEqual(['older_row_abc@0.1.0.0', 'alpha_row_abc@0.1.1.0', 'beta_row_abc@0.1.1.0']);
    expect(releasesOf(folded.text)).toEqual({ older_row_abc: '0.1.0.0', alpha_row_abc: '0.1.1.0', fn_row_abc: '0.1.1.0', beta_row_abc: '0.1.1.0' });

    const notStamping = build(tree({ ...shared, ...fragments, VERSION: '0.1.0.0\n', 'CHANGELOG.md': changelog(released) }));
    expect(notStamping.problems).toEqual([]);
    expect(rowsOf(notStamping.text).map((r) => r.id)).toEqual(['older_row_abc']);
  });

  test('the same id marked in two releases is a problem', () => {
    const root = tree({
      VERSION: '0.1.1.0\n',
      'CHANGELOG.md': changelog(section('0.1.1.0', marker('twice_row_abc')), section('0.1.0.0', marker('twice_row_abc'))),
      'behavior-changes.d/twice_row_abc.md': 'Twice.\n',
    });
    expect(build(root).problems).toEqual(['twice_row_abc is marked in two releases (0.1.0.0 and 0.1.1.0)']);
  });

  test('a marker repeated among unreleased changes, or marked again after its release, is refused on the PR tree', () => {
    const twoFragments = build(tree({
      VERSION: '0.1.0.0\n',
      'CHANGELOG.md': changelog(section('0.1.0.0', 'First.')),
      'behavior-changes.d/dup_row_abc.md': 'Dup.\n',
      'changelog.d/a.md': `${marker('dup_row_abc')}\n`,
      'changelog.d/b.md': `${marker('dup_row_abc')}\n`,
    }));
    expect(twoFragments.problems).toEqual(['dup_row_abc is marked twice among the unreleased changes (changelog.d and ## [Unreleased]); the release would mark it twice']);
    const remarked = build(tree({
      VERSION: '0.1.0.0\n',
      'CHANGELOG.md': changelog(section('0.1.0.0', marker('old_row_abc'))),
      'behavior-changes.d/old_row_abc.md': 'Old.\n',
      'changelog.d/a.md': `${marker('old_row_abc')}\n`,
    }));
    expect(remarked.problems).toEqual(['old_row_abc is marked again after release 0.1.0.0; a released id is never marked again']);
  });

  test('a changelog.d fragment whose front matter bumps anything but patch is refused, naming the file and the fix', () => {
    const base = { VERSION: '0.1.0.0\n', 'CHANGELOG.md': changelog(section('0.1.0.0', 'First.')) };
    for (const bump of ['minor', 'major', "'micro'"]) {
      const { problems } = build(tree({ ...base, 'changelog.d/feature-x.md': `---\nbump: ${bump}\nimportant: security\n---\n**Faster sync.**\n` }));
      expect(problems).toEqual([`changelog.d/feature-x.md says bump: ${bump.replace(/'/g, '')}; gbrain releases are PATCH only and the release takes the highest bump in the batch, so delete the bump: line (or write bump: patch)`]);
    }
    for (const line of ['bump: minor # feature', '"bump": major']) {
      expect(build(tree({ ...base, 'changelog.d/feature-x.md': `---\n${line}\n---\n**Faster sync.**\n` })).problems.join('\n')).toContain('changelog.d/feature-x.md says bump: ');
    }
    expect(build(tree({ ...base, 'changelog.d/feature-x.md': '---\nbump: patch\n---\n**Faster sync.**\n' })).problems).toEqual([]);
    expect(build(tree({ ...base, 'changelog.d/feature-x.md': '**Faster sync.**\n\nbump: minor appears in prose here.\n' })).problems).toEqual([]);
  });

  test('an id starting with a digit is refused, so the generated map never holds an unquoted numeric key', () => {
    const root = tree({
      VERSION: '0.1.0.0\n',
      'CHANGELOG.md': changelog(section('0.1.0.0', 'First.')),
      'behavior-changes.d/8123_sync.md': 'Sync.\n',
      'changelog.d/a.md': `${marker('8123_sync')}\n`,
    });
    expect(build(root).problems).toEqual([
      'the marker <!-- behavior-change: 8123_sync --> is not an id: lowercase letters, digits and _, starting with a letter (3-96 characters)',
      'behavior-changes.d/8123_sync.md: a fragment is named <id>.md, the id lowercase letters, digits and _, starting with a letter (3-96 characters)',
      "the marker <!-- behavior-change: 8123_sync --> names no behavior-changes.d/8123_sync.md and no function row dated releasedIn('8123_sync')",
    ]);
  });

  test('with [Unreleased] markers on the base, the release in progress orders ids as the fold writes them', () => {
    const shared = {
      'behavior-changes.d/frag_row_abc.md': 'From a fragment.\n',
      'behavior-changes.d/open_row_abc.md': 'From [Unreleased].\n',
    };
    const released = section('0.1.0.0', 'First.');
    const frag = `**Fragment.**\n\n${marker('frag_row_abc')}`;
    const open = `**Open.**\n\n${marker('open_row_abc')}`;
    const inProgress = build(tree({ ...shared, 'changelog.d/a.md': `${frag}\n`, VERSION: '0.1.1.0\n', 'CHANGELOG.md': changelog(`## [Unreleased]\n\n${open}\n`, released) }));
    const folded = build(tree({ ...shared, VERSION: '0.1.1.0\n', 'CHANGELOG.md': changelog(section('0.1.1.0', frag, '', open), released) }));
    expect(inProgress.problems).toEqual([]);
    expect(folded.problems).toEqual([]);
    expect(folded.text).toBe(inProgress.text);
  });
});

describe('main()', () => {
  const files = () => ({
    VERSION: '0.1.0.0\n',
    'CHANGELOG.md': changelog(section('0.1.0.0', marker('older_row_abc'))),
    'behavior-changes.d/older_row_abc.md': 'Older change.\n',
    'src/core/.keep': '',
  });

  test('--check: stale exits 1 without writing, fresh exits 0; a write makes it fresh', () => {
    const root = tree(files());
    const missing = run(root, ['--check']);
    expect(missing.code).toBe(1);
    expect(missing.out).toContain(`FAIL: ${OUT} is stale.`);
    expect(existsSync(join(root, OUT))).toBe(false);

    const write = run(root, []);
    expect(write.code).toBe(0);
    expect(write.out).toContain(`wrote ${OUT}`);
    expect(readFileSync(join(root, OUT), 'utf8')).toBe(build(root).text);
    expect(run(root, []).out).toContain('unchanged');

    const fresh = run(root, ['--check']);
    expect(fresh.code).toBe(0);
    expect(fresh.out).toContain('is fresh');

    writeFileSync(join(root, OUT), readFileSync(join(root, OUT), 'utf8').replace("since: '0.1.0.0'", "since: '0.0.1.0'"));
    expect(run(root, ['--check']).code).toBe(1);
  });

  test('a fragment problem exits 1 with FAIL/Why/Fix and writes nothing', () => {
    const root = tree({ ...files(), 'behavior-changes.d/orphan_row_abc.md': 'No marker.\n' });
    const r = run(root, []);
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL: 1 behavior-change fragment problem(s):');
    expect(r.out).toContain('Why:');
    expect(r.out).toContain('Fix:');
    expect(existsSync(join(root, OUT))).toBe(false);
  });

  test('an unknown argument is a usage error', () => {
    expect(run(tree(files()), ['--nope']).code).toBe(2);
  });
});
