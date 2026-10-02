/**
 * Google connector file privacy (security fix wave). Custom `--dir` Google
 * sources live outside the 0700 `~/.gbrain`, so the files gbrain writes there
 * must be private by themselves: the cursor state file, its corrupt-file
 * quarantine and every materialized page are 0600, and directories gbrain
 * creates are 0700. A directory the user chose is never chmod-ed.
 *
 * Every mode assertion runs in a child process under umask 0000
 * (test/helpers/google-file-modes-child.ts), where an unspecified mode is
 * world-readable, so a writer that forgets its mode fails here. POSIX modes
 * only: skipped on win32.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { googleStateFile, readGoogleState } from '../src/core/google/google-source.ts';

const posix = process.platform !== 'win32';
const base = mkdtempSync(join(tmpdir(), 'gbrain-file-modes-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

async function child(scenario: string, dir: string, extra: Record<string, unknown> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, GBRAIN_HOME: join(base, 'home'), FILE_MODES_TOKEN: 'synthetic-local-fixture',
    GBRAIN_TEST_FILE_MODES: JSON.stringify({ scenario, base: dir, ...extra }) };
  delete env.DATABASE_URL;
  delete env.GBRAIN_DATABASE_URL;
  const proc = Bun.spawn([process.execPath, 'run', join(import.meta.dir, 'helpers/google-file-modes-child.ts')], { env, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill('SIGKILL'), 100_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const line = stdout.split('\n').find(l => l.startsWith('FILE_MODES {'));
    return { stdout, stderr, exit, result: line ? JSON.parse(line.slice('FILE_MODES '.length)) : null };
  } finally { clearTimeout(timer); if (proc.exitCode === null) proc.kill('SIGKILL'); await proc.exited; }
}

describe.skipIf(!posix)('Google files written under umask 0000', () => {
  let legacy: any;
  let managed: any;
  beforeAll(async () => {
    const legacyDir = join(base, 'legacy');
    const managedDir = join(base, 'managed');
    mkdirSync(legacyDir);
    mkdirSync(managedDir);
    const [l, m] = await Promise.all([child('legacy', legacyDir), child('managed', managedDir)]);
    expect(l.result, l.stderr).not.toBeNull();
    expect(m.result, m.stderr).not.toBeNull();
    legacy = l.result;
    managed = m.result;
  }, 120_000);

  test('atomicWriteFileSync opens and fchmods a requested mode; an omitted mode keeps the existing behavior', () => {
    expect(legacy.atomic).toEqual({ requested: 0o600, legacy: 0o600, omitted: 0o644, preserved: 0o640 });
  });

  test('sources add --kind google creates only the leaf 0700 and leaves a chosen directory alone', () => {
    expect(legacy.sourcesAdd).toEqual({ parent: 0o777, added: 0o700, chosen: 0o755 });
  });

  test('a fresh sweep writes the state file and every page 0600 and lays out 0700 directories under an untouched root', () => {
    expect(legacy.fresh.status).not.toBe('partial');
    expect(legacy.fresh.root).toBe(0o755);
    const files = Object.entries(legacy.fresh.files);
    expect(files.map(([path]) => path)).toEqual(expect.arrayContaining(['.google-source.json']));
    expect(files.filter(([path]) => path.endsWith('.md')).map(([path]) => path.split('/')[0]).sort()).toEqual(['calendar', 'emails', 'people']);
    for (const [path, mode] of files) expect([path, mode]).toEqual([path, 0o600]);
    expect(Object.keys(legacy.fresh.dirs).length).toBeGreaterThan(3);
    for (const [path, mode] of Object.entries(legacy.fresh.dirs)) expect([path, mode]).toEqual([path, 0o700]);
  });

  test('a delta sweep over legacy 0644 files reasserts 0600 and replaces a stale 0644 temp file', () => {
    expect(legacy.delta).toMatchObject({ pageMode: 0o600, state: 0o600, staleTmp: false });
    expect(legacy.delta.status).not.toBe('partial');
  });

  test('a stale temp path that is a directory fails that thread with an error naming the path', () => {
    expect(legacy.staleDir.status).toBe('partial');
    expect(legacy.staleDir.stderr).toContain(`Stale temporary path ${legacy.staleDir.tmpPath} is a directory`);
  });

  test('a corrupt state file is quarantined 0600 and the sync continues with empty state', () => {
    expect(legacy.quarantine).toEqual({ mode: 0o600, emptyState: true });
  });

  test('managed coordinator publication with publishMode lands 0600 files and 0700 created directories, and reasserts on rewrite', () => {
    expect(managed.coordinatorNew).toMatchObject({ state: 'committed', file: 0o600, root: 0o755,
      dirs: { emails: 0o700, 'emails/2026': 0o700, 'emails/2026/09': 0o700 } });
    expect(managed.coordinatorRewrite).toEqual({ state: 'committed', file: 0o600 });
  });

  test('managed Google import and receipts rewrite publish 0600 without changing the submitted intent', () => {
    expect(managed.googleImport).toMatchObject({ file: 0o600, root: 0o755, dirs: { emails: 0o700, 'emails/2026': 0o700, 'emails/2026/09': 0o700 } });
    expect(managed.googleImport.intentText).not.toContain('publishMode');
    expect(managed.googleImport.intentText).not.toContain('"mode"');
    // Request ids derive from this intent (minus its authority); the key set is the pre-wave set, so ids are unchanged across the upgrade.
    expect(managed.googleImport.intentKeys).toEqual(['canonicalRoot', 'checkpointBefore', 'checkpointKey', 'configHash', 'connector', 'content',
      'expected_revision', 'fileBeforeHash', 'filePath', 'kind', 'noEmbed', 'noSchemaPack', 'ownerEpoch', 'sourcePath', 'sourceRoot', 'syncAuthority']);
    expect(managed.googleReceipts).toEqual({ status: 'complete', file: 0o600 });
  });
});

describe.skipIf(!posix)('managed restoration after a crash', () => {
  test('restoring a deleted private page stages it 0600 from the first byte, then restores it 0600', async () => {
    const dir = join(base, 'restore-case');
    mkdirSync(dir);
    const crashed = await child('restore-crash', dir);
    expect(crashed.stdout, crashed.stderr).toContain('FILE_MODES_CRASH');
    expect(crashed.result.before).toBe(0o600);
    expect(existsSync(crashed.result.file)).toBe(false);
    const observed = await child('restore-observe', dir, { requestId: crashed.result.requestId });
    expect(observed.result, observed.stderr).not.toBeNull();
    expect(observed.exit).not.toBe(0);
    expect(observed.result.stageMode).toBe(0o600);
    expect(lstatSync(observed.result.stage).mode & 0o777).toBe(0o600);
    const finished = await child('restore-finish', dir, { requestId: crashed.result.requestId });
    expect(finished.result, finished.stderr).toMatchObject({ recovery: null, file: 0o600 });
  }, 120_000);
});

describe('corrupt state quarantine that cannot be secured', () => {
  test('names the path, the failed step, the exposure and the fix, and still returns empty state', () => {
    const dir = join(base, 'unsecured');
    mkdirSync(join(dir, '.google-source.json.corrupt', 'occupied'), { recursive: true });
    writeFileSync(googleStateFile(dir), '{ not json');
    const lines: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
    let state;
    try { state = readGoogleState(dir); } finally { process.stderr.write = write; }
    expect(state.gmail_history_id).toBeNull();
    const file = googleStateFile(dir);
    expect(lines.join('')).toContain(`[google] could not secure the quarantined state file ${file}: rename failed`);
    expect(lines.join('')).toContain(`It may be readable by other local users; run chmod 600 ${file} or delete it.`);
  });
});
