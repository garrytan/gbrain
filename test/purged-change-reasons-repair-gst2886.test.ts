/**
 * GST-2886: change reasons leaked before the #8635 fix stay leaked until `gbrain repair purged-change-reasons` clears them.
 *
 * 1. Protects: before #8635 a sync could read a page's `gbrain-reason` trailer, a fact purge could commit and tombstone
 *    that (commit, path), and the import could then store the purged text as the snapshot's `change_reason`. Brains
 *    upgraded past the fix keep those rows. `gbrain repair purged-change-reasons` (explicit-only, preview-bound,
 *    destructive) lists every stored reason whose text is the trailer of a tombstoned (source, commit, path), with a
 *    per-brain count, and `--apply --expect <hash> --yes` sets exactly those to '[purged]'.
 * 2. Fails when: the leaked row is not listed, the count is wrong, the apply clears anything else (the sibling reason from
 *    the same commit, a reason already '[purged]'), a second apply changes anything, or a repo-less brain refuses.
 * 3. Real temp Git repositories, the real classic and managed sync racing the real purge_fact handler (which writes the
 *    real tombstone and version row; since #8635 that row stores NULL, so the test writes back the text a brain from
 *    before the fix holds), and the real `gbrain repair` command; PGLite, plus Postgres when DATABASE_URL is set.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError, type OperationContext } from '../src/core/ops/contract.ts';
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
import { runRepairCommand } from '../src/commands/repair.ts';
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


const inHome = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home }, fn);

async function leakedRows(engine: BrainEngine, sourceId: string, claim: string): Promise<Array<{ id: number; reason: string }>> {
  return (await engine.executeRaw<{ id: number; reason: string }>(`SELECT v.id, v.change_reason AS reason FROM page_versions v JOIN pages p ON p.id = v.page_id
    WHERE p.source_id = $1 AND strpos(lower(v.change_reason), $2) > 0 ORDER BY v.id`, [sourceId, claim.toLowerCase()])).map(row => ({ id: Number(row.id), reason: row.reason }));
}
async function siblingReason(engine: BrainEngine, sourceId: string): Promise<string | null> {
  const rows = await engine.executeRaw<{ reason: string | null }>(`SELECT v.change_reason AS reason FROM page_versions v JOIN pages p ON p.id = v.page_id
    WHERE p.source_id = $1 AND p.slug = 'notes/b' ORDER BY v.id DESC LIMIT 1`, [sourceId]);
  return rows[0]?.reason ?? null;
}
async function repairCli(engine: BrainEngine, args: string[]): Promise<{ out: string; error?: OperationError }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
  try { await inHome(() => runRepairCommand(engine, args)); return { out: lines.join('\n') }; }
  catch (error) { if (error instanceof OperationError) return { out: lines.join('\n'), error }; throw error; }
  finally { console.log = original; }
}
const lastJson = (out: string) => JSON.parse(out.slice(out.lastIndexOf('\n{') + 1 || 0)).results[0];
const leakedText = (claim: string) => `Changed after ${claim} was rotated.`;
async function latestVersion(engine: BrainEngine, sourceId: string, slug: string): Promise<{ id: number; reason: string | null }> {
  const [row] = await engine.executeRaw<{ id: number; reason: string | null }>(`SELECT v.id, v.change_reason AS reason FROM page_versions v JOIN pages p ON p.id = v.page_id
    WHERE p.source_id = $1 AND p.slug = $2 ORDER BY v.id DESC LIMIT 1`, [sourceId, slug]);
  return { id: Number(row!.id), reason: row!.reason };
}
/** Since #8635 the race stores NULL; a brain that ran the race before the fix holds the trailer text in that same row. */
async function asBeforeTheFix(engine: BrainEngine, leak: Leak): Promise<void> {
  const row = await latestVersion(engine, leak.sourceId, 'notes/a');
  expect(row.reason).toBeNull();
  await engine.executeRaw('UPDATE page_versions SET change_reason = $1 WHERE id = $2', [leakedText(leak.claim), row.id]);
}
const reasonOf = async (engine: BrainEngine, id: number) => (await engine.executeRaw<{ reason: string | null }>('SELECT change_reason AS reason FROM page_versions WHERE id = $1', [id]))[0]!.reason;

interface Leak { sourceId: string; claim: string; fact: number; pushed: string; root: string }

/** Classic sync, as master runs it today: the pass reads the trailers, the purge commits, the import stores the reason. */
async function classicLeak(engine: BrainEngine, sourceId = `leak-classic-${serial + 1}`, firstReason?: string): Promise<Leak> {
  const n = ++serial;
  const claim = `Vault code is ${7100 + n}`;
  const root = newRepo({ 'notes/a.md': page('A one.'), 'notes/b.md': page('B one.') });
  await runSources(engine, ['add', sourceId, '--path', root, '--no-federated']);
  const sync = () => performSync(engine, { repoPath: root, sourceId, noPull: true, noEmbed: true, noExtract: true, concurrency: 1 });
  await sync();
  write(root, { 'notes/a.md': page('A two.'), 'notes/b.md': page('B two.') });
  const pushed = commit(root, 'edit', [...(firstReason ? [`notes/a.md: ${firstReason}`] : []), `notes/a.md: Changed after ${claim} was rotated.`, `notes/b.md: ${SIBLING}`]);
  const fact = await seedFact(engine, sourceId, `people/vault-example-${n}`, claim);
  const purged = purgeAfterNextScan(() => purge(engine, sourceId, fact));
  await sync();
  expect((await purged()).state).toBe('committed');
  __setReasonGitStreamForTests();
  return { sourceId, claim, fact, pushed, root };
}

/** Managed sync, as master runs it today: the request was prepared from the pass's scan, the purge commits, then it publishes. */
async function managedLeak(engine: BrainEngine): Promise<Leak> {
  const n = ++serial;
  const claim = `Alarm phrase is ${8200 + n}`;
  const sourceId = `leak-managed-${n}`;
  const root = newRepo({ 'notes/a.md': page('A one.'), 'notes/b.md': page('B one.') });
  await engine.executeRaw('UPDATE persistence_brain SET enabled = false WHERE singleton = 1');
  await engine.executeRaw(`INSERT INTO sources(id, name, local_path, config) VALUES ($1, $1, $2, '{}')`, [sourceId, root]);
  const fact = await seedFact(engine, sourceId, `people/alarm-example-${n}`, claim);
  await claimWorktree(engine, sourceId, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled = true WHERE singleton = 1');
  try {
    expect((await performManagedSync(engine, { sourceId, noPull: true })).status).toBe('first_sync');
    write(root, { 'notes/a.md': page('A two.'), 'notes/b.md': page('B two.') });
    const pushed = commit(root, 'edit', [`notes/a.md: Changed after ${claim} was rotated.`, `notes/b.md: ${SIBLING}`]);
    const purged = purgeOncePrepared(engine, 'notes/a', () => purge(engine, sourceId, fact));
    await performManagedSync(engine, { sourceId, noPull: true });
    expect((await purged()).state).toBe('committed');
    return { sourceId, claim, fact, pushed, root };
  } finally {
    installFaultHook(undefined);
    await disposePersistenceConsumer(engine).catch(() => undefined);
    await engine.executeRaw('UPDATE persistence_brain SET enabled = false WHERE singleton = 1');
  }
}

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
  for (const engine of engines) if (engine.kind === 'pglite') await engine.disconnect();
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

for (const backend of ['pglite', 'postgres'] as const) {
  const engineOf = () => engines.find(engine => engine.kind === backend)!;
  describe(`[${backend}] GST-2886: change reasons leaked before #8635`, () => {
    const leaks: Leak[] = [];
    const skip = backend === 'postgres' && !process.env.DATABASE_URL;

    test.skipIf(skip)('a brain from before #8635 holds the purged reason under a tombstoned (commit, path), after classic and managed syncs', async () => inHome(async () => {
      const engine = engineOf();
      leaks.push(await classicLeak(engine), await managedLeak(engine));
      for (const leak of leaks) {
        await asBeforeTheFix(engine, leak);
        expect(await engine.executeRaw('SELECT commit_sha, path FROM reason_purge_tombstones WHERE source_id = $1', [leak.sourceId]))
          .toEqual([{ commit_sha: leak.pushed, path: 'notes/a.md' }]);
        expect((await leakedRows(engine, leak.sourceId, leak.claim)).map(row => row.reason)).toEqual([`Changed after ${leak.claim} was rotated.`]);
        expect(await siblingReason(engine, leak.sourceId)).toBe(SIBLING);
      }
    }), 300_000);

    test.skipIf(skip)('no other command clears it: repair --all (preview and apply) and a second purge', async () => inHome(async () => {
      const engine = engineOf();
      expect(leaks).toHaveLength(2);
      const preview = await repairCli(engine, ['--all', '--json']);
      for (const leak of leaks) expect(preview.out.toLowerCase()).not.toContain(leak.claim.toLowerCase());
      await repairCli(engine, ['--all', '--apply', '--json']);
      for (const leak of leaks) {
        expect(await leakedRows(engine, leak.sourceId, leak.claim)).toHaveLength(1);
        const again = await run(engine, leak.sourceId, 'purge_fact', { id: leak.fact, source_id: leak.sourceId, dry_run: true }).then(() => null, (error: unknown) => error);
        expect(again).toBeInstanceOf(OperationError);
        expect(await leakedRows(engine, leak.sourceId, leak.claim)).toHaveLength(1);
      }
    }), 300_000);

    test.skipIf(skip)('repair purged-change-reasons: preview counts the leaked rows per brain, apply clears exactly them, a rerun changes nothing', async () => inHome(async () => {
      const engine = engineOf();
      expect(leaks).toHaveLength(2);
      const human = await repairCli(engine, ['purged-change-reasons']);
      expect(human.error?.message).toBeUndefined();
      expect(human.out).toContain('2 leaked change reason(s) in 2 source(s) of this brain');
      for (const leak of leaks) expect(human.out).toContain(`${leak.sourceId}:notes/a@v`);
      for (const leak of leaks) expect(human.out.toLowerCase()).not.toContain(leak.claim.toLowerCase());
      const preview = await repairCli(engine, ['purged-change-reasons', '--json']);
      expect(preview.error?.message).toBeUndefined();
      const planned = lastJson(preview.out);
      expect(planned.mode).toBe('dry_run');
      expect(planned.details.brain_total).toBe(2);
      for (const leak of leaks) expect(planned.details.by_source[leak.sourceId]).toBe(1);
      expect(planned.residuals).toMatchObject({ path_mismatch: 0, unreadable_commit: 0 });
      for (const leak of leaks) expect(preview.out.toLowerCase()).not.toContain(leak.claim.toLowerCase());
      expect(typeof planned.preview_hash).toBe('string');

      const applied = lastJson((await repairCli(engine, ['purged-change-reasons', '--apply', '--expect', planned.preview_hash, '--yes', '--json'])).out);
      expect(applied.outcome_items.reduce((sum: number, item: { detail: { cleared: number } }) => sum + item.detail.cleared, 0)).toBe(2);
      for (const leak of leaks) {
        expect(await leakedRows(engine, leak.sourceId, leak.claim)).toEqual([]);
        const [cleared] = await engine.executeRaw<{ reason: string | null }>(`SELECT v.change_reason AS reason FROM page_versions v JOIN pages p ON p.id = v.page_id
          WHERE p.source_id = $1 AND p.slug = 'notes/a' ORDER BY v.id DESC LIMIT 1`, [leak.sourceId]);
        expect(cleared?.reason).toBe('[purged]');
        expect(await siblingReason(engine, leak.sourceId)).toBe(SIBLING);
      }
      const rerun = lastJson((await repairCli(engine, ['purged-change-reasons', '--json'])).out);
      expect(rerun.affected).toBe(0);
      expect(rerun.details.brain_total).toBe(0);
    }), 300_000);

    // The source id is one an object prototype holds, so a per-source tally kept in a plain object would break.
    test.skipIf(skip)('consent, a stale hash, a row changed since the preview, the same text under another path, a missing checkout, and a source named constructor', async () => inHome(async () => {
      const engine = engineOf();
      const leak = await classicLeak(engine, 'constructor');
      await asBeforeTheFix(engine, leak);
      const leaked = await latestVersion(engine, leak.sourceId, 'notes/a');
      const elsewhere = await latestVersion(engine, leak.sourceId, 'notes/b');
      expect(elsewhere.reason).toBe(SIBLING);
      await engine.executeRaw('UPDATE page_versions SET change_reason = $1 WHERE id = $2', [leakedText(leak.claim), elsewhere.id]);
      const cli = (...args: string[]) => repairCli(engine, ['purged-change-reasons', '--source', leak.sourceId, ...args, '--json']);

      const gone = `${leak.root}.moved`;
      renameSync(leak.root, gone);
      const blind = await cli();
      renameSync(gone, leak.root);
      expect(blind.error?.message).toBeUndefined();
      expect(lastJson(blind.out).residuals).toMatchObject({ unreadable_commit: 1 });
      expect(lastJson(blind.out).details.brain_total).toBe(0);

      const human = await repairCli(engine, ['purged-change-reasons', '--source', leak.sourceId]);
      expect(human.out).toContain('1 leaked change reason(s) in 1 source(s) of this brain');
      expect(human.out).toContain('constructor:notes/a@v');
      const planned = lastJson((await cli()).out);
      expect(planned.details.brain_total).toBe(1);
      expect(planned.details.by_source).toEqual({ constructor: 1 });
      expect(planned.residuals).toMatchObject({ path_mismatch: 1, unreadable_commit: 0, sources_without_checkout: 0 });

      const previous = process.exitCode;
      const unconsented = await cli('--apply', '--expect', planned.preview_hash);
      const exitCode = process.exitCode;
      process.exitCode = previous ?? 0;
      expect(unconsented.error?.message).toBeUndefined();
      expect(exitCode).toBe(3);
      expect(await reasonOf(engine, leaked.id)).toBe(leakedText(leak.claim));
      expect((await cli('--apply', '--expect', 'f'.repeat(64), '--yes')).error?.code).toBe('preview_changed');

      await engine.executeRaw('UPDATE page_versions SET change_reason = $1 WHERE id = $2', ['Rewritten by hand.', leaked.id]);
      const changed = lastJson((await cli('--apply', '--expect', planned.preview_hash, '--yes')).out);
      expect(changed.outcomes).toMatchObject({ changed_since_preview: 1 });
      expect(await reasonOf(engine, leaked.id)).toBe('Rewritten by hand.');
      expect(await reasonOf(engine, elsewhere.id)).toBe(leakedText(leak.claim));

      await engine.executeRaw('UPDATE page_versions SET change_reason = $1 WHERE id = $2', [leakedText(leak.claim), leaked.id]);
      const widened = lastJson((await cli('--include-ambiguous')).out);
      expect(widened.details.brain_total).toBe(2);
      await cli('--include-ambiguous', '--apply', '--expect', widened.preview_hash, '--yes');
      expect(await reasonOf(engine, leaked.id)).toBe('[purged]');
      expect(await reasonOf(engine, elsewhere.id)).toBe('[purged]');
      expect(lastJson((await cli('--include-ambiguous')).out).details.brain_total).toBe(0);
    }), 300_000);

    // Sync stores the first reason a commit gives a file; when the commit gives that file two, the purge may have matched the other one.
    test.skipIf(skip)('a commit with two reasons for one file: the stored first reason is kept as path_mismatch, not redacted', async () => inHome(async () => {
      const engine = engineOf();
      const leak = await classicLeak(engine, undefined, 'Benign first note.');
      const row = await latestVersion(engine, leak.sourceId, 'notes/a');
      expect(row.reason).toBeNull();
      await engine.executeRaw('UPDATE page_versions SET change_reason = $1 WHERE id = $2', ['Benign first note.', row.id]);
      const planned = lastJson((await repairCli(engine, ['purged-change-reasons', '--source', leak.sourceId, '--json'])).out);
      expect(planned.details.brain_total).toBe(0);
      expect(planned.residuals).toMatchObject({ path_mismatch: 1, unreadable_commit: 0 });
    }), 300_000);

    // A repo-less source has no trailers and no tombstones; the preview says so and exits clean.
    test.skipIf(skip)('repo-less source: the preview lists nothing and does not refuse', async () => inHome(async () => {
      const engine = engineOf();
      const sourceId = `repo-less-${++serial}`;
      await engine.executeRaw(`INSERT INTO sources(id, name, config) VALUES ($1, $1, '{}')`, [sourceId]);
      await importFromContent(engine, 'notes/plain', page('Plain.'), { noEmbed: true, sourceId });
      const preview = await repairCli(engine, ['purged-change-reasons', '--source', sourceId, '--json']);
      expect(preview.error?.message).toBeUndefined();
      const planned = lastJson(preview.out);
      expect(planned.affected).toBe(0);
      expect(planned.details.sources_without_checkout).toBe(1);
      expect(planned.residuals).toMatchObject({ sources_without_checkout: 1, unreadable_commit: 0 });
    }), 120_000);
  });
}
