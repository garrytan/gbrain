/**
 * Protect exact Hermes source selection and opt-in turn cutovers without
 * changing --since. Existing adapter coverage imports whole stores only;
 * ignoring either option leaks scheduled/pre-cutover turns. No new test-only
 * production seam: the native SQLite adapter, CLI parser and renderer run.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermesAdapter } from '../src/core/transcripts/hermes.ts';
import { lastMessageTs, trimSessionMessages } from '../src/core/transcripts/session-selection.ts';
import { renderSessionParts, redactSession } from '../src/core/transcripts/render.ts';
import { runTranscriptsIngest } from '../src/core/transcripts/ingest.ts';
import { ingestCheckpointFingerprintInput, parseIngestArgs } from '../src/commands/transcripts.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { FileDiagnostics, ParsedSession, TranscriptAdapter } from '../src/core/transcripts/types.ts';
import { buildHermesFixture } from './fixtures/transcripts/hermes-fixture-builder.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const dirs: string[] = [];
let persistedEngine: PGLiteEngine;
beforeAll(async () => {
  persistedEngine = new PGLiteEngine();
  await persistedEngine.connect({});
  await persistedEngine.initSchema();
}, 120_000);
afterAll(async () => { if (persistedEngine) await persistedEngine.disconnect(); });
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(): { path: string; patterns: string } {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-cutover-')); dirs.push(dir);
  return { path: buildHermesFixture(dir), patterns: join(dir, 'no-private-patterns.txt') };
}
async function drain(gen: AsyncGenerator<ParsedSession, FileDiagnostics>) {
  const sessions: ParsedSession[] = [];
  let step = await gen.next();
  while (!step.done) { sessions.push(step.value); step = await gen.next(); }
  return { sessions, diag: step.value };
}

describe('Hermes source and message cutover', () => {
  test('selects exact session sources, preserving native provenance; unknown is clean empty', async () => {
    const { path, patterns } = fixture();
    const selected = await drain(hermesAdapter.parse(path, { sessionSources: ['gateway'] }));
    expect(selected.sessions.map(s => s.meta.sessionId)).toEqual(['hermes-fixture-2']);
    expect(selected.sessions[0].meta.raw?.source).toBe('gateway');
    const unknown = await drain(hermesAdapter.parse(path, { sessionSources: ['gate%'] }));
    expect(unknown.sessions).toHaveLength(0);
    expect(unknown.diag.expectedEmpty).toBe(true);
    const clean = await runTranscriptsIngest({} as BrainEngine, {
      paths: [path], format: 'hermes', sourceId: 'default', sessionSources: ['unknown'], userPatternsPath: patterns,
    });
    expect(clean.cleanScan).toBe(true);
    expect(clean.driftFiles).toBe(0);
    expect(clean.maxSessionTs).toBe('');
  });

  test('--since remains whole-session; message cutoff composes with source and limit', async () => {
    const { path, patterns } = fixture();
    const options = { paths: [path], format: 'hermes' as const, sourceId: 'default', dryRun: true, userPatternsPath: patterns };
    const sinceIso = '2026-08-05T08:00:07.000Z';
    const legacy = await runTranscriptsIngest({} as BrainEngine, { ...options, sinceIso });
    expect(legacy.sessionsImported).toBe(2);
    const cutover = await runTranscriptsIngest({} as BrainEngine, {
      ...options, sinceIso, messagesSinceIso: sinceIso, sessionSources: ['cli'], limit: 1,
    });
    expect(cutover.sessionsImported).toBe(1);
    expect(cutover.files[0].sessions[0].baseSlug).not.toBe(legacy.files[0].sessions[0].baseSlug);
    const filtered = await runTranscriptsIngest({} as BrainEngine, { ...options, messagesSinceIso: '2027-01-01T00:00:00Z' });
    expect(filtered.sessionsFiltered).toBe(2);
    expect(filtered.pages.planned).toBe(0);
  });

  test('strict cutover excludes boundary/invalid turns before render; rerender retains stable identity', async () => {
    const { path, patterns } = fixture();
    const { sessions } = await drain(hermesAdapter.parse(path));
    const original = sessions[0];
    const cutoff = '2026-08-05T08:00:05.000Z';
    const trimmed = trimSessionMessages(original, cutoff);
    expect(trimmed.messages).toHaveLength(1);
    expect(original.messages).toHaveLength(2);
    const full = renderSessionParts(redactSession(original, { userPatternsPath: patterns }), { sourcePath: path });
    const render = () => renderSessionParts(redactSession(trimSessionMessages(original, cutoff), { userPatternsPath: patterns }), { sourcePath: path });
    const one = render();
    expect(one.baseSlug).not.toBe(full.baseSlug);
    expect(one.parts[0].frontmatterId).not.toBe(full.parts[0].frontmatterId);
    expect(trimmed.meta.raw?.source_session_id).toBe(original.meta.sessionId);
    expect(trimSessionMessages(original, '2026-08-05T09:00:05+01:00').meta.sessionId).toBe(trimmed.meta.sessionId);
    expect(one.parts[0].body).not.toContain('Draft the widget-co launch checklist');
    expect(one.parts[0].body).toContain('Launch checklist drafted');
    expect(render().parts[0].content).toBe(one.parts[0].content);
    expect(trimSessionMessages({ ...original, meta: { ...original.meta, startedAt: undefined } }, cutoff).meta.startedAt).toBe(original.messages[0].timestamp);
    const invalid = { ...original, messages: [{ role: 'user' as const, timestamp: 'corrupt', text: 'not provenance' }] };
    expect(trimSessionMessages(invalid, cutoff).messages).toHaveLength(0);
    expect(lastMessageTs(invalid.messages)).toBe('');
    expect(lastMessageTs([...original.messages].reverse())).toBe(original.messages[1].timestamp);
  });

  test('persists flattened cutoff provenance after strict redaction without replacing the full archive', async () => {
    const { path, patterns } = fixture();
    const engine = persistedEngine;
    const full = await runTranscriptsIngest(engine, {
      paths: [path], format: 'hermes', sourceId: 'default', userPatternsPath: patterns,
    });
    const archiveSlug = full.files[0].sessions[0].baseSlug;
    const cutoff = '2026-08-05T08:00:05.000Z';
    const cutover = await runTranscriptsIngest(engine, {
      paths: [path], format: 'hermes', sourceId: 'default', messagesSinceIso: cutoff, userPatternsPath: patterns,
    });
    const cutoverSlug = cutover.files[0].sessions[0].baseSlug;

    expect(cutoverSlug).not.toBe(archiveSlug);
    expect(await engine.getPage(archiveSlug, { sourceId: 'default' })).not.toBeNull();
    const page = await engine.getPage(cutoverSlug, { sourceId: 'default' });
    expect(page).not.toBeNull();
    expect(page!.compiled_truth).toContain('Launch checklist drafted');
    expect(page!.compiled_truth).not.toContain('Draft the widget-co launch checklist');

    const raw = await engine.getRawData(cutoverSlug, 'transcript:hermes', { sourceId: 'default' });
    expect(raw).toHaveLength(1);
    expect(raw[0].data).toMatchObject({
      source_session_id: 'hermes-fixture-1',
      import_messages_since: cutoff,
      import_semantics: 'strictly-after-v1',
    });
    expect(raw[0].data).not.toHaveProperty('import_view');
  });

  test('invalid epoch values do not crash or invent timestamps', async () => {
    const { path } = fixture();
    const db = new Database(path);
    try { db.exec('UPDATE messages SET timestamp = 1e300'); } finally { db.close(); }
    const { sessions } = await drain(hermesAdapter.parse(path));
    expect(sessions.every(s => s.messages.every(m => m.timestamp === ''))).toBe(true);
  });

  test('maintenance cancellation closes a yielded SQLite snapshot and refuses a clean result', async () => {
    const { path, patterns } = fixture();
    const controller = new AbortController();
    let closed = false;
    const adapter: TranscriptAdapter = { ...hermesAdapter,
      async *parse(path, options) {
        try { return yield* hermesAdapter.parse(path, options); } finally { closed = true; }
      },
    };
    let failure: unknown;
    try {
      await runTranscriptsIngest({} as BrainEngine, { paths: [path], sourceId: 'default', dryRun: true,
        userPatternsPath: patterns, adapters: [adapter], signal: controller.signal,
        onSession: () => controller.abort(new Error('maintenance deadline')),
      });
    } catch (error) { failure = error; }
    expect(failure instanceof Error && failure.message).toBe('maintenance deadline');
    expect(closed).toBe(true);
  });

  test('cutoff and source scopes have independent canonical checkpoints; default remains unchanged', () => {
    const base = { sourceId: 'default', pathspec: ['state.db'], format: 'hermes', version: 1 };
    expect(ingestCheckpointFingerprintInput(base)).toEqual(base);
    const a = ingestCheckpointFingerprintInput({ ...base, sessionSources: ['cli', 'gateway', 'cli'], messagesSinceIso: '2026-01-02T01:00:00+01:00' });
    const b = ingestCheckpointFingerprintInput({ ...base, sessionSources: ['gateway', 'cli'], messagesSinceIso: '2026-01-02T00:00:00Z' });
    expect(a).toEqual(b);
    expect(a).not.toEqual(ingestCheckpointFingerprintInput({ ...base, sessionSources: ['cli'] }));
    expect(a).not.toEqual(ingestCheckpointFingerprintInput({ ...base, messagesSinceIso: '2026-01-03T00:00:00Z' }));
    expect(parseIngestArgs(['state.db', '--session-source', 'cli', '--session-source', 'gateway', '--messages-since', '2026-01-02T01:00:00+01:00'])).toEqual({
      paths: ['state.db'], sessionSources: ['cli', 'gateway'], messagesSinceIso: '2026-01-02T00:00:00.000Z',
    });
    expect('error' in parseIngestArgs(['--messages-since', 'last'])).toBe(true);
    expect('error' in parseIngestArgs(['--session-source'])).toBe(true);
  });
});
