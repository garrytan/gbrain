/**
 * Multi-user lane L4, member lineage: the brain owner's six page reads (get_page, list_pages, search, get_tags,
 * get_backlinks, find_pages) in a principal session on a multi-user Rust store answer exactly as the same reads do on
 * PGLite (and Postgres when DATABASE_URL is set) under the record `remoteCallerAccess` builds for the owner's key.
 *
 * 1. Protects: an owner's read-only call carries member lineage (it reads the atoms and derived_from pages of the origins
 *    it reads); in a session the store builds that record (`scopeCallerRecord`) and derives every policy from it
 *    (`access_derive.rs`, the owner read rule). A write-class call has no lineage and reads no more than the rules allow.
 * 2. Fails when: a session read refuses (`engine_capability_missing`, the pre-lineage state), shows a page or a derived
 *    page PGLite hides, or hides one PGLite shows; or the fixture stops exercising lineage (the reference read-only and
 *    write-class answers must differ).
 *    The owner's key has the read scope only, as a read-only remote client's does: the session admits each read tool
 *    by the operation's own scope (as serve --http does for PGLite) and still refuses a write or admin tool.
 * 3. Real seams: the same seed on every arm (members, a folder rule, tokens minted by the token service and bound to
 *    members, the owner set by setOwner), the operation handlers called with a remote context, the Rust brain reopened
 *    with GBRAIN_RUST_MULTIUSER=1 so the store resolves multi-user mode at open (asserted in the run), and the session
 *    opened from the owner's bearer token.
 *
 * Needs the addon `bun run rust:build` writes (or GBRAIN_TEST_RUST_ENGINE_ADDON).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { loadRustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { openPrincipalSession } from '../src/core/rust-engine/principal-session.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { operations, operationsByName } from '../src/core/operations.ts';
import { buildOperationContext } from '../src/mcp/dispatch.ts';
import { operationScopesAllowed } from '../src/core/scope.ts';
import { remoteCallerAccess } from '../src/core/access/caller.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { proposeRevision } from '../src/core/access/policy.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { drainProjections } from '../src/core/page-state/projections.ts';
import { __resetPrivateVisibilityCacheForTests, withCallerAccess } from '../src/core/search/private-visibility.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { rustArmAddonPath } from './engine-parity/rust-arm.ts';

const OWNER = 'owner-example';
const BOB = 'bob-example';
const CAROL = 'carol-example';

/** Origins (each with an atom and a derived_from page) and plain pages; each readable by some callers and not others. */
const ORIGINS = {
  open: [] as string[],
  priv: ['visibility: private'],
  ownerOnly: [`readable_by: [${OWNER}]`],
  bob: [`readable_by: [${BOB}]`],
  nobody: ['readable_by: []'],
} as const;
const FOLDER = { 'partners/bob-example/plan': 'folderBob', 'partners/closed/plan': 'folderClosed' } as const;
const HUB = 'notes/hub-example';
const slugOf = (o: string) => `notes/${o.toLowerCase()}-example`;
const canary = (k: string) => `cnry${k.toLowerCase().replace(/[^a-z]/g, '')}zz`;
const doc = (title: string, type: string, fm: readonly string[]) =>
  ['---', `type: ${type}`, `title: ${title}`, ...fm, '---', `# ${title}`, '', `Harbor ledger planning notes ${canary(title)} for the roadmap.`].join('\n');

/** The six owner page reads L3 serves over HTTP, with the arguments each takes. */
const READS: Array<[string, string, Record<string, unknown>]> = [
  ...[...Object.keys(ORIGINS).flatMap(o => [slugOf(o), `atoms/${o.toLowerCase()}-atom`, `notes/${o.toLowerCase()}-derived`]), ...Object.keys(FOLDER)]
    .map(slug => [`get_page ${slug}`, 'get_page', { slug }] as [string, string, Record<string, unknown>]),
  ['list_pages', 'list_pages', { limit: 100 }],
  ['search', 'search', { query: 'harbor ledger planning notes', match: 'keyword', fields: 'full', limit: 50 }],
  ...[...Object.keys(ORIGINS).map(slugOf), ...Object.keys(FOLDER)].map(slug => [`get_tags ${slug}`, 'get_tags', { slug }] as [string, string, Record<string, unknown>]),
  ['get_backlinks hub', 'get_backlinks', { slug: HUB }],
  ['find_pages notes/*', 'find_pages', { pattern: 'notes/*' }],
  ['find_pages atoms/*', 'find_pages', { pattern: 'atoms/*' }],
  ['find_pages partners/*', 'find_pages', { pattern: 'partners/*' }],
];

async function seed(engine: BrainEngine): Promise<string> {
  __resetPrivateVisibilityCacheForTests();
  for (const id of [OWNER, BOB, CAROL]) await addMember(engine, id);
  await proposeRevision(engine, 'default', [
    { id: 'bob-folder', prefix: 'partners/bob-example/', readable_by: [`member:${BOB}`] },
    { id: 'closed-folder', prefix: 'partners/closed/', readable_by: [`member:${CAROL}`] },
  ], { origin: 'cli', store: 'database' });
  const put = (slug: string, text: string) => importFromContent(engine, slug, text, { sourceId: 'default', noEmbed: true } as never);
  await put(HUB, doc('hub', 'note', []));
  const links: Array<{ from_slug: string; to_slug: string; link_type: string; context: string }> = [];
  for (const [o, fm] of Object.entries(ORIGINS)) {
    const origin = slugOf(o);
    await put(origin, doc(o, 'note', fm));
    await put(`atoms/${o.toLowerCase()}-atom`, doc(`${o} atom`, 'atom', ['visibility: world', `source_slug: ${origin}`]));
    await put(`notes/${o.toLowerCase()}-derived`, doc(`${o} derived`, 'note', [`derived_from: [${origin}]`]));
    await engine.addTag(origin, `tag-${o.toLowerCase()}-zz`, { sourceId: 'default' });
    for (const from of [origin, `atoms/${o.toLowerCase()}-atom`, `notes/${o.toLowerCase()}-derived`]) links.push({ from_slug: from, to_slug: HUB, link_type: 'mentions', context: `${from} names hub` });
  }
  for (const [slug, key] of Object.entries(FOLDER)) {
    await put(slug, doc(key, 'note', []));
    await engine.addTag(slug, `tag-${key.toLowerCase()}-zz`, { sourceId: 'default' });
    links.push({ from_slug: slug, to_slug: HUB, link_type: 'mentions', context: `${key} names hub` });
  }
  await engine.addLinksBatch(links);
  const minted = await mintLegacyToken(engine, { name: 'owner', scopes: ['read'], takesHolders: ['world'], sourceGrant: ['default'] });
  await bindCredential(engine, { kind: 'token', id: minted.id }, { member: OWNER });
  await setOwner(engine, OWNER);
  await drainProjections(engine);
  return minted.token;
}

/** One operation handler called as a remote caller (what dispatch runs once the caller record is in place). */
async function read(engine: BrainEngine, auth: AuthInfo, tool: string, params: Record<string, unknown>): Promise<unknown> {
  const op = operations.find(o => o.name === tool);
  if (!op) throw new Error(`no operation ${tool}`);
  const ctx = buildOperationContext(engine, params, { remote: true, transport: 'http', auth, sourceId: 'default', takesHoldersAllowList: ['world'] });
  try { return scrub(await op.handler(ctx, params)); } catch (e) { return { error: (e as { code?: string }).code ?? String(e) }; }
}

const VOLATILE = /(^|_)(id|ids)$|_at$|_revision$|^(revision|created|updated|fetched|content_hash|stale|effective_date|took_ms|elapsed_ms|score|rank)$/;
function scrub(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, '<time>').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>');
  if (value instanceof Date) return '<time>';
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => !VOLATILE.test(k)).map(([k, v]) => [k, scrub(v)]));
  return value;
}

/** The fixture pages an answer names (by canary or slug), so a failure says which page leaked or went missing. */
function named(answer: unknown): string[] {
  const text = JSON.stringify(answer);
  const keys = [...Object.keys(ORIGINS).flatMap(o => [o, `${o} atom`, `${o} derived`]), ...Object.values(FOLDER)];
  return keys.filter(k => text.includes(canary(k)) || text.includes(k.includes(' ') ? `${k.split(' ')[0]!.toLowerCase()}-${k.split(' ')[1]}` : slugOf(k)));
}

type Answers = Record<string, unknown>;
const reference: Record<string, Record<'read' | 'write', Answers>> = {};

for (const kind of testBackends()) {
  describe(`owner page reads, reference arm (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
    }, 180_000);
    afterAll(async () => { await close?.(); });

    test('the owner key reads each page the way remoteCallerAccess says', async () => {
      const token = await seed(engine);
      const auth = await new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), engine }).verifyAccessToken(token) as unknown as AuthInfo;
      const out: Record<'read' | 'write', Answers> = { read: {}, write: {} };
      for (const [mode, readOnly] of [['read', true], ['write', false]] as const) {
        const access = await remoteCallerAccess(engine, auth, auth.privatePages?.sources, 'http', null, undefined, readOnly);
        for (const [label, tool, params] of READS) out[mode][label] = await withCallerAccess(access, () => read(engine, auth, tool, params));
      }
      // The fixture exercises lineage: the read-only call (lineage) reads derived pages the write-class call does not.
      const shown = (a: Answers) => READS.reduce((n, [label]) => n + named(a[label]).length, 0);
      expect(shown(out.read)).toBeGreaterThan(shown(out.write));
      expect(named(out.read['get_page atoms/owneronly-atom'])).toContain('ownerOnly atom');
      expect(named(out.write['get_page atoms/owneronly-atom'])).toEqual([]);
      reference[kind] = out;
    }, 180_000);
  });
}

describe('owner page reads in a principal session on a multi-user Rust store', () => {
  let engine: RustEngine;
  let dir: string;
  let token: string;
  let auth: AuthInfo;
  const saved = process.env.GBRAIN_RUST_MULTIUSER;
  beforeAll(async () => {
    delete process.env.GBRAIN_RUST_MULTIUSER;
    dir = mkdtempSync(join(tmpdir(), 'gbrain-session-owner-reads-'));
    engine = openRustEngine({ addon: await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: rustArmAddonPath() } }), databasePath: join(dir, 'db') });
    await engine.connect({ engine: 'rust', database_path: join(dir, 'db') } as never);
    await engine.initSchema();
    token = await seed(engine);
    // The token verified as serve --http does, before the reopen (the same AuthInfo the reference arms build).
    auth = await new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), engine }).verifyAccessToken(token) as unknown as AuthInfo;
    // The store resolves multi-user mode when it opens: reopen with the switch set.
    await engine.disconnect();
    process.env.GBRAIN_RUST_MULTIUSER = '1';
    await engine.connect({ engine: 'rust', database_path: join(dir, 'db') } as never);
  }, 180_000);
  afterAll(async () => {
    await engine?.disconnect();
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.GBRAIN_RUST_MULTIUSER; else process.env.GBRAIN_RUST_MULTIUSER = saved;
  });

  test('each read answers as on every reference arm, read-only (lineage) and write-class alike', async () => {
    const store = engine.openStore('session-owner-reads');
    expect(store.multiuser).toBe(true);
    const session = await openPrincipalSession(store, token);
    const out: Record<'read' | 'write', Answers> = { read: {}, write: {} };
    try {
      for (const [mode, readOnly] of [['read', true], ['write', false]] as const) {
        for (const [label, tool, params] of READS) {
          out[mode][label] = await session.run(tool, { readOnly, privateReadableSources: auth.privatePages?.sources ?? [] }, () => read(engine, auth, tool, params));
        }
      }
      // A write-class tool from the read-scope key still refuses, before any work, as serve --http refuses it on PGLite.
      for (const tool of ['put_page', 'add_tag', 'delete_page', 'sources_add', 'no_such_tool']) {
        let ran = false;
        const refused = await session.run(tool, { readOnly: false }, async () => { ran = true; }).then(() => 'ok', e => (e as { code?: string }).code);
        const http = operationsByName[tool] ? operationScopesAllowed(auth.scopes ?? [], operationsByName[tool]!) : false;
        expect({ tool, refused, ran, http }).toEqual({ tool, refused: 'permission_denied', ran: false, http: false });
      }
    } finally { session.release(); }
    expect(auth.scopes).toEqual(['read']);
    expect(Object.keys(reference).sort()).toEqual([...testBackends()].sort());
    for (const [kind, ref] of Object.entries(reference)) {
      for (const mode of ['read', 'write'] as const) {
        for (const [label] of READS) {
          expect({ kind, mode, label, pages: named(out[mode][label]) }).toEqual({ kind, mode, label, pages: named(ref[mode][label]) });
        }
        expect({ kind, mode, answers: out[mode] }).toEqual({ kind, mode, answers: ref[mode] });
      }
    }
  }, 180_000);
});
