/** Setup receipt survives a swap even if config.json is lost before relaunch. */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gbrainPath } from './config.ts';

const path = () => gbrainPath('autopilot-upgrade-pending');

export function pendingUpgradeExists(): boolean {
  return existsSync(path());
}

export function pendingUpgradeTarget(): string | null {
  try {
    const value = JSON.parse(readFileSync(path(), 'utf8')) as { targetVersion?: unknown };
    return typeof value?.targetVersion === 'string' ? value.targetVersion : null;
  } catch {
    return null;
  }
}

export function beginPendingUpgrade(targetVersion: string): void {
  const file = path();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ targetVersion }), { mode: 0o600 });
}

export function clearPendingUpgrade(): void {
  try { unlinkSync(path()); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}
