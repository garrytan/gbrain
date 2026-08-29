/**
 * `gbrain hook` monthly backup-coverage integration points (hook.ts):
 *   1. session-start digest note (backupSessionStartNote, 'hook-note' channel,
 *      record-after-write + 24h cross-channel dampener);
 *   2. user-prompt banner on the degraded no-serve path (pendingBackupBanner,
 *      'hook-banner' channel), with the push-failure banner outranking it;
 *   3. session-end detached `gbrain backup check --quiet` spawn (stale-or-absent
 *      cache only, 24h debounce via last_spawn_at in the nag file, kill switch).
 *
 * hook.ts reads the REAL cache/nag paths under GBRAIN_HOME (status-file.ts
 * seams stay at their defaults), so tests write the cache via saveBackupStatus()
 * against the tmp home. Follows test/hook-command.serial.test.ts exactly for
 * env save/restore + tmp GBRAIN_HOME + collectStdout + runHook.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runHook } from '../src/commands/hook.ts';
import { pushStatusPathForRoot } from '../src/core/workspace-push.ts';
import {
  BACKUP_STATUS_SCHEMA_VERSION,
  BACKUP_NAG_SCHEMA_VERSION,
  saveBackupStatus,
  __setBackupStatusPathForTests,
  __setBackupNagStatePathForTests,
  __setBackupIntervalForTests,
  type BackupStatus,
} from '../src/core/backup/status-file.ts';

const ENV_KEYS = [
  'GBRAIN_HOME', 'DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_SOURCE', 'GBRAIN_HOOKS',
  // stop-push [D3/D17/D20] + banner [D5] + cloud detection knobs
  'GBRAIN_STOP_PUSH', 'GBRAIN_STOP_PUSH_DEBOUNCE_MIN', 'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_REMOTE_SESSION_ID', 'GH_TOKEN', 'GITHUB_TOKEN',
  // backup-check knobs
  'GBRAIN_BACKUP_CHECK', 'GBRAIN_BACKUP_CHECK_DAYS', 'GBRAIN_FORCE_BACKUP_NAG',
] as const;

let tmp: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gb-hkbk-'));
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GBRAIN_HOME = tmp; // cache/nag/heartbeat all under tmp/.gbrain
  // Seams stay at DEFAULT — they resolve under the tmp GBRAIN_HOME. The
  // explicit nulls just guard against leakage from another file in-process.
  __setBackupStatusPathForTests(null);
  __setBackupNagStatePathForTests(null);
  __setBackupIntervalForTests(null);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

const home = () => join(tmp, '.gbrain');
const nagPath = () => join(home(), 'backup-nag-state.json');

function collectStdout(): { io: { write: (s: string) => void }; get: () => string } {
  let buf = '';
  return { io: { write: (s: string) => { buf += s; } }, get: () => buf };
}

interface NagFileShape {
  schema_version: string;
  entries: Array<{ brain_id: string; source_id: string; pack_name: string; declined_count: number }>;
  last_shown_at?: string;
  global_shown_count?: number;
  global_month?: string;
  last_spawn_at?: string;
}

function readNagState(): NagFileShape {
  return JSON.parse(readFileSync(nagPath(), 'utf8')) as NagFileShape;
}

function makeStatus(overall: 'ok' | 'warn'): BackupStatus {
  const noRemote = overall === 'warn' ? 1 : 0;
  return {
    schema_version: BACKUP_STATUS_SCHEMA_VERSION,
    checked_at: new Date().toISOString(), // fresh — well inside the 30d window
    gbrain_version: '0.0.0-test',
    interval_days: 30,
    computed_by: 'cli',
    overall,
    totals: {
      assets: 2,
      no_remote: noRemote,
      unpushed: 0,
      failing: 0,
      recoverable_repos: 2 - noRemote,
      pages_at_risk: 0,
    },
    assets: [
      overall === 'warn'
        ? { kind: 'source_repo', id: 'wiki-example', state: 'no_remote', fix_argv: null }
        : { kind: 'source_repo', id: 'wiki-example', state: 'ok' },
      { kind: 'bootstrap_workspace', id: join(tmp, 'ws-example'), state: 'ok' },
    ],
  };
}

function makeWs(name: string): string {
  const ws = join(tmp, name);
  mkdirSync(ws, { recursive: true });
  return ws;
}

// ── 1. session-start digest note ('hook-note') ──────────────────────────────

describe('session-start backup note (hook-note channel)', () => {
  test('warn cache → digest carries "Backup check:", ONE hook-note impression; immediate re-run is dampened', async () => {
    saveBackupStatus(makeStatus('warn'));
    const ws = makeWs('ws');

    const out = collectStdout();
    expect(await runHook(['session-start'], { ...out.io, stdin: '', cwd: ws })).toBe(0);
    const text = out.get();
    expect(text).toContain('Backup check:');
    expect(text).toContain("aren't on any git remote");
    expect(text).toContain('wiki-example');

    // Record-after-write: exactly ONE impression landed in the nag file.
    const state = readNagState();
    expect(state.schema_version).toBe(BACKUP_NAG_SCHEMA_VERSION);
    const noteEntries = state.entries.filter((e) => e.pack_name === 'hook-note');
    expect(noteEntries).toHaveLength(1);
    expect(noteEntries[0]!.brain_id).toBe('host');
    expect(noteEntries[0]!.source_id).toBe('backup');
    expect(noteEntries[0]!.declined_count).toBe(1);
    expect(state.global_shown_count).toBe(1);
    expect(state.last_shown_at).toBeDefined();

    // A second session-start immediately after: the 24h cross-channel
    // dampener suppresses the note; the budget is not spent again.
    const out2 = collectStdout();
    expect(await runHook(['session-start'], { ...out2.io, stdin: '', cwd: ws })).toBe(0);
    expect(out2.get()).not.toContain('Backup check:');
    const state2 = readNagState();
    expect(state2.global_shown_count).toBe(1);
    expect(state2.entries.filter((e) => e.pack_name === 'hook-note')).toHaveLength(1);
  });

  test('ok cache → no backup note in the digest, no nag state written', async () => {
    saveBackupStatus(makeStatus('ok'));
    const ws = makeWs('ws-ok');
    const out = collectStdout();
    expect(await runHook(['session-start'], { ...out.io, stdin: '', cwd: ws })).toBe(0);
    expect(out.get()).not.toContain('Backup check:');
    expect(existsSync(nagPath())).toBe(false);
  });

  test('GBRAIN_BACKUP_CHECK=0 silences a warn cache (kill switch beats a stale warn)', async () => {
    process.env.GBRAIN_BACKUP_CHECK = '0';
    saveBackupStatus(makeStatus('warn'));
    const ws = makeWs('ws-off');
    const out = collectStdout();
    expect(await runHook(['session-start'], { ...out.io, stdin: '', cwd: ws })).toBe(0);
    expect(out.get()).not.toContain('Backup check:');
    expect(existsSync(nagPath())).toBe(false);
  });
});

// ── 2. user-prompt banner ('hook-banner') on the degraded no-serve path ─────

describe('user-prompt backup banner (hook-banner channel)', () => {
  test('warn cache + no serve → banner-only JSON payload with systemMessage AND additionalContext; hook-banner impression recorded', async () => {
    saveBackupStatus(makeStatus('warn'));
    const out = collectStdout();
    // No config at all → the main payload never writes (degraded rail); the
    // backup banner rides the banner-only emission path.
    expect(await runHook(['user-prompt'], { ...out.io, stdin: '{}' })).toBe(0);
    const payload = JSON.parse(out.get()) as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
      systemMessage?: string;
    };
    expect(payload.hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit');
    expect(payload.systemMessage).toContain('NOTICE:');
    expect(payload.systemMessage).toContain("aren't on any git remote");
    expect(payload.systemMessage).toContain('gbrain backup status');
    expect(payload.hookSpecificOutput?.additionalContext).toBe(payload.systemMessage!);

    const state = readNagState();
    const bannerEntries = state.entries.filter((e) => e.pack_name === 'hook-banner');
    expect(bannerEntries).toHaveLength(1);
    expect(bannerEntries[0]!.declined_count).toBe(1);
    expect(state.global_shown_count).toBe(1);
  });

  test('push-failure banner outranks the backup banner (single banner slot)', async () => {
    saveBackupStatus(makeStatus('warn'));
    // A failing push status for an EXISTING root (ghost entries are filtered).
    const root = makeWs('banner-brain');
    mkdirSync(join(home(), 'bootstrap'), { recursive: true });
    writeFileSync(
      pushStatusPathForRoot(root),
      JSON.stringify({ ts: new Date().toISOString(), ok: false, reason: 'refused_visibility: origin unverifiable', repoRoot: root }) + '\n',
      { mode: 0o600 },
    );

    const out = collectStdout();
    expect(await runHook(['user-prompt'], { ...out.io, stdin: JSON.stringify({ prompt: 'hi' }) })).toBe(0);
    const payload = JSON.parse(out.get()) as {
      hookSpecificOutput?: { additionalContext?: string };
      systemMessage?: string;
    };
    // The PUSH failure text won the slot…
    expect(payload.systemMessage).toContain('FAILING');
    expect(payload.systemMessage).toContain('NOT on GitHub');
    expect(payload.hookSpecificOutput?.additionalContext).toContain('FAILING');
    // …and the backup text is nowhere in the payload.
    expect(payload.systemMessage).not.toContain('knowledge assets');
    expect(payload.hookSpecificOutput?.additionalContext).not.toContain('knowledge assets');
    // The backup gate was never consulted/recorded — no hook-banner impression.
    if (existsSync(nagPath())) {
      expect(readNagState().entries.filter((e) => e.pack_name === 'hook-banner')).toHaveLength(0);
    }
  });
});

// ── 3. session-end detached backup-check spawn ──────────────────────────────

function sessionEndIo(ws: string, spy: () => void) {
  return {
    write: () => {},
    stdin: JSON.stringify({ session_id: 'sess-bkp', cwd: ws }),
    spawnPush: () => {},
    spawnBackupCheck: spy,
  };
}

describe('session-end backup-check spawn (24h debounce)', () => {
  test('stale-or-absent cache → spawns once; second session-end debounced via last_spawn_at', async () => {
    const ws = makeWs('ws-end');
    let spawns = 0;
    const io = sessionEndIo(ws, () => { spawns++; });

    // No cache file at all: absent counts as stale → spawn.
    expect(await runHook(['session-end'], io)).toBe(0);
    expect(spawns).toBe(1);
    // Debounce banked in the nag file (recorded BEFORE the spawn).
    expect(readNagState().last_spawn_at).toBeDefined();

    // Second session-end immediately after: still no cache (the spy wrote
    // nothing), but the 24h last_spawn_at debounce holds — no second spawn.
    expect(await runHook(['session-end'], io)).toBe(0);
    expect(spawns).toBe(1);
  });

  test('fresh ok cache → no spawn (nothing stale to recompute)', async () => {
    saveBackupStatus(makeStatus('ok'));
    const ws = makeWs('ws-end-ok');
    let spawns = 0;
    expect(await runHook(['session-end'], sessionEndIo(ws, () => { spawns++; }))).toBe(0);
    expect(spawns).toBe(0);
    // recordBackupSpawn never ran — no debounce state was written.
    expect(existsSync(nagPath())).toBe(false);
  });

  test('GBRAIN_BACKUP_CHECK=0 → no spawn even with an absent cache', async () => {
    process.env.GBRAIN_BACKUP_CHECK = '0';
    const ws = makeWs('ws-end-off');
    let spawns = 0;
    expect(await runHook(['session-end'], sessionEndIo(ws, () => { spawns++; }))).toBe(0);
    expect(spawns).toBe(0);
    expect(existsSync(nagPath())).toBe(false);
  });
});
