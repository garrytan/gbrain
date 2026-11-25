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
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { facetHint, planImport, previewHash, sniffFormat, IMPORT_BATCH } from '../src/core/profile/import.ts';
import { newReceipt, runImport, summarize, type ImportCall } from '../src/core/profile/import-run.ts';
import { loadReceipt, parseImportArgs, runProfileImport } from '../src/commands/profile-import.ts';
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
  const saved = process.exitCode;
  process.exitCode = 0;
  try {
    await runProfileImport(args, call, async () => ({ principal, profile }), home);
    return { out: lines.join('\n'), code: Number(process.exitCode ?? 0) };
  } finally { log.mockRestore(); process.exitCode = saved; }
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
  });
  test('facet hints and sniffing', () => {
    expect(facetHint('Dietary notes', 'No pork')).toBe('diet');
    expect(facetHint(null, 'Ring size 7')).toBe('size.ring');
    expect(facetHint(null, 'Likes jazz')).toBe('other');
    expect(sniffFormat('- a bullet')).toBe('muse-memory');
    expect(sniffFormat('[not json')).toBe('muse-memory');
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
