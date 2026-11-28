/**
 * Lane 3 P3: `gbrain profile export` on repo-less keyless PGLite (no git, no embedding provider: a transport that fails
 * on any call is installed, so a model call fails the test).
 *
 * 1. Protects: only world-visible facts leave by default and private ones only with --include-private and a warning;
 *    the three formats; a Muse block replaces only the previous block, keeps the user's own lines and carries the
 *    standing line; a damaged destination is refused and left byte-for-byte as it was; an export read back by
 *    `profile import` skips GBrain's own block, and an import refuses a damaged block; a claim that mentions the marker
 *    text stays a bullet; --into merges the file as it is after the profile read and writes through a symlink.
 * 2. Fails when: a private fact is exported by default; a member's export carries the owner's profile; --into rewrites
 *    lines outside the block or a refused file.
 * 3. Real seams: operation handlers for the local CLI, OAuth client-credentials tokens through MCP dispatch for a
 *    member, and the real export command writing a real file.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
import type { ImportCall } from '../src/core/profile/import-run.ts';
import { PROFILE_CLAIM_CAP, type ProfileBlock, type ProfileFact } from '../src/core/profile/read.ts';
import { MUSE_STANDING_LINE, mergeMuseBlock, renderMarkdown, renderMemoryText, renderMuseBlock, selectFacts } from '../src/core/profile/export.ts';
import { planImport } from '../src/core/profile/import.ts';
import { parseExportArgs, runProfileExport } from '../src/commands/profile-export.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = Record<string, any>;
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const localCtx = (engine: BrainEngine): OperationContext =>
  ({ engine, config: { engine: engine.kind } as never, logger: quiet, dryRun: false, remote: false, sourceId: 'default' } as OperationContext);
const localCall = (engine: BrainEngine): ImportCall => async (tool, p) => await operationsByName[tool]!.handler(localCtx(engine), p) as R;
const refusal = async (fn: () => Promise<unknown>): Promise<R> => { try { await fn(); } catch (e) { return e as R; } throw new Error('not refused'); };

/** Runs the export in process and returns stdout, stderr and the parsed JSON document when --json was passed. */
async function exportCli(args: string[], call: ImportCall): Promise<{ out: string; err: string; json?: R }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ') + '\n'); });
  const error = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ') + '\n'); });
  const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; }) as never);
  try {
    await runProfileExport(args, call);
    const text = out.join('');
    return { out: text, err: err.join(''), ...(args.includes('--json') ? { json: JSON.parse(text) } : {}) };
  } finally { log.mockRestore(); error.mockRestore(); write.mockRestore(); }
}

const fact = (over: Partial<ProfileFact>): ProfileFact => ({ fact_id: '1', source_id: 'default', facet: 'diet', claim: 'Eats vegetarian',
  provenance: 'told me', content_origin: 'user_said', valid_from: '2026-11-01T00:00:00.000Z', visibility: 'world', confidence: 1, ...over });
const BLOCK: ProfileBlock = {
  entity: { slug: 'memory/owner', basis: 'reserved_page' },
  constraints: [fact({ fact_id: '2', facet: 'allergy', claim: 'Allergic to peanuts', visibility: 'private' })],
  facets: [fact({ fact_id: '1' }), fact({ fact_id: '3', facet: 'size.shoe', claim: '10 US', valid_from: '2026-10-02T00:00:00.000Z' })],
  preferences: [fact({ fact_id: '4', facet: null, claim: 'Prefers  window\nseats' })],
  relationships: [{ type: 'spouse', direction: 'out', slug: 'people/alice-example', context: null }], withheld: 0,
};

beforeAll(() => { __setEmbedTransportForTests((async () => { throw new Error('profile export makes no model call'); }) as never); });
afterAll(() => { __setEmbedTransportForTests(null); });

describe('renderers', () => {
  test('world-visible facts only unless private ones are asked for; relationships never leave', () => {
    const world = selectFacts(BLOCK, false);
    expect(world.facts.map(f => f.fact_id)).toEqual(['1', '3', '4']);
    expect(world.private_left_out).toBe(1);
    expect(selectFacts(BLOCK, true).facts.map(f => f.fact_id)).toEqual(['2', '1', '3', '4']);
    expect(renderMemoryText(world.facts)).toBe('[2026-11-01] - Eats vegetarian\n[2026-10-02] - 10 US\n[2026-11-01] - Prefers window seats\n');
    expect(renderMuseBlock(selectFacts(BLOCK, true).facts)).not.toContain('alice-example');
  });

  test('memory-text and the Muse block read back as the same facts and facets', () => {
    const all = selectFacts(BLOCK, true).facts;
    const text = planImport(renderMemoryText(all), 'auto');
    expect(text.format).toBe('memory-text');
    expect(text.items.map(i => [i.fact, i.valid_from])).toEqual([['Allergic to peanuts', '2026-11-01'], ['Eats vegetarian', '2026-11-01'], ['10 US', '2026-10-02'], ['Prefers window seats', '2026-11-01']]);
    const block = renderMuseBlock(all);
    expect(block.split('\n')[0]).toMatch(/^<!-- gbrain:profile begin rev=[0-9a-f]{12} -->$/);
    expect(block).toContain(`- ${MUSE_STANDING_LINE}`);
    expect(renderMuseBlock(all)).toBe(block);
    const inner = block.split('\n').slice(1, -1).join('\n');
    expect(planImport(inner, 'muse-memory').items.filter(i => i.fact !== MUSE_STANDING_LINE).map(i => [i.fact, i.facet]))
      .toEqual([['Allergic to peanuts', 'allergy'], ['Eats vegetarian', 'diet'], ['shoe: 10 US', 'size.shoe'], ['Prefers window seats', 'other']]);
  });

  test('an import of a Memory.md holding GBrain\'s block skips the block and keeps the user\'s own lines', () => {
    const file = mergeMuseBlock('# Memory\n\n## Food\n- Likes ramen\n', renderMuseBlock(selectFacts(BLOCK, true).facts)) + '- Drinks oat milk\n';
    const plan = planImport(file, 'auto');
    expect(plan.items.map(i => [i.fact, i.facet])).toEqual([['Likes ramen', 'diet'], ['Drinks oat milk', 'diet']]);
    expect(plan.dropped).toEqual([{ line: 6, reason: expect.stringMatching(/^GBrain's own exported block/) }]);
  });

  test('the block replaces only the previous block; damaged markers are refused', () => {
    const block = renderMuseBlock([fact({})]);
    expect(mergeMuseBlock('', block)).toBe(block + '\n');
    const first = mergeMuseBlock('# Memory\n- mine one\n', block);
    expect(first).toBe(`# Memory\n- mine one\n\n${block}\n`);
    const edited = first + '- mine two\n';
    const next = renderMuseBlock([fact({ claim: 'Eats vegan' })]);
    expect(mergeMuseBlock(edited, next)).toBe(`# Memory\n- mine one\n\n${next}\n- mine two\n`);
    const bad = (text: string) => { try { mergeMuseBlock(text, block); } catch (e) { return (e as R).code; } return 'accepted'; };
    expect(bad(first + block)).toBe('invalid_params');
    expect(bad('<!-- gbrain:profile end -->\n' + block)).toBe('invalid_params');
    expect(bad(block.split('\n').slice(0, -1).join('\n'))).toBe('invalid_params');
    expect(bad('<!-- gbrain:profile begin -->\n- x\n<!-- gbrain:profile end -->')).toBe('invalid_params');
    expect(bad('<!-- gbrain:profile end -->\n- x\n<!-- gbrain:profile begin rev=000000000000 -->')).toBe('invalid_params');
  });

  test('a claim that mentions the marker text is a bullet, not a marker, on export and on import', () => {
    const block = renderMuseBlock([fact({ claim: 'Keeps notes on gbrain:profile end markers' }), fact({ claim: 'Eats vegan', fact_id: '2' })]);
    const file = mergeMuseBlock('# Memory\n- mine one\n', block);
    expect(mergeMuseBlock(file, block)).toBe(file);
    expect(planImport(file + '- mine two\n', 'muse-memory').items.map(i => i.fact)).toEqual(['mine one', 'mine two']);
  });

  test('a fact a tool wrote keeps its label in the memory list and the Muse block', () => {
    const tool = fact({ claim: 'Prefers aisle seats', content_origin: 'tool_output', facet: null });
    expect(renderMemoryText([tool])).toBe('[2026-11-01] - Prefers aisle seats (from a tool, not confirmed by you)\n');
    expect(renderMuseBlock([tool])).toContain('- Prefers aisle seats (from a tool, not confirmed by you)');
    expect(renderMemoryText([fact({})])).toBe('[2026-11-01] - Eats vegetarian\n');
    // #10288: a fact with no event date exports as a plain item that imports back.
    expect(renderMemoryText([fact({ valid_from: '' })])).toBe('- Eats vegetarian\n');
    expect(planImport(renderMemoryText([fact({ valid_from: '' })]), 'memory-text').items.map(i => i.fact)).toEqual(['Eats vegetarian']);
  });

  test('a fact from an outside source keeps its label too, in every format', () => {
    const outside = fact({ claim: 'Likes jazz', content_origin: null, trust_tier: 'external_untrusted', facet: null });
    expect(renderMemoryText([outside])).toBe('[2026-11-01] - Likes jazz (from an outside source, not confirmed by you)\n');
    expect(renderMarkdown(BLOCK, [outside])).toContain('- Likes jazz (from an outside source, not confirmed by you)');
  });

  test('the GBrain block leaves the heading the user\'s later bullets sit under as it was', () => {
    const file = mergeMuseBlock('# Memory\n\n## Diet\n- Vegetarian\n', renderMuseBlock([fact({})])) + '- No dairy\n';
    expect(planImport(file, 'muse-memory').items.map(i => [i.fact, i.facet])).toEqual([['Vegetarian', 'diet'], ['No dairy', 'diet']]);
    const dated = mergeMuseBlock('[2026-01-01] - Likes tea\n', renderMuseBlock([fact({})])) + '[2026-01-02] - Likes coffee\n';
    const plan = planImport(dated, 'memory-text');
    expect(plan.items.map(i => i.fact)).toEqual(['Likes tea', 'Likes coffee']);
    expect(plan.dropped).toHaveLength(1);
  });

  test('marker lines inside a fenced code block are an example, not the block', () => {
    const example = '# Notes\n```markdown\n<!-- gbrain:profile begin rev=000000000000 -->\n- example\n<!-- gbrain:profile end -->\n```\n- mine\n';
    const block = renderMuseBlock([fact({})]);
    expect(mergeMuseBlock(example, block)).toBe(example.replace(/\n$/, '') + '\n\n' + block + '\n');
    expect(planImport(example, 'muse-memory').dropped.filter(d => d.reason.startsWith("GBrain's own"))).toEqual([]);
  });

  test('facts the credential cannot read and facts cut at the read limit are named, never dropped silently', async () => {
    const long = 'x'.repeat(PROFILE_CLAIM_CAP);
    const call: ImportCall = async () => ({ profile: { ...BLOCK, withheld: 2, preferences: [fact({ fact_id: '9', facet: null, claim: long })] } });
    const out = await exportCli(['--format', 'memory-text', '--include-private', '--json'], call);
    expect(out.json).toMatchObject({ withheld: 2, cut: 1 });
    expect(out.err).toContain('2 fact(s) this credential cannot read were not exported');
    expect(out.err).toContain(`cut at ${PROFILE_CLAIM_CAP}`);
  });

  test('an import refuses a file whose GBrain block has no end, instead of skipping the lines after it', () => {
    const refused = (() => { try { planImport('<!-- gbrain:profile begin rev=000000000000 -->\n- Likes tea\n', 'muse-memory'); } catch (e) { return e as R; } return null; })();
    expect(refused).toMatchObject({ code: 'invalid_params', message: expect.stringContaining('nothing was previewed') });
  });

  test('flags', () => {
    expect(parseExportArgs([])).toEqual({ error: 'Pass --format memory-text|muse-memory|markdown.' });
    expect(parseExportArgs(['--format', 'markdown', '--into', 'x.md'])).toMatchObject({ error: expect.stringContaining('only with --format muse-memory') });
    expect(parseExportArgs(['--format', 'muse-memory', '--into', 'x.md', '--include-private'])).toEqual({ format: 'muse-memory', into: 'x.md', includePrivate: true, json: false });
  });
});

describe('local export on a single-user keyless brain', () => {
  let engine: BrainEngine;
  let home: string;
  beforeAll(async () => {
    engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema();
    home = mkdtempSync(join(tmpdir(), 'gbrain-profile-export-'));
    const remember = localCall(engine);
    await remember('remember', { fact: 'Eats vegetarian canaryexportdiet', facet: 'diet', visibility: 'world', provenance: 'told me' });
    await remember('remember', { fact: 'Allergic to peanuts canaryexportallergy', facet: 'allergy', provenance: 'told me' });
  }, 60_000);
  afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

  test('the private allergy stays home by default and leaves only with --include-private and a warning', async () => {
    const plain = await exportCli(['--format', 'memory-text'], localCall(engine));
    expect(plain.out).toContain('canaryexportdiet');
    expect(plain.out).not.toContain('canaryexportallergy');
    expect(plain.err).toContain('1 private fact(s) left out');
    const all = await exportCli(['--format', 'markdown', '--include-private', '--json'], localCall(engine));
    expect(all.json).toMatchObject({ format: 'markdown', profile: 'memory/owner', exported: 2, private_included: 1, private_left_out: 0 });
    expect(all.json!.text).toContain('canaryexportallergy');
    expect(all.err).toContain("outside gbrain's access control");
  }, 60_000);

  test('--into keeps the user\'s lines and mode, replaces the block, and leaves a damaged file untouched', async () => {
    const file = join(home, 'Memory.md');
    writeFileSync(file, '# Memory\n- Likes ramen\n', { mode: 0o640 });
    const first = await exportCli(['--format', 'muse-memory', '--into', file, '--json'], localCall(engine));
    expect(first.json).toMatchObject({ exported: 1, into: file });
    const once = readFileSync(file, 'utf8');
    expect(once.startsWith('# Memory\n- Likes ramen\n\n<!-- gbrain:profile begin rev=')).toBe(true);
    expect(once).toContain('canaryexportdiet');
    expect(statSync(file).mode & 0o777).toBe(0o640);
    writeFileSync(file, once + '- Drinks oat milk\n');
    await exportCli(['--format', 'muse-memory', '--into', file], localCall(engine));
    expect(readFileSync(file, 'utf8')).toBe(once + '- Drinks oat milk\n');
    const damaged = once + once.slice(once.indexOf('<!--'));
    writeFileSync(file, damaged);
    const refused = await refusal(() => exportCli(['--format', 'muse-memory', '--into', file], localCall(engine)));
    expect(refused.code).toBe('invalid_params');
    expect(readFileSync(file, 'utf8')).toBe(damaged);
  }, 60_000);

  test('--into merges the file as it is after the profile read, and writes through a symlink to its target', async () => {
    const target = join(home, 'Target.md');
    const link = join(home, 'Linked.md');
    writeFileSync(target, '# Memory\n');
    symlinkSync(target, link);
    const call: ImportCall = async (tool, p) => { const out = await localCall(engine)(tool, p); appendFileSync(target, '- Written during the read\n'); return out; };
    await exportCli(['--format', 'muse-memory', '--into', link], call);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    const text = readFileSync(target, 'utf8');
    expect(text.startsWith('# Memory\n- Written during the read\n\n<!-- gbrain:profile begin rev=')).toBe(true);
  }, 60_000);

  test('--into a symlink whose target does not exist yet creates the target and keeps the link', async () => {
    const target = join(home, 'dotfiles-Memory.md');
    const link = join(home, 'Dangling.md');
    symlinkSync(target, link);
    await exportCli(['--format', 'muse-memory', '--into', link], localCall(engine));
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toContain('<!-- gbrain:profile begin rev=');
    expect(readdirSync(home).filter(n => n.endsWith('.tmp'))).toEqual([]);
  }, 60_000);

  test('--into follows a chain of symlinks to a target not yet created, and refuses a symlink loop', async () => {
    const target = join(home, 'chain-target.md');
    symlinkSync(target, join(home, 'chain-b.md'));
    symlinkSync(join(home, 'chain-b.md'), join(home, 'chain-a.md'));
    await exportCli(['--format', 'muse-memory', '--into', join(home, 'chain-a.md')], localCall(engine));
    expect(lstatSync(join(home, 'chain-b.md')).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toContain('<!-- gbrain:profile begin rev=');
    symlinkSync(join(home, 'loop-b.md'), join(home, 'loop-a.md'));
    symlinkSync(join(home, 'loop-a.md'), join(home, 'loop-b.md'));
    const refused = await refusal(() => exportCli(['--format', 'muse-memory', '--into', join(home, 'loop-a.md')], localCall(engine)));
    expect(refused).toMatchObject({ code: 'invalid_params', message: expect.stringContaining('symlink loop') });
  }, 60_000);

  test('--include-private makes the file owner-only, even when it was readable by others', async () => {
    const file = join(home, 'Shared.md');
    writeFileSync(file, '# Memory\n', { mode: 0o644 });
    chmodSync(file, 0o644);
    await exportCli(['--format', 'muse-memory', '--into', file, '--include-private'], localCall(engine));
    expect(readFileSync(file, 'utf8')).toContain('canaryexportallergy');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  }, 60_000);

  test('--into resolves a relative symlink against its real directory, and refuses a looping parent cleanly', async () => {
    const real = join(home, 'real-dir', 'profile');
    mkdirSync(real, { recursive: true });
    mkdirSync(join(home, 'real-dir', 'shared'));
    symlinkSync(real, join(home, 'muse-link'));
    symlinkSync('../shared/Memory.md', join(real, 'Memory.md'));
    await exportCli(['--format', 'muse-memory', '--into', join(home, 'muse-link', 'Memory.md')], localCall(engine));
    expect(readFileSync(join(home, 'real-dir', 'shared', 'Memory.md'), 'utf8')).toContain('<!-- gbrain:profile begin rev=');
    expect(existsSync(join(home, 'shared'))).toBe(false);
    symlinkSync(join(home, 'dir-loop-b'), join(home, 'dir-loop-a'));
    symlinkSync(join(home, 'dir-loop-a'), join(home, 'dir-loop-b'));
    const refused = await refusal(() => exportCli(['--format', 'muse-memory', '--into', join(home, 'dir-loop-a', 'Memory.md')], localCall(engine)));
    expect(refused.code).toBe('invalid_params');
  }, 60_000);

  test('--into refuses an incomplete profile read and leaves the file as it was', async () => {
    const file = join(home, 'Partial.md');
    writeFileSync(file, '# Memory\n- mine\n');
    const partial: ImportCall = async (tool, p) => { const out = await localCall(engine)(tool, p); return { ...out, profile: { ...(out.profile as R), partial: true } }; };
    const refused = await refusal(() => exportCli(['--format', 'muse-memory', '--into', file], partial));
    expect(refused.code).toBe('unavailable');
    expect(readFileSync(file, 'utf8')).toBe('# Memory\n- mine\n');
  }, 60_000);
});

describe('a member exports only its own profile (remote callers, repo-less)', () => {
  let engine: BrainEngine;
  const tokens: Record<string, string> = {};
  const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  const remote = (who: string): ImportCall => async (tool, params) => {
    const out = await dispatchToolCall(engine, tool, params, { remote: true, transport: 'http', sourceId: 'default',
      auth: await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo });
    const text = out.content.map(c => c.text).join('\n');
    if (out.isError) throw Object.assign(new Error(text), { code: /"code"\s*:\s*"([a-z_]+)"/.exec(text)?.[1] ?? 'error' });
    return JSON.parse(out.content[0]!.text) as R;
  };
  beforeAll(async () => {
    engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema();
    __resetPrivateVisibilityCacheForTests();
    for (const id of ['alice-example', 'owner-example']) await addMember(engine, id);
    await setOwner(engine, 'owner-example');
    const c = await provider().registerClientManual('p3-alice-' + randomUUID().slice(0, 8), ['client_credentials'], 'read write', [], 'default');
    await bindCredential(engine, { kind: 'client', id: c.clientId }, { member: 'alice-example' });
    tokens.alice = (await provider().exchangeClientCredentials(c.clientId, c.clientSecret ?? '')).access_token;
    await localCall(engine)('remember', { fact: 'Owner eats pescatarian canaryownerexport', facet: 'diet', visibility: 'world', provenance: 'told me' });
    await remote('alice')('remember', { fact: 'Runs trails canaryaliceexport', facet: 'other', provenance: 'told me' });
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  test('the member\'s export carries its own facts and none of the owner\'s', async () => {
    const out = await exportCli(['--format', 'markdown', '--include-private', '--json'], remote('alice'));
    expect(out.json).toMatchObject({ profile: 'memory/members/alice-example', exported: 1 });
    expect(out.json!.text).toContain('canaryaliceexport');
    expect(out.json!.text).not.toContain('canaryownerexport');
  }, 60_000);
});
