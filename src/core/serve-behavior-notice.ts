/**
 * #6543 C2: `gbrain serve` writes the behavior changes an upgrade turned on to its own log (stderr) once per process,
 * so an operator who only watches the serve log sees them too. Read-only toward delivery: the brain baseline is read
 * with `persist: false`, and the CLI/stdio markers and the HTTP `config` row are never claimed, so the next CLI command
 * and every MCP client still get their own notice. The serve log keeps its own marker under
 * GBRAIN_HOME/notices/behavior-changes/ (`<notice id>.<brain key>.serve_log.shown`) so a restart of the same release
 * does not repeat it. Never throws.
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from './engine.ts';
import { gbrainPath, type GBrainConfig } from './config.ts';
import {
  BEHAVIOR_NOTICE_CODE, BEHAVIOR_NOTICE_ID, behaviorBrainKey, behaviorChangesNotice, brainBaseline, chainDisclosure, compareReleases, currentBrainId,
} from './behavior-change-notice.ts';

let loggedThisProcess = false;

export async function logServeBehaviorNotice(
  engine: BrainEngine,
  cfg: GBrainConfig | null,
  opts: { write?: (line: string) => void; now?: number } = {},
): Promise<boolean> {
  if (loggedThisProcess) return false;
  loggedThisProcess = true;
  try {
    const brainKey = behaviorBrainKey(cfg, await currentBrainId());
    const dir = gbrainPath('notices', 'behavior-changes');
    const prefix = `${BEHAVIOR_NOTICE_CODE}@`, suffix = `.${brainKey}.serve_log.shown`;
    let after = await brainBaseline(engine, brainKey, { persist: false, now: opts.now });
    try {
      for (const name of readdirSync(dir)) {
        if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
        const release = name.slice(prefix.length, -suffix.length);
        if (/^\d+(\.\d+)*$/.test(release) && compareReleases(release, after) > 0) after = release;
      }
    } catch { /* no markers yet */ }
    const notice = behaviorChangesNotice(await chainDisclosure(engine, cfg), { after });
    if (!notice) return false;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${BEHAVIOR_NOTICE_ID}${suffix}`), `${new Date(opts.now ?? Date.now()).toISOString()}\n`, { mode: 0o600, flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'EEXIST') return false;
    }
    (opts.write ?? (line => process.stderr.write(line)))(`[gbrain serve] notice=${notice.code}: ${notice.why}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Test seam: forget this process's look. */
export function __resetServeBehaviorNoticeForTests(): void {
  loggedThisProcess = false;
}
