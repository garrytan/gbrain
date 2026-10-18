/**
 * Every subset of the shipped typing units (U1, U3, U4: 2^3 = 8) passes the frozen examples
 * (test/helpers/typing-unit-examples.ts). With no unit, extraction types the world-v1 corpus byte-identically to master
 * (digest of master b5f12b12); with the shipped package it types it as the confirmed package afcec1ad did, plus master's
 * #6191 target-role rule (the only difference; docs/eval/decisions/q2-parser-gaps/dev-units.md, Landing merge)
 * (scripts/q2-typing-dev.ts world-v1). Those checks need a gbrain-evals checkout (GBRAIN_TEST_TYPING_EVALS_DIR, else
 * ../gbrain-evals) and are skipped without one.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { extractPageLinks } from '../src/core/link-extraction.ts';
import { deriveTemporalEvidence } from '../src/core/link-temporal-evidence.ts';
import { TYPING_UNITS, withTypingUnits, type TypingUnit } from '../src/core/link-typing-units.ts';
import { loadWorldV1, worldV1Edges } from '../scripts/q2-typing-dev.ts';
import { EXAMPLES, expected, observe } from './helpers/typing-unit-examples.ts';

const subsets: TypingUnit[][] = Array.from({ length: 1 << TYPING_UNITS.length }, (_, mask) => TYPING_UNITS.filter((_, i) => mask & (1 << i)));

describe(`typing units: all ${subsets.length} subsets pass the frozen examples`, () => {
  for (const units of subsets) {
    test(`{${units.join(',')}}`, async () => {
      await withTypingUnits(units, async () => {
        for (const ex of EXAMPLES) {
          const want = expected(ex, new Set(units));
          expect({ id: ex.id, ...(await observe(ex, want)) }).toEqual({ id: ex.id, ...want });
        }
      });
    });
  }
});

const evalsDir = resolve(process.env.GBRAIN_TEST_TYPING_EVALS_DIR ?? join(import.meta.dir, '../../gbrain-evals'));
const worldDir = join(evalsDir, 'eval/data/world-v1');
const haveWorld = existsSync(worldDir);
if (!haveWorld) console.warn(`[link-typing-units-subsets] world-v1 identity skipped: no ${worldDir}. Set GBRAIN_TEST_TYPING_EVALS_DIR to a gbrain-evals checkout to run it.`);

test.skipIf(!haveWorld)('no unit: world-v1 typing is byte-identical to master', async () => {
  const master = readFileSync(join(import.meta.dir, 'fixtures/q2-typing-units/world-v1-master.sha256'), 'utf8').trim();
  const r = await withTypingUnits([], () => worldV1Edges(loadWorldV1(worldDir), extractPageLinks as never, deriveTemporalEvidence as never));
  expect(r.sha256).toBe(master);
}, 60_000);

test.skipIf(!haveWorld)('shipped package: world-v1 typing is the confirmed package afcec1ad plus master\'s target-role rule', async () => {
  const confirmed = readFileSync(join(import.meta.dir, 'fixtures/q2-typing-units/world-v1-confirmed-package.sha256'), 'utf8').trim();
  const r = await worldV1Edges(loadWorldV1(worldDir), extractPageLinks as never, deriveTemporalEvidence as never);
  expect(r.sha256).toBe(confirmed);
}, 60_000);
