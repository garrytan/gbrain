/**
 * GST-2490 (G6 of GST-2476): what credentials bound to the brain owner read, and the operator's owner opt-in.
 *
 * 1. Protects: an owner read keeps a derived page (an atom, a synthesized concept, a Life Chronicle event, a derived_from
 *    page) and a fact when the owner reads every origin of it, with no setting: an origin under an owner-only folder
 *    rule, or one whose readers name the owner. With config access.owner_reads_restricted on (set only by the operator
 *    on the brain host), the owner also reads pages that readers lists, folder rules and page rules keep to other
 *    members, with their derived pages and facts, on every read path; never another member's own member page
 *    (memory/members/<id>), its derived pages or its facts. What every other caller reads is identical with the opt-in
 *    off and on, writes are not widened, and a remote caller cannot turn it on.
 * 2. Fails when: a derivative or fact of an origin the owner reads stays hidden from the owner; the opt-in is off and
 *    the owner reads another member's page or its derivative; the opt-in is on and the owner misses one, or reads a
 *    member page; any other caller's view changes with the opt-in; the publication gate lets the owner write a page the
 *    opt-in only lets it read; a remote caller sets the key; or the local --as owner preview disagrees with the key.
 * 3. Real seams: tokens minted by the token service and verified by the serve --http verifier, dispatched through MCP
 *    dispatch (remote: true, transport http); rules in the database (repo-less brain) and in a committed access.yml
 *    read by sync (git source); PGLite, and Postgres with DATABASE_URL; embeddings stubbed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { setOwner, setOwnerReadsRestricted, ownerView } from '../src/core/access/owner.ts';
import { bindCredential } from '../src/core/access/members.ts';
import { proposeRevision, policyStatus } from '../src/core/access/policy.ts';
import { POLICY_FILE } from '../src/core/access/policy-git.ts';
import { performSync } from '../src/commands/sync.ts';
import { openAsPreview } from '../src/cli/as-preview.ts';
import { authorizePageVisibility } from '../src/core/persistence/page-visibility.ts';
import type { WriteAuthority } from '../src/core/persistence/model.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

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

const SRC = 'optin-src';
const OWNER = 'owner-example';
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Origins: what keeps each one, and whether its derived pages and facts are built. */
const ORIGINS = {
  health: { slug: 'health/origin-example', fm: [] as string[], derive: true },
  grp: { slug: 'email/grp-origin', fm: [`readable_by: [${OWNER}, group:team-a]`], derive: true },
  team: { slug: 'team/origin-example', fm: [] as string[], derive: true },
  readers: { slug: 'notes/alice-readers', fm: ['readable_by: [alice-example]'], derive: false },
  ledger: { slug: 'notes/alice-ledger', fm: [] as string[], derive: false },
  member: { slug: 'memory/members/alice-example', fm: ['readable_by: [alice-example]'], derive: true },
  open: { slug: 'notes/open-example', fm: [] as string[], derive: false },
} as const;
type Origin = keyof typeof ORIGINS;
const DERIVED = ['atom', 'df', 'concept', 'event'] as const;
const slugOf = (o: Origin, d: string) => ({ atom: `atoms/${o}-atom`, df: `notes/${o}-derived`, concept: `concepts/${o}-concept`, event: `events/${o}-event` })[d]!;
const canary = (key: string) => 'canaryoptin' + key.replace(/[^a-z]/g, '') + 'x';

/** Every key the fixtures answer: an origin, a derived page (origin.kind) or a fact (origin.fact). */
const KEYS: string[] = [];
for (const [o, spec] of Object.entries(ORIGINS) as Array<[Origin, (typeof ORIGINS)[Origin]]>) {
  KEYS.push(o);
  if (spec.derive) for (const d of DERIVED) KEYS.push(`${o}.${d}`);
  if (spec.derive) KEYS.push(`${o}.fact`);
}
if (!ORIGINS.grp.derive) throw new Error('unreachable');

const doc = (title: string, key: string, fm: readonly string[], type = 'note') =>
  ['---', `type: ${type}`, `title: ${title}`, ...fm, '---', `# ${title}`, '', `Harbor ledger planning notes ${canary(key)} here.`].join('\n');

const RULES = [
  { id: 'health', prefix: 'health/', readers: [OWNER] },
  { id: 'team', prefix: 'team/', readers: ['alice-example'] },
  { id: 'ledger', slug: 'notes/alice-ledger', readers: ['alice-example'] },
];
const policyYaml = () => ['version: 1', 'rules:', ...RULES.flatMap(r => [`  - id: ${r.id}`, r.prefix ? `    prefix: ${r.prefix}` : `    slug: ${r.slug}`, `    readable_by: [${r.readers.join(', ')}]`])].join('\n') + '\n';

/** Read paths: each returns text that names a key's canary when the caller reads it. */
const READS: Array<[string, string, (slug: string) => Record<string, unknown>, boolean]> = [
  ['get_page', 'get_page', slug => ({ slug }), true],
  ['list_pages', 'list_pages', () => ({ limit: 100 }), false],
  ['search', 'search', () => ({ query: 'harbor ledger planning notes', fields: 'full', limit: 100 }), false],
  ['search keyword', 'search', () => ({ query: 'planning notes', match: 'keyword', fields: 'full', limit: 100 }), false],
  ['query', 'query', () => ({ query: 'harbor ledger planning notes', expand: false, fields: 'full', limit: 100 }), false],
  ['facts since', 'recall', () => ({ since: '2000-01-01', limit: 100 }), false],
  ['facts question', 'recall', () => ({ question: 'harbor fact planning' }), false],
];

for (const kind of testBackends()) {
  for (const store of ['database', 'git'] as const) {
    describe(`owner reads and the owner opt-in (${kind}, rules in ${store === 'git' ? 'access.yml' : 'the database, repo-less'})`, () => {
      let engine: BrainEngine;
      let close: () => Promise<void>;
      let root = '';
      const tokens: Record<string, string> = {};
      const tokenIds: Record<string, string> = {};
      const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

      async function call(who: string, op: string, params: Record<string, unknown>): Promise<string> {
        if (who === 'as-owner') {
          const preview = await openAsPreview(engine, OWNER, op, true);
          const out = await preview.run(() => dispatchToolCall(engine, op, { ...params }, preview.context({ remote: false, sourceId: SRC }) as never));
          return out.content.map(c => c.text).join('\n');
        }
        const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
        const sourceId = auth.sourceId ?? 'default';
        const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
        const out = await dispatchToolCall(engine, op, { ...params }, {
          remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'],
          ...(localFederated ? { localFederatedSourceIds: localFederated } : {}),
        });
        return out.content.map(c => c.text).join('\n');
      }

      const pageSlug = (key: string): string | null => {
        const [o, d] = key.split('.') as [Origin, string | undefined];
        return d === undefined ? ORIGINS[o].slug : d === 'fact' ? null : slugOf(o, d);
      };
      /** The keys `who` reads on each path. */
      async function seenBy(who: string): Promise<Record<string, string[]>> {
        __resetPrivateVisibilityCacheForTests();
        const out: Record<string, string[]> = {};
        for (const [label, op, params, perPage] of READS) {
          const seen = new Set<string>();
          if (perPage) {
            for (const key of KEYS) { const slug = pageSlug(key); if (slug && (await call(who, op, params(slug))).includes(canary(key))) seen.add(key); }
          } else {
            const text = await call(who, op, params(''));
            for (const key of KEYS) if (op === 'list_pages' ? (pageSlug(key) !== null && text.includes(`"${pageSlug(key)}"`)) : text.includes(canary(key))) seen.add(key);
          }
          out[label] = KEYS.filter(k => seen.has(k));
        }
        for (const o of Object.keys(ORIGINS) as Origin[]) {
          if (!ORIGINS[o].derive) continue;
          if ((await call(who, 'recall', { entity: ORIGINS[o].slug })).includes(canary(`${o}.fact`))) (out['facts entity'] ??= []).push(`${o}.fact`);
        }
        out['facts entity'] ??= [];
        return out;
      }
      /** What a reader of exactly these origins sees on every path: pages on page paths, facts on fact paths. */
      const expected = (origins: Origin[], derivedOf: Origin[]) => {
        const pages = KEYS.filter(k => { const [o, d] = k.split('.') as [Origin, string | undefined]; return d === undefined ? origins.includes(o) : d !== 'fact' && derivedOf.includes(o); });
        const facts = KEYS.filter(k => { const [o, d] = k.split('.') as [Origin, string | undefined]; return d === 'fact' && derivedOf.includes(o); });
        const out: Record<string, string[]> = {};
        for (const [label, op] of READS) {
          // Search finds a remembered fact through its entity page's indexed facts fence on the repo-less brain; the git fixture never re-syncs that page.
          const withFacts = op === 'query' || (op === 'search' && store === 'database');
          out[label] = op === 'recall' ? facts : withFacts ? KEYS.filter(k => pages.includes(k) || facts.includes(k)) : pages;
        }
        out['facts entity'] = facts;
        return out;
      };
      const withOptIn = async <T>(fn: () => Promise<T>): Promise<T> => {
        await setOwnerReadsRestricted(engine, true, { remote: false });
        __resetPrivateVisibilityCacheForTests();
        try { return await fn(); } finally { await setOwnerReadsRestricted(engine, false, { remote: false }); __resetPrivateVisibilityCacheForTests(); }
      };

      beforeAll(async () => {
        configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
        __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
        if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
        else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
        __resetPrivateVisibilityCacheForTests();
        for (const id of [OWNER, 'alice-example', 'bob-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
        await engine.executeRaw("INSERT INTO access_groups (id) VALUES ('team-a')");
        await engine.executeRaw("INSERT INTO access_group_members (group_id, member_id) VALUES ('team-a', 'bob-example')");
        if (store === 'git') {
          root = mkdtempSync(join(tmpdir(), 'gbrain-optin-'));
          git(root, 'init', '-q', '-b', 'main');
          git(root, 'config', 'user.email', 't@t.co');
          git(root, 'config', 'user.name', 't');
          for (const [o, spec] of Object.entries(ORIGINS) as Array<[Origin, (typeof ORIGINS)[Origin]]>) {
            mkdirSync(join(root, spec.slug, '..'), { recursive: true });
            writeFileSync(join(root, `${spec.slug}.md`), doc(`${o} origin`, o, spec.fm) + '\n');
          }
          mkdirSync(join(root, '.gbrain'), { recursive: true });
          writeFileSync(join(root, POLICY_FILE), policyYaml());
          git(root, 'add', '-A');
          git(root, 'commit', '-q', '-m', 'pages and policy');
          await engine.executeRaw("INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, '{}')", [SRC, root]);
          await performSync(engine, { sourceId: SRC, repoPath: root, noPull: true, noEmbed: true, full: true, concurrency: 1 });
          expect((await policyStatus(engine, SRC)).store).toBe('git');
        } else {
          await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
          await proposeRevision(engine, SRC, RULES.map(r => ({ id: r.id, prefix: r.prefix ?? r.slug, readable_by: r.readers.map(m => `member:${m}`) }) as never), { origin: 'cli', store: 'database' });
          for (const [o, spec] of Object.entries(ORIGINS) as Array<[Origin, (typeof ORIGINS)[Origin]]>) await importFromContent(engine, spec.slug, doc(`${o} origin`, o, spec.fm), { sourceId: SRC });
        }
        for (const [o, spec] of Object.entries(ORIGINS) as Array<[Origin, (typeof ORIGINS)[Origin]]>) {
          if (!spec.derive) continue;
          await importFromContent(engine, slugOf(o, 'atom'), doc(`${o} atom`, `${o}.atom`, [`source_slug: ${spec.slug}`], 'atom'), { sourceId: SRC });
          await importFromContent(engine, slugOf(o, 'df'), doc(`${o} derived`, `${o}.df`, [`derived_from: [${spec.slug}]`]), { sourceId: SRC });
          await importFromContent(engine, slugOf(o, 'concept'), doc(`${o} concept`, `${o}.concept`, ['synthesized_by: fixture'], 'concept'), { sourceId: SRC });
          await engine.addLink(slugOf(o, 'concept'), slugOf(o, 'atom'), 'input', 'synthesized_from', 'concept-provenance', undefined, undefined, { fromSourceId: SRC, toSourceId: SRC });
          await importFromContent(engine, slugOf(o, 'event'), doc(`${o} event`, `${o}.event`, ['captured_via: life-chronicle:fixture', 'event:', `  depth: ${spec.slug}`], 'event'), { sourceId: SRC });
          if (store === 'git') {
            // A git source's pages change only through the checkout, so remember refuses there on Postgres; this is the row a facts fence on the origin would yield.
            await engine.executeRaw("INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, source_markdown_slug, valid_from) VALUES ($1, $2, $3, 'fact', 'world', 'fixture', $2, now())",
              [SRC, spec.slug, `Harbor fact planning ${canary(`${o}.fact`)}`]);
            continue;
          }
          const remembered = await dispatchToolCall(engine, 'remember', { fact: `Harbor fact planning ${canary(`${o}.fact`)}`, provenance: 'fixture', entity: spec.slug, visibility: 'world' }, { remote: false, sourceId: SRC });
          if (remembered.isError) throw new Error(`fixture remember: ${remembered.content.map(c => c.text).join(' ')}`);
        }
        for (const [name, member] of [['owner', OWNER], ['alice', 'alice-example'], ['bob', 'bob-example'], ['unbound', null]] as const) {
          const minted = await mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] });
          tokens[name] = minted.token;
          tokenIds[name] = minted.id;
          if (member) await bindCredential(engine, { kind: 'token', id: minted.id }, { member });
        }
        await setOwner(engine, OWNER);
      }, 300_000);

      afterAll(async () => {
        __setEmbedTransportForTests(null);
        resetGateway();
        await close?.();
        if (root) rmSync(root, { recursive: true, force: true });
      }, 60_000);

      test('fixture control: a trusted local caller reads every page and fact', async () => {
        const seen: string[] = [];
        for (const key of KEYS) {
          const slug = pageSlug(key);
          const text = slug ? (await dispatchToolCall(engine, 'get_page', { slug }, { remote: false, sourceId: SRC })).content.map(c => c.text).join('\n')
            : (await dispatchToolCall(engine, 'recall', { since: '2000-01-01', limit: 100 }, { remote: false, sourceId: SRC })).content.map(c => c.text).join('\n');
          if (text.includes(canary(key))) seen.push(key);
        }
        expect(seen).toEqual(KEYS);
      }, 120_000);

      test('with no setting, the owner reads the derived pages and facts of every origin it reads, and nothing kept to other members', async () => {
        expect(await seenBy('owner')).toEqual(expected(['health', 'grp', 'open'], ['health', 'grp']));
      }, 300_000);

      test('the opt-in extends that to pages and rules kept to other members, never another member\'s member page', async () => {
        await withOptIn(async () => {
          expect((await ownerView(engine)).reads_restricted).toBe(true);
          expect(await seenBy('owner')).toEqual(expected(['health', 'grp', 'team', 'readers', 'ledger', 'open'], ['health', 'grp', 'team']));
        });
      }, 300_000);

      test('the local --as owner preview reads what the owner\'s key reads, off and on', async () => {
        expect(await seenBy('as-owner')).toEqual(await seenBy('owner'));
        await withOptIn(async () => { expect(await seenBy('as-owner')).toEqual(await seenBy('owner')); });
      }, 600_000);

      test('every other caller reads exactly the same with the opt-in off and on', async () => {
        for (const who of ['alice', 'bob', 'unbound']) {
          const off = await seenBy(who);
          expect({ who, on: await withOptIn(() => seenBy(who)) }).toEqual({ who, on: off });
        }
        const alice = await seenBy('alice');
        expect(alice['get_page']).toEqual(['team', 'readers', 'ledger', 'member', 'open']);
        expect((await seenBy('bob'))['get_page']).toEqual(['grp', 'open']);
        expect((await seenBy('unbound'))['get_page']).toEqual(['open']);
      }, 600_000);

      test('the opt-in widens no write: the publication gate keeps the owner to the pages its readers and rules name', async () => {
        const writable = async () => {
          const authority = { version: 1, principal: { kind: 'legacy_token', id: tokenIds.owner }, remote: true, excludePrivate: true, sourceId: SRC,
            sourceIncarnation: 'unused', scopes: ['read', 'write'], operations: null, slugPrefixes: null } as WriteAuthority;
          const out: Origin[] = [];
          for (const o of Object.keys(ORIGINS) as Origin[]) if (await authorizePageVisibility(engine, authority, ORIGINS[o].slug).then(() => true, () => false)) out.push(o);
          return out;
        };
        const off = await writable();
        expect(off).toEqual(['health', 'grp', 'open']);
        expect(await withOptIn(writable)).toEqual(off);
      }, 120_000);

      test('only the operator on the brain host sets the opt-in; a remote caller is refused and nothing changes', async () => {
        await expect(setOwnerReadsRestricted(engine, true, { remote: true })).rejects.toThrow();
        expect(await engine.getConfig('access.owner_reads_restricted')).not.toBe('1');
      }, 60_000);
    });
  }
}

for (const kind of testBackends()) {
  describe(`owner opt-in and other members' member pages (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const tokens: Record<string, string> = {};
    const MSRC = 'optin-members';
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    async function read(who: string, op: string, params: Record<string, unknown>): Promise<string> {
      __resetPrivateVisibilityCacheForTests();
      const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
      const out = await dispatchToolCall(engine, op, { ...params }, { remote: true, transport: 'http', auth, sourceId: auth.sourceId ?? 'default', takesHoldersAllowList: ['world'] });
      return out.content.map(c => c.text).join('\n');
    }
    const note = (title: string, canary: string, fm: string[], type = 'note') => ['---', `type: ${type}`, `title: ${title}`, ...fm, '---', `# ${title}`, '', `Harbor notes ${canary} here.`].join('\n');
    const optIn = async <T>(on: boolean, fn: () => Promise<T>): Promise<T> => {
      await setOwnerReadsRestricted(engine, on, { remote: false });
      __resetPrivateVisibilityCacheForTests();
      try { return await fn(); } finally { await setOwnerReadsRestricted(engine, false, { remote: false }); __resetPrivateVisibilityCacheForTests(); }
    };

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      for (const id of [OWNER, 'alice-example', 'bob-example', 'dan-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [MSRC]);
      await proposeRevision(engine, MSRC, [{ id: 'bob-page', prefix: 'memory/members/bob-example', readable_by: ['member:bob-example'] }] as never, { origin: 'cli', store: 'database' });
      await importFromContent(engine, 'memory/members/alice-example', note('alice memory', 'canarympalicevone', ['readable_by: [alice-example]']), { sourceId: MSRC });
      await importFromContent(engine, 'memory/members/alice-example', note('alice memory', 'canarympalicevtwo', [`readable_by: [alice-example, ${OWNER}]`]), { sourceId: MSRC });
      await importFromContent(engine, 'memory/members/bob-example', note('bob memory', 'canarympbobpage', [`readable_by: [bob-example, ${OWNER}]`]), { sourceId: MSRC });
      await importFromContent(engine, 'atoms/bob-atom', note('bob atom', 'canarympbobatom', ['source_slug: memory/members/bob-example'], 'atom'), { sourceId: MSRC });
      await importFromContent(engine, 'notes/bob-derived', note('bob derived', 'canarympbobderived', ['derived_from: [memory/members/bob-example]']), { sourceId: MSRC });
      await importFromContent(engine, 'memory/members/dan-example', note('dan memory', 'canarympdanpage', []), { sourceId: MSRC });
      await importFromContent(engine, 'atoms/dan-atom', note('dan atom', 'canarympdanatom', ['visibility: world', 'source_slug: memory/members/dan-example'], 'atom'), { sourceId: MSRC });
      for (const [name, member] of [['owner', OWNER], ['unbound', null]] as const) {
        const minted = await mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'], sourceGrant: [MSRC] });
        tokens[name] = minted.token;
        if (member) await bindCredential(engine, { kind: 'token', id: minted.id }, { member });
      }
      await setOwner(engine, OWNER);
    }, 300_000);
    afterAll(async () => { await close?.(); }, 60_000);

    for (const on of [false, true]) {
      test(`opt-in ${on ? 'on' : 'off'}: an older version of another member's member page kept from the owner stays hidden`, async () => {
        await optIn(on, async () => {
          const versions = await read('owner', 'get_versions', { slug: 'memory/members/alice-example', include_body: true, limit: 10 });
          expect({ on, v1: versions.includes('canarympalicevone') }).toEqual({ on, v1: false });
          expect(await read('owner', 'get_page', { slug: 'memory/members/alice-example' })).toContain('canarympalicevtwo');
        });
      }, 120_000);

      test(`opt-in ${on ? 'on' : 'off'}: derived pages of another member's member page follow that page's rules for the owner`, async () => {
        await optIn(on, async () => {
          const seen: string[] = [];
          for (const [slug, canary] of [['memory/members/bob-example', 'canarympbobpage'], ['atoms/bob-atom', 'canarympbobatom'], ['notes/bob-derived', 'canarympbobderived'],
            ['memory/members/dan-example', 'canarympdanpage'], ['atoms/dan-atom', 'canarympdanatom']] as const) {
            if ((await read('owner', 'get_page', { slug })).includes(canary)) seen.push(slug);
          }
          expect({ on, seen }).toEqual({ on, seen: ['memory/members/dan-example', 'atoms/dan-atom'] });
          expect((await read('unbound', 'get_page', { slug: 'atoms/dan-atom' })).includes('canarympdanatom')).toBe(true);
        });
      }, 120_000);
    }
  });
}
