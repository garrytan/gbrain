/**
 * Lane 3 P2: `gbrain profile import` on repo-less keyless PGLite (no git, no embedding provider: a transport that fails
 * on any call is installed, so a model call fails the test).
 *
 * 1. Protects: the three parsers and --format auto; credential-shaped lines dropped before the preview and never
 *    printed; the preview hash binds the parse and the target; apply refuses a changed preview; every fact lands
 *    private and inferred on the caller's own profile through remember batches; a re-run and a resume write nothing
 *    twice; a pending item is polled to its end; an import never supersedes a fact the user said.
 * 2. Fails when: a member's import reaches the owner's profile; a resume sends a different file or to another profile;
 *    apply runs without the preview's hash, or with a TTY prompt in a scripted run.
 * 3. Real seams: operation handlers for the local CLI, OAuth client-credentials tokens through MCP dispatch for a
 *    member, and the real CLI in a subprocess with no TTY.
 */
import { afterAll, beforeAll, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, operationsByName, type OperationContext } from '../src/core/operations.ts';
import { __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { batchParams, facetHint, planImport, previewHash, sniffFormat, IMPORT_BATCH } from '../src/core/profile/import.ts';
import { allowedOpNames } from '../src/mcp/surface.ts';
import { newReceipt, runImport, summarize, type ImportCall } from '../src/core/profile/import-run.ts';
import { loadReceipt, parseImportArgs, runProfileImport, saveReceipt } from '../src/commands/profile-import.ts';
import { localPrincipal } from '../src/commands/profile.ts';
import { run as runProfileCli } from '../src/cli/commands/profile.ts';
import { makeContext } from '../src/cli/main.ts';
import { RemoteMcpError } from '../src/core/remote-mcp-error.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { runCli } from './helpers/cli-spawn.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = Record<string, any>;
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const localCtx = (engine: BrainEngine): OperationContext =>
  ({ engine, config: { engine: engine.kind } as never, logger: quiet, dryRun: false, remote: false, sourceId: 'default' } as OperationContext);
const localCall = (engine: BrainEngine): ImportCall => async (tool, p) => await operationsByName[tool]!.handler(localCtx(engine), p) as R;
const refusal = async (fn: () => Promise<unknown>): Promise<R> => { try { await fn(); } catch (e) { return e as R; } throw new Error('not refused'); };
const rows = (engine: BrainEngine, needle: string) => engine.executeRaw<R>(
  "SELECT id, entity_slug, claim_metric, visibility, write_origin->>'content_origin' AS origin, expired_at, superseded_by, valid_from FROM facts WHERE fact LIKE $1 ORDER BY id",
  ['%' + needle + '%']);
const count = async (engine: BrainEngine) => Number((await engine.executeRaw<R>('SELECT COUNT(*) AS n FROM facts'))[0]!.n);
/** A token-shaped string built at run time, so no literal credential sits in the repository. */
const FAKE_TOKEN = 'ghp_' + 'Zq7Rk2Lm9Xw4'.repeat(3);

/** Runs a CLI-level import in process and returns what it printed and the exit code it set. */
async function cli(args: string[], call: ImportCall, profile: string, home: string, principal = 'local:test'): Promise<{ out: string; code: number }> {
  const lines: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  _resetCliExitVerdictForTests();
  try {
    await runProfileImport(args, call, async () => ({ principal, profile }), home);
    return { out: lines.join('\n'), code: currentExitCode() };
  } finally { log.mockRestore(); _resetCliExitVerdictForTests(); process.exitCode = 0; }
}

beforeAll(() => { __setEmbedTransportForTests((async () => { throw new Error('profile import makes no model call'); }) as never); });
afterAll(() => { __setEmbedTransportForTests(null); });

const MUSE = [
  '# Memory', '', '## Allergies', '- Allergic to peanuts canarymusepeanut', '', '## Food', '- Eats vegetarian canarymuseveg',
  '## Sizes', '- Shoe: 10 US canarymuseshoe', '- Prefers window seats canarymusewindow', '- prefers window seats CANARYMUSEWINDOW',
  '## Notes', `- My GitHub token is ${FAKE_TOKEN}`, '- Jacket size M canarymusejacket',
].join('\n');

describe('parsers', () => {
  test('muse-memory: headings name the facet, duplicates collapse, a credential line is dropped and never printed', () => {
    const plan = planImport(MUSE, 'auto');
    expect(plan.format).toBe('muse-memory');
    expect(plan.items.map(i => [i.line, i.facet])).toEqual([[4, 'allergy'], [7, 'diet'], [9, 'size.shoe'], [10, 'other'], [14, 'size.jacket']]);
    expect(plan.dropped).toHaveLength(1);
    expect(plan.dropped[0]!.line).toBe(13);
    expect(plan.dropped[0]!.reason).toStartWith('credential-shaped (');
    expect(JSON.stringify(plan)).not.toContain(FAKE_TOKEN);
  });
  test('memory-text: the date becomes valid_from; an allergy names its facet without a heading', () => {
    const plan = planImport('Here are my memories:\n[2026-01-05] - Allergic to shellfish\n[2026-02-01] – Works at acme-example\n\nThat is all.', 'auto');
    expect(plan.format).toBe('memory-text');
    expect(plan.items).toEqual([
      { line: 2, fact: 'Allergic to shellfish', facet: 'allergy', valid_from: '2026-01-05' },
      { line: 3, fact: 'Works at acme-example', facet: 'other', valid_from: '2026-02-01' },
    ]);
    expect(plan.dropped).toEqual([{ line: 1, reason: 'not a dated memory or list item' }, { line: 5, reason: 'not a dated memory or list item' }]);
  });
  test('an impossible date is not sent as valid_from; the fact is kept', () => {
    expect(planImport('[2024-02-30] - Moved house\n[2024-13-01] - Got a dog', 'memory-text').items).toEqual([
      { line: 1, fact: 'Moved house', facet: 'other' }, { line: 2, fact: 'Got a dog', facet: 'other' }]);
    expect(planImport(JSON.stringify([{ content: 'Bought a bike', created_at: '2024-02-30T10:00:00Z' }]), 'auto').items).toEqual([{ line: 1, fact: 'Bought a bike', facet: 'other' }]);
  });
  test('muse-memory: a prose line is named as dropped, never skipped silently', () => {
    const plan = planImport('## Theater\nLoves musicals, especially revivals.\n- Season tickets at the playhouse', 'muse-memory');
    expect(plan.items).toEqual([{ line: 3, fact: 'Season tickets at the playhouse', facet: 'other' }]);
    expect(plan.dropped).toEqual([{ line: 2, reason: 'not a list item' }]);
  });
  test('claude-memories: an array of memories, a {memories} document and a conversations_memory summary', () => {
    const arr = JSON.stringify([{ content: 'Prefers dark roast coffee', created_at: '2026-03-01T10:00:00Z' }, { memory: 'Household of three', category: 'Family' }]);
    expect(sniffFormat(arr)).toBe('claude-memories');
    expect(planImport(arr, 'auto').items).toEqual([
      { line: 1, fact: 'Prefers dark roast coffee', facet: 'other', valid_from: '2026-03-01' },
      { line: 2, fact: 'Household of three', facet: 'household' },
    ]);
    const doc = JSON.stringify({ memories: [{ text: 'Runs on weekday mornings' }] });
    expect(planImport(doc, 'claude-memories').items.map(i => i.fact)).toEqual(['Runs on weekday mornings']);
    const summary = JSON.stringify([{ conversations_memory: '**Work**\n- Leads a small team\n- Allergic to latex' }]);
    expect(planImport(summary, 'auto').items.map(i => [i.fact, i.facet])).toEqual([['Leads a small team', 'other'], ['Allergic to latex', 'allergy']]);
    const prose = JSON.stringify([{ conversations_memory: '**Work context**\nRuns a small design studio.\n\n**Food**\nCooks vegetarian most nights.' }]);
    expect(planImport(prose, 'auto').items.map(i => [i.fact, i.facet])).toEqual([['Runs a small design studio.', 'other'], ['Cooks vegetarian most nights.', 'diet']]);
  });
  test('claude-memories: a compact array of strings is detected; a JSON shape with no memories is named, not imported as empty', () => {
    const compact = '["Likes tea","Allergic to latex"]';
    expect(sniffFormat(compact)).toBe('claude-memories');
    expect(planImport(compact, 'auto').items.map(i => [i.line, i.fact, i.facet])).toEqual([[1, 'Likes tea', 'other'], [2, 'Allergic to latex', 'allergy']]);
    const other = planImport('{"settings":{"theme":"dark"}}', 'auto');
    expect(other.items).toEqual([]);
    expect(other.dropped).toEqual([{ line: 1, reason: expect.stringMatching(/^no memories found/) }]);
  });
  test('the same words under two headings are kept once per facet', () => {
    const plan = planImport('## Food\n- Peanuts canarytwoheads\n## Allergies\n- Peanuts canarytwoheads\n- peanuts CANARYTWOHEADS', 'muse-memory');
    expect(plan.items.map(i => [i.line, i.facet])).toEqual([[2, 'diet'], [4, 'allergy']]);
  });
  test('a JSON file that is null or a bare value names no memories; invalid JSON is refused before anything is sent', () => {
    for (const text of ['null', '7', '"just text"']) {
      const plan = planImport(text, 'claude-memories');
      expect(plan.items).toEqual([]);
      expect(plan.dropped).toEqual([{ line: 1, reason: expect.stringMatching(/^no memories found/) }]);
    }
    let err: R | undefined;
    try { planImport('{"memories": [', 'claude-memories'); } catch (e) { err = e as R; }
    expect(err?.code).toBe('invalid_params');
    expect(String(err?.message)).toContain('not valid JSON');
    let bare: R | undefined;
    try { planImport('{"memories": [' + FAKE_TOKEN + ']}', 'claude-memories'); } catch (e) { bare = e as R; }
    expect(bare?.code).toBe('invalid_params');
    expect(JSON.stringify({ message: bare?.message, fix: bare?.fix, suggestion: bare?.suggestion })).not.toContain(FAKE_TOKEN);
  });
  test('facet hints and sniffing', () => {
    expect(facetHint('Dietary notes', 'No pork')).toBe('diet');
    expect(facetHint(null, 'Ring size 7')).toBe('size.ring');
    expect(facetHint(null, 'Likes jazz')).toBe('other');
    for (const heading of ['Theater', 'Creative projects', 'Weather', 'Seating', 'Homework']) expect(facetHint(heading, 'Something')).toBe('other');
    expect(facetHint('Eating out', 'Likes ramen')).toBe('diet');
    expect(facetHint('Home', 'Two cats')).toBe('household');
    expect(sniffFormat('- a bullet')).toBe('muse-memory');
    expect(sniffFormat('[not json')).toBe('muse-memory');
  });
  test('a credential split across lines is dropped whole in every format and never printed', () => {
    const value = 'Qz7#vLp2!rTx9wKm' + 'Hd4%';
    const claude = planImport(JSON.stringify({ memories: [{ conversations_memory: `Work notes\nVPN password:\n${value}` }, { content: 'Likes tea' }] }), 'claude-memories');
    expect(claude.items.map(i => i.fact)).toEqual(['Likes tea']);
    expect(claude.dropped).toEqual([{ line: 1, reason: expect.stringMatching(/^credential-shaped/) }]);
    const pemBody = Array.from({ length: 4 }, (_, i) => 'MIIEv' + String(i).repeat(3) + 'QIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7' + i).join('\n');
    const pem = `- Keeps notes\n-----BEGIN ${'PRIVATE'} KEY-----\n${pemBody}\n-----END ${'PRIVATE'} KEY-----\n- Likes tea`;
    for (const fmt of ['muse-memory', 'memory-text'] as const) {
      const plan = planImport(pem, fmt);
      expect(plan.items.map(i => i.fact)).toEqual(['Keeps notes', 'Likes tea']);
      expect(JSON.stringify(plan)).not.toContain('QIBADANBgkqhkiG9w0');
    }
    const labelled = planImport(`- VPN password:\n- ${value}\n- Likes tea`, 'muse-memory');
    expect(labelled.items.map(i => i.fact)).toEqual(['VPN password:', 'Likes tea']);
    expect(labelled.dropped).toEqual([{ line: 2, reason: 'credential-shaped (labeled_credential)' }]);
    expect(JSON.stringify(labelled)).not.toContain(value);
  });
  test('an oversized line is dropped by line', () => {
    const plan = planImport('- ' + 'x'.repeat(2001) + '\n- short canaryshort', 'muse-memory');
    expect(plan.items.map(i => i.line)).toEqual([2]);
    expect(plan.dropped).toEqual([{ line: 1, reason: 'longer than 2000 characters' }]);
  });
});

describe('preview binding', () => {
  const plan = planImport(MUSE, 'auto');
  const owner = { principal: 'local:/home/a/.gbrain', profile: 'memory/owner' };
  test('the hash is stable and changes with the file, the parse, the profile or the principal', () => {
    expect(previewHash(plan, owner)).toBe(previewHash(planImport(MUSE, 'muse-memory'), { ...owner }));
    expect(previewHash(plan, owner)).toMatch(/^[0-9a-f]{16}$/);
    for (const other of [
      previewHash(planImport(MUSE + '\n- one more', 'auto'), owner),
      previewHash(planImport(MUSE, 'memory-text'), owner),
      previewHash(plan, { ...owner, profile: 'memory/members/alice-example' }),
      previewHash(plan, { ...owner, principal: 'remote:https://brain.example/mcp#c1' }),
    ]) expect(other).not.toBe(previewHash(plan, owner));
  });
  test('the printed apply line quotes a file name with spaces; --source is repeated in the apply and resume commands', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain profile import quote-'));
    try {
      const file = join(dir, 'my memories.md');
      writeFileSync(file, '- Likes jazz canaryquote');
      const apply = (await cli([file], async () => ({}), 'memory/owner', dir)).out.split('\n').find(l => l.startsWith('Apply: '))!;
      expect(apply).toContain(`'${file}'`);
      expect(parseImportArgs([file, '--source', 'notes-example'])).toMatchObject({ file, source: 'notes-example' });
      const p = JSON.parse((await cli([file, '--source', 'notes-example', '--json'], async () => ({}), 'memory/owner', dir)).out);
      expect(p.apply_argv.slice(-2)).toEqual(['--source', 'notes-example']);
      const r = newReceipt(planImport('- Likes jazz canaryquote', 'auto'), p.preview, file, { principal: 'local:test', profile: 'memory/owner' }, 'test');
      const path = join(dir, 'receipt.json');
      saveReceipt(path, r);
      const shown = JSON.parse((await cli(['--status', path, '--source', 'notes-example', '--json'], async () => ({}), 'memory/owner', dir)).out);
      expect(shown.resume_argv.slice(-2)).toEqual(['--source', 'notes-example']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('the flags: apply needs --yes with --preview; one mode at a time', () => {
    expect(parseImportArgs(['f.md'])).toMatchObject({ file: 'f.md', format: 'auto', yes: false });
    expect(parseImportArgs(['f.md', '--yes', '--preview', 'abc', '--format', 'memory-text'])).toMatchObject({ yes: true, preview: 'abc', format: 'memory-text' });
    for (const bad of [['f.md', '--yes'], ['f.md', '--preview', 'abc'], [], ['f.md', '--status', 'r.json'], ['f.md', '--format', 'chatgpt'], ['f.md', '--preview'], ['a', 'b']])
      expect(parseImportArgs(bad)).toHaveProperty('error');
  });
});

describe('local import on a single-user keyless brain', () => {
  let engine: BrainEngine;
  let home: string;
  beforeAll(async () => {
    engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema();
    home = mkdtempSync(join(tmpdir(), 'gbrain-profile-import-'));
  }, 60_000);
  afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

  test('preview writes nothing; apply needs the hash; facts land private and inferred on memory/owner; a re-run writes nothing', async () => {
    const file = join(home, 'Memory.md');
    writeFileSync(file, MUSE);
    const before = await count(engine);
    const preview = await cli([file, '--json'], localCall(engine), 'memory/owner', home);
    const p = JSON.parse(preview.out);
    expect(p).toMatchObject({ format: 'muse-memory', profile: 'memory/owner', items: 5, by_facet: { allergy: 1, diet: 1, other: 1, 'size.shoe': 1, 'size.jacket': 1 } });
    expect(p.dropped).toEqual([{ line: 13, reason: expect.stringMatching(/^credential-shaped/) }]);
    expect(p.facts.map((f: R) => [f.line, f.facet])).toEqual([[4, 'allergy'], [7, 'diet'], [9, 'size.shoe'], [10, 'other'], [14, 'size.jacket']]);
    expect(preview.out).not.toContain(FAKE_TOKEN);
    expect(p.apply_argv.slice(-3)).toEqual(['--yes', '--preview', p.preview]);
    expect(await count(engine)).toBe(before);

    const stale = await refusal(() => cli([file, '--yes', '--preview', '0000000000000000'], localCall(engine), 'memory/owner', home));
    expect(stale.code).toBe('preview_changed');
    const otherProfile = await refusal(() => cli([file, '--yes', '--preview', p.preview], localCall(engine), 'memory/members/alice-example', home));
    expect(otherProfile.code).toBe('preview_changed');
    expect(await count(engine)).toBe(before);

    const applied = await cli([file, '--yes', '--preview', p.preview, '--json'], localCall(engine), 'memory/owner', home);
    expect(applied.code).toBe(0);
    const a = JSON.parse(applied.out);
    expect(a).toMatchObject({ complete: true, batches: { committed: 1 }, items: { inserted: 5 }, failed: [] });
    expect(statSync(a.receipt).mode & 0o777).toBe(0o600);
    const landed = await rows(engine, 'canarymuse');
    expect(landed).toHaveLength(5);
    for (const r of landed) expect(r).toMatchObject({ entity_slug: 'memory/owner', visibility: 'private', origin: 'inferred' });
    expect(landed.map(r => r.claim_metric)).toEqual(['profile.allergy', 'profile.diet', 'profile.size.shoe', 'profile.other', 'profile.size.jacket']);
    const after = await count(engine);

    rmSync(a.receipt);
    const again = JSON.parse((await cli([file, '--yes', '--preview', p.preview, '--json'], localCall(engine), 'memory/owner', home)).out);
    expect(again.complete).toBe(true);
    expect(await count(engine)).toBe(after);
    const status = JSON.parse((await cli(['--status', a.receipt, '--json'], localCall(engine), 'memory/owner', home)).out);
    expect(status).toMatchObject({ preview: p.preview, complete: true });
  }, 120_000);

  test('an interrupted apply resumes from its receipt, sends each item once, and refuses a changed file', async () => {
    const file = join(home, 'memories.txt');
    const lines = Array.from({ length: IMPORT_BATCH * 2 + 5 }, (_, i) => `[2026-04-${String((i % 28) + 1).padStart(2, '0')}] - Resume fact ${i} canaryresume`);
    writeFileSync(file, lines.join('\n'));
    const hash = JSON.parse((await cli([file, '--json'], localCall(engine), 'memory/owner', home)).out).preview;
    let sent = 0;
    const flaky: ImportCall = async (tool, p) => {
      if (tool === 'remember' && ++sent === 2) throw Object.assign(new Error('socket hang up'), { code: 'network_error' });
      return localCall(engine)(tool, p);
    };
    const first = await cli([file, '--yes', '--preview', hash, '--json'], flaky, 'memory/owner', home);
    const r1 = JSON.parse(first.out);
    expect(first.code).toBe(1);
    expect(r1.batches).toEqual({ committed: 1, failed: 1, not_started: 1 });
    expect(r1.resume_argv).toEqual(['gbrain', 'profile', 'import', '--resume', r1.receipt]);
    expect(r1.batch_errors).toEqual([{ batch: 1, code: 'network_error', message: 'socket hang up' }]);
    expect(await rows(engine, 'canaryresume')).toHaveLength(IMPORT_BATCH);

    const resumed = await cli(['--resume', r1.receipt, '--json'], localCall(engine), 'memory/owner', home);
    expect(resumed.code).toBe(0);
    expect(JSON.parse(resumed.out)).toMatchObject({ complete: true, batches: { committed: 3 } });
    const landed = await rows(engine, 'canaryresume');
    expect(landed).toHaveLength(lines.length);
    expect(landed[0]!.valid_from.toISOString().slice(0, 10)).toBe('2026-04-01');

    writeFileSync(file, lines.concat('[2026-05-01] - Added later canaryresume').join('\n'));
    const changed = await refusal(() => cli(['--resume', r1.receipt], localCall(engine), 'memory/owner', home));
    expect(changed.code).toBe('preview_changed');
    writeFileSync(file, lines.join('\n'));
    const wrongProfile = await refusal(() => cli(['--resume', r1.receipt], localCall(engine), 'memory/members/alice-example', home));
    expect(wrongProfile.code).toBe('preview_changed');
    expect(await rows(engine, 'canaryresume')).toHaveLength(lines.length);
  }, 180_000);

  test('applying the same preview again on a later day, with its receipt gone, replays instead of being refused', async () => {
    const file = join(home, 'later.md');
    writeFileSync(file, '- Keeps a sourdough starter canarylater\n- Plays chess on Sundays canarylater');
    const hash = JSON.parse((await cli([file, '--json'], localCall(engine), 'memory/owner', home)).out).preview;
    const first = JSON.parse((await cli([file, '--yes', '--preview', hash, '--json'], localCall(engine), 'memory/owner', home)).out);
    expect(first.complete).toBe(true);
    expect(loadReceipt(first.receipt).provenance).toBe(`imported from later.md (muse-memory), preview ${hash}`);
    rmSync(first.receipt);
    const before = await count(engine);
    setSystemTime(new Date(Date.now() + 3 * 86_400_000));
    try {
      const again = await cli([file, '--yes', '--preview', hash, '--json'], localCall(engine), 'memory/owner', home);
      expect(again.code).toBe(0);
      expect(JSON.parse(again.out)).toMatchObject({ complete: true, failed: [] });
    } finally { setSystemTime(); }
    expect(await count(engine)).toBe(before);
  }, 60_000);

  test('an import never retires an unfaceted fact the user said in the same words', async () => {
    const said = await localCall(engine)('remember', { fact: 'Allergic to shellfish canaryplainsaid', provenance: 'told me 2026-11-25', content_origin: 'user_said', visibility: 'private' });
    const file = join(home, 'plain.md');
    writeFileSync(file, '## Allergies\n- Allergic to shellfish canaryplainsaid');
    const hash = JSON.parse((await cli([file, '--json'], localCall(engine), 'memory/owner', home)).out).preview;
    const out = JSON.parse((await cli([file, '--yes', '--preview', hash, '--json'], localCall(engine), 'memory/owner', home)).out);
    expect(out.complete).toBe(true);
    const all = await rows(engine, 'canaryplainsaid');
    expect(all.find(r => String(r.id) === String(said.id))).toMatchObject({ origin: 'user_said', expired_at: null, superseded_by: null });
    expect(all.filter(r => r.expired_at === null && r.superseded_by === null)).toHaveLength(all.length);
  }, 60_000);
  test('a starter-surface client may send the import batch, content_origin included', async () => {
    const plan = planImport('## Food\n- Likes figs canarystarter', 'muse-memory');
    const res = await dispatchToolCall(engine, 'remember', batchParams(plan, 'starterhash', 0, plan.items, 'imported (test)'),
      { remote: true, transport: 'stdio', surface: 'starter', allowedOps: allowedOpNames(operations, 'starter'), sourceId: 'default' });
    expect(res.isError ?? false).toBe(false);
    expect((await rows(engine, 'canarystarter'))[0]).toMatchObject({ origin: 'inferred', visibility: 'private' });
  }, 60_000);
  test('a starter-surface client cannot label a fact user_said, at the top or in an item; the full surface still can', async () => {
    const starter = { remote: true, transport: 'stdio' as const, surface: 'starter' as const, allowedOps: allowedOpNames(operations, 'starter'), sourceId: 'default' };
    const before = await count(engine);
    for (const params of [
      { fact: 'Says it is vegan canarystartersaid', provenance: 'told me', content_origin: 'user_said' },
      { provenance: 'told me', items: [{ fact: 'Says it is vegan canarystartersaid', content_origin: 'user_said' }] },
    ]) {
      const res = await dispatchToolCall(engine, 'remember', params, starter);
      expect(res.isError).toBe(true);
      const body = JSON.parse(res.content[0]!.text) as R;
      expect(body.code).toBe('param_not_on_surface');
      expect(body.message).toContain('content_origin "user_said"');
      expect(body.suggestion).toContain('content_origin inferred or tool_output');
    }
    expect(await count(engine)).toBe(before);
    const tool = await dispatchToolCall(engine, 'remember', { fact: 'Read in a tool canarystartertool', provenance: 'a tool', content_origin: 'tool_output' }, starter);
    expect(tool.isError ?? false).toBe(false);
    const full = await dispatchToolCall(engine, 'remember', { fact: 'Says it is vegan canarystartersaid', provenance: 'told me', content_origin: 'user_said' },
      { remote: true, transport: 'stdio', surface: 'full', allowedOps: allowedOpNames(operations, 'full'), sourceId: 'default' });
    expect(full.isError ?? false).toBe(false);
    expect((await rows(engine, 'canarystartersaid'))[0]).toMatchObject({ origin: 'user_said' });
  }, 60_000);
  test('an import never supersedes a fact the user said', async () => {
    const said = await localCall(engine)('remember', { fact: 'Eats pescatarian canarysaid', facet: 'diet', provenance: 'told me 2026-11-25', content_origin: 'user_said' });
    const file = join(home, 'said.md');
    writeFileSync(file, '## Diet\n- Eats vegan canarysaidimport\n- Eats pescatarian canarysaid');
    const hash = JSON.parse((await cli([file, '--json'], localCall(engine), 'memory/owner', home)).out).preview;
    const out = JSON.parse((await cli([file, '--yes', '--preview', hash, '--json'], localCall(engine), 'memory/owner', home)).out);
    expect(out.complete).toBe(true);
    const kept = (await rows(engine, 'canarysaid')).find(r => String(r.id) === String(said.id))!;
    expect(kept).toMatchObject({ origin: 'user_said', expired_at: null, superseded_by: null });
    expect((await rows(engine, 'canarysaidimport'))[0]).toMatchObject({ origin: 'inferred', expired_at: null });
  }, 60_000);
});

describe('the local CLI binds the brain it writes and writes as the user', () => {
  let a: BrainEngine;
  let b: BrainEngine;
  beforeAll(async () => {
    a = new PGLiteEngine(); await a.connect({ engine: 'pglite' } as never); await a.initSchema();
    b = new PGLiteEngine(); await b.connect({ engine: 'pglite' } as never); await b.initSchema();
  }, 120_000);
  afterAll(async () => { await a.disconnect(); await b.disconnect(); });
  const ctxFor = (target: string) => async (engine: BrainEngine, params: Record<string, unknown>) =>
    ({ ...(await makeContext(engine, params)), config: { engine: 'pglite', database_path: target } } as OperationContext);
  const out = async (fn: () => Promise<void>) => {
    const lines: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((...x: unknown[]) => { lines.push(x.join(' ')); });
    _resetCliExitVerdictForTests();
    try { await fn(); return lines.join('\n'); } finally { log.mockRestore(); _resetCliExitVerdictForTests(); process.exitCode = 0; }
  };

  test('the principal names the brain, a digest of its database and the source, never the database itself', async () => {
    const base = localCtx(a);
    const url = ['postgres://user-example', 'hunter2-example@db.example:5432/brain'].join(':');
    const p = await localPrincipal({ ...base, brainId: 'host', config: { engine: 'postgres', database_url: url } as never });
    expect(p).toMatch(/^local:host:[0-9a-f]{12}#default$/);
    expect(p).not.toContain('hunter2');
    for (const other of [
      { ...base, brainId: 'host', config: { engine: 'postgres', database_url: url.replace('/brain', '/brain2') } as never },
      { ...base, brainId: 'work-example', config: { engine: 'postgres', database_url: url } as never },
      { ...base, brainId: 'host', sourceId: 'notes-example', config: { engine: 'postgres', database_url: url } as never },
    ]) expect(await localPrincipal(other as OperationContext)).not.toBe(p);
  });

  test('a preview from one brain cannot apply to another; the apply is admitted as the user\'s interactive write', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-profile-import-brains-'));
    try {
      const file = join(home, 'Memory.md');
      writeFileSync(file, '- Grows tomatoes canarybrains');
      const pa = JSON.parse(await out(() => runProfileCli(a, ['import', file, '--json'], { makeContext: ctxFor('/brains/a.pglite') } as never)));
      const pb = JSON.parse(await out(() => runProfileCli(b, ['import', file, '--json'], { makeContext: ctxFor('/brains/b.pglite') } as never)));
      expect(pa.preview).not.toBe(pb.preview);
      const wrong = await refusal(() => out(() => runProfileCli(b, ['import', file, '--yes', '--preview', pa.preview], { makeContext: ctxFor('/brains/b.pglite') } as never)));
      expect(wrong.code).toBe('preview_changed');
      expect(await rows(b, 'canarybrains')).toHaveLength(0);
      const origins: unknown[] = [];
      const remember = operationsByName.remember!;
      const handler = remember.handler;
      const spy = spyOn(remember, 'handler').mockImplementation(async (ctx, p) => { origins.push(ctx.admissionOrigin); return handler(ctx, p); });
      try {
        const applied = JSON.parse(await out(() => runProfileCli(a, ['import', file, '--yes', '--preview', pa.preview, '--json'], { makeContext: ctxFor('/brains/a.pglite') } as never)));
        expect(applied.complete).toBe(true);
      } finally { spy.mockRestore(); }
      expect(origins.length).toBeGreaterThan(0);
      expect(new Set(origins)).toEqual(new Set(['interactive']));
      expect(await rows(a, 'canarybrains')).toHaveLength(1);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 120_000);
  test('--source reaches the context the local import writes through', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-profile-import-source-'));
    try {
      const file = join(home, 'Memory.md');
      writeFileSync(file, '- Grows basil canarysource');
      const seen: unknown[] = [];
      const spyCtx = async (engine: BrainEngine, params: Record<string, unknown>) => { seen.push(params.source); return ctxFor('/brains/a.pglite')(engine, params); };
      const p = JSON.parse(await out(() => runProfileCli(a, ['import', file, '--source', 'default', '--json'], { makeContext: spyCtx } as never)));
      expect(seen).toEqual(['default']);
      expect(p.apply_argv.slice(-2)).toEqual(['--source', 'default']);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 60_000);
});

describe('progress receipt', () => {
  test('a pending item is polled by its request id; a failed item is reported and never retried', async () => {
    const plan = planImport('- Fact one\n- Fact two', 'muse-memory');
    const target = { principal: 'local:test', profile: 'memory/owner' };
    const receipt = newReceipt(plan, previewHash(plan, target), '/tmp/x.md', target, 'imported');
    const calls: string[] = [];
    let polled = 0;
    const fake: ImportCall = async (tool, p) => {
      calls.push(tool);
      if (tool === 'remember') return { items: [{ index: 0, request_id: 'child-0', status: 'pending' }, { index: 1, request_id: 'child-1', status: 'failed', error: { code: 'invalid_params', message: 'bad' } }] };
      expect(p).toEqual({ request_id: 'child-0' });
      return ++polled === 1 ? { state: 'publishing' } : { state: 'committed', outcome: { status: 'inserted', id: '42' } };
    };
    const saves: number[] = [];
    await runImport(plan, receipt, fake, r => saves.push(r.batches[0]!.items.length));
    expect(receipt.batches[0]!.state).toBe('pending');
    await runImport(plan, receipt, fake, () => {});
    expect(receipt.batches[0]!.state).toBe('pending');
    await runImport(plan, receipt, fake, () => {});
    expect(receipt.batches[0]!.state).toBe('partial');
    expect(receipt.batches[0]!.items).toEqual([
      { line: 1, request_id: 'child-0', status: 'inserted', fact_id: '42' },
      { line: 2, request_id: 'child-1', status: 'failed', error: { code: 'invalid_params', message: 'bad' } },
    ]);
    await runImport(plan, receipt, fake, () => {});
    expect(calls).toEqual(['remember', 'get_write_request', 'get_write_request']);
    expect(saves.length).toBeGreaterThan(0);
    expect(summarize(receipt)).toMatchObject({ complete: true, failed: [{ line: 2 }] });
  });
  test('a write that ended in conflict is reported failed, not left pending', async () => {
    const plan = planImport('- Fact one', 'muse-memory');
    const target = { principal: 'local:test', profile: 'memory/owner' };
    const receipt = newReceipt(plan, previewHash(plan, target), '/tmp/x.md', target, 'imported');
    const fake: ImportCall = async (tool) => tool === 'remember'
      ? { items: [{ index: 0, request_id: 'c0', status: 'pending' }] }
      : { state: 'conflict', error_code: 'write_conflict', error_message: 'the page moved' };
    await runImport(plan, receipt, fake, () => {});
    await runImport(plan, receipt, fake, () => {});
    expect(receipt.batches[0]!.state).toBe('partial');
    expect(receipt.batches[0]!.items[0]).toMatchObject({ status: 'failed', error: { code: 'write_conflict' } });
  });
  test('one refused line costs only itself: the rest of its batch is sent again under its own request id', async () => {
    const plan = planImport(Array.from({ length: IMPORT_BATCH + 1 }, (_, i) => `- Fact ${i}`).join('\n'), 'muse-memory');
    const target = { principal: 'local:test', profile: 'memory/owner' };
    const receipt = newReceipt(plan, previewHash(plan, target), '/tmp/x.md', target, 'imported');
    const sent: Array<{ id: string; n: number }> = [];
    const fake: ImportCall = async (_tool, p) => {
      const items = p.items as unknown[];
      sent.push({ id: String(p.request_id), n: items.length });
      if (sent.length === 1) throw Object.assign(new Error('items[3].valid_from must be an ISO date'), { code: 'invalid_params' });
      return { items: items.map((_, index) => ({ index, request_id: `c${sent.length}-${index}`, status: 'inserted', id: String(index) })) };
    };
    await runImport(plan, receipt, fake, () => {});
    expect(sent.map(s => s.n)).toEqual([IMPORT_BATCH, IMPORT_BATCH - 1, 1]);
    expect(sent[1]!.id).toBe(`${receipt.batches[0]!.request_id}-r1`);
    expect(receipt.batches.map(b => b.state)).toEqual(['partial', 'committed']);
    expect(receipt.batches[0]!.items.map(i => i.line)).toEqual(plan.items.slice(0, IMPORT_BATCH).map(i => i.line));
    expect(receipt.batches[0]!.items.filter(i => i.status === 'failed')).toEqual([{ line: plan.items[3]!.line, request_id: '', status: 'failed', error: { code: 'invalid_params', message: 'items[3].valid_from must be an ISO date' } }]);
    await runImport(plan, receipt, fake, () => {});
    expect(sent).toHaveLength(3);
  });
  test('a resumed write is read from its receipt fields: write_error, a hold for review, a lost or unknown admission', async () => {
    const plan = planImport('- Fact one\n- Fact two\n- Fact three\n- Fact four', 'muse-memory');
    const target = { principal: 'local:test', profile: 'memory/owner' };
    const receipt = newReceipt(plan, previewHash(plan, target), '/tmp/x.md', target, 'imported');
    const fake: ImportCall = async (tool, p) => {
      if (tool === 'remember') return { items: [
        { index: 0, request_id: 'c0', status: 'pending' }, { index: 1, request_id: 'c1', status: 'pending' },
        { index: 2, request_id: 'c2', status: 'failed', error: { code: 'write_outcome_unknown', message: 'the connection dropped', write_error: 'write_outcome_unknown' } },
        { index: 3, status: 'pending' }] };
      if (p.request_id === 'c0') return { state: 'conflict', write_error: 'write_conflict', write_error_message: 'the page moved' };
      if (p.request_id === 'c1') return { state: 'committed', outcome: { status: 'held', hold_ref: 'h7', gate: { next: { argv: ['gbrain', 'trust', 'release', 'h7'] } } } };
      throw Object.assign(new Error('No accessible write request has that request_id.'), { code: 'not_found' });
    };
    await runImport(plan, receipt, fake, () => {});
    expect(receipt.batches[0]!.state).toBe('pending');
    expect(receipt.batches[0]!.items.map(i => i.status)).toEqual(['pending', 'pending', 'pending', 'failed']);
    expect(receipt.batches[0]!.items[3]!.error!.code).toBe('write_outcome_unknown');
    await runImport(plan, receipt, fake, () => {});
    expect(receipt.batches[0]!.state).toBe('partial');
    const [conflict, held, lost] = receipt.batches[0]!.items;
    expect(conflict).toMatchObject({ status: 'failed', error: { code: 'write_conflict', message: 'the page moved' } });
    expect(held).toMatchObject({ status: 'failed', error: { code: 'write_held' } });
    expect(held!.error!.message).toContain('h7');
    expect(held!.error!.message).toContain('gbrain trust release h7');
    expect(lost).toMatchObject({ status: 'failed', error: { code: 'write_outcome_unknown' } });
    expect(summarize(receipt)).toMatchObject({ complete: true, items: { failed: 4 } });
  });
  test('a line the write gate holds costs only itself, inside a batch or as the whole batch, and names its release command', async () => {
    const plan = planImport(Array.from({ length: IMPORT_BATCH + 1 }, (_, i) => `- Fact ${i}`).join('\n'), 'muse-memory');
    const target = { principal: 'local:test', profile: 'memory/owner' };
    const receipt = newReceipt(plan, previewHash(plan, target), '/tmp/x.md', target, 'imported');
    const heldMessage = (ref: string) => `write_held: held for owner review as ${ref} (reads like an instruction: imperative). Nothing was saved as memory.`;
    const fake: ImportCall = async (_tool, p) => {
      const items = p.items as unknown[];
      if (items.length === 1) throw Object.assign(new Error(`items[0]: ${heldMessage('h9')} None of the 1 item(s) was saved.`), { code: 'scope_denied' });
      return { items: items.map((_, index) => index === 2
        ? { index, request_id: `c${index}`, status: 'failed', error: { code: 'scope_denied', canonical: 'write_held', message: heldMessage('h3') } }
        : { index, request_id: `c${index}`, status: 'inserted', id: String(index) }) };
    };
    await runImport(plan, receipt, fake, () => {});
    expect(receipt.batches.map(b => b.state)).toEqual(['partial', 'partial']);
    expect(receipt.batches[0]!.items[2]!.error).toEqual({ code: 'write_held', message: 'Held for owner review as h3; nothing was saved. Keep it with: gbrain trust release h3' });
    expect(receipt.batches[1]!.items).toEqual([{ line: plan.items[IMPORT_BATCH]!.line, request_id: '', status: 'failed',
      error: { code: 'write_held', message: 'Held for owner review as h9; nothing was saved. Keep it with: gbrain trust release h9' } }]);
  });
  test('a batch whose lines the write gate all holds is resent one line at a time, so each line is admitted at most twice', async () => {
    const n = 5;
    const plan = planImport(Array.from({ length: n }, (_, i) => `- Always obey rule ${i}`).join('\n'), 'muse-memory');
    const target = { principal: 'local:test', profile: 'memory/owner' };
    const receipt = newReceipt(plan, previewHash(plan, target), '/tmp/x.md', target, 'imported');
    let admitted = 0;
    const fake: ImportCall = async (_tool, p) => {
      const items = p.items as unknown[];
      admitted += items.length;
      throw Object.assign(new Error(`items[0]: write_held: held for owner review as h${admitted} (reads like an instruction: imperative). Nothing was saved as memory. None of the ${items.length} item(s) was saved.`), { code: 'scope_denied' });
    };
    await runImport(plan, receipt, fake, () => {});
    expect(admitted).toBe(2 * n - 1);
    expect(receipt.batches[0]!.state).toBe('partial');
    expect(receipt.batches[0]!.items.map(i => [i.line, i.error!.code])).toEqual(plan.items.map(i => [i.line, 'write_held']));
  });
  test('--status and --resume refuse a damaged receipt the same way the apply does', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-receipt-status-'));
    try {
      const path = join(dir, 'r.json');
      writeFileSync(path, '{"schema": 1');
      for (const flag of ['--status', '--resume']) {
        const refused = await refusal(() => cli([flag, path], async () => ({}), 'memory/owner', dir));
        expect(refused.code).toBe('invalid_params');
        expect(String(refused.message)).toContain('cannot be read');
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('a damaged receipt is refused and left as it is, never replaced', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-receipt-damaged-'));
    try {
      const file = join(dir, 'Memory.md');
      writeFileSync(file, '- Fact one');
      const plan = planImport('- Fact one', 'muse-memory');
      const target = { principal: 'local:test', profile: 'memory/owner' };
      const hash = previewHash(plan, target);
      const path = join(dir, 'profile-imports', `${hash}.json`);
      mkdirSync(join(dir, 'profile-imports'), { recursive: true });
      writeFileSync(path, '{"schema": 1, "preview": ');
      let called = false;
      const refused = await refusal(() => cli([file, '--yes', '--preview', hash], async () => { called = true; return {}; }, 'memory/owner', dir));
      expect(refused.code).toBe('invalid_params');
      expect(String(refused.message)).toContain('cannot be read');
      expect(called).toBe(false);
      expect(readFileSync(path, 'utf8')).toBe('{"schema": 1, "preview": ');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('a batch-level refusal that names no line stays failed and is sent again on resume', async () => {
    const plan = planImport('- Fact one', 'muse-memory');
    const target = { principal: 'local:test', profile: 'memory/owner' };
    const receipt = newReceipt(plan, previewHash(plan, target), '/tmp/x.md', target, 'imported');
    let n = 0;
    const fake: ImportCall = async () => {
      if (++n === 1) throw Object.assign(new Error('visibility is not supported'), { code: 'invalid_params' });
      return { items: [{ index: 0, request_id: 'c0', status: 'inserted', id: '1' }] };
    };
    await runImport(plan, receipt, fake, () => {});
    expect(receipt.batches[0]).toMatchObject({ state: 'failed', error: { code: 'invalid_params' } });
    await runImport(plan, receipt, fake, () => {});
    expect(receipt.batches[0]!.state).toBe('committed');
  });
  test('a thin client\'s line-level refusal (RemoteMcpError detail.code) records the lines and moves on', async () => {
    const plan = planImport(Array.from({ length: IMPORT_BATCH + 1 }, (_, i) => `- Fact ${i}`).join('\n'), 'muse-memory');
    const target = { principal: 'remote:https://brain.example/mcp#c1', profile: 'memory/members/alice-example' };
    const receipt = newReceipt(plan, previewHash(plan, target), '/tmp/x.md', target, 'imported');
    let n = 0;
    const remote: ImportCall = async () => {
      if (++n === 1) throw new RemoteMcpError('tool_error', 'items[4].fact is empty', { code: 'invalid_params' });
      return { items: [{ index: 0, request_id: 'c20', status: 'inserted', id: '9' }] };
    };
    await runImport(plan, receipt, remote, () => {});
    expect(receipt.batches.map(b => b.state)).toEqual(['partial', 'committed']);
    expect(receipt.batches[0]!.items.find(i => i.line === plan.items[4]!.line)!.error).toEqual({ code: 'invalid_params', message: 'items[4].fact is empty' });
  });
  test('a receipt is replaced whole, never rewritten in place', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-receipt-'));
    try {
      const plan = planImport('- Fact one', 'muse-memory');
      const target = { principal: 'local:test', profile: 'memory/owner' };
      const path = join(dir, 'profile-imports', 'r.json');
      const first = newReceipt(plan, previewHash(plan, target), '/tmp/x.md', target, 'imported');
      saveReceipt(path, first);
      linkSync(path, join(dir, 'before.json'));
      saveReceipt(path, { ...first, batches: first.batches.map(b => ({ ...b, state: 'committed' as const })) });
      expect(loadReceipt(join(dir, 'before.json')).batches[0]!.state).toBe('not_started');
      expect(loadReceipt(path).batches[0]!.state).toBe('committed');
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readdirSync(join(dir, 'profile-imports'))).toEqual(['r.json']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('a file that is not a receipt is refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-receipt-'));
    try {
      writeFileSync(join(dir, 'r.json'), '{"schema":2}');
      expect(() => loadReceipt(join(dir, 'r.json'))).toThrow('not a profile import receipt');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('a member imports onto its own profile (remote callers, repo-less)', () => {
  let engine: BrainEngine;
  let home: string;
  const tokens: Record<string, string> = {};
  const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  const remote = (who: string): ImportCall => async (tool, params) => {
    const out = await dispatchToolCall(engine, tool, params, { remote: true, transport: 'http', sourceId: 'default',
      auth: await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo });
    const text = out.content.map(c => c.text).join('\n');
    if (out.isError) throw Object.assign(new Error(text), { code: /"code"\s*:\s*"([a-z_]+)"/.exec(text)?.[1] ?? 'error' });
    return JSON.parse(out.content[0]!.text) as R;
  };
  const ownerIds = async () => {
    const block = (await localCall(engine)('context_pack', { profile: true })).profile as R;
    return ['facets', 'constraints', 'preferences'].flatMap(k => block[k].map((f: R) => f.fact_id)).sort();
  };

  beforeAll(async () => {
    engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema();
    __resetPrivateVisibilityCacheForTests();
    home = mkdtempSync(join(tmpdir(), 'gbrain-profile-import-member-'));
    for (const id of ['alice-example', 'owner-example']) await addMember(engine, id);
    await setOwner(engine, 'owner-example');
    for (const [name, member] of [['alice', 'alice-example'], ['owner', 'owner-example']] as const) {
      const c = await provider().registerClientManual('p2-' + name + '-' + randomUUID().slice(0, 8), ['client_credentials'], 'read write', [], 'default');
      await bindCredential(engine, { kind: 'client', id: c.clientId }, { member });
      tokens[name] = (await provider().exchangeClientCredentials(c.clientId, c.clientSecret ?? '')).access_token;
    }
    await localCall(engine)('remember', { fact: 'Owner eats pescatarian canaryownerdiet', facet: 'diet', provenance: 'told me' });
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

  test('the facts land private on the member page; the owner profile is untouched, even when the client names it', async () => {
    const file = join(home, 'Memory.md');
    writeFileSync(file, '## Allergies\n- Allergic to kiwi canaryaliceimport\n- Likes trail running canaryaliceimport');
    const self = ((await remote('alice')('context_pack', { profile: true, budget_tokens: 1 })).profile as R).entity.slug;
    expect(self).toBe('memory/members/alice-example');
    const ownerBefore = await ownerIds();
    const hash = JSON.parse((await cli([file, '--json'], remote('alice'), self, home, 'remote:https://brain.example/mcp#alice')).out).preview;
    const out = await cli([file, '--yes', '--preview', hash, '--json'], remote('alice'), self, home, 'remote:https://brain.example/mcp#alice');
    expect(JSON.parse(out.out)).toMatchObject({ complete: true, items: { inserted: 2 } });
    for (const r of await rows(engine, 'canaryaliceimport')) expect(r).toMatchObject({ entity_slug: 'memory/members/alice-example', visibility: 'private', origin: 'inferred' });
    expect(await ownerIds()).toEqual(ownerBefore);

    const forged = join(home, 'forged.md');
    writeFileSync(forged, '- Owner secretly likes opera canaryforgedimport');
    const owner = ((await localCall(engine)('context_pack', { profile: true })).profile as R).entity.slug;
    const fh = JSON.parse((await cli([forged, '--json'], remote('alice'), owner, home, 'remote:https://brain.example/mcp#alice')).out).preview;
    await cli([forged, '--yes', '--preview', fh, '--json'], remote('alice'), owner, home, 'remote:https://brain.example/mcp#alice');
    const forgedRows = await rows(engine, 'canaryforgedimport');
    expect(forgedRows).toHaveLength(1);
    expect(forgedRows[0]!.entity_slug).toBe('memory/members/alice-example');
    expect(await ownerIds()).toEqual(ownerBefore);
    expect(JSON.stringify((await remote('alice')('context_pack', { profile: true })).profile)).not.toContain('canaryownerdiet');
  }, 120_000);
});

describe('the real CLI with no TTY', () => {
  let home: string;
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-profile-import-cli-'));
    const init = await runCli(['init', '--pglite', '--no-embedding', '--json'], { home });
    if (init.exitCode !== 0) throw new Error(`init failed: ${init.stdout}\n${init.stderr}`);
  }, 180_000);
  afterAll(() => { rmSync(home, { recursive: true, force: true }); });

  test('a thin client refuses --brain and --source before anything is sent', async () => {
    const thin = mkdtempSync(join(tmpdir(), 'gbrain-profile-import-thin-'));
    try {
      mkdirSync(join(thin, '.gbrain'));
      writeFileSync(join(thin, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(thin, '.gbrain', 'brain.pglite'), remote_mcp: {
        issuer_url: 'http://127.0.0.1:9', mcp_url: 'http://127.0.0.1:9/mcp', oauth_client_id: 'fixture', oauth_client_secret: 'fixture' } }));
      const file = join(thin, 'memories.txt');
      writeFileSync(file, '[2026-01-05] - Likes figs canarythin');
      const env = { GBRAIN_NO_BANNER: '1', GBRAIN_MODEL_DISCOVERY: 'off' };
      const brain = await runCli(['--brain', 'work-example', 'profile', 'import', file], { home: thin, cwd: thin, timeoutMs: 20_000, env });
      expect(brain.exitCode).not.toBe(0);
      expect(brain.stdout + brain.stderr).toContain('--brain is not supported on a thin-client install');
      const source = await runCli(['profile', 'import', file, '--source', 'notes-example'], { home: thin, cwd: thin, timeoutMs: 20_000, env });
      expect(source.exitCode).not.toBe(0);
      expect(source.stdout + source.stderr).toContain('does not accept --source on a thin-client install');
    } finally { rmSync(thin, { recursive: true, force: true }); }
  }, 60_000);
  test('preview, then --yes --preview applies without a prompt; apply without the hash refuses', async () => {
    const file = join(home, 'memories.txt');
    writeFileSync(file, '[2026-01-05] - Allergic to sesame canarycli\n[2026-01-06] - Prefers aisle seats canarycli');
    const preview = await runCli(['profile', 'import', file, '--json'], { home });
    expect(preview.exitCode).toBe(0);
    const p = JSON.parse(preview.stdout);
    expect(p).toMatchObject({ format: 'memory-text', profile: 'memory/owner', items: 2 });
    const bare = await runCli(['profile', 'import', file, '--yes'], { home });
    expect(bare.exitCode).not.toBe(0);
    expect(bare.stdout + bare.stderr).toContain('--preview');
    const applied = await runCli(['profile', 'import', file, '--yes', '--preview', p.preview, '--json'], { home });
    expect(applied.exitCode).toBe(0);
    const a = JSON.parse(applied.stdout);
    expect(a).toMatchObject({ complete: true, items: { inserted: 2 } });
    expect(existsSync(a.receipt)).toBe(true);
    expect(JSON.parse(readFileSync(a.receipt, 'utf8')).target.principal).toStartWith('local:');
    const shown = await runCli(['profile', '--json'], { home });
    expect(JSON.parse(shown.stdout).constraints.map((f: R) => f.claim)).toEqual(['Allergic to sesame canarycli']);
  }, 240_000);
});
