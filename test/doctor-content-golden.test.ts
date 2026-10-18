/**
 * `gbrain doctor` goldens on a PGLite brain with content (GBRA-68).
 *
 * The W0 doctor goldens (test/doctor-json-golden.test.ts) run on an empty
 * brain, so the content-reading checks (frontmatter scan, timeline history
 * and orphans, link resolution, fence census, slug collisions, undeclared
 * DB-only pages) never see a page. This golden imports a small synthetic Git
 * source whose pages exercise fenced and inline code, HTML comments, inline
 * citations, timeline bullets, bare wikilinks, CRLF lines and a broken
 * frontmatter file left untracked after the import, then pins `doctor --json`
 * and the human `doctor` output plus their exit codes. Captured on master
 * before the doctor CPU fixes (the citation reader's no-citation exit, the
 * doctor-scoped `git ls-files` memo, the per-source Git scope in
 * undeclared_db_only_pages), so those fixes must reproduce it.
 *
 * Same hermetic env and normalizer as the W0 goldens; every capture runs
 * twice from independent fresh homes and must normalize identically.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defineNormalizer, expectGolden, expectNormalizerStable } from './helpers/golden.ts';
import { doctorJsonNormalizer, makeDoctorHome, networkAttempts, runGbrain, type DoctorHome, type GbrainRun } from './helpers/doctor-json-golden.ts';

const DOCTOR = doctorJsonNormalizer();
const homes: DoctorHome[] = [];
afterAll(() => {
  for (const h of homes) h.cleanup();
});

const PAGES: Record<string, string> = {
  'people/alice-example.md': [
    '---', 'title: Alice Example', 'type: person', '---',
    '# Alice Example', '',
    'Alice works with [[acme-example]] and [[bob-example]]. Inline `[[not-a-link]]` stays code.', '',
    'Alice joined Acme in March. [Source: Meeting notes, 2024-03-05]', '',
    '```ts', 'const s = "[Source: Fenced, 2024-01-01]"; // [[fenced-link]]', '```', '',
    '<!-- [Source: Hidden, 2024-01-02] -->', '',
    '## Timeline', '',
    '- **2024-03-05** | Joined Acme [Source: Email, 2024-03-05]',
    '- **2024-04-10** | Promoted', '',
  ].join('\n'),
  'companies/acme-example.md': [
    '---', 'title: Acme Example', 'type: company', '---',
    '# Acme Example', '',
    '~~~', '[[tilde-fenced]] [Source: Tilde, 2024-01-03]', '~~~', '',
    'Acme raised a round. [Source: Press, 2024-02-01; Filing, 2024-02-03]', '',
    'An unclosed `backtick keeps [[alice-example]] live.', '',
    'Double ``code with `inner` [[x]]`` span, then *emphasis* [Source: Blog, 2024-02-20].', '',
  ].join('\n'),
  'notes/plain.md': [
    '---', 'title: Plain', '---',
    'Mentions [[alice-example]], [[acme-example]], [[people/alice-example]] and [[carol-example]].', '',
    '- **2024-05-01** | Plain bullet without a citation', '',
  ].join('\n'),
  'notes/crlf.md': ['---', 'title: Crlf', '---', 'Line one [[acme-example]]', '', 'Cited. [Source: Call, 2024-06-01]', '```', '[[in-fence]]', '```', ''].join('\r\n'),
  'notes/unterminated-fence.md': ['---', 'title: Unterminated', '---', 'Before [[acme-example]].', '', '````md', '[Source: Never, 2024-07-01]', '```', 'still fenced [[x]]', ''].join('\n'),
};

/** Written after the import (which refuses it), untracked, so only the filesystem checks see it. */
const BROKEN_PAGE = ['---', 'title: [unclosed', 'tags: a: b', '---', 'Body with [[alice-example]].', ''].join('\n');

const FIXED_DATE = '2024-01-01T00:00:00Z';

function writeSource(dir: string): void {
  for (const [rel, body] of Object.entries(PAGES)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  const env = { ...process.env, GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', ...args], { env, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
}

type Captures = Record<string, GbrainRun>;
const ALL = defineNormalizer<Captures>(DOCTOR.name, (c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, DOCTOR.apply(v)])));

async function capture(): Promise<Captures> {
  const h = makeDoctorHome('doctor-content-golden');
  homes.push(h);
  const src = join(h.home, 'notes-src');
  writeSource(src);
  for (const args of [
    ['init', '--pglite', '--no-embedding'],
    ['sources', 'add', 'notes', '--path', src, '--federated', '--force'],
    ['import', src, '--no-embed', '--source-id', 'notes'],
    ['extract', 'all', '--source', 'db'],
  ]) {
    const run = await runGbrain(h, args);
    if (run.exitCode !== 0) throw new Error(`gbrain ${args.join(' ')} failed (${run.exitCode}): ${run.stderr}`);
  }
  writeFileSync(join(src, 'notes', 'broken-frontmatter.md'), BROKEN_PAGE);
  const json = await runGbrain(h, ['doctor', '--json', '--skills-dir', h.skillsDir]);
  const human = await runGbrain(h, ['doctor', '--skills-dir', h.skillsDir]);
  expect(networkAttempts(h)).toEqual([]);
  return { json, human };
}

describe('gbrain doctor goldens on a brain with content (PGLite)', () => {
  test('doctor --json and human doctor match the master capture', async () => {
    const c = await expectNormalizerStable(capture, ALL);
    expect(c.json.json).not.toBeNull();
    expectGolden('doctor/content-pglite-json', c.json, DOCTOR);
    expectGolden('doctor/content-pglite-human', c.human, DOCTOR);
  }, 300_000);
});
