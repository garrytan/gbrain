/**
 * codex hook lane — the two coupled defects that made an archived rollout
 * unreachable end-to-end:
 *
 *  1. `confineCodexTranscriptPath` collapsed EVERY lstat failure to
 *     `unreadable`, so a vanished path never reached hook.ts's
 *     `reason === 'missing_path'` gate and discovery never engaged.
 *  2. Confinement and discovery both knew only `<codex home>/sessions`, so a
 *     rollout codex had moved to `<codex home>/archived_sessions` was refused
 *     as `outside_projects_dir` and was invisible to the fallback walk.
 *
 * The archived store is FLAT (no YYYY/MM/DD nesting), which is why the dated
 * walk alone could never see it.
 *
 * The degrade label matters: hook.ts computes
 * `discoveryWasGuess = found.degrade === 'transcript_discovered_newest'`, so
 * an id-MATCHED archived hit must keep `transcript_discovered` — labelling it
 * `_newest` would misclassify a real match as a guess and suppress the relay.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  confineCodexTranscriptPath,
  discoverNewestCodexRollout,
} from '../src/core/transcripts/codex-hook-lane.ts';
import { withEnv } from './helpers/with-env.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gb-cdx-arch-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const meta = JSON.stringify({
  timestamp: 't0',
  type: 'session_meta',
  payload: { id: 'r-1', session_id: 'cdx-sess-1', timestamp: 't0', cwd: '/repo', cli_version: '0.147.0' },
});

/** Seed the FLAT archived store under a codex home. */
function seedArchived(home: string, name = 'rollout-2026-08-20-zzz-sess-arch.jsonl'): string {
  const arch = join(home, 'archived_sessions');
  mkdirSync(arch, { recursive: true });
  const p = join(arch, name);
  writeFileSync(p, meta + '\n');
  return p;
}

describe('confineCodexTranscriptPath — the missing_path rung', () => {
  test('a vanished path reports missing_path, not unreadable (hook.ts gates discovery on it)', () => {
    const root = join(dir, 'sessions');
    const day = join(root, '2026', '08', '25');
    mkdirSync(day, { recursive: true });
    expect(confineCodexTranscriptPath(join(day, 'gone.jsonl'), { root })).toEqual({
      ok: false,
      reason: 'missing_path',
    });

    // ENOTDIR — a path component that is a file, not a directory. Also "this
    // path does not exist as given", so it takes the same rung.
    const real = join(day, 'rollout-real-sess-a.jsonl');
    writeFileSync(real, meta + '\n');
    expect(confineCodexTranscriptPath(join(real, 'nested.jsonl'), { root })).toEqual({
      ok: false,
      reason: 'missing_path',
    });
  });
});

describe('confineCodexTranscriptPath — the archived store is inside the fence', () => {
  test('a rollout under archived_sessions is accepted by the PRODUCTION default (root undefined)', async () => {
    await withEnv({ CODEX_HOME: dir }, async () => {
      mkdirSync(join(dir, 'sessions'), { recursive: true });
      const archived = seedArchived(dir);
      expect(confineCodexTranscriptPath(archived)).toEqual({
        ok: true,
        path: archived,
        size: expect.any(Number),
      });

      // The live store still resolves through that same default.
      const day = join(dir, 'sessions', '2026', '08', '25');
      mkdirSync(day, { recursive: true });
      const live = join(day, 'rollout-live-sess-b.jsonl');
      writeFileSync(live, meta + '\n');
      expect(confineCodexTranscriptPath(live)).toEqual({ ok: true, path: live, size: expect.any(Number) });
    });
  });

  test('PRESERVED: an explicitly pinned root stays single-root — the test seam never widens', async () => {
    await withEnv({ CODEX_HOME: dir }, async () => {
      const root = join(dir, 'sessions');
      mkdirSync(root, { recursive: true });
      const archived = seedArchived(dir);
      expect(confineCodexTranscriptPath(archived, { root })).toEqual({
        ok: false,
        reason: 'outside_projects_dir',
      });
      expect(discoverNewestCodexRollout('sess-arch', { root })).toBeNull();
    });
  });

  test('PRESERVED: paths outside BOTH stores are still refused', async () => {
    await withEnv({ CODEX_HOME: dir }, async () => {
      mkdirSync(join(dir, 'sessions'), { recursive: true });
      mkdirSync(join(dir, 'archived_sessions'), { recursive: true });

      const outside = join(dir, 'outside.jsonl');
      writeFileSync(outside, meta + '\n');
      expect(confineCodexTranscriptPath(outside)).toEqual({ ok: false, reason: 'outside_projects_dir' });

      // A directory that merely shares the archived NAME but sits elsewhere is
      // not a root — the widening is two pinned paths, not a name match.
      const decoy = join(dir, 'nested', 'archived_sessions');
      mkdirSync(decoy, { recursive: true });
      const decoyFile = join(decoy, 'rollout-decoy-sess-d.jsonl');
      writeFileSync(decoyFile, meta + '\n');
      expect(confineCodexTranscriptPath(decoyFile)).toEqual({ ok: false, reason: 'outside_projects_dir' });
    });
  });

  test('PRESERVED: the whole ladder applies to the archived root in the same order', async () => {
    await withEnv({ CODEX_HOME: dir }, async () => {
      mkdirSync(join(dir, 'sessions'), { recursive: true });
      const arch = join(dir, 'archived_sessions');
      mkdirSync(arch, { recursive: true });

      expect(confineCodexTranscriptPath('')).toEqual({ ok: false, reason: 'missing_path' });
      expect(confineCodexTranscriptPath(join(arch, 'x.txt'))).toEqual({ ok: false, reason: 'not_jsonl' });

      const evil = join(dir, 'evil.jsonl');
      writeFileSync(evil, meta + '\n');
      const link = join(arch, 'rollout-link-sess-e.jsonl');
      symlinkSync(evil, link);
      expect(confineCodexTranscriptPath(link)).toEqual({ ok: false, reason: 'symlink' });

      const fat = join(arch, 'rollout-fat-sess-f.jsonl');
      writeFileSync(fat, 'x'.repeat(64));
      expect(confineCodexTranscriptPath(fat, { maxBytes: 16 })).toEqual({ ok: false, reason: 'too_large' });
    });
  });
});

describe('discoverNewestCodexRollout — reaches the flat archived store', () => {
  test('an id match in archived_sessions is found and is NOT labelled a guess', async () => {
    await withEnv({ CODEX_HOME: dir }, async () => {
      mkdirSync(join(dir, 'sessions'), { recursive: true });
      const archived = seedArchived(dir);
      // Production default: root undefined → both stores.
      expect(discoverNewestCodexRollout('sess-arch')).toEqual({
        path: archived,
        degrade: 'transcript_discovered',
      });
    });
  });

  test('with no id the newest across BOTH stores wins; archived symlinks are still refused', () => {
    const root = join(dir, 'sessions');
    const arch = join(dir, 'archived_sessions');
    const day = join(root, '2026', '08', '25');
    mkdirSync(day, { recursive: true });
    mkdirSync(arch, { recursive: true });
    const live = join(day, 'rollout-live-sess-g.jsonl');
    const archived = join(arch, 'rollout-arch-sess-h.jsonl');
    writeFileSync(live, meta + '\n');
    writeFileSync(archived, meta + '\n');
    const past = new Date(Date.now() - 60_000);
    utimesSync(live, past, past); // the archived copy is newer

    expect(discoverNewestCodexRollout(null, { root, archivedRoot: arch })).toEqual({
      path: archived,
      degrade: 'transcript_discovered_newest',
    });

    const evil = join(dir, 'evil2.jsonl');
    writeFileSync(evil, meta + '\n');
    symlinkSync(evil, join(arch, 'rollout-linked-sess-i.jsonl'));
    expect(discoverNewestCodexRollout('sess-i', { root, archivedRoot: arch })).toBeNull();
  });
});
