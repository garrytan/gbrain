#!/usr/bin/env bun
/** Reconstruct the exact synthetic candidate text/order used by the completed free-account pilot. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FrozenPool } from '../typesafe-rerank-ab.ts';

const QUERY = 'Which access policy was approved for the Atlas launch?';
const FILLER = ' The team discussed monitoring dashboards, deployment checklists, review meetings, routine coordination, and preparation notes.';
const GOLD = 'The approved Atlas launch access policy was invite-only access for internal employees.';

export function createJevRerankWorkloads(): FrozenPool[] {
  return [[10, 1000], [5, 6000], [50, 1000], [50, 6000]].map(([count, chars]) => {
    const shortFifty = count === 50 && chars === 1000;
    const goldId = shortFifty ? 'short-gold' : `candidate-${count === 5 ? 49 : count! - 1}`;
    const candidates = Array.from({ length: count! }, (_, index) => {
      const gold = index === count! - 1;
      const noteIndex = shortFifty ? index % 9 : index;
      const prefix = gold ? GOLD : `Atlas planning note ${noteIndex}. It describes schedules and review activities but does not record the approved access policy.`;
      return {
        id: gold ? goldId : shortFifty ? `short-negative-${index}` : `candidate-${index}`,
        text: (prefix + FILLER.repeat(Math.ceil(chars! / FILLER.length))).slice(0, chars),
      };
    });
    return { id: `profile-${count}x${chars}`, query: QUERY,
      group: shortFifty ? 'atlas-fifty-short' : 'synthetic-atlas-profile', candidates, relevant: [goldId] };
  });
}

if (import.meta.main) {
  const out = process.argv[2];
  if (!out) throw new Error('Usage: bun scripts/fixtures/jev-rerank-workloads.ts <output.jsonl>');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, createJevRerankWorkloads().map(pool => JSON.stringify(pool)).join('\n') + '\n');
}
