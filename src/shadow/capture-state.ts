/**
 * Shadow replay capture state (docs/guides/shadow-replay.md): the on/off flag, the kill switch and the paths under
 * `<configDir()>/shadow/<brain>/capture/`. The engine factory imports only this module, so a brain that never turned
 * capture on loads none of the recorder.
 *
 *   capture/state.json     on/off as `engine shadow capture on|off` set it (the config flag)
 *   capture/off            the kill switch marker `capture off` writes; every recorder checks it before each flush
 *   capture/epoch.json     the current epoch: its id, state and the purge log baseline it started from
 *   capture/epoch-<id>/    one segment file per recording process, plus a heartbeat file per process
 *   capture/bases/<id>/    the copies seeded when epoch <id> began (Rust store, PGLite brain, manifest.json)
 *   capture/key            the per-brain key for the keyed hashes in a replay summary
 *
 * `GBRAIN_SHADOW_CAPTURE=off` (also `0`, `false`, `no`) turns capture off for every process started with it.
 * Off never deletes anything; `engine shadow capture delete --yes` does.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineConfig } from '../core/types.ts';
import { shadowBrainKey, shadowDirFor, shadowRoot } from './state.ts';

export const CAPTURE_STATE_VERSION = 1;

export interface CaptureState {
  version: number;
  enabled: boolean;
  turned_on_at: string;
  turned_off_at?: string;
}

export const captureDir = (shadowDir: string) => join(shadowDir, 'capture');
export const captureStatePath = (cap: string) => join(cap, 'state.json');
export const captureOffMarker = (cap: string) => join(cap, 'off');

/** True when the environment turns capture off for this process. */
export function captureKilledByEnv(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.GBRAIN_SHADOW_CAPTURE?.trim().toLowerCase();
  return v === 'off' || v === '0' || v === 'false' || v === 'no';
}

export function readCaptureState(cap: string): CaptureState | null {
  const path = captureStatePath(cap);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as CaptureState;
    return parsed?.version === CAPTURE_STATE_VERSION ? parsed : null;
  } catch { // silent-read-ok: an unreadable state file reads as capture off, so nothing is recorded (the private side)
    return null;
  }
}

/** Writes a small private file atomically (temp file plus rename), mode 0600, directory 0700. */
export function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

/** On means: the flag says on, no off marker, and the environment does not turn it off. */
export function captureIsOn(cap: string, env: Record<string, string | undefined> = process.env): boolean {
  if (captureKilledByEnv(env) || existsSync(captureOffMarker(cap))) return false;
  return readCaptureState(cap)?.enabled === true;
}

/**
 * The engine factory's check: the capture directory when capture is on for the brain `config` opens, else null.
 * Off costs one existsSync on the shadow root for a home that never used shadow mode. The shadow child and the
 * replay child never record.
 */
export function captureStateFor(config: EngineConfig): { shadowDir: string; cap: string } | null {
  if (process.env.GBRAIN_SHADOW_CHILD === '1' || captureKilledByEnv()) return null;
  if (!existsSync(shadowRoot())) return null;
  const key = shadowBrainKey(config);
  if (!key) return null;
  const shadowDir = shadowDirFor(key);
  const cap = captureDir(shadowDir);
  return existsSync(captureStatePath(cap)) && captureIsOn(cap) ? { shadowDir, cap } : null;
}

/**
 * The capture directory of the brain `config` opens when it holds an epoch, whatever the
 * on/off state and the environment: purges in every process must delete recordings and copies (capture.ts watchPurges).
 */
export function capturePurgeWatchFor(config: EngineConfig): string | null {
  if (process.env.GBRAIN_SHADOW_CHILD === '1' || !existsSync(shadowRoot())) return null;
  const key = shadowBrainKey(config);
  if (!key) return null;
  const cap = captureDir(shadowDirFor(key));
  return existsSync(join(cap, 'epoch.json')) ? cap : null;
}
