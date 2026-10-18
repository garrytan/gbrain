/**
 * Adoption funnel (D8): a local, opt-in record of how far one install got.
 *
 * Off by default. Recording happens only while `~/.gbrain/funnel.jsonl` (under GBRAIN_HOME when set)
 * exists, and only `gbrain status --funnel --enable` creates it; with no file,
 * every recorder below is a single `existsSync` and writes nothing.
 * `gbrain status --funnel --delete` removes the file, which turns recording off.
 *
 * Each line is `{event, at, session}`: an event name, when it happened and
 * when the recording process started. Never content, queries, slugs, ids or
 * names. Nothing here touches the network; the user decides whether to share
 * `gbrain status --funnel --json`, which reports counts, never rates.
 *
 * Appends are one short line each (POSIX O_APPEND keeps concurrent writers
 * line-atomic); `save` and `recall` are written at most once per process, so
 * the file grows by sessions, not by calls. A recorder never throws.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { gbrainPath } from './config.ts';

export const FUNNEL_SCHEMA_VERSION = 1 as const;

export type FunnelEvent = 'enabled' | 'clean_install' | 'import' | 'save' | 'recall' | 'correction' | 'withdrawal';

export const FUNNEL_STAGES = [
  'clean_install',
  'import_useful_data',
  'recall_new_session',
  'correction_applied',
  'withdrawal_applied',
  'use_after_seven_days',
] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export interface FunnelLine { event: FunnelEvent; at: string; session: string }

export interface FunnelReport {
  schema_version: typeof FUNNEL_SCHEMA_VERSION;
  enabled: boolean;
  enabled_on: string | null;
  stages: Array<{ stage: FunnelStage; count: number; first_on: string | null }>;
}

const ONCE_PER_SESSION: ReadonlySet<FunnelEvent> = new Set(['save', 'recall']);
const WRITES: ReadonlySet<FunnelEvent> = new Set(['import', 'save', 'correction']);
const USE: ReadonlySet<FunnelEvent> = new Set(['import', 'save', 'recall', 'correction', 'withdrawal']);
const DAY_MS = 86_400_000;

const sessionStarted = new Date(performance.timeOrigin).toISOString();
const recordedThisSession = new Set<FunnelEvent>();
let pathOverride: string | null = null;

/** Test-only seam (the test-isolation lint forbids mutating GBRAIN_HOME). @internal */
export function __setFunnelPathForTests(path: string | null): void {
  pathOverride = path;
  recordedThisSession.clear();
}

export function funnelPath(): string {
  return pathOverride ?? gbrainPath('funnel.jsonl');
}

export function funnelEnabled(): boolean {
  return existsSync(funnelPath());
}

export function recordFunnelEvent(event: FunnelEvent): void {
  try {
    const path = funnelPath();
    if (!existsSync(path)) return;
    if (ONCE_PER_SESSION.has(event)) {
      if (recordedThisSession.has(event)) return;
      recordedThisSession.add(event);
    }
    const line: FunnelLine = { event, at: new Date().toISOString(), session: sessionStarted };
    appendFileSync(path, JSON.stringify(line) + '\n');
  } catch {
    /* the funnel is never fatal */
  }
}

/** `promise.then(funnelPassThrough('save'))`: record the event once the write committed, pass the result on. */
export function funnelPassThrough<T>(event: FunnelEvent): (result: T) => T {
  return result => { recordFunnelEvent(event); return result; };
}

/** A remember result: `superseded` is a correction, anything else that committed is a save. */
export function recordRememberOutcome(result: unknown): void {
  const status = (result as { status?: unknown } | null)?.status;
  if (status === 'superseded') recordFunnelEvent('correction');
  else if (status === 'inserted' || status === 'duplicate') recordFunnelEvent('save');
}

/** A read that returned at least one fact or page counts as a recall. */
export function recordRecallOutcome(result: unknown): void {
  const r = result as { facts?: unknown; results?: unknown } | unknown[] | null;
  const returned = Array.isArray(r) ? r.length
    : (Array.isArray(r?.facts) ? r.facts.length : 0) + (Array.isArray(r?.results) ? r.results.length : 0);
  if (returned > 0) recordFunnelEvent('recall');
}

/** Turn recording on. Idempotent: an existing file keeps its history. */
export function enableFunnel(): void {
  const path = funnelPath();
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  const line: FunnelLine = { event: 'enabled', at: new Date().toISOString(), session: sessionStarted };
  appendFileSync(path, JSON.stringify(line) + '\n', { mode: 0o600 });
}

/** Delete the record, which also turns recording off. Returns whether a file was removed. */
export function deleteFunnel(): boolean {
  const path = funnelPath();
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

function readLines(path: string): FunnelLine[] {
  const out: FunnelLine[] = [];
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    try {
      const l = JSON.parse(raw) as FunnelLine;
      if (typeof l.event === 'string' && typeof l.at === 'string' && typeof l.session === 'string' && !Number.isNaN(Date.parse(l.at))) out.push(l);
    } catch { /* a torn line is skipped */ }
  }
  return out;
}

const day = (iso: string) => iso.slice(0, 10);

/**
 * Counts per stage:
 * - clean_install: `gbrain init` runs that created a new brain;
 * - import_useful_data: imports that saved at least one page;
 * - recall_new_session: sessions whose read returned something, started after
 *   an earlier session saved, imported or corrected memory (correctness is
 *   Cat 41's `correct_then_recall`, not judged here);
 * - correction_applied / withdrawal_applied: committed corrections (`remember`
 *   superseding a fact, `takes_supersede`) and withdrawals (`forget`, `forget_fact`);
 * - use_after_seven_days: distinct days with any use, seven or more days after
 *   the clean install (or after recording was turned on, without one).
 */
export function readFunnelReport(): FunnelReport {
  const path = funnelPath();
  if (!existsSync(path)) {
    return { schema_version: FUNNEL_SCHEMA_VERSION, enabled: false, enabled_on: null, stages: FUNNEL_STAGES.map(stage => ({ stage, count: 0, first_on: null })) };
  }
  const lines = readLines(path).sort((a, b) => a.at.localeCompare(b.at));
  const of = (e: FunnelEvent) => lines.filter(l => l.event === e);
  const enabled = of('enabled')[0] ?? null;
  const install = of('clean_install')[0] ?? null;
  const writes = lines.filter(l => WRITES.has(l.event));
  const newSessionRecalls = of('recall').filter(r => writes.some(w => w.at < r.session));
  const anchor = install ?? enabled ?? lines[0] ?? null;
  const laterUse = new Map<string, string>();
  if (anchor) {
    const from = Date.parse(day(anchor.at)) + 7 * DAY_MS;
    for (const l of lines) if (USE.has(l.event) && Date.parse(day(l.at)) >= from && !laterUse.has(day(l.at))) laterUse.set(day(l.at), l.at);
  }
  const stage = (s: FunnelStage, rows: Array<{ at: string }>) => ({ stage: s, count: rows.length, first_on: rows[0] ? day(rows[0].at) : null });
  return {
    schema_version: FUNNEL_SCHEMA_VERSION,
    enabled: true,
    enabled_on: enabled ? day(enabled.at) : null,
    stages: [
      stage('clean_install', of('clean_install')),
      stage('import_useful_data', of('import')),
      stage('recall_new_session', newSessionRecalls),
      stage('correction_applied', of('correction')),
      stage('withdrawal_applied', of('withdrawal')),
      stage('use_after_seven_days', [...laterUse.values()].map(at => ({ at }))),
    ],
  };
}
