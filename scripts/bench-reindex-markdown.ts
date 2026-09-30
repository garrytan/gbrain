import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const checkout = resolve(process.argv[2] ?? join(import.meta.dir, '..'));
const pages = Number(process.argv[3] ?? 3600);
const paragraphs = Number(process.argv[4] ?? 8);
if (!Number.isInteger(pages) || pages < 3000 || pages > 10000 || !Number.isInteger(paragraphs) || paragraphs < 1 || paragraphs > 128) {
  throw new Error('Usage: bun scripts/bench-reindex-markdown.ts [checkout] [pages: 3000..10000] [paragraphs: 1..128]');
}
const root = mkdtempSync(join(tmpdir(), 'gbrain-reindex-bench-'));
const home = join(root, 'home');
mkdirSync(join(home, '.gbrain'), { recursive: true });
mkdirSync(join(root, 'notes'), { recursive: true });
writeFileSync(join(home, '.gbrain/config.json'), JSON.stringify({ engine: 'pglite', database_path: join(home, '.gbrain/brain.pglite') }));
const fixture = resolve(import.meta.dir, '../test/fixtures/reindex-markdown-perf.ts');
const env: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  HOME: home,
  GBRAIN_HOME: home,
  XDG_CONFIG_HOME: join(home, '.config'),
  XDG_DATA_HOME: join(home, '.local/share'),
  GBRAIN_SKIP_STARTUP_HOOKS: '1',
  GBRAIN_NO_UPDATE_CHECK: '1',
  REINDEX_FIXTURE_ROOT: root,
  REINDEX_FIXTURE_CHECKOUT: checkout,
  REINDEX_FIXTURE_PAGES: String(pages),
  REINDEX_FIXTURE_PARAGRAPHS: String(paragraphs),
};
console.log(JSON.stringify({ root, checkout, pages, paragraphs, runtime: Bun.version, platform: process.platform, arch: process.arch }));
const deadline = Date.now() + 600_000;

async function run(name: string, mode: string, killAt?: number) {
  const trace = join(root, `${name}.trace.ndjson`);
  writeFileSync(trace, '');
  const stdout = Bun.file(join(root, `${name}.stdout.log`));
  const stderr = Bun.file(join(root, `${name}.stderr.log`));
  const started = performance.now();
  const child = Bun.spawn([process.execPath, '--no-env-file', ...(mode === 'trace'
    ? ['--preload', fixture, join(checkout, 'src/cli.ts'), 'reindex', '--markdown', '--no-embed', '--json', '--repo', join(root, 'notes')]
    : [fixture])], {
    cwd: join(root, 'notes'),
    env: { ...env, REINDEX_FIXTURE_MODE: mode, REINDEX_FIXTURE_TRACE: trace, REINDEX_FIXTURE_KILL_AT: String(killAt ?? 0) },
    stdout,
    stderr,
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, Math.max(1, deadline - Date.now()));
  let exitCode: number;
  try { exitCode = await child.exited; } finally { clearTimeout(timer); }
  const elapsedMs = performance.now() - started;
  const output = await stdout.text();
  const lines = mode === 'trace' ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const commits = lines.filter(row => row.phase === 'committed');
  const pageCommits = commits.filter(row => row.kind === 'page');
  const commitTimes = commits.map(row => row.commitMs).sort((a, b) => a - b);
  const summary = {
    name, exitCode, timedOut, elapsedMs, output: output.trim(), transactions: commits.length,
    pageTransactions: pageCommits.length,
    uniquePages: new Set(pageCommits.flatMap(row => row.pageKeys)).size,
    maxPagesPerTransaction: pageCommits.reduce((max, row) => Math.max(max, row.pageKeys.length), 0),
    statisticsTransactions: commits.filter(row => row.kind === 'statistics').length,
    unclassifiedTransactions: commits.filter(row => row.kind === 'other').length,
    lastTrace: lines.at(-1),
    commitP50Ms: commitTimes[Math.floor(commitTimes.length * 0.5)],
    commitP99Ms: commitTimes[Math.floor(commitTimes.length * 0.99)],
    commitMaxMs: commitTimes.at(-1),
    bodyMaxMs: commits.reduce((max, row) => Math.max(max, row.bodyMs), 0),
  };
  appendFileSync(join(root, 'summary.ndjson'), JSON.stringify(summary) + '\n');
  console.log(JSON.stringify(summary));
  if (timedOut || (exitCode !== 0 && killAt === undefined)) throw new Error(`${name} failed; logs retained in ${root}`);
  assert.equal(existsSync(join(root, 'network-attempts.log')), false, 'No network calls are permitted');
  return summary;
}

function verifyStore(summary: Awaited<ReturnType<typeof run>>, pending: number) {
  assert.deepEqual(JSON.parse(summary.output), {
    pages, pending, current_without_chunks: 0, current_without_projection: 0, missing_tags: 0,
  });
}

function verifySweep(summary: Awaited<ReturnType<typeof run>>, count: number) {
  const result = JSON.parse(summary.output);
  assert.equal(result.reindexed, count);
  assert.equal(result.pending_after, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.skipped, 0);
  assert.equal(summary.pageTransactions, count, 'Each page must have its own committed transaction');
  assert.equal(summary.uniquePages, count, 'Every rebuilt page must have a distinct guarded transaction');
  assert.equal(summary.maxPagesPerTransaction, count ? 1 : 0, 'A page rebuild transaction must not span multiple pages');
  assert.equal(summary.unclassifiedTransactions, 0, 'Unexpected transactions require explicit investigation');
  assert.equal(summary.transactions, count + summary.statisticsTransactions);
}

verifyStore(await run('seed', 'seed'), pages);
verifySweep(await run('sweep', 'trace'), pages);
verifyStore(await run('after-sweep', 'inspect'), 0);
verifySweep(await run('idempotent', 'trace'), 0);
verifyStore(await run('reset', 'reset'), pages);
const interrupted = await run('interrupted', 'trace', 101);
assert.notEqual(interrupted.exitCode, 0);
assert.equal(interrupted.pageTransactions, 100);
assert.equal(interrupted.uniquePages, 100);
assert.equal(interrupted.maxPagesPerTransaction, 1);
assert.equal(interrupted.unclassifiedTransactions, 0);
assert.equal(interrupted.lastTrace.phase, 'body_done');
assert.equal(interrupted.lastTrace.pageSequence, 101);
verifyStore(await run('after-interrupt', 'inspect'), pages - 100);
verifySweep(await run('resume', 'trace'), pages - 100);
verifyStore(await run('after-resume', 'inspect'), 0);
