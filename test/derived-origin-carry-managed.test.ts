/**
 * GST-2689 on managed brains with a Git checkout: a derived page whose only privacy is its private origin keeps it once
 * the origin row is gone, and the label it gets is one changed line in its file, published through the Git door.
 *
 * 1. Protects: a `git rm` of a private origin followed by sync (the managed sync soft-deletes the page) and the consented
 *    retention purge, an explicit local `delete_page purge: true`, and a remote delete each stamp `visibility: private`
 *    on every derived_from page, atom and concept that would gain a reader, before the origin row is removed; each file
 *    changes only in that label line, untouched pages keep their bytes, and an unbound remote caller reads none of them
 *    through get_page, get_versions, list_pages or search, before or after. A remote delete's stamp is a maintenance
 *    write whose batch names the delete's request id.
 * 2. Fails when: a derived page opens once the origin row goes, a file changes beyond its label line, or the remote
 *    stamp is not a maintenance write tied to its delete.
 * 3. Real seams: a claimed worktree with Git and managed persistence (helpers/managed-brain.ts), managed sync, the
 *    `gbrain pages purge-deleted` command entry, MCP dispatch with a minted owner token; PGLite always, Postgres with DATABASE_URL.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { AuthInfo, OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { SYNC_DELETE_TOMBSTONE_OP } from '../src/core/persistence/sync-delete-tombstones.ts';
import { runPages } from '../src/commands/pages.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { bindCredential } from '../src/core/access/members.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const OWNER = 'owner-example';

const CARRIED = ['digest', 'atom', 'concept'] as const;
const UNTOUCHED = ['own', 'plain'] as const;
type Shape = 'origin' | typeof CARRIED[number] | typeof UNTOUCHED[number];
const SHAPES: Shape[] = ['origin', ...CARRIED, ...UNTOUCHED];
const slugOf = (k: string, shape: Shape) => `notes/${k}-${shape}`;
const canaryOf = (k: string, shape: Shape) => `canary${k}${shape}`;
function fileText(k: string, shape: Shape): string {
  const origin = slugOf(k, 'origin');
  const fm: Record<Shape, string[]> = {
    origin: ['type: note', 'visibility: private'],
    digest: ['type: note', `derived_from: ${origin}.md`],
    atom: ['type: atom', 'visibility: world', `source_slug: ${origin}`],
    concept: ['type: concept', 'synthesized_by: test', 'visibility: world'],
    own: ['type: note', 'visibility: private', `derived_from: [${origin}]`],
    plain: ['type: note'],
  };
  return ['---', `title: ${k} ${shape}`, ...fm[shape], '---', '', `Harbor ledger planning notes ${canaryOf(k, shape)} for the roadmap.`, ''].join('\n');
}
const KEYS = ['gitrm', 'purge', 'remote', 'midpurge'];
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q', '-b', 'main');
  for (const k of KEYS) for (const shape of SHAPES) writeFileSync(join(root, `${slugOf(k, shape)}.md`), fileText(k, shape));
  commit(root, 'notes');
};

/** A fixture write outside coordination (links have no file), as the managed suites age tombstones. */
async function fixtureWrite(engine: BrainEngine, fn: () => Promise<unknown>): Promise<void> {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try { await fn(); } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
}
const provenance = (engine: BrainEngine, k: string) => fixtureWrite(engine, () => engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
  SELECT c.id, a.id, 'synthesized_from', 'concept-provenance' FROM pages c, pages a WHERE c.source_id='default' AND a.source_id='default' AND c.slug=$1 AND a.slug=$2`,
[slugOf(k, 'concept'), slugOf(k, 'atom')]));
async function age(engine: BrainEngine, hours: number): Promise<void> {
  await fixtureWrite(engine, async () => {
    await engine.executeRaw(`UPDATE pages SET deleted_at = deleted_at - ($1 || ' hours')::interval WHERE source_id='default' AND deleted_at IS NOT NULL`, [String(hours)]);
    await engine.executeRaw(`UPDATE op_checkpoints c SET completed_keys = jsonb_set(c.completed_keys, '{0,deleted_at}', to_jsonb(p.deleted_at)) FROM pages p
      WHERE c.op=$1 AND p.id::text = c.fingerprint`, [SYNC_DELETE_TOMBSTONE_OP]);
  });
}
async function cli(engine: BrainEngine, args: string[]): Promise<void> {
  const log = spyOn(console, 'log').mockImplementation(() => {});
  const err = spyOn(console, 'error').mockImplementation(() => {});
  try { await withEnv({ GBRAIN_CONSENT: undefined }, () => runPages(engine, args)); }
  finally { log.mockRestore(); err.mockRestore(); }
}
const page = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ deleted_at: string | null; frontmatter: unknown }>(
  "SELECT deleted_at, frontmatter FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0];
const fmOf = async (engine: BrainEngine, slug: string) => { const fm = (await page(engine, slug))!.frontmatter; return (typeof fm === 'string' ? JSON.parse(fm) : fm) as Record<string, unknown>; };

/** What an unbound remote caller reads of each page, per read path. */
async function unboundReads(engine: BrainEngine, k: string, shapes: readonly Shape[]) {
  __resetPrivateVisibilityCacheForTests();
  const ctx = { engine, config: { engine: engine.kind }, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: true, sourceId: 'default' } as unknown as OperationContext;
  const text = (value: unknown) => JSON.stringify(value);
  const attempt = async (fn: () => Promise<unknown>) => { try { return text(await fn()); } catch { return ''; } };
  const out: Record<string, unknown> = {};
  for (const shape of shapes) {
    const slug = slugOf(k, shape), canary = canaryOf(k, shape);
    out[shape] = {
      get_page: (await attempt(() => operationsByName.get_page!.handler(ctx, { slug }))).includes(canary),
      get_versions: (await attempt(() => operationsByName.get_versions!.handler(ctx, { slug, include_body: true }))).includes(canary),
      list_pages: (await attempt(() => operationsByName.list_pages!.handler(ctx, { limit: 100 }))).includes(`"${slug}"`),
      search: (await attempt(() => operationsByName.search!.handler(ctx, { query: canary, match: 'keyword', fields: 'full', limit: 20 }))).includes(canary),
    };
  }
  return out;
}
const hidden = { get_page: false, get_versions: false, list_pages: false, search: false };

/** The contract after the origin row is gone: label line only, untouched bytes kept, nothing opens. */
async function expectCarried(engine: BrainEngine, root: string, k: string, files: Record<string, string>): Promise<void> {
  await settleManagedGitEffects(engine);
  expect(await page(engine, slugOf(k, 'origin'))).toBeUndefined();
  for (const shape of CARRIED) {
    const slug = slugOf(k, shape);
    expect({ shape, visibility: (await fmOf(engine, slug)).visibility }).toEqual({ shape, visibility: 'private' });
    const after = readFileSync(join(root, `${slug}.md`), 'utf8');
    const lines = (text: string) => text.split('\n').filter(line => !line.startsWith('visibility:'));
    expect({ shape, label: after.split('\n').filter(line => line.startsWith('visibility:')) }).toEqual({ shape, label: ['visibility: private'] });
    expect({ shape, rest: lines(after) }).toEqual({ shape, rest: lines(files[shape]!) });
  }
  for (const shape of UNTOUCHED) expect({ shape, bytes: readFileSync(join(root, `${slugOf(k, shape)}.md`), 'utf8') }).toEqual({ shape, bytes: files[shape] });
  const others = SHAPES.filter(s => s !== 'origin' && s !== 'plain');
  expect(await unboundReads(engine, k, others)).toEqual(Object.fromEntries(others.map(s => [s, hidden])));
}

async function before(engine: BrainEngine, root: string, k: string): Promise<Record<string, string>> {
  await provenance(engine, k);
  expect(await unboundReads(engine, k, CARRIED)).toEqual(Object.fromEntries(CARRIED.map(s => [s, hidden])));
  return Object.fromEntries(SHAPES.map(s => [s, readFileSync(join(root, `${slugOf(k, s)}.md`), 'utf8')]));
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`${backend}: managed repo brain, derived pages keep their origin's privacy`, () => {
    test('git rm of the origin, sync, then the consented retention purge: the derived files gain the label line before the row goes', () => managedBrain(async ({ engine, root }) => {
      await performManagedSync(engine, OPTS);
      const k = 'gitrm', origin = slugOf(k, 'origin');
      const files = await before(engine, root, k);
      git(root, 'rm', '-q', `${origin}.md`); commit(root, 'remove the origin');
      await performManagedSync(engine, OPTS);
      expect((await page(engine, origin))?.deleted_at).not.toBeNull();
      await age(engine, 100);
      await cli(engine, ['purge-deleted', '--json', '--yes']);
      await expectCarried(engine, root, k, files);
    }, { setup, databaseUrl }), 300_000);

    test('the managed retention purge rechecks inside its transaction: a derived page written after the carry parks the origin and skips its row', () => managedBrain(async ({ engine, root }) => {
      await performManagedSync(engine, OPTS);
      const k = 'midpurge', origin = slugOf(k, 'origin'), late = `notes/${k}-late`;
      await before(engine, root, k);
      git(root, 'rm', '-q', `${origin}.md`); commit(root, 'remove the origin');
      await performManagedSync(engine, OPTS);
      await age(engine, 100);
      let fired = false;
      installFaultHook(async point => {
        if (point !== 'purge:after_carry' || fired) return;
        fired = true;
        await fixtureWrite(engine, async () => {
          expect((await importFromContent(engine, late, ['---', 'title: late', 'type: note', `derived_from: ${origin}.md`, '---', '', `Harbor ledger planning notes ${canaryOf(k, 'plain')}late for the roadmap.`, ''].join('\n'),
            { sourceId: 'default', noEmbed: true })).status).toBe('imported');
        });
      });
      let held: Awaited<ReturnType<typeof purgeDeletedPagesCoordinated>>;
      try { held = await purgeDeletedPagesCoordinated(engine, 72); }
      finally { installFaultHook(undefined); }
      expect(fired).toBe(true);
      expect(held.slugs).not.toContain(origin);
      expect(held.blocked.find(b => b.slug === origin)?.code).toBe('derived_origin_parked');
      expect((await page(engine, origin))?.deleted_at).not.toBeNull();
      __resetPrivateVisibilityCacheForTests();
      const ctx = { engine, config: { engine: engine.kind }, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: true, sourceId: 'default' } as unknown as OperationContext;
      const read = async () => { try { return JSON.stringify(await operationsByName.get_page!.handler(ctx, { slug: late })); } catch { return ''; } };
      expect((await read()).includes(`${canaryOf(k, 'plain')}late`)).toBe(false);
    }, { setup, databaseUrl }), 300_000);

    test('an explicit local purge: the derived files gain the label line through the Git door before the row goes', () => managedBrain(async ({ engine, root, ctx }) => {
      await performManagedSync(engine, OPTS);
      const k = 'purge', origin = slugOf(k, 'origin');
      const files = await before(engine, root, k);
      const snapshot = await engine.readPageSnapshot(origin, { sourceId: 'default' });
      const result = await operationsByName.delete_page!.handler(ctx, { slug: origin, purge: true, request_id: randomUUID(), expected_revision: snapshot!.revision }) as { status: string };
      expect(result.status).toBe('purged');
      await expectCarried(engine, root, k, files);
    }, { setup, databaseUrl }), 300_000);

    test('a remote delete: the stamp is a maintenance write whose batch names the delete request id, and its response names no stamped page', () => managedBrain(async ({ engine, root }) => {
      await performManagedSync(engine, OPTS);
      const k = 'remote', origin = slugOf(k, 'origin');
      const files = await before(engine, root, k);
      await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [OWNER]);
      const minted = await mintLegacyToken(engine, { name: 'owner-writer', scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: ['default'] });
      await bindCredential(engine, { kind: 'token', id: minted.id }, { member: OWNER });
      await setOwner(engine, OWNER);
      const auth = await new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) })
        .verifyAccessToken(minted.token) as unknown as AuthInfo;
      const requestId = randomUUID();
      const snapshot = await engine.readPageSnapshot(origin, { sourceId: 'default' });
      // A remote write reaches a private page only while the operator relaxes remote privacy (search.remote_private_pages).
      await engine.setConfig('search.remote_private_pages', 'visible');
      __resetPrivateVisibilityCacheForTests();
      const out = await dispatchToolCall(engine, 'delete_page', { slug: origin, request_id: requestId, expected_revision: snapshot!.revision },
        { remote: true, transport: 'http', auth, sourceId: 'default', takesHoldersAllowList: ['world'] });
      await engine.setConfig('search.remote_private_pages', 'hidden');
      const text = out.content.map(c => c.text).join('\n');
      expect(out.isError ? text : '').toBe('');
      for (const shape of [...CARRIED, ...UNTOUCHED]) expect({ shape, named: text.includes(slugOf(k, shape)) }).toEqual({ shape, named: false });
      const stamps = await engine.executeRaw<{ slug: string; principal_kind: string; state: string }>(`SELECT slug, principal_kind, state FROM persistence_requests
        WHERE intent->>'maintenance_batch' = $1 ORDER BY slug`, [`derived-origin-carry:${requestId}`]);
      expect(stamps.map(s => s.slug)).toEqual(CARRIED.map(s => slugOf(k, s)).sort());
      expect(stamps.every(s => s.principal_kind === 'local_cli' && s.state === 'committed')).toBe(true);
      await age(engine, 100);
      await cli(engine, ['purge-deleted', '--json', '--yes']);
      await expectCarried(engine, root, k, files);
    }, { setup, databaseUrl }), 300_000);
  });
}
