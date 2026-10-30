/**
 * GBRA-161 PR 1b load probe: publishes one atom generation per origin page through the primitive, then a second
 * generation per origin that replaces its atom
 * (one retirement each), and reports lock-wait percentiles (page locks and the generation key lock, measured per call)
 * and ledger growth (rows and on-disk bytes of derived_generations and derived_generation_items). Postgres runs 8
 * publishers at once; PGLite has one connection. It reports numbers and asserts only that every publication landed:
 * the plan sets no threshold. Every lane runs it at SMOKE_ORIGINS, so the concurrent publish path runs against each
 * arm's own database; the measured run (GBRAIN_TEST_GENERATION_LOAD=1) defaults to 10000 origins, and
 * GBRAIN_TEST_GENERATION_LOAD_ORIGINS sets either size.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { atomGenerationAdapter, atomOwnerKey, readAtomInput } from '../../src/core/generations/adapters/atoms.ts';
import { markdownItem } from '../../src/core/generations/adapters/page.ts';
import { publishGeneration } from '../../src/core/generations/publish.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { pathologicalArms } from './harness.ts';

const SMOKE_ORIGINS = 200;
const ORIGINS = Number(process.env.GBRAIN_TEST_GENERATION_LOAD_ORIGINS ?? (process.env.GBRAIN_TEST_GENERATION_LOAD === '1' ? 10000 : SMOKE_ORIGINS));

const percentile = (values: number[], p: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]! : 0; };
const atomMarkdown = (origin: string, title: string) => '---\ntype: atom\ntitle: ' + title + '\natom_type: insight\nsource_slug: ' + origin + '\nextracted_by: extract_atoms-load\n---\n' + title + '.\n';

async function ledgerSize(engine: BrainEngine) {
  const [row] = await engine.executeRaw<{ generations: number; items: number; generation_bytes: string; item_bytes: string }>(
    "SELECT (SELECT count(*)::int FROM derived_generations) AS generations, (SELECT count(*)::int FROM derived_generation_items) AS items, pg_total_relation_size('derived_generations')::text AS generation_bytes, pg_total_relation_size('derived_generation_items')::text AS item_bytes");
  return { generations: Number(row!.generations), items: Number(row!.items), generation_bytes: Number(row!.generation_bytes), item_bytes: Number(row!.item_bytes) };
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe('GBRA-161 PR 1b generation load probe (' + backend + ')', () => {
    test(ORIGINS + ' origins: two generations each; lock-wait percentiles and ledger growth', async () => {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-g1-load-'));
      try {
        await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
          const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
          const proto = Object.getPrototypeOf(engine) as BrainEngine;
          const pageLocks: number[] = []; const keyLocks: number[] = [];
          const lockPageKeys = proto.lockPageKeys; const executeRaw = proto.executeRaw;
          proto.lockPageKeys = async function (this: BrainEngine, ...args: Parameters<BrainEngine['lockPageKeys']>) {
            const started = performance.now(); try { return await lockPageKeys.apply(this, args); } finally { pageLocks.push(performance.now() - started); }
          };
          proto.executeRaw = async function (this: BrainEngine, ...args: Parameters<BrainEngine['executeRaw']>) {
            const keyed = typeof args[1]?.[0] === 'string' && String(args[1][0]).startsWith('gbrain:generation:');
            const started = performance.now();
            try { return await (executeRaw as (...a: unknown[]) => Promise<unknown>).apply(this, args); } finally { if (keyed) keyLocks.push(performance.now() - started); }
          } as BrainEngine['executeRaw'];
          try {
            const origins = Array.from({ length: ORIGINS }, (_, index) => 'notes/load-' + String(index).padStart(6, '0'));
            const seeded = performance.now();
            for (const slug of origins) await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'Load origin ' + slug + '. The team ships small changes.', timeline: '' });
            const seedMs = performance.now() - seeded;
            const empty = await ledgerSize(engine);
            const workers = backend === 'postgres' ? 8 : 1;
            const pass = async (title: string) => {
              pageLocks.length = 0; keyLocks.length = 0;
              let next = 0; let published = 0;
              const started = performance.now();
              await Promise.all(Array.from({ length: workers }, async () => {
                for (;;) {
                  const index = next++;
                  if (index >= origins.length) return;
                  const origin = origins[index]!;
                  const key = { kind: atomGenerationAdapter.kind, sourceId: 'default', ownerKey: atomOwnerKey({ kind: 'page', slug: origin }) };
                  const slug = 'atoms/load/' + title.toLowerCase().replaceAll(' ', '-') + '-' + String(index).padStart(6, '0');
                  const outcome = await publishGeneration(engine, atomGenerationAdapter, { key, items: [markdownItem(slug, atomMarkdown(origin, title))],
                    input: await readAtomInput(engine, key), runId: 'load:' + title + ':' + index });
                  if (outcome.state === 'published') published++;
                }
              }));
              return { title, published, ms: Math.round(performance.now() - started),
                page_lock_ms: { p50: +percentile(pageLocks, 0.5).toFixed(2), p99: +percentile(pageLocks, 0.99).toFixed(2), max: +Math.max(0, ...pageLocks).toFixed(2), samples: pageLocks.length },
                key_lock_ms: { p50: +percentile(keyLocks, 0.5).toFixed(2), p99: +percentile(keyLocks, 0.99).toFixed(2), max: +Math.max(0, ...keyLocks).toFixed(2), samples: keyLocks.length },
                ledger: await ledgerSize(engine) };
            };
            const first = await pass('First insight');
            const second = await pass('Second insight');
            const report = { backend, origins: ORIGINS, workers, seed_ms: Math.round(seedMs), ledger_before: empty, passes: [first, second],
              ledger_bytes_per_origin: +(((second.ledger.generation_bytes + second.ledger.item_bytes) - (empty.generation_bytes + empty.item_bytes)) / ORIGINS).toFixed(1) };
            console.log('[generation-load] ' + JSON.stringify(report));
            if (process.env.GBRAIN_TEST_GENERATION_LOAD_OUT) writeFileSync(process.env.GBRAIN_TEST_GENERATION_LOAD_OUT + '.' + backend + '.json', JSON.stringify(report, null, 1));
            expect([first.published, second.published]).toEqual([ORIGINS, ORIGINS]);
            const [{ retired }] = await engine.executeRaw<{ retired: number }>("SELECT count(*)::int AS retired FROM pages WHERE type='atom' AND deleted_at IS NOT NULL");
            expect(Number(retired)).toBe(ORIGINS);
          } finally { proto.lockPageKeys = lockPageKeys; proto.executeRaw = executeRaw; await close(); }
        });
      } finally { rmSync(home, { recursive: true, force: true }); }
    }, 3_600_000);
  });
}
