/**
 * v0.41.13.0 (T9) — sync timeout cascade-recovery workload.
 *
 * Called by tests/heavy/sync_timeout_rescue.sh. Runs the cron-emulation
 * loop entirely in PGLite + in-memory git fixtures and emits a JSON
 * envelope that the wrapper inspects for pass/fail.
 *
 * The contract being pinned:
 *   1. With --timeout set tight enough that NOT every file imports in one
 *      pass, performSync returns `status: 'partial'` and `last_commit` is
 *      UNCHANGED.
 *   2. Re-running performSync with the same args after a partial resumes:
 *      content_hash short-circuits already-imported files at ~ms each,
 *      remaining files actually get imported.
 *   3. Within WAVES passes, every source reaches `last_commit === HEAD`.
 *
 * Why PGLite (not Postgres): the workload's job is to test per-source
 * AbortController + partial-resume invariants. The parallel-fan-out case
 * lives in test/e2e/sync-parallel.test.ts (real Postgres; D-V4-mech-10).
 * PGLite forces serial sync internally (`parallelEligible` excludes it).
 *
 * Output: JSON envelope to stdout. Stderr captures any noise.
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { performSync } from '../../src/commands/sync.ts';

const PAGES = parseInt(process.env.PAGES ?? '200', 10);
const WAVES = parseInt(process.env.WAVES ?? '3', 10);
const TIMEOUT_SECONDS = parseInt(process.env.TIMEOUT_SECONDS ?? '5', 10);
const STRICT = process.env.STRICT === '1';

interface WaveResult {
  wave: number;
  status: string;
  files_imported: number;
  pages_in_db: number;
}

interface SourceResult {
  id: string;
  pages: number;
  waves: WaveResult[];
  converged_at_wave: number | null;
}

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createGitFixture(sourceId: string, pages: number): string {
  const repoPath = mkdtempSync(join(tmpdir(), `gbrain-rescue-${sourceId}-`));
  git(repoPath, ['init', '--quiet']);
  git(repoPath, ['config', 'user.email', 'test@example.com']);
  git(repoPath, ['config', 'user.name', 'Test']);
  for (let i = 0; i < pages; i++) {
    const slug = `${sourceId}/page-${String(i).padStart(4, '0')}`;
    const path = join(repoPath, `${slug}.md`);
    mkdirSync(join(repoPath, sourceId), { recursive: true });
    writeFileSync(
      path,
      `---\ntitle: Page ${i}\ntype: note\n---\n\n# Page ${i}\n\nFixture content for ${sourceId} page ${i}.\n`,
    );
  }
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '--quiet', '-m', `seed ${pages} pages for ${sourceId}`]);
  return repoPath;
}

async function runSourceWaves(
  engine: PGLiteEngine,
  sourceId: string,
  repoPath: string,
): Promise<SourceResult> {
  // Register the source so per-source last_commit lives in `sources`.
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
    [sourceId, sourceId, repoPath],
  );

  const headCommit = git(repoPath, ['rev-parse', 'HEAD']);
  const waves: WaveResult[] = [];
  let convergedAtWave: number | null = null;

  for (let w = 1; w <= WAVES; w++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_SECONDS * 1000);
    let result;
    try {
      result = await performSync(engine, {
        repoPath,
        sourceId,
        noPull: true,
        noEmbed: true,
        noExtract: true,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const pageRows = await engine.executeRaw<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM pages WHERE source_id = $1`,
      [sourceId],
    );
    waves.push({
      wave: w,
      status: result.status,
      files_imported: result.filesImported ?? (result.added + result.modified),
      pages_in_db: Number(pageRows[0]?.c ?? 0),
    });

    // "Converged" means: this source has every page imported AND the bookmark
    // advanced to HEAD (i.e. status was non-partial AND result.toCommit === HEAD).
    const lastCommitRow = await engine.executeRaw<{ last_commit: string | null }>(
      `SELECT last_commit FROM sources WHERE id = $1`,
      [sourceId],
    );
    const advanced = lastCommitRow[0]?.last_commit === headCommit;
    if (advanced && result.status !== 'partial') {
      convergedAtWave = w;
      break;
    }
  }

  return { id: sourceId, pages: PAGES, waves, converged_at_wave: convergedAtWave };
}

async function main() {
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  const sources = ['default', 'straylight-brain', 'zion-brain', 'media-corpus'];
  const repos = new Map<string, string>();
  for (const s of sources) repos.set(s, createGitFixture(s, PAGES));

  const results: SourceResult[] = [];
  for (const s of sources) {
    const r = await runSourceWaves(engine, s, repos.get(s)!);
    results.push(r);
  }

  await engine.disconnect();

  const allConverged = results.every(r => r.converged_at_wave !== null);
  const summary = {
    schema_version: 1,
    pages_per_source: PAGES,
    waves: WAVES,
    timeout_seconds: TIMEOUT_SECONDS,
    sources: results,
    all_converged: allConverged,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (STRICT && !allConverged) {
    process.stderr.write(
      `[sync_timeout_rescue] FAIL: some sources did not converge within ${WAVES} waves.\n`,
    );
    process.exit(1);
  }
}

main().catch(err => {
  process.stderr.write(`[sync_timeout_rescue] workload threw: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(2);
});
