/**
 * #6741 A: Codex sub-agent rollouts (`session_meta.payload.source = {subagent: ...}`,
 * e.g. the guardian auto-reviewer) carry their task only as injected
 * `response_item` role=user context, which the adapter skips by design. They are
 * understood, not host-format drift, so they must not hold the `--since last`
 * watermark; an ordinary rollout with assistant turns and no user turn still does.
 *
 * Fails when: a sub-agent rollout is reported as `userTurnsMissing` drift (the
 * watermark never advances and every daily run rescans everything), or when the
 * sub-agent exemption swallows a real drift file.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { codexAdapter } from '../src/core/transcripts/codex.ts';
import type { FileDiagnostics, ParsedSession } from '../src/core/transcripts/types.ts';
import type { TranscriptsIngestResult } from '../src/core/transcripts/ingest.ts';
import { fmtSummary, runTranscripts } from '../src/commands/transcripts.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let dir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  dir = mkdtempSync(join(tmpdir(), 'gb-codex-subagent-'));
  return () => rmSync(dir, { recursive: true, force: true });
});

const line = (timestamp: string, type: string, payload: unknown) => JSON.stringify({ timestamp, type, payload });
const meta = (id: string, at: string, source?: unknown) =>
  line(at, 'session_meta', { id, session_id: 'root-session', timestamp: at, cwd: '/repo', cli_version: '0.159.3', ...(source === undefined ? {} : { source }) });
const injectedUser = (at: string, text: string) => line(at, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const assistant = (at: string, text: string) => line(at, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const typedUser = (at: string, text: string) => line(at, 'event_msg', { type: 'user_message', message: text });

function rollout(name: string, lines: string[]): string {
  const path = join(dir, name);
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

/** The guardian shape from the report: the task arrives only as an injected response_item user row. */
const guardian = () => rollout('rollout-guardian.jsonl', [
  meta('r-guardian', '2026-10-01T09:00:00.000Z', { subagent: { other: 'guardian' } }),
  injectedUser('2026-10-01T09:00:01.000Z', 'Review the proposed command for safety.'),
  assistant('2026-10-01T09:00:02.000Z', 'The command is safe to run.'),
]);
const ordinary = () => rollout('rollout-ordinary.jsonl', [
  meta('r-ordinary', '2026-10-01T10:00:00.000Z'),
  typedUser('2026-10-01T10:00:01.000Z', 'Summarize the build log.'),
  assistant('2026-10-01T10:00:02.000Z', 'The build passed.'),
]);
const drifted = () => rollout('rollout-drift.jsonl', [
  meta('r-drift', '2026-10-01T11:00:00.000Z', 'cli'),
  assistant('2026-10-01T11:00:02.000Z', 'An answer whose user turn the parser no longer recognizes.'),
]);

async function drain(gen: AsyncGenerator<ParsedSession, FileDiagnostics>) {
  const sessions: ParsedSession[] = [];
  let step = await gen.next();
  while (!step.done) { sessions.push(step.value); step = await gen.next(); }
  return { sessions, diag: step.value };
}

async function ingestSinceLast(): Promise<TranscriptsIngestResult> {
  const out: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...args: unknown[]) => { out.push(args.map(String).join(' ')); });
  try {
    await withEnv({ GBRAIN_HOME: dir, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, () =>
      runTranscripts(engine, ['ingest', dir, '--format', 'codex', '--source', 'default', '--since', 'last', '--json', '--quiet']));
  } finally {
    log.mockRestore();
  }
  return JSON.parse(out.join('\n')) as TranscriptsIngestResult;
}

describe('#6741 A: Codex sub-agent rollouts are understood, not drift', () => {
  test('the adapter reports a sub-agent rollout instead of userTurnsMissing; the session still imports', async () => {
    const { sessions, diag } = await drain(codexAdapter.parse(guardian()));
    expect(sessions.map(s => s.messages.map(m => m.role))).toEqual([['assistant']]);
    expect(diag.userTurnsMissing).toBeUndefined();
    expect(diag.subagentRollout).toBe(true);
  });

  test('a non-sub-agent assistant-only rollout is still flagged userTurnsMissing', async () => {
    const { diag } = await drain(codexAdapter.parse(drifted()));
    expect(diag.userTurnsMissing).toBe(true);
    expect(diag.subagentRollout).toBeUndefined();
  });

  test('--since last advances past a sub-agent rollout, and a real drift file still holds it', async () => {
    guardian();
    ordinary();
    const first = await ingestSinceLast();
    expect(first).toMatchObject({ cleanScan: true, driftFiles: 0, subagentRollouts: 1, sessionsImported: 2 });
    expect(first.files.find(f => f.path.endsWith('rollout-guardian.jsonl'))).toMatchObject({ drift: false, subagentRollout: true });

    // The watermark advanced to the newest session, so a rescan filters both.
    const second = await ingestSinceLast();
    expect(second).toMatchObject({ sessionsFiltered: 2, sessionsImported: 0 });

    drifted();
    const third = await ingestSinceLast();
    expect(third).toMatchObject({ cleanScan: false, driftFiles: 1, subagentRollouts: 1 });
    // The drift file held the watermark: its newer session is read again, never skipped.
    const fourth = await ingestSinceLast();
    expect(fourth).toMatchObject({ sessionsFiltered: 2, sessionsImported: 1, cleanScan: false });
  }, 120_000);

  test('the scan summary reports sub-agent rollouts separately from drift', () => {
    const summary = fmtSummary({ files: [], pages: { imported: 0, skipped: 2, errored: 0, planned: 0, pending: 0 }, sessionsSeen: 2, sessionsImported: 2,
      sessionsFiltered: 0, sessionsErrored: 0, sessionsPending: 0, sessionsSkippedNoTimestamp: 0, redactions: 0, imperatives: 0, partsDeleted: 0, driftFiles: 0,
      subagentRollouts: 3, truncatedFiles: 0, erroredFiles: 0, slugsTouched: [], cleanScan: true, maxSessionTs: '' });
    expect(summary).toContain('3 sub-agent rollouts (no user turns by design)');
    expect(summary).not.toContain('DRIFT WARNING');
  });
});
