/**
 * BrainEngine parity: the brain owner's remote fact reads (recall, entity, get_page's fact table), end to end through the
 * MCP dispatcher, on every engine arm. The owner lineage read (CallerAccess.lineage, GST-2490) judges each fact by the
 * page it came from: a fact whose source page the owner may not read is hidden, and so is a fact on a page derived
 * (`derived_from`) from a page kept to another member.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm through harness.ts) the brain
 *    owner, reading remotely over http (a bound token) and over stdio (--stdio-member), gets exactly the facts PGLite gives
 *    it: the facts from an open page (world and private), from its own page and from a page derived from its own page, and
 *    from a `visibility: private` page; never a fact from a page kept to another member, from a read-by-nobody page or from
 *    a page derived from another member's page. Each tool's answer is compared across arms, with ids and write times only
 *    removed, except the plain recall query: its fact set is compared across arms and its order fields are pinned per
 *    engine (the named loss in RUST_ENGINE.md row RQ-1).
 *  - Regression: on a Rust brain every remote owner read refused before any work (ownerLineageRefusal,
 *    src/mcp/engine-access-refusal.ts, engine_capability_missing "the owner lineage read"), so the owner got no fact at
 *    all. This case is red there and green once the owner lineage read goes to the Rust store as its owner read rule.
 *  - Why existing coverage misses it: remote-access-matrix's owner cases put every fact on one open page, so the lineage
 *    of a fact's source page (another member's origin) is never judged; facts-rest-sites' readMemberPageWithdrawal case
 *    calls the engine member, not the tools a remote owner reaches.
 *  - Seams: none (real engines, the real dispatcher, tokens minted by the token service and verified by the OAuth provider
 *    as serve --http does, the owner set by setOwner, credentials bound by bindCredential). Facts go in through
 *    insertFacts with their source page named, as a fence import writes them. Embeddings are off.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';
import { noGrantFederatedScope } from '../../src/core/source-resolver.ts';
import { __resetPrivateVisibilityCacheForTests } from '../../src/core/search/private-visibility.ts';
import { addMember, bindCredential } from '../../src/core/access/members.ts';
import { setOwner } from '../../src/core/access/owner.ts';
import { drainProjections } from '../../src/core/page-state/projections.ts';
import { flushAccessReadLog } from '../../src/core/access/read-log.ts';
import type { AuthInfo } from '../../src/core/ops/contract.ts';

const { parityTest } = parityArms(testBackends());

const OWNER = 'owner-example';
const BOB = 'bob-example';
const ENTITY = 'people/subject-example';

/** The source pages of the facts: slug and the frontmatter lines that decide who may read each. */
const PAGES = {
  open: { slug: 'notes/open-source-example', fm: [] as string[] },
  priv: { slug: 'notes/private-source-example', fm: ['visibility: private'] },
  ownerOrigin: { slug: 'notes/owner-origin-example', fm: [`readable_by: [${OWNER}]`] },
  bobOrigin: { slug: 'notes/bob-origin-example', fm: [`readable_by: [${BOB}]`] },
  nobody: { slug: 'notes/nobody-example', fm: ['readable_by: []'] },
  fromOwner: { slug: 'notes/from-owner-example', fm: ['derived_from: [notes/owner-origin-example]'] },
  fromBob: { slug: 'notes/from-bob-example', fm: ['derived_from: [notes/bob-origin-example.md]'] },
} as const;
type PageKey = keyof typeof PAGES;
const KEYS = Object.keys(PAGES) as PageKey[];

/** One fact per source page (world), plus one private fact on the open page. Each carries its own canary. */
const FACTS = [
  ...KEYS.map(key => ({ name: key as string, page: key, visibility: 'world' as const })),
  { name: 'openPrivate', page: 'open' as PageKey, visibility: 'private' as const },
];
const canaryOf = (name: string) => `cnryfact${name.toLowerCase()}zz`;
const factText = (name: string) => `Harbor ledger planning notes ${canaryOf(name)}`;

/** What the owner gets, over either transport, from every fact read below (engine-independent). */
const OWNER_FACTS = ['open', 'priv', 'ownerOrigin', 'fromOwner', 'openPrivate'];

const pageText = (title: string, fm: readonly string[]) =>
  ['---', 'type: note', `title: ${title}`, ...fm, '---', `# ${title}`, '', `Source notes for ${title}.`].join('\n');

type Who = 'owner-http' | 'owner-stdio';
const WHO: Who[] = ['owner-http', 'owner-stdio'];

async function seed(engine: BrainEngine): Promise<string> {
  __resetPrivateVisibilityCacheForTests();
  for (const id of [OWNER, BOB]) await addMember(engine, id);
  for (const key of KEYS) await importFromContent(engine, PAGES[key].slug, pageText(key, PAGES[key].fm), { sourceId: 'default', noEmbed: true } as never);
  await importFromContent(engine, ENTITY, ['---', 'type: person', 'title: Subject Example', '---', '# Subject Example', '', 'A person.'].join('\n'), { sourceId: 'default', noEmbed: true } as never);
  await engine.insertFacts(FACTS.map((f, i) => ({
    fact: factText(f.name), entity_slug: ENTITY, kind: 'fact', visibility: f.visibility, source: 'fence', row_num: i + 1,
    valid_from: new Date(Date.UTC(2026, 6, 1 + i)), source_markdown_slug: PAGES[f.page].slug,
  })) as never, { source_id: 'default' });
  const minted = await mintLegacyToken(engine, { name: 'owner', scopes: ['read'], takesHolders: ['world'], sourceGrant: ['default'] });
  await bindCredential(engine, { kind: 'token', id: minted.id }, { member: OWNER });
  await setOwner(engine, OWNER);
  await drainProjections(engine);
  return minted.token;
}

/** One tool call as the owner, over the caller's transport, as serve --http (an OAuth-verified token) or the stdio server does. */
async function call(engine: BrainEngine, token: string, who: Who, tool: string, params: Record<string, unknown>) {
  if (who === 'owner-stdio') {
    return dispatchToolCall(engine, tool, { ...params }, { remote: true, transport: 'stdio', sourceId: 'default', stdioMember: OWNER });
  }
  const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), engine });
  const auth = await provider.verifyAccessToken(token) as unknown as AuthInfo;
  const sourceId = auth.sourceId ?? 'default';
  const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
  return dispatchToolCall(engine, tool, { ...params }, {
    remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'],
    ...(localFederated ? { localFederatedSourceIds: localFederated } : {}),
  });
}

/** Keys that hold a generated id or a write time; the sequences and clocks differ per arm and per run. */
const VOLATILE = /(^|_)(id|ids)$|_at$|_revision$|^(revision|created|updated|fetched|content_hash|stale|effective_date|valid_from|valid_until|took_ms|elapsed_ms|latency_ms)$/;
const volatileText = (text: string) => text
  .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, '<time>')
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
  .replace(/\bfact \d+\b/g, 'fact <n>')
  .replace(/^\| \d+ \|/gm, '| <n> |');
function scrub(value: unknown): unknown {
  if (typeof value === 'string') return volatileText(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => !VOLATILE.test(k)).map(([k, v]) => [k, scrub(v)]));
  }
  return value;
}
/** The answer's JSON on its first line; notice lines after it carry no fact. */
function answerJson(text: string): unknown {
  const first = text.split('\n')[0] ?? '';
  try { return JSON.parse(first); } catch { /* not one-line JSON */ }
  try { return JSON.parse(text); } catch { return text; }
}

/** The facts (by name, in FACTS order) whose canary the answer names, the error code, and the scrubbed answer. */
async function observe(engine: BrainEngine, token: string, who: Who, tool: string, params: Record<string, unknown>) {
  const out = await call(engine, token, who, tool, params);
  const text = out.content.map(c => c.text).join('\n');
  const body = answerJson(text);
  const error = out.isError === true ? String((body as { code?: string })?.code ?? 'error') : null;
  const hay = error ? '' : text;
  return { error, facts: FACTS.map(f => f.name).filter(n => hay.includes(canaryOf(n))), payload: error ? { error, body: scrub(body) } : scrub(body) };
}

describe('engine parity: the brain owner\'s remote fact reads judge each fact by its source page', () => {
  parityTest('owner fact reads: recall, entity and get_page give the remote owner the facts of the pages it may read, never one from a page derived from another member\'s origin', {
    methods: ['listFactsByEntity', 'listFactsSince', 'insertFacts', 'getPage'],
  }, async (engine) => {
    const token = await seed(engine);
    const out: Record<string, unknown> = {};
    const reads: Array<[string, string, Record<string, unknown>]> = [
      ['recall entity', 'recall', { entity: ENTITY }],
      ['recall all', 'recall', {}],
      ['recall query', 'recall', { query: 'harbor ledger planning notes', limit: 100 }],
      ['entity', 'entity', { name: ENTITY }],
    ];
    for (const who of WHO) {
      const mine: Record<string, unknown> = {};
      for (const [label, tool, params] of reads) {
        const cell = await observe(engine, token, who, tool, params);
        expect({ who, what: label, error: cell.error, facts: cell.facts }).toEqual({ who, what: label, error: null, facts: OWNER_FACTS });
        if (label === 'recall query') {
          // Named loss, RUST_ENGINE.md row RQ-1: a plain recall query (no entity, session, since or supersessions selector)
          // ranks facts by the query on PGLite and Postgres, and answers the newest facts first on Rust (master's
          // `!lacksRawSql(ctx.engine)` guard in src/core/ops/facts.ts). The fact set is compared across arms below; the
          // order fields are pinned per engine here, so this case fails the day Rust ranks. When it fails that way: delete
          // this branch, compare the whole answer again (`mine[label] = cell.payload`, as for every other read), close row RQ-1
          // and drop its swap plan line (RUST_READ_LIMITS in src/core/engine-swap/failback.ts).
          const body = cell.payload as { facts_order?: unknown; facts_degraded?: unknown; facts?: Array<{ relevance?: unknown }> };
          const order = { who, facts_order: body.facts_order, facts_degraded: body.facts_degraded ?? null, ranked: (body.facts ?? []).some(f => f.relevance !== undefined) };
          expect(order).toEqual(engine.kind === 'rust'
            ? { who, facts_order: 'newest', facts_degraded: null, ranked: false }
            : { who, facts_order: 'relevance', facts_degraded: { reason: 'keyword_only_no_embedding_provider' }, ranked: true });
          mine[label] = { facts: cell.facts };
          continue;
        }
        mine[label] = cell.payload;
      }
      // get_page's fact table: compared across arms; it never carries a fact outside the owner's set.
      const page = await observe(engine, token, who, 'get_page', { slug: ENTITY });
      expect({ who, error: page.error, outside: page.facts.filter(f => !OWNER_FACTS.includes(f)) }).toEqual({ who, error: null, outside: [] });
      mine['get_page entity'] = page.payload;
      out[who] = mine;
    }
    await flushAccessReadLog();
    return out;
  });
});
