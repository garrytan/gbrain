/**
 * Cursor state for the Apple source kind: `.apple-source.json` in the managed
 * dir (0600). A corrupt file is quarantined to `.corrupt`, never silently
 * treated as a fresh install. On managed brains the same shape is carried in
 * the connector checkpoint instead (see apple-source.ts).
 */
import { chmodSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import { atomicWriteFileSync, mkdirPrivate } from '../atomic-write.ts';
import { normalizeMailRecovery } from './mail-recovery.ts';
import type { AppleLoopGraceHold, AppleLoopMessage, AppleMailLoopsState, AppleSourceState } from './types.ts';

export function appleStateFile(dir: string): string {
  return join(dir, '.apple-source.json');
}

export function emptyAppleState(): AppleSourceState {
  return {
    version: 1,
    calendar: { hashes: {} },
    contacts: { hashes: {} },
    mail: { hashes: {} },
    item_holds: undefined,
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function hashMap(v: unknown): Record<string, string> {
  if (!isRecord(v)) return {};
  return Object.fromEntries(Object.entries(v).filter(([, h]) => typeof h === 'string')) as Record<string, string>;
}

function loopsState(v: unknown): AppleMailLoopsState | undefined {
  if (!isRecord(v)) return undefined;
  const holds: Record<string, AppleLoopGraceHold> = {};
  if (isRecord(v.loop_grace_holds)) {
    for (const [id, h] of Object.entries(v.loop_grace_holds)) {
      if (isRecord(h) && typeof h.due_ms === 'number') holds[id] = h as unknown as AppleLoopGraceHold;
    }
  }
  const threads: Record<string, AppleLoopMessage[]> = {};
  if (isRecord(v.threads)) {
    for (const [id, list] of Object.entries(v.threads)) {
      if (Array.isArray(list)) threads[id] = list.filter((m): m is AppleLoopMessage => isRecord(m) && typeof m.id === 'string' && typeof m.ms === 'number' && typeof m.from === 'string');
    }
  }
  return {
    ...(Object.keys(threads).length > 0 ? { threads } : {}),
    ...(typeof v.digest === 'string' ? { digest: v.digest } : {}),
    ...(v.reread === true ? { reread: true } : {}),
    ...(typeof v.complete_at === 'string' ? { complete_at: v.complete_at } : {}),
    ...(typeof v.extract_seen === 'boolean' ? { extract_seen: v.extract_seen } : {}),
    ...(Array.isArray(v.pending_threads) ? { pending_threads: v.pending_threads.filter((x): x is string => typeof x === 'string') } : {}),
    ...(v.identity_reconcile === true ? { identity_reconcile: true } : {}),
    ...(v.coverage_gap === true ? { coverage_gap: true } : {}),
    ...(Object.keys(holds).length > 0 ? { loop_grace_holds: holds } : {}),
  };
}

/** Merge a parsed (possibly partial or foreign-shaped) object over the empty state. */
export function normalizeAppleState(parsed: unknown): AppleSourceState {
  const empty = emptyAppleState();
  if (!isRecord(parsed)) return empty;
  const cal = isRecord(parsed.calendar) ? parsed.calendar : {};
  const con = isRecord(parsed.contacts) ? parsed.contacts : {};
  const mail = isRecord(parsed.mail) ? parsed.mail : {};
  const window = isRecord(cal.window) && typeof cal.window.from === 'string' && typeof cal.window.to === 'string'
    ? { from: cal.window.from, to: cal.window.to } : undefined;
  return {
    version: 1,
    calendar: { ...(window ? { window } : {}), hashes: hashMap(cal.hashes) },
    contacts: { hashes: hashMap(con.hashes) },
    mail: {
      ...(typeof mail.since === 'string' ? { since: mail.since } : {}),
      hashes: hashMap(mail.hashes),
      ...(typeof mail.newest === 'string' ? { newest: mail.newest } : {}),
      ...(typeof mail.resume_from === 'string' ? { resume_from: mail.resume_from } : {}),
      ...(typeof mail.resume_id === 'string' ? { resume_id: mail.resume_id } : {}),
      ...(isRecord(mail.routing) && typeof mail.routing.v === 'number' && Number.isFinite(mail.routing.v) && typeof mail.routing.fp === 'string' && mail.routing.fp.length > 0
        ? { routing: { v: mail.routing.v, fp: mail.routing.fp, ...(mail.routing.legacy === true ? { legacy: true as const } : {}) } } : {}),
      ...(isRecord(mail.walk) && typeof mail.walk.key === 'string' && typeof mail.walk.since === 'string'
        && ['full', 'reread', 'incremental'].includes(String(mail.walk.purpose)) && Array.isArray(mail.walk.seen)
        ? { walk: { key: mail.walk.key, since: mail.walk.since, purpose: mail.walk.purpose as 'full' | 'reread' | 'incremental',
          seen: mail.walk.seen.filter((x): x is string => typeof x === 'string'),
          ...(typeof mail.walk.recover === 'string' ? { recover: mail.walk.recover } : {}),
          ...(Array.isArray(mail.walk.landed) ? { landed: mail.walk.landed.filter((x): x is string => typeof x === 'string') } : {}) } } : {}),
    },
    item_holds: isRecord(parsed.item_holds) ? parsed.item_holds : undefined,
    ...(loopsState(parsed.mail_loops) ? { mail_loops: loopsState(parsed.mail_loops)! } : {}),
    ...(normalizeMailRecovery(parsed.mail_recovery) ? { mail_recovery: normalizeMailRecovery(parsed.mail_recovery)! } : {}),
    ...(typeof parsed.last_full_at === 'string' ? { last_full_at: parsed.last_full_at } : {}),
    ...(isRecord(parsed.last_probe) ? { last_probe: parsed.last_probe as AppleSourceState['last_probe'] } : {}),
  };
}

export function readAppleState(dir: string): AppleSourceState {
  const file = appleStateFile(dir);
  if (!existsSync(file)) return emptyAppleState();
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    if (!isRecord(parsed)) throw new Error('state file is not a JSON object');
    return normalizeAppleState(parsed);
  } catch (e) {
    // A CORRUPT existing state file is not a fresh install: quarantine it for
    // forensics (private first, so its contents are never world-readable) and
    // say so loudly. Cursors reset; the next sync re-hashes and resumes.
    const quarantine = `${file}.corrupt`;
    let failure: { step: 'chmod' | 'rename'; path: string; error: unknown } | null = null;
    try {
      chmodSync(file, 0o600);
    } catch (error) {
      failure = { step: 'chmod', path: file, error };
    }
    try {
      renameSync(file, quarantine);
      if (failure) failure.path = quarantine;
    } catch (error) {
      failure ??= { step: 'rename', path: file, error };
    }
    process.stderr.write(
      `[apple] state file ${file} was corrupt (${e instanceof Error ? e.message : String(e)}); ` +
        `quarantined to .corrupt — hashes reset, the next sync re-evaluates every item.\n`,
    );
    if (failure) {
      process.stderr.write(
        `[apple] could not secure the quarantined state file ${failure.path}: ${failure.step} failed ` +
          `(${failure.error instanceof Error ? failure.error.message : String(failure.error)}). ` +
          `It may be readable by other local users; run chmod 600 ${failure.path} or delete it.\n`,
      );
    }
    return emptyAppleState();
  }
}

export function writeAppleState(dir: string, state: AppleSourceState): void {
  mkdirPrivate(dir);
  // Atomic (tmp+fsync+rename); 0600 is reasserted on every write so a legacy
  // looser file tightens.
  atomicWriteFileSync(appleStateFile(dir), JSON.stringify(state, null, 2), { mode: 0o600 });
}
