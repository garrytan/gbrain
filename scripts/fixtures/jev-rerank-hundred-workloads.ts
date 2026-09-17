#!/usr/bin/env bun
/** Reconstruct the separate 100-candidate extension without changing the frozen pilot. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FrozenPool } from '../typesafe-rerank-ab.ts';
import { createJevRerankWorkloads } from './jev-rerank-workloads.ts';

export function createHundredDocumentWorkloads(): FrozenPool[] {
  const pilot = createJevRerankWorkloads();
  return [1000, 6000].map(chars => {
    const reference = pilot.find(pool => pool.id === `profile-50x${chars}`)!;
    const candidates = Array.from({ length: 100 }, (_, index) => {
      const gold = index === 99;
      const text = gold ? reference.candidates.at(-1)!.text
        : chars === 1000 ? reference.candidates[index % 9]!.text
        : reference.candidates[0]!.text.replace('note 0.', `note ${index}.`).slice(0, chars);
      return { id: gold ? 'candidate-gold' : `candidate-${index}`, text };
    });
    return { id: `profile-100x${chars}`, query: reference.query,
      group: 'synthetic-atlas-hundred', candidates, relevant: ['candidate-gold'] };
  });
}

if (import.meta.main) {
  const out = process.argv[2];
  if (!out) throw new Error('Usage: bun scripts/fixtures/jev-rerank-hundred-workloads.ts <output.jsonl>');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, createHundredDocumentWorkloads().map(pool => JSON.stringify(pool)).join('\n') + '\n');
}
