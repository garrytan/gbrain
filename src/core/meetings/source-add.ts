/** `sources add --kind meetings`: the record-mode choice and the registered config (trusted local CLI only). */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from '../spawn.ts';
import { OperationError } from '../ops/contract.ts';
import { SYNC_INTERVAL_MIN_FLOOR, type MeetingProviderName, type MeetingRecordMode, type MeetingTranscriptMode } from './types.ts';

/** The record mode and directory a new meetings source gets (D5, autoplan T2). */
export interface MeetingsRecordChoice { record: MeetingRecordMode; dir: string | null }

/** The Git checkout holding `dir` (or its nearest existing ancestor), or null when there is none. */
export function enclosingGitCheckout(dir: string): string | null {
  let probe = resolve(dir);
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return null;
    probe = parent;
  }
  const out = spawnSync('git', ['-C', probe, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return out.status === 0 && out.stdout.trim() ? out.stdout.trim() : null;
}

/**
 * Chosen once, at `sources add`, and stored: `git` when the source is given a directory inside a real Git checkout
 * (an ordinary directory never selects it), `database` otherwise. `--record git` without such a directory refuses
 * with the fix; it never falls back. Meeting pages are never nested into another source's checkout root, which
 * would import them twice, so Git recording needs its own directory.
 */
export function chooseMeetingsRecord(sourceId: string, requested: 'auto' | MeetingRecordMode, dir: string | undefined): MeetingsRecordChoice {
  if (requested === 'database') return { record: 'database', dir: null };
  const checkout = dir ? enclosingGitCheckout(dir) : null;
  if (checkout && dir) return { record: 'git', dir: resolve(dir) };
  if (requested === 'auto') return { record: 'database', dir: null };
  throw new OperationError('invalid_params',
    dir ? `--record git needs --dir inside a Git checkout; ${dir} is not in one.` : '--record git needs --dir: the Git checkout directory the meeting pages are committed to.',
    `Create or choose a directory inside a Git checkout that no other source uses (for example: git init ~/brain-meetings), then run gbrain sources add ${sourceId} --kind meetings --record git --dir <that directory>. Or leave out --record to keep the record in the database.`);
}

/** The `sources.config` a new meetings source is registered with. Only non-default tuning keys are written. */
export function meetingsSourceConfig(opts: NonNullable<AddSourceMeetings>, choice: MeetingsRecordChoice, federated: boolean | null | undefined, managed: boolean): Record<string, unknown> {
  return {
    kind: 'meetings',
    m_provider: opts.provider,
    m_record: choice.record,
    ...(choice.dir ? { m_dir: choice.dir } : {}),
    ...(opts.historyDays !== undefined ? { m_history_days: opts.historyDays } : {}),
    ...(opts.lookbackDays !== undefined ? { m_lookback_days: opts.lookbackDays } : {}),
    ...(opts.transcript === 'full' ? { m_transcript: 'full' } : {}),
    ...(opts.tokenEnv ? { m_token_env: opts.tokenEnv } : {}),
    ...(opts.private ? { m_visibility: 'private' } : {}),
    ...(opts.syncIntervalMin !== undefined ? { sync_interval_min: Math.max(SYNC_INTERVAL_MIN_FLOOR, opts.syncIntervalMin) } : {}),
    // D7: meeting notes join unqualified reads only when the user asks (--federated).
    federated: federated ?? false,
    // A managed Git-recorded source is strict: the door commits each page before its database row.
    ...(managed && choice.record === 'git' ? { canonical: 'git' } : {}),
  };
}

export interface AddSourceMeetingsOpts {
  provider: MeetingProviderName;
  record: 'auto' | MeetingRecordMode;
  transcript: MeetingTranscriptMode;
  historyDays?: number;
  lookbackDays?: number;
  syncIntervalMin?: number;
  tokenEnv?: string;
  dir?: string;
  private: boolean;
}
type AddSourceMeetings = AddSourceMeetingsOpts | undefined;
