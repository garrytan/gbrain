/**
 * #7343: `gbrain doctor --only <wave check>` ran every wave check, and the
 * self-session classifier made one existence check per scratch project per
 * item.
 *
 * - The timeline_history entry runs only the checks `--only` names: a wave
 *   check alone, timeline_history only when named, everything without --only.
 * - `captured_facts_active` (classifyCapturedFacts) and `self_capture` read
 *   each scratch project once, so the filesystem calls do not grow with the
 *   number of facts or corpus files, and the classification is unchanged.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { timelineHistoryEntry } from '../src/commands/doctor/checks/graph-health.ts';
import { selfCaptureCheck } from '../src/commands/doctor/checks/self-capture.ts';
import { classifyCapturedFacts } from '../src/core/repair/captured-facts.ts';
import { CLAUDE_CLI_CWD_PREFIX } from '../src/core/ai/providers/claude-cli-scratch.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';

const noProgress = new Proxy({}, { get: () => () => undefined }) as DoctorContext['progress'];
const SCRATCH_PROJECTS = 6;
const SESSIONS = 30;

let engine: PGLiteEngine;
const root = fs.mkdtempSync(join(tmpdir(), 'gbrain-7343-'));
const projects = join(root, 'claude', 'projects');
const corpus = join(root, 'corpus');
const lastScratch = `-tmp-${CLAUDE_CLI_CWD_PREFIX}${1000 + SCRATCH_PROJECTS - 1}`;
const selfSessions = Array.from({ length: SESSIONS }, (_, i) => i).filter(i => i % 3 === 0).map(i => `sess-${i}`);

function ctxFor(only: Set<string> | null): DoctorContext {
  return {
    engine, args: ['--json'], jsonOutput: true, fastMode: false, doFix: false, dryRun: false, scope: 'brain', orphanRatioSourceId: undefined,
    progress: noProgress, skillsDirResolution: { dir: null, source: 'none' }, skillsDir: null, autoFixReport: null, schemaVersion: 0,
    connectionFailed: false, only, tier: 'standard',
  };
}

const names = async (only: Set<string> | null) => ((await timelineHistoryEntry.run(ctxFor(only))) as Array<{ name: string }>).map(c => c.name);

/** Counts fs calls whose path lies under the harness projects root while `run` executes. */
async function projectFsCalls<T>(run: () => Promise<T>): Promise<{ result: T; exists: number; readdirs: number }> {
  const under = (p: unknown) => typeof p === 'string' && p.startsWith(projects);
  const exists = spyOn(fs, 'existsSync');
  const readdir = spyOn(fs, 'readdirSync');
  try {
    const result = await run();
    return { result, exists: exists.mock.calls.filter(([p]) => under(p)).length, readdirs: readdir.mock.calls.filter(([p]) => under(p)).length };
  } finally {
    exists.mockRestore();
    readdir.mockRestore();
  }
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  fs.mkdirSync(corpus, { recursive: true });
  for (let p = 0; p < SCRATCH_PROJECTS; p++) fs.mkdirSync(join(projects, `-tmp-${CLAUDE_CLI_CWD_PREFIX}${1000 + p}`), { recursive: true });
  fs.mkdirSync(join(projects, '-home-user-work'), { recursive: true });
  for (let i = 0; i < SESSIONS; i++) {
    const id = `sess-${i}`;
    fs.writeFileSync(join(projects, selfSessions.includes(id) ? lastScratch : '-home-user-work', `${id}.jsonl`), '{}\n');
    fs.writeFileSync(join(corpus, `${id}.txt`), `[user]\nsession ${i}\n`);
    await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, source_session)
      VALUES ('default', 'people/alice-example', $1, 'fact', 'private', 'hook:writeback', $2)`, [`Alice Example fact number ${i}`, id]);
  }
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('#7343 doctor --only selects single wave checks', () => {
  test('a wave check named in --only runs alone', async () => {
    expect(await names(new Set(['writer_version']))).toEqual(['writer_version']);
  }, 60_000);

  test('timeline_history runs only when named, and alone', async () => {
    expect(await names(new Set(['timeline_history']))).toEqual(['timeline_history']);
  }, 60_000);

  test('two named wave checks run in entry order, and nothing else', async () => {
    expect(await names(new Set(['keyword_plan', 'segmented_storage']))).toEqual(['segmented_storage', 'keyword_plan']);
  }, 60_000);

  test('without --only the entry still emits every check it declares', async () => {
    expect(await names(null)).toEqual([...timelineHistoryEntry.emits]);
  }, 120_000);
});

describe('#7343 self-session lookups read each scratch project once', () => {
  test('classifyCapturedFacts: no per-fact existence checks, same classes', async () => {
    const { result, exists, readdirs } = await projectFsCalls(() => classifyCapturedFacts(engine, ['default'], { projectsRoot: projects, corpusDir: corpus }));
    const evidenced = result.candidates.filter(c => c.reason === 'self_capture_transcript');
    expect(evidenced.map(c => c.session).sort()).toEqual([...selfSessions].sort());
    expect(evidenced.every(c => c.evidence === join(lastScratch, `${c.session}.jsonl`))).toBe(true);
    expect(result.not_suspect).toBe(SESSIONS - selfSessions.length);
    expect(exists).toBe(0);
    expect(readdirs).toBeLessThanOrEqual(2 * (SCRATCH_PROJECTS + 2));
  }, 60_000);

  test('selfCaptureCheck: no per-file existence checks, same counts', async () => {
    await engine.setConfig('dream.synthesize.session_corpus_dir', corpus);
    const { result, exists, readdirs } = await projectFsCalls(() => selfCaptureCheck(engine, { projectsRoot: projects }));
    expect(result.details).toMatchObject({ classified: selfSessions.length, unclassifiable: 0, corpus_files: SESSIONS });
    expect(exists).toBe(0);
    expect(readdirs).toBeLessThanOrEqual(2 * (SCRATCH_PROJECTS + 2));
  }, 60_000);
});
