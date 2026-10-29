/**
 * #7866: a conversion's strict passes on a production-shaped source. On master a no-change `sources canonical --to git`
 * re-imported every page its `--full` episode found not derived-current (pages written before contextual retrieval had
 * no mode stamp), queued an embedding effect for each, did it again in the second pass, and stopped
 * `git_conversion_incomplete` whenever one of its own writes outlived the single pass's 5 s wait. These tests pin the
 * fixed behaviour: a full round without an episode, no embedding effect for a no-op whose chunks hold their vectors, a
 * drained pass, progress whose total is the planned paths, and refusals that carry the operator contract.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SyncResult } from '../src/commands/sync.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { withDrainLease } from '../src/core/persistence/sync-lease.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { chunksEmbeddedAsIs } from '../src/core/persistence/noop-kernel.ts';
import { __setSyncReceiptWaitForTests } from '../src/core/persistence/sync-receipt-wait.ts';
import { applyGitConversion, planGitConversion, type ConversionProgress } from '../src/core/persistence/git-conversion.ts';
import { runSourcesCanonical } from '../src/commands/sources-canonical.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { operationsByName } from '../src/core/operations.ts';
import { acquireWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { acquireCommitLockAsync } from '../src/core/git/commit-push.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const N = 30;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (i: number, body = `Committed body ${i}.`) => `---\ntype: concept\ntitle: note ${i}\n---\n\n${body}\n`;
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
  for (let i = 0; i < N; i++) writeFileSync(join(root, `notes/n${String(i).padStart(2, '0')}.md`), note(i));
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'notes');
};
/** Pages as an older gbrain left them: every chunk embedded for its text, and no contextual-mode stamp. */
async function legacyEmbedded(engine: BrainEngine): Promise<void> {
  const [col] = await engine.executeRaw<{ t: string }>("SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid='content_chunks'::regclass AND attname='embedding'");
  const dims = Number(col!.t.match(/\d+/)![0]);
  await engine.executeRaw(`UPDATE content_chunks SET embedding=('[' || array_to_string(array_fill(0.1::real, ARRAY[${dims}]), ',') || ']')::vector, embedded_at=now(), embedded_text_hash=md5(chunk_text)`);
  await engine.executeRaw('UPDATE pages SET contextual_retrieval_mode=NULL');
}
const counts = async (engine: BrainEngine) => {
  const [row] = await engine.executeRaw<{ embedding: number; imports: number }>(`SELECT (SELECT count(*)::int FROM persistence_effects WHERE kind='embedding') AS embedding,
    (SELECT count(*)::int FROM persistence_requests WHERE intent->>'kind'='managed_sync_import') AS imports`);
  return row!;
};
async function firstSync(engine: BrainEngine): Promise<void> {
  expect((await performManagedSync(engine, { sourceId: 'default', noPull: true, noExtract: true })).status).toBe('first_sync');
}
async function convert(engine: BrainEngine, seen: ConversionProgress[] = []) {
  const { preview } = await planGitConversion(engine, 'default');
  expect(preview.discard.count).toBe(0);
  return applyGitConversion(engine, 'default', preview.preview_hash, { noExtract: true, onProgress: progress => seen.push(progress) });
}
const strictEvents = (seen: ConversionProgress[]) => seen.filter(progress => progress.phase.startsWith('strict_pass'));

for (const backend of testBackends()) describe(`[${backend}] #7866: the conversion's strict passes`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('a no-change conversion of pages an older gbrain embedded makes no embedding effect and no write', () => managedBrain(async ({ engine }) => {
    await firstSync(engine);
    await legacyEmbedded(engine);
    const before = await counts(engine);
    const seen: ConversionProgress[] = [];
    expect(await convert(engine, seen)).toMatchObject({ status: 'converted' });
    expect(await counts(engine)).toEqual(before);
    // Progress: the total is the planned paths in both passes and never changes within them.
    expect(strictEvents(seen).length).toBeGreaterThan(0);
    expect(strictEvents(seen).every(progress => progress.total === N)).toBe(true);
    expect(await engine.executeRaw("SELECT 1 FROM sources WHERE id='default' AND config->>'canonical'='git'")).toHaveLength(1);
  }, { databaseUrl, setup }), 300_000);

  test('a no-op re-import queues no embedding effect when every chunk holds a vector for its text, and still queues one for a page whose vector is for other text', () => managedBrain(async ({ engine }) => {
    await firstSync(engine);
    await legacyEmbedded(engine);
    // A parser this binary no longer records owes every page a re-import; the re-import changes no content.
    await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys, '{0,parser}', '"parser-of-an-older-release"'::jsonb) WHERE completed_keys->0 ? 'parser'`);
    const [unembedded] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug='notes/n07'");
    await engine.executeRaw("UPDATE content_chunks SET embedded_text_hash=md5('text an earlier revision held') WHERE page_id=$1", [unembedded!.id]);
    const before = await counts(engine);
    const [{ last }] = await engine.executeRaw<{ last: string }>('SELECT COALESCE(max(id), 0)::text AS last FROM persistence_effects') as [{ last: string }];
    expect(await convert(engine)).toMatchObject({ status: 'converted' });
    const after = await counts(engine);
    expect(after.imports - before.imports).toBe(N);
    const queued = await engine.executeRaw<{ page_id: number }>("SELECT (data->>'page_id')::int AS page_id FROM persistence_effects WHERE kind='embedding' AND id > $1::bigint", [last]);
    expect(queued.map(row => Number(row.page_id))).toEqual([Number(unembedded!.id)]);
  }, { databaseUrl, setup }), 300_000);

  // Value: protects=a content no-op still queues an embedding effect for a page with a chunk lacking its embedded_at stamp, or whose text projection is not sealed at its revision; fails_when=chunksEmbeddedAsIs ignores either; why_new=the test above covers only a stale text hash; seam=none; no_claim=a NULL vector (such a page is not re-imported by the round) and provider calls
  test('a no-op re-import still queues an embedding effect for a page with a chunk lacking its embedded_at stamp, or with its text projection behind its revision', () => managedBrain(async ({ engine }) => {
    await firstSync(engine);
    await legacyEmbedded(engine);
    await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys, '{0,parser}', '"parser-of-an-older-release"'::jsonb) WHERE completed_keys->0 ? 'parser'`);
    const ids = Object.fromEntries((await engine.executeRaw<{ slug: string; id: number }>("SELECT slug, id FROM pages WHERE slug IN ('notes/n05','notes/n08')")).map(row => [row.slug, Number(row.id)]));
    await engine.executeRaw('UPDATE content_chunks SET embedded_at=NULL WHERE page_id=$1', [ids['notes/n08']]);
    await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE id=$1', [ids['notes/n05']]);
    const [{ last }] = await engine.executeRaw<{ last: string }>('SELECT COALESCE(max(id), 0)::text AS last FROM persistence_effects') as [{ last: string }];
    expect(await convert(engine)).toMatchObject({ status: 'converted' });
    const queued = await engine.executeRaw<{ page_id: number }>("SELECT (data->>'page_id')::int AS page_id FROM persistence_effects WHERE kind='embedding' AND id > $1::bigint", [last]);
    expect(queued.map(row => Number(row.page_id)).sort((a, b) => a - b)).toEqual([ids['notes/n05']!, ids['notes/n08']!].sort((a, b) => a - b));
  }, { databaseUrl, setup }), 300_000);

  // Value: protects=chunksEmbeddedAsIs reads a chunk with no vector in the active column as owing embedding work; fails_when=the predicate drops its NULL-vector clause; why_new=the conversion round never re-imports such a page, so only a direct call reaches the clause (#7886); seam=none; no_claim=which effect a sync queues (covered above)
  test('chunksEmbeddedAsIs: a page whose chunk has no vector in the active column still owes embedding work', () => managedBrain(async ({ engine }) => {
    await firstSync(engine);
    await legacyEmbedded(engine);
    const [page] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug='notes/n06'");
    expect(await chunksEmbeddedAsIs(engine, Number(page!.id))).toBe(true);
    await engine.executeRaw('UPDATE content_chunks SET embedding=NULL WHERE id=(SELECT min(id) FROM content_chunks WHERE page_id=$1)', [page!.id]);
    expect(await chunksEmbeddedAsIs(engine, Number(page!.id))).toBe(false);
  }, { databaseUrl, setup }), 300_000);

  // Value: protects=the human-mode refusal prints the Next: command from fix and strict-pass stderr progress names the planned paths; fails_when=the Next: line or the strict-pass progress text is dropped; why_new=the drainer test reads --json only; seam=none; no_claim=JSON contract (covered by the drainer test)
  test('a refused apply in text mode prints the refusal with the fix command as Next, and strict-pass progress on stderr', () => managedBrain(async ({ engine, root }) => {
    await firstSync(engine);
    writeFileSync(join(root, 'notes/n05.md'), note(5, 'Edited in Git after the last sync.'));
    git(root, 'commit', '-qam', 'edit n05');
    const { preview } = await planGitConversion(engine, 'default');
    let release!: () => void, acquired!: () => void;
    const holding = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { acquired = resolve; });
    const holder = withDrainLease(engine, 'default', { holder: { kind: 'cli', id: null }, remote: false }, async () => { acquired(); await holding; return { status: 'up_to_date' } as SyncResult; });
    await held;
    const out: string[] = [], err: string[] = [];
    const log = console.log, write = process.stderr.write, priorExitCode = process.exitCode;
    console.log = (line: unknown) => { out.push(String(line)); };
    process.stderr.write = ((chunk: string | Uint8Array) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try { await runSourcesCanonical(engine, ['default', '--to', 'git', '--apply', '--expect', preview.preview_hash, '--no-extract']); }
    finally { console.log = log; process.stderr.write = write; _resetCliExitVerdictForTests(); process.exitCode = priorExitCode ?? 0; release(); await holder; }
    expect(out.at(-1)).toContain('Conversion refused (git_conversion_incomplete)');
    expect(out.at(-1)).toContain('Next: gbrain sources canonical default --to git --dry-run --json');
    expect(err.join('')).toContain(`[sources canonical] strict_pass_1: ${N} planned path(s), 0 group(s) committed`);
  }, { databaseUrl, setup }), 300_000);

  for (const phase of ['strict_pass_1', 'strict_pass_2'] as const) test(`${phase}: a strict pass whose own write outlives the single pass's receipt wait drains on instead of refusing writer_pending`, () => managedBrain(async ({ engine, root }) => {
    await firstSync(engine);
    const slug = phase === 'strict_pass_1' ? 'n03' : 'n04';
    const edit = () => { writeFileSync(join(root, `notes/${slug}.md`), note(3, 'Edited in Git after the last sync.')); git(root, 'commit', '-qam', `edit ${slug}`); };
    if (phase === 'strict_pass_1') edit();
    const seen: ConversionProgress[] = [];
    let stalled = false, armed = false;
    // The waits are scaled down (#7886): once the pass froze its import, the consumer stops claiming for longer than the
    // single pass's receipt wait (held while queued here), as it does behind a busy owner on a production host. Pass 2 gets
    // its import from a Git commit landed between the passes.
    const restore = __setSyncReceiptWaitForTests({ pass: 200, held: 600, drain: 600 });
    installFaultHook(async point => {
      if (point === 'conversion:before_flip' && phase === 'strict_pass_2') edit();
      if (point === 'sync:after_freeze' && seen.at(-1)?.phase === phase) armed = true;
      if (point !== 'consumer:claiming' || !armed || stalled) return;
      stalled = true;
      // gstack-timing-ok: the stall must outlast the injected 600 ms receipt wait; the assertions read the outcome, not the elapsed time
      await Bun.sleep(1500);
    });
    try {
      expect(await convert(engine, seen)).toMatchObject({ status: 'converted' });
    } finally { installFaultHook(undefined); restore(); }
    expect(stalled).toBe(true);
    const [page] = await engine.executeRaw<{ compiled_truth: string }>(`SELECT compiled_truth FROM pages WHERE slug='notes/${slug}'`);
    expect(page!.compiled_truth).toContain('Edited in Git after the last sync.');
    // The round names its candidate and its one import batch; the total stays the planned paths.
    const pass = seen.filter(progress => progress.phase === phase);
    expect(pass.every(progress => progress.total === N)).toBe(true);
    expect(pass.some(progress => progress.round === 1 && progress.candidates === 1 && progress.batch === 1 && progress.batches === 1)).toBe(true);
    expect(pass.every(progress => progress.scanned <= (progress.candidates ?? 0))).toBe(true);
  }, { databaseUrl, setup }), 300_000);

  test('a concurrent drainer of the source refuses the apply with the operator contract and counts, before anything is flipped', () => managedBrain(async ({ engine, root }) => {
    await firstSync(engine);
    writeFileSync(join(root, 'notes/n05.md'), note(5, 'Edited in Git after the last sync.'));
    git(root, 'commit', '-qam', 'edit n05');
    const { preview } = await planGitConversion(engine, 'default');
    let release!: () => void, acquired!: () => void;
    const holding = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { acquired = resolve; });
    const holder = withDrainLease(engine, 'default', { holder: { kind: 'cli', id: null }, remote: false }, async () => { acquired(); await holding; return { status: 'up_to_date' } as SyncResult; });
    await held;
    const out: string[] = [];
    const log = console.log, write = process.stderr.write, priorExitCode = process.exitCode;
    console.log = (line: unknown) => { out.push(String(line)); };
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try { await runSourcesCanonical(engine, ['default', '--to', 'git', '--apply', '--expect', preview.preview_hash, '--no-extract', '--json']); }
    finally { console.log = log; process.stderr.write = write; _resetCliExitVerdictForTests(); process.exitCode = priorExitCode ?? 0; release(); await holder; }
    const refused = JSON.parse(out.at(-1)!);
    expect(refused).toMatchObject({ status: 'refused', code: 'git_conversion_incomplete',
      fix: { next: 'run', argv: ['gbrain', 'sources', 'canonical', 'default', '--to', 'git', '--dry-run', '--json'], verify: { argv: ['gbrain', 'sync', 'status', '--source', 'default', '--json'] } },
      progress: { phase: 'strict_pass_1', total: N } });
    expect(refused.message).toContain('still mixed');
    // Nothing flipped, and the page Git moved still has the database's version for the next apply to take.
    expect(await engine.executeRaw("SELECT 1 FROM sources WHERE id='default' AND config->>'canonical'='git'")).toHaveLength(0);
    const [page] = await engine.executeRaw<{ compiled_truth: string }>("SELECT compiled_truth FROM pages WHERE slug='notes/n05'");
    expect(page!.compiled_truth).toContain('Committed body 5.');
    // The same apply runs once the drainer is gone.
    const { preview: again } = await planGitConversion(engine, 'default');
    expect(await applyGitConversion(engine, 'default', again.preview_hash, { noExtract: true })).toMatchObject({ status: 'converted' });
  }, { databaseUrl, setup }), 300_000);

  // Value: protects=a strict_pass_2 refusal says the source stays git-canonical and carries the fix, counts and planned total; fails_when=pass 2 refuses without fix or progress, or the flag is not kept; why_new=the drainer test refuses in pass 1 only; seam=none; no_claim=a real concurrent writer (a held drain lease stands in)
  test('a refusal in strict pass 2 keeps the source git-canonical and carries the operator contract and counts', () => managedBrain(async ({ engine }) => {
    await firstSync(engine);
    const { preview } = await planGitConversion(engine, 'default');
    let release!: () => void;
    const holding = new Promise<void>(resolve => { release = resolve; });
    let holder: Promise<unknown> | undefined;
    installFaultHook(async point => {
      if (point !== 'conversion:before_flip' || holder) return;
      let acquired!: () => void;
      const held = new Promise<void>(resolve => { acquired = resolve; });
      holder = withDrainLease(engine, 'default', { holder: { kind: 'cli', id: null }, remote: false }, async () => { acquired(); await holding; return { status: 'up_to_date' } as SyncResult; });
      await held;
    });
    const out: string[] = [];
    const log = console.log, write = process.stderr.write, priorExitCode = process.exitCode;
    console.log = (line: unknown) => { out.push(String(line)); };
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try { await runSourcesCanonical(engine, ['default', '--to', 'git', '--apply', '--expect', preview.preview_hash, '--no-extract', '--json']); }
    finally { installFaultHook(undefined); console.log = log; process.stderr.write = write; _resetCliExitVerdictForTests(); process.exitCode = priorExitCode ?? 0; release(); await holder; }
    const refused = JSON.parse(out.at(-1)!);
    expect(refused).toMatchObject({ status: 'refused', code: 'git_conversion_incomplete',
      fix: { next: 'run', argv: ['gbrain', 'sources', 'canonical', 'default', '--to', 'git', '--dry-run', '--json'], verify: { argv: ['gbrain', 'sync', 'status', '--source', 'default', '--json'] } },
      progress: { phase: 'strict_pass_2', total: N } });
    expect(refused.message).toContain('strict_pass_2');
    expect(refused.message).toContain('the source stays git-canonical');
    expect(await engine.executeRaw("SELECT 1 FROM sources WHERE id='default' AND config->>'canonical'='git'")).toHaveLength(1);
  }, { databaseUrl, setup }), 300_000);

  test('a page whose derived stamp is still pending when strict pass 2 reads its level is not re-imported (the progress test\'s 1-in-8 flake)', () => managedBrain(async ({ engine }) => {
    await firstSync(engine);
    const seen: ConversionProgress[] = [];
    let atFlip: Awaited<ReturnType<typeof counts>> | undefined;
    // On a slow host the last page strict pass 1 imported can still lack its contextual-mode stamp when pass 2 reads the
    // level: committed, equal to its file and record, but not derived-current. Forced here for one page.
    installFaultHook(async point => {
      if (point !== 'conversion:before_flip') return;
      await engine.executeRaw("UPDATE pages SET contextual_retrieval_mode=NULL WHERE slug='notes/n09'");
      atFlip = await counts(engine);
    });
    try {
      expect(await convert(engine, seen)).toMatchObject({ status: 'converted' });
    } finally { installFaultHook(undefined); }
    expect(seen.filter(progress => progress.phase === 'strict_pass_2').every(progress => progress.scanned === 0)).toBe(true);
    expect((await counts(engine)).imports).toBe(atFlip!.imports);
  }, { databaseUrl, setup }), 300_000);

  test('the checkout\'s writer locks stay free while a strict pass holds the source\'s drain lease: they are taken per commit', () => managedBrain(async ({ engine, root }) => {
    await firstSync(engine);
    writeFileSync(join(root, 'notes/n04.md'), note(4, 'Edited in Git after the last sync.'));
    git(root, 'commit', '-qam', 'edit n04');
    const binding = (await getWorktreeBinding(engine, 'default'))!;
    const seen: ConversionProgress[] = [];
    const taken: string[] = [];
    installFaultHook(async point => {
      if (point !== 'sync:after_freeze' || taken.length || seen.at(-1)?.phase !== 'strict_pass_1') return;
      // A page write's publication takes the worktree writer lock; `gbrain git commit-push` takes the checkout's commit lock.
      const worktree = await acquireWorktree(binding, 0, undefined, engine, { yieldLanes: true });
      taken.push(worktree ? 'worktree' : 'worktree busy');
      await worktree?.release();
      const commit = await acquireCommitLockAsync(root, 0).then(lock => lock, () => null);
      taken.push(commit ? 'commit' : 'commit busy');
      await commit?.release();
    });
    try {
      expect(await convert(engine, seen)).toMatchObject({ status: 'converted' });
    } finally { installFaultHook(undefined); }
    expect(taken).toEqual(['worktree', 'commit']);
  }, { databaseUrl, setup }), 300_000);

  test('a repo-less brain is unaffected: pages write as before and the conversion refuses with the operator contract, writing nothing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-repo-less-'));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
        try {
          const ctx = { engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId: 'default', remote: false, dryRun: false,
            logger: { info() {}, warn() {}, error() {} } } as Parameters<typeof operationsByName.put_page.handler>[0];
          await operationsByName.put_page.handler(ctx, { slug: 'notes/repo-less', content: note(1) });
          const out: string[] = [];
          const log = console.log, write = process.stderr.write, priorExitCode = process.exitCode;
          console.log = (line: unknown) => { out.push(String(line)); };
          process.stderr.write = (() => true) as typeof process.stderr.write;
          try { await runSourcesCanonical(engine, ['default', '--to', 'git', '--apply', '--expect', 'a'.repeat(64), '--no-extract', '--json']); }
          finally { console.log = log; process.stderr.write = write; _resetCliExitVerdictForTests(); process.exitCode = priorExitCode ?? 0; }
          expect(JSON.parse(out.at(-1)!)).toMatchObject({ status: 'refused', code: 'strict_requires_managed', fix: { verify: { argv: ['gbrain', 'doctor', '--json'] } } });
          expect(await engine.executeRaw("SELECT 1 FROM sources WHERE id='default' AND config->>'canonical'='git'")).toHaveLength(0);
          const [page] = await engine.executeRaw<{ compiled_truth: string }>("SELECT compiled_truth FROM pages WHERE slug='notes/repo-less'");
          expect(page!.compiled_truth).toContain('Committed body 1.');
        } finally { await close(); }
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 300_000);
});

// Value: protects=the opt-in conversion bench stays runnable and still measures a no-change conversion as no write and no embedding effect; fails_when=an API the bench calls moves or the conversion regresses to re-importing; why_new=the bench never runs in CI; seam=none; no_claim=bench timings at scale (40 pages, local Postgres)
if (testBackends().includes('postgres')) describe('[postgres] #7866: scripts/bench/conversion-strict-pass.ts', () => {
  test('a no-change conversion of a small legacy source converts with no import request and no embedding effect', () => {
    const work = mkdtempSync(join(tmpdir(), 'conversion-bench-smoke-'));
    try {
      const out = join(work, 'out.json');
      const run = spawnSync(process.execPath, [join(resolve(import.meta.dir, '..'), 'scripts/bench/conversion-strict-pass.ts'), '--pages', '40', '--legacy', '1',
        '--timebox-min', '3', '--database-url', requirePostgresTestDatabase(), '--work', work, '--label', 'smoke', '--out', out], { encoding: 'utf8', timeout: 240_000 });
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ pages: 40, plan: { discard: 0 }, apply: { status: 'converted', import_requests: 0, embedding_effects: 0 } });
    } finally { rmSync(work, { recursive: true, force: true }); }
  }, 300_000);
});
