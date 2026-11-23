#!/usr/bin/env bun
/**
 * The one-time proof of the Rust brain's above-cap recovery route (PR 21b): an isolated brain whose `records.redb` is
 * over the 8 GiB archive cap is recovered by the quiesced physical-copy runbook (docs/guides/in-agent-setup.md, "Large
 * brains on the Rust engine"). Not part of CI and never run against a real brain: it builds its own brain under a scratch
 * directory and deletes it at the end.
 *
 *   GBRAIN_RUST_ENGINE_ADDON=<addon> bun scripts/rust/large-store-fixture.ts --receipt <file.md> [--target-gib 9] [--scratch <dir>] [--keep]
 *
 * Steps (each timed): build the brain through the addon (small pages with 1,536-dimension embeddings, then pages with
 * multi-MiB bodies until records.redb passes the target) -> close it -> `backup create` refuses `backup_too_large` at the
 * real cap -> sha256 of the source files -> `cp` of FORMAT and records.redb into a new home -> `backup verify-store` of
 * the copy -> sha256 of the copy (equal to the source) -> an isolated engine opens the copy: page, chunk and embedding
 * counts equal, an embedding and a page body read back -> sha256 of the source again (unchanged). The receipt records the method, the
 * actual bytes, the durations and the verdict; a failed step stops the run and the receipt says which.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readSync, readFileSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runBackupCli } from '../../src/commands/backup.ts';
import { createBackup, verifyRustStoreDir } from '../../src/core/backup/rust-snapshot.ts';
import { loadRustAddon } from '../../src/core/rust-engine/addon-loader.ts';
import { openRustEngine } from '../../src/core/rust-engine.ts';
import { VERSION } from '../../src/version.ts';

const GIB = 1024 ** 3;
const arg = (name: string, fallback?: string): string | undefined => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : fallback; };
const targetBytes = Number(arg('--target-gib', '9')) * GIB;
/** `--smoke` runs the same steps on a small brain (a script check): it skips the two over-cap assertions. */
const smoke = process.argv.includes('--smoke');
const receiptPath = arg('--receipt');
const scratch = resolve(arg('--scratch', `/var/tmp/gbrain-large-store-${process.pid}`)!);
if (!receiptPath) throw new Error('--receipt <file.md> is required');
const addonPath = process.env.GBRAIN_RUST_ENGINE_ADDON;
if (!addonPath) throw new Error('set GBRAIN_RUST_ENGINE_ADDON to the addon bun run rust:build wrote');

const steps: Array<{ step: string; seconds: number; note: string }> = [];
async function timed<T>(step: string, run: () => Promise<T> | T, note: (value: T) => string = () => ''): Promise<T> {
  const start = Date.now();
  const value = await run();
  steps.push({ step, seconds: Math.round((Date.now() - start) / 100) / 10, note: note(value) });
  console.log(`${step}: ${steps.at(-1)!.seconds}s ${steps.at(-1)!.note}`);
  return value;
}
const sha256 = (file: string): string => {
  const hash = createHash('sha256'); const fd = openSync(file, 'r'); const buffer = Buffer.alloc(8 * 1024 * 1024);
  try { for (let n = readSync(fd, buffer, 0, buffer.length, null); n > 0; n = readSync(fd, buffer, 0, buffer.length, null)) hash.update(buffer.subarray(0, n)); } finally { closeSync(fd); }
  return hash.digest('hex');
};
const hashes = (dir: string): Record<string, string> => ({ 'records.redb': sha256(join(dir, 'records.redb')), FORMAT: sha256(join(dir, 'FORMAT')) });

const words = Array.from({ length: 512 }, (_, i) => `w${i.toString(36)}x`);
let seed = 7;
const random = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const bodyOf = (bytes: number): string => { const parts: string[] = []; for (let n = 0; n < bytes;) { const w = words[Math.floor(random() * 512)]!; parts.push(w); n += w.length + 1; } return parts.join(' '); };

const root = join(scratch, 'source-home');
const dbDir = join(root, '.gbrain', 'brain.rust');
const copyHome = join(scratch, 'copy-home');
const copyDir = join(copyHome, '.gbrain', 'brain.rust');
let verdict = 'not finished';
const facts: Record<string, string | number> = {};

try {
  const free = statfsSync(resolve(scratch, '..')).bavail * statfsSync(resolve(scratch, '..')).bsize;
  if (free < 2.5 * targetBytes + 5 * GIB) throw new Error(`not enough free space for the drill: ${free} bytes free, needs ${Math.round(2.5 * targetBytes + 5 * GIB)}`);
  facts.free_bytes_before = free;
  mkdirSync(join(root, '.gbrain'), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify({ engine: 'rust', database_path: dbDir, embedding_disabled: true }));
  const addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: addonPath } });

  let sourceStats: Record<string, number> = {};
  await timed('build the brain', async () => {
    const engine = openRustEngine({ addon, databasePath: dbDir });
    await engine.connect({ engine: 'rust', database_path: dbDir } as never);
    const embedding = new Float32Array(1536).map((_, i) => Math.sin(i));
    for (let n = 0; n < 2000; n++) {
      await engine.putPage(`small/p${n}`, { type: 'note', title: `Small ${n}`, compiled_truth: `small page ${n} about ${words[n % 512]}`, timeline: '' });
      await engine.upsertChunks(`small/p${n}`, [{ chunk_index: 0, chunk_text: `small page ${n}`, chunk_source: 'compiled_truth', embedding, model: 'text-embedding-3-large', token_count: 4 }]);
    }
    for (let n = 0; statSync(join(dbDir, 'records.redb')).size < targetBytes; n++) {
      if (n % 64 === 63) { await new Promise(done => setTimeout(done, 50)); Bun.gc(true); spawnSync('sync'); }
      await engine.putPage(`big/p${n}`, { type: 'note', title: `Big ${n}`, compiled_truth: `uniquemarker${n} ${bodyOf(8 * 1024 * 1024)}`, timeline: '' });
    }
    sourceStats = await engine.getStats() as unknown as Record<string, number>;
    await engine.disconnect();
    return statSync(join(dbDir, 'records.redb')).size;
  }, bytes => `records.redb ${bytes} bytes`);
  facts.records_redb_bytes = statSync(join(dbDir, 'records.redb')).size;
  facts.format_bytes = statSync(join(dbDir, 'FORMAT')).size;
  if (!smoke && Number(facts.records_redb_bytes) <= 8 * GIB) throw new Error('the fixture is not over the 8 GiB cap');
  if (existsSync(join(dbDir, '.gbrain-owner.sock'))) throw new Error('the owner socket is still there: the brain is not stopped');

  const refusal = await timed('backup create at the real cap', async () => {
    const error = await createBackup({ output: join(scratch, 'refused.gbrain-backup'), root, addon }).then(() => null, (e: Error & { code?: string; message: string }) => e);
    if (!smoke && (!error || error.code !== 'backup_too_large')) throw new Error(`expected backup_too_large, got ${error ? error.code : 'a created archive'}`);
    return error?.message ?? 'smoke run: no refusal expected';
  }, message => message.slice(0, 120));
  facts.create_refusal = refusal;

  const before = await timed('sha256 of the stopped source', () => hashes(dbDir));
  mkdirSync(copyDir, { recursive: true, mode: 0o700 });
  await timed('physical copy (cp FORMAT records.redb)', () => {
    const run = spawnSync('cp', [join(dbDir, 'FORMAT'), join(dbDir, 'records.redb'), copyDir], { stdio: 'inherit' });
    if (run.status !== 0) throw new Error('cp failed');
  });
  writeFileSync(join(copyHome, '.gbrain', 'config.json'), JSON.stringify({ engine: 'rust', database_path: copyDir, embedding_disabled: true }));

  const report = await timed('verify-store of the copy (library)', () => verifyRustStoreDir(copyDir, addon), r => `verdict ${r.verdict}, ${r.keys} keys, generation ${r.generation}`);
  const cli = await timed('verify-store of the copy (CLI, --json)', async () => {
    const lines: string[] = []; const log = console.log; console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    try { const result = await runBackupCli(['verify-store', copyDir, '--json'], async () => { throw new Error('no engine'); }); return { exitCode: result.exitCode, json: JSON.parse(lines.join('\n')) as { ok: boolean } }; } finally { console.log = log; }
  }, r => `exit ${r.exitCode}`);
  if (report.verdict !== 'ok' || cli.exitCode !== 0 || !cli.json.ok) throw new Error(`verify-store did not pass: ${report.verdict}`);

  const copied = await timed('sha256 of the copy', () => hashes(copyDir));
  if (copied['records.redb'] !== before['records.redb'] || copied.FORMAT !== before.FORMAT) throw new Error('the copy differs from the source');

  await timed('isolated reopen: counts, an embedding, a page body', async () => {
    const engine = openRustEngine({ addon, databasePath: copyDir });
    await engine.connect({ engine: 'rust', database_path: copyDir } as never);
    try {
      const stats = await engine.getStats() as unknown as Record<string, number>;
      for (const key of ['page_count', 'chunk_count', 'embedded_count']) if (stats[key] !== sourceStats[key]) throw new Error(`${key} differs: ${stats[key]} vs ${sourceStats[key]}`);
      const [chunk] = await engine.getChunksWithEmbeddings('small/p1999', { includeUnsealed: true });
      const vector = chunk?.embedding as Float32Array | undefined;
      if (!vector || vector.length !== 1536 || Math.abs(vector[7]! - Math.sin(7)) > 1e-6) throw new Error('the embedding of small/p1999 is missing or changed in the copy');
      const page = await engine.getPage('big/p0');
      if (!page || page.compiled_truth.length < 8 * 1024 * 1024 - 1024) throw new Error('big/p0 is short in the copy');
      facts.pages = stats.page_count!; facts.chunks = stats.chunk_count!; facts.embedded_chunks = stats.embedded_count!;
    } finally { await engine.disconnect(); }
  });
  const after = await timed('sha256 of the source again', () => hashes(dbDir));
  if (after['records.redb'] !== before['records.redb'] || after.FORMAT !== before.FORMAT) throw new Error('the source changed during the drill');
  facts.sha256_records_redb = before['records.redb']!;
  facts.verify_digest_tags = Object.keys(report.tags).length;
  facts.keyword_index = report.keyword_index ? report.keyword_index.state : 'not checked';
  facts.generation = report.generation ?? -1;
  verdict = 'PASS';
} catch (error) {
  verdict = `FAIL: ${(error as Error).message}`;
  console.error(verdict);
} finally {
  const addonSha = createHash('sha256').update(readFileSync(addonPath)).digest('hex');
  const total = Number(facts.records_redb_bytes ?? 0) + Number(facts.format_bytes ?? 0);
  const seconds = (name: string): string => `${steps.find(s => s.step.startsWith(name))?.seconds ?? 'not run'} s`;
  writeFileSync(receiptPath, [
    '# Physical-copy drill: a Rust brain above the 8 GiB archive cap', '',
    `Verdict: **${verdict}**`, '',
    '| What | Value |', '| --- | --- |',
    '| Method | `quiesced_physical_copy` (the runbook in `docs/guides/in-agent-setup.md`, "Large brains on the Rust engine"): stop the brain, `cp` FORMAT and records.redb into a new home, `gbrain backup verify-store`, open the copy in isolation |',
    `| Brain | isolated, built by \`scripts/rust/large-store-fixture.ts\` through the addon (2,000 small pages with 1,536-dimension embeddings, then ~8 MiB pages); never a real brain, never touched by a shadow |`,
    `| records.redb bytes | ${facts.records_redb_bytes ?? 'n/a'} (${(Number(facts.records_redb_bytes ?? 0) / GIB).toFixed(2)} GiB; cap ${8 * GIB}) |`,
    `| Bytes copied (records.redb + FORMAT) | ${total} |`,
    `| Pages, chunks, embedded chunks | ${facts.pages ?? 'n/a'}, ${facts.chunks ?? 'n/a'}, ${facts.embedded_chunks ?? 'n/a'} (equal on the source and the copy) |`,
    `| Quiescence | the brain's engine was disconnected before the copy; no \`.gbrain-owner.sock\` in the directory |`,
    `| \`backup create\` at the real cap | ${facts.create_refusal ? `refused \`backup_too_large\`: ${String(facts.create_refusal).slice(0, 160)}` : 'n/a'} |`,
    `| Copy duration | ${seconds('physical copy')} |`,
    `| verify-store | ${seconds('verify-store of the copy (library)')} library, ${seconds('verify-store of the copy (CLI')} CLI; verdict ${verdict === 'PASS' ? 'ok' : 'see the verdict above'}; ${facts.verify_digest_tags ?? 'n/a'} record kinds digested; keyword index ${facts.keyword_index ?? 'n/a'}; generation ${facts.generation ?? 'n/a'} |`,
    `| sha256 records.redb, source = copy = source after | ${facts.sha256_records_redb ?? 'n/a'} |`,
    `| Isolated reopen | ${seconds('isolated reopen')}: counts equal, a 1,536-dimension embedding read back exactly, an 8 MiB page body read back whole |`,
    `| Build duration | ${seconds('build the brain')} |`,
    `| Platform | ${process.platform}-${process.arch}, Bun ${Bun.version}, ${cpus().length} CPUs, ${Math.round(totalmem() / GIB)} GiB RAM |`,
    `| gbrain version, addon sha256 | ${VERSION}, ${addonSha} |`,
    `| Free space before | ${facts.free_bytes_before ?? 'n/a'} bytes |`, '',
    'Steps and durations:', '', ...steps.map(s => `- ${s.step}: ${s.seconds} s${s.note ? ` (${s.note})` : ''}`), '',
  ].join('\n'));
  if (!process.argv.includes('--keep')) rmSync(scratch, { recursive: true, force: true });
  console.log(`receipt: ${receiptPath}; scratch ${process.argv.includes('--keep') ? 'kept' : 'deleted'}`);
  process.exit(verdict === 'PASS' ? 0 : 1);
}
