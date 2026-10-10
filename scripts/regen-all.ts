#!/usr/bin/env bun
/**
 * One entry point for every generated artifact (GBRA-47 B8; DX-14).
 *
 *   bun run regen:all              regenerate every artifact, print what changed
 *   bun run regen:all --check      read-only: run every artifact's freshness check
 *                                  (what `bun run verify` runs as check:regen-all)
 *   bun run regen:all --goldens    also regenerate the offline contract goldens
 *                                  (deliberate: justify each changed golden in the PR body)
 *
 * Offline and keyless: generators run with provider keys and database URLs
 * removed from the environment. Idempotent: a second run changes nothing.
 * Goldens that need Postgres are never regenerated here; they are named with
 * their own command. Order matters: llms.txt inlines docs other generators
 * write, so it runs last.
 *
 * Exit: 0 fresh (or regenerated), 1 --check found stale artifacts or a
 * generator failed, 2 usage error.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface Artifact { name: string; regen: string[]; check: string[] }

const HARNESS_DOCS_CHECK = `import { readFileSync } from 'node:fs';
import { renderHarnessReference } from './src/core/harness/registry.ts';
if (readFileSync('docs/guides/harness-adapters.md', 'utf8') !== renderHarnessReference()) {
  console.error('docs/guides/harness-adapters.md is stale');
  process.exit(1);
}`;

/**
 * Every `bun test` this script spawns. Bun does not apply bunfig.toml's
 * `[test] timeout`, so without the flag a cold PGLite init or a JIT-less
 * runner hits the 5 s default (#6187).
 */
const BUN_TEST = ['bun', 'test', '--timeout=60000'];

export const ARTIFACTS: Artifact[] = [
  { name: 'schema (src/schema-embedded)', regen: ['bun', 'run', 'scripts/build-schema.ts'], check: ['bash', 'scripts/check-schema-fresh.sh'] },
  { name: 'schema migrations bundle', regen: ['bun', 'run', 'scripts/build-schema-migrations.ts'], check: ['bash', 'scripts/check-schema-migrations-fresh.sh'] },
  { name: 'error-code registry docs', regen: ['bun', 'scripts/build-error-codes.ts'], check: ['bun', 'scripts/build-error-codes.ts', '--check'] },
  { name: 'agent operator protocol blocks', regen: ['bun', 'scripts/build-agent-protocol.ts'], check: ['bun', 'scripts/build-agent-protocol.ts', '--check'] },
  { name: 'harness adapter reference', regen: ['bun', 'run', 'scripts/build-harness-docs.ts'], check: ['bun', '-e', HARNESS_DOCS_CHECK] },
  { name: 'operation manifest', regen: ['bun', 'run', 'scripts/build-operation-manifest.ts'], check: [...BUN_TEST, 'test/operation-manifest.test.ts'] },
  { name: 'MCP tool catalog', regen: ['bun', 'run', 'scripts/generate-tool-catalog.ts'], check: ['bash', 'scripts/check-tool-catalog-fresh.sh'] },
  { name: 'skills manifest', regen: ['bun', 'run', 'scripts/generate-skills-manifest.ts'], check: ['bash', 'scripts/check-skills-manifest-fresh.sh'] },
  { name: 'eval metric glossary', regen: ['bun', 'run', 'scripts/generate-metric-glossary.ts'], check: ['bash', 'scripts/check-eval-glossary-fresh.sh'] },
  { name: 'CLI flag registry', regen: ['bun', 'run', 'scripts/generate-flag-registry.ts'], check: [...BUN_TEST, 'test/generate-flag-registry.test.ts'] },
  { name: 'plugin tree + persona variants', regen: ['bun', 'run', 'scripts/generate-plugin-tree.ts', '--out', 'plugin', '--variants-out', 'plugin-variants'], check: ['bash', 'scripts/check-plugin-tree.sh'] },
  { name: 'structural suites manifest', regen: ['bun', 'scripts/classify-tests.ts'], check: ['bun', 'scripts/classify-tests.ts', '--check'] },
  { name: 'llms.txt + llms-full.txt', regen: ['bun', 'run', 'scripts/build-llms.ts'], check: [...BUN_TEST, 'test/build-llms.test.ts'] },
];

/** Offline contract goldens: regenerated only with --goldens, each a reviewer-visible change to justify. */
export const CONTRACT_GOLDENS = [
  'test/export-surface-golden.test.ts',
  'test/cli-goldens.test.ts',
  'test/cli-dispatch-phase.test.ts',
  'test/engine-sql-sql-text.test.ts',
];

/** Goldens that need a Postgres database; never run here. */
export const POSTGRES_GOLDENS = [
  'GBRAIN_TEST_UPDATE_GOLDENS=1 DATABASE_URL=<test db> bun test --timeout=60000 test/e2e/schema-catalog-golden.test.ts',
  'GBRAIN_TEST_UPDATE_GOLDENS=1 DATABASE_URL=<test db> bun test --timeout=60000 test/e2e/doctor-json-golden.test.ts',
];

export const goldenArgv = (file: string): string[] => [...BUN_TEST, file];

const ROOT = resolve(import.meta.dir, '..');
const DOCS = 'docs/RELEASING.md#generated-artifacts';

export function offlineEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || /_API_KEY$|_API_TOKEN$/.test(k) || k === 'DATABASE_URL' || k === 'GBRAIN_DATABASE_URL') continue;
    out[k] = v;
  }
  return out;
}

async function run(argv: string[], env: Record<string, string>): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(argv, { cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, output: `${out}${err}` };
}

/** Dirty paths (git status) with a content hash, so a second change to an already-dirty file still shows. */
function dirtyState(): Map<string, string> {
  const r = Bun.spawnSync(['git', 'status', '--porcelain', '--untracked-files=all'], { cwd: ROOT, stdout: 'pipe' });
  return new Map(r.stdout.toString().split('\n').filter(Boolean).map(line => {
    const path = line.slice(3).replace(/^.* -> /, '');
    const file = join(ROOT, path);
    return [path, existsSync(file) ? String(Bun.hash(readFileSync(file))) : 'deleted'];
  }));
}

/** Run every freshness check (pool of 4); returns the stale artifacts with their output tails. */
export async function checkArtifacts(artifacts: Artifact[], env = offlineEnv()): Promise<Array<{ artifact: Artifact; tail: string }>> {
  const stale: Array<{ artifact: Artifact; tail: string }> = [];
  const queue = [...artifacts];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let a = queue.shift(); a; a = queue.shift()) {
      const r = await run(a.check, env);
      if (r.code !== 0) stale.push({ artifact: a, tail: r.output.trim().split('\n').slice(-8).join('\n') });
    }
  }));
  return artifacts.flatMap(a => stale.filter(s => s.artifact === a));
}

export function staleReport(stale: Array<{ artifact: Artifact; tail: string }>): string {
  return [
    ...stale.flatMap(({ artifact, tail }) => [`STALE ${artifact.name} (check: ${artifact.check.slice(0, 3).join(' ')}${artifact.check.length > 3 ? ' …' : ''})`, ...tail.split('\n').map(l => `  | ${l}`)]),
    `regen:all --check: ${stale.length} generated artifact(s) stale: ${stale.map(s => s.artifact.name).join(', ')}`,
    'Why: a committed artifact no longer matches its generator, so CI fails the freshness gate.',
    'Fix: bun run regen:all   (then commit the changed files it lists)',
    `Docs: ${DOCS}`,
  ].join('\n');
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const unknown = args.filter(a => a !== '--check' && a !== '--goldens');
  if (unknown.length || (args.includes('--check') && args.includes('--goldens'))) {
    console.log('Usage: bun run regen:all [--check | --goldens]');
    process.exit(2);
  }
  const env = offlineEnv();
  if (args.includes('--check')) {
    const stale = await checkArtifacts(ARTIFACTS, env);
    if (stale.length) {
      console.log(staleReport(stale));
      process.exit(1);
    }
    console.log(`regen:all --check: all ${ARTIFACTS.length} generated artifacts fresh.`);
    process.exit(0);
  }

  const before = dirtyState();
  const steps = [...ARTIFACTS.map(a => ({ name: a.name, argv: a.regen, env })),
    ...(args.includes('--goldens') ? CONTRACT_GOLDENS.map(f => ({ name: `golden ${f}`, argv: goldenArgv(f), env: { ...env, GBRAIN_TEST_UPDATE_GOLDENS: '1' } })) : [])];
  const llms = steps.findIndex(s => s.name.startsWith('llms'));
  steps.push(...steps.splice(llms, 1));
  for (const step of steps) {
    const r = await run(step.argv, step.env);
    if (r.code !== 0) {
      console.log(r.output.trim().split('\n').slice(-20).join('\n'));
      console.log(`regen:all: FAILED at ${step.name} (${step.argv.join(' ')}, exit ${r.code}).`);
      console.log(`Fix: run that command directly, fix what it reports, then rerun bun run regen:all. Docs: ${DOCS}`);
      process.exit(1);
    }
    console.log(`regen:all: ${step.name} ok`);
  }
  const changed = [...dirtyState()].filter(([p, h]) => before.get(p) !== h).map(([p]) => p);
  console.log(changed.length
    ? `regen:all: ${changed.length} file(s) changed; commit them:\n${changed.map(p => `  ${p}`).join('\n')}`
    : 'regen:all: every generated artifact was already fresh; nothing changed.');
  if (args.includes('--goldens') && changed.some(p => p.includes('test/fixtures/goldens/'))) {
    console.log('Changed contract goldens are reviewer-visible behavior changes: justify each in the PR body.');
  }
  console.log(`Not regenerated here (need Postgres):\n${POSTGRES_GOLDENS.map(c => `  ${c}`).join('\n')}`);
  if (!args.includes('--goldens')) console.log(`Contract goldens (deliberate): bun run regen:all --goldens regenerates ${CONTRACT_GOLDENS.join(', ')}.`);
}
