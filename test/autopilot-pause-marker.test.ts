/**
 * PR-A / A3: the cooperative pause marker that lets `gbrain migrate --to <engine>`
 * quiesce a running daemon for the duration of a cross-engine copy.
 *
 * The incident this closes: `migrate-engine.ts` contained ZERO references to
 * autopilot, so an engine migration rewrote `config.json` while a live daemon
 * kept writing into the SOURCE engine. Those writes were lost, and the daemon
 * then died on a stale config object with no operator-visible link between the
 * two events.
 *
 * EVERY test here runs against a scratch GBRAIN_HOME. The paths resolve through
 * gbrainHomePath() at call time, so without the override this file would write
 * and — worse — unconditionally DELETE markers in the developer's real
 * ~/.gbrain, un-quiescing a live migration on the machine running the tests.
 */
import { describe, test, expect } from 'bun:test';
import { existsSync, writeFileSync, unlinkSync, mkdirSync, readFileSync, utimesSync } from 'fs';
import { spawnSync } from 'child_process';
import { dirname } from 'path';
import { withEnv, emptyHome } from './helpers/with-env.ts';
import {
  autopilotPausedMarkerPath,
  autopilotDisabledMarkerPath,
  autopilotLockPath,
} from '../src/core/autopilot-paths.ts';
import { quiesceAutopilot, MIGRATE_PAUSE_MARKER_PREFIX } from '../src/commands/migrate-engine.ts';

/** Scratch home + no grace sleep: the default 35s would stall the suite. */
function quiesceEnv(extra: Record<string, string | undefined> = {}) {
  return { GBRAIN_HOME: emptyHome(), GBRAIN_MIGRATE_QUIESCE_SECONDS: '0', ...extra };
}

function touchLock(mtime?: Date) {
  const lock = autopilotLockPath();
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, `${process.pid}\n`);
  if (mtime) utimesSync(lock, mtime, mtime);
}

describe('autopilot pause marker (A3 quiesce)', () => {
  test('resolves inside the gbrain home, not raw $HOME', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome() }, () => {
      // The daemon writes its lock through gbrainHomePath(); a marker resolved
      // from raw process.env.HOME would land in a different directory under
      // GBRAIN_HOME and the pause would silently never be observed.
      const p = autopilotPausedMarkerPath();
      expect(p.endsWith('autopilot-paused')).toBe(true);
      expect(p).toContain(process.env.GBRAIN_HOME!);
    });
  });

  test('pause and disabled markers are distinct files', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome() }, () => {
      // They mean different things: paused = "a migration is running, hold";
      // disabled = "your repo is gone, I stopped myself". Collapsing them would
      // make a migration look like a fault in `--status`.
      expect(autopilotPausedMarkerPath()).not.toBe(autopilotDisabledMarkerPath());
    });
  });

  test('presence is the whole protocol — create then remove', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome() }, () => {
      const p = autopilotPausedMarkerPath();
      mkdirSync(dirname(p), { recursive: true });
      expect(existsSync(p)).toBe(false);
      writeFileSync(p, `${MIGRATE_PAUSE_MARKER_PREFIX} at 2026-08-11T00:00:00.000Z\n`);
      expect(existsSync(p)).toBe(true);
      unlinkSync(p);
      expect(existsSync(p)).toBe(false);
    });
  });

  test('marker content is human-readable, so an orphan explains itself', () => {
    // If a migration crashes hard the marker survives. Whoever finds it must be
    // able to tell what wrote it and when, rather than guessing why autopilot
    // stopped doing work.
    const body = `${MIGRATE_PAUSE_MARKER_PREFIX} at ${new Date(0).toISOString()}\n`;
    expect(body).toContain('gbrain migrate');
    expect(body).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

describe('quiesceAutopilot (migrate-side of the protocol)', () => {
  test('no daemon lock → marker STILL written (red-team: the no-lock window is routine)', async () => {
    await withEnv(quiesceEnv(), async () => {
      // The daemon unlinks its lock on every clean exit and the supervisor
      // relaunches it within a minute; cron installs have no lock between
      // runs. A migrate that skipped the marker in such a window would let a
      // daemon that STARTS mid-copy write into the source engine — all lost
      // at the flip. So the marker is unconditional; only the grace sleep
      // keys on a live heartbeat.
      const resume = await quiesceAutopilot();
      expect(resume).not.toBeNull();
      expect(existsSync(autopilotPausedMarkerPath())).toBe(true);
      resume!();
      expect(existsSync(autopilotPausedMarkerPath())).toBe(false);
    });
  });

  test('live lock → marker written with owned prefix + pid; resume removes it, twice-safe', async () => {
    await withEnv(quiesceEnv(), async () => {
      touchLock();
      const resume = await quiesceAutopilot();
      expect(resume).not.toBeNull();
      const marker = autopilotPausedMarkerPath();
      expect(existsSync(marker)).toBe(true);
      const body = readFileSync(marker, 'utf8');
      expect(body.startsWith(MIGRATE_PAUSE_MARKER_PREFIX)).toBe(true);
      expect(body).toContain(`(pid ${process.pid})`);
      resume!();
      expect(existsSync(marker)).toBe(false);
      resume!(); // idempotent — the finally + cleanup backstop may both fire
      expect(existsSync(marker)).toBe(false);
    });
  });

  test('foreign marker → null (caller must ABORT), and the marker is untouched', async () => {
    await withEnv(quiesceEnv(), async () => {
      touchLock();
      const marker = autopilotPausedMarkerPath();
      mkdirSync(dirname(marker), { recursive: true });
      writeFileSync(marker, 'paused by an operator for maintenance\n');
      // Codex catch: the old contract returned a no-op resume and let the
      // migration proceed UNOWNED — when the real owner finished, its cleanup
      // un-paused the daemon in the middle of our copy window. Null forces
      // the caller to refuse to run instead.
      expect(await quiesceAutopilot()).toBeNull();
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, 'utf8')).toContain('operator');
    });
  });

  test('adopts a DEAD migrate\'s orphan: the marker does not become permanent', async () => {
    await withEnv(quiesceEnv(), async () => {
      touchLock();
      const marker = autopilotPausedMarkerPath();
      mkdirSync(dirname(marker), { recursive: true });
      // A prior migrate wrote this and died before its finally could run.
      // Refusing to adopt would park the daemon forever: every retry would
      // defer to the "foreign" marker, and nothing else ever deletes it.
      // A real reaped pid, so the liveness probe sees ESRCH.
      const dead = spawnSync('true');
      writeFileSync(marker, `${MIGRATE_PAUSE_MARKER_PREFIX} (pid ${dead.pid}) at ${new Date(0).toISOString()}\n`);
      const resume = await quiesceAutopilot();
      expect(resume).not.toBeNull();
      expect(existsSync(marker)).toBe(true); // still paused during the copy
      // Ownership is TAKEN, not shared: the body now carries OUR pid, so a
      // third migrate reads a live holder and aborts instead of also adopting
      // (double-adoption would un-pause the daemon mid-copy).
      expect(readFileSync(marker, 'utf8')).toContain(`(pid ${process.pid})`);
      resume!();
      expect(existsSync(marker)).toBe(false); // and released after
    });
  });

  test('does NOT adopt a LIVE migrate\'s marker — resume must not un-pause a concurrent copy', async () => {
    await withEnv(quiesceEnv(), async () => {
      touchLock();
      const marker = autopilotPausedMarkerPath();
      mkdirSync(dirname(marker), { recursive: true });
      // Same prefix as ours, but the holder pid is alive (this very process).
      // Red-team catch: prefix-only adoption let migrate B adopt migrate A's
      // live marker; B's finally then deleted it mid-copy and the daemon
      // resumed inside A's copy window — the exact incident this closes.
      writeFileSync(marker, `${MIGRATE_PAUSE_MARKER_PREFIX} (pid ${process.pid}) at ${new Date(0).toISOString()}\n`);
      expect(await quiesceAutopilot()).toBeNull();
      expect(existsSync(marker)).toBe(true); // untouched — the live holder owns it
    });
  });

  test('a prefix-matching marker WITHOUT a pid is treated as foreign, not adopted', async () => {
    await withEnv(quiesceEnv(), async () => {
      touchLock();
      const marker = autopilotPausedMarkerPath();
      mkdirSync(dirname(marker), { recursive: true });
      // No ownership handle → cannot prove the holder is dead → defer.
      writeFileSync(marker, `${MIGRATE_PAUSE_MARKER_PREFIX} at ${new Date(0).toISOString()}\n`);
      expect(await quiesceAutopilot()).toBeNull();
      expect(existsSync(marker)).toBe(true);
    });
  });

  test('garbage grace env falls back with a warning instead of silently disabling', async () => {
    await withEnv(quiesceEnv({ GBRAIN_MIGRATE_QUIESCE_SECONDS: 'garbage' }), async () => {
      // Stale lock (aged past the heartbeat window) so no code path can sleep:
      // the marker still gets written — quiesce keys on lock EXISTENCE — but
      // the grace is skipped, letting this assert the NaN warning without a
      // 35s stall. Pre-fix, Number('garbage') = NaN made `NaN > 0` false and
      // the grace vanished with no signal at all.
      touchLock(new Date(Date.now() - 3600_000));
      const warns: string[] = [];
      const origWarn = console.warn;
      console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); };
      try {
        const resume = await quiesceAutopilot();
        expect(resume).not.toBeNull();
        expect(existsSync(autopilotPausedMarkerPath())).toBe(true);
        resume!();
      } finally {
        console.warn = origWarn;
      }
      expect(warns.join('\n')).toContain('GBRAIN_MIGRATE_QUIESCE_SECONDS');
    });
  });
});

describe('release is ownership-conditional', () => {
  test('resume does NOT delete a marker that changed hands', async () => {
    await withEnv(quiesceEnv(), async () => {
      // Round-4 review catch: an adoption race resolved against us means the
      // marker at this PATH now belongs to another migrate. A path-only
      // unlink would un-pause the daemon in the middle of the new owner's
      // copy window; release must compare content first.
      const resume = await quiesceAutopilot();
      expect(resume).not.toBeNull();
      const marker = autopilotPausedMarkerPath();
      writeFileSync(marker, `${MIGRATE_PAUSE_MARKER_PREFIX} (pid 999999) at ${new Date(0).toISOString()}\n`);
      resume!();
      expect(existsSync(marker)).toBe(true); // still there — not ours anymore
    });
  });
});

describe('pause marker fences minion job pickup', () => {
  test('worker claim loop checks the marker BEFORE queue.claim (static wiring guard)', async () => {
    // Third review round: the marker parked the autopilot dispatch loop but a
    // minion worker kept CLAIMING queued jobs mid-copy — writes the migration
    // silently lost at the flip. No in-process worker harness exists, so pin
    // the wiring statically (the autopilot-supervisor-wiring pattern): the
    // gate must sit in the poll loop ahead of the claim call.
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const src = readFileSync(resolve(import.meta.dir, '../src/core/minions/worker.ts'), 'utf8');
    const gateIdx = src.indexOf('existsSync(autopilotPausedMarkerPath())');
    const claimIdx = src.indexOf('this.queue.claim(');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(claimIdx).toBeGreaterThan(gateIdx);
    // And the POST-claim re-check (round 4): a claim can commit after
    // migrate's drain probe; a job claimed into that window is released
    // back un-run rather than executed.
    const postGateIdx = src.indexOf('existsSync(autopilotPausedMarkerPath())', claimIdx);
    expect(postGateIdx).toBeGreaterThan(claimIdx);
    expect(src.indexOf('releaseClaimForPause(', postGateIdx)).toBeGreaterThan(postGateIdx);
  });
});
