import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { runDream } from '../src/commands/dream.ts';
import { runCycle } from '../src/core/cycle.ts';
import { runPhaseSynthesize } from '../src/core/cycle/synthesize.ts';
import { ensureCorpusSpoolDir, wbFileName } from '../src/core/context/corpus-segments.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { keylessDreamTest as test } from './helpers/keyless-dream-test.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const floor = '2026-09-02T12:00:00Z';
const oldCapture = '2026-09-02T11:59:59Z';
const newCapture = '2026-09-02T12:00:00Z';
const files = {
  oldDated: '2026-09-01-old.txt',
  newDated: '2026-09-03-new.txt',
  oldUndated: wbFileName('old-session', '1'.repeat(24), 'default'),
  newUndated: wbFileName('new-session', '2'.repeat(24), 'default'),
  oldFrontmatter: 'old-frontmatter.md',
  newFrontmatter: 'new-frontmatter.md',
};
const oldPage = 'sessions/2026-09-03-old-page';
const newPage = 'sessions/2026-09-01-new-page';
const undatedPage = 'sessions/2026-09-04-undated-page';
const sinceKey = 'dream.synthesize.since';
let engine: PGLiteEngine;
let root: string;
let brainDir: string;
let corpusDir: string;
let spool: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => { await engine.disconnect(); });

beforeEach(async () => {
  await resetPgliteState(engine);
  root = mkdtempSync(join(tmpdir(), 'gbrain-dream-since-'));
  brainDir = join(root, 'brain');
  corpusDir = join(root, 'corpus');
  mkdirSync(brainDir);
  spool = ensureCorpusSpoolDir(corpusDir);
  await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
  await engine.setConfig('dream.synthesize.min_chars', '20');
  await engine.setConfig('models.dream.triage', 'no-such-provider:judge');
  write(corpusDir, files.oldDated, newCapture);
  write(corpusDir, files.newDated, oldCapture);
  write(spool, files.oldUndated, oldCapture);
  write(spool, files.newUndated, newCapture);
  write(corpusDir, files.oldFrontmatter, newCapture, '2026-09-02T13:00:00+02:00');
  write(corpusDir, files.newFrontmatter, oldCapture, '2026-09-02T14:00:00+02:00');
  await put(oldPage, '2026-09-01');
  await put(newPage, '2026-09-02T07:00:00-05:00');
  await put(undatedPage);
});

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function write(dir: string, name: string, modified: string, date?: string) {
  const path = join(dir, name);
  writeFileSync(path, `${date ? `---\ndate: '${date}'\n---\n` : ''}[user]\nDiscussed the launch plan in ${name}.\n`);
  utimesSync(path, new Date(modified), new Date(modified));
}

async function put(slug: string, date?: string) {
  await engine.putPage(slug, {
    type: 'conversation', title: 'Planning notes', compiled_truth: `Discussion of the launch plan in ${slug}.`,
    frontmatter: date ? { date } : {},
  });
}

function candidateNames(result: { details?: Record<string, unknown> }): string[] {
  return (result.details?.verdicts as Array<{ filePath: string }>).map(v => basename(v.filePath)).sort();
}

test('the real cycle admits only corpus files and conversation pages at or after the floor', async () => {
  await engine.setConfig(sinceKey, floor);
  for (const dir of [brainDir, null]) {
    const report = await runCycle(engine, { brainDir: dir, phases: ['synthesize'] });
    const phase = report.phases.find(p => p.phase === 'synthesize')!;
    expect(phase.status).toBe('ok');
    expect(candidateNames(phase)).toEqual([files.newDated, files.newUndated, files.newFrontmatter, basename(newPage)].sort());
    expect(phase.details?.synthesis_state).toEqual({ candidates: 4, already_synthesized: 0 });
  }
}, 60_000);

test('no floor preserves the historical corpus and conversation candidate list', async () => {
  const phase = await runPhaseSynthesize(engine, { brainDir, dryRun: true });
  expect(phase.status).toBe('ok');
  expect(candidateNames(phase)).toEqual([...Object.values(files), ...[oldPage, newPage, undatedPage].map(p => basename(p))].sort());
  expect(phase.details).not.toHaveProperty('since');
}, 60_000);

test('date and range windows use the UTC capture day for undated corpus files', async () => {
  const phase = await runPhaseSynthesize(engine, { brainDir, dryRun: true, date: '2026-09-02' });
  expect(candidateNames(phase)).toEqual([files.oldUndated, files.newUndated, files.oldFrontmatter, files.newFrontmatter, basename(newPage)].sort());

  await engine.setConfig(sinceKey, floor);
  const range = await runPhaseSynthesize(engine, { brainDir, dryRun: true, from: '2026-09-02', to: '2026-09-02' });
  expect(candidateNames(range)).toEqual([files.newUndated, files.newFrontmatter, basename(newPage)].sort());
}, 60_000);

test('an invalid cutoff fails the phase before discovery even when synthesis is off', async () => {
  await engine.setConfig('dream.synthesize.enabled', 'false');
  for (const value of ['', 'tomorrow', '2026-02-30', '2026-09-02T25:00:00Z']) {
    await engine.setConfig(sinceKey, value);
    const phase = await runPhaseSynthesize(engine, { brainDir, dryRun: true });
    expect(phase.status).toBe('fail');
    expect(phase.error?.message).toContain(sinceKey);
    expect(phase.details).not.toHaveProperty('verdicts');
  }
}, 60_000);

test('bare dream --dry-run --json previews the floor on a paused repo-less brain', async () => {
  await engine.setConfig('dream.synthesize.enabled', 'false');
  const stdout = spyOn(console, 'log').mockImplementation(() => {});
  try {
    for (const [since, count] of [['2026-09-02', 6], ['2026-12-01', 0]] as const) {
      await engine.setConfig(sinceKey, since);
      const report = await runDream(engine, ['--dry-run', '--json']);
      const json = stdout.mock.calls.findLast(([line]) => typeof line === 'string' && line.startsWith('{'))?.[0];
      expect(JSON.parse(json as string)).toEqual(report);
      expect(report?.phases.find(p => p.phase === 'synthesize')).toMatchObject({
        status: 'ok', details: { since, transcripts_discovered: count, synthesis_state: { candidates: count } },
      });
    }
  } finally {
    stdout.mockRestore();
  }
}, 60_000);

test('the cutoff also excludes an explicitly selected older file', async () => {
  await engine.setConfig(sinceKey, floor);
  const phase = await runPhaseSynthesize(engine, { brainDir, dryRun: true, inputFile: join(corpusDir, files.oldDated) });
  expect(phase.details).toMatchObject({ since: floor, transcripts_discovered: 0, synthesis_state: { candidates: 0 } });
}, 60_000);
