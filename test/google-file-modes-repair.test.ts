/**
 * Legacy Google file repair (security fix wave, user challenge UC1): files
 * gbrain wrote under a Google source directory outside `~/.gbrain` before
 * this release keep their 0644 modes. `gbrain doctor` reports them
 * (`google_file_modes`), the v0.60.31 migration prints a one-time notice, and
 * `gbrain repair google-file-modes` previews by default and tightens only with
 * `--apply`: only gbrain's own layout, never the chosen root, never through a
 * symlink, never another user's file. POSIX modes only: skipped on win32.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { checkGoogleFileModes } from '../src/commands/doctor/checks/google-file-modes.ts';
import { googleFileModesNoticePhase } from '../src/commands/migrations/v0_60_31-google-file-modes.ts';

let engine: PGLiteEngine;
const scratch = mkdtempSync(join(tmpdir(), 'gbrain-google-repair-'));
const home = join(scratch, 'home');
let root: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
  root = mkdtempSync(join(scratch, 'custom-'));
  chmodSync(root, 0o755);
});

const mode = (path: string) => lstatSync(path).mode & 0o7777;
const config = (dir: string) => JSON.stringify({ kind: 'google', g_account: 'owner@example.invalid', g_services: 'gmail', g_dir: dir });
const PAGES = ['emails/2026/09/2026-09-01-roadmap-aa11.md', 'calendar/2026/09/2026-09-02-sync-bb22.md', 'people/alice-example.md'];

/** A pre-release custom-dir layout: everything 0644/0755, as the default umask left it. */
async function legacySource(id = 'gmail', dir = root) {
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [id, dir, config(dir)]);
  for (const rel of PAGES) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), `page ${rel}\n`);
    chmodSync(join(dir, rel), 0o644);
    await engine.putPage(rel.replace(/\.md$/, ''), { type: 'note', title: rel, compiled_truth: rel, timeline: '', frontmatter: {} }, { sourceId: id });
    await engine.executeRaw('UPDATE pages SET source_path=$1 WHERE source_id=$2 AND slug=$3', [rel, id, rel.replace(/\.md$/, '')]);
  }
  for (const d of ['emails', 'emails/2026', 'emails/2026/09', 'calendar', 'calendar/2026', 'calendar/2026/09', 'people']) chmodSync(join(dir, d), 0o755);
  writeFileSync(join(dir, '.google-source.json'), '{}');
  chmodSync(join(dir, '.google-source.json'), 0o644);
  writeFileSync(join(dir, 'my-own-notes.md'), 'not gbrain');
  chmodSync(join(dir, 'my-own-notes.md'), 0o644);
}

const repair = (apply: boolean, source?: string) => withEnv({ GBRAIN_HOME: home }, async () => {
  const runner = await repairRunner(engine, { apply, logger: { info() {}, warn() {}, error() {} } });
  return runner.run('google-file-modes', await resolveRepairScope(engine, source), { sourceFlag: source, explicit: true });
});

describe.skipIf(process.platform === 'win32')('gbrain repair google-file-modes', () => {
  test('preview lists gbrain-written loose entries and changes nothing', async () => {
    await legacySource();
    const result = await repair(false, 'gmail');
    expect(result.mode).toBe('dry_run');
    // 3 pages + state file + 7 layout directories; never the root or the user's own file.
    expect(result.affected).toBe(11);
    expect(result.sample).toContain('gmail:.google-source.json');
    expect(result.sample.some(item => item.includes('my-own-notes'))).toBe(false);
    expect(result.apply_command).toBe('gbrain repair google-file-modes --source gmail --apply');
    expect(mode(join(root, PAGES[0]))).toBe(0o644);
    expect(mode(join(root, 'emails'))).toBe(0o755);
  });

  test('apply tightens files 0600 and layout directories 0700, leaving the root, other files and content untouched', async () => {
    await legacySource();
    const before = PAGES.map(rel => readFileSync(join(root, rel), 'utf8'));
    const result = await repair(true, 'gmail');
    expect(result).toMatchObject({ applied: 11, skipped: 0, complete: true });
    for (const rel of [...PAGES, '.google-source.json']) expect([rel, mode(join(root, rel))]).toEqual([rel, 0o600]);
    for (const d of ['emails', 'emails/2026', 'emails/2026/09', 'calendar', 'people']) expect([d, mode(join(root, d))]).toEqual([d, 0o700]);
    expect(mode(root)).toBe(0o755);
    expect(mode(join(root, 'my-own-notes.md'))).toBe(0o644);
    expect(PAGES.map(rel => readFileSync(join(root, rel), 'utf8'))).toEqual(before);
    expect((await repair(false, 'gmail')).affected).toBe(0);
  });

  test('never follows a symlinked page or a symlinked layout directory', async () => {
    await legacySource();
    const outside = join(scratch, `outside-${Date.now()}`);
    mkdirSync(join(outside, '2026', '09'), { recursive: true });
    writeFileSync(join(outside, 'target.md'), 'outside');
    chmodSync(join(outside, 'target.md'), 0o644);
    writeFileSync(join(outside, '2026', '09', '2026-09-02-sync-bb22.md'), 'outside');
    chmodSync(join(outside, '2026', '09', '2026-09-02-sync-bb22.md'), 0o644);
    rmSync(join(root, 'people/alice-example.md'));
    symlinkSync(join(outside, 'target.md'), join(root, 'people/alice-example.md'));
    rmSync(join(root, 'calendar'), { recursive: true });
    symlinkSync(outside, join(root, 'calendar'));
    const preview = await repair(false, 'gmail');
    expect(preview.residuals.skipped_symlink).toBeGreaterThanOrEqual(2);
    expect(preview.sample.some(item => item.includes('calendar') || item.includes('alice'))).toBe(false);
    await repair(true, 'gmail');
    expect(mode(join(outside, 'target.md'))).toBe(0o644);
    expect(mode(join(outside, '2026', '09', '2026-09-02-sync-bb22.md'))).toBe(0o644);
    expect(mode(join(root, PAGES[0]))).toBe(0o600);
  });

  test("another user's files are counted and left alone", async () => {
    await legacySource();
    const getuid = process.getuid!;
    const real = getuid.call(process);
    process.getuid = () => real + 1;
    let preview;
    try { preview = await repair(false, 'gmail'); } finally { process.getuid = getuid; }
    expect(preview.affected).toBe(0);
    expect(preview.residuals.skipped_foreign_owner).toBeGreaterThan(0);
    expect(mode(join(root, PAGES[0]))).toBe(0o644);
  });

  test('a Google source inside ~/.gbrain is out of scope', async () => {
    const inside = join(home, '.gbrain', 'clones', 'gmail-google');
    mkdirSync(inside, { recursive: true });
    await legacySource('gmail', inside);
    expect((await repair(false, 'gmail')).affected).toBe(0);
  });
});

describe.skipIf(process.platform === 'win32')('detection: doctor and the one-time upgrade notice', () => {
  test('doctor warns per directory with counts and the exact preview and apply commands, without file names', async () => {
    await legacySource();
    const check = await withEnv({ GBRAIN_HOME: home }, () => checkGoogleFileModes(engine));
    expect(check.status).toBe('warn');
    expect(check.message).toContain(`Google source gmail: 4 file(s) and 7 directories gbrain wrote under ${root}`);
    expect(check.message).toContain('Preview: gbrain repair google-file-modes --source gmail');
    expect(check.message).toContain('apply after the user agrees: gbrain repair google-file-modes --source gmail --apply');
    expect(check.message).not.toContain('roadmap');
    await repair(true, 'gmail');
    expect((await withEnv({ GBRAIN_HOME: home }, () => checkGoogleFileModes(engine))).status).toBe('ok');
  });

  test('the migration notice names each custom-dir source once and skips default-dir sources', async () => {
    await legacySource('custom');
    const inside = join(home, '.gbrain', 'clones', 'default-google');
    mkdirSync(inside, { recursive: true });
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', ['inside-home', inside, config(inside)]);
    const printed: string[] = [];
    const run = () => withEnv({ GBRAIN_HOME: home }, () => googleFileModesNoticePhase(engine, { dryRun: false, print: line => printed.push(line) }));
    expect((await run()).status).toBe('complete');
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain(`Google source custom keeps its files in ${root}, outside ~/.gbrain`);
    expect(printed[0]).toContain('(11 found now)');
    expect(printed[0]).toContain('gbrain repair google-file-modes --source custom --apply');
    expect(printed[0]).not.toContain('roadmap');
    expect(mode(join(root, PAGES[0]))).toBe(0o644);
    expect(await run()).toMatchObject({ status: 'skipped', detail: 'already_shown' });
    expect(printed).toHaveLength(1);
  });
});
