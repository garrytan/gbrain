/**
 * #8635 (#8591): a change reason read from a Git trailer before a fact purge commits never reaches page history after it.
 *
 * 1. Protects: a sync pass, classic or managed, scans its range's `gbrain-reason` trailers (the managed preparation
 *    keeps that scan per request), then publishes each file. A purge committing between the scan and the publication
 *    tombstones the (commit, path) the reason came from; the snapshot the publication archives must not carry the purged
 *    text. The content still imports, and an unrelated reason from the same commit still lands on its own page.
 * 2. Fails when: the archived snapshot's `change_reason` holds the purged claim, the edit is not imported, or the sibling
 *    path's reason is lost.
 * 3. Real temp Git repositories, the real classic and managed sync and the real purge_fact handler; PGLite, plus
 *    Postgres when DATABASE_URL is set. The seams only choose when the real purge runs: classic, from the reason scan's
 *    Git runner once Git has answered; managed, at the consumer's `consumer:prepared` fault point, after the request
 *    was prepared from the pass's cached scan and before its publication.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operations } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { runSources } from '../src/commands/sources.ts';
import { performSync } from '../src/commands/sync.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { hardenedGitStream } from '../src/core/hardened-git.ts';
import { __setReasonGitStreamForTests, clearReasonScanCache } from '../src/core/reason-trailers.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-purged-reason-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
let serial = 0;

const page = (body: string) => `---\ntitle: Note\ntype: note\n---\n\n${body}\n`;
const SIBLING = 'Routine tidy-up.';

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function write(root: string, files: Record<string, string>): void {
  for (const [path, body] of Object.entries(files)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), body); }
}
function commit(root: string, message: string, reasons: string[] = []): string {
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-q', '-m', message,
    ...reasons.flatMap(reason => ['--trailer', `gbrain-reason: ${reason}`]));
  return git(root, 'rev-parse', 'HEAD');
}
function newRepo(files: Record<string, string>): string {
  const root = join(home, `repo-${++serial}`);
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  write(root, files);
  commit(root, 'initial content');
  return root;
}

const ctx = (engine: BrainEngine, sourceId: string): OperationContext => ({ engine, sourceId, remote: false, dryRun: false,
  config: { engine: engine.kind }, logger: { info() {}, warn() {}, error() {} } } as OperationContext);
const run = (engine: BrainEngine, sourceId: string, name: string, params: Record<string, unknown>) =>
  operations.find(o => o.name === name)!.handler(ctx(engine, sourceId), params) as Promise<Record<string, any>>;

const factFence = (claim: string) => `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | ${claim} | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |
<!--- gbrain:facts:end -->`;
/** A database-only page holding the claim as a fact, so purge_fact has a target in the source. */
async function seedFact(engine: BrainEngine, sourceId: string, slug: string, claim: string): Promise<number> {
  await importFromContent(engine, slug, `---\ntitle: Holder\ntype: person\n---\n# Holder\n\nProse.\n\n## Facts\n\n${factFence(claim)}\n`, { noEmbed: true, sourceId });
  await runExtractFacts(engine, { slugs: [slug], sourceId });
  const [row] = await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE fact = $1 AND entity_slug = $2', [claim, slug]);
  return Number(row!.id);
}
async function purge(engine: BrainEngine, sourceId: string, id: number): Promise<Record<string, any>> {
  const dry = await run(engine, sourceId, 'purge_fact', { id, source_id: sourceId, dry_run: true });
  return run(engine, sourceId, 'purge_fact', { id, source_id: sourceId, confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: randomUUID() });
}

/** Classic: the next reason scan reads Git, then the purge runs to its commit before the scan's result reaches the pass. */
function purgeAfterNextScan(purgeNow: () => Promise<Record<string, any>>): () => Promise<Record<string, any>> {
  let started: Promise<Record<string, any>> | null = null;
  __setReasonGitStreamForTests(async (root, args, opts) => {
    const result = await hardenedGitStream(root, args, opts);
    if (!started) { started = purgeNow(); await started; }
    return result;
  });
  return () => started ?? Promise.reject(new Error('no reason scan ran'));
}
/** Managed: the purge runs to its commit once the request for `slug` is prepared, before its publication starts. */
function purgeOncePrepared(engine: BrainEngine, slug: string, purgeNow: () => Promise<Record<string, any>>): () => Promise<Record<string, any>> {
  let started: Promise<Record<string, any>> | null = null;
  installFaultHook(async (point, detail) => {
    if (started || point !== 'consumer:prepared' || !detail.requestId) return;
    const [row] = await engine.executeRaw<{ slug: string }>('SELECT slug FROM persistence_requests WHERE request_id = $1::uuid', [detail.requestId]);
    if (row?.slug !== slug) return;
    started = purgeNow();
    await started;
  });
  return () => started ?? Promise.reject(new Error(`no request for ${slug} was prepared`));
}

async function reasonsOf(engine: BrainEngine, sourceId: string, slug: string): Promise<Array<string | null>> {
  return (await engine.executeRaw<{ reason: string | null }>(`SELECT v.change_reason AS reason FROM page_versions v JOIN pages p ON p.id = v.page_id
    WHERE p.source_id = $1 AND p.slug = $2 ORDER BY v.id`, [sourceId, slug])).map(row => row.reason);
}
async function bodyOf(engine: BrainEngine, sourceId: string, slug: string): Promise<string> {
  const [row] = await engine.executeRaw<{ body: string }>('SELECT compiled_truth AS body FROM pages WHERE source_id = $1 AND slug = $2', [sourceId, slug]);
  return row?.body ?? '';
}
async function expectNoPurgedReason(engine: BrainEngine, sourceId: string, claim: string): Promise<void> {
  expect(await engine.executeRaw(`SELECT v.change_reason FROM page_versions v JOIN pages p ON p.id = v.page_id
    WHERE p.source_id = $1 AND strpos(lower(v.change_reason), $2) > 0`, [sourceId, claim.toLowerCase()])).toEqual([]);
  expect([null, '[purged]']).toContain((await reasonsOf(engine, sourceId, 'notes/a')).at(-1) ?? null);
  expect(await bodyOf(engine, sourceId, 'notes/a')).toContain('A two.');
  expect(await bodyOf(engine, sourceId, 'notes/b')).toContain('B two.');
  expect((await reasonsOf(engine, sourceId, 'notes/b')).at(-1)).toBe(SIBLING);
}

const inHome = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home }, fn);

beforeAll(async () => inHome(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
  for (const engine of engines) await registerLocalWriter(engine, 'cli');
}), 180_000);
afterEach(() => { __setReasonGitStreamForTests(); installFaultHook(undefined); clearReasonScanCache(); });
afterAll(async () => {
  await inHome(async () => { for (const engine of engines) await disposePersistenceConsumer(engine).catch(() => undefined); });
  await engines[0]?.disconnect();
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

for (const backend of ['pglite', 'postgres'] as const) {
  const engineOf = () => engines.find(engine => engine.kind === backend)!;
  describe(`[${backend}] #8635: a purge that commits after a sync read its reasons`, () => {
    test.skipIf(backend === 'postgres' && !process.env.DATABASE_URL)('classic sync: the pass scanned before the purge; the archived snapshot never carries the purged reason', async () => inHome(async () => {
      const engine = engineOf();
      const n = ++serial;
      const claim = `Vault code is ${7100 + n}`;
      const id = `pr-classic-${n}`;
      const root = newRepo({ 'notes/a.md': page('A one.'), 'notes/b.md': page('B one.') });
      await runSources(engine, ['add', id, '--path', root, '--no-federated']);
      const sync = () => performSync(engine, { repoPath: root, sourceId: id, noPull: true, noEmbed: true, noExtract: true, concurrency: 1 });
      await sync();
      write(root, { 'notes/a.md': page('A two.'), 'notes/b.md': page('B two.') });
      const pushed = commit(root, 'edit', [`notes/a.md: Changed after ${claim} was rotated.`, `notes/b.md: ${SIBLING}`]);
      const fact = await seedFact(engine, id, `people/vault-example-${n}`, claim);

      const purged = purgeAfterNextScan(() => purge(engine, id, fact));
      await sync();
      expect((await purged()).state).toBe('committed');
      expect(await engine.executeRaw('SELECT commit_sha, path FROM reason_purge_tombstones WHERE source_id = $1', [id]))
        .toEqual([{ commit_sha: pushed, path: 'notes/a.md' }]);
      await expectNoPurgedReason(engine, id, claim);
    }), 180_000);

    test.skipIf(backend === 'postgres' && !process.env.DATABASE_URL)('managed sync: a preparation that kept its scan publishes after the purge without the purged reason', async () => inHome(async () => {
      const engine = engineOf();
      const n = ++serial;
      const claim = `Alarm phrase is ${8200 + n}`;
      const id = `pr-managed-${n}`;
      const root = newRepo({ 'notes/a.md': page('A one.'), 'notes/b.md': page('B one.') });
      await engine.executeRaw('UPDATE persistence_brain SET enabled = false WHERE singleton = 1');
      await engine.executeRaw(`INSERT INTO sources(id, name, local_path, config) VALUES ($1, $1, $2, '{}')`, [id, root]);
      const fact = await seedFact(engine, id, `people/alarm-example-${n}`, claim);
      await claimWorktree(engine, id, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled = true WHERE singleton = 1');
      try {
        expect((await performManagedSync(engine, { sourceId: id, noPull: true })).status).toBe('first_sync');
        write(root, { 'notes/a.md': page('A two.'), 'notes/b.md': page('B two.') });
        const pushed = commit(root, 'edit', [`notes/a.md: Changed after ${claim} was rotated.`, `notes/b.md: ${SIBLING}`]);

        const purged = purgeOncePrepared(engine, 'notes/a', () => purge(engine, id, fact));
        await performManagedSync(engine, { sourceId: id, noPull: true });
        expect((await purged()).state).toBe('committed');
        expect(await engine.executeRaw('SELECT commit_sha, path FROM reason_purge_tombstones WHERE source_id = $1', [id]))
          .toEqual([{ commit_sha: pushed, path: 'notes/a.md' }]);
        await expectNoPurgedReason(engine, id, claim);
      } finally {
        await disposePersistenceConsumer(engine).catch(() => undefined);
        await engine.executeRaw('UPDATE persistence_brain SET enabled = false WHERE singleton = 1');
      }
    }), 180_000);
  });
}
