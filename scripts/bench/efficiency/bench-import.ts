#!/usr/bin/env bun
/**
 * Import-pipeline bench (GBRA-66). Opt-in, never run in CI.
 *
 *   bun scripts/bench/efficiency/bench-import.ts --engine pglite|postgres --data <dir> --label <name>
 *       [--embed] [--max-usd 2] [--pg-url postgresql://postgres:postgres@127.0.0.1:5440/postgres]
 *       [--cpu-prof] [--out results/import.jsonl]
 *
 * <dir> holds one subdirectory per source (`default/`, `notes-main/`, ...). It is
 * copied into the brain home first, because `sources add` writes ownership markers.
 * Creates a fresh, isolated brain at $BENCH_WORK/engines/<engine>-<label>
 * (GBRAIN_HOME), so ~/.gbrain is never touched. Postgres gets a fresh
 * database `bench_<label>` on the --pg-url server.
 *
 * Phases, each a fresh `gbrain` process with preload-instrument.ts:
 *   init                 gbrain init (schema + migrations)
 *   import <source>      gbrain import <dir> --no-embed --source-id <id> (parse + chunk + write)
 *   extract              gbrain extract all --source db (links + timeline)
 *   embed                gbrain embed --stale --max-usd N (provider calls; tokens + USD from usage)
 * Per phase: wall ms, CPU ms, engine method time (outermost calls) and
 * outbound HTTP time. A separate in-process probe times parseMarkdown and
 * chunking alone over the same files, so CPU-side parse/chunk cost is
 * separable from database writes.
 */
import { cpSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { WORK, appendRows, ensureDir, flag, has, lastJson, log, machine, readJsonl, round, runCli, usageCost, writeJson, type Row, type UsageRecord } from './lib.ts';
import { parseMarkdown } from '../../../src/core/markdown.ts';
import { prepareMarkdownChunks } from '../../../src/core/markdown-chunks.ts';

const engine = flag('engine', 'pglite') as 'pglite' | 'postgres';
const srcData = flag('data')!;
const label = flag('label')!;
const pgAdmin = flag('pg-url', 'postgresql://postgres:postgres@127.0.0.1:5440/postgres')!;
const out = flag('out', join(WORK, 'results', 'import.jsonl'))!;
const maxUsd = flag('max-usd', '2')!;
if (!srcData || !label) throw new Error('--data and --label are required');

const home = join(WORK, 'engines', `${engine}-${label}`);
const data = join(home, 'data');
const runDir = ensureDir(join(home, 'bench-run'));
const env: Record<string, string> = { GBRAIN_HOME: home, GBRAIN_ALLOW_DEFAULT_WRITE: '1' };
const M = machine();

function walk(dir: string): string[] {
  const outFiles: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) outFiles.push(...walk(p));
    else if (e.name.endsWith('.md')) outFiles.push(p);
  }
  return outFiles;
}

async function pgExec(sql: string) {
  const p = Bun.spawn(['docker', 'exec', 'gbra66-bench-pg', 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdout: 'pipe', stderr: 'pipe' });
  const code = await p.exited;
  if (code !== 0) throw new Error(`psql failed: ${await new Response(p.stderr).text()}`);
}

interface Phase { phase: string; wall_ms: number; code: number; cpu_user_ms?: number; engine_ms?: number; engine_top?: Record<string, { calls: number; ms: number }>; http_ms?: number; http_calls?: number; usage?: ReturnType<typeof usageCost>; json?: any }

async function phase(name: string, args: string[], extraEnv: Record<string, string> = {}): Promise<Phase> {
  const tag = name.replace(/[^a-z0-9]+/gi, '-');
  const usageFile = join(runDir, `${tag}.usage.jsonl`);
  const timingFile = join(runDir, `${tag}.timing.json`);
  rmSync(usageFile, { force: true });
  const cpuDir = has('cpu-prof') ? ensureDir(join(runDir, `cpuprof-${tag}`)) : undefined;
  const r = await runCli(args, { ...env, ...extraEnv, BENCH_USAGE_LOG: usageFile, BENCH_ENGINE_TIMING: timingFile }, { preload: true, cpuProf: cpuDir });
  if (r.code !== 0) log(`${name} exit ${r.code}: ${r.stderr.split('\n').filter((l) => /error|fail/i.test(l)).slice(0, 3).join(' | ').slice(0, 300)}`);
  let timing: any = {};
  try { timing = JSON.parse(readFileSync(timingFile, 'utf8')); } catch { /* process died early */ }
  const usage = readJsonl<UsageRecord>(usageFile);
  const engineMs = Object.values((timing.engine ?? {}) as Record<string, { ms: number }>).reduce((a, v) => a + v.ms, 0);
  const top = Object.fromEntries(Object.entries(timing.engine ?? {}).slice(0, 8)) as Record<string, { calls: number; ms: number }>;
  const p: Phase = {
    phase: name, wall_ms: round(r.ms), code: r.code, cpu_user_ms: timing.cpu_user_ms, engine_ms: engineMs, engine_top: top,
    http_ms: usage.reduce((a, u) => a + u.ms, 0), http_calls: usage.length, usage: usageCost(usage), json: lastJson(r.stdout),
  };
  log(`${name}: ${p.wall_ms}ms (engine ${engineMs}ms, http ${p.http_ms}ms/${p.http_calls} calls, cpu ${timing.cpu_user_ms}ms)`);
  return p;
}

async function parseChunkProbe(files: string[], root: string) {
  let parse = 0;
  let chunk = 0;
  let chunks = 0;
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    const rel = relative(root, f);
    const t0 = performance.now();
    const parsed = parseMarkdown(text, rel, { validate: true });
    const t1 = performance.now();
    const c = await prepareMarkdownChunks({ compiled_truth: parsed.compiled_truth, timeline: parsed.timeline, frontmatter: parsed.frontmatter });
    const t2 = performance.now();
    parse += t1 - t0;
    chunk += t2 - t1;
    chunks += c.length;
  }
  return { parse_ms: round(parse), chunk_ms: round(chunk), chunks };
}

async function main() {
  log(`engine=${engine} label=${label} home=${home}`);
  rmSync(home, { recursive: true, force: true });
  ensureDir(runDir);
  // Each brain registers and owns its own copy: sources add writes ownership markers into the directory.
  cpSync(srcData, data, { recursive: true });
  const initArgs = ['init', '--non-interactive', '--json', '--skip-embed-check'];
  if (engine === 'pglite') initArgs.push('--pglite');
  else {
    const db = `bench_${label.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
    await pgExec(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await pgExec(`CREATE DATABASE ${db}`);
    initArgs.push('--url', pgAdmin.replace(/\/[^/]*$/, `/${db}`));
  }
  const phases: Phase[] = [await phase('init', initArgs)];

  const sources = readdirSync(data).filter((d) => statSync(join(data, d)).isDirectory()).sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)));
  let files = 0;
  let bytes = 0;
  const probe = { parse_ms: 0, chunk_ms: 0, chunks: 0 };
  for (const src of sources) {
    const dir = join(data, src);
    const fl = walk(dir);
    files += fl.length;
    bytes += fl.reduce((a, f) => a + statSync(f).size, 0);
    if (src !== 'default') phases.push(await phase(`sources add ${src}`, ['sources', 'add', src, '--path', dir, '--federated', '--force']));
    const imp = await phase(`import ${src}`, ['import', dir, '--no-embed', '--json', '--source-id', src]);
    if (imp.code !== 0) throw new Error(`import ${src} failed (exit ${imp.code})`);
    phases.push(imp);
    const pr = await parseChunkProbe(fl, dir);
    probe.parse_ms += pr.parse_ms;
    probe.chunk_ms += pr.chunk_ms;
    probe.chunks += pr.chunks;
  }
  phases.push(await phase('extract all', ['extract', 'all', '--source', 'db', '--json']));
  if (has('embed')) phases.push(await phase('embed --stale', ['embed', '--stale', '--json', '--max-usd', maxUsd]));
  const stats = lastJson((await runCli(['stats', '--json'], env)).stdout) ?? {};
  const pages = Number(stats.page_count ?? 0);
  const chunks = Number(stats.chunk_count ?? 0);

  const importPhases = phases.filter((p) => p.phase.startsWith('import '));
  const sum = (ps: Phase[], k: keyof Phase) => ps.reduce((a, p) => a + Number(p[k] ?? 0), 0);
  const rows: Row[] = [];
  const base = { suite: 'import' as const, machine: M, engine, brain: label, pages, chunks, mode: 'once' as const, n: 1 };
  for (const p of phases) {
    rows.push({ ...base, command: `gbrain ${p.phase}`, p50_ms: p.wall_ms, p95_ms: p.wall_ms, errors: p.code === 0 ? 0 : 1, extra: { cpu_user_ms: p.cpu_user_ms, engine_ms: p.engine_ms, http_ms: p.http_ms, http_calls: p.http_calls, usd: p.usage?.usd, usage: p.usage?.byModel, engine_top: p.engine_top } });
  }
  const totalImport = sum(importPhases, 'wall_ms');
  rows.push({
    ...base, command: 'import pipeline total (all sources, --no-embed)', p50_ms: round(totalImport), p95_ms: round(totalImport),
    extra: {
      files, bytes, ms_per_page: round(totalImport / Math.max(1, files), 2), engine_ms: sum(importPhases, 'engine_ms'), cpu_user_ms: sum(importPhases, 'cpu_user_ms'), http_ms: sum(importPhases, 'http_ms'),
      probe_parse_ms: round(probe.parse_ms), probe_chunk_ms: round(probe.chunk_ms), probe_chunks: probe.chunks,
      extract_ms: phases.find((p) => p.phase === 'extract all')?.wall_ms, embed_ms: phases.find((p) => p.phase.startsWith('embed'))?.wall_ms,
      embed_usd: phases.find((p) => p.phase.startsWith('embed'))?.usage?.usd ?? 0, stats: { links: stats.link_count, timeline: stats.timeline_entry_count, embedded: stats.embedded_count },
    },
  });
  appendRows(out, rows);
  writeJson(join(WORK, 'results', `import-${engine}-${label}.json`), { machine: M, engine, label, files, bytes, stats: { pages, chunks, links: stats.link_count, timeline: stats.timeline_entry_count, embedded: stats.embedded_count }, probe, phases: phases.map(({ json: _j, ...p }) => p) });
  log(`done: pages=${pages} chunks=${chunks} import=${round(totalImport)}ms`);
}

await main();
