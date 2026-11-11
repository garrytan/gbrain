/**
 * #8901: `transcripts ingest --format hermes` imports every row of the Hermes
 * `sessions` table, automation included (cron runs, delegate sub-agent
 * children, kanban workers, tool integrations, hook-driven runs), so most
 * imported Hermes pages on a working install are not conversations and, with
 * `--facts`, cost extraction calls for text the user never said.
 *
 * Protects: the adapter drops sessions whose `source` (or immutable
 * `created_source`) is in `excludeSessionSources` BEFORE reading their
 * messages, and with `subagent` listed also drops delegate children
 * recognised by Hermes' own `_delegate_from` marker under any source;
 * `parent_session_id` alone never excludes (compression continuations and
 * branches import); a store without the marker column still imports; a store
 * whose every row is excluded is an understood empty, not drift; ingest
 * reports excluded sessions separately (`sessionsExcluded`,
 * `excludedBySource`, `delegatesExcluded`, the `excluded:` line), never as
 * errors, keeps the scan clean, takes the watermark from imported sessions
 * only, and never hands an excluded session's slug to `--facts`; every Hermes
 * page carries `transcript_import.session_source` (+ `session_created_source`,
 * `delegate`) and raw metadata `delegate_from`; the CLI flag, the config key
 * and the default resolve flag > config > default with `none`/`[]` as the off
 * switch; an explicit set is part of the `--since last` fingerprint, the
 * default is not (and only for Hermes stores / auto-detected paths); a config
 * value that is not a list refuses the run instead of excluding nothing; the
 * frontmatter labels pass the same redaction as the title; a BLOB holding JSON
 * text is read as Hermes' json_extract reads it, while a non-UTF-8 BLOB or a
 * non-JSON `model_config` is unparsed metadata, never an aborted scan; operator labels
 * such as `constructor` count correctly.
 * Regression it catches: a predicate that reads `parent_session_id`, a filter
 * applied after rendering (slugs leak into `--facts`), an all-excluded store
 * freezing the watermark as drift, a store without `model_config` reading as
 * schema drift, the default set re-scoping existing watermarks at upgrade.
 * Existing coverage: `transcript-adapters.test.ts` and
 * `hermes-clarify-transcripts-7396.test.ts` parse stores without any
 * automation rows and never pass an exclude option.
 * Seams: `hermesDelegateMarker` / `hermesSessionExcluded` are exported for
 * these unit cases (@internal); everything else runs through the adapter,
 * `runTranscriptsIngest` and `parseIngestArgs`. PGLite only; no env writes.
 *
 * The adapter, CLI and policy modules are imported as namespaces so the
 * discrimination run (`scripts/check-test-discriminates.sh`, which reverts
 * the source files to the pre-fix state) fails inside the tests instead of at
 * module link.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runTranscriptsIngest, type TranscriptsIngestResult } from '../src/core/transcripts/ingest.ts';
import { redactSession } from '../src/core/transcripts/render.ts';
import * as hermes from '../src/core/transcripts/hermes.ts';
import * as cli from '../src/commands/transcripts.ts';
import { fingerprint } from '../src/core/op-checkpoint.ts';
import { buildTranscriptSlug, type FileDiagnostics, type ParsedSession } from '../src/core/transcripts/types.ts';
import {
  buildHermesAutomationFixture,
  buildHermesFixture,
  HERMES_AUTOMATION_SESSIONS,
} from './fixtures/transcripts/hermes-fixture-builder.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv } from './helpers/with-env.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { parseSourceList } from '../src/core/config-list.ts';

const ALL_IDS = HERMES_AUTOMATION_SESSIONS.map(s => s.id);
const DELEGATE_IDS = ['subagent-run', 'delegate-under-desktop'];
const NO_PATTERNS = { userPatternsPath: '/nonexistent-patterns.txt' };

let dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-exclude-8901-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs = []; });

async function drain(gen: AsyncGenerator<ParsedSession, FileDiagnostics>): Promise<{ sessions: ParsedSession[]; diag: FileDiagnostics }> {
  const sessions: ParsedSession[] = [];
  let step = await gen.next();
  while (!step.done) { sessions.push(step.value); step = await gen.next(); }
  return { sessions, diag: step.value };
}

function parseWith(path: string, excludeSessionSources?: readonly string[]) {
  return drain(hermes.hermesAdapter.parse(path, excludeSessionSources ? { excludeSessionSources } : undefined));
}

function slugOf(id: string): string {
  const s = HERMES_AUTOMATION_SESSIONS.find(x => x.id === id)!;
  return buildTranscriptSlug('hermes', new Date(s.startedAt * 1000).toISOString(), { sessionId: id });
}

/** Last message timestamp (start + 2 s) of a fixture session, as the ingest watermark records it. */
function lastTsOf(id: string): string {
  const s = HERMES_AUTOMATION_SESSIONS.find(x => x.id === id)!;
  return new Date((s.startedAt + 2) * 1000).toISOString();
}

describe('hermes adapter: session-kind filter (#8901)', () => {
  test('without an exclude option every session imports and carries its kind', async () => {
    const { sessions, diag } = await parseWith(buildHermesAutomationFixture(scratch()));
    expect(sessions.map(s => s.meta.sessionId)).toEqual(ALL_IDS);
    expect(diag.sessions).toBe(ALL_IDS.length);
    expect(diag.sessionsExcluded).toBeUndefined();
    expect(diag.excludedBySource).toBeUndefined();
    expect(diag.expectedEmpty).toBeUndefined();
    // Metadata the host could not have parsed (garbled-config) is flagged on the session, never guessed excluded.
    expect(sessions.filter(s => s.meta.hostMetadataUnparsed).map(s => s.meta.sessionId)).toEqual(['garbled-config']);
    const byId = new Map(sessions.map(s => [s.meta.sessionId, s.meta]));
    expect(byId.get('desktop-root')).toMatchObject({ sessionSource: 'desktop' });
    expect(byId.get('desktop-root')!.delegate).toBeUndefined();
    expect(byId.get('desktop-root')!.sessionCreatedSource).toBeUndefined();
    expect(byId.get('subagent-run')).toMatchObject({ sessionSource: 'subagent', delegate: true });
    expect(byId.get('delegate-under-desktop')).toMatchObject({ sessionSource: 'desktop', delegate: true });
    expect(byId.get('delegate-under-desktop')!.raw).toMatchObject({ source: 'desktop', delegate_from: 'desktop-root' });
    expect(byId.get('continuation-of-root')!.delegate).toBeUndefined();
    expect(byId.get('continuation-of-root')!.raw!.delegate_from).toBeUndefined();
    expect(byId.get('branch-of-root')!.delegate).toBeUndefined();
    expect(byId.get('garbled-config')!.delegate).toBeUndefined();
    expect(byId.get('local-routed-desktop')).toMatchObject({ sessionSource: 'local', sessionCreatedSource: 'desktop' });
    expect(byId.get('local-routed-desktop')!.raw).toMatchObject({ source: 'local', created_source: 'desktop' });
    expect(byId.get('kanban-retagged')).toMatchObject({ sessionSource: 'local', sessionCreatedSource: 'kanban' });
  });

  test('cron + subagent: drops cron, the subagent row and the inherited-source delegate child; keeps the continuation, the branch and custom sources', async () => {
    const { sessions, diag } = await parseWith(buildHermesAutomationFixture(scratch()), ['cron', 'subagent']);
    const imported = sessions.map(s => s.meta.sessionId);
    expect(imported).toEqual(ALL_IDS.filter(id => id !== 'cron-report' && !DELEGATE_IDS.includes(id)));
    expect(imported).toContain('continuation-of-root'); // parent_session_id only: never a sub-agent signal
    expect(imported).toContain('branch-of-root');
    expect(imported).toContain('hook-run');
    expect(imported).toContain('kanban-worker');
    expect(diag.sessions).toBe(ALL_IDS.length - 3);
    expect(diag.sessionsExcluded).toBe(3);
    expect(diag.excludedBySource).toEqual({ cron: 1, subagent: 2 });
    expect(diag.delegatesExcluded).toBe(1);
    expect(diag.expectedEmpty).toBeUndefined();
  });

  test('the default set drops what Hermes hides (subagent + delegates, kanban, tool) by source or by creation label, keeps cron and hooks', async () => {
    const { sessions, diag } = await parseWith(buildHermesAutomationFixture(scratch()), hermes.DEFAULT_HERMES_EXCLUDE_SOURCES);
    const imported = sessions.map(s => s.meta.sessionId);
    expect(imported).toEqual(['desktop-root', 'cron-report', 'continuation-of-root', 'branch-of-root', 'hook-run', 'garbled-config', 'local-routed-desktop']);
    expect(diag.sessionsExcluded).toBe(5);
    expect(diag.excludedBySource).toEqual({ subagent: 2, kanban: 2, tool: 1 });
    expect(diag.delegatesExcluded).toBe(1);
  });

  test('a custom hook source is excluded only when named', async () => {
    const path = buildHermesAutomationFixture(scratch());
    const named = await parseWith(path, ['hook-example']);
    expect(named.sessions.map(s => s.meta.sessionId)).not.toContain('hook-run');
    expect(named.diag.sessionsExcluded).toBe(1);
    expect(named.diag.excludedBySource).toEqual({ 'hook-example': 1 });
    expect(named.diag.delegatesExcluded).toBeUndefined();
    const unnamed = await parseWith(path, ['cron']);
    expect(unnamed.sessions.map(s => s.meta.sessionId)).toContain('hook-run');
  });

  test('a store without model_config / created_source columns still imports and counts by source only (the exclusion is decided before the message read)', async () => {
    const path = buildHermesFixture(scratch()); // the pre-marker schema
    const plain = await parseWith(path, ['subagent']);
    expect(plain.sessions.map(s => s.meta.sessionId)).toEqual(['hermes-fixture-1', 'hermes-fixture-2']);
    expect(plain.diag.sessionsExcluded).toBeUndefined();
    expect(plain.diag.zeroSessionsReason).toBeUndefined();
    // Excluding `cli` counts BOTH cli rows, including the tool-only one that
    // would otherwise have been skipped silently for having no text.
    const cli_ = await parseWith(path, ['cli']);
    expect(cli_.sessions.map(s => s.meta.sessionId)).toEqual(['hermes-fixture-2']);
    expect(cli_.diag.sessionsExcluded).toBe(2);
    expect(cli_.diag.excludedBySource).toEqual({ cli: 2 });
  });

  test('every row excluded is an understood empty store, not drift; rows that merely have no text are still drift', async () => {
    const all = await parseWith(buildHermesAutomationFixture(scratch()), ['desktop', 'cron', 'subagent', 'hook-example', 'kanban', 'tool', 'local']);
    expect(all.sessions).toEqual([]);
    expect(all.diag.sessions).toBe(0);
    expect(all.diag.sessionsExcluded).toBe(ALL_IDS.length);
    expect(all.diag.expectedEmpty).toBe(true);
    expect(all.diag.zeroSessionsReason).toBe('every session in store excluded by source (cron, desktop, hook-example, kanban, local, subagent, tool)');

    // One excluded cron row beside a desktop row whose messages are all tool
    // output: the surviving row yields nothing, so this is today's drift.
    const dir = scratch();
    const path = join(dir, 'state.db');
    const db = new Database(path);
    try {
      db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, created_source TEXT, display_name TEXT, model TEXT,
        model_config TEXT, parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL, cwd TEXT, title TEXT);
        CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, timestamp REAL NOT NULL);`);
      db.prepare('INSERT INTO sessions (id, source, started_at) VALUES (?, ?, ?)').run('cron-only', 'cron', 1786200000);
      db.prepare('INSERT INTO sessions (id, source, started_at) VALUES (?, ?, ?)').run('desktop-toolonly', 'desktop', 1786203600);
      const m = db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)');
      m.run('cron-only', 'user', 'scheduled prompt', 1786200001);
      m.run('desktop-toolonly', 'tool', 'TOOL-ONLY-TEXT', 1786203601);
    } finally {
      db.close();
    }
    const mixed = await parseWith(path, ['cron']);
    expect(mixed.diag.sessions).toBe(0);
    expect(mixed.diag.sessionsExcluded).toBe(1);
    expect(mixed.diag.expectedEmpty).toBeUndefined();
    expect(mixed.diag.zeroSessionsReason).toBe('no sessions with user/assistant text messages in store');
  });

  test('hermesDelegateMarker reads the marker the way Hermes does and never guesses', () => {
    const marker = hermes.hermesDelegateMarker;
    expect(marker(null)).toEqual({ delegate: false, unparsed: false });
    expect(marker(undefined)).toEqual({ delegate: false, unparsed: false });
    expect(marker('')).toEqual({ delegate: false, unparsed: false });
    expect(marker('{}')).toEqual({ delegate: false, unparsed: false });
    expect(marker('{"model":"model-example"}')).toEqual({ delegate: false, unparsed: false });
    expect(marker('{"_delegate_from":null}')).toEqual({ delegate: false, unparsed: false });
    expect(marker('{"_branched_from":"p"}')).toEqual({ delegate: false, unparsed: false });
    expect(marker('{"_delegate_from":"parent-1"}')).toEqual({ delegate: true, unparsed: false, from: 'parent-1' });
    expect(marker('{not json')).toEqual({ delegate: false, unparsed: true });
    expect(marker('[1,2]')).toEqual({ delegate: false, unparsed: true });
    expect(marker('"text"')).toEqual({ delegate: false, unparsed: true });
    // SQLite lets a BLOB or a number sit in the TEXT column: bytes that are not
    // JSON, and a number, are unparsed, never a throw; a BLOB that holds JSON
    // text is read the way Hermes' json_extract reads it (outside review, ship pass 2).
    expect(marker(Buffer.from([1, 2, 3]))).toEqual({ delegate: false, unparsed: true });
    expect(marker(Buffer.from([0xde, 0xad, 0xbe, 0xef]))).toEqual({ delegate: false, unparsed: true });
    expect(marker(42)).toEqual({ delegate: false, unparsed: true });
    expect(marker(Buffer.from('{"_delegate_from":"parent-1"}', 'utf8'))).toEqual({ delegate: true, unparsed: false, from: 'parent-1' });
    expect(marker(Buffer.from('{"model":"model-example"}', 'utf8'))).toEqual({ delegate: false, unparsed: false });
    // A non-string parent value is presence only, never serialized; a deeply nested one never throws.
    expect(marker('{"_delegate_from":{"id":"p"}}')).toEqual({ delegate: true, unparsed: false });
    const deep = `{"_delegate_from":${'['.repeat(60_000)}${']'.repeat(60_000)}}`;
    expect(() => marker(deep)).not.toThrow();
    expect(typeof marker(deep).delegate).toBe('boolean');
  });

  test('hermesSessionExcluded matches source, then creation label, then the marker under subagent; an empty set excludes nothing', () => {
    const excluded = new Set(['subagent', 'kanban']);
    const no = { delegate: false };
    const yes = { delegate: true };
    expect(hermes.hermesSessionExcluded({ source: 'desktop' }, no, excluded)).toEqual({ excluded: false });
    expect(hermes.hermesSessionExcluded({ source: 'subagent' }, no, excluded)).toEqual({ excluded: true, label: 'subagent', viaMarker: false, matched: ['subagent'] });
    expect(hermes.hermesSessionExcluded({ source: 'local', created_source: 'kanban' }, no, excluded)).toEqual({ excluded: true, label: 'kanban', viaMarker: false, matched: ['kanban'] });
    expect(hermes.hermesSessionExcluded({ source: 'desktop', created_source: 'desktop' }, yes, excluded)).toEqual({ excluded: true, label: 'subagent', viaMarker: true, matched: ['subagent'] });
    expect(hermes.hermesSessionExcluded({ source: 'desktop' }, yes, new Set(['cron']))).toEqual({ excluded: false });
    expect(hermes.hermesSessionExcluded({ source: null }, no, excluded)).toEqual({ excluded: false });
    expect(hermes.hermesSessionExcluded({ source: 'subagent' }, yes, new Set())).toEqual({ excluded: false });
    // A delegate child spawned under a cron run matches cron AND subagent: counted once under cron, both labels did something.
    expect(hermes.hermesSessionExcluded({ source: 'cron' }, yes, new Set(['cron', 'subagent']))).toEqual({ excluded: true, label: 'cron', viaMarker: false, matched: ['cron', 'subagent'] });
    expect(hermes.hermesSessionExcluded({ source: 'local', created_source: 'kanban' }, yes, new Set(['kanban', 'subagent']))).toEqual({ excluded: true, label: 'kanban', viaMarker: false, matched: ['kanban', 'subagent'] });
    // A subagent row carrying the marker is one label, not two.
    expect(hermes.hermesSessionExcluded({ source: 'subagent' }, yes, excluded)).toEqual({ excluded: true, label: 'subagent', viaMarker: false, matched: ['subagent'] });
  });

  test('a BLOB model_config and a garbled one on an excluded row: no throw, unparsed counted for imported rows only, operator labels like constructor count correctly', async () => {
    const dir = scratch();
    const path = join(dir, 'state.db');
    const db = new Database(path);
    try {
      db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, created_source TEXT, display_name TEXT, model TEXT,
        model_config TEXT, parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL, cwd TEXT, title TEXT);
        CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, timestamp REAL NOT NULL);`);
      const ins = db.prepare('INSERT INTO sessions (id, source, model_config, started_at) VALUES (?, ?, ?, ?)');
      ins.run('blob-config', 'desktop', Buffer.from([0xde, 0xad, 0xbe, 0xef]), 1786300000);
      ins.run('cron-garbled', 'cron', '{not json', 1786303600);
      ins.run('ctor-labelled', 'constructor', null, 1786307200);
      ins.run('proto-labelled', '__proto__', null, 1786310800);
      ins.run('plain-desktop', 'desktop', null, 1786314400);
      ins.run('textless-garbled', 'desktop', '{not json', 1786318000);
      ins.run('blob-source', Buffer.from([0x01, 0x02]), null, 1786321600);
      // A BLOB that holds JSON text with the marker: a delegate child, as Hermes' json_extract reads it.
      ins.run('blob-json-delegate', 'desktop', Buffer.from('{"_delegate_from":"plain-desktop"}', 'utf8'), 1786325200);
      const m = db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)');
      for (const id of ['blob-config', 'cron-garbled', 'ctor-labelled', 'proto-labelled', 'plain-desktop', 'blob-source', 'blob-json-delegate']) {
        m.run(id, 'user', `hello from ${id}`, 1786300001);
        m.run(id, 'assistant', `reply to ${id}`, 1786300002);
      }
      m.run('textless-garbled', 'tool', 'TOOL-ONLY', 1786318001);
    } finally {
      db.close();
    }
    const { sessions, diag } = await parseWith(path, ['cron', 'constructor', '__proto__']);
    expect(sessions.map(s => s.meta.sessionId)).toEqual(['blob-config', 'plain-desktop', 'blob-source', 'blob-json-delegate']);
    // The JSON-text BLOB is parsed, not unparsed: the row imports with `subagent` unlisted and carries the delegate flag.
    const blobDelegate = sessions.find(s => s.meta.sessionId === 'blob-json-delegate')!;
    expect(blobDelegate.meta.delegate).toBe(true);
    expect(blobDelegate.meta.hostMetadataUnparsed).toBeUndefined();
    expect(blobDelegate.meta.raw!.delegate_from).toBe('plain-desktop');
    const underDefault = await parseWith(path, hermes.DEFAULT_HERMES_EXCLUDE_SOURCES);
    expect(underDefault.sessions.map(s => s.meta.sessionId)).not.toContain('blob-json-delegate');
    expect(underDefault.diag.excludedBySource).toEqual({ subagent: 1 });
    expect(underDefault.diag.delegatesExcluded).toBe(1);
    // A BLOB in the source column is not a label: no frontmatter kind, raw source null, no throw.
    const blobSource = sessions.find(s => s.meta.sessionId === 'blob-source')!;
    expect(blobSource.meta.sessionSource).toBeUndefined();
    expect(blobSource.meta.raw!.source).toBeNull();
    expect(sessions.find(s => s.meta.sessionId === 'blob-config')!.meta.hostMetadataUnparsed).toBe(true);
    expect(sessions.find(s => s.meta.sessionId === 'plain-desktop')!.meta.hostMetadataUnparsed).toBeUndefined();
    expect(diag.sessionsExcluded).toBe(3);
    expect(Object.entries(diag.excludedBySource!).sort()).toEqual([['__proto__', 1], ['constructor', 1], ['cron', 1]]);
    expect(typeof diag.excludedBySource!['constructor']).toBe('number');
    // The excluded garbled row and the text-less garbled row are never yielded, so only the BLOB row carries the flag.
    expect(sessions.filter(s => s.meta.hostMetadataUnparsed).map(s => s.meta.sessionId)).toEqual(['blob-config']);
    expect(diag.excludeLabelsMatched).toEqual(['__proto__', 'constructor', 'cron']);
    expect(diag.delegatesExcluded).toBeUndefined();
    expect(cli.fmtExcludedLine({ sessionsExcluded: 3, excludedBySource: diag.excludedBySource!, delegatesExcluded: 0 }))
      .toBe('excluded: 3 automated session(s) by source (__proto__ 1, constructor 1, cron 1) — not imported, not errors');
  });

  test('a library caller passing none or blanks excludes nothing at the adapter boundary', async () => {
    const path = buildHermesAutomationFixture(scratch());
    for (const list of [['none'], [' ', ''], ['none', '']]) {
      const { sessions, diag } = await parseWith(path, list);
      expect(sessions.map(s => s.meta.sessionId)).toEqual(ALL_IDS);
      expect(diag.sessionsExcluded).toBeUndefined();
      expect(diag.expectedEmpty).toBeUndefined();
    }
  });

  test('the session-kind labels pass the same redaction as the title before they reach frontmatter', () => {
    const label = 'hook-private-label';
    const session: ParsedSession = {
      meta: { harness: 'hermes', sessionId: 'redact-1', sessionSource: label, sessionCreatedSource: `${label}-created`, startedAt: '2026-08-03T10:00:00.000Z', raw: { session_id: 'redact-1', source: label } },
      messages: [{ role: 'user', text: 'hello', timestamp: '2026-08-03T10:00:01.000Z' }],
    };
    const { session: red, redactionCount } = redactSession(session, { patterns: [{ regex: new RegExp(label, 'g') } as never] });
    expect(red.meta.sessionSource).toBe('<REDACTED:user-pattern>');
    expect(red.meta.sessionCreatedSource).toBe('<REDACTED:user-pattern>-created');
    expect((red.meta.raw as Record<string, unknown>).source).toBe('<REDACTED:user-pattern>');
    expect(redactionCount).toBe(3);
    // Untouched when no pattern matches.
    const clean = redactSession(session, { patterns: [] });
    expect(clean.session.meta.sessionSource).toBe(label);
  });
});

describe('ingest accounting, watermark and the --facts boundary (PGLite, #8901)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => { await resetPgliteState(engine); });

  test('excluded sessions are counted apart from imported ones, keep the scan clean, never become pages and never reach slugsTouched', async () => {
    const path = buildHermesAutomationFixture(scratch());
    const r = await runTranscriptsIngest(engine, { paths: [path], sourceId: 'default', ...NO_PATTERNS, excludeSessionSources: ['cron', 'subagent'] });
    const excludedIds = ['cron-report', ...DELEGATE_IDS];
    const importedIds = ALL_IDS.filter(id => !excludedIds.includes(id));
    expect(r.sessionsExcluded).toBe(3);
    expect(r.excludedBySource).toEqual({ cron: 1, subagent: 2 });
    expect(r.delegatesExcluded).toBe(1);
    expect(r.sessionMetadataUnparsed).toBe(1);
    expect(r.files[0].sessionsExcluded).toBe(3);
    expect(r.sessionsSeen).toBe(importedIds.length);
    expect(r.sessionsImported).toBe(importedIds.length);
    expect(r.sessionsErrored).toBe(0);
    expect(r.pages.imported).toBe(importedIds.length);
    expect(r.driftFiles).toBe(0);
    expect(r.cleanScan).toBe(true);
    expect([...r.slugsTouched].sort()).toEqual(importedIds.map(slugOf).sort());
    for (const id of excludedIds) {
      expect(r.slugsTouched).not.toContain(slugOf(id));
      expect(await engine.getPage(slugOf(id), { sourceId: 'default' })).toBeNull();
    }
    expect(await engine.getPage(slugOf('continuation-of-root'), { sourceId: 'default' })).not.toBeNull();
    expect(cli.fmtSummary(r)).toContain('excluded: 3 automated session(s) by source (cron 1, subagent 2 incl. 1 delegate child(ren) under another source) — not imported, not errors');
    expect(cli.fmtSummary(r)).not.toContain('DRIFT WARNING');
  }, 60_000);

  test('the watermark comes from imported sessions only, so a newer excluded session never advances it', async () => {
    const path = buildHermesAutomationFixture(scratch());
    // kanban-retagged (created_source kanban) is the newest row in the store.
    const r = await runTranscriptsIngest(engine, { paths: [path], sourceId: 'default', ...NO_PATTERNS, excludeSessionSources: ['kanban'] });
    expect(r.excludedBySource).toEqual({ kanban: 2 });
    expect(r.cleanScan).toBe(true);
    expect(r.maxSessionTs).toBe(lastTsOf('local-routed-desktop'));
    expect(r.maxSessionTs < lastTsOf('kanban-retagged')).toBe(true);
  }, 60_000);

  test('a dry run reports the excluded counts and writes nothing', async () => {
    const path = buildHermesAutomationFixture(scratch());
    const r = await runTranscriptsIngest(engine, { paths: [path], sourceId: 'default', ...NO_PATTERNS, dryRun: true, excludeSessionSources: hermes.DEFAULT_HERMES_EXCLUDE_SOURCES });
    expect(r.sessionsExcluded).toBe(5);
    expect(r.pages.planned).toBe(ALL_IDS.length - 5);
    expect(r.pages.imported).toBe(0);
    expect(await engine.getPage(slugOf('desktop-root'), { sourceId: 'default' })).toBeNull();
  }, 60_000);

  test('pages record the session kind in transcript_import and the delegate parent in raw metadata', async () => {
    const path = buildHermesAutomationFixture(scratch());
    const r = await runTranscriptsIngest(engine, { paths: [path], sourceId: 'default', ...NO_PATTERNS, excludeSessionSources: [] });
    expect(r.sessionsExcluded).toBe(0);
    expect(r.sessionsImported).toBe(ALL_IDS.length);
    const ti = async (id: string) => {
      const page = await engine.getPage(slugOf(id), { sourceId: 'default' });
      expect(page).not.toBeNull();
      return (page!.frontmatter as Record<string, unknown>).transcript_import as Record<string, unknown>;
    };
    expect(await ti('desktop-root')).toEqual({ harness: 'hermes', session_id: 'desktop-root', version: 1, part: 1, of: 1, session_source: 'desktop' });
    expect(await ti('delegate-under-desktop')).toEqual({ harness: 'hermes', session_id: 'delegate-under-desktop', version: 1, part: 1, of: 1, session_source: 'desktop', delegate: true });
    expect(await ti('subagent-run')).toMatchObject({ session_source: 'subagent', delegate: true });
    expect(await ti('cron-report')).toEqual({ harness: 'hermes', session_id: 'cron-report', version: 1, part: 1, of: 1, session_source: 'cron' });
    expect(await ti('continuation-of-root')).toEqual({ harness: 'hermes', session_id: 'continuation-of-root', version: 1, part: 1, of: 1, session_source: 'desktop' });
    expect(await ti('local-routed-desktop')).toEqual({ harness: 'hermes', session_id: 'local-routed-desktop', version: 1, part: 1, of: 1, session_source: 'local', session_created_source: 'desktop' });
    const raw = await engine.getRawData(slugOf('delegate-under-desktop'), 'transcript:hermes', { sourceId: 'default' });
    expect(raw).toHaveLength(1);
    expect(raw[0].data).toMatchObject({ session_id: 'delegate-under-desktop', source: 'desktop', delegate_from: 'desktop-root' });
    const rootRaw = await engine.getRawData(slugOf('desktop-root'), 'transcript:hermes', { sourceId: 'default' });
    expect((rootRaw[0].data as Record<string, unknown>).delegate_from).toBeUndefined();
  }, 60_000);
});

describe('CLI flag, config key, policy and fingerprint (#8901)', () => {
  test('--exclude-source parses a comma list, normalizes it, and refuses missing, flag-shaped or mixed values', () => {
    const parse = (args: string[]) => cli.parseIngestArgs(args) as { excludeSources?: string[]; error?: string };
    expect(parse(['a.db', '--exclude-source', 'cron,subagent']).excludeSources).toEqual(['cron', 'subagent']);
    expect(parse(['a.db', '--exclude-source', ' cron , subagent ,, cron ']).excludeSources).toEqual(['cron', 'subagent']);
    expect(parse(['a.db', '--exclude-source', 'none']).excludeSources).toEqual([]);
    expect(parse(['a.db', '--exclude-source', 'none,cron']).error).toContain('none');
    expect(parse(['a.db', '--exclude-source']).error).toContain('exclude-source');
    expect(parse(['a.db', '--exclude-source', '--facts']).error).toContain('exclude-source');
    expect(parse(['a.db', '--exclude-source', '']).error).toContain('exclude-source');
    expect(parse(['a.db', '--exclude-source', ',']).error).toContain('lists no session sources');
    expect(parse(['a.db', '--exclude-source', ' , ']).error).toContain('lists no session sources');
    expect(parse(['a.db']).excludeSources).toBeUndefined();
  });

  test('the = spelling is refused before dispatch with the two-argument hint, like every value flag of this command', async () => {
    const r = await runCli(['transcripts', 'ingest', 'a.db', '--exclude-source=cron'], { home: scratch(), timeoutMs: 90_000 });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('--exclude-source');
    expect(r.stderr).toContain('two arguments');
  }, 120_000);

  test('resolveHermesExcludePolicy: flag beats config beats default; none / [] / "" are the explicit off switch', () => {
    const resolve = hermes.resolveHermesExcludePolicy;
    expect(resolve({})).toEqual({ sources: ['subagent', 'kanban', 'tool'], explicit: false });
    expect(resolve({ flag: null, configRaw: null })).toEqual({ sources: ['subagent', 'kanban', 'tool'], explicit: false });
    expect(resolve({ configRaw: '["cron", "subagent"]' })).toEqual({ sources: ['cron', 'subagent'], explicit: true });
    expect(resolve({ configRaw: 'cron, hook-example' })).toEqual({ sources: ['cron', 'hook-example'], explicit: true });
    expect(resolve({ configRaw: '[]' })).toEqual({ sources: [], explicit: true });
    expect(resolve({ configRaw: '' })).toEqual({ sources: [], explicit: true });
    expect(resolve({ configRaw: 'none' })).toEqual({ sources: [], explicit: true });
    // A value that is not a list is refused, never read as "exclude nothing".
    expect(resolve({ configRaw: '{"a":1}' })).toMatchObject({ sources: ['subagent', 'kanban', 'tool'], explicit: false, error: expect.stringContaining('not a JSON array or comma list (got object)') });
    expect(resolve({ configRaw: 'null' })).toMatchObject({ explicit: false, error: expect.stringContaining('got null') });
    expect(resolve({ configRaw: '[1, "cron"]' })).toMatchObject({ explicit: false, error: expect.stringContaining('non-string') });
    expect(resolve({ configRaw: '["none", "cron"]' })).toMatchObject({ explicit: false, error: expect.stringContaining('none cannot be combined') });
    expect(resolve({ configRaw: 'none, cron' })).toMatchObject({ explicit: false, error: expect.stringContaining('none cannot be combined') });
    expect(resolve({ configRaw: '["cron"]' }).error).toBeUndefined();
    // A JSON-quoted comma list is split without its quotes; a JSON-shaped
    // value that does not parse, or a list that names nothing, is refused.
    expect(resolve({ configRaw: '"cron,subagent"' })).toEqual({ sources: ['cron', 'subagent'], explicit: true });
    expect(resolve({ configRaw: '"none"' })).toEqual({ sources: [], explicit: true });
    expect(resolve({ configRaw: '""' })).toEqual({ sources: [], explicit: true });
    expect(resolve({ configRaw: '["cron","subagent",]' })).toMatchObject({ explicit: false, error: expect.stringContaining('looks like JSON but does not parse') });
    expect(resolve({ configRaw: ',' })).toMatchObject({ explicit: false, error: expect.stringContaining('lists no source labels') });
    expect(resolve({ configRaw: '[" "]' })).toMatchObject({ explicit: false, error: expect.stringContaining('lists no source labels') });
    expect(resolve({ configRaw: '"cron"' }).sources.some((v) => v.includes('"'))).toBe(false);
    expect(parseSourceList('"a, b"')).toEqual(['a', 'b']);
    expect(parseSourceList('["a","b"]')).toEqual(['a', 'b']);
    expect(parseSourceList('a,b')).toEqual(['a', 'b']);
    expect(hermes.HERMES_SUBAGENT_SOURCE).toBe('subagent');
    expect(resolve({ flag: ['cron'], configRaw: '["subagent"]' })).toEqual({ sources: ['cron'], explicit: true });
    expect(resolve({ flag: [], configRaw: '["subagent"]' })).toEqual({ sources: [], explicit: true });
    expect(resolve({ flag: [' tool ', 'tool', 'none', ''] })).toEqual({ sources: ['tool'], explicit: true });
    expect(hermes.DEFAULT_HERMES_EXCLUDE_SOURCES).toEqual(['subagent', 'kanban', 'tool']);
  });

  test('the checkpoint fingerprint keys on an explicit exclude set (sorted) and never on the default', () => {
    const base = { sourceId: 'default', pathspec: ['/x/state.db'], format: 'hermes', version: 1 };
    const input = cli.ingestCheckpointFingerprintInput;
    expect(input(base)).toEqual({ sourceId: 'default', pathspec: ['/x/state.db'], format: 'hermes', version: 1 });
    expect(input({ ...base, excludeSources: ['subagent', 'cron'] })).toEqual({ ...base, excludeSources: ['cron', 'subagent'] });
    // Keyed for hermes and auto only: an explicit codex/claude-code run ignores the set, so its watermark must not move.
    expect(input({ ...base, format: 'auto', excludeSources: ['cron'] })).toEqual({ ...base, format: 'auto', excludeSources: ['cron'] });
    expect(input({ ...base, format: 'codex', excludeSources: ['cron'] })).toEqual({ ...base, format: 'codex' });
    expect(input({ ...base, format: 'claude-code', excludeSources: [] })).toEqual({ ...base, format: 'claude-code' });
    expect(fingerprint(input({ ...base, excludeSources: ['subagent', 'cron'] }))).toBe(fingerprint(input({ ...base, excludeSources: ['cron', 'subagent'] })));
    expect(fingerprint(input({ ...base, excludeSources: ['cron'] }))).not.toBe(fingerprint(input({ ...base, excludeSources: ['cron', 'subagent'] })));
    expect(fingerprint(input({ ...base, excludeSources: [] }))).not.toBe(fingerprint(input(base)));
    // The cap dimension (#4149) is untouched.
    expect(input({ ...base, maxBytes: 7 })).toEqual({ ...base, maxBytes: 7 });
  });

  test('fmtExcludedLine names every label and the delegate children counted under subagent', () => {
    expect(cli.fmtExcludedLine({ sessionsExcluded: 4, excludedBySource: { subagent: 3, cron: 1 }, delegatesExcluded: 2 }))
      .toBe('excluded: 4 automated session(s) by source (cron 1, subagent 3 incl. 2 delegate child(ren) under another source) — not imported, not errors');
    expect(cli.fmtExcludedLine({ sessionsExcluded: 1, excludedBySource: { 'hook-example': 1 }, delegatesExcluded: 0 }))
      .toBe('excluded: 1 automated session(s) by source (hook-example 1) — not imported, not errors');
  });
});

describe('overlapping labels and timestamp-less sessions (PGLite, #8901)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => { await resetPgliteState(engine); });

  test('a cron-spawned delegate child counts once under cron, and subagent is not reported unmatched; a timestamp-less garbled session is skipped, not counted as scanned', async () => {
    const dir = scratch();
    const path = join(dir, 'state.db');
    const db = new Database(path);
    try {
      db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, created_source TEXT, display_name TEXT, model TEXT,
        model_config TEXT, parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL, cwd TEXT, title TEXT);
        CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, timestamp REAL NOT NULL);`);
      const ins = db.prepare('INSERT INTO sessions (id, source, model_config, parent_session_id, started_at) VALUES (?, ?, ?, ?, ?)');
      ins.run('cron-root', 'cron', null, null, 1786400000);
      ins.run('cron-delegate', 'cron', JSON.stringify({ _delegate_from: 'cron-root' }), 'cron-root', 1786403600);
      ins.run('desktop-ok', 'desktop', null, null, 1786407200);
      ins.run('garbled-no-ts', 'desktop', '{not json', null, 0);
      const m = db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)');
      for (const id of ['cron-root', 'cron-delegate', 'desktop-ok']) {
        m.run(id, 'user', `hello from ${id}`, 1786400001);
        m.run(id, 'assistant', `reply to ${id}`, 1786400002);
      }
      m.run('garbled-no-ts', 'user', 'undated', 0);
      m.run('garbled-no-ts', 'assistant', 'undated reply', 0);
    } finally {
      db.close();
    }
    const r = await runTranscriptsIngest(engine, { paths: [path], sourceId: 'default', ...NO_PATTERNS, excludeSessionSources: ['cron', 'subagent'] });
    expect(r.sessionsExcluded).toBe(2);
    expect(r.excludedBySource).toEqual({ cron: 2 });
    expect(r.delegatesExcluded).toBe(0);
    expect(r.excludeLabelsMatched).toEqual(['cron', 'subagent']);
    expect(r.sessionsSkippedNoTimestamp).toBe(1);
    expect(r.sessionMetadataUnparsed).toBe(0);
    expect(r.sessionsImported).toBe(1);
    expect(r.files[0].diagnosticsApplied).toBe(true);
    // Through the command: no false "unmatched" for subagent.
    const out: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
    _resetCliExitVerdictForTests();
    try {
      await withEnv({ DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, () =>
        cli.runTranscripts(engine, ['ingest', path, '--format', 'hermes', '--source', 'default', '--dry-run', '--json', '--quiet', '--exclude-source', 'cron,subagent']));
    } finally {
      log.mockRestore();
      _resetCliExitVerdictForTests();
    }
    expect((JSON.parse(out.join('\n')) as { unmatched_exclude_sources: string[] }).unmatched_exclude_sources).toEqual([]);
  }, 60_000);
});

describe('runIngest end to end: flag > config key > default, refusal, watermark scope (PGLite, #8901)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => { await resetPgliteState(engine); });

  async function runCmd(args: string[]): Promise<{ out: string[]; err: string[]; verdict: number }> {
    const out: string[] = [];
    const err: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
    const errLog = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.map(String).join(' ')); });
    _resetCliExitVerdictForTests();
    let verdict = 0;
    try {
      await withEnv({ DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, () => cli.runTranscripts(engine, ['ingest', ...args]));
      verdict = currentExitCode();
    } finally {
      log.mockRestore();
      errLog.mockRestore();
      _resetCliExitVerdictForTests(); // a refusal sets the module-level CLI verdict; clear it for the next command
    }
    return { out, err, verdict };
  }
  async function ingestJson(path: string, extra: string[] = []): Promise<TranscriptsIngestResult> {
    const { out } = await runCmd([path, '--format', 'hermes', '--source', 'default', '--json', '--quiet', ...extra]);
    return JSON.parse(out.join('\n')) as TranscriptsIngestResult;
  }

  test('no flag, no key: the default set is applied through the command', async () => {
    const r = await ingestJson(buildHermesAutomationFixture(scratch()), ['--dry-run']);
    expect(r.excludedBySource).toEqual({ subagent: 2, kanban: 2, tool: 1 });
    expect(r.sessionsExcluded).toBe(5);
    expect(r.sessionsImported).toBe(ALL_IDS.length - 5);
  }, 60_000);

  // Value: protects=the default, the config key and the explicit-list scope apply on a run that omits --format (the scheduled-run shape, which auto-detects the Hermes store by its SQLite magic); fails_when=hermesPossible tightens to parsed.format === 'hermes', or the fingerprint keys the explicit list only under format 'hermes'; why_new=every other command-level run in this file names --format; seam=none; no_claim=does not cover --all discovery of the store
  test('without --format the auto-detected Hermes store takes the default, the key and the explicit-list scope', async () => {
    const path = buildHermesAutomationFixture(scratch());
    const auto = async (extra: string[]) => JSON.parse((await runCmd([path, '--source', 'default', '--json', '--quiet', ...extra])).out.join('\n')) as TranscriptsIngestResult;
    const byDefault = await auto(['--dry-run']);
    expect(byDefault.excludedBySource).toEqual({ subagent: 2, kanban: 2, tool: 1 });
    await engine.setConfig(cli.HERMES_EXCLUDE_SOURCES_CONFIG_KEY, '["cron"]');
    const byKey = await auto(['--dry-run']);
    expect(byKey.excludedBySource).toEqual({ cron: 1 });
    expect(byKey.sessionsExcluded).toBe(1);
    // An explicit list is part of the --since last scope on an auto-detected path too:
    // narrowing it starts a fresh scope that admits the re-admitted delegate sessions.
    const first = await auto(['--since', 'last', '--exclude-source', 'cron,subagent']);
    expect(first.sessionsImported).toBe(ALL_IDS.length - 3);
    for (const id of DELEGATE_IDS) expect(await engine.getPage(slugOf(id), { sourceId: 'default' })).toBeNull();
    const second = await auto(['--since', 'last', '--exclude-source', 'cron']);
    expect(second.sessionsFiltered).toBe(0);
    expect(second.excludedBySource).toEqual({ cron: 1 });
    for (const id of DELEGATE_IDS) expect(await engine.getPage(slugOf(id), { sourceId: 'default' })).not.toBeNull();
  }, 120_000);

  test('the config key replaces the default and the flag beats the key', async () => {
    await engine.setConfig(cli.HERMES_EXCLUDE_SOURCES_CONFIG_KEY, '["cron"]');
    const byKey = await ingestJson(buildHermesAutomationFixture(scratch()), ['--dry-run']);
    expect(byKey.excludedBySource).toEqual({ cron: 1 });
    const byFlag = await ingestJson(buildHermesAutomationFixture(scratch()), ['--dry-run', '--exclude-source', 'none']);
    expect(byFlag.sessionsExcluded).toBe(0);
    expect(byFlag.sessionsImported).toBe(ALL_IDS.length);
  }, 60_000);

  test('a config value that is not a list refuses the run instead of excluding nothing', async () => {
    await engine.setConfig(cli.HERMES_EXCLUDE_SOURCES_CONFIG_KEY, '{"sources":["cron"]}');
    const path = buildHermesAutomationFixture(scratch());
    const { out, err, verdict } = await runCmd([path, '--format', 'hermes', '--source', 'default', '--json', '--quiet']);
    expect(out).toEqual([]);
    expect(verdict).toBe(2);
    expect(err.join('\n')).toContain(`config ${cli.HERMES_EXCLUDE_SOURCES_CONFIG_KEY} is not a JSON array or comma list (got object)`);
    // A JSON-shaped value that does not parse and a JSON-quoted list that
    // names nothing are refused too, never read as "exclude nothing".
    await engine.setConfig(cli.HERMES_EXCLUDE_SOURCES_CONFIG_KEY, '["cron","subagent",]');
    expect((await runCmd([path, '--format', 'hermes', '--source', 'default', '--json', '--quiet'])).err.join('\n')).toContain('looks like JSON but does not parse');
    await engine.setConfig(cli.HERMES_EXCLUDE_SOURCES_CONFIG_KEY, ',');
    expect((await runCmd([path, '--format', 'hermes', '--source', 'default', '--json', '--quiet'])).err.join('\n')).toContain('lists no source labels');
    // An explicit codex run never reads the key, so a bad value does not refuse it.
    const codexRun = await runCmd([path, '--format', 'codex', '--source', 'default', '--json', '--quiet']);
    expect(codexRun.err.join('\n')).not.toContain('is not a JSON array');
    expect(codexRun.err.join('\n')).not.toContain('lists no source labels');
    const codexResult = JSON.parse(codexRun.out.join('\n')) as TranscriptsIngestResult;
    expect(codexResult.sessionsExcluded).toBe(0);
    expect(await engine.getPage(slugOf('desktop-root'), { sourceId: 'default' })).toBeNull();
    // The flag still works around a bad key for one run.
    const r = await ingestJson(path, ['--dry-run', '--exclude-source', 'cron']);
    expect(r.excludedBySource).toEqual({ cron: 1 });
  }, 60_000);

  // Value: protects=a non-Hermes adapter imports every session although the Hermes exclude set now rides the parse options of every run; fails_when=an adapter or the ingest loop filters on excludeSessionSources generically, or an adapter throws on the unknown option; why_new=the codex runs above point at a SQLite store and stop at detection, so no non-Hermes file is parsed with the set anywhere else; seam=none; no_claim=does not prove Hermes behaviour
  test('a non-Hermes adapter ignores the exclude set: codex imports the same sessions with and without it', async () => {
    const codexPath = join(import.meta.dir, 'fixtures', 'transcripts', 'codex-rollout.jsonl');
    const base = { paths: [codexPath], format: 'codex' as const, sourceId: 'default', ...NO_PATTERNS };
    const plain = await runTranscriptsIngest(engine, base);
    const withSet = await runTranscriptsIngest(engine, { ...base, excludeSessionSources: ['cron', 'subagent', 'codex'] });
    expect(plain.sessionsImported).toBeGreaterThan(0);
    expect(withSet.sessionsImported).toBe(plain.sessionsImported);
    expect(withSet.slugsTouched).toEqual(plain.slugsTouched);
    expect(withSet.sessionsExcluded).toBe(0);
    expect(withSet.excludedBySource).toEqual(plain.excludedBySource);
    const { out, err } = await runCmd([codexPath, '--format', 'codex', '--source', 'default', '--dry-run', '--json', '--quiet', '--exclude-source', 'cron']);
    const viaFlag = JSON.parse(out.join('\n')) as TranscriptsIngestResult;
    expect(viaFlag.sessionsImported).toBe(plain.sessionsImported);
    expect(viaFlag.sessionsExcluded).toBe(0);
    expect(err.join('\n')).toContain('--exclude-source applies to Hermes stores only; ignored for --format codex');
  }, 60_000);

  test('a config read failure refuses the run with verdict 1 and writes nothing; the flag skips the read', async () => {
    const path = buildHermesAutomationFixture(scratch());
    const spy = spyOn(engine, 'getConfig').mockRejectedValueOnce(new Error('boom'));
    try {
      const { out, err, verdict } = await runCmd([path, '--format', 'hermes', '--source', 'default', '--json', '--quiet']);
      expect(verdict).toBe(1);
      expect(out).toEqual([]);
      expect(err.join('\n')).toContain(`could not read config ${cli.HERMES_EXCLUDE_SOURCES_CONFIG_KEY}: boom`);
      expect(await engine.getPage(slugOf('desktop-root'), { sourceId: 'default' })).toBeNull();
      spy.mockClear();
      await runCmd([path, '--format', 'hermes', '--source', 'default', '--dry-run', '--json', '--quiet', '--exclude-source', 'cron']);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  test('a --limit stop before a second store is visited never calls a label unmatched; --json carries the re-admitted default members', async () => {
    const storeA = buildHermesAutomationFixture(scratch());
    const storeB = buildHermesAutomationFixture(scratch());
    const limited = JSON.parse((await runCmd([storeA, storeB, '--format', 'hermes', '--source', 'default', '--dry-run', '--limit', '1', '--json', '--quiet', '--exclude-source', 'cron,typo-label'])).out.join('\n')) as { files: unknown[]; unmatched_exclude_sources: string[]; readmitted_default_sources: string[] };
    expect(limited.files.length).toBeLessThan(2);
    expect(limited.unmatched_exclude_sources).toEqual([]);
    expect(limited.readmitted_default_sources).toEqual(['subagent', 'kanban', 'tool']);
    const full = JSON.parse((await runCmd([storeA, storeB, '--format', 'hermes', '--source', 'default', '--dry-run', '--json', '--quiet', '--exclude-source', 'cron,typo-label'])).out.join('\n')) as { files: unknown[]; unmatched_exclude_sources: string[]; readmitted_default_sources: string[] };
    expect(full.files.length).toBe(2);
    expect(full.unmatched_exclude_sources).toEqual(['typo-label']);
    const off = JSON.parse((await runCmd([storeA, '--format', 'hermes', '--source', 'default', '--dry-run', '--json', '--quiet', '--exclude-source', 'none'])).out.join('\n')) as { readmitted_default_sources: string[] };
    expect(off.readmitted_default_sources).toEqual(['subagent', 'kanban', 'tool']);
  }, 90_000);

  test('an explicit label that matched nothing is named in the human summary', async () => {
    const path = buildHermesAutomationFixture(scratch());
    const { out } = await runCmd([path, '--format', 'hermes', '--source', 'default', '--dry-run', '--exclude-source', 'cron,Subagent,typo-label']);
    const text = out.join('\n');
    expect(text).toContain('excluded: 1 automated session(s) by source (cron 1)');
    expect(text).toContain('note: 1 scanned session(s) had host metadata that did not parse; a delegate marker there could not be read');
    expect(text).toContain('note: no session matched --exclude-source label(s) Subagent, typo-label (labels are exact and case-sensitive)');
    // An explicit list replaces the default: the re-admitted default members are named.
    expect(text).toContain('note: --exclude-source replaces the default list; subagent, kanban, tool session(s) import on this run');
    // Under --limit the adapter's diagnostics never arrive, so no label is called a typo on partial evidence.
    const limited = JSON.parse((await runCmd([path, '--format', 'hermes', '--source', 'default', '--dry-run', '--limit', '1', '--json', '--quiet', '--exclude-source', 'cron,typo-label'])).out.join('\n')) as { unmatched_exclude_sources: string[]; sessionsExcluded: number };
    expect(limited.unmatched_exclude_sources).toEqual([]);
    // The flag with a non-Hermes explicit format is ignored, and says so.
    const codexFlag = await runCmd([path, '--format', 'codex', '--source', 'default', '--dry-run', '--json', '--quiet', '--exclude-source', 'cron']);
    expect(codexFlag.err.join('\n')).toContain('--exclude-source applies to Hermes stores only; ignored for --format codex');
    const quiet = await runCmd([path, '--format', 'hermes', '--source', 'default', '--dry-run', '--quiet', '--exclude-source', 'typo-label']);
    expect(quiet.out).toEqual([]);
    // Set through the key: named by the key, and carried in --json for scheduled runs.
    await engine.setConfig(cli.HERMES_EXCLUDE_SOURCES_CONFIG_KEY, '["typo-label","cron"]');
    const byKey = await runCmd([path, '--format', 'hermes', '--source', 'default', '--dry-run']);
    expect(byKey.out.join('\n')).toContain(`note: no session matched ${cli.HERMES_EXCLUDE_SOURCES_CONFIG_KEY} label(s) typo-label`);
    const json = JSON.parse((await runCmd([path, '--format', 'hermes', '--source', 'default', '--dry-run', '--json', '--quiet'])).out.join('\n')) as { unmatched_exclude_sources: string[] };
    expect(json.unmatched_exclude_sources).toEqual(['typo-label']);
  }, 60_000);

  test('--since last: changing an explicit list starts a fresh scope that admits the re-admitted sessions; the default has its own scope', async () => {
    const path = buildHermesAutomationFixture(scratch());
    const first = await ingestJson(path, ['--since', 'last', '--exclude-source', 'cron,subagent']);
    expect(first.sessionsImported).toBe(ALL_IDS.length - 3);
    expect(first.pages.imported).toBe(ALL_IDS.length - 3);
    expect(first.cleanScan).toBe(true);
    for (const id of DELEGATE_IDS) expect(await engine.getPage(slugOf(id), { sourceId: 'default' })).toBeNull();

    // Same store, same watermark key family, narrower explicit list: a fresh
    // scope, so nothing is filtered by the old watermark and the two delegate
    // sessions import.
    const second = await ingestJson(path, ['--since', 'last', '--exclude-source', 'cron']);
    expect(second.sessionsFiltered).toBe(0);
    expect(second.excludedBySource).toEqual({ cron: 1 });
    for (const id of DELEGATE_IDS) expect(await engine.getPage(slugOf(id), { sourceId: 'default' })).not.toBeNull();

    // The default policy is its own scope too: it never inherits an explicit
    // run's watermark (and an explicit run never inherits the default's).
    const third = await ingestJson(path, ['--since', 'last']);
    expect(third.sessionsFiltered).toBe(0);
    expect(third.excludedBySource).toEqual({ subagent: 2, kanban: 2, tool: 1 });

    // Within one scope the watermark holds, and the unparsed-metadata count
    // follows scanned sessions (the garbled row is below the watermark now).
    const fourth = await ingestJson(path, ['--since', 'last']);
    expect(fourth.sessionsFiltered).toBe(ALL_IDS.length - 5);
    expect(fourth.pages.imported).toBe(0);
    expect(third.sessionMetadataUnparsed).toBe(1);
    expect(fourth.sessionMetadataUnparsed).toBe(0);
  }, 120_000);
});
