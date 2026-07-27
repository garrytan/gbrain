/**
 * v0.42 Wave D2 — `gbrain extract --explain <kind>` CLI.
 *
 *   gbrain extract --explain <kind>
 *
 * Prints the active-pack's resolution chain for the requested kind:
 *   - Which pack declares it extractable
 *   - The ExtractableSpec struct (prompt_template path, fixture_corpus
 *     path, eval_dimensions, benchmark_min_recall)
 *   - Whether prompt + fixture files exist on disk
 *   - The last 7-day rollup row for the kind (eval-fail rate, halt rate)
 *
 * Discovery aid for pack authors. No mutations.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { BrainEngine } from '../core/engine.ts';
import { loadActivePackBestEffort } from '../core/schema-pack/best-effort.ts';
import { getExtractableSpec, extractableSpecsFromPack } from '../core/schema-pack/extractable.ts';
import { locateMutablePackFile } from '../core/schema-pack/mutate.ts';

export async function runExtractExplain(
  engine: BrainEngine,
  args: string[],
): Promise<void> {
  const json = args.includes('--json');
  // --explain consumes the NEXT positional arg as the kind.
  const explainIdx = args.indexOf('--explain');
  const kindArg = explainIdx >= 0 && explainIdx + 1 < args.length
    ? args[explainIdx + 1]
    : args.find((a, i) => i > 0 && !a.startsWith('--'));

  if (!kindArg || kindArg.startsWith('--')) {
    console.error('Usage: gbrain extract --explain <kind>');
    process.exit(2);
  }

  // Active pack (best-effort; null when no pack configured).
  const pack = await loadActivePackBestEffort({
    engine,
    remote: false,
  } as unknown as Parameters<typeof loadActivePackBestEffort>[0]);

  if (!pack) {
    if (json) {
      console.log(JSON.stringify({
        schema_version: 1,
        kind: kindArg,
        status: 'no_active_pack',
        message: 'No active schema pack configured.',
      }, null, 2));
    } else {
      console.log(`Kind: ${kindArg}`);
      console.log('Status: no active pack configured');
      console.log('');
      console.log('Configure a pack with: gbrain schema use <pack-name>');
    }
    return;
  }

  const spec = getExtractableSpec(pack.manifest, kindArg);

  // Built-in cycle phase kinds that aren't declared in pack manifests
  // (they're hardcoded in the cycle dispatcher per Wave B). Surface them
  // distinctly from "kind not found" so operators understand the
  // landscape.
  const cyclePhaseKinds = new Set([
    'facts.conversation',
    'facts.fence',
    'atoms',
    'concepts',
    'takes.proposed',
  ]);

  if (!spec && !cyclePhaseKinds.has(kindArg)) {
    const allExtractable = Array.from(extractableSpecsFromPack(pack.manifest).keys()).sort();
    if (json) {
      console.log(JSON.stringify({
        schema_version: 1,
        kind: kindArg,
        status: 'not_declared',
        active_pack: pack.manifest.name,
        available_extractable_kinds: allExtractable,
        builtin_kinds: Array.from(cyclePhaseKinds).sort(),
      }, null, 2));
    } else {
      console.log(`Kind: ${kindArg}`);
      console.log(`Active pack: ${pack.manifest.name}`);
      console.log('Status: NOT declared extractable by this pack');
      console.log('');
      console.log('Pack-declared extractable kinds:');
      if (allExtractable.length === 0) {
        console.log('  (none)');
      } else {
        for (const k of allExtractable) console.log(`  ${k}`);
      }
      console.log('');
      console.log('Built-in kinds (shipped by gbrain cycle phases):');
      for (const k of Array.from(cyclePhaseKinds).sort()) console.log(`  ${k}`);
      console.log('');
      console.log(`To declare it: gbrain schema scaffold-extractable ${kindArg} --pack ${pack.manifest.name}`);
    }
    return;
  }

  // Pack-declared kind — load files and look up rollup.
  let promptPath: string | undefined;
  let fixturePath: string | undefined;
  let promptExists = false;
  let fixtureExists = false;
  if (spec) {
    try {
      const located = locateMutablePackFile(pack.manifest.name);
      const packRoot = dirname(located.path);
      if (spec.prompt_template) {
        promptPath = join(packRoot, spec.prompt_template);
        promptExists = existsSync(promptPath);
      }
      if (spec.fixture_corpus) {
        fixturePath = join(packRoot, spec.fixture_corpus);
        fixtureExists = existsSync(fixturePath);
      }
    } catch {
      // Bundled pack (read-only) — paths not resolvable in mutable tier
    }
  }

  // Pull last 7d rollup aggregate for this kind.
  type RollupRow = {
    cost_7d_usd: number;
    eval_pass_count: number;
    eval_fail_count: number;
    halt_count: number;
    round_completed_count: number;
    last_updated_at: Date | string | null;
  };
  let rollup: RollupRow | null = null;
  try {
    const rows = await engine.executeRaw<RollupRow>(
      `SELECT
         SUM(cost_usd) AS cost_7d_usd,
         SUM(eval_pass_count) AS eval_pass_count,
         SUM(eval_fail_count) AS eval_fail_count,
         SUM(halt_count) AS halt_count,
         SUM(round_completed_count) AS round_completed_count,
         MAX(updated_at) AS last_updated_at
       FROM extract_rollup_7d
       WHERE day >= CURRENT_DATE - 7 AND kind = $1`,
      [kindArg],
    );
    rollup = rows[0] ?? null;
  } catch {
    // Pre-v106 brain — leave rollup null.
  }

  if (json) {
    console.log(JSON.stringify({
      schema_version: 1,
      kind: kindArg,
      status: spec ? 'pack_declared' : 'builtin',
      active_pack: pack.manifest.name,
      spec,
      prompt_template: promptPath ? { path: promptPath, exists: promptExists } : null,
      fixture_corpus: fixturePath ? { path: fixturePath, exists: fixtureExists } : null,
      rollup_7d: rollup,
    }, null, 2));
    return;
  }

  console.log(`Kind: ${kindArg}`);
  console.log(`Active pack: ${pack.manifest.name}`);
  console.log(`Status: ${spec ? 'pack-declared extractable' : 'built-in cycle phase (no pack declaration)'}`);
  console.log('');
  if (spec) {
    console.log('ExtractableSpec:');
    console.log(`  prompt_template: ${spec.prompt_template ?? '(none)'} ${promptExists ? '✓' : '(missing)'}`);
    console.log(`  fixture_corpus:  ${spec.fixture_corpus ?? '(none)'} ${fixtureExists ? '✓' : '(missing)'}`);
    console.log(`  eval_dimensions: ${spec.eval_dimensions?.join(', ') ?? '(none)'}`);
    if (spec.benchmark_min_recall != null) {
      console.log(`  benchmark_min_recall: ${spec.benchmark_min_recall}`);
    }
    if (spec.verifier_path) {
      console.log(`  verifier_path: ${spec.verifier_path} (RESERVED; v0.43+ trust review)`);
    }
    console.log('');
  }
  if (rollup) {
    const halts = Number(rollup.halt_count) || 0;
    const completed = Number(rollup.round_completed_count) || 0;
    const total = halts + completed;
    const haltRate = total > 0 ? ((halts / total) * 100).toFixed(1) : '0.0';
    console.log('Last 7 days (rollup):');
    console.log(`  cost_usd:         $${(Number(rollup.cost_7d_usd) || 0).toFixed(4)}`);
    console.log(`  rounds_completed: ${completed}`);
    console.log(`  halts:            ${halts} (${haltRate}%)`);
    console.log(`  eval_pass:        ${Number(rollup.eval_pass_count) || 0}`);
    console.log(`  eval_fail:        ${Number(rollup.eval_fail_count) || 0}`);
    if (rollup.last_updated_at) {
      console.log(`  last_run:         ${new Date(rollup.last_updated_at).toISOString()}`);
    }
  } else {
    console.log('Last 7 days (rollup): no runs recorded');
  }
}
