/**
 * GBRA-218 (PR A2): per-folder read access, the database store and the predicate.
 *
 * 1. Protects: a page under a folder rule is read remotely only by a credential
 *    whose member satisfies every rule whose prefix the slug starts with
 *    (nested member and group rules both pass); unbound credentials, other
 *    members, granted_sources bots and both escape hatches read nothing there.
 *    Narrowing applies at once; widening (a rule removed, readers added) is
 *    held until a previewed, hash-bound gbrain access apply. Pages under a
 *    narrowing still being stamped read as nobody.
 * 2. Fails when: a folder-ruled page leaks to an unlisted caller on a read
 *    path or under a hatch; a widening applies without approval; an
 *    interrupted narrowing leaves pages readable under the old rules; a page
 *    written, renamed or derived during or after an apply escapes its rules.
 * 3. Existing coverage (member-read-access) pins page-level readable_by only.
 * 4. Real seams: tokens minted by the token service, verified by the serve
 *    --http verifier, dispatched through MCP dispatch; rule edits through the
 *    CLI module and the policy engine; a repo-less brain (no git checkout, the
 *    default keyless install), and Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { parseRescopeTokenArgs, rescopeLegacyToken } from '../src/core/grants/legacy-token.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { classifyRulebook, folderRulesAllow, heldRuleId, matchingRuleIds, parsePolicyYaml, ruleIdForPrefix, serializePolicyYaml, type FolderRule } from '../src/core/access/folder-rules.ts';
import { applyApproved, policySeams, policyStatus, previewApply, proposeRevision, resumePolicy } from '../src/core/access/policy.ts';
import { runAccessRules } from '../src/commands/access-rules.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const DIMS = 1536;
function vectorFor(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % DIMS] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}

const rule = (id: string, prefix: string, readers: string[]): FolderRule => ({ id, prefix, readable_by: readers.map(r => (r.includes(':') ? r : `member:${r}`)).sort() });

describe('folder-rule grammar', () => {
  test('a valid file parses, omitted ids derive from the prefix, and serialize round-trips', () => {
    const parsed = parsePolicyYaml('version: 1\nrules:\n  - prefix: partners/alice-example/\n    readable_by: [alice-example, group:team-a]\n  - id: team\n    prefix: partners/\n    readable_by: group:team-a\n');
    expect(parsed).toEqual({ ok: true, rules: [rule('partners-alice-example', 'partners/alice-example/', ['alice-example', 'group:team-a']), rule('team', 'partners/', ['group:team-a'])] });
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsePolicyYaml(serializePolicyYaml(parsed.rules))).toEqual(parsed);
    expect(ruleIdForPrefix('a/'.repeat(40)).length).toBeLessThanOrEqual(64);
    expect(parsePolicyYaml('')).toEqual({ ok: true, rules: [] });
  });

  test('patterns, upper case, missing slashes, traversal, bad readers and duplicates are refused with a line', () => {
    const bad = (text: string) => { const p = parsePolicyYaml(text); if (p.ok) throw new Error(`accepted: ${text}`); return p; };
    for (const prefix of ['partners/*/', 'Partners/', 'partners', '../x/', '/partners/', 'a//b/']) {
      expect(bad(`version: 1\nrules:\n  - prefix: "${prefix}"\n    readable_by: alice-example\n`).problems[0]!.line).toBe(3);
    }
    expect(bad('version: 1\nrules:\n  - prefix: notes/\n    readable_by: [Not Valid]\n').prefixes).toEqual(['notes/']);
    const dup = bad('version: 1\nrules:\n  - id: a\n    prefix: x/\n    readable_by: alice-example\n  - id: a\n    prefix: y/\n    readable_by: alice-example\n');
    expect(dup.problems.map(p => p.message).join(' ')).toContain('appears twice');
    expect(bad('rules: [').prefixes).toBeNull();
    expect(bad('version: 2\nrules: []\n').problems[0]!.message).toContain('version');
  });

  test('classification: additions, removed readers and a moved prefix\'s new folder narrow; removals, added readers and the old folder\'s release are held; the target is never wider', () => {
    const applied = [rule('a', 'x/', ['alice-example', 'bob-example']), rule('b', 'y/', ['alice-example']), rule('c', 'z/', ['alice-example'])];
    const desired = [rule('a', 'x/', ['alice-example', 'carol-example']), rule('c', 'w/', ['alice-example']), rule('d', 'v/', ['bob-example'])];
    const cls = classifyRulebook(applied, desired);
    const held = heldRuleId('c', 'z/');
    expect(cls.changes.map(c => `${c.rule}:${c.kind}:${c.narrowing}`).sort()).toEqual(['a:readers_added:false', 'a:readers_removed:true', 'b:removed:false', `${held}:prefix_released:false`, 'c:prefix_moved:true', 'd:added:true']);
    expect(cls.target).toEqual([rule('a', 'x/', ['alice-example']), rule('b', 'y/', ['alice-example']), rule('c', 'w/', ['alice-example']), rule(held, 'z/', ['alice-example']), rule('d', 'v/', ['bob-example'])]);
    expect(classifyRulebook(cls.target, desired).held.map(c => `${c.rule}:${c.kind}:${c.prefix}`)).toEqual(['a:readers_added:x/', 'b:removed:y/', `${held}:prefix_released:z/`]);
    expect(cls.kind).toBe('mixed');
    expect(classifyRulebook([], desired).kind).toBe('narrowing');
    expect(classifyRulebook(desired, desired).kind).toBe('unchanged');
  });
});

const SRC = 'fr-team';
const SRC2 = 'fr-other';
const PAGES = {
  alicePlan: { slug: 'partners/alice-example/plan', source: SRC, canary: 'canaryfralice' },
  teamNotes: { slug: 'partners/team/notes', source: SRC, canary: 'canaryfrteam' },
  open: { slug: 'notes/open', source: SRC, canary: 'canaryfropen' },
  summary: { slug: 'notes/summary', source: SRC, canary: 'canaryfrsummary', extra: 'derived_from: partners/alice-example/plan' },
  other: { slug: 'partners/alice-example/plan', source: SRC2, canary: 'canaryfrother' },
} as const;
type Key = keyof typeof PAGES;
const ALL = Object.keys(PAGES) as Key[];
const pageText = (title: string, canary: string, extra?: string) => ['---', 'type: note', `title: ${title}`, ...(extra ? [extra] : []), '---', `# ${title}`, '', `Folder ledger notes ${canary} for the roadmap.`].join('\n');

for (const kind of testBackends()) {
  describe(`folder access rules, database store (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let other: PGLiteEngine;
    const tokens: Record<string, string> = {};

    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

    async function call(who: string, op: string, params: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
      const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
      const sourceId = auth.sourceId ?? 'default';
      const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
      const out = await dispatchToolCall(engine, op, { ...params }, {
        remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'],
        ...(localFederated ? { localFederatedSourceIds: localFederated } : {}),
      });
      return { isError: out.isError === true, text: out.content.map(c => c.text).join('\n') };
    }

    /** The pages `who` reads, on each of get_page, keyword search, hybrid search and list_pages. */
    async function visible(who: string, keys: readonly Key[] = ALL): Promise<Record<string, Key[]>> {
      const out: Record<string, Key[]> = {};
      for (const key of keys) {
        const p = PAGES[key];
        const paths: Array<[string, string, Record<string, unknown>]> = [
          ['get_page', 'get_page', { slug: p.slug, source_id: p.source }],
          ['search keyword', 'search', { query: p.canary, match: 'keyword', fields: 'full', limit: 20 }],
          ['search hybrid', 'search', { query: `folder ledger notes ${p.canary}`, fields: 'full', limit: 50 }],
          ['list_pages', 'list_pages', { slug_prefix: p.slug.split('/')[0] + '/', source_id: p.source }],
        ];
        for (const [label, op, params] of paths) {
          const { text } = await call(who, op, params);
          const seen = label === 'list_pages' ? text.includes(p.slug) && (p.source === SRC2 ? text.includes(SRC2) : true) && !text.includes('"pages": []') && text.includes(p.slug) : text.includes(p.canary);
          if (seen) (out[label] ??= []).push(key);
        }
      }
      return out;
    }
    /** Keys read on every path (and nothing read only partially). */
    async function reads(who: string, keys: readonly Key[] = ALL): Promise<Key[]> {
      const v = await visible(who, keys);
      return keys.filter(k => ['get_page', 'search keyword'].every(l => v[l]?.includes(k)) || Object.values(v).some(ks => ks.includes(k)));
    }

    async function stamps(): Promise<Record<string, string[] | null>> {
      const rows = await engine.executeRaw<{ source_id: string; slug: string; folder_rule_ids: string[] | null }>(
        'SELECT source_id, slug, folder_rule_ids FROM pages WHERE source_id = ANY($1::text[]) ORDER BY source_id, slug', [[SRC, SRC2]]);
      return Object.fromEntries(rows.map(r => [`${r.source_id}:${r.slug}`, r.folder_rule_ids]));
    }

    async function cli(args: string[]): Promise<unknown> {
      const lines: string[] = [];
      const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
      try { await runAccessRules(engine, args[0]!, args.slice(1), args.includes('--json')); } finally { spy.mockRestore(); }
      const text = lines.join('\n');
      return args.includes('--json') ? JSON.parse(text) : text;
    }

    const NESTED = [rule('team', 'partners/', ['group:team-a']), rule('alice', 'partners/alice-example/', ['alice-example'])];
    const BASE = [...NESTED, rule('shared', 'partners/team/', ['bob-example', 'carol-example'])];

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      other = new PGLiteEngine(); await other.connect({ engine: 'pglite' } as never); await other.initSchema();
      __resetPrivateVisibilityCacheForTests();
      for (const s of [SRC, SRC2]) await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [s]);
      for (const key of ALL) {
        const p = PAGES[key];
        await importFromContent(engine, p.slug, pageText(key, p.canary, 'extra' in p ? p.extra : undefined), { sourceId: p.source });
      }
      for (const id of ['alice-example', 'bob-example', 'carol-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
      await engine.executeRaw("INSERT INTO access_groups (id) VALUES ('team-a')");
      for (const m of ['alice-example', 'bob-example']) await engine.executeRaw("INSERT INTO access_group_members (group_id, member_id) VALUES ('team-a', $1)", [m]);
      const mint = async (name: string, member?: string) => {
        const minted = await mintLegacyToken(engine, { name, scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: [SRC, SRC2] });
        tokens[name] = minted.token;
        if (member) await engine.executeRaw('UPDATE access_tokens SET member_id = $2 WHERE id = $1::uuid', [minted.id, member]);
      };
      await mint('alice', 'alice-example');
      await mint('bob', 'bob-example');
      await mint('carol', 'carol-example');
      await mint('unbound');
    }, 240_000);

    afterAll(async () => {
      policySeams.afterInstall = undefined;
      await other?.disconnect();
      __setEmbedTransportForTests(null);
      resetGateway();
      await close?.();
    }, 60_000);

    test('control: with no folder rule every caller reads every page and nothing is stamped', async () => {
      for (const who of ['alice', 'bob', 'carol', 'unbound']) expect({ who, keys: await reads(who) }).toEqual({ who, keys: ALL });
      expect(Object.values(await stamps()).every(v => v === null)).toBe(true);
    }, 240_000);

    test('a narrowing applies at once: nested group and member rules both have to pass, and other sources and folders are untouched', async () => {
      const r = await proposeRevision(engine, SRC, NESTED, { origin: 'cli', store: 'database' });
      expect({ state: r.state, kind: r.change_kind, held: r.held }).toEqual({ state: 'applied', kind: 'narrowing', held: [] });
      expect(await stamps()).toEqual({
        [`${SRC}:notes/open`]: null, [`${SRC}:notes/summary`]: null,
        [`${SRC}:partners/alice-example/plan`]: [`${SRC}:alice`, `${SRC}:team`],
        [`${SRC}:partners/team/notes`]: [`${SRC}:team`],
        [`${SRC2}:partners/alice-example/plan`]: null,
      });
      const [state] = await engine.executeRaw<{ store: string }>("SELECT config->>'access_store' AS store FROM sources WHERE id = $1", [SRC]);
      expect(state?.store).toBe('database');
      expect(await reads('alice')).toEqual(['alicePlan', 'teamNotes', 'open', 'other']);
      expect(await reads('bob')).toEqual(['teamNotes', 'open', 'other']);
      for (const who of ['carol', 'unbound']) expect({ who, keys: await reads(who) }).toEqual({ who, keys: ['open', 'other'] });
    }, 240_000);

    test('a page derived from a folder-ruled page is readable by no remote caller, members included (D4)', async () => {
      for (const who of ['alice', 'bob', 'unbound']) expect({ who, keys: await reads(who, ['summary']) }).toEqual({ who, keys: [] });
    }, 120_000);

    test('no escape hatch or granted_sources opens a folder rule', async () => {
      const arms: Array<[string, (fn: () => Promise<void>) => Promise<void>]> = [
        ['GBRAIN_REMOTE_PRIVATE_PAGES=1', fn => withEnv({ GBRAIN_REMOTE_PRIVATE_PAGES: '1' }, fn)],
        ['search.remote_private_pages=visible', async fn => {
          await engine.setConfig('search.remote_private_pages', 'visible'); __resetPrivateVisibilityCacheForTests();
          try { await fn(); } finally { await engine.setConfig('search.remote_private_pages', 'hidden'); __resetPrivateVisibilityCacheForTests(); }
        }],
        ['granted_sources', async fn => {
          for (const who of ['bob', 'carol', 'unbound']) await rescopeLegacyToken(engine, parseRescopeTokenArgs([who, '--private-pages', 'granted-sources']));
          try { await fn(); } finally { for (const who of ['bob', 'carol', 'unbound']) await rescopeLegacyToken(engine, parseRescopeTokenArgs([who, '--private-pages', 'none'])); }
        }],
      ];
      for (const [name, run] of arms) {
        await run(async () => {
          expect({ name, bob: await reads('bob', ['alicePlan', 'teamNotes']) }).toEqual({ name, bob: ['teamNotes'] });
          for (const who of ['carol', 'unbound']) expect({ name, who, keys: await reads(who, ['alicePlan', 'teamNotes', 'summary']) }).toEqual({ name, who, keys: [] });
        });
      }
    }, 240_000);

    test('a rule in a second source with the same prefix is its own rule (source-qualified ids)', async () => {
      await proposeRevision(engine, SRC2, [rule('alice', 'partners/alice-example/', ['carol-example'])], { origin: 'cli', store: 'database' });
      expect((await stamps())[`${SRC2}:partners/alice-example/plan`]).toEqual([`${SRC2}:alice`]);
      expect(await reads('carol', ['alicePlan', 'other'])).toEqual(['other']);
      expect(await reads('alice', ['alicePlan', 'other'])).toEqual(['alicePlan']);
    }, 120_000);

    test('removing readers applies at once; adding them back is held until a hash-bound apply', async () => {
      expect((await proposeRevision(engine, SRC, [...NESTED, rule('shared', 'partners/team/', ['bob-example', 'carol-example'])], { origin: 'cli' })).state).toBe('applied');
      expect(await reads('bob', ['teamNotes'])).toEqual(['teamNotes']);
      const narrowed = await proposeRevision(engine, SRC, [...NESTED, rule('shared', 'partners/team/', ['carol-example'])], { origin: 'cli' });
      expect({ state: narrowed.state, kinds: narrowed.changes.map(c => c.kind) }).toEqual({ state: 'applied', kinds: ['readers_removed'] });
      expect(await reads('bob', ['teamNotes'])).toEqual([]);
      const widened = await proposeRevision(engine, SRC, BASE, { origin: 'cli' });
      expect({ state: widened.state, held: widened.held.map(h => h.kind) }).toEqual({ state: 'recorded', held: ['readers_added'] });
      expect(await reads('bob', ['teamNotes'])).toEqual([]);
      const preview = await previewApply(engine, SRC);
      expect(preview.widening.map(w => ({ rule: w.change.rule, pages: w.pages, gains: w.gains }))).toEqual([{ rule: 'shared', pages: 1, gains: ['bob-example'] }]);
      await expect(applyApproved(engine, SRC, { expect: 'not-the-plan' })).rejects.toMatchObject({ code: 'preview_changed' });
      expect(await reads('bob', ['teamNotes'])).toEqual([]);
      const applied = await applyApproved(engine, SRC, { expect: preview.plan_hash! });
      expect(applied.state).toBe('applied');
      expect(await reads('bob', ['teamNotes'])).toEqual(['teamNotes']);
    }, 240_000);

    test('a preview bound to one plan refuses once the desired rules move', async () => {
      await proposeRevision(engine, SRC, [NESTED[0]!], { origin: 'cli' });
      const preview = await previewApply(engine, SRC);
      expect(preview.widening[0]!.gains).toEqual(['bob-example']);
      await proposeRevision(engine, SRC, [NESTED[0]!, rule('extra', 'partners/extra/', ['alice-example'])], { origin: 'cli' });
      await expect(applyApproved(engine, SRC, { expect: preview.plan_hash! })).rejects.toMatchObject({ code: 'preview_changed' });
      expect(await reads('bob', ['alicePlan'])).toEqual([]);
      const back = await proposeRevision(engine, SRC, BASE, { origin: 'revert' });
      expect(back.held.map(h => `${h.rule}:${h.kind}`)).toEqual(['extra:removed']);
      await applyApproved(engine, SRC, { expect: (await previewApply(engine, SRC)).plan_hash! });
      expect((await policyStatus(engine, SRC)).held).toEqual([]);
      expect((await policyStatus(engine, SRC)).rules).toEqual(BASE.slice().sort((a, b) => a.id.localeCompare(b.id)));
    }, 240_000);

    test('pages written or renamed after the rules are stamped by the write itself', async () => {
      await importFromContent(engine, 'partners/alice-example/later', pageText('later', 'canaryfrlater'), { sourceId: SRC });
      await importFromContent(engine, 'notes/moving', pageText('moving', 'canaryfrmoving'), { sourceId: SRC });
      await engine.updateSlug('notes/moving', 'partners/alice-example/moved', { sourceId: SRC } as never);
      const s = await stamps();
      expect(s[`${SRC}:partners/alice-example/later`]).toEqual([`${SRC}:alice`, `${SRC}:team`]);
      expect(s[`${SRC}:partners/alice-example/moved`]).toEqual([`${SRC}:alice`, `${SRC}:team`]);
      const bob = await call('bob', 'search', { query: 'canaryfrmoving canaryfrlater', match: 'keyword', fields: 'full' });
      expect(bob.text).not.toContain('canaryfr');
    }, 120_000);

    test('an interrupted narrowing reads as nobody under its prefix (derivatives too) until resume finishes it', async () => {
      await importFromContent(engine, 'clients/acme-example/brief', pageText('brief', 'canaryfrbrief'), { sourceId: SRC });
      await importFromContent(engine, 'notes/brief-summary', pageText('brief summary', 'canaryfrbriefsum', 'derived_from: clients/acme-example/brief'), { sourceId: SRC });
      const ok = async (who: string, canary: string) => (await call(who, 'search', { query: canary, match: 'keyword', fields: 'full' })).text.includes(canary);
      expect(await ok('alice', 'canaryfrbrief')).toBe(true);
      policySeams.afterInstall = () => { throw new Error('interrupted'); };
      try {
        await expect(proposeRevision(engine, SRC, [...BASE, rule('acme', 'clients/acme-example/', ['alice-example'])], { origin: 'cli' })).rejects.toThrow('interrupted');
      } finally { policySeams.afterInstall = undefined; }
      const status = await policyStatus(engine, SRC);
      expect(status.pending.map(p => p.prefix)).toEqual(['clients/acme-example/']);
      expect((await stamps())[`${SRC}:clients/acme-example/brief`]).toBeNull();
      expect(await ok('alice', 'canaryfrbrief')).toBe(false);
      expect(await ok('alice', 'canaryfrbriefsum')).toBe(false);
      expect(await ok('alice', 'canaryfropen')).toBe(true);
      const notice = await call('alice', 'search', { query: 'canaryfrbrief', match: 'keyword' });
      expect(notice.text).toContain('access_policy_pending');
      await importFromContent(engine, 'clients/acme-example/during', pageText('during', 'canaryfrduring'), { sourceId: SRC });
      expect((await stamps())[`${SRC}:clients/acme-example/during`]).toEqual([`${SRC}:acme`]);
      const resumed = await resumePolicy(engine, SRC);
      expect(resumed.pending_before).toEqual(['clients/acme-example/']);
      expect((await policyStatus(engine, SRC)).pending).toEqual([]);
      expect((await stamps())[`${SRC}:clients/acme-example/brief`]).toEqual([`${SRC}:acme`]);
      expect(await ok('alice', 'canaryfrbrief')).toBe(true);
      expect(await ok('bob', 'canaryfrbrief')).toBe(false);
      expect(await ok('alice', 'canaryfrbriefsum')).toBe(false);
    }, 240_000);

    test('a lost reply is reconciled by operation id; a raced preview refuses', async () => {
      const desired = [...(await policyStatus(engine, SRC)).desired!.rules, rule('ops', 'ops/', ['alice-example'])];
      const first = await proposeRevision(engine, SRC, desired, { origin: 'cli', operationId: 'acc_test-1' });
      const again = await proposeRevision(engine, SRC, desired, { origin: 'cli', operationId: 'acc_test-1' });
      expect({ reconciled: again.reconciled, revision: again.revision }).toEqual({ reconciled: true, revision: first.revision });
      expect((await policyStatus(engine, SRC, 'acc_test-1')).operation).toEqual({ operation_id: 'acc_test-1', revision: first.revision, state: 'applied' });
      await expect(proposeRevision(engine, SRC, desired.slice(1), { origin: 'cli', expectDesired: first.revision! - 1 })).rejects.toMatchObject({ code: 'preview_changed' });
    }, 120_000);

    test('the CLI previews by default, writes with --yes, refuses an invalid rule and holds a removal', async () => {
      const before = (await policyStatus(engine, SRC)).desired!.revision;
      const preview = await cli(['rule', 'add', '--source', SRC, '--prefix', 'hr/', '--readers', 'carol-example,ghost-example', '--json']) as { applied: boolean; expect: number; unknown_readers: string[]; changes: unknown[] };
      expect({ applied: preview.applied, expect: preview.expect, unknown: preview.unknown_readers }).toEqual({ applied: false, expect: before, unknown: ['ghost-example'] });
      expect((await policyStatus(engine, SRC)).desired!.revision).toBe(before);
      const text = await cli(['rule', 'add', '--source', SRC, '--prefix', 'hr/', '--readers', 'carol-example']) as string;
      expect(text.split('\n').at(-1)).toContain(`Nothing written. To approve, add --yes --expect ${before}`);
      const done = await cli(['rule', 'add', '--source', SRC, '--prefix', 'hr/', '--readers', 'carol-example', '--yes', '--expect', String(before), '--json']) as { state: string; applied: boolean; store: string; operation_id: string };
      expect({ state: done.state, applied: done.applied, store: done.store }).toEqual({ state: 'applied', applied: true, store: 'database' });
      await expect(cli(['rule', 'add', '--source', SRC, '--prefix', 'HR/*', '--readers', 'carol-example', '--yes'])).rejects.toMatchObject({ code: 'access_rule_invalid' });
      const rm = await cli(['rule', 'rm', 'hr', '--source', SRC, '--yes', '--json']) as { state: string; held: Array<{ kind: string }> };
      expect({ state: rm.state, held: rm.held.map(h => h.kind) }).toEqual({ state: 'recorded', held: ['removed'] });
      expect((await policyStatus(engine, SRC)).rules.some(r => r.id === 'hr')).toBe(true);
      const history = await cli(['rule', 'history', '--source', SRC, '--json']) as { revisions: Array<{ revision: number; approved_at: string | null }> };
      expect(history.revisions[0]!.approved_at).toBeNull();
      const apply = await cli(['apply', '--source', SRC, '--json']) as { plan_hash: string; widening: Array<{ change: { rule: string } }> };
      expect(apply.widening.map(w => w.change.rule)).toEqual(['hr']);
      await cli(['apply', '--source', SRC, '--yes', '--expect', apply.plan_hash, '--json']);
      expect((await policyStatus(engine, SRC)).rules.some(r => r.id === 'hr')).toBe(false);
    }, 240_000);

    test('a remote write under .gbrain/ is refused and writes nothing', async () => {
      for (const slug of ['.gbrain/access', '.gbrain/access.yml']) {
        const out = await call('alice', 'put_page', { slug, content: '---\ntitle: x\n---\nversion: 1\n', request_id: crypto.randomUUID() });
        expect({ slug, isError: out.isError }).toEqual({ slug, isError: true });
      }
      expect(await engine.executeRaw("SELECT 1 FROM pages WHERE slug LIKE '.gbrain%'")).toEqual([]);
    }, 60_000);

    test('export carries the rules and import loads them into another repo-less brain, narrowing at once', async () => {
      const yml = await cli(['rule', 'export', '--source', SRC]) as string;
      const file = join(mkdtempSync(join(tmpdir(), 'gbrain-fr-')), 'access.yml');
      writeFileSync(file, yml);
      {
        await other.executeRaw("INSERT INTO sources (id, name) VALUES ('imported', 'imported')");
        await importFromContent(other, 'partners/team/notes', pageText('t', 'x'), { sourceId: 'imported' });
        const lines: string[] = [];
        const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
        try { await runAccessRules(other, 'rule', ['import', '--file', file, '--source', 'imported', '--yes', '--json'], true); } finally { spy.mockRestore(); }
        expect(JSON.parse(lines.join('\n')).state).toBe('applied');
        const [row] = await other.executeRaw<{ ids: string[] }>("SELECT folder_rule_ids AS ids FROM pages WHERE slug = 'partners/team/notes'");
        expect(row?.ids).toEqual(['imported:shared', 'imported:team']);
        const parsed = parsePolicyYaml(yml);
        expect(parsed.ok && parsed.rules.map(r => r.id).sort()).toEqual((await policyStatus(engine, SRC)).desired!.rules.map(r => r.id).sort());
      }
    }, 120_000);

    test('a moved prefix restricts the new folder at once and holds only the old folder\'s release (L4)', async () => {
      await importFromContent(engine, 'projects/old-example/doc', pageText('old doc', 'canaryfrmvold'), { sourceId: SRC });
      await importFromContent(engine, 'projects/new-example/doc', pageText('new doc', 'canaryfrmvnew'), { sourceId: SRC });
      const ok = async (who: string, canary: string) => (await call(who, 'search', { query: canary, match: 'keyword', fields: 'full' })).text.includes(canary);
      const base = (await policyStatus(engine, SRC)).desired!.rules.filter(r => r.id !== 'mv');
      expect((await proposeRevision(engine, SRC, [...base, rule('mv', 'projects/old-example/', ['alice-example'])], { origin: 'cli' })).state).toBe('applied');
      expect({ old: await ok('bob', 'canaryfrmvold'), new: await ok('bob', 'canaryfrmvnew') }).toEqual({ old: false, new: true });
      const moved = await proposeRevision(engine, SRC, [...base, rule('mv', 'projects/new-example/', ['alice-example'])], { origin: 'cli' });
      expect({ state: moved.state, changes: moved.changes.map(c => `${c.kind}:${c.narrowing}:${c.prefix}`).sort(), held: moved.held.map(h => `${h.kind}:${h.prefix}`) }).toEqual({
        state: 'recorded', changes: ['prefix_moved:true:projects/new-example/', 'prefix_released:false:projects/old-example/'], held: ['prefix_released:projects/old-example/'] });
      for (const who of ['bob', 'unbound']) expect({ who, old: await ok(who, 'canaryfrmvold'), new: await ok(who, 'canaryfrmvnew') }).toEqual({ who, old: false, new: false });
      expect({ old: await ok('alice', 'canaryfrmvold'), new: await ok('alice', 'canaryfrmvnew') }).toEqual({ old: true, new: true });
      const preview = await previewApply(engine, SRC);
      expect(preview.widening.map(w => ({ kind: w.change.kind, prefix: w.change.prefix, pages: w.pages, sample: w.sample, gains: w.gains }))).toEqual([
        { kind: 'prefix_released', prefix: 'projects/old-example/', pages: 1, sample: ['projects/old-example/doc'], gains: 'every_source_reader' }]);
      expect((await stamps())[`${SRC}:projects/new-example/doc`]).toEqual([`${SRC}:mv`]);
      await applyApproved(engine, SRC, { expect: preview.plan_hash! });
      for (const who of ['bob', 'unbound']) expect({ who, old: await ok(who, 'canaryfrmvold'), new: await ok(who, 'canaryfrmvnew') }).toEqual({ who, old: true, new: false });
      expect((await stamps())[`${SRC}:projects/old-example/doc`]).toBeNull();
      expect((await policyStatus(engine, SRC)).held).toEqual([]);
    }, 240_000);

    test('property: the SQL predicate and the row helper agree on generated slugs, rules and identities', async () => {
      const src = 'fr-prop';
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [src]);
      const segs = ['a', 'b', 'c'];
      const slugs = [...new Set(segs.flatMap(x => segs.flatMap(y => [`${x}/${y}/p`, `${x}/p`])))];
      for (const s of slugs) await importFromContent(engine, s, pageText(s, 'prop'), { sourceId: src });
      const rules = [rule('ra', 'a/', ['group:team-a']), rule('rab', 'a/b/', ['alice-example']), rule('rc', 'c/', ['carol-example', 'bob-example']), rule('rcc', 'c/c/', ['group:team-a'])];
      await proposeRevision(engine, src, rules, { origin: 'cli', store: 'database' });
      const { folderAccessFor } = await import('../src/core/access/caller.ts');
      const { withCallerAccess, folderRulesAllowedSql } = await import('../src/core/search/private-visibility.ts');
      for (const identity of [[], ['member:alice-example', 'group:team-a'], ['member:bob-example', 'group:team-a'], ['member:carol-example']]) {
        const folder = await folderAccessFor(engine, identity);
        const sql = withCallerAccess({ identity, ...folder }, () => folderRulesAllowedSql('p', folder.satisfiedRuleIds));
        const rows = await engine.executeRaw<{ slug: string }>(`SELECT slug FROM pages p WHERE source_id = $1 AND ${sql} ORDER BY slug`, [src]);
        const want = slugs.filter(s => folderRulesAllow(s, rules, identity)).sort();
        expect({ identity, got: rows.map(r => r.slug) }).toEqual({ identity, got: want });
        for (const s of slugs) expect(matchingRuleIds(s, rules)?.map(id => `${src}:${id}`) ?? null).toEqual((await stamps2(s)) ?? null);
      }
      async function stamps2(slug: string) {
        const [r] = await engine.executeRaw<{ ids: string[] | null }>('SELECT folder_rule_ids AS ids FROM pages WHERE source_id = $1 AND slug = $2', [src, slug]);
        return r?.ids ?? null;
      }
    }, 240_000);
  });
}
