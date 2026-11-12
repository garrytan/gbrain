/**
 * Shared fixture for the GBRA-108 access-design tests (raw-only rules, audience members, members-read-lineage): one
 * brain with origins, their derived pages (an atom, a derived_from page, a synthesized concept, a Life Chronicle event)
 * and a world fact per origin (on an open entity page, provenance on the origin), read through MCP dispatch with real
 * tokens over every read path. Rules live in the database (repo-less) or in a committed .gbrain/access.yml (git).
 * Every origin and derived page has an older version, and links to an open hub page.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';
import { parseRescopeTokenArgs, rescopeLegacyToken } from '../../src/core/grants/legacy-token.ts';
import { noGrantFederatedScope } from '../../src/core/source-resolver.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../../src/core/search/private-visibility.ts';
import { setOwner } from '../../src/core/access/owner.ts';
import { bindCredential } from '../../src/core/access/members.ts';
import { applyApproved, getRevision, previewApply, proposeRevision, type ProposalResult } from '../../src/core/access/policy.ts';
import { POLICY_FILE, syncGitPolicy, writeApprovedFile, writeGitRules } from '../../src/core/access/policy-git.ts';
import { serializePolicyYaml, type FolderRule } from '../../src/core/access/folder-rules.ts';
import { performSync } from '../../src/commands/sync.ts';
import { openAsPreview } from '../../src/cli/as-preview.ts';
import type { AuthInfo } from '../../src/core/ops/contract.ts';
import { isolatedPersistencePostgres } from './persistence-postgres.ts';

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

export const DERIVED = ['atom', 'df', 'concept', 'event'] as const;
export const ENTITY = 'people/entity-example';
export const HUB = 'notes/hub-example';

export interface OriginSpec { slug: string; fm: string[]; derive: boolean }
export interface CallerSpec { name: string; member?: string; grantedSources?: boolean; mayActFor?: string[]; audience?: string[]; as?: string }
export interface LineageSpec {
  kind: 'pglite' | 'postgres';
  store: 'database' | 'git';
  src: string;
  tag: string;
  origins: Record<string, OriginSpec>;
  rules: FolderRule[];
  members: string[];
  groups?: Record<string, string[]>;
  owner?: string;
  callers: CallerSpec[];
}

export type Seen = Record<string, string[]>;

export interface LineageBrain {
  engine: BrainEngine;
  keys: string[];
  pageSlug(key: string): string | null;
  canary(key: string): string;
  call(who: string, op: string, params: Record<string, unknown>): Promise<string>;
  seenBy(who: string): Promise<Seen>;
  expected(pages: string[], facts: string[]): Seen;
  setRules(rules: FolderRule[]): Promise<ProposalResult>;
  approve(): Promise<string>;
  tokenIds: Record<string, string>;
  close(): Promise<void>;
}

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Every read path: [label, op, params, per-page]. */
const READS: Array<[string, string, (slug: string) => Record<string, unknown>, 'page' | 'list' | 'versions' | 'backlinks']> = [
  ['get_page', 'get_page', slug => ({ slug }), 'page'],
  ['get_versions', 'get_versions', slug => ({ slug, include_body: true, limit: 10 }), 'versions'],
  ['list_pages', 'list_pages', () => ({ limit: 100 }), 'list'],
  ['backlinks', 'get_backlinks', () => ({ slug: HUB }), 'backlinks'],
  ['search', 'search', () => ({ query: 'harbor ledger planning notes', autocut: false, fields: 'full', limit: 100 }), 'list'],
  ['search keyword', 'search', () => ({ query: 'planning notes', match: 'keyword', autocut: false, fields: 'full', limit: 100 }), 'list'],
  ['query', 'query', () => ({ query: 'harbor ledger planning notes', expand: false, autocut: false, fields: 'full', limit: 100 }), 'list'],
  ['recall since', 'recall', () => ({ since: '2000-01-01', limit: 100 }), 'list'],
  ['recall question', 'recall', () => ({ question: 'harbor fact planning' }), 'list'],
  ['recall entity', 'recall', () => ({ entity: ENTITY }), 'list'],
];

export async function buildLineageBrain(spec: LineageSpec): Promise<LineageBrain> {
  const { kind, store, src, tag } = spec;
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
  let engine: BrainEngine;
  let closeEngine: () => Promise<void>;
  if (kind === 'postgres') ({ engine, close: closeEngine } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
  else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); closeEngine = () => engine.disconnect(); }
  __resetPrivateVisibilityCacheForTests();
  const canary = (key: string) => 'canary' + tag + key.replace(/[^a-z]/g, '') + 'x';
  const oldCanary = (key: string) => 'canaryold' + tag + key.replace(/[^a-z]/g, '') + 'x';
  const slugOf = (o: string, d: string) => ({ atom: `atoms/${o}-atom`, df: `notes/${o}-derived`, concept: `concepts/${o}-concept`, event: `events/${o}-event` })[d]!;
  const keys: string[] = [];
  for (const [o, s] of Object.entries(spec.origins)) {
    keys.push(o);
    if (s.derive) { for (const d of DERIVED) keys.push(o + '.' + d); keys.push(o + '.fact'); }
  }
  const pageSlug = (key: string): string | null => {
    const [o, d] = key.split('.') as [string, string | undefined];
    return d === undefined ? spec.origins[o]!.slug : d === 'fact' ? null : slugOf(o, d);
  };
  const doc = (title: string, key: string, fm: readonly string[], type = 'note', old = false) =>
    ['---', 'type: ' + type, 'title: ' + title, ...fm, '---', '# ' + title, '', 'Harbor ledger planning notes ' + (old ? oldCanary(key) : canary(key)) + ' here.'].join('\n');

  for (const id of spec.members) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
  for (const [g, ms] of Object.entries(spec.groups ?? {})) {
    await engine.executeRaw('INSERT INTO access_groups (id) VALUES ($1)', [g]);
    for (const m of ms) await engine.executeRaw('INSERT INTO access_group_members (group_id, member_id) VALUES ($1, $2)', [g, m]);
  }
  let root = '';
  if (store === 'git') {
    root = mkdtempSync(join(tmpdir(), 'gbrain-lineage-'));
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 't@t.co');
    git(root, 'config', 'user.name', 't');
    await engine.executeRaw("INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, '{}')", [src, root]);
    for (const old of [true, false]) {
      for (const [o, s] of Object.entries(spec.origins)) {
        mkdirSync(join(root, s.slug, '..'), { recursive: true });
        writeFileSync(join(root, s.slug + '.md'), doc(o + ' origin', o, s.fm, 'note', old) + '\n');
      }
      mkdirSync(join(root, '.gbrain'), { recursive: true });
      writeFileSync(join(root, POLICY_FILE), serializePolicyYaml(spec.rules));
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', old ? 'pages and policy' : 'pages again');
      await performSync(engine, { sourceId: src, repoPath: root, noPull: true, noEmbed: true, full: true, concurrency: 1 });
    }
  } else {
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [src]);
    await proposeRevision(engine, src, spec.rules, { origin: 'cli', store: 'database' });
    for (const old of [true, false]) {
      for (const [o, s] of Object.entries(spec.origins)) await importFromContent(engine, s.slug, doc(o + ' origin', o, s.fm, 'note', old), { sourceId: src });
    }
  }
  // The entity and hub pages carry their own types, so search's type-diversity cap (60% per type) never trims the pages under test.
  await importFromContent(engine, ENTITY, doc('entity', 'entity', [], 'person').replace('Harbor ledger planning notes', 'Anchor page'), { sourceId: src });
  await importFromContent(engine, HUB, doc('hub', 'hub', [], 'project').replace('Harbor ledger planning notes', 'Anchor page'), { sourceId: src });
  for (const [o, s] of Object.entries(spec.origins)) {
    await engine.addLink(s.slug, HUB, 'hub', 'mentions', 'fixture', undefined, undefined, { fromSourceId: src, toSourceId: src });
    if (!s.derive) continue;
    for (const old of [true, false]) {
      await importFromContent(engine, slugOf(o, 'atom'), doc(o + ' atom', o + '.atom', ['visibility: world', 'source_slug: ' + s.slug], 'atom', old), { sourceId: src });
      await importFromContent(engine, slugOf(o, 'df'), doc(o + ' derived', o + '.df', ['derived_from: [' + s.slug + ']'], 'note', old), { sourceId: src });
      await importFromContent(engine, slugOf(o, 'concept'), doc(o + ' concept', o + '.concept', ['visibility: world', 'synthesized_by: fixture'], 'concept', old), { sourceId: src });
      await importFromContent(engine, slugOf(o, 'event'), doc(o + ' event', o + '.event', ['captured_via: life-chronicle:fixture', 'event:', '  depth: ' + s.slug], 'event', old), { sourceId: src });
    }
    await engine.addLink(slugOf(o, 'concept'), slugOf(o, 'atom'), 'input', 'synthesized_from', 'concept-provenance', undefined, undefined, { fromSourceId: src, toSourceId: src });
    for (const d of DERIVED) await engine.addLink(slugOf(o, d), HUB, 'hub', 'mentions', 'fixture', undefined, undefined, { fromSourceId: src, toSourceId: src });
    await engine.executeRaw("INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, source_markdown_slug, valid_from) VALUES ($1, $2, $3, 'fact', 'world', 'fixture', $4, now())",
      [src, ENTITY, 'Harbor fact planning ' + canary(o + '.fact'), s.slug]);
  }
  const tokens: Record<string, string> = {};
  const tokenIds: Record<string, string> = {};
  const callers = new Map(spec.callers.map(c => [c.name, c]));
  for (const c of spec.callers) {
    if (c.as) continue;
    const minted = await mintLegacyToken(engine, { name: c.name, scopes: ['read'], takesHolders: ['world'], sourceGrant: [src] });
    tokens[c.name] = minted.token;
    tokenIds[c.name] = minted.id;
    if (c.member || c.mayActFor) await bindCredential(engine, { kind: 'token', id: minted.id }, { ...(c.member ? { member: c.member } : {}), ...(c.mayActFor ? { mayActFor: c.mayActFor } : {}) });
    if (c.grantedSources) await rescopeLegacyToken(engine, parseRescopeTokenArgs([c.name, '--private-pages', 'granted-sources']));
  }
  if (spec.owner) await setOwner(engine, spec.owner);
  const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

  async function call(who: string, op: string, params: Record<string, unknown>): Promise<string> {
    const c = callers.get(who);
    if (!c) throw new Error('unknown caller ' + who);
    if (c.as) {
      const preview = await openAsPreview(engine, c.as, op, true);
      const out = await preview.run(() => dispatchToolCall(engine, op, { ...params }, preview.context({ remote: false, sourceId: src }) as never));
      return out.content.map(x => x.text).join('\n');
    }
    const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
    const sourceId = auth.sourceId ?? 'default';
    const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
    const out = await dispatchToolCall(engine, op, { ...params }, {
      remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'],
      ...(localFederated ? { localFederatedSourceIds: localFederated } : {}),
      ...(c.audience ? { onBehalfOf: { header: c.audience.join(','), requestMeta: undefined } } : {}),
    });
    return out.content.map(x => x.text).join('\n');
  }

  async function seenBy(who: string): Promise<Seen> {
    __resetPrivateVisibilityCacheForTests();
    const out: Seen = {};
    for (const [label, op, params, mode] of READS) {
      const seen = new Set<string>();
      if (mode === 'page' || mode === 'versions') {
        for (const key of keys) {
          const slug = pageSlug(key);
          if (!slug) continue;
          const text = await call(who, op, params(slug));
          if (text.includes(mode === 'versions' ? oldCanary(key) : canary(key))) seen.add(key);
        }
      } else {
        const text = await call(who, op, params(''));
        for (const key of keys) {
          const slug = pageSlug(key);
          if (mode === 'backlinks' || label === 'list_pages' ? (slug !== null && text.includes('"' + slug + '"')) : text.includes(canary(key))) seen.add(key);
        }
      }
      out[label] = keys.filter(k => seen.has(k));
    }
    return out;
  }

  /** What a caller reading exactly these page keys and fact keys sees on every path. */
  const expected = (pages: string[], facts: string[]): Seen => {
    const out: Seen = {};
    for (const [label, op] of READS) {
      out[label] = op === 'recall' ? keys.filter(k => facts.includes(k))
        : op === 'query' ? keys.filter(k => pages.includes(k) || facts.includes(k))
        : keys.filter(k => pages.includes(k));
    }
    return out;
  };

  async function setRules(rules: FolderRule[]): Promise<ProposalResult> {
    if (store === 'database') return proposeRevision(engine, src, rules, { origin: 'cli', store: 'database' });
    const { sync } = await writeGitRules(engine, src, root, rules, 'access: fixture rules');
    if (!sync.proposal) throw new Error('git rules produced no proposal: ' + JSON.stringify(sync));
    return sync.proposal;
  }

  async function approve(): Promise<string> {
    const preview = await previewApply(engine, src);
    if (!preview.plan_hash) throw new Error('nothing to approve');
    const r = await applyApproved(engine, src, { expect: preview.plan_hash });
    if (store === 'git') {
      const approved = (await getRevision(engine, src, r.revision ?? undefined))?.rules ?? [];
      await writeApprovedFile(root, approved, 'access: approve fixture rules');
      await syncGitPolicy(engine, src, root);
    }
    return preview.plan_hash;
  }

  return {
    engine, keys, pageSlug, canary, call, seenBy, expected, setRules, approve, tokenIds,
    close: async () => {
      __setEmbedTransportForTests(null);
      resetGateway();
      await closeEngine();
      if (root) rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Every key of \`keys\` that starts with one of \`origins\` and is a derived page (not the origin, not the fact). */
export function derivedOf(keys: readonly string[], origins: readonly string[]): string[] {
  return keys.filter(k => { const [o, d] = k.split('.'); return d !== undefined && d !== 'fact' && origins.includes(o!); });
}

/** The fact keys of \`origins\`. */
export function factsOf(keys: readonly string[], origins: readonly string[]): string[] {
  return keys.filter(k => { const [o, d] = k.split('.'); return d === 'fact' && origins.includes(o!); });
}
