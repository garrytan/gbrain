/**
 * pi crashed-session sweep: which session files a pi session-start hands back
 * to session-end (core/transcripts/pi-sweep.ts).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findPiSweepCandidates, markPiSweepAttempted, sweepPiSessions, PI_SWEEP_IDLE_MS, PI_SWEEP_MAX_AGE_MS } from '../src/core/transcripts/pi-sweep.ts';
import { withEnv } from './helpers/with-env.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'gb-pi-sweep-')); dirs.push(root);
  const sessions = join(root, 'sessions'); const corpus = join(root, 'corpus');
  mkdirSync(join(sessions, '--home-user-project--'), { recursive: true }); mkdirSync(corpus, { recursive: true });
  return { root, sessions, corpus, state: join(root, 'home', 'hooks', 'pi-sweep.json') };
}
const NOW = Date.parse('2026-10-08T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
function session(dir: string, id: string, ageMs: number): string {
  const p = join(dir, '--home-user-project--', `2026-10-08T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(p, JSON.stringify({ type: 'session', version: 3, id, timestamp: 't', cwd: '/home/user/project' }) + '\n');
  const t = (NOW - ageMs) / 1000; utimesSync(p, t, t);
  return p;
}
function corpusFile(dir: string, id: string, ageMs: number): void {
  const p = join(dir, `${id}.txt`); writeFileSync(p, 'x');
  const t = (NOW - ageMs) / 1000; utimesSync(p, t, t);
}

describe('findPiSweepCandidates', () => {
  test('an idle session with no corpus file is a candidate', () => {
    const e = setup(); const p = session(e.sessions, 'killed', 2 * HOUR);
    expect(findPiSweepCandidates({ sessionsDir: e.sessions, corpusDir: e.corpus, stateFile: e.state, now: NOW }))
      .toEqual([{ sessionId: 'killed', path: p, mtimeMs: NOW - 2 * HOUR }]);
  });
  test('a session written to recently (live in another terminal) is skipped', () => {
    const e = setup(); session(e.sessions, 'live', PI_SWEEP_IDLE_MS - 60_000);
    expect(findPiSweepCandidates({ sessionsDir: e.sessions, corpusDir: e.corpus, stateFile: e.state, now: NOW })).toEqual([]);
  });
  test('a session older than the max age is skipped (inside corpus retention)', () => {
    const e = setup(); session(e.sessions, 'old', PI_SWEEP_MAX_AGE_MS + HOUR);
    expect(findPiSweepCandidates({ sessionsDir: e.sessions, corpusDir: e.corpus, stateFile: e.state, now: NOW })).toEqual([]);
  });
  test('the session now starting is never swept', () => {
    const e = setup(); session(e.sessions, 'me', 2 * HOUR);
    expect(findPiSweepCandidates({ sessionsDir: e.sessions, corpusDir: e.corpus, stateFile: e.state, now: NOW, currentSessionId: 'me' })).toEqual([]);
  });
  test('a captured session is skipped; one resumed after its capture is swept again', () => {
    const e = setup();
    session(e.sessions, 'done', 3 * HOUR); corpusFile(e.corpus, 'done', 2 * HOUR);
    session(e.sessions, 'resumed', 2 * HOUR); corpusFile(e.corpus, 'resumed', 5 * HOUR);
    expect(findPiSweepCandidates({ sessionsDir: e.sessions, corpusDir: e.corpus, stateFile: e.state, now: NOW }).map((c) => c.sessionId)).toEqual(['resumed']);
  });
  test('newest first, at most three per start', () => {
    const e = setup();
    for (let i = 1; i <= 5; i++) session(e.sessions, `s${i}`, i * HOUR);
    expect(findPiSweepCandidates({ sessionsDir: e.sessions, corpusDir: e.corpus, stateFile: e.state, now: NOW }).map((c) => c.sessionId)).toEqual(['s1', 's2', 's3']);
  });
  test('an attempted file version is not retried; a newer write to it is', () => {
    const e = setup(); const p = session(e.sessions, 'flaky', 2 * HOUR);
    const first = findPiSweepCandidates({ sessionsDir: e.sessions, corpusDir: e.corpus, stateFile: e.state, now: NOW });
    markPiSweepAttempted(e.state, first);
    expect(findPiSweepCandidates({ sessionsDir: e.sessions, corpusDir: e.corpus, stateFile: e.state, now: NOW })).toEqual([]);
    const t = (NOW - HOUR) / 1000; utimesSync(p, t, t);
    expect(findPiSweepCandidates({ sessionsDir: e.sessions, corpusDir: e.corpus, stateFile: e.state, now: NOW }).map((c) => c.sessionId)).toEqual(['flaky']);
  });
  test('non-session JSONL and symlinks are ignored', () => {
    const e = setup();
    const notes = join(e.sessions, 'notes.jsonl'); writeFileSync(notes, '{"hello":1}\n');
    const t = (NOW - 2 * HOUR) / 1000; utimesSync(notes, t, t);
    expect(findPiSweepCandidates({ sessionsDir: e.sessions, corpusDir: e.corpus, stateFile: e.state, now: NOW })).toEqual([]);
  });
  test('a missing store is not an error', () => {
    const e = setup();
    expect(findPiSweepCandidates({ sessionsDir: join(e.root, 'nope'), corpusDir: e.corpus, stateFile: e.state, now: NOW })).toEqual([]);
  });
});

describe('sweepPiSessions', () => {
  test('hands each candidate to session-end as a SessionEnd payload, once', () => {
    const e = setup(); const p = session(e.sessions, 'killed', 2 * HOUR);
    const sent: string[] = [];
    const o = { home: join(e.root, 'home'), sessionsDir: e.sessions, corpusDir: e.corpus, currentSessionId: 'me', spawn: (s: string) => sent.push(s), now: NOW };
    sweepPiSessions(o);
    expect(sent.map((s) => JSON.parse(s))).toEqual([{ hook_event_name: 'SessionEnd', session_id: 'killed', transcript_path: p, reason: 'gbrain_sweep' }]);
    sweepPiSessions(o);
    expect(sent).toHaveLength(1);
  });
  test('GBRAIN_PI_SWEEP=0 disables it', async () => {
    const e = setup(); session(e.sessions, 'killed', 2 * HOUR);
    const sent: string[] = [];
    await withEnv({ GBRAIN_PI_SWEEP: '0' }, async () => {
      sweepPiSessions({ home: join(e.root, 'home'), sessionsDir: e.sessions, corpusDir: e.corpus, currentSessionId: undefined, spawn: (s) => sent.push(s), now: NOW });
    });
    expect(sent).toEqual([]);
  });
  test('a throwing spawner never escapes', () => {
    const e = setup(); session(e.sessions, 'a', 2 * HOUR); session(e.sessions, 'b', 3 * HOUR);
    const r = sweepPiSessions({ home: join(e.root, 'home'), sessionsDir: e.sessions, corpusDir: e.corpus, currentSessionId: undefined, spawn: () => { throw new Error('boom'); }, now: NOW });
    expect(r.map((c) => c.sessionId)).toEqual(['a', 'b']);
  });
});
