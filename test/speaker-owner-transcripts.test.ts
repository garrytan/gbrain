/**
 * GST-3216 PR 2: transcript importers mark the owner's turns (`speaker_owner`) only when the session itself shows a
 * person typed them: Claude Code's interactive terminal (`entrypoint: cli` on every user turn), Codex's CLI or IDE
 * session, and the owner's own ChatGPT or Claude export. An SDK or headless run, a worker session with no entrypoint,
 * a sub-agent and every other harness stay speaker-unknown. Repo-less PGLite, plus Postgres for the end-to-end path.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runTranscriptsIngest } from '../src/core/transcripts/ingest.ts';
import { claudeCodeAdapter } from '../src/core/transcripts/claude-code.ts';
import { codexAdapter } from '../src/core/transcripts/codex.ts';
import { renderSessionParts } from '../src/core/transcripts/render.ts';
import type { ParsedSession, TranscriptMessage } from '../src/core/transcripts/types.ts';
import { readSpeakerOwners } from '../src/core/identity/speaker-owner.ts';
import { addMember } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { bindMemberSource } from '../src/core/access/member-sources.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

setDefaultTimeout(60_000);

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'gb-speaker-owner-')); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** One Claude Code session file; `entrypoint` undefined leaves the key out, as a worker's records do. */
function claudeSession(name: string, entrypoints: Array<string | undefined>): string {
  const lines = entrypoints.flatMap((entrypoint, i) => {
    const ts = `2026-03-0${1}T10:0${i}:00.000Z`;
    const base = { parentUuid: null, isSidechain: false, sessionId: `session-${name}`, cwd: '/tmp/example', gitBranch: 'main', version: '2.4.1', userType: 'external' };
    return [
      { ...base, type: 'user', uuid: `u-${i}`, timestamp: ts, ...(entrypoint === undefined ? {} : { entrypoint }), message: { role: 'user', content: `question ${i} from the user` } },
      { ...base, type: 'assistant', uuid: `a-${i}`, timestamp: ts.replace(':00.000Z', ':30.000Z'), message: { role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }] } },
    ];
  });
  const path = join(dir, `${name}.jsonl`);
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

function codexSession(name: string, source: unknown): string {
  const lines = [
    { type: 'session_meta', timestamp: '2026-03-02T09:00:00.000Z', payload: { id: `codex-${name}`, cwd: '/tmp/example', timestamp: '2026-03-02T09:00:00.000Z', cli_version: '0.147.0', source } },
    { type: 'event_msg', timestamp: '2026-03-02T09:00:01.000Z', payload: { type: 'user_message', message: 'please fix the build' } },
    { type: 'event_msg', timestamp: '2026-03-02T09:00:02.000Z', payload: { type: 'agent_message', message: 'fixed' } },
  ];
  const path = join(dir, `${name}.jsonl`);
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

async function metaOf(adapter: typeof claudeCodeAdapter | typeof codexAdapter, path: string): Promise<ParsedSession['meta'] | null> {
  for await (const session of adapter.parse(path)) return session.meta;
  return null;
}

describe('adapters say whose the user turns are', () => {
  test('Claude Code: an interactive terminal session is the owner\'s', async () => {
    expect((await metaOf(claudeCodeAdapter, claudeSession('cli', ['cli', 'cli'])))?.ownerBasis).toBe('session_user');
  });

  test('Claude Code: an SDK run, a mixed session and a worker session with no entrypoint are speaker-unknown', async () => {
    expect((await metaOf(claudeCodeAdapter, claudeSession('sdk', ['sdk-ts', 'sdk-ts'])))?.ownerBasis).toBeUndefined();
    expect((await metaOf(claudeCodeAdapter, claudeSession('mixed', ['cli', 'sdk-cli'])))?.ownerBasis).toBeUndefined();
    // A worker agent's top-level session: userType external, isSidechain false, and no entrypoint on any record.
    expect((await metaOf(claudeCodeAdapter, claudeSession('worker', [undefined, undefined])))?.ownerBasis).toBeUndefined();
  });

  test('Codex: the CLI and the IDE extension are the owner\'s; exec and sub-agent rollouts are not', async () => {
    expect((await metaOf(codexAdapter, codexSession('cli', 'cli')))?.ownerBasis).toBe('session_user');
    expect((await metaOf(codexAdapter, codexSession('vscode', 'vscode')))?.ownerBasis).toBe('session_user');
    expect((await metaOf(codexAdapter, codexSession('exec', 'exec')))?.ownerBasis).toBeUndefined();
    expect((await metaOf(codexAdapter, codexSession('sub', { subagent: { thread_spawn: { parent_thread_id: 'p' } } })))?.ownerBasis).toBeUndefined();
  });
});

describe('the rendered marker', () => {
  const msg = (role: 'user' | 'assistant', text: string, speaker?: string): TranscriptMessage =>
    ({ role, text, timestamp: '2026-03-01T10:00:00.000Z', ...(speaker ? { speaker } : {}) });
  const render = (messages: TranscriptMessage[], ownerBasis?: 'session_user', member: string | null = null) =>
    renderSessionParts({ session: { meta: { harness: 'chatgpt', sessionId: 'render-1', ...(ownerBasis ? { ownerBasis } : {}) }, messages }, redactionCount: 0, imperativesFlagged: 0 },
      { sourcePath: '', owner: { member } }).parts[0]!.frontmatter.speaker_owner;

  test('names the user label and counts its turns', () => {
    expect(render([msg('user', 'a'), msg('assistant', 'b'), msg('user', 'c')], 'session_user', 'alice-example'))
      .toEqual({ label: 'User', basis: 'session_user', turns: 2, member: 'alice-example' });
  });

  test('no basis, two user labels, or an assistant under the same label: no marker', () => {
    expect(render([msg('user', 'a'), msg('assistant', 'b')])).toBeUndefined();
    expect(render([msg('user', 'a', 'Alice Example'), msg('user', 'b', 'Bob Example'), msg('assistant', 'c')], 'session_user')).toBeUndefined();
    expect(render([msg('user', 'a', 'Pat Example'), msg('assistant', 'b', 'Pat Example')], 'session_user')).toBeUndefined();
  });
});

for (const backend of testBackends()) describe(`[${backend}] transcripts ingest stamps speaker_owner (repo-less)`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  beforeAll(async () => {
    if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { const pg = new PGLiteEngine(); await pg.connect({ engine: 'pglite' } as never); await pg.initSchema(); engine = pg; close = () => pg.disconnect(); }
  }, 120_000);
  afterAll(async () => { await close?.(); }, 60_000);
  beforeEach(async () => {
    for (const sql of ['DELETE FROM access_member_sources', 'DELETE FROM access_members', 'DELETE FROM raw_data', 'DELETE FROM pages', "DELETE FROM config WHERE key = 'access.owner_member'"]) await engine.executeRaw(sql);
  });

  const ingest = (paths: string[]) => runTranscriptsIngest(engine, { paths, sourceId: 'default', userPatternsPath: '/nonexistent-patterns.txt' });
  const conversation = async (sessionId: string) => (await engine.executeRaw<{ slug: string; frontmatter: Record<string, unknown> }>(
    "SELECT slug, frontmatter FROM pages WHERE source_id = 'default' AND frontmatter->'transcript_import'->>'session_id' = $1", [sessionId]))[0]!;

  test('an interactive Claude Code session lands with a trusted marker naming the owner member', async () => {
    await addMember(engine, 'alice-example');
    await setOwner(engine, 'alice-example');
    const r = await ingest([claudeSession('e2e-cli', ['cli', 'cli', 'cli'])]);
    expect(r.pages.imported).toBe(1);
    const page = await conversation('session-e2e-cli');
    expect(page.frontmatter.speaker_owner).toEqual({ label: 'User', basis: 'session_user', turns: 3, member: 'alice-example' });
    expect((await readSpeakerOwners(engine, [{ source_id: 'default', slug: page.slug }]))[0]!.status).toBe('trusted');
  });

  test('on a brain other people share, only a source bound to one person marks the owner', async () => {
    await addMember(engine, 'alice-example');
    await addMember(engine, 'bob-example');
    await setOwner(engine, 'alice-example');
    await ingest([claudeSession('e2e-shared', ['cli', 'cli'])]);
    expect((await conversation('session-e2e-shared')).frontmatter.speaker_owner).toBeUndefined();
    await bindMemberSource(engine, 'alice-example', 'default');
    await ingest([claudeSession('e2e-bound', ['cli', 'cli'])]);
    const page = await conversation('session-e2e-bound');
    expect(page.frontmatter.speaker_owner).toEqual({ label: 'User', basis: 'session_user', turns: 2, member: 'alice-example' });
    expect((await readSpeakerOwners(engine, [{ source_id: 'default', slug: page.slug }]))[0]!.status).toBe('trusted');
  });

  test('a worker session with no entrypoint lands speaker-unknown', async () => {
    await ingest([claudeSession('e2e-worker', [undefined, undefined])]);
    const page = await conversation('session-e2e-worker');
    expect(page.frontmatter.speaker_owner).toBeUndefined();
    expect((await readSpeakerOwners(engine, [{ source_id: 'default', slug: page.slug }]))[0]!.status).toBe('absent');
  });

  test('re-import never adds the marker to a page imported before it, and never carries a marker someone else added', async () => {
    // A page written before speaker_owner existed: the same session, imported while no marker was stamped.
    await ingest([claudeSession('e2e-old', [undefined, undefined])]);
    expect((await conversation('session-e2e-old')).frontmatter.speaker_owner).toBeUndefined();
    const again = await ingest([claudeSession('e2e-old', ['cli', 'cli'])]);
    expect(again.pages.imported).toBe(0);
    expect((await conversation('session-e2e-old')).frontmatter.speaker_owner).toBeUndefined();

    const sdk = claudeSession('e2e-sdk', ['sdk-ts', 'sdk-ts']);
    await ingest([sdk]);
    const sdkPage = await conversation('session-e2e-sdk');
    await engine.executeRaw("UPDATE pages SET frontmatter = frontmatter || $2::jsonb WHERE source_id = 'default' AND slug = $1",
      [sdkPage.slug, JSON.stringify({ speaker_owner: { label: 'User', basis: 'session_user', turns: 2 } })]);
    writeFileSync(sdk, readFileSync(sdk, 'utf8') + JSON.stringify({ parentUuid: null, isSidechain: false, sessionId: 'session-e2e-sdk', type: 'user', uuid: 'u-9', entrypoint: 'sdk-ts', timestamp: '2026-03-01T11:00:00.000Z', message: { role: 'user', content: 'one more' } }) + '\n');
    await ingest([sdk]);
    const rewritten = await conversation('session-e2e-sdk');
    expect(rewritten.frontmatter.speaker_owner).toBeUndefined();
  });
});
