#!/usr/bin/env bun
/**
 * #7866: the speed and side effects of `gbrain sources canonical --to git --apply` on a synthetic production-shaped source.
 * Opt-in, never run in CI.
 *
 *   bun scripts/bench/conversion-strict-pass.ts [--pages 25000] [--timebox-min 30] [--legacy 1]
 *     [--database-url postgres://postgres:postgres@localhost:5434/gbrain_test] [--work ~/.capy/work/conversion-bench] [--label <name>] [--out <file.json>]
 *
 * It builds a Git checkout of N markdown pages in nested directories, syncs it into a fresh Postgres database (created and
 * dropped), and with --legacy 1 leaves the pages as an older gbrain did: every chunk holding a vector for its text and no
 * contextual-mode stamp. It then plans the conversion and applies it with nothing changed, timing each step and counting
 * the write requests and embedding effects the apply made. An apply still running at --timebox-min is stopped and its
 * rate read from the pages it settled. It prints one JSON report on stdout and writes it to --out.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '../..');
function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const PAGES = Number(flag('pages', '25000'));
const TIMEBOX_MS = Number(flag('timebox-min', '30')) * 60_000;
const LEGACY = flag('legacy', '1') === '1';
const DATABASE_URL = flag('database-url', process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5434/gbrain_test');
const WORK = resolve(flag('work', join(homedir(), '.capy', 'work', 'conversion-bench')));
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }).trim();
const LABEL = flag('label', git(REPO, 'rev-parse', '--short', 'HEAD'));
const OUT = resolve(flag('out', join(WORK, `conversion-${LABEL.replace(/[^\w.-]/g, '_')}-${PAGES}.json`)));
const log = (msg: string) => console.error(`[conversion-bench ${new Date().toISOString().slice(11, 19)}] ${msg}`);
const seconds = (ms: number) => Math.round(ms / 100) / 10;

function checkout(): string {
  const root = join(WORK, `checkout-${PAGES}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
  for (let i = 0; i < PAGES; i++) {
    const dir = join(root, 'notes', `d${String(Math.floor(i / 500)).padStart(3, '0')}`);
    if (i % 500 === 0) mkdirSync(dir, { recursive: true });
    const para = `Paragraph about example topic ${i % 97}, written for a synthetic page. `.repeat(12);
    writeFileSync(join(dir, `p${String(i).padStart(6, '0')}.md`), `---\ntype: concept\ntitle: Synthetic page ${i}\n---\n\n# Synthetic page ${i}\n\n${para}\n\n## Notes\n\n${para}\n`);
  }
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'synthetic pages');
  return root;
}

async function main() {
  mkdirSync(WORK, { recursive: true });
  const { isolatedPersistencePostgres } = await import('../../test/helpers/persistence-postgres.ts');
  const { claimWorktree } = await import('../../src/core/persistence/ownership.ts');
  const { activateSharedSkillPersistence } = await import('../../src/core/persistence/skill-activation.ts');
  const { disposePersistenceConsumer } = await import('../../src/core/persistence/service.ts');
  const { drainManagedSync } = await import('../../src/core/persistence/sync-drain.ts');
  const { withDrainLease } = await import('../../src/core/persistence/sync-lease.ts');
  const { applyGitConversion, planGitConversion } = await import('../../src/core/persistence/git-conversion.ts');
  const home = join(WORK, `home-${process.pid}`);
  rmSync(home, { recursive: true, force: true }); mkdirSync(home, { recursive: true });
  process.env.GBRAIN_HOME = home; delete process.env.DATABASE_URL; delete process.env.GBRAIN_DATABASE_URL;
  let t = performance.now();
  const root = checkout();
  const report: Record<string, unknown> = { label: LABEL, pages: PAGES, legacy: LEGACY, checkout_s: seconds(performance.now() - t) };
  log(`checkout of ${PAGES} pages in ${report.checkout_s}s`);
  const { engine, close } = await isolatedPersistencePostgres(DATABASE_URL);
  const counts = async () => (await engine.executeRaw<{ embedding: number; imports: number; committed: number }>(`SELECT
      (SELECT count(*)::int FROM persistence_effects WHERE kind='embedding') AS embedding,
      (SELECT count(*)::int FROM persistence_requests WHERE intent->>'kind'='managed_sync_import') AS imports,
      (SELECT count(*)::int FROM persistence_requests WHERE intent->>'kind'='managed_sync_import' AND state='committed') AS committed`))[0]!;
  try {
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
    await claimWorktree(engine, 'default', root);
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    t = performance.now();
    const first = await withDrainLease(engine, 'default', { holder: { kind: 'cli', id: null }, remote: false },
      () => drainManagedSync(engine, { sourceId: 'default', noPull: true, noExtract: true }, false));
    report.first_sync = { status: first.status, outcome: first.drain?.outcome, s: seconds(performance.now() - t) };
    log(`first sync ${JSON.stringify(report.first_sync)}`);
    if (LEGACY) {
      const [col] = await engine.executeRaw<{ t: string }>("SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid='content_chunks'::regclass AND attname='embedding'");
      const dims = Number(col!.t.match(/\d+/)![0]);
      await engine.executeRaw(`UPDATE content_chunks SET embedding=('[' || array_to_string(array_fill(0.1::real, ARRAY[${dims}]), ',') || ']')::vector, embedded_at=now(), embedded_text_hash=md5(chunk_text)`);
      await engine.executeRaw('UPDATE pages SET contextual_retrieval_mode=NULL');
    }
    t = performance.now();
    const { preview } = await planGitConversion(engine, 'default');
    report.plan = { s: seconds(performance.now() - t), discard: preview.discard.count, adopt: preview.adopt.count, pages: preview.pages };
    log(`plan ${JSON.stringify(report.plan)}`);
    const before = await counts();
    let last: Record<string, unknown> = {};
    t = performance.now();
    const timer = setInterval(() => log(`apply +${seconds(performance.now() - t)}s ${JSON.stringify(last)}`), 30_000);
    const outcome = await Promise.race([
      applyGitConversion(engine, 'default', preview.preview_hash, { noExtract: true, onProgress: progress => { last = { ...progress, push: undefined }; } })
        .then(result => ({ status: result.status }), (error: { code?: string; message?: string }) => ({ status: 'refused', code: error.code, message: error.message })),
      new Promise<{ status: string }>(resolve => setTimeout(() => resolve({ status: 'timebox' }), TIMEBOX_MS).unref?.()),
    ]);
    clearInterval(timer);
    const elapsed = performance.now() - t, after = await counts();
    const settled = after.committed - before.committed;
    report.apply = { ...outcome, s: seconds(elapsed), last_progress: last, import_requests: after.imports - before.imports, imports_committed: settled,
      embedding_effects: after.embedding - before.embedding,
      pages_per_s: outcome.status === 'converted' ? Math.round((PAGES / (elapsed / 1000)) * 10) / 10 : Math.round((settled / (elapsed / 1000)) * 10) / 10 };
    log(`apply ${JSON.stringify(report.apply)}`);
  } finally {
    await Promise.race([disposePersistenceConsumer(engine), new Promise(resolve => setTimeout(resolve, 10_000))]);
    await Promise.race([close(), new Promise(resolve => setTimeout(resolve, 10_000))]);
    rmSync(home, { recursive: true, force: true });
  }
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  process.exit(0);
}
await main();
