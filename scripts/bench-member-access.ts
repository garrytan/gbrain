/**
 * GBRA-218 member read access: remote search latency and recall benchmark.
 *
 * Seeds a synthetic one-source brain on in-process PGLite (repo-less), with a
 * share of pages naming readers, then runs remote search calls through MCP
 * dispatch as serve --http does, for an unbound token and a member token.
 * Reports p50/p95 per cell and hit@10 against a pre-filter oracle: the pages
 * the member may read that contain every query word, known by construction
 * (the synthetic corpus gives each page distinct words; capped at 10). PGLite is in-process, so
 * runs on two revisions are directly comparable; on a revision without member
 * tables only the 0% cell runs. --rules adds that many folder rules (A2) on
 * prefixes no page lives under, so the cell measures what the folder layer
 * costs a brain whose pages it does not restrict. On a revision with shared agents (GBRA-231), restricted shares
 * add two cells for a bot token whose harness names an audience: `aud1` (the member alone) and `aud2` (the member and
 * a second member who reads the same restricted pages, so recall matches the member's). A search that fails, loses its
 * vector arm or reports any degraded stage (other than the reranker this keyless bench never configures) stops the run.
 *
 * Usage: bun scripts/bench-member-access.ts [--pages 5000] [--queries 60] [--shares 0,0.2,0.8] [--rules 0] [--json]
 */
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';

const arg = (name: string, def: number) => { const i = process.argv.indexOf(name); return i > 0 ? Number(process.argv[i + 1]) : def; };
const PAGES = arg('--pages', 5000);
const QUERIES = arg('--queries', 60);
const JSON_MODE = process.argv.includes('--json');
const SHARES = (process.argv.includes('--shares') ? process.argv[process.argv.indexOf('--shares') + 1] : '0,0.2,0.8').split(',').map(Number);
const RULES = (process.argv.includes('--rules') ? process.argv[process.argv.indexOf('--rules') + 1] : '0').split(',').map(Number);
const DIMS = 1536;
const SRC = 'bench-src';
const SYLLABLES = 'ba ce di fo gu ha je ki lo mu na pe qi ro su ta ve wi xo yu za'.split(' ');
const VOCAB = Array.from({ length: 4000 }, (_, i) => SYLLABLES[i % 21] + SYLLABLES[Math.floor(i / 21) % 21] + SYLLABLES[Math.floor(i / 441) % 21] + 'n');
/** Deterministic word j of page i (a fixed LCG), so both brains and both revisions see the same corpus. */
const wordOf = (i: number, j: number) => VOCAB[((i + 1) * 2654435761 + (j + 1) * 40503) % 4294967296 % VOCAB.length];

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
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

async function newEngine(): Promise<PGLiteEngine> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
  await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
  return engine;
}

/** Page i: its readers at this restricted share (null = open) and whether the member may read it. */
function pageSpec(i: number, share: number): { readers: string | null; memberReads: boolean } {
  const restricted = share > 0 && (share >= 0.5 ? i % 5 !== 0 : i % Math.round(1 / share) === 0);
  return { readers: restricted ? (i % 2 === 0 ? '[alice-example, alice-twin]' : '[group:team-b]') : null, memberReads: !restricted || i % 2 === 0 };
}

async function seed(engine: PGLiteEngine, share: number): Promise<void> {
  for (let i = 0; i < PAGES; i++) {
    const { readers } = pageSpec(i, share);
    const words = Array.from({ length: 12 }, (_, j) => wordOf(i, j));
    const fm = ['---', 'type: note', `title: Page ${i}`, ...(readers ? [`readable_by: ${readers}`] : []), '---'].join('\n');
    await importFromContent(engine, `notes/page-${i}`, `${fm}\n# Page ${i}\n\nNotes about the ${words.join(' ')} for item ${i}.`, { sourceId: SRC });
  }
}

async function runCell(share: number, rules: number) {
  const engine = await newEngine();
  const hasMembers = (await engine.executeRaw<{ t: string | null }>("SELECT to_regclass('access_members')::text AS t"))[0]?.t != null;
  const hasRules = (await engine.executeRaw<{ t: string | null }>("SELECT to_regclass('access_rules')::text AS t"))[0]?.t != null;
  if ((share > 0 && !hasMembers) || (rules > 0 && !hasRules)) { await engine.disconnect(); return null; }
  await seed(engine, share);
  if (rules > 0) {
    const { proposeRevision } = await import('../src/core/access/policy.ts');
    await proposeRevision(engine, SRC, Array.from({ length: rules }, (_, k) => ({ id: `r-${k}`, prefix: `restricted/r-${k}/`, readable_by: ['member:alice-example'] })), { origin: 'cli', store: 'database' });
  }

  // Share 0 is a brain with no restriction at all (no member, no readers), the case nearly every brain is in; its
  // "member" token is a second unbound token. Restricted shares create the member and bind it.
  const bindMember = hasMembers && share > 0;
  if (bindMember) await engine.executeRaw("INSERT INTO access_members (id) VALUES ('alice-example') ON CONFLICT DO NOTHING");
  const mint = async (name: string) => mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] });
  const unbound = await mint('bench-unbound');
  const alice = await mint('bench-alice');
  if (bindMember) await engine.executeRaw('UPDATE access_tokens SET member_id = $2 WHERE id = $1::uuid', [alice.id, 'alice-example']);
  const audiences = bindMember && await import('../src/core/access/audience.ts').then(() => true, () => false);
  const bot = audiences ? await mint('bench-bot') : null;
  if (bot) {
    await engine.executeRaw("INSERT INTO access_members (id) VALUES ('alice-twin') ON CONFLICT DO NOTHING");
    await engine.executeRaw("UPDATE access_tokens SET may_act_for = ARRAY['member:alice-example', 'member:alice-twin'] WHERE id = $1::uuid", [bot.id]);
  }
  const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

  async function remote(token: string, params: Record<string, unknown>, header?: string) {
    const auth = await provider.verifyAccessToken(token) as unknown as AuthInfo;
    const sourceId = auth.sourceId ?? 'default';
    const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
    const t0 = performance.now();
    const out = await dispatchToolCall(engine, 'search', params, { remote: true, transport: 'http', auth, sourceId,
      takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'], ...(localFederated ? { localFederatedSourceIds: localFederated } : {}),
      ...(header ? { onBehalfOf: { header } } : {}) } as Parameters<typeof dispatchToolCall>[3]);
    const text = out.content.map(c => c.text).join('\n');
    const degraded = ((out._meta?.retrieval as { degraded?: Array<{ stage?: string }> } | undefined)?.degraded ?? []).filter(d => d.stage !== 'reranker_skipped');
    if (out.isError || text.includes('vector_arm_failed') || degraded.length) throw new Error(`bench search degraded or failed: ${JSON.stringify(degraded)} ${text.slice(0, 300)}`);
    return { ms: performance.now() - t0, text };
  }
  const slugsIn = (text: string) => [...new Set(text.match(/notes\/page-\d+/g) ?? [])];

  const cells: Record<string, unknown>[] = [];
  for (const match of ['keyword', 'hybrid'] as const) {
    const whos = bot ? ['unbound', 'member', 'aud1', 'aud2'] as const : ['unbound', 'member'] as const;
    const times: Record<string, number[]> = Object.fromEntries(whos.map(w => [w, []]));
    const hits: Record<string, number> = {}, possible: Record<string, number> = {};
    for (let q = 0; q < QUERIES + 5; q++) {
      const page = share > 0 ? [...Array(PAGES).keys()].filter(j => pageSpec(j, share).memberReads)[(q * 7919) % PAGES % Math.max(1, Math.round(PAGES * (share >= 0.5 ? 0.6 : 0.9)))] ?? 0 : (q * 7919) % PAGES;
      const query = `${wordOf(page, q % 12)} ${wordOf(page, (q + 5) % 12)}`;
      const params = { query, limit: 10, ...(match === 'keyword' ? { match: 'keyword' } : {}) };
      const order = whos.map((_, k) => whos[(k + q) % whos.length]!);
      for (const who of order) {
        const { ms, text } = await (who === 'aud1' ? remote(bot!.token, params, 'alice-example') : who === 'aud2' ? remote(bot!.token, params, 'alice-example, alice-twin')
          : remote(who === 'member' ? alice.token : unbound.token, params));
        if (q >= 5) times[who]!.push(ms);
        if (who !== 'unbound' && share > 0 && q >= 5) {
          const words = query.split(' ');
          const want = Array.from({ length: PAGES }, (_, j) => j)
            .filter(j => pageSpec(j, share).memberReads && words.every(w => Array.from({ length: 12 }, (_, k) => wordOf(j, k)).includes(w)))
            .slice(0, 10).map(j => `notes/page-${j}`);
          const got = new Set(slugsIn(text));
          hits[who] = (hits[who] ?? 0) + want.filter(s => got.has(s)).length;
          possible[who] = (possible[who] ?? 0) + want.length;
        }
      }
    }
    for (const who of whos) {
      cells.push({ share, rules, who, match, p50: +pct(times[who]!, 0.5).toFixed(2), p95: +pct(times[who]!, 0.95).toFixed(2),
        ...(possible[who] ? { hit_at_10: +(hits[who]! / possible[who]!).toFixed(3) } : {}) });
    }
  }
  await engine.disconnect();
  return cells;
}

configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'bench' } });
__setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
const all: Record<string, unknown>[] = [];
for (const share of SHARES) {
  for (const rules of RULES) {
    const cells = await runCell(share, rules);
    if (cells) all.push(...cells);
  }
}
if (JSON_MODE) console.log(JSON.stringify({ pages: PAGES, queries: QUERIES, cells: all }));
else console.table(all);
process.exit(0);
