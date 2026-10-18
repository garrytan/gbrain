#!/usr/bin/env bun
/**
 * Summarize a Bun/V8 .cpuprofile: self time by function and by file (GBRA-66).
 *
 *   bun scripts/bench/efficiency/cpuprof-top.ts <file.cpuprofile> [--top 25]
 */
import { readFileSync } from 'node:fs';
import { REPO, flag } from './lib.ts';

const file = process.argv[2]!;
const top = Number(flag('top', '25'));
const prof = JSON.parse(readFileSync(file, 'utf8'));
const nodes = new Map<number, any>(prof.nodes.map((n: any) => [n.id, n]));
const self = new Map<number, number>();
const deltas: number[] = prof.timeDeltas ?? [];
prof.samples.forEach((id: number, i: number) => self.set(id, (self.get(id) ?? 0) + (deltas[i] ?? 0)));
const byFn = new Map<string, number>();
const byFile = new Map<string, number>();
let total = 0;
for (const [id, us] of self) {
  const cf = nodes.get(id).callFrame;
  const url = String(cf.url || '(native)').replace(`file://${REPO}/`, '').replace(REPO + '/', '');
  const fn = `${cf.functionName || '(anonymous)'} ${url}:${cf.lineNumber + 1}`;
  byFn.set(fn, (byFn.get(fn) ?? 0) + us);
  byFile.set(url, (byFile.get(url) ?? 0) + us);
  total += us;
}
const show = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, us]) => `${(us / 1000).toFixed(1).padStart(9)} ms ${((us / total) * 100).toFixed(1).padStart(5)}%  ${k}`).join('\n');
console.log(`total sampled ${(total / 1000).toFixed(0)} ms\n\n== self time by function ==\n${show(byFn)}\n\n== self time by file ==\n${show(byFile)}`);
