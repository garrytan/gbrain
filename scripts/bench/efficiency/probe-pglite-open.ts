#!/usr/bin/env bun
/**
 * PGLite open probe (GBRA-92). Opt-in, never run in CI.
 *
 *   bun scripts/bench/efficiency/probe-pglite-open.ts --data <brain.pglite dir> [--n 20]
 *
 * Times `PGlite.create` on a copy of an existing PGLite data directory, one
 * fresh process per sample, interleaving four variants:
 *   stock-128MB  PGLite's stock vector/pg_trgm extensions (eager preload), the
 *                data directory's shared_buffers (128MB)
 *   lazy-128MB   gbrain's extensions (files written after start, loaded on first use)
 *   stock-32MB / lazy-32MB  the same with `-c shared_buffers=32MB` (one-shot reads)
 * Each sample also times the first query that loads vector.so, so the cost the
 * lazy extensions move to first use stays visible. Prints p50/p95 per variant.
 */
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flag, pct, round } from './lib.ts';

const VARIANTS = ['stock-128MB', 'lazy-128MB', 'stock-32MB', 'lazy-32MB'] as const;

if (flag('child')) {
  const [ext, buffers] = flag('child')!.split('-') as ['stock' | 'lazy', string];
  const { getEmbeddedPgliteOptions } = await import('../../../src/core/pglite-embedded-assets.ts');
  const { PGlite } = await import('@electric-sql/pglite');
  const embedded = await getEmbeddedPgliteOptions();
  const extensions = ext === 'lazy' ? embedded.extensions : {
    vector: (await import('@electric-sql/pglite/vector')).vector,
    pg_trgm: (await import('@electric-sql/pglite/contrib/pg_trgm')).pg_trgm,
  };
  const startParams = buffers === '128MB' ? embedded.startParams : [...embedded.startParams, '-c', `shared_buffers=${buffers}`];
  const t0 = performance.now();
  const db = await PGlite.create({ ...embedded, extensions, startParams, dataDir: flag('data')! });
  const t1 = performance.now();
  await db.query(`SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector`);
  const t2 = performance.now();
  await db.close();
  console.log(JSON.stringify({ create: t1 - t0, firstVector: t2 - t1 }));
  process.exit(0);
}

const n = Number(flag('n', '20'));
const work = mkdtempSync(join(tmpdir(), 'gbrain-probe-open-'));
const dataDir = join(work, 'data');
cpSync(flag('data')!, dataDir, { recursive: true });
const samples: Record<string, { create: number[]; firstVector: number[] }> = {};
try {
  for (let i = 0; i < n + 1; i++) {
    for (const v of VARIANTS) {
      const proc = Bun.spawnSync([process.execPath, import.meta.path, '--child', v, '--data', dataDir], { stderr: 'inherit' });
      if (proc.exitCode !== 0) throw new Error(`${v} sample failed (exit ${proc.exitCode})`);
      if (i === 0) continue; // first round warms the page cache
      const r = JSON.parse(proc.stdout.toString().trim().split('\n').pop()!);
      (samples[v] ??= { create: [], firstVector: [] }).create.push(r.create);
      samples[v]!.firstVector.push(r.firstVector);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`variant        n   create p50/p95 ms   first vector query p50/p95 ms`);
for (const v of VARIANTS) {
  const s = samples[v]!;
  console.log(`${v.padEnd(13)} ${String(s.create.length).padStart(3)}   ${round(pct(s.create, 0.5))} / ${round(pct(s.create, 0.95))}`.padEnd(40) + `${round(pct(s.firstVector, 0.5))} / ${round(pct(s.firstVector, 0.95))}`);
}
