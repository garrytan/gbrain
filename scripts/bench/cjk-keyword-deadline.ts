#!/usr/bin/env bun
/**
 * #5989 / #6043 bench: the CJK keyword arm on a large Korean Postgres corpus,
 * today's path (strict AND under the engine's 8 s statement timeout) against
 * the hybrid path (OR fallback + one total deadline with a capped retry).
 * Opt-in, never run in CI, not shipped in the CLI. No network.
 *
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5434/gbrain_test \
 *     bun scripts/bench/cjk-keyword-deadline.ts [--pages 50000] [--deadline 3000] [--runs 3] [--keep]
 *
 * Creates `gbrain_bench_cjk_<hex>` on the DATABASE_URL server, seeds
 * `--pages` pages x 8 chunks of ~530-character Korean text drawn from a
 * fixed vocabulary in which the 2-term query's words are common (about 90%
 * of chunks match both), so the 2-term query matches most of the table and
 * the 5- and 7-term particle-bearing queries match nothing, like the
 * reporter's brain. Reports wall time, rows and the arm outcome per query
 * and path (median of `--runs`). Ranking quality among capped candidates is
 * not measured (no relevance judgments). Drops the database unless --keep.
 */
import { randomBytes } from 'node:crypto';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { CjkKeywordMeta } from '../../src/core/engine-sql/cjk-search.ts';

function flag(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
}
const PAGES = flag('pages', 50_000);
const DEADLINE = flag('deadline', 3000);
const RUNS = flag('runs', 3);
const KEEP = process.argv.includes('--keep');
const QUERIES = ['좌석 업그레이드', '팀 좌석을 업그레이드하는 방법은 무엇인가요?', '관리자 계정의 비밀번호를 변경하려면 어떻게 해야 하나요'];
const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) throw new Error('Set DATABASE_URL to a Postgres server where this role may CREATE DATABASE.');
const log = (m: string) => console.error(`[bench ${new Date().toISOString().slice(11, 19)}] ${m}`);

const dbName = `gbrain_bench_cjk_${randomBytes(6).toString('hex')}`;
const admin = postgres(adminUrl, { max: 1, prepare: false });
await admin.unsafe(`CREATE DATABASE ${dbName}`);
const url = new URL(adminUrl);
url.pathname = `/${dbName}`;
const engine = new PostgresEngine();
await engine.connect({ database_url: url.toString(), poolSize: 2 });

const rows: string[] = [];
try {
  await engine.initSchema();
  log(`seeding ${PAGES} pages x 8 chunks into ${dbName}`);
  await engine.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, knowledge_revision, text_projection_revision, chunker_version)
    SELECT 'kr/p-' || i, 'default', 'note', '문서 ' || i, 'x', '00000000-0000-4000-8000-000000000001'::uuid,
      '00000000-0000-4000-8000-000000000001'::uuid, 4 FROM generate_series(1, ${PAGES}) i`);
  await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source)
    SELECT p.id, c, (
      SELECT string_agg((ARRAY['좌석', '업그레이드', '요금제', '관리자', '설정', '사용자', '계정', '결제', '팀', '기능', '변경', '확인', '지원', '문의', '프로젝트'])[1 + ((p.id * 31 + c * 17 + w * 7) % 15)]
        || CASE WHEN w % 6 = 0 THEN '. ' ELSE ' ' END, '')
      FROM generate_series(1, 130) w
    ), 'compiled_truth'
    FROM pages p CROSS JOIN generate_series(0, 7) c`);
  await engine.executeRaw('ANALYZE content_chunks');
  await engine.executeRaw('ANALYZE pages');
  const [{ n }] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM content_chunks`);
  log(`seeded ${n} chunks`);

  for (const q of QUERIES) {
    for (const path of ['today', 'bounded'] as const) {
      const times: number[] = [];
      let count = 0;
      let meta: CjkKeywordMeta | undefined;
      let error = '';
      for (let r = 0; r < RUNS; r++) {
        const t = performance.now();
        try {
          const res = await engine.searchKeyword(q, path === 'today' ? { limit: 20 } : { limit: 20, orFallback: true, cjkKeyword: { deadlineMs: DEADLINE, onMeta: m => { meta = m; } } });
          count = res.length;
        } catch (e) {
          error = (e as Error).message.slice(0, 60);
        }
        times.push(performance.now() - t);
      }
      times.sort((a, b) => a - b);
      const outcome = path === 'today' ? (error || 'complete') : meta ? (meta.incomplete ? `incomplete (${meta.reason})${meta.capped ? ', capped' : ''}` : meta.capped ? 'complete, capped' : 'complete') : error;
      rows.push(`| ${q} | ${path} | ${times[Math.floor(times.length / 2)]!.toFixed(0)} | ${count} | ${outcome} |`);
      log(rows.at(-1)!);
    }
  }
} finally {
  await engine.disconnect();
  if (!KEEP) await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
}
console.log(`${PAGES} pages x 8 chunks, deadline ${DEADLINE} ms, median of ${RUNS}\n| query | path | ms | rows | outcome |\n|---|---|---|---|---|\n${rows.join('\n')}`);
