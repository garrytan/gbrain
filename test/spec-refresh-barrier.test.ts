/**
 * spec/tla/refresh-barrier models the refresh write barrier (spec/tla/README.md). This test keeps the model's configs
 * honest about what they check: the default config is #8682 alone, every config checks a property, and the TLA+
 * workflow runs when anything a mutant names changes.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SPEC = join(ROOT, 'spec/tla/refresh-barrier');
const CONFIGS = readdirSync(SPEC).filter(f => f.endsWith('.cfg')).sort();
const read = (cfg: string) => readFileSync(join(SPEC, cfg), 'utf8');
const SAFETY = [...read('RefreshBarrier.cfg').matchAll(/^INVARIANT (\w+)$/gm)].map(m => m[1]!);

function constants(cfg: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of read(cfg).split('\n')) {
    const m = line.match(/^\s+(\w+)\s*=\s*(.+?)\s*$/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

describe('spec/tla/refresh-barrier configs', () => {
  test('RefreshBarrier.cfg checks #8682 alone, as coded', () => {
    const c = constants('RefreshBarrier.cfg');
    expect({ ImportHolds: c.ImportHolds, RecoveryDefers: c.RecoveryDefers, AdoptLocalEdits: c.AdoptLocalEdits })
      .toEqual({ ImportHolds: 'FALSE', RecoveryDefers: 'FALSE', AdoptLocalEdits: 'FALSE' });
  });

  for (const cfg of CONFIGS) {
    test(cfg + ': checks every safety invariant, or the liveness properties', () => {
      const text = read(cfg);
      const checked = [...text.matchAll(/^(?:INVARIANT|PROPERTY) (\w+)$/gm)].map(m => m[1]!);
      if (text.includes('SPECIFICATION FairSpec')) expect(checked).toEqual(['DeferredLeaves', 'EveryWriteEnds']);
      else expect(checked).toEqual(SAFETY);
    });
  }
});

describe('the TLA+ workflow runs when anything a refresh-barrier mutant names changes', () => {
  test('every code file and test in mutants.json is in tla-spec.yml\'s path filter', () => {
    const workflow = readFileSync(join(ROOT, '.github/workflows/tla-spec.yml'), 'utf8');
    const list = (from: string, to: string) => [...workflow.slice(workflow.indexOf(from), workflow.indexOf(to)).matchAll(/^\s+- '([^']+)'$/gm)].map(m => m[1]!);
    const { mutants } = JSON.parse(read('../refresh-barrier/mutants.json')) as { mutants: Array<{ code?: { edits: Array<{ file: string }>; tests: Array<{ test: string }> } }> };
    const named = new Set(mutants.flatMap(m => m.code ? [...m.code.edits.map(e => e.file), ...m.code.tests.map(t => t.test)] : []));
    const paths = new Set(list('  pull_request:', '  push:'));
    expect([...named].filter(file => !paths.has(file))).toEqual([]);
    expect(workflow).toContain('spec: [drain-lease, refresh-barrier]');
  });
});
