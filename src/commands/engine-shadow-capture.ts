/**
 * `gbrain engine shadow capture on|off|status|delete` (docs/guides/shadow-capture.md). Capture records every engine
 * call into owner-only files; this release has no replay yet, so a recording only grows (bounded) until it is deleted
 * or a purge removes it.
 */
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  captureDir, captureKilledByEnv, captureOffMarker, captureIsOn, readCaptureState, writePrivateJson, CAPTURE_STATE_VERSION,
} from '../shadow/capture-state.ts';
import { ReplayError } from '../shadow/replay-errors.ts';

export interface ShadowCaptureIo {
  out: (l: string) => void;
  err: (l: string) => void;
  now: () => Date;
  brain: { key: string; dir: string };
}

function captureStatus(cap: string) {
  const { purgeIfLogChanged, purgePending, readEpoch, epochDir, recordersDir } = require('../shadow/capture.ts') as typeof import('../shadow/capture.ts');
  const purged = purgeIfLogChanged(cap);
  const epoch = readEpoch(cap);
  const dir = epoch ? epochDir(cap, epoch.id) : null;
  const files = dir && existsSync(dir) ? readdirSync(dir) : [];
  return {
    schema_version: 1,
    on: captureIsOn(cap),
    killed_by_env: captureKilledByEnv(),
    off_marker: existsSync(captureOffMarker(cap)),
    epoch: epoch ? { id: epoch.id, state: epoch.state, started_at: epoch.started_at, ...(epoch.unverified ? { unverified: epoch.unverified } : {}) } : null,
    invalidated_now: purged,
    purge_cleanup_pending: purgePending(cap),
    recording_processes: existsSync(recordersDir(cap)) ? readdirSync(recordersDir(cap)).filter(f => f.endsWith('.json')).length : 0,
    segment_bytes: files.filter(f => f.endsWith('.jsonl')).reduce((n, f) => n + statSync(join(dir!, f)).size, 0),
    directory: cap,
  };
}

export async function runShadowCaptureCommand(rest: string[], io: ShadowCaptureIo): Promise<number> {
  const cap = captureDir(io.brain.dir);
  const [action, ...flags] = rest;
  if (action === 'on') {
    if (!flags.includes('--yes')) {
      io.out(`Capture records every call this brain makes to its storage engine (reads and writes, with their arguments) into\n${cap}/ (owner-only files). Nothing leaves this machine. This release only records: there is no replay yet.\nRestart any long-running serve or MCP process afterwards: only engines opened after capture is on record.\nRun again with --yes to turn it on.`);
      return 1;
    }
    const { purgeIfLogChanged, purgePending, readEpoch, startEpoch } = await import('../shadow/capture.ts');
    purgeIfLogChanged(cap); // a purge while capture was off, or an unfinished purge, deletes the old recordings first
    if (purgePending(cap)) throw new ReplayError('shadow_replay_purged', `a purge could not delete every recording under ${cap} yet; run capture on again`);
    const wasOn = readCaptureState(cap)?.enabled === true && !existsSync(captureOffMarker(cap));
    // Off then on starts a fresh recording, before capture reads as on: calls made while it was off are not in any
    // recording, so the old one cannot be continued as if it were complete.
    if (!wasOn || readEpoch(cap)?.state !== 'recording') startEpoch(cap, undefined, io.now());
    if (!wasOn) writePrivateJson(join(cap, 'state.json'), { version: CAPTURE_STATE_VERSION, enabled: true, turned_on_at: io.now().toISOString() });
    rmSync(captureOffMarker(cap), { force: true });
    io.out(captureKilledByEnv() ? 'Capture is on, but GBRAIN_SHADOW_CAPTURE=off in this environment keeps it off for processes started with it.' : 'Capture is on. Recording starts with the next gbrain process that opens this brain.');
    return 0;
  }
  if (action === 'off') {
    const prev = readCaptureState(cap);
    writePrivateJson(join(cap, 'state.json'), { version: CAPTURE_STATE_VERSION, enabled: false, turned_on_at: prev?.turned_on_at ?? io.now().toISOString(), turned_off_at: io.now().toISOString() });
    writeFileSync(captureOffMarker(cap), `${io.now().toISOString()}\n`, { mode: 0o600 });
    io.out(`Capture is off. Every recording process stops at its next flush. Nothing was deleted; recordings stay in ${cap}. To delete them: gbrain engine shadow capture delete --yes`);
    return 0;
  }
  if (action === 'status') {
    const s = captureStatus(cap);
    if (flags.includes('--json')) io.out(JSON.stringify(s, null, 2));
    else io.out(`capture: ${s.on ? 'on' : 'off'}${s.killed_by_env ? ' (GBRAIN_SHADOW_CAPTURE=off)' : ''}\nepoch: ${s.epoch ? `${s.epoch.id} ${s.epoch.state}` : 'none'}\nrecording processes: ${s.recording_processes}\nrecorded bytes: ${s.segment_bytes}\ndirectory: ${s.directory}`);
    return 0;
  }
  if (action === 'delete') {
    if (!flags.includes('--yes')) { io.out(`This deletes every recording under ${cap}. Run again with --yes.`); return 1; }
    const { deleteReplayState } = await import('../shadow/capture-lock.ts');
    const gone = deleteReplayState(io.brain.dir, { whole: false });
    io.out(gone.length ? `Deleted:\n${gone.join('\n')}` : 'Nothing to delete.');
    return 0;
  }
  throw new ReplayError('shadow_capture_off', `unknown capture action ${action ?? '(none)'}; use on, off, status or delete`);
}
