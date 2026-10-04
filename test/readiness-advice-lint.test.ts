/**
 * A7 lint: "turn on / switch embeddings" advice comes from readiness
 * (`embeddingEnablement` in src/core/readiness.ts), never from hand-written
 * strings elsewhere in src/.
 *
 * Protects: the six contradictory renderings of "turn on embeddings" (one of
 * them a `mv brain.pglite` wipe that loses DB-only facts) from coming back. A
 * new hard-coded recipe fails here; the allowlist below is the pre-wave
 * baseline, shrink-only (Lanes B/E sweep these sites onto readiness), and a
 * stale count fails too so the list cannot hide a regression.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { RECIPES } from '../src/core/ai/recipes/index.ts';

const ROOT = join(import.meta.dir, '..');
const SRC = join(ROOT, 'src');
const EXEMPT = new Set(['src/core/readiness.ts', 'src/core/cli-flag-registry.generated.ts']);

/** Shrink-only baseline: file → allowed hit count, with the owner that removes it. */
const ALLOWLIST: Record<string, { count: number; reason: string }> = {
  'src/commands/doctor/checks/embedding-health.ts': { count: 1, reason: 'Lane E1: doctor fixes become readiness Actions' },
  'src/commands/init.ts': { count: 1, reason: 'Lane E/G5: init deferred-setup hint renders embeddingEnablement' },
  'src/commands/models.ts': { count: 1, reason: 'Lane E: models dims hint' },
  'src/commands/reindex-code.ts': { count: 2, reason: 'Lane E: reindex-code embedding hint' },
  'src/commands/reinit-pglite.ts': { count: 2, reason: 'usage examples of reinit-pglite\'s own --embedding-model flag' },
  'src/core/advisor/collect-setup-smells.ts': { count: 1, reason: 'Lane E: advisor setup smells read readiness' },
  'src/core/embed-preflight.ts': { count: 5, reason: 'Lane E: embed preflight refusals carry the readiness fix' },
};

const WIPE = /\bmv\s+\S+\s+\S+\.bak\b|\bmv\s+\S*brain\.pglite/;
const REFUSED_CONFIG_SET = /config set embedding_(?:model|dimensions)\b/;
const LITERAL_MODEL = /--embedding-model[ =]+([a-z][a-z0-9-]*):[a-z0-9]/g;

function isComment(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*');
}

function hitsIn(text: string): number {
  let hits = 0;
  for (const line of text.split('\n')) {
    if (isComment(line)) continue;
    if (WIPE.test(line) || REFUSED_CONFIG_SET.test(line)) { hits++; continue; }
    for (const m of line.matchAll(LITERAL_MODEL)) {
      if (RECIPES.has(m[1])) { hits++; break; }
    }
  }
  return hits;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('embedding enablement advice lives in readiness', () => {
  const found = new Map<string, number>();
  for (const file of walk(SRC)) {
    const rel = relative(ROOT, file);
    if (EXEMPT.has(rel)) continue;
    const n = hitsIn(readFileSync(file, 'utf8'));
    if (n > 0) found.set(rel, n);
  }

  test('no wipe recipe and no new hard-coded embedding_model advice outside readiness.ts', () => {
    const offenders = [...found].filter(([f, n]) => n > (ALLOWLIST[f]?.count ?? 0));
    expect(offenders).toEqual([]);
  });

  test('allowlist is shrink-only: a fixed site must drop its entry', () => {
    const stale = Object.entries(ALLOWLIST).filter(([f, a]) => (found.get(f) ?? 0) < a.count).map(([f]) => f);
    expect(stale).toEqual([]);
  });

  test('the detector catches the removed recipes', () => {
    expect(hitsIn('console.error(`  mv ${dbPath} ${dbPath}.bak`);')).toBe(1);
    expect(hitsIn("'  mv ~/.gbrain/brain.pglite ~/.gbrain/brain.pglite.bak'")).toBe(1);
    expect(hitsIn("'Enable with `gbrain init --force --embedding-model voyage:voyage-4`'")).toBe(1);
    expect(hitsIn("'Use --embedding-model provider:model.'")).toBe(0);
    expect(hitsIn(' * mv brain.pglite in a comment')).toBe(0);
  });
});
