/**
 * self_capture doctor check (#5413): counts corpus files captured from
 * gbrain's own claude-cli sessions (classified) and files whose harness
 * transcript is gone (unclassifiable), prints copy-paste quarantine commands
 * and never moves or deletes anything.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { selfCaptureCheck } from '../src/commands/doctor/checks/self-capture.ts';
import { CLAUDE_CLI_CWD_PREFIX } from '../src/core/ai/providers/claude-cli-scratch.ts';

let engine: PGLiteEngine;
const root = mkdtempSync(join(tmpdir(), 'gbrain-self-capture-'));
const corpus = join(root, 'corpus');
const projects = join(root, 'claude', 'projects');

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  mkdirSync(corpus, { recursive: true });
  // A gbrain claude-cli scratch project holding two self sessions, and an ordinary project.
  const self = join(projects, `-tmp-${CLAUDE_CLI_CWD_PREFIX.replace(/[^a-z0-9]/gi, '-')}4242`);
  mkdirSync(self, { recursive: true });
  mkdirSync(join(projects, '-home-user-work'), { recursive: true });
  for (const id of ['self-a', 'self-b']) writeFileSync(join(self, `${id}.jsonl`), '{}\n');
  writeFileSync(join(projects, '-home-user-work', 'human-1.jsonl'), '{}\n');
  writeFileSync(join(corpus, 'self-a.txt'), 'self capture a');
  writeFileSync(join(corpus, 'self-a.txt.ingested'), '{}');
  writeFileSync(join(corpus, 'self-b.txt'), 'self capture b');
  writeFileSync(join(corpus, 'human-1.txt'), 'a real session');
  writeFileSync(join(corpus, 'pruned-9.txt'), 'harness transcript gone');
  mkdirSync(join(corpus, 'nested'), { recursive: true });
  writeFileSync(join(self, 'self-c.jsonl'), '{}\n');
  writeFileSync(join(corpus, 'nested', 'self-c.txt'), 'nested self capture');
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(root, { recursive: true, force: true });
});

describe('self_capture doctor check', () => {
  test('ok when no session corpus is configured', async () => {
    const check = await selfCaptureCheck(engine, { projectsRoot: projects });
    expect(check).toMatchObject({ name: 'self_capture', status: 'ok' });
  });

  test('counts classified and unclassifiable files, prints quarantine commands, and moves nothing', async () => {
    await engine.setConfig('dream.synthesize.session_corpus_dir', corpus);
    const before = readdirSync(corpus).sort();
    const check = await selfCaptureCheck(engine, { projectsRoot: projects });
    expect(check.status).toBe('warn');
    expect(check.details).toMatchObject({ classified: 3, unclassifiable: 1, corpus_files: 5, count: 'exact' });
    expect([...check.details!.classified_sample as string[]].sort()).toEqual(['nested/self-c.txt', 'self-a.txt', 'self-b.txt']);
    expect(check.message).toContain('Nothing was moved or deleted');
    // New captures stopped vs old files remain (#5820): the newest capture's
    // time is reported so a growing count is visible.
    expect(typeof check.details!.newest_capture_at).toBe('string');
    expect(check.message).toContain(`the newest is from ${check.details!.newest_capture_at}`);
    expect(check.message).toContain('no longer creates them (#5820)');
    expect(check.message).toContain('mkdir -p');
    expect(readdirSync(corpus).sort()).toEqual(before);

    // The printed commands are copy-paste runnable and move the capture with its sidecar.
    const commands = check.details!.quarantine_commands as string[];
    execFileSync('sh', ['-c', commands.join(' && ')]);
    const quarantine = check.details!.quarantine_dir as string;
    expect(readdirSync(quarantine).sort()).toEqual(['nested', 'self-a.txt', 'self-a.txt.ingested', 'self-b.txt']);
    expect(readdirSync(join(quarantine, 'nested'))).toEqual(['self-c.txt']);
    expect(readdirSync(corpus).sort()).toEqual(['human-1.txt', 'nested', 'pruned-9.txt']);
    expect(existsSync(join(corpus, 'human-1.txt'))).toBe(true);

    const after = await selfCaptureCheck(engine, { projectsRoot: projects });
    expect(after).toMatchObject({ status: 'ok', details: { classified: 0, unclassifiable: 1 } });
    expect(after.message).toContain('cannot be decided');
  });

  test.skipIf(process.getuid?.() === 0)('an unreadable nested corpus directory makes health unknown, never an exact count', async () => {
    const locked = join(corpus, 'locked');
    mkdirSync(locked);
    writeFileSync(join(locked, 'self-a.txt'), 'hidden');
    chmodSync(locked, 0o000);
    try {
      await engine.setConfig('dream.synthesize.session_corpus_dir', corpus);
      const check = await selfCaptureCheck(engine, { projectsRoot: projects });
      expect(check).toMatchObject({ status: 'warn', details: { health: 'unknown', count: 'lower_bound', unreadable_dirs: 1 } });
    } finally { chmodSync(locked, 0o755); rmSync(locked, { recursive: true, force: true }); }
  });

  test('an unreadable or missing corpus directory reports unknown health, never an exact zero', async () => {
    await engine.setConfig('dream.synthesize.session_corpus_dir', join(root, 'missing-corpus'));
    const check = await selfCaptureCheck(engine, { projectsRoot: projects });
    expect(check).toMatchObject({ status: 'warn', details: { health: 'unknown', count: 'unknown' } });
  });
});
